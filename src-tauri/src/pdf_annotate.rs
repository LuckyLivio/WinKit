//! Phase 5B PR 1 backend:
//! - Unified PDF page box (`MediaBox`/`CropBox`) + `/Rotate` -> display-space CTM math.
//! - Shared alpha-preserving PDF Image XObject (`/Image` + `/SMask` + `/ExtGState`) overlay engine
//!   that preserves selectable text, vector drawings, image resolutions, and existing links.
//! - `P06` Visual PDF Signature (`sign_pdf_impl`) + opt-in local template storage.
//! - `P13` Non-destructive PDF Page Cropping (`detect_pdf_white_margins_impl`, `crop_pdf_impl`).
//! - `I13` PDF Watermark (`watermark_pdf_impl`) sharing `WatermarkStyleConfig` with image/video modes.

use crate::error::AppError;
use crate::fs_guard::validate_existing_input_file;
use crate::image_assets::decode_png_data_url_or_base64;
use crate::image_watermark::{
    compute_scaled_stamp_size, load_stamp_rgba, WatermarkPlacement, WatermarkStyleConfig,
};
use crate::pdf_core::{
    inspect_structural_flags_from_doc, parse_page_range_spec, AtomicPdfOutput, PdfSessionManager,
    PdfTaskProgressPayload,
};
use crate::pdf_pdfium::{MAX_PDF_FILE_BYTES, MAX_PDF_PAGES};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use image::RgbaImage;
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const MIN_CROPPED_SIDE_PT: f32 = 18.0;
const MAX_SIGNATURE_TEMPLATES: usize = 24;
const MAX_SIGNATURE_TEMPLATE_PNG_BYTES: usize = 2 * 1024 * 1024;
const MAX_OVERLAY_STAMP_SIDE_PX: u32 = 2400;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PdfBox {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
}

impl PdfBox {
    pub fn normalized(x0: f32, y0: f32, x1: f32, y1: f32) -> Self {
        Self {
            x0: x0.min(x1),
            y0: y0.min(y1),
            x1: x0.max(x1),
            y1: y0.max(y1),
        }
    }

    pub fn width(self) -> f32 {
        (self.x1 - self.x0).max(0.0)
    }

    pub fn height(self) -> f32 {
        (self.y1 - self.y0).max(0.0)
    }

    pub fn intersect(self, other: Self) -> Option<Self> {
        let x0 = self.x0.max(other.x0);
        let y0 = self.y0.max(other.y0);
        let x1 = self.x1.min(other.x1);
        let y1 = self.y1.min(other.y1);
        if x1 - x0 > 1.0 && y1 - y0 > 1.0 {
            Some(Self { x0, y0, x1, y1 })
        } else {
            None
        }
    }

    pub fn to_pdf_array(self) -> Object {
        Object::Array(vec![
            Object::Real(round_pt(self.x0)),
            Object::Real(round_pt(self.y0)),
            Object::Real(round_pt(self.x1)),
            Object::Real(round_pt(self.y1)),
        ])
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ResolvedPageFrame {
    pub media_box: PdfBox,
    pub crop_box: PdfBox,
    /// Effective clockwise page rotation normalized to {0, 90, 180, 270}.
    pub rotation_cw: u16,
    /// Displayed upright page width in points.
    pub display_width_pt: f32,
    /// Displayed upright page height in points.
    pub display_height_pt: f32,
}

fn round_pt(v: f32) -> f32 {
    (v * 1000.0).round() / 1000.0
}

fn normalize_rotation_cw(raw: i64) -> u16 {
    let m = raw.rem_euclid(360);
    match ((m + 45) / 90) % 4 {
        1 => 90,
        2 => 180,
        3 => 270,
        _ => 0,
    }
}

fn object_as_f32(doc: &Document, obj: &Object) -> Option<f32> {
    let resolved = match obj {
        Object::Reference(id) => doc.get_object(*id).ok()?,
        other => other,
    };
    match resolved {
        Object::Real(v) if v.is_finite() => Some(*v),
        Object::Integer(i) => Some(*i as f32),
        _ => None,
    }
}

fn object_as_box(doc: &Document, obj: &Object) -> Option<PdfBox> {
    let resolved = match obj {
        Object::Reference(id) => doc.get_object(*id).ok()?,
        other => other,
    };
    let arr = resolved.as_array().ok()?;
    if arr.len() != 4 {
        return None;
    }
    let x0 = object_as_f32(doc, &arr[0])?;
    let y0 = object_as_f32(doc, &arr[1])?;
    let x1 = object_as_f32(doc, &arr[2])?;
    let y1 = object_as_f32(doc, &arr[3])?;
    let b = PdfBox::normalized(x0, y0, x1, y1);
    if b.width() > 1.0 && b.height() > 1.0 {
        Some(b)
    } else {
        None
    }
}

fn object_as_i64(doc: &Document, obj: &Object) -> Option<i64> {
    let resolved = match obj {
        Object::Reference(id) => doc.get_object(*id).ok()?,
        other => other,
    };
    resolved.as_i64().ok()
}

/// Resolves effective `/MediaBox`, `/CropBox` (intersected with `/MediaBox`), and `/Rotate`
/// for `page_id` including `/Parent` inheritance per PDF 1.7 §7.7.3.4.
pub fn resolve_page_frame(doc: &Document, page_id: ObjectId) -> ResolvedPageFrame {
    let mut media_box: Option<PdfBox> = None;
    let mut crop_box: Option<PdfBox> = None;
    let mut rotation: Option<u16> = None;

    let mut visited = HashSet::new();
    let mut cur = Some(page_id);
    while let Some(id) = cur {
        if !visited.insert(id) || visited.len() > 64 {
            break;
        }
        let Ok(dict) = doc.get_dictionary(id) else {
            break;
        };
        if media_box.is_none() {
            if let Ok(obj) = dict.get(b"MediaBox") {
                media_box = object_as_box(doc, obj);
            }
        }
        if crop_box.is_none() {
            if let Ok(obj) = dict.get(b"CropBox") {
                crop_box = object_as_box(doc, obj);
            }
        }
        if rotation.is_none() {
            if let Ok(obj) = dict.get(b"Rotate") {
                if let Some(r) = object_as_i64(doc, obj) {
                    rotation = Some(normalize_rotation_cw(r));
                }
            }
        }
        if media_box.is_some() && crop_box.is_some() && rotation.is_some() {
            break;
        }
        cur = dict.get(b"Parent").ok().and_then(|o| o.as_reference().ok());
    }

    let media = media_box.unwrap_or(PdfBox {
        x0: 0.0,
        y0: 0.0,
        x1: 595.28,
        y1: 841.89,
    });
    let crop = crop_box.and_then(|c| c.intersect(media)).unwrap_or(media);
    let rot = rotation.unwrap_or(0);
    let (display_width_pt, display_height_pt) = if rot % 180 == 90 {
        (crop.height(), crop.width())
    } else {
        (crop.width(), crop.height())
    };

    ResolvedPageFrame {
        media_box: media,
        crop_box: crop,
        rotation_cw: rot,
        display_width_pt,
        display_height_pt,
    }
}

/// Computes the exact 2D PDF CTM `[a, b, c, d, e, f]` mapping visual bottom-left upright coordinates
/// `(sx, sy) ∈ [0, W_disp] × [0, H_disp]` into unrotated PDF user space `(px, py)` inside `crop_box`.
///
/// Verified across all 4 `/Rotate` values (`0, 90, 180, 270`) and arbitrary non-zero origins `(cx0, cy0)`:
/// - `R = 0`:   `px = cx0 + sx`, `py = cy0 + sy`
/// - `R = 90`:  `px = cx1 - sy`, `py = cy0 + sx`
/// - `R = 180`: `px = cx1 - sx`, `py = cy1 - sy`
/// - `R = 270`: `px = cx0 + sy`, `py = cy1 - sx`
pub fn display_to_pdf_ctm(crop_box: PdfBox, rotation_cw: u16) -> [f32; 6] {
    match rotation_cw % 360 {
        90 => [0.0, 1.0, -1.0, 0.0, crop_box.x1, crop_box.y0],
        180 => [-1.0, 0.0, 0.0, -1.0, crop_box.x1, crop_box.y1],
        270 => [0.0, -1.0, 1.0, 0.0, crop_box.x0, crop_box.y1],
        _ => [1.0, 0.0, 0.0, 1.0, crop_box.x0, crop_box.y0],
    }
}

pub fn display_to_pdf_point(crop_box: PdfBox, rotation_cw: u16, sx: f32, sy: f32) -> (f32, f32) {
    let [a, b, c, d, e, f] = display_to_pdf_ctm(crop_box, rotation_cw);
    (a * sx + c * sy + e, b * sx + d * sy + f)
}

fn load_unencrypted_lopdf_doc(path_raw: &str) -> Result<(PathBuf, Document, bool, bool), AppError> {
    let (canonical, file_len) = validate_existing_input_file(path_raw)?;
    if file_len == 0 {
        return Err(AppError::new(
            "PDF_CORRUPT_OR_INVALID",
            "PDF file is empty (0 bytes).",
        ));
    }
    if file_len > MAX_PDF_FILE_BYTES {
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
                "This PDF is password-protected or encrypted. Unlock it first with P16 Remove Password.",
            )
        } else {
            AppError::new(
                "PDF_CORRUPT_OR_INVALID",
                format!("Failed to parse PDF document structure: {msg}"),
            )
        }
    })?;
    let flags = inspect_structural_flags_from_doc(&doc);
    if flags.is_encrypted {
        return Err(AppError::new(
            "PDF_PASSWORD_REQUIRED",
            "This PDF is password-protected or encrypted. Unlock it first with P16 Remove Password.",
        ));
    }
    let page_count = doc.get_pages().len();
    if page_count == 0 {
        return Err(AppError::new(
            "PDF_CORRUPT_OR_INVALID",
            "PDF document contains no pages.",
        ));
    }
    if page_count > MAX_PDF_PAGES {
        return Err(AppError::size_limit(format!(
            "PDF has {page_count} pages, exceeding the {MAX_PDF_PAGES}-page safety limit."
        )));
    }
    Ok((canonical, doc, flags.has_signatures, flags.has_acroform))
}

