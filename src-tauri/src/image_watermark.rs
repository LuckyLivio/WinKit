//! Phase 3B Batch 3 backend: I13 Image Watermark (Text stamp & Transparent PNG Logo).
//!
//! Supports corner/edge/center placement and diagonal brick tiling with relative margins,
//! proportional scaling, opacity, Lanczos3 resizing, bilinear rotation, and exact
//! Porter-Duff source-over alpha compositing (fully preserving transparency on transparent PNGs).
//! Batch processing writes strictly new non-overwriting copies via `write_unique_output_file`
//! with streaming cancellation and atomic `.tmp` cleanup.

use crate::error::AppError;
use crate::fs_guard::validate_existing_input_file;
use crate::image_assets::{
    decode_png_data_url_or_base64, encode_rgba_to_png_fast, ImageAssetPayload, ImageAssetStore,
};
use crate::image_core::{
    composite_rgba_over_rgb, decode_image_to_display, encode_jpeg_bytes, validate_output_directory,
    write_unique_output_file, BatchImageItemOutcome, BatchImageJobResponse,
    BatchImageOutcomeStatus, ImageBatchProgressPayload, ImageFileFormat,
};
use image::imageops::FilterType;
use image::{Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WatermarkPlacement {
    TopLeft,
    TopCenter,
    TopRight,
    MiddleLeft,
    Center,
    MiddleRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
    DiagonalTile,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkStyleConfig {
    /// Either a pre-rasterized transparent PNG stamp (text watermark) or a local PNG logo path.
    pub stamp_png_data_url: Option<String>,
    pub logo_path: Option<String>,
    pub placement: WatermarkPlacement,
    /// Relative watermark width as percentage of base image width (5..=80).
    pub scale_percent: f32,
    /// Relative margin from edges as percentage of min(width, height) (0..=25).
    pub margin_percent: f32,
    /// Opacity percentage (5..=100).
    pub opacity_percent: f32,
    /// Diagonal tile angle in degrees (-60..=60, default -30).
    pub tile_angle_deg: Option<f32>,
    /// Tile gap factor as percentage of rotated stamp size (30..=250, default 110).
    pub tile_spacing_percent: Option<f32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderWatermarkedAssetRequest {
    pub asset_id: Option<String>,
    pub input_path: Option<String>,
    pub label: Option<String>,
    pub style: WatermarkStyleConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkImagesBatchRequest {
    pub source_paths: Vec<String>,
    pub output_dir: String,
    pub style: WatermarkStyleConfig,
}

fn load_stamp_rgba(style: &WatermarkStyleConfig) -> Result<RgbaImage, AppError> {
    if let Some(raw_url) = style
        .stamp_png_data_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let png_bytes = decode_png_data_url_or_base64(raw_url)?;
        let img = image::load_from_memory_with_format(&png_bytes, image::ImageFormat::Png)
            .map_err(|_| AppError::decode_failed("Failed to decode text watermark stamp PNG."))?;
        return Ok(img.to_rgba8());
    }

    if let Some(logo) = style
        .logo_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let (path, _) = validate_existing_input_file(logo)?;
        let decoded = decode_image_to_display(&path)?;
        return Ok(decoded.image.to_rgba8());
    }

    Err(AppError::invalid_param(
        "Please provide watermark text or select a transparent PNG logo.",
    ))
}

/// Computes target stamp pixel size matching frontend preview math 1:1.
pub fn compute_scaled_stamp_size(
    base_w: u32,
    base_h: u32,
    stamp_w: u32,
    stamp_h: u32,
    scale_percent: f32,
) -> (u32, u32) {
    if base_w == 0 || base_h == 0 || stamp_w == 0 || stamp_h == 0 {
        return (1, 1);
    }
    let scale = f64::from(scale_percent.clamp(5.0, 80.0)) / 100.0;
    let aspect = f64::from(stamp_h) / f64::from(stamp_w);
    let mut target_w = (f64::from(base_w) * scale).round().max(16.0);
    let mut target_h = (target_w * aspect).round().max(8.0);

    let max_h = (f64::from(base_h) * 0.45).max(16.0);
    if target_h > max_h {
        target_h = max_h;
        target_w = (target_h / aspect).round().max(8.0);
    }
    let max_w = (f64::from(base_w) * 0.92).max(16.0);
    if target_w > max_w {
        target_w = max_w;
        target_h = (target_w * aspect).round().max(8.0);
    }

    (
        (target_w as u32).clamp(1, base_w),
        (target_h as u32).clamp(1, base_h),
    )
}

/// Rotates an RGBA stamp around its center with bilinear interpolation and zero edge clipping.
fn rotate_rgba_bilinear(src: &RgbaImage, angle_deg: f32) -> RgbaImage {
    let rad = f64::from(angle_deg).to_radians();
    let cos_a = rad.cos();
    let sin_a = rad.sin();
    let sw = src.width() as f64;
    let sh = src.height() as f64;
    let out_w = ((sw * cos_a.abs() + sh * sin_a.abs()).ceil() as u32).max(1);
    let out_h = ((sw * sin_a.abs() + sh * cos_a.abs()).ceil() as u32).max(1);

    let cx_src = sw * 0.5;
    let cy_src = sh * 0.5;
    let cx_dst = out_w as f64 * 0.5;
    let cy_dst = out_h as f64 * 0.5;

    let mut out = RgbaImage::from_pixel(out_w, out_h, Rgba([0, 0, 0, 0]));
    let sw_i = src.width() as i32;
    let sh_i = src.height() as i32;

    let sample_premul = |ix: i32, iy: i32| -> [f64; 4] {
        if ix < 0 || iy < 0 || ix >= sw_i || iy >= sh_i {
            return [0.0; 4];
        }
        let p = src.get_pixel(ix as u32, iy as u32).0;
        let a = f64::from(p[3]) / 255.0;
        [
            f64::from(p[0]) * a,
            f64::from(p[1]) * a,
            f64::from(p[2]) * a,
            a,
        ]
    };

    for y in 0..out_h {
        let dy = y as f64 + 0.5 - cy_dst;
        for x in 0..out_w {
            let dx = x as f64 + 0.5 - cx_dst;
            let sx = dx * cos_a + dy * sin_a + cx_src - 0.5;
            let sy = -dx * sin_a + dy * cos_a + cy_src - 0.5;

            let x0 = sx.floor() as i32;
            let y0 = sy.floor() as i32;
            if x0 < -1 || y0 < -1 || x0 >= sw_i || y0 >= sh_i {
                continue;
            }
            let fx = sx - f64::from(x0);
            let fy = sy - f64::from(y0);

            let p00 = sample_premul(x0, y0);
            let p10 = sample_premul(x0 + 1, y0);
            let p01 = sample_premul(x0, y0 + 1);
            let p11 = sample_premul(x0 + 1, y0 + 1);

            let mut acc = [0.0f64; 4];
            for ch in 0..4 {
                let top = p00[ch] * (1.0 - fx) + p10[ch] * fx;
                let bot = p01[ch] * (1.0 - fx) + p11[ch] * fx;
                acc[ch] = top * (1.0 - fy) + bot * fy;
            }

            if acc[3] > 0.002 {
                let inv_a = 1.0 / acc[3];
                out.put_pixel(
                    x,
                    y,
                    Rgba([
                        (acc[0] * inv_a).round().clamp(0.0, 255.0) as u8,
                        (acc[1] * inv_a).round().clamp(0.0, 255.0) as u8,
                        (acc[2] * inv_a).round().clamp(0.0, 255.0) as u8,
                        (acc[3] * 255.0).round().clamp(0.0, 255.0) as u8,
                    ]),
                );
            }
        }
    }

    out
}

/// Blends `stamp` onto `dst` at `(ox, oy)` using exact Porter-Duff `source-over` compositing,
/// preserving base image transparency cleanly.
fn blend_stamp_over(dst: &mut RgbaImage, stamp: &RgbaImage, ox: i32, oy: i32, opacity: f32) {
    let dw = dst.width() as i32;
    let dh = dst.height() as i32;
    let sw = stamp.width() as i32;
    let sh = stamp.height() as i32;
    let op = opacity.clamp(0.0, 1.0);
    if op <= 0.0 {
        return;
    }

    let x_start = (-ox).max(0);
    let y_start = (-oy).max(0);
    let x_end = sw.min(dw - ox);
    let y_end = sh.min(dh - oy);
    if x_start >= x_end || y_start >= y_end {
        return;
    }

    for sy in y_start..y_end {
        let dy = (oy + sy) as u32;
        for sx in x_start..x_end {
            let sp = stamp.get_pixel(sx as u32, sy as u32).0;
            if sp[3] == 0 {
                continue;
            }
            let sa = (f32::from(sp[3]) / 255.0) * op;
            if sa <= 0.001 {
                continue;
            }
            let dx = (ox + sx) as u32;
            let dp = dst.get_pixel(dx, dy).0;
            let da = f32::from(dp[3]) / 255.0;
            let out_a = sa + da * (1.0 - sa);
            if out_a <= 0.0001 {
                continue;
            }
            let inv_out = 1.0 / out_a;
            let r = (f32::from(sp[0]) * sa + f32::from(dp[0]) * da * (1.0 - sa)) * inv_out;
            let g = (f32::from(sp[1]) * sa + f32::from(dp[1]) * da * (1.0 - sa)) * inv_out;
            let b = (f32::from(sp[2]) * sa + f32::from(dp[2]) * da * (1.0 - sa)) * inv_out;
            dst.put_pixel(
                dx,
                dy,
                Rgba([
                    r.round().clamp(0.0, 255.0) as u8,
                    g.round().clamp(0.0, 255.0) as u8,
                    b.round().clamp(0.0, 255.0) as u8,
                    (out_a * 255.0).round().clamp(0.0, 255.0) as u8,
                ]),
            );
        }
    }
}

/// Applies the resolved RGBA watermark stamp onto a cloned base image.
pub fn composite_watermark_rgba(
    base: &RgbaImage,
    stamp_raw: &RgbaImage,
    style: &WatermarkStyleConfig,
) -> Result<RgbaImage, AppError> {
    let (bw, bh) = base.dimensions();
    if bw == 0 || bh == 0 {
        return Err(AppError::invalid_param(
            "Source image dimensions must be positive.",
        ));
    }
    let (sw_raw, sh_raw) = stamp_raw.dimensions();
    if sw_raw == 0 || sh_raw == 0 {
        return Err(AppError::invalid_param(
            "Watermark image dimensions must be positive.",
        ));
    }

    let (tw, th) = compute_scaled_stamp_size(bw, bh, sw_raw, sh_raw, style.scale_percent);
    let scaled_stamp = if tw == sw_raw && th == sh_raw {
        stamp_raw.clone()
    } else {
        image::imageops::resize(stamp_raw, tw, th, FilterType::Lanczos3)
    };

    let opacity = style.opacity_percent.clamp(5.0, 100.0) / 100.0;
    let margin = ((f64::from(bw.min(bh)) * f64::from(style.margin_percent.clamp(0.0, 25.0)))
        / 100.0)
        .round() as i32;

    let mut out = base.clone();

    if style.placement == WatermarkPlacement::DiagonalTile {
        let angle = style.tile_angle_deg.unwrap_or(-30.0).clamp(-60.0, 60.0);
        let rotated = if angle.abs() < 0.1 {
            scaled_stamp
        } else {
            rotate_rgba_bilinear(&scaled_stamp, angle)
        };
        let rw = rotated.width() as i32;
        let rh = rotated.height() as i32;
        let spacing = style
            .tile_spacing_percent
            .unwrap_or(110.0)
            .clamp(30.0, 250.0)
            / 100.0;
        let step_x = ((rw as f32) * (1.0 + spacing * 0.55)).round().max(24.0) as i32;
        let step_y = ((rh as f32) * (1.0 + spacing * 0.65)).round().max(24.0) as i32;

        let mut row_idx = 0i32;
        let mut y = -rh / 2;
        while y < bh as i32 + rh {
            let x_offset = if row_idx % 2 == 1 { step_x / 2 } else { 0 };
            let mut x = -rw + x_offset;
            while x < bw as i32 + rw {
                blend_stamp_over(&mut out, &rotated, x, y, opacity);
                x += step_x;
            }
            y += step_y;
            row_idx += 1;
        }
        return Ok(out);
    }

    let bw_i = bw as i32;
    let bh_i = bh as i32;
    let tw_i = tw as i32;
    let th_i = th as i32;

    let (ox, oy) = match style.placement {
        WatermarkPlacement::TopLeft => (margin, margin),
        WatermarkPlacement::TopCenter => ((bw_i - tw_i) / 2, margin),
        WatermarkPlacement::TopRight => (bw_i - tw_i - margin, margin),
        WatermarkPlacement::MiddleLeft => (margin, (bh_i - th_i) / 2),
        WatermarkPlacement::Center => ((bw_i - tw_i) / 2, (bh_i - th_i) / 2),
        WatermarkPlacement::MiddleRight => (bw_i - tw_i - margin, (bh_i - th_i) / 2),
        WatermarkPlacement::BottomLeft => (margin, bh_i - th_i - margin),
        WatermarkPlacement::BottomCenter => ((bw_i - tw_i) / 2, bh_i - th_i - margin),
        WatermarkPlacement::BottomRight => (bw_i - tw_i - margin, bh_i - th_i - margin),
        WatermarkPlacement::DiagonalTile => unreachable!(),
    };

    blend_stamp_over(&mut out, &scaled_stamp, ox, oy, opacity);
    Ok(out)
}

/// Renders a standalone transparent RGBA watermark overlay sized `(width, height)` matching
/// `composite_watermark_rgba` and frontend `watermarkStamp.ts` placement/tiling math 1:1.
/// Shared by `video_watermark` (I13 video mode) so image and video watermarks stay pixel-consistent.
pub fn render_watermark_overlay_rgba(
    width: u32,
    height: u32,
    style: &WatermarkStyleConfig,
) -> Result<RgbaImage, AppError> {
    if width == 0 || height == 0 {
        return Err(AppError::invalid_param(
            "Video overlay dimensions must be positive.",
        ));
    }
    let stamp = load_stamp_rgba(style)?;
    let blank = RgbaImage::from_pixel(width, height, Rgba([0, 0, 0, 0]));
    composite_watermark_rgba(&blank, &stamp, style)
}

pub fn render_watermarked_asset_impl(
    store: &ImageAssetStore,
    req: &RenderWatermarkedAssetRequest,
) -> Result<ImageAssetPayload, AppError> {
    let stamp = load_stamp_rgba(&req.style)?;
    let (src_rgba, fallback_label) = if let Some(aid) = req
        .asset_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        store.get_rgba(aid)?
    } else if let Some(raw_path) = req
        .input_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let (path, _) = validate_existing_input_file(raw_path)?;
        let decoded = decode_image_to_display(&path)?;
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "watermarked.png".into());
        (decoded.image.to_rgba8(), name)
    } else {
        return Err(AppError::invalid_param(
            "Provide either an in-memory asset or local image file path.",
        ));
    };

    let out_rgba = composite_watermark_rgba(&src_rgba, &stamp, &req.style)?;
    let label = req
        .label
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&fallback_label)
        .to_string();
    store.insert_rgba(&out_rgba, label)
}

