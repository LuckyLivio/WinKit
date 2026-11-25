//! Core offline image background-removal (`I04`) inference, alpha compositing, tight subject
//! cropping, in-memory full-resolution result cache, and safe non-destructive export.
//!
//! Design guarantees:
//! - Reuses `image_core::decode_image_to_display` so EXIF Orientation `1..=8`, HEIC (WIC),
//!   PNG/JPEG/WebP/TIFF/BMP/GIF, 128 MiB file ceiling, and 100 MP pixel ceiling are enforced
//!   consistently across WinKit.
//! - Runs `BiRefNet_lite 512 FP16` via WinKit's bundled `onnxruntime.dll 1.23.2` with
//!   `DisableCpuMemArena` + `DisableMemPattern` enabled, keeping idle worker RAM around ~284 MiB
//!   and peak commit around ~2.4 GiB instead of >5.3 GiB.
//! - Preserves existing transparency on semi-transparent inputs via multiplicative alpha
//!   compositing (`final_alpha = round(src_alpha * mask_alpha / 255)`) while feeding the model
//!   a neutral mid-gray backdrop so transparent RGB garbage never leaks halos.
//! - Keeps original upright dimensions by default and supports optional tight subject cropping
//!   with configurable padding, transparent PNG/WebP export, or solid-color PNG/JPEG/WebP export.
//! - Never overwrites the source file (`SAME_INPUT_AND_OUTPUT`) and commits outputs atomically via
//!   `fs_guard::write_output_bytes_cancellable`.

use crate::error::AppError;
use crate::fs_guard::{
    paths_refer_to_same_location, validate_user_path, write_output_bytes_cancellable,
};
use crate::image_assets::{copy_png_to_system_clipboard, ImageAssetStore};
use crate::image_core::{
    composite_rgba_over_rgb, decode_image_to_display, encode_jpeg_bytes, encode_preview_data_url,
    encode_webp_bytes, inject_png_iccp_chunk,
};
use crate::matting_models::ResolvedMattingAssets;
use crate::ocr_ort::{resolve_ort_dll_path, OrtRuntime, OrtSession};
use image::codecs::png::{CompressionType, FilterType as PngFilterType, PngEncoder};
use image::imageops::FilterType;
use image::{ColorType, DynamicImage, GrayImage, ImageEncoder, RgbImage, RgbaImage};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub const MATTING_PROGRESS_EVENT: &str = "winkit://matting-progress";
pub const MATTING_MODEL_INPUT_SIZE: u32 = 512;
pub const MATTING_RGB512_BYTES: usize =
    (MATTING_MODEL_INPUT_SIZE as usize) * (MATTING_MODEL_INPUT_SIZE as usize) * 3;
pub const MATTING_MASK512_BYTES: usize =
    (MATTING_MODEL_INPUT_SIZE as usize) * (MATTING_MODEL_INPUT_SIZE as usize);
pub const TIGHT_CROP_ALPHA_THRESHOLD: u8 = 8;
pub const MAX_CROP_PADDING_PX: u32 = 512;

const IMAGENET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const IMAGENET_STD: [f32; 3] = [0.229, 0.224, 0.225];
const PREVIEW_MAX_EDGE: u32 = 1600;
const MAX_MATTING_STORE_ITEMS: usize = 4;
const MAX_MATTING_STORE_TOTAL_BYTES: usize = 160 * 1024 * 1024; // 160 MiB compressed PNG RAM cap

