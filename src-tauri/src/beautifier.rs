//! I03 Screenshot Beautifier backend (upgraded in Phase 3B Batch 1).
//!
//! Supports solid color, linear gradient, and custom cover-cropped background images,
//! padding, SDF anti-aliased rounded corners, 3-pass separable drop shadows,
//! aspect ratios (`original`, `1:1`, `16:9`, `4:5`, `9:16`), in-memory `ImageAssetStore`
//! handoff from I01/I11/I12, direct copy/handoff rendering, and batch processing.

use crate::error::AppError;
use crate::fs_guard::{validate_existing_input_file, write_output_bytes_cancellable};
use crate::image_assets::{
    encode_rgba_to_png_fast, ImageAssetPayload, ImageAssetStore, MAX_ASSET_PIXELS, MAX_ASSET_SIDE,
};
use crate::image_core::{
    decode_image_to_display, validate_output_directory, write_unique_output_file,
    BatchImageItemOutcome, BatchImageJobResponse, BatchImageOutcomeStatus,
    ImageBatchProgressPayload,
};
use base64::Engine;
use image::codecs::png::PngEncoder;
use image::imageops::FilterType;
use image::{ColorType, DynamicImage, GenericImageView, ImageEncoder, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

pub const MAX_INPUT_FILE_BYTES: u64 = 50 * 1024 * 1024; // 50 MiB
pub const MAX_SOURCE_DIMENSION: u32 = MAX_ASSET_SIDE; // 16384 px (supports long screenshots)
pub const MAX_SOURCE_PIXELS: u64 = 33_554_432; // 33.5 MP
pub const MAX_OUTPUT_DIMENSION: u32 = 16_800;
pub const MAX_OUTPUT_PIXELS: u64 = MAX_ASSET_PIXELS; // 48 MP (~192 MB RGBA ceiling)
const MAX_PREVIEW_SIDE: u32 = 1440;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AspectPreset {
    #[serde(rename = "original")]
    Original,
    #[serde(rename = "1:1")]
    Square,
    #[serde(rename = "16:9")]
    Wide16x9,
    #[serde(rename = "4:5")]
    Portrait4x5,
    #[serde(rename = "9:16")]
    Story9x16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum BackgroundKind {
    #[default]
    Solid,
    Gradient,
    Image,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceImageInspection {
    pub path: String,
    pub file_name: String,
    pub width: u32,
    pub height: u32,
    pub has_alpha: bool,
    pub preview_data_url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeautifyStyleConfig {
    #[serde(default)]
    pub background_kind: BackgroundKind,
    pub background_hex: String,
    pub gradient_start_hex: Option<String>,
    pub gradient_end_hex: Option<String>,
    pub gradient_angle_deg: Option<f32>,
    pub background_image_path: Option<String>,
    pub padding: u32,
    pub corner_radius: u32,
    pub shadow_strength: u32,
    pub aspect_ratio: AspectPreset,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeautifyExportParams {
    pub input_path: Option<String>,
    pub asset_id: Option<String>,
    pub output_path: String,
    #[serde(default)]
    pub background_kind: BackgroundKind,
    pub background_hex: String,
    pub gradient_start_hex: Option<String>,
    pub gradient_end_hex: Option<String>,
    pub gradient_angle_deg: Option<f32>,
    pub background_image_path: Option<String>,
    pub padding: u32,
    pub corner_radius: u32,
    pub shadow_strength: u32,
    pub aspect_ratio: AspectPreset,
    pub overwrite: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeautifyRenderAssetRequest {
    pub input_path: Option<String>,
    pub asset_id: Option<String>,
    pub label: Option<String>,
    pub style: BeautifyStyleConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeautifyBatchRequest {
    pub source_paths: Vec<String>,
    pub output_dir: String,
    pub style: BeautifyStyleConfig,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeautifyExportResult {
    pub output_path: String,
    pub output_width: u32,
    pub output_height: u32,
    pub byte_length: u64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FrameLayout {
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub image_x: u32,
    pub image_y: u32,
    pub image_width: u32,
    pub image_height: u32,
    pub effective_radius: u32,
    pub shadow_blur: u32,
    pub shadow_offset_y: u32,
    pub shadow_opacity: f32,
}

pub enum ResolvedBackground {
    Solid([u8; 3]),
    Gradient {
        start: [u8; 3],
        end: [u8; 3],
        angle_deg: f32,
    },
    Image(RgbaImage),
}

pub fn parse_hex_rgb(hex: &str) -> Result<[u8; 3], AppError> {
    let trimmed = hex.trim();
    let digits = trimmed.strip_prefix('#').unwrap_or(trimmed);
    if digits.len() != 6 || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppError::invalid_param(
            "Background color must be a 6-digit hexadecimal #RRGGBB color.",
        ));
    }
    let r = u8::from_str_radix(&digits[0..2], 16).unwrap_or(255);
    let g = u8::from_str_radix(&digits[2..4], 16).unwrap_or(255);
    let b = u8::from_str_radix(&digits[4..6], 16).unwrap_or(255);
    Ok([r, g, b])
}

pub fn resolve_background(style: &BeautifyStyleConfig) -> Result<ResolvedBackground, AppError> {
    match style.background_kind {
        BackgroundKind::Solid => Ok(ResolvedBackground::Solid(parse_hex_rgb(
            &style.background_hex,
        )?)),
        BackgroundKind::Gradient => {
            let start = parse_hex_rgb(
                style
                    .gradient_start_hex
                    .as_deref()
                    .unwrap_or(&style.background_hex),
            )?;
            let end = parse_hex_rgb(style.gradient_end_hex.as_deref().unwrap_or("#CBD5E1"))?;
            let angle = style.gradient_angle_deg.unwrap_or(135.0).rem_euclid(360.0);
            Ok(ResolvedBackground::Gradient {
                start,
                end,
                angle_deg: angle,
            })
        }
        BackgroundKind::Image => {
            let raw = style
                .background_image_path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    AppError::invalid_param("Please choose a local background image file.")
                })?;
            let (bg_path, _) = validate_existing_input_file(raw)?;
            let decoded = decode_image_to_display(&bg_path)?;
            Ok(ResolvedBackground::Image(decoded.image.to_rgba8()))
        }
    }
}

fn fit_aspect_ratio(base_w: u32, base_h: u32, num_w: u64, num_h: u64) -> (u32, u32) {
    if u64::from(base_w) * num_h >= u64::from(base_h) * num_w {
        let target_h = ((f64::from(base_w) * (num_h as f64)) / (num_w as f64)).round() as u32;
        (base_w, base_h.max(target_h))
    } else {
        let target_w = ((f64::from(base_h) * (num_w as f64)) / (num_h as f64)).round() as u32;
        (base_w.max(target_w), base_h)
    }
}

pub fn compute_frame_layout(
    src_w: u32,
    src_h: u32,
    padding: u32,
    corner_radius: u32,
    shadow_strength: u32,
    aspect: AspectPreset,
) -> Result<FrameLayout, AppError> {
    if src_w == 0 || src_h == 0 {
        return Err(AppError::invalid_param(
            "Source image dimensions must be positive.",
        ));
    }
    if src_w > MAX_SOURCE_DIMENSION
        || src_h > MAX_SOURCE_DIMENSION
        || u64::from(src_w) * u64::from(src_h) > MAX_SOURCE_PIXELS
    {
        return Err(AppError::size_limit(format!(
            "Source image ({src_w}x{src_h}) exceeds maximum supported dimensions ({MAX_SOURCE_DIMENSION}px / 33.5 MP)."
        )));
    }

    let pad = padding.min(240);
    let raw_radius = corner_radius.min(160);
    let strength = shadow_strength.min(100);

    let base_w = src_w.saturating_add(pad.saturating_mul(2));
    let base_h = src_h.saturating_add(pad.saturating_mul(2));

    let (canvas_width, canvas_height) = match aspect {
        AspectPreset::Original => (base_w, base_h),
        AspectPreset::Square => {
            let side = base_w.max(base_h);
            (side, side)
        }
        AspectPreset::Wide16x9 => fit_aspect_ratio(base_w, base_h, 16, 9),
        AspectPreset::Portrait4x5 => fit_aspect_ratio(base_w, base_h, 4, 5),
        AspectPreset::Story9x16 => fit_aspect_ratio(base_w, base_h, 9, 16),
    };

    if canvas_width > MAX_OUTPUT_DIMENSION
        || canvas_height > MAX_OUTPUT_DIMENSION
        || u64::from(canvas_width) * u64::from(canvas_height) > MAX_OUTPUT_PIXELS
    {
        return Err(AppError::size_limit(format!(
            "Output canvas ({canvas_width}x{canvas_height}) exceeds safety limit ({MAX_OUTPUT_DIMENSION}px / 48 MP)."
        )));
    }

    let image_x = (canvas_width - src_w) / 2;
    let image_y = (canvas_height - src_h) / 2;
    let effective_radius = raw_radius.min(src_w.min(src_h) / 2);

    let shadow_blur = if strength > 0 {
        ((strength as f32) * 0.45).round() as u32
    } else {
        0
    };
    let shadow_offset_y = if strength > 0 {
        ((strength as f32) * 0.18).round() as u32
    } else {
        0
    };
    let shadow_opacity = if strength > 0 {
        ((strength as f32 / 100.0) * 0.48).min(0.55)
    } else {
        0.0
    };

    Ok(FrameLayout {
        canvas_width,
        canvas_height,
        image_x,
        image_y,
        image_width: src_w,
        image_height: src_h,
        effective_radius,
        shadow_blur,
        shadow_offset_y,
        shadow_opacity,
    })
}

fn open_validated_source_image(path: &Path, byte_len: u64) -> Result<DynamicImage, AppError> {
    if byte_len > MAX_INPUT_FILE_BYTES {
        return Err(AppError::size_limit(format!(
            "Input image exceeds 50 MB safety limit ({:.2} MB).",
            byte_len as f64 / (1024.0 * 1024.0)
        )));
    }
    let decoded = decode_image_to_display(path)?;
    let (w, h) = decoded.image.dimensions();
    if w == 0
        || h == 0
        || w > MAX_SOURCE_DIMENSION
        || h > MAX_SOURCE_DIMENSION
        || u64::from(w) * u64::from(h) > MAX_SOURCE_PIXELS
    {
        return Err(AppError::size_limit(format!(
            "Image dimensions ({w}x{h}) exceed safety bounds ({MAX_SOURCE_DIMENSION}px / 33.5 MP)."
        )));
    }
    Ok(decoded.image)
}

pub fn inspect_source_image(raw_path: &str) -> Result<SourceImageInspection, AppError> {
    let (path, byte_len) = validate_existing_input_file(raw_path)?;
    let decoded = open_validated_source_image(&path, byte_len)?;
    let (width, height) = decoded.dimensions();

    let rgba = decoded.to_rgba8();
    let has_alpha = rgba.pixels().any(|p| p.0[3] < 255);

    let preview_img = if width > MAX_PREVIEW_SIDE || height > MAX_PREVIEW_SIDE {
        decoded.resize(MAX_PREVIEW_SIDE, MAX_PREVIEW_SIDE, FilterType::Triangle)
    } else {
        decoded
    };

    let preview_rgba = preview_img.to_rgba8();
    let (pw, ph) = preview_rgba.dimensions();
    let mut png_bytes = Vec::new();
    PngEncoder::new(&mut png_bytes)
        .write_image(preview_rgba.as_raw(), pw, ph, ColorType::Rgba8.into())
        .map_err(|_| AppError::decode_failed("Failed to encode preview buffer."))?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();

    Ok(SourceImageInspection {
        path: path.to_string_lossy().into_owned(),
        file_name,
        width,
        height,
        has_alpha,
        preview_data_url: format!("data:image/png;base64,{b64}"),
    })
}

/// Anti-aliased SDF coverage [0.0, 1.0] for pixel `(px, py)` inside a `w x h` rounded rectangle.
#[inline]
fn rounded_rect_coverage(px: u32, py: u32, w: u32, h: u32, radius: f32) -> f32 {
    if radius <= 0.0 {
        return 1.0;
    }
    let x = px as f32 + 0.5;
    let y = py as f32 + 0.5;
    let wf = w as f32;
    let hf = h as f32;

    let dx = if x < radius {
        radius - x
    } else if x > wf - radius {
        x - (wf - radius)
    } else {
        0.0
    };

    let dy = if y < radius {
        radius - y
    } else if y > hf - radius {
        y - (hf - radius)
    } else {
        0.0
    };

    if dx <= 0.0 && dy <= 0.0 {
        return 1.0;
    }
    let dist = (dx * dx + dy * dy).sqrt() - radius;
    (0.5 - dist).clamp(0.0, 1.0)
}

/// O(W * H) separable horizontal + vertical sliding-window box blur on a single-channel alpha field.
fn box_blur_pass(src: &[f32], dst: &mut [f32], w: usize, h: usize, radius: usize) {
    if radius == 0 || w == 0 || h == 0 {
        dst.copy_from_slice(src);
        return;
    }
    let inv = 1.0 / (2 * radius + 1) as f32;
    let mut temp = vec![0.0f32; w * h];

    for y in 0..h {
        let row = y * w;
        let mut acc = src[row] * (radius + 1) as f32;
        for x in 1..=radius {
            acc += src[row + x.min(w - 1)];
        }
        for x in 0..w {
            temp[row + x] = acc * inv;
            let remove_idx = x.saturating_sub(radius);
            let add_idx = (x + radius + 1).min(w - 1);
            acc += src[row + add_idx] - src[row + remove_idx];
        }
    }

    for x in 0..w {
        let mut acc = temp[x] * (radius + 1) as f32;
        for y in 1..=radius {
            acc += temp[y.min(h - 1) * w + x];
        }
        for y in 0..h {
            dst[y * w + x] = acc * inv;
            let remove_y = y.saturating_sub(radius);
            let add_y = (y + radius + 1).min(h - 1);
            acc += temp[add_y * w + x] - temp[remove_y * w + x];
        }
    }
}

/// Renders the opaque background canvas matching CSS solid / `linear-gradient(angle deg, ...)` /
/// `object-fit: cover; object-position: center` semantics identically.
fn build_background_canvas(cw: u32, ch: u32, bg: &ResolvedBackground) -> RgbaImage {
    match bg {
        ResolvedBackground::Solid(rgb) => {
            RgbaImage::from_pixel(cw, ch, Rgba([rgb[0], rgb[1], rgb[2], 255]))
        }
        ResolvedBackground::Gradient {
            start,
            end,
            angle_deg,
        } => {
            // CSS linear-gradient angle: 0deg = bottom-to-top, 90deg = left-to-right, 135deg = TL-to-BR
            let rad = angle_deg.to_radians();
            let dx = rad.sin();
            let dy = -rad.cos();
            let wf = cw as f32;
            let hf = ch as f32;
            let half_len = (wf * dx.abs() + hf * dy.abs()) * 0.5;
            let inv_len = if half_len > 0.001 {
                1.0 / (2.0 * half_len)
            } else {
                0.0
            };
            let cx = wf * 0.5;
            let cy = hf * 0.5;

            let sr = f32::from(start[0]);
            let sg = f32::from(start[1]);
            let sb = f32::from(start[2]);
            let dr = f32::from(end[0]) - sr;
            let dg = f32::from(end[1]) - sg;
            let db = f32::from(end[2]) - sb;

            let mut canvas = RgbaImage::new(cw, ch);
            let raw = canvas.as_mut();
            for y in 0..ch {
                let py = y as f32 + 0.5 - cy;
                let row_off = (y as usize) * (cw as usize) * 4;
                for x in 0..cw {
                    let px = x as f32 + 0.5 - cx;
                    let proj = px * dx + py * dy;
                    let t = ((proj + half_len) * inv_len).clamp(0.0, 1.0);
                    let o = row_off + (x as usize) * 4;
                    raw[o] = (sr + dr * t).round() as u8;
                    raw[o + 1] = (sg + dg * t).round() as u8;
                    raw[o + 2] = (sb + db * t).round() as u8;
                    raw[o + 3] = 255;
                }
            }
            canvas
        }
        ResolvedBackground::Image(bg_img) => {
            let (bw, bh) = bg_img.dimensions();
            if bw == 0 || bh == 0 {
                return RgbaImage::from_pixel(cw, ch, Rgba([232, 236, 242, 255]));
            }
            let scale = (f64::from(cw) / f64::from(bw)).max(f64::from(ch) / f64::from(bh));
            let scaled_w = ((f64::from(bw) * scale).round() as u32).max(cw);
            let scaled_h = ((f64::from(bh) * scale).round() as u32).max(ch);
            let resized = image::imageops::resize(bg_img, scaled_w, scaled_h, FilterType::Lanczos3);
            let crop_x = (scaled_w - cw) / 2;
            let crop_y = (scaled_h - ch) / 2;
            let mut out = image::imageops::crop_imm(&resized, crop_x, crop_y, cw, ch).to_image();
            // Flatten any transparent background image pixels cleanly onto neutral light surface
            for p in out.pixels_mut() {
                if p.0[3] < 255 {
                    let a = f32::from(p.0[3]) / 255.0;
                    let inv = 1.0 - a;
                    p.0[0] = (f32::from(p.0[0]) * a + 232.0 * inv).round() as u8;
                    p.0[1] = (f32::from(p.0[1]) * a + 236.0 * inv).round() as u8;
                    p.0[2] = (f32::from(p.0[2]) * a + 242.0 * inv).round() as u8;
                    p.0[3] = 255;
                }
            }
            out
        }
    }
}

pub fn render_beautified_rgba_with_bg(
    src_rgba: &RgbaImage,
    bg: &ResolvedBackground,
    layout: &FrameLayout,
) -> RgbaImage {
    let cw = layout.canvas_width as usize;
    let ch = layout.canvas_height as usize;
    let sw = layout.image_width;
    let sh = layout.image_height;
    let radius = layout.effective_radius as f32;

    let mut fg_cov = vec![0.0f32; (sw as usize) * (sh as usize)];
    for py in 0..sh {
        let row_off = (py as usize) * (sw as usize);
        for px in 0..sw {
            let src_a = f32::from(src_rgba.get_pixel(px, py).0[3]) / 255.0;
            if src_a > 0.0 {
                let mask = rounded_rect_coverage(px, py, sw, sh, radius);
                fg_cov[row_off + px as usize] = src_a * mask;
            }
        }
    }

    let mut canvas = build_background_canvas(layout.canvas_width, layout.canvas_height, bg);

    // Render soft Gaussian-approximated drop shadow over the actual background pixels
    if layout.shadow_opacity > 0.0 && layout.shadow_blur > 0 {
        let mut shadow_a = vec![0.0f32; cw * ch];
        let mut shadow_b = vec![0.0f32; cw * ch];

        let ox = layout.image_x as usize;
        let oy = (layout.image_y + layout.shadow_offset_y) as usize;
        for py in 0..(sh as usize) {
            let dst_y = oy + py;
            if dst_y >= ch {
                break;
            }
            let src_row = py * (sw as usize);
            let dst_row = dst_y * cw;
            for px in 0..(sw as usize) {
                let dst_x = ox + px;
                if dst_x < cw {
                    shadow_a[dst_row + dst_x] = fg_cov[src_row + px] * layout.shadow_opacity;
                }
            }
        }

        let box_r = ((layout.shadow_blur as f32 * 0.6).round() as usize).max(1);
        box_blur_pass(&shadow_a, &mut shadow_b, cw, ch, box_r);
        box_blur_pass(&shadow_b, &mut shadow_a, cw, ch, box_r);
        box_blur_pass(&shadow_a, &mut shadow_b, cw, ch, box_r);

        for y in 0..ch {
            let row = y * cw;
            for x in 0..cw {
                let sa = shadow_b[row + x].clamp(0.0, 1.0);
                if sa > 0.001 {
                    let inv = 1.0 - sa;
                    let bg_px = canvas.get_pixel(x as u32, y as u32).0;
                    canvas.put_pixel(
                        x as u32,
                        y as u32,
                        Rgba([
                            (f32::from(bg_px[0]) * inv).round() as u8,
                            (f32::from(bg_px[1]) * inv).round() as u8,
                            (f32::from(bg_px[2]) * inv).round() as u8,
                            255,
                        ]),
                    );
                }
            }
        }
    }

    // Composite 1:1 unscaled foreground pixels onto canvas
    for py in 0..sh {
        let row_off = (py as usize) * (sw as usize);
        let dst_y = layout.image_y + py;
        for px in 0..sw {
            let a = fg_cov[row_off + px as usize];
            if a <= 0.0 {
                continue;
            }
            let dst_x = layout.image_x + px;
            let src_px = src_rgba.get_pixel(px, py).0;
            if a >= 0.999 {
                canvas.put_pixel(dst_x, dst_y, Rgba([src_px[0], src_px[1], src_px[2], 255]));
            } else {
                let dst_px = canvas.get_pixel(dst_x, dst_y).0;
                let inv = 1.0 - a;
                let r = (f32::from(src_px[0]) * a + f32::from(dst_px[0]) * inv).round() as u8;
                let g = (f32::from(src_px[1]) * a + f32::from(dst_px[1]) * inv).round() as u8;
                let b = (f32::from(src_px[2]) * a + f32::from(dst_px[2]) * inv).round() as u8;
                canvas.put_pixel(dst_x, dst_y, Rgba([r, g, b, 255]));
            }
        }
    }

    canvas
}

pub fn render_beautified_rgba(
    src_rgba: &RgbaImage,
    bg_rgb: [u8; 3],
    layout: &FrameLayout,
) -> RgbaImage {
    render_beautified_rgba_with_bg(src_rgba, &ResolvedBackground::Solid(bg_rgb), layout)
}

fn load_source_rgba(
    input_path: Option<&str>,
    asset_id: Option<&str>,
    store: Option<&ImageAssetStore>,
) -> Result<(RgbaImage, Option<PathBuf>), AppError> {
    if let Some(aid) = asset_id.map(str::trim).filter(|s| !s.is_empty()) {
        let st = store.ok_or_else(|| {
            AppError::new("ASSET_NOT_FOUND", "In-memory image store unavailable.")
        })?;
        let (rgba, _) = st.get_rgba(aid)?;
        return Ok((rgba, None));
    }
    let raw = input_path
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::invalid_param("Please select an image first."))?;
    let (path, byte_len) = validate_existing_input_file(raw)?;
    let decoded = open_validated_source_image(&path, byte_len)?;
    Ok((decoded.to_rgba8(), Some(path)))
}

pub fn export_beautified_png_sync(
    params: &BeautifyExportParams,
) -> Result<BeautifyExportResult, AppError> {
    export_beautified_png_with_store(params, None, None)
}

pub fn export_beautified_png_cancellable(
    params: &BeautifyExportParams,
    cancel_flag: Option<&AtomicBool>,
) -> Result<BeautifyExportResult, AppError> {
    export_beautified_png_with_store(params, None, cancel_flag)
}

pub fn export_beautified_png_with_store(
    params: &BeautifyExportParams,
    store: Option<&ImageAssetStore>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<BeautifyExportResult, AppError> {
    let check_cancelled = || {
        if cancel_flag.is_some_and(|f| f.load(Ordering::Relaxed)) {
            Err(AppError::cancelled())
        } else {
            Ok(())
        }
    };
    check_cancelled()?;

    let style = BeautifyStyleConfig {
        background_kind: params.background_kind,
        background_hex: params.background_hex.clone(),
        gradient_start_hex: params.gradient_start_hex.clone(),
        gradient_end_hex: params.gradient_end_hex.clone(),
        gradient_angle_deg: params.gradient_angle_deg,
        background_image_path: params.background_image_path.clone(),
        padding: params.padding,
        corner_radius: params.corner_radius,
        shadow_strength: params.shadow_strength,
        aspect_ratio: params.aspect_ratio,
    };
    let resolved_bg = resolve_background(&style)?;
    let (src_rgba, src_path) = load_source_rgba(
        params.input_path.as_deref(),
        params.asset_id.as_deref(),
        store,
    )?;
    check_cancelled()?;

    let (src_w, src_h) = src_rgba.dimensions();
    let layout = compute_frame_layout(
        src_w,
        src_h,
        style.padding,
        style.corner_radius,
        style.shadow_strength,
        style.aspect_ratio,
    )?;

    let rendered = render_beautified_rgba_with_bg(&src_rgba, &resolved_bg, &layout);
    check_cancelled()?;

    let mut png_bytes = Vec::new();
    PngEncoder::new(Cursor::new(&mut png_bytes))
        .write_image(
            rendered.as_raw(),
            layout.canvas_width,
            layout.canvas_height,
            ColorType::Rgba8.into(),
        )
        .map_err(|_| AppError::decode_failed("Failed to encode output PNG image."))?;

    let saved = write_output_bytes_cancellable(
        &params.output_path,
        src_path.as_deref(),
        &png_bytes,
        params.overwrite,
        cancel_flag,
    )?;

    Ok(BeautifyExportResult {
        output_path: saved.path,
        output_width: layout.canvas_width,
        output_height: layout.canvas_height,
        byte_length: saved.byte_length,
    })
}

/// Renders full-resolution beautified image into `ImageAssetStore` (for Clipboard copy or I13 handoff).
pub fn render_beautified_to_asset_impl(
    req: &BeautifyRenderAssetRequest,
    store: &ImageAssetStore,
) -> Result<ImageAssetPayload, AppError> {
    let resolved_bg = resolve_background(&req.style)?;
    let (src_rgba, _) = load_source_rgba(
        req.input_path.as_deref(),
        req.asset_id.as_deref(),
        Some(store),
    )?;
    let (src_w, src_h) = src_rgba.dimensions();
    let layout = compute_frame_layout(
        src_w,
        src_h,
        req.style.padding,
        req.style.corner_radius,
        req.style.shadow_strength,
        req.style.aspect_ratio,
    )?;
    let rendered = render_beautified_rgba_with_bg(&src_rgba, &resolved_bg, &layout);
    let label = req
        .label
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "beautified.png".into());
    store.insert_rgba(&rendered, label)
}

/// Applies one beautify configuration across a batch of images, exporting lossless PNGs
/// to `output_dir` with automatic non-overwrite collision handling and real cancellation.
pub fn beautify_images_batch_impl<F>(
    task_id: &str,
    req: &BeautifyBatchRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: F,
) -> Result<BatchImageJobResponse, AppError>
where
    F: FnMut(&ImageBatchProgressPayload),
{
    let output_dir = validate_output_directory(&req.output_dir)?;
    let resolved_bg = resolve_background(&req.style)?;

    let total = req.source_paths.len();
    let mut items = Vec::with_capacity(total);
    let mut succeeded = 0usize;
    let mut skipped = 0usize;
    let mut failed = 0usize;
    let mut total_orig = 0u64;
    let mut total_out = 0u64;
    let mut cancelled = false;

    for (idx, raw) in req.source_paths.iter().enumerate() {
        if cancel_flag.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
        let path = PathBuf::from(raw);
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| raw.clone());
        let stem = path
            .file_stem()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "image".into());

        on_progress(&ImageBatchProgressPayload {
            task_id: task_id.to_string(),
            tool_id: "I03".into(),
            current_index: idx + 1,
            total_items: total,
            current_file_name: file_name.clone(),
        });

        let step_res: Result<(u64, u32, u32, PathBuf, u64), AppError> = (|| {
            let (valid_path, byte_len) = validate_existing_input_file(raw)?;
            let decoded = open_validated_source_image(&valid_path, byte_len)?;
            let rgba = decoded.to_rgba8();
            let (sw, sh) = rgba.dimensions();
            let layout = compute_frame_layout(
                sw,
                sh,
                req.style.padding,
                req.style.corner_radius,
                req.style.shadow_strength,
                req.style.aspect_ratio,
            )?;
            if cancel_flag.load(Ordering::Relaxed) {
                return Err(AppError::cancelled());
            }
            let rendered = render_beautified_rgba_with_bg(&rgba, &resolved_bg, &layout);
            let png_bytes = encode_rgba_to_png_fast(&rendered)?;
            if cancel_flag.load(Ordering::Relaxed) {
                return Err(AppError::cancelled());
            }
            let out_path = write_unique_output_file(&output_dir, &stem, "png", &png_bytes)?;
            Ok((
                byte_len,
                layout.canvas_width,
                layout.canvas_height,
                out_path,
                png_bytes.len() as u64,
            ))
        })();

        match step_res {
            Ok((orig_b, ow, oh, out_p, out_b)) => {
                total_orig = total_orig.saturating_add(orig_b);
                total_out = total_out.saturating_add(out_b);
                succeeded += 1;
                items.push(BatchImageItemOutcome {
                    source_path: raw.clone(),
                    file_name,
                    output_path: Some(out_p.to_string_lossy().into_owned()),
                    status: BatchImageOutcomeStatus::Ok,
                    original_bytes: orig_b,
                    output_bytes: out_b,
                    saved_percent: 0.0,
                    output_width: Some(ow),
                    output_height: Some(oh),
                    codec_note: Some("Lossless PNG".into()),
                    message: None,
                });
            }
            Err(err) if err.code == "TASK_CANCELLED" => {
                cancelled = true;
                break;
            }
            Err(err) => {
                failed += 1;
                items.push(BatchImageItemOutcome {
                    source_path: raw.clone(),
                    file_name,
                    output_path: None,
                    status: BatchImageOutcomeStatus::Error,
                    original_bytes: 0,
                    output_bytes: 0,
                    saved_percent: 0.0,
                    output_width: None,
                    output_height: None,
                    codec_note: None,
                    message: Some(err.message),
                });
            }
        }
    }

    if cancelled {
        for raw in req.source_paths.iter().skip(items.len()) {
            let file_name = Path::new(raw)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| raw.clone());
            skipped += 1;
            items.push(BatchImageItemOutcome {
                source_path: raw.clone(),
                file_name,
                output_path: None,
                status: BatchImageOutcomeStatus::Skipped,
                original_bytes: 0,
                output_bytes: 0,
                saved_percent: 0.0,
                output_width: None,
                output_height: None,
                codec_note: None,
                message: Some("Cancelled before processing".into()),
            });
        }
    }

    Ok(BatchImageJobResponse {
        task_id: task_id.to_string(),
        tool_id: "I03".into(),
        output_dir: output_dir.to_string_lossy().into_owned(),
        cancelled,
        succeeded_count: succeeded,
        kept_original_count: 0,
        skipped_count: skipped,
        failed_count: failed,
        total_original_bytes: total_orig,
        total_output_bytes: total_out,
        items,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::RgbImage;
    use tempfile::tempdir;

    #[test]
    fn exports_redecodable_png_for_landscape_portrait_and_transparent_inputs_without_overwriting_source(
    ) {
        let dir = tempdir().expect("tempdir");
        let sub = dir.path().join("截图 美化 测试");
        std::fs::create_dir_all(&sub).expect("mkdir");

        let mut trans_src = RgbaImage::from_pixel(120, 60, Rgba([220, 40, 40, 255]));
        for y in 20..40 {
            for x in 40..80 {
                trans_src.put_pixel(x, y, Rgba([0, 0, 0, 0]));
            }
        }
        let src_png_path = sub.join("透明 横图 样例.png");
        trans_src.save(&src_png_path).expect("save src png");

        let info = inspect_source_image(&src_png_path.to_string_lossy()).expect("inspect");
        assert_eq!((info.width, info.height), (120, 60));
        assert!(info.has_alpha);

        let same_err = export_beautified_png_sync(&BeautifyExportParams {
            input_path: Some(src_png_path.to_string_lossy().into_owned()),
            asset_id: None,
            output_path: src_png_path.to_string_lossy().into_owned(),
            background_kind: BackgroundKind::Solid,
            background_hex: "#E8ECF2".to_string(),
            gradient_start_hex: None,
            gradient_end_hex: None,
            gradient_angle_deg: None,
            background_image_path: None,
            padding: 20,
            corner_radius: 8,
            shadow_strength: 24,
            aspect_ratio: AspectPreset::Original,
            overwrite: true,
        })
        .unwrap_err();
        assert_eq!(same_err.code, "SAME_INPUT_AND_OUTPUT");

        let out_orig = sub.join("导出 原始比例.png");
        let exported = export_beautified_png_sync(&BeautifyExportParams {
            input_path: Some(src_png_path.to_string_lossy().into_owned()),
            asset_id: None,
            output_path: out_orig.to_string_lossy().into_owned(),
            background_kind: BackgroundKind::Solid,
            background_hex: "#102030".to_string(),
            gradient_start_hex: None,
            gradient_end_hex: None,
            gradient_angle_deg: None,
            background_image_path: None,
            padding: 20,
            corner_radius: 10,
            shadow_strength: 0,
            aspect_ratio: AspectPreset::Original,
            overwrite: false,
        })
        .expect("export original");
        assert_eq!((exported.output_width, exported.output_height), (160, 100));

        let decoded_orig = image::open(&out_orig).unwrap().to_rgba8();
        assert_eq!(decoded_orig.get_pixel(2, 2).0, [16, 32, 48, 255]);
        assert_eq!(decoded_orig.get_pixel(80, 50).0, [16, 32, 48, 255]);
        assert_eq!(decoded_orig.get_pixel(25, 30).0, [220, 40, 40, 255]);

        let portrait_jpg_path = sub.join("竖图 样例.jpg");
        let jpg_img = RgbImage::from_pixel(80, 140, image::Rgb([30, 120, 200]));
        jpg_img.save(&portrait_jpg_path).expect("save portrait jpg");

        let out_wide = sub.join("导出 宽屏 16x9.png");
        let wide_res = export_beautified_png_sync(&BeautifyExportParams {
            input_path: Some(portrait_jpg_path.to_string_lossy().into_owned()),
            asset_id: None,
            output_path: out_wide.to_string_lossy().into_owned(),
            background_kind: BackgroundKind::Solid,
            background_hex: "#E8ECF2".to_string(),
            gradient_start_hex: None,
            gradient_end_hex: None,
            gradient_angle_deg: None,
            background_image_path: None,
            padding: 20,
            corner_radius: 12,
            shadow_strength: 30,
            aspect_ratio: AspectPreset::Wide16x9,
            overwrite: false,
        })
        .expect("export portrait 16:9");
        assert_eq!((wide_res.output_width, wide_res.output_height), (320, 180));
    }

    #[test]
    fn renders_gradients_cover_bg_images_4x5_9x16_aspects_and_batch_mode_cleanly() {
        let dir = tempdir().unwrap();
        let out_dir = dir.path().join("batch_out");
        std::fs::create_dir_all(&out_dir).unwrap();

        // 1. Gradient + 4:5 aspect
        let layout_45 =
            compute_frame_layout(100, 100, 20, 8, 0, AspectPreset::Portrait4x5).unwrap();
        assert_eq!(
            (layout_45.canvas_width, layout_45.canvas_height),
            (140, 175)
        );
        let layout_916 = compute_frame_layout(100, 100, 20, 8, 0, AspectPreset::Story9x16).unwrap();
        assert_eq!(
            (layout_916.canvas_width, layout_916.canvas_height),
            (140, 249)
        );

        let fg = RgbaImage::from_pixel(100, 100, Rgba([255, 255, 255, 255]));
        let grad_img = render_beautified_rgba_with_bg(
            &fg,
            &ResolvedBackground::Gradient {
                start: [20, 40, 200],
                end: [240, 100, 30],
                angle_deg: 90.0, // left -> right
            },
            &layout_45,
        );
        // Left margin should be near start blue, right margin near end orange
        let left_px = grad_img.get_pixel(2, 80).0;
        let right_px = grad_img.get_pixel(137, 80).0;
        assert!(left_px[2] > 180 && right_px[0] > 210);

        // 2. Background image + batch processing of same-named files from two folders
        let bg_path = dir.path().join("wallpaper.png");
        RgbaImage::from_pixel(40, 20, Rgba([40, 180, 90, 255]))
            .save(&bg_path)
            .unwrap();
        let fa = dir.path().join("a");
        let fb = dir.path().join("b");
        std::fs::create_dir_all(&fa).unwrap();
        std::fs::create_dir_all(&fb).unwrap();
        let p1 = fa.join("shot.png");
        let p2 = fb.join("shot.png");
        fg.save(&p1).unwrap();
        RgbaImage::from_pixel(60, 120, Rgba([20, 20, 20, 255]))
            .save(&p2)
            .unwrap();

        let cancel = AtomicBool::new(false);
        let res = beautify_images_batch_impl(
            "t-i03-batch",
            &BeautifyBatchRequest {
                source_paths: vec![
                    p1.to_string_lossy().into_owned(),
                    p2.to_string_lossy().into_owned(),
                ],
                output_dir: out_dir.to_string_lossy().into_owned(),
                style: BeautifyStyleConfig {
                    background_kind: BackgroundKind::Image,
                    background_hex: "#FFFFFF".into(),
                    gradient_start_hex: None,
                    gradient_end_hex: None,
                    gradient_angle_deg: None,
                    background_image_path: Some(bg_path.to_string_lossy().into_owned()),
                    padding: 20,
                    corner_radius: 10,
                    shadow_strength: 0,
                    aspect_ratio: AspectPreset::Portrait4x5,
                },
            },
            &cancel,
            |_| {},
        )
        .expect("batch beautify");

        assert_eq!(res.succeeded_count, 2);
        assert_ne!(res.items[0].output_path, res.items[1].output_path);
        let out0 = image::open(res.items[0].output_path.as_ref().unwrap())
            .unwrap()
            .to_rgba8();
        assert_eq!(out0.dimensions(), (140, 175));
        assert_eq!(out0.get_pixel(4, 4).0, [40, 180, 90, 255]);
    }

    #[test]
    fn rejects_oversized_dimensions_cleanly() {
        let err =
            compute_frame_layout(17_000, 500, 40, 12, 20, AspectPreset::Original).unwrap_err();
        assert_eq!(err.code, "SIZE_LIMIT_EXCEEDED");
    }
}
