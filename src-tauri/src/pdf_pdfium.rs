//! Bundled standalone Windows x64 PDFium FFI wrapper.
//!
//! Security & deployment invariants:
//! - Strictly loads `pdfium.dll` from the bundled WinKit resource/install directory (never `PATH`).
//! - Verifies exact byte length (`7,849,984` B) and SHA-256 digest before calling `LoadLibraryW`.
//! - Uses `FPDF_LoadCustomDocument` backed by Rust `std::fs::File` for full UTF-16 Windows path
//!   support (`中文路径.pdf`), bounded streaming reads without loading the whole file into memory,
//!   and immediate file handle release upon document drop.
//! - Enforces pixel, dimension, and count caps on untrusted inputs so malformed/oversized pages
//!   cannot trigger unbounded allocations.

use crate::error::AppError;
use crate::fs_guard::validate_existing_input_file;
use crate::image_assets::encode_rgba_to_png_fast;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::ffi::{c_char, c_double, c_int, c_uint, c_ulong, c_void};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::{Mutex, OnceLock};

pub const PDFIUM_DLL_FILENAME: &str = "pdfium.dll";
pub const PDFIUM_VERSION_LABEL: &str = "PDFium 160.0.8179.0 (chromium/8179)";
pub const PDFIUM_EXPECTED_BYTES: usize = 7_849_984;
pub const PDFIUM_EXPECTED_SHA256: &str =
    "b9324fe77556753e24443b8ff1d03b39a3aa01ccd6e56e7debb82922438e8965";

pub const MAX_PDF_FILE_BYTES: u64 = 512 * 1024 * 1024; // 512 MiB hard safety cap
pub const MAX_PDF_PAGES: usize = 5_000;
pub const OVERSIZED_PAGE_PT: f32 = 14_400.0; // PDF 1.7 standard 200-inch ceiling
pub const MAX_RENDER_SIDE_PX: u32 = 8_192;
pub const MAX_RENDER_PIXELS: u64 = 48_000_000;
pub const MAX_PREVIEW_SIDE_PX: u32 = 2_600;
const MAX_OUTLINE_ITEMS: usize = 2_000;
const MAX_OUTLINE_DEPTH: usize = 16;
const MAX_TEXT_RECTS_PER_PAGE: usize = 4_000;
const MAX_SEARCH_MATCHES_TOTAL: usize = 500;
const MAX_LINKS_PER_PAGE: usize = 500;
pub const MAX_PDFIUM_PAGE_RAW_CHARS: usize = 200_000;

const FPDF_ERR_FILE: c_ulong = 2;
const FPDF_ERR_FORMAT: c_ulong = 3;
const FPDF_ERR_PASSWORD: c_ulong = 4;
const FPDF_ERR_SECURITY: c_ulong = 5;
const FPDF_ERR_PAGE: c_ulong = 6;

const FPDF_BITMAP_BGRA: c_int = 4;
const FPDF_ANNOT: c_int = 0x01;

