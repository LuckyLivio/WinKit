//! P14 PDF Compression (`lossless` structural optimization, `balanced`, and `smallest`).
//!
//! Quality & safety invariants:
//! - NEVER rasterizes text or vector pages into page images. All text streams, fonts, vector
//!   drawings, links, outlines, and page orientations remain untouched.
//! - `lossless` runs bundled QPDF structural optimization only (`objectStreams: "generate"`,
//!   `compressStreams: "y"`, `recompressFlate`, `compressionLevel: "9"`,
//!   `removeUnreferencedResources: "yes"`). Zero image pixels are altered.
//! - `balanced` and `smallest` selectively optimize opaque 8-bit `DeviceRGB` and `DeviceGray`
//!   embedded image XObjects (skipping `/ImageMask`, `/Mask`, `/SMask` targets/owners, indexed
//!   palettes, and special color spaces so transparency and spot colors are never corrupted),
//!   replacing an image stream ONLY when the recompressed stream is strictly smaller (<= 95%),
//!   then running QPDF structural optimization.
//! - Global no-bloat guarantee: if the optimized output is >= the original byte length, WinKit
//!   preserves a clean non-overwriting copy of the original file and reports `keptOriginal = true`.

use crate::error::AppError;
use crate::fs_guard::validate_existing_input_file;
use crate::pdf_core::{AtomicPdfOutput, PdfSessionManager, PdfTaskProgressPayload};
use crate::pdf_crypto::inspect_pdf_security_impl;
use crate::pdf_pdfium::{inspect_with_pdfium, MAX_PDF_FILE_BYTES};
use crate::pdf_qpdf::{run_qpdf_job, DEFAULT_QPDF_TIMEOUT, QPDF_EXIT_ERROR};
use image::imageops::FilterType;
use image::{DynamicImage, GrayImage, RgbImage};
use jpeg_encoder::{ColorType as JpegColorType, Encoder as JpegEncoder};
use lopdf::{Document, Object, ObjectId, Stream};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressPdfRequest {
    pub input_path: String,
    pub output_path: String,
    pub overwrite: bool,
    /// `"lossless"` | `"balanced"` | `"smallest"`
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressPdfResult {
    pub output_path: String,
    pub mode: String,
    pub page_count: usize,
    pub original_bytes: u64,
    pub output_bytes: u64,
    pub saved_bytes: u64,
    pub saved_percent: f64,
    pub kept_original: bool,
    pub images_inspected: usize,
    pub images_optimized: usize,
    pub images_downsampled: usize,
    pub has_text_layer: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CompressMode {
    Lossless,
    Balanced,
    Smallest,
}

impl CompressMode {
    fn parse(raw: &str) -> Result<Self, AppError> {
        match raw {
            "lossless" => Ok(Self::Lossless),
            "balanced" => Ok(Self::Balanced),
            "smallest" => Ok(Self::Smallest),
            _ => Err(AppError::invalid_param(
                "Invalid compression mode (expected 'lossless', 'balanced', or 'smallest').",
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Lossless => "lossless",
            Self::Balanced => "balanced",
            Self::Smallest => "smallest",
        }
    }

    /// Maximum pixel dimension on the longer side for embedded opaque images.
    /// Full-page A4 height (11.7 in): 1600 px ≈ 137–150 DPI, 1150 px ≈ 100–110 DPI.
    fn image_params(self) -> Option<(u32, u8)> {
        match self {
            Self::Lossless => None,
            Self::Balanced => Some((1600, 78)),
            Self::Smallest => Some((1150, 62)),
        }
    }
}

struct TempFileGuard(PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if self.0.exists() {
            let _ = fs::remove_file(&self.0);
        }
    }
}

#[derive(Default)]
struct ImageOptStats {
    inspected: usize,
    optimized: usize,
    downsampled: usize,
}

fn is_simple_colorspace(obj: &Object, doc: &Document) -> Option<&'static str> {
    let resolved = match obj {
        Object::Reference(id) => doc.get_object(*id).ok()?,
        other => other,
    };
    match resolved {
        Object::Name(n) if n == b"DeviceRGB" => Some("rgb"),
        Object::Name(n) if n == b"DeviceGray" => Some("gray"),
        Object::Array(arr) if arr.len() == 1 => {
            if let Ok(n) = arr[0].as_name() {
                if n == b"DeviceRGB" {
                    return Some("rgb");
                }
                if n == b"DeviceGray" {
                    return Some("gray");
                }
            }
            None
        }
        _ => None,
    }
}

fn extract_stream_filters(stream: &Stream) -> Vec<Vec<u8>> {
    match stream.dict.get(b"Filter") {
        Ok(Object::Name(name)) => vec![name.clone()],
        Ok(Object::Array(arr)) => arr
            .iter()
            .filter_map(|item| item.as_name().ok().map(|n| n.to_vec()))
            .collect(),
        _ => Vec::new(),
    }
}

fn decode_opaque_image_stream(
    stream: &Stream,
    width: u32,
    height: u32,
    cs: &str,
) -> Option<(DynamicImage, bool)> {
    let filters = extract_stream_filters(stream);
    if filters.is_empty() {
        let expected = (width as usize)
            .checked_mul(height as usize)?
            .checked_mul(if cs == "rgb" { 3 } else { 1 })?;
        if stream.content.len() < expected {
            return None;
        }
        let raw = stream.content[..expected].to_vec();
        let dyn_img = if cs == "rgb" {
            DynamicImage::ImageRgb8(RgbImage::from_raw(width, height, raw)?)
        } else {
            DynamicImage::ImageLuma8(GrayImage::from_raw(width, height, raw)?)
        };
        return Some((dyn_img, false));
    }

    if filters.len() == 1 && filters[0] == b"DCTDecode" {
        let decoded =
            image::load_from_memory_with_format(&stream.content, image::ImageFormat::Jpeg).ok()?;
        let normalized = if cs == "gray" {
            DynamicImage::ImageLuma8(decoded.to_luma8())
        } else {
            DynamicImage::ImageRgb8(decoded.to_rgb8())
        };
        return Some((normalized, true));
    }

    if filters.len() == 1 && filters[0] == b"FlateDecode" {
        let raw = stream.decompressed_content().ok()?;
        let expected = (width as usize)
            .checked_mul(height as usize)?
            .checked_mul(if cs == "rgb" { 3 } else { 1 })?;
        if raw.len() < expected {
            return None;
        }
        let trimmed = raw[..expected].to_vec();
        let dyn_img = if cs == "rgb" {
            DynamicImage::ImageRgb8(RgbImage::from_raw(width, height, trimmed)?)
        } else {
            DynamicImage::ImageLuma8(GrayImage::from_raw(width, height, trimmed)?)
        };
        return Some((dyn_img, false));
    }

    // Skip CCITT, JBIG2, JPXDecode, chained filters, etc. safely without modifying them.
    None
}

fn encode_jpeg_stream(img: &DynamicImage, cs: &str, quality: u8) -> Option<(Vec<u8>, u32, u32)> {
    let mut out = Vec::new();
    let encoder = JpegEncoder::new(&mut out, quality);
    if cs == "gray" {
        let gray = img.to_luma8();
        let (w, h) = gray.dimensions();
        if w > u16::MAX as u32 || h > u16::MAX as u32 {
            return None;
        }
        encoder
            .encode(gray.as_raw(), w as u16, h as u16, JpegColorType::Luma)
            .ok()?;
        Some((out, w, h))
    } else {
        let rgb = img.to_rgb8();
        let (w, h) = rgb.dimensions();
        if w > u16::MAX as u32 || h > u16::MAX as u32 {
            return None;
        }
        encoder
            .encode(rgb.as_raw(), w as u16, h as u16, JpegColorType::Rgb)
            .ok()?;
        Some((out, w, h))
    }
}

fn optimize_embedded_images_lopdf<F>(
    input_path: &Path,
    stage_path: &Path,
    max_long_side: u32,
    jpeg_quality: u8,
    cancel: &AtomicBool,
    mut on_progress: F,
) -> Result<ImageOptStats, AppError>
where
    F: FnMut(usize, usize),
{
    let mut doc = Document::load(input_path).map_err(|_| {
        AppError::new(
            "PDF_CORRUPT_OR_INVALID",
            "Unable to parse PDF structure for embedded image optimization.",
        )
    })?;

    // Collect every object ID referenced as an /SMask or /Mask so we NEVER recompress soft masks
    let mut protected_mask_ids: HashSet<ObjectId> = HashSet::new();
    let mut candidate_image_ids: Vec<ObjectId> = Vec::new();

    for (&obj_id, obj) in &doc.objects {
        let Object::Stream(stream) = obj else {
            continue;
        };
        let is_image = stream
            .dict
            .get(b"Subtype")
            .and_then(Object::as_name)
            .map(|n| n == b"Image")
            .unwrap_or(false);
        if !is_image {
            continue;
        }
        if let Ok(Object::Reference(smask_id)) = stream.dict.get(b"SMask") {
            protected_mask_ids.insert(*smask_id);
        }
        if let Ok(Object::Reference(mask_id)) = stream.dict.get(b"Mask") {
            protected_mask_ids.insert(*mask_id);
        }
        candidate_image_ids.push(obj_id);
    }

    let total_candidates = candidate_image_ids.len();
    let mut stats = ImageOptStats::default();

    for (idx, obj_id) in candidate_image_ids.into_iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::cancelled());
        }
        if idx % 4 == 0 || idx + 1 == total_candidates {
            on_progress(idx + 1, total_candidates.max(1));
        }
        if protected_mask_ids.contains(&obj_id) {
            continue;
        }

        // Read metadata without mutably borrowing doc so we can resolve indirect ColorSpace refs
        let meta = {
            let Some(Object::Stream(stream)) = doc.objects.get(&obj_id) else {
                continue;
            };
            let is_image_mask = stream
                .dict
                .get(b"ImageMask")
                .and_then(Object::as_bool)
                .unwrap_or(false);
            if is_image_mask
                || stream.dict.has(b"SMask")
                || stream.dict.has(b"Mask")
                || stream.dict.has(b"DecodeParms")
                || stream.dict.has(b"Decode")
            {
                continue;
            }
            let bpc = stream
                .dict
                .get(b"BitsPerComponent")
                .and_then(Object::as_i64)
                .unwrap_or(0);
            if bpc != 8 {
                continue;
            }
            let width = stream
                .dict
                .get(b"Width")
                .and_then(Object::as_i64)
                .unwrap_or(0);
            let height = stream
                .dict
                .get(b"Height")
                .and_then(Object::as_i64)
                .unwrap_or(0);
            if width <= 0 || height <= 0 || width > 16_384 || height > 16_384 {
                continue;
            }
            let cs_obj = match stream.dict.get(b"ColorSpace") {
                Ok(c) => c,
                Err(_) => continue,
            };
            let Some(cs) = is_simple_colorspace(cs_obj, &doc) else {
                continue;
            };
            let orig_len = stream.content.len();
            // Skip tiny icons / UI glyphs (< 12 KiB and small dimensions) to preserve crisp UI art
            if orig_len < 12 * 1024
                && (width as u32) <= max_long_side
                && (height as u32) <= max_long_side
            {
                continue;
            }
            (width as u32, height as u32, cs, orig_len)
        };

        let (width, height, cs, orig_len) = meta;
        stats.inspected += 1;

        let decoded_opt = {
            let Some(Object::Stream(stream)) = doc.objects.get(&obj_id) else {
                continue;
            };
            decode_opaque_image_stream(stream, width, height, cs)
        };
        let Some((img, was_jpeg)) = decoded_opt else {
            continue;
        };

        let long_side = width.max(height);
        let needs_resize = long_side > max_long_side;
        // Skip already-compact JPEGs that do not need downsampling and are already high-ratio
        let pixel_count = (width as u64).saturating_mul(height as u64);
        if was_jpeg && !needs_resize && (orig_len as u64) * 10 <= pixel_count * 2 {
            continue;
        }

        let processed = if needs_resize {
            let scale = (max_long_side as f64) / (long_side as f64);
            let new_w = ((width as f64 * scale).round() as u32).max(1);
            let new_h = ((height as f64 * scale).round() as u32).max(1);
            img.resize_exact(new_w, new_h, FilterType::Triangle)
        } else {
            img
        };

        let Some((jpeg_bytes, new_w, new_h)) = encode_jpeg_stream(&processed, cs, jpeg_quality)
        else {
            continue;
        };

        // Strict per-image no-bloat threshold: require at least 5% savings on this stream
        if jpeg_bytes.len() * 100 >= orig_len * 95 {
            continue;
        }

        if let Some(Object::Stream(stream)) = doc.objects.get_mut(&obj_id) {
            stream.content = jpeg_bytes;
            stream.dict.set("Width", Object::Integer(new_w as i64));
            stream.dict.set("Height", Object::Integer(new_h as i64));
            stream.dict.set("BitsPerComponent", Object::Integer(8));
            stream.dict.set(
                "ColorSpace",
                Object::Name(if cs == "gray" {
                    b"DeviceGray".to_vec()
                } else {
                    b"DeviceRGB".to_vec()
                }),
            );
            stream
                .dict
                .set("Filter", Object::Name(b"DCTDecode".to_vec()));
            stream
                .dict
                .set("Length", Object::Integer(stream.content.len() as i64));
            stream.dict.remove(b"DecodeParms");
            stats.optimized += 1;
            if needs_resize {
                stats.downsampled += 1;
            }
        }
    }

    if stats.optimized > 0 {
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).map_err(|e| {
            AppError::new(
                "PDF_WRITE_FAILED",
                format!("Failed serializing image-optimized PDF: {e}"),
            )
        })?;
        fs::write(stage_path, &bytes)
            .map_err(|e| AppError::from_io(e, "Failed writing intermediate compressed PDF"))?;
    }

    Ok(stats)
}