fn strip_invalidated_signature_markers(doc: &mut Document) {
    if let Ok(catalog_id) = doc.trailer.get(b"Root").and_then(|o| o.as_reference()) {
        if let Ok(cat) = doc.get_dictionary_mut(catalog_id) {
            cat.remove(b"Perms");
            if let Ok(Object::Dictionary(ref mut acro)) = cat.get_mut(b"AcroForm") {
                acro.remove(b"SigFlags");
            } else if let Ok(Object::Reference(acro_id)) = cat.get(b"AcroForm").cloned() {
                if let Ok(acro) = doc.get_dictionary_mut(acro_id) {
                    acro.remove(b"SigFlags");
                }
            }
        }
    }
}

fn zlib_compress(data: &[u8]) -> Result<Vec<u8>, AppError> {
    let mut encoder = ZlibEncoder::new(Vec::with_capacity(data.len() / 2), Compression::default());
    encoder
        .write_all(data)
        .map_err(|e| AppError::from_io(e, "Failed to compress PDF stream"))?;
    encoder
        .finish()
        .map_err(|e| AppError::from_io(e, "Failed to finalize compressed PDF stream"))
}

/// Embeds an RGBA image into `doc` as a Flate-compressed `/DeviceRGB` Image XObject
/// with an accompanying 8-bit Flate-compressed `/SMask` when transparency is present.
pub fn embed_rgba_image_xobject(doc: &mut Document, img: &RgbaImage) -> Result<ObjectId, AppError> {
    // Clamp huge stamps proportionally so PDF size stays compact while remaining crisp at 300 DPI.
    let bounded: std::borrow::Cow<'_, RgbaImage> =
        if img.width() > MAX_OVERLAY_STAMP_SIDE_PX || img.height() > MAX_OVERLAY_STAMP_SIDE_PX {
            let scale =
                (MAX_OVERLAY_STAMP_SIDE_PX as f32 / img.width().max(img.height()) as f32).min(1.0);
            let nw = ((img.width() as f32 * scale).round() as u32).max(1);
            let nh = ((img.height() as f32 * scale).round() as u32).max(1);
            std::borrow::Cow::Owned(image::imageops::resize(
                img,
                nw,
                nh,
                image::imageops::FilterType::Lanczos3,
            ))
        } else {
            std::borrow::Cow::Borrowed(img)
        };

    let w = bounded.width();
    let h = bounded.height();
    let pixel_count = (w as usize).saturating_mul(h as usize);
    let mut rgb = Vec::with_capacity(pixel_count * 3);
    let mut alpha = Vec::with_capacity(pixel_count);
    let mut has_transparency = false;

    for p in bounded.pixels() {
        rgb.push(p[0]);
        rgb.push(p[1]);
        rgb.push(p[2]);
        alpha.push(p[3]);
        if p[3] < 255 {
            has_transparency = true;
        }
    }

    let smask_id = if has_transparency {
        let compressed_alpha = zlib_compress(&alpha)?;
        let mut smask_dict = Dictionary::new();
        smask_dict.set("Type", Object::Name(b"XObject".to_vec()));
        smask_dict.set("Subtype", Object::Name(b"Image".to_vec()));
        smask_dict.set("Width", Object::Integer(i64::from(w)));
        smask_dict.set("Height", Object::Integer(i64::from(h)));
        smask_dict.set("ColorSpace", Object::Name(b"DeviceGray".to_vec()));
        smask_dict.set("BitsPerComponent", Object::Integer(8));
        smask_dict.set("Filter", Object::Name(b"FlateDecode".to_vec()));
        Some(doc.add_object(Object::Stream(Stream::new(smask_dict, compressed_alpha))))
    } else {
        None
    };

    let compressed_rgb = zlib_compress(&rgb)?;
    let mut img_dict = Dictionary::new();
    img_dict.set("Type", Object::Name(b"XObject".to_vec()));
    img_dict.set("Subtype", Object::Name(b"Image".to_vec()));
    img_dict.set("Width", Object::Integer(i64::from(w)));
    img_dict.set("Height", Object::Integer(i64::from(h)));
    img_dict.set("ColorSpace", Object::Name(b"DeviceRGB".to_vec()));
    img_dict.set("BitsPerComponent", Object::Integer(8));
    img_dict.set("Filter", Object::Name(b"FlateDecode".to_vec()));
    if let Some(sid) = smask_id {
        img_dict.set("SMask", Object::Reference(sid));
    }

    Ok(doc.add_object(Object::Stream(Stream::new(img_dict, compressed_rgb))))
}

fn add_ext_gstate_opacity(doc: &mut Document, opacity: f32) -> ObjectId {
    let alpha = opacity.clamp(0.01, 1.0);
    let mut gs = Dictionary::new();
    gs.set("Type", Object::Name(b"ExtGState".to_vec()));
    gs.set("ca", Object::Real(round_pt(alpha)));
    gs.set("CA", Object::Real(round_pt(alpha)));
    gs.set("AIS", Object::Boolean(false));
    doc.add_object(Object::Dictionary(gs))
}

fn resolve_dict_clone(doc: &Document, obj: &Object) -> Dictionary {
    match obj {
        Object::Dictionary(d) => d.clone(),
        Object::Reference(id) => doc.get_dictionary(*id).cloned().unwrap_or_default(),
        _ => Dictionary::new(),
    }
}

fn resolve_inherited_resources_clone(doc: &Document, page_id: ObjectId) -> Dictionary {
    let mut visited = HashSet::new();
    let mut cur = Some(page_id);
    while let Some(id) = cur {
        if !visited.insert(id) || visited.len() > 64 {
            break;
        }
        let Ok(dict) = doc.get_dictionary(id) else {
            break;
        };
        if let Ok(res_obj) = dict.get(b"Resources") {
            return resolve_dict_clone(doc, res_obj);
        }
        cur = dict.get(b"Parent").ok().and_then(|o| o.as_reference().ok());
    }
    Dictionary::new()
}

fn next_unique_resource_name(dict: &Dictionary, prefix: &str) -> String {
    for idx in 1..10_000 {
        let candidate = format!("{prefix}{idx}");
        if !dict.has(candidate.as_bytes()) {
            return candidate;
        }
    }
    format!("{prefix}99999")
}

/// Safely wraps a page's existing `/Contents` in `q ... Q` and appends an overlay content stream
/// with collision-free XObject and ExtGState resource names without mutating shared resource dicts.
fn append_overlay_to_page(
    doc: &mut Document,
    page_id: ObjectId,
    xobjects: &[(String, ObjectId)],
    ext_gstates: &[(String, ObjectId)],
    overlay_ops: &[u8],
) -> Result<(), AppError> {
    let mut res_dict = resolve_inherited_resources_clone(doc, page_id);

    let mut xobj_dict = res_dict
        .get(b"XObject")
        .ok()
        .map(|o| resolve_dict_clone(doc, o))
        .unwrap_or_default();
    let mut xobj_mapping = Vec::with_capacity(xobjects.len());
    for (placeholder, obj_id) in xobjects {
        let actual_name = next_unique_resource_name(&xobj_dict, "WKIm");
        xobj_dict.set(actual_name.as_bytes(), Object::Reference(*obj_id));
        xobj_mapping.push((placeholder.clone(), actual_name));
    }
    if !xobjects.is_empty() {
        res_dict.set("XObject", Object::Dictionary(xobj_dict));
    }

    let mut gs_dict = res_dict
        .get(b"ExtGState")
        .ok()
        .map(|o| resolve_dict_clone(doc, o))
        .unwrap_or_default();
    let mut gs_mapping = Vec::with_capacity(ext_gstates.len());
    for (placeholder, obj_id) in ext_gstates {
        let actual_name = next_unique_resource_name(&gs_dict, "WKGs");
        gs_dict.set(actual_name.as_bytes(), Object::Reference(*obj_id));
        gs_mapping.push((placeholder.clone(), actual_name));
    }
    if !ext_gstates.is_empty() {
        res_dict.set("ExtGState", Object::Dictionary(gs_dict));
    }

    // Substitute placeholder resource names inside `overlay_ops`
    let mut ops_str = String::from_utf8_lossy(overlay_ops).into_owned();
    for (placeholder, actual) in &xobj_mapping {
        ops_str = ops_str.replace(placeholder, actual);
    }
    for (placeholder, actual) in &gs_mapping {
        ops_str = ops_str.replace(placeholder, actual);
    }

    // Collect existing content stream references safely
    let existing_refs: Vec<Object> = {
        let page_dict = doc.get_dictionary(page_id).map_err(|_| {
            AppError::new("PDF_PAGE_ERROR", "Target PDF page dictionary is missing.")
        })?;
        match page_dict.get(b"Contents").ok() {
            None => Vec::new(),
            Some(Object::Reference(cid)) => {
                // Indirect reference might point to a Stream OR an Array of stream references!
                if let Ok(Object::Array(arr)) = doc.get_object(*cid) {
                    arr.clone()
                } else {
                    vec![Object::Reference(*cid)]
                }
            }
            Some(Object::Array(arr)) => arr.clone(),
            Some(_) => Vec::new(),
        }
    };

    let prefix_id = doc.add_object(Object::Stream(Stream::new(
        Dictionary::new(),
        b"q\n".to_vec(),
    )));
    let mut suffix_bytes = Vec::with_capacity(ops_str.len() + 4);
    suffix_bytes.extend_from_slice(b"\nQ\n");
    suffix_bytes.extend_from_slice(ops_str.as_bytes());
    let compressed_suffix = zlib_compress(&suffix_bytes)?;
    let mut suffix_dict = Dictionary::new();
    suffix_dict.set("Filter", Object::Name(b"FlateDecode".to_vec()));
    let suffix_id = doc.add_object(Object::Stream(Stream::new(suffix_dict, compressed_suffix)));

    let mut new_contents = Vec::with_capacity(existing_refs.len() + 2);
    new_contents.push(Object::Reference(prefix_id));
    new_contents.extend(existing_refs);
    new_contents.push(Object::Reference(suffix_id));

    let page_dict = doc
        .get_dictionary_mut(page_id)
        .map_err(|_| AppError::new("PDF_PAGE_ERROR", "Target PDF page dictionary is missing."))?;
    page_dict.set("Resources", Object::Dictionary(res_dict));
    page_dict.set("Contents", Object::Array(new_contents));

    Ok(())
}

