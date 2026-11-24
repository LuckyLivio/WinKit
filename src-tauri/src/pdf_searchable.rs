//! Phase 6 PR 3 (`P04` Make PDF Searchable):
//! - Per-page text-layer inspection via isolated PDFium worker (`inspect_searchable_pdf_pages_impl`).
//! - Exact device-pixel to PDF page user-space mapping using `FPDF_DeviceToPage` from the actual
//!   rendered bitmap dimensions (correctly handling `4096 px` / `48 MP` render caps, `/Rotate`
//!   0/90/180/270, and direct or `/Parent`-inherited offset `/CropBox`).
//! - Self-contained ISO 32000-1 Type 0 composite invisible Unicode font (`3 Tr`, minimal valid
//!   glyphless TrueType `/FontFile2`, `/CIDToGIDMap`, half/full-width `/W`, and chunked UTF-16BE
//!   `/ToUnicode` CMap) compatible with PDFium (`C08`), Chrome, Edge, Adobe Acrobat, and `pypdf`.
//! - Non-destructive `lopdf` page stream wrapping (`q ... Q` + invisible text stream) preserving
//!   visual page rendering, page order, existing text, bookmarks (`/Outlines`), and links.
//! - Atomic output staging (`AtomicPdfOutput`), same-path overwrite rejection, encryption/signature
//!   checks, and mid-flight cancellation with `.tmp` cleanup.

use crate::error::AppError;
use crate::fs_guard::validate_existing_input_file;
use crate::ocr_core::{
    oriented_reading_quad, OcrPageResult, OcrPoint, OcrRecognizeOptions, DEFAULT_DET_LIMIT_SIDE,
};
use crate::ocr_worker::{OcrSessionManager, OcrWorkerRequest, OcrWorkerResponse};
use crate::pdf_annotate::resolve_page_frame;
use crate::pdf_core::{
    inspect_structural_flags_from_doc, parse_page_range_spec, AtomicPdfOutput,
    PdfDocumentInspection, PdfSessionManager, PdfTaskProgressPayload,
};
use crate::pdf_pdfium::{
    PdfDeviceToPageTransform, PdfPageTextSummary, MAX_PDF_FILE_BYTES, MAX_PDF_PAGES,
};
use crate::pdf_worker::{PdfWorkerRequest, PdfWorkerResponse};
use flate2::write::ZlibEncoder;
use flate2::Compression;
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