const PDFACTION_GOTO: c_ulong = 1;
const PDFACTION_URI: c_ulong = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPageGeometry {
    pub page_number: usize,
    pub width_pt: f32,
    pub height_pt: f32,
    pub rotation: u16,
    pub is_oversized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfOutlineItem {
    pub title: String,
    pub page_number: Option<usize>,
    pub children: Vec<PdfOutlineItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfNormalizedRect {
    pub left: f32,
    pub top: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfTextSpan {
    pub text: String,
    pub rect: PdfNormalizedRect,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfLinkItem {
    pub rect: PdfNormalizedRect,
    pub kind: String, // "internal" | "external"
    pub target_page: Option<usize>,
    pub uri: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPageTextPayload {
    pub page_number: usize,
    pub full_text: String,
    pub char_count: usize,
    pub spans: Vec<PdfTextSpan>,
    pub links: Vec<PdfLinkItem>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PdfExtractedPageStatus {
    Included,
    Truncated,
    Scanned,
    Omitted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfExtractedPageMeta {
    pub page_number: usize,
    pub char_count: usize,
    pub byte_count: usize,
    pub has_text: bool,
    pub status: PdfExtractedPageStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfExtractPagesTextResult {
    pub path: String,
    pub file_name: String,
    pub total_pages: usize,
    pub requested_pages: Vec<usize>,
    pub included_pages: Vec<usize>,
    pub scanned_pages: Vec<usize>,
    pub omitted_pages: Vec<usize>,
    pub pages: Vec<PdfExtractedPageMeta>,
    pub combined_text: String,
    pub extracted_page_count: usize,
    pub total_chars: usize,
    pub total_bytes: usize,
    pub truncated: bool,
}

/// Normalizes raw PDFium `FPDFText_GetText` page text for clean editing and natural offline
/// speech synthesis while preserving paragraph boundaries.
pub fn normalize_pdf_text_for_speech(raw: &str) -> String {
    let cleaned: String = raw
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|&c| {
            !matches!(
                c,
                '\u{FEFF}' | '\u{00AD}' | '\u{200B}' | '\u{200C}' | '\u{200D}'
            ) && (!c.is_control() || c == '\n' || c == '\t')
        })
        .collect();

    let mut out_lines: Vec<String> = Vec::new();
    let mut consecutive_empty = 0usize;

    for raw_line in cleaned.split('\n') {
        let mut norm_line = String::new();
        let mut prev_space = false;
        for ch in raw_line.trim().chars() {
            if ch == '\t' || ch == ' ' || ch == '\u{00A0}' {
                if !prev_space && !norm_line.is_empty() {
                    norm_line.push(' ');
                    prev_space = true;
                }
            } else {
                norm_line.push(ch);
                prev_space = false;
            }
        }
        let trimmed = norm_line.trim();
        if trimmed.is_empty() {
            if !out_lines.is_empty() && consecutive_empty == 0 {
                out_lines.push(String::new());
                consecutive_empty = 1;
            }
        } else {
            out_lines.push(trimmed.to_string());
            consecutive_empty = 0;
        }
    }

    while out_lines.last().is_some_and(|l| l.is_empty()) {
        out_lines.pop();
    }

    out_lines.join("\n")
}

#[derive(Debug, Clone, Copy)]
struct AppendTtsTextOutcome {
    added_chars: usize,
    added_bytes: usize,
    hit_budget: bool,
}

fn append_bounded_tts_text(
    combined: &mut String,
    total_chars: &mut usize,
    piece: &str,
    max_chars: usize,
    max_bytes: usize,
) -> AppendTtsTextOutcome {
    let Some(first_ch) = piece.chars().next() else {
        return AppendTtsTextOutcome {
            added_chars: 0,
            added_bytes: 0,
            hit_budget: false,
        };
    };
    let sep = if combined.is_empty() { "" } else { "\n\n" };
    let sep_chars = sep.chars().count();
    let sep_bytes = sep.len();

    // Only append the inter-page separator if at least one character of `piece` fits within both
    // character and UTF-8 byte ceilings.
    if *total_chars + sep_chars + 1 > max_chars
        || combined.len() + sep_bytes + first_ch.len_utf8() > max_bytes
    {
        return AppendTtsTextOutcome {
            added_chars: 0,
            added_bytes: 0,
            hit_budget: true,
        };
    }

    let piece_chars = piece.chars().count();
    if *total_chars + sep_chars + piece_chars <= max_chars
        && combined.len() + sep_bytes + piece.len() <= max_bytes
    {
        combined.push_str(sep);
        combined.push_str(piece);
        *total_chars += sep_chars + piece_chars;
        return AppendTtsTextOutcome {
            added_chars: piece_chars,
            added_bytes: piece.len(),
            hit_budget: false,
        };
    }

    // Truncate cleanly on a UTF-8 character boundary within both char and byte ceilings.
    combined.push_str(sep);
    *total_chars += sep_chars;
    let mut added_chars = 0usize;
    let mut added_bytes = 0usize;
    for ch in piece.chars() {
        let ch_bytes = ch.len_utf8();
        if *total_chars + 1 > max_chars || combined.len() + ch_bytes > max_bytes {
            break;
        }
        combined.push(ch);
        *total_chars += 1;
        added_chars += 1;
        added_bytes += ch_bytes;
    }
    AppendTtsTextOutcome {
        added_chars,
        added_bytes,
        hit_budget: true,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfSearchMatch {
    pub page_number: usize,
    pub match_index: usize,
    pub snippet: String,
    pub rects: Vec<PdfNormalizedRect>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfSearchResult {
    pub query: String,
    pub total_matches: usize,
    pub truncated: bool,
    pub matches: Vec<PdfSearchMatch>,
}

/// Exact affine mapping from PDFium rendered device pixels `(dx, dy)` in `[0, width_px] × [0, height_px]`
/// into raw PDF page user-space coordinates `(page_x, page_y)`, computed directly via `FPDF_DeviceToPage`
/// using the exact same viewport and rotation passed to `FPDF_RenderPageBitmap`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfDeviceToPageTransform {
    pub origin_x: f64,
    pub origin_y: f64,
    pub dx_per_px_x: f64,
    pub dx_per_px_y: f64,
    pub dy_per_px_x: f64,
    pub dy_per_px_y: f64,
}

impl PdfDeviceToPageTransform {
    pub fn from_corners(
        width_px: u32,
        height_px: u32,
        origin: (f64, f64),
        top_right: (f64, f64),
        bottom_left: (f64, f64),
    ) -> Self {
        let w = (width_px.max(1)) as f64;
        let h = (height_px.max(1)) as f64;
        Self {
            origin_x: origin.0,
            origin_y: origin.1,
            dx_per_px_x: (top_right.0 - origin.0) / w,
            dx_per_px_y: (top_right.1 - origin.1) / w,
            dy_per_px_x: (bottom_left.0 - origin.0) / h,
            dy_per_px_y: (bottom_left.1 - origin.1) / h,
        }
    }

    pub fn map_device_point(&self, dx: f64, dy: f64) -> (f64, f64) {
        (
            self.origin_x + dx * self.dx_per_px_x + dy * self.dy_per_px_x,
            self.origin_y + dx * self.dx_per_px_y + dy * self.dy_per_px_y,
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPageTextSummary {
    pub page_number: usize,
    pub width_pt: f32,
    pub height_pt: f32,
    pub rotation: u16,
    pub meaningful_char_count: usize,
    pub has_text_layer: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfRenderMeta {
    pub page_number: usize,
    pub width_px: u32,
    pub height_px: u32,
    pub page_width_pt: f32,
    pub page_height_pt: f32,
    pub rotation: u16,
    pub capped: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_to_page: Option<PdfDeviceToPageTransform>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfiumInspectResult {
    pub page_count: usize,
    pub pages: Vec<PdfPageGeometry>,
    pub has_text_layer: bool,
    pub sampled_text_pages: usize,
    pub is_likely_scanned: bool,
    pub outlines: Vec<PdfOutlineItem>,
    pub title: Option<String>,
    pub author: Option<String>,
    pub subject: Option<String>,
    pub creator: Option<String>,
    pub producer: Option<String>,
    pub warnings: Vec<String>,
}

/// Resolve bundled `pdfium.dll` strictly from WinKit's own directories (never `PATH`).
pub fn resolve_pdfium_dll_path(resource_dir: Option<&Path>) -> Result<PathBuf, AppError> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(res) = resource_dir {
        candidates.push(res.join("pdfium").join(PDFIUM_DLL_FILENAME));
        candidates.push(res.join(PDFIUM_DLL_FILENAME));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join("pdfium").join(PDFIUM_DLL_FILENAME));
            candidates.push(
                exe_dir
                    .join("resources")
                    .join("pdfium")
                    .join(PDFIUM_DLL_FILENAME),
            );
        }
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("pdfium")
            .join(PDFIUM_DLL_FILENAME),
    );

    for path in &candidates {
        if path.is_file() {
            return Ok(path.clone());
        }
    }

    Err(AppError::new(
        "PDF_ENGINE_MISSING",
        format!(
            "Bundled offline PDF rendering library ({PDFIUM_DLL_FILENAME}) was not found in the application directory."
        ),
    ))
}

fn verify_pdfium_dll(path: &Path) -> Result<(), AppError> {
    let bytes = fs::read(path).map_err(|e| {
        AppError::new(
            "PDF_ENGINE_MISSING",
            format!("Unable to read bundled {PDFIUM_DLL_FILENAME}: {e}"),
        )
    })?;
    if bytes.len() != PDFIUM_EXPECTED_BYTES {
        return Err(AppError::new(
            "PDF_ENGINE_INVALID",
            format!(
                "Bundled {PDFIUM_DLL_FILENAME} size mismatch (expected {PDFIUM_EXPECTED_BYTES} bytes, got {}).",
                bytes.len()
            ),
        ));
    }
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let actual_hex = format!("{:x}", hasher.finalize());
    if actual_hex != PDFIUM_EXPECTED_SHA256 {
        return Err(AppError::new(
            "PDF_ENGINE_INVALID",
            "Bundled PDFium library integrity checksum mismatch.",
        ));
    }
    Ok(())
}

/// Compute bounded pixel dimensions for rendering a page at target width or DPI.
pub fn compute_bounded_render_size(
    page_width_pt: f32,
    page_height_pt: f32,
    extra_rotation_cw: u16,
    target_width_px: Option<u32>,
    target_dpi: Option<f32>,
    max_side_cap: u32,
) -> (u32, u32, bool) {
    let safe_w = if page_width_pt.is_finite() && page_width_pt > 1.0 {
        page_width_pt
    } else {
        595.0
    };
    let safe_h = if page_height_pt.is_finite() && page_height_pt > 1.0 {
        page_height_pt
    } else {
        842.0
    };
    let (eff_w_pt, eff_h_pt) = if extra_rotation_cw % 180 == 90 {
        (safe_h, safe_w)
    } else {
        (safe_w, safe_h)
    };

    let (mut desired_w, mut desired_h) = if let Some(dpi) = target_dpi {
        let clamped_dpi = dpi.clamp(24.0, 600.0);
        let scale = clamped_dpi / 72.0;
        (
            (eff_w_pt as f64 * scale as f64).round().max(1.0),
            (eff_h_pt as f64 * scale as f64).round().max(1.0),
        )
    } else {
        let tw = target_width_px.unwrap_or(960).clamp(32, max_side_cap) as f64;
        let aspect = (eff_h_pt as f64) / (eff_w_pt as f64);
        (tw, (tw * aspect).round().max(1.0))
    };

    let mut capped = false;
    let side_cap = max_side_cap.min(MAX_RENDER_SIDE_PX) as f64;
    if desired_w > side_cap || desired_h > side_cap {
        let ratio = (side_cap / desired_w).min(side_cap / desired_h);
        desired_w = (desired_w * ratio).floor().max(1.0);
        desired_h = (desired_h * ratio).floor().max(1.0);
        capped = true;
    }

    let pixels = desired_w * desired_h;
    if pixels > MAX_RENDER_PIXELS as f64 {
        let ratio = ((MAX_RENDER_PIXELS as f64) / pixels).sqrt();
        desired_w = (desired_w * ratio).floor().max(1.0);
        desired_h = (desired_h * ratio).floor().max(1.0);
        capped = true;
    }

    ((desired_w as u32).max(1), (desired_h as u32).max(1), capped)
}

#[cfg(windows)]
mod win_impl {
    use super::*;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCSTR;
    use windows::Win32::Foundation::HMODULE;
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

    type FpdfDocument = *mut c_void;
    type FpdfPage = *mut c_void;
    type FpdfBitmap = *mut c_void;
    type FpdfTextPage = *mut c_void;
    type FpdfSchHandle = *mut c_void;
    type FpdfBookmark = *mut c_void;
    type FpdfDest = *mut c_void;
    type FpdfLink = *mut c_void;
    type FpdfAction = *mut c_void;

    #[repr(C)]
    struct FpdfLibraryConfig {
        version: c_int,
        user_font_paths: *const *const c_char,
        isolate: *mut c_void,
        v8_embedder_slot: c_uint,
        platform: *mut c_void,
        renderer_type: c_int,
    }

    #[repr(C)]
    struct FsSizeF {
        width: f32,
        height: f32,
    }

    #[repr(C)]
    struct FsRectF {
        left: f32,
        top: f32,
        right: f32,
        bottom: f32,
    }

    #[repr(C)]
    struct FpdfFileAccess {
        file_len: c_ulong,
        get_block: unsafe extern "C" fn(
            param: *mut c_void,
            position: c_ulong,
            buf: *mut u8,
            size: c_ulong,
        ) -> c_int,
        param: *mut c_void,
    }

    struct FileReadCtx {
        file: File,
        len: u64,
    }

    unsafe extern "C" fn file_get_block(
        param: *mut c_void,
        position: c_ulong,
        buf: *mut u8,
        size: c_ulong,
    ) -> c_int {
        if param.is_null() || buf.is_null() {
            return 0;
        }
        let ctx = &mut *(param as *mut FileReadCtx);
        let pos = position as u64;
        let req = size as usize;
        if pos.saturating_add(req as u64) > ctx.len {
            return 0;
        }
        if ctx.file.seek(SeekFrom::Start(pos)).is_err() {
            return 0;
        }
        let slice = std::slice::from_raw_parts_mut(buf, req);
        if ctx.file.read_exact(slice).is_err() {
            return 0;
        }
        1
    }

    #[allow(non_snake_case)]
    pub struct PdfiumApi {
        _module: HMODULE,
        FPDF_InitLibraryWithConfig: unsafe extern "C" fn(*const FpdfLibraryConfig),
        FPDF_LoadCustomDocument:
            unsafe extern "C" fn(*mut FpdfFileAccess, *const c_char) -> FpdfDocument,
        FPDF_CloseDocument: unsafe extern "C" fn(FpdfDocument),
        FPDF_GetLastError: unsafe extern "C" fn() -> c_ulong,
        FPDF_GetPageCount: unsafe extern "C" fn(FpdfDocument) -> c_int,
        FPDF_GetPageSizeByIndexF: unsafe extern "C" fn(FpdfDocument, c_int, *mut FsSizeF) -> c_int,
        FPDF_LoadPage: unsafe extern "C" fn(FpdfDocument, c_int) -> FpdfPage,
        FPDF_ClosePage: unsafe extern "C" fn(FpdfPage),
        FPDFPage_GetRotation: unsafe extern "C" fn(FpdfPage) -> c_int,
        FPDFBitmap_CreateEx:
            unsafe extern "C" fn(c_int, c_int, c_int, *mut c_void, c_int) -> FpdfBitmap,
        FPDFBitmap_FillRect:
            unsafe extern "C" fn(FpdfBitmap, c_int, c_int, c_int, c_int, c_ulong) -> c_int,
        FPDFBitmap_Destroy: unsafe extern "C" fn(FpdfBitmap),
        FPDF_RenderPageBitmap:
            unsafe extern "C" fn(FpdfBitmap, FpdfPage, c_int, c_int, c_int, c_int, c_int, c_int),
        FPDF_PageToDevice: unsafe extern "C" fn(
            FpdfPage,
            c_int,
            c_int,
            c_int,
            c_int,
            c_int,
            c_double,
            c_double,
            *mut c_int,
            *mut c_int,
        ) -> c_int,
        FPDF_DeviceToPage: unsafe extern "C" fn(
            FpdfPage,
            c_int,
            c_int,
            c_int,
            c_int,
            c_int,
            c_int,
            c_int,
            *mut c_double,
            *mut c_double,
        ) -> c_int,
        FPDFText_LoadPage: unsafe extern "C" fn(FpdfPage) -> FpdfTextPage,
        FPDFText_ClosePage: unsafe extern "C" fn(FpdfTextPage),
        FPDFText_CountChars: unsafe extern "C" fn(FpdfTextPage) -> c_int,
        FPDFText_GetText: unsafe extern "C" fn(FpdfTextPage, c_int, c_int, *mut u16) -> c_int,
        FPDFText_CountRects: unsafe extern "C" fn(FpdfTextPage, c_int, c_int) -> c_int,
        FPDFText_GetRect: unsafe extern "C" fn(
            FpdfTextPage,
            c_int,
            *mut c_double,
            *mut c_double,
            *mut c_double,
            *mut c_double,
        ) -> c_int,
        FPDFText_GetBoundedText: unsafe extern "C" fn(
            FpdfTextPage,
            c_double,
            c_double,
            c_double,
            c_double,
            *mut u16,
            c_int,
        ) -> c_int,
        FPDFText_FindStart:
            unsafe extern "C" fn(FpdfTextPage, *const u16, c_ulong, c_int) -> FpdfSchHandle,
        FPDFText_FindNext: unsafe extern "C" fn(FpdfSchHandle) -> c_int,
        FPDFText_FindClose: unsafe extern "C" fn(FpdfSchHandle),
        FPDFText_GetSchResultIndex: unsafe extern "C" fn(FpdfSchHandle) -> c_int,
        FPDFText_GetSchCount: unsafe extern "C" fn(FpdfSchHandle) -> c_int,
        FPDFBookmark_GetFirstChild:
            unsafe extern "C" fn(FpdfDocument, FpdfBookmark) -> FpdfBookmark,
        FPDFBookmark_GetNextSibling:
            unsafe extern "C" fn(FpdfDocument, FpdfBookmark) -> FpdfBookmark,
        FPDFBookmark_GetTitle: unsafe extern "C" fn(FpdfBookmark, *mut c_void, c_ulong) -> c_ulong,
        FPDFBookmark_GetDest: unsafe extern "C" fn(FpdfDocument, FpdfBookmark) -> FpdfDest,
        FPDFBookmark_GetAction: unsafe extern "C" fn(FpdfBookmark) -> FpdfAction,
        FPDFDest_GetDestPageIndex: unsafe extern "C" fn(FpdfDocument, FpdfDest) -> c_int,
        FPDFLink_Enumerate: unsafe extern "C" fn(FpdfPage, *mut c_int, *mut FpdfLink) -> c_int,
        FPDFLink_GetAnnotRect: unsafe extern "C" fn(FpdfLink, *mut FsRectF) -> c_int,
        FPDFLink_GetDest: unsafe extern "C" fn(FpdfDocument, FpdfLink) -> FpdfDest,
        FPDFLink_GetAction: unsafe extern "C" fn(FpdfLink) -> FpdfAction,
        FPDFAction_GetType: unsafe extern "C" fn(FpdfAction) -> c_ulong,
        FPDFAction_GetDest: unsafe extern "C" fn(FpdfDocument, FpdfAction) -> FpdfDest,
        FPDFAction_GetURIPath:
            unsafe extern "C" fn(FpdfDocument, FpdfAction, *mut c_void, c_ulong) -> c_ulong,
        FPDF_GetMetaText:
            unsafe extern "C" fn(FpdfDocument, *const c_char, *mut c_void, c_ulong) -> c_ulong,
    }

    // PDFium is NOT thread-safe internally; all calls serialize through `PDFIUM_RUNTIME` mutex.
    unsafe impl Send for PdfiumApi {}

    static PDFIUM_RUNTIME: OnceLock<Mutex<Option<PdfiumApi>>> = OnceLock::new();

    unsafe fn load_sym<T>(module: HMODULE, name: &[u8]) -> Result<T, AppError> {
        let proc = GetProcAddress(module, PCSTR::from_raw(name.as_ptr())).ok_or_else(|| {
            let label = String::from_utf8_lossy(&name[..name.len().saturating_sub(1)]);
            AppError::new(
                "PDF_ENGINE_INVALID",
                format!("Required PDFium symbol '{label}' was not found."),
            )
        })?;
        Ok(std::mem::transmute_copy(&proc))
    }

    impl PdfiumApi {
        fn load(dll_path: &Path) -> Result<Self, AppError> {
            verify_pdfium_dll(dll_path)?;
            let wide: Vec<u16> = OsStr::new(dll_path)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let module = unsafe { LoadLibraryW(windows::core::PCWSTR::from_raw(wide.as_ptr())) }
                .map_err(|e| {
                    AppError::new(
                        "PDF_ENGINE_LOAD_FAILED",
                        format!("Failed to load bundled {PDFIUM_DLL_FILENAME}: {e}"),
                    )
                })?;

            let api = unsafe {
                Self {
                    _module: module,
                    FPDF_InitLibraryWithConfig: load_sym(module, b"FPDF_InitLibraryWithConfig\0")?,
                    FPDF_LoadCustomDocument: load_sym(module, b"FPDF_LoadCustomDocument\0")?,
                    FPDF_CloseDocument: load_sym(module, b"FPDF_CloseDocument\0")?,
                    FPDF_GetLastError: load_sym(module, b"FPDF_GetLastError\0")?,
                    FPDF_GetPageCount: load_sym(module, b"FPDF_GetPageCount\0")?,
                    FPDF_GetPageSizeByIndexF: load_sym(module, b"FPDF_GetPageSizeByIndexF\0")?,
                    FPDF_LoadPage: load_sym(module, b"FPDF_LoadPage\0")?,
                    FPDF_ClosePage: load_sym(module, b"FPDF_ClosePage\0")?,
                    FPDFPage_GetRotation: load_sym(module, b"FPDFPage_GetRotation\0")?,
                    FPDFBitmap_CreateEx: load_sym(module, b"FPDFBitmap_CreateEx\0")?,
                    FPDFBitmap_FillRect: load_sym(module, b"FPDFBitmap_FillRect\0")?,
                    FPDFBitmap_Destroy: load_sym(module, b"FPDFBitmap_Destroy\0")?,
                    FPDF_RenderPageBitmap: load_sym(module, b"FPDF_RenderPageBitmap\0")?,
                    FPDF_PageToDevice: load_sym(module, b"FPDF_PageToDevice\0")?,
                    FPDF_DeviceToPage: load_sym(module, b"FPDF_DeviceToPage\0")?,
                    FPDFText_LoadPage: load_sym(module, b"FPDFText_LoadPage\0")?,
                    FPDFText_ClosePage: load_sym(module, b"FPDFText_ClosePage\0")?,
                    FPDFText_CountChars: load_sym(module, b"FPDFText_CountChars\0")?,
                    FPDFText_GetText: load_sym(module, b"FPDFText_GetText\0")?,
                    FPDFText_CountRects: load_sym(module, b"FPDFText_CountRects\0")?,
                    FPDFText_GetRect: load_sym(module, b"FPDFText_GetRect\0")?,
                    FPDFText_GetBoundedText: load_sym(module, b"FPDFText_GetBoundedText\0")?,
                    FPDFText_FindStart: load_sym(module, b"FPDFText_FindStart\0")?,
                    FPDFText_FindNext: load_sym(module, b"FPDFText_FindNext\0")?,
                    FPDFText_FindClose: load_sym(module, b"FPDFText_FindClose\0")?,
                    FPDFText_GetSchResultIndex: load_sym(module, b"FPDFText_GetSchResultIndex\0")?,
                    FPDFText_GetSchCount: load_sym(module, b"FPDFText_GetSchCount\0")?,
                    FPDFBookmark_GetFirstChild: load_sym(module, b"FPDFBookmark_GetFirstChild\0")?,
                    FPDFBookmark_GetNextSibling: load_sym(
                        module,
                        b"FPDFBookmark_GetNextSibling\0",
                    )?,
                    FPDFBookmark_GetTitle: load_sym(module, b"FPDFBookmark_GetTitle\0")?,
                    FPDFBookmark_GetDest: load_sym(module, b"FPDFBookmark_GetDest\0")?,
                    FPDFBookmark_GetAction: load_sym(module, b"FPDFBookmark_GetAction\0")?,
                    FPDFDest_GetDestPageIndex: load_sym(module, b"FPDFDest_GetDestPageIndex\0")?,
                    FPDFLink_Enumerate: load_sym(module, b"FPDFLink_Enumerate\0")?,
                    FPDFLink_GetAnnotRect: load_sym(module, b"FPDFLink_GetAnnotRect\0")?,
                    FPDFLink_GetDest: load_sym(module, b"FPDFLink_GetDest\0")?,
                    FPDFLink_GetAction: load_sym(module, b"FPDFLink_GetAction\0")?,
                    FPDFAction_GetType: load_sym(module, b"FPDFAction_GetType\0")?,
                    FPDFAction_GetDest: load_sym(module, b"FPDFAction_GetDest\0")?,
                    FPDFAction_GetURIPath: load_sym(module, b"FPDFAction_GetURIPath\0")?,
                    FPDF_GetMetaText: load_sym(module, b"FPDF_GetMetaText\0")?,
                }
            };

            let cfg = FpdfLibraryConfig {
                version: 2,
                user_font_paths: ptr::null(),
                isolate: ptr::null_mut(),
                v8_embedder_slot: 0,
                platform: ptr::null_mut(),
                renderer_type: 0,
            };
            unsafe {
                (api.FPDF_InitLibraryWithConfig)(&cfg);
            }
            Ok(api)
        }
    }

    struct LoadedPdfDoc<'a> {
        api: &'a PdfiumApi,
        doc: FpdfDocument,
        _access: Box<FpdfFileAccess>,
        _ctx: Box<FileReadCtx>,
    }

    impl<'a> Drop for LoadedPdfDoc<'a> {
        fn drop(&mut self) {
            if !self.doc.is_null() {
                unsafe {
                    (self.api.FPDF_CloseDocument)(self.doc);
                }
                self.doc = ptr::null_mut();
            }
        }
    }

    fn open_pdf_doc<'a>(api: &'a PdfiumApi, path: &Path) -> Result<LoadedPdfDoc<'a>, AppError> {
        let path_str = path.to_string_lossy();
        let (canonical, file_len) = validate_existing_input_file(&path_str)?;
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

        let mut file_attempt = 0u32;
        let file = loop {
            match File::open(&canonical) {
                Ok(f) => break f,
                Err(e) if matches!(e.raw_os_error(), Some(5 | 32 | 33)) && file_attempt < 6 => {
                    file_attempt += 1;
                    std::thread::sleep(std::time::Duration::from_millis(35 * file_attempt as u64));
                }
                Err(e) => {
                    return Err(AppError::from_io(e, "Unable to open PDF file for reading"));
                }
            }
        };
        let mut ctx = Box::new(FileReadCtx {
            file,
            len: file_len,
        });
        let mut access = Box::new(FpdfFileAccess {
            file_len: file_len as c_ulong,
            get_block: file_get_block,
            param: (&mut *ctx as *mut FileReadCtx) as *mut c_void,
        });

        let doc = unsafe { (api.FPDF_LoadCustomDocument)(&mut *access, ptr::null()) };
        if doc.is_null() {
            let err_code = unsafe { (api.FPDF_GetLastError)() };
            return Err(map_pdfium_error(err_code));
        }

        let page_count = unsafe { (api.FPDF_GetPageCount)(doc) };
        if page_count < 0 {
            unsafe { (api.FPDF_CloseDocument)(doc) };
            return Err(AppError::new(
                "PDF_CORRUPT_OR_INVALID",
                "PDF document reported an invalid page count.",
            ));
        }
        if (page_count as usize) > MAX_PDF_PAGES {
            unsafe { (api.FPDF_CloseDocument)(doc) };
            return Err(AppError::size_limit(format!(
                "PDF has {page_count} pages, exceeding the {MAX_PDF_PAGES}-page safety limit."
            )));
        }

        Ok(LoadedPdfDoc {
            api,
            doc,
            _access: access,
            _ctx: ctx,
        })
    }

    fn map_pdfium_error(code: c_ulong) -> AppError {
        match code {
            FPDF_ERR_PASSWORD => AppError::new(
                "PDF_PASSWORD_REQUIRED",
                "This PDF requires a password to open. Use PDF Decrypt (P16) with the known password to create an unlocked copy.",
            ),
            FPDF_ERR_SECURITY => AppError::new(
                "PDF_UNSUPPORTED_SECURITY",
                "This PDF uses an unsupported security handler.",
            ),
            FPDF_ERR_FORMAT => AppError::new(
                "PDF_CORRUPT_OR_INVALID",
                "This file is not a valid PDF document or its structure is corrupted.",
            ),
            FPDF_ERR_PAGE => AppError::new(
                "PDF_PAGE_ERROR",
                "PDF page data is missing or unreadable.",
            ),
            FPDF_ERR_FILE => AppError::new(
                "FILE_NOT_FOUND",
                "Unable to read PDF file.",
            ),
            _ => AppError::new(
                "PDF_CORRUPT_OR_INVALID",
                format!("Failed to open PDF document (PDFium error {code})."),
            ),
        }
    }

    fn utf16le_bytes_to_string(buf: &[u8]) -> String {
        let mut units: Vec<u16> = buf
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .collect();
        while units.last() == Some(&0) {
            units.pop();
        }
        String::from_utf16_lossy(&units).trim().to_string()
    }

    fn read_meta_text(api: &PdfiumApi, doc: FpdfDocument, tag: &[u8]) -> Option<String> {
        let len = unsafe {
            (api.FPDF_GetMetaText)(doc, tag.as_ptr() as *const c_char, ptr::null_mut(), 0)
        };
        if len <= 2 || len > 16_384 {
            return None;
        }
        let mut buf = vec![0u8; len as usize];
        let written = unsafe {
            (api.FPDF_GetMetaText)(
                doc,
                tag.as_ptr() as *const c_char,
                buf.as_mut_ptr() as *mut c_void,
                len,
            )
        };
        if written <= 2 {
            return None;
        }
        let s = utf16le_bytes_to_string(&buf[..(written as usize).min(buf.len())]);
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }

    fn collect_outlines(
        api: &PdfiumApi,
        doc: FpdfDocument,
        parent: FpdfBookmark,
        depth: usize,
        visited: &mut HashSet<usize>,
        count: &mut usize,
    ) -> Vec<PdfOutlineItem> {
        if depth >= MAX_OUTLINE_DEPTH || *count >= MAX_OUTLINE_ITEMS {
            return Vec::new();
        }
        let mut items = Vec::new();
        let mut current = unsafe { (api.FPDFBookmark_GetFirstChild)(doc, parent) };
        while !current.is_null() && *count < MAX_OUTLINE_ITEMS {
            let ptr_key = current as usize;
            if !visited.insert(ptr_key) {
                break;
            }
            *count += 1;

            let title_len = unsafe { (api.FPDFBookmark_GetTitle)(current, ptr::null_mut(), 0) };
            let title = if title_len > 2 && title_len <= 8_192 {
                let mut buf = vec![0u8; title_len as usize];
                unsafe {
                    (api.FPDFBookmark_GetTitle)(
                        current,
                        buf.as_mut_ptr() as *mut c_void,
                        title_len,
                    );
                }
                utf16le_bytes_to_string(&buf)
            } else {
                String::new()
            };

            let mut dest = unsafe { (api.FPDFBookmark_GetDest)(doc, current) };
            if dest.is_null() {
                let action = unsafe { (api.FPDFBookmark_GetAction)(current) };
                if !action.is_null() {
                    let act_type = unsafe { (api.FPDFAction_GetType)(action) };
                    if act_type == PDFACTION_GOTO {
                        dest = unsafe { (api.FPDFAction_GetDest)(doc, action) };
                    }
                }
            }
            let page_number = if !dest.is_null() {
                let idx = unsafe { (api.FPDFDest_GetDestPageIndex)(doc, dest) };
                if idx >= 0 {
                    Some((idx as usize) + 1)
                } else {
                    None
                }
            } else {
                None
            };

            let children = collect_outlines(api, doc, current, depth + 1, visited, count);
            if !title.is_empty() || !children.is_empty() {
                items.push(PdfOutlineItem {
                    title: if title.is_empty() {
                        "Untitled".to_string()
                    } else {
                        title
                    },
                    page_number,
                    children,
                });
            }

            current = unsafe { (api.FPDFBookmark_GetNextSibling)(doc, current) };
        }
        items
    }

    fn pdf_rect_to_normalized(
        api: &PdfiumApi,
        page: FpdfPage,
        left: f64,
        top: f64,
        right: f64,
        bottom: f64,
    ) -> Option<PdfNormalizedRect> {
        const SCALE: c_int = 10_000;
        let mut x1 = 0;
        let mut y1 = 0;
        let mut x2 = 0;
        let mut y2 = 0;
        let mut x3 = 0;
        let mut y3 = 0;
        let mut x4 = 0;
        let mut y4 = 0;
        unsafe {
            let ok1 =
                (api.FPDF_PageToDevice)(page, 0, 0, SCALE, SCALE, 0, left, top, &mut x1, &mut y1);
            let ok2 = (api.FPDF_PageToDevice)(
                page, 0, 0, SCALE, SCALE, 0, right, bottom, &mut x2, &mut y2,
            );
            let ok3 = (api.FPDF_PageToDevice)(
                page, 0, 0, SCALE, SCALE, 0, left, bottom, &mut x3, &mut y3,
            );
            let ok4 =
                (api.FPDF_PageToDevice)(page, 0, 0, SCALE, SCALE, 0, right, top, &mut x4, &mut y4);
            if ok1 == 0 || ok2 == 0 || ok3 == 0 || ok4 == 0 {
                return None;
            }
        }
        let min_x = x1.min(x2).min(x3).min(x4).clamp(0, SCALE) as f32 / SCALE as f32;
        let max_x = x1.max(x2).max(x3).max(x4).clamp(0, SCALE) as f32 / SCALE as f32;
        let min_y = y1.min(y2).min(y3).min(y4).clamp(0, SCALE) as f32 / SCALE as f32;
        let max_y = y1.max(y2).max(y3).max(y4).clamp(0, SCALE) as f32 / SCALE as f32;
        let w = (max_x - min_x).max(0.0);
        let h = (max_y - min_y).max(0.0);
        if w < 0.0005 || h < 0.0005 {
            return None;
        }
        Some(PdfNormalizedRect {
            left: min_x,
            top: min_y,
            width: w,
            height: h,
        })
    }

    pub fn with_pdfium<T>(
        resource_dir: Option<&Path>,
        f: impl FnOnce(&PdfiumApi) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let cell = PDFIUM_RUNTIME.get_or_init(|| Mutex::new(None));
        let mut guard = cell.lock().map_err(|_| {
            AppError::new("PDF_ENGINE_LOAD_FAILED", "PDFium runtime mutex poisoned.")
        })?;
        if guard.is_none() {
            let dll_path = resolve_pdfium_dll_path(resource_dir)?;
            *guard = Some(PdfiumApi::load(&dll_path)?);
        }
        let api = guard.as_ref().expect("PDFium initialized");
        f(api)
    }

    pub fn inspect_with_pdfium(
        resource_dir: Option<&Path>,
        path: &Path,
    ) -> Result<PdfiumInspectResult, AppError> {
        with_pdfium(resource_dir, |api| {
            let loaded = open_pdf_doc(api, path)?;
            let page_count = unsafe { (api.FPDF_GetPageCount)(loaded.doc) }.max(0) as usize;
            let mut pages = Vec::with_capacity(page_count);
            let mut warnings = Vec::new();
            let mut oversized_count = 0usize;

            for idx in 0..page_count {
                let mut sz = FsSizeF {
                    width: 0.0,
                    height: 0.0,
                };
                let ok =
                    unsafe { (api.FPDF_GetPageSizeByIndexF)(loaded.doc, idx as c_int, &mut sz) };
                let (w, h) = if ok != 0
                    && sz.width.is_finite()
                    && sz.height.is_finite()
                    && sz.width > 0.0
                    && sz.height > 0.0
                {
                    (sz.width, sz.height)
                } else {
                    (595.0, 842.0)
                };
                let is_oversized = w > OVERSIZED_PAGE_PT || h > OVERSIZED_PAGE_PT;
                if is_oversized {
                    oversized_count += 1;
                }
                // Only load page rotation metadata on reasonable page counts (fast for <= 500 pages; for huge docs sample/lazy)
                let rotation = if page_count <= 500 {
                    let page = unsafe { (api.FPDF_LoadPage)(loaded.doc, idx as c_int) };
                    if !page.is_null() {
                        let rot_code = unsafe { (api.FPDFPage_GetRotation)(page) };
                        unsafe { (api.FPDF_ClosePage)(page) };
                        match rot_code {
                            1 => 90,
                            2 => 180,
                            3 => 270,
                            _ => 0,
                        }
                    } else {
                        0
                    }
                } else {
                    0
                };
                pages.push(PdfPageGeometry {
                    page_number: idx + 1,
                    width_pt: w,
                    height_pt: h,
                    rotation,
                    is_oversized,
                });
            }

            if oversized_count > 0 {
                warnings.push(format!(
                    "{oversized_count} page(s) exceed standard PDF dimensions (> 14,400 pt) and will be safely capped during preview/image rendering."
                ));
            }

            // Sample up to 12 pages across the document to detect selectable text layer vs scanned PDF
            let mut sample_indices: Vec<usize> = Vec::new();
            if page_count > 0 {
                for i in 0..page_count.min(8) {
                    sample_indices.push(i);
                }
                if page_count > 8 {
                    sample_indices.push(page_count / 2);
                    sample_indices.push(page_count - 1);
                }
            }
            let mut has_text_layer = false;
            let mut sampled_text_pages = 0usize;
            for &idx in &sample_indices {
                let page = unsafe { (api.FPDF_LoadPage)(loaded.doc, idx as c_int) };
                if page.is_null() {
                    continue;
                }
                sampled_text_pages += 1;
                let text_page = unsafe { (api.FPDFText_LoadPage)(page) };
                if !text_page.is_null() {
                    let count = unsafe { (api.FPDFText_CountChars)(text_page) };
                    if count > 0 {
                        let fetch = (count as usize).min(256);
                        let mut buf = vec![0u16; fetch + 1];
                        let got = unsafe {
                            (api.FPDFText_GetText)(text_page, 0, fetch as c_int, buf.as_mut_ptr())
                        };
                        if got > 1 {
                            let s =
                                String::from_utf16_lossy(&buf[..(got as usize).saturating_sub(1)]);
                            if s.chars().any(|c| !c.is_whitespace() && !c.is_control()) {
                                has_text_layer = true;
                            }
                        }
                    }
                    unsafe { (api.FPDFText_ClosePage)(text_page) };
                }
                unsafe { (api.FPDF_ClosePage)(page) };
                if has_text_layer {
                    break;
                }
            }

            let is_likely_scanned = page_count > 0 && sampled_text_pages > 0 && !has_text_layer;
            let mut visited = HashSet::new();
            let mut outline_count = 0usize;
            let outlines = collect_outlines(
                api,
                loaded.doc,
                ptr::null_mut(),
                0,
                &mut visited,
                &mut outline_count,
            );

            let title = read_meta_text(api, loaded.doc, b"Title\0");
            let author = read_meta_text(api, loaded.doc, b"Author\0");
            let subject = read_meta_text(api, loaded.doc, b"Subject\0");
            let creator = read_meta_text(api, loaded.doc, b"Creator\0");
            let producer = read_meta_text(api, loaded.doc, b"Producer\0");

            Ok(PdfiumInspectResult {
                page_count,
                pages,
                has_text_layer,
                sampled_text_pages,
                is_likely_scanned,
                outlines,
                title,
                author,
                subject,
                creator,
                producer,
                warnings,
            })
        })
    }

    pub fn render_page_rgba_with_pdfium(
        resource_dir: Option<&Path>,
        path: &Path,
        page_number: usize,
        target_width_px: Option<u32>,
        target_dpi: Option<f32>,
        extra_rotation_cw: u16,
        max_side_cap: u32,
    ) -> Result<(PdfRenderMeta, Vec<u8>), AppError> {
        if page_number == 0 {
            return Err(AppError::invalid_param("Page number must be >= 1."));
        }
        with_pdfium(resource_dir, |api| {
            let loaded = open_pdf_doc(api, path)?;
            let page_count = unsafe { (api.FPDF_GetPageCount)(loaded.doc) }.max(0) as usize;
            if page_number > page_count {
                return Err(AppError::invalid_param(format!(
                    "Requested page {page_number} is out of bounds (document has {page_count} pages)."
                )));
            }
            let page_index = (page_number - 1) as c_int;
            let mut sz = FsSizeF {
                width: 595.0,
                height: 842.0,
            };
            unsafe {
                (api.FPDF_GetPageSizeByIndexF)(loaded.doc, page_index, &mut sz);
            }

            let page = unsafe { (api.FPDF_LoadPage)(loaded.doc, page_index) };
            if page.is_null() {
                return Err(AppError::new(
                    "PDF_PAGE_ERROR",
                    format!("Failed to load PDF page {page_number}."),
                ));
            }
            let inherent_rot = match unsafe { (api.FPDFPage_GetRotation)(page) } {
                1 => 90u16,
                2 => 180u16,
                3 => 270u16,
                _ => 0u16,
            };

            let norm_extra = (extra_rotation_cw % 360) / 90 * 90;
            let (width_px, height_px, capped) = compute_bounded_render_size(
                sz.width,
                sz.height,
                norm_extra,
                target_width_px,
                target_dpi,
                max_side_cap,
            );

            let stride = (width_px as usize) * 4;
            let mut bgra = vec![255u8; stride * (height_px as usize)];
            let bitmap = unsafe {
                (api.FPDFBitmap_CreateEx)(
                    width_px as c_int,
                    height_px as c_int,
                    FPDF_BITMAP_BGRA,
                    bgra.as_mut_ptr() as *mut c_void,
                    stride as c_int,
                )
            };
            if bitmap.is_null() {
                unsafe { (api.FPDF_ClosePage)(page) };
                return Err(AppError::new(
                    "PDF_RENDER_FAILED",
                    format!("Unable to allocate render bitmap for page {page_number}."),
                ));
            }

            let pdfium_rotate = match norm_extra {
                90 => 1,
                180 => 2,
                270 => 3,
                _ => 0,
            };
            unsafe {
                (api.FPDFBitmap_FillRect)(
                    bitmap,
                    0,
                    0,
                    width_px as c_int,
                    height_px as c_int,
                    0xFFFF_FFFF,
                );
                (api.FPDF_RenderPageBitmap)(
                    bitmap,
                    page,
                    0,
                    0,
                    width_px as c_int,
                    height_px as c_int,
                    pdfium_rotate,
                    FPDF_ANNOT,
                );
            }

            // Compute exact affine device-to-page transform using the identical viewport/rotation
            // passed to `FPDF_RenderPageBitmap` before closing `page`.
            let mut ox = 0.0f64;
            let mut oy = 0.0f64;
            let mut xx = 0.0f64;
            let mut xy = 0.0f64;
            let mut yx = 0.0f64;
            let mut yy = 0.0f64;
            let d2p_ok = unsafe {
                let ok_o = (api.FPDF_DeviceToPage)(
                    page,
                    0,
                    0,
                    width_px as c_int,
                    height_px as c_int,
                    pdfium_rotate,
                    0,
                    0,
                    &mut ox,
                    &mut oy,
                );
                let ok_x = (api.FPDF_DeviceToPage)(
                    page,
                    0,
                    0,
                    width_px as c_int,
                    height_px as c_int,
                    pdfium_rotate,
                    width_px as c_int,
                    0,
                    &mut xx,
                    &mut xy,
                );
                let ok_y = (api.FPDF_DeviceToPage)(
                    page,
                    0,
                    0,
                    width_px as c_int,
                    height_px as c_int,
                    pdfium_rotate,
                    0,
                    height_px as c_int,
                    &mut yx,
                    &mut yy,
                );
                ok_o != 0 && ok_x != 0 && ok_y != 0
            };

            unsafe {
                (api.FPDFBitmap_Destroy)(bitmap);
                (api.FPDF_ClosePage)(page);
            }

            let device_to_page = if d2p_ok
                && ox.is_finite()
                && oy.is_finite()
                && xx.is_finite()
                && xy.is_finite()
                && yx.is_finite()
                && yy.is_finite()
            {
                Some(PdfDeviceToPageTransform::from_corners(
                    width_px,
                    height_px,
                    (ox, oy),
                    (xx, xy),
                    (yx, yy),
                ))
            } else {
                None
            };

            // Convert BGRA -> RGBA in place (force opaque alpha on white paper backdrop)
            for px in bgra.as_chunks_mut::<4>().0 {
                px.swap(0, 2);
                px[3] = 255;
            }

            let meta = PdfRenderMeta {
                page_number,
                width_px,
                height_px,
                page_width_pt: sz.width,
                page_height_pt: sz.height,
                rotation: (inherent_rot + norm_extra) % 360,
                capped,
                device_to_page,
            };
            Ok((meta, bgra))
        })
    }

    pub fn render_page_png_with_pdfium(
        resource_dir: Option<&Path>,
        path: &Path,
        page_number: usize,
        target_width_px: Option<u32>,
        target_dpi: Option<f32>,
        extra_rotation_cw: u16,
        max_side_cap: u32,
    ) -> Result<(PdfRenderMeta, Vec<u8>), AppError> {
        let (meta, rgba) = render_page_rgba_with_pdfium(
            resource_dir,
            path,
            page_number,
            target_width_px,
            target_dpi,
            extra_rotation_cw,
            max_side_cap,
        )?;
        let img =
            image::RgbaImage::from_raw(meta.width_px, meta.height_px, rgba).ok_or_else(|| {
                AppError::new(
                    "PDF_RENDER_FAILED",
                    "Rendered RGBA buffer dimensions mismatch.",
                )
            })?;
        let png = encode_rgba_to_png_fast(&img)?;
        Ok((meta, png))
    }

    pub fn extract_page_text_with_pdfium(
        resource_dir: Option<&Path>,
        path: &Path,
        page_number: usize,
    ) -> Result<PdfPageTextPayload, AppError> {
        if page_number == 0 {
            return Err(AppError::invalid_param("Page number must be >= 1."));
        }
        with_pdfium(resource_dir, |api| {
            let loaded = open_pdf_doc(api, path)?;
            let page_count = unsafe { (api.FPDF_GetPageCount)(loaded.doc) }.max(0) as usize;
            if page_number > page_count {
                return Err(AppError::invalid_param(format!(
                    "Requested page {page_number} is out of bounds (document has {page_count} pages)."
                )));
            }
            let page = unsafe { (api.FPDF_LoadPage)(loaded.doc, (page_number - 1) as c_int) };
            if page.is_null() {
                return Err(AppError::new(
                    "PDF_PAGE_ERROR",
                    format!("Failed to load PDF page {page_number}."),
                ));
            }

            let mut spans = Vec::new();
            let mut full_text = String::new();
            let mut char_count = 0usize;

            let text_page = unsafe { (api.FPDFText_LoadPage)(page) };
            if !text_page.is_null() {
                let raw_count = unsafe { (api.FPDFText_CountChars)(text_page) };
                if raw_count > 0 {
                    char_count = raw_count as usize;
                    let capped_chars = char_count.min(200_000);
                    let mut full_buf = vec![0u16; capped_chars + 1];
                    let got = unsafe {
                        (api.FPDFText_GetText)(
                            text_page,
                            0,
                            capped_chars as c_int,
                            full_buf.as_mut_ptr(),
                        )
                    };
                    if got > 1 {
                        full_text =
                            String::from_utf16_lossy(&full_buf[..(got as usize).saturating_sub(1)]);
                    }

                    let rect_count = unsafe { (api.FPDFText_CountRects)(text_page, 0, raw_count) };
                    if rect_count > 0 {
                        let limit = (rect_count as usize).min(MAX_TEXT_RECTS_PER_PAGE);
                        for idx in 0..limit {
                            let mut left = 0.0;
                            let mut top = 0.0;
                            let mut right = 0.0;
                            let mut bottom = 0.0;
                            let ok = unsafe {
                                (api.FPDFText_GetRect)(
                                    text_page,
                                    idx as c_int,
                                    &mut left,
                                    &mut top,
                                    &mut right,
                                    &mut bottom,
                                )
                            };
                            if ok == 0 {
                                continue;
                            }
                            let need = unsafe {
                                (api.FPDFText_GetBoundedText)(
                                    text_page,
                                    left,
                                    top,
                                    right,
                                    bottom,
                                    ptr::null_mut(),
                                    0,
                                )
                            };
                            if need <= 0 || need > 8_192 {
                                continue;
                            }
                            let mut text_buf = vec![0u16; (need as usize) + 1];
                            let got = unsafe {
                                (api.FPDFText_GetBoundedText)(
                                    text_page,
                                    left,
                                    top,
                                    right,
                                    bottom,
                                    text_buf.as_mut_ptr(),
                                    (need as usize + 1) as c_int,
                                )
                            };
                            if got <= 0 {
                                continue;
                            }
                            let slice_len = (got as usize).min(text_buf.len());
                            let mut trimmed = &text_buf[..slice_len];
                            while trimmed.last() == Some(&0) {
                                trimmed = &trimmed[..trimmed.len() - 1];
                            }
                            let span_text = String::from_utf16_lossy(trimmed);
                            if span_text.trim().is_empty() {
                                continue;
                            }
                            if let Some(norm) =
                                pdf_rect_to_normalized(api, page, left, top, right, bottom)
                            {
                                spans.push(PdfTextSpan {
                                    text: span_text,
                                    rect: norm,
                                });
                            }
                        }
                    }
                }
                unsafe { (api.FPDFText_ClosePage)(text_page) };
            }

            // Enumerate links on page
            let mut links = Vec::new();
            let mut start_pos: c_int = 0;
            let mut link_handle: FpdfLink = ptr::null_mut();
            while links.len() < MAX_LINKS_PER_PAGE
                && unsafe { (api.FPDFLink_Enumerate)(page, &mut start_pos, &mut link_handle) } != 0
            {
                if link_handle.is_null() {
                    continue;
                }
                let mut rect = FsRectF {
                    left: 0.0,
                    top: 0.0,
                    right: 0.0,
                    bottom: 0.0,
                };
                if unsafe { (api.FPDFLink_GetAnnotRect)(link_handle, &mut rect) } == 0 {
                    continue;
                }
                let Some(norm_rect) = pdf_rect_to_normalized(
                    api,
                    page,
                    rect.left as f64,
                    rect.top as f64,
                    rect.right as f64,
                    rect.bottom as f64,
                ) else {
                    continue;
                };

                let mut dest = unsafe { (api.FPDFLink_GetDest)(loaded.doc, link_handle) };
                let action = unsafe { (api.FPDFLink_GetAction)(link_handle) };
                let mut uri_out: Option<String> = None;
                if dest.is_null() && !action.is_null() {
                    let act_type = unsafe { (api.FPDFAction_GetType)(action) };
                    if act_type == PDFACTION_GOTO {
                        dest = unsafe { (api.FPDFAction_GetDest)(loaded.doc, action) };
                    } else if act_type == PDFACTION_URI {
                        let uri_len = unsafe {
                            (api.FPDFAction_GetURIPath)(loaded.doc, action, ptr::null_mut(), 0)
                        };
                        if uri_len > 1 && uri_len <= 4_096 {
                            let mut buf = vec![0u8; uri_len as usize];
                            unsafe {
                                (api.FPDFAction_GetURIPath)(
                                    loaded.doc,
                                    action,
                                    buf.as_mut_ptr() as *mut c_void,
                                    uri_len,
                                );
                            }
                            while buf.last() == Some(&0) {
                                buf.pop();
                            }
                            let u = String::from_utf8_lossy(&buf).trim().to_string();
                            if u.starts_with("http://") || u.starts_with("https://") {
                                uri_out = Some(u);
                            }
                        }
                    }
                }

                if !dest.is_null() {
                    let idx = unsafe { (api.FPDFDest_GetDestPageIndex)(loaded.doc, dest) };
                    if idx >= 0 {
                        links.push(PdfLinkItem {
                            rect: norm_rect,
                            kind: "internal".to_string(),
                            target_page: Some((idx as usize) + 1),
                            uri: None,
                        });
                    }
                } else if let Some(uri) = uri_out {
                    links.push(PdfLinkItem {
                        rect: norm_rect,
                        kind: "external".to_string(),
                        target_page: None,
                        uri: Some(uri),
                    });
                }
            }

            unsafe { (api.FPDF_ClosePage)(page) };

            Ok(PdfPageTextPayload {
                page_number,
                full_text,
                char_count,
                spans,
                links,
            })
        })
    }

    pub fn search_document_with_pdfium(
        resource_dir: Option<&Path>,
        path: &Path,
        query: &str,
        case_sensitive: bool,
    ) -> Result<PdfSearchResult, AppError> {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return Ok(PdfSearchResult {
                query: String::new(),
                total_matches: 0,
                truncated: false,
                matches: Vec::new(),
            });
        }
        let query_utf16: Vec<u16> = trimmed.encode_utf16().chain(std::iter::once(0)).collect();
        let flags: c_ulong = if case_sensitive { 0x0000_0001 } else { 0 };

        with_pdfium(resource_dir, |api| {
            let loaded = open_pdf_doc(api, path)?;
            let page_count = unsafe { (api.FPDF_GetPageCount)(loaded.doc) }.max(0) as usize;
            let mut matches = Vec::new();
            let mut truncated = false;

            'pages: for idx in 0..page_count {
                let page = unsafe { (api.FPDF_LoadPage)(loaded.doc, idx as c_int) };
                if page.is_null() {
                    continue;
                }
                let text_page = unsafe { (api.FPDFText_LoadPage)(page) };
                if !text_page.is_null() {
                    let total_chars = unsafe { (api.FPDFText_CountChars)(text_page) };
                    if total_chars > 0 {
                        let sch = unsafe {
                            (api.FPDFText_FindStart)(text_page, query_utf16.as_ptr(), flags, 0)
                        };
                        if !sch.is_null() {
                            while unsafe { (api.FPDFText_FindNext)(sch) } != 0 {
                                if matches.len() >= MAX_SEARCH_MATCHES_TOTAL {
                                    truncated = true;
                                    unsafe { (api.FPDFText_FindClose)(sch) };
                                    unsafe { (api.FPDFText_ClosePage)(text_page) };
                                    unsafe { (api.FPDF_ClosePage)(page) };
                                    break 'pages;
                                }
                                let start_idx = unsafe { (api.FPDFText_GetSchResultIndex)(sch) };
                                let count = unsafe { (api.FPDFText_GetSchCount)(sch) };
                                if start_idx < 0 || count <= 0 {
                                    continue;
                                }
                                let mut rects = Vec::new();
                                let rc = unsafe {
                                    (api.FPDFText_CountRects)(text_page, start_idx, count)
                                };
                                for ri in 0..rc.clamp(0, 32) {
                                    let mut left = 0.0;
                                    let mut top = 0.0;
                                    let mut right = 0.0;
                                    let mut bottom = 0.0;
                                    if unsafe {
                                        (api.FPDFText_GetRect)(
                                            text_page,
                                            ri,
                                            &mut left,
                                            &mut top,
                                            &mut right,
                                            &mut bottom,
                                        )
                                    } != 0
                                    {
                                        if let Some(norm) = pdf_rect_to_normalized(
                                            api, page, left, top, right, bottom,
                                        ) {
                                            rects.push(norm);
                                        }
                                    }
                                }

                                // Build short snippet around match
                                let snip_start = (start_idx - 24).max(0);
                                let snip_end = (start_idx + count + 24).min(total_chars);
                                let snip_len = (snip_end - snip_start).max(1) as usize;
                                let mut snip_buf = vec![0u16; snip_len + 1];
                                let got = unsafe {
                                    (api.FPDFText_GetText)(
                                        text_page,
                                        snip_start,
                                        snip_len as c_int,
                                        snip_buf.as_mut_ptr(),
                                    )
                                };
                                let snippet = if got > 1 {
                                    String::from_utf16_lossy(
                                        &snip_buf[..(got as usize).saturating_sub(1)],
                                    )
                                    .split_whitespace()
                                    .collect::<Vec<_>>()
                                    .join(" ")
                                } else {
                                    trimmed.to_string()
                                };

                                matches.push(PdfSearchMatch {
                                    page_number: idx + 1,
                                    match_index: matches.len(),
                                    snippet,
                                    rects,
                                });
                            }
                            unsafe { (api.FPDFText_FindClose)(sch) };
                        }
                    }
                    unsafe { (api.FPDFText_ClosePage)(text_page) };
                }
                unsafe { (api.FPDF_ClosePage)(page) };
            }

            Ok(PdfSearchResult {
                query: trimmed.to_string(),
                total_matches: matches.len(),
                truncated,
                matches,
            })
        })
    }

    /// Evaluates every page in a single PDFium session to determine per-page selectable Unicode text presence
    /// so `P04` can accurately skip pages that already contain searchable text.
    pub fn inspect_pages_text_status_with_pdfium(
        resource_dir: Option<&Path>,
        path: &Path,
    ) -> Result<Vec<PdfPageTextSummary>, AppError> {
        with_pdfium(resource_dir, |api| {
            let loaded = open_pdf_doc(api, path)?;
            let page_count = unsafe { (api.FPDF_GetPageCount)(loaded.doc) }.max(0) as usize;
            let mut out = Vec::with_capacity(page_count);

            for idx in 0..page_count {
                let mut sz = FsSizeF {
                    width: 595.0,
                    height: 842.0,
                };
                let ok =
                    unsafe { (api.FPDF_GetPageSizeByIndexF)(loaded.doc, idx as c_int, &mut sz) };
                let (w, h) = if ok != 0
                    && sz.width.is_finite()
                    && sz.height.is_finite()
                    && sz.width > 0.0
                    && sz.height > 0.0
                {
                    (sz.width, sz.height)
                } else {
                    (595.0, 842.0)
                };

                let page = unsafe { (api.FPDF_LoadPage)(loaded.doc, idx as c_int) };
                let mut rotation = 0u16;
                let mut meaningful_char_count = 0usize;

                if !page.is_null() {
                    rotation = match unsafe { (api.FPDFPage_GetRotation)(page) } {
                        1 => 90,
                        2 => 180,
                        3 => 270,
                        _ => 0,
                    };
                    let text_page = unsafe { (api.FPDFText_LoadPage)(page) };
                    if !text_page.is_null() {
                        let raw_count = unsafe { (api.FPDFText_CountChars)(text_page) };
                        if raw_count > 0 {
                            let fetch = (raw_count as usize).min(200_000);
                            let mut buf = vec![0u16; fetch + 1];
                            let got = unsafe {
                                (api.FPDFText_GetText)(
                                    text_page,
                                    0,
                                    fetch as c_int,
                                    buf.as_mut_ptr(),
                                )
                            };
                            if got > 1 {
                                let s = String::from_utf16_lossy(
                                    &buf[..(got as usize).saturating_sub(1)],
                                );
                                meaningful_char_count = s
                                    .chars()
                                    .filter(|c| !c.is_whitespace() && !c.is_control())
                                    .count();
                            }
                        }
                        unsafe { (api.FPDFText_ClosePage)(text_page) };
                    }
                    unsafe { (api.FPDF_ClosePage)(page) };
                }

                out.push(PdfPageTextSummary {
                    page_number: idx + 1,
                    width_pt: w,
                    height_pt: h,
                    rotation,
                    meaningful_char_count,
                    has_text_layer: meaningful_char_count > 0,
                });
            }

            Ok(out)
        })
    }

    /// Extracts every individual character on `page_number` in PDFium reading/copy order along
    /// with its exact normalized `[0, 1]` selection rectangle (`FPDFText_CountRects(i, 1)` +
    /// `FPDFText_GetRect`), used to verify per-character selection alignment on rotated text.
    pub fn extract_page_char_rects_with_pdfium(
        resource_dir: Option<&Path>,
        path: &Path,
        page_number: usize,
    ) -> Result<Vec<(char, PdfNormalizedRect)>, AppError> {
        if page_number == 0 {
            return Err(AppError::invalid_param("Page number must be >= 1."));
        }
        with_pdfium(resource_dir, |api| {
            let loaded = open_pdf_doc(api, path)?;
            let page_count = unsafe { (api.FPDF_GetPageCount)(loaded.doc) }.max(0) as usize;
            if page_number > page_count {
                return Err(AppError::invalid_param(format!(
                    "Requested page {page_number} is out of bounds (document has {page_count} pages)."
                )));
            }
            let page = unsafe { (api.FPDF_LoadPage)(loaded.doc, (page_number - 1) as c_int) };
            if page.is_null() {
                return Err(AppError::new(
                    "PDF_PAGE_ERROR",
                    format!("Failed to load PDF page {page_number}."),
                ));
            }

            let mut out = Vec::new();
            let text_page = unsafe { (api.FPDFText_LoadPage)(page) };
            if !text_page.is_null() {
                let raw_count = unsafe { (api.FPDFText_CountChars)(text_page) };
                if raw_count > 0 {
                    let limit = (raw_count as usize).min(20_000);
                    for i in 0..limit {
                        let mut ch_buf = [0u16; 3];
                        let got = unsafe {
                            (api.FPDFText_GetText)(text_page, i as c_int, 1, ch_buf.as_mut_ptr())
                        };
                        if got <= 1 {
                            continue;
                        }
                        let ch_str = String::from_utf16_lossy(&ch_buf[..(got as usize - 1)]);
                        let Some(ch) = ch_str.chars().next() else {
                            continue;
                        };
                        let rc = unsafe { (api.FPDFText_CountRects)(text_page, i as c_int, 1) };
                        if rc <= 0 {
                            continue;
                        }
                        let mut left = 0.0;
                        let mut top = 0.0;
                        let mut right = 0.0;
                        let mut bottom = 0.0;
                        let ok = unsafe {
                            (api.FPDFText_GetRect)(
                                text_page,
                                0,
                                &mut left,
                                &mut top,
                                &mut right,
                                &mut bottom,
                            )
                        };
                        if ok != 0 {
                            if let Some(norm) =
                                pdf_rect_to_normalized(api, page, left, top, right, bottom)
                            {
                                out.push((ch, norm));
                            }
                        }
                    }
                }
                unsafe { (api.FPDFText_ClosePage)(text_page) };
            }
            unsafe { (api.FPDF_ClosePage)(page) };
            Ok(out)
        })
    }

    /// Reuses PDFium text extraction (`FPDFText_LoadPage` + `FPDFText_GetText`) in a single
    /// document open to extract ordered, normalized text strictly within `max_chars` / `max_bytes`
    /// for offline `T06` reading without duplicating per-page text payloads.
    pub fn extract_pages_text_for_tts_with_pdfium(
        resource_dir: Option<&Path>,
        path: &Path,
        requested_pages: &[usize],
        max_chars: usize,
        max_bytes: usize,
    ) -> Result<PdfExtractPagesTextResult, AppError> {
        extract_pages_text_for_tts_with_pdfium_limits(
            resource_dir,
            path,
            requested_pages,
            max_chars,
            max_bytes,
            MAX_PDFIUM_PAGE_RAW_CHARS,
        )
    }

    pub fn extract_pages_text_for_tts_with_pdfium_limits(
        resource_dir: Option<&Path>,
        path: &Path,
        requested_pages: &[usize],
        max_chars: usize,
        max_bytes: usize,
        page_raw_char_cap: usize,
    ) -> Result<PdfExtractPagesTextResult, AppError> {
        if requested_pages.is_empty() {
            return Err(AppError::invalid_param(
                "Please select at least one PDF page to read aloud.",
            ));
        }

        let mut deduped: Vec<usize> = Vec::with_capacity(requested_pages.len());
        let mut seen = HashSet::new();
        for &p in requested_pages {
            if p == 0 {
                return Err(AppError::invalid_param("Page number must be >= 1."));
            }
            if seen.insert(p) {
                deduped.push(p);
            }
        }

        let effective_raw_cap = page_raw_char_cap.max(1);

        with_pdfium(resource_dir, |api| {
            let loaded = open_pdf_doc(api, path)?;
            let total_pages = unsafe { (api.FPDF_GetPageCount)(loaded.doc) }.max(0) as usize;
            if total_pages == 0 {
                return Err(AppError::new(
                    "PDF_CORRUPT_OR_INVALID",
                    "PDF document contains no pages.",
                ));
            }
            for &p in &deduped {
                if p > total_pages {
                    return Err(AppError::invalid_param(format!(
                        "Requested page {p} is out of bounds (document has {total_pages} pages)."
                    )));
                }
            }

            let mut pages_out = Vec::with_capacity(deduped.len());
            let mut included_pages = Vec::new();
            let mut scanned_pages = Vec::new();
            let mut omitted_pages = Vec::new();
            let mut combined_text = String::new();
            let mut total_chars = 0usize;
            let mut truncated = false;

            for &page_number in &deduped {
                // Once the combined budget has already triggered truncation, omit remaining pages
                // cleanly without doing extra full-page text reads or mislabeling them as scanned.
                if truncated {
                    omitted_pages.push(page_number);
                    pages_out.push(PdfExtractedPageMeta {
                        page_number,
                        char_count: 0,
                        byte_count: 0,
                        has_text: false,
                        status: PdfExtractedPageStatus::Omitted,
                    });
                    continue;
                }

                let page = unsafe { (api.FPDF_LoadPage)(loaded.doc, (page_number - 1) as c_int) };
                if page.is_null() {
                    return Err(AppError::new(
                        "PDF_PAGE_ERROR",
                        format!("Failed to load PDF page {page_number}."),
                    ));
                }

                let mut raw_text = String::new();
                let mut hit_pdfium_page_cap = false;
                let text_page = unsafe { (api.FPDFText_LoadPage)(page) };
                if !text_page.is_null() {
                    let raw_count = unsafe { (api.FPDFText_CountChars)(text_page) };
                    if raw_count > 0 {
                        let raw_count_usize = raw_count as usize;
                        hit_pdfium_page_cap = raw_count_usize > effective_raw_cap;
                        let capped = raw_count_usize.min(effective_raw_cap);
                        let mut full_buf = vec![0u16; capped + 1];
                        let got = unsafe {
                            (api.FPDFText_GetText)(
                                text_page,
                                0,
                                capped as c_int,
                                full_buf.as_mut_ptr(),
                            )
                        };
                        if got > 1 {
                            let mut end = (got as usize).saturating_sub(1);
                            // Avoid splitting a UTF-16 surrogate pair when hitting the raw cap.
                            if hit_pdfium_page_cap
                                && end > 0
                                && (0xD800..=0xDBFF).contains(&full_buf[end - 1])
                            {
                                end -= 1;
                            }
                            raw_text = String::from_utf16_lossy(&full_buf[..end]);
                        }
                    }
                    unsafe { (api.FPDFText_ClosePage)(text_page) };
                }
                unsafe { (api.FPDF_ClosePage)(page) };

                let normalized = normalize_pdf_text_for_speech(&raw_text);
                let has_text = normalized.chars().any(|c| !c.is_whitespace());

                if !has_text {
                    if hit_pdfium_page_cap {
                        truncated = true;
                        omitted_pages.push(page_number);
                        pages_out.push(PdfExtractedPageMeta {
                            page_number,
                            char_count: 0,
                            byte_count: 0,
                            has_text: false,
                            status: PdfExtractedPageStatus::Omitted,
                        });
                    } else {
                        scanned_pages.push(page_number);
                        pages_out.push(PdfExtractedPageMeta {
                            page_number,
                            char_count: 0,
                            byte_count: 0,
                            has_text: false,
                            status: PdfExtractedPageStatus::Scanned,
                        });
                    }
                    continue;
                }

                let outcome = append_bounded_tts_text(
                    &mut combined_text,
                    &mut total_chars,
                    &normalized,
                    max_chars,
                    max_bytes,
                );

                if outcome.added_chars == 0 {
                    truncated = true;
                    omitted_pages.push(page_number);
                    pages_out.push(PdfExtractedPageMeta {
                        page_number,
                        char_count: 0,
                        byte_count: 0,
                        has_text: true,
                        status: PdfExtractedPageStatus::Omitted,
                    });
                } else {
                    let page_truncated = hit_pdfium_page_cap || outcome.hit_budget;
                    if page_truncated {
                        truncated = true;
                    }
                    included_pages.push(page_number);
                    pages_out.push(PdfExtractedPageMeta {
                        page_number,
                        char_count: outcome.added_chars,
                        byte_count: outcome.added_bytes,
                        has_text: true,
                        status: if page_truncated {
                            PdfExtractedPageStatus::Truncated
                        } else {
                            PdfExtractedPageStatus::Included
                        },
                    });
                }
            }

            let file_name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "document.pdf".to_string());
            let total_bytes = combined_text.len();
            let extracted_page_count = included_pages.len();

            Ok(PdfExtractPagesTextResult {
                path: path.to_string_lossy().into_owned(),
                file_name,
                total_pages,
                requested_pages: deduped,
                included_pages,
                scanned_pages,
                omitted_pages,
                pages: pages_out,
                combined_text,
                extracted_page_count,
                total_chars,
                total_bytes,
                truncated,
            })
        })
    }
}

#[cfg(windows)]
pub use win_impl::{
    extract_page_char_rects_with_pdfium, extract_page_text_with_pdfium,
    extract_pages_text_for_tts_with_pdfium, extract_pages_text_for_tts_with_pdfium_limits,
    inspect_pages_text_status_with_pdfium, inspect_with_pdfium, render_page_png_with_pdfium,
    render_page_rgba_with_pdfium, search_document_with_pdfium,
};

#[cfg(not(windows))]
pub fn extract_pages_text_for_tts_with_pdfium_limits(
    _resource_dir: Option<&Path>,
    _path: &Path,
    _requested_pages: &[usize],
    _max_chars: usize,
    _max_bytes: usize,
    _page_raw_char_cap: usize,
) -> Result<PdfExtractPagesTextResult, AppError> {
    Err(AppError::new(
        "PDF_ENGINE_MISSING",
        "Bundled Windows PDFium engine is only available on Windows.",
    ))
}

#[cfg(not(windows))]
pub fn extract_pages_text_for_tts_with_pdfium(
    _resource_dir: Option<&Path>,
    _path: &Path,
    _requested_pages: &[usize],
    _max_chars: usize,
    _max_bytes: usize,
) -> Result<PdfExtractPagesTextResult, AppError> {
    Err(AppError::new(
        "PDF_ENGINE_MISSING",
        "Bundled Windows PDFium engine is only available on Windows.",
    ))
}

#[cfg(not(windows))]
pub fn extract_page_char_rects_with_pdfium(
    _resource_dir: Option<&Path>,
    _path: &Path,
    _page_number: usize,
) -> Result<Vec<(char, PdfNormalizedRect)>, AppError> {
    Err(AppError::new(
        "PDF_ENGINE_MISSING",
        "Bundled Windows PDFium engine is only available on Windows.",
    ))
}

#[cfg(not(windows))]
pub fn inspect_pages_text_status_with_pdfium(
    _resource_dir: Option<&Path>,
    _path: &Path,
) -> Result<Vec<PdfPageTextSummary>, AppError> {
    Err(AppError::new(
        "PDF_ENGINE_MISSING",
        "Bundled Windows PDFium engine is only available on Windows.",
    ))
}

#[cfg(not(windows))]
pub fn inspect_with_pdfium(
    _resource_dir: Option<&Path>,
    _path: &Path,
) -> Result<PdfiumInspectResult, AppError> {
    Err(AppError::new(
        "PDF_ENGINE_MISSING",
        "Bundled Windows PDFium engine is only available on Windows.",
    ))
}

#[cfg(not(windows))]
pub fn render_page_rgba_with_pdfium(
    _resource_dir: Option<&Path>,
    _path: &Path,
    _page_number: usize,
    _target_width_px: Option<u32>,
    _target_dpi: Option<f32>,
    _extra_rotation_cw: u16,
    _max_side_cap: u32,
) -> Result<(PdfRenderMeta, Vec<u8>), AppError> {
    Err(AppError::new(
        "PDF_ENGINE_MISSING",
        "Bundled Windows PDFium engine is only available on Windows.",
    ))
}

#[cfg(not(windows))]
pub fn render_page_png_with_pdfium(
    _resource_dir: Option<&Path>,
    _path: &Path,
    _page_number: usize,
    _target_width_px: Option<u32>,
    _target_dpi: Option<f32>,
    _extra_rotation_cw: u16,
    _max_side_cap: u32,
) -> Result<(PdfRenderMeta, Vec<u8>), AppError> {
    Err(AppError::new(
        "PDF_ENGINE_MISSING",
        "Bundled Windows PDFium engine is only available on Windows.",
    ))
}

#[cfg(not(windows))]
pub fn extract_page_text_with_pdfium(
    _resource_dir: Option<&Path>,
    _path: &Path,
    _page_number: usize,
) -> Result<PdfPageTextPayload, AppError> {
    Err(AppError::new(
        "PDF_ENGINE_MISSING",
        "Bundled Windows PDFium engine is only available on Windows.",
    ))
}

#[cfg(not(windows))]
pub fn search_document_with_pdfium(
    _resource_dir: Option<&Path>,
    _path: &Path,
    _query: &str,
    _case_sensitive: bool,
) -> Result<PdfSearchResult, AppError> {
    Err(AppError::new(
        "PDF_ENGINE_MISSING",
        "Bundled Windows PDFium engine is only available on Windows.",
    ))
}