fn format_ctm_op(ctm: [f32; 6]) -> String {
    format!(
        "{:.4} {:.4} {:.4} {:.4} {:.4} {:.4} cm\n",
        ctm[0], ctm[1], ctm[2], ctm[3], ctm[4], ctm[5]
    )
}

/// Emits PDF operators to draw unit-square image `/{img_placeholder}` centered at visual bottom-left
/// `(cx_pt, cy_pt)` with dimensions `(w_pt, h_pt)`, clockwise screen rotation `angle_cw_deg`, and
/// graphics state `/{gs_placeholder}`.
fn build_centered_image_draw_ops(
    cx_pt: f32,
    cy_pt: f32,
    w_pt: f32,
    h_pt: f32,
    angle_cw_deg: f32,
    img_placeholder: &str,
    gs_placeholder: &str,
) -> String {
    let rad = (-angle_cw_deg).to_radians();
    let cos_a = rad.cos();
    let sin_a = rad.sin();
    let mut out = String::with_capacity(160);
    out.push_str("q\n");
    out.push_str(&format!("/{gs_placeholder} gs\n"));
    // Translate to center (cx_pt, cy_pt)
    out.push_str(&format!("1 0 0 1 {:.4} {:.4} cm\n", cx_pt, cy_pt));
    // Rotate by -angle_cw_deg CCW (= +angle_cw_deg CW visually)
    if angle_cw_deg.abs() > 0.01 {
        out.push_str(&format!(
            "{:.5} {:.5} {:.5} {:.5} 0 0 cm\n",
            cos_a, sin_a, -sin_a, cos_a
        ));
    }
    // Translate bottom-left of image to (-w/2, -h/2) and scale unit square to (w_pt, h_pt)
    out.push_str(&format!(
        "{:.4} 0 0 {:.4} {:.4} {:.4} cm\n",
        w_pt,
        h_pt,
        -w_pt * 0.5,
        -h_pt * 0.5
    ));
    out.push_str(&format!("/{img_placeholder} Do\n"));
    out.push_str("Q\n");
    out
}

fn save_lopdf_atomic(
    doc: &mut Document,
    output_raw: &str,
    sources: &[PathBuf],
    overwrite: bool,
) -> Result<(PathBuf, u64), AppError> {
    let atomic = AtomicPdfOutput::prepare(output_raw, sources, overwrite)?;
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes)
        .map_err(|e| AppError::from_io(e, "Failed to serialize output PDF document"))?;
    atomic.write_and_commit(&bytes)
}

// ================================================================================================
// P06: Visual PDF Signature & Opt-In Signature Template Store
// ================================================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfSignaturePlacement {
    /// 1-based page number.
    pub page_number: usize,
    /// Visual left edge in normalized display coordinates `[0.0, 1.0]` (0 = left, 1 = right).
    pub x_norm: f32,
    /// Visual top edge in normalized display coordinates `[0.0, 1.0]` (0 = top, 1 = bottom).
    pub y_norm: f32,
    /// Visual width as fraction of displayed page width `(0.01..=1.0]`.
    pub width_norm: f32,
    /// Visual height as fraction of displayed page height `(0.01..=1.0]`.
    pub height_norm: f32,
    /// Clockwise rotation in degrees `[-180, 180]`.
    pub rotation_deg: f32,
    /// Opacity `[0.1, 1.0]`.
    pub opacity: f32,
    /// Optional per-placement PNG data URL (if omitted, uses top-level `signature_png_data_url`).
    pub stamp_png_data_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignPdfRequest {
    pub task_id: Option<String>,
    pub path: String,
    pub output_path: String,
    pub overwrite: Option<bool>,
    pub signature_png_data_url: Option<String>,
    pub placements: Vec<PdfSignaturePlacement>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignPdfResult {
    pub output_path: String,
    pub byte_length: u64,
    pub total_pages: usize,
    pub signed_pages: Vec<usize>,
    pub placement_count: usize,
    pub signature_invalidated: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureTemplateItem {
    pub id: String,
    pub name: String,
    pub created_at_ms: u64,
    pub width_px: u32,
    pub height_px: u32,
    pub png_data_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureTemplatesListResponse {
    pub storage_dir: String,
    pub items: Vec<SignatureTemplateItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSignatureTemplateRequest {
    pub name: String,
    pub png_data_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredTemplateMeta {
    id: String,
    name: String,
    created_at_ms: u64,
    width_px: u32,
    height_px: u32,
}

/// Resolves opt-in local signature template directory.
/// When `WEBVIEW2_USER_DATA_FOLDER` is set (isolated test profile), keeps templates inside that
/// isolated directory so the user's daily profile is never touched.
pub fn resolve_signature_templates_dir(app_local_data_dir: Option<&Path>) -> PathBuf {
    if let Ok(isolated) = std::env::var("WEBVIEW2_USER_DATA_FOLDER") {
        let trimmed = isolated.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed).join("signature-templates");
        }
    }
    if let Some(dir) = app_local_data_dir {
        return dir.join("signature-templates");
    }
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        return PathBuf::from(local_app_data)
            .join("com.luckylivio.winkit")
            .join("signature-templates");
    }
    std::env::temp_dir().join("winkit-signature-templates")
}

fn validate_template_id(id: &str) -> Result<&str, AppError> {
    let trimmed = id.trim();
    if trimmed.is_empty()
        || trimmed.len() > 64
        || !trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::invalid_param("Invalid signature template ID."));
    }
    Ok(trimmed)
}

