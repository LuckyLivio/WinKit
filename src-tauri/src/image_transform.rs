//! Phase 3A Batch 2 backend: I07 Batch Image Resize & I08 Batch Rotate/Flip.
//!
//! All operations first decode images into upright display pixels (baking any EXIF
//! orientation 2..=8 cleanly) and export without residual EXIF orientation tags so
//! Windows Photos and other viewers never rotate exported images a second time.

use crate::error::AppError;
use crate::fs_guard::validate_user_path;
use crate::image_core::{
    decode_image_to_display, encode_bmp_bytes, encode_jpeg_bytes, encode_png_lossless_bytes,
    encode_preview_data_url, encode_tiff_bytes, encode_webp_bytes, validate_output_directory,
    write_unique_output_file, BatchImageItemOutcome, BatchImageJobResponse,
    BatchImageOutcomeStatus, ImageBatchProgressPayload, ImageFileFormat,
};
use crate::wic_heic::{encode_heic_bytes_via_wic, get_heic_capabilities};
use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const PREVIEW_MAX_EDGE: u32 = 1400;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResizeMode {
    Percentage,
    LongestEdge,
    Exact,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeImagesBatchRequest {
    pub source_paths: Vec<String>,
    pub output_dir: String,
    pub mode: ResizeMode,
    pub percentage: f64,
    pub longest_edge: u32,
    pub target_width: u32,
    pub target_height: u32,
    pub keep_aspect_ratio: bool,
    pub prevent_upscale: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransformStep {
    RotateLeft,
    RotateRight,
    Rotate180,
    FlipHorizontal,
    FlipVertical,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRotateImageRequest {
    pub path: String,
    pub steps: Vec<TransformStep>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRotateImageResponse {
    pub preview_data_url: String,
    pub source_exif_orientation: u16,
    pub display_width: u32,
    pub display_height: u32,
    pub output_width: u32,
    pub output_height: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RotateImagesBatchRequest {
    pub source_paths: Vec<String>,
    pub output_dir: String,
    pub steps: Vec<TransformStep>,
}

/// Computes exact target pixel dimensions from display-oriented `(display_w, display_h)`.
/// Mirrors `computeResizeTargetDimensions` in `src/tools/image-batch/imageBatchModel.ts`.
#[allow(clippy::too_many_arguments)]
pub fn compute_resize_target_dimensions(
    display_w: u32,
    display_h: u32,
    mode: ResizeMode,
    percentage: f64,
    longest_edge: u32,
    target_width: u32,
    target_height: u32,
    keep_aspect_ratio: bool,
    prevent_upscale: bool,
) -> (u32, u32, bool) {
    let w = display_w.max(1);
    let h = display_h.max(1);

    let (raw_w, raw_h) = match mode {
        ResizeMode::Percentage => {
            let clamped_pct = if percentage.is_finite() {
                percentage.clamp(1.0, 400.0)
            } else {
                100.0
            };
            let effective_pct = if prevent_upscale && clamped_pct > 100.0 {
                100.0
            } else {
                clamped_pct
            };
            let scale = effective_pct / 100.0;
            let nw = ((w as f64) * scale).round().max(1.0) as u32;
            let nh = ((h as f64) * scale).round().max(1.0) as u32;
            (nw, nh)
        }
        ResizeMode::LongestEdge => {
            let edge = longest_edge.clamp(1, 32_768);
            let current_long = w.max(h);
            if prevent_upscale && current_long <= edge {
                (w, h)
            } else {
                let scale = (edge as f64) / (current_long as f64);
                let nw = ((w as f64) * scale).round().max(1.0) as u32;
                let nh = ((h as f64) * scale).round().max(1.0) as u32;
                (nw, nh)
            }
        }
        ResizeMode::Exact => {
            let req_w = target_width.clamp(1, 32_768);
            let req_h = target_height.clamp(1, 32_768);
            if keep_aspect_ratio {
                let scale_w = (req_w as f64) / (w as f64);
                let scale_h = (req_h as f64) / (h as f64);
                let mut scale = scale_w.min(scale_h);
                if prevent_upscale && scale > 1.0 {
                    scale = 1.0;
                }
                let nw = ((w as f64) * scale).round().max(1.0) as u32;
                let nh = ((h as f64) * scale).round().max(1.0) as u32;
                (nw, nh)
            } else if prevent_upscale {
                (req_w.min(w), req_h.min(h))
            } else {
                (req_w, req_h)
            }
        }
    };

    let unchanged = raw_w == w && raw_h == h;
    (raw_w, raw_h, unchanged)
}

pub fn apply_transform_steps(mut img: DynamicImage, steps: &[TransformStep]) -> DynamicImage {
    for step in steps {
        img = match step {
            TransformStep::RotateLeft => img.rotate270(),
            TransformStep::RotateRight => img.rotate90(),
            TransformStep::Rotate180 => img.rotate180(),
            TransformStep::FlipHorizontal => img.fliph(),
            TransformStep::FlipVertical => img.flipv(),
        };
    }
    img
}

/// Encodes transformed/resized display pixels back into the source format while
/// preserving ICC color profiles and writing implicit Orientation = 1 (no EXIF
/// orientation tag so viewers never rotate a second time).
fn encode_in_native_or_safe_format(
    img: &DynamicImage,
    source_format: ImageFileFormat,
    icc: Option<&[u8]>,
) -> Result<(Vec<u8>, &'static str, String), AppError> {
    match source_format {
        ImageFileFormat::Jpeg => {
            let rgb = img.to_rgb8();
            let bytes = encode_jpeg_bytes(&rgb, 92, true, icc)?;
            Ok((bytes, "jpg", "JPEG Q92 (upright)".into()))
        }
        ImageFileFormat::Png | ImageFileFormat::Gif | ImageFileFormat::Unknown => {
            let bytes = encode_png_lossless_bytes(img, 1, icc)?;
            Ok((bytes, "png", "PNG (upright)".into()))
        }
        ImageFileFormat::Webp => {
            let bytes = encode_webp_bytes(img, 92, false, icc)?;
            Ok((bytes, "webp", "WebP Q92 (upright)".into()))
        }
        ImageFileFormat::Tiff => {
            let bytes = encode_tiff_bytes(img)?;
            Ok((bytes, "tiff", "TIFF (upright)".into()))
        }
        ImageFileFormat::Bmp => {
            let bytes = encode_bmp_bytes(img, [255, 255, 255])?;
            Ok((bytes, "bmp", "BMP (upright)".into()))
        }
        ImageFileFormat::Heic => {
            let caps = get_heic_capabilities();
            if caps.encode_available {
                let bytes = encode_heic_bytes_via_wic(&img.to_rgba8(), 92, icc)?;
                Ok((bytes, "heic", "HEIC Q92 (WIC, upright)".into()))
            } else {
                let rgb = img.to_rgb8();
                let bytes = encode_jpeg_bytes(&rgb, 92, true, icc)?;
                Ok((
                    bytes,
                    "jpg",
                    "JPEG Q92 (HEIC encoder unavailable fallback)".into(),
                ))
            }
        }
    }
}

pub fn resize_images_batch_impl<F>(
    task_id: &str,
    req: &ResizeImagesBatchRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: F,
) -> Result<BatchImageJobResponse, AppError>
where
    F: FnMut(&ImageBatchProgressPayload),
{
    let output_dir = validate_output_directory(&req.output_dir)?;
    let total = req.source_paths.len();
    let mut items = Vec::with_capacity(total);
    let mut succeeded = 0usize;
    let mut kept_orig = 0usize;
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
            tool_id: "I07".into(),
            current_index: idx + 1,
            total_items: total,
            current_file_name: file_name.clone(),
        });

        let orig_len = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        total_orig = total_orig.saturating_add(orig_len);

        let decoded = match decode_image_to_display(&path) {
            Ok(d) => d,
            Err(err) => {
                failed += 1;
                items.push(BatchImageItemOutcome {
                    source_path: raw.clone(),
                    file_name,
                    output_path: None,
                    status: BatchImageOutcomeStatus::Error,
                    original_bytes: orig_len,
                    output_bytes: 0,
                    saved_percent: 0.0,
                    output_width: None,
                    output_height: None,
                    codec_note: None,
                    message: Some(err.message),
                });
                continue;
            }
        };

        if cancel_flag.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }

        let (dw, dh) = decoded.image.dimensions();
        let (tw, th, unchanged) = compute_resize_target_dimensions(
            dw,
            dh,
            req.mode,
            req.percentage,
            req.longest_edge,
            req.target_width,
            req.target_height,
            req.keep_aspect_ratio,
            req.prevent_upscale,
        );

        let final_img = if unchanged {
            decoded.image
        } else {
            decoded.image.resize_exact(tw, th, FilterType::Lanczos3)
        };

        if cancel_flag.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }

        match encode_in_native_or_safe_format(
            &final_img,
            decoded.format,
            decoded.icc_profile.as_deref(),
        ) {
            Ok((out_bytes, ext, note)) => {
                match write_unique_output_file(&output_dir, &stem, ext, &out_bytes) {
                    Ok(out_path) => {
                        let out_len = out_bytes.len() as u64;
                        total_out = total_out.saturating_add(out_len);
                        let saved = if orig_len > 0 {
                            (((orig_len as f64) - (out_len as f64)) / (orig_len as f64) * 1000.0)
                                .round()
                                / 10.0
                        } else {
                            0.0
                        };
                        let (status, msg) = if unchanged {
                            kept_orig += 1;
                            (
                                BatchImageOutcomeStatus::KeptOriginal,
                                Some(format!("Kept original dimensions ({dw}×{dh})")),
                            )
                        } else {
                            succeeded += 1;
                            (
                                BatchImageOutcomeStatus::Ok,
                                Some(format!("{dw}×{dh} → {tw}×{th}")),
                            )
                        };
                        items.push(BatchImageItemOutcome {
                            source_path: raw.clone(),
                            file_name,
                            output_path: Some(out_path.to_string_lossy().into_owned()),
                            status,
                            original_bytes: orig_len,
                            output_bytes: out_len,
                            saved_percent: saved,
                            output_width: Some(tw),
                            output_height: Some(th),
                            codec_note: Some(note),
                            message: msg,
                        });
                    }
                    Err(err) => {
                        failed += 1;
                        items.push(BatchImageItemOutcome {
                            source_path: raw.clone(),
                            file_name,
                            output_path: None,
                            status: BatchImageOutcomeStatus::Error,
                            original_bytes: orig_len,
                            output_bytes: 0,
                            saved_percent: 0.0,
                            output_width: None,
                            output_height: None,
                            codec_note: Some(note),
                            message: Some(err.message),
                        });
                    }
                }
            }
            Err(err) => {
                failed += 1;
                items.push(BatchImageItemOutcome {
                    source_path: raw.clone(),
                    file_name,
                    output_path: None,
                    status: BatchImageOutcomeStatus::Error,
                    original_bytes: orig_len,
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
        tool_id: "I07".into(),
        output_dir: output_dir.to_string_lossy().into_owned(),
        cancelled,
        succeeded_count: succeeded,
        kept_original_count: kept_orig,
        skipped_count: skipped,
        failed_count: failed,
        total_original_bytes: total_orig,
        total_output_bytes: total_out,
        items,
    })
}

pub fn preview_rotate_image_impl(
    req: &PreviewRotateImageRequest,
) -> Result<PreviewRotateImageResponse, AppError> {
    let path = validate_user_path(&req.path, "Rotate preview image")?;
    let decoded = decode_image_to_display(&path)?;
    let (dw, dh) = decoded.image.dimensions();
    let transformed = apply_transform_steps(decoded.image, &req.steps);
    let (ow, oh) = transformed.dimensions();
    let url = encode_preview_data_url(&transformed, PREVIEW_MAX_EDGE, decoded.has_alpha)
        .ok_or_else(|| AppError::decode_failed("Failed encoding transform preview."))?;

    Ok(PreviewRotateImageResponse {
        preview_data_url: url,
        source_exif_orientation: decoded.exif_orientation,
        display_width: dw,
        display_height: dh,
        output_width: ow,
        output_height: oh,
    })
}

pub fn rotate_images_batch_impl<F>(
    task_id: &str,
    req: &RotateImagesBatchRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: F,
) -> Result<BatchImageJobResponse, AppError>
where
    F: FnMut(&ImageBatchProgressPayload),
{
    let output_dir = validate_output_directory(&req.output_dir)?;
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
            tool_id: "I08".into(),
            current_index: idx + 1,
            total_items: total,
            current_file_name: file_name.clone(),
        });

        let orig_len = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        total_orig = total_orig.saturating_add(orig_len);

        let decoded = match decode_image_to_display(&path) {
            Ok(d) => d,
            Err(err) => {
                failed += 1;
                items.push(BatchImageItemOutcome {
                    source_path: raw.clone(),
                    file_name,
                    output_path: None,
                    status: BatchImageOutcomeStatus::Error,
                    original_bytes: orig_len,
                    output_bytes: 0,
                    saved_percent: 0.0,
                    output_width: None,
                    output_height: None,
                    codec_note: None,
                    message: Some(err.message),
                });
                continue;
            }
        };

        if cancel_flag.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }

        let transformed = apply_transform_steps(decoded.image, &req.steps);
        let (ow, oh) = transformed.dimensions();

        match encode_in_native_or_safe_format(
            &transformed,
            decoded.format,
            decoded.icc_profile.as_deref(),
        ) {
            Ok((out_bytes, ext, note)) => {
                match write_unique_output_file(&output_dir, &stem, ext, &out_bytes) {
                    Ok(out_path) => {
                        let out_len = out_bytes.len() as u64;
                        total_out = total_out.saturating_add(out_len);
                        succeeded += 1;
                        let saved = if orig_len > 0 {
                            (((orig_len as f64) - (out_len as f64)) / (orig_len as f64) * 1000.0)
                                .round()
                                / 10.0
                        } else {
                            0.0
                        };
                        let orient_msg = if decoded.exif_orientation > 1 {
                            format!(
                                "EXIF #{} baked + {} step(s), exported upright",
                                decoded.exif_orientation,
                                req.steps.len()
                            )
                        } else {
                            format!("{} transform step(s), exported upright", req.steps.len())
                        };
                        items.push(BatchImageItemOutcome {
                            source_path: raw.clone(),
                            file_name,
                            output_path: Some(out_path.to_string_lossy().into_owned()),
                            status: BatchImageOutcomeStatus::Ok,
                            original_bytes: orig_len,
                            output_bytes: out_len,
                            saved_percent: saved,
                            output_width: Some(ow),
                            output_height: Some(oh),
                            codec_note: Some(note),
                            message: Some(orient_msg),
                        });
                    }
                    Err(err) => {
                        failed += 1;
                        items.push(BatchImageItemOutcome {
                            source_path: raw.clone(),
                            file_name,
                            output_path: None,
                            status: BatchImageOutcomeStatus::Error,
                            original_bytes: orig_len,
                            output_bytes: 0,
                            saved_percent: 0.0,
                            output_width: None,
                            output_height: None,
                            codec_note: Some(note),
                            message: Some(err.message),
                        });
                    }
                }
            }
            Err(err) => {
                failed += 1;
                items.push(BatchImageItemOutcome {
                    source_path: raw.clone(),
                    file_name,
                    output_path: None,
                    status: BatchImageOutcomeStatus::Error,
                    original_bytes: orig_len,
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
        tool_id: "I08".into(),
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
    use crate::image_core::read_exif_orientation_from_bytes;
    use tempfile::tempdir;

    /// Injects a minimal valid EXIF APP1 segment with Orientation = `orient` right after JPEG SOI.
    fn inject_jpeg_exif_orientation(jpeg: &[u8], orient: u16) -> Vec<u8> {
        assert!(jpeg.len() >= 2 && jpeg[0] == 0xFF && jpeg[1] == 0xD8);
        // Little-endian TIFF header + 1 IFD0 entry (Tag 0x0112 SHORT count=1 value=orient) + next IFD=0
        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"II");
        tiff.extend_from_slice(&42u16.to_le_bytes());
        tiff.extend_from_slice(&8u32.to_le_bytes());
        tiff.extend_from_slice(&1u16.to_le_bytes()); // 1 entry
        tiff.extend_from_slice(&0x0112u16.to_le_bytes()); // Orientation
        tiff.extend_from_slice(&3u16.to_le_bytes()); // SHORT
        tiff.extend_from_slice(&1u32.to_le_bytes()); // count = 1
        tiff.extend_from_slice(&orient.to_le_bytes());
        tiff.extend_from_slice(&0u16.to_le_bytes());
        tiff.extend_from_slice(&0u32.to_le_bytes()); // next IFD = 0

        let mut payload = Vec::new();
        payload.extend_from_slice(b"Exif\0\0");
        payload.extend_from_slice(&tiff);
        let seg_len = (payload.len() + 2) as u16;

        let mut out = Vec::with_capacity(jpeg.len() + payload.len() + 4);
        out.extend_from_slice(&jpeg[0..2]);
        out.extend_from_slice(&[0xFF, 0xE1]);
        out.extend_from_slice(&seg_len.to_be_bytes());
        out.extend_from_slice(&payload);
        out.extend_from_slice(&jpeg[2..]);
        out
    }

    /// Creates an asymmetric 4-corner marker image (80x40):
    /// TL = Red, TR = Green, BL = Blue, BR = Yellow
    fn make_asymmetric_4corner_rgb() -> image::RgbImage {
        let mut img = image::RgbImage::new(80, 40);
        for (x, y, p) in img.enumerate_pixels_mut() {
            *p = match (x < 40, y < 20) {
                (true, true) => image::Rgb([240, 20, 20]),    // TL: Red
                (false, true) => image::Rgb([20, 230, 20]),   // TR: Green
                (true, false) => image::Rgb([20, 40, 240]),   // BL: Blue
                (false, false) => image::Rgb([245, 235, 20]), // BR: Yellow
            };
        }
        img
    }

    #[test]
    fn resizes_by_percentage_longest_edge_exact_prevents_upscale_and_respects_exif_orientation() {
        let dir = tempdir().expect("tempdir");
        let out_dir = dir.path().join("out");
        fs::create_dir_all(&out_dir).unwrap();

        // Raw 80x40 JPEG tagged with EXIF Orientation 6 -> display dimensions are 40x80 (portrait)!
        let raw_jpg = encode_jpeg_bytes(&make_asymmetric_4corner_rgb(), 96, true, None).unwrap();
        let phone_jpg = inject_jpeg_exif_orientation(&raw_jpg, 6);
        let phone_path = dir.path().join("phone_orient6.jpg");
        fs::write(&phone_path, &phone_jpg).unwrap();

        // Small 30x20 PNG that must NOT be upscaled when target longest_edge = 100
        let small_png = dir.path().join("small.png");
        DynamicImage::ImageRgb8(image::RgbImage::new(30, 20))
            .save(&small_png)
            .unwrap();

        // Check dimension helper directly
        assert_eq!(
            compute_resize_target_dimensions(
                40,
                80,
                ResizeMode::LongestEdge,
                100.0,
                40,
                100,
                100,
                true,
                true
            ),
            (20, 40, false)
        );
        assert_eq!(
            compute_resize_target_dimensions(
                30,
                20,
                ResizeMode::LongestEdge,
                100.0,
                100,
                100,
                100,
                true,
                true
            ),
            (30, 20, true)
        );
        assert_eq!(
            compute_resize_target_dimensions(
                80,
                40,
                ResizeMode::Exact,
                100.0,
                100,
                40,
                40,
                true,
                true
            ),
            (40, 20, false)
        );
        assert_eq!(
            compute_resize_target_dimensions(
                80,
                40,
                ResizeMode::Exact,
                100.0,
                100,
                40,
                40,
                false,
                true
            ),
            (40, 40, false)
        );

        let cancel = AtomicBool::new(false);
        let res = resize_images_batch_impl(
            "t-i07",
            &ResizeImagesBatchRequest {
                source_paths: vec![
                    phone_path.to_string_lossy().into_owned(),
                    small_png.to_string_lossy().into_owned(),
                ],
                output_dir: out_dir.to_string_lossy().into_owned(),
                mode: ResizeMode::LongestEdge,
                percentage: 50.0,
                longest_edge: 40,
                target_width: 40,
                target_height: 40,
                keep_aspect_ratio: true,
                prevent_upscale: true,
            },
            &cancel,
            |_| {},
        )
        .expect("resize batch");

        assert_eq!(res.succeeded_count, 1);
        assert_eq!(res.kept_original_count, 1);
        assert_eq!(res.items[0].output_width, Some(20));
        assert_eq!(res.items[0].output_height, Some(40));
        assert_eq!(res.items[1].output_width, Some(30));
        assert_eq!(res.items[1].output_height, Some(20));

        // Verify exported phone image has upright pixels (20x40) AND EXIF Orientation = 1!
        let out_bytes = fs::read(res.items[0].output_path.as_ref().unwrap()).unwrap();
        assert_eq!(read_exif_orientation_from_bytes(&out_bytes), 1);
        let opened = image::load_from_memory(&out_bytes).unwrap();
        assert_eq!(opened.dimensions(), (20, 40));
    }

    #[test]
    fn verifies_non_commutative_rotate_flip_order_and_bakes_exif_orientation_without_double_rotation(
    ) {
        let dir = tempdir().expect("tempdir");
        let out_dir = dir.path().join("out");
        fs::create_dir_all(&out_dir).unwrap();

        // 1) Non-commutative order check on asymmetric 4-corner image (TL=R, TR=G, BL=B, BR=Y)
        let base = DynamicImage::ImageRgb8(make_asymmetric_4corner_rgb());
        // Order A: RotateRight (TL=B, TR=R, BL=Y, BR=G) then FlipHorizontal (TL=R, TR=B, BL=G, BR=Y)
        let order_a = apply_transform_steps(
            base.clone(),
            &[TransformStep::RotateRight, TransformStep::FlipHorizontal],
        )
        .to_rgb8();
        assert_eq!(order_a.dimensions(), (40, 80));
        let tl_a = order_a.get_pixel(5, 5);
        assert!(
            tl_a[0] > 200 && tl_a[1] < 60 && tl_a[2] < 60,
            "Order A TL should be Red, got {tl_a:?}"
        );

        // Order B: FlipHorizontal (TL=G, TR=R, BL=Y, BR=B) then RotateRight (TL=Y, TR=G, BL=B, BR=R)
        let order_b = apply_transform_steps(
            base,
            &[TransformStep::FlipHorizontal, TransformStep::RotateRight],
        )
        .to_rgb8();
        let tl_b = order_b.get_pixel(5, 5);
        assert!(
            tl_b[0] > 200 && tl_b[1] > 200 && tl_b[2] < 60,
            "Order B TL should be Yellow, got {tl_b:?}"
        );

        // 2) Phone JPEG with EXIF Orientation 6 (raw 80x40 -> display 40x80 with TL=Blue, TR=Red, BL=Yellow, BR=Green)
        // Applying RotateLeft returns it to 80x40 (TL=Red, TR=Green, BL=Blue, BR=Yellow) AND strips EXIF Orientation -> 1!
        let raw_jpg = encode_jpeg_bytes(&make_asymmetric_4corner_rgb(), 96, true, None).unwrap();
        let phone_jpg = inject_jpeg_exif_orientation(&raw_jpg, 6);
        let phone_path = dir.path().join("exif6_photo.jpg");
        fs::write(&phone_path, &phone_jpg).unwrap();

        let cancel = AtomicBool::new(false);
        let res = rotate_images_batch_impl(
            "t-i08",
            &RotateImagesBatchRequest {
                source_paths: vec![phone_path.to_string_lossy().into_owned()],
                output_dir: out_dir.to_string_lossy().into_owned(),
                steps: vec![TransformStep::RotateLeft],
            },
            &cancel,
            |_| {},
        )
        .expect("rotate batch");

        assert_eq!(res.succeeded_count, 1);
        let out_bytes = fs::read(res.items[0].output_path.as_ref().unwrap()).unwrap();
        assert_eq!(
            read_exif_orientation_from_bytes(&out_bytes),
            1,
            "Exported photo must NOT retain EXIF Orientation 6 (would double-rotate in Windows Photos!)"
        );
        let out_img = image::load_from_memory(&out_bytes).unwrap().to_rgb8();
        assert_eq!(out_img.dimensions(), (80, 40));
        let tl = out_img.get_pixel(8, 8);
        assert!(
            tl[0] > 200 && tl[1] < 60 && tl[2] < 60,
            "Expected Red at TL after EXIF6+RotateLeft, got {tl:?}"
        );
    }
}
