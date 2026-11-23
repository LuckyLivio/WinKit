//! Shared PDF core state, bounded render cache, inspection, page range parsing, and atomic output.
//!
//! Design guarantees:
//! - Bounded LRU render cache (`MAX_CACHE_ENTRIES = 64`, `MAX_CACHE_BYTES = 64 MiB`) prevents
//!   unbounded RAM growth when scrolling 300+ page documents.
//! - Cache keys incorporate `(canonical_path, modified_unix_ns, file_size, page, width, rotation)`
//!   so external modifications never serve stale frames.
//! - `AtomicPdfOutput` writes strictly to a sibling `.tmp` file, rejects source overwrites,
//!   commits atomically, and deletes `.tmp` on Drop if uncommitted or cancelled.
//! - `cleanup_on_exit()` terminates the isolated PDFium worker Job Object and clears cache immediately.

use crate::error::AppError;
use crate::fs_guard::{
    paths_refer_to_same_location, validate_existing_input_file, validate_user_path,
};
use crate::pdf_pdfium::{
    PdfOutlineItem, PdfPageGeometry, PdfPageTextPayload, PdfRenderMeta, PdfSearchResult,
    MAX_PDF_FILE_BYTES, MAX_PDF_PAGES, MAX_PREVIEW_SIDE_PX,
};
use crate::pdf_worker::{PdfWorkerClient, PdfWorkerRequest, PdfWorkerResponse};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use lopdf::{Document, Object};
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub const PDF_TASK_PROGRESS_EVENT: &str = "winkit://pdf-progress";