pub fn list_signature_templates_impl(
    templates_dir: &Path,
) -> Result<SignatureTemplatesListResponse, AppError> {
    let storage_dir = templates_dir.to_string_lossy().into_owned();
    if !templates_dir.is_dir() {
        return Ok(SignatureTemplatesListResponse {
            storage_dir,
            items: Vec::new(),
        });
    }
    let mut items = Vec::new();
    let entries = fs::read_dir(templates_dir)
        .map_err(|e| AppError::from_io(e, "Failed to read signature templates directory"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(meta) = serde_json::from_str::<StoredTemplateMeta>(&raw) else {
            continue;
        };
        if validate_template_id(&meta.id).is_err() {
            continue;
        }
        let png_path = templates_dir.join(format!("{}.png", meta.id));
        let Ok(png_bytes) = fs::read(&png_path) else {
            continue;
        };
        if png_bytes.is_empty() || png_bytes.len() > MAX_SIGNATURE_TEMPLATE_PNG_BYTES {
            continue;
        }
        let data_url = format!(
            "data:image/png;base64,{}",
            BASE64_STANDARD.encode(&png_bytes)
        );
        items.push(SignatureTemplateItem {
            id: meta.id,
            name: meta.name,
            created_at_ms: meta.created_at_ms,
            width_px: meta.width_px,
            height_px: meta.height_px,
            png_data_url: data_url,
        });
    }
    items.sort_by_key(|a| std::cmp::Reverse(a.created_at_ms));
    Ok(SignatureTemplatesListResponse { storage_dir, items })
}

pub fn save_signature_template_impl(
    templates_dir: &Path,
    req: &SaveSignatureTemplateRequest,
) -> Result<SignatureTemplateItem, AppError> {
    let clean_name = req.name.trim();
    if clean_name.is_empty() || clean_name.chars().count() > 64 {
        return Err(AppError::invalid_param(
            "Signature template name must be between 1 and 64 characters.",
        ));
    }
    let png_bytes = decode_png_data_url_or_base64(&req.png_data_url)?;
    if png_bytes.len() > MAX_SIGNATURE_TEMPLATE_PNG_BYTES {
        return Err(AppError::size_limit(
            "Signature PNG exceeds the 2 MiB template size limit.",
        ));
    }
    let decoded = image::load_from_memory_with_format(&png_bytes, image::ImageFormat::Png)
        .map_err(|_| AppError::decode_failed("Invalid signature PNG image."))?;
    let width_px = decoded.width();
    let height_px = decoded.height();

    fs::create_dir_all(templates_dir)
        .map_err(|e| AppError::from_io(e, "Failed to create signature templates directory"))?;
    let existing = list_signature_templates_impl(templates_dir)?;
    if existing.items.len() >= MAX_SIGNATURE_TEMPLATES {
        return Err(AppError::invalid_param(format!(
            "Up to {MAX_SIGNATURE_TEMPLATES} saved signature templates are allowed. Delete an old template first."
        )));
    }

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let id = format!("sig-{}", uuid::Uuid::new_v4().simple());
    let meta = StoredTemplateMeta {
        id: id.clone(),
        name: clean_name.to_string(),
        created_at_ms: now_ms,
        width_px,
        height_px,
    };
    let meta_json = serde_json::to_string_pretty(&meta).map_err(|e| {
        AppError::new(
            "INTERNAL_ERROR",
            format!("Failed to serialize metadata: {e}"),
        )
    })?;

    let png_path = templates_dir.join(format!("{id}.png"));
    let meta_path = templates_dir.join(format!("{id}.json"));
    let png_tmp = templates_dir.join(format!("{id}.png.tmp"));
    let meta_tmp = templates_dir.join(format!("{id}.json.tmp"));

    fs::write(&png_tmp, &png_bytes)
        .map_err(|e| AppError::from_io(e, "Failed to write signature template PNG"))?;
    if let Err(e) = fs::rename(&png_tmp, &png_path) {
        let _ = fs::remove_file(&png_tmp);
        return Err(AppError::from_io(
            e,
            "Failed to commit signature template PNG",
        ));
    }
    fs::write(&meta_tmp, meta_json.as_bytes())
        .map_err(|e| AppError::from_io(e, "Failed to write signature template metadata"))?;
    if let Err(e) = fs::rename(&meta_tmp, &meta_path) {
        let _ = fs::remove_file(&meta_tmp);
        let _ = fs::remove_file(&png_path);
        return Err(AppError::from_io(
            e,
            "Failed to commit signature template metadata",
        ));
    }

    Ok(SignatureTemplateItem {
        id,
        name: clean_name.to_string(),
        created_at_ms: now_ms,
        width_px,
        height_px,
        png_data_url: format!(
            "data:image/png;base64,{}",
            BASE64_STANDARD.encode(&png_bytes)
        ),
    })
}

pub fn delete_signature_template_impl(templates_dir: &Path, id: &str) -> Result<(), AppError> {
    let valid_id = validate_template_id(id)?;
    let png_path = templates_dir.join(format!("{valid_id}.png"));
    let meta_path = templates_dir.join(format!("{valid_id}.json"));
    let _ = fs::remove_file(png_path);
    let _ = fs::remove_file(meta_path);
    Ok(())
}

pub fn sign_pdf_impl<F>(
    req: &SignPdfRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: F,
) -> Result<SignPdfResult, AppError>
where
    F: FnMut(&PdfTaskProgressPayload),
{
    if req.placements.is_empty() {
        return Err(AppError::invalid_param(
            "Place at least one signature on a PDF page before exporting.",
        ));
    }
    if req.placements.len() > 200 {
        return Err(AppError::invalid_param(
            "Too many signature placements in one operation (maximum 200).",
        ));
    }

    let (src_path, mut doc, has_signatures, has_acroform) = load_unencrypted_lopdf_doc(&req.path)?;
    let pages_map = doc.get_pages();
    let total_pages = pages_map.len();

    // Validate placements & group by 1-based page number
    let mut placements_by_page: std::collections::BTreeMap<usize, Vec<&PdfSignaturePlacement>> =
        std::collections::BTreeMap::new();
    for p in &req.placements {
        if p.page_number == 0 || p.page_number > total_pages {
            return Err(AppError::invalid_param(format!(
                "Signature placement page {} is out of range (1..={total_pages}).",
                p.page_number
            )));
        }
        if !p.x_norm.is_finite()
            || !p.y_norm.is_finite()
            || !p.width_norm.is_finite()
            || !p.height_norm.is_finite()
            || p.width_norm <= 0.005
            || p.height_norm <= 0.005
            || p.width_norm > 1.5
            || p.height_norm > 1.5
        {
            return Err(AppError::invalid_param(
                "Invalid signature placement coordinates or dimensions.",
            ));
        }
        placements_by_page.entry(p.page_number).or_default().push(p);
    }

    // Deduplicate identical signature PNG data URLs into shared PDF Image XObjects!
    let mut xobj_cache: std::collections::HashMap<String, ObjectId> =
        std::collections::HashMap::new();
    let mut resolve_stamp_xobj =
        |doc: &mut Document, raw_url: &str| -> Result<ObjectId, AppError> {
            if let Some(id) = xobj_cache.get(raw_url) {
                return Ok(*id);
            }
            let png_bytes = decode_png_data_url_or_base64(raw_url)?;
            let img = image::load_from_memory_with_format(&png_bytes, image::ImageFormat::Png)
                .map_err(|_| AppError::decode_failed("Failed to decode signature PNG image."))?
                .to_rgba8();
            let id = embed_rgba_image_xobject(doc, &img)?;
            xobj_cache.insert(raw_url.to_string(), id);
            Ok(id)
        };

    let task_id = req
        .task_id
        .clone()
        .unwrap_or_else(|| "p06-sign".to_string());
    let total_target_pages = placements_by_page.len();
    let mut signed_pages = Vec::with_capacity(total_target_pages);

    for (idx, (&page_num, page_placements)) in placements_by_page.iter().enumerate() {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(AppError::cancelled());
        }
        let page_id = *pages_map
            .get(&(page_num as u32))
            .ok_or_else(|| AppError::new("PDF_PAGE_ERROR", format!("Missing page {page_num}.")))?;
        let frame = resolve_page_frame(&doc, page_id);
        let ctm = display_to_pdf_ctm(frame.crop_box, frame.rotation_cw);

        let mut xobjs: Vec<(String, ObjectId)> = Vec::new();
        let mut gstates: Vec<(String, ObjectId)> = Vec::new();
        let mut ops = String::new();
        ops.push_str("q\n");
        ops.push_str(&format_ctm_op(ctm));
        // Clip cleanly to visible displayed crop box
        ops.push_str(&format!(
            "0 0 {:.4} {:.4} re W n\n",
            frame.display_width_pt, frame.display_height_pt
        ));

        for (p_idx, pl) in page_placements.iter().enumerate() {
            let raw_url = pl
                .stamp_png_data_url
                .as_deref()
                .or(req.signature_png_data_url.as_deref())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    AppError::invalid_param("Missing signature image PNG for placement.")
                })?;
            let xobj_id = resolve_stamp_xobj(&mut doc, raw_url)?;
            let gs_id = add_ext_gstate_opacity(&mut doc, pl.opacity.clamp(0.1, 1.0));
            let img_ph = format!("__SIG_IM_{p_idx}__");
            let gs_ph = format!("__SIG_GS_{p_idx}__");
            xobjs.push((img_ph.clone(), xobj_id));
            gstates.push((gs_ph.clone(), gs_id));

            let w_pt = pl.width_norm * frame.display_width_pt;
            let h_pt = pl.height_norm * frame.display_height_pt;
            let cx_pt = (pl.x_norm + pl.width_norm * 0.5) * frame.display_width_pt;
            let cy_pt = (1.0 - (pl.y_norm + pl.height_norm * 0.5)) * frame.display_height_pt;
            let rot_cw = pl.rotation_deg.clamp(-360.0, 360.0);

            ops.push_str(&build_centered_image_draw_ops(
                cx_pt, cy_pt, w_pt, h_pt, rot_cw, &img_ph, &gs_ph,
            ));
        }
        ops.push_str("Q\n");

        append_overlay_to_page(&mut doc, page_id, &xobjs, &gstates, ops.as_bytes())?;
        signed_pages.push(page_num);

        on_progress(&PdfTaskProgressPayload {
            task_id: task_id.clone(),
            tool_id: "P06".to_string(),
            current: idx + 1,
            total: total_target_pages,
            percent: ((idx + 1) as f64 / total_target_pages.max(1) as f64) * 90.0,
            detail: format!(
                "Signed page {page_num} ({}/{})",
                idx + 1,
                total_target_pages
            ),
        });
    }

    let mut warnings = Vec::new();
    if has_signatures {
        strip_invalidated_signature_markers(&mut doc);
        warnings.push(
            "The source PDF contained digital signature fields; the exported signed copy invalidates original cryptographic signatures. Visual signatures added here are not CA-certified digital signatures."
                .to_string(),
        );
    }
    if has_acroform {
        warnings.push(
            "Source PDF contains interactive form fields; visual signatures were embedded as page appearance overlays."
                .to_string(),
        );
    }

    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let (committed, byte_length) = save_lopdf_atomic(
        &mut doc,
        &req.output_path,
        &[src_path],
        req.overwrite.unwrap_or(false),
    )?;

    on_progress(&PdfTaskProgressPayload {
        task_id,
        tool_id: "P06".to_string(),
        current: total_target_pages,
        total: total_target_pages,
        percent: 100.0,
        detail: "Completed visual PDF signing.".to_string(),
    });

    Ok(SignPdfResult {
        output_path: committed.to_string_lossy().into_owned(),
        byte_length,
        total_pages,
        signed_pages,
        placement_count: req.placements.len(),
        signature_invalidated: has_signatures,
        warnings,
    })
}

// ================================================================================================
// P13: Non-Destructive PDF Page Cropping & Auto White-Margin Detection
// ================================================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectWhiteMarginsRequest {
    pub path: String,
    pub page_number: usize,
    pub padding_pt: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedWhiteMargins {
    pub page_number: usize,
    pub is_blank: bool,
    pub page_width_pt: f32,
    pub page_height_pt: f32,
    pub left_pt: f32,
    pub right_pt: f32,
    pub top_pt: f32,
    pub bottom_pt: f32,
    pub left_norm: f32,
    pub top_norm: f32,
    pub width_norm: f32,
    pub height_norm: f32,
}