static MATTING_RESULT_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubjectBoundingBox {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MattingBackgroundMode {
    Transparent,
    SolidColor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MattingExportFormat {
    Png,
    Jpeg,
    Webp,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MattingProgressPayload {
    pub task_id: String,
    pub phase: String,
    pub percent: f64,
    pub detail: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveBackgroundRequest {
    pub path: Option<String>,
    pub asset_id: Option<String>,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveBackgroundResult {
    pub result_id: String,
    pub cutout_asset_id: Option<String>,
    pub file_name: String,
    pub source_path: Option<String>,
    pub width: u32,
    pub height: u32,
    pub raw_width: u32,
    pub raw_height: u32,
    pub exif_orientation: u16,
    pub source_has_alpha: bool,
    pub preserved_source_alpha: bool,
    pub subject_bbox: Option<SubjectBoundingBox>,
    pub foreground_ratio: f64,
    pub soft_edge_ratio: f64,
    pub elapsed_ms: u64,
    pub original_preview_data_url: String,
    pub cutout_preview_data_url: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MattingExportRequest {
    pub result_id: String,
    pub output_path: String,
    pub source_path: Option<String>,
    pub overwrite: bool,
    pub background_mode: MattingBackgroundMode,
    pub background_hex: Option<String>,
    pub format: MattingExportFormat,
    pub quality: Option<u8>,
    pub crop_to_subject: bool,
    pub crop_padding_px: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MattingExportResult {
    pub output_path: String,
    pub width: u32,
    pub height: u32,
    pub byte_length: u64,
    pub has_alpha: bool,
    pub cropped: bool,
    pub format: MattingExportFormat,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MattingCopyClipboardRequest {
    pub result_id: String,
    pub background_mode: MattingBackgroundMode,
    pub background_hex: Option<String>,
    pub crop_to_subject: bool,
    pub crop_padding_px: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MattingCopyClipboardResult {
    pub width: u32,
    pub height: u32,
    pub has_alpha: bool,
    pub cropped: bool,
}

#[derive(Debug, Clone)]
pub struct MattingAlphaStats {
    pub subject_bbox: Option<SubjectBoundingBox>,
    pub foreground_ratio: f64,
    pub soft_edge_ratio: f64,
    pub preserved_source_alpha: bool,
}

#[derive(Debug, Clone)]
pub struct StoredMattingCutout {
    pub id: String,
    pub label: String,
    pub source_path: Option<String>,
    pub width: u32,
    pub height: u32,
    pub icc_profile: Option<Vec<u8>>,
    pub subject_bbox: Option<SubjectBoundingBox>,
    pub cutout_png_bytes: Vec<u8>,
    pub cutout_asset_id: Option<String>,
}

#[derive(Clone, Default)]
pub struct MattingResultStore {
    inner: Arc<Mutex<VecDeque<StoredMattingCutout>>>,
}

impl MattingResultStore {
    pub fn insert(&self, entry: StoredMattingCutout) -> Result<String, AppError> {
        let id = entry.id.clone();
        let mut guard = self.inner.lock().map_err(|_| {
            AppError::new("INTERNAL_LOCK_ERROR", "Matting result store lock poisoned.")
        })?;
        guard.push_back(entry);

        let mut total_bytes: usize = guard.iter().map(|e| e.cutout_png_bytes.len()).sum();
        while guard.len() > MAX_MATTING_STORE_ITEMS
            || (total_bytes > MAX_MATTING_STORE_TOTAL_BYTES && guard.len() > 1)
        {
            if let Some(evicted) = guard.pop_front() {
                total_bytes = total_bytes.saturating_sub(evicted.cutout_png_bytes.len());
            } else {
                break;
            }
        }
        Ok(id)
    }

    pub fn get(&self, result_id: &str) -> Result<StoredMattingCutout, AppError> {
        let guard = self.inner.lock().map_err(|_| {
            AppError::new("INTERNAL_LOCK_ERROR", "Matting result store lock poisoned.")
        })?;
        guard
            .iter()
            .find(|e| e.id == result_id)
            .cloned()
            .ok_or_else(|| {
                AppError::new(
                    "MATTING_RESULT_EXPIRED",
                    "In-memory cutout result expired or was cleared. Please re-run background removal.",
                )
            })
    }

    pub fn clear(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.clear();
        }
    }
}

pub fn next_matting_result_id() -> String {
    format!(
        "matting-{}",
        MATTING_RESULT_SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

/// Decoded source image ready for matting.
pub struct LoadedMattingSource {
    pub rgba: RgbaImage,
    pub raw_width: u32,
    pub raw_height: u32,
    pub exif_orientation: u16,
    pub source_has_alpha: bool,
    pub icc_profile: Option<Vec<u8>>,
    pub file_name: String,
    pub source_path: Option<String>,
    pub warnings: Vec<String>,
}

pub fn load_matting_source(
    request: &RemoveBackgroundRequest,
    asset_store: &ImageAssetStore,
) -> Result<LoadedMattingSource, AppError> {
    if let Some(raw_path) = request
        .path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let validated = validate_user_path(raw_path, "Input image")?;
        let decoded = decode_image_to_display(&validated)?;
        let mut warnings = Vec::new();
        if decoded.is_animated || decoded.page_count > 1 {
            warnings.push(format!(
                "Multi-frame image detected ({} frames); only the first frame was processed.",
                decoded.page_count.max(2)
            ));
        }
        let rgba = decoded.image.to_rgba8();
        let file_name = validated
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "image.png".into());
        return Ok(LoadedMattingSource {
            rgba,
            raw_width: decoded.raw_width,
            raw_height: decoded.raw_height,
            exif_orientation: decoded.exif_orientation,
            source_has_alpha: decoded.has_alpha,
            icc_profile: decoded.icc_profile,
            file_name,
            source_path: Some(validated.to_string_lossy().into_owned()),
            warnings,
        });
    }

    if let Some(asset_id) = request
        .asset_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let (rgba, store_label) = asset_store.get_rgba(asset_id)?;
        let (w, h) = rgba.dimensions();
        let source_has_alpha = rgba.pixels().any(|p| p.0[3] < 255);
        let file_name = request
            .label
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&store_label)
            .to_string();
        return Ok(LoadedMattingSource {
            rgba,
            raw_width: w,
            raw_height: h,
            exif_orientation: 1,
            source_has_alpha,
            icc_profile: None,
            file_name,
            source_path: None,
            warnings: Vec::new(),
        });
    }

    Err(AppError::invalid_param(
        "Provide either a local image path or an in-memory image asset ID.",
    ))
}

/// Builds the 512×512 RGB input buffer for `BiRefNet_lite`.
///
/// If the source image already contains transparent/semi-transparent pixels, composites it over
/// neutral mid-gray (`[128, 128, 128]`) strictly for model RGB input so hidden RGB values under
/// transparent pixels never create artificial dark or bright halos.
pub fn prepare_rgb512_for_model(rgba: &RgbaImage, source_has_alpha: bool) -> Vec<u8> {
    let rgb: RgbImage = if source_has_alpha {
        composite_rgba_over_rgb(rgba, [128, 128, 128])
    } else {
        let (w, h) = rgba.dimensions();
        let mut out = Vec::with_capacity((w as usize) * (h as usize) * 3);
        for p in rgba.pixels() {
            out.push(p.0[0]);
            out.push(p.0[1]);
            out.push(p.0[2]);
        }
        RgbImage::from_raw(w, h, out).expect("valid RGB dimensions")
    };

    let resized = image::imageops::resize(
        &rgb,
        MATTING_MODEL_INPUT_SIZE,
        MATTING_MODEL_INPUT_SIZE,
        FilterType::Triangle,
    );
    resized.into_raw()
}

/// Applies a 512×512 grayscale alpha matte to the original upright RGBA image.
///
/// Multiplicative alpha composition (`final_alpha = round(src_alpha * mask_alpha / 255)`) ensures:
/// - Opaque inputs (`src_a == 255`) get the exact predicted matte (`final_alpha == mask_a`).
/// - Semi-transparent inputs keep their existing transparent cutouts and soft semi-transparent
///   edges (`final_alpha <= src_a` everywhere, and `src_a == 0 => final_alpha == 0`).
/// - Fully transparent output pixels (`final_alpha == 0`) have RGB zeroed for clean compression
///   and zero fringe bleed.
pub fn apply_predicted_matte_to_rgba(
    source: &RgbaImage,
    mask512: &[u8],
) -> Result<(RgbaImage, MattingAlphaStats), AppError> {
    if mask512.len() != MATTING_MASK512_BYTES {
        return Err(AppError::invalid_param(format!(
            "Invalid predicted matte length: expected {MATTING_MASK512_BYTES}, got {}.",
            mask512.len()
        )));
    }
    let (w, h) = source.dimensions();
    if w == 0 || h == 0 {
        return Err(AppError::decode_failed("Image has zero width or height."));
    }

    let mask_gray = GrayImage::from_raw(
        MATTING_MODEL_INPUT_SIZE,
        MATTING_MODEL_INPUT_SIZE,
        mask512.to_vec(),
    )
    .ok_or_else(|| AppError::invalid_param("Failed to construct 512x512 alpha matte."))?;
    let full_mask = if w == MATTING_MODEL_INPUT_SIZE && h == MATTING_MODEL_INPUT_SIZE {
        mask_gray
    } else {
        image::imageops::resize(&mask_gray, w, h, FilterType::Triangle)
    };

    let src_raw = source.as_raw();
    let mask_raw = full_mask.as_raw();
    let total_pixels = (w as usize) * (h as usize);
    let mut out_raw = vec![0u8; total_pixels * 4];

    let mut min_x = w;
    let mut min_y = h;
    let mut max_x = 0u32;
    let mut max_y = 0u32;
    let mut any_subject = false;
    let mut fg_count = 0u64;
    let mut soft_count = 0u64;
    let mut preserved_source_alpha = false;

    for y in 0..h {
        let row_base = (y as usize) * (w as usize);
        for x in 0..w {
            let idx = row_base + (x as usize);
            let s4 = idx * 4;
            let src_a = src_raw[s4 + 3];
            let mask_a = mask_raw[idx];
            if src_a < 255 {
                preserved_source_alpha = true;
            }
            let final_a = if src_a == 255 {
                mask_a
            } else if src_a == 0 || mask_a == 0 {
                0
            } else {
                ((u16::from(src_a) * u16::from(mask_a) + 127) / 255) as u8
            };

            if final_a == 0 {
                // Keep zeroed [0, 0, 0, 0]
                continue;
            }
            out_raw[s4] = src_raw[s4];
            out_raw[s4 + 1] = src_raw[s4 + 1];
            out_raw[s4 + 2] = src_raw[s4 + 2];
            out_raw[s4 + 3] = final_a;

            if final_a >= TIGHT_CROP_ALPHA_THRESHOLD {
                any_subject = true;
                if x < min_x {
                    min_x = x;
                }
                if y < min_y {
                    min_y = y;
                }
                if x > max_x {
                    max_x = x;
                }
                if y > max_y {
                    max_y = y;
                }
            }
            if final_a >= 128 {
                fg_count += 1;
            }
            if final_a > 5 && final_a < 250 {
                soft_count += 1;
            }
        }
    }

    let subject_bbox = if any_subject {
        Some(SubjectBoundingBox {
            x: min_x,
            y: min_y,
            width: max_x - min_x + 1,
            height: max_y - min_y + 1,
        })
    } else {
        None
    };

    let denom = total_pixels.max(1) as f64;
    let out_img = RgbaImage::from_raw(w, h, out_raw)
        .ok_or_else(|| AppError::decode_failed("Failed constructing composited RGBA cutout."))?;

    Ok((
        out_img,
        MattingAlphaStats {
            subject_bbox,
            foreground_ratio: fg_count as f64 / denom,
            soft_edge_ratio: soft_count as f64 / denom,
            preserved_source_alpha,
        },
    ))
}

pub fn compute_padded_crop_rect(
    image_width: u32,
    image_height: u32,
    bbox: SubjectBoundingBox,
    padding_px: u32,
) -> SubjectBoundingBox {
    let pad = padding_px.min(MAX_CROP_PADDING_PX);
    let x0 = bbox.x.saturating_sub(pad);
    let y0 = bbox.y.saturating_sub(pad);
    let x1 = bbox
        .x
        .saturating_add(bbox.width)
        .saturating_add(pad)
        .min(image_width);
    let y1 = bbox
        .y
        .saturating_add(bbox.height)
        .saturating_add(pad)
        .min(image_height);
    SubjectBoundingBox {
        x: x0,
        y: y0,
        width: x1.saturating_sub(x0).max(1),
        height: y1.saturating_sub(y0).max(1),
    }
}

pub fn crop_rgba_to_subject(
    rgba: &RgbaImage,
    bbox: Option<SubjectBoundingBox>,
    padding_px: u32,
) -> (RgbaImage, bool) {
    let Some(b) = bbox else {
        return (rgba.clone(), false);
    };
    let (w, h) = rgba.dimensions();
    let rect = compute_padded_crop_rect(w, h, b, padding_px);
    if rect.x == 0 && rect.y == 0 && rect.width == w && rect.height == h {
        return (rgba.clone(), false);
    }
    let cropped =
        image::imageops::crop_imm(rgba, rect.x, rect.y, rect.width, rect.height).to_image();
    (cropped, true)
}

pub fn parse_hex_color_rgb(raw: &str) -> Result<[u8; 3], AppError> {
    let trimmed = raw.trim().trim_start_matches('#');
    if trimmed.len() != 6 || !trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::invalid_param(
            "Background color must be a 6-digit hex code such as #FFFFFF.",
        ));
    }
    let r = u8::from_str_radix(&trimmed[0..2], 16)
        .map_err(|_| AppError::invalid_param("Invalid red hex channel."))?;
    let g = u8::from_str_radix(&trimmed[2..4], 16)
        .map_err(|_| AppError::invalid_param("Invalid green hex channel."))?;
    let b = u8::from_str_radix(&trimmed[4..6], 16)
        .map_err(|_| AppError::invalid_param("Invalid blue hex channel."))?;
    Ok([r, g, b])
}

pub fn encode_rgba_png_bytes(
    rgba: &RgbaImage,
    fast_cache: bool,
    icc: Option<&[u8]>,
) -> Result<Vec<u8>, AppError> {
    let (w, h) = rgba.dimensions();
    let mut out = Vec::new();
    let (comp, filter) = if fast_cache {
        (CompressionType::Fast, PngFilterType::Sub)
    } else {
        (CompressionType::Default, PngFilterType::Adaptive)
    };
    let enc = PngEncoder::new_with_quality(&mut out, comp, filter);
    enc.write_image(rgba.as_raw(), w, h, ColorType::Rgba8.into())
        .map_err(|e| AppError::decode_failed(format!("PNG encoding failed: {e}")))?;
    if let Some(profile) = icc {
        Ok(inject_png_iccp_chunk(&out, profile))
    } else {
        Ok(out)
    }
}

pub fn encode_rgb_png_bytes(rgb: &RgbImage, icc: Option<&[u8]>) -> Result<Vec<u8>, AppError> {
    let (w, h) = rgb.dimensions();
    let mut out = Vec::new();
    let enc =
        PngEncoder::new_with_quality(&mut out, CompressionType::Default, PngFilterType::Adaptive);
    enc.write_image(rgb.as_raw(), w, h, ColorType::Rgb8.into())
        .map_err(|e| AppError::decode_failed(format!("PNG encoding failed: {e}")))?;
    if let Some(profile) = icc {
        Ok(inject_png_iccp_chunk(&out, profile))
    } else {
        Ok(out)
    }
}

pub fn render_matting_export_bytes(
    cutout: &StoredMattingCutout,
    background_mode: MattingBackgroundMode,
    background_hex: Option<&str>,
    format: MattingExportFormat,
    quality: u8,
    crop_to_subject: bool,
    crop_padding_px: u32,
) -> Result<(Vec<u8>, u32, u32, bool, bool), AppError> {
    if background_mode == MattingBackgroundMode::Transparent && format == MattingExportFormat::Jpeg
    {
        return Err(AppError::invalid_param(
            "JPEG does not support a transparent alpha channel. Choose PNG/WebP or switch to Solid Background.",
        ));
    }

    let decoded =
        image::load_from_memory_with_format(&cutout.cutout_png_bytes, image::ImageFormat::Png)
            .map_err(|e| {
                AppError::decode_failed(format!("Failed decoding cached cutout PNG: {e}"))
            })?
            .to_rgba8();

    let (working_rgba, cropped) = if crop_to_subject {
        crop_rgba_to_subject(&decoded, cutout.subject_bbox, crop_padding_px)
    } else {
        (decoded, false)
    };
    let (w, h) = working_rgba.dimensions();
    let icc = cutout.icc_profile.as_deref();
    let clamped_quality = quality.clamp(1, 100);

    match background_mode {
        MattingBackgroundMode::Transparent => {
            let bytes = match format {
                MattingExportFormat::Png => encode_rgba_png_bytes(&working_rgba, false, icc)?,
                MattingExportFormat::Webp => encode_webp_bytes(
                    &DynamicImage::ImageRgba8(working_rgba),
                    clamped_quality,
                    clamped_quality >= 100,
                    icc,
                )?,
                MattingExportFormat::Jpeg => unreachable!("validated above"),
            };
            Ok((bytes, w, h, true, cropped))
        }
        MattingBackgroundMode::SolidColor => {
            let bg_rgb = parse_hex_color_rgb(background_hex.unwrap_or("#FFFFFF"))?;
            let flat_rgb = composite_rgba_over_rgb(&working_rgba, bg_rgb);
            let bytes = match format {
                MattingExportFormat::Png => encode_rgb_png_bytes(&flat_rgb, icc)?,
                MattingExportFormat::Jpeg => {
                    encode_jpeg_bytes(&flat_rgb, clamped_quality, true, icc)?
                }
                MattingExportFormat::Webp => encode_webp_bytes(
                    &DynamicImage::ImageRgb8(flat_rgb),
                    clamped_quality,
                    clamped_quality >= 100,
                    icc,
                )?,
            };
            Ok((bytes, w, h, false, cropped))
        }
    }
}

pub fn export_matting_result_impl(
    store: &MattingResultStore,
    request: &MattingExportRequest,
    cancel_flag: &AtomicBool,
) -> Result<MattingExportResult, AppError> {
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }
    let cutout = store.get(request.result_id.trim())?;
    let target_path: PathBuf = validate_user_path(&request.output_path, "Output image path")?;

    // Guard against overwriting either the stored or request-supplied source image.
    let mut primary_source: Option<&Path> = None;
    for candidate_src in [
        request.source_path.as_deref(),
        cutout.source_path.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        let trimmed = candidate_src.trim();
        if !trimmed.is_empty() {
            let p = Path::new(trimmed);
            if primary_source.is_none() {
                primary_source = Some(p);
            }
            if paths_refer_to_same_location(p, &target_path) {
                return Err(AppError::same_input_output());
            }
        }
    }

    let (bytes, width, height, has_alpha, cropped) = render_matting_export_bytes(
        &cutout,
        request.background_mode,
        request.background_hex.as_deref(),
        request.format,
        request.quality.unwrap_or(92),
        request.crop_to_subject,
        request.crop_padding_px.unwrap_or(0),
    )?;

    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    write_output_bytes_cancellable(
        &request.output_path,
        primary_source,
        &bytes,
        request.overwrite,
        Some(cancel_flag),
    )?;

    Ok(MattingExportResult {
        output_path: target_path.to_string_lossy().into_owned(),
        width,
        height,
        byte_length: bytes.len() as u64,
        has_alpha,
        cropped,
        format: request.format,
    })
}

pub fn copy_matting_result_to_clipboard_impl(
    store: &MattingResultStore,
    request: &MattingCopyClipboardRequest,
) -> Result<MattingCopyClipboardResult, AppError> {
    let cutout = store.get(request.result_id.trim())?;
    let (png_bytes, width, height, has_alpha, cropped) = render_matting_export_bytes(
        &cutout,
        request.background_mode,
        request.background_hex.as_deref(),
        MattingExportFormat::Png,
        100,
        request.crop_to_subject,
        request.crop_padding_px.unwrap_or(0),
    )?;
    copy_png_to_system_clipboard(&png_bytes)?;
    Ok(MattingCopyClipboardResult {
        width,
        height,
        has_alpha,
        cropped,
    })
}

pub fn build_matting_preview_urls(
    original_rgba: &RgbaImage,
    original_has_alpha: bool,
    cutout_rgba: &RgbaImage,
) -> Result<(String, String), AppError> {
    let orig_url = encode_preview_data_url(
        &DynamicImage::ImageRgba8(original_rgba.clone()),
        PREVIEW_MAX_EDGE,
        original_has_alpha,
    )
    .ok_or_else(|| AppError::decode_failed("Failed encoding original image preview."))?;

    let cutout_url = encode_preview_data_url(
        &DynamicImage::ImageRgba8(cutout_rgba.clone()),
        PREVIEW_MAX_EDGE,
        true,
    )
    .ok_or_else(|| AppError::decode_failed("Failed encoding cutout image preview."))?;

    Ok((orig_url, cutout_url))
}

/// ONNX Runtime CPU engine wrapping `BiRefNet_lite 512 FP16` inside `--matting-worker`.
///
/// Self-referential lifetime wrapper (same safe pattern as `RapidOcrEngine` & `SenseVoiceAsrEngine`):
/// `runtime` lives in a `Box<OrtRuntime>` dropped strictly AFTER `session`.
pub struct BiRefNetMattingEngine {
    session: OrtSession<'static>,
    _runtime: Box<OrtRuntime>,
}

impl BiRefNetMattingEngine {
    pub fn load(
        assets: &ResolvedMattingAssets,
        resource_dir: Option<&Path>,
    ) -> Result<Self, AppError> {
        let (dll_path, crt_dir) = resolve_ort_dll_path(resource_dir)?;
        let runtime = Box::new(OrtRuntime::load(&dll_path, crt_dir.as_deref())?);
        let threads = std::thread::available_parallelism()
            .map(|n| (n.get() / 2).clamp(2, 6) as i32)
            .unwrap_or(4);

        // SAFETY: `runtime` is heap-allocated in a Box moved into `Self` and declared AFTER
        // `session`, so Rust drop order guarantees `session` drops strictly before `_runtime`.
        let rt_ref: &'static OrtRuntime = unsafe { &*(&*runtime as *const OrtRuntime) };
        let session = rt_ref.create_session_with_options(
            &assets.model_onnx_path,
            threads,
            true, // disable CPU memory arena (cuts peak commit from ~5.3 GiB -> ~2.4 GiB and idle WS -> ~284 MiB)
            true, // disable mem pattern (avoids holding 3+ GiB arena across runs)
        )?;

        Ok(Self {
            session,
            _runtime: runtime,
        })
    }

    pub fn runtime_version(&self) -> &str {
        self._runtime.version_string()
    }

    /// Runs `BiRefNet_lite 512 FP16` on a 512×512 RGB buffer and returns a 512×512 `u8` alpha matte.
    pub fn predict_mask_512(&self, rgb512: &[u8]) -> Result<Vec<u8>, AppError> {
        if rgb512.len() != MATTING_RGB512_BYTES {
            return Err(AppError::invalid_param(format!(
                "Expected {MATTING_RGB512_BYTES} RGB bytes for 512x512 matting input, got {}.",
                rgb512.len()
            )));
        }

        let side = MATTING_MODEL_INPUT_SIZE as usize;
        let plane = side * side;
        let mut chw = vec![0.0f32; plane * 3];
        let (c0, rest) = chw.split_at_mut(plane);
        let (c1, c2) = rest.split_at_mut(plane);

        let inv255 = 1.0f32 / 255.0f32;
        for i in 0..plane {
            let p = i * 3;
            c0[i] = (f32::from(rgb512[p]) * inv255 - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
            c1[i] = (f32::from(rgb512[p + 1]) * inv255 - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
            c2[i] = (f32::from(rgb512[p + 2]) * inv255 - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
        }

        let shape = [
            1i64,
            3,
            i64::from(MATTING_MODEL_INPUT_SIZE),
            i64::from(MATTING_MODEL_INPUT_SIZE),
        ];
        let (_out_shape, logits) = self.session.run_f32(&shape, &chw).map_err(|e| {
            AppError::new(
                "MATTING_INFERENCE_FAILED",
                format!("Background removal ONNX inference failed: {}", e.message),
            )
        })?;

        if logits.len() < plane {
            return Err(AppError::new(
                "MATTING_INFERENCE_FAILED",
                format!(
                    "Unexpected matting output size: expected at least {plane} elements, got {}.",
                    logits.len()
                ),
            ));
        }

        let mut mask = vec![0u8; plane];
        for i in 0..plane {
            let v = logits[i];
            let prob = if v.is_finite() {
                1.0f32 / (1.0f32 + (-v.clamp(-40.0, 40.0)).exp())
            } else if v.is_sign_positive() {
                1.0
            } else {
                0.0
            };
            mask[i] = (prob * 255.0 + 0.5).clamp(0.0, 255.0) as u8;
        }
        Ok(mask)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn matte_composition_preserves_existing_transparency_and_soft_edges() {
        // 16x16 source image:
        // - left column (x < 4): fully transparent (alpha = 0) with bright red garbage RGB
        // - middle band (4 <= x < 10): semi-transparent glass (alpha = 128)
        // - right band (x >= 10): fully opaque (alpha = 255)
        let mut src = RgbaImage::new(16, 16);
        for y in 0..16 {
            for x in 0..16 {
                let px = if x < 4 {
                    Rgba([255, 0, 0, 0])
                } else if x < 10 {
                    Rgba([40, 180, 240, 128])
                } else {
                    Rgba([200, 100, 50, 255])
                };
                src.put_pixel(x, y, px);
            }
        }

        // Model predicts full foreground on top half (y < 256 -> mask 255), soft edge band at y=256..300,
        // and background 0 on bottom half.
        let mut mask512 = vec![0u8; MATTING_MASK512_BYTES];
        for y in 0..512usize {
            let val = if y < 256 {
                255u8
            } else if y < 320 {
                128u8
            } else {
                0u8
            };
            for x in 0..512usize {
                mask512[y * 512 + x] = val;
            }
        }

        let (out, stats) = apply_predicted_matte_to_rgba(&src, &mask512).expect("compose");
        assert!(stats.preserved_source_alpha);

        // 1. Original fully transparent pixels stay [0, 0, 0, 0] even where model predicted 255
        let p_trans = out.get_pixel(1, 2).0;
        assert_eq!(p_trans, [0, 0, 0, 0]);

        // 2. Semi-transparent glass where model predicts 255 preserves alpha ~128 (never boosted to 255!)
        let p_glass = out.get_pixel(6, 2).0;
        assert_eq!(p_glass[3], 128);
        assert_eq!(&p_glass[0..3], &[40, 180, 240]);

        // 3. Opaque foreground where model predicts 255 stays alpha 255
        let p_fg = out.get_pixel(12, 2).0;
        assert_eq!(p_fg, [200, 100, 50, 255]);

        // 4. Background where model predicts 0 becomes [0, 0, 0, 0]
        let p_bg = out.get_pixel(12, 14).0;
        assert_eq!(p_bg, [0, 0, 0, 0]);

        // 5. Tight bbox excludes transparent left strip (x < 4) and transparent bottom rows
        let bbox = stats.subject_bbox.expect("bbox");
        assert_eq!(bbox.x, 4);
        assert_eq!(bbox.y, 0);
        assert_eq!(bbox.width, 12);
        assert!(bbox.height < 16);
    }

    #[test]
    fn tight_crop_and_solid_background_export_protect_source_and_existing_targets() {
        let dir = tempdir().expect("tempdir");
        let src_path = dir.path().join("source.png");

        // Build a 40x30 RGBA cutout with a centered 12x10 red square (x=14..26, y=10..20)
        let mut cutout_rgba = RgbaImage::from_pixel(40, 30, Rgba([0, 0, 0, 0]));
        for y in 10..20 {
            for x in 14..26 {
                cutout_rgba.put_pixel(x, y, Rgba([220, 40, 60, 255]));
            }
        }
        let png_bytes = encode_rgba_png_bytes(&cutout_rgba, true, None).expect("encode");
        fs::write(&src_path, &png_bytes).expect("write src");

        let store = MattingResultStore::default();
        let rid = store
            .insert(StoredMattingCutout {
                id: "matting-test-1".into(),
                label: "source.png".into(),
                source_path: Some(src_path.to_string_lossy().into_owned()),
                width: 40,
                height: 30,
                icc_profile: None,
                subject_bbox: Some(SubjectBoundingBox {
                    x: 14,
                    y: 10,
                    width: 12,
                    height: 10,
                }),
                cutout_png_bytes: png_bytes,
                cutout_asset_id: None,
            })
            .expect("insert");

        let cancel = AtomicBool::new(false);

        // 1. Source overwrite rejected
        let same_err = export_matting_result_impl(
            &store,
            &MattingExportRequest {
                result_id: rid.clone(),
                output_path: src_path.to_string_lossy().into_owned(),
                source_path: Some(src_path.to_string_lossy().into_owned()),
                overwrite: true,
                background_mode: MattingBackgroundMode::Transparent,
                background_hex: None,
                format: MattingExportFormat::Png,
                quality: Some(92),
                crop_to_subject: false,
                crop_padding_px: Some(0),
            },
            &cancel,
        )
        .unwrap_err();
        assert_eq!(same_err.code, "SAME_INPUT_AND_OUTPUT");

        // 2. Transparent + JPEG rejected
        let jpeg_err = export_matting_result_impl(
            &store,
            &MattingExportRequest {
                result_id: rid.clone(),
                output_path: dir.path().join("bad.jpg").to_string_lossy().into_owned(),
                source_path: Some(src_path.to_string_lossy().into_owned()),
                overwrite: false,
                background_mode: MattingBackgroundMode::Transparent,
                background_hex: None,
                format: MattingExportFormat::Jpeg,
                quality: Some(92),
                crop_to_subject: false,
                crop_padding_px: Some(0),
            },
            &cancel,
        )
        .unwrap_err();
        assert_eq!(jpeg_err.code, "INVALID_PARAMETER");

        // 3. Default export preserves original 40x30 and real Alpha channel
        let trans_out = dir.path().join("cutout.png");
        let res_trans = export_matting_result_impl(
            &store,
            &MattingExportRequest {
                result_id: rid.clone(),
                output_path: trans_out.to_string_lossy().into_owned(),
                source_path: Some(src_path.to_string_lossy().into_owned()),
                overwrite: false,
                background_mode: MattingBackgroundMode::Transparent,
                background_hex: None,
                format: MattingExportFormat::Png,
                quality: None,
                crop_to_subject: false,
                crop_padding_px: Some(0),
            },
            &cancel,
        )
        .expect("transparent export");
        assert_eq!((res_trans.width, res_trans.height), (40, 30));
        assert!(res_trans.has_alpha);
        assert!(!res_trans.cropped);
        let read_trans = image::open(&trans_out).expect("reopen").to_rgba8();
        assert_eq!(read_trans.get_pixel(0, 0).0[3], 0);
        assert_eq!(read_trans.get_pixel(18, 14).0, [220, 40, 60, 255]);

        // 4. Existing target rejected when overwrite == false
        let exists_err = export_matting_result_impl(
            &store,
            &MattingExportRequest {
                result_id: rid.clone(),
                output_path: trans_out.to_string_lossy().into_owned(),
                source_path: Some(src_path.to_string_lossy().into_owned()),
                overwrite: false,
                background_mode: MattingBackgroundMode::Transparent,
                background_hex: None,
                format: MattingExportFormat::Png,
                quality: None,
                crop_to_subject: false,
                crop_padding_px: Some(0),
            },
            &cancel,
        )
        .unwrap_err();
        assert_eq!(exists_err.code, "TARGET_ALREADY_EXISTS");

        // 5. Tight crop with 2px padding + Solid Blue background PNG
        let solid_out = dir.path().join("solid_cropped.png");
        let res_solid = export_matting_result_impl(
            &store,
            &MattingExportRequest {
                result_id: rid,
                output_path: solid_out.to_string_lossy().into_owned(),
                source_path: Some(src_path.to_string_lossy().into_owned()),
                overwrite: false,
                background_mode: MattingBackgroundMode::SolidColor,
                background_hex: Some("#2563EB".into()),
                format: MattingExportFormat::Png,
                quality: None,
                crop_to_subject: true,
                crop_padding_px: Some(2),
            },
            &cancel,
        )
        .expect("solid cropped export");
        assert_eq!((res_solid.width, res_solid.height), (16, 14));
        assert!(!res_solid.has_alpha);
        assert!(res_solid.cropped);
        let read_solid = image::open(&solid_out).expect("reopen solid").to_rgb8();
        assert_eq!(read_solid.get_pixel(0, 0).0, [0x25, 0x63, 0xEB]);
        assert_eq!(read_solid.get_pixel(4, 4).0, [220, 40, 60]);
    }

    #[test]
    fn exif_rotated_jpeg_decodes_upright_before_matting() {
        let dir = tempdir().expect("tempdir");
        // Create a 32x16 raw JPEG with EXIF Orientation = 6 (90° CW -> upright display is 16x32)
        let raw_img = RgbImage::from_pixel(32, 16, image::Rgb([80, 140, 220]));
        let mut jpeg_bytes = encode_jpeg_bytes(&raw_img, 90, true, None).expect("jpeg");
        // Minimal valid EXIF APP1 segment with Orientation = 6 (little-endian TIFF)
        let exif_payload: [u8; 32] = [
            b'E', b'x', b'i', b'f', 0, 0, // Exif\0\0
            b'I', b'I', 0x2A, 0x00, // Little-endian TIFF header
            0x08, 0x00, 0x00, 0x00, // IFD0 offset = 8
            0x01, 0x00, // 1 entry
            0x12, 0x01, // Tag 0x0112 (Orientation)
            0x03, 0x00, // Type SHORT
            0x01, 0x00, 0x00, 0x00, // Count 1
            0x06, 0x00, 0x00, 0x00, // Value = 6 (Rotate 90 CW)
            0x00, 0x00, 0x00, 0x00, // Next IFD = 0
        ];
        let app1_len = (exif_payload.len() + 2) as u16;
        let mut with_exif = Vec::with_capacity(jpeg_bytes.len() + exif_payload.len() + 4);
        with_exif.extend_from_slice(&jpeg_bytes[0..2]); // SOI
        with_exif.push(0xFF);
        with_exif.push(0xE1);
        with_exif.extend_from_slice(&app1_len.to_be_bytes());
        with_exif.extend_from_slice(&exif_payload);
        with_exif.extend_from_slice(&jpeg_bytes[2..]);
        jpeg_bytes = with_exif;

        let path = dir.path().join("rotated_exif6.jpg");
        fs::write(&path, &jpeg_bytes).expect("write rotated jpeg");

        let asset_store = ImageAssetStore::default();
        let loaded = load_matting_source(
            &RemoveBackgroundRequest {
                path: Some(path.to_string_lossy().into_owned()),
                asset_id: None,
                label: None,
            },
            &asset_store,
        )
        .expect("load rotated");

        assert_eq!(loaded.exif_orientation, 6);
        assert_eq!((loaded.raw_width, loaded.raw_height), (32, 16));
        assert_eq!(loaded.rgba.dimensions(), (16, 32));
    }
}