pub fn watermark_images_batch_impl<F>(
    task_id: &str,
    req: &WatermarkImagesBatchRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: F,
) -> Result<BatchImageJobResponse, AppError>
where
    F: FnMut(&ImageBatchProgressPayload),
{
    let output_dir = validate_output_directory(&req.output_dir)?;
    let stamp = load_stamp_rgba(&req.style)?;
    let total = req.source_paths.len();
    let mut items = Vec::with_capacity(total);
    let mut succeeded = 0usize;
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
            .map(|s| s.to_string_lossy().into_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "image".into());

        on_progress(&ImageBatchProgressPayload {
            task_id: task_id.to_string(),
            tool_id: "I13".to_string(),
            current_index: idx + 1,
            total_items: total,
            current_file_name: file_name.clone(),
        });

        let process = (|| -> Result<(String, u64, u64, u32, u32), AppError> {
            let (validated, orig_bytes) = validate_existing_input_file(raw)?;
            let decoded = decode_image_to_display(&validated)?;
            let rgba = decoded.image.to_rgba8();
            let watermarked = composite_watermark_rgba(&rgba, &stamp, &req.style)?;
            let (ow, oh) = watermarked.dimensions();

            if cancel_flag.load(Ordering::Relaxed) {
                return Err(AppError::cancelled());
            }

            // Preserve alpha cleanly as PNG for transparent / PNG / WebP / TIFF inputs; keep JPEG for opaque JPEGs
            let keep_jpeg = decoded.format == ImageFileFormat::Jpeg
                && !watermarked.pixels().any(|p| p.0[3] < 255);
            let (out_bytes, ext) = if keep_jpeg {
                let rgb = composite_rgba_over_rgb(&watermarked, [255, 255, 255]);
                (encode_jpeg_bytes(&rgb, 92, true, None)?, "jpg")
            } else {
                (encode_rgba_to_png_fast(&watermarked)?, "png")
            };

            let written_path = write_unique_output_file(
                &output_dir,
                &format!("{stem}_watermarked"),
                ext,
                &out_bytes,
            )?;
            Ok((
                written_path.to_string_lossy().into_owned(),
                orig_bytes,
                out_bytes.len() as u64,
                ow,
                oh,
            ))
        })();

        match process {
            Ok((out_path, orig_b, out_b, ow, oh)) => {
                succeeded += 1;
                total_orig += orig_b;
                total_out += out_b;
                items.push(BatchImageItemOutcome {
                    source_path: raw.clone(),
                    file_name,
                    status: BatchImageOutcomeStatus::Ok,
                    output_path: Some(out_path),
                    original_bytes: orig_b,
                    output_bytes: out_b,
                    saved_percent: 0.0,
                    output_width: Some(ow),
                    output_height: Some(oh),
                    codec_note: None,
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
                    status: BatchImageOutcomeStatus::Error,
                    output_path: None,
                    original_bytes: 0,
                    output_bytes: 0,
                    saved_percent: 0.0,
                    output_width: None,
                    output_height: None,
                    codec_note: Some(err.code.to_string()),
                    message: Some(err.message),
                });
            }
        }
    }

    Ok(BatchImageJobResponse {
        task_id: task_id.to_string(),
        tool_id: "I13".to_string(),
        output_dir: output_dir.to_string_lossy().into_owned(),
        succeeded_count: succeeded,
        kept_original_count: 0,
        skipped_count: 0,
        failed_count: failed,
        cancelled,
        total_original_bytes: total_orig,
        total_output_bytes: total_out,
        items,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn composites_logo_and_diagonal_tile_preserving_png_transparency_and_never_overwriting() {
        let dir = tempdir().expect("tempdir");
        let in_a = dir.path().join("sub_a");
        let in_b = dir.path().join("sub_b");
        let out_dir = dir.path().join("out");
        fs::create_dir_all(&in_a).unwrap();
        fs::create_dir_all(&in_b).unwrap();
        fs::create_dir_all(&out_dir).unwrap();

        // 1. Landscape opaque PNG
        let land_path = in_a.join("photo.png");
        RgbaImage::from_pixel(640, 360, Rgba([240, 244, 248, 255]))
            .save(&land_path)
            .unwrap();

        // 2. Same-basename portrait transparent PNG (alpha=0 background with center opaque square)
        let port_path = in_b.join("photo.png");
        let mut port = RgbaImage::from_pixel(360, 640, Rgba([0, 0, 0, 0]));
        for y in 200..440 {
            for x in 80..280 {
                port.put_pixel(x, y, Rgba([40, 90, 200, 255]));
            }
        }
        port.save(&port_path).unwrap();

        // 3. Transparent PNG logo (red square inside transparent frame)
        let logo_path = dir.path().join("logo.png");
        let mut logo = RgbaImage::from_pixel(80, 40, Rgba([0, 0, 0, 0]));
        for y in 4..36 {
            for x in 4..76 {
                logo.put_pixel(x, y, Rgba([220, 38, 38, 255]));
            }
        }
        logo.save(&logo_path).unwrap();

        let orig_land_hash = Sha256::digest(fs::read(&land_path).unwrap());
        let orig_port_hash = Sha256::digest(fs::read(&port_path).unwrap());

        let cancel = AtomicBool::new(false);
        let req = WatermarkImagesBatchRequest {
            source_paths: vec![
                land_path.to_string_lossy().into_owned(),
                port_path.to_string_lossy().into_owned(),
            ],
            output_dir: out_dir.to_string_lossy().into_owned(),
            style: WatermarkStyleConfig {
                stamp_png_data_url: None,
                logo_path: Some(logo_path.to_string_lossy().into_owned()),
                placement: WatermarkPlacement::BottomRight,
                scale_percent: 25.0,
                margin_percent: 5.0,
                opacity_percent: 80.0,
                tile_angle_deg: None,
                tile_spacing_percent: None,
            },
        };

        let report = watermark_images_batch_impl("wm-1", &req, &cancel, |_| {}).expect("batch");
        assert_eq!(report.succeeded_count, 2);
        assert_eq!(report.failed_count, 0);
        assert!(!report.cancelled);

        // Two same-basename inputs must receive distinct output paths (no overwrite!)
        let out_0 = report.items[0].output_path.as_ref().unwrap();
        let out_1 = report.items[1].output_path.as_ref().unwrap();
        assert_ne!(out_0, out_1);

        // Source files untouched (SHA-256 unchanged)
        assert_eq!(
            Sha256::digest(fs::read(&land_path).unwrap()),
            orig_land_hash
        );
        assert_eq!(
            Sha256::digest(fs::read(&port_path).unwrap()),
            orig_port_hash
        );

        // Portrait transparent PNG must remain transparent in top-left corner AND carry red watermark near bottom-right
        let port_out = image::open(out_1).expect("open port out").to_rgba8();
        assert_eq!(port_out.dimensions(), (360, 640));
        assert_eq!(
            port_out.get_pixel(5, 5).0[3],
            0,
            "top-left transparent region must remain alpha=0"
        );
        let br_px = port_out.get_pixel(300, 600).0;
        assert!(
            br_px[0] > 180 && br_px[3] > 150,
            "bottom-right watermark logo should be visible over transparent canvas, got {br_px:?}"
        );

        // Also verify diagonal tile mode covers center cleanly
        let tiled = composite_watermark_rgba(
            &RgbaImage::from_pixel(400, 300, Rgba([255, 255, 255, 255])),
            &logo,
            &WatermarkStyleConfig {
                stamp_png_data_url: None,
                logo_path: None,
                placement: WatermarkPlacement::DiagonalTile,
                scale_percent: 25.0,
                margin_percent: 4.0,
                opacity_percent: 50.0,
                tile_angle_deg: Some(-30.0),
                tile_spacing_percent: Some(100.0),
            },
        )
        .expect("diagonal tile");
        let tinted_pixels = tiled.pixels().filter(|p| p.0[1] < 245).count();
        assert!(
            tinted_pixels > 1500,
            "diagonal tiling must stamp multiple copies across the canvas, got {tinted_pixels} tinted pixels"
        );
    }
}