const MAX_CACHE_ENTRIES: usize = 64;
const MAX_CACHE_BYTES: usize = 64 * 1024 * 1024; // 64 MiB total PNG render cache ceiling

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfTaskProgressPayload {
    pub task_id: String,
    pub tool_id: String,
    pub current: usize,
    pub total: usize,
    pub percent: f64,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfDocumentInspection {
    pub path: String,
    pub file_name: String,
    pub byte_length: u64,
    pub page_count: usize,
    pub pages: Vec<PdfPageGeometry>,
    pub has_text_layer: bool,
    pub sampled_text_pages: usize,
    pub is_likely_scanned: bool,
    pub has_outlines: bool,
    pub outlines: Vec<PdfOutlineItem>,
    pub has_acroform: bool,
    pub has_signatures: bool,
    pub signature_count: usize,
    pub is_encrypted: bool,
    pub title: Option<String>,
    pub author: Option<String>,
    pub subject: Option<String>,
    pub creator: Option<String>,
    pub producer: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedPdfPagePayload {
    pub meta: PdfRenderMeta,
    pub data_url: String,
    pub from_cache: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfRenderRequest {
    pub path: String,
    pub page_number: usize,
    pub target_width_px: Option<u32>,
    pub extra_rotation_cw: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct RenderCacheKey {
    path: String,
    modified_ns: u128,
    byte_length: u64,
    page_number: usize,
    target_width_px: u32,
    extra_rotation_cw: u16,
}

struct RenderCacheEntry {
    key: RenderCacheKey,
    meta: PdfRenderMeta,
    png_bytes: Vec<u8>,
}

#[derive(Default)]
struct BoundedRenderCache {
    entries: VecDeque<RenderCacheEntry>,
    total_bytes: usize,
}

impl BoundedRenderCache {
    fn get(&mut self, key: &RenderCacheKey) -> Option<(PdfRenderMeta, Vec<u8>)> {
        let pos = self.entries.iter().position(|e| &e.key == key)?;
        let entry = self.entries.remove(pos)?;
        let result = (entry.meta.clone(), entry.png_bytes.clone());
        self.entries.push_back(entry);
        Some(result)
    }

    fn insert(&mut self, key: RenderCacheKey, meta: PdfRenderMeta, png_bytes: Vec<u8>) {
        if let Some(pos) = self.entries.iter().position(|e| e.key == key) {
            if let Some(old) = self.entries.remove(pos) {
                self.total_bytes = self.total_bytes.saturating_sub(old.png_bytes.len());
            }
        }
        let item_len = png_bytes.len();
        if item_len > MAX_CACHE_BYTES / 2 {
            // Single oversized render bypasses cache rather than flushing everything
            return;
        }
        while self.entries.len() >= MAX_CACHE_ENTRIES
            || self.total_bytes.saturating_add(item_len) > MAX_CACHE_BYTES
        {
            if let Some(evicted) = self.entries.pop_front() {
                self.total_bytes = self.total_bytes.saturating_sub(evicted.png_bytes.len());
            } else {
                break;
            }
        }
        self.total_bytes = self.total_bytes.saturating_add(item_len);
        self.entries.push_back(RenderCacheEntry {
            key,
            meta,
            png_bytes,
        });
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.total_bytes = 0;
    }

    #[cfg(test)]
    fn stats(&self) -> (usize, usize) {
        (self.entries.len(), self.total_bytes)
    }
}

#[derive(Clone, Default)]
pub struct PdfSessionManager {
    worker: Arc<PdfWorkerClient>,
    cache: Arc<Mutex<BoundedRenderCache>>,
}

impl PdfSessionManager {
    pub fn set_resource_dir(&self, dir: PathBuf) {
        self.worker.set_resource_dir(dir);
    }

    pub fn worker(&self) -> &PdfWorkerClient {
        &self.worker
    }

    pub fn clear_cache(&self) {
        if let Ok(mut guard) = self.cache.lock() {
            guard.clear();
        }
    }

    pub fn cleanup_on_exit(&self) {
        self.clear_cache();
        self.worker.shutdown_worker();
    }

    pub fn inspect_document(&self, path_raw: &str) -> Result<PdfDocumentInspection, AppError> {
        let (canonical, byte_length) = validate_existing_input_file(path_raw)?;
        if byte_length == 0 {
            return Err(AppError::new(
                "PDF_CORRUPT_OR_INVALID",
                "PDF file is empty (0 bytes).",
            ));
        }
        if byte_length > MAX_PDF_FILE_BYTES {
            return Err(AppError::size_limit(format!(
                "PDF file exceeds the {} MiB safety limit.",
                MAX_PDF_FILE_BYTES / (1024 * 1024)
            )));
        }

        let path_str = canonical.to_string_lossy().into_owned();
        let file_name = canonical
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "document.pdf".to_string());

        let (resp, _) = self.worker.send(PdfWorkerRequest::Inspect {
            path: path_str.clone(),
        })?;
        let pdfium_info = match resp {
            PdfWorkerResponse::Inspect(info) => info,
            _ => {
                return Err(AppError::new(
                    "PDF_WORKER_ERROR",
                    "Unexpected PDF worker response for inspection.",
                ))
            }
        };

        let struct_flags = inspect_structural_flags_lopdf(&canonical);
        let mut warnings = pdfium_info.warnings;
        if struct_flags.has_signatures {
            warnings.push(format!(
                "This PDF contains {} digital signature field(s). Preview is read-only; structural edits (merge/split/reorder/delete/extract) will invalidate original cryptographic signatures.",
                struct_flags.signature_count.max(1)
            ));
        }
        if struct_flags.has_acroform {
            warnings.push(
                "This PDF contains interactive AcroForm fields. Structural edits preserve page appearance, while interactive form trees may be simplified or omitted on edited copies."
                    .to_string(),
            );
        }

        Ok(PdfDocumentInspection {
            path: path_str,
            file_name,
            byte_length,
            page_count: pdfium_info.page_count,
            pages: pdfium_info.pages,
            has_text_layer: pdfium_info.has_text_layer,
            sampled_text_pages: pdfium_info.sampled_text_pages,
            is_likely_scanned: pdfium_info.is_likely_scanned,
            has_outlines: !pdfium_info.outlines.is_empty(),
            outlines: pdfium_info.outlines,
            has_acroform: struct_flags.has_acroform,
            has_signatures: struct_flags.has_signatures,
            signature_count: struct_flags.signature_count,
            is_encrypted: struct_flags.is_encrypted,
            title: pdfium_info.title,
            author: pdfium_info.author,
            subject: pdfium_info.subject,
            creator: pdfium_info.creator,
            producer: pdfium_info.producer,
            warnings,
        })
    }

    pub fn render_page(&self, req: &PdfRenderRequest) -> Result<RenderedPdfPagePayload, AppError> {
        let (canonical, byte_length) = validate_existing_input_file(&req.path)?;
        let modified_ns = fs::metadata(&canonical)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path_str = canonical.to_string_lossy().into_owned();
        let target_width_px = req
            .target_width_px
            .unwrap_or(960)
            .clamp(48, MAX_PREVIEW_SIDE_PX);
        let extra_rotation_cw = (req.extra_rotation_cw.unwrap_or(0) % 360) / 90 * 90;

        let cache_key = RenderCacheKey {
            path: path_str.clone(),
            modified_ns,
            byte_length,
            page_number: req.page_number,
            target_width_px,
            extra_rotation_cw,
        };

        if let Ok(mut guard) = self.cache.lock() {
            if let Some((meta, png_bytes)) = guard.get(&cache_key) {
                let data_url = format!(
                    "data:image/png;base64,{}",
                    BASE64_STANDARD.encode(&png_bytes)
                );
                return Ok(RenderedPdfPagePayload {
                    meta,
                    data_url,
                    from_cache: true,
                });
            }
        }

        let (resp, png_bytes) = self.worker.send(PdfWorkerRequest::RenderPng {
            path: path_str,
            page_number: req.page_number,
            target_width_px: Some(target_width_px),
            target_dpi: None,
            extra_rotation_cw,
            max_side_cap: MAX_PREVIEW_SIDE_PX,
        })?;
        let meta = match resp {
            PdfWorkerResponse::Render(m) => m,
            _ => {
                return Err(AppError::new(
                    "PDF_WORKER_ERROR",
                    "Unexpected PDF worker response for page rendering.",
                ))
            }
        };

        let data_url = format!(
            "data:image/png;base64,{}",
            BASE64_STANDARD.encode(&png_bytes)
        );
        if let Ok(mut guard) = self.cache.lock() {
            guard.insert(cache_key, meta.clone(), png_bytes);
        }

        Ok(RenderedPdfPagePayload {
            meta,
            data_url,
            from_cache: false,
        })
    }

    pub fn render_page_rgba_for_export(
        &self,
        path: &Path,
        page_number: usize,
        target_dpi: f32,
        extra_rotation_cw: u16,
        max_side_cap: u32,
    ) -> Result<(PdfRenderMeta, Vec<u8>), AppError> {
        let (resp, rgba) = self.worker.send(PdfWorkerRequest::RenderRgba {
            path: path.to_string_lossy().into_owned(),
            page_number,
            target_width_px: None,
            target_dpi: Some(target_dpi),
            extra_rotation_cw,
            max_side_cap,
        })?;
        let meta = match resp {
            PdfWorkerResponse::Render(m) => m,
            _ => {
                return Err(AppError::new(
                    "PDF_WORKER_ERROR",
                    "Unexpected PDF worker response for export rendering.",
                ))
            }
        };
        Ok((meta, rgba))
    }

    pub fn get_page_text(
        &self,
        path_raw: &str,
        page_number: usize,
    ) -> Result<PdfPageTextPayload, AppError> {
        let (canonical, _) = validate_existing_input_file(path_raw)?;
        let (resp, _) = self.worker.send(PdfWorkerRequest::ExtractText {
            path: canonical.to_string_lossy().into_owned(),
            page_number,
        })?;
        match resp {
            PdfWorkerResponse::ExtractText(text) => Ok(text),
            _ => Err(AppError::new(
                "PDF_WORKER_ERROR",
                "Unexpected PDF worker response for text extraction.",
            )),
        }
    }

    pub fn search_text(
        &self,
        path_raw: &str,
        query: &str,
        case_sensitive: bool,
    ) -> Result<PdfSearchResult, AppError> {
        let (canonical, _) = validate_existing_input_file(path_raw)?;
        let (resp, _) = self.worker.send(PdfWorkerRequest::Search {
            path: canonical.to_string_lossy().into_owned(),
            query: query.to_string(),
            case_sensitive,
        })?;
        match resp {
            PdfWorkerResponse::Search(res) => Ok(res),
            _ => Err(AppError::new(
                "PDF_WORKER_ERROR",
                "Unexpected PDF worker response for document search.",
            )),
        }
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct PdfStructuralFlags {
    pub is_encrypted: bool,
    pub has_acroform: bool,
    pub has_signatures: bool,
    pub signature_count: usize,
}

pub fn inspect_structural_flags_from_doc(doc: &Document) -> PdfStructuralFlags {
    let mut flags = PdfStructuralFlags::default();
    if doc.trailer.get(b"Encrypt").is_ok() {
        flags.is_encrypted = true;
    }

    if let Ok(catalog) = doc.catalog() {
        if catalog.get(b"AcroForm").is_ok() {
            flags.has_acroform = true;
            if let Ok(acro_obj) = catalog.get(b"AcroForm") {
                if let Ok(acro_dict) = resolve_dict(doc, acro_obj) {
                    if let Ok(sig_flags) = acro_dict.get(b"SigFlags").and_then(Object::as_i64) {
                        if (sig_flags & 1) != 0 {
                            flags.has_signatures = true;
                        }
                    }
                }
            }
        }
        if catalog.get(b"Perms").is_ok() {
            flags.has_signatures = true;
        }
    }

    let mut sig_objects = 0usize;
    for obj in doc.objects.values() {
        if let Object::Dictionary(dict) = obj {
            let is_sig_type = dict
                .get(b"Type")
                .and_then(Object::as_name)
                .map(|n| n == b"Sig")
                .unwrap_or(false);
            let is_sig_ft = dict
                .get(b"FT")
                .and_then(Object::as_name)
                .map(|n| n == b"Sig")
                .unwrap_or(false);
            if is_sig_type || is_sig_ft {
                sig_objects += 1;
            }
        }
    }
    if sig_objects > 0 {
        flags.has_signatures = true;
        flags.signature_count = sig_objects;
    }
    flags
}

fn resolve_dict<'a>(doc: &'a Document, obj: &'a Object) -> Result<&'a lopdf::Dictionary, ()> {
    match obj {
        Object::Dictionary(d) => Ok(d),
        Object::Reference(id) => doc
            .get_object(*id)
            .ok()
            .and_then(|o| o.as_dict().ok())
            .ok_or(()),
        _ => Err(()),
    }
}

pub fn inspect_structural_flags_lopdf(path: &Path) -> PdfStructuralFlags {
    match Document::load(path) {
        Ok(doc) => inspect_structural_flags_from_doc(&doc),
        Err(_) => PdfStructuralFlags::default(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedPageRange {
    pub pages: Vec<usize>,
    pub duplicate_pages: Vec<usize>,
    pub normalized_label: String,
}

/// Parse a 1-based page range specification like `"1-3, 5, 8-10"`.
/// Rejects empty specs, non-numeric tokens, reversed ranges (`5-2`), zero, and out-of-bounds pages.
/// Preserves order; reports duplicates explicitly so callers can warn or dedupe transparently.
pub fn parse_page_range_spec(spec: &str, total_pages: usize) -> Result<ParsedPageRange, AppError> {
    if total_pages == 0 || total_pages > MAX_PDF_PAGES {
        return Err(AppError::invalid_param(
            "Document has no valid pages for range selection.",
        ));
    }
    let trimmed = spec.trim();
    if trimmed.is_empty() {
        return Err(AppError::invalid_param(
            "Page range expression must not be empty.",
        ));
    }

    let normalized_commas = trimmed.replace('，', ",").replace(['–', '—'], "-");
    let mut pages = Vec::new();
    let mut seen = HashSet::new();
    let mut duplicate_pages = Vec::new();
    let mut dup_seen = HashSet::new();

    for raw_token in normalized_commas.split(',') {
        let token = raw_token.trim();
        if token.is_empty() {
            return Err(AppError::invalid_param(format!(
                "Empty segment in page range '{trimmed}'."
            )));
        }
        if let Some((a_raw, b_raw)) = token.split_once('-') {
            if b_raw.contains('-') {
                return Err(AppError::invalid_param(format!(
                    "Invalid page range segment '{token}'."
                )));
            }
            let start: usize = a_raw.trim().parse().map_err(|_| {
                AppError::invalid_param(format!("Invalid start page in '{token}'."))
            })?;
            let end: usize = b_raw
                .trim()
                .parse()
                .map_err(|_| AppError::invalid_param(format!("Invalid end page in '{token}'.")))?;
            if start == 0 || end == 0 || start > total_pages || end > total_pages {
                return Err(AppError::invalid_param(format!(
                    "Page range '{token}' is out of bounds (valid: 1-{total_pages})."
                )));
            }
            if start > end {
                return Err(AppError::invalid_param(format!(
                    "Page range '{token}' is reversed (start > end)."
                )));
            }
            for p in start..=end {
                if !seen.insert(p) && dup_seen.insert(p) {
                    duplicate_pages.push(p);
                }
                pages.push(p);
                if pages.len() > MAX_PDF_PAGES * 2 {
                    return Err(AppError::size_limit(
                        "Page selection expands to too many pages.",
                    ));
                }
            }
        } else {
            let p: usize = token
                .parse()
                .map_err(|_| AppError::invalid_param(format!("Invalid page number '{token}'.")))?;
            if p == 0 || p > total_pages {
                return Err(AppError::invalid_param(format!(
                    "Page {p} is out of bounds (valid: 1-{total_pages})."
                )));
            }
            if !seen.insert(p) && dup_seen.insert(p) {
                duplicate_pages.push(p);
            }
            pages.push(p);
        }
    }

    if pages.is_empty() {
        return Err(AppError::invalid_param(
            "Page range did not select any pages.",
        ));
    }

    let normalized_label = format_compact_page_list(&pages);
    Ok(ParsedPageRange {
        pages,
        duplicate_pages,
        normalized_label,
    })
}

pub fn format_compact_page_list(pages: &[usize]) -> String {
    if pages.is_empty() {
        return String::new();
    }
    let mut parts = Vec::new();
    let mut run_start = pages[0];
    let mut run_end = pages[0];
    for &p in &pages[1..] {
        if p == run_end + 1 {
            run_end = p;
        } else {
            if run_start == run_end {
                parts.push(format!("{run_start}"));
            } else {
                parts.push(format!("{run_start}-{run_end}"));
            }
            run_start = p;
            run_end = p;
        }
    }
    if run_start == run_end {
        parts.push(format!("{run_start}"));
    } else {
        parts.push(format!("{run_start}-{run_end}"));
    }
    parts.join(", ")
}

/// Non-destructive atomic output staging for PDF files.
/// Automatically removes the temporary file if dropped before `commit()`.
pub struct AtomicPdfOutput {
    final_path: PathBuf,
    tmp_path: PathBuf,
    overwrite: bool,
    committed: bool,
}

impl AtomicPdfOutput {
    pub fn prepare(
        output_raw: &str,
        forbidden_sources: &[PathBuf],
        overwrite: bool,
    ) -> Result<Self, AppError> {
        let output_path = validate_user_path(output_raw, "Output")?;
        if output_path.is_dir() {
            return Err(AppError::new(
                "IS_DIRECTORY",
                "Output path points to an existing directory.",
            ));
        }
        for src in forbidden_sources {
            if paths_refer_to_same_location(src, &output_path) {
                return Err(AppError::same_input_output());
            }
        }
        let parent = output_path.parent().ok_or_else(|| {
            AppError::invalid_param("Output file path must reside inside an existing directory.")
        })?;
        let parent_meta = fs::metadata(parent)
            .map_err(|e| AppError::from_io(e, "Unable to access output directory"))?;
        if !parent_meta.is_dir() {
            return Err(AppError::invalid_param(
                "Output parent path is not a valid directory.",
            ));
        }
        if !overwrite && output_path.exists() {
            return Err(AppError::target_exists());
        }

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let pid = std::process::id();
        let base_name = output_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "output.pdf".to_string());
        let tmp_path = parent.join(format!(".{base_name}.winkit-{pid}-{stamp}.tmp"));

        Ok(Self {
            final_path: output_path,
            tmp_path,
            overwrite,
            committed: false,
        })
    }

    /// Allocate a unique non-overwriting `.pdf` path inside `dir` (never overwriting any existing file).
    pub fn prepare_unique_in_dir(
        dir: &Path,
        desired_file_name: &str,
        forbidden_sources: &[PathBuf],
    ) -> Result<(Self, bool), AppError> {
        let dir_meta = fs::metadata(dir)
            .map_err(|e| AppError::from_io(e, "Unable to access output directory"))?;
        if !dir_meta.is_dir() {
            return Err(AppError::invalid_param(
                "Output location must be an existing directory.",
            ));
        }
        let clean_name = sanitize_pdf_filename(desired_file_name);
        let stem = Path::new(&clean_name)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "output".to_string());

        for idx in 1..=9999usize {
            let candidate_name = if idx == 1 {
                format!("{stem}.pdf")
            } else {
                format!("{stem}_{idx}.pdf")
            };
            let candidate = dir.join(&candidate_name);
            let clashes_source = forbidden_sources
                .iter()
                .any(|src| paths_refer_to_same_location(src, &candidate));
            if clashes_source || candidate.exists() {
                continue;
            }
            let staged = Self::prepare(&candidate.to_string_lossy(), forbidden_sources, false)?;
            return Ok((staged, idx > 1));
        }

        Err(AppError::new(
            "IO_ERROR",
            "Unable to allocate a unique output filename after 9,999 attempts.",
        ))
    }

    pub fn write_and_commit(mut self, bytes: &[u8]) -> Result<(PathBuf, u64), AppError> {
        let mut tmp_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&self.tmp_path)
            .map_err(|e| {
                AppError::from_io(e, "Unable to create temporary PDF file in output directory")
            })?;
        tmp_file
            .write_all(bytes)
            .and_then(|()| tmp_file.flush())
            .map_err(|e| AppError::from_io(e, "Failed while writing temporary PDF file"))?;
        drop(tmp_file);

        if !self.overwrite {
            match fs::hard_link(&self.tmp_path, &self.final_path) {
                Ok(()) => {
                    let _ = fs::remove_file(&self.tmp_path);
                }
                Err(err) if err.kind() == ErrorKind::AlreadyExists => {
                    return Err(AppError::target_exists());
                }
                Err(_) => {
                    if self.final_path.exists() {
                        return Err(AppError::target_exists());
                    }
                    fs::rename(&self.tmp_path, &self.final_path)
                        .map_err(|e| AppError::from_io(e, "Unable to finalize output PDF file"))?;
                }
            }
        } else {
            fs::rename(&self.tmp_path, &self.final_path)
                .map_err(|e| AppError::from_io(e, "Unable to replace output PDF file"))?;
        }

        self.committed = true;
        Ok((self.final_path.clone(), bytes.len() as u64))
    }
}

impl Drop for AtomicPdfOutput {
    fn drop(&mut self) {
        if !self.committed && self.tmp_path.exists() {
            let _ = fs::remove_file(&self.tmp_path);
        }
    }
}

pub fn sanitize_pdf_filename(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            other => other,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "output.pdf".to_string()
    } else if trimmed.to_ascii_lowercase().ends_with(".pdf") {
        trimmed.to_string()
    } else {
        format!("{trimmed}.pdf")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_range_parser_validates_bounds_duplicates_and_order() {
        let ok = parse_page_range_spec("1-3, 5, 3, 8-9", 10).expect("valid");
        assert_eq!(ok.pages, vec![1, 2, 3, 5, 3, 8, 9]);
        assert_eq!(ok.duplicate_pages, vec![3]);
        assert_eq!(ok.normalized_label, "1-3, 5, 3, 8-9");

        assert!(parse_page_range_spec("", 10).is_err());
        assert!(parse_page_range_spec("0-2", 10).is_err());
        assert!(parse_page_range_spec("5-2", 10).is_err());
        assert!(parse_page_range_spec("1-11", 10).is_err());
        assert!(parse_page_range_spec("abc", 10).is_err());
    }

    #[test]
    fn bounded_render_cache_enforces_entry_and_byte_limits() {
        let mut cache = BoundedRenderCache::default();
        for i in 1..=80usize {
            let key = RenderCacheKey {
                path: "sample.pdf".into(),
                modified_ns: 1,
                byte_length: 100,
                page_number: i,
                target_width_px: 200,
                extra_rotation_cw: 0,
            };
            let meta = PdfRenderMeta {
                page_number: i,
                width_px: 200,
                height_px: 280,
                page_width_pt: 595.0,
                page_height_pt: 842.0,
                rotation: 0,
                capped: false,
            };
            cache.insert(key, meta, vec![0u8; 512 * 1024]);
        }
        let (count, bytes) = cache.stats();
        assert!(count <= MAX_CACHE_ENTRIES);
        assert!(bytes <= MAX_CACHE_BYTES);
    }
}