pub fn detect_pdf_white_margins_impl(
    pdf_mgr: &PdfSessionManager,
    req: &DetectWhiteMarginsRequest,
) -> Result<DetectedWhiteMargins, AppError> {
    let (canonical, _) = validate_existing_input_file(&req.path)?;
    if req.page_number == 0 {
        return Err(AppError::invalid_param("Page number must be >= 1."));
    }
    let padding_pt = req.padding_pt.unwrap_or(6.0).clamp(0.0, 72.0);
    // Render at 96 DPI capped at 1200px wide for fast, accurate margin analysis.
    let (meta, rgba) =
        pdf_mgr.render_page_rgba_for_export(&canonical, req.page_number, 96.0, 0, 1200)?;
    let w = meta.width_px as usize;
    let h = meta.height_px as usize;
    if w == 0 || h == 0 || rgba.len() < w * h * 4 {
        return Err(AppError::new(
            "PDF_RENDER_FAILED",
            "Rendered page buffer was empty during white-margin detection.",
        ));
    }

    let mut min_x = w;
    let mut min_y = h;
    let mut max_x = 0usize;
    let mut max_y = 0usize;
    let mut found = false;

    for y in 0..h {
        let row_off = y * w * 4;
        for x in 0..w {
            let i = row_off + x * 4;
            let r = rgba[i];
            let g = rgba[i + 1];
            let b = rgba[i + 2];
            let a = rgba[i + 3];
            // Non-white visible pixel threshold
            if a >= 16 && (r < 246 || g < 246 || b < 246) {
                found = true;
                if x < min_x {
                    min_x = x;
                }
                if x > max_x {
                    max_x = x;
                }
                if y < min_y {
                    min_y = y;
                }
                if y > max_y {
                    max_y = y;
                }
            }
        }
    }

    let pw = meta.page_width_pt.max(1.0);
    let ph = meta.page_height_pt.max(1.0);
    if !found {
        return Ok(DetectedWhiteMargins {
            page_number: req.page_number,
            is_blank: true,
            page_width_pt: pw,
            page_height_pt: ph,
            left_pt: 0.0,
            right_pt: 0.0,
            top_pt: 0.0,
            bottom_pt: 0.0,
            left_norm: 0.0,
            top_norm: 0.0,
            width_norm: 1.0,
            height_norm: 1.0,
        });
    }

    let mut left_pt = ((min_x as f32 / w as f32) * pw - padding_pt).max(0.0);
    let mut right_pt = (((w - 1 - max_x) as f32 / w as f32) * pw - padding_pt).max(0.0);
    let mut top_pt = ((min_y as f32 / h as f32) * ph - padding_pt).max(0.0);
    let mut bottom_pt = (((h - 1 - max_y) as f32 / h as f32) * ph - padding_pt).max(0.0);

    // Ensure remaining box stays above MIN_CROPPED_SIDE_PT
    if pw - left_pt - right_pt < MIN_CROPPED_SIDE_PT {
        left_pt = 0.0;
        right_pt = 0.0;
    }
    if ph - top_pt - bottom_pt < MIN_CROPPED_SIDE_PT {
        top_pt = 0.0;
        bottom_pt = 0.0;
    }

    let left_norm = (left_pt / pw).clamp(0.0, 0.95);
    let top_norm = (top_pt / ph).clamp(0.0, 0.95);
    let width_norm = ((pw - left_pt - right_pt) / pw).clamp(0.05, 1.0 - left_norm);
    let height_norm = ((ph - top_pt - bottom_pt) / ph).clamp(0.05, 1.0 - top_norm);

    Ok(DetectedWhiteMargins {
        page_number: req.page_number,
        is_blank: false,
        page_width_pt: round_pt(pw),
        page_height_pt: round_pt(ph),
        left_pt: round_pt(left_pt),
        right_pt: round_pt(right_pt),
        top_pt: round_pt(top_pt),
        bottom_pt: round_pt(bottom_pt),
        left_norm,
        top_norm,
        width_norm,
        height_norm,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PdfCropScope {
    Current,
    All,
    Range,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PdfCropUnitsMode {
    /// Apply exact visual margin trim in points (`left/right/top/bottom_pt`).
    MarginsPt,
    /// Apply normalized visual box (`left/top/width/height_norm`) relative to each target page.
    NormalizedBox,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropPdfRequest {
    pub task_id: Option<String>,
    pub path: String,
    pub output_path: String,
    pub overwrite: Option<bool>,
    pub scope: PdfCropScope,
    pub current_page: Option<usize>,
    pub page_range: Option<String>,
    pub mode: PdfCropUnitsMode,
    pub left_pt: Option<f32>,
    pub right_pt: Option<f32>,
    pub top_pt: Option<f32>,
    pub bottom_pt: Option<f32>,
    pub left_norm: Option<f32>,
    pub top_norm: Option<f32>,
    pub width_norm: Option<f32>,
    pub height_norm: Option<f32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CroppedPageDimSummary {
    pub page_number: usize,
    pub old_width_pt: f32,
    pub old_height_pt: f32,
    pub new_width_pt: f32,
    pub new_height_pt: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CropPdfResult {
    pub output_path: String,
    pub byte_length: u64,
    pub total_pages: usize,
    pub cropped_page_count: usize,
    pub sample_pages: Vec<CroppedPageDimSummary>,
    pub signature_invalidated: bool,
    pub warnings: Vec<String>,
}

/// Computes the new unrotated PDF `/CropBox` given a page's resolved frame and visual crop margins
/// `(left_pt, right_pt, top_pt, bottom_pt)` measured in displayed upright coordinates.
pub fn compute_cropped_pdf_box_from_visual_margins(
    frame: ResolvedPageFrame,
    left_pt: f32,
    right_pt: f32,
    top_pt: f32,
    bottom_pt: f32,
) -> Result<PdfBox, AppError> {
    if !left_pt.is_finite()
        || !right_pt.is_finite()
        || !top_pt.is_finite()
        || !bottom_pt.is_finite()
        || left_pt < 0.0
        || right_pt < 0.0
        || top_pt < 0.0
        || bottom_pt < 0.0
    {
        return Err(AppError::invalid_param(
            "Crop margins must be non-negative finite numbers.",
        ));
    }
    let sx0 = left_pt;
    let sx1 = frame.display_width_pt - right_pt;
    let sy0 = bottom_pt;
    let sy1 = frame.display_height_pt - top_pt;
    if sx1 - sx0 < MIN_CROPPED_SIDE_PT || sy1 - sy0 < MIN_CROPPED_SIDE_PT {
        return Err(AppError::invalid_param(format!(
            "Cropped page area would be smaller than the minimum {MIN_CROPPED_SIDE_PT} pt × {MIN_CROPPED_SIDE_PT} pt."
        )));
    }
    let (px_a, py_a) = display_to_pdf_point(frame.crop_box, frame.rotation_cw, sx0, sy0);
    let (px_b, py_b) = display_to_pdf_point(frame.crop_box, frame.rotation_cw, sx1, sy1);
    let raw = PdfBox::normalized(px_a, py_a, px_b, py_b);
    let clamped = raw.intersect(frame.media_box).ok_or_else(|| {
        AppError::invalid_param("Resulting crop rectangle lies outside the page MediaBox.")
    })?;
    if clamped.width() < MIN_CROPPED_SIDE_PT || clamped.height() < MIN_CROPPED_SIDE_PT {
        return Err(AppError::invalid_param(format!(
            "Cropped page area would be smaller than {MIN_CROPPED_SIDE_PT} pt."
        )));
    }
    Ok(clamped)
}

pub fn crop_pdf_impl<F>(
    req: &CropPdfRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: F,
) -> Result<CropPdfResult, AppError>
where
    F: FnMut(&PdfTaskProgressPayload),
{
    let (src_path, mut doc, has_signatures, _) = load_unencrypted_lopdf_doc(&req.path)?;
    let pages_map = doc.get_pages();
    let total_pages = pages_map.len();

    let target_pages: Vec<usize> = match req.scope {
        PdfCropScope::Current => {
            let p = req.current_page.unwrap_or(1);
            if p == 0 || p > total_pages {
                return Err(AppError::invalid_param(format!(
                    "Current page {p} is out of range (1..={total_pages})."
                )));
            }
            vec![p]
        }
        PdfCropScope::All => (1..=total_pages).collect(),
        PdfCropScope::Range => {
            let spec = req.page_range.as_deref().unwrap_or("").trim();
            let parsed = parse_page_range_spec(spec, total_pages)?;
            let dedup: BTreeSet<usize> = parsed.pages.into_iter().collect();
            dedup.into_iter().collect()
        }
    };

    let task_id = req
        .task_id
        .clone()
        .unwrap_or_else(|| "p13-crop".to_string());
    let mut warnings = Vec::new();
    let mut sample_pages = Vec::new();
    let mut cropped_count = 0usize;

    for (idx, &page_num) in target_pages.iter().enumerate() {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(AppError::cancelled());
        }
        let page_id = *pages_map
            .get(&(page_num as u32))
            .ok_or_else(|| AppError::new("PDF_PAGE_ERROR", format!("Missing page {page_num}.")))?;
        let frame = resolve_page_frame(&doc, page_id);

        let (l_pt, r_pt, t_pt, b_pt) = match req.mode {
            PdfCropUnitsMode::MarginsPt => (
                req.left_pt.unwrap_or(0.0),
                req.right_pt.unwrap_or(0.0),
                req.top_pt.unwrap_or(0.0),
                req.bottom_pt.unwrap_or(0.0),
            ),
            PdfCropUnitsMode::NormalizedBox => {
                let ln = req.left_norm.unwrap_or(0.0).clamp(0.0, 0.98);
                let tn = req.top_norm.unwrap_or(0.0).clamp(0.0, 0.98);
                let wn = req.width_norm.unwrap_or(1.0).clamp(0.02, 1.0 - ln);
                let hn = req.height_norm.unwrap_or(1.0).clamp(0.02, 1.0 - tn);
                (
                    ln * frame.display_width_pt,
                    (1.0 - ln - wn).max(0.0) * frame.display_width_pt,
                    tn * frame.display_height_pt,
                    (1.0 - tn - hn).max(0.0) * frame.display_height_pt,
                )
            }
        };

        let new_crop = match compute_cropped_pdf_box_from_visual_margins(
            frame, l_pt, r_pt, t_pt, b_pt,
        ) {
            Ok(b) => b,
            Err(err) => {
                if target_pages.len() == 1 {
                    return Err(err);
                }
                warnings.push(format!(
                    "Page {page_num} skipped because crop margins exceeded page bounds ({:.1}×{:.1} pt).",
                    frame.display_width_pt, frame.display_height_pt
                ));
                continue;
            }
        };

        let page_dict = doc.get_dictionary_mut(page_id).map_err(|_| {
            AppError::new(
                "PDF_PAGE_ERROR",
                format!("Missing page {page_num} dictionary."),
            )
        })?;
        // Materialize MediaBox on the page if inherited, then set CropBox (and align TrimBox/ArtBox if present).
        if !page_dict.has(b"MediaBox") {
            page_dict.set("MediaBox", frame.media_box.to_pdf_array());
        }
        page_dict.set("CropBox", new_crop.to_pdf_array());
        if page_dict.has(b"TrimBox") {
            page_dict.set("TrimBox", new_crop.to_pdf_array());
        }
        if page_dict.has(b"ArtBox") {
            page_dict.set("ArtBox", new_crop.to_pdf_array());
        }

        let (new_w, new_h) = if frame.rotation_cw % 180 == 90 {
            (new_crop.height(), new_crop.width())
        } else {
            (new_crop.width(), new_crop.height())
        };
        cropped_count += 1;
        if sample_pages.len() < 12 {
            sample_pages.push(CroppedPageDimSummary {
                page_number: page_num,
                old_width_pt: round_pt(frame.display_width_pt),
                old_height_pt: round_pt(frame.display_height_pt),
                new_width_pt: round_pt(new_w),
                new_height_pt: round_pt(new_h),
            });
        }

        on_progress(&PdfTaskProgressPayload {
            task_id: task_id.clone(),
            tool_id: "P13".to_string(),
            current: idx + 1,
            total: target_pages.len(),
            percent: ((idx + 1) as f64 / target_pages.len().max(1) as f64) * 90.0,
            detail: format!(
                "Cropped page {page_num} ({}/{})",
                idx + 1,
                target_pages.len()
            ),
        });
    }

    if cropped_count == 0 {
        return Err(AppError::invalid_param(
            "No pages could be cropped with the selected margins.",
        ));
    }

    if has_signatures {
        strip_invalidated_signature_markers(&mut doc);
        warnings.push(
            "The source PDF contained digital signatures; modifying page boxes invalidates original signatures."
                .to_string(),
        );
    }

    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let (committed, byte_length) = save_lopdf_atomic(
        &mut doc,
        &req.output_path,
        &[src_path],
        req.overwrite.unwrap_or(false),
    )?;

    on_progress(&PdfTaskProgressPayload {
        task_id,
        tool_id: "P13".to_string(),
        current: target_pages.len(),
        total: target_pages.len(),
        percent: 100.0,
        detail: "Completed PDF cropping.".to_string(),
    });

    Ok(CropPdfResult {
        output_path: committed.to_string_lossy().into_owned(),
        byte_length,
        total_pages,
        cropped_page_count: cropped_count,
        sample_pages,
        signature_invalidated: has_signatures,
        warnings,
    })
}

// ================================================================================================
// I13: PDF Watermark Mode (sharing WatermarkStyleConfig & placement math with Image/Video modes)
// ================================================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PdfWatermarkScope {
    All,
    Current,
    Odd,
    Even,
    Range,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkPdfRequest {
    pub task_id: Option<String>,
    pub path: String,
    pub output_path: String,
    pub overwrite: Option<bool>,
    pub scope: PdfWatermarkScope,
    pub current_page: Option<usize>,
    pub page_range: Option<String>,
    pub style: WatermarkStyleConfig,
    /// Optional clockwise rotation in degrees (`-180..=180`, default `0`) for single 9-grid placements.
    pub single_angle_deg: Option<f32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkPdfResult {
    pub output_path: String,
    pub byte_length: u64,
    pub total_pages: usize,
    pub watermarked_page_count: usize,
    pub signature_invalidated: bool,
    pub warnings: Vec<String>,
}

fn compute_watermark_ops_for_page(
    frame: ResolvedPageFrame,
    stamp_w_px: u32,
    stamp_h_px: u32,
    style: &WatermarkStyleConfig,
    single_angle_deg: f32,
    img_ph: &str,
    gs_ph: &str,
) -> String {
    let base_w = frame.display_width_pt.max(1.0);
    let base_h = frame.display_height_pt.max(1.0);
    // Use high-precision virtual grid (×4) to keep exact aspect ratios matching `compute_scaled_stamp_size`
    let (tw_u, th_u) = compute_scaled_stamp_size(
        (base_w * 4.0).round().max(1.0) as u32,
        (base_h * 4.0).round().max(1.0) as u32,
        stamp_w_px,
        stamp_h_px,
        style.scale_percent,
    );
    let tw = (tw_u as f32) / 4.0;
    let th = (th_u as f32) / 4.0;
    let margin = base_w.min(base_h) * (style.margin_percent.clamp(0.0, 25.0) / 100.0);

    let ctm = display_to_pdf_ctm(frame.crop_box, frame.rotation_cw);
    let mut ops = String::new();
    ops.push_str("q\n");
    ops.push_str(&format_ctm_op(ctm));
    ops.push_str(&format!("0 0 {:.4} {:.4} re W n\n", base_w, base_h));

    if style.placement == WatermarkPlacement::DiagonalTile {
        let angle_deg = style.tile_angle_deg.unwrap_or(-30.0).clamp(-60.0, 60.0);
        let rad = angle_deg.to_radians();
        let cos_a = rad.cos().abs();
        let sin_a = rad.sin().abs();
        let rot_w = (tw * cos_a + th * sin_a).ceil().max(4.0);
        let rot_h = (tw * sin_a + th * cos_a).ceil().max(4.0);
        let spacing = style
            .tile_spacing_percent
            .unwrap_or(110.0)
            .clamp(30.0, 250.0)
            / 100.0;
        let step_x = (rot_w * (1.0 + spacing * 0.55)).max(15.0);
        let step_y = (rot_h * (1.0 + spacing * 0.65)).max(15.0);

        let mut row_idx = 0usize;
        let mut y = -rot_h * 0.5;
        let mut draw_count = 0usize;
        while y < base_h + rot_h && draw_count < 600 {
            let x_off = if row_idx % 2 == 1 { step_x * 0.5 } else { 0.0 };
            let mut x = -rot_w + x_off;
            while x < base_w + rot_w && draw_count < 600 {
                let cx_canvas = x + rot_w * 0.5;
                let cy_canvas = y + rot_h * 0.5;
                let cx_pdf = cx_canvas;
                let cy_pdf = base_h - cy_canvas;
                ops.push_str(&build_centered_image_draw_ops(
                    cx_pdf, cy_pdf, tw, th, angle_deg, img_ph, gs_ph,
                ));
                draw_count += 1;
                x += step_x;
            }
            row_idx += 1;
            y += step_y;
        }
    } else {
        let (ox, oy) = match style.placement {
            WatermarkPlacement::TopLeft => (margin, margin),
            WatermarkPlacement::TopCenter => ((base_w - tw) * 0.5, margin),
            WatermarkPlacement::TopRight => (base_w - tw - margin, margin),
            WatermarkPlacement::MiddleLeft => (margin, (base_h - th) * 0.5),
            WatermarkPlacement::Center => ((base_w - tw) * 0.5, (base_h - th) * 0.5),
            WatermarkPlacement::MiddleRight => (base_w - tw - margin, (base_h - th) * 0.5),
            WatermarkPlacement::BottomLeft => (margin, base_h - th - margin),
            WatermarkPlacement::BottomCenter => ((base_w - tw) * 0.5, base_h - th - margin),
            WatermarkPlacement::BottomRight => (base_w - tw - margin, base_h - th - margin),
            WatermarkPlacement::DiagonalTile => unreachable!(),
        };
        let cx_pdf = ox + tw * 0.5;
        let cy_pdf = base_h - (oy + th * 0.5);
        let rot = single_angle_deg.clamp(-180.0, 180.0);
        ops.push_str(&build_centered_image_draw_ops(
            cx_pdf, cy_pdf, tw, th, rot, img_ph, gs_ph,
        ));
    }

    ops.push_str("Q\n");
    ops
}

pub fn watermark_pdf_impl<F>(
    req: &WatermarkPdfRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: F,
) -> Result<WatermarkPdfResult, AppError>
where
    F: FnMut(&PdfTaskProgressPayload),
{
    let stamp_rgba = load_stamp_rgba(&req.style)?;
    let (src_path, mut doc, has_signatures, has_acroform) = load_unencrypted_lopdf_doc(&req.path)?;
    let pages_map = doc.get_pages();
    let total_pages = pages_map.len();

    let target_pages: Vec<usize> = match req.scope {
        PdfWatermarkScope::All => (1..=total_pages).collect(),
        PdfWatermarkScope::Current => {
            let p = req.current_page.unwrap_or(1);
            if p == 0 || p > total_pages {
                return Err(AppError::invalid_param(format!(
                    "Current page {p} is out of range (1..={total_pages})."
                )));
            }
            vec![p]
        }
        PdfWatermarkScope::Odd => (1..=total_pages).filter(|p| p % 2 == 1).collect(),
        PdfWatermarkScope::Even => (1..=total_pages).filter(|p| p % 2 == 0).collect(),
        PdfWatermarkScope::Range => {
            let spec = req.page_range.as_deref().unwrap_or("").trim();
            let parsed = parse_page_range_spec(spec, total_pages)?;
            let dedup: BTreeSet<usize> = parsed.pages.into_iter().collect();
            dedup.into_iter().collect()
        }
    };

    if target_pages.is_empty() {
        return Err(AppError::invalid_param(
            "No pages matched the selected watermark scope (for example, a 1-page PDF has no even pages).",
        ));
    }

    // Embed the watermark stamp & ExtGState ONCE and reuse across all target pages!
    let stamp_xobj_id = embed_rgba_image_xobject(&mut doc, &stamp_rgba)?;
    let opacity = (req.style.opacity_percent.clamp(5.0, 100.0)) / 100.0;
    let gs_id = add_ext_gstate_opacity(&mut doc, opacity);
    let single_angle = req.single_angle_deg.unwrap_or(0.0).clamp(-180.0, 180.0);

    let task_id = req
        .task_id
        .clone()
        .unwrap_or_else(|| "i13-pdf-watermark".to_string());
    let img_ph = "__WM_IM__".to_string();
    let gs_ph = "__WM_GS__".to_string();

    for (idx, &page_num) in target_pages.iter().enumerate() {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(AppError::cancelled());
        }
        let page_id = *pages_map
            .get(&(page_num as u32))
            .ok_or_else(|| AppError::new("PDF_PAGE_ERROR", format!("Missing page {page_num}.")))?;
        let frame = resolve_page_frame(&doc, page_id);
        let ops = compute_watermark_ops_for_page(
            frame,
            stamp_rgba.width(),
            stamp_rgba.height(),
            &req.style,
            single_angle,
            &img_ph,
            &gs_ph,
        );
        append_overlay_to_page(
            &mut doc,
            page_id,
            &[(img_ph.clone(), stamp_xobj_id)],
            &[(gs_ph.clone(), gs_id)],
            ops.as_bytes(),
        )?;

        on_progress(&PdfTaskProgressPayload {
            task_id: task_id.clone(),
            tool_id: "I13".to_string(),
            current: idx + 1,
            total: target_pages.len(),
            percent: ((idx + 1) as f64 / target_pages.len().max(1) as f64) * 90.0,
            detail: format!(
                "Watermarked page {page_num} ({}/{})",
                idx + 1,
                target_pages.len()
            ),
        });
    }

    let mut warnings = Vec::new();
    if has_signatures {
        strip_invalidated_signature_markers(&mut doc);
        warnings.push(
            "The source PDF contained digital signatures; watermarking creates a new copy that invalidates original cryptographic signatures."
                .to_string(),
        );
    }
    if has_acroform {
        warnings.push(
            "Source PDF contains interactive form fields; watermarks were overlaid on page content."
                .to_string(),
        );
    }

    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let (committed, byte_length) = save_lopdf_atomic(
        &mut doc,
        &req.output_path,
        &[src_path],
        req.overwrite.unwrap_or(false),
    )?;

    on_progress(&PdfTaskProgressPayload {
        task_id,
        tool_id: "I13".to_string(),
        current: target_pages.len(),
        total: target_pages.len(),
        percent: 100.0,
        detail: "Completed PDF watermarking.".to_string(),
    });

    Ok(WatermarkPdfResult {
        output_path: committed.to_string_lossy().into_owned(),
        byte_length,
        total_pages,
        watermarked_page_count: target_pages.len(),
        signature_invalidated: has_signatures,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image_assets::encode_rgba_to_png_fast;
    use crate::pdf_pdfium::{
        extract_page_text_with_pdfium, render_page_rgba_with_pdfium, resolve_pdfium_dll_path,
    };
    use image::Rgba;
    use lopdf::dictionary;

    /// Helper: builds a multi-page PDF with distinct quadrant colors + selectable text +
    /// non-zero CropBox + `/Rotate` values (0, 90, 180, 270) so every coordinate transform
    /// is verified pixel-by-pixel using real PDFium rendering!
    fn build_rotated_quadrant_pdf(path: &Path) {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let font_id = doc.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
        });

        // Create 4 pages:
        // Page 1: rot=0,   MediaBox [0 0 400 600], CropBox [40 60 360 540] -> disp 320x480
        // Page 2: rot=90,  MediaBox [0 0 400 600], CropBox [40 60 360 540] -> disp 480x320
        // Page 3: rot=180, MediaBox [0 0 400 600], CropBox [40 60 360 540] -> disp 320x480
        // Page 4: rot=270, MediaBox [0 0 400 600], CropBox [40 60 360 540] -> disp 480x320
        // Each page has selectable text "WINKIT_COORD_PAGE_N" and white background with a dark inner box.
        let mut kids = Vec::new();
        for (idx, rot) in [0i64, 90, 180, 270].iter().enumerate() {
            let content = format!(
                "1 1 1 rg 0 0 400 600 re f \
                 0.1 0.1 0.1 rg 140 240 120 120 re f \
                 BT /F1 16 Tf 120 300 Td (WINKIT_COORD_PAGE_{}) Tj ET\n",
                idx + 1
            );
            let content_id = doc.add_object(Object::Stream(Stream::new(
                Dictionary::new(),
                content.into_bytes(),
            )));
            let mut page_dict = dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 400.into(), 600.into()],
                "CropBox" => vec![40.into(), 60.into(), 360.into(), 540.into()],
                "Rotate" => *rot,
                "Resources" => dictionary! {
                    "Font" => dictionary! {
                        "F1" => font_id,
                    },
                },
                "Contents" => content_id,
            };
            if idx == 0 {
                // Add an external URI link on page 1 to verify link preservation
                let annot_id = doc.add_object(dictionary! {
                    "Type" => "Annot",
                    "Subtype" => "Link",
                    "Rect" => vec![100.into(), 280.into(), 300.into(), 320.into()],
                    "A" => dictionary! {
                        "Type" => "Action",
                        "S" => "URI",
                        "URI" => Object::string_literal("https://example.org/winkit-5b"),
                    },
                });
                page_dict.set("Annots", Object::Array(vec![Object::Reference(annot_id)]));
            }
            let pid = doc.add_object(page_dict);
            kids.push(Object::Reference(pid));
        }

        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => kids,
                "Count" => 4,
            }),
        );
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        doc.trailer.set("Root", catalog_id);
        doc.save(path).expect("save test pdf");
    }

    fn make_solid_png_data_url(w: u32, h: u32, rgba: [u8; 4]) -> String {
        let img = RgbaImage::from_pixel(w, h, Rgba(rgba));
        let png = encode_rgba_to_png_fast(&img).expect("encode png");
        format!("data:image/png;base64,{}", BASE64_STANDARD.encode(png))
    }

    #[test]
    fn display_to_pdf_ctm_maps_all_four_rotations_and_nonzero_origin_exact() {
        let cb = PdfBox {
            x0: 72.0,
            y0: 100.0,
            x1: 667.0,
            y1: 942.0,
        };
        // R=0: BL(0,0)->(72,100), TR(595,842)->(667,942)
        assert_eq!(display_to_pdf_point(cb, 0, 0.0, 0.0), (72.0, 100.0));
        assert_eq!(display_to_pdf_point(cb, 0, 595.0, 842.0), (667.0, 942.0));
        // R=90 CW: W_disp=842, H_disp=595; BL(0,0)->(667,100), TL(0,595)->(72,100), TR(842,595)->(72,942)
        assert_eq!(display_to_pdf_point(cb, 90, 0.0, 0.0), (667.0, 100.0));
        assert_eq!(display_to_pdf_point(cb, 90, 0.0, 595.0), (72.0, 100.0));
        assert_eq!(display_to_pdf_point(cb, 90, 842.0, 595.0), (72.0, 942.0));
        // R=180: BL(0,0)->(667,942), TR(595,842)->(72,100)
        assert_eq!(display_to_pdf_point(cb, 180, 0.0, 0.0), (667.0, 942.0));
        assert_eq!(display_to_pdf_point(cb, 180, 595.0, 842.0), (72.0, 100.0));
        // R=270 CW: BL(0,0)->(72,942), BR(842,0)->(72,100), TL(0,595)->(667,942)
        assert_eq!(display_to_pdf_point(cb, 270, 0.0, 0.0), (72.0, 942.0));
        assert_eq!(display_to_pdf_point(cb, 270, 842.0, 0.0), (72.0, 100.0));
        assert_eq!(display_to_pdf_point(cb, 270, 0.0, 595.0), (667.0, 942.0));
    }

    #[test]
    fn p06_p13_i13_pixel_accurate_across_all_four_rotations_and_nonzero_cropbox() {
        if resolve_pdfium_dll_path(None).is_err() {
            return;
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let src = dir.path().join("rotated_4p.pdf");
        build_rotated_quadrant_pdf(&src);
        let cancel = AtomicBool::new(false);

        // 1. P06: Place bright RED stamp in VISUAL TOP-LEFT quadrant (x_norm=0.05, y_norm=0.05, 0.25×0.20)
        //    on ALL 4 rotated pages (0°, 90°, 180°, 270°) with non-zero CropBox [40, 60, 360, 540]!
        let signed_pdf = dir.path().join("signed.pdf");
        let red_sig = make_solid_png_data_url(120, 60, [220, 30, 30, 230]);
        let placements = (1..=4)
            .map(|p| PdfSignaturePlacement {
                page_number: p,
                x_norm: 0.05,
                y_norm: 0.05,
                width_norm: 0.25,
                height_norm: 0.20,
                rotation_deg: 0.0,
                opacity: 1.0,
                stamp_png_data_url: None,
            })
            .collect();
        let sign_res = sign_pdf_impl(
            &SignPdfRequest {
                task_id: Some("t-sign".to_string()),
                path: src.to_string_lossy().into_owned(),
                output_path: signed_pdf.to_string_lossy().into_owned(),
                overwrite: Some(false),
                signature_png_data_url: Some(red_sig),
                placements,
            },
            &cancel,
            |_| {},
        )
        .expect("sign pdf");
        assert_eq!(sign_res.signed_pages, vec![1, 2, 3, 4]);

        // Verify via PDFium: on ALL 4 pages, visual TOP-LEFT pixel (15%, 12%) is RED while BOTTOM-RIGHT (85%, 85%) is WHITE,
        // AND selectable text + URI link remain intact!
        for page_num in 1..=4 {
            let (meta, rgba) =
                render_page_rgba_with_pdfium(None, &signed_pdf, page_num, Some(300), None, 0, 1200)
                    .expect("render signed");
            let w = meta.width_px as usize;
            let h = meta.height_px as usize;
            let tl_x = (w as f32 * 0.15) as usize;
            let tl_y = (h as f32 * 0.12) as usize;
            let tl_i = (tl_y * w + tl_x) * 4;
            assert!(
                rgba[tl_i] > 180 && rgba[tl_i + 1] < 90 && rgba[tl_i + 2] < 90,
                "Page {page_num} visual top-left expected RED signature ink, got {:?}",
                &rgba[tl_i..tl_i + 4]
            );
            let br_x = (w as f32 * 0.85) as usize;
            let br_y = (h as f32 * 0.85) as usize;
            let br_i = (br_y * w + br_x) * 4;
            assert!(
                rgba[br_i] > 240 && rgba[br_i + 1] > 240 && rgba[br_i + 2] > 240,
                "Page {page_num} visual bottom-right expected WHITE, got {:?}",
                &rgba[br_i..br_i + 4]
            );
            let txt = extract_page_text_with_pdfium(None, &signed_pdf, page_num).expect("text");
            assert!(
                txt.full_text
                    .contains(&format!("WINKIT_COORD_PAGE_{page_num}")),
                "Selectable text lost on page {page_num}: {}",
                txt.full_text
            );
            if page_num == 1 {
                assert!(
                    txt.links
                        .iter()
                        .any(|l| l.uri.as_deref() == Some("https://example.org/winkit-5b")),
                    "External URI link lost after signing"
                );
            }
        }

        // 2. P13: Crop ONLY visual TOP by 100pt and RIGHT by 60pt across ALL 4 rotated pages!
        let cropped_pdf = dir.path().join("cropped.pdf");
        let crop_res = crop_pdf_impl(
            &CropPdfRequest {
                task_id: Some("t-crop".to_string()),
                path: signed_pdf.to_string_lossy().into_owned(),
                output_path: cropped_pdf.to_string_lossy().into_owned(),
                overwrite: Some(false),
                scope: PdfCropScope::All,
                current_page: None,
                page_range: None,
                mode: PdfCropUnitsMode::MarginsPt,
                left_pt: Some(0.0),
                right_pt: Some(60.0),
                top_pt: Some(100.0),
                bottom_pt: Some(0.0),
                left_norm: None,
                top_norm: None,
                width_norm: None,
                height_norm: None,
            },
            &cancel,
            |_| {},
        )
        .expect("crop pdf");
        assert_eq!(crop_res.cropped_page_count, 4);
        // Verify resulting displayed dimensions on page 1 (320-60=260, 480-100=380) and page 2 (480-60=420, 320-100=220)
        assert!((crop_res.sample_pages[0].new_width_pt - 260.0).abs() < 1.0);
        assert!((crop_res.sample_pages[0].new_height_pt - 380.0).abs() < 1.0);
        assert!((crop_res.sample_pages[1].new_width_pt - 420.0).abs() < 1.0);
        assert!((crop_res.sample_pages[1].new_height_pt - 220.0).abs() < 1.0);

        // Verify via PDFium: because visual top 100pt was cropped off, the red top-left signature
        // (which sat in top 5%..25% = 24..120pt on 480pt page 1, or 16..80pt on 320pt page 2) is now GONE on page 2!
        let (meta_p2, rgba_p2) =
            render_page_rgba_with_pdfium(None, &cropped_pdf, 2, Some(300), None, 0, 1200)
                .expect("render cropped p2");
        assert!((meta_p2.page_width_pt - 420.0).abs() < 1.0);
        assert!((meta_p2.page_height_pt - 220.0).abs() < 1.0);
        let p2_tl = ((meta_p2.height_px as usize / 10) * meta_p2.width_px as usize
            + (meta_p2.width_px as usize / 10))
            * 4;
        assert!(
            rgba_p2[p2_tl] > 230 && rgba_p2[p2_tl + 1] > 230 && rgba_p2[p2_tl + 2] > 230,
            "Cropped 90°-rotated page 2 still had red top-left stamp -> wrong axis cropped! got {:?}",
            &rgba_p2[p2_tl..p2_tl + 4]
        );

        // Auto white-margin detection check
        let mgr = PdfSessionManager::default();
        let margins = detect_pdf_white_margins_impl(
            &mgr,
            &DetectWhiteMarginsRequest {
                path: src.to_string_lossy().into_owned(),
                page_number: 2,
                padding_pt: Some(4.0),
            },
        )
        .expect("detect white margins");
        assert!(!margins.is_blank);
        assert!(margins.left_pt > 50.0 && margins.right_pt > 50.0);

        // 3. I13 PDF Watermark: place BLUE stamp in VISUAL BOTTOM-RIGHT on odd pages (pages 1 & 3)
        let wm_pdf = dir.path().join("watermarked.pdf");
        let blue_stamp = make_solid_png_data_url(160, 60, [20, 80, 230, 255]);
        let wm_res = watermark_pdf_impl(
            &WatermarkPdfRequest {
                task_id: Some("t-wm".to_string()),
                path: src.to_string_lossy().into_owned(),
                output_path: wm_pdf.to_string_lossy().into_owned(),
                overwrite: Some(false),
                scope: PdfWatermarkScope::Odd,
                current_page: None,
                page_range: None,
                style: WatermarkStyleConfig {
                    stamp_png_data_url: Some(blue_stamp),
                    logo_path: None,
                    placement: WatermarkPlacement::BottomRight,
                    scale_percent: 30.0,
                    margin_percent: 5.0,
                    opacity_percent: 90.0,
                    tile_angle_deg: None,
                    tile_spacing_percent: None,
                },
                single_angle_deg: Some(0.0),
            },
            &cancel,
            |_| {},
        )
        .expect("watermark pdf");
        assert_eq!(wm_res.watermarked_page_count, 2);

        // Page 3 (180° rotated, odd -> watermarked): visual BOTTOM-RIGHT must be BLUE!
        let (m3, r3) = render_page_rgba_with_pdfium(None, &wm_pdf, 3, Some(300), None, 0, 1200)
            .expect("render wm p3");
        let idx3 = ((m3.height_px as f32 * 0.90) as usize * m3.width_px as usize
            + (m3.width_px as f32 * 0.85) as usize)
            * 4;
        assert!(
            r3[idx3 + 2] > 180 && r3[idx3] < 90,
            "Page 3 (180°) visual bottom-right expected BLUE watermark, got {:?}",
            &r3[idx3..idx3 + 4]
        );
        // Page 2 (even -> NOT watermarked): visual BOTTOM-RIGHT must remain WHITE!
        let (m2, r2) = render_page_rgba_with_pdfium(None, &wm_pdf, 2, Some(300), None, 0, 1200)
            .expect("render wm p2");
        let idx2 = ((m2.height_px as f32 * 0.90) as usize * m2.width_px as usize
            + (m2.width_px as f32 * 0.85) as usize)
            * 4;
        assert!(
            r2[idx2] > 240 && r2[idx2 + 1] > 240 && r2[idx2 + 2] > 240,
            "Page 2 (even, out of scope) should not be watermarked, got {:?}",
            &r2[idx2..idx2 + 4]
        );
    }

    #[test]
    fn signature_template_store_save_list_delete_isolated() {
        let dir = tempfile::tempdir().expect("tempdir");
        let tdir = dir.path().join("sig-templates");
        let list0 = list_signature_templates_impl(&tdir).expect("list empty");
        assert!(list0.items.is_empty());

        let saved = save_signature_template_impl(
            &tdir,
            &SaveSignatureTemplateRequest {
                name: "Official Stamp".to_string(),
                png_data_url: make_solid_png_data_url(80, 40, [17, 24, 39, 255]),
            },
        )
        .expect("save");
        assert_eq!(saved.width_px, 80);
        assert_eq!(saved.height_px, 40);

        let list1 = list_signature_templates_impl(&tdir).expect("list 1");
        assert_eq!(list1.items.len(), 1);
        assert_eq!(list1.items[0].id, saved.id);

        delete_signature_template_impl(&tdir, &saved.id).expect("delete");
        let list2 = list_signature_templates_impl(&tdir).expect("list 2");
        assert!(list2.items.is_empty());
    }
}
