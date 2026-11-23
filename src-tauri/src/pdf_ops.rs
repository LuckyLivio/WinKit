//! Pure-Rust structural PDF engine (`lopdf 0.47`) for vector-preserving page operations.
//!
//! Powers:
//! - Shared `build_image_pdf_document`: EXIF-upright, alpha-composited image-to-PDF pages
//!   (used by both `P07` mixed PDF+image merge and `P12` Images to PDF).
//! - Shared `assemble_pdf_from_plan`: vector & text preserving page assembly with inherited
//!   `/Pages` attribute materialization, cycle-safe deep cloning, external URI link preservation,
//!   internal GoTo/Dest/named-dest remapping + dangling link removal, `/Outlines` bookmark
//!   remapping + dangling bookmark pruning, and digital signature invalidation sanitization.
//! - `P07` (`merge_pdfs_impl`), `P08` (`preview_split_pdf_plan_impl`, `split_pdf_impl`), and
//!   shared entry points for `P09`/`P10`/`P11`.

use crate::error::AppError;
use crate::fs_guard::validate_existing_input_file;
use crate::image_core::{
    composite_rgba_over_rgb, decode_image_to_display, encode_jpeg_bytes, parse_hex_rgb,
    ImageFileFormat,
};
use crate::pdf_core::{
    format_compact_page_list, inspect_structural_flags_from_doc, parse_page_range_spec,
    sanitize_pdf_filename, AtomicPdfOutput, PdfTaskProgressPayload,
};
use crate::pdf_pdfium::{MAX_PDF_FILE_BYTES, MAX_PDF_PAGES};
use flate2::write::ZlibEncoder;
use flate2::Compression;
use lopdf::{Dictionary, Document, Object, ObjectId, Stream, StringFormat};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const MAX_CLONE_DEPTH: usize = 128;
const MAX_OUTLINE_NODES: usize = 2_000;
const MAX_IMAGE_INPUT_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PdfPageSizePreset {
    Original,
    A4,
    Letter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PdfPageOrientation {
    Auto,
    Portrait,
    Landscape,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageToPdfPageOptions {
    pub page_size: PdfPageSizePreset,
    pub orientation: PdfPageOrientation,
    pub margin_pt: f32,
    pub background_hex: String,
    pub jpeg_quality: u8,
    pub lossless_png_images: bool,
    pub assumed_dpi: f32,
}

impl Default for ImageToPdfPageOptions {
    fn default() -> Self {
        Self {
            page_size: PdfPageSizePreset::A4,
            orientation: PdfPageOrientation::Auto,
            margin_pt: 24.0,
            background_hex: "#FFFFFF".to_string(),
            jpeg_quality: 90,
            lossless_png_images: false,
            assumed_dpi: 150.0,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfStructuralSummary {
    pub preserved_external_links: usize,
    pub remapped_internal_links: usize,
    pub dropped_dangling_links: usize,
    pub remapped_bookmarks: usize,
    pub dropped_dangling_bookmarks: usize,
    pub signature_invalidated_sources: Vec<String>,
    pub acroform_simplified_sources: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePdfInputItem {
    pub path: String,
    /// Optional explicit kind ("pdf" | "image"); auto-detected from magic/extension if omitted.
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePdfsRequest {
    pub task_id: Option<String>,
    pub inputs: Vec<MergePdfInputItem>,
    pub output_path: String,
    pub add_filename_bookmarks: bool,
    pub overwrite: Option<bool>,
    pub image_options: Option<ImageToPdfPageOptions>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePdfsResult {
    pub output_path: String,
    pub byte_length: u64,
    pub total_pages: usize,
    pub source_count: usize,
    pub pdf_source_count: usize,
    pub image_source_count: usize,
    pub summary: PdfStructuralSummary,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PdfSplitMode {
    EveryPage,
    EveryNPages,
    CustomRanges,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitPdfPlanRequest {
    pub path: String,
    pub mode: PdfSplitMode,
    pub chunk_size: Option<usize>,
    /// Line- or semicolon-separated range expressions for CustomRanges mode (e.g. "1-3; 4-6; 7, 9").
    pub custom_ranges: Option<String>,
    pub output_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitPdfPlanItem {
    pub part_index: usize,
    pub file_name: String,
    pub pages: Vec<usize>,
    pub page_count: usize,
    pub range_label: String,
    pub collision_adjusted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitPdfPlanPreview {
    pub valid: bool,
    pub source_page_count: usize,
    pub output_file_count: usize,
    pub total_output_pages: usize,
    pub items: Vec<SplitPdfPlanItem>,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitPdfRequest {
    pub task_id: Option<String>,
    pub path: String,
    pub mode: PdfSplitMode,
    pub chunk_size: Option<usize>,
    pub custom_ranges: Option<String>,
    pub output_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitPdfOutputFile {
    pub part_index: usize,
    pub path: String,
    pub file_name: String,
    pub byte_length: u64,
    pub page_count: usize,
    pub range_label: String,
    pub collision_adjusted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitPdfResult {
    pub output_dir: String,
    pub source_page_count: usize,
    pub files: Vec<SplitPdfOutputFile>,
    pub total_output_pages: usize,
    pub total_output_bytes: u64,
    pub cancelled: bool,
    pub summary: PdfStructuralSummary,
    pub warnings: Vec<String>,
}

pub struct PlannedPageRef {
    pub source_idx: usize,
    pub source_page_1based: usize,
    pub extra_rotation_cw: u16,
}

pub struct AssembleOptions {
    pub add_filename_bookmarks: bool,
    pub preserve_source_outlines: bool,
}

pub struct LoadedSourceDoc {
    pub display_name: String,
    pub path: Option<PathBuf>,
    pub doc: Document,
    pub has_signatures: bool,
    pub has_acroform: bool,
}

#[derive(Debug, Clone)]
struct SourceOutlineNode {
    title: String,
    target_page_id: Option<ObjectId>,
    children: Vec<SourceOutlineNode>,
}

struct PendingInternalLink {
    source_idx: usize,
    out_page_id: ObjectId,
    annot_id: ObjectId,
    target_old_page_id: ObjectId,
    dest_tail: Vec<Object>,
    is_action_goto: bool,
}

fn encode_pdf_unicode_string(text: &str) -> Object {
    if text.is_ascii() {
        return Object::String(text.as_bytes().to_vec(), StringFormat::Literal);
    }
    let mut bytes = Vec::with_capacity(2 + text.len() * 2);
    bytes.push(0xFE);
    bytes.push(0xFF);
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_be_bytes());
    }
    Object::String(bytes, StringFormat::Hexadecimal)
}

fn decode_pdf_string(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let units: Vec<u16> = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_be_bytes(*c))
            .collect();
        return String::from_utf16_lossy(&units).trim().to_string();
    }
    if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
        return String::from_utf8_lossy(&bytes[3..]).trim().to_string();
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.trim().to_string();
    }
    bytes
        .iter()
        .map(|&b| b as char)
        .collect::<String>()
        .trim()
        .to_string()
}

pub fn load_pdf_for_editing(path: &Path) -> Result<LoadedSourceDoc, AppError> {
    let path_str = path.to_string_lossy();
    let (canonical, len) = validate_existing_input_file(&path_str)?;
    if len == 0 {
        return Err(AppError::new(
            "PDF_CORRUPT_OR_INVALID",
            "PDF file is empty (0 bytes).",
        ));
    }
    if len > MAX_PDF_FILE_BYTES {
        return Err(AppError::size_limit(format!(
            "PDF file exceeds the {} MiB safety limit.",
            MAX_PDF_FILE_BYTES / (1024 * 1024)
        )));
    }
    let doc = Document::load(&canonical).map_err(|e| {
        let msg = e.to_string();
        if msg.to_ascii_lowercase().contains("encrypt")
            || msg.to_ascii_lowercase().contains("password")
        {
            AppError::new(
                "PDF_PASSWORD_REQUIRED",
                "This PDF is password-protected or encrypted. Password unlocking is not supported in this version.",
            )
        } else {
            AppError::new(
                "PDF_CORRUPT_OR_INVALID",
                format!("Failed to parse PDF structure: {msg}"),
            )
        }
    })?;
    let flags = inspect_structural_flags_from_doc(&doc);
    if flags.is_encrypted {
        return Err(AppError::new(
            "PDF_PASSWORD_REQUIRED",
            "This PDF is password-protected or encrypted. Password unlocking is not supported in this version.",
        ));
    }
    let page_count = doc.get_pages().len();
    if page_count == 0 {
        return Err(AppError::new(
            "PDF_CORRUPT_OR_INVALID",
            "PDF document contains 0 pages.",
        ));
    }
    if page_count > MAX_PDF_PAGES {
        return Err(AppError::size_limit(format!(
            "PDF has {page_count} pages, exceeding the {MAX_PDF_PAGES}-page safety limit."
        )));
    }

    let display_name = canonical
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Document".to_string());

    Ok(LoadedSourceDoc {
        display_name,
        path: Some(canonical),
        doc,
        has_signatures: flags.has_signatures,
        has_acroform: flags.has_acroform,
    })
}

/// Build a clean, standalone 1-page PDF `Document` from an image file (JPEG/PNG/WebP/BMP/TIFF/WIC HEIC).
/// Applies EXIF upright orientation, composites alpha over `options.background_hex`, and centers the
/// image inside the configured page geometry.
pub fn build_image_pdf_document(
    image_path: &Path,
    options: &ImageToPdfPageOptions,
) -> Result<Document, AppError> {
    let (canonical, file_len) = validate_existing_input_file(&image_path.to_string_lossy())?;
    if file_len == 0 {
        return Err(AppError::decode_failed("Image file is empty (0 bytes)."));
    }
    if file_len > MAX_IMAGE_INPUT_BYTES {
        return Err(AppError::size_limit(format!(
            "Image exceeds the {} MiB safety limit.",
            MAX_IMAGE_INPUT_BYTES / (1024 * 1024)
        )));
    }

    let decoded = decode_image_to_display(&canonical)?;
    let fmt = decoded.format;
    let rgba = decoded.image.to_rgba8();
    let img_w = rgba.width();
    let img_h = rgba.height();
    if img_w == 0 || img_h == 0 {
        return Err(AppError::decode_failed(
            "Image has invalid zero dimensions.",
        ));
    }

    let bg = parse_hex_rgb(&options.background_hex);
    let rgb_img = composite_rgba_over_rgb(&rgba, bg);

    let use_flate = options.lossless_png_images
        && matches!(
            fmt,
            ImageFileFormat::Png | ImageFileFormat::Bmp | ImageFileFormat::Tiff
        );
    let (stream_bytes, filter_name) = if use_flate {
        let rgb_raw = rgb_img.into_raw();
        let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
        enc.write_all(&rgb_raw).map_err(|e| {
            AppError::new("IO_ERROR", format!("Zlib image compression failed: {e}"))
        })?;
        let compressed = enc
            .finish()
            .map_err(|e| AppError::new("IO_ERROR", format!("Zlib finish failed: {e}")))?;
        (compressed, "FlateDecode")
    } else {
        let quality = options.jpeg_quality.clamp(40, 100);
        let jpeg = encode_jpeg_bytes(&rgb_img, quality, false, None)?;
        (jpeg, "DCTDecode")
    };

    let (page_w_pt, page_h_pt, draw_x, draw_y, draw_w, draw_h) =
        compute_image_page_layout(img_w, img_h, options);

    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();

    let mut img_dict = Dictionary::new();
    img_dict.set("Type", Object::Name(b"XObject".to_vec()));
    img_dict.set("Subtype", Object::Name(b"Image".to_vec()));
    img_dict.set("Width", Object::Integer(img_w as i64));
    img_dict.set("Height", Object::Integer(img_h as i64));
    img_dict.set("ColorSpace", Object::Name(b"DeviceRGB".to_vec()));
    img_dict.set("BitsPerComponent", Object::Integer(8));
    img_dict.set("Filter", Object::Name(filter_name.as_bytes().to_vec()));
    let image_id = doc.add_object(Object::Stream(Stream::new(img_dict, stream_bytes)));

    let content_str =
        format!("q\n{draw_w:.3} 0 0 {draw_h:.3} {draw_x:.3} {draw_y:.3} cm\n/Im0 Do\nQ\n");
    let content_id = doc.add_object(Object::Stream(Stream::new(
        Dictionary::new(),
        content_str.into_bytes(),
    )));

    let mut xobjects = Dictionary::new();
    xobjects.set("Im0", Object::Reference(image_id));
    let mut resources = Dictionary::new();
    resources.set("XObject", Object::Dictionary(xobjects));

    let mut page_dict = Dictionary::new();
    page_dict.set("Type", Object::Name(b"Page".to_vec()));
    page_dict.set("Parent", Object::Reference(pages_id));
    page_dict.set(
        "MediaBox",
        Object::Array(vec![
            Object::Real(0.0),
            Object::Real(0.0),
            Object::Real(page_w_pt),
            Object::Real(page_h_pt),
        ]),
    );
    page_dict.set("Resources", Object::Dictionary(resources));
    page_dict.set("Contents", Object::Reference(content_id));
    let page_id = doc.add_object(Object::Dictionary(page_dict));

    let mut pages_dict = Dictionary::new();
    pages_dict.set("Type", Object::Name(b"Pages".to_vec()));
    pages_dict.set("Kids", Object::Array(vec![Object::Reference(page_id)]));
    pages_dict.set("Count", Object::Integer(1));
    doc.objects.insert(pages_id, Object::Dictionary(pages_dict));

    let mut catalog = Dictionary::new();
    catalog.set("Type", Object::Name(b"Catalog".to_vec()));
    catalog.set("Pages", Object::Reference(pages_id));
    let catalog_id = doc.add_object(Object::Dictionary(catalog));
    doc.trailer.set("Root", Object::Reference(catalog_id));

    Ok(doc)
}

pub fn compute_image_page_layout(
    img_w: u32,
    img_h: u32,
    options: &ImageToPdfPageOptions,
) -> (f32, f32, f32, f32, f32, f32) {
    let margin = options.margin_pt.clamp(0.0, 144.0);
    let dpi = options.assumed_dpi.clamp(72.0, 600.0);

    let (page_w, page_h) = match options.page_size {
        PdfPageSizePreset::Original => {
            let w_pt = ((img_w as f32) * 72.0 / dpi).clamp(36.0, 14_000.0);
            let h_pt = ((img_h as f32) * 72.0 / dpi).clamp(36.0, 14_000.0);
            let total_w = (w_pt + margin * 2.0).min(14_400.0);
            let total_h = (h_pt + margin * 2.0).min(14_400.0);
            match options.orientation {
                PdfPageOrientation::Portrait if total_w > total_h => (total_h, total_w),
                PdfPageOrientation::Landscape if total_h > total_w => (total_h, total_w),
                _ => (total_w, total_h),
            }
        }
        PdfPageSizePreset::A4 => {
            let (pw, ph) = (595.28f32, 841.89f32);
            match options.orientation {
                PdfPageOrientation::Portrait => (pw, ph),
                PdfPageOrientation::Landscape => (ph, pw),
                PdfPageOrientation::Auto => {
                    if img_w > img_h {
                        (ph, pw)
                    } else {
                        (pw, ph)
                    }
                }
            }
        }
        PdfPageSizePreset::Letter => {
            let (pw, ph) = (612.0f32, 792.0f32);
            match options.orientation {
                PdfPageOrientation::Portrait => (pw, ph),
                PdfPageOrientation::Landscape => (ph, pw),
                PdfPageOrientation::Auto => {
                    if img_w > img_h {
                        (ph, pw)
                    } else {
                        (pw, ph)
                    }
                }
            }
        }
    };

    let avail_w = (page_w - margin * 2.0).max(16.0);
    let avail_h = (page_h - margin * 2.0).max(16.0);
    let scale = (avail_w / img_w as f32).min(avail_h / img_h as f32);
    let draw_w = (img_w as f32 * scale).max(1.0);
    let draw_h = (img_h as f32 * scale).max(1.0);
    let draw_x = (page_w - draw_w) * 0.5;
    let draw_y = (page_h - draw_h) * 0.5;
    (page_w, page_h, draw_x, draw_y, draw_w, draw_h)
}

pub fn detect_image_format(bytes: &[u8], ext: &str) -> Result<ImageFileFormat, AppError> {
    if bytes.len() >= 8 && &bytes[0..8] == b"\x89PNG\r\n\x1a\n" {
        return Ok(ImageFileFormat::Png);
    }
    if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return Ok(ImageFileFormat::Jpeg);
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Ok(ImageFileFormat::Webp);
    }
    if bytes.len() >= 2 && &bytes[0..2] == b"BM" {
        return Ok(ImageFileFormat::Bmp);
    }
    if bytes.len() >= 4
        && (&bytes[0..4] == b"II*\x00" || &bytes[0..4] == b"MM\x00*" || &bytes[0..4] == b"II+\x00")
    {
        return Ok(ImageFileFormat::Tiff);
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        let brand = &bytes[8..12];
        if matches!(
            brand,
            b"heic" | b"heix" | b"hevc" | b"hevx" | b"mif1" | b"msf1" | b"heif"
        ) {
            return Ok(ImageFileFormat::Heic);
        }
    }
    match ext {
        "png" => Ok(ImageFileFormat::Png),
        "jpg" | "jpeg" => Ok(ImageFileFormat::Jpeg),
        "webp" => Ok(ImageFileFormat::Webp),
        "bmp" => Ok(ImageFileFormat::Bmp),
        "tif" | "tiff" => Ok(ImageFileFormat::Tiff),
        "heic" | "heif" => Ok(ImageFileFormat::Heic),
        _ => Err(AppError::decode_failed(
            "Unsupported image format for PDF creation (supported: PNG, JPEG, WebP, BMP, TIFF, HEIC).",
        )),
    }
}

pub fn is_probably_pdf_file(path: &Path) -> bool {
    if let Ok(mut f) = std::fs::File::open(path) {
        use std::io::Read;
        let mut head = [0u8; 16];
        if let Ok(n) = f.read(&mut head) {
            if head[..n].windows(5).any(|w| w == b"%PDF-") {
                return true;
            }
        }
    }
    path.extension()
        .map(|e| e.to_string_lossy().eq_ignore_ascii_case("pdf"))
        .unwrap_or(false)
}

/// Resolve inherited `/Pages` attributes (`/MediaBox`, `/CropBox`, `/Resources`, `/Rotate`) onto a page dict.
fn materialize_inherited_page_attrs(
    doc: &Document,
    page_id: ObjectId,
) -> Result<Dictionary, AppError> {
    let base_dict = doc
        .get_dictionary(page_id)
        .map_err(|_| {
            AppError::new(
                "PDF_PAGE_ERROR",
                "Unable to read source PDF page dictionary.",
            )
        })?
        .clone();

    let mut result = base_dict.clone();
    let inheritable: [&[u8]; 4] = [b"MediaBox", b"CropBox", b"Resources", b"Rotate"];

    let mut current_parent = base_dict
        .get(b"Parent")
        .ok()
        .and_then(|o| o.as_reference().ok());
    let mut visited = HashSet::new();
    visited.insert(page_id);

    while let Some(parent_id) = current_parent {
        if !visited.insert(parent_id) {
            break;
        }
        let Ok(parent_dict) = doc.get_dictionary(parent_id) else {
            break;
        };
        for key in inheritable {
            if result.get(key).is_err() {
                if let Ok(val) = parent_dict.get(key) {
                    result.set(key.to_vec(), val.clone());
                }
            }
        }
        current_parent = parent_dict
            .get(b"Parent")
            .ok()
            .and_then(|o| o.as_reference().ok());
    }

    if result.get(b"MediaBox").is_err() {
        result.set(
            "MediaBox",
            Object::Array(vec![
                Object::Real(0.0),
                Object::Real(0.0),
                Object::Real(595.28),
                Object::Real(841.89),
            ]),
        );
    }

    Ok(result)
}

fn collect_named_destinations(doc: &Document) -> HashMap<Vec<u8>, ObjectId> {
    let mut map = HashMap::new();
    let Ok(catalog) = doc.catalog() else {
        return map;
    };

    // 1. Legacy Catalog /Dests dictionary
    if let Ok(dests_obj) = catalog.get(b"Dests") {
        if let Some(dict) = resolve_object_to_dict(doc, dests_obj) {
            for (name, val) in dict.iter() {
                if let Some((page_id, _)) = extract_dest_page_id(doc, val, None) {
                    map.insert(name.clone(), page_id);
                }
            }
        }
    }

    // 2. Modern Catalog /Names -> /Dests name tree
    if let Ok(names_obj) = catalog.get(b"Names") {
        if let Some(names_dict) = resolve_object_to_dict(doc, names_obj) {
            if let Ok(dests_tree) = names_dict.get(b"Dests") {
                let mut visited = HashSet::new();
                walk_name_tree_dests(doc, dests_tree, &mut visited, &mut map);
            }
        }
    }

    map
}

fn walk_name_tree_dests(
    doc: &Document,
    node_obj: &Object,
    visited: &mut HashSet<ObjectId>,
    out: &mut HashMap<Vec<u8>, ObjectId>,
) {
    if out.len() >= 4_000 {
        return;
    }
    if let Object::Reference(id) = node_obj {
        if !visited.insert(*id) {
            return;
        }
    }
    let Some(dict) = resolve_object_to_dict(doc, node_obj) else {
        return;
    };
    if let Ok(names_arr) = dict.get(b"Names").and_then(Object::as_array) {
        let mut i = 0;
        while i + 1 < names_arr.len() {
            if let Ok(key_bytes) = names_arr[i].as_str() {
                if let Some((page_id, _)) = extract_dest_page_id(doc, &names_arr[i + 1], None) {
                    out.insert(key_bytes.to_vec(), page_id);
                }
            }
            i += 2;
        }
    }
    if let Ok(kids_arr) = dict.get(b"Kids").and_then(Object::as_array) {
        for kid in kids_arr {
            walk_name_tree_dests(doc, kid, visited, out);
        }
    }
}

fn resolve_object_to_dict<'a>(doc: &'a Document, obj: &'a Object) -> Option<&'a Dictionary> {
    match obj {
        Object::Dictionary(d) => Some(d),
        Object::Reference(id) => doc.get_object(*id).ok().and_then(|o| o.as_dict().ok()),
        _ => None,
    }
}

fn resolve_object<'a>(doc: &'a Document, obj: &'a Object) -> Option<&'a Object> {
    let mut current = obj;
    for _ in 0..8 {
        match current {
            Object::Reference(id) => {
                current = doc.get_object(*id).ok()?;
            }
            other => return Some(other),
        }
    }
    None
}

fn extract_dest_page_id(
    doc: &Document,
    dest_obj: &Object,
    named_dests: Option<&HashMap<Vec<u8>, ObjectId>>,
) -> Option<(ObjectId, Vec<Object>)> {
    let resolved = resolve_object(doc, dest_obj)?;
    match resolved {
        Object::Array(arr) => {
            let page_id = arr.first()?.as_reference().ok()?;
            let tail = arr[1..].to_vec();
            Some((page_id, tail))
        }
        Object::Dictionary(d) => {
            let inner = d.get(b"D").ok()?;
            extract_dest_page_id(doc, inner, named_dests)
        }
        Object::String(bytes, _) => {
            let map = named_dests?;
            let page_id = *map.get(bytes)?;
            Some((page_id, vec![Object::Name(b"Fit".to_vec())]))
        }
        Object::Name(bytes) => {
            let map = named_dests?;
            let page_id = *map.get(bytes)?;
            Some((page_id, vec![Object::Name(b"Fit".to_vec())]))
        }
        _ => None,
    }
}

fn extract_source_outlines(
    doc: &Document,
    named_dests: &HashMap<Vec<u8>, ObjectId>,
) -> Vec<SourceOutlineNode> {
    let Ok(catalog) = doc.catalog() else {
        return Vec::new();
    };
    let Ok(outlines_ref) = catalog.get(b"Outlines") else {
        return Vec::new();
    };
    let Some(outlines_dict) = resolve_object_to_dict(doc, outlines_ref) else {
        return Vec::new();
    };
    let Ok(first_id) = outlines_dict.get(b"First").and_then(Object::as_reference) else {
        return Vec::new();
    };
    let mut visited = HashSet::new();
    let mut count = 0usize;
    read_outline_siblings(doc, first_id, named_dests, 0, &mut visited, &mut count)
}

fn read_outline_siblings(
    doc: &Document,
    start_id: ObjectId,
    named_dests: &HashMap<Vec<u8>, ObjectId>,
    depth: usize,
    visited: &mut HashSet<ObjectId>,
    count: &mut usize,
) -> Vec<SourceOutlineNode> {
    if depth >= 16 || *count >= MAX_OUTLINE_NODES {
        return Vec::new();
    }
    let mut nodes = Vec::new();
    let mut curr = Some(start_id);
    while let Some(id) = curr {
        if *count >= MAX_OUTLINE_NODES || !visited.insert(id) {
            break;
        }
        let Ok(dict) = doc.get_dictionary(id) else {
            break;
        };
        *count += 1;

        let title = dict
            .get(b"Title")
            .ok()
            .and_then(|o| resolve_object(doc, o))
            .and_then(|o| o.as_str().ok())
            .map(decode_pdf_string)
            .unwrap_or_default();

        let mut target_page_id = dict
            .get(b"Dest")
            .ok()
            .and_then(|d| extract_dest_page_id(doc, d, Some(named_dests)))
            .map(|(pid, _)| pid);

        if target_page_id.is_none() {
            if let Ok(act_obj) = dict.get(b"A") {
                if let Some(act_dict) = resolve_object_to_dict(doc, act_obj) {
                    let is_goto = act_dict
                        .get(b"S")
                        .and_then(Object::as_name)
                        .map(|n| n == b"GoTo")
                        .unwrap_or(false);
                    if is_goto {
                        target_page_id = act_dict
                            .get(b"D")
                            .ok()
                            .and_then(|d| extract_dest_page_id(doc, d, Some(named_dests)))
                            .map(|(pid, _)| pid);
                    }
                }
            }
        }

        let children = match dict.get(b"First").and_then(Object::as_reference) {
            Ok(child_id) => {
                read_outline_siblings(doc, child_id, named_dests, depth + 1, visited, count)
            }
            Err(_) => Vec::new(),
        };

        if !title.is_empty() || !children.is_empty() {
            nodes.push(SourceOutlineNode {
                title: if title.is_empty() {
                    "Untitled".to_string()
                } else {
                    title
                },
                target_page_id,
                children,
            });
        }

        curr = dict.get(b"Next").and_then(Object::as_reference).ok();
    }
    nodes
}

struct ObjectCloner<'a> {
    src: &'a Document,
    dst: &'a mut Document,
    visited: HashMap<ObjectId, ObjectId>,
    blocked_page_ids: &'a HashSet<ObjectId>,
}

impl<'a> ObjectCloner<'a> {
    fn clone_object(&mut self, obj: &Object, depth: usize) -> Object {
        if depth > MAX_CLONE_DEPTH {
            return Object::Null;
        }
        match obj {
            Object::Reference(old_id) => {
                // Never pull sibling pages or PageTree roots inadvertently when cloning page resources
                if self.blocked_page_ids.contains(old_id) {
                    return Object::Null;
                }
                if let Some(&mapped) = self.visited.get(old_id) {
                    return Object::Reference(mapped);
                }
                let Ok(src_obj) = self.src.get_object(*old_id) else {
                    return Object::Null;
                };
                // Guard against accidentally following /Pages or /Catalog nodes
                if let Object::Dictionary(d) = src_obj {
                    if let Ok(ty) = d.get(b"Type").and_then(Object::as_name) {
                        if ty == b"Pages" || ty == b"Catalog" || ty == b"Page" {
                            return Object::Null;
                        }
                    }
                }
                let new_id = self.dst.new_object_id();
                self.visited.insert(*old_id, new_id);
                let cloned = self.clone_object(src_obj, depth + 1);
                self.dst.objects.insert(new_id, cloned);
                Object::Reference(new_id)
            }
            Object::Array(items) => {
                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    out.push(self.clone_object(item, depth + 1));
                }
                Object::Array(out)
            }
            Object::Dictionary(dict) => {
                let mut out = Dictionary::new();
                for (k, v) in dict.iter() {
                    // Omit cross-tree back-references that drag entire source document graphs
                    if k == b"Parent" || k == b"StructTreeRoot" || k == b"StructParents" {
                        continue;
                    }
                    out.set(k.clone(), self.clone_object(v, depth + 1));
                }
                Object::Dictionary(out)
            }
            Object::Stream(stream) => {
                let mut out_dict = Dictionary::new();
                for (k, v) in stream.dict.iter() {
                    if k == b"Parent" {
                        continue;
                    }
                    out_dict.set(k.clone(), self.clone_object(v, depth + 1));
                }
                Object::Stream(Stream::new(out_dict, stream.content.clone()))
            }
            primitive => primitive.clone(),
        }
    }
}

#[derive(Debug, Clone)]
struct OutputOutlineNode {
    title: String,
    target_out_page_id: Option<ObjectId>,
    children: Vec<OutputOutlineNode>,
}

fn remap_outline_nodes(
    nodes: &[SourceOutlineNode],
    source_idx: usize,
    surviving_map: &HashMap<(usize, ObjectId), ObjectId>,
    summary: &mut PdfStructuralSummary,
) -> Vec<OutputOutlineNode> {
    let mut out = Vec::new();
    for node in nodes {
        let mapped_children =
            remap_outline_nodes(&node.children, source_idx, surviving_map, summary);
        let mapped_target = node
            .target_page_id
            .and_then(|old_pid| surviving_map.get(&(source_idx, old_pid)).copied());

        if let Some(target) = mapped_target {
            summary.remapped_bookmarks += 1;
            out.push(OutputOutlineNode {
                title: node.title.clone(),
                target_out_page_id: Some(target),
                children: mapped_children,
            });
        } else if !mapped_children.is_empty() {
            // Keep structural parent container pointing cleanly to first surviving child (no dangling ref!)
            let fallback_target = first_outline_target(&mapped_children);
            summary.remapped_bookmarks += 1;
            out.push(OutputOutlineNode {
                title: node.title.clone(),
                target_out_page_id: fallback_target,
                children: mapped_children,
            });
        } else if node.target_page_id.is_some() {
            summary.dropped_dangling_bookmarks += 1;
        }
    }
    out
}

fn first_outline_target(nodes: &[OutputOutlineNode]) -> Option<ObjectId> {
    for n in nodes {
        if let Some(t) = n.target_out_page_id {
            return Some(t);
        }
        if let Some(t) = first_outline_target(&n.children) {
            return Some(t);
        }
    }
    None
}

fn write_outlines_tree(doc: &mut Document, roots: &[OutputOutlineNode]) -> Option<ObjectId> {
    if roots.is_empty() {
        return None;
    }
    let outlines_id = doc.new_object_id();
    let (first_id, last_id, total_visible) = write_outline_level(doc, outlines_id, roots)?;
    let mut root_dict = Dictionary::new();
    root_dict.set("Type", Object::Name(b"Outlines".to_vec()));
    root_dict.set("First", Object::Reference(first_id));
    root_dict.set("Last", Object::Reference(last_id));
    root_dict.set("Count", Object::Integer(total_visible as i64));
    doc.objects
        .insert(outlines_id, Object::Dictionary(root_dict));
    Some(outlines_id)
}

fn write_outline_level(
    doc: &mut Document,
    parent_id: ObjectId,
    nodes: &[OutputOutlineNode],
) -> Option<(ObjectId, ObjectId, usize)> {
    if nodes.is_empty() {
        return None;
    }
    let ids: Vec<ObjectId> = (0..nodes.len()).map(|_| doc.new_object_id()).collect();
    let mut total_count = nodes.len();

    for (idx, node) in nodes.iter().enumerate() {
        let my_id = ids[idx];
        let mut dict = Dictionary::new();
        dict.set("Title", encode_pdf_unicode_string(&node.title));
        dict.set("Parent", Object::Reference(parent_id));
        if idx > 0 {
            dict.set("Prev", Object::Reference(ids[idx - 1]));
        }
        if idx + 1 < ids.len() {
            dict.set("Next", Object::Reference(ids[idx + 1]));
        }
        if let Some(target_page_id) = node.target_out_page_id {
            dict.set(
                "Dest",
                Object::Array(vec![
                    Object::Reference(target_page_id),
                    Object::Name(b"Fit".to_vec()),
                ]),
            );
        }
        if let Some((c_first, c_last, c_count)) = write_outline_level(doc, my_id, &node.children) {
            dict.set("First", Object::Reference(c_first));
            dict.set("Last", Object::Reference(c_last));
            dict.set("Count", Object::Integer(c_count as i64));
            total_count += c_count;
        }
        doc.objects.insert(my_id, Object::Dictionary(dict));
    }

    Some((*ids.first()?, *ids.last()?, total_count))
}

/// Vector-preserving structural PDF assembly from any sequence of `(source_idx, 1-based page, extra_rotation_cw)`.
pub fn assemble_pdf_from_plan(
    sources: &[LoadedSourceDoc],
    plan: &[PlannedPageRef],
    options: &AssembleOptions,
    cancel_flag: &AtomicBool,
    mut on_page: impl FnMut(usize, usize),
) -> Result<(Document, PdfStructuralSummary), AppError> {
    if plan.is_empty() {
        return Err(AppError::invalid_param(
            "Output PDF must contain at least 1 page.",
        ));
    }
    if plan.len() > MAX_PDF_PAGES {
        return Err(AppError::size_limit(format!(
            "Output PDF has {} pages, exceeding the {MAX_PDF_PAGES}-page safety limit.",
            plan.len()
        )));
    }

    let mut summary = PdfStructuralSummary::default();
    let mut source_page_maps: Vec<BTreeMap<u32, ObjectId>> = Vec::with_capacity(sources.len());
    let mut source_page_id_sets: Vec<HashSet<ObjectId>> = Vec::with_capacity(sources.len());
    let mut source_named_dests: Vec<HashMap<Vec<u8>, ObjectId>> = Vec::with_capacity(sources.len());
    let mut source_outlines: Vec<Vec<SourceOutlineNode>> = Vec::with_capacity(sources.len());

    let mut used_sources: HashSet<usize> = HashSet::new();
    for item in plan {
        used_sources.insert(item.source_idx);
    }

    for (idx, src) in sources.iter().enumerate() {
        let pages_map = src.doc.get_pages();
        let id_set: HashSet<ObjectId> = pages_map.values().copied().collect();
        let named = collect_named_destinations(&src.doc);
        let outlines = if options.preserve_source_outlines {
            extract_source_outlines(&src.doc, &named)
        } else {
            Vec::new()
        };
        if used_sources.contains(&idx) {
            if src.has_signatures {
                summary
                    .signature_invalidated_sources
                    .push(src.display_name.clone());
            }
            if src.has_acroform {
                summary
                    .acroform_simplified_sources
                    .push(src.display_name.clone());
            }
        }
        source_page_maps.push(pages_map);
        source_page_id_sets.push(id_set);
        source_named_dests.push(named);
        source_outlines.push(outlines);
    }

    let mut out_doc = Document::with_version("1.6");
    let out_pages_id = out_doc.new_object_id();
    let mut out_page_ids: Vec<ObjectId> = Vec::with_capacity(plan.len());

    // Preserve shared fonts/XObjects per source document across cloned pages!
    let mut per_source_visited: Vec<HashMap<ObjectId, ObjectId>> =
        (0..sources.len()).map(|_| HashMap::new()).collect();
    let mut surviving_page_map: HashMap<(usize, ObjectId), ObjectId> = HashMap::new();
    let mut first_out_page_per_source: HashMap<usize, ObjectId> = HashMap::new();
    let mut pending_internal_links: Vec<PendingInternalLink> = Vec::new();

    for (idx, step) in plan.iter().enumerate() {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(AppError::cancelled());
        }
        let src = sources.get(step.source_idx).ok_or_else(|| {
            AppError::invalid_param("Invalid source document reference in PDF plan.")
        })?;
        let old_page_id = *source_page_maps[step.source_idx]
            .get(&(step.source_page_1based as u32))
            .ok_or_else(|| {
                AppError::invalid_param(format!(
                    "Page {} is out of bounds in source '{}'.",
                    step.source_page_1based, src.display_name
                ))
            })?;

        let materialized = materialize_inherited_page_attrs(&src.doc, old_page_id)?;
        let out_page_id = out_doc.new_object_id();

        let mut new_page_dict = Dictionary::new();
        let mut new_annots_refs: Vec<Object> = Vec::new();

        {
            let mut visited_map = std::mem::take(&mut per_source_visited[step.source_idx]);
            let mut cloner = ObjectCloner {
                src: &src.doc,
                dst: &mut out_doc,
                visited: visited_map,
                blocked_page_ids: &source_page_id_sets[step.source_idx],
            };

            for (key, val) in materialized.iter() {
                if key == b"Parent"
                    || key == b"Annots"
                    || key == b"StructParents"
                    || key == b"B"
                    || key == b"Rotate"
                {
                    continue;
                }
                new_page_dict.set(key.clone(), cloner.clone_object(val, 0));
            }

            // Handle /Annots carefully: preserve external URI links, defer internal GoTo/Dest links,
            // strip invalid digital signature values, and rewrite /P to the new page ID.
            if let Ok(annots_obj) = materialized.get(b"Annots") {
                if let Some(Object::Array(annots_arr)) = resolve_object(&src.doc, annots_obj) {
                    for annot_item in annots_arr {
                        let Some(annot_dict) = resolve_object_to_dict(&src.doc, annot_item) else {
                            continue;
                        };
                        let subtype = annot_dict
                            .get(b"Subtype")
                            .and_then(Object::as_name)
                            .unwrap_or(b"");

                        // Strip signature widgets' invalid cryptographic /V dictionaries
                        let is_sig_widget = subtype == b"Widget"
                            && annot_dict
                                .get(b"FT")
                                .and_then(Object::as_name)
                                .map(|n| n == b"Sig")
                                .unwrap_or(false);
                        if is_sig_widget {
                            continue;
                        }

                        if subtype == b"Link" {
                            // Inspect external URI vs internal GoTo / Dest
                            let mut handled_link = false;

                            if let Ok(dest_obj) = annot_dict.get(b"Dest") {
                                if let Some((target_old_pid, tail)) = extract_dest_page_id(
                                    &src.doc,
                                    dest_obj,
                                    Some(&source_named_dests[step.source_idx]),
                                ) {
                                    let mut cloned_annot =
                                        clone_annot_base(&mut cloner, annot_dict, out_page_id);
                                    cloned_annot.remove(b"Dest");
                                    cloned_annot.remove(b"A");
                                    let annot_id =
                                        cloner.dst.add_object(Object::Dictionary(cloned_annot));
                                    new_annots_refs.push(Object::Reference(annot_id));
                                    pending_internal_links.push(PendingInternalLink {
                                        source_idx: step.source_idx,
                                        out_page_id,
                                        annot_id,
                                        target_old_page_id: target_old_pid,
                                        dest_tail: tail,
                                        is_action_goto: false,
                                    });
                                    handled_link = true;
                                } else {
                                    // Unresolvable internal dest -> drop to prevent dangling link
                                    summary.dropped_dangling_links += 1;
                                    handled_link = true;
                                }
                            } else if let Ok(act_obj) = annot_dict.get(b"A") {
                                if let Some(act_dict) = resolve_object_to_dict(&src.doc, act_obj) {
                                    let act_s =
                                        act_dict.get(b"S").and_then(Object::as_name).unwrap_or(b"");
                                    if act_s == b"URI" {
                                        let mut cloned_annot =
                                            clone_annot_base(&mut cloner, annot_dict, out_page_id);
                                        cloned_annot.set("A", cloner.clone_object(act_obj, 0));
                                        let annot_id =
                                            cloner.dst.add_object(Object::Dictionary(cloned_annot));
                                        new_annots_refs.push(Object::Reference(annot_id));
                                        summary.preserved_external_links += 1;
                                        handled_link = true;
                                    } else if act_s == b"GoTo" {
                                        if let Some((target_old_pid, tail)) =
                                            act_dict.get(b"D").ok().and_then(|d| {
                                                extract_dest_page_id(
                                                    &src.doc,
                                                    d,
                                                    Some(&source_named_dests[step.source_idx]),
                                                )
                                            })
                                        {
                                            let mut cloned_annot = clone_annot_base(
                                                &mut cloner,
                                                annot_dict,
                                                out_page_id,
                                            );
                                            cloned_annot.remove(b"Dest");
                                            cloned_annot.remove(b"A");
                                            let annot_id = cloner
                                                .dst
                                                .add_object(Object::Dictionary(cloned_annot));
                                            new_annots_refs.push(Object::Reference(annot_id));
                                            pending_internal_links.push(PendingInternalLink {
                                                source_idx: step.source_idx,
                                                out_page_id,
                                                annot_id,
                                                target_old_page_id: target_old_pid,
                                                dest_tail: tail,
                                                is_action_goto: true,
                                            });
                                            handled_link = true;
                                        } else {
                                            summary.dropped_dangling_links += 1;
                                            handled_link = true;
                                        }
                                    }
                                }
                            }

                            if !handled_link {
                                // Non-URI / non-GoTo link (e.g. Launch/JavaScript) omitted cleanly
                                summary.dropped_dangling_links += 1;
                            }
                        } else {
                            // Preserve non-link annotations (highlights, notes, stamps, etc.) cleanly
                            let cloned_annot =
                                clone_annot_base(&mut cloner, annot_dict, out_page_id);
                            let annot_id = cloner.dst.add_object(Object::Dictionary(cloned_annot));
                            new_annots_refs.push(Object::Reference(annot_id));
                        }
                    }
                }
            }

            visited_map = cloner.visited;
            per_source_visited[step.source_idx] = visited_map;
        }

        // Compute normalized final rotation (inherent + extra_rotation_cw)
        let inherent_rot = materialized
            .get(b"Rotate")
            .and_then(Object::as_i64)
            .unwrap_or(0)
            .rem_euclid(360) as u16;
        let final_rot = (inherent_rot + (step.extra_rotation_cw % 360)) % 360;
        if final_rot != 0 {
            new_page_dict.set("Rotate", Object::Integer(final_rot as i64));
        }

        new_page_dict.set("Type", Object::Name(b"Page".to_vec()));
        new_page_dict.set("Parent", Object::Reference(out_pages_id));
        if !new_annots_refs.is_empty() {
            new_page_dict.set("Annots", Object::Array(new_annots_refs));
        }

        out_doc
            .objects
            .insert(out_page_id, Object::Dictionary(new_page_dict));
        out_page_ids.push(out_page_id);
        surviving_page_map
            .entry((step.source_idx, old_page_id))
            .or_insert(out_page_id);
        first_out_page_per_source
            .entry(step.source_idx)
            .or_insert(out_page_id);

        on_page(idx + 1, plan.len());
    }

    // Pass 2: Remap internal links to surviving pages; drop links whose target page was removed
    let mut dropped_annots_by_page: HashMap<ObjectId, HashSet<ObjectId>> = HashMap::new();
    for link in pending_internal_links {
        if let Some(&target_new_pid) =
            surviving_page_map.get(&(link.source_idx, link.target_old_page_id))
        {
            let mut dest_arr = Vec::with_capacity(1 + link.dest_tail.len());
            dest_arr.push(Object::Reference(target_new_pid));
            if link.dest_tail.is_empty() {
                dest_arr.push(Object::Name(b"Fit".to_vec()));
            } else {
                for item in link.dest_tail {
                    // Only keep safe primitive/name dest parameters (never raw foreign refs)
                    if !matches!(item, Object::Reference(_)) {
                        dest_arr.push(item);
                    }
                }
            }
            if let Ok(Object::Dictionary(annot_dict)) = out_doc.get_object_mut(link.annot_id) {
                if link.is_action_goto {
                    let mut act = Dictionary::new();
                    act.set("S", Object::Name(b"GoTo".to_vec()));
                    act.set("D", Object::Array(dest_arr));
                    annot_dict.set("A", Object::Dictionary(act));
                } else {
                    annot_dict.set("Dest", Object::Array(dest_arr));
                }
            }
            summary.remapped_internal_links += 1;
        } else {
            out_doc.objects.remove(&link.annot_id);
            dropped_annots_by_page
                .entry(link.out_page_id)
                .or_default()
                .insert(link.annot_id);
            summary.dropped_dangling_links += 1;
        }
    }

    for (page_id, dropped_ids) in dropped_annots_by_page {
        if let Ok(Object::Dictionary(pdict)) = out_doc.get_object_mut(page_id) {
            if let Ok(Object::Array(arr)) = pdict.get_mut(b"Annots") {
                arr.retain(|item| match item {
                    Object::Reference(id) => !dropped_ids.contains(id),
                    _ => true,
                });
                if arr.is_empty() {
                    pdict.remove(b"Annots");
                }
            }
        }
    }

    // Pass 3: Remap bookmarks (/Outlines) and optionally wrap each source file in a top-level bookmark
    let mut final_outlines: Vec<OutputOutlineNode> = Vec::new();
    let mut seen_source_order: Vec<usize> = Vec::new();
    for step in plan {
        if !seen_source_order.contains(&step.source_idx) {
            seen_source_order.push(step.source_idx);
        }
    }
    for src_idx in seen_source_order {
        let mapped_src_outlines = if options.preserve_source_outlines {
            remap_outline_nodes(
                &source_outlines[src_idx],
                src_idx,
                &surviving_page_map,
                &mut summary,
            )
        } else {
            Vec::new()
        };

        if options.add_filename_bookmarks {
            if let Some(&first_pid) = first_out_page_per_source.get(&src_idx) {
                final_outlines.push(OutputOutlineNode {
                    title: sources[src_idx].display_name.clone(),
                    target_out_page_id: Some(first_pid),
                    children: mapped_src_outlines,
                });
            }
        } else {
            final_outlines.extend(mapped_src_outlines);
        }
    }

    let outlines_root_id = write_outlines_tree(&mut out_doc, &final_outlines);

    // Pass 4: Assemble clean /Pages, /Catalog, and /Info
    let mut pages_dict = Dictionary::new();
    pages_dict.set("Type", Object::Name(b"Pages".to_vec()));
    pages_dict.set(
        "Kids",
        Object::Array(
            out_page_ids
                .iter()
                .copied()
                .map(Object::Reference)
                .collect(),
        ),
    );
    pages_dict.set("Count", Object::Integer(out_page_ids.len() as i64));
    out_doc
        .objects
        .insert(out_pages_id, Object::Dictionary(pages_dict));

    let mut catalog = Dictionary::new();
    catalog.set("Type", Object::Name(b"Catalog".to_vec()));
    catalog.set("Pages", Object::Reference(out_pages_id));
    if let Some(oid) = outlines_root_id {
        catalog.set("Outlines", Object::Reference(oid));
        catalog.set("PageMode", Object::Name(b"UseOutlines".to_vec()));
    }
    let catalog_id = out_doc.add_object(Object::Dictionary(catalog));
    out_doc.trailer.set("Root", Object::Reference(catalog_id));

    let mut info = Dictionary::new();
    info.set("Producer", encode_pdf_unicode_string("WinKit PDF Engine"));
    let info_id = out_doc.add_object(Object::Dictionary(info));
    out_doc.trailer.set("Info", Object::Reference(info_id));

    Ok((out_doc, summary))
}

fn clone_annot_base(
    cloner: &mut ObjectCloner<'_>,
    annot_dict: &Dictionary,
    new_page_id: ObjectId,
) -> Dictionary {
    let mut cloned = Dictionary::new();
    for (k, v) in annot_dict.iter() {
        if k == b"P" || k == b"Parent" || k == b"Popup" || k == b"Dest" || k == b"A" {
            continue;
        }
        cloned.set(k.clone(), cloner.clone_object(v, 0));
    }
    cloned.set("P", Object::Reference(new_page_id));
    cloned
}

pub fn serialize_pdf_document(doc: &mut Document) -> Result<Vec<u8>, AppError> {
    doc.compress();
    let mut buf = Vec::new();
    doc.save_to(&mut buf).map_err(|e| {
        AppError::new(
            "PDF_WRITE_FAILED",
            format!("Failed to serialize output PDF document: {e}"),
        )
    })?;
    Ok(buf)
}

/// P07: Merge multiple PDFs (and optionally image files) in user order into a single new PDF.
pub fn merge_pdfs_impl(
    req: &MergePdfsRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(PdfTaskProgressPayload),
) -> Result<MergePdfsResult, AppError> {
    if req.inputs.len() < 2 {
        return Err(AppError::invalid_param(
            "Select at least 2 files (PDF or images) to merge.",
        ));
    }
    let task_id = req
        .task_id
        .clone()
        .unwrap_or_else(|| "pdf-merge".to_string());
    let img_opts = req.image_options.clone().unwrap_or_default();

    let mut sources: Vec<LoadedSourceDoc> = Vec::with_capacity(req.inputs.len());
    let mut forbidden_sources: Vec<PathBuf> = Vec::with_capacity(req.inputs.len());
    let mut plan: Vec<PlannedPageRef> = Vec::new();
    let mut pdf_source_count = 0usize;
    let mut image_source_count = 0usize;

    for (idx, item) in req.inputs.iter().enumerate() {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(AppError::cancelled());
        }
        let (canonical, _) = validate_existing_input_file(&item.path)?;
        forbidden_sources.push(canonical.clone());

        let is_pdf = match item.kind.as_deref() {
            Some("pdf") => true,
            Some("image") => false,
            _ => is_probably_pdf_file(&canonical),
        };

        let loaded = if is_pdf {
            pdf_source_count += 1;
            load_pdf_for_editing(&canonical)?
        } else {
            image_source_count += 1;
            let doc = build_image_pdf_document(&canonical, &img_opts)?;
            let display_name = canonical
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| format!("Image {}", idx + 1));
            LoadedSourceDoc {
                display_name,
                path: Some(canonical.clone()),
                doc,
                has_signatures: false,
                has_acroform: false,
            }
        };

        let page_count = loaded.doc.get_pages().len();
        let src_idx = sources.len();
        sources.push(loaded);
        for p in 1..=page_count {
            plan.push(PlannedPageRef {
                source_idx: src_idx,
                source_page_1based: p,
                extra_rotation_cw: 0,
            });
        }

        on_progress(PdfTaskProgressPayload {
            task_id: task_id.clone(),
            tool_id: "P07".to_string(),
            current: idx + 1,
            total: req.inputs.len(),
            percent: ((idx + 1) as f64 / req.inputs.len() as f64) * 35.0,
            detail: format!("Loaded {}/{}", idx + 1, req.inputs.len()),
        });
    }

    let staged = AtomicPdfOutput::prepare(
        &req.output_path,
        &forbidden_sources,
        req.overwrite.unwrap_or(false),
    )?;

    let total_pages = plan.len();
    let (mut out_doc, summary) = assemble_pdf_from_plan(
        &sources,
        &plan,
        &AssembleOptions {
            add_filename_bookmarks: req.add_filename_bookmarks,
            preserve_source_outlines: true,
        },
        cancel_flag,
        |done, total| {
            let pct = 35.0 + (done as f64 / total.max(1) as f64) * 55.0;
            on_progress(PdfTaskProgressPayload {
                task_id: task_id.clone(),
                tool_id: "P07".to_string(),
                current: done,
                total,
                percent: pct,
                detail: format!("Assembling page {done}/{total}"),
            });
        },
    )?;

    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let bytes = serialize_pdf_document(&mut out_doc)?;
    let (final_path, byte_length) = staged.write_and_commit(&bytes)?;

    let mut warnings = Vec::new();
    if !summary.signature_invalidated_sources.is_empty() {
        warnings.push(format!(
            "Original digital signatures were invalidated and stripped from merged output for: {}.",
            summary.signature_invalidated_sources.join(", ")
        ));
    }
    if !summary.acroform_simplified_sources.is_empty() {
        warnings.push(format!(
            "Interactive AcroForm trees were simplified in merged output for: {} (page appearance preserved).",
            summary.acroform_simplified_sources.join(", ")
        ));
    }

    on_progress(PdfTaskProgressPayload {
        task_id,
        tool_id: "P07".to_string(),
        current: total_pages,
        total: total_pages,
        percent: 100.0,
        detail: "Completed".to_string(),
    });

    Ok(MergePdfsResult {
        output_path: final_path.to_string_lossy().into_owned(),
        byte_length,
        total_pages,
        source_count: sources.len(),
        pdf_source_count,
        image_source_count,
        summary,
        warnings,
    })
}

/// P08 upfront validator & output filename/page preview.
pub fn preview_split_pdf_plan_impl(
    req: &SplitPdfPlanRequest,
) -> Result<SplitPdfPlanPreview, AppError> {
    let loaded = load_pdf_for_editing(Path::new(&req.path))?;
    let total_pages = loaded.doc.get_pages().len();
    let stem = loaded.display_name.clone();
    let out_dir = req
        .output_dir
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let pad_width = total_pages.to_string().len().max(2);

    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let mut parts: Vec<Vec<usize>> = Vec::new();

    if loaded.has_signatures {
        warnings.push(
            "Source PDF contains digital signatures; split outputs will not preserve original signatures."
                .to_string(),
        );
    }

    match req.mode {
        PdfSplitMode::EveryPage => {
            for p in 1..=total_pages {
                parts.push(vec![p]);
            }
        }
        PdfSplitMode::EveryNPages => {
            let n = req.chunk_size.unwrap_or(1);
            if n == 0 || n > total_pages {
                errors.push(format!(
                    "Pages per split file must be between 1 and {total_pages}."
                ));
            } else {
                let mut start = 1usize;
                while start <= total_pages {
                    let end = (start + n - 1).min(total_pages);
                    parts.push((start..=end).collect());
                    start = end + 1;
                }
            }
        }
        PdfSplitMode::CustomRanges => {
            let raw = req.custom_ranges.as_deref().unwrap_or("").trim();
            if raw.is_empty() {
                errors.push(
                    "Enter one or more page ranges (separate output files by ';' or new lines, e.g. '1-3; 4-6; 7, 9')."
                        .to_string(),
                );
            } else {
                let normalized = raw.replace('；', ";");
                let groups: Vec<&str> = normalized
                    .split([';', '\n'])
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .collect();
                if groups.is_empty() {
                    errors.push("No valid page range groups found.".to_string());
                } else {
                    let mut across_parts_seen = HashSet::new();
                    let mut across_parts_dups = Vec::new();
                    for (g_idx, grp) in groups.iter().enumerate() {
                        match parse_page_range_spec(grp, total_pages) {
                            Ok(parsed) => {
                                if !parsed.duplicate_pages.is_empty() {
                                    warnings.push(format!(
                                        "Part {} repeats page(s): {}.",
                                        g_idx + 1,
                                        format_compact_page_list(&parsed.duplicate_pages)
                                    ));
                                }
                                for &p in &parsed.pages {
                                    if !across_parts_seen.insert(p)
                                        && !across_parts_dups.contains(&p)
                                    {
                                        across_parts_dups.push(p);
                                    }
                                }
                                parts.push(parsed.pages);
                            }
                            Err(err) => {
                                errors.push(format!("Part {}: {}", g_idx + 1, err.message));
                            }
                        }
                    }
                    if !across_parts_dups.is_empty() {
                        across_parts_dups.sort_unstable();
                        warnings.push(format!(
                            "Page(s) appear in multiple split outputs: {}.",
                            format_compact_page_list(&across_parts_dups)
                        ));
                    }
                }
            }
        }
    }

    let mut items = Vec::with_capacity(parts.len());
    let mut used_names: HashSet<String> = HashSet::new();
    let mut total_output_pages = 0usize;

    for (idx, pages) in parts.into_iter().enumerate() {
        total_output_pages += pages.len();
        let range_label = format_compact_page_list(&pages);
        let base_suffix = if pages.len() == 1 {
            format!("p{:0width$}", pages[0], width = pad_width)
        } else if pages.windows(2).all(|w| w[1] == w[0] + 1) {
            format!(
                "p{:0width$}-{:0width$}",
                pages[0],
                pages[pages.len() - 1],
                width = pad_width
            )
        } else {
            format!("part{:02}", idx + 1)
        };
        let desired = sanitize_pdf_filename(&format!("{stem}_{base_suffix}.pdf"));
        let mut final_name = desired.clone();
        let mut collision_adjusted = false;
        let desired_stem = Path::new(&desired)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| format!("part_{}", idx + 1));

        let mut suffix_n = 2usize;
        while used_names.contains(&final_name.to_ascii_lowercase())
            || out_dir
                .as_ref()
                .is_some_and(|dir| dir.join(&final_name).exists())
        {
            final_name = format!("{desired_stem}_{suffix_n}.pdf");
            collision_adjusted = true;
            suffix_n += 1;
        }
        used_names.insert(final_name.to_ascii_lowercase());

        items.push(SplitPdfPlanItem {
            part_index: idx + 1,
            file_name: final_name,
            page_count: pages.len(),
            pages,
            range_label,
            collision_adjusted,
        });
    }

    let valid = errors.is_empty() && !items.is_empty();
    Ok(SplitPdfPlanPreview {
        valid,
        source_page_count: total_pages,
        output_file_count: items.len(),
        total_output_pages,
        items,
        errors,
        warnings,
    })
}

/// P08: Execute split plan, writing non-overwriting atomic PDFs to the target folder.
pub fn split_pdf_impl(
    req: &SplitPdfRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(PdfTaskProgressPayload),
) -> Result<SplitPdfResult, AppError> {
    let plan = preview_split_pdf_plan_impl(&SplitPdfPlanRequest {
        path: req.path.clone(),
        mode: req.mode,
        chunk_size: req.chunk_size,
        custom_ranges: req.custom_ranges.clone(),
        output_dir: Some(req.output_dir.clone()),
    })?;
    if !plan.valid {
        return Err(AppError::invalid_param(
            plan.errors
                .first()
                .cloned()
                .unwrap_or_else(|| "Invalid split configuration.".to_string()),
        ));
    }

    let out_dir = crate::fs_guard::validate_user_path(&req.output_dir, "Output directory")?;
    let dir_meta = std::fs::metadata(&out_dir)
        .map_err(|e| AppError::from_io(e, "Unable to access output directory"))?;
    if !dir_meta.is_dir() {
        return Err(AppError::invalid_param(
            "Selected output location is not a valid directory.",
        ));
    }

    let loaded = load_pdf_for_editing(Path::new(&req.path))?;
    let source_path = loaded
        .path
        .clone()
        .unwrap_or_else(|| PathBuf::from(&req.path));
    let forbidden = vec![source_path];
    let sources = vec![loaded];

    let task_id = req
        .task_id
        .clone()
        .unwrap_or_else(|| "pdf-split".to_string());
    let total_files = plan.items.len();

    let mut files = Vec::with_capacity(total_files);
    let mut total_output_pages = 0usize;
    let mut total_output_bytes = 0u64;
    let mut cancelled = false;
    let mut aggregate_summary = PdfStructuralSummary::default();

    for (idx, item) in plan.items.iter().enumerate() {
        if cancel_flag.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
        let page_refs: Vec<PlannedPageRef> = item
            .pages
            .iter()
            .map(|&p| PlannedPageRef {
                source_idx: 0,
                source_page_1based: p,
                extra_rotation_cw: 0,
            })
            .collect();

        let (mut doc, part_summary) = assemble_pdf_from_plan(
            &sources,
            &page_refs,
            &AssembleOptions {
                add_filename_bookmarks: false,
                preserve_source_outlines: true,
            },
            cancel_flag,
            |_, _| {},
        )?;

        if cancel_flag.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }

        let bytes = serialize_pdf_document(&mut doc)?;
        let (staged, collision_adjusted) =
            AtomicPdfOutput::prepare_unique_in_dir(&out_dir, &item.file_name, &forbidden)?;
        let (final_path, byte_length) = staged.write_and_commit(&bytes)?;
        let actual_name = final_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| item.file_name.clone());

        aggregate_summary.preserved_external_links += part_summary.preserved_external_links;
        aggregate_summary.remapped_internal_links += part_summary.remapped_internal_links;
        aggregate_summary.dropped_dangling_links += part_summary.dropped_dangling_links;
        aggregate_summary.remapped_bookmarks += part_summary.remapped_bookmarks;
        aggregate_summary.dropped_dangling_bookmarks += part_summary.dropped_dangling_bookmarks;
        for s in part_summary.signature_invalidated_sources {
            if !aggregate_summary.signature_invalidated_sources.contains(&s) {
                aggregate_summary.signature_invalidated_sources.push(s);
            }
        }
        for s in part_summary.acroform_simplified_sources {
            if !aggregate_summary.acroform_simplified_sources.contains(&s) {
                aggregate_summary.acroform_simplified_sources.push(s);
            }
        }

        total_output_pages += item.page_count;
        total_output_bytes += byte_length;
        files.push(SplitPdfOutputFile {
            part_index: item.part_index,
            path: final_path.to_string_lossy().into_owned(),
            file_name: actual_name,
            byte_length,
            page_count: item.page_count,
            range_label: item.range_label.clone(),
            collision_adjusted: collision_adjusted || item.collision_adjusted,
        });

        on_progress(PdfTaskProgressPayload {
            task_id: task_id.clone(),
            tool_id: "P08".to_string(),
            current: idx + 1,
            total: total_files,
            percent: ((idx + 1) as f64 / total_files.max(1) as f64) * 100.0,
            detail: format!("Exported {}/{total_files}", idx + 1),
        });
    }

    Ok(SplitPdfResult {
        output_dir: out_dir.to_string_lossy().into_owned(),
        source_page_count: plan.source_page_count,
        files,
        total_output_pages,
        total_output_bytes,
        cancelled,
        summary: aggregate_summary,
        warnings: plan.warnings,
    })
}

/* ==================== P09 Organize PDF, P10 Delete Pages, P11 Extract Pages ==================== */

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizePageSpec {
    pub source_page: usize,
    pub extra_rotation_cw: u16,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizePdfRequest {
    pub task_id: Option<String>,
    pub path: String,
    pub pages: Vec<OrganizePageSpec>,
    pub output_path: String,
    pub overwrite: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizePdfResult {
    pub output_path: String,
    pub byte_length: u64,
    pub source_page_count: usize,
    pub output_page_count: usize,
    pub rotated_pages: usize,
    pub deleted_pages: usize,
    pub reordered: bool,
    pub summary: PdfStructuralSummary,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletePdfPagesRequest {
    pub task_id: Option<String>,
    pub path: String,
    pub delete_pages: Vec<usize>,
    pub output_path: String,
    pub overwrite: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletePdfPagesResult {
    pub output_path: String,
    pub byte_length: u64,
    pub source_page_count: usize,
    pub deleted_pages: Vec<usize>,
    pub kept_pages: Vec<usize>,
    pub summary: PdfStructuralSummary,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PdfExtractMode {
    SinglePdf,
    PerPagePdfs,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractPdfPagesRequest {
    pub task_id: Option<String>,
    pub path: String,
    pub pages: Vec<usize>,
    pub mode: PdfExtractMode,
    pub dedupe_and_sort: Option<bool>,
    pub output_path: Option<String>,
    pub output_dir: Option<String>,
    pub overwrite: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractPdfOutputFile {
    pub path: String,
    pub file_name: String,
    pub byte_length: u64,
    pub page_count: usize,
    pub range_label: String,
    pub collision_adjusted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractPdfPagesResult {
    pub mode: PdfExtractMode,
    pub source_page_count: usize,
    pub extracted_pages: Vec<usize>,
    pub duplicate_pages_removed: usize,
    pub files: Vec<ExtractPdfOutputFile>,
    pub total_output_bytes: u64,
    pub cancelled: bool,
    pub summary: PdfStructuralSummary,
    pub warnings: Vec<String>,
}

fn collect_structural_warnings(summary: &PdfStructuralSummary) -> Vec<String> {
    let mut warnings = Vec::new();
    if !summary.signature_invalidated_sources.is_empty() {
        warnings.push(format!(
            "Original digital signatures were invalidated and stripped from edited output for: {}.",
            summary.signature_invalidated_sources.join(", ")
        ));
    }
    if !summary.acroform_simplified_sources.is_empty() {
        warnings.push(format!(
            "Interactive AcroForm trees were simplified in edited output for: {} (page appearance preserved).",
            summary.acroform_simplified_sources.join(", ")
        ));
    }
    warnings
}

/// P09: Organize PDF pages (reorder, rotate 90/180/270°, delete) and export a new PDF.
pub fn organize_pdf_impl(
    req: &OrganizePdfRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(PdfTaskProgressPayload),
) -> Result<OrganizePdfResult, AppError> {
    if req.pages.is_empty() {
        return Err(AppError::invalid_param(
            "Output PDF must keep at least 1 page.",
        ));
    }
    let loaded = load_pdf_for_editing(Path::new(&req.path))?;
    let source_page_count = loaded.doc.get_pages().len();
    let source_path = loaded
        .path
        .clone()
        .unwrap_or_else(|| PathBuf::from(&req.path));

    let mut plan = Vec::with_capacity(req.pages.len());
    let mut kept_set = HashSet::new();
    let mut rotated_pages = 0usize;
    for spec in &req.pages {
        if spec.source_page == 0 || spec.source_page > source_page_count {
            return Err(AppError::invalid_param(format!(
                "Page {} is out of bounds (document has {source_page_count} pages).",
                spec.source_page
            )));
        }
        let norm_rot = (spec.extra_rotation_cw % 360) / 90 * 90;
        if norm_rot != 0 {
            rotated_pages += 1;
        }
        kept_set.insert(spec.source_page);
        plan.push(PlannedPageRef {
            source_idx: 0,
            source_page_1based: spec.source_page,
            extra_rotation_cw: norm_rot,
        });
    }

    let deleted_pages = source_page_count.saturating_sub(kept_set.len());
    let reordered = plan
        .windows(2)
        .any(|w| w[0].source_page_1based > w[1].source_page_1based);

    let staged = AtomicPdfOutput::prepare(
        &req.output_path,
        &[source_path],
        req.overwrite.unwrap_or(false),
    )?;
    let task_id = req
        .task_id
        .clone()
        .unwrap_or_else(|| "pdf-organize".to_string());
    let sources = vec![loaded];
    let out_count = plan.len();

    let (mut out_doc, summary) = assemble_pdf_from_plan(
        &sources,
        &plan,
        &AssembleOptions {
            add_filename_bookmarks: false,
            preserve_source_outlines: true,
        },
        cancel_flag,
        |done, total| {
            on_progress(PdfTaskProgressPayload {
                task_id: task_id.clone(),
                tool_id: "P09".to_string(),
                current: done,
                total,
                percent: (done as f64 / total.max(1) as f64) * 90.0,
                detail: format!("Organizing page {done}/{total}"),
            });
        },
    )?;

    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let bytes = serialize_pdf_document(&mut out_doc)?;
    let (final_path, byte_length) = staged.write_and_commit(&bytes)?;
    let warnings = collect_structural_warnings(&summary);

    on_progress(PdfTaskProgressPayload {
        task_id,
        tool_id: "P09".to_string(),
        current: out_count,
        total: out_count,
        percent: 100.0,
        detail: "Completed".to_string(),
    });

    Ok(OrganizePdfResult {
        output_path: final_path.to_string_lossy().into_owned(),
        byte_length,
        source_page_count,
        output_page_count: out_count,
        rotated_pages,
        deleted_pages,
        reordered,
        summary,
        warnings,
    })
}

/// P10: Delete selected pages from a PDF and export remaining pages into a new PDF.
/// Explicitly rejects deleting all pages so an empty invalid PDF can never be produced.
pub fn delete_pdf_pages_impl(
    req: &DeletePdfPagesRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(PdfTaskProgressPayload),
) -> Result<DeletePdfPagesResult, AppError> {
    if req.delete_pages.is_empty() {
        return Err(AppError::invalid_param("Select at least 1 page to delete."));
    }
    let loaded = load_pdf_for_editing(Path::new(&req.path))?;
    let source_page_count = loaded.doc.get_pages().len();
    let source_path = loaded
        .path
        .clone()
        .unwrap_or_else(|| PathBuf::from(&req.path));

    let mut delete_set = HashSet::new();
    for &p in &req.delete_pages {
        if p == 0 || p > source_page_count {
            return Err(AppError::invalid_param(format!(
                "Page {p} is out of bounds (document has {source_page_count} pages)."
            )));
        }
        delete_set.insert(p);
    }

    let mut deleted_pages: Vec<usize> = delete_set.iter().copied().collect();
    deleted_pages.sort_unstable();
    let kept_pages: Vec<usize> = (1..=source_page_count)
        .filter(|p| !delete_set.contains(p))
        .collect();

    if kept_pages.is_empty() {
        return Err(AppError::invalid_param(
            "Cannot delete all pages from a PDF; at least 1 page must remain.",
        ));
    }

    let staged = AtomicPdfOutput::prepare(
        &req.output_path,
        &[source_path],
        req.overwrite.unwrap_or(false),
    )?;
    let task_id = req
        .task_id
        .clone()
        .unwrap_or_else(|| "pdf-delete".to_string());
    let plan: Vec<PlannedPageRef> = kept_pages
        .iter()
        .map(|&p| PlannedPageRef {
            source_idx: 0,
            source_page_1based: p,
            extra_rotation_cw: 0,
        })
        .collect();
    let sources = vec![loaded];

    let (mut out_doc, summary) = assemble_pdf_from_plan(
        &sources,
        &plan,
        &AssembleOptions {
            add_filename_bookmarks: false,
            preserve_source_outlines: true,
        },
        cancel_flag,
        |done, total| {
            on_progress(PdfTaskProgressPayload {
                task_id: task_id.clone(),
                tool_id: "P10".to_string(),
                current: done,
                total,
                percent: (done as f64 / total.max(1) as f64) * 90.0,
                detail: format!("Keeping page {done}/{total}"),
            });
        },
    )?;

    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let bytes = serialize_pdf_document(&mut out_doc)?;
    let (final_path, byte_length) = staged.write_and_commit(&bytes)?;
    let warnings = collect_structural_warnings(&summary);

    on_progress(PdfTaskProgressPayload {
        task_id,
        tool_id: "P10".to_string(),
        current: kept_pages.len(),
        total: kept_pages.len(),
        percent: 100.0,
        detail: "Completed".to_string(),
    });

    Ok(DeletePdfPagesResult {
        output_path: final_path.to_string_lossy().into_owned(),
        byte_length,
        source_page_count,
        deleted_pages,
        kept_pages,
        summary,
        warnings,
    })
}

/// P11: Extract selected pages into either a single combined PDF or one PDF per selected page.
pub fn extract_pdf_pages_impl(
    req: &ExtractPdfPagesRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(PdfTaskProgressPayload),
) -> Result<ExtractPdfPagesResult, AppError> {
    if req.pages.is_empty() {
        return Err(AppError::invalid_param(
            "Select at least 1 page to extract.",
        ));
    }
    let loaded = load_pdf_for_editing(Path::new(&req.path))?;
    let source_page_count = loaded.doc.get_pages().len();
    let source_path = loaded
        .path
        .clone()
        .unwrap_or_else(|| PathBuf::from(&req.path));
    let stem = loaded.display_name.clone();

    for &p in &req.pages {
        if p == 0 || p > source_page_count {
            return Err(AppError::invalid_param(format!(
                "Page {p} is out of bounds (document has {source_page_count} pages)."
            )));
        }
    }

    let dedupe_and_sort = req.dedupe_and_sort.unwrap_or(true);
    let mut extracted_pages: Vec<usize> = Vec::with_capacity(req.pages.len());
    let mut seen = HashSet::new();
    let mut duplicate_pages_removed = 0usize;
    for &p in &req.pages {
        if dedupe_and_sort {
            if seen.insert(p) {
                extracted_pages.push(p);
            } else {
                duplicate_pages_removed += 1;
            }
        } else {
            extracted_pages.push(p);
        }
    }
    if dedupe_and_sort {
        extracted_pages.sort_unstable();
    }

    let task_id = req
        .task_id
        .clone()
        .unwrap_or_else(|| "pdf-extract".to_string());
    let sources = vec![loaded];

    match req.mode {
        PdfExtractMode::SinglePdf => {
            let output_raw = req
                .output_path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    AppError::invalid_param(
                        "Output PDF path is required when extracting to a single PDF.",
                    )
                })?;
            let staged = AtomicPdfOutput::prepare(
                output_raw,
                &[source_path],
                req.overwrite.unwrap_or(false),
            )?;
            let plan: Vec<PlannedPageRef> = extracted_pages
                .iter()
                .map(|&p| PlannedPageRef {
                    source_idx: 0,
                    source_page_1based: p,
                    extra_rotation_cw: 0,
                })
                .collect();

            let (mut out_doc, summary) = assemble_pdf_from_plan(
                &sources,
                &plan,
                &AssembleOptions {
                    add_filename_bookmarks: false,
                    preserve_source_outlines: true,
                },
                cancel_flag,
                |done, total| {
                    on_progress(PdfTaskProgressPayload {
                        task_id: task_id.clone(),
                        tool_id: "P11".to_string(),
                        current: done,
                        total,
                        percent: (done as f64 / total.max(1) as f64) * 90.0,
                        detail: format!("Extracting page {done}/{total}"),
                    });
                },
            )?;
            if cancel_flag.load(Ordering::Relaxed) {
                return Err(AppError::cancelled());
            }

            let bytes = serialize_pdf_document(&mut out_doc)?;
            let (final_path, byte_length) = staged.write_and_commit(&bytes)?;
            let file_name = final_path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "extracted.pdf".to_string());
            let warnings = collect_structural_warnings(&summary);

            on_progress(PdfTaskProgressPayload {
                task_id,
                tool_id: "P11".to_string(),
                current: extracted_pages.len(),
                total: extracted_pages.len(),
                percent: 100.0,
                detail: "Completed".to_string(),
            });

            Ok(ExtractPdfPagesResult {
                mode: PdfExtractMode::SinglePdf,
                source_page_count,
                extracted_pages: extracted_pages.clone(),
                duplicate_pages_removed,
                files: vec![ExtractPdfOutputFile {
                    path: final_path.to_string_lossy().into_owned(),
                    file_name,
                    byte_length,
                    page_count: extracted_pages.len(),
                    range_label: format_compact_page_list(&extracted_pages),
                    collision_adjusted: false,
                }],
                total_output_bytes: byte_length,
                cancelled: false,
                summary,
                warnings,
            })
        }
        PdfExtractMode::PerPagePdfs => {
            let dir_raw = req
                .output_dir
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    AppError::invalid_param(
                        "Output directory is required when extracting one PDF per page.",
                    )
                })?;
            let out_dir = crate::fs_guard::validate_user_path(dir_raw, "Output directory")?;
            let dir_meta = std::fs::metadata(&out_dir)
                .map_err(|e| AppError::from_io(e, "Unable to access output directory"))?;
            if !dir_meta.is_dir() {
                return Err(AppError::invalid_param(
                    "Selected output location is not a valid directory.",
                ));
            }
            let pad_width = source_page_count.to_string().len().max(2);
            let forbidden = vec![source_path];
            let total = extracted_pages.len();
            let mut files = Vec::with_capacity(total);
            let mut total_output_bytes = 0u64;
            let mut cancelled = false;
            let mut aggregate_summary = PdfStructuralSummary::default();

            for (idx, &p) in extracted_pages.iter().enumerate() {
                if cancel_flag.load(Ordering::Relaxed) {
                    cancelled = true;
                    break;
                }
                let plan = vec![PlannedPageRef {
                    source_idx: 0,
                    source_page_1based: p,
                    extra_rotation_cw: 0,
                }];
                let (mut out_doc, part_summary) = assemble_pdf_from_plan(
                    &sources,
                    &plan,
                    &AssembleOptions {
                        add_filename_bookmarks: false,
                        preserve_source_outlines: true,
                    },
                    cancel_flag,
                    |_, _| {},
                )?;
                if cancel_flag.load(Ordering::Relaxed) {
                    cancelled = true;
                    break;
                }
                let bytes = serialize_pdf_document(&mut out_doc)?;
                let desired =
                    sanitize_pdf_filename(&format!("{stem}_p{:0width$}.pdf", p, width = pad_width));
                let (staged, collision_adjusted) =
                    AtomicPdfOutput::prepare_unique_in_dir(&out_dir, &desired, &forbidden)?;
                let (final_path, byte_length) = staged.write_and_commit(&bytes)?;
                let file_name = final_path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or(desired);

                aggregate_summary.preserved_external_links += part_summary.preserved_external_links;
                aggregate_summary.remapped_internal_links += part_summary.remapped_internal_links;
                aggregate_summary.dropped_dangling_links += part_summary.dropped_dangling_links;
                aggregate_summary.remapped_bookmarks += part_summary.remapped_bookmarks;
                aggregate_summary.dropped_dangling_bookmarks +=
                    part_summary.dropped_dangling_bookmarks;
                for s in part_summary.signature_invalidated_sources {
                    if !aggregate_summary.signature_invalidated_sources.contains(&s) {
                        aggregate_summary.signature_invalidated_sources.push(s);
                    }
                }
                for s in part_summary.acroform_simplified_sources {
                    if !aggregate_summary.acroform_simplified_sources.contains(&s) {
                        aggregate_summary.acroform_simplified_sources.push(s);
                    }
                }

                total_output_bytes += byte_length;
                files.push(ExtractPdfOutputFile {
                    path: final_path.to_string_lossy().into_owned(),
                    file_name,
                    byte_length,
                    page_count: 1,
                    range_label: format!("{p}"),
                    collision_adjusted,
                });

                on_progress(PdfTaskProgressPayload {
                    task_id: task_id.clone(),
                    tool_id: "P11".to_string(),
                    current: idx + 1,
                    total,
                    percent: ((idx + 1) as f64 / total.max(1) as f64) * 100.0,
                    detail: format!("Extracted {}/{total}", idx + 1),
                });
            }

            let warnings = collect_structural_warnings(&aggregate_summary);
            Ok(ExtractPdfPagesResult {
                mode: PdfExtractMode::PerPagePdfs,
                source_page_count,
                extracted_pages,
                duplicate_pages_removed,
                files,
                total_output_bytes,
                cancelled,
                summary: aggregate_summary,
                warnings,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf_core::PdfSessionManager;
    use tempfile::tempdir;

    /// Build a multi-page synthetic PDF with selectable text, vector drawing, external URI link,
    /// internal GoTo link (Page 1 -> Page 3), and hierarchical outlines (Bookmarks).
    fn create_rich_test_pdf(path: &Path, page_texts: &[&str], with_sig_marker: bool) {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();

        let mut font_dict = Dictionary::new();
        font_dict.set("Type", Object::Name(b"Font".to_vec()));
        font_dict.set("Subtype", Object::Name(b"Type1".to_vec()));
        font_dict.set("BaseFont", Object::Name(b"Helvetica".to_vec()));
        let font_id = doc.add_object(Object::Dictionary(font_dict));

        let mut fonts = Dictionary::new();
        fonts.set("F1", Object::Reference(font_id));
        let mut resources = Dictionary::new();
        resources.set("Font", Object::Dictionary(fonts));
        let resources_id = doc.add_object(Object::Dictionary(resources));

        let mut page_ids = Vec::new();
        for (i, text) in page_texts.iter().enumerate() {
            let escaped = text
                .replace('\\', r"\\")
                .replace('(', r"\(")
                .replace(')', r"\)");
            let content = format!(
                "q 0.1 0.3 0.7 rg 40 700 200 40 re f Q\nBT /F1 18 Tf 50 760 Td ({escaped}) Tj ET\n"
            );
            let content_id = doc.add_object(Object::Stream(Stream::new(
                Dictionary::new(),
                content.into_bytes(),
            )));
            let mut page = Dictionary::new();
            page.set("Type", Object::Name(b"Page".to_vec()));
            page.set("Parent", Object::Reference(pages_id));
            // Deliberately inherit MediaBox & Resources on even pages to test inheritance materialization!
            if i % 2 == 0 {
                page.set(
                    "MediaBox",
                    Object::Array(vec![
                        Object::Integer(0),
                        Object::Integer(0),
                        Object::Integer(595),
                        Object::Integer(842),
                    ]),
                );
                page.set("Resources", Object::Reference(resources_id));
            }
            page.set("Contents", Object::Reference(content_id));
            page_ids.push(doc.add_object(Object::Dictionary(page)));
        }

        // Add external URI link & internal GoTo link (Page 1 -> last page) on page 1
        if page_ids.len() >= 2 {
            let mut ext_action = Dictionary::new();
            ext_action.set("S", Object::Name(b"URI".to_vec()));
            ext_action.set(
                "URI",
                Object::String(
                    b"https://example.org/winkit".to_vec(),
                    StringFormat::Literal,
                ),
            );
            let mut ext_link = Dictionary::new();
            ext_link.set("Type", Object::Name(b"Annot".to_vec()));
            ext_link.set("Subtype", Object::Name(b"Link".to_vec()));
            ext_link.set(
                "Rect",
                Object::Array(vec![
                    Object::Integer(50),
                    Object::Integer(600),
                    Object::Integer(250),
                    Object::Integer(630),
                ]),
            );
            ext_link.set("A", Object::Dictionary(ext_action));
            let ext_link_id = doc.add_object(Object::Dictionary(ext_link));

            let mut int_link = Dictionary::new();
            int_link.set("Type", Object::Name(b"Annot".to_vec()));
            int_link.set("Subtype", Object::Name(b"Link".to_vec()));
            int_link.set(
                "Rect",
                Object::Array(vec![
                    Object::Integer(50),
                    Object::Integer(540),
                    Object::Integer(250),
                    Object::Integer(570),
                ]),
            );
            int_link.set(
                "Dest",
                Object::Array(vec![
                    Object::Reference(*page_ids.last().unwrap()),
                    Object::Name(b"Fit".to_vec()),
                ]),
            );
            let int_link_id = doc.add_object(Object::Dictionary(int_link));

            if let Ok(Object::Dictionary(p0)) = doc.get_object_mut(page_ids[0]) {
                p0.set(
                    "Annots",
                    Object::Array(vec![
                        Object::Reference(ext_link_id),
                        Object::Reference(int_link_id),
                    ]),
                );
            }
        }

        // Build /Pages with inheritable MediaBox & Resources
        let mut pages_dict = Dictionary::new();
        pages_dict.set("Type", Object::Name(b"Pages".to_vec()));
        pages_dict.set(
            "Kids",
            Object::Array(page_ids.iter().copied().map(Object::Reference).collect()),
        );
        pages_dict.set("Count", Object::Integer(page_ids.len() as i64));
        pages_dict.set(
            "MediaBox",
            Object::Array(vec![
                Object::Integer(0),
                Object::Integer(0),
                Object::Integer(612),
                Object::Integer(792),
            ]),
        );
        pages_dict.set("Resources", Object::Reference(resources_id));
        doc.objects.insert(pages_id, Object::Dictionary(pages_dict));

        // Add bookmarks pointing to first and last pages
        let outline_nodes: Vec<OutputOutlineNode> = page_ids
            .iter()
            .enumerate()
            .map(|(i, &pid)| OutputOutlineNode {
                title: format!("Chapter {}", i + 1),
                target_out_page_id: Some(pid),
                children: Vec::new(),
            })
            .collect();
        let outlines_id = write_outlines_tree(&mut doc, &outline_nodes);

        let mut catalog = Dictionary::new();
        catalog.set("Type", Object::Name(b"Catalog".to_vec()));
        catalog.set("Pages", Object::Reference(pages_id));
        if let Some(oid) = outlines_id {
            catalog.set("Outlines", Object::Reference(oid));
        }
        if with_sig_marker {
            let mut sig = Dictionary::new();
            sig.set("Type", Object::Name(b"Sig".to_vec()));
            sig.set("Filter", Object::Name(b"Adobe.PPKLite".to_vec()));
            let sig_id = doc.add_object(Object::Dictionary(sig));
            let mut acro = Dictionary::new();
            acro.set("SigFlags", Object::Integer(3));
            acro.set("Fields", Object::Array(vec![Object::Reference(sig_id)]));
            let acro_id = doc.add_object(Object::Dictionary(acro));
            catalog.set("AcroForm", Object::Reference(acro_id));
        }
        let catalog_id = doc.add_object(Object::Dictionary(catalog));
        doc.trailer.set("Root", Object::Reference(catalog_id));

        let bytes = serialize_pdf_document(&mut doc).expect("serialize");
        std::fs::write(path, bytes).expect("write pdf");
    }

    #[test]
    fn pdfium_inspect_render_text_search_and_error_classification_work_offline() {
        let dir = tempdir().expect("tempdir");
        let pdf_path = dir.path().join("测试文档_sample.pdf");
        create_rich_test_pdf(
            &pdf_path,
            &[
                "WinKit Alpha Page One",
                "WinKit Beta Page Two",
                "WinKit Gamma End",
            ],
            true,
        );

        let mgr = PdfSessionManager::default();
        let info = mgr
            .inspect_document(&pdf_path.to_string_lossy())
            .expect("inspect succeeds");
        assert_eq!(info.page_count, 3);
        assert!(info.has_text_layer);
        assert!(!info.is_likely_scanned);
        assert!(info.has_outlines);
        assert_eq!(info.outlines.len(), 3);
        assert!(info.has_signatures);
        assert!(info.has_acroform);

        // Render page 1 and verify cache hit on second call
        let r1 = mgr
            .render_page(&crate::pdf_core::PdfRenderRequest {
                path: pdf_path.to_string_lossy().into_owned(),
                page_number: 1,
                target_width_px: Some(320),
                extra_rotation_cw: None,
            })
            .expect("render 1");
        assert!(!r1.from_cache);
        assert_eq!(r1.meta.width_px, 320);
        assert!(r1.data_url.starts_with("data:image/png;base64,"));

        let r2 = mgr
            .render_page(&crate::pdf_core::PdfRenderRequest {
                path: pdf_path.to_string_lossy().into_owned(),
                page_number: 1,
                target_width_px: Some(320),
                extra_rotation_cw: None,
            })
            .expect("render 2 cached");
        assert!(r2.from_cache);

        // Extract text + links on page 1
        let page_text = mgr
            .get_page_text(&pdf_path.to_string_lossy(), 1)
            .expect("text page 1");
        assert!(page_text.full_text.contains("WinKit Alpha"));
        assert!(!page_text.spans.is_empty());
        assert_eq!(page_text.links.len(), 2);
        assert!(page_text.links.iter().any(
            |l| l.kind == "external" && l.uri.as_deref() == Some("https://example.org/winkit")
        ));
        assert!(page_text
            .links
            .iter()
            .any(|l| l.kind == "internal" && l.target_page == Some(3)));

        // Search text across pages
        let search = mgr
            .search_text(&pdf_path.to_string_lossy(), "Gamma", false)
            .expect("search");
        assert_eq!(search.total_matches, 1);
        assert_eq!(search.matches[0].page_number, 3);
        assert!(!search.matches[0].rects.is_empty());

        // Corrupt file fails cleanly with PDF_CORRUPT_OR_INVALID
        let corrupt = dir.path().join("corrupt.pdf");
        std::fs::write(&corrupt, b"NOT A REAL PDF FILE").expect("write corrupt");
        let err = mgr
            .inspect_document(&corrupt.to_string_lossy())
            .unwrap_err();
        assert_eq!(err.code, "PDF_CORRUPT_OR_INVALID");
    }

    #[test]
    fn p07_merge_preserves_vectors_links_bookmarks_supports_images_and_warns_on_signatures() {
        let dir = tempdir().expect("tempdir");
        let pdf_a = dir.path().join("doc_a.pdf");
        let pdf_b = dir.path().join("doc_b.pdf");
        let img_c = dir.path().join("diagram.png");
        let merged = dir.path().join("merged_out.pdf");

        create_rich_test_pdf(&pdf_a, &["Doc A Page 1", "Doc A Page 2"], true);
        create_rich_test_pdf(&pdf_b, &["Doc B Page 1"], false);

        // Create a real PNG image to verify mixed PDF + image merge
        let img = image::RgbaImage::from_pixel(120, 80, image::Rgba([40, 120, 220, 180]));
        img.save(&img_c).expect("save png");

        let cancel = AtomicBool::new(false);
        let res = merge_pdfs_impl(
            &MergePdfsRequest {
                task_id: Some("t-merge".into()),
                inputs: vec![
                    MergePdfInputItem {
                        path: pdf_a.to_string_lossy().into_owned(),
                        kind: None,
                    },
                    MergePdfInputItem {
                        path: img_c.to_string_lossy().into_owned(),
                        kind: None,
                    },
                    MergePdfInputItem {
                        path: pdf_b.to_string_lossy().into_owned(),
                        kind: None,
                    },
                ],
                output_path: merged.to_string_lossy().into_owned(),
                add_filename_bookmarks: true,
                overwrite: Some(false),
                image_options: None,
            },
            &cancel,
            |_| {},
        )
        .expect("merge succeeds");

        assert_eq!(res.total_pages, 4);
        assert_eq!(res.pdf_source_count, 2);
        assert_eq!(res.image_source_count, 1);
        assert_eq!(res.summary.preserved_external_links, 1);
        assert_eq!(res.summary.remapped_internal_links, 1);
        assert_eq!(res.summary.dropped_dangling_links, 0);
        assert_eq!(res.summary.signature_invalidated_sources, vec!["doc_a"]);

        // Verify via PDFium that selectable text, filename bookmarks, and links all work in merged PDF
        let mgr = PdfSessionManager::default();
        let info = mgr
            .inspect_document(&merged.to_string_lossy())
            .expect("inspect merged");
        assert_eq!(info.page_count, 4);
        assert!(info.has_text_layer);
        assert!(
            !info.has_signatures,
            "invalid signature marker stripped from edited copy"
        );
        assert_eq!(info.outlines.len(), 3);
        assert_eq!(info.outlines[0].title, "doc_a");
        assert_eq!(info.outlines[0].page_number, Some(1));
        assert_eq!(info.outlines[1].title, "diagram");
        assert_eq!(info.outlines[1].page_number, Some(3));
        assert_eq!(info.outlines[2].title, "doc_b");
        assert_eq!(info.outlines[2].page_number, Some(4));

        let p4_text = mgr
            .get_page_text(&merged.to_string_lossy(), 4)
            .expect("p4 text");
        assert!(p4_text.full_text.contains("Doc B Page 1"));
    }

    #[test]
    fn p08_split_validates_ranges_prunes_dangling_links_and_never_overwrites() {
        let dir = tempdir().expect("tempdir");
        let src_pdf = dir.path().join("report.pdf");
        let out_dir = dir.path().join("split_out");
        std::fs::create_dir_all(&out_dir).expect("mkdir");

        create_rich_test_pdf(&src_pdf, &["Part One", "Part Two", "Part Three"], false);

        // Pre-create a colliding filename to verify non-overwriting suffix protection
        let collision_path = out_dir.join("report_p01-02.pdf");
        std::fs::write(&collision_path, b"DO_NOT_OVERWRITE").expect("write collision");

        let preview = preview_split_pdf_plan_impl(&SplitPdfPlanRequest {
            path: src_pdf.to_string_lossy().into_owned(),
            mode: PdfSplitMode::CustomRanges,
            chunk_size: None,
            custom_ranges: Some("1-2; 3".into()),
            output_dir: Some(out_dir.to_string_lossy().into_owned()),
        })
        .expect("preview");
        assert!(preview.valid);
        assert_eq!(preview.items.len(), 2);
        assert!(preview.items[0].collision_adjusted);
        assert_eq!(preview.items[0].file_name, "report_p01-02_2.pdf");

        let cancel = AtomicBool::new(false);
        let split_res = split_pdf_impl(
            &SplitPdfRequest {
                task_id: Some("t-split".into()),
                path: src_pdf.to_string_lossy().into_owned(),
                mode: PdfSplitMode::CustomRanges,
                chunk_size: None,
                custom_ranges: Some("1-2; 3".into()),
                output_dir: out_dir.to_string_lossy().into_owned(),
            },
            &cancel,
            |_| {},
        )
        .expect("split");

        assert!(!split_res.cancelled);
        assert_eq!(split_res.files.len(), 2);
        assert_eq!(split_res.total_output_pages, 3);
        // Existing colliding file is 100% intact
        assert_eq!(std::fs::read(&collision_path).unwrap(), b"DO_NOT_OVERWRITE");
        // Page 1's internal link to Page 3 was dropped in Part 1 (no dangling ref!), external link preserved
        assert_eq!(split_res.summary.preserved_external_links, 1);
        assert_eq!(split_res.summary.dropped_dangling_links, 1);

        let mgr = PdfSessionManager::default();
        let part1_text = mgr.get_page_text(&split_res.files[0].path, 1).expect("p1");
        assert_eq!(part1_text.links.len(), 1);
        assert_eq!(part1_text.links[0].kind, "external");

        // Invalid range rejected upfront
        let bad_preview = preview_split_pdf_plan_impl(&SplitPdfPlanRequest {
            path: src_pdf.to_string_lossy().into_owned(),
            mode: PdfSplitMode::CustomRanges,
            chunk_size: None,
            custom_ranges: Some("1-9".into()),
            output_dir: None,
        })
        .expect("bad preview");
        assert!(!bad_preview.valid);
        assert!(!bad_preview.errors.is_empty());
    }

    #[test]
    fn p09_organize_reorders_rotates_deletes_and_remaps_links_and_outlines_cleanly() {
        let dir = tempdir().expect("tempdir");
        let src = dir.path().join("deck.pdf");
        let out = dir.path().join("deck_organized.pdf");
        create_rich_test_pdf(
            &src,
            &["Page One", "Page Two", "Page Three", "Page Four"],
            true,
        );

        let cancel = AtomicBool::new(false);
        // Reorder [3, 1, 4] (dropping page 2), rotate page 1 by 90° and page 4 by 270°
        let res = organize_pdf_impl(
            &OrganizePdfRequest {
                task_id: Some("t-org".into()),
                path: src.to_string_lossy().into_owned(),
                pages: vec![
                    OrganizePageSpec {
                        source_page: 3,
                        extra_rotation_cw: 0,
                    },
                    OrganizePageSpec {
                        source_page: 1,
                        extra_rotation_cw: 90,
                    },
                    OrganizePageSpec {
                        source_page: 4,
                        extra_rotation_cw: 270,
                    },
                ],
                output_path: out.to_string_lossy().into_owned(),
                overwrite: Some(false),
            },
            &cancel,
            |_| {},
        )
        .expect("organize succeeds");

        assert_eq!(res.output_page_count, 3);
        assert_eq!(res.rotated_pages, 2);
        assert_eq!(res.deleted_pages, 1);
        assert!(res.reordered);
        assert_eq!(res.summary.signature_invalidated_sources, vec!["deck"]);
        assert_eq!(res.summary.preserved_external_links, 1);
        // Page 1's internal link to Page 4 survived and must now point to new Page 3!
        assert_eq!(res.summary.remapped_internal_links, 1);
        assert_eq!(res.summary.dropped_dangling_links, 0);
        // Bookmark for dropped Page 2 was pruned cleanly (3 remaining outlines)
        assert_eq!(res.summary.remapped_bookmarks, 3);
        assert_eq!(res.summary.dropped_dangling_bookmarks, 1);

        let mgr = PdfSessionManager::default();
        let info = mgr
            .inspect_document(&out.to_string_lossy())
            .expect("inspect out");
        assert_eq!(info.page_count, 3);
        assert_eq!(info.pages[0].rotation, 0);
        assert_eq!(info.pages[1].rotation, 90);
        assert_eq!(info.pages[2].rotation, 270);
        // Rotated A4 page 2 should now be landscape (width > height)!
        assert!(info.pages[1].width_pt > info.pages[1].height_pt);
        assert_eq!(info.outlines.len(), 3);

        // Verify page order via selectable text & verify remapped link target == page 3
        let p1 = mgr.get_page_text(&out.to_string_lossy(), 1).expect("p1");
        let p2 = mgr.get_page_text(&out.to_string_lossy(), 2).expect("p2");
        let p3 = mgr.get_page_text(&out.to_string_lossy(), 3).expect("p3");
        assert!(p1.full_text.contains("Page Three"));
        assert!(p2.full_text.contains("Page One"));
        assert!(p3.full_text.contains("Page Four"));
        assert!(p2
            .links
            .iter()
            .any(|l| l.kind == "internal" && l.target_page == Some(3)));
    }

    #[test]
    fn p10_delete_blocks_deleting_all_pages_and_preserves_surviving_structure() {
        let dir = tempdir().expect("tempdir");
        let src = dir.path().join("notes.pdf");
        let out = dir.path().join("notes_trimmed.pdf");
        create_rich_test_pdf(&src, &["Alpha", "Beta", "Gamma"], false);
        let cancel = AtomicBool::new(false);

        // Attempting to delete all 3 pages must fail cleanly without creating output
        let err = delete_pdf_pages_impl(
            &DeletePdfPagesRequest {
                task_id: None,
                path: src.to_string_lossy().into_owned(),
                delete_pages: vec![1, 2, 3],
                output_path: out.to_string_lossy().into_owned(),
                overwrite: Some(false),
            },
            &cancel,
            |_| {},
        )
        .unwrap_err();
        assert_eq!(err.code, "INVALID_PARAMETER");
        assert!(!out.exists());

        // Deleting page 2 keeps [1, 3] and remaps Page 1's internal link from old Page 3 -> new Page 2
        let res = delete_pdf_pages_impl(
            &DeletePdfPagesRequest {
                task_id: Some("t-del".into()),
                path: src.to_string_lossy().into_owned(),
                delete_pages: vec![2],
                output_path: out.to_string_lossy().into_owned(),
                overwrite: Some(false),
            },
            &cancel,
            |_| {},
        )
        .expect("delete succeeds");
        assert_eq!(res.deleted_pages, vec![2]);
        assert_eq!(res.kept_pages, vec![1, 3]);
        assert_eq!(res.summary.remapped_internal_links, 1);

        let mgr = PdfSessionManager::default();
        let p1 = mgr.get_page_text(&out.to_string_lossy(), 1).expect("p1");
        let p2 = mgr.get_page_text(&out.to_string_lossy(), 2).expect("p2");
        assert!(p1.full_text.contains("Alpha"));
        assert!(p2.full_text.contains("Gamma"));
        assert!(p1
            .links
            .iter()
            .any(|l| l.kind == "internal" && l.target_page == Some(2)));
    }

    #[test]
    fn p11_extract_supports_single_and_per_page_modes_with_collision_protection() {
        let dir = tempdir().expect("tempdir");
        let src = dir.path().join("book.pdf");
        let single_out = dir.path().join("book_extract.pdf");
        let per_page_dir = dir.path().join("pages_out");
        std::fs::create_dir_all(&per_page_dir).expect("mkdir");
        create_rich_test_pdf(&src, &["One", "Two", "Three", "Four"], false);
        let cancel = AtomicBool::new(false);

        // Mode 1: Single PDF with dedupe + ascending sort ([4, 2, 4] -> [2, 4])
        let single = extract_pdf_pages_impl(
            &ExtractPdfPagesRequest {
                task_id: Some("t-ext-1".into()),
                path: src.to_string_lossy().into_owned(),
                pages: vec![4, 2, 4],
                mode: PdfExtractMode::SinglePdf,
                dedupe_and_sort: Some(true),
                output_path: Some(single_out.to_string_lossy().into_owned()),
                output_dir: None,
                overwrite: Some(false),
            },
            &cancel,
            |_| {},
        )
        .expect("single extract");
        assert_eq!(single.extracted_pages, vec![2, 4]);
        assert_eq!(single.duplicate_pages_removed, 1);
        assert_eq!(single.files.len(), 1);
        assert_eq!(single.files[0].page_count, 2);

        // Mode 2: Per-page PDFs with collision-safe non-overwrite naming
        let existing = per_page_dir.join("book_p01.pdf");
        std::fs::write(&existing, b"EXISTING_CONTENT").expect("seed collision");
        let per_page = extract_pdf_pages_impl(
            &ExtractPdfPagesRequest {
                task_id: Some("t-ext-2".into()),
                path: src.to_string_lossy().into_owned(),
                pages: vec![1, 3],
                mode: PdfExtractMode::PerPagePdfs,
                dedupe_and_sort: Some(true),
                output_path: None,
                output_dir: Some(per_page_dir.to_string_lossy().into_owned()),
                overwrite: None,
            },
            &cancel,
            |_| {},
        )
        .expect("per-page extract");
        assert_eq!(per_page.files.len(), 2);
        assert!(per_page.files[0].collision_adjusted);
        assert_eq!(per_page.files[0].file_name, "book_p01_2.pdf");
        assert_eq!(std::fs::read(&existing).unwrap(), b"EXISTING_CONTENT");
    }
}