pub fn compress_pdf_impl<F>(
    pdf_session: &PdfSessionManager,
    req: &CompressPdfRequest,
    task_id: &str,
    cancel: &AtomicBool,
    mut emit_progress: F,
) -> Result<CompressPdfResult, AppError>
where
    F: FnMut(PdfTaskProgressPayload),
{
    let mode = CompressMode::parse(&req.mode)?;
    let (canonical, original_bytes) = validate_existing_input_file(&req.input_path)?;
    if original_bytes == 0 {
        return Err(AppError::new(
            "PDF_CORRUPT_OR_INVALID",
            "PDF file is empty (0 bytes).",
        ));
    }
    if original_bytes > MAX_PDF_FILE_BYTES {
        return Err(AppError::size_limit(format!(
            "PDF file exceeds the {} MiB safety limit.",
            MAX_PDF_FILE_BYTES / (1024 * 1024)
        )));
    }

    emit_progress(PdfTaskProgressPayload {
        task_id: task_id.to_string(),
        tool_id: "P14".to_string(),
        current: 4,
        total: 100,
        percent: 4.0,
        detail: "Inspecting source PDF".to_string(),
    });

    let sec = inspect_pdf_security_impl(pdf_session, &canonical.to_string_lossy())?;
    match sec.status.as_str() {
        "corrupt_or_invalid" => {
            return Err(AppError::new(
                "PDF_CORRUPT_OR_INVALID",
                "This file is not a valid PDF document or its structure is corrupted.",
            ));
        }
        "unsupported_security" => {
            return Err(AppError::new(
                "PDF_UNSUPPORTED_SECURITY",
                "This PDF uses an unsupported security handler.",
            ));
        }
        "encrypted_password_required" => {
            return Err(AppError::new(
                "PDF_PASSWORD_REQUIRED",
                "This PDF requires a password. Unlock it with PDF Decrypt (P16) before compressing.",
            ));
        }
        _ => {}
    }

    let resource_dir = pdf_session.resource_dir();
    let src_pdfium = inspect_with_pdfium(resource_dir.as_deref(), &canonical)?;
    if src_pdfium.page_count == 0 {
        return Err(AppError::new(
            "PDF_CORRUPT_OR_INVALID",
            "PDF document contains 0 pages.",
        ));
    }

    let atomic = AtomicPdfOutput::prepare(
        &req.output_path,
        std::slice::from_ref(&canonical),
        req.overwrite,
    )?;

    let mut warnings = sec.warnings;
    let mut img_stats = ImageOptStats::default();
    let mut stage_guard: Option<TempFileGuard> = None;

    let qpdf_input: PathBuf = if let Some((max_side, quality)) = mode.image_params() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let stage_path = atomic.temp_path().with_file_name(format!(
            ".winkit-p14-stage-{}-{stamp}.tmp",
            std::process::id()
        ));
        stage_guard = Some(TempFileGuard(stage_path.clone()));

        emit_progress(PdfTaskProgressPayload {
            task_id: task_id.to_string(),
            tool_id: "P14".to_string(),
            current: 10,
            total: 100,
            percent: 10.0,
            detail: "Optimizing embedded bitmap images".to_string(),
        });

        match optimize_embedded_images_lopdf(
            &canonical,
            &stage_path,
            max_side,
            quality,
            cancel,
            |cur, tot| {
                let pct = 10 + (cur * 45) / tot.max(1);
                emit_progress(PdfTaskProgressPayload {
                    task_id: task_id.to_string(),
                    tool_id: "P14".to_string(),
                    current: pct,
                    total: 100,
                    percent: pct as f64,
                    detail: format!("Analyzing embedded images ({cur}/{tot})"),
                });
            },
        ) {
            Ok(stats) => {
                img_stats = stats;
                if img_stats.optimized > 0 && stage_path.is_file() {
                    stage_path
                } else {
                    canonical.clone()
                }
            }
            Err(err) if err.code == "TASK_CANCELLED" => return Err(err),
            Err(_) => {
                warnings.push(
                    "Embedded image pass skipped due to complex PDF stream layout; falling back to lossless QPDF structural optimization."
                        .to_string(),
                );
                canonical.clone()
            }
        }
    } else {
        canonical.clone()
    };

    if cancel.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    // Stage 2: Lossless QPDF structural optimization (object streams, Flate level 9, prune unreferenced)
    let job = json!({
        "inputFile": qpdf_input.to_string_lossy(),
        "outputFile": atomic.temp_path().to_string_lossy(),
        "objectStreams": "generate",
        "compressStreams": "y",
        "recompressFlate": "",
        "compressionLevel": "9",
        "removeUnreferencedResources": "yes",
        "progress": ""
    });

    let progress_cb = std::cell::RefCell::new(&mut emit_progress);
    let qpdf_out = run_qpdf_job(
        resource_dir.as_deref(),
        &job,
        Some(cancel),
        DEFAULT_QPDF_TIMEOUT,
        Some(&|pct| {
            let scaled = 56 + ((pct as usize) * 32) / 100;
            (progress_cb.borrow_mut())(PdfTaskProgressPayload {
                task_id: task_id.to_string(),
                tool_id: "P14".to_string(),
                current: scaled,
                total: 100,
                percent: scaled as f64,
                detail: "Optimizing PDF object & Flate streams".to_string(),
            });
        }),
    )?;

    drop(stage_guard);

    if cancel.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }
    if qpdf_out.exit_code == QPDF_EXIT_ERROR {
        return Err(AppError::new(
            "PDF_WRITE_FAILED",
            "PDF structural optimization failed on this document.",
        ));
    }

    let compressed_len = fs::metadata(atomic.temp_path())
        .map_err(|e| AppError::from_io(e, "Compressed PDF output was not produced"))?
        .len();

    // Global no-bloat rule: never deliver a file larger than or equal to the original
    let kept_original = compressed_len >= original_bytes;
    if kept_original {
        fs::copy(&canonical, atomic.temp_path())
            .map_err(|e| AppError::from_io(e, "Failed copying original PDF without bloat"))?;
        warnings.push(
            "This PDF is already tightly compressed; no smaller copy could be produced without degrading content, so the original content was kept verbatim."
                .to_string(),
        );
    }

    (progress_cb.borrow_mut())(PdfTaskProgressPayload {
        task_id: task_id.to_string(),
        tool_id: "P14".to_string(),
        current: 92,
        total: 100,
        percent: 92.0,
        detail: "Verifying compressed PDF integrity".to_string(),
    });

    let out_pdfium = inspect_with_pdfium(resource_dir.as_deref(), atomic.temp_path())?;
    if out_pdfium.page_count != src_pdfium.page_count {
        return Err(AppError::new(
            "PDF_WRITE_FAILED",
            format!(
                "Compressed PDF verification failed: expected {} pages, got {}.",
                src_pdfium.page_count, out_pdfium.page_count
            ),
        ));
    }

    let (final_path, final_bytes) = atomic.commit_existing_tmp()?;
    let saved_bytes = if kept_original {
        0
    } else {
        original_bytes.saturating_sub(final_bytes)
    };
    let saved_percent = if original_bytes > 0 && saved_bytes > 0 {
        ((saved_bytes as f64) * 100.0 / (original_bytes as f64) * 10.0).round() / 10.0
    } else {
        0.0
    };

    (progress_cb.borrow_mut())(PdfTaskProgressPayload {
        task_id: task_id.to_string(),
        tool_id: "P14".to_string(),
        current: 100,
        total: 100,
        percent: 100.0,
        detail: "Compression complete".to_string(),
    });

    Ok(CompressPdfResult {
        output_path: final_path.to_string_lossy().into_owned(),
        mode: mode.as_str().to_string(),
        page_count: out_pdfium.page_count,
        original_bytes,
        output_bytes: final_bytes,
        saved_bytes,
        saved_percent,
        kept_original,
        images_inspected: img_stats.inspected,
        images_optimized: if kept_original {
            0
        } else {
            img_stats.optimized
        },
        images_downsampled: if kept_original {
            0
        } else {
            img_stats.downsampled
        },
        has_text_layer: out_pdfium.has_text_layer,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf_pdfium::extract_page_text_with_pdfium;
    use lopdf::dictionary;
    use tempfile::tempdir;

    fn build_uncompressed_scanned_and_text_pdf(path: &Path, include_text: bool, img_side: u32) {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let font_id = doc.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
        });

        // Smooth colorful photographic gradient (raw uncompressed RGB -> huge before JPEG!)
        let mut raw_rgb = Vec::with_capacity((img_side * img_side * 3) as usize);
        for y in 0..img_side {
            for x in 0..img_side {
                let r = ((x * 255) / img_side.max(1)) as u8;
                let g = ((y * 255) / img_side.max(1)) as u8;
                let b = (((x + y) * 127) / img_side.max(1)) as u8;
                raw_rgb.push(r);
                raw_rgb.push(g);
                raw_rgb.push(b);
            }
        }
        let img_id = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => img_side as i64,
                "Height" => img_side as i64,
                "ColorSpace" => "DeviceRGB",
                "BitsPerComponent" => 8,
            },
            raw_rgb,
        ));
        let resources_id = doc.add_object(dictionary! {
            "Font" => dictionary! { "F1" => font_id },
            "XObject" => dictionary! { "Im0" => img_id },
        });
        let content_str = if include_text {
            "q 400 0 0 400 90 120 cm /Im0 Do Q BT /F1 18 Tf 72 760 Td (WinKit Mixed Text And Image Compression Test) Tj ET"
        } else {
            "q 500 0 0 500 45 150 cm /Im0 Do Q"
        };
        let content_id =
            doc.add_object(Stream::new(dictionary! {}, content_str.as_bytes().to_vec()));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
            "Resources" => resources_id,
            "Contents" => content_id,
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![page_id.into()],
                "Count" => 1,
            }),
        );
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        doc.trailer.set("Root", catalog_id);
        doc.save(path).expect("save scanned pdf");
    }

    fn build_multipage_text_pdf(path: &Path, page_count: usize) {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let font_id = doc.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
        });
        let resources_id = doc.add_object(dictionary! {
            "Font" => dictionary! { "F1" => font_id },
        });
        let mut kids: Vec<Object> = Vec::with_capacity(page_count);
        for p in 1..=page_count {
            let content = format!(
                "BT /F1 12 Tf 72 760 Td (WinKit Page {p} selectable vector text payload repeated for realistic size testing.) Tj ET"
            );
            let cid = doc.add_object(Stream::new(dictionary! {}, content.into_bytes()));
            let pid = doc.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
                "Resources" => resources_id,
                "Contents" => cid,
            });
            kids.push(pid.into());
        }
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => kids,
                "Count" => page_count as i64,
            }),
        );
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        doc.trailer.set("Root", catalog_id);
        doc.save(path).expect("save multipage pdf");
    }

    #[test]
    fn p14_compresses_mixed_scanned_keeps_text_avoids_bloat_and_handles_300_pages() {
        let dir = tempdir().expect("tempdir");
        let session = PdfSessionManager::default();
        let cancel = AtomicBool::new(false);

        // 1. Mixed text + large uncompressed bitmap -> huge reduction in balanced & smallest, text preserved
        let mixed_src = dir.path().join("mixed.pdf");
        build_uncompressed_scanned_and_text_pdf(&mixed_src, true, 1800);
        let mixed_bal_out = dir.path().join("mixed_balanced.pdf");
        let bal = compress_pdf_impl(
            &session,
            &CompressPdfRequest {
                input_path: mixed_src.to_string_lossy().into_owned(),
                output_path: mixed_bal_out.to_string_lossy().into_owned(),
                overwrite: false,
                mode: "balanced".to_string(),
            },
            "c1",
            &cancel,
            |_| {},
        )
        .expect("balanced compress");
        assert!(!bal.kept_original);
        assert!(
            bal.saved_percent > 80.0,
            "expected big savings, got {}%",
            bal.saved_percent
        );
        assert_eq!(bal.images_optimized, 1);
        assert_eq!(bal.images_downsampled, 1);
        assert!(bal.has_text_layer);

        let text = extract_page_text_with_pdfium(None, &mixed_bal_out, 1).unwrap();
        assert!(text
            .full_text
            .contains("WinKit Mixed Text And Image Compression Test"));

        // 2. Re-compressing already-compressed PDF in lossless mode must NEVER bloat
        let re_out = dir.path().join("mixed_recompressed.pdf");
        let re = compress_pdf_impl(
            &session,
            &CompressPdfRequest {
                input_path: mixed_bal_out.to_string_lossy().into_owned(),
                output_path: re_out.to_string_lossy().into_owned(),
                overwrite: false,
                mode: "lossless".to_string(),
            },
            "c2",
            &cancel,
            |_| {},
        )
        .expect("recompress lossless");
        assert!(re.output_bytes <= re.original_bytes);

        // 3. 300-page pure text PDF -> fast lossless structural compression, all 300 pages & text intact
        let p300 = dir.path().join("doc_300_pages.pdf");
        build_multipage_text_pdf(&p300, 300);
        let p300_out = dir.path().join("doc_300_pages_opt.pdf");
        let res300 = compress_pdf_impl(
            &session,
            &CompressPdfRequest {
                input_path: p300.to_string_lossy().into_owned(),
                output_path: p300_out.to_string_lossy().into_owned(),
                overwrite: false,
                mode: "lossless".to_string(),
            },
            "c3",
            &cancel,
            |_| {},
        )
        .expect("300-page compress");
        assert_eq!(res300.page_count, 300);
        assert!(
            !res300.kept_original,
            "300-page uncompressed text PDF should shrink via object streams"
        );
        assert!(res300.saved_bytes > 0);
        let p300_text = extract_page_text_with_pdfium(None, &p300_out, 300).unwrap();
        assert!(p300_text.full_text.contains("WinKit Page 300"));
    }
}
