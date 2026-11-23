//! Phase 5A P17: Offline PDF to Images batch renderer & exporter.
//!
//! Renders PDF pages through the isolated PDFium worker (`PdfSessionManager`), encodes to PNG /
//! JPEG / WebP (and HEIC only when Windows WIC HEIC encoding is explicitly verified available),
//! provides upfront pixel dimension estimates with safety-cap visibility, isolates per-page errors
//! so one failing page never aborts remaining valid pages, and commits outputs atomically without
//! overwriting existing files.

use crate::error::AppError;
use crate::fs_guard::{validate_existing_input_file, validate_user_path};
use crate::image_assets::encode_rgba_to_png_fast;
use crate::image_core::{composite_rgba_over_rgb, encode_jpeg_bytes};
use crate::pdf_core::{
    parse_page_range_spec, sanitize_pdf_filename, PdfSessionManager, PdfTaskProgressPayload,
};
use crate::pdf_pdfium::{compute_bounded_render_size, MAX_RENDER_SIDE_PX};
use crate::wic_heic::{encode_heic_bytes_via_wic, get_heic_capabilities};
use image::RgbaImage;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PdfExportImageFormat {
    Png,
    Jpeg,
    Webp,
    Heic,
}

impl PdfExportImageFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Webp => "webp",
            Self::Heic => "heic",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PdfExportPageScope {
    All,
    SinglePage,
    CustomRange,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfToImagesPlanRequest {
    pub path: String,
    pub scope: PdfExportPageScope,
    pub single_page: Option<usize>,
    pub custom_range: Option<String>,
    pub dpi: f32,
    pub format: PdfExportImageFormat,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfToImagesPageEstimate {
    pub page_number: usize,
    pub width_px: u32,
    pub height_px: u32,
    pub capped: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfToImagesPlanPreview {
    pub valid: bool,
    pub source_page_count: usize,
    pub target_page_count: usize,
    pub max_width_px: u32,
    pub max_height_px: u32,
    pub capped_count: usize,
    pub heic_encode_available: bool,
    pub sample_estimates: Vec<PdfToImagesPageEstimate>,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfToImagesRequest {
    pub task_id: Option<String>,
    pub path: String,
    pub scope: PdfExportPageScope,
    pub single_page: Option<usize>,
    pub custom_range: Option<String>,
    pub dpi: f32,
    pub format: PdfExportImageFormat,
    pub quality: Option<u8>,
    pub webp_lossless: Option<bool>,
    pub output_dir: String,
    pub create_subfolder: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PdfExportImageItemStatus {
    Ok,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfExportImageItemOutcome {
    pub page_number: usize,
    pub status: PdfExportImageItemStatus,
    pub output_path: Option<String>,
    pub file_name: Option<String>,
    pub width_px: Option<u32>,
    pub height_px: Option<u32>,
    pub byte_length: u64,
    pub capped: bool,
    pub collision_adjusted: bool,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfToImagesResult {
    pub output_dir: String,
    pub total_requested: usize,
    pub succeeded_count: usize,
    pub failed_count: usize,
    pub cancelled: bool,
    pub total_output_bytes: u64,
    pub items: Vec<PdfExportImageItemOutcome>,
    pub warnings: Vec<String>,
}

fn resolve_target_pages(
    scope: PdfExportPageScope,
    total_pages: usize,
    single_page: Option<usize>,
    custom_range: Option<&str>,
) -> Result<Vec<usize>, String> {
    if total_pages == 0 {
        return Err("PDF contains 0 pages.".to_string());
    }
    match scope {
        PdfExportPageScope::All => Ok((1..=total_pages).collect()),
        PdfExportPageScope::SinglePage => {
            let p = single_page.unwrap_or(1);
            if p == 0 || p > total_pages {
                Err(format!(
                    "Page {p} is out of bounds (valid: 1-{total_pages})."
                ))
            } else {
                Ok(vec![p])
            }
        }
        PdfExportPageScope::CustomRange => {
            let spec = custom_range.unwrap_or("").trim();
            if spec.is_empty() {
                return Err("Enter a page range such as '1-3, 5'.".to_string());
            }
            let parsed = parse_page_range_spec(spec, total_pages).map_err(|e| e.message)?;
            let mut seen = HashSet::new();
            let deduped: Vec<usize> = parsed
                .pages
                .into_iter()
                .filter(|p| seen.insert(*p))
                .collect();
            Ok(deduped)
        }
    }
}

pub fn preview_pdf_to_images_plan_impl(
    pdf_mgr: &PdfSessionManager,
    req: &PdfToImagesPlanRequest,
) -> Result<PdfToImagesPlanPreview, AppError> {
    let info = pdf_mgr.inspect_document(&req.path)?;
    let heic_caps = get_heic_capabilities();

    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    if !req.dpi.is_finite() || req.dpi < 36.0 || req.dpi > 600.0 {
        errors.push("DPI must be between 36 and 600.".to_string());
    }
    if req.format == PdfExportImageFormat::Heic && !heic_caps.encode_available {
        errors.push(
            "HEIC encoding is not available on this Windows installation (requires HEVC/HEIF Image Extensions)."
                .to_string(),
        );
    }

    let target_pages = match resolve_target_pages(
        req.scope,
        info.page_count,
        req.single_page,
        req.custom_range.as_deref(),
    ) {
        Ok(pages) => pages,
        Err(msg) => {
            errors.push(msg);
            Vec::new()
        }
    };

    let safe_dpi = req.dpi.clamp(36.0, 600.0);
    let mut max_w = 0u32;
    let mut max_h = 0u32;
    let mut capped_count = 0usize;
    let mut sample_estimates = Vec::new();

    for (idx, &p) in target_pages.iter().enumerate() {
        let Some(geom) = info.pages.get(p - 1) else {
            continue;
        };
        let (w, h, capped) = compute_bounded_render_size(
            geom.width_pt,
            geom.height_pt,
            0,
            None,
            Some(safe_dpi),
            MAX_RENDER_SIDE_PX,
        );
        max_w = max_w.max(w);
        max_h = max_h.max(h);
        if capped {
            capped_count += 1;
        }
        if idx < 12 {
            sample_estimates.push(PdfToImagesPageEstimate {
                page_number: p,
                width_px: w,
                height_px: h,
                capped,
            });
        }
    }

    if capped_count > 0 {
        warnings.push(format!(
            "{capped_count} page(s) exceed maximum safe bitmap dimensions ({MAX_RENDER_SIDE_PX}px side / 48 MP) and will be scaled cleanly to fit safely."
        ));
    }

    let valid = errors.is_empty() && !target_pages.is_empty();
    Ok(PdfToImagesPlanPreview {
        valid,
        source_page_count: info.page_count,
        target_page_count: target_pages.len(),
        max_width_px: max_w,
        max_height_px: max_h,
        capped_count,
        heic_encode_available: heic_caps.encode_available,
        sample_estimates,
        errors,
        warnings,
    })
}

fn write_unique_image_atomic(
    dir: &Path,
    stem_base: &str,
    ext: &str,
    bytes: &[u8],
) -> Result<(PathBuf, bool), AppError> {
    let clean_stem = sanitize_pdf_filename(stem_base);
    let stem = Path::new(&clean_stem)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "page".to_string());

    for idx in 1..=9999usize {
        let file_name = if idx == 1 {
            format!("{stem}.{ext}")
        } else {
            format!("{stem}_{idx}.{ext}")
        };
        let candidate = dir.join(&file_name);
        if candidate.exists() {
            continue;
        }
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let pid = std::process::id();
        let tmp = dir.join(format!(".{file_name}.winkit-{pid}-{stamp}.tmp"));
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| AppError::from_io(e, "Unable to create temporary image file"))?;
        if let Err(err) = f.write_all(bytes).and_then(|()| f.flush()) {
            drop(f);
            let _ = fs::remove_file(&tmp);
            return Err(AppError::from_io(err, "Failed while writing image output"));
        }
        drop(f);

        match fs::hard_link(&tmp, &candidate) {
            Ok(()) => {
                let _ = fs::remove_file(&tmp);
                return Ok((candidate, idx > 1));
            }
            Err(err) if err.kind() == ErrorKind::AlreadyExists => {
                let _ = fs::remove_file(&tmp);
                continue;
            }
            Err(_) => {
                if candidate.exists() {
                    let _ = fs::remove_file(&tmp);
                    continue;
                }
                if let Err(ren_err) = fs::rename(&tmp, &candidate) {
                    let _ = fs::remove_file(&tmp);
                    return Err(AppError::from_io(ren_err, "Unable to commit image output"));
                }
                return Ok((candidate, idx > 1));
            }
        }
    }

    Err(AppError::new(
        "IO_ERROR",
        "Unable to allocate a unique output image filename.",
    ))
}

fn encode_rendered_page(
    rgba_bytes: Vec<u8>,
    width_px: u32,
    height_px: u32,
    format: PdfExportImageFormat,
    quality: u8,
    webp_lossless: bool,
) -> Result<Vec<u8>, AppError> {
    let rgba = RgbaImage::from_raw(width_px, height_px, rgba_bytes).ok_or_else(|| {
        AppError::new("PDF_RENDER_FAILED", "Rendered image buffer size mismatch.")
    })?;

    match format {
        PdfExportImageFormat::Png => encode_rgba_to_png_fast(&rgba),
        PdfExportImageFormat::Jpeg => {
            let rgb = composite_rgba_over_rgb(&rgba, [255, 255, 255]);
            encode_jpeg_bytes(&rgb, quality.clamp(40, 100), false, None)
        }
        PdfExportImageFormat::Webp => {
            let encoder = webp::Encoder::from_rgba(rgba.as_raw(), width_px, height_px);
            let mem = if webp_lossless {
                encoder.encode_lossless()
            } else {
                encoder.encode(quality.clamp(40, 100) as f32)
            };
            Ok(mem.to_vec())
        }
        PdfExportImageFormat::Heic => {
            encode_heic_bytes_via_wic(&rgba, quality.clamp(40, 100), None)
        }
    }
}

pub fn pdf_to_images_impl(
    pdf_mgr: &PdfSessionManager,
    req: &PdfToImagesRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(PdfTaskProgressPayload),
) -> Result<PdfToImagesResult, AppError> {
    if !req.dpi.is_finite() || req.dpi < 36.0 || req.dpi > 600.0 {
        return Err(AppError::invalid_param("DPI must be between 36 and 600."));
    }
    if req.format == PdfExportImageFormat::Heic && !get_heic_capabilities().encode_available {
        return Err(AppError::new(
            "UNSUPPORTED_FORMAT",
            "HEIC encoding is not available on this Windows installation.",
        ));
    }

    let (canonical_pdf, _) = validate_existing_input_file(&req.path)?;
    let info = pdf_mgr.inspect_document(&canonical_pdf.to_string_lossy())?;
    let target_pages = resolve_target_pages(
        req.scope,
        info.page_count,
        req.single_page,
        req.custom_range.as_deref(),
    )
    .map_err(AppError::invalid_param)?;

    let base_out_dir = validate_user_path(&req.output_dir, "Output directory")?;
    let base_meta = fs::metadata(&base_out_dir)
        .map_err(|e| AppError::from_io(e, "Unable to access output directory"))?;
    if !base_meta.is_dir() {
        return Err(AppError::invalid_param(
            "Selected output location is not a valid directory.",
        ));
    }

    let stem = canonical_pdf
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "document".to_string());

    let final_out_dir = if req.create_subfolder.unwrap_or(false) {
        let folder_name = sanitize_pdf_filename(&format!("{stem}_images"))
            .trim_end_matches(".pdf")
            .to_string();
        let sub = base_out_dir.join(folder_name);
        fs::create_dir_all(&sub)
            .map_err(|e| AppError::from_io(e, "Unable to create output subfolder"))?;
        sub
    } else {
        base_out_dir
    };

    let task_id = req
        .task_id
        .clone()
        .unwrap_or_else(|| "pdf-to-images".to_string());
    let total = target_pages.len();
    let pad_width = info.page_count.to_string().len().max(3);
    let quality = req.quality.unwrap_or(90).clamp(40, 100);
    let webp_lossless = req.webp_lossless.unwrap_or(false);
    let ext = req.format.extension();

    let mut items = Vec::with_capacity(total);
    let mut succeeded_count = 0usize;
    let mut failed_count = 0usize;
    let mut total_output_bytes = 0u64;
    let mut cancelled = false;
    let mut capped_pages = 0usize;

    for (idx, &page_number) in target_pages.iter().enumerate() {
        if cancel_flag.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }

        let render_res = pdf_mgr.render_page_rgba_for_export(
            &canonical_pdf,
            page_number,
            req.dpi,
            0,
            MAX_RENDER_SIDE_PX,
        );

        let outcome = match render_res {
            Ok((meta, rgba)) => {
                if cancel_flag.load(Ordering::Relaxed) {
                    cancelled = true;
                    break;
                }
                if meta.capped {
                    capped_pages += 1;
                }
                match encode_rendered_page(
                    rgba,
                    meta.width_px,
                    meta.height_px,
                    req.format,
                    quality,
                    webp_lossless,
                ) {
                    Ok(encoded) => {
                        if cancel_flag.load(Ordering::Relaxed) {
                            cancelled = true;
                            break;
                        }
                        let file_stem =
                            format!("{stem}_p{:0width$}", page_number, width = pad_width);
                        match write_unique_image_atomic(&final_out_dir, &file_stem, ext, &encoded) {
                            Ok((out_path, collision_adjusted)) => {
                                let byte_len = encoded.len() as u64;
                                succeeded_count += 1;
                                total_output_bytes += byte_len;
                                let fname = out_path
                                    .file_name()
                                    .map(|n| n.to_string_lossy().into_owned());
                                PdfExportImageItemOutcome {
                                    page_number,
                                    status: PdfExportImageItemStatus::Ok,
                                    output_path: Some(out_path.to_string_lossy().into_owned()),
                                    file_name: fname,
                                    width_px: Some(meta.width_px),
                                    height_px: Some(meta.height_px),
                                    byte_length: byte_len,
                                    capped: meta.capped,
                                    collision_adjusted,
                                    error_message: None,
                                }
                            }
                            Err(err) => {
                                failed_count += 1;
                                PdfExportImageItemOutcome {
                                    page_number,
                                    status: PdfExportImageItemStatus::Error,
                                    output_path: None,
                                    file_name: None,
                                    width_px: Some(meta.width_px),
                                    height_px: Some(meta.height_px),
                                    byte_length: 0,
                                    capped: meta.capped,
                                    collision_adjusted: false,
                                    error_message: Some(err.message),
                                }
                            }
                        }
                    }
                    Err(err) => {
                        failed_count += 1;
                        PdfExportImageItemOutcome {
                            page_number,
                            status: PdfExportImageItemStatus::Error,
                            output_path: None,
                            file_name: None,
                            width_px: Some(meta.width_px),
                            height_px: Some(meta.height_px),
                            byte_length: 0,
                            capped: meta.capped,
                            collision_adjusted: false,
                            error_message: Some(err.message),
                        }
                    }
                }
            }
            Err(err) => {
                failed_count += 1;
                PdfExportImageItemOutcome {
                    page_number,
                    status: PdfExportImageItemStatus::Error,
                    output_path: None,
                    file_name: None,
                    width_px: None,
                    height_px: None,
                    byte_length: 0,
                    capped: false,
                    collision_adjusted: false,
                    error_message: Some(err.message),
                }
            }
        };

        items.push(outcome);
        on_progress(PdfTaskProgressPayload {
            task_id: task_id.clone(),
            tool_id: "P17".to_string(),
            current: idx + 1,
            total,
            percent: ((idx + 1) as f64 / total.max(1) as f64) * 100.0,
            detail: format!("Rendered page {page_number} ({}/{total})", idx + 1),
        });
    }

    let mut warnings = Vec::new();
    if capped_pages > 0 {
        warnings.push(format!(
            "{capped_pages} page(s) were capped to safe maximum bitmap limits ({MAX_RENDER_SIDE_PX}px side / 48 MP)."
        ));
    }

    Ok(PdfToImagesResult {
        output_dir: final_out_dir.to_string_lossy().into_owned(),
        total_requested: total,
        succeeded_count,
        failed_count,
        cancelled,
        total_output_bytes,
        items,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf_ops::{
        images_to_pdf_impl, ImagesToPdfRequest, PdfPageOrientation, PdfPageSizePreset,
    };
    use lopdf::{Dictionary, Document, Object, Stream};
    use tempfile::tempdir;

    #[test]
    fn p17_exports_png_jpeg_webp_respects_dpi_caps_and_never_overwrites() {
        let dir = tempdir().expect("tempdir");
        let img_a = dir.path().join("a.png");
        let img_b = dir.path().join("b.png");
        let src_pdf = dir.path().join("slides.pdf");
        let out_dir = dir.path().join("export");
        fs::create_dir_all(&out_dir).expect("mkdir");

        image::RgbaImage::from_pixel(200, 100, image::Rgba([40, 140, 220, 255]))
            .save(&img_a)
            .expect("save a");
        image::RgbaImage::from_pixel(120, 240, image::Rgba([220, 80, 40, 255]))
            .save(&img_b)
            .expect("save b");

        let cancel = AtomicBool::new(false);
        images_to_pdf_impl(
            &ImagesToPdfRequest {
                task_id: None,
                image_paths: vec![
                    img_a.to_string_lossy().into_owned(),
                    img_b.to_string_lossy().into_owned(),
                ],
                output_path: src_pdf.to_string_lossy().into_owned(),
                overwrite: Some(false),
                page_size: PdfPageSizePreset::A4,
                orientation: PdfPageOrientation::Auto,
                margin_pt: 20.0,
                background_hex: "#FFFFFF".into(),
                jpeg_quality: Some(90),
                lossless_png_images: Some(false),
                assumed_dpi: Some(150.0),
            },
            &cancel,
            |_| {},
        )
        .expect("build pdf");

        let mgr = PdfSessionManager::default();
        // Upfront estimate at 150 DPI for A4 (~595.28 x 841.89 pt -> ~1240 x 1754 px)
        let plan = preview_pdf_to_images_plan_impl(
            &mgr,
            &PdfToImagesPlanRequest {
                path: src_pdf.to_string_lossy().into_owned(),
                scope: PdfExportPageScope::All,
                single_page: None,
                custom_range: None,
                dpi: 150.0,
                format: PdfExportImageFormat::Png,
            },
        )
        .expect("plan");
        assert!(plan.valid);
        assert_eq!(plan.target_page_count, 2);
        assert!((plan.sample_estimates[0].width_px as i32 - 1754).abs() <= 4);

        // Pre-create colliding file to verify non-overwrite protection
        let colliding = out_dir.join("slides_p001.png");
        fs::write(&colliding, b"KEEP_ME").expect("seed collision");

        // Export PNG at 72 DPI
        let png_res = pdf_to_images_impl(
            &mgr,
            &PdfToImagesRequest {
                task_id: Some("p17-png".into()),
                path: src_pdf.to_string_lossy().into_owned(),
                scope: PdfExportPageScope::All,
                single_page: None,
                custom_range: None,
                dpi: 72.0,
                format: PdfExportImageFormat::Png,
                quality: Some(90),
                webp_lossless: None,
                output_dir: out_dir.to_string_lossy().into_owned(),
                create_subfolder: Some(false),
            },
            &cancel,
            |_| {},
        )
        .expect("export png");
        assert_eq!(png_res.succeeded_count, 2);
        assert_eq!(png_res.failed_count, 0);
        assert!(png_res.items[0].collision_adjusted);
        assert_eq!(
            png_res.items[0].file_name.as_deref(),
            Some("slides_p001_2.png")
        );
        assert_eq!(fs::read(&colliding).unwrap(), b"KEEP_ME");
        let decoded =
            image::open(png_res.items[0].output_path.as_ref().unwrap()).expect("decode png");
        assert!((decoded.width() as i32 - 842).abs() <= 2);
        assert!((decoded.height() as i32 - 595).abs() <= 2);

        // Export WebP single page
        let webp_res = pdf_to_images_impl(
            &mgr,
            &PdfToImagesRequest {
                task_id: Some("p17-webp".into()),
                path: src_pdf.to_string_lossy().into_owned(),
                scope: PdfExportPageScope::SinglePage,
                single_page: Some(2),
                custom_range: None,
                dpi: 72.0,
                format: PdfExportImageFormat::Webp,
                quality: Some(85),
                webp_lossless: Some(false),
                output_dir: out_dir.to_string_lossy().into_owned(),
                create_subfolder: Some(true),
            },
            &cancel,
            |_| {},
        )
        .expect("export webp");
        assert_eq!(webp_res.succeeded_count, 1);
        let decoded_webp =
            image::open(webp_res.items[0].output_path.as_ref().unwrap()).expect("decode webp");
        assert!((decoded_webp.width() as i32 - 595).abs() <= 2);

        // Oversized page (>14,400 pt) safely caps dimensions without OOM
        let huge_pdf = dir.path().join("huge.pdf");
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let content_id = doc.add_object(Object::Stream(Stream::new(Dictionary::new(), Vec::new())));
        let mut page = Dictionary::new();
        page.set("Type", Object::Name(b"Page".to_vec()));
        page.set("Parent", Object::Reference(pages_id));
        page.set(
            "MediaBox",
            Object::Array(vec![
                Object::Integer(0),
                Object::Integer(0),
                Object::Integer(16000),
                Object::Integer(16000),
            ]),
        );
        page.set("Contents", Object::Reference(content_id));
        let pid = doc.add_object(Object::Dictionary(page));
        let mut pages = Dictionary::new();
        pages.set("Type", Object::Name(b"Pages".to_vec()));
        pages.set("Kids", Object::Array(vec![Object::Reference(pid)]));
        pages.set("Count", Object::Integer(1));
        doc.objects.insert(pages_id, Object::Dictionary(pages));
        let mut cat = Dictionary::new();
        cat.set("Type", Object::Name(b"Catalog".to_vec()));
        cat.set("Pages", Object::Reference(pages_id));
        let cid = doc.add_object(Object::Dictionary(cat));
        doc.trailer.set("Root", Object::Reference(cid));
        let mut buf = Vec::new();
        doc.save_to(&mut buf).expect("save huge");
        fs::write(&huge_pdf, buf).expect("write huge");

        let huge_plan = preview_pdf_to_images_plan_impl(
            &mgr,
            &PdfToImagesPlanRequest {
                path: huge_pdf.to_string_lossy().into_owned(),
                scope: PdfExportPageScope::All,
                single_page: None,
                custom_range: None,
                dpi: 300.0,
                format: PdfExportImageFormat::Jpeg,
            },
        )
        .expect("huge plan");
        assert_eq!(huge_plan.capped_count, 1);
        assert!(huge_plan.max_width_px <= MAX_RENDER_SIDE_PX);
        assert!((huge_plan.max_width_px as u64) * (huge_plan.max_height_px as u64) <= 48_000_000);
    }
}
