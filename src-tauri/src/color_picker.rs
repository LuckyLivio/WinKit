//! Phase 3B2 backend: I10 Native Windows Screen Color Picker & Image Palette Extractor.
//!
//! - Reuses `screen_capture`'s Per-Monitor DPI virtual-screen coordinate system, `BitBlt` +
//!   unlocked-desktop `PrintWindow` fallback (respecting protected windows), and
//!   `WDA_EXCLUDEFROMCAPTURE` overlay discipline.
//! - Interactive screen picker renders a crisp 11×11 zoomed magnifier loupe with high-contrast
//!   center pixel reticle, live HEX/RGB/physical-coordinate readout, click/Enter confirm,
//!   Esc/right-click cancel, and exact 1 px Arrow-key fine-tuning (`VK_LEFT/RIGHT/UP/DOWN`).
//! - Screen sampling explicitly reads composited display sRGB (`alpha = 255`); it does not attempt
//!   to infer original per-window translucency.
//! - Image palette extractor decodes images in EXIF display orientation, strictly excludes fully
//!   transparent pixels (`alpha == 0`), returns only existing distinct valid colors when an image
//!   contains fewer than `max_colors`, and uses deterministic farthest-first k-means clustering
//!   for complex photographs.

use crate::error::AppError;
use crate::fs_guard::validate_existing_input_file;
use crate::image_assets::ImageAssetStore;
use crate::image_core::decode_image_to_display;
use crate::screen_capture::{list_capture_monitors_impl, CaptureMonitorInfo, CaptureRect};
use image::RgbaImage;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickScreenColorRequest {
    /// Whether to temporarily hide WinKit's main window while capturing the pristine desktop
    /// snapshot underneath (default `true`).
    pub hide_main_window: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleScreenPixelRequest {
    pub physical_x: i32,
    pub physical_y: i32,
    pub hide_main_window: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenColorSample {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub hex: String,
    pub physical_x: i32,
    pub physical_y: i32,
    pub monitor_id: Option<String>,
    pub scale_percent: u32,
    pub composited_rgb_only: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractImagePaletteRequest {
    pub asset_id: Option<String>,
    pub path: Option<String>,
    /// Requested number of representative swatches (`5..=8`, default `6`).
    pub max_colors: Option<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PaletteSwatch {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub hex: String,
    pub share_percent: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePaletteResult {
    pub swatches: Vec<PaletteSwatch>,
    pub total_pixels: u64,
    pub opaque_pixels: u64,
    pub excluded_transparent_pixels: u64,
    pub distinct_color_count: usize,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedVirtualPixel {
    pub local_x: u32,
    pub local_y: u32,
    pub monitor_id: Option<String>,
    pub scale_percent: u32,
}

pub fn format_rgb_hex(r: u8, g: u8, b: u8) -> String {
    format!("#{r:02X}{g:02X}{b:02X}")
}

/// Maps a physical virtual-screen coordinate `(phys_x, phys_y)` — including negative
/// multi-monitor coordinates — to `(local_x, local_y)` inside a captured virtual-screen buffer
/// and resolves the owning monitor's ID and DPI scale factor.
pub fn resolve_virtual_pixel_location(
    monitors: &[CaptureMonitorInfo],
    virt: CaptureRect,
    phys_x: i32,
    phys_y: i32,
) -> Result<ResolvedVirtualPixel, AppError> {
    let min_x = virt.x;
    let min_y = virt.y;
    let max_x = i64::from(virt.x) + i64::from(virt.width);
    let max_y = i64::from(virt.y) + i64::from(virt.height);
    if i64::from(phys_x) < i64::from(min_x)
        || i64::from(phys_x) >= max_x
        || i64::from(phys_y) < i64::from(min_y)
        || i64::from(phys_y) >= max_y
    {
        return Err(AppError::invalid_param(format!(
            "Coordinate ({phys_x}, {phys_y}) is outside the active virtual screen bounds ({min_x},{min_y} {}×{}).",
            virt.width, virt.height
        )));
    }

    let local_x = (i64::from(phys_x) - i64::from(min_x)) as u32;
    let local_y = (i64::from(phys_y) - i64::from(min_y)) as u32;

    let owner = monitors.iter().find(|m| {
        i64::from(phys_x) >= i64::from(m.x)
            && i64::from(phys_x) < i64::from(m.x) + i64::from(m.width)
            && i64::from(phys_y) >= i64::from(m.y)
            && i64::from(phys_y) < i64::from(m.y) + i64::from(m.height)
    });

    Ok(ResolvedVirtualPixel {
        local_x,
        local_y,
        monitor_id: owner.map(|m| m.id.clone()),
        scale_percent: owner.map(|m| m.scale_percent).unwrap_or(100),
    })
}

/// Pure helper computing a 1-pixel keyboard nudge clamped safely inside the virtual screen.
pub fn nudge_local_pixel(
    local_x: i32,
    local_y: i32,
    dx: i32,
    dy: i32,
    width: i32,
    height: i32,
) -> (i32, i32) {
    let max_x = (width - 1).max(0);
    let max_y = (height - 1).max(0);
    (
        local_x.saturating_add(dx).clamp(0, max_x),
        local_y.saturating_add(dy).clamp(0, max_y),
    )
}

// ---------------------------------------------------------------------------
// Image Palette Extraction (pure Rust, excludes alpha == 0, deterministic)
// ---------------------------------------------------------------------------

fn color_dist_sq(a: [f64; 3], b: [f64; 3]) -> f64 {
    // Perceptually weighted sRGB Euclidean distance (redmean approximation)
    let r_mean = 0.5 * (a[0] + b[0]);
    let dr = a[0] - b[0];
    let dg = a[1] - b[1];
    let db = a[2] - b[2];
    let wr = 2.0 + r_mean / 256.0;
    let wg = 4.0;
    let wb = 2.0 + (255.0 - r_mean) / 256.0;
    wr * dr * dr + wg * dg * dg + wb * db * db
}

pub fn extract_palette_from_rgba(rgba: &RgbaImage, max_colors: usize) -> ImagePaletteResult {
    let target_k = max_colors.clamp(5, 8);
    let (width, height) = rgba.dimensions();
    let total_pixels = u64::from(width) * u64::from(height);
    if total_pixels == 0 {
        return ImagePaletteResult {
            swatches: Vec::new(),
            total_pixels: 0,
            opaque_pixels: 0,
            excluded_transparent_pixels: 0,
            distinct_color_count: 0,
            width,
            height,
        };
    }

    // Uniform stride sampling up to ~90k pixels keeps flat graphic colors exact without blending
    let stride = (((total_pixels as f64) / 90_000.0).sqrt().ceil() as u32).max(1);
    let mut color_counts: HashMap<[u8; 3], u64> = HashMap::new();
    let mut sampled_opaque = 0u64;
    let mut sampled_transparent = 0u64;

    let mut y = 0u32;
    while y < height {
        let mut x = 0u32;
        while x < width {
            let p = rgba.get_pixel(x, y).0;
            if p[3] == 0 {
                sampled_transparent += 1;
            } else {
                sampled_opaque += 1;
                *color_counts.entry([p[0], p[1], p[2]]).or_insert(0) += 1;
            }
            x += stride;
        }
        y += stride;
    }

    // Exact opaque / transparent counts across full image when stride > 1 for honest telemetry
    let (opaque_pixels, excluded_transparent_pixels) = if stride == 1 {
        (sampled_opaque, sampled_transparent)
    } else {
        let mut op = 0u64;
        let mut tr = 0u64;
        for px in rgba.pixels() {
            if px.0[3] == 0 {
                tr += 1;
            } else {
                op += 1;
            }
        }
        (op, tr)
    };

    if sampled_opaque == 0 || color_counts.is_empty() {
        return ImagePaletteResult {
            swatches: Vec::new(),
            total_pixels,
            opaque_pixels,
            excluded_transparent_pixels,
            distinct_color_count: 0,
            width,
            height,
        };
    }

    let distinct_color_count = color_counts.len();

    // Case 1: Fewer or equal distinct colors than requested -> return exact valid colors only
    if distinct_color_count <= target_k {
        let mut entries: Vec<([u8; 3], u64)> = color_counts.into_iter().collect();
        entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        let swatches = entries
            .into_iter()
            .map(|(rgb, count)| PaletteSwatch {
                r: rgb[0],
                g: rgb[1],
                b: rgb[2],
                hex: format_rgb_hex(rgb[0], rgb[1], rgb[2]),
                share_percent: ((count as f64 / sampled_opaque as f64) * 1000.0).round() / 10.0,
            })
            .collect();
        return ImagePaletteResult {
            swatches,
            total_pixels,
            opaque_pixels,
            excluded_transparent_pixels,
            distinct_color_count,
            width,
            height,
        };
    }

    // Case 2: Quantize to 5-bit per channel histogram buckets for fast deterministic clustering
    let mut bucket_map: HashMap<[u8; 3], ([f64; 3], u64)> = HashMap::new();
    for (rgb, count) in color_counts {
        let key = [rgb[0] >> 3, rgb[1] >> 3, rgb[2] >> 3];
        let w = count as f64;
        let entry = bucket_map.entry(key).or_insert(([0.0; 3], 0));
        entry.0[0] += f64::from(rgb[0]) * w;
        entry.0[1] += f64::from(rgb[1]) * w;
        entry.0[2] += f64::from(rgb[2]) * w;
        entry.1 += count;
    }

    let mut points: Vec<([f64; 3], u64)> = bucket_map
        .into_values()
        .map(|(sum, cnt)| {
            let inv = 1.0 / (cnt as f64);
            ([sum[0] * inv, sum[1] * inv, sum[2] * inv], cnt)
        })
        .collect();
    // Deterministic ordering by frequency descending, then RGB tuple
    points.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| a.0[0].total_cmp(&b.0[0]))
            .then_with(|| a.0[1].total_cmp(&b.0[1]))
            .then_with(|| a.0[2].total_cmp(&b.0[2]))
    });

    let k = target_k.min(points.len());

    // Deterministic farthest-first weighted seeding (starts with most dominant color, then picks
    // points maximizing weighted perceptual separation so vivid accents are never missed).
    let mut centers: Vec<[f64; 3]> = Vec::with_capacity(k);
    centers.push(points[0].0);

    while centers.len() < k {
        let mut best_idx = None;
        let mut best_score = -1.0f64;
        for (idx, &(pt, cnt)) in points.iter().enumerate() {
            let min_d2 = centers
                .iter()
                .map(|c| color_dist_sq(pt, *c))
                .fold(f64::INFINITY, f64::min);
            // Balance perceptual distinctiveness with pixel weight (sqrt dampens huge backgrounds)
            let score = min_d2 * (cnt as f64).powf(0.35);
            if score > best_score {
                best_score = score;
                best_idx = Some(idx);
            }
        }
        let Some(chosen) = best_idx else { break };
        if best_score <= 1.0 {
            break;
        }
        centers.push(points[chosen].0);
    }

    // Weighted k-means refinement (12 iterations)
    let mut cluster_weights = vec![0u64; centers.len()];
    for _ in 0..12 {
        let mut sums = vec![[0.0f64; 3]; centers.len()];
        cluster_weights.fill(0);
        for &(pt, cnt) in &points {
            let mut best_c = 0usize;
            let mut best_d = f64::INFINITY;
            for (ci, c) in centers.iter().enumerate() {
                let d = color_dist_sq(pt, *c);
                if d < best_d {
                    best_d = d;
                    best_c = ci;
                }
            }
            let w = cnt as f64;
            sums[best_c][0] += pt[0] * w;
            sums[best_c][1] += pt[1] * w;
            sums[best_c][2] += pt[2] * w;
            cluster_weights[best_c] += cnt;
        }
        for ci in 0..centers.len() {
            if cluster_weights[ci] > 0 {
                let inv = 1.0 / (cluster_weights[ci] as f64);
                centers[ci] = [sums[ci][0] * inv, sums[ci][1] * inv, sums[ci][2] * inv];
            }
        }
    }

    // Merge identical rounded RGB outputs and sort by prominence descending
    let mut merged: HashMap<[u8; 3], u64> = HashMap::new();
    for (ci, center) in centers.into_iter().enumerate() {
        let weight = cluster_weights[ci];
        if weight == 0 {
            continue;
        }
        let rgb = [
            center[0].round().clamp(0.0, 255.0) as u8,
            center[1].round().clamp(0.0, 255.0) as u8,
            center[2].round().clamp(0.0, 255.0) as u8,
        ];
        *merged.entry(rgb).or_insert(0) += weight;
    }

    let mut final_list: Vec<([u8; 3], u64)> = merged.into_iter().collect();
    final_list.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    let swatches = final_list
        .into_iter()
        .map(|(rgb, count)| PaletteSwatch {
            r: rgb[0],
            g: rgb[1],
            b: rgb[2],
            hex: format_rgb_hex(rgb[0], rgb[1], rgb[2]),
            share_percent: ((count as f64 / sampled_opaque as f64) * 1000.0).round() / 10.0,
        })
        .collect();

    ImagePaletteResult {
        swatches,
        total_pixels,
        opaque_pixels,
        excluded_transparent_pixels,
        distinct_color_count,
        width,
        height,
    }
}

pub fn extract_image_palette_impl(
    store: &ImageAssetStore,
    req: &ExtractImagePaletteRequest,
) -> Result<ImagePaletteResult, AppError> {
    let max_colors = req.max_colors.unwrap_or(6).clamp(5, 8);
    if let Some(asset_id) = req
        .asset_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let (rgba, _) = store.get_rgba(asset_id)?;
        return Ok(extract_palette_from_rgba(&rgba, max_colors));
    }
    if let Some(raw_path) = req.path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let (valid_path, _) = validate_existing_input_file(raw_path)?;
        let decoded = decode_image_to_display(&valid_path)?;
        let rgba = decoded.image.to_rgba8();
        return Ok(extract_palette_from_rgba(&rgba, max_colors));
    }
    Err(AppError::invalid_param(
        "Please provide an image file path or in-memory image asset to extract a palette.",
    ))
}

// ---------------------------------------------------------------------------
// Native Windows 11 Interactive Magnifier Screen Picker & Direct Pixel Sampler
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod win_picker {
    use super::*;
    use crate::screen_capture::{
        capture_screen_rect_shared, is_escape_pressed_shared, virtual_screen_rect_shared,
    };
    use std::ptr::null_mut;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateDIBSection,
        CreateFontW, CreatePen, CreateSolidBrush, DeleteDC, DeleteObject, DrawTextW, EndPaint,
        FillRect, FrameRect, GetDC, InvalidateRect, LineTo, MoveToEx, ReleaseDC, SelectObject,
        SetBkMode, SetTextColor, UpdateWindow, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DEFAULT_PITCH, DIB_RGB_COLORS,
        DT_LEFT, DT_SINGLELINE, DT_VCENTER, FF_SWISS, HBITMAP, HGDIOBJ, OUT_DEFAULT_PRECIS,
        PAINTSTRUCT, PS_SOLID, SRCCOPY, TRANSPARENT,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        VK_DOWN, VK_ESCAPE, VK_LEFT, VK_RETURN, VK_RIGHT, VK_UP,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetCursorPos,
        GetMessageW, GetWindowLongPtrW, KillTimer, LoadCursorW, PostQuitMessage, RegisterClassExW,
        SetCursorPos, SetForegroundWindow, SetTimer, SetWindowDisplayAffinity, SetWindowLongPtrW,
        ShowWindow, TranslateMessage, CS_HREDRAW, CS_VREDRAW, GWLP_USERDATA, IDC_CROSS, MSG,
        SW_SHOW, WDA_EXCLUDEFROMCAPTURE, WM_DESTROY, WM_ERASEBKGND, WM_KEYDOWN, WM_LBUTTONDOWN,
        WM_MOUSEMOVE, WM_PAINT, WM_RBUTTONDOWN, WM_TIMER, WNDCLASSEXW, WS_EX_TOOLWINDOW,
        WS_EX_TOPMOST, WS_POPUP,
    };

    const GRID_HALF: i32 = 5; // 11 × 11 pixels around cursor
    const CELL_PX: i32 = 14; // 154 × 154 px loupe grid

    fn wide_z(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn rgb_to_colorref(r: u8, g: u8, b: u8) -> COLORREF {
        COLORREF(u32::from(r) | (u32::from(g) << 8) | (u32::from(b) << 16))
    }

    unsafe fn create_bgra_dib(rgba: &RgbaImage) -> Option<HBITMAP> {
        let (w, h) = rgba.dimensions();
        let screen_dc = GetDC(None);
        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w as i32,
                biHeight: -(h as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..std::mem::zeroed()
            },
            ..std::mem::zeroed()
        };
        let mut ptr: *mut std::ffi::c_void = null_mut();
        let res = CreateDIBSection(Some(screen_dc), &bmi, DIB_RGB_COLORS, &mut ptr, None, 0);
        let _ = ReleaseDC(None, screen_dc);
        let bmp = res.ok()?;
        if !ptr.is_null() {
            let total = (w as usize) * (h as usize);
            let dst = std::slice::from_raw_parts_mut(ptr as *mut u8, total * 4);
            let src = rgba.as_raw();
            for i in 0..total {
                let o = i * 4;
                dst[o] = src[o + 2];
                dst[o + 1] = src[o + 1];
                dst[o + 2] = src[o];
                dst[o + 3] = 255;
            }
        }
        Some(bmp)
    }

    struct PickerState {
        virt_x: i32,
        virt_y: i32,
        width: i32,
        height: i32,
        frozen: RgbaImage,
        bg_bmp: HBITMAP,
        cursor_x: i32,
        cursor_y: i32,
        picked: Option<(i32, i32)>,
        cancelled: bool,
    }

    unsafe extern "system" fn picker_wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut PickerState;
        if ptr.is_null() {
            return DefWindowProcW(hwnd, msg, wparam, lparam);
        }
        let st = &mut *ptr;

        match msg {
            WM_ERASEBKGND => LRESULT(1),
            WM_MOUSEMOVE => {
                let x = ((lparam.0 & 0xFFFF) as i16 as i32).clamp(0, (st.width - 1).max(0));
                let y =
                    (((lparam.0 >> 16) & 0xFFFF) as i16 as i32).clamp(0, (st.height - 1).max(0));
                if x != st.cursor_x || y != st.cursor_y {
                    st.cursor_x = x;
                    st.cursor_y = y;
                    let _ = InvalidateRect(Some(hwnd), None, false);
                }
                LRESULT(0)
            }
            WM_LBUTTONDOWN => {
                let x = ((lparam.0 & 0xFFFF) as i16 as i32).clamp(0, (st.width - 1).max(0));
                let y =
                    (((lparam.0 >> 16) & 0xFFFF) as i16 as i32).clamp(0, (st.height - 1).max(0));
                st.picked = Some((x, y));
                let _ = DestroyWindow(hwnd);
                LRESULT(0)
            }
            WM_RBUTTONDOWN => {
                st.cancelled = true;
                let _ = DestroyWindow(hwnd);
                LRESULT(0)
            }
            WM_KEYDOWN => {
                let vk = wparam.0 as u16;
                if vk == VK_ESCAPE.0 {
                    st.cancelled = true;
                    let _ = DestroyWindow(hwnd);
                } else if vk == VK_RETURN.0 {
                    st.picked = Some((st.cursor_x, st.cursor_y));
                    let _ = DestroyWindow(hwnd);
                } else {
                    let delta = match vk {
                        x if x == VK_LEFT.0 => Some((-1, 0)),
                        x if x == VK_RIGHT.0 => Some((1, 0)),
                        x if x == VK_UP.0 => Some((0, -1)),
                        x if x == VK_DOWN.0 => Some((0, 1)),
                        _ => None,
                    };
                    if let Some((dx, dy)) = delta {
                        let (nx, ny) = nudge_local_pixel(
                            st.cursor_x,
                            st.cursor_y,
                            dx,
                            dy,
                            st.width,
                            st.height,
                        );
                        st.cursor_x = nx;
                        st.cursor_y = ny;
                        let _ = SetCursorPos(st.virt_x + nx, st.virt_y + ny);
                        let _ = InvalidateRect(Some(hwnd), None, false);
                    }
                }
                LRESULT(0)
            }
            WM_TIMER => {
                if is_escape_pressed_shared() {
                    st.cancelled = true;
                    let _ = DestroyWindow(hwnd);
                }
                LRESULT(0)
            }
            WM_PAINT => {
                let mut ps: PAINTSTRUCT = std::mem::zeroed();
                let hdc = BeginPaint(hwnd, &mut ps);
                let mem_dc = CreateCompatibleDC(Some(hdc));
                let back_bmp = CreateCompatibleBitmap(hdc, st.width, st.height);
                let old_back = SelectObject(mem_dc, HGDIOBJ(back_bmp.0));

                // 1. Copy crisp frozen desktop image
                let src_dc = CreateCompatibleDC(Some(hdc));
                let old_src = SelectObject(src_dc, HGDIOBJ(st.bg_bmp.0));
                let _ = BitBlt(
                    mem_dc,
                    0,
                    0,
                    st.width,
                    st.height,
                    Some(src_dc),
                    0,
                    0,
                    SRCCOPY,
                );
                let _ = SelectObject(src_dc, old_src);
                let _ = DeleteDC(src_dc);

                // 2. Render floating magnifier loupe card near cursor without clipping screen edges
                let grid_cells = GRID_HALF * 2 + 1;
                let grid_px = grid_cells * CELL_PX; // 154 px
                let card_pad = 10;
                let footer_h = 68;
                let card_w = grid_px + card_pad * 2;
                let card_h = grid_px + card_pad * 2 + footer_h;

                let offset = 24;
                let card_x = if st.cursor_x + offset + card_w <= st.width - 8 {
                    st.cursor_x + offset
                } else {
                    (st.cursor_x - offset - card_w).clamp(8, (st.width - card_w - 8).max(8))
                };
                let card_y = if st.cursor_y + offset + card_h <= st.height - 8 {
                    st.cursor_y + offset
                } else {
                    (st.cursor_y - offset - card_h).clamp(8, (st.height - card_h - 8).max(8))
                };

                let card_rc = RECT {
                    left: card_x,
                    top: card_y,
                    right: card_x + card_w,
                    bottom: card_y + card_h,
                };
                let card_bg = CreateSolidBrush(rgb_to_colorref(22, 27, 36));
                let card_border = CreateSolidBrush(rgb_to_colorref(71, 85, 105));
                FillRect(mem_dc, &card_rc, card_bg);
                let _ = FrameRect(mem_dc, &card_rc, card_border);
                let _ = DeleteObject(HGDIOBJ(card_bg.0));
                let _ = DeleteObject(HGDIOBJ(card_border.0));

                let gx0 = card_x + card_pad;
                let gy0 = card_y + card_pad;

                // Paint 11 × 11 zoomed pixel cells
                for dy in -GRID_HALF..=GRID_HALF {
                    for dx in -GRID_HALF..=GRID_HALF {
                        let sx = st.cursor_x + dx;
                        let sy = st.cursor_y + dy;
                        let rgb = if sx >= 0 && sy >= 0 && sx < st.width && sy < st.height {
                            let p = st.frozen.get_pixel(sx as u32, sy as u32).0;
                            [p[0], p[1], p[2]]
                        } else {
                            [18, 22, 30]
                        };
                        let cx = gx0 + (dx + GRID_HALF) * CELL_PX;
                        let cy = gy0 + (dy + GRID_HALF) * CELL_PX;
                        let cell_rc = RECT {
                            left: cx,
                            top: cy,
                            right: cx + CELL_PX,
                            bottom: cy + CELL_PX,
                        };
                        let brush = CreateSolidBrush(rgb_to_colorref(rgb[0], rgb[1], rgb[2]));
                        FillRect(mem_dc, &cell_rc, brush);
                        let _ = DeleteObject(HGDIOBJ(brush.0));
                    }
                }

                // Subtle pixel grid lines
                let grid_pen = CreatePen(PS_SOLID, 1, rgb_to_colorref(55, 65, 81));
                let old_pen = SelectObject(mem_dc, HGDIOBJ(grid_pen.0));
                for i in 0..=grid_cells {
                    let x = gx0 + i * CELL_PX;
                    let _ = MoveToEx(mem_dc, x, gy0, None);
                    let _ = LineTo(mem_dc, x, gy0 + grid_px);
                    let y = gy0 + i * CELL_PX;
                    let _ = MoveToEx(mem_dc, gx0, y, None);
                    let _ = LineTo(mem_dc, gx0 + grid_px, y);
                }
                let _ = SelectObject(mem_dc, old_pen);
                let _ = DeleteObject(HGDIOBJ(grid_pen.0));

                // High-contrast double reticle on exact center pixel (GRID_HALF, GRID_HALF)
                let center_x = gx0 + GRID_HALF * CELL_PX;
                let center_y = gy0 + GRID_HALF * CELL_PX;
                let outer_rc = RECT {
                    left: center_x - 1,
                    top: center_y - 1,
                    right: center_x + CELL_PX + 1,
                    bottom: center_y + CELL_PX + 1,
                };
                let inner_rc = RECT {
                    left: center_x,
                    top: center_y,
                    right: center_x + CELL_PX,
                    bottom: center_y + CELL_PX,
                };
                let black_br = CreateSolidBrush(rgb_to_colorref(0, 0, 0));
                let white_br = CreateSolidBrush(rgb_to_colorref(255, 255, 255));
                let _ = FrameRect(mem_dc, &outer_rc, black_br);
                let _ = FrameRect(mem_dc, &inner_rc, white_br);
                let _ = DeleteObject(HGDIOBJ(black_br.0));
                let _ = DeleteObject(HGDIOBJ(white_br.0));

                // Footer swatch + HEX + RGB + physical coords + hint
                let center_px = st
                    .frozen
                    .get_pixel(st.cursor_x as u32, st.cursor_y as u32)
                    .0;
                let hex = format_rgb_hex(center_px[0], center_px[1], center_px[2]);
                let phys_x = st.virt_x + st.cursor_x;
                let phys_y = st.virt_y + st.cursor_y;

                let swatch_rc = RECT {
                    left: gx0,
                    top: gy0 + grid_px + 9,
                    right: gx0 + 28,
                    bottom: gy0 + grid_px + 37,
                };
                let sw_brush =
                    CreateSolidBrush(rgb_to_colorref(center_px[0], center_px[1], center_px[2]));
                let sw_border = CreateSolidBrush(rgb_to_colorref(226, 232, 240));
                FillRect(mem_dc, &swatch_rc, sw_brush);
                let _ = FrameRect(mem_dc, &swatch_rc, sw_border);
                let _ = DeleteObject(HGDIOBJ(sw_brush.0));
                let _ = DeleteObject(HGDIOBJ(sw_border.0));

                let font_main = CreateFontW(
                    -14,
                    0,
                    0,
                    0,
                    600,
                    0,
                    0,
                    0,
                    DEFAULT_CHARSET,
                    OUT_DEFAULT_PRECIS,
                    CLIP_DEFAULT_PRECIS,
                    CLEARTYPE_QUALITY,
                    (DEFAULT_PITCH.0 | FF_SWISS.0) as u32,
                    PCWSTR(wide_z("Consolas").as_ptr()),
                );
                let font_sub = CreateFontW(
                    -11,
                    0,
                    0,
                    0,
                    400,
                    0,
                    0,
                    0,
                    DEFAULT_CHARSET,
                    OUT_DEFAULT_PRECIS,
                    CLIP_DEFAULT_PRECIS,
                    CLEARTYPE_QUALITY,
                    (DEFAULT_PITCH.0 | FF_SWISS.0) as u32,
                    PCWSTR(wide_z("Microsoft YaHei UI").as_ptr()),
                );

                SetBkMode(mem_dc, TRANSPARENT);
                let old_font = SelectObject(mem_dc, HGDIOBJ(font_main.0));
                SetTextColor(mem_dc, rgb_to_colorref(248, 250, 252));

                let mut line1 = wide_z(&hex);
                let n1 = line1.len() - 1;
                let mut rc1 = RECT {
                    left: gx0 + 36,
                    top: gy0 + grid_px + 7,
                    right: card_x + card_w - card_pad,
                    bottom: gy0 + grid_px + 25,
                };
                DrawTextW(
                    mem_dc,
                    &mut line1[..n1],
                    &mut rc1,
                    DT_LEFT | DT_VCENTER | DT_SINGLELINE,
                );

                let _ = SelectObject(mem_dc, HGDIOBJ(font_sub.0));
                SetTextColor(mem_dc, rgb_to_colorref(203, 213, 225));

                let mut line2 = wide_z(&format!(
                    "{},{},{} ({phys_x},{phys_y})",
                    center_px[0], center_px[1], center_px[2]
                ));
                let n2 = line2.len() - 1;
                let mut rc2 = RECT {
                    left: gx0 + 36,
                    top: gy0 + grid_px + 24,
                    right: card_x + card_w - card_pad,
                    bottom: gy0 + grid_px + 41,
                };
                DrawTextW(
                    mem_dc,
                    &mut line2[..n2],
                    &mut rc2,
                    DT_LEFT | DT_VCENTER | DT_SINGLELINE,
                );

                SetTextColor(mem_dc, rgb_to_colorref(148, 163, 184));
                let mut line3 = wide_z("点击/Enter · 方向键1px · Esc");
                let n3 = line3.len() - 1;
                let mut rc3 = RECT {
                    left: gx0,
                    top: gy0 + grid_px + 44,
                    right: card_x + card_w - card_pad,
                    bottom: gy0 + grid_px + 62,
                };
                DrawTextW(
                    mem_dc,
                    &mut line3[..n3],
                    &mut rc3,
                    DT_LEFT | DT_VCENTER | DT_SINGLELINE,
                );

                let _ = SelectObject(mem_dc, old_font);
                let _ = DeleteObject(HGDIOBJ(font_main.0));
                let _ = DeleteObject(HGDIOBJ(font_sub.0));

                let _ = BitBlt(hdc, 0, 0, st.width, st.height, Some(mem_dc), 0, 0, SRCCOPY);
                let _ = SelectObject(mem_dc, old_back);
                let _ = DeleteObject(HGDIOBJ(back_bmp.0));
                let _ = DeleteDC(mem_dc);
                let _ = EndPaint(hwnd, &ps);
                LRESULT(0)
            }
            WM_DESTROY => {
                let _ = KillTimer(Some(hwnd), 1);
                PostQuitMessage(0);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    pub fn pick_screen_color(cancel_flag: &AtomicBool) -> Result<ScreenColorSample, AppError> {
        let virt = virtual_screen_rect_shared();
        let monitors = list_capture_monitors_impl();
        let frozen = capture_screen_rect_shared(virt, false)?;

        unsafe {
            let hinst = GetModuleHandleW(None).map_err(|_| {
                AppError::new("CAPTURE_UNAVAILABLE", "Unable to query module handle.")
            })?;
            let cls_name = wide_z("WinKitColorPickerClass");
            let wc = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(picker_wnd_proc),
                hInstance: hinst.into(),
                hCursor: LoadCursorW(None, IDC_CROSS).unwrap_or_default(),
                lpszClassName: PCWSTR(cls_name.as_ptr()),
                ..std::mem::zeroed()
            };
            let _ = RegisterClassExW(&wc);

            let bg_bmp = create_bgra_dib(&frozen).ok_or_else(|| {
                AppError::new(
                    "CAPTURE_UNAVAILABLE",
                    "Unable to prepare frozen desktop image for color picker.",
                )
            })?;

            let mut pt: POINT = std::mem::zeroed();
            let _ = GetCursorPos(&mut pt);
            let init_x = (pt.x - virt.x).clamp(0, (virt.width as i32 - 1).max(0));
            let init_y = (pt.y - virt.y).clamp(0, (virt.height as i32 - 1).max(0));

            let mut state = Box::new(PickerState {
                virt_x: virt.x,
                virt_y: virt.y,
                width: virt.width as i32,
                height: virt.height as i32,
                frozen,
                bg_bmp,
                cursor_x: init_x,
                cursor_y: init_y,
                picked: None,
                cancelled: false,
            });

            let hwnd = match CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
                PCWSTR(cls_name.as_ptr()),
                PCWSTR(wide_z("WinKit Color Picker").as_ptr()),
                WS_POPUP,
                virt.x,
                virt.y,
                virt.width as i32,
                virt.height as i32,
                None,
                None,
                Some(hinst.into()),
                None,
            ) {
                Ok(h) => h,
                Err(_) => {
                    let _ = DeleteObject(HGDIOBJ(bg_bmp.0));
                    return Err(AppError::new(
                        "CAPTURE_UNAVAILABLE",
                        "Unable to create native color picker overlay window.",
                    ));
                }
            };

            let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
            SetWindowLongPtrW(
                hwnd,
                GWLP_USERDATA,
                state.as_mut() as *mut PickerState as isize,
            );
            let _ = SetTimer(Some(hwnd), 1, 40, None);
            let _ = ShowWindow(hwnd, SW_SHOW);
            let _ = UpdateWindow(hwnd);
            let _ = SetForegroundWindow(hwnd);

            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                if cancel_flag.load(Ordering::Relaxed) {
                    state.cancelled = true;
                    let _ = DestroyWindow(hwnd);
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            let _ = DeleteObject(HGDIOBJ(bg_bmp.0));

            if state.cancelled {
                return Err(AppError::cancelled());
            }
            let Some((lx, ly)) = state.picked else {
                return Err(AppError::cancelled());
            };
            let phys_x = virt.x + lx;
            let phys_y = virt.y + ly;
            let loc = resolve_virtual_pixel_location(&monitors, virt, phys_x, phys_y)?;
            let px = state.frozen.get_pixel(loc.local_x, loc.local_y).0;
            Ok(ScreenColorSample {
                r: px[0],
                g: px[1],
                b: px[2],
                hex: format_rgb_hex(px[0], px[1], px[2]),
                physical_x: phys_x,
                physical_y: phys_y,
                monitor_id: loc.monitor_id,
                scale_percent: loc.scale_percent,
                composited_rgb_only: true,
            })
        }
    }

    pub fn sample_screen_pixel_at(phys_x: i32, phys_y: i32) -> Result<ScreenColorSample, AppError> {
        let virt = virtual_screen_rect_shared();
        let monitors = list_capture_monitors_impl();
        let loc = resolve_virtual_pixel_location(&monitors, virt, phys_x, phys_y)?;
        let patch = capture_screen_rect_shared(
            CaptureRect {
                x: phys_x,
                y: phys_y,
                width: 1,
                height: 1,
            },
            false,
        )?;
        let px = patch.get_pixel(0, 0).0;
        Ok(ScreenColorSample {
            r: px[0],
            g: px[1],
            b: px[2],
            hex: format_rgb_hex(px[0], px[1], px[2]),
            physical_x: phys_x,
            physical_y: phys_y,
            monitor_id: loc.monitor_id,
            scale_percent: loc.scale_percent,
            composited_rgb_only: true,
        })
    }
}

pub fn pick_screen_color_impl(cancel_flag: &AtomicBool) -> Result<ScreenColorSample, AppError> {
    #[cfg(windows)]
    {
        win_picker::pick_screen_color(cancel_flag)
    }
    #[cfg(not(windows))]
    {
        let _ = cancel_flag;
        Err(AppError::new(
            "CAPTURE_UNAVAILABLE",
            "Native screen color picking is supported on Windows 11.",
        ))
    }
}

pub fn sample_screen_pixel_at_impl(
    phys_x: i32,
    phys_y: i32,
) -> Result<ScreenColorSample, AppError> {
    #[cfg(windows)]
    {
        win_picker::sample_screen_pixel_at(phys_x, phys_y)
    }
    #[cfg(not(windows))]
    {
        let _ = (phys_x, phys_y);
        Err(AppError::new(
            "CAPTURE_UNAVAILABLE",
            "Native screen pixel sampling is supported on Windows 11.",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    #[test]
    fn virtual_screen_coordinate_mapping_handles_multi_monitor_negative_coords_and_mixed_dpi() {
        let monitors = vec![
            CaptureMonitorInfo {
                id: "monitor-left".into(),
                device_name: r"\\.\DISPLAY2".into(),
                is_primary: false,
                x: -1920,
                y: -240,
                width: 1920,
                height: 1080,
                scale_percent: 100,
            },
            CaptureMonitorInfo {
                id: "monitor-primary".into(),
                device_name: r"\\.\DISPLAY1".into(),
                is_primary: true,
                x: 0,
                y: 0,
                width: 3840,
                height: 2160,
                scale_percent: 150,
            },
            CaptureMonitorInfo {
                id: "monitor-right".into(),
                device_name: r"\\.\DISPLAY3".into(),
                is_primary: false,
                x: 3840,
                y: 0,
                width: 2560,
                height: 1440,
                scale_percent: 200,
            },
        ];
        let virt = CaptureRect {
            x: -1920,
            y: -240,
            width: 8320,
            height: 2400,
        };

        // Negative coordinate on left 100% monitor
        let left_loc = resolve_virtual_pixel_location(&monitors, virt, -100, -40).expect("left");
        assert_eq!(left_loc.local_x, 1820);
        assert_eq!(left_loc.local_y, 200);
        assert_eq!(left_loc.monitor_id.as_deref(), Some("monitor-left"));
        assert_eq!(left_loc.scale_percent, 100);

        // Positive coordinate on primary 150% monitor
        let primary_loc = resolve_virtual_pixel_location(&monitors, virt, 1200, 900).expect("prim");
        assert_eq!(primary_loc.local_x, 3120);
        assert_eq!(primary_loc.local_y, 1140);
        assert_eq!(primary_loc.monitor_id.as_deref(), Some("monitor-primary"));
        assert_eq!(primary_loc.scale_percent, 150);

        // Coordinate on right 200% monitor
        let right_loc = resolve_virtual_pixel_location(&monitors, virt, 4000, 100).expect("right");
        assert_eq!(right_loc.local_x, 5920);
        assert_eq!(right_loc.local_y, 340);
        assert_eq!(right_loc.monitor_id.as_deref(), Some("monitor-right"));
        assert_eq!(right_loc.scale_percent, 200);

        // Out-of-bounds rejected cleanly
        assert!(resolve_virtual_pixel_location(&monitors, virt, -1921, 0).is_err());
        assert!(resolve_virtual_pixel_location(&monitors, virt, 6400, 0).is_err());

        // 1px arrow nudge clamps at boundaries
        assert_eq!(nudge_local_pixel(0, 0, -1, -1, 100, 50), (0, 0));
        assert_eq!(nudge_local_pixel(99, 49, 1, 1, 100, 50), (99, 49));
        assert_eq!(nudge_local_pixel(10, 20, 1, -1, 100, 50), (11, 19));
    }

    #[test]
    fn palette_excludes_fully_transparent_pixels_and_returns_only_valid_colors_for_low_color_images(
    ) {
        // 120×60 image: half fully transparent (with non-zero garbage RGB [255,0,255,0]),
        // plus strictly 3 opaque color blocks (#E11D48, #2563EB, #10B981).
        let mut img = RgbaImage::from_pixel(120, 60, Rgba([255, 0, 255, 0]));
        for y in 0..60 {
            for x in 0..30 {
                img.put_pixel(x, y, Rgba([0xE1, 0x1D, 0x48, 255]));
            }
            for x in 30..50 {
                img.put_pixel(x, y, Rgba([0x25, 0x63, 0xEB, 255]));
            }
            for x in 50..60 {
                img.put_pixel(x, y, Rgba([0x10, 0xB9, 0x81, 255]));
            }
        }

        let res = extract_palette_from_rgba(&img, 8);
        assert_eq!(res.total_pixels, 7200);
        assert_eq!(res.opaque_pixels, 3600);
        assert_eq!(res.excluded_transparent_pixels, 3600);
        assert_eq!(res.distinct_color_count, 3);
        // Must return strictly 3 valid swatches (NOT 8 duplicated swatches, and NEVER #FF00FF!)
        assert_eq!(res.swatches.len(), 3);
        assert_eq!(res.swatches[0].hex, "#E11D48");
        assert!((res.swatches[0].share_percent - 50.0).abs() < 0.2);
        assert_eq!(res.swatches[1].hex, "#2563EB");
        assert_eq!(res.swatches[2].hex, "#10B981");
        assert!(res.swatches.iter().all(|s| s.hex != "#FF00FF"));
    }

    #[test]
    fn palette_handles_fully_transparent_image_and_rich_multi_color_image() {
        let empty = RgbaImage::from_pixel(40, 40, Rgba([12, 34, 56, 0]));
        let res_empty = extract_palette_from_rgba(&empty, 6);
        assert!(res_empty.swatches.is_empty());
        assert_eq!(res_empty.opaque_pixels, 0);
        assert_eq!(res_empty.excluded_transparent_pixels, 1600);

        // Rich image with 12 distinct vibrant color bands -> extracts exact requested 6 colors
        let mut rich = RgbaImage::new(240, 120);
        let bands: [[u8; 3]; 12] = [
            [220, 38, 38],
            [234, 88, 12],
            [202, 138, 4],
            [22, 163, 74],
            [13, 148, 136],
            [37, 99, 235],
            [79, 70, 229],
            [147, 51, 234],
            [219, 39, 119],
            [15, 23, 42],
            [100, 116, 139],
            [241, 245, 249],
        ];
        for y in 0..120 {
            for x in 0..240 {
                let b = bands[(x / 20) as usize];
                rich.put_pixel(x, y, Rgba([b[0], b[1], b[2], 255]));
            }
        }
        let res_rich = extract_palette_from_rgba(&rich, 6);
        assert_eq!(res_rich.swatches.len(), 6);
        assert_eq!(res_rich.distinct_color_count, 12);
    }
}
