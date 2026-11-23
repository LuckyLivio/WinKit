//! Phase 3B Batch 1 backend: I01 Native Windows 11 Screenshot & Scrolling Long Screenshot.
//!
//! Provides four capture modes (Region, Window, Monitor, Scrolling Long Screenshot)
//! using native Win32/DWM/GDI APIs with Per-Monitor DPI physical pixel coordinates,
//! PrintWindow(PW_RENDERFULLCONTENT) for occluded-safe window capture, strict respect
//! for Windows display affinity (protected content), WDA_EXCLUDEFROMCAPTURE overlays/HUDs,
//! immediate Esc/cancel stop, and overlap-based vertical scrolling stitching.

use crate::error::AppError;
use crate::image_assets::{ImageAssetPayload, ImageAssetStore, MAX_ASSET_PIXELS, MAX_ASSET_SIDE};
use image::{Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const CAPTURE_PROGRESS_EVENT: &str = "winkit://capture-progress";
pub const DEFAULT_MAX_SCROLL_FRAMES: u32 = 50;
pub const DEFAULT_MAX_STITCH_HEIGHT: u32 = 16_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct CaptureRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureMonitorInfo {
    pub id: String,
    pub device_name: String,
    pub is_primary: bool,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_percent: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureWindowInfo {
    pub hwnd: u64,
    pub title: String,
    pub process_name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub is_protected: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScrollStopReason {
    ReachedBottom,
    UserStopped,
    AlignmentFailed,
    SizeLimitReached,
    MaxFramesReached,
    SingleFrameOnly,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureProgressPayload {
    pub task_id: String,
    pub phase: String, // "countdown" | "selecting" | "scrolling" | "stitching"
    pub countdown_remaining: Option<u32>,
    pub frame_count: u32,
    pub stitched_height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResultPayload {
    pub asset: ImageAssetPayload,
    pub mode: String,
    pub rect: CaptureRect,
    pub frame_count: u32,
    pub stop_reason: Option<ScrollStopReason>,
    pub is_partial: bool,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRegionRequest {
    pub countdown_seconds: u32,
    pub include_cursor: bool,
    /// Optional explicit physical-pixel rect (bypasses interactive overlay when supplied).
    pub explicit_rect: Option<CaptureRect>,
    /// Whether to hide WinKit's main window during capture (default true).
    pub hide_main_window: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureMonitorRequest {
    pub monitor_id: String,
    pub countdown_seconds: u32,
    pub include_cursor: bool,
    pub hide_main_window: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureWindowRequest {
    pub hwnd: u64,
    pub countdown_seconds: u32,
    pub include_cursor: bool,
    pub hide_main_window: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureScrollRequest {
    pub countdown_seconds: u32,
    pub max_frames: Option<u32>,
    pub max_height: Option<u32>,
    /// Wheel notches per scroll step (default 3 = 360 wheel delta).
    pub wheel_notches: Option<u32>,
    /// Settle delay in milliseconds after each scroll step (default 280 ms).
    pub step_delay_ms: Option<u32>,
    /// Optional explicit physical-pixel rect (bypasses interactive selector when supplied).
    pub explicit_rect: Option<CaptureRect>,
    pub hide_main_window: Option<bool>,
}

// ---------------------------------------------------------------------------
// Pure Rust Vertical Scrolling Overlap Stitcher (platform-independent & tested)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
struct RowSig {
    r: f32,
    g: f32,
    b: f32,
    edge: f32,
}

fn compute_row_signatures(img: &RgbaImage, match_w: u32) -> Vec<RowSig> {
    let h = img.height() as usize;
    let w = match_w.max(1) as usize;
    let step = (w / 160).max(1);
    let mut sigs = Vec::with_capacity(h);
    let raw = img.as_raw();
    let stride = img.width() as usize * 4;

    for y in 0..h {
        let row = &raw[y * stride..y * stride + w * 4];
        let mut sr = 0.0f32;
        let mut sg = 0.0f32;
        let mut sb = 0.0f32;
        let mut se = 0.0f32;
        let mut cnt = 0.0f32;
        let mut prev_luma = 0.0f32;
        let mut x = 0usize;
        while x < w {
            let p = x * 4;
            let r = f32::from(row[p]);
            let g = f32::from(row[p + 1]);
            let b = f32::from(row[p + 2]);
            let luma = 0.299 * r + 0.587 * g + 0.114 * b;
            if cnt > 0.0 {
                se += (luma - prev_luma).abs();
            }
            prev_luma = luma;
            sr += r;
            sg += g;
            sb += b;
            cnt += 1.0;
            x += step;
        }
        let inv = if cnt > 0.0 { 1.0 / cnt } else { 1.0 };
        sigs.push(RowSig {
            r: sr * inv,
            g: sg * inv,
            b: sb * inv,
            edge: se * inv,
        });
    }
    sigs
}

fn row_sad(a: &RgbaImage, ay: u32, b: &RgbaImage, by: u32, match_w: u32) -> f32 {
    let w = match_w.max(1) as usize;
    let step = (w / 96).max(1);
    let raw_a = a.as_raw();
    let raw_b = b.as_raw();
    let off_a = (ay as usize) * (a.width() as usize) * 4;
    let off_b = (by as usize) * (b.width() as usize) * 4;
    let mut sum = 0u32;
    let mut cnt = 0u32;
    let mut x = 0usize;
    while x < w {
        let pa = off_a + x * 4;
        let pb = off_b + x * 4;
        sum += u32::from(raw_a[pa].abs_diff(raw_b[pb]))
            + u32::from(raw_a[pa + 1].abs_diff(raw_b[pb + 1]))
            + u32::from(raw_a[pa + 2].abs_diff(raw_b[pb + 2]));
        cnt += 3;
        x += step;
    }
    if cnt == 0 {
        0.0
    } else {
        sum as f32 / cnt as f32
    }
}

/// Detects static sticky top header and sticky bottom footer rows that remain
/// essentially identical between two consecutive scroll frames.
fn detect_sticky_margins(prev: &RgbaImage, next: &RgbaImage, match_w: u32) -> (u32, u32) {
    let h = prev.height().min(next.height());
    let max_sticky = h / 3;

    let mut top = 0u32;
    while top < max_sticky && row_sad(prev, top, next, top, match_w) <= 1.0 {
        top += 1;
    }
    // Only treat as sticky header if a coherent strip >= 12 px stayed fixed
    // AND did not cover nearly the entire frame (which would mean no scroll happened).
    if top < 12 || top >= max_sticky {
        top = 0;
    }

    let mut bottom = 0u32;
    while bottom < max_sticky
        && top + bottom + 32 < h
        && row_sad(prev, h - 1 - bottom, next, h - 1 - bottom, match_w) <= 1.0
    {
        bottom += 1;
    }
    if bottom < 12 || bottom >= max_sticky {
        bottom = 0;
    }
    (top, bottom)
}

/// Computes mean RGB difference across the interior band (excluding scrollbar strip).
pub fn frame_band_sad(
    prev: &RgbaImage,
    next: &RgbaImage,
    top: u32,
    bottom: u32,
    match_w: u32,
) -> f32 {
    let h = prev.height().min(next.height());
    if top + bottom >= h {
        return 0.0;
    }
    let band_h = h - top - bottom;
    let y_step = (band_h / 64).max(1);
    let mut total = 0.0f32;
    let mut rows = 0u32;
    let mut y = top;
    while y < h - bottom {
        total += row_sad(prev, y, next, y, match_w);
        rows += 1;
        y += y_step;
    }
    if rows == 0 {
        0.0
    } else {
        total / rows as f32
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PairMatchOutcome {
    /// Essentially identical viewport (scroll reached bottom or cannot scroll).
    Unchanged,
    /// Reliable downward scroll of `dy` pixels found, with optimal seam cut and sticky margins.
    Aligned {
        dy: u32,
        sticky_top: u32,
        sticky_bottom: u32,
        match_sad: f32,
    },
    /// Content changed too much or lacked unambiguous texture to align safely.
    Failed,
}

/// Finds the exact vertical downward displacement `dy` between consecutive frames `prev` and `next`.
pub fn match_vertical_scroll_pair(prev: &RgbaImage, next: &RgbaImage) -> PairMatchOutcome {
    if prev.dimensions() != next.dimensions() || prev.width() < 16 || prev.height() < 40 {
        return PairMatchOutcome::Failed;
    }
    let (w, h) = prev.dimensions();
    // Exclude rightmost scrollbar strip (typically 12–24px at 100%–150% DPI)
    let scrollbar_margin = if w > 120 { (w / 14).clamp(16, 32) } else { 0 };
    let match_w = w.saturating_sub(scrollbar_margin).max(16);

    // Quick full-band check: did the viewport even move?
    let whole_sad = frame_band_sad(prev, next, 0, 0, match_w);
    if whole_sad < 1.3 {
        return PairMatchOutcome::Unchanged;
    }

    let (sticky_top, sticky_bottom) = detect_sticky_margins(prev, next, match_w);
    let band_start = sticky_top;
    let band_end = h.saturating_sub(sticky_bottom);
    if band_end <= band_start + 32 {
        return PairMatchOutcome::Unchanged;
    }
    let band_h = band_end - band_start;

    let band_sad = frame_band_sad(prev, next, band_start, sticky_bottom, match_w);
    if band_sad < 1.3 {
        return PairMatchOutcome::Unchanged;
    }

    let min_overlap = (band_h / 6).clamp(24, 140).min(band_h.saturating_sub(4));
    let max_dy = band_h.saturating_sub(min_overlap);
    if max_dy < 4 {
        return PairMatchOutcome::Failed;
    }

    // Coarse 1D row-signature scan across all candidate dy in [4 ..= max_dy]
    let sig_prev = compute_row_signatures(prev, match_w);
    let sig_next = compute_row_signatures(next, match_w);

    let mut coarse: Vec<(u32, f32)> = Vec::with_capacity((max_dy - 3) as usize);
    for dy in 4..=max_dy {
        let overlap = band_h - dy;
        let y_step = (overlap / 90).max(1);
        let mut acc = 0.0f32;
        let mut cnt = 0u32;
        let mut k = 0u32;
        while k < overlap {
            let sp = sig_prev[(band_start + dy + k) as usize];
            let sn = sig_next[(band_start + k) as usize];
            acc += (sp.r - sn.r).abs()
                + (sp.g - sn.g).abs()
                + (sp.b - sn.b).abs()
                + (sp.edge - sn.edge).abs() * 1.5;
            cnt += 1;
            k += y_step;
        }
        coarse.push((dy, if cnt > 0 { acc / cnt as f32 } else { 999.0 }));
    }

    coarse.sort_by(|a, b| a.1.total_cmp(&b.1));

    // Evaluate exact 2D RGB SAD on top 32 coarse candidates (spread across distinct dy)
    let mut refined: Vec<(u32, f32)> = Vec::new();
    for &(dy, _) in coarse.iter().take(48) {
        if refined.len() >= 32 {
            break;
        }
        let overlap = band_h - dy;
        let y_step = (overlap / 80).max(1);
        let mut acc = 0.0f32;
        let mut cnt = 0u32;
        let mut k = 0u32;
        while k < overlap {
            acc += row_sad(prev, band_start + dy + k, next, band_start + k, match_w);
            cnt += 1;
            k += y_step;
        }
        let score = if cnt > 0 { acc / cnt as f32 } else { 999.0 };
        refined.push((dy, score));
    }

    // Also probe fine ±2px neighborhood around best refined candidate for pixel-exact lock
    refined.sort_by(|a, b| a.1.total_cmp(&b.1));
    if let Some(&(best_dy0, _)) = refined.first() {
        for delta in -2i32..=2i32 {
            let cand = best_dy0 as i32 + delta;
            if cand >= 4 && (cand as u32) <= max_dy {
                let dy = cand as u32;
                if !refined.iter().any(|&(d, _)| d == dy) {
                    let overlap = band_h - dy;
                    let y_step = (overlap / 120).max(1);
                    let mut acc = 0.0f32;
                    let mut cnt = 0u32;
                    let mut k = 0u32;
                    while k < overlap {
                        acc += row_sad(prev, band_start + dy + k, next, band_start + k, match_w);
                        cnt += 1;
                        k += y_step;
                    }
                    refined.push((dy, if cnt > 0 { acc / cnt as f32 } else { 999.0 }));
                }
            }
        }
        refined.sort_by(|a, b| a.1.total_cmp(&b.1));
    }

    let Some(&(best_dy, best_score)) = refined.first() else {
        return PairMatchOutcome::Failed;
    };

    // Measure vertical signal variation inside the overlapping strip of `next`
    // so totally flat blank pages cannot fake an alignment.
    let overlap = band_h - best_dy;
    let mut mean_r = 0.0f32;
    let mut mean_g = 0.0f32;
    let mut mean_b = 0.0f32;
    for k in 0..overlap {
        let s = sig_next[(band_start + k) as usize];
        mean_r += s.r;
        mean_g += s.g;
        mean_b += s.b;
    }
    let inv = 1.0 / (overlap.max(1) as f32);
    mean_r *= inv;
    mean_g *= inv;
    mean_b *= inv;
    let mut row_var = 0.0f32;
    for k in 0..overlap {
        let s = sig_next[(band_start + k) as usize];
        row_var += (s.r - mean_r).abs() + (s.g - mean_g).abs() + (s.b - mean_b).abs() + s.edge;
    }
    row_var *= inv;

    // Second-best distinct candidate outside ±6px window
    let second_best = refined
        .iter()
        .find(|&&(dy, _)| dy.abs_diff(best_dy) > 6)
        .map(|&(_, s)| s)
        .unwrap_or(999.0);

    let reliable = if best_score <= 3.0 {
        // Ultra-crisp pixel match: require non-trivial texture OR clearly better than alternatives
        row_var >= 2.0 || second_best >= best_score + 4.0
    } else if best_score <= 9.5 {
        // Moderate match (e.g. slight subpixel AA / scrollbar animation): require clear uniqueness
        row_var >= 3.0 && second_best >= best_score * 1.35 + 2.0
    } else {
        false
    };

    if !reliable {
        return PairMatchOutcome::Failed;
    }

    PairMatchOutcome::Aligned {
        dy: best_dy,
        sticky_top,
        sticky_bottom,
        match_sad: best_score,
    }
}

/// Incremental vertical stitcher accumulating clean scroll frames into a single tall RGBA image.
pub struct VerticalStitcher {
    width: u32,
    frame_height: u32,
    max_height: u32,
    max_pixels: u64,
    /// Top header rows preserved once at the very top of the stitched result.
    header_rows: Vec<u8>,
    header_height: u32,
    /// Accumulated scrollable body rows (strictly excluding sticky top & bottom).
    body_rows: Vec<u8>,
    body_height: u32,
    /// Latest bottom footer rows preserved once at the very bottom.
    footer_rows: Vec<u8>,
    footer_height: u32,
    last_frame: RgbaImage,
    frame_count: u32,
    sticky_locked: Option<(u32, u32)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StitchPushOutcome {
    Appended { new_total_height: u32, dy: u32 },
    Unchanged,
    AlignmentFailed,
    SizeLimitReached,
}

impl VerticalStitcher {
    pub fn new(first_frame: RgbaImage, max_height: u32) -> Self {
        let (width, frame_height) = first_frame.dimensions();
        let capped_h = max_height.clamp(frame_height, MAX_ASSET_SIDE);
        Self {
            width,
            frame_height,
            max_height: capped_h,
            max_pixels: MAX_ASSET_PIXELS,
            header_rows: Vec::new(),
            header_height: 0,
            body_rows: first_frame.as_raw().clone(),
            body_height: frame_height,
            footer_rows: Vec::new(),
            footer_height: 0,
            last_frame: first_frame,
            frame_count: 1,
            sticky_locked: None,
        }
    }

    pub fn total_height(&self) -> u32 {
        self.header_height + self.body_height + self.footer_height
    }

    pub fn frame_count(&self) -> u32 {
        self.frame_count
    }

    pub fn push_frame(&mut self, next_frame: RgbaImage) -> StitchPushOutcome {
        if next_frame.dimensions() != (self.width, self.frame_height) {
            return StitchPushOutcome::AlignmentFailed;
        }
        let stride = (self.width as usize) * 4;

        match match_vertical_scroll_pair(&self.last_frame, &next_frame) {
            PairMatchOutcome::Unchanged => StitchPushOutcome::Unchanged,
            PairMatchOutcome::Failed => StitchPushOutcome::AlignmentFailed,
            PairMatchOutcome::Aligned {
                dy,
                sticky_top,
                sticky_bottom,
                ..
            } => {
                // On the very first real scroll transition, split out sticky header & footer
                // so they appear cleanly ONCE instead of repeating on every appended slice.
                let (eff_top, eff_bottom) = match self.sticky_locked {
                    Some(locked) => locked,
                    None => {
                        self.sticky_locked = Some((sticky_top, sticky_bottom));
                        if sticky_top > 0 || sticky_bottom > 0 {
                            let full = self.last_frame.as_raw();
                            self.header_rows = full[0..(sticky_top as usize) * stride].to_vec();
                            self.header_height = sticky_top;
                            let body_end_row = self.frame_height - sticky_bottom;
                            self.body_rows = full
                                [(sticky_top as usize) * stride..(body_end_row as usize) * stride]
                                .to_vec();
                            self.body_height = body_end_row - sticky_top;
                            self.footer_rows = full[(body_end_row as usize) * stride..].to_vec();
                            self.footer_height = sticky_bottom;
                        }
                        (sticky_top, sticky_bottom)
                    }
                };

                let band_end = self.frame_height - eff_bottom;
                let append_start_row = band_end.saturating_sub(dy);
                let append_rows = band_end.saturating_sub(append_start_row);
                if append_rows == 0 {
                    return StitchPushOutcome::Unchanged;
                }

                let projected_h = self.total_height().saturating_add(append_rows);
                if projected_h > self.max_height
                    || u64::from(self.width) * u64::from(projected_h) > self.max_pixels
                {
                    return StitchPushOutcome::SizeLimitReached;
                }

                let next_raw = next_frame.as_raw();
                // Copy newly revealed bottom rows of the scrollable band
                let slice_start = (append_start_row as usize) * stride;
                let slice_end = (band_end as usize) * stride;
                self.body_rows
                    .extend_from_slice(&next_raw[slice_start..slice_end]);
                self.body_height += append_rows;

                // Keep the latest footer pixels (e.g., if footer showed final status)
                if eff_bottom > 0 {
                    self.footer_rows = next_raw[(band_end as usize) * stride..].to_vec();
                    self.footer_height = eff_bottom;
                }

                let _ = eff_top; // header already captured cleanly from frame 0
                self.last_frame = next_frame;
                self.frame_count += 1;

                StitchPushOutcome::Appended {
                    new_total_height: self.total_height(),
                    dy: append_rows,
                }
            }
        }
    }

    pub fn into_image(self) -> RgbaImage {
        let total_h = self.total_height();
        let mut all = Vec::with_capacity((self.width as usize) * (total_h as usize) * 4);
        all.extend_from_slice(&self.header_rows);
        all.extend_from_slice(&self.body_rows);
        all.extend_from_slice(&self.footer_rows);
        RgbaImage::from_raw(self.width, total_h, all).unwrap_or_else(|| {
            RgbaImage::from_pixel(self.width.max(1), 1, Rgba([255, 255, 255, 255]))
        })
    }
}

/// Pure helper used by unit tests to stitch a pre-recorded sequence of frames.
pub fn stitch_frame_sequence(
    frames: Vec<RgbaImage>,
    max_height: u32,
) -> Result<(RgbaImage, u32, ScrollStopReason, bool), AppError> {
    let mut iter = frames.into_iter();
    let first = iter
        .next()
        .ok_or_else(|| AppError::invalid_param("At least one frame is required to stitch."))?;
    let mut stitcher = VerticalStitcher::new(first, max_height);
    let mut unchanged_streak = 0u32;

    for frame in iter {
        match stitcher.push_frame(frame) {
            StitchPushOutcome::Appended { .. } => {
                unchanged_streak = 0;
            }
            StitchPushOutcome::Unchanged => {
                unchanged_streak += 1;
                if unchanged_streak >= 1 {
                    let count = stitcher.frame_count();
                    return Ok((
                        stitcher.into_image(),
                        count,
                        ScrollStopReason::ReachedBottom,
                        false,
                    ));
                }
            }
            StitchPushOutcome::AlignmentFailed => {
                let count = stitcher.frame_count();
                return Ok((
                    stitcher.into_image(),
                    count,
                    ScrollStopReason::AlignmentFailed,
                    true,
                ));
            }
            StitchPushOutcome::SizeLimitReached => {
                let count = stitcher.frame_count();
                return Ok((
                    stitcher.into_image(),
                    count,
                    ScrollStopReason::SizeLimitReached,
                    true,
                ));
            }
        }
    }

    let count = stitcher.frame_count();
    let reason = if count <= 1 {
        ScrollStopReason::SingleFrameOnly
    } else {
        ScrollStopReason::ReachedBottom
    };
    Ok((stitcher.into_image(), count, reason, false))
}

// ---------------------------------------------------------------------------
// Native Windows 11 Capture Implementation
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod win_impl {
    use super::*;
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::ptr::null_mut;
    use windows::core::{BOOL, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows::Win32::Graphics::Dwm::{
        DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
    };
    use windows::Win32::Graphics::Gdi::{
        BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateDIBSection,
        CreateFontW, CreatePen, CreateSolidBrush, DeleteDC, DeleteObject, DrawTextW, EndPaint,
        EnumDisplayMonitors, FillRect, GetDC, GetMonitorInfoW, InvalidateRect, LineTo, MoveToEx,
        ReleaseDC, SelectObject, SetBkMode, SetTextColor, UpdateWindow, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET,
        DEFAULT_PITCH, DIB_RGB_COLORS, DT_CENTER, DT_SINGLELINE, DT_VCENTER, FF_SWISS, HBITMAP,
        HDC, HGDIOBJ, HMONITOR, MONITORINFOEXW, OUT_DEFAULT_PRECIS, PAINTSTRUCT, PS_SOLID, SRCCOPY,
        TRANSPARENT,
    };
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::StationsAndDesktops::{
        CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_ACCESS_FLAGS,
        DESKTOP_CONTROL_FLAGS, UOI_NAME,
    };
    use windows::Win32::System::Threading::{
        GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, ReleaseCapture, SendInput, SetCapture, INPUT, INPUT_0, INPUT_MOUSE,
        MOUSEEVENTF_WHEEL, MOUSEINPUT, VK_ESCAPE,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, DrawIconEx, EnumWindows,
        GetCursorInfo, GetIconInfo, GetMessageW, GetSystemMetrics, GetWindowDisplayAffinity,
        GetWindowLongPtrW, GetWindowLongW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, KillTimer, LoadCursorW,
        PeekMessageW, PostMessageW, PostQuitMessage, RegisterClassExW, SetCursorPos, SetTimer,
        SetWindowDisplayAffinity, SetWindowLongPtrW, ShowWindow, TranslateMessage, WindowFromPoint,
        CS_HREDRAW, CS_VREDRAW, CURSORINFO, CURSOR_SHOWING, DI_NORMAL, GWLP_USERDATA, GWL_EXSTYLE,
        ICONINFO, IDC_ARROW, IDC_CROSS, MSG, PM_REMOVE, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
        SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SW_SHOW, SW_SHOWNA, WDA_EXCLUDEFROMCAPTURE,
        WM_DESTROY, WM_ERASEBKGND, WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE,
        WM_MOUSEWHEEL, WM_PAINT, WM_RBUTTONDOWN, WM_TIMER, WNDCLASSEXW, WS_EX_APPWINDOW,
        WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
    };

    const PW_RENDERFULLCONTENT_FLAG: u32 = 0x0000_0002;
    const MONITORINFOF_PRIMARY_FLAG: u32 = 0x0000_0001;

    fn wide_z(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn is_escape_pressed() -> bool {
        unsafe { (GetAsyncKeyState(i32::from(VK_ESCAPE.0)) as u16 & 0x8000) != 0 }
    }

    pub fn list_monitors() -> Vec<CaptureMonitorInfo> {
        unsafe extern "system" fn enum_proc(
            hmon: HMONITOR,
            _hdc: HDC,
            _rc: *mut RECT,
            data: LPARAM,
        ) -> BOOL {
            let list = &mut *(data.0 as *mut Vec<CaptureMonitorInfo>);
            let mut info: MONITORINFOEXW = std::mem::zeroed();
            info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
            if GetMonitorInfoW(hmon, &mut info.monitorInfo as *mut _).as_bool() {
                let r = info.monitorInfo.rcMonitor;
                let w = (r.right - r.left).max(0) as u32;
                let h = (r.bottom - r.top).max(0) as u32;
                let end = info
                    .szDevice
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(info.szDevice.len());
                let device_name = OsString::from_wide(&info.szDevice[..end])
                    .to_string_lossy()
                    .into_owned();
                let mut dpi_x = 96u32;
                let mut dpi_y = 96u32;
                let _ = GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
                let scale_percent = ((dpi_x * 100 + 48) / 96).max(100);
                let is_primary = (info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY_FLAG) != 0;
                let idx = list.len() + 1;
                list.push(CaptureMonitorInfo {
                    id: format!("monitor-{idx}"),
                    device_name,
                    is_primary,
                    x: r.left,
                    y: r.top,
                    width: w,
                    height: h,
                    scale_percent,
                });
            }
            BOOL(1)
        }

        let mut out: Vec<CaptureMonitorInfo> = Vec::new();
        unsafe {
            let _ = EnumDisplayMonitors(
                None,
                None,
                Some(enum_proc),
                LPARAM(&mut out as *mut Vec<CaptureMonitorInfo> as isize),
            );
        }
        out.sort_by_key(|m| !m.is_primary);
        out
    }

    fn query_process_exe_name(pid: u32) -> String {
        unsafe {
            let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return String::new();
            };
            let mut buf = vec![0u16; 512];
            let mut size = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_FORMAT(0),
                PWSTR(buf.as_mut_ptr()),
                &mut size,
            )
            .is_ok();
            let _ = windows::Win32::Foundation::CloseHandle(handle);
            if !ok || size == 0 {
                return String::new();
            }
            let full = OsString::from_wide(&buf[..size as usize])
                .to_string_lossy()
                .into_owned();
            std::path::Path::new(&full)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or(full)
        }
    }

    fn get_window_extended_bounds(hwnd: HWND) -> Option<RECT> {
        unsafe {
            let mut ext: RECT = std::mem::zeroed();
            if DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut ext as *mut _ as *mut _,
                std::mem::size_of::<RECT>() as u32,
            )
            .is_ok()
                && ext.right > ext.left
                && ext.bottom > ext.top
            {
                return Some(ext);
            }
            let mut rc: RECT = std::mem::zeroed();
            if GetWindowRect(hwnd, &mut rc).is_ok() && rc.right > rc.left && rc.bottom > rc.top {
                return Some(rc);
            }
            None
        }
    }

    pub fn list_windows() -> Vec<CaptureWindowInfo> {
        struct EnumCtx {
            self_pid: u32,
            items: Vec<CaptureWindowInfo>,
        }

        unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let ctx = &mut *(lparam.0 as *mut EnumCtx);
            if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                return BOOL(1);
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 || pid == ctx.self_pid {
                return BOOL(1);
            }

            let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
            if (ex & WS_EX_TOOLWINDOW.0) != 0 && (ex & WS_EX_APPWINDOW.0) == 0 {
                return BOOL(1);
            }

            let mut cloaked: u32 = 0;
            if DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut _ as *mut _,
                std::mem::size_of::<u32>() as u32,
            )
            .is_ok()
                && cloaked != 0
            {
                return BOOL(1);
            }

            let len = GetWindowTextLengthW(hwnd);
            if len <= 0 {
                return BOOL(1);
            }
            let mut title_buf = vec![0u16; (len + 1) as usize];
            let copied = GetWindowTextW(hwnd, &mut title_buf);
            if copied <= 0 {
                return BOOL(1);
            }
            let title = OsString::from_wide(&title_buf[..copied as usize])
                .to_string_lossy()
                .trim()
                .to_string();
            if title.is_empty() || title == "Program Manager" {
                return BOOL(1);
            }

            let Some(rc) = get_window_extended_bounds(hwnd) else {
                return BOOL(1);
            };
            let w = (rc.right - rc.left).max(0) as u32;
            let h = (rc.bottom - rc.top).max(0) as u32;
            if w < 48 || h < 32 {
                return BOOL(1);
            }

            let mut affinity = 0u32;
            let is_protected =
                GetWindowDisplayAffinity(hwnd, &mut affinity).is_ok() && affinity != 0;
            let process_name = query_process_exe_name(pid);

            ctx.items.push(CaptureWindowInfo {
                hwnd: hwnd.0 as usize as u64,
                title,
                process_name,
                x: rc.left,
                y: rc.top,
                width: w,
                height: h,
                is_protected,
            });
            BOOL(1)
        }

        let mut ctx = EnumCtx {
            self_pid: unsafe { GetCurrentProcessId() },
            items: Vec::new(),
        };
        unsafe {
            let _ = EnumWindows(Some(enum_proc), LPARAM(&mut ctx as *mut EnumCtx as isize));
        }
        ctx.items
    }

    pub fn virtual_screen_rect() -> CaptureRect {
        unsafe {
            let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
            let w = GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1) as u32;
            let h = GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1) as u32;
            CaptureRect {
                x,
                y,
                width: w,
                height: h,
            }
        }
    }

    unsafe fn draw_cursor_onto_dc(mem_dc: HDC, origin_x: i32, origin_y: i32, w: u32, h: u32) {
        let mut ci: CURSORINFO = std::mem::zeroed();
        ci.cbSize = std::mem::size_of::<CURSORINFO>() as u32;
        if GetCursorInfo(&mut ci).is_err() || (ci.flags.0 & CURSOR_SHOWING.0) == 0 {
            return;
        }
        if ci.hCursor.is_invalid() {
            return;
        }
        let mut ii: ICONINFO = std::mem::zeroed();
        let (hx, hy) = if GetIconInfo(ci.hCursor.into(), &mut ii).is_ok() {
            if !ii.hbmColor.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(ii.hbmColor.0));
            }
            if !ii.hbmMask.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(ii.hbmMask.0));
            }
            (ii.xHotspot as i32, ii.yHotspot as i32)
        } else {
            (0, 0)
        };
        let cx = ci.ptScreenPos.x - hx - origin_x;
        let cy = ci.ptScreenPos.y - hy - origin_y;
        if cx > -64 && cy > -64 && cx < (w as i32) + 64 && cy < (h as i32) + 64 {
            let _ = DrawIconEx(mem_dc, cx, cy, ci.hCursor.into(), 0, 0, 0, None, DI_NORMAL);
        }
    }

    /// Verifies that the interactive user desktop (`Default`) is currently active — never falls
    /// back when the workstation is locked (`Winlogon`) or showing a UAC secure desktop.
    unsafe fn is_default_desktop_active() -> bool {
        const DESKTOP_READOBJECTS_MASK: u32 = 0x0001;
        let Ok(hdesk) = OpenInputDesktop(
            DESKTOP_CONTROL_FLAGS(0),
            false,
            DESKTOP_ACCESS_FLAGS(DESKTOP_READOBJECTS_MASK),
        ) else {
            return false;
        };
        let mut buf = [0u16; 128];
        let mut needed = 0u32;
        let ok = GetUserObjectInformationW(
            windows::Win32::Foundation::HANDLE(hdesk.0),
            UOI_NAME,
            Some(buf.as_mut_ptr() as *mut std::ffi::c_void),
            (buf.len() * std::mem::size_of::<u16>()) as u32,
            Some(&mut needed),
        )
        .is_ok();
        let _ = CloseDesktop(hdesk);
        if !ok {
            return false;
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        let name = OsString::from_wide(&buf[..end])
            .to_string_lossy()
            .into_owned();
        name.eq_ignore_ascii_case("Default")
    }

    /// Fallback when GDI desktop `BitBlt` is unavailable on an unlocked user desktop (e.g. display
    /// panel asleep on a hybrid-GPU laptop): composites visible top-level windows overlapping `rect`
    /// bottom-to-top using `PrintWindow(PW_RENDERFULLCONTENT)`, strictly excluding WinKit's own PID
    /// and blacking out any protected (`GetWindowDisplayAffinity != 0`) windows.
    unsafe fn composite_unlocked_windows_fallback(
        mem_dc: HDC,
        screen_dc: HDC,
        rect: CaptureRect,
    ) -> bool {
        if !is_default_desktop_active() {
            return false;
        }

        struct Candidate {
            hwnd: HWND,
            win_rc: RECT,
            ext_rc: RECT,
            is_protected: bool,
        }
        struct EnumState {
            self_pid: u32,
            target: RECT,
            list: Vec<Candidate>,
        }

        unsafe extern "system" fn collect_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let st = &mut *(lparam.0 as *mut EnumState);
            if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                return BOOL(1);
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 || pid == st.self_pid {
                return BOOL(1);
            }
            let mut cloaked: u32 = 0;
            if DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut _ as *mut _,
                std::mem::size_of::<u32>() as u32,
            )
            .is_ok()
                && cloaked != 0
            {
                return BOOL(1);
            }
            let mut win_rc: RECT = std::mem::zeroed();
            if GetWindowRect(hwnd, &mut win_rc).is_err() {
                return BOOL(1);
            }
            let ext_rc = get_window_extended_bounds(hwnd).unwrap_or(win_rc);
            if ext_rc.right <= st.target.left
                || ext_rc.left >= st.target.right
                || ext_rc.bottom <= st.target.top
                || ext_rc.top >= st.target.bottom
            {
                return BOOL(1);
            }
            let mut affinity = 0u32;
            let is_protected =
                GetWindowDisplayAffinity(hwnd, &mut affinity).is_ok() && affinity != 0;
            st.list.push(Candidate {
                hwnd,
                win_rc,
                ext_rc,
                is_protected,
            });
            BOOL(1)
        }

        let target = RECT {
            left: rect.x,
            top: rect.y,
            right: rect.x.saturating_add(rect.width as i32),
            bottom: rect.y.saturating_add(rect.height as i32),
        };
        let mut state = EnumState {
            self_pid: GetCurrentProcessId(),
            target,
            list: Vec::new(),
        };
        let _ = EnumWindows(
            Some(collect_proc),
            LPARAM(&mut state as *mut EnumState as isize),
        );
        if state.list.is_empty() {
            return false;
        }

        // Composite bottom-to-top in Z-order
        state.list.reverse();
        let black_brush = CreateSolidBrush(COLORREF(0x0000_0000));
        let mut rendered_any = false;

        for cand in state.list {
            let il = cand.ext_rc.left.max(target.left);
            let it = cand.ext_rc.top.max(target.top);
            let ir = cand.ext_rc.right.min(target.right);
            let ib = cand.ext_rc.bottom.min(target.bottom);
            if ir <= il || ib <= it {
                continue;
            }

            if cand.is_protected {
                let local = RECT {
                    left: il - target.left,
                    top: it - target.top,
                    right: ir - target.left,
                    bottom: ib - target.top,
                };
                let _ = FillRect(mem_dc, &local, black_brush);
                rendered_any = true;
                continue;
            }

            let ww = (cand.win_rc.right - cand.win_rc.left).max(0) as u32;
            let wh = (cand.win_rc.bottom - cand.win_rc.top).max(0) as u32;
            if ww == 0
                || wh == 0
                || ww > MAX_ASSET_SIDE
                || wh > MAX_ASSET_SIDE
                || u64::from(ww) * u64::from(wh) > MAX_ASSET_PIXELS
            {
                continue;
            }

            let win_dc = CreateCompatibleDC(Some(screen_dc));
            if win_dc.is_invalid() {
                continue;
            }
            let bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: ww as i32,
                    biHeight: -(wh as i32),
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..std::mem::zeroed()
                },
                ..std::mem::zeroed()
            };
            let mut tmp_bits: *mut std::ffi::c_void = null_mut();
            if let Ok(wbmp) = CreateDIBSection(
                Some(screen_dc),
                &bmi,
                DIB_RGB_COLORS,
                &mut tmp_bits,
                None,
                0,
            ) {
                let wold = SelectObject(win_dc, HGDIOBJ(wbmp.0));
                if PrintWindow(
                    cand.hwnd,
                    win_dc,
                    PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT_FLAG),
                )
                .as_bool()
                {
                    let dst_x = il - target.left;
                    let dst_y = it - target.top;
                    let src_x = il - cand.win_rc.left;
                    let src_y = it - cand.win_rc.top;
                    let cw = ir - il;
                    let ch = ib - it;
                    if BitBlt(
                        mem_dc,
                        dst_x,
                        dst_y,
                        cw,
                        ch,
                        Some(win_dc),
                        src_x,
                        src_y,
                        SRCCOPY,
                    )
                    .is_ok()
                    {
                        rendered_any = true;
                    }
                }
                let _ = SelectObject(win_dc, wold);
                let _ = DeleteObject(HGDIOBJ(wbmp.0));
            }
            let _ = DeleteDC(win_dc);
        }

        let _ = DeleteObject(HGDIOBJ(black_brush.0));
        rendered_any
    }

    /// Captures an exact physical screen rectangle via GDI BitBlt into a 32-bit top-down DIB,
    /// falling back to Z-ordered `PrintWindow` compositing on unlocked desktops if the GDI screen
    /// surface is temporarily unavailable (e.g. display panel off on hybrid-GPU laptops).
    pub fn capture_screen_rect(
        rect: CaptureRect,
        include_cursor: bool,
    ) -> Result<RgbaImage, AppError> {
        if rect.width == 0 || rect.height == 0 {
            return Err(AppError::invalid_param(
                "Capture region must have positive width and height.",
            ));
        }
        if rect.width > MAX_ASSET_SIDE
            || rect.height > MAX_ASSET_SIDE
            || u64::from(rect.width) * u64::from(rect.height) > MAX_ASSET_PIXELS
        {
            return Err(AppError::size_limit(
                "Capture region exceeds maximum dimensions.",
            ));
        }

        unsafe {
            let screen_dc = GetDC(None);
            if screen_dc.is_invalid() {
                return Err(AppError::new(
                    "CAPTURE_UNAVAILABLE",
                    "Unable to acquire Windows desktop DC.",
                ));
            }
            let mem_dc = CreateCompatibleDC(Some(screen_dc));
            if mem_dc.is_invalid() {
                let _ = ReleaseDC(None, screen_dc);
                return Err(AppError::new(
                    "CAPTURE_UNAVAILABLE",
                    "Unable to allocate compatible DC.",
                ));
            }

            let bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: rect.width as i32,
                    biHeight: -(rect.height as i32), // top-down
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..std::mem::zeroed()
                },
                ..std::mem::zeroed()
            };

            let mut bits_ptr: *mut std::ffi::c_void = null_mut();
            let dib = CreateDIBSection(
                Some(screen_dc),
                &bmi,
                DIB_RGB_COLORS,
                &mut bits_ptr,
                None,
                0,
            );
            let Ok(hbitmap) = dib else {
                let _ = DeleteDC(mem_dc);
                let _ = ReleaseDC(None, screen_dc);
                return Err(AppError::new(
                    "CAPTURE_UNAVAILABLE",
                    "Unable to create DIB capture buffer.",
                ));
            };

            let old = SelectObject(mem_dc, HGDIOBJ(hbitmap.0));
            let mut blt_ok = BitBlt(
                mem_dc,
                0,
                0,
                rect.width as i32,
                rect.height as i32,
                Some(screen_dc),
                rect.x,
                rect.y,
                SRCCOPY,
            )
            .is_ok();

            if !blt_ok {
                blt_ok = composite_unlocked_windows_fallback(mem_dc, screen_dc, rect);
            }

            if blt_ok && include_cursor {
                draw_cursor_onto_dc(mem_dc, rect.x, rect.y, rect.width, rect.height);
            }

            let total_px = (rect.width as usize) * (rect.height as usize);
            let mut rgba = vec![0u8; total_px * 4];
            if blt_ok && !bits_ptr.is_null() {
                let src = std::slice::from_raw_parts(bits_ptr as *const u8, total_px * 4);
                for i in 0..total_px {
                    let o = i * 4;
                    rgba[o] = src[o + 2]; // R
                    rgba[o + 1] = src[o + 1]; // G
                    rgba[o + 2] = src[o]; // B
                    rgba[o + 3] = 255; // Opaque
                }
            }

            let _ = SelectObject(mem_dc, old);
            let _ = DeleteObject(HGDIOBJ(hbitmap.0));
            let _ = DeleteDC(mem_dc);
            let _ = ReleaseDC(None, screen_dc);

            if !blt_ok {
                return Err(AppError::new(
                    "CAPTURE_UNAVAILABLE",
                    "Screen BitBlt failed; desktop may be locked or protected.",
                ));
            }

            RgbaImage::from_raw(rect.width, rect.height, rgba)
                .ok_or_else(|| AppError::decode_failed("Failed constructing captured RGBA buffer."))
        }
    }

    /// Captures a specific top-level window using PrintWindow(PW_RENDERFULLCONTENT)
    /// so partially occluded windows capture their full un-occluded contents, while
    /// strictly respecting Windows display affinity (protected content).
    pub fn capture_window(
        hwnd_raw: u64,
        include_cursor: bool,
    ) -> Result<(RgbaImage, CaptureRect, String), AppError> {
        let hwnd = HWND(hwnd_raw as usize as *mut std::ffi::c_void);
        unsafe {
            if !IsWindow(Some(hwnd)).as_bool() {
                return Err(AppError::new(
                    "CAPTURE_UNAVAILABLE",
                    "Target window is no longer open.",
                ));
            }
            if IsIconic(hwnd).as_bool() {
                return Err(AppError::new(
                    "CAPTURE_UNAVAILABLE",
                    "Target window is minimized; restore it before capturing.",
                ));
            }

            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == GetCurrentProcessId() {
                return Err(AppError::invalid_param(
                    "WinKit's own window is excluded from window capture.",
                ));
            }

            let mut affinity = 0u32;
            if GetWindowDisplayAffinity(hwnd, &mut affinity).is_ok() && affinity != 0 {
                return Err(AppError::new(
                    "CAPTURE_PROTECTED",
                    "Target window is protected against screen capture by Windows display affinity.",
                ));
            }

            let mut win_rc: RECT = std::mem::zeroed();
            if GetWindowRect(hwnd, &mut win_rc).is_err()
                || win_rc.right <= win_rc.left
                || win_rc.bottom <= win_rc.top
            {
                return Err(AppError::new(
                    "CAPTURE_UNAVAILABLE",
                    "Unable to query target window bounds.",
                ));
            }
            let ext_rc = get_window_extended_bounds(hwnd).unwrap_or(win_rc);

            let full_w = (win_rc.right - win_rc.left) as u32;
            let full_h = (win_rc.bottom - win_rc.top) as u32;
            if full_w == 0
                || full_h == 0
                || full_w > MAX_ASSET_SIDE
                || full_h > MAX_ASSET_SIDE
                || u64::from(full_w) * u64::from(full_h) > MAX_ASSET_PIXELS
            {
                return Err(AppError::size_limit(
                    "Target window exceeds maximum capture bounds.",
                ));
            }

            let screen_dc = GetDC(None);
            if screen_dc.is_invalid() {
                return Err(AppError::new(
                    "CAPTURE_UNAVAILABLE",
                    "Unable to acquire desktop DC.",
                ));
            }
            let mem_dc = CreateCompatibleDC(Some(screen_dc));
            if mem_dc.is_invalid() {
                let _ = ReleaseDC(None, screen_dc);
                return Err(AppError::new(
                    "CAPTURE_UNAVAILABLE",
                    "Unable to allocate capture DC.",
                ));
            }

            let bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: full_w as i32,
                    biHeight: -(full_h as i32),
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..std::mem::zeroed()
                },
                ..std::mem::zeroed()
            };
            let mut bits_ptr: *mut std::ffi::c_void = null_mut();
            let Ok(hbitmap) = CreateDIBSection(
                Some(screen_dc),
                &bmi,
                DIB_RGB_COLORS,
                &mut bits_ptr,
                None,
                0,
            ) else {
                let _ = DeleteDC(mem_dc);
                let _ = ReleaseDC(None, screen_dc);
                return Err(AppError::new(
                    "CAPTURE_UNAVAILABLE",
                    "Unable to create window DIB buffer.",
                ));
            };

            let old = SelectObject(mem_dc, HGDIOBJ(hbitmap.0));
            let ok =
                PrintWindow(hwnd, mem_dc, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT_FLAG)).as_bool();

            if ok && include_cursor {
                draw_cursor_onto_dc(mem_dc, win_rc.left, win_rc.top, full_w, full_h);
            }

            let total_px = (full_w as usize) * (full_h as usize);
            let mut full_rgba = vec![0u8; total_px * 4];
            let mut any_non_zero = false;
            if ok && !bits_ptr.is_null() {
                let src = std::slice::from_raw_parts(bits_ptr as *const u8, total_px * 4);
                for i in 0..total_px {
                    let o = i * 4;
                    let r = src[o + 2];
                    let g = src[o + 1];
                    let b = src[o];
                    if (r | g | b) != 0 {
                        any_non_zero = true;
                    }
                    full_rgba[o] = r;
                    full_rgba[o + 1] = g;
                    full_rgba[o + 2] = b;
                    full_rgba[o + 3] = 255;
                }
            }

            let _ = SelectObject(mem_dc, old);
            let _ = DeleteObject(HGDIOBJ(hbitmap.0));
            let _ = DeleteDC(mem_dc);
            let _ = ReleaseDC(None, screen_dc);

            if !ok || !any_non_zero {
                return Err(AppError::new(
                    "CAPTURE_UNAVAILABLE",
                    "Windows did not return renderable content for this window (it may be protected, elevated, or hardware-protected).",
                ));
            }

            let full_img = RgbaImage::from_raw(full_w, full_h, full_rgba)
                .ok_or_else(|| AppError::decode_failed("Failed building captured window image."))?;

            // Crop invisible Windows 11 drop-shadow margins using DWMWA_EXTENDED_FRAME_BOUNDS
            let crop_x = (ext_rc.left - win_rc.left).max(0) as u32;
            let crop_y = (ext_rc.top - win_rc.top).max(0) as u32;
            let crop_w =
                ((ext_rc.right - ext_rc.left).max(1) as u32).min(full_w.saturating_sub(crop_x));
            let crop_h =
                ((ext_rc.bottom - ext_rc.top).max(1) as u32).min(full_h.saturating_sub(crop_y));

            let cropped = if crop_x == 0 && crop_y == 0 && crop_w == full_w && crop_h == full_h {
                full_img
            } else {
                image::imageops::crop_imm(&full_img, crop_x, crop_y, crop_w, crop_h).to_image()
            };

            let len = GetWindowTextLengthW(hwnd);
            let title = if len > 0 {
                let mut buf = vec![0u16; (len + 1) as usize];
                let n = GetWindowTextW(hwnd, &mut buf);
                OsString::from_wide(&buf[..n.max(0) as usize])
                    .to_string_lossy()
                    .into_owned()
            } else {
                "window".into()
            };

            Ok((
                cropped,
                CaptureRect {
                    x: win_rc.left + crop_x as i32,
                    y: win_rc.top + crop_y as i32,
                    width: crop_w,
                    height: crop_h,
                },
                title,
            ))
        }
    }

    // --- Small topmost WDA_EXCLUDEFROMCAPTURE floating HUD (Countdown & Scroll Stop) ---

    struct HudWindow {
        hwnd: HWND,
        state: Box<HudState>,
    }

    struct HudState {
        text: String,
        stop_clicked: Arc<AtomicBool>,
        clickable: bool,
    }

    unsafe extern "system" fn hud_wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut HudState;
        match msg {
            WM_ERASEBKGND => LRESULT(1),
            WM_LBUTTONDOWN => {
                if !ptr.is_null() {
                    let st = &*ptr;
                    if st.clickable {
                        st.stop_clicked.store(true, Ordering::Relaxed);
                    }
                }
                LRESULT(0)
            }
            WM_KEYDOWN => {
                if wparam.0 == usize::from(VK_ESCAPE.0) && !ptr.is_null() {
                    let st = &*ptr;
                    st.stop_clicked.store(true, Ordering::Relaxed);
                }
                LRESULT(0)
            }
            WM_PAINT => {
                let mut ps: PAINTSTRUCT = std::mem::zeroed();
                let hdc = BeginPaint(hwnd, &mut ps);
                let mut rc: RECT = std::mem::zeroed();
                let _ = windows::Win32::UI::WindowsAndMessaging::GetClientRect(hwnd, &mut rc);
                let bg = CreateSolidBrush(COLORREF(0x0024_1E18)); // dark slate BGR
                let border = CreateSolidBrush(COLORREF(0x00EB_6325)); // accent blue BGR
                FillRect(hdc, &rc, bg);
                let _ = windows::Win32::Graphics::Gdi::FrameRect(hdc, &rc, border);
                let _ = DeleteObject(HGDIOBJ(bg.0));
                let _ = DeleteObject(HGDIOBJ(border.0));

                if !ptr.is_null() {
                    let st = &*ptr;
                    let font = CreateFontW(
                        -16,
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
                        PCWSTR(wide_z("Microsoft YaHei UI").as_ptr()),
                    );
                    let old_font = SelectObject(hdc, HGDIOBJ(font.0));
                    SetBkMode(hdc, TRANSPARENT);
                    SetTextColor(hdc, COLORREF(0x00FF_FFFF));
                    let mut text_w = wide_z(&st.text);
                    let text_len = text_w.len() - 1;
                    DrawTextW(
                        hdc,
                        &mut text_w[..text_len],
                        &mut rc,
                        DT_CENTER | DT_VCENTER | DT_SINGLELINE,
                    );
                    let _ = SelectObject(hdc, old_font);
                    let _ = DeleteObject(HGDIOBJ(font.0));
                }
                let _ = EndPaint(hwnd, &ps);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    impl HudWindow {
        fn create(
            x: i32,
            y: i32,
            w: i32,
            h: i32,
            text: String,
            stop_flag: Arc<AtomicBool>,
            clickable: bool,
        ) -> Option<Self> {
            unsafe {
                let hinst = GetModuleHandleW(None).ok()?;
                let cls_name = wide_z("WinKitCaptureHudClass");
                let wc = WNDCLASSEXW {
                    cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                    style: CS_HREDRAW | CS_VREDRAW,
                    lpfnWndProc: Some(hud_wnd_proc),
                    hInstance: hinst.into(),
                    hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
                    lpszClassName: PCWSTR(cls_name.as_ptr()),
                    ..std::mem::zeroed()
                };
                let _ = RegisterClassExW(&wc);

                let hwnd = CreateWindowExW(
                    WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                    PCWSTR(cls_name.as_ptr()),
                    PCWSTR(wide_z("WinKit HUD").as_ptr()),
                    WS_POPUP,
                    x,
                    y,
                    w,
                    h,
                    None,
                    None,
                    Some(hinst.into()),
                    None,
                )
                .ok()?;

                // Guarantee HUD is invisible to Windows capture APIs
                let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);

                let mut state = Box::new(HudState {
                    text,
                    stop_clicked: stop_flag,
                    clickable,
                });
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, &mut *state as *mut HudState as isize);
                let _ = ShowWindow(hwnd, SW_SHOWNA);
                let _ = UpdateWindow(hwnd);
                Some(Self { hwnd, state })
            }
        }

        fn set_text(&mut self, text: String) {
            self.state.text = text;
            unsafe {
                let _ = InvalidateRect(Some(self.hwnd), None, false);
                self.pump();
            }
        }

        fn pump(&self) {
            unsafe {
                let mut msg: MSG = std::mem::zeroed();
                while PeekMessageW(&mut msg, Some(self.hwnd), 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        }
    }

    impl Drop for HudWindow {
        fn drop(&mut self) {
            unsafe {
                SetWindowLongPtrW(self.hwnd, GWLP_USERDATA, 0);
                let _ = DestroyWindow(self.hwnd);
            }
        }
    }

    pub fn run_countdown(
        seconds: u32,
        cancel_flag: &AtomicBool,
        mut on_tick: impl FnMut(u32),
    ) -> Result<(), AppError> {
        if seconds == 0 {
            return Ok(());
        }
        let stop_flag = Arc::new(AtomicBool::new(false));
        let mon = list_monitors()
            .into_iter()
            .next()
            .unwrap_or(CaptureMonitorInfo {
                id: "m1".into(),
                device_name: "".into(),
                is_primary: true,
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
                scale_percent: 100,
            });
        let hud_w = 320;
        let hud_h = 46;
        let hud_x = mon.x + (mon.width as i32 - hud_w) / 2;
        let hud_y = mon.y + 28;
        let mut hud = HudWindow::create(
            hud_x,
            hud_y,
            hud_w,
            hud_h,
            format!("WinKit · {seconds} 秒后截图（Esc 取消）"),
            Arc::clone(&stop_flag),
            false,
        );

        for rem in (1..=seconds).rev() {
            on_tick(rem);
            if let Some(ref mut h) = hud {
                h.set_text(format!("WinKit · {rem} 秒后截图（Esc 取消）"));
            }
            let end = Instant::now() + Duration::from_secs(1);
            while Instant::now() < end {
                if let Some(ref h) = hud {
                    h.pump();
                }
                if cancel_flag.load(Ordering::Relaxed)
                    || stop_flag.load(Ordering::Relaxed)
                    || is_escape_pressed()
                {
                    drop(hud);
                    return Err(AppError::cancelled());
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        }
        drop(hud);
        std::thread::sleep(Duration::from_millis(80));
        Ok(())
    }

    // --- Native Full-Virtual-Screen Interactive Region Selector Overlay ---

    struct SelectorState {
        virt_x: i32,
        virt_y: i32,
        width: i32,
        height: i32,
        bright_bmp: HBITMAP,
        dim_bmp: HBITMAP,
        dragging: bool,
        start_pt: POINT,
        curr_pt: POINT,
        result: Option<CaptureRect>,
        cancelled: bool,
        prompt_text: String,
    }

    unsafe fn make_dib_from_rgba(rgba: &RgbaImage, dim_factor: f32) -> Option<HBITMAP> {
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
            let total_px = (w as usize) * (h as usize);
            let dst = std::slice::from_raw_parts_mut(ptr as *mut u8, total_px * 4);
            let src = rgba.as_raw();
            if dim_factor >= 0.999 {
                for i in 0..total_px {
                    let o = i * 4;
                    dst[o] = src[o + 2];
                    dst[o + 1] = src[o + 1];
                    dst[o + 2] = src[o];
                    dst[o + 3] = 255;
                }
            } else {
                for i in 0..total_px {
                    let o = i * 4;
                    dst[o] = (f32::from(src[o + 2]) * dim_factor) as u8;
                    dst[o + 1] = (f32::from(src[o + 1]) * dim_factor) as u8;
                    dst[o + 2] = (f32::from(src[o]) * dim_factor) as u8;
                    dst[o + 3] = 255;
                }
            }
        }
        Some(bmp)
    }

    unsafe extern "system" fn selector_wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut SelectorState;
        if ptr.is_null() {
            return DefWindowProcW(hwnd, msg, wparam, lparam);
        }
        let st = &mut *ptr;

        match msg {
            WM_ERASEBKGND => LRESULT(1),
            WM_KEYDOWN => {
                if wparam.0 == usize::from(VK_ESCAPE.0) {
                    st.cancelled = true;
                    let _ = DestroyWindow(hwnd);
                }
                LRESULT(0)
            }
            WM_RBUTTONDOWN => {
                st.cancelled = true;
                let _ = DestroyWindow(hwnd);
                LRESULT(0)
            }
            WM_LBUTTONDOWN => {
                let x = (lparam.0 & 0xFFFF) as i16 as i32;
                let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;
                st.dragging = true;
                st.start_pt = POINT { x, y };
                st.curr_pt = POINT { x, y };
                let _ = SetCapture(hwnd);
                let _ = InvalidateRect(Some(hwnd), None, false);
                LRESULT(0)
            }
            WM_MOUSEMOVE => {
                if st.dragging {
                    let x = (lparam.0 & 0xFFFF) as i16 as i32;
                    let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;
                    st.curr_pt = POINT {
                        x: x.clamp(0, st.width),
                        y: y.clamp(0, st.height),
                    };
                    let _ = InvalidateRect(Some(hwnd), None, false);
                }
                LRESULT(0)
            }
            WM_LBUTTONUP => {
                if st.dragging {
                    st.dragging = false;
                    let _ = ReleaseCapture();
                    let x1 = st.start_pt.x.min(st.curr_pt.x).clamp(0, st.width);
                    let y1 = st.start_pt.y.min(st.curr_pt.y).clamp(0, st.height);
                    let x2 = st.start_pt.x.max(st.curr_pt.x).clamp(0, st.width);
                    let y2 = st.start_pt.y.max(st.curr_pt.y).clamp(0, st.height);
                    let rw = (x2 - x1).max(0) as u32;
                    let rh = (y2 - y1).max(0) as u32;
                    if rw >= 8 && rh >= 8 {
                        st.result = Some(CaptureRect {
                            x: st.virt_x + x1,
                            y: st.virt_y + y1,
                            width: rw,
                            height: rh,
                        });
                        let _ = DestroyWindow(hwnd);
                    } else {
                        let _ = InvalidateRect(Some(hwnd), None, false);
                    }
                }
                LRESULT(0)
            }
            WM_TIMER => {
                if is_escape_pressed() {
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

                let src_dc = CreateCompatibleDC(Some(hdc));
                // 1. Paint full dimmed desktop background
                let old_src = SelectObject(src_dc, HGDIOBJ(st.dim_bmp.0));
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

                // 2. Paint bright un-dimmed cutout inside active selection rectangle
                let font = CreateFontW(
                    -16,
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
                    PCWSTR(wide_z("Microsoft YaHei UI").as_ptr()),
                );
                let old_font = SelectObject(mem_dc, HGDIOBJ(font.0));
                SetBkMode(mem_dc, TRANSPARENT);
                SetTextColor(mem_dc, COLORREF(0x00FF_FFFF));

                if st.dragging {
                    let x1 = st.start_pt.x.min(st.curr_pt.x);
                    let y1 = st.start_pt.y.min(st.curr_pt.y);
                    let x2 = st.start_pt.x.max(st.curr_pt.x);
                    let y2 = st.start_pt.y.max(st.curr_pt.y);
                    let rw = (x2 - x1).max(0);
                    let rh = (y2 - y1).max(0);
                    if rw > 0 && rh > 0 {
                        let _ = SelectObject(src_dc, HGDIOBJ(st.bright_bmp.0));
                        let _ = BitBlt(mem_dc, x1, y1, rw, rh, Some(src_dc), x1, y1, SRCCOPY);
                        let pen = CreatePen(PS_SOLID, 2, COLORREF(0x00EB_6325));
                        let old_pen = SelectObject(mem_dc, HGDIOBJ(pen.0));
                        let _ = MoveToEx(mem_dc, x1, y1, None);
                        let _ = LineTo(mem_dc, x2, y1);
                        let _ = LineTo(mem_dc, x2, y2);
                        let _ = LineTo(mem_dc, x1, y2);
                        let _ = LineTo(mem_dc, x1, y1);
                        let _ = SelectObject(mem_dc, old_pen);
                        let _ = DeleteObject(HGDIOBJ(pen.0));

                        // Dimension readout badge above/below selection
                        let badge_w = 190;
                        let badge_h = 30;
                        let bx = x1.clamp(8, (st.width - badge_w - 8).max(8));
                        let by = if y1 >= badge_h + 10 {
                            y1 - badge_h - 8
                        } else {
                            (y2 + 8).min(st.height - badge_h - 8)
                        };
                        let mut brc = RECT {
                            left: bx,
                            top: by,
                            right: bx + badge_w,
                            bottom: by + badge_h,
                        };
                        let bg = CreateSolidBrush(COLORREF(0x0024_1E18));
                        FillRect(mem_dc, &brc, bg);
                        let _ = DeleteObject(HGDIOBJ(bg.0));
                        let mut label = wide_z(&format!("{rw} × {rh} px · Esc 取消"));
                        let label_len = label.len() - 1;
                        DrawTextW(
                            mem_dc,
                            &mut label[..label_len],
                            &mut brc,
                            DT_CENTER | DT_VCENTER | DT_SINGLELINE,
                        );
                    }
                } else {
                    // Instruction pill at top center of screen
                    let pill_w = 420;
                    let pill_h = 40;
                    let px = (st.width - pill_w) / 2;
                    let mut prc = RECT {
                        left: px,
                        top: 28,
                        right: px + pill_w,
                        bottom: 28 + pill_h,
                    };
                    let bg = CreateSolidBrush(COLORREF(0x0024_1E18));
                    FillRect(mem_dc, &prc, bg);
                    let _ = DeleteObject(HGDIOBJ(bg.0));
                    let mut tip = wide_z(&st.prompt_text);
                    let tip_len = tip.len() - 1;
                    DrawTextW(
                        mem_dc,
                        &mut tip[..tip_len],
                        &mut prc,
                        DT_CENTER | DT_VCENTER | DT_SINGLELINE,
                    );
                }

                let _ = SelectObject(mem_dc, old_font);
                let _ = DeleteObject(HGDIOBJ(font.0));
                let _ = SelectObject(src_dc, old_src);
                let _ = DeleteDC(src_dc);

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

    /// Shows the native Win32 interactive full-screen region selector over a pre-captured
    /// frozen desktop frame. Returns `Ok(Some(rect))` in exact physical screen coordinates,
    /// or `Err(TASK_CANCELLED)` if the user pressed Esc / right-clicked.
    pub fn select_region_over_frozen(
        frozen: &RgbaImage,
        virt: CaptureRect,
        prompt_text: &str,
        cancel_flag: &AtomicBool,
    ) -> Result<CaptureRect, AppError> {
        unsafe {
            let hinst = GetModuleHandleW(None).map_err(|_| {
                AppError::new("CAPTURE_UNAVAILABLE", "Unable to query module handle.")
            })?;
            let cls_name = wide_z("WinKitRegionSelectorClass");
            let wc = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(selector_wnd_proc),
                hInstance: hinst.into(),
                hCursor: LoadCursorW(None, IDC_CROSS).unwrap_or_default(),
                lpszClassName: PCWSTR(cls_name.as_ptr()),
                ..std::mem::zeroed()
            };
            let _ = RegisterClassExW(&wc);

            let bright_bmp = make_dib_from_rgba(frozen, 1.0).ok_or_else(|| {
                AppError::new("CAPTURE_UNAVAILABLE", "Unable to prepare selector frame.")
            })?;
            let dim_bmp = make_dib_from_rgba(frozen, 0.52).ok_or_else(|| {
                let _ = DeleteObject(HGDIOBJ(bright_bmp.0));
                AppError::new(
                    "CAPTURE_UNAVAILABLE",
                    "Unable to prepare dimmed selector frame.",
                )
            })?;

            let mut state = Box::new(SelectorState {
                virt_x: virt.x,
                virt_y: virt.y,
                width: virt.width as i32,
                height: virt.height as i32,
                bright_bmp,
                dim_bmp,
                dragging: false,
                start_pt: POINT { x: 0, y: 0 },
                curr_pt: POINT { x: 0, y: 0 },
                result: None,
                cancelled: false,
                prompt_text: prompt_text.to_string(),
            });

            let hwnd = CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
                PCWSTR(cls_name.as_ptr()),
                PCWSTR(wide_z("WinKit Region Selector").as_ptr()),
                WS_POPUP,
                virt.x,
                virt.y,
                virt.width as i32,
                virt.height as i32,
                None,
                None,
                Some(hinst.into()),
                None,
            );

            let Ok(hwnd) = hwnd else {
                let _ = DeleteObject(HGDIOBJ(bright_bmp.0));
                let _ = DeleteObject(HGDIOBJ(dim_bmp.0));
                return Err(AppError::new(
                    "CAPTURE_UNAVAILABLE",
                    "Unable to create region selector window.",
                ));
            };

            let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
            SetWindowLongPtrW(
                hwnd,
                GWLP_USERDATA,
                &mut *state as *mut SelectorState as isize,
            );
            let _ = SetTimer(Some(hwnd), 1, 40, None);
            let _ = ShowWindow(hwnd, SW_SHOW);
            let _ = UpdateWindow(hwnd);
            let _ = windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow(hwnd);

            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                if cancel_flag.load(Ordering::Relaxed) {
                    state.cancelled = true;
                    let _ = DestroyWindow(hwnd);
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            let _ = DeleteObject(HGDIOBJ(bright_bmp.0));
            let _ = DeleteObject(HGDIOBJ(dim_bmp.0));

            if state.cancelled {
                return Err(AppError::cancelled());
            }
            state.result.ok_or_else(AppError::cancelled)
        }
    }

    fn send_wheel_down_at(cx: i32, cy: i32, notches: u32) {
        let delta = -((notches.clamp(1, 6) as i32) * 120);
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: delta as u32,
                    dwFlags: MOUSEEVENTF_WHEEL,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        unsafe {
            let sent = SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
            if sent == 0 {
                let target = WindowFromPoint(POINT { x: cx, y: cy });
                if !target.0.is_null() {
                    let mut pid = 0u32;
                    GetWindowThreadProcessId(target, Some(&mut pid));
                    if pid != 0 && pid != GetCurrentProcessId() {
                        let wparam = WPARAM(((delta as i16 as u16) as usize) << 16);
                        let lparam = LPARAM(
                            (((cy as i16 as u16) as isize) << 16) | ((cx as i16 as u16) as isize),
                        );
                        let _ = PostMessageW(Some(target), WM_MOUSEWHEEL, wparam, lparam);
                    }
                }
            }
        }
    }

    /// Runs live scrolling capture inside physical screen rectangle `rect`.
    /// Immediately halts wheel scrolling upon `cancel_flag`, Stop HUD click, or `Esc`.
    pub fn run_scrolling_capture(
        rect: CaptureRect,
        max_frames: u32,
        max_height: u32,
        wheel_notches: u32,
        step_delay_ms: u32,
        cancel_flag: &AtomicBool,
        mut on_progress: impl FnMut(u32, u32),
    ) -> Result<(RgbaImage, u32, ScrollStopReason, bool), AppError> {
        let stop_flag = Arc::new(AtomicBool::new(false));
        let virt = virtual_screen_rect();

        // Position floating Stop HUD strictly OUTSIDE `rect` (and excluded via WDA_EXCLUDEFROMCAPTURE)
        let hud_w = 340;
        let hud_h = 44;
        let hud_x = (rect.x + (rect.width as i32 - hud_w) / 2)
            .clamp(virt.x + 8, virt.x + virt.width as i32 - hud_w - 8);
        let hud_y = if rect.y - virt.y >= hud_h + 14 {
            rect.y - hud_h - 10
        } else if (rect.y + rect.height as i32) + hud_h + 14 <= virt.y + virt.height as i32 {
            rect.y + rect.height as i32 + 10
        } else {
            virt.y + 12
        };

        let mut hud = HudWindow::create(
            hud_x,
            hud_y,
            hud_w,
            hud_h,
            "正在滚动长截图 · 第 1 帧 · 点击或按 Esc 停止".into(),
            Arc::clone(&stop_flag),
            true,
        );

        let should_stop = |hud_ref: &Option<HudWindow>| -> bool {
            if let Some(h) = hud_ref {
                h.pump();
            }
            cancel_flag.load(Ordering::Relaxed)
                || stop_flag.load(Ordering::Relaxed)
                || is_escape_pressed()
        };

        // Move cursor into scrollable region center (without clicking, so we don't trigger links)
        let cx = rect.x + (rect.width as i32) / 2;
        let cy = rect.y + (rect.height as i32) / 2;
        unsafe {
            let _ = SetCursorPos(cx, cy);
        }
        std::thread::sleep(Duration::from_millis(60));

        if should_stop(&hud) {
            drop(hud);
            return Err(AppError::cancelled());
        }

        let first = capture_screen_rect(rect, false)?;
        let mut stitcher = VerticalStitcher::new(first, max_height);
        on_progress(1, stitcher.total_height());

        let mut unchanged_streak = 0u32;
        let capped_frames = max_frames.clamp(2, 120);
        let delay_ms = u64::from(step_delay_ms.clamp(120, 1200));

        for _step in 1..capped_frames {
            if should_stop(&hud) {
                drop(hud);
                let fc = stitcher.frame_count();
                return Ok((
                    stitcher.into_image(),
                    fc,
                    ScrollStopReason::UserStopped,
                    true,
                ));
            }

            // Re-ensure cursor stays over target scroll viewport before wheel event
            unsafe {
                let _ = SetCursorPos(cx, cy);
            }
            send_wheel_down_at(cx, cy, wheel_notches);

            // Wait in 20ms responsive slices so stop/Esc halts immediately with zero extra scrolls
            let deadline = Instant::now() + Duration::from_millis(delay_ms);
            while Instant::now() < deadline {
                if should_stop(&hud) {
                    drop(hud);
                    let fc = stitcher.frame_count();
                    return Ok((
                        stitcher.into_image(),
                        fc,
                        ScrollStopReason::UserStopped,
                        true,
                    ));
                }
                std::thread::sleep(Duration::from_millis(20));
            }

            let next_frame = capture_screen_rect(rect, false)?;
            match stitcher.push_frame(next_frame) {
                StitchPushOutcome::Appended {
                    new_total_height, ..
                } => {
                    unchanged_streak = 0;
                    let fc = stitcher.frame_count();
                    on_progress(fc, new_total_height);
                    if let Some(ref mut h) = hud {
                        h.set_text(format!(
                            "正在滚动长截图 · 第 {fc} 帧 ({new_total_height}px) · 点击/Esc 停止"
                        ));
                    }
                }
                StitchPushOutcome::Unchanged => {
                    unchanged_streak += 1;
                    if unchanged_streak >= 2 {
                        drop(hud);
                        let fc = stitcher.frame_count();
                        return Ok((
                            stitcher.into_image(),
                            fc,
                            ScrollStopReason::ReachedBottom,
                            false,
                        ));
                    }
                }
                StitchPushOutcome::AlignmentFailed => {
                    drop(hud);
                    let fc = stitcher.frame_count();
                    return Ok((
                        stitcher.into_image(),
                        fc,
                        ScrollStopReason::AlignmentFailed,
                        true,
                    ));
                }
                StitchPushOutcome::SizeLimitReached => {
                    drop(hud);
                    let fc = stitcher.frame_count();
                    return Ok((
                        stitcher.into_image(),
                        fc,
                        ScrollStopReason::SizeLimitReached,
                        true,
                    ));
                }
            }
        }

        drop(hud);
        let fc = stitcher.frame_count();
        Ok((
            stitcher.into_image(),
            fc,
            ScrollStopReason::MaxFramesReached,
            true,
        ))
    }
}

// ---------------------------------------------------------------------------
// Public Cross-Platform Entrypoints
// ---------------------------------------------------------------------------

pub fn list_capture_monitors_impl() -> Vec<CaptureMonitorInfo> {
    #[cfg(windows)]
    {
        win_impl::list_monitors()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[cfg(windows)]
pub(crate) fn virtual_screen_rect_shared() -> CaptureRect {
    win_impl::virtual_screen_rect()
}

#[cfg(windows)]
pub(crate) fn capture_screen_rect_shared(
    rect: CaptureRect,
    include_cursor: bool,
) -> Result<RgbaImage, AppError> {
    win_impl::capture_screen_rect(rect, include_cursor)
}

#[cfg(windows)]
pub(crate) fn is_escape_pressed_shared() -> bool {
    win_impl::is_escape_pressed()
}

pub fn list_capture_windows_impl() -> Vec<CaptureWindowInfo> {
    #[cfg(windows)]
    {
        win_impl::list_windows()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

pub fn capture_region_impl<F>(
    task_id: &str,
    req: &CaptureRegionRequest,
    store: &ImageAssetStore,
    cancel_flag: &AtomicBool,
    mut on_progress: F,
) -> Result<CaptureResultPayload, AppError>
where
    F: FnMut(&CaptureProgressPayload),
{
    #[cfg(windows)]
    {
        win_impl::run_countdown(req.countdown_seconds.min(15), cancel_flag, |rem| {
            on_progress(&CaptureProgressPayload {
                task_id: task_id.to_string(),
                phase: "countdown".into(),
                countdown_remaining: Some(rem),
                frame_count: 0,
                stitched_height: 0,
            });
        })?;

        if let Some(explicit) = req.explicit_rect {
            let rgba = win_impl::capture_screen_rect(explicit, req.include_cursor)?;
            let asset = store.insert_rgba(&rgba, "screenshot_region.png".into())?;
            return Ok(CaptureResultPayload {
                asset,
                mode: "region".into(),
                rect: explicit,
                frame_count: 1,
                stop_reason: None,
                is_partial: false,
                note: None,
            });
        }

        // Capture a pristine virtual desktop snapshot BEFORE opening the selection overlay
        // so the overlay, border, and dim layer can NEVER appear in the output pixels.
        let virt = win_impl::virtual_screen_rect();
        let frozen = win_impl::capture_screen_rect(virt, req.include_cursor)?;
        on_progress(&CaptureProgressPayload {
            task_id: task_id.to_string(),
            phase: "selecting".into(),
            countdown_remaining: None,
            frame_count: 0,
            stitched_height: 0,
        });
        let selected = win_impl::select_region_over_frozen(
            &frozen,
            virt,
            "拖动框选截图区域 · 按 Esc 或右键取消",
            cancel_flag,
        )?;
        let rel_x = (selected.x - virt.x).max(0) as u32;
        let rel_y = (selected.y - virt.y).max(0) as u32;
        let cw = selected.width.min(frozen.width().saturating_sub(rel_x));
        let ch = selected.height.min(frozen.height().saturating_sub(rel_y));
        if cw == 0 || ch == 0 {
            return Err(AppError::invalid_param("Selected capture region is empty."));
        }
        let cropped = image::imageops::crop_imm(&frozen, rel_x, rel_y, cw, ch).to_image();
        let asset = store.insert_rgba(&cropped, "screenshot_region.png".into())?;
        Ok(CaptureResultPayload {
            asset,
            mode: "region".into(),
            rect: CaptureRect {
                x: selected.x,
                y: selected.y,
                width: cw,
                height: ch,
            },
            frame_count: 1,
            stop_reason: None,
            is_partial: false,
            note: None,
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (task_id, req, store, cancel_flag, &mut on_progress);
        Err(AppError::new(
            "CAPTURE_UNAVAILABLE",
            "Native screen capture is supported on Windows 11.",
        ))
    }
}

pub fn capture_monitor_impl<F>(
    task_id: &str,
    req: &CaptureMonitorRequest,
    store: &ImageAssetStore,
    cancel_flag: &AtomicBool,
    mut on_progress: F,
) -> Result<CaptureResultPayload, AppError>
where
    F: FnMut(&CaptureProgressPayload),
{
    #[cfg(windows)]
    {
        let monitors = win_impl::list_monitors();
        let target = monitors
            .iter()
            .find(|m| m.id == req.monitor_id || m.device_name == req.monitor_id)
            .or_else(|| monitors.first())
            .ok_or_else(|| AppError::new("CAPTURE_UNAVAILABLE", "No display monitors detected."))?
            .clone();

        win_impl::run_countdown(req.countdown_seconds.min(15), cancel_flag, |rem| {
            on_progress(&CaptureProgressPayload {
                task_id: task_id.to_string(),
                phase: "countdown".into(),
                countdown_remaining: Some(rem),
                frame_count: 0,
                stitched_height: 0,
            });
        })?;

        let rect = CaptureRect {
            x: target.x,
            y: target.y,
            width: target.width,
            height: target.height,
        };
        let rgba = win_impl::capture_screen_rect(rect, req.include_cursor)?;
        let asset = store.insert_rgba(&rgba, format!("screenshot_{}.png", target.id))?;
        Ok(CaptureResultPayload {
            asset,
            mode: "monitor".into(),
            rect,
            frame_count: 1,
            stop_reason: None,
            is_partial: false,
            note: Some(format!(
                "{} ({}×{} @ {}%)",
                target.device_name, target.width, target.height, target.scale_percent
            )),
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (task_id, req, store, cancel_flag, &mut on_progress);
        Err(AppError::new(
            "CAPTURE_UNAVAILABLE",
            "Native monitor capture is supported on Windows 11.",
        ))
    }
}

pub fn capture_window_impl<F>(
    task_id: &str,
    req: &CaptureWindowRequest,
    store: &ImageAssetStore,
    cancel_flag: &AtomicBool,
    mut on_progress: F,
) -> Result<CaptureResultPayload, AppError>
where
    F: FnMut(&CaptureProgressPayload),
{
    #[cfg(windows)]
    {
        win_impl::run_countdown(req.countdown_seconds.min(15), cancel_flag, |rem| {
            on_progress(&CaptureProgressPayload {
                task_id: task_id.to_string(),
                phase: "countdown".into(),
                countdown_remaining: Some(rem),
                frame_count: 0,
                stitched_height: 0,
            });
        })?;

        let (rgba, rect, title) = win_impl::capture_window(req.hwnd, req.include_cursor)?;
        let asset = store.insert_rgba(&rgba, "screenshot_window.png".into())?;
        Ok(CaptureResultPayload {
            asset,
            mode: "window".into(),
            rect,
            frame_count: 1,
            stop_reason: None,
            is_partial: false,
            note: Some(title),
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (task_id, req, store, cancel_flag, &mut on_progress);
        Err(AppError::new(
            "CAPTURE_UNAVAILABLE",
            "Native window capture is supported on Windows 11.",
        ))
    }
}

pub fn capture_scroll_impl<F>(
    task_id: &str,
    req: &CaptureScrollRequest,
    store: &ImageAssetStore,
    cancel_flag: &AtomicBool,
    mut on_progress: F,
) -> Result<CaptureResultPayload, AppError>
where
    F: FnMut(&CaptureProgressPayload),
{
    #[cfg(windows)]
    {
        let rect = if let Some(explicit) = req.explicit_rect {
            explicit
        } else {
            let virt = win_impl::virtual_screen_rect();
            let frozen = win_impl::capture_screen_rect(virt, false)?;
            on_progress(&CaptureProgressPayload {
                task_id: task_id.to_string(),
                phase: "selecting".into(),
                countdown_remaining: None,
                frame_count: 0,
                stitched_height: 0,
            });
            let sel = win_impl::select_region_over_frozen(
                &frozen,
                virt,
                "框选可滚动内容区域（框选后自动向下滚动拼接 · Esc 取消）",
                cancel_flag,
            )?;
            // Wait for selector overlay teardown & desktop repaint before live scrolling starts
            std::thread::sleep(Duration::from_millis(100));
            sel
        };

        win_impl::run_countdown(req.countdown_seconds.min(15), cancel_flag, |rem| {
            on_progress(&CaptureProgressPayload {
                task_id: task_id.to_string(),
                phase: "countdown".into(),
                countdown_remaining: Some(rem),
                frame_count: 0,
                stitched_height: 0,
            });
        })?;

        let max_frames = req.max_frames.unwrap_or(DEFAULT_MAX_SCROLL_FRAMES);
        let max_height = req.max_height.unwrap_or(DEFAULT_MAX_STITCH_HEIGHT);
        let wheel_notches = req.wheel_notches.unwrap_or(2);
        let step_delay_ms = req.step_delay_ms.unwrap_or(300);

        let (stitched, frame_count, stop_reason, is_partial) = win_impl::run_scrolling_capture(
            rect,
            max_frames,
            max_height,
            wheel_notches,
            step_delay_ms,
            cancel_flag,
            |fc, sh| {
                on_progress(&CaptureProgressPayload {
                    task_id: task_id.to_string(),
                    phase: "scrolling".into(),
                    countdown_remaining: None,
                    frame_count: fc,
                    stitched_height: sh,
                });
            },
        )?;

        let asset = store.insert_rgba(&stitched, "screenshot_scroll.png".into())?;
        Ok(CaptureResultPayload {
            asset,
            mode: "scroll".into(),
            rect,
            frame_count,
            stop_reason: Some(stop_reason),
            is_partial,
            note: None,
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (task_id, req, store, cancel_flag, &mut on_progress);
        Err(AppError::new(
            "CAPTURE_UNAVAILABLE",
            "Native scrolling capture is supported on Windows 11.",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Synthesizes a tall scrollable document with distinct colored horizontal bands &
    /// unique horizontal bar patterns per row (simulating numbered rows on a web page).
    fn make_synthetic_long_page(w: u32, h: u32) -> RgbaImage {
        let mut img = RgbaImage::new(w, h);
        for y in 0..h {
            let band = y / 40;
            let in_band = y % 40;
            let r = ((band * 53 + 40) % 215 + 30) as u8;
            let g = ((band * 97 + 70) % 215 + 30) as u8;
            let b = ((band * 131 + 110) % 215 + 30) as u8;
            for x in 0..w {
                let mut px = [r, g, b, 255];
                // Add crisp row-unique marker blocks inside each 40px band
                if (10..=28).contains(&in_band)
                    && x >= 20
                    && x < 20 + ((band % 11) + 2) * 22
                    && ((x + y * 3 + band * 7) % 19) < 9
                {
                    px = [24, 30, 42, 255];
                }
                if in_band == 0 {
                    px = [255, 255, 255, 255];
                }
                img.put_pixel(x, y, Rgba(px));
            }
        }
        img
    }

    #[test]
    fn stitches_overlapping_scroll_frames_with_sticky_header_and_scrollbar_accurately() {
        let w = 360u32;
        let view_h = 300u32;
        let header_h = 36u32;
        let body_view_h = view_h - header_h; // 264
        let full_body = make_synthetic_long_page(w, 720);

        // Simulate 5 frames scrolling down by 140px each, stopping at bottom (max offset 720-264=456),
        // WITH a fixed dark header AND a moving scrollbar thumb on the rightmost 16px!
        let offsets = [0u32, 140, 280, 420, 456, 456];
        let mut frames = Vec::new();
        for (idx, &off) in offsets.iter().enumerate() {
            let mut f = RgbaImage::new(w, view_h);
            // Sticky top header
            for y in 0..header_h {
                for x in 0..w {
                    f.put_pixel(x, y, Rgba([18, 24, 38, 255]));
                }
            }
            // Scrollable body
            for y in 0..body_view_h {
                for x in 0..w {
                    f.put_pixel(x, header_h + y, *full_body.get_pixel(x, off + y));
                }
            }
            // Moving right-edge scrollbar thumb (must NOT break alignment!)
            let thumb_y = header_h + ((idx as u32) * 35).min(body_view_h - 40);
            for y in header_h..view_h {
                for x in (w - 14)..w {
                    let c = if y >= thumb_y && y < thumb_y + 36 {
                        [120, 130, 145, 255]
                    } else {
                        [235, 238, 242, 255]
                    };
                    f.put_pixel(x, y, Rgba(c));
                }
            }
            frames.push(f);
        }

        let (stitched, count, reason, is_partial) =
            stitch_frame_sequence(frames, 4000).expect("stitch");
        assert_eq!(reason, ScrollStopReason::ReachedBottom);
        assert!(!is_partial);
        assert_eq!(count, 5);
        // Exact expected height: 36px sticky header + 720px scrollable body = 756px!
        assert_eq!(stitched.width(), w);
        assert_eq!(stitched.height(), header_h + 720);

        // Verify top header appears cleanly at y=10 and full body matches pixel-for-pixel at y=header+0, mid, and bottom!
        assert_eq!(stitched.get_pixel(50, 10).0, [18, 24, 38, 255]);
        for sample_y in [5u32, 200, 450, 710] {
            assert_eq!(
                stitched.get_pixel(100, header_h + sample_y).0,
                full_body.get_pixel(100, sample_y).0,
                "Pixel mismatch at stitched body y={sample_y}"
            );
        }
    }

    #[test]
    fn reports_alignment_failure_and_size_limit_with_partial_result() {
        let f1 = make_synthetic_long_page(240, 200);
        // Completely unrelated shifted/inverted frame -> alignment MUST fail honestly
        let mut f2 = RgbaImage::new(240, 200);
        for y in 0..200 {
            for x in 0..240 {
                let p = f1.get_pixel(x, 199 - y).0;
                f2.put_pixel(x, y, Rgba([255 - p[0], 255 - p[1], 255 - p[2], 255]));
            }
        }
        let (partial_img, count, reason, is_partial) =
            stitch_frame_sequence(vec![f1.clone(), f2], 2000).expect("align fail");
        assert_eq!(reason, ScrollStopReason::AlignmentFailed);
        assert!(is_partial);
        assert_eq!(count, 1);
        assert_eq!(partial_img.dimensions(), (240, 200));

        // Size limit test: cap height to 280px while pushing frames scrolling 100px each
        let tall = make_synthetic_long_page(240, 500);
        let s0 = image::imageops::crop_imm(&tall, 0, 0, 240, 200).to_image();
        let s1 = image::imageops::crop_imm(&tall, 0, 100, 240, 200).to_image();
        let (capped, _, cap_reason, cap_partial) =
            stitch_frame_sequence(vec![s0, s1], 250).expect("size cap");
        assert_eq!(cap_reason, ScrollStopReason::SizeLimitReached);
        assert!(cap_partial);
        assert!(capped.height() <= 250);
    }

    #[cfg(windows)]
    #[test]
    fn enumerates_real_windows_monitors_and_excludes_self_windows() {
        let monitors = list_capture_monitors_impl();
        assert!(
            !monitors.is_empty(),
            "Expected at least one Windows display monitor"
        );
        assert!(monitors[0].width > 0 && monitors[0].height > 0);
        assert!(monitors[0].scale_percent >= 100);
        let windows = list_capture_windows_impl();
        let self_pid = unsafe { windows::Win32::System::Threading::GetCurrentProcessId() };
        for w in windows {
            let mut pid = 0u32;
            unsafe {
                windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(
                    windows::Win32::Foundation::HWND(w.hwnd as usize as *mut _),
                    Some(&mut pid),
                );
            }
            assert_ne!(pid, self_pid, "Own process window leaked into capture list");
        }
    }
}