pub const DEFAULT_SEARCHABLE_PDF_DPI: f32 = 200.0;
pub const SEARCHABLE_PDF_MAX_SIDE_CAP: u32 = 4096;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfSearchableInspectResult {
    pub inspection: PdfDocumentInspection,
    pub pages: Vec<PdfPageTextSummary>,
    pub scanned_page_count: usize,
    pub searchable_page_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MakePdfSearchableRequest {
    pub input_path: String,
    pub output_path: String,
    #[serde(default)]
    pub page_range: Option<String>,
    #[serde(default = "default_true")]
    pub skip_existing_text_pages: bool,
    #[serde(default = "default_ocr_dpi")]
    pub ocr_dpi: f32,
    #[serde(default = "default_max_side_len")]
    pub max_side_len: u32,
    #[serde(default)]
    pub overwrite: bool,
    /// Optional test/diagnostic override for max render side cap (clamped to 256..=4096).
    #[serde(default)]
    pub max_side_cap_override: Option<u32>,
}

fn default_true() -> bool {
    true
}

fn default_ocr_dpi() -> f32 {
    DEFAULT_SEARCHABLE_PDF_DPI
}

fn default_max_side_len() -> u32 {
    DEFAULT_DET_LIMIT_SIDE
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchablePdfPageOutcome {
    pub page_number: usize,
    /// `"ocr_applied"` | `"skipped_existing_text"` | `"ocr_empty"` | `"skipped_out_of_range"`
    pub status: String,
    pub existing_char_count: usize,
    pub added_line_count: usize,
    pub added_char_count: usize,
    pub rendered_width_px: Option<u32>,
    pub rendered_height_px: Option<u32>,
    pub render_capped: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MakePdfSearchableResult {
    pub output_path: String,
    pub output_bytes: u64,
    pub total_pages: usize,
    pub selected_pages: usize,
    pub ocr_applied_pages: usize,
    pub skipped_existing_text_pages: usize,
    pub ocr_empty_pages: usize,
    pub skipped_out_of_range_pages: usize,
    pub capped_pages: usize,
    pub total_lines_added: usize,
    pub total_chars_added: usize,
    pub elapsed_ms: u64,
    pub had_signatures: bool,
    pub warnings: Vec<String>,
    pub pages: Vec<SearchablePdfPageOutcome>,
}

pub fn inspect_searchable_pdf_pages_impl(
    pdf_mgr: &PdfSessionManager,
    path_raw: &str,
) -> Result<PdfSearchableInspectResult, AppError> {
    let inspection = pdf_mgr.inspect_document(path_raw)?;
    let pages = pdf_mgr.inspect_pages_text(path_raw)?;
    let searchable_page_count = pages.iter().filter(|p| p.has_text_layer).count();
    let scanned_page_count = pages.len().saturating_sub(searchable_page_count);
    Ok(PdfSearchableInspectResult {
        inspection,
        pages,
        scanned_page_count,
        searchable_page_count,
    })
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

fn load_unencrypted_lopdf_doc(
    path_raw: &str,
) -> Result<(PathBuf, Document, bool, usize), AppError> {
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
    Ok((canonical, doc, flags.has_signatures, flags.signature_count))
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

/// Builds a minimal, self-contained, spec-compliant glyphless TrueType (SFNT) font (~580 bytes)
/// with 2 empty glyphs (`GID 0` `.notdef`, `GID 1` invisible glyph, `unitsPerEm = 1000`,
/// `ascent = 880`, `descent = -120`, `advanceWidth = 1000`).
///
/// Using a real embedded glyphless TrueType program with `/CIDToGIDMap` + `/ToUnicode` + `3 Tr`
/// avoids missing-font warnings across PDFium (`C08`), Chrome, Edge, Adobe Acrobat, and `pypdf`
/// while adding only ~1.5 KiB overhead to the output PDF.
fn build_glyphless_ttf() -> Vec<u8> {
    fn sfnt_checksum(data: &[u8]) -> u32 {
        let mut sum = 0u32;
        for chunk in data.chunks(4) {
            let mut buf = [0u8; 4];
            buf[..chunk.len()].copy_from_slice(chunk);
            sum = sum.wrapping_add(u32::from_be_bytes(buf));
        }
        sum
    }

    // `head` (54 bytes; checkSumAdjustment at offset 8 patched after full assembly)
    let mut head = Vec::with_capacity(54);
    head.extend_from_slice(&0x0001_0000u32.to_be_bytes()); // version 1.0
    head.extend_from_slice(&0x0001_0000u32.to_be_bytes()); // fontRevision 1.0
    head.extend_from_slice(&0u32.to_be_bytes()); // checkSumAdjustment placeholder
    head.extend_from_slice(&0x5F0F_3CF5u32.to_be_bytes()); // magicNumber
    head.extend_from_slice(&0x000Bu16.to_be_bytes()); // flags
    head.extend_from_slice(&1000u16.to_be_bytes()); // unitsPerEm
    head.extend_from_slice(&0i64.to_be_bytes()); // created
    head.extend_from_slice(&0i64.to_be_bytes()); // modified
    head.extend_from_slice(&0i16.to_be_bytes()); // xMin
    head.extend_from_slice(&(-120i16).to_be_bytes()); // yMin
    head.extend_from_slice(&1000i16.to_be_bytes()); // xMax
    head.extend_from_slice(&880i16.to_be_bytes()); // yMax
    head.extend_from_slice(&0u16.to_be_bytes()); // macStyle
    head.extend_from_slice(&8u16.to_be_bytes()); // lowestRecPPEM
    head.extend_from_slice(&2i16.to_be_bytes()); // fontDirectionHint
    head.extend_from_slice(&0i16.to_be_bytes()); // indexToLocFormat (short 16-bit offsets)
    head.extend_from_slice(&0i16.to_be_bytes()); // glyphDataFormat

    // `hhea` (36 bytes)
    let mut hhea = Vec::with_capacity(36);
    hhea.extend_from_slice(&0x0001_0000u32.to_be_bytes()); // version 1.0
    hhea.extend_from_slice(&880i16.to_be_bytes()); // ascent
    hhea.extend_from_slice(&(-120i16).to_be_bytes()); // descent
    hhea.extend_from_slice(&0i16.to_be_bytes()); // lineGap
    hhea.extend_from_slice(&1000u16.to_be_bytes()); // advanceWidthMax
    hhea.extend_from_slice(&0i16.to_be_bytes()); // minLeftSideBearing
    hhea.extend_from_slice(&0i16.to_be_bytes()); // minRightSideBearing
    hhea.extend_from_slice(&1000i16.to_be_bytes()); // xMaxExtent
    hhea.extend_from_slice(&1i16.to_be_bytes()); // caretSlopeRise
    hhea.extend_from_slice(&0i16.to_be_bytes()); // caretSlopeRun
    hhea.extend_from_slice(&0i16.to_be_bytes()); // caretOffset
    hhea.extend_from_slice(&[0u8; 8]); // reserved
    hhea.extend_from_slice(&0i16.to_be_bytes()); // metricDataFormat
    hhea.extend_from_slice(&2u16.to_be_bytes()); // numberOfHMetrics

    // `maxp` (32 bytes, version 1.0 for TrueType outlines)
    let mut maxp = Vec::with_capacity(32);
    maxp.extend_from_slice(&0x0001_0000u32.to_be_bytes());
    maxp.extend_from_slice(&2u16.to_be_bytes()); // numGlyphs = 2
    maxp.extend_from_slice(&2u16.to_be_bytes()); // maxPoints = 2
    maxp.extend_from_slice(&1u16.to_be_bytes()); // maxContours = 1
    maxp.extend_from_slice(&[0u8; 22]);

    // `OS/2` (78 bytes, version 1)
    let mut os2 = Vec::with_capacity(78);
    os2.extend_from_slice(&1u16.to_be_bytes()); // version
    os2.extend_from_slice(&1000i16.to_be_bytes()); // xAvgCharWidth
    os2.extend_from_slice(&400u16.to_be_bytes()); // usWeightClass
    os2.extend_from_slice(&5u16.to_be_bytes()); // usWidthClass
    os2.extend_from_slice(&0u16.to_be_bytes()); // fsType (installable)
    os2.extend_from_slice(&650i16.to_be_bytes()); // ySubscriptXSize
    os2.extend_from_slice(&600i16.to_be_bytes()); // ySubscriptYSize
    os2.extend_from_slice(&0i16.to_be_bytes()); // ySubscriptXOffset
    os2.extend_from_slice(&75i16.to_be_bytes()); // ySubscriptYOffset
    os2.extend_from_slice(&650i16.to_be_bytes()); // ySuperscriptXSize
    os2.extend_from_slice(&600i16.to_be_bytes()); // ySuperscriptYSize
    os2.extend_from_slice(&0i16.to_be_bytes()); // ySuperscriptXOffset
    os2.extend_from_slice(&350i16.to_be_bytes()); // ySuperscriptYOffset
    os2.extend_from_slice(&50i16.to_be_bytes()); // yStrikeoutSize
    os2.extend_from_slice(&300i16.to_be_bytes()); // yStrikeoutPosition
    os2.extend_from_slice(&0i16.to_be_bytes()); // sFamilyClass
    os2.extend_from_slice(&[0u8; 10]); // panose
    os2.extend_from_slice(&[0u8; 16]); // ulUnicodeRange1..4
    os2.extend_from_slice(b"WKIT"); // achVendID
    os2.extend_from_slice(&0x0040u16.to_be_bytes()); // fsSelection (REGULAR)
    os2.extend_from_slice(&0x0020u16.to_be_bytes()); // usFirstCharIndex
    os2.extend_from_slice(&0x0020u16.to_be_bytes()); // usLastCharIndex
    os2.extend_from_slice(&880i16.to_be_bytes()); // sTypoAscender
    os2.extend_from_slice(&(-120i16).to_be_bytes()); // sTypoDescender
    os2.extend_from_slice(&0i16.to_be_bytes()); // sTypoLineGap
    os2.extend_from_slice(&880u16.to_be_bytes()); // usWinAscent
    os2.extend_from_slice(&120u16.to_be_bytes()); // usWinDescent
    os2.extend_from_slice(&1u32.to_be_bytes()); // ulCodePageRange1 (Latin 1)
    os2.extend_from_slice(&0u32.to_be_bytes()); // ulCodePageRange2

    // `hmtx` (8 bytes: 2 glyphs, advance=1000, lsb=0)
    let mut hmtx = Vec::with_capacity(8);
    hmtx.extend_from_slice(&1000u16.to_be_bytes());
    hmtx.extend_from_slice(&0i16.to_be_bytes());
    hmtx.extend_from_slice(&1000u16.to_be_bytes());
    hmtx.extend_from_slice(&0i16.to_be_bytes());

    // `glyf`: GID 0 (.notdef) is 0 bytes; GID 1 is a 24-byte zero-area 2-point contour spanning
    // [0, -120, 1000, 880] so PDFium/Chrome/Edge/Acrobat compute exact non-zero glyph selection
    // bounding boxes (`FPDFText_GetRect`) while `3 Tr` (and zero contour area) paints zero pixels.
    let mut glyf = Vec::with_capacity(24);
    glyf.extend_from_slice(&1i16.to_be_bytes()); // numberOfContours = 1
    glyf.extend_from_slice(&0i16.to_be_bytes()); // xMin = 0
    glyf.extend_from_slice(&(-120i16).to_be_bytes()); // yMin = -120
    glyf.extend_from_slice(&1000i16.to_be_bytes()); // xMax = 1000
    glyf.extend_from_slice(&880i16.to_be_bytes()); // yMax = 880
    glyf.extend_from_slice(&1u16.to_be_bytes()); // endPtsOfContours[0] = 1 (2 points: 0..=1)
    glyf.extend_from_slice(&0u16.to_be_bytes()); // instructionLength = 0
    glyf.extend_from_slice(&[0x01u8, 0x01u8]); // flags: both on-curve, 16-bit signed deltas
    glyf.extend_from_slice(&0i16.to_be_bytes()); // dx[0] = 0 -> x = 0
    glyf.extend_from_slice(&1000i16.to_be_bytes()); // dx[1] = +1000 -> x = 1000
    glyf.extend_from_slice(&(-120i16).to_be_bytes()); // dy[0] = -120 -> y = -120
    glyf.extend_from_slice(&1000i16.to_be_bytes()); // dy[1] = +1000 -> y = +880
    debug_assert_eq!(glyf.len(), 24);

    // `loca` (short 16-bit offsets in units of 2 bytes): GID 0 = [0..0], GID 1 = [0..24] (12 * 2)
    let mut loca = Vec::with_capacity(6);
    loca.extend_from_slice(&0u16.to_be_bytes());
    loca.extend_from_slice(&0u16.to_be_bytes());
    loca.extend_from_slice(&12u16.to_be_bytes());

    // `cmap` (Format 4 subtable: U+0020 -> GID 1, sentinel 0xFFFF -> 0)
    let mut cmap = Vec::with_capacity(44);
    cmap.extend_from_slice(&0u16.to_be_bytes()); // version
    cmap.extend_from_slice(&1u16.to_be_bytes()); // numTables
    cmap.extend_from_slice(&3u16.to_be_bytes()); // platformID (Windows)
    cmap.extend_from_slice(&1u16.to_be_bytes()); // encodingID (Unicode BMP)
    cmap.extend_from_slice(&12u32.to_be_bytes()); // offset
                                                  // Format 4 subtable (32 bytes)
    cmap.extend_from_slice(&4u16.to_be_bytes()); // format
    cmap.extend_from_slice(&32u16.to_be_bytes()); // length
    cmap.extend_from_slice(&0u16.to_be_bytes()); // language
    cmap.extend_from_slice(&4u16.to_be_bytes()); // segCountX2 (2 segments)
    cmap.extend_from_slice(&4u16.to_be_bytes()); // searchRange
    cmap.extend_from_slice(&1u16.to_be_bytes()); // entrySelector
    cmap.extend_from_slice(&0u16.to_be_bytes()); // rangeShift
    cmap.extend_from_slice(&0x0020u16.to_be_bytes()); // endCode[0]
    cmap.extend_from_slice(&0xFFFFu16.to_be_bytes()); // endCode[1]
    cmap.extend_from_slice(&0u16.to_be_bytes()); // reservedPad
    cmap.extend_from_slice(&0x0020u16.to_be_bytes()); // startCode[0]
    cmap.extend_from_slice(&0xFFFFu16.to_be_bytes()); // startCode[1]
    cmap.extend_from_slice(&((-0x001Fi16) as u16).to_be_bytes()); // idDelta[0]: 0x20 - 0x1F = 1
    cmap.extend_from_slice(&1u16.to_be_bytes()); // idDelta[1]: 0xFFFF + 1 = 0
    cmap.extend_from_slice(&0u16.to_be_bytes()); // idRangeOffset[0]
    cmap.extend_from_slice(&0u16.to_be_bytes()); // idRangeOffset[1]

    // `name` (minimal Platform 3 / Encoding 1 UTF-16BE records for IDs 1, 2, 4, 6)
    let font_name_utf16: Vec<u8> = "WinKitOCR-Glyphless"
        .encode_utf16()
        .flat_map(|u| u.to_be_bytes())
        .collect();
    let style_utf16: Vec<u8> = "Regular"
        .encode_utf16()
        .flat_map(|u| u.to_be_bytes())
        .collect();
    let mut name_strings = Vec::new();
    let off_name = 0u16;
    name_strings.extend_from_slice(&font_name_utf16);
    let off_style = name_strings.len() as u16;
    name_strings.extend_from_slice(&style_utf16);
    let records: [(u16, u16, u16); 4] = [
        (1, font_name_utf16.len() as u16, off_name),
        (2, style_utf16.len() as u16, off_style),
        (4, font_name_utf16.len() as u16, off_name),
        (6, font_name_utf16.len() as u16, off_name),
    ];
    let string_storage_offset = (6 + records.len() * 12) as u16;
    let mut name_tbl = Vec::with_capacity(string_storage_offset as usize + name_strings.len());
    name_tbl.extend_from_slice(&0u16.to_be_bytes()); // format
    name_tbl.extend_from_slice(&(records.len() as u16).to_be_bytes());
    name_tbl.extend_from_slice(&string_storage_offset.to_be_bytes());
    for (name_id, len, off) in records {
        name_tbl.extend_from_slice(&3u16.to_be_bytes()); // Windows
        name_tbl.extend_from_slice(&1u16.to_be_bytes()); // Unicode BMP
        name_tbl.extend_from_slice(&0x0409u16.to_be_bytes()); // en-US
        name_tbl.extend_from_slice(&name_id.to_be_bytes());
        name_tbl.extend_from_slice(&len.to_be_bytes());
        name_tbl.extend_from_slice(&off.to_be_bytes());
    }
    name_tbl.extend_from_slice(&name_strings);

    // `post` (32 bytes, format 3.0)
    let mut post = Vec::with_capacity(32);
    post.extend_from_slice(&0x0003_0000u32.to_be_bytes());
    post.extend_from_slice(&[0u8; 28]);

    // Tables MUST be sorted ascending by ASCII tag bytes per OpenType/SFNT spec.
    let mut tables: Vec<([u8; 4], Vec<u8>)> = vec![
        (*b"OS/2", os2),
        (*b"cmap", cmap),
        (*b"glyf", glyf),
        (*b"head", head),
        (*b"hhea", hhea),
        (*b"hmtx", hmtx),
        (*b"loca", loca),
        (*b"maxp", maxp),
        (*b"name", name_tbl),
        (*b"post", post),
    ];
    tables.sort_by_key(|(tag, _)| *tag);

    let num_tables = tables.len() as u16;
    let mut entry_selector = 0u16;
    while (1u16 << (entry_selector + 1)) <= num_tables {
        entry_selector += 1;
    }
    let search_range = (1u16 << entry_selector) * 16;
    let range_shift = num_tables * 16 - search_range;

    let mut out = Vec::new();
    out.extend_from_slice(&0x0001_0000u32.to_be_bytes()); // sfntVersion (TrueType)
    out.extend_from_slice(&num_tables.to_be_bytes());
    out.extend_from_slice(&search_range.to_be_bytes());
    out.extend_from_slice(&entry_selector.to_be_bytes());
    out.extend_from_slice(&range_shift.to_be_bytes());

    let dir_size = 12 + tables.len() * 16;
    let mut cur_offset = dir_size;
    let mut head_offset = 0usize;

    for (tag, data) in &tables {
        let checksum = sfnt_checksum(data);
        if tag == b"head" {
            head_offset = cur_offset;
        }
        out.extend_from_slice(tag);
        out.extend_from_slice(&checksum.to_be_bytes());
        out.extend_from_slice(&(cur_offset as u32).to_be_bytes());
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let padded_len = (data.len() + 3) & !3;
        cur_offset += padded_len;
    }

    for (_, data) in &tables {
        out.extend_from_slice(data);
        let pad = (4 - (data.len() % 4)) % 4;
        out.resize(out.len() + pad, 0);
    }

    // Patch `head.checkSumAdjustment`
    let whole_checksum = sfnt_checksum(&out);
    let adj = 0xB1B0_AFBAu32.wrapping_sub(whole_checksum);
    out[head_offset + 8..head_offset + 12].copy_from_slice(&adj.to_be_bytes());

    out
}

/// Relative glyph width in 1000-unit em space for realistic per-character selection boxes
/// inside mixed Chinese + English OCR tokens (total span width is further scaled via `Tz`).
fn cid_width_units(ch: char) -> u16 {
    if ch.is_ascii() {
        match ch {
            ' ' | 'i' | 'l' | 'I' | '.' | ',' | ':' | ';' | '!' | '|' | '\'' | '`' => 350,
            'W' | 'M' | 'm' | 'w' | '@' | '%' => 700,
            _ => 550,
        }
    } else {
        1000
    }
}

struct InvisibleUnicodeFont {
    type0_font_id: ObjectId,
    cid_by_char: HashMap<char, u16>,
}

fn build_tounicode_cmap(chars_by_cid: &[(u16, char)]) -> Vec<u8> {
    let mut out = String::with_capacity(chars_by_cid.len() * 24 + 512);
    out.push_str(
        "/CIDInit /ProcSet findresource begin\n\
         12 dict begin\n\
         begincmap\n\
         /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n\
         /CMapName /WinKitOCR-ToUnicode def\n\
         /CMapType 2 def\n\
         1 begincodespacerange\n\
         <0000> <FFFF>\n\
         endcodespacerange\n",
    );

    let mut utf16_buf = [0u16; 2];
    for chunk in chars_by_cid.chunks(100) {
        out.push_str(&format!("{} beginbfchar\n", chunk.len()));
        for &(cid, ch) in chunk {
            let encoded = ch.encode_utf16(&mut utf16_buf);
            if encoded.len() == 1 {
                out.push_str(&format!("<{cid:04X}> <{:04X}>\n", encoded[0]));
            } else {
                out.push_str(&format!(
                    "<{cid:04X}> <{:04X}{:04X}>\n",
                    encoded[0], encoded[1]
                ));
            }
        }
        out.push_str("endbfchar\n");
    }

    out.push_str(
        "endcmap\n\
         CMapName currentdict /CMap defineresource pop\n\
         end\n\
         end\n",
    );
    out.into_bytes()
}

fn build_invisible_unicode_font(
    doc: &mut Document,
    used_chars: &BTreeSet<char>,
) -> Result<InvisibleUnicodeFont, AppError> {
    let mut cid_by_char: HashMap<char, u16> = HashMap::with_capacity(used_chars.len() + 1);
    let mut chars_by_cid: Vec<(u16, char)> = Vec::with_capacity(used_chars.len() + 1);

    let mut next_cid: u16 = 1;
    // Ensure space character always has a valid CID for inter-word bridging.
    let mut ordered: BTreeSet<char> = used_chars.clone();
    ordered.insert(' ');

    for ch in ordered {
        if ch.is_control() {
            continue;
        }
        if next_cid == u16::MAX {
            break;
        }
        cid_by_char.insert(ch, next_cid);
        chars_by_cid.push((next_cid, ch));
        next_cid += 1;
    }

    let max_cid = chars_by_cid.last().map(|(c, _)| *c).unwrap_or(1);

    // 1. Embedded glyphless TrueType font stream (/FontFile2)
    let ttf_raw = build_glyphless_ttf();
    let ttf_compressed = zlib_compress(&ttf_raw)?;
    let mut ff2_dict = Dictionary::new();
    ff2_dict.set("Length1", Object::Integer(ttf_raw.len() as i64));
    ff2_dict.set("Filter", Object::Name(b"FlateDecode".to_vec()));
    let ff2_id = doc.add_object(Object::Stream(Stream::new(ff2_dict, ttf_compressed)));

    // 2. /FontDescriptor
    let mut fd_dict = Dictionary::new();
    fd_dict.set("Type", Object::Name(b"FontDescriptor".to_vec()));
    fd_dict.set("FontName", Object::Name(b"WinKitOCR-Glyphless".to_vec()));
    fd_dict.set("Flags", Object::Integer(4)); // Symbolic
    fd_dict.set(
        "FontBBox",
        Object::Array(vec![
            Object::Integer(0),
            Object::Integer(-120),
            Object::Integer(1000),
            Object::Integer(880),
        ]),
    );
    fd_dict.set("ItalicAngle", Object::Integer(0));
    fd_dict.set("Ascent", Object::Integer(880));
    fd_dict.set("Descent", Object::Integer(-120));
    fd_dict.set("CapHeight", Object::Integer(880));
    fd_dict.set("StemV", Object::Integer(80));
    fd_dict.set("FontFile2", Object::Reference(ff2_id));
    let fd_id = doc.add_object(Object::Dictionary(fd_dict));

    // 3. /CIDToGIDMap stream: CID 0 -> GID 0, CID 1..=max_cid -> GID 1
    let mut cid_to_gid = Vec::with_capacity((usize::from(max_cid) + 1) * 2);
    cid_to_gid.extend_from_slice(&0u16.to_be_bytes());
    for _ in 1..=max_cid {
        cid_to_gid.extend_from_slice(&1u16.to_be_bytes());
    }
    let cid_to_gid_compressed = zlib_compress(&cid_to_gid)?;
    let mut ctg_dict = Dictionary::new();
    ctg_dict.set("Filter", Object::Name(b"FlateDecode".to_vec()));
    let ctg_id = doc.add_object(Object::Stream(Stream::new(ctg_dict, cid_to_gid_compressed)));

    // 4. Per-CID /W array (omit 1000 entries since /DW = 1000)
    let mut w_array: Vec<Object> = Vec::new();
    for &(cid, ch) in &chars_by_cid {
        let w = cid_width_units(ch);
        if w != 1000 {
            w_array.push(Object::Integer(i64::from(cid)));
            w_array.push(Object::Array(vec![Object::Integer(i64::from(w))]));
        }
    }

    // 5. Descendant CIDFontType2 dictionary
    let mut sys_info = Dictionary::new();
    sys_info.set("Registry", Object::string_literal("Adobe"));
    sys_info.set("Ordering", Object::string_literal("Identity"));
    sys_info.set("Supplement", Object::Integer(0));

    let mut cid_font = Dictionary::new();
    cid_font.set("Type", Object::Name(b"Font".to_vec()));
    cid_font.set("Subtype", Object::Name(b"CIDFontType2".to_vec()));
    cid_font.set("BaseFont", Object::Name(b"WinKitOCR-Glyphless".to_vec()));
    cid_font.set("CIDSystemInfo", Object::Dictionary(sys_info));
    cid_font.set("FontDescriptor", Object::Reference(fd_id));
    cid_font.set("DW", Object::Integer(1000));
    if !w_array.is_empty() {
        cid_font.set("W", Object::Array(w_array));
    }
    cid_font.set("CIDToGIDMap", Object::Reference(ctg_id));
    let cid_font_id = doc.add_object(Object::Dictionary(cid_font));

    // 6. /ToUnicode CMap stream
    let cmap_raw = build_tounicode_cmap(&chars_by_cid);
    let cmap_compressed = zlib_compress(&cmap_raw)?;
    let mut cmap_dict = Dictionary::new();
    cmap_dict.set("Filter", Object::Name(b"FlateDecode".to_vec()));
    let cmap_id = doc.add_object(Object::Stream(Stream::new(cmap_dict, cmap_compressed)));

    // 7. Top-level Type0 Composite Font dictionary
    let mut type0 = Dictionary::new();
    type0.set("Type", Object::Name(b"Font".to_vec()));
    type0.set("Subtype", Object::Name(b"Type0".to_vec()));
    type0.set("BaseFont", Object::Name(b"WinKitOCR-Glyphless".to_vec()));
    type0.set("Encoding", Object::Name(b"Identity-H".to_vec()));
    type0.set(
        "DescendantFonts",
        Object::Array(vec![Object::Reference(cid_font_id)]),
    );
    type0.set("ToUnicode", Object::Reference(cmap_id));
    let type0_font_id = doc.add_object(Object::Dictionary(type0));

    Ok(InvisibleUnicodeFont {
        type0_font_id,
        cid_by_char,
    })
}

fn fmt_num(v: f64) -> String {
    if !v.is_finite() {
        return "0".to_string();
    }
    let rounded = (v * 10_000.0).round() / 10_000.0;
    if rounded.abs() < 1e-6 {
        "0".to_string()
    } else {
        let s = format!("{rounded:.4}");
        let trimmed = s.trim_end_matches('0').trim_end_matches('.');
        if trimmed == "-0" || trimmed.is_empty() {
            "0".to_string()
        } else {
            trimmed.to_string()
        }
    }
}

fn emit_line_tj_ops(
    ops: &mut String,
    font_res_name: &str,
    line: &crate::ocr_core::OcrTextLine,
    d2p: &PdfDeviceToPageTransform,
    cid_by_char: &HashMap<char, u16>,
) -> bool {
    let line_reading_quad = line.reading_quad_px.unwrap_or_else(|| {
        oriented_reading_quad(&line.quad_px, line.vertical_rotated, line.rotated_180)
    });

    // Map all 4 device-pixel corners ordered in true reading orientation
    // `[read_TL, read_TR, read_BR, read_BL]` into PDF page user space via `FPDF_DeviceToPage`.
    let p0 = d2p.map_device_point(
        f64::from(line_reading_quad[0].x),
        f64::from(line_reading_quad[0].y),
    );
    let p1 = d2p.map_device_point(
        f64::from(line_reading_quad[1].x),
        f64::from(line_reading_quad[1].y),
    );
    let p2 = d2p.map_device_point(
        f64::from(line_reading_quad[2].x),
        f64::from(line_reading_quad[2].y),
    );
    let p3 = d2p.map_device_point(
        f64::from(line_reading_quad[3].x),
        f64::from(line_reading_quad[3].y),
    );

    // Reading-direction baseline vector along `read_BL -> read_BR` (averaged with `read_TL -> read_TR`).
    let bx = 0.5 * ((p2.0 - p3.0) + (p1.0 - p0.0));
    let by = 0.5 * ((p2.1 - p3.1) + (p1.1 - p0.1));
    let line_len = bx.hypot(by);

    // Upward glyph ascent vector along `read_BL -> read_TL` (averaged with `read_BR -> read_TR`).
    let vx = 0.5 * ((p0.0 - p3.0) + (p1.0 - p2.0));
    let vy = 0.5 * ((p0.1 - p3.1) + (p1.1 - p2.1));
    let line_height = vx.hypot(vy);

    if line_len < 0.25 || line_height < 0.25 || !line_len.is_finite() || !line_height.is_finite() {
        return false;
    }

    let ux = bx / line_len;
    let uy = by / line_len;
    let hx = vx / line_height;
    let hy = vy / line_height;

    // Glyphless font metrics: ascent = 880, descent = -120 (total em = 1000).
    // Place text baseline 12% up from bottom edge `read_BL` so glyphs cover [read_BL..read_TL] x [read_BL..read_BR].
    let origin_x = p3.0 + 0.12 * vx;
    let origin_y = p3.1 + 0.12 * vy;
    let font_size = line_height.clamp(0.5, 2000.0);

    let encode_token = |s: &str| -> (String, u64) {
        let mut hex = String::with_capacity(s.chars().count() * 4);
        let mut units = 0u64;
        for ch in s.chars() {
            if ch.is_control() {
                continue;
            }
            if let Some(&cid) = cid_by_char.get(&ch) {
                hex.push_str(&format!("{cid:04X}"));
                units += u64::from(cid_width_units(ch));
            }
        }
        (hex, units)
    };

    // Emit the entire `OcrTextLine` as ONE single `Tm ... TJ` PDF text object so viewers
    // (PDFium, Chrome, Edge, Acrobat) NEVER split or reorder adjacent spans on rotated /
    // 180° upside-down lines while preserving exact per-span CTC positioning via `TJ` kerning.
    if line.spans.is_empty() {
        let (hex, width_units_sum) = encode_token(line.text.trim());
        if hex.is_empty() || width_units_sum == 0 {
            return false;
        }
        let natural_width = font_size * (width_units_sum as f64 / 1000.0);
        if natural_width <= 1e-6 {
            return false;
        }
        let tz = ((line_len / natural_width) * 100.0).clamp(5.0, 2000.0);
        ops.push_str(&format!(
            "/{font_res_name} {} Tf {} Tz {} {} {} {} {} {} Tm <{hex}> Tj\n",
            fmt_num(font_size),
            fmt_num(tz),
            fmt_num(ux),
            fmt_num(uy),
            fmt_num(hx),
            fmt_num(hy),
            fmt_num(origin_x),
            fmt_num(origin_y),
        ));
        return true;
    }

    struct EncodedSpan {
        hex: String,
        units: u64,
        start_along: f64,
        has_leading_space: bool,
    }

    let line_chars: Vec<char> = line.text.chars().collect();
    let space_cid = cid_by_char.get(&' ').copied();
    let space_units = u64::from(cid_width_units(' '));

    let mut encoded_spans: Vec<EncodedSpan> = Vec::with_capacity(line.spans.len());
    let mut prev_end: usize = 0;
    let mut total_units: u64 = 0;

    for span in &line.spans {
        let (hex, units) = encode_token(&span.text);
        if hex.is_empty() || units == 0 {
            continue;
        }
        let sq = span.reading_quad_px.unwrap_or_else(|| {
            let raw_q = span.quad_px.unwrap_or_else(|| quad_from_bbox(span.bbox_px));
            oriented_reading_quad(&raw_q, line.vertical_rotated, line.rotated_180)
        });
        let sp_bl = d2p.map_device_point(f64::from(sq[3].x), f64::from(sq[3].y));
        let start_along = ((sp_bl.0 - p3.0) * ux + (sp_bl.1 - p3.1) * uy).clamp(0.0, line_len);
        let has_leading_space = !encoded_spans.is_empty()
            && prev_end < span.char_start
            && span.char_start <= line_chars.len()
            && line_chars[prev_end..span.char_start]
                .iter()
                .any(|c| c.is_whitespace());
        if has_leading_space && space_cid.is_some() {
            total_units += space_units;
        }
        total_units += units;
        encoded_spans.push(EncodedSpan {
            hex,
            units,
            start_along,
            has_leading_space,
        });
        prev_end = span.char_end;
    }

    if encoded_spans.is_empty() || total_units == 0 {
        return false;
    }

    let natural_width = font_size * (total_units as f64 / 1000.0);
    if natural_width <= 1e-6 {
        return false;
    }
    let tz = ((line_len / natural_width) * 100.0).clamp(5.0, 2000.0);
    let pt_per_unit = (font_size * (tz / 100.0)) / 1000.0;

    let mut tj_items = String::with_capacity(line.text.len() * 5 + 32);
    let mut cur_along = 0.0f64;

    for (idx, sp) in encoded_spans.iter().enumerate() {
        if sp.has_leading_space {
            if let Some(scid) = space_cid {
                tj_items.push_str(&format!("<{scid:04X}> "));
                cur_along += (space_units as f64) * pt_per_unit;
            }
        }
        // Apply gentle non-overlapping kerning to track CTC span boundaries on wide-gap lines
        // without ever pulling backward over previous characters or faking spaces where none exist.
        if idx > 0 && pt_per_unit > 1e-6 {
            let delta_pt = sp.start_along - cur_along;
            let max_pull = if sp.has_leading_space {
                (space_units as f64) * pt_per_unit * 0.6
            } else {
                font_size * 0.15
            };
            let max_push = if sp.has_leading_space {
                line_len * 0.35
            } else {
                // Keep non-space CJK/ASCII boundary adjustments tight (< 120 em units) so PDFium
                // never synthesizes a false space between contiguous spans.
                100.0 * pt_per_unit
            };
            let clamped_pt = delta_pt.clamp(-max_pull, max_push);
            let adj_em = -(clamped_pt / pt_per_unit);
            if adj_em.abs() >= 10.0 && adj_em.is_finite() {
                tj_items.push_str(&format!("{} ", fmt_num(adj_em)));
                cur_along += clamped_pt;
            }
        }
        tj_items.push_str(&format!("<{}> ", sp.hex));
        cur_along += (sp.units as f64) * pt_per_unit;
    }

    ops.push_str(&format!(
        "/{font_res_name} {} Tf {} Tz {} {} {} {} {} {} Tm [{}] TJ\n",
        fmt_num(font_size),
        fmt_num(tz),
        fmt_num(ux),
        fmt_num(uy),
        fmt_num(hx),
        fmt_num(hy),
        fmt_num(origin_x),
        fmt_num(origin_y),
        tj_items.trim_end(),
    ));
    true
}

fn quad_from_bbox(b: crate::ocr_core::OcrBoundingBox) -> [OcrPoint; 4] {
    [
        OcrPoint { x: b.x, y: b.y },
        OcrPoint {
            x: b.x + b.width,
            y: b.y,
        },
        OcrPoint {
            x: b.x + b.width,
            y: b.y + b.height,
        },
        OcrPoint {
            x: b.x,
            y: b.y + b.height,
        },
    ]
}

/// Builds a self-contained invisible PDF text content stream (`q BT 3 Tr ... ET Q`) for one OCR'd page.
pub fn build_page_invisible_text_stream(
    page_ocr: &OcrPageResult,
    d2p: &PdfDeviceToPageTransform,
    font_res_name: &str,
    cid_by_char: &HashMap<char, u16>,
) -> Vec<u8> {
    let mut ops = String::with_capacity(page_ocr.lines.len() * 192 + 64);
    ops.push_str("q\nBT\n3 Tr\n");

    let mut emitted_any = false;

    for line in &page_ocr.lines {
        if line.text.trim().is_empty() {
            continue;
        }
        if emit_line_tj_ops(&mut ops, font_res_name, line, d2p, cid_by_char) {
            emitted_any = true;
        }
    }

    ops.push_str("ET\nQ\n");
    if emitted_any {
        ops.into_bytes()
    } else {
        Vec::new()
    }
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

/// Safely injects the shared invisible Type0 font resource (without mutating shared `/Resources`
/// or `/Font` dicts) and appends `text_stream_raw` after wrapping existing `/Contents` in `q ... Q`.
fn attach_invisible_text_layer_to_page(
    doc: &mut Document,
    page_id: ObjectId,
    font_id: ObjectId,
    build_ops: impl FnOnce(&str) -> Vec<u8>,
) -> Result<bool, AppError> {
    let mut res_dict = resolve_inherited_resources_clone(doc, page_id);
    let mut font_dict = res_dict
        .get(b"Font")
        .ok()
        .map(|o| resolve_dict_clone(doc, o))
        .unwrap_or_default();
    let font_res_name = next_unique_resource_name(&font_dict, "WKOcrF");

    let text_ops = build_ops(&font_res_name);
    if text_ops.is_empty() {
        return Ok(false);
    }

    font_dict.set(font_res_name.as_bytes(), Object::Reference(font_id));
    res_dict.set("Font", Object::Dictionary(font_dict));

    let compressed_text = zlib_compress(&text_ops)?;
    let mut text_stream_dict = Dictionary::new();
    text_stream_dict.set("Filter", Object::Name(b"FlateDecode".to_vec()));
    let text_stream_id = doc.add_object(Object::Stream(Stream::new(
        text_stream_dict,
        compressed_text,
    )));

    let existing_contents = doc
        .get_dictionary(page_id)
        .ok()
        .and_then(|d| d.get(b"Contents").ok())
        .cloned();

    let mut new_contents: Vec<Object> = Vec::new();
    match existing_contents {
        Some(Object::Reference(orig_id)) => {
            if let Ok(Object::Array(arr)) = doc.get_object(orig_id).cloned() {
                if !arr.is_empty() {
                    let q_id = doc.add_object(Object::Stream(Stream::new(
                        Dictionary::new(),
                        b"q\n".to_vec(),
                    )));
                    let q_end_id = doc.add_object(Object::Stream(Stream::new(
                        Dictionary::new(),
                        b"\nQ\n".to_vec(),
                    )));
                    new_contents.push(Object::Reference(q_id));
                    new_contents.extend(arr);
                    new_contents.push(Object::Reference(q_end_id));
                }
            } else {
                let q_id = doc.add_object(Object::Stream(Stream::new(
                    Dictionary::new(),
                    b"q\n".to_vec(),
                )));
                let q_end_id = doc.add_object(Object::Stream(Stream::new(
                    Dictionary::new(),
                    b"\nQ\n".to_vec(),
                )));
                new_contents.push(Object::Reference(q_id));
                new_contents.push(Object::Reference(orig_id));
                new_contents.push(Object::Reference(q_end_id));
            }
        }
        Some(Object::Array(arr)) if !arr.is_empty() => {
            let q_id = doc.add_object(Object::Stream(Stream::new(
                Dictionary::new(),
                b"q\n".to_vec(),
            )));
            let q_end_id = doc.add_object(Object::Stream(Stream::new(
                Dictionary::new(),
                b"\nQ\n".to_vec(),
            )));
            new_contents.push(Object::Reference(q_id));
            new_contents.extend(arr);
            new_contents.push(Object::Reference(q_end_id));
        }
        _ => {}
    }
    new_contents.push(Object::Reference(text_stream_id));

    let page_dict = doc
        .get_dictionary_mut(page_id)
        .map_err(|_| AppError::new("PDF_PAGE_ERROR", "Target PDF page dictionary missing."))?;
    page_dict.set("Resources", Object::Dictionary(res_dict));
    page_dict.set("Contents", Object::Array(new_contents));
    Ok(true)
}

/// Fallback affine device-to-page transform computed directly from `resolve_page_frame` + actual
/// rendered pixel dimensions (used only if `FPDF_DeviceToPage` is unavailable).
fn fallback_device_to_page_from_frame(
    doc: &Document,
    page_id: ObjectId,
    width_px: u32,
    height_px: u32,
) -> PdfDeviceToPageTransform {
    let frame = resolve_page_frame(doc, page_id);
    let w = frame.display_width_pt as f64;
    let h = frame.display_height_pt as f64;
    let map_disp = |sx: f64, sy: f64| -> (f64, f64) {
        let (px, py) = crate::pdf_annotate::display_to_pdf_point(
            frame.crop_box,
            frame.rotation_cw,
            sx as f32,
            sy as f32,
        );
        (f64::from(px), f64::from(py))
    };
    let origin = map_disp(0.0, h);
    let top_right = map_disp(w, h);
    let bottom_left = map_disp(0.0, 0.0);
    PdfDeviceToPageTransform::from_corners(width_px, height_px, origin, top_right, bottom_left)
}

#[allow(clippy::too_many_arguments)]
pub fn make_pdf_searchable_impl<F>(
    task_id: &str,
    pdf_mgr: &PdfSessionManager,
    ocr_mgr: &OcrSessionManager,
    req: &MakePdfSearchableRequest,
    cancel_flag: &Arc<AtomicBool>,
    emit_progress: F,
) -> Result<MakePdfSearchableResult, AppError>
where
    F: FnMut(PdfTaskProgressPayload),
{
    make_pdf_searchable_with_save_hook(
        task_id,
        pdf_mgr,
        ocr_mgr,
        req,
        cancel_flag,
        emit_progress,
        || {},
    )
}

#[allow(clippy::too_many_arguments)]
fn make_pdf_searchable_with_save_hook<F, H>(
    task_id: &str,
    pdf_mgr: &PdfSessionManager,
    ocr_mgr: &OcrSessionManager,
    req: &MakePdfSearchableRequest,
    cancel_flag: &Arc<AtomicBool>,
    mut emit_progress: F,
    after_save_before_commit: H,
) -> Result<MakePdfSearchableResult, AppError>
where
    F: FnMut(PdfTaskProgressPayload),
    H: FnOnce(),
{
    let t0 = Instant::now();
    let (canonical, mut doc, had_signatures, signature_count) =
        load_unencrypted_lopdf_doc(&req.input_path)?;

    // Stage atomic output upfront so same-input/output and existing-file errors fail immediately.
    let atomic_out = AtomicPdfOutput::prepare(
        &req.output_path,
        std::slice::from_ref(&canonical),
        req.overwrite,
    )?;

    let page_map = doc.get_pages();
    let total_pages = page_map.len();

    let selected_set: BTreeSet<usize> = match req
        .page_range
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(spec) => {
            let parsed = parse_page_range_spec(spec, total_pages)?;
            parsed.pages.into_iter().collect()
        }
        None => (1..=total_pages).collect(),
    };

    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    emit_progress(PdfTaskProgressPayload {
        task_id: task_id.to_string(),
        tool_id: "P04".to_string(),
        current: 0,
        total: selected_set.len(),
        percent: 2.0,
        detail: "Inspecting existing PDF text layers...".to_string(),
    });

    let canonical_str = canonical.to_string_lossy().into_owned();
    let text_summaries = pdf_mgr.inspect_pages_text(&canonical_str)?;
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }
    let summary_by_page: HashMap<usize, &PdfPageTextSummary> =
        text_summaries.iter().map(|s| (s.page_number, s)).collect();

    let ocr_dpi = req.ocr_dpi.clamp(100.0, 300.0);
    let max_side_cap = req
        .max_side_cap_override
        .map(|v| v.clamp(256, SEARCHABLE_PDF_MAX_SIDE_CAP))
        .unwrap_or(SEARCHABLE_PDF_MAX_SIDE_CAP);
    let ocr_options = OcrRecognizeOptions {
        max_side_len: req.max_side_len,
        include_preview: false,
    };

    struct PendingPageOcr {
        page_number: usize,
        page_id: ObjectId,
        ocr: OcrPageResult,
        d2p: PdfDeviceToPageTransform,
        rendered_width_px: u32,
        rendered_height_px: u32,
        render_capped: bool,
        existing_char_count: usize,
    }

    let mut pending_layers: Vec<PendingPageOcr> = Vec::new();
    let mut outcomes_by_page: HashMap<usize, SearchablePdfPageOutcome> = HashMap::new();
    let mut used_chars: BTreeSet<char> = BTreeSet::new();
    let mut skipped_existing_text_pages = 0usize;
    let mut ocr_empty_pages = 0usize;
    let mut skipped_out_of_range_pages = 0usize;
    let mut capped_pages = 0usize;
    let mut warnings: Vec<String> = Vec::new();

    if had_signatures {
        warnings.push(format!(
            "Source PDF contained {} digital signature(s); adding an invisible text layer to the new copy invalidates original cryptographic signatures.",
            signature_count.max(1)
        ));
    }

    let total_selected = selected_set.len().max(1);
    let mut processed_selected = 0usize;

    for page_number in 1..=total_pages {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(AppError::cancelled());
        }

        let existing_chars = summary_by_page
            .get(&page_number)
            .map(|s| s.meaningful_char_count)
            .unwrap_or(0);
        let has_existing_text = existing_chars > 0;

        if !selected_set.contains(&page_number) {
            skipped_out_of_range_pages += 1;
            outcomes_by_page.insert(
                page_number,
                SearchablePdfPageOutcome {
                    page_number,
                    status: "skipped_out_of_range".to_string(),
                    existing_char_count: existing_chars,
                    added_line_count: 0,
                    added_char_count: 0,
                    rendered_width_px: None,
                    rendered_height_px: None,
                    render_capped: false,
                },
            );
            continue;
        }

        processed_selected += 1;

        if req.skip_existing_text_pages && has_existing_text {
            skipped_existing_text_pages += 1;
            outcomes_by_page.insert(
                page_number,
                SearchablePdfPageOutcome {
                    page_number,
                    status: "skipped_existing_text".to_string(),
                    existing_char_count: existing_chars,
                    added_line_count: 0,
                    added_char_count: 0,
                    rendered_width_px: None,
                    rendered_height_px: None,
                    render_capped: false,
                },
            );
            emit_progress(PdfTaskProgressPayload {
                task_id: task_id.to_string(),
                tool_id: "P04".to_string(),
                current: processed_selected,
                total: total_selected,
                percent: 5.0 + (processed_selected as f64 / total_selected as f64) * 85.0,
                detail: format!("Page {page_number}/{total_pages} already searchable (skipped)"),
            });
            continue;
        }

        let page_id = *page_map.get(&(page_number as u32)).ok_or_else(|| {
            AppError::new(
                "PDF_PAGE_ERROR",
                format!("PDF page {page_number} could not be resolved."),
            )
        })?;

        emit_progress(PdfTaskProgressPayload {
            task_id: task_id.to_string(),
            tool_id: "P04".to_string(),
            current: processed_selected,
            total: total_selected,
            percent: 5.0 + ((processed_selected - 1) as f64 / total_selected as f64) * 85.0,
            detail: format!("Rendering & recognizing page {page_number}/{total_pages}..."),
        });

        let (resp, rgba) = pdf_mgr.worker().send(PdfWorkerRequest::RenderRgba {
            path: canonical_str.clone(),
            page_number,
            target_width_px: None,
            target_dpi: Some(ocr_dpi),
            extra_rotation_cw: 0,
            max_side_cap,
        })?;
        let render_meta = match resp {
            PdfWorkerResponse::Render(m) => m,
            _ => {
                return Err(AppError::new(
                    "PDF_WORKER_ERROR",
                    "Unexpected PDF worker response while rendering page for OCR.",
                ));
            }
        };

        if render_meta.capped {
            capped_pages += 1;
        }

        if cancel_flag.load(Ordering::Relaxed) {
            return Err(AppError::cancelled());
        }

        let ocr_resp = ocr_mgr.worker().send(
            OcrWorkerRequest::RecognizeRgbaBuffer {
                width: render_meta.width_px,
                height: render_meta.height_px,
                page_number,
                render_dpi: Some(ocr_dpi),
                source_width_pt: Some(render_meta.page_width_pt),
                source_height_pt: Some(render_meta.page_height_pt),
                options: ocr_options.clone(),
            },
            &rgba,
            Some(cancel_flag),
        )?;

        let page_ocr = match ocr_resp {
            OcrWorkerResponse::Page(p) => p,
            _ => {
                return Err(AppError::new(
                    "OCR_WORKER_ERROR",
                    "Unexpected OCR worker response while processing PDF page.",
                ));
            }
        };

        if page_ocr.lines.is_empty() || page_ocr.text.trim().is_empty() {
            ocr_empty_pages += 1;
            outcomes_by_page.insert(
                page_number,
                SearchablePdfPageOutcome {
                    page_number,
                    status: "ocr_empty".to_string(),
                    existing_char_count: existing_chars,
                    added_line_count: 0,
                    added_char_count: 0,
                    rendered_width_px: Some(render_meta.width_px),
                    rendered_height_px: Some(render_meta.height_px),
                    render_capped: render_meta.capped,
                },
            );
            continue;
        }

        for line in &page_ocr.lines {
            for ch in line.text.chars() {
                if !ch.is_control() {
                    used_chars.insert(ch);
                }
            }
            for sp in &line.spans {
                for ch in sp.text.chars() {
                    if !ch.is_control() {
                        used_chars.insert(ch);
                    }
                }
            }
        }

        let d2p = render_meta.device_to_page.unwrap_or_else(|| {
            fallback_device_to_page_from_frame(
                &doc,
                page_id,
                render_meta.width_px,
                render_meta.height_px,
            )
        });

        pending_layers.push(PendingPageOcr {
            page_number,
            page_id,
            ocr: page_ocr,
            d2p,
            rendered_width_px: render_meta.width_px,
            rendered_height_px: render_meta.height_px,
            render_capped: render_meta.capped,
            existing_char_count: existing_chars,
        });
    }

    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    emit_progress(PdfTaskProgressPayload {
        task_id: task_id.to_string(),
        tool_id: "P04".to_string(),
        current: total_selected,
        total: total_selected,
        percent: 93.0,
        detail: "Embedding invisible Unicode text layer and saving PDF...".to_string(),
    });

    let mut ocr_applied_pages = 0usize;
    let mut total_lines_added = 0usize;
    let mut total_chars_added = 0usize;

    if !pending_layers.is_empty() && !used_chars.is_empty() {
        let font = build_invisible_unicode_font(&mut doc, &used_chars)?;
        for item in pending_layers {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err(AppError::cancelled());
            }
            let added = attach_invisible_text_layer_to_page(
                &mut doc,
                item.page_id,
                font.type0_font_id,
                |font_name| {
                    build_page_invisible_text_stream(
                        &item.ocr,
                        &item.d2p,
                        font_name,
                        &font.cid_by_char,
                    )
                },
            )?;
            if added {
                ocr_applied_pages += 1;
                total_lines_added += item.ocr.line_count;
                total_chars_added += item.ocr.char_count;
                outcomes_by_page.insert(
                    item.page_number,
                    SearchablePdfPageOutcome {
                        page_number: item.page_number,
                        status: "ocr_applied".to_string(),
                        existing_char_count: item.existing_char_count,
                        added_line_count: item.ocr.line_count,
                        added_char_count: item.ocr.char_count,
                        rendered_width_px: Some(item.rendered_width_px),
                        rendered_height_px: Some(item.rendered_height_px),
                        render_capped: item.render_capped,
                    },
                );
            } else {
                ocr_empty_pages += 1;
                outcomes_by_page.insert(
                    item.page_number,
                    SearchablePdfPageOutcome {
                        page_number: item.page_number,
                        status: "ocr_empty".to_string(),
                        existing_char_count: item.existing_char_count,
                        added_line_count: 0,
                        added_char_count: 0,
                        rendered_width_px: Some(item.rendered_width_px),
                        rendered_height_px: Some(item.rendered_height_px),
                        render_capped: item.render_capped,
                    },
                );
            }
        }
    }

    if had_signatures {
        strip_invalidated_signature_markers(&mut doc);
    }

    if capped_pages > 0 {
        warnings.push(format!(
            "{capped_pages} large page(s) reached the {max_side_cap} px render cap; text coordinates were mapped using actual rendered bitmap dimensions via PDFium device-to-page transform."
        ));
    }

    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    doc.save(atomic_out.temp_path()).map_err(|e| {
        AppError::new(
            "WRITE_FAILED",
            format!("Failed to write searchable PDF output: {e}"),
        )
    })?;
    after_save_before_commit();
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }
    let (final_path, output_bytes) = atomic_out.commit_existing_tmp()?;

    let mut pages_out = Vec::with_capacity(total_pages);
    for p in 1..=total_pages {
        if let Some(outcome) = outcomes_by_page.remove(&p) {
            pages_out.push(outcome);
        }
    }

    emit_progress(PdfTaskProgressPayload {
        task_id: task_id.to_string(),
        tool_id: "P04".to_string(),
        current: total_selected,
        total: total_selected,
        percent: 100.0,
        detail: "Completed".to_string(),
    });

    Ok(MakePdfSearchableResult {
        output_path: final_path.to_string_lossy().into_owned(),
        output_bytes,
        total_pages,
        selected_pages: selected_set.len(),
        ocr_applied_pages,
        skipped_existing_text_pages,
        ocr_empty_pages,
        skipped_out_of_range_pages,
        capped_pages,
        total_lines_added,
        total_chars_added,
        elapsed_ms: t0.elapsed().as_millis() as u64,
        had_signatures,
        warnings,
        pages: pages_out,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf_ops::{
        images_to_pdf_impl, ImagesToPdfRequest, PdfPageOrientation, PdfPageSizePreset,
    };
    use crate::pdf_pdfium::{
        extract_page_char_rects_with_pdfium, extract_page_text_with_pdfium,
        render_page_rgba_with_pdfium, search_document_with_pdfium, PdfNormalizedRect,
    };
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::path::Path;
    use tempfile::tempdir;

    fn sha256_file(p: &Path) -> String {
        let bytes = fs::read(p).expect("read file for sha256");
        let mut h = Sha256::new();
        h.update(&bytes);
        format!("{:x}", h.finalize())
    }

    /// Creates a real multi-page test PDF containing:
    /// - Page 1: Bilingual scanned image (Rotate = 0, standard CropBox)
    /// - Page 2: Native vector text page (already searchable -> must be skipped by default)
    /// - Page 3: Bilingual scanned image with Rotate = 90
    /// - Page 4: Bilingual scanned image with Rotate = 180
    /// - Page 5: Bilingual scanned image with Rotate = 270
    /// - Page 6: Bilingual scanned image with direct offset CropBox [80, 100, 560, 440]
    /// - Page 7: Bilingual scanned image inside a child `/Pages` node with **inherited** offset CropBox [70, 90, 550, 430]
    /// - Page 8: Giant scanned page (2400 x 1200 pt -> at 200 DPI desires 6667 x 3333 px, hitting 4096 px cap!)
    ///
    /// Plus `/Outlines` bookmarks and an external URI link on page 1 so we verify preservation!
    fn build_comprehensive_p04_fixture_pdf(fixture_png: &Path, out_pdf: &Path) {
        let img = image::open(fixture_png)
            .expect("open bilingual fixture")
            .to_rgba8();
        let (iw, ih) = img.dimensions();
        let mut rgb = Vec::with_capacity((iw * ih * 3) as usize);
        for p in img.pixels() {
            rgb.push(p[0]);
            rgb.push(p[1]);
            rgb.push(p[2]);
        }
        let compressed_rgb = zlib_compress(&rgb).expect("compress rgb");

        let mut doc = Document::with_version("1.5");
        let root_pages_id = doc.new_object_id();

        let mut img_dict = Dictionary::new();
        img_dict.set("Type", Object::Name(b"XObject".to_vec()));
        img_dict.set("Subtype", Object::Name(b"Image".to_vec()));
        img_dict.set("Width", Object::Integer(i64::from(iw)));
        img_dict.set("Height", Object::Integer(i64::from(ih)));
        img_dict.set("ColorSpace", Object::Name(b"DeviceRGB".to_vec()));
        img_dict.set("BitsPerComponent", Object::Integer(8));
        img_dict.set("Filter", Object::Name(b"FlateDecode".to_vec()));
        let img_id = doc.add_object(Object::Stream(Stream::new(img_dict, compressed_rgb)));

        let mut img_res = Dictionary::new();
        let mut xobjs = Dictionary::new();
        xobjs.set("Im0", Object::Reference(img_id));
        img_res.set("XObject", Object::Dictionary(xobjs));
        let img_res_id = doc.add_object(Object::Dictionary(img_res));

        let make_img_page = |doc: &mut Document,
                             parent: ObjectId,
                             media: [f32; 4],
                             crop: Option<[f32; 4]>,
                             rotate: Option<i64>,
                             draw_rect: [f32; 4],
                             draw_rot_cw: u16,
                             extra_annot: Option<ObjectId>|
         -> ObjectId {
            // Draw image inside `draw_rect = [x0, y0, x1, y1]` oriented so that AFTER `/Rotate` is applied
            // by the viewer, the bilingual text reads upright left-to-right!
            let [x0, y0, x1, y1] = draw_rect;
            let w = x1 - x0;
            let h = y1 - y0;
            let ctm = match draw_rot_cw {
                // If page has /Rotate 90 (CW), unrotated +Y becomes visual right (+X), unrotated -X becomes visual up (+Y)
                90 => format!("0 {h} -{w} 0 {x1} {y0} cm"),
                // If page has /Rotate 180, unrotated -X is visual right, -Y is visual up
                180 => format!("-{w} 0 0 -{h} {x1} {y1} cm"),
                // If page has /Rotate 270 (CW), unrotated -Y is visual right, +X is visual up
                270 => format!("0 -{h} {w} 0 {x0} {y1} cm"),
                _ => format!("{w} 0 0 {h} {x0} {y0} cm"),
            };
            let ops = format!("q\n{ctm}\n/Im0 Do\nQ\n");
            let content_id = doc.add_object(Object::Stream(Stream::new(
                Dictionary::new(),
                ops.into_bytes(),
            )));
            let mut p = Dictionary::new();
            p.set("Type", Object::Name(b"Page".to_vec()));
            p.set("Parent", Object::Reference(parent));
            p.set(
                "MediaBox",
                Object::Array(media.into_iter().map(Object::Real).collect()),
            );
            if let Some(cb) = crop {
                p.set(
                    "CropBox",
                    Object::Array(cb.into_iter().map(Object::Real).collect()),
                );
            }
            if let Some(r) = rotate {
                p.set("Rotate", Object::Integer(r));
            }
            p.set("Resources", Object::Reference(img_res_id));
            p.set("Contents", Object::Reference(content_id));
            if let Some(ann) = extra_annot {
                p.set("Annots", Object::Array(vec![Object::Reference(ann)]));
            }
            doc.add_object(Object::Dictionary(p))
        };

        // External URI link annotation on page 1 to verify link preservation
        let mut action = Dictionary::new();
        action.set("Type", Object::Name(b"Action".to_vec()));
        action.set("S", Object::Name(b"URI".to_vec()));
        action.set(
            "URI",
            Object::string_literal("https://example.org/winkit-p04"),
        );
        let mut annot = Dictionary::new();
        annot.set("Type", Object::Name(b"Annot".to_vec()));
        annot.set("Subtype", Object::Name(b"Link".to_vec()));
        annot.set(
            "Rect",
            Object::Array(vec![
                Object::Real(20.0),
                Object::Real(20.0),
                Object::Real(160.0),
                Object::Real(48.0),
            ]),
        );
        annot.set("A", Object::Dictionary(action));
        let annot_id = doc.add_object(Object::Dictionary(annot));

        // Page 1: Normal 0 deg scanned page with link annotation
        let p1 = make_img_page(
            &mut doc,
            root_pages_id,
            [0.0, 0.0, 600.0, 300.0],
            None,
            None,
            [30.0, 40.0, 570.0, 260.0],
            0,
            Some(annot_id),
        );

        // Page 2: Native vector text page (already searchable -> must be skipped by default!)
        let mut helv = Dictionary::new();
        helv.set("Type", Object::Name(b"Font".to_vec()));
        helv.set("Subtype", Object::Name(b"Type1".to_vec()));
        helv.set("BaseFont", Object::Name(b"Helvetica".to_vec()));
        let helv_id = doc.add_object(Object::Dictionary(helv));
        let mut fdict = Dictionary::new();
        fdict.set("F1", Object::Reference(helv_id));
        let mut p2_res = Dictionary::new();
        p2_res.set("Font", Object::Dictionary(fdict));
        let p2_content = doc.add_object(Object::Stream(Stream::new(
            Dictionary::new(),
            b"BT /F1 18 Tf 72 720 Td (Existing Native Searchable Page 2) Tj ET".to_vec(),
        )));
        let mut p2_dict = Dictionary::new();
        p2_dict.set("Type", Object::Name(b"Page".to_vec()));
        p2_dict.set("Parent", Object::Reference(root_pages_id));
        p2_dict.set(
            "MediaBox",
            Object::Array(vec![
                Object::Real(0.0),
                Object::Real(0.0),
                Object::Real(595.0),
                Object::Real(842.0),
            ]),
        );
        p2_dict.set("Resources", Object::Dictionary(p2_res));
        p2_dict.set("Contents", Object::Reference(p2_content));
        let p2 = doc.add_object(Object::Dictionary(p2_dict));

        // Page 3: Rotate = 90
        let p3 = make_img_page(
            &mut doc,
            root_pages_id,
            [0.0, 0.0, 300.0, 600.0],
            None,
            Some(90),
            [40.0, 30.0, 260.0, 570.0],
            90,
            None,
        );

        // Page 4: Rotate = 180
        let p4 = make_img_page(
            &mut doc,
            root_pages_id,
            [0.0, 0.0, 600.0, 300.0],
            None,
            Some(180),
            [30.0, 40.0, 570.0, 260.0],
            180,
            None,
        );

        // Page 5: Rotate = 270
        let p5 = make_img_page(
            &mut doc,
            root_pages_id,
            [0.0, 0.0, 300.0, 600.0],
            None,
            Some(270),
            [40.0, 30.0, 260.0, 570.0],
            270,
            None,
        );

        // Page 6: Direct offset CropBox [80, 100, 680, 400] inside MediaBox [0, 0, 800, 600]
        let p6 = make_img_page(
            &mut doc,
            root_pages_id,
            [0.0, 0.0, 800.0, 600.0],
            Some([80.0, 100.0, 680.0, 400.0]),
            None,
            [110.0, 140.0, 650.0, 360.0],
            0,
            None,
        );

        // Page 7: Inherited offset CropBox [70, 90, 670, 390] from child `/Pages` node
        let child_pages_id = doc.new_object_id();
        let p7 = make_img_page(
            &mut doc,
            child_pages_id,
            [0.0, 0.0, 800.0, 600.0],
            None, // intentionally omitted on Page -> inherited from child_pages_id!
            None,
            [100.0, 130.0, 640.0, 350.0],
            0,
            None,
        );
        let mut child_pages = Dictionary::new();
        child_pages.set("Type", Object::Name(b"Pages".to_vec()));
        child_pages.set("Parent", Object::Reference(root_pages_id));
        child_pages.set("Kids", Object::Array(vec![Object::Reference(p7)]));
        child_pages.set("Count", Object::Integer(1));
        child_pages.set(
            "CropBox",
            Object::Array(vec![
                Object::Real(70.0),
                Object::Real(90.0),
                Object::Real(670.0),
                Object::Real(390.0),
            ]),
        );
        doc.objects
            .insert(child_pages_id, Object::Dictionary(child_pages));

        // Page 8: Oversized 2400 x 1200 pt page (at 200 DPI desires 6667 x 3333 px -> hits 4096 px cap!)
        let p8 = make_img_page(
            &mut doc,
            root_pages_id,
            [0.0, 0.0, 2400.0, 1200.0],
            None,
            None,
            [120.0, 160.0, 2280.0, 1040.0],
            0,
            None,
        );

        let mut root_pages = Dictionary::new();
        root_pages.set("Type", Object::Name(b"Pages".to_vec()));
        root_pages.set(
            "Kids",
            Object::Array(vec![
                Object::Reference(p1),
                Object::Reference(p2),
                Object::Reference(p3),
                Object::Reference(p4),
                Object::Reference(p5),
                Object::Reference(p6),
                Object::Reference(child_pages_id),
                Object::Reference(p8),
            ]),
        );
        root_pages.set("Count", Object::Integer(8));
        doc.objects
            .insert(root_pages_id, Object::Dictionary(root_pages));

        // Add `/Outlines` bookmark to verify outline preservation
        let outlines_id = doc.new_object_id();
        let item1_id = doc.new_object_id();
        let mut item1 = Dictionary::new();
        item1.set("Title", Object::string_literal("Scanned Cover"));
        item1.set("Parent", Object::Reference(outlines_id));
        item1.set(
            "Dest",
            Object::Array(vec![Object::Reference(p1), Object::Name(b"Fit".to_vec())]),
        );
        doc.objects.insert(item1_id, Object::Dictionary(item1));

        let mut outlines = Dictionary::new();
        outlines.set("Type", Object::Name(b"Outlines".to_vec()));
        outlines.set("First", Object::Reference(item1_id));
        outlines.set("Last", Object::Reference(item1_id));
        outlines.set("Count", Object::Integer(1));
        doc.objects
            .insert(outlines_id, Object::Dictionary(outlines));

        let mut catalog = Dictionary::new();
        catalog.set("Type", Object::Name(b"Catalog".to_vec()));
        catalog.set("Pages", Object::Reference(root_pages_id));
        catalog.set("Outlines", Object::Reference(outlines_id));
        let catalog_id = doc.add_object(Object::Dictionary(catalog));
        doc.trailer.set("Root", Object::Reference(catalog_id));

        doc.save(out_pdf)
            .expect("save comprehensive p04 fixture pdf");
    }

    #[test]
    fn p04_end_to_end_rotations_cropboxes_4096_cap_mixed_pages_idempotency_and_guards() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("ocr_bilingual_sample.png");
        assert!(fixture.is_file(), "Missing fixture {}", fixture.display());

        let dir = tempdir().expect("tempdir");
        let input_pdf = dir.path().join("p04_mixed_suite.pdf");
        build_comprehensive_p04_fixture_pdf(&fixture, &input_pdf);
        let input_sha_before = sha256_file(&input_pdf);

        let pdf_mgr = PdfSessionManager::default();
        let ocr_mgr = OcrSessionManager::default();

        // 1. Per-page text inspection must distinguish scanned (7 pages) vs native text (page 2)
        let inspected = inspect_searchable_pdf_pages_impl(&pdf_mgr, &input_pdf.to_string_lossy())
            .expect("inspect p04 pages");
        assert_eq!(inspected.pages.len(), 8);
        assert_eq!(inspected.searchable_page_count, 1);
        assert_eq!(inspected.scanned_page_count, 7);
        assert!(
            inspected.pages[1].has_text_layer,
            "Page 2 must be detected as searchable"
        );
        for idx in [0, 2, 3, 4, 5, 6, 7] {
            assert!(
                !inspected.pages[idx].has_text_layer,
                "Page {} must be detected as scanned",
                idx + 1
            );
        }

        // 2. Same input & output path MUST be rejected before running OCR
        let same_err = make_pdf_searchable_impl(
            "p04-same-path",
            &pdf_mgr,
            &ocr_mgr,
            &MakePdfSearchableRequest {
                input_path: input_pdf.to_string_lossy().into_owned(),
                output_path: input_pdf.to_string_lossy().into_owned(),
                page_range: None,
                skip_existing_text_pages: true,
                ocr_dpi: 200.0,
                max_side_len: 1280,
                overwrite: true,
                max_side_cap_override: None,
            },
            &Arc::new(AtomicBool::new(false)),
            |_| {},
        )
        .unwrap_err();
        assert_eq!(same_err.code, "SAME_INPUT_AND_OUTPUT");

        // 3. Cancellation mid-run must clean up sibling `.tmp` files and never touch source
        let cancel_out = dir.path().join("p04_cancelled.pdf");
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let cancel_trigger = Arc::clone(&cancel_flag);
        let cancel_res = make_pdf_searchable_impl(
            "p04-cancel",
            &pdf_mgr,
            &ocr_mgr,
            &MakePdfSearchableRequest {
                input_path: input_pdf.to_string_lossy().into_owned(),
                output_path: cancel_out.to_string_lossy().into_owned(),
                page_range: None,
                skip_existing_text_pages: true,
                ocr_dpi: 200.0,
                max_side_len: 1280,
                overwrite: true,
                max_side_cap_override: None,
            },
            &cancel_flag,
            move |ev| {
                if ev.current >= 1 {
                    cancel_trigger.store(true, Ordering::SeqCst);
                }
            },
        );
        assert_eq!(cancel_res.unwrap_err().code, "TASK_CANCELLED");
        assert!(!cancel_out.exists(), "Cancelled output must not exist");
        let leftover_tmps: Vec<_> = fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(
            leftover_tmps.is_empty(),
            "No .tmp files may remain after cancel: {leftover_tmps:?}"
        );

        // 4. Full P04 conversion across all 8 pages (0/90/180/270 rot, direct & inherited offset CropBox, 4096 px cap, mixed text page)
        let out_pdf = dir.path().join("p04_searchable_out.pdf");
        let res = make_pdf_searchable_impl(
            "p04-full",
            &pdf_mgr,
            &ocr_mgr,
            &MakePdfSearchableRequest {
                input_path: input_pdf.to_string_lossy().into_owned(),
                output_path: out_pdf.to_string_lossy().into_owned(),
                page_range: None,
                skip_existing_text_pages: true,
                ocr_dpi: 200.0,
                max_side_len: 1280,
                overwrite: true,
                max_side_cap_override: None,
            },
            &Arc::new(AtomicBool::new(false)),
            |_| {},
        )
        .expect("make pdf searchable");

        assert_eq!(res.total_pages, 8);
        assert_eq!(res.ocr_applied_pages, 7);
        assert_eq!(res.skipped_existing_text_pages, 1);
        assert_eq!(res.capped_pages, 1, "Page 8 must hit 4096 px render cap");
        assert_eq!(res.pages[1].status, "skipped_existing_text");
        assert!(
            res.pages[7].render_capped,
            "Page 8 render_capped must be true"
        );
        assert_eq!(res.pages[7].rendered_width_px, Some(4096));
        assert_eq!(
            sha256_file(&input_pdf),
            input_sha_before,
            "Source PDF must remain untouched"
        );

        // 5. Verify outlines & links preserved on output PDF
        let out_inspect = pdf_mgr
            .inspect_document(&out_pdf.to_string_lossy())
            .expect("inspect output");
        assert_eq!(out_inspect.page_count, 8);
        assert!(out_inspect.has_outlines, "Bookmarks must be preserved");
        assert_eq!(out_inspect.outlines[0].title, "Scanned Cover");

        let p1_text = extract_page_text_with_pdfium(None, &out_pdf, 1).expect("p1 text");
        assert!(
            p1_text
                .links
                .iter()
                .any(|l| l.uri.as_deref() == Some("https://example.org/winkit-p04")),
            "External link on page 1 must be preserved"
        );

        // 6. Verify EVERY OCR'd page (1, 3, 4, 5, 6, 7, 8) is searchable for BOTH Chinese & English
        // AND verify actual PDFium text selection rects align with the drawn image region (not offset/mis-rotated/mis-scaled)!
        let search_zh = search_document_with_pdfium(None, &out_pdf, "离线文字识别", false)
            .expect("search Chinese");
        let search_en =
            search_document_with_pdfium(None, &out_pdf, "SHA-256", false).expect("search English");
        let search_code =
            search_document_with_pdfium(None, &out_pdf, "WK-0601", false).expect("search code");

        for page_num in [1usize, 3, 4, 5, 6, 7, 8] {
            let zh_hits: Vec<_> = search_zh
                .matches
                .iter()
                .filter(|m| m.page_number == page_num)
                .collect();
            let en_hits: Vec<_> = search_en
                .matches
                .iter()
                .filter(|m| m.page_number == page_num)
                .collect();
            let code_hits: Vec<_> = search_code
                .matches
                .iter()
                .filter(|m| m.page_number == page_num)
                .collect();

            assert!(
                !zh_hits.is_empty(),
                "Page {page_num} missing Chinese search hit '离线文字识别'"
            );
            assert!(
                !en_hits.is_empty(),
                "Page {page_num} missing English search hit 'SHA-256'"
            );
            assert!(
                !code_hits.is_empty(),
                "Page {page_num} missing code search hit 'WK-0601'"
            );

            // Real selection-box spatial geometry check!
            // On every single fixture page (including Rotate 90/180/270, direct & inherited offset CropBox,
            // and 4096 px capped page 8), the title "离线文字识别" is drawn near the upper half (top ~ 0.15..0.50),
            // "SHA-256" in the middle (~ 0.35..0.68), and "WK-0601" near the lower half (~ 0.60..0.92),
            // strictly ordered top-to-bottom: title.top < sha.top < code.top!
            let title_r = &zh_hits[0].rects[0];
            let sha_r = &en_hits[0].rects[0];
            let code_r = &code_hits[0].rects[0];
            assert!(
                title_r.left >= 0.04 && title_r.left + title_r.width <= 0.96,
                "Page {page_num} title rect X out of drawn image area: {title_r:?}"
            );
            assert!(
                title_r.top >= 0.12 && title_r.top <= 0.55,
                "Page {page_num} title rect Y drifted (wrong rotation/CropBox/DPI scale?): {title_r:?}"
            );
            assert!(
                code_r.top >= 0.55 && code_r.top + code_r.height <= 0.95,
                "Page {page_num} code rect Y drifted (wrong rotation/CropBox/DPI scale?): {code_r:?}"
            );
            assert!(
                title_r.top + 0.05 < sha_r.top && sha_r.top + 0.05 < code_r.top,
                "Page {page_num} selection rects not monotonically ordered top-to-bottom: title={title_r:?}, sha={sha_r:?}, code={code_r:?}"
            );
        }

        // 7. Verify visual rendering pixel fidelity before vs after adding invisible text layer (`3 Tr`)
        for page_num in [1usize, 3, 6, 8] {
            let (m_before, px_before) =
                render_page_rgba_with_pdfium(None, &input_pdf, page_num, Some(600), None, 0, 2048)
                    .expect("render before");
            let (m_after, px_after) =
                render_page_rgba_with_pdfium(None, &out_pdf, page_num, Some(600), None, 0, 2048)
                    .expect("render after");
            assert_eq!(
                (m_before.width_px, m_before.height_px),
                (m_after.width_px, m_after.height_px)
            );
            assert_eq!(
                px_before, px_after,
                "Invisible text layer altered visible pixels on page {page_num}!"
            );
        }

        // 8. Verify native page 2 kept its original text untouched
        let p2_text = extract_page_text_with_pdfium(None, &out_pdf, 2).expect("p2 text");
        assert!(p2_text
            .full_text
            .contains("Existing Native Searchable Page 2"));

        // 9. Idempotency: re-running P04 on its own output skips all 8 pages and NEVER duplicates text!
        let out_pdf_second = dir.path().join("p04_searchable_second_pass.pdf");
        let res2 = make_pdf_searchable_impl(
            "p04-second-pass",
            &pdf_mgr,
            &ocr_mgr,
            &MakePdfSearchableRequest {
                input_path: out_pdf.to_string_lossy().into_owned(),
                output_path: out_pdf_second.to_string_lossy().into_owned(),
                page_range: None,
                skip_existing_text_pages: true,
                ocr_dpi: 200.0,
                max_side_len: 1280,
                overwrite: true,
                max_side_cap_override: None,
            },
            &Arc::new(AtomicBool::new(false)),
            |_| {},
        )
        .expect("second pass p04");
        assert_eq!(res2.ocr_applied_pages, 0);
        assert_eq!(res2.skipped_existing_text_pages, 8);
        let p1_after_second =
            extract_page_text_with_pdfium(None, &out_pdf_second, 1).expect("p1 text 2nd pass");
        assert_eq!(
            p1_after_second.full_text, p1_text.full_text,
            "Re-running P04 must not duplicate text layer"
        );

        // 10. Also verify images_to_pdf_impl single scanned PDF works end-to-end
        let simple_scan = dir.path().join("simple_scan.pdf");
        let no_cancel = AtomicBool::new(false);
        images_to_pdf_impl(
            &ImagesToPdfRequest {
                task_id: None,
                image_paths: vec![fixture.to_string_lossy().into_owned()],
                output_path: simple_scan.to_string_lossy().into_owned(),
                overwrite: Some(true),
                page_size: PdfPageSizePreset::Original,
                orientation: PdfPageOrientation::Auto,
                margin_pt: 0.0,
                background_hex: "#FFFFFF".to_string(),
                jpeg_quality: None,
                lossless_png_images: Some(true),
                assumed_dpi: Some(150.0),
            },
            &no_cancel,
            |_| {},
        )
        .expect("make single scan");
        let simple_out = dir.path().join("simple_scan_searchable.pdf");
        let simple_res = make_pdf_searchable_impl(
            "p04-single",
            &pdf_mgr,
            &ocr_mgr,
            &MakePdfSearchableRequest {
                input_path: simple_scan.to_string_lossy().into_owned(),
                output_path: simple_out.to_string_lossy().into_owned(),
                page_range: None,
                skip_existing_text_pages: true,
                ocr_dpi: 200.0,
                max_side_len: 1280,
                overwrite: true,
                max_side_cap_override: None,
            },
            &Arc::new(AtomicBool::new(false)),
            |_| {},
        )
        .expect("p04 single");
        assert_eq!(simple_res.ocr_applied_pages, 1);
        let simple_txt = extract_page_text_with_pdfium(None, &simple_out, 1).expect("simple txt");
        assert!(simple_txt.full_text.contains("WinKit"));
        assert!(simple_txt.full_text.contains("离线文字识别"));

        // 11. Verify encrypted input rejects with PDF_PASSWORD_REQUIRED and signed input warns clearly
        let mut enc_doc = Document::load(&simple_scan).expect("load simple scan");
        let enc_dict_id = enc_doc.add_object(Object::Dictionary(Dictionary::new()));
        enc_doc
            .trailer
            .set("Encrypt", Object::Reference(enc_dict_id));
        let enc_pdf = dir.path().join("encrypted_marker.pdf");
        enc_doc.save(&enc_pdf).expect("save encrypted marker");
        let enc_err = make_pdf_searchable_impl(
            "p04-enc",
            &pdf_mgr,
            &ocr_mgr,
            &MakePdfSearchableRequest {
                input_path: enc_pdf.to_string_lossy().into_owned(),
                output_path: dir
                    .path()
                    .join("enc_out.pdf")
                    .to_string_lossy()
                    .into_owned(),
                page_range: None,
                skip_existing_text_pages: true,
                ocr_dpi: 200.0,
                max_side_len: 1280,
                overwrite: true,
                max_side_cap_override: None,
            },
            &Arc::new(AtomicBool::new(false)),
            |_| {},
        )
        .unwrap_err();
        assert_eq!(enc_err.code, "PDF_PASSWORD_REQUIRED");

        let mut sig_doc = Document::load(&simple_scan).expect("load simple scan for sig");
        let mut sig_field = Dictionary::new();
        sig_field.set("Type", Object::Name(b"Sig".to_vec()));
        sig_field.set("FT", Object::Name(b"Sig".to_vec()));
        let sig_field_id = sig_doc.add_object(Object::Dictionary(sig_field));
        let mut acro = Dictionary::new();
        acro.set(
            "Fields",
            Object::Array(vec![Object::Reference(sig_field_id)]),
        );
        acro.set("SigFlags", Object::Integer(3));
        let acro_id = sig_doc.add_object(Object::Dictionary(acro));
        if let Ok(cat_id) = sig_doc.trailer.get(b"Root").and_then(Object::as_reference) {
            if let Ok(cat) = sig_doc.get_dictionary_mut(cat_id) {
                cat.set("AcroForm", Object::Reference(acro_id));
            }
        }
        let sig_pdf = dir.path().join("signed_scan.pdf");
        sig_doc.save(&sig_pdf).expect("save signed scan");
        let sig_out = dir.path().join("signed_scan_searchable.pdf");
        let sig_res = make_pdf_searchable_impl(
            "p04-sig",
            &pdf_mgr,
            &ocr_mgr,
            &MakePdfSearchableRequest {
                input_path: sig_pdf.to_string_lossy().into_owned(),
                output_path: sig_out.to_string_lossy().into_owned(),
                page_range: None,
                skip_existing_text_pages: true,
                ocr_dpi: 200.0,
                max_side_len: 1280,
                overwrite: true,
                max_side_cap_override: None,
            },
            &Arc::new(AtomicBool::new(false)),
            |_| {},
        )
        .expect("signed pdf searchable");
        assert!(sig_res.had_signatures);
        assert!(sig_res.warnings.iter().any(|w| w.contains("signature")));
    }

    #[test]
    fn p04_cancel_during_doc_save_preserves_existing_target_hash_and_cleans_tmp() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("ocr_bilingual_sample.png");
        assert!(fixture.is_file(), "Missing fixture {}", fixture.display());

        let dir = tempdir().expect("tempdir");
        let input_pdf = dir.path().join("scan_input.pdf");
        let no_cancel = AtomicBool::new(false);
        images_to_pdf_impl(
            &ImagesToPdfRequest {
                task_id: None,
                image_paths: vec![fixture.to_string_lossy().into_owned()],
                output_path: input_pdf.to_string_lossy().into_owned(),
                overwrite: Some(true),
                page_size: PdfPageSizePreset::Original,
                orientation: PdfPageOrientation::Auto,
                margin_pt: 0.0,
                background_hex: "#FFFFFF".to_string(),
                jpeg_quality: None,
                lossless_png_images: Some(true),
                assumed_dpi: Some(150.0),
            },
            &no_cancel,
            |_| {},
        )
        .expect("create input pdf");
        let input_sha_before = sha256_file(&input_pdf);

        // Pre-populate an existing target file so overwrite=true must NOT clobber it if cancel arrives during doc.save().
        let existing_target = dir.path().join("existing_target.pdf");
        fs::write(
            &existing_target,
            b"%PDF-1.4\n% sentinel-target-bytes-must-survive-cancel\n%%EOF\n",
        )
        .expect("write sentinel target");
        let target_sha_before = sha256_file(&existing_target);

        let pdf_mgr = PdfSessionManager::default();
        let ocr_mgr = OcrSessionManager::default();
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let cancel_during_save = Arc::clone(&cancel_flag);

        let err = make_pdf_searchable_with_save_hook(
            "p04-cancel-during-save",
            &pdf_mgr,
            &ocr_mgr,
            &MakePdfSearchableRequest {
                input_path: input_pdf.to_string_lossy().into_owned(),
                output_path: existing_target.to_string_lossy().into_owned(),
                page_range: None,
                skip_existing_text_pages: true,
                ocr_dpi: 200.0,
                max_side_len: 1280,
                overwrite: true,
                max_side_cap_override: None,
            },
            &cancel_flag,
            |_| {},
            move || {
                // Simulate user cancelling while `doc.save()` was serializing the `.tmp` file.
                cancel_during_save.store(true, Ordering::SeqCst);
            },
        )
        .unwrap_err();

        assert_eq!(err.code, "TASK_CANCELLED");
        assert_eq!(
            sha256_file(&existing_target),
            target_sha_before,
            "Existing target file must remain byte-for-byte unchanged when cancelled during doc.save()"
        );
        assert_eq!(
            sha256_file(&input_pdf),
            input_sha_before,
            "Source PDF must remain untouched"
        );
        let leftover_tmps: Vec<_> = fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(
            leftover_tmps.is_empty(),
            "All temporary files must be deleted after post-save cancellation: {leftover_tmps:?}"
        );
    }

    /// Finds the contiguous sequence of `(char, PdfNormalizedRect)` matching `needle` in PDFium's
    /// extracted character stream (exact copy/selection order).
    fn find_char_rects_for_token(
        chars: &[(char, PdfNormalizedRect)],
        needle: &str,
    ) -> Option<Vec<(char, PdfNormalizedRect)>> {
        let target: Vec<char> = needle.chars().collect();
        if target.is_empty() || chars.len() < target.len() {
            return None;
        }
        for i in 0..=(chars.len() - target.len()) {
            if (0..target.len()).all(|j| chars[i + j].0 == target[j]) {
                return Some(chars[i..i + target.len()].to_vec());
            }
        }
        None
    }

    #[test]
    fn p04_rotated_text_per_char_selection_search_and_copy_order_for_page_rotate_and_baked_bitmap()
    {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("ocr_bilingual_sample.png");
        assert!(fixture.is_file(), "Missing fixture {}", fixture.display());

        let base_rgb = image::open(&fixture)
            .expect("open bilingual fixture")
            .to_rgb8();
        let rot90_cw_rgb = image::imageops::rotate90(&base_rgb);
        let rot180_rgb = image::imageops::rotate180(&base_rgb);
        let rot270_cw_rgb = image::imageops::rotate270(&base_rgb);

        let dir = tempdir().expect("tempdir");
        let input_pdf = dir.path().join("p04_rotated_text_suite.pdf");

        // Build a 6-page PDF covering BOTH classes of rotated text:
        // Class 1 — PDF `/Rotate` dictionary rotation (visual upright after viewer applies /Rotate):
        //   Page 1: /Rotate 90
        //   Page 2: /Rotate 180
        //   Page 3: /Rotate 270
        // Class 2 — `/Rotate = 0` scanned pages where text is physically rotated into the bitmap:
        //   Page 4: /Rotate 0 + 90° CW baked bitmap (vertical text reading top-to-bottom)
        //   Page 5: /Rotate 0 + 180° baked bitmap (upside-down horizontal text reading right-to-left)
        //   Page 6: /Rotate 0 + 270° CW (90° CCW) baked bitmap (vertical text reading bottom-to-top)
        let mut doc = Document::with_version("1.5");
        let root_pages_id = doc.new_object_id();

        let add_rgb_xobj = |doc: &mut Document, img: &image::RgbImage| -> ObjectId {
            let compressed = zlib_compress(img.as_raw()).expect("compress rgb");
            let mut img_dict = Dictionary::new();
            img_dict.set("Type", Object::Name(b"XObject".to_vec()));
            img_dict.set("Subtype", Object::Name(b"Image".to_vec()));
            img_dict.set("Width", Object::Integer(i64::from(img.width())));
            img_dict.set("Height", Object::Integer(i64::from(img.height())));
            img_dict.set("ColorSpace", Object::Name(b"DeviceRGB".to_vec()));
            img_dict.set("BitsPerComponent", Object::Integer(8));
            img_dict.set("Filter", Object::Name(b"FlateDecode".to_vec()));
            let img_id = doc.add_object(Object::Stream(Stream::new(img_dict, compressed)));
            let mut xobjs = Dictionary::new();
            xobjs.set("Im0", Object::Reference(img_id));
            let mut res = Dictionary::new();
            res.set("XObject", Object::Dictionary(xobjs));
            doc.add_object(Object::Dictionary(res))
        };

        let res_base = add_rgb_xobj(&mut doc, &base_rgb);
        let res_rot90 = add_rgb_xobj(&mut doc, &rot90_cw_rgb);
        let res_rot180 = add_rgb_xobj(&mut doc, &rot180_rgb);
        let res_rot270 = add_rgb_xobj(&mut doc, &rot270_cw_rgb);

        let add_page = |doc: &mut Document,
                        res_id: ObjectId,
                        media: [f32; 4],
                        rotate: Option<i64>,
                        draw_rect: [f32; 4],
                        draw_rot_cw: u16|
         -> ObjectId {
            let [x0, y0, x1, y1] = draw_rect;
            let w = x1 - x0;
            let h = y1 - y0;
            let ctm = match draw_rot_cw {
                90 => format!("0 {h} -{w} 0 {x1} {y0} cm"),
                180 => format!("-{w} 0 0 -{h} {x1} {y1} cm"),
                270 => format!("0 -{h} {w} 0 {x0} {y1} cm"),
                _ => format!("{w} 0 0 {h} {x0} {y0} cm"),
            };
            let ops = format!("q\n{ctm}\n/Im0 Do\nQ\n");
            let cid = doc.add_object(Object::Stream(Stream::new(
                Dictionary::new(),
                ops.into_bytes(),
            )));
            let mut p = Dictionary::new();
            p.set("Type", Object::Name(b"Page".to_vec()));
            p.set("Parent", Object::Reference(root_pages_id));
            p.set(
                "MediaBox",
                Object::Array(media.into_iter().map(Object::Real).collect()),
            );
            if let Some(r) = rotate {
                p.set("Rotate", Object::Integer(r));
            }
            p.set("Resources", Object::Reference(res_id));
            p.set("Contents", Object::Reference(cid));
            doc.add_object(Object::Dictionary(p))
        };

        // Class 1: PDF /Rotate 90, 180, 270
        let p1 = add_page(
            &mut doc,
            res_base,
            [0.0, 0.0, 300.0, 600.0],
            Some(90),
            [40.0, 30.0, 260.0, 570.0],
            90,
        );
        let p2 = add_page(
            &mut doc,
            res_base,
            [0.0, 0.0, 600.0, 300.0],
            Some(180),
            [30.0, 40.0, 570.0, 260.0],
            180,
        );
        let p3 = add_page(
            &mut doc,
            res_base,
            [0.0, 0.0, 300.0, 600.0],
            Some(270),
            [40.0, 30.0, 260.0, 570.0],
            270,
        );
        // Class 2: /Rotate=0 with 90° CW, 180°, 270° CW baked into bitmap
        let p4 = add_page(
            &mut doc,
            res_rot90,
            [0.0, 0.0, 300.0, 600.0],
            None,
            [40.0, 30.0, 260.0, 570.0],
            0,
        );
        let p5 = add_page(
            &mut doc,
            res_rot180,
            [0.0, 0.0, 600.0, 300.0],
            None,
            [30.0, 40.0, 570.0, 260.0],
            0,
        );
        let p6 = add_page(
            &mut doc,
            res_rot270,
            [0.0, 0.0, 300.0, 600.0],
            None,
            [40.0, 30.0, 260.0, 570.0],
            0,
        );

        let mut root_pages = Dictionary::new();
        root_pages.set("Type", Object::Name(b"Pages".to_vec()));
        root_pages.set(
            "Kids",
            Object::Array(vec![
                Object::Reference(p1),
                Object::Reference(p2),
                Object::Reference(p3),
                Object::Reference(p4),
                Object::Reference(p5),
                Object::Reference(p6),
            ]),
        );
        root_pages.set("Count", Object::Integer(6));
        doc.objects
            .insert(root_pages_id, Object::Dictionary(root_pages));

        let mut catalog = Dictionary::new();
        catalog.set("Type", Object::Name(b"Catalog".to_vec()));
        catalog.set("Pages", Object::Reference(root_pages_id));
        let catalog_id = doc.add_object(Object::Dictionary(catalog));
        doc.trailer.set("Root", Object::Reference(catalog_id));
        doc.save(&input_pdf).expect("save rotated fixture pdf");

        let out_pdf = dir.path().join("p04_rotated_text_searchable.pdf");
        let pdf_mgr = PdfSessionManager::default();
        let ocr_mgr = OcrSessionManager::default();
        let res = make_pdf_searchable_impl(
            "p04-rotated-selection",
            &pdf_mgr,
            &ocr_mgr,
            &MakePdfSearchableRequest {
                input_path: input_pdf.to_string_lossy().into_owned(),
                output_path: out_pdf.to_string_lossy().into_owned(),
                page_range: None,
                skip_existing_text_pages: true,
                ocr_dpi: 200.0,
                max_side_len: 1280,
                overwrite: true,
                max_side_cap_override: None,
            },
            &Arc::new(AtomicBool::new(false)),
            |_| {},
        )
        .expect("run p04 on rotated suite");
        assert_eq!(res.ocr_applied_pages, 6);

        // Whole-word search must hit multi-character tokens on ALL 6 pages (both /Rotate and baked-in bitmap rotations).
        let search_zh =
            search_document_with_pdfium(None, &out_pdf, "离线文字识别", false).expect("search zh");
        let search_en =
            search_document_with_pdfium(None, &out_pdf, "WinKit", false).expect("search en");

        for page_num in 1usize..=6 {
            let page_txt =
                extract_page_text_with_pdfium(None, &out_pdf, page_num).expect("extract text");
            assert!(
                page_txt.full_text.contains("WinKit"),
                "Page {page_num} copy order missing 'WinKit'; full_text={:?}",
                page_txt.full_text
            );
            assert!(
                page_txt.full_text.contains("离线文字识别"),
                "Page {page_num} copy order missing '离线文字识别'; full_text={:?}",
                page_txt.full_text
            );
            assert!(
                search_en.matches.iter().any(|m| m.page_number == page_num),
                "Page {page_num} whole-word search failed for 'WinKit'"
            );
            assert!(
                search_zh.matches.iter().any(|m| m.page_number == page_num),
                "Page {page_num} whole-word search failed for '离线文字识别'"
            );
        }

        // Now verify PER-CHARACTER selection boxes inside multi-character tokens ("WinKit" & "离线文字识别"):
        // Pages 1..=3 (/Rotate 90/180/270): visual upright -> characters advance left-to-right (increasing center_x, same row y).
        for page_num in [1usize, 2, 3] {
            let chars =
                extract_page_char_rects_with_pdfium(None, &out_pdf, page_num).expect("char rects");
            for token in ["WinKit", "离线文字识别"] {
                let seq = find_char_rects_for_token(&chars, token).unwrap_or_else(|| {
                    panic!("Page {page_num} missing char rects for token {token:?}")
                });
                let first_cy = seq[0].1.top + 0.5 * seq[0].1.height;
                for w in seq.windows(2) {
                    let cx0 = w[0].1.left + 0.5 * w[0].1.width;
                    let cx1 = w[1].1.left + 0.5 * w[1].1.width;
                    let cy1 = w[1].1.top + 0.5 * w[1].1.height;
                    assert!(
                        cx1 > cx0 + 0.002,
                        "Page {page_num} (/Rotate) token {token:?} char '{}' -> '{}' did not advance L->R: {:?} vs {:?}",
                        w[0].0,
                        w[1].0,
                        w[0].1,
                        w[1].1
                    );
                    assert!(
                        (cy1 - first_cy).abs() < 0.04,
                        "Page {page_num} (/Rotate) token {token:?} char '{}' drifted vertically: {:?}",
                        w[1].0,
                        w[1].1
                    );
                }
            }
        }

        // Page 4 (/Rotate=0, 90° CW baked bitmap): vertical reading TOP-TO-BOTTOM -> increasing center_y, same column x!
        {
            let chars =
                extract_page_char_rects_with_pdfium(None, &out_pdf, 4).expect("p4 char rects");
            for token in ["WinKit", "离线文字识别"] {
                let seq = find_char_rects_for_token(&chars, token)
                    .unwrap_or_else(|| panic!("Page 4 missing char rects for {token:?}"));
                let first_cx = seq[0].1.left + 0.5 * seq[0].1.width;
                for w in seq.windows(2) {
                    let cy0 = w[0].1.top + 0.5 * w[0].1.height;
                    let cy1 = w[1].1.top + 0.5 * w[1].1.height;
                    let cx1 = w[1].1.left + 0.5 * w[1].1.width;
                    assert!(
                        cy1 > cy0 + 0.002,
                        "Page 4 (baked 90° CW) token {token:?} char '{}' -> '{}' did not advance Top->Bottom: {:?} vs {:?}",
                        w[0].0,
                        w[1].0,
                        w[0].1,
                        w[1].1
                    );
                    assert!(
                        (cx1 - first_cx).abs() < 0.05,
                        "Page 4 (baked 90° CW) token {token:?} char '{}' drifted horizontally out of vertical column: {:?}",
                        w[1].0,
                        w[1].1
                    );
                }
            }
        }

        // Page 5 (/Rotate=0, 180° baked bitmap): upside-down horizontal reading RIGHT-TO-LEFT -> decreasing center_x, same row y!
        // Also verify cross-span order: "WinKit" precedes "离线文字识别" in PDFium's char stream so dragging
        // from 'W' to '试' in Chrome/Edge selects the full line without PDFium reordering adjacent spans!
        {
            let chars =
                extract_page_char_rects_with_pdfium(None, &out_pdf, 5).expect("p5 char rects");
            let joined_no_ws: String = chars
                .iter()
                .map(|(c, _)| *c)
                .filter(|c| !c.is_whitespace())
                .collect();
            let pos_wk = joined_no_ws.find("WinKit").expect("Page 5 missing WinKit");
            let pos_zh = joined_no_ws
                .find("离线文字识别")
                .expect("Page 5 missing 离线文字识别");
            assert!(
                pos_wk < pos_zh,
                "Page 5 (baked 180°) span order inverted in PDFium (pos_wk={pos_wk}, pos_zh={pos_zh}, text={joined_no_ws:?})"
            );
            for token in ["WinKit", "离线文字识别"] {
                let seq = find_char_rects_for_token(&chars, token)
                    .unwrap_or_else(|| panic!("Page 5 missing char rects for {token:?}"));
                let first_cy = seq[0].1.top + 0.5 * seq[0].1.height;
                for w in seq.windows(2) {
                    let cx0 = w[0].1.left + 0.5 * w[0].1.width;
                    let cx1 = w[1].1.left + 0.5 * w[1].1.width;
                    let cy1 = w[1].1.top + 0.5 * w[1].1.height;
                    assert!(
                        cx1 < cx0 - 0.002,
                        "Page 5 (baked 180°) token {token:?} char '{}' -> '{}' did not advance Right->Left: {:?} vs {:?}",
                        w[0].0,
                        w[1].0,
                        w[0].1,
                        w[1].1
                    );
                    assert!(
                        (cy1 - first_cy).abs() < 0.04,
                        "Page 5 (baked 180°) token {token:?} char '{}' drifted vertically: {:?}",
                        w[1].0,
                        w[1].1
                    );
                }
            }
        }

        // Page 6 (/Rotate=0, 270° CW / 90° CCW baked bitmap): vertical reading BOTTOM-TO-TOP -> decreasing center_y, same column x!
        {
            let chars =
                extract_page_char_rects_with_pdfium(None, &out_pdf, 6).expect("p6 char rects");
            for token in ["WinKit", "离线文字识别"] {
                let seq = find_char_rects_for_token(&chars, token)
                    .unwrap_or_else(|| panic!("Page 6 missing char rects for {token:?}"));
                let first_cx = seq[0].1.left + 0.5 * seq[0].1.width;
                for w in seq.windows(2) {
                    let cy0 = w[0].1.top + 0.5 * w[0].1.height;
                    let cy1 = w[1].1.top + 0.5 * w[1].1.height;
                    let cx1 = w[1].1.left + 0.5 * w[1].1.width;
                    assert!(
                        cy1 < cy0 - 0.002,
                        "Page 6 (baked 270° CW) token {token:?} char '{}' -> '{}' did not advance Bottom->Top: {:?} vs {:?}",
                        w[0].0,
                        w[1].0,
                        w[0].1,
                        w[1].1
                    );
                    assert!(
                        (cx1 - first_cx).abs() < 0.05,
                        "Page 6 (baked 270° CW) token {token:?} char '{}' drifted horizontally out of vertical column: {:?}",
                        w[1].0,
                        w[1].1
                    );
                }
            }
        }
    }
}
