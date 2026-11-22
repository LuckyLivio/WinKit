//! F04 Archive preview, extraction, and creation backend (ZIP, 7z, RAR, TAR, TAR.GZ, TAR.XZ,
//! TAR.BZ2, single-stream GZ/XZ/BZ2, and ISO 9660/Joliet).
//!
//! RAR reading uses `unrar-rs` (Apache-2.0 with UnRAR read-only restriction):
//! UnRAR source code may be used in any software to handle RAR archives without limitations
//! free of charge, but cannot be used to develop RAR (WinRAR) compatible archiver and to
//! re-create RAR compression algorithm, which is proprietary. Distribution of modified UnRAR
//! source code in separate form or as a part of other software is permitted, provided that
//! full text of this paragraph, starting from "UnRAR source code" words, is included in license,
//! or in documentation if license is not available, and in source code comments of resulting
//! package.

use crate::error::AppError;
use crate::fs_guard::{paths_refer_to_same_location, validate_user_path};
use crate::iso_reader::{list_iso_entries, stream_iso_entry};
use bzip2_rs::DecoderReader as Bz2DecoderReader;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use lzma_rust2::XzReader;
use serde::{Deserialize, Serialize};
use sevenz_rust2::{
    Archive as SevenZArchive, ArchiveReader as SevenZReader, Password as SevenZPassword,
};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;
use tar::{Archive as TarArchive, Builder as TarBuilder, EntryType};
use unrar_rs::RarArchive;
use zip::result::ZipError;
use zip::unstable::write::FileOptionsExt;
use zip::write::SimpleFileOptions;
use zip::{AesMode, CompressionMethod, ZipArchive, ZipWriter};

pub const ARCHIVE_PROGRESS_EVENT: &str = "winkit://archive-progress";
const MAX_PREVIEW_ENTRIES: usize = 5_000;
const MAX_EXTRACT_FILES_PER_ARCHIVE: usize = 50_000;
pub const DEFAULT_MAX_EXTRACT_BYTES_PER_ARCHIVE: u64 = 4 * 1024 * 1024 * 1024; // 4 GiB written cap
const STREAM_BUF_BYTES: usize = 256 * 1024;

static ARCHIVE_TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

const RESERVED_DOS_NAMES: &[&str] = &[
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "COM1",
    "COM2",
    "COM3",
    "COM4",
    "COM5",
    "COM6",
    "COM7",
    "COM8",
    "COM9",
    "COM\u{00B9}",
    "COM\u{00B2}",
    "COM\u{00B3}",
    "LPT1",
    "LPT2",
    "LPT3",
    "LPT4",
    "LPT5",
    "LPT6",
    "LPT7",
    "LPT8",
    "LPT9",
    "LPT\u{00B9}",
    "LPT\u{00B2}",
    "LPT\u{00B3}",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveFormat {
    Zip,
    SevenZ,
    Rar,
    Tar,
    TarGz,
    TarXz,
    TarBz2,
    SingleGz,
    SingleXz,
    SingleBz2,
    Iso,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveCreateFormat {
    Zip,
    ZipAes256,
    ZipZipcrypto,
    TarGz,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtractConflictPolicy {
    UniqueFolder,
    FailIfExists,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntryInfo {
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub is_macos_metadata: bool,
    pub compressed_size: Option<u64>,
    pub uncompressed_size: Option<u64>,
    pub encrypted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivePreviewResponse {
    pub archive_path: String,
    pub archive_name: String,
    pub format: ArchiveFormat,
    pub archive_byte_length: u64,
    pub needs_password: bool,
    pub encrypted_entry_count: usize,
    pub total_entries: usize,
    pub total_uncompressed_bytes: u64,
    pub entries_truncated: bool,
    pub entries: Vec<ArchiveEntryInfo>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractArchivesRequest {
    pub archive_paths: Vec<String>,
    pub output_parent_dir: String,
    #[serde(default)]
    pub passwords: HashMap<String, String>,
    pub skip_macos_metadata: bool,
    pub conflict_policy: ExtractConflictPolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveExtractStatus {
    Extracted,
    NeedsPassword,
    WrongPassword,
    Conflict,
    Cancelled,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveExtractItemReport {
    pub archive_path: String,
    pub archive_name: String,
    pub format: Option<ArchiveFormat>,
    pub status: ArchiveExtractStatus,
    pub output_dir: Option<String>,
    pub extracted_files: usize,
    pub extracted_dirs: usize,
    pub skipped_entries: usize,
    pub written_bytes: u64,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractArchivesBatchResponse {
    pub task_id: String,
    pub output_parent_dir: String,
    pub cancelled: bool,
    pub succeeded_count: usize,
    pub failed_count: usize,
    pub items: Vec<ArchiveExtractItemReport>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateArchiveRequest {
    pub source_paths: Vec<String>,
    pub output_path: String,
    pub format: ArchiveCreateFormat,
    pub password: Option<String>,
    pub overwrite: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateArchiveResponse {
    pub task_id: String,
    pub output_path: String,
    pub output_parent_dir: String,
    pub format: ArchiveFormat,
    pub entry_count: usize,
    pub skipped_count: usize,
    pub output_byte_length: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveProgressPayload {
    pub task_id: String,
    pub operation: &'static str,
    pub current_index: usize,
    pub total_items: usize,
    pub current_item: String,
    pub processed_bytes: u64,
    pub total_bytes: Option<u64>,
}

#[cfg(windows)]
fn is_reparse_point_meta(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    meta.file_type().is_symlink() || (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0
}

#[cfg(not(windows))]
fn is_reparse_point_meta(meta: &fs::Metadata) -> bool {
    meta.file_type().is_symlink()
}

fn move_path_no_overwrite(from: &Path, to: &Path, context: &str) -> Result<(), AppError> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

        let from_w: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let to_w: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
        let ok = unsafe { MoveFileExW(from_w.as_ptr(), to_w.as_ptr(), 0) };
        if ok == 0 {
            let io_err = io::Error::last_os_error();
            if matches!(io_err.raw_os_error(), Some(80) | Some(183)) {
                return Err(AppError::target_exists());
            }
            return Err(AppError::from_io(io_err, context));
        }
        Ok(())
    }

    #[cfg(not(windows))]
    {
        if fs::symlink_metadata(to).is_ok() {
            return Err(AppError::target_exists());
        }
        fs::rename(from, to).map_err(|e| AppError::from_io(e, context))
    }
}

pub fn detect_archive_format(path: &Path) -> Result<ArchiveFormat, AppError> {
    let lower = path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        return Ok(ArchiveFormat::TarGz);
    }
    if lower.ends_with(".tar.xz") || lower.ends_with(".txz") {
        return Ok(ArchiveFormat::TarXz);
    }
    if lower.ends_with(".tar.bz2") || lower.ends_with(".tbz2") || lower.ends_with(".tb2") {
        return Ok(ArchiveFormat::TarBz2);
    }
    if lower.ends_with(".tar") {
        return Ok(ArchiveFormat::Tar);
    }
    if lower.ends_with(".zip") {
        return Ok(ArchiveFormat::Zip);
    }
    if lower.ends_with(".7z") {
        return Ok(ArchiveFormat::SevenZ);
    }
    if lower.ends_with(".rar") {
        return Ok(ArchiveFormat::Rar);
    }
    if lower.ends_with(".iso") {
        return Ok(ArchiveFormat::Iso);
    }
    if lower.ends_with(".gz") {
        return Ok(ArchiveFormat::SingleGz);
    }
    if lower.ends_with(".xz") {
        return Ok(ArchiveFormat::SingleXz);
    }
    if lower.ends_with(".bz2") {
        return Ok(ArchiveFormat::SingleBz2);
    }

    // Fallback magic bytes inspection for extensionless archives
    let mut header = [0u8; 8];
    if let Ok(mut f) = File::open(path) {
        if let Ok(n) = f.read(&mut header) {
            let h = &header[..n];
            if h.starts_with(b"PK\x03\x04") || h.starts_with(b"PK\x05\x06") {
                return Ok(ArchiveFormat::Zip);
            }
            if h.starts_with(&[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]) {
                return Ok(ArchiveFormat::SevenZ);
            }
            if h.starts_with(b"Rar!\x1A\x07") {
                return Ok(ArchiveFormat::Rar);
            }
            if h.starts_with(&[0x1F, 0x8B]) {
                return Ok(ArchiveFormat::SingleGz);
            }
            if h.starts_with(&[0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00]) {
                return Ok(ArchiveFormat::SingleXz);
            }
            if h.starts_with(b"BZh") {
                return Ok(ArchiveFormat::SingleBz2);
            }
        }
    }

    Err(AppError::new(
        "UNSUPPORTED_ARCHIVE_FORMAT",
        format!(
            "Unsupported archive format for \"{}\". Supported: ZIP, 7z, RAR, TAR, TAR.GZ, TAR.XZ, TAR.BZ2, GZ, XZ, BZ2, ISO.",
            path.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        ),
    ))
}

fn strip_archive_stem(file_name: &str, format: ArchiveFormat) -> String {
    let lower = file_name.to_lowercase();
    let strip_len = match format {
        ArchiveFormat::TarGz if lower.ends_with(".tar.gz") => 7,
        ArchiveFormat::TarGz if lower.ends_with(".tgz") => 4,
        ArchiveFormat::TarXz if lower.ends_with(".tar.xz") => 7,
        ArchiveFormat::TarXz if lower.ends_with(".txz") => 4,
        ArchiveFormat::TarBz2 if lower.ends_with(".tar.bz2") => 8,
        ArchiveFormat::TarBz2 if lower.ends_with(".tbz2") => 5,
        ArchiveFormat::TarBz2 if lower.ends_with(".tb2") => 4,
        ArchiveFormat::Tar if lower.ends_with(".tar") => 4,
        ArchiveFormat::Zip if lower.ends_with(".zip") => 4,
        ArchiveFormat::SevenZ if lower.ends_with(".7z") => 3,
        ArchiveFormat::Rar if lower.ends_with(".rar") => 4,
        ArchiveFormat::Iso if lower.ends_with(".iso") => 4,
        ArchiveFormat::SingleGz if lower.ends_with(".gz") => 3,
        ArchiveFormat::SingleXz if lower.ends_with(".xz") => 3,
        ArchiveFormat::SingleBz2 if lower.ends_with(".bz2") => 4,
        _ => 0,
    };
    let candidate = if strip_len > 0 && file_name.len() > strip_len {
        &file_name[..file_name.len() - strip_len]
    } else {
        file_name
    };
    sanitize_single_windows_segment(candidate).unwrap_or_else(|| "extracted".to_string())
}

fn sanitize_single_windows_segment(raw: &str) -> Option<String> {
    let mut cleaned: String = raw
        .chars()
        .map(|c| {
            if (c as u32) <= 0x1F
                || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            {
                '_'
            } else {
                c
            }
        })
        .collect();
    cleaned = cleaned.trim_end_matches([' ', '.']).to_string();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return None;
    }
    let stem_upper = cleaned
        .split('.')
        .next()
        .unwrap_or("")
        .trim()
        .to_uppercase();
    if RESERVED_DOS_NAMES.contains(&stem_upper.as_str()) {
        cleaned.push_str("_extracted");
    }
    Some(cleaned)
}

fn is_macos_junk_path(raw_path: &str) -> bool {
    let normalized = raw_path.replace('\\', "/");
    for seg in normalized.split('/').filter(|s| !s.is_empty()) {
        if seg.eq_ignore_ascii_case("__MACOSX") || seg.eq_ignore_ascii_case(".DS_Store") {
            return true;
        }
    }
    false
}

/// Strictly validates an archive entry's relative path against Zip-Slip traversal, drive prefixes,
/// Windows forbidden characters, trailing spaces/dots, and reserved DOS device names.
pub fn validate_archive_relative_path(raw: &str) -> Result<PathBuf, AppError> {
    let normalized = raw.replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(AppError::invalid_param("Empty archive entry path."));
    }
    if trimmed.starts_with('/') || normalized.starts_with("//") {
        return Err(AppError::new(
            "UNSAFE_ARCHIVE_PATH",
            format!("Blocked absolute archive path \"{raw}\"."),
        ));
    }

    let mut rel = PathBuf::new();
    let mut depth = 0usize;
    for seg in trimmed.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return Err(AppError::new(
                "UNSAFE_ARCHIVE_PATH",
                format!("Blocked parent-directory traversal in archive path \"{raw}\"."),
            ));
        }
        if seg.encode_utf16().count() > 255 {
            return Err(AppError::new(
                "UNSAFE_ARCHIVE_PATH",
                format!("Archive path segment exceeds Windows 255-character limit: \"{seg}\"."),
            ));
        }
        if seg.ends_with(' ') || seg.ends_with('.') {
            return Err(AppError::new(
                "UNSAFE_ARCHIVE_PATH",
                format!("Archive path segment ends with space or period: \"{seg}\"."),
            ));
        }
        for ch in seg.chars() {
            if (ch as u32) <= 0x1F
                || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            {
                return Err(AppError::new(
                    "UNSAFE_ARCHIVE_PATH",
                    format!("Archive path \"{raw}\" contains characters disallowed on Windows."),
                ));
            }
        }
        let dos_stem = seg.split('.').next().unwrap_or("").trim().to_uppercase();
        if RESERVED_DOS_NAMES.contains(&dos_stem.as_str()) {
            return Err(AppError::new(
                "UNSAFE_ARCHIVE_PATH",
                format!("Archive path \"{raw}\" uses reserved Windows device name \"{dos_stem}\"."),
            ));
        }
        depth += 1;
        if depth > 64 {
            return Err(AppError::new(
                "UNSAFE_ARCHIVE_PATH",
                "Archive directory nesting exceeds 64-level safety limit.",
            ));
        }
        rel.push(seg);
    }

    if rel.as_os_str().is_empty() {
        return Err(AppError::invalid_param("Empty normalized archive path."));
    }
    Ok(rel)
}

fn single_stream_inner_name(archive_name: &str, format: ArchiveFormat) -> String {
    let base = strip_archive_stem(archive_name, format);
    if base.is_empty() {
        "decompressed.bin".to_string()
    } else {
        base
    }
}

fn push_preview_entry(
    entries: &mut Vec<ArchiveEntryInfo>,
    total_entries: &mut usize,
    total_uncompressed: &mut u64,
    encrypted_count: &mut usize,
    truncated: &mut bool,
    info: ArchiveEntryInfo,
) {
    *total_entries += 1;
    if info.encrypted {
        *encrypted_count += 1;
    }
    if let Some(sz) = info.uncompressed_size {
        *total_uncompressed = total_uncompressed.saturating_add(sz);
    }
    if entries.len() < MAX_PREVIEW_ENTRIES {
        entries.push(info);
    } else {
        *truncated = true;
    }
}

pub fn inspect_archive_impl(
    raw_path: &str,
    password: Option<&str>,
) -> Result<ArchivePreviewResponse, AppError> {
    let archive_path = validate_user_path(raw_path, "Archive")?;
    let meta = fs::symlink_metadata(&archive_path)
        .map_err(|e| AppError::from_io(e, "Cannot inspect archive"))?;
    if is_reparse_point_meta(&meta) || !meta.is_file() {
        return Err(AppError::invalid_param(
            "Selected archive must be a regular local file.",
        ));
    }

    let archive_byte_length = meta.len();
    let archive_name = archive_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let format = detect_archive_format(&archive_path)?;

    let mut entries = Vec::new();
    let mut total_entries = 0usize;
    let mut total_uncompressed_bytes = 0u64;
    let mut encrypted_entry_count = 0usize;
    let mut entries_truncated = false;
    let mut needs_password = false;

    match format {
        ArchiveFormat::Zip => {
            let file = File::open(&archive_path)
                .map_err(|e| AppError::from_io(e, "Cannot open ZIP archive"))?;
            let mut zip = ZipArchive::new(file)
                .map_err(|e| AppError::decode_failed(format!("Invalid ZIP archive: {e}")))?;

            for i in 0..zip.len() {
                let raw_entry = zip
                    .by_index_raw(i)
                    .map_err(|e| AppError::decode_failed(format!("ZIP entry error: {e}")))?;
                let name = raw_entry
                    .name()
                    .map(|c| c.into_owned())
                    .unwrap_or_else(|_| String::from_utf8_lossy(raw_entry.name_raw()).into_owned());
                let is_dir = raw_entry.is_dir();
                let is_symlink = raw_entry
                    .unix_mode()
                    .is_some_and(|m| (m & 0o170000) == 0o120000);
                let encrypted = raw_entry.encrypted();
                if encrypted {
                    needs_password = true;
                }
                let is_macos_metadata = is_macos_junk_path(&name);
                push_preview_entry(
                    &mut entries,
                    &mut total_entries,
                    &mut total_uncompressed_bytes,
                    &mut encrypted_entry_count,
                    &mut entries_truncated,
                    ArchiveEntryInfo {
                        path: name,
                        is_dir,
                        is_symlink,
                        is_macos_metadata,
                        compressed_size: Some(raw_entry.compressed_size()),
                        uncompressed_size: Some(raw_entry.size()),
                        encrypted,
                    },
                );
            }
        }
        ArchiveFormat::SevenZ => {
            let pw = match password {
                Some(p) if !p.is_empty() => SevenZPassword::from(p),
                _ => SevenZPassword::empty(),
            };
            let open_res = SevenZArchive::open_with_password(&archive_path, &pw);
            match open_res {
                Ok(arc) => {
                    for entry in &arc.files {
                        let name = entry.name().to_string();
                        let is_dir = entry.is_directory();
                        let encrypted = entry.has_stream()
                            && arc.blocks.iter().any(|b| {
                                b.coders
                                    .iter()
                                    .any(|c| c.encoder_method_id() == [0x06, 0xF1, 0x07, 0x01])
                            });
                        if encrypted {
                            needs_password = true;
                        }
                        push_preview_entry(
                            &mut entries,
                            &mut total_entries,
                            &mut total_uncompressed_bytes,
                            &mut encrypted_entry_count,
                            &mut entries_truncated,
                            ArchiveEntryInfo {
                                path: name.clone(),
                                is_dir,
                                is_symlink: false,
                                is_macos_metadata: is_macos_junk_path(&name),
                                compressed_size: None,
                                uncompressed_size: Some(entry.size()),
                                encrypted,
                            },
                        );
                    }
                }
                Err(err) => {
                    let msg = err.to_string();
                    if msg.to_lowercase().contains("password")
                        || msg.to_lowercase().contains("decrypt")
                        || msg.to_lowercase().contains("encrypted")
                    {
                        needs_password = true;
                    } else {
                        return Err(AppError::decode_failed(format!(
                            "Cannot read 7z archive: {msg}"
                        )));
                    }
                }
            }
        }
        ArchiveFormat::Rar => {
            let file = File::open(&archive_path)
                .map_err(|e| AppError::from_io(e, "Cannot open RAR archive"))?;
            let opened = match password {
                Some(pw) if !pw.is_empty() => RarArchive::open_with_password(file, pw),
                _ => RarArchive::open(file),
            };
            match opened {
                Ok(arc) => {
                    let members: Vec<_> = arc.entries().collect();
                    for (idx, member) in members.into_iter().enumerate() {
                        let redir_is_link = arc.member_redirection(idx).ok().flatten().is_some();
                        let is_symlink = member.is_symlink || redir_is_link;
                        if member.is_encrypted {
                            needs_password = true;
                        }
                        let name = member.raw_name.clone();
                        push_preview_entry(
                            &mut entries,
                            &mut total_entries,
                            &mut total_uncompressed_bytes,
                            &mut encrypted_entry_count,
                            &mut entries_truncated,
                            ArchiveEntryInfo {
                                path: name.clone(),
                                is_dir: member.is_directory,
                                is_symlink,
                                is_macos_metadata: is_macos_junk_path(&name),
                                compressed_size: Some(member.compressed_size),
                                uncompressed_size: member.unpacked_size,
                                encrypted: member.is_encrypted,
                            },
                        );
                    }
                }
                Err(err) => {
                    let msg = err.to_string();
                    let lower = msg.to_lowercase();
                    if lower.contains("password") || lower.contains("encrypt") {
                        needs_password = true;
                    } else {
                        return Err(AppError::decode_failed(format!(
                            "Cannot read RAR archive: {msg}"
                        )));
                    }
                }
            }
        }
        ArchiveFormat::Tar => {
            let file = File::open(&archive_path)
                .map_err(|e| AppError::from_io(e, "Cannot open TAR archive"))?;
            inspect_tar_stream(
                file,
                &mut entries,
                &mut total_entries,
                &mut total_uncompressed_bytes,
                &mut encrypted_entry_count,
                &mut entries_truncated,
            )?;
        }
        ArchiveFormat::TarGz => {
            let file = File::open(&archive_path)
                .map_err(|e| AppError::from_io(e, "Cannot open TAR.GZ archive"))?;
            inspect_tar_stream(
                GzDecoder::new(file),
                &mut entries,
                &mut total_entries,
                &mut total_uncompressed_bytes,
                &mut encrypted_entry_count,
                &mut entries_truncated,
            )?;
        }
        ArchiveFormat::TarXz => {
            let file = File::open(&archive_path)
                .map_err(|e| AppError::from_io(e, "Cannot open TAR.XZ archive"))?;
            inspect_tar_stream(
                XzReader::new(file, true),
                &mut entries,
                &mut total_entries,
                &mut total_uncompressed_bytes,
                &mut encrypted_entry_count,
                &mut entries_truncated,
            )?;
        }
        ArchiveFormat::TarBz2 => {
            let file = File::open(&archive_path)
                .map_err(|e| AppError::from_io(e, "Cannot open TAR.BZ2 archive"))?;
            inspect_tar_stream(
                Bz2DecoderReader::new(file),
                &mut entries,
                &mut total_entries,
                &mut total_uncompressed_bytes,
                &mut encrypted_entry_count,
                &mut entries_truncated,
            )?;
        }
        ArchiveFormat::SingleGz | ArchiveFormat::SingleXz | ArchiveFormat::SingleBz2 => {
            let inner_name = single_stream_inner_name(&archive_name, format);
            push_preview_entry(
                &mut entries,
                &mut total_entries,
                &mut total_uncompressed_bytes,
                &mut encrypted_entry_count,
                &mut entries_truncated,
                ArchiveEntryInfo {
                    path: inner_name.clone(),
                    is_dir: false,
                    is_symlink: false,
                    is_macos_metadata: is_macos_junk_path(&inner_name),
                    compressed_size: Some(archive_byte_length),
                    uncompressed_size: None,
                    encrypted: false,
                },
            );
        }
        ArchiveFormat::Iso => {
            let mut file = File::open(&archive_path)
                .map_err(|e| AppError::from_io(e, "Cannot open ISO image"))?;
            let iso_entries = list_iso_entries(&mut file)?;
            for item in iso_entries {
                push_preview_entry(
                    &mut entries,
                    &mut total_entries,
                    &mut total_uncompressed_bytes,
                    &mut encrypted_entry_count,
                    &mut entries_truncated,
                    ArchiveEntryInfo {
                        path: item.path.clone(),
                        is_dir: item.is_dir,
                        is_symlink: item.is_symlink,
                        is_macos_metadata: is_macos_junk_path(&item.path),
                        compressed_size: Some(item.size),
                        uncompressed_size: Some(item.size),
                        encrypted: false,
                    },
                );
            }
        }
    }

    Ok(ArchivePreviewResponse {
        archive_path: archive_path.to_string_lossy().into_owned(),
        archive_name,
        format,
        archive_byte_length,
        needs_password,
        encrypted_entry_count,
        total_entries,
        total_uncompressed_bytes,
        entries_truncated,
        entries,
    })
}

fn inspect_tar_stream<R: Read>(
    reader: R,
    entries: &mut Vec<ArchiveEntryInfo>,
    total_entries: &mut usize,
    total_uncompressed: &mut u64,
    encrypted_count: &mut usize,
    truncated: &mut bool,
) -> Result<(), AppError> {
    let mut tar = TarArchive::new(reader);
    let iter = tar
        .entries()
        .map_err(|e| AppError::decode_failed(format!("Invalid TAR stream: {e}")))?;

    for item_res in iter {
        let entry =
            item_res.map_err(|e| AppError::decode_failed(format!("Corrupt TAR entry: {e}")))?;
        let header_type = entry.header().entry_type();
        let is_dir = header_type == EntryType::Directory;
        let is_symlink = matches!(header_type, EntryType::Symlink | EntryType::Link);
        let size = entry.header().size().unwrap_or(0);
        let path_str = entry
            .path()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        if path_str.is_empty() {
            continue;
        }
        push_preview_entry(
            entries,
            total_entries,
            total_uncompressed,
            encrypted_count,
            truncated,
            ArchiveEntryInfo {
                path: path_str.clone(),
                is_dir,
                is_symlink,
                is_macos_metadata: is_macos_junk_path(&path_str),
                compressed_size: None,
                uncompressed_size: Some(size),
                encrypted: false,
            },
        );
    }
    Ok(())
}

/// Counts actual bytes written to disk and enforces both written-byte ceiling and cancellation.
struct BoundedExtractWriter<'a, W: Write> {
    inner: W,
    total_written: &'a mut u64,
    max_bytes: u64,
    cancel_flag: &'a AtomicBool,
    on_bytes: &'a mut dyn FnMut(u64),
}

impl<'a, W: Write> Write for BoundedExtractWriter<'a, W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.cancel_flag.load(Ordering::Relaxed) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "WINKIT_TASK_CANCELLED",
            ));
        }
        let next = self.total_written.saturating_add(buf.len() as u64);
        if next > self.max_bytes {
            return Err(io::Error::other("WINKIT_ARCHIVE_LIMIT_EXCEEDED"));
        }
        let n = self.inner.write(buf)?;
        *self.total_written = self.total_written.saturating_add(n as u64);
        (self.on_bytes)(*self.total_written);
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn copy_stream_bounded<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut BoundedExtractWriter<'_, W>,
) -> Result<(), AppError> {
    let mut buf = vec![0u8; STREAM_BUF_BYTES];
    loop {
        if writer.cancel_flag.load(Ordering::Relaxed) {
            return Err(AppError::cancelled());
        }
        let n = reader.read(&mut buf).map_err(map_extract_io_error)?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n]).map_err(map_extract_io_error)?;
    }
    writer.flush().map_err(map_extract_io_error)?;
    Ok(())
}

fn map_extract_io_error(err: io::Error) -> AppError {
    let s = err.to_string();
    if s.contains("WINKIT_TASK_CANCELLED") {
        return AppError::cancelled();
    }
    if s.contains("WINKIT_ARCHIVE_LIMIT_EXCEEDED") {
        return AppError::size_limit(
            "Archive extraction exceeded the maximum safe output byte limit.",
        );
    }
    AppError::from_io(err, "Archive extraction I/O error")
}

struct StagingCleanupGuard {
    staging_dir: PathBuf,
    committed: bool,
}

impl StagingCleanupGuard {
    fn new(staging_dir: PathBuf) -> Self {
        Self {
            staging_dir,
            committed: false,
        }
    }

    fn mark_committed(&mut self) {
        self.committed = true;
    }
}

impl Drop for StagingCleanupGuard {
    fn drop(&mut self) {
        if !self.committed && self.staging_dir.exists() {
            let _ = fs::remove_dir_all(&self.staging_dir);
        }
    }
}

fn allocate_staging_dir(output_parent: &Path, idx: usize) -> Result<PathBuf, AppError> {
    let pid = std::process::id();
    let seq = ARCHIVE_TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let mut attempt = 0u32;
    loop {
        let name = if attempt == 0 {
            format!(".winkit-extract-{pid}-{seq:x}-{idx}.tmp")
        } else {
            format!(".winkit-extract-{pid}-{seq:x}-{idx}-{attempt}.tmp")
        };
        let candidate = output_parent.join(name);
        if fs::symlink_metadata(&candidate).is_err() {
            fs::create_dir(&candidate)
                .map_err(|e| AppError::from_io(e, "Cannot create extraction staging directory"))?;
            return Ok(candidate);
        }
        attempt = attempt.saturating_add(1);
    }
}

fn choose_destination_folder(
    output_parent: &Path,
    base_name: &str,
    policy: ExtractConflictPolicy,
    batch_claimed: &mut HashSet<String>,
) -> Result<PathBuf, AppError> {
    let first_key = base_name.to_lowercase();
    let first_path = output_parent.join(base_name);

    // If `FailIfExists` and the folder/file ALREADY existed on disk before this batch
    // (and wasn't simply claimed by an earlier same-named archive in this batch):
    if policy == ExtractConflictPolicy::FailIfExists
        && !batch_claimed.contains(&first_key)
        && fs::symlink_metadata(&first_path).is_ok()
    {
        return Err(AppError::new(
            "TARGET_ALREADY_EXISTS",
            format!(
                "Destination \"{}\" already exists in the selected output folder; existing files were protected.",
                base_name
            ),
        ));
    }

    if !batch_claimed.contains(&first_key) && fs::symlink_metadata(&first_path).is_err() {
        batch_claimed.insert(first_key);
        return Ok(first_path);
    }

    // Either same-name archive in this batch OR `UniqueFolder` avoiding pre-existing output
    let mut suffix = 2u32;
    loop {
        let candidate_name = format!("{base_name} ({suffix})");
        let cand_key = candidate_name.to_lowercase();
        let cand_path = output_parent.join(&candidate_name);
        if !batch_claimed.contains(&cand_key) && fs::symlink_metadata(&cand_path).is_err() {
            batch_claimed.insert(cand_key);
            return Ok(cand_path);
        }
        suffix = suffix.saturating_add(1);
    }
}

struct ExtractCounters {
    extracted_files: usize,
    extracted_dirs: usize,
    skipped_entries: usize,
    written_bytes: u64,
    written_slots: HashSet<String>,
}

impl ExtractCounters {
    fn new() -> Self {
        Self {
            extracted_files: 0,
            extracted_dirs: 0,
            skipped_entries: 0,
            written_bytes: 0,
            written_slots: HashSet::new(),
        }
    }

    fn prepare_file_path(
        &mut self,
        staging_dir: &Path,
        raw_entry_path: &str,
    ) -> Result<Option<PathBuf>, AppError> {
        let rel = validate_archive_relative_path(raw_entry_path)?;
        let slot_key = rel.to_string_lossy().replace('\\', "/").to_lowercase();
        if !self.written_slots.insert(slot_key) {
            self.skipped_entries += 1;
            return Ok(None);
        }
        if self.extracted_files >= MAX_EXTRACT_FILES_PER_ARCHIVE {
            return Err(AppError::size_limit(format!(
                "Archive exceeds the {MAX_EXTRACT_FILES_PER_ARCHIVE}-file extraction safety limit."
            )));
        }
        let target = staging_dir.join(&rel);
        if !target.starts_with(staging_dir) {
            return Err(AppError::new(
                "UNSAFE_ARCHIVE_PATH",
                "Resolved archive entry escaped target directory.",
            ));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| AppError::from_io(e, "Cannot create output subdirectory"))?;
        }
        Ok(Some(target))
    }

    fn prepare_dir_path(
        &mut self,
        staging_dir: &Path,
        raw_entry_path: &str,
    ) -> Result<(), AppError> {
        let rel = validate_archive_relative_path(raw_entry_path)?;
        let target = staging_dir.join(&rel);
        if !target.starts_with(staging_dir) {
            return Err(AppError::new(
                "UNSAFE_ARCHIVE_PATH",
                "Resolved archive directory escaped target directory.",
            ));
        }
        fs::create_dir_all(&target)
            .map_err(|e| AppError::from_io(e, "Cannot create output directory"))?;
        self.extracted_dirs += 1;
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
fn extract_single_archive_to_staging<P>(
    archive_path: &Path,
    archive_name: &str,
    format: ArchiveFormat,
    staging_dir: &Path,
    password: Option<&str>,
    skip_macos_metadata: bool,
    max_extract_bytes: u64,
    cancel_flag: &AtomicBool,
    mut on_bytes_written: P,
) -> Result<ExtractCounters, AppError>
where
    P: FnMut(u64),
{
    let mut counters = ExtractCounters::new();

    match format {
        ArchiveFormat::Zip => {
            let file = File::open(archive_path)
                .map_err(|e| AppError::from_io(e, "Cannot open ZIP archive"))?;
            let mut zip = ZipArchive::new(file)
                .map_err(|e| AppError::decode_failed(format!("Invalid ZIP archive: {e}")))?;

            for i in 0..zip.len() {
                if cancel_flag.load(Ordering::Relaxed) {
                    return Err(AppError::cancelled());
                }

                let (raw_name, is_dir, is_symlink, is_encrypted) = {
                    let raw = zip
                        .by_index_raw(i)
                        .map_err(|e| AppError::decode_failed(format!("ZIP entry error: {e}")))?;
                    let entry_name = raw
                        .name()
                        .map(|c| c.into_owned())
                        .unwrap_or_else(|_| String::from_utf8_lossy(raw.name_raw()).into_owned());
                    (
                        entry_name,
                        raw.is_dir(),
                        raw.unix_mode().is_some_and(|m| (m & 0o170000) == 0o120000),
                        raw.encrypted(),
                    )
                };

                if (skip_macos_metadata && is_macos_junk_path(&raw_name)) || is_symlink {
                    counters.skipped_entries += 1;
                    continue;
                }

                if is_dir {
                    counters.prepare_dir_path(staging_dir, &raw_name)?;
                    continue;
                }

                if is_encrypted && password.is_none_or(str::is_empty) {
                    return Err(AppError::new(
                        "ARCHIVE_NEEDS_PASSWORD",
                        "This ZIP archive is password-protected.",
                    ));
                }

                let mut entry_reader = if is_encrypted {
                    let pw_bytes = password.unwrap_or("").as_bytes();
                    match zip.by_index_decrypt(i, pw_bytes) {
                        Ok(f) => f,
                        Err(ZipError::InvalidPassword) => {
                            return Err(AppError::new(
                                "ARCHIVE_WRONG_PASSWORD",
                                "Incorrect password for this ZIP archive.",
                            ));
                        }
                        Err(ZipError::UnsupportedArchive(msg)) => {
                            return Err(AppError::decode_failed(format!(
                                "Unsupported ZIP compression or encryption: {msg}"
                            )));
                        }
                        Err(e) => {
                            return Err(AppError::decode_failed(format!(
                                "Failed decrypting ZIP entry: {e}"
                            )));
                        }
                    }
                } else {
                    zip.by_index(i).map_err(|e| {
                        AppError::decode_failed(format!("Failed reading ZIP entry: {e}"))
                    })?
                };

                if let Some(target_file) = counters.prepare_file_path(staging_dir, &raw_name)? {
                    let out = File::create(&target_file)
                        .map_err(|e| AppError::from_io(e, "Cannot create extracted file"))?;
                    let mut bounded = BoundedExtractWriter {
                        inner: out,
                        total_written: &mut counters.written_bytes,
                        max_bytes: max_extract_bytes,
                        cancel_flag,
                        on_bytes: &mut on_bytes_written,
                    };
                    if let Err(err) = copy_stream_bounded(&mut entry_reader, &mut bounded) {
                        // In ZipCrypto, wrong passwords can also fail mid-stream on CRC/deflate check
                        if is_encrypted && err.code == "IO_ERROR" {
                            return Err(AppError::new(
                                "ARCHIVE_WRONG_PASSWORD",
                                "Incorrect password or corrupted encrypted ZIP stream.",
                            ));
                        }
                        return Err(err);
                    }
                    counters.extracted_files += 1;
                }
            }
        }
        ArchiveFormat::SevenZ => {
            let pw = match password {
                Some(p) if !p.is_empty() => SevenZPassword::from(p),
                _ => SevenZPassword::empty(),
            };
            let mut reader = SevenZReader::open(archive_path, pw).map_err(|e| {
                let s = e.to_string();
                let lower = s.to_lowercase();
                if lower.contains("password")
                    || lower.contains("decrypt")
                    || lower.contains("encrypt")
                {
                    if password.is_none_or(str::is_empty) {
                        AppError::new(
                            "ARCHIVE_NEEDS_PASSWORD",
                            "This 7z archive is password-protected.",
                        )
                    } else {
                        AppError::new(
                            "ARCHIVE_WRONG_PASSWORD",
                            "Incorrect password for this 7z archive.",
                        )
                    }
                } else {
                    AppError::decode_failed(format!("Cannot open 7z archive: {s}"))
                }
            })?;

            let mut captured_err: Option<AppError> = None;
            let iter_res = reader.for_each_entries(|entry, data_reader| {
                if cancel_flag.load(Ordering::Relaxed) {
                    captured_err = Some(AppError::cancelled());
                    return Ok(false);
                }
                let raw_name = entry.name().to_string();
                if skip_macos_metadata && is_macos_junk_path(&raw_name) {
                    counters.skipped_entries += 1;
                    return Ok(true);
                }
                if entry.is_directory() {
                    if let Err(e) = counters.prepare_dir_path(staging_dir, &raw_name) {
                        captured_err = Some(e);
                        return Ok(false);
                    }
                    return Ok(true);
                }

                match counters.prepare_file_path(staging_dir, &raw_name) {
                    Ok(Some(target_file)) => {
                        let out = match File::create(&target_file) {
                            Ok(f) => f,
                            Err(e) => {
                                captured_err =
                                    Some(AppError::from_io(e, "Cannot create 7z extracted file"));
                                return Ok(false);
                            }
                        };
                        let mut bounded = BoundedExtractWriter {
                            inner: out,
                            total_written: &mut counters.written_bytes,
                            max_bytes: max_extract_bytes,
                            cancel_flag,
                            on_bytes: &mut on_bytes_written,
                        };
                        let mut dyn_reader = data_reader;
                        if let Err(e) = copy_stream_bounded(&mut dyn_reader, &mut bounded) {
                            captured_err = Some(e);
                            return Ok(false);
                        }
                        counters.extracted_files += 1;
                    }
                    Ok(None) => {}
                    Err(e) => {
                        captured_err = Some(e);
                        return Ok(false);
                    }
                }
                Ok(true)
            });

            if let Some(e) = captured_err {
                return Err(e);
            }
            if let Err(err) = iter_res {
                let s = err.to_string();
                let lower = s.to_lowercase();
                if lower.contains("password") || lower.contains("decrypt") || lower.contains("crc")
                {
                    if password.is_none_or(str::is_empty) {
                        return Err(AppError::new(
                            "ARCHIVE_NEEDS_PASSWORD",
                            "This 7z archive requires a password.",
                        ));
                    }
                    return Err(AppError::new(
                        "ARCHIVE_WRONG_PASSWORD",
                        "Incorrect password or corrupt 7z data.",
                    ));
                }
                return Err(AppError::decode_failed(format!(
                    "Failed extracting 7z archive: {s}"
                )));
            }
        }
        ArchiveFormat::Rar => {
            let file = File::open(archive_path)
                .map_err(|e| AppError::from_io(e, "Cannot open RAR archive"))?;
            let mut arc = match password {
                Some(pw) if !pw.is_empty() => RarArchive::open_with_password(file, pw),
                _ => RarArchive::open(file),
            }
            .map_err(|e| {
                let s = e.to_string();
                let lower = s.to_lowercase();
                if lower.contains("password") || lower.contains("encrypt") {
                    if password.is_none_or(str::is_empty) {
                        AppError::new(
                            "ARCHIVE_NEEDS_PASSWORD",
                            "This RAR archive is password-protected.",
                        )
                    } else {
                        AppError::new(
                            "ARCHIVE_WRONG_PASSWORD",
                            "Incorrect password for this RAR archive.",
                        )
                    }
                } else {
                    AppError::decode_failed(format!("Cannot open RAR archive: {s}"))
                }
            })?;

            if let Some(pw) = password.filter(|p| !p.is_empty()) {
                arc.set_password(pw);
            }

            let members: Vec<_> = arc.entries().collect();
            for (i, m) in members.into_iter().enumerate() {
                if cancel_flag.load(Ordering::Relaxed) {
                    return Err(AppError::cancelled());
                }

                let (raw_name, is_dir, is_symlink, is_encrypted) = {
                    let redir = arc.member_redirection(i).ok().flatten().is_some();
                    (
                        m.raw_name,
                        m.is_directory,
                        m.is_symlink || redir,
                        m.is_encrypted,
                    )
                };

                if (skip_macos_metadata && is_macos_junk_path(&raw_name)) || is_symlink {
                    counters.skipped_entries += 1;
                    let _ = arc.by_index(i).and_then(|e| e.skip());
                    continue;
                }

                if is_dir {
                    counters.prepare_dir_path(staging_dir, &raw_name)?;
                    continue;
                }

                if is_encrypted && password.is_none_or(str::is_empty) {
                    return Err(AppError::new(
                        "ARCHIVE_NEEDS_PASSWORD",
                        "This RAR archive is password-protected.",
                    ));
                }

                if let Some(target_file) = counters.prepare_file_path(staging_dir, &raw_name)? {
                    let out = File::create(&target_file)
                        .map_err(|e| AppError::from_io(e, "Cannot create RAR extracted file"))?;
                    let mut bounded = BoundedExtractWriter {
                        inner: out,
                        total_written: &mut counters.written_bytes,
                        max_bytes: max_extract_bytes,
                        cancel_flag,
                        on_bytes: &mut on_bytes_written,
                    };
                    let rar_entry = arc.by_index(i).map_err(|e| {
                        AppError::decode_failed(format!("RAR entry access failed: {e}"))
                    })?;
                    if let Err(err) = rar_entry.copy_to(&mut bounded) {
                        let s = err.to_string();
                        if s.contains("WINKIT_TASK_CANCELLED") {
                            return Err(AppError::cancelled());
                        }
                        if s.contains("WINKIT_ARCHIVE_LIMIT_EXCEEDED") {
                            return Err(AppError::size_limit(
                                "Archive extraction exceeded the maximum safe output byte limit.",
                            ));
                        }
                        let lower = s.to_lowercase();
                        if is_encrypted
                            && (lower.contains("password")
                                || lower.contains("crc")
                                || lower.contains("checksum")
                                || lower.contains("decrypt"))
                        {
                            return Err(AppError::new(
                                "ARCHIVE_WRONG_PASSWORD",
                                "Incorrect password for this RAR archive.",
                            ));
                        }
                        return Err(AppError::decode_failed(format!(
                            "Failed extracting RAR entry: {s}"
                        )));
                    }
                    counters.extracted_files += 1;
                }
            }
        }
        ArchiveFormat::Tar => {
            let file = File::open(archive_path)
                .map_err(|e| AppError::from_io(e, "Cannot open TAR archive"))?;
            extract_tar_stream(
                file,
                staging_dir,
                skip_macos_metadata,
                max_extract_bytes,
                cancel_flag,
                &mut counters,
                &mut on_bytes_written,
            )?;
        }
        ArchiveFormat::TarGz => {
            let file = File::open(archive_path)
                .map_err(|e| AppError::from_io(e, "Cannot open TAR.GZ archive"))?;
            extract_tar_stream(
                GzDecoder::new(file),
                staging_dir,
                skip_macos_metadata,
                max_extract_bytes,
                cancel_flag,
                &mut counters,
                &mut on_bytes_written,
            )?;
        }
        ArchiveFormat::TarXz => {
            let file = File::open(archive_path)
                .map_err(|e| AppError::from_io(e, "Cannot open TAR.XZ archive"))?;
            extract_tar_stream(
                XzReader::new(file, true),
                staging_dir,
                skip_macos_metadata,
                max_extract_bytes,
                cancel_flag,
                &mut counters,
                &mut on_bytes_written,
            )?;
        }
        ArchiveFormat::TarBz2 => {
            let file = File::open(archive_path)
                .map_err(|e| AppError::from_io(e, "Cannot open TAR.BZ2 archive"))?;
            extract_tar_stream(
                Bz2DecoderReader::new(file),
                staging_dir,
                skip_macos_metadata,
                max_extract_bytes,
                cancel_flag,
                &mut counters,
                &mut on_bytes_written,
            )?;
        }
        ArchiveFormat::SingleGz | ArchiveFormat::SingleXz | ArchiveFormat::SingleBz2 => {
            let inner_name = single_stream_inner_name(archive_name, format);
            let file = File::open(archive_path)
                .map_err(|e| AppError::from_io(e, "Cannot open compressed stream"))?;
            if let Some(target_file) = counters.prepare_file_path(staging_dir, &inner_name)? {
                let out = File::create(&target_file)
                    .map_err(|e| AppError::from_io(e, "Cannot create decompressed output file"))?;
                let mut bounded = BoundedExtractWriter {
                    inner: out,
                    total_written: &mut counters.written_bytes,
                    max_bytes: max_extract_bytes,
                    cancel_flag,
                    on_bytes: &mut on_bytes_written,
                };
                match format {
                    ArchiveFormat::SingleGz => {
                        let mut dec = GzDecoder::new(file);
                        copy_stream_bounded(&mut dec, &mut bounded)?;
                    }
                    ArchiveFormat::SingleXz => {
                        let mut dec = XzReader::new(file, true);
                        copy_stream_bounded(&mut dec, &mut bounded)?;
                    }
                    ArchiveFormat::SingleBz2 => {
                        let mut dec = Bz2DecoderReader::new(file);
                        copy_stream_bounded(&mut dec, &mut bounded)?;
                    }
                    _ => unreachable!(),
                }
                counters.extracted_files += 1;
            }
        }
        ArchiveFormat::Iso => {
            let mut file = File::open(archive_path)
                .map_err(|e| AppError::from_io(e, "Cannot open ISO image"))?;
            let iso_entries = list_iso_entries(&mut file)?;
            for item in iso_entries {
                if cancel_flag.load(Ordering::Relaxed) {
                    return Err(AppError::cancelled());
                }
                if (skip_macos_metadata && is_macos_junk_path(&item.path)) || item.is_symlink {
                    counters.skipped_entries += 1;
                    continue;
                }
                if item.is_dir {
                    counters.prepare_dir_path(staging_dir, &item.path)?;
                    continue;
                }
                if let Some(target_file) = counters.prepare_file_path(staging_dir, &item.path)? {
                    let out = File::create(&target_file)
                        .map_err(|e| AppError::from_io(e, "Cannot create ISO extracted file"))?;
                    let mut bounded = BoundedExtractWriter {
                        inner: out,
                        total_written: &mut counters.written_bytes,
                        max_bytes: max_extract_bytes,
                        cancel_flag,
                        on_bytes: &mut on_bytes_written,
                    };
                    stream_iso_entry(&mut file, &item, &mut bounded, cancel_flag).map_err(|e| {
                        if e.message.contains("WINKIT_ARCHIVE_LIMIT_EXCEEDED") {
                            AppError::size_limit(
                                "Archive extraction exceeded the maximum safe output byte limit.",
                            )
                        } else {
                            e
                        }
                    })?;
                    counters.extracted_files += 1;
                }
            }
        }
    }

    Ok(counters)
}

fn extract_tar_stream<R: Read>(
    reader: R,
    staging_dir: &Path,
    skip_macos_metadata: bool,
    max_extract_bytes: u64,
    cancel_flag: &AtomicBool,
    counters: &mut ExtractCounters,
    on_bytes_written: &mut dyn FnMut(u64),
) -> Result<(), AppError> {
    let mut tar = TarArchive::new(reader);
    let iter = tar
        .entries()
        .map_err(|e| AppError::decode_failed(format!("Invalid TAR stream: {e}")))?;

    for item_res in iter {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(AppError::cancelled());
        }
        let mut entry =
            item_res.map_err(|e| AppError::decode_failed(format!("Corrupt TAR entry: {e}")))?;
        let kind = entry.header().entry_type();
        let raw_name = entry
            .path()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        if raw_name.is_empty() {
            continue;
        }
        if (skip_macos_metadata && is_macos_junk_path(&raw_name))
            || matches!(
                kind,
                EntryType::Symlink
                    | EntryType::Link
                    | EntryType::Char
                    | EntryType::Block
                    | EntryType::Fifo
            )
        {
            counters.skipped_entries += 1;
            continue;
        }
        if kind == EntryType::Directory {
            counters.prepare_dir_path(staging_dir, &raw_name)?;
            continue;
        }
        if !kind.is_file() {
            counters.skipped_entries += 1;
            continue;
        }

        if let Some(target_file) = counters.prepare_file_path(staging_dir, &raw_name)? {
            let out = File::create(&target_file)
                .map_err(|e| AppError::from_io(e, "Cannot create TAR extracted file"))?;
            let mut bounded = BoundedExtractWriter {
                inner: out,
                total_written: &mut counters.written_bytes,
                max_bytes: max_extract_bytes,
                cancel_flag,
                on_bytes: on_bytes_written,
            };
            copy_stream_bounded(&mut entry, &mut bounded)?;
            counters.extracted_files += 1;
        }
    }
    Ok(())
}

pub fn extract_archives_batch_with_limit<F>(
    task_id: &str,
    req: &ExtractArchivesRequest,
    max_extract_bytes_per_archive: u64,
    cancel_flag: &AtomicBool,
    mut on_progress: F,
) -> Result<ExtractArchivesBatchResponse, AppError>
where
    F: FnMut(&ArchiveProgressPayload),
{
    if req.archive_paths.is_empty() {
        return Err(AppError::invalid_param(
            "Select at least one archive to extract.",
        ));
    }

    let out_parent = validate_user_path(&req.output_parent_dir, "Output folder")?;
    let out_meta = fs::symlink_metadata(&out_parent)
        .map_err(|e| AppError::from_io(e, "Cannot access output folder"))?;
    if is_reparse_point_meta(&out_meta) || !out_meta.is_dir() {
        return Err(AppError::invalid_param(
            "Selected output path must be an existing regular folder.",
        ));
    }

    let total_items = req.archive_paths.len();
    let mut batch_claimed: HashSet<String> = HashSet::new();
    let mut reports: Vec<ArchiveExtractItemReport> = Vec::with_capacity(total_items);
    let mut succeeded_count = 0usize;
    let mut failed_count = 0usize;
    let mut cancelled = false;

    for (idx, raw_arc) in req.archive_paths.iter().enumerate() {
        let arc_path = match validate_user_path(raw_arc, "Archive") {
            Ok(p) => p,
            Err(err) => {
                failed_count += 1;
                reports.push(ArchiveExtractItemReport {
                    archive_path: raw_arc.clone(),
                    archive_name: raw_arc.clone(),
                    format: None,
                    status: ArchiveExtractStatus::Error,
                    output_dir: None,
                    extracted_files: 0,
                    extracted_dirs: 0,
                    skipped_entries: 0,
                    written_bytes: 0,
                    message: Some(err.message),
                });
                continue;
            }
        };
        let arc_name = arc_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| raw_arc.clone());

        if cancel_flag.load(Ordering::Relaxed) {
            cancelled = true;
            reports.push(ArchiveExtractItemReport {
                archive_path: raw_arc.clone(),
                archive_name: arc_name,
                format: None,
                status: ArchiveExtractStatus::Cancelled,
                output_dir: None,
                extracted_files: 0,
                extracted_dirs: 0,
                skipped_entries: 0,
                written_bytes: 0,
                message: Some("Cancelled before extraction started.".to_string()),
            });
            continue;
        }

        let format = match detect_archive_format(&arc_path) {
            Ok(f) => f,
            Err(err) => {
                failed_count += 1;
                reports.push(ArchiveExtractItemReport {
                    archive_path: raw_arc.clone(),
                    archive_name: arc_name,
                    format: None,
                    status: ArchiveExtractStatus::Error,
                    output_dir: None,
                    extracted_files: 0,
                    extracted_dirs: 0,
                    skipped_entries: 0,
                    written_bytes: 0,
                    message: Some(err.message),
                });
                continue;
            }
        };

        let base_folder = strip_archive_stem(&arc_name, format);
        let final_dest = match choose_destination_folder(
            &out_parent,
            &base_folder,
            req.conflict_policy,
            &mut batch_claimed,
        ) {
            Ok(dest) => dest,
            Err(err) => {
                failed_count += 1;
                reports.push(ArchiveExtractItemReport {
                    archive_path: raw_arc.clone(),
                    archive_name: arc_name,
                    format: Some(format),
                    status: ArchiveExtractStatus::Conflict,
                    output_dir: None,
                    extracted_files: 0,
                    extracted_dirs: 0,
                    skipped_entries: 0,
                    written_bytes: 0,
                    message: Some(err.message),
                });
                continue;
            }
        };

        let staging_dir = match allocate_staging_dir(&out_parent, idx) {
            Ok(d) => d,
            Err(err) => {
                failed_count += 1;
                reports.push(ArchiveExtractItemReport {
                    archive_path: raw_arc.clone(),
                    archive_name: arc_name,
                    format: Some(format),
                    status: ArchiveExtractStatus::Error,
                    output_dir: None,
                    extracted_files: 0,
                    extracted_dirs: 0,
                    skipped_entries: 0,
                    written_bytes: 0,
                    message: Some(err.message),
                });
                continue;
            }
        };
        let mut cleanup = StagingCleanupGuard::new(staging_dir.clone());

        let password = req
            .passwords
            .get(raw_arc)
            .or_else(|| req.passwords.get(&arc_path.to_string_lossy().into_owned()))
            .map(String::as_str);

        let mut last_emit = Instant::now();
        on_progress(&ArchiveProgressPayload {
            task_id: task_id.to_string(),
            operation: "extract",
            current_index: idx + 1,
            total_items,
            current_item: arc_name.clone(),
            processed_bytes: 0,
            total_bytes: None,
        });

        let res = extract_single_archive_to_staging(
            &arc_path,
            &arc_name,
            format,
            &staging_dir,
            password,
            req.skip_macos_metadata,
            max_extract_bytes_per_archive,
            cancel_flag,
            |written| {
                if last_emit.elapsed().as_millis() >= 80 {
                    last_emit = Instant::now();
                    on_progress(&ArchiveProgressPayload {
                        task_id: task_id.to_string(),
                        operation: "extract",
                        current_index: idx + 1,
                        total_items,
                        current_item: arc_name.clone(),
                        processed_bytes: written,
                        total_bytes: None,
                    });
                }
            },
        );

        match res {
            Ok(counters) => {
                match move_path_no_overwrite(
                    &staging_dir,
                    &final_dest,
                    "Commit extracted archive directory",
                ) {
                    Ok(()) => {
                        cleanup.mark_committed();
                        succeeded_count += 1;
                        reports.push(ArchiveExtractItemReport {
                            archive_path: raw_arc.clone(),
                            archive_name: arc_name,
                            format: Some(format),
                            status: ArchiveExtractStatus::Extracted,
                            output_dir: Some(final_dest.to_string_lossy().into_owned()),
                            extracted_files: counters.extracted_files,
                            extracted_dirs: counters.extracted_dirs,
                            skipped_entries: counters.skipped_entries,
                            written_bytes: counters.written_bytes,
                            message: None,
                        });
                    }
                    Err(commit_err) => {
                        // `cleanup` drop deletes staging_dir while preserving pre-existing final_dest!
                        failed_count += 1;
                        let st = if commit_err.code == "TARGET_ALREADY_EXISTS" {
                            ArchiveExtractStatus::Conflict
                        } else {
                            ArchiveExtractStatus::Error
                        };
                        reports.push(ArchiveExtractItemReport {
                            archive_path: raw_arc.clone(),
                            archive_name: arc_name,
                            format: Some(format),
                            status: st,
                            output_dir: None,
                            extracted_files: 0,
                            extracted_dirs: 0,
                            skipped_entries: 0,
                            written_bytes: 0,
                            message: Some(commit_err.message),
                        });
                    }
                }
            }
            Err(err) => {
                // `cleanup` drop cleans up all temporary files from this failed/cancelled archive!
                let status = match err.code {
                    "TASK_CANCELLED" => {
                        cancelled = true;
                        ArchiveExtractStatus::Cancelled
                    }
                    "ARCHIVE_NEEDS_PASSWORD" => {
                        failed_count += 1;
                        ArchiveExtractStatus::NeedsPassword
                    }
                    "ARCHIVE_WRONG_PASSWORD" => {
                        failed_count += 1;
                        ArchiveExtractStatus::WrongPassword
                    }
                    "TARGET_ALREADY_EXISTS" => {
                        failed_count += 1;
                        ArchiveExtractStatus::Conflict
                    }
                    _ => {
                        failed_count += 1;
                        ArchiveExtractStatus::Error
                    }
                };
                reports.push(ArchiveExtractItemReport {
                    archive_path: raw_arc.clone(),
                    archive_name: arc_name,
                    format: Some(format),
                    status,
                    output_dir: None,
                    extracted_files: 0,
                    extracted_dirs: 0,
                    skipped_entries: 0,
                    written_bytes: 0,
                    message: Some(err.message),
                });
            }
        }
    }

    Ok(ExtractArchivesBatchResponse {
        task_id: task_id.to_string(),
        output_parent_dir: out_parent.to_string_lossy().into_owned(),
        cancelled,
        succeeded_count,
        failed_count,
        items: reports,
    })
}

#[derive(Debug)]
struct CreateArchiveSourceItem {
    disk_path: PathBuf,
    archive_rel_path: String,
    is_dir: bool,
    byte_length: u64,
}

fn collect_create_archive_items(
    raw_sources: &[String],
    output_path: &Path,
) -> Result<(Vec<CreateArchiveSourceItem>, usize, u64), AppError> {
    let mut items: Vec<CreateArchiveSourceItem> = Vec::new();
    let mut seen_archive_slots: HashSet<String> = HashSet::new();
    let mut seen_disk_paths: HashSet<String> = HashSet::new();
    let mut skipped_count = 0usize;
    let mut total_bytes = 0u64;

    for raw in raw_sources {
        if raw.trim().is_empty() {
            continue;
        }
        let src_path = validate_user_path(raw, "Source")?;
        if paths_refer_to_same_location(&src_path, output_path) {
            return Err(AppError::same_input_output());
        }
        let meta = fs::symlink_metadata(&src_path)
            .map_err(|e| AppError::from_io(e, "Cannot inspect source item"))?;
        if is_reparse_point_meta(&meta) {
            skipped_count += 1;
            continue;
        }
        let disk_key = fs::canonicalize(&src_path)
            .unwrap_or_else(|_| src_path.clone())
            .to_string_lossy()
            .to_lowercase();
        if !seen_disk_paths.insert(disk_key) {
            continue;
        }

        let root_name = src_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| AppError::invalid_param("Cannot determine source filename."))?;

        if meta.is_file() {
            let slot = root_name.to_lowercase();
            if !seen_archive_slots.insert(slot) {
                return Err(AppError::invalid_param(format!(
                    "Duplicate top-level filename \"{root_name}\" in archive selection."
                )));
            }
            let len = meta.len();
            total_bytes = total_bytes.saturating_add(len);
            items.push(CreateArchiveSourceItem {
                disk_path: src_path,
                archive_rel_path: root_name,
                is_dir: false,
                byte_length: len,
            });
            continue;
        }

        if meta.is_dir() {
            // Prevent writing output archive inside a directory being compressed (infinite recursion!)
            if let Ok(canon_dir) = fs::canonicalize(&src_path) {
                if let Some(out_parent) = output_path.parent() {
                    if let Ok(canon_out_parent) = fs::canonicalize(out_parent) {
                        if canon_out_parent.starts_with(&canon_dir) {
                            return Err(AppError::invalid_param(
                                "Output archive cannot be saved inside one of the folders being compressed.",
                            ));
                        }
                    }
                }
            }

            let root_slot = root_name.to_lowercase();
            if !seen_archive_slots.insert(root_slot) {
                return Err(AppError::invalid_param(format!(
                    "Duplicate top-level folder name \"{root_name}\" in archive selection."
                )));
            }

            let mut dir_stack: Vec<(PathBuf, String)> = vec![(src_path, root_name)];
            while let Some((cur_dir, cur_rel)) = dir_stack.pop() {
                items.push(CreateArchiveSourceItem {
                    disk_path: cur_dir.clone(),
                    archive_rel_path: cur_rel.clone(),
                    is_dir: true,
                    byte_length: 0,
                });

                let rd = fs::read_dir(&cur_dir)
                    .map_err(|e| AppError::from_io(e, "Cannot read source folder"))?;
                let mut children: Vec<(PathBuf, String)> = Vec::new();
                for entry_res in rd {
                    let entry =
                        entry_res.map_err(|e| AppError::from_io(e, "Cannot read folder entry"))?;
                    let name = entry.file_name().to_string_lossy().into_owned();
                    children.push((entry.path(), name));
                }
                children.sort_by_key(|c| c.1.to_lowercase());

                let mut subdirs: Vec<(PathBuf, String)> = Vec::new();
                for (child_path, child_name) in children {
                    let child_meta = match fs::symlink_metadata(&child_path) {
                        Ok(m) => m,
                        Err(_) => {
                            skipped_count += 1;
                            continue;
                        }
                    };
                    if is_reparse_point_meta(&child_meta) {
                        skipped_count += 1;
                        continue;
                    }
                    let child_rel = format!("{cur_rel}/{child_name}");
                    if child_meta.is_dir() {
                        subdirs.push((child_path, child_rel));
                    } else if child_meta.is_file() {
                        let len = child_meta.len();
                        total_bytes = total_bytes.saturating_add(len);
                        items.push(CreateArchiveSourceItem {
                            disk_path: child_path,
                            archive_rel_path: child_rel,
                            is_dir: false,
                            byte_length: len,
                        });
                    }
                }
                for sub in subdirs.into_iter().rev() {
                    dir_stack.push(sub);
                }
            }
        }
    }

    if items.is_empty() {
        return Err(AppError::invalid_param(
            "No regular files or folders were found to archive.",
        ));
    }
    Ok((items, skipped_count, total_bytes))
}

struct TempFileCleanupGuard {
    path: PathBuf,
    committed: bool,
}

impl Drop for TempFileCleanupGuard {
    fn drop(&mut self) {
        if !self.committed && self.path.exists() {
            let _ = fs::remove_file(&self.path);
        }
    }
}

pub fn create_archive_impl<F>(
    task_id: &str,
    req: &CreateArchiveRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: F,
) -> Result<CreateArchiveResponse, AppError>
where
    F: FnMut(&ArchiveProgressPayload),
{
    if req.source_paths.is_empty() {
        return Err(AppError::invalid_param(
            "Select at least one file or folder to compress.",
        ));
    }
    let output_path = validate_user_path(&req.output_path, "Output archive")?;
    let output_parent = output_path
        .parent()
        .ok_or_else(|| AppError::invalid_param("Output archive has no parent folder."))?
        .to_path_buf();
    if !output_parent.is_dir() {
        return Err(AppError::invalid_param(
            "Output archive parent folder does not exist.",
        ));
    }
    if fs::symlink_metadata(&output_path).is_ok() && !req.overwrite {
        return Err(AppError::target_exists());
    }

    let password_str = req.password.as_deref().unwrap_or("");
    if matches!(
        req.format,
        ArchiveCreateFormat::ZipAes256 | ArchiveCreateFormat::ZipZipcrypto
    ) && password_str.is_empty()
    {
        return Err(AppError::invalid_param(
            "Password is required for encrypted ZIP archives.",
        ));
    }

    let (items, skipped_count, total_input_bytes) =
        collect_create_archive_items(&req.source_paths, &output_path)?;

    let pid = std::process::id();
    let seq = ARCHIVE_TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let temp_path = output_parent.join(format!(".winkit-arc-{pid}-{seq:x}.tmp"));
    let mut temp_guard = TempFileCleanupGuard {
        path: temp_path.clone(),
        committed: false,
    };

    let mut processed_bytes = 0u64;
    let mut last_emit = Instant::now();
    let total_items = items.len();
    let mut buf = vec![0u8; STREAM_BUF_BYTES];

    let out_format = match req.format {
        ArchiveCreateFormat::Zip
        | ArchiveCreateFormat::ZipAes256
        | ArchiveCreateFormat::ZipZipcrypto => {
            let out_file = File::create(&temp_path)
                .map_err(|e| AppError::from_io(e, "Cannot create temporary ZIP file"))?;
            let mut zip = ZipWriter::new(out_file);

            for (idx, item) in items.iter().enumerate() {
                if cancel_flag.load(Ordering::Relaxed) {
                    return Err(AppError::cancelled());
                }

                if item.is_dir {
                    let dir_name = format!("{}/", item.archive_rel_path.trim_end_matches('/'));
                    let opts =
                        SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
                    zip.add_directory(&dir_name, opts).map_err(|e| {
                        AppError::decode_failed(format!("Failed adding ZIP folder: {e}"))
                    })?;
                    continue;
                }

                let base_opts = SimpleFileOptions::default()
                    .compression_method(CompressionMethod::Deflated)
                    .large_file(item.byte_length >= 0xFFFF_FFFF);

                let opts = match req.format {
                    ArchiveCreateFormat::Zip => base_opts,
                    ArchiveCreateFormat::ZipAes256 => {
                        base_opts.with_aes_encryption(AesMode::Aes256, password_str)
                    }
                    ArchiveCreateFormat::ZipZipcrypto => base_opts
                        .with_deprecated_encryption(password_str.as_bytes())
                        .map_err(|e| {
                            AppError::invalid_param(format!("ZipCrypto option error: {e}"))
                        })?,
                    ArchiveCreateFormat::TarGz => unreachable!(),
                };

                zip.start_file(&item.archive_rel_path, opts).map_err(|e| {
                    AppError::decode_failed(format!("Failed starting ZIP file entry: {e}"))
                })?;

                let mut src = File::open(&item.disk_path)
                    .map_err(|e| AppError::from_io(e, "Cannot read source file for ZIP"))?;
                loop {
                    if cancel_flag.load(Ordering::Relaxed) {
                        return Err(AppError::cancelled());
                    }
                    let n = src
                        .read(&mut buf)
                        .map_err(|e| AppError::from_io(e, "Error reading source file"))?;
                    if n == 0 {
                        break;
                    }
                    zip.write_all(&buf[..n])
                        .map_err(|e| AppError::from_io(e, "Error writing ZIP entry"))?;
                    processed_bytes = processed_bytes.saturating_add(n as u64);
                    if last_emit.elapsed().as_millis() >= 80 {
                        last_emit = Instant::now();
                        on_progress(&ArchiveProgressPayload {
                            task_id: task_id.to_string(),
                            operation: "create",
                            current_index: idx + 1,
                            total_items,
                            current_item: item.archive_rel_path.clone(),
                            processed_bytes,
                            total_bytes: Some(total_input_bytes),
                        });
                    }
                }
            }

            let mut inner = zip
                .finish()
                .map_err(|e| AppError::decode_failed(format!("Failed finalizing ZIP: {e}")))?;
            inner
                .flush()
                .map_err(|e| AppError::from_io(e, "Failed flushing ZIP file"))?;
            ArchiveFormat::Zip
        }
        ArchiveCreateFormat::TarGz => {
            let out_file = File::create(&temp_path)
                .map_err(|e| AppError::from_io(e, "Cannot create temporary TAR.GZ file"))?;
            let gz = GzEncoder::new(out_file, Compression::default());
            let mut tar_builder = TarBuilder::new(gz);

            for (idx, item) in items.iter().enumerate() {
                if cancel_flag.load(Ordering::Relaxed) {
                    return Err(AppError::cancelled());
                }
                if item.is_dir {
                    tar_builder
                        .append_dir(&item.archive_rel_path, &item.disk_path)
                        .map_err(|e| AppError::from_io(e, "Failed adding TAR folder"))?;
                    continue;
                }
                let mut src = File::open(&item.disk_path)
                    .map_err(|e| AppError::from_io(e, "Cannot read source file for TAR.GZ"))?;
                tar_builder
                    .append_file(&item.archive_rel_path, &mut src)
                    .map_err(|e| AppError::from_io(e, "Failed writing TAR.GZ entry"))?;
                processed_bytes = processed_bytes.saturating_add(item.byte_length);
                if last_emit.elapsed().as_millis() >= 80 {
                    last_emit = Instant::now();
                    on_progress(&ArchiveProgressPayload {
                        task_id: task_id.to_string(),
                        operation: "create",
                        current_index: idx + 1,
                        total_items,
                        current_item: item.archive_rel_path.clone(),
                        processed_bytes,
                        total_bytes: Some(total_input_bytes),
                    });
                }
            }

            let gz = tar_builder
                .into_inner()
                .map_err(|e| AppError::from_io(e, "Failed finalizing TAR stream"))?;
            let mut out_file = gz
                .finish()
                .map_err(|e| AppError::from_io(e, "Failed finalizing GZ stream"))?;
            out_file
                .flush()
                .map_err(|e| AppError::from_io(e, "Failed flushing TAR.GZ file"))?;
            ArchiveFormat::TarGz
        }
    };

    if req.overwrite && fs::symlink_metadata(&output_path).is_ok() {
        fs::rename(&temp_path, &output_path)
            .map_err(|e| AppError::from_io(e, "Cannot replace target archive"))?;
    } else {
        move_path_no_overwrite(&temp_path, &output_path, "Commit created archive")?;
    }
    temp_guard.committed = true;

    let output_byte_length = fs::metadata(&output_path).map(|m| m.len()).unwrap_or(0);

    Ok(CreateArchiveResponse {
        task_id: task_id.to_string(),
        output_path: output_path.to_string_lossy().into_owned(),
        output_parent_dir: output_parent.to_string_lossy().into_owned(),
        format: out_format,
        entry_count: items.len(),
        skipped_count,
        output_byte_length,
    })
}

/// Safely opens an existing local non-reparse directory in Windows Explorer.
pub fn open_local_directory_impl(raw_dir: &str) -> Result<(), AppError> {
    let dir_path = validate_user_path(raw_dir, "Directory")?;
    let meta = fs::symlink_metadata(&dir_path)
        .map_err(|e| AppError::from_io(e, "Cannot access folder to open"))?;
    if is_reparse_point_meta(&meta) || !meta.is_dir() {
        return Err(AppError::invalid_param(
            "Only existing regular local folders can be opened in File Explorer.",
        ));
    }

    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let verb_w: Vec<u16> = "explore\0".encode_utf16().collect();
        let path_w: Vec<u16> = dir_path.as_os_str().encode_wide().chain(Some(0)).collect();
        let ret = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb_w.as_ptr(),
                path_w.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        if (ret as isize) <= 32 {
            return Err(AppError::new(
                "OPEN_FOLDER_FAILED",
                "Windows File Explorer could not open the selected directory.",
            ));
        }
        Ok(())
    }

    #[cfg(not(windows))]
    {
        let _ = dir_path;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::process::Command;
    use tempfile::tempdir;

    fn sha256_file(path: &Path) -> String {
        let data = fs::read(path).expect("read file");
        let digest = Sha256::digest(&data);
        digest.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn roundtrip_unicode_nested_empty_zip_aes256_zipcrypto_and_targz_with_external_tool_verification(
    ) {
        let dir = tempdir().expect("tempdir");
        let src_root = dir.path().join("资料包_中文");
        let nested = src_root.join("子目录").join("空目录");
        fs::create_dir_all(&nested).expect("mkdir nested");

        let f_cn = src_root.join("报告_2026.txt");
        let f_empty = src_root.join("子目录").join("空文件.txt");
        fs::write(&f_cn, "WinKit F04 中文内容校验 12345\n".as_bytes()).expect("write cn");
        fs::write(&f_empty, b"").expect("write empty");

        let expected_cn_hash = sha256_file(&f_cn);
        let expected_empty_hash = sha256_file(&f_empty);
        let cancel = AtomicBool::new(false);

        // 1) Normal ZIP + AES-256 ZIP + ZipCrypto ZIP + TAR.GZ
        for (fname, fmt, pw) in [
            ("normal.zip", ArchiveCreateFormat::Zip, None),
            (
                "aes256.zip",
                ArchiveCreateFormat::ZipAes256,
                Some("Pass#2026!"),
            ),
            (
                "zipcrypto.zip",
                ArchiveCreateFormat::ZipZipcrypto,
                Some("Compat#2026"),
            ),
            ("bundle.tar.gz", ArchiveCreateFormat::TarGz, None),
        ] {
            let out_arc = dir.path().join(fname);
            let created = create_archive_impl(
                "test-create",
                &CreateArchiveRequest {
                    source_paths: vec![src_root.to_string_lossy().into_owned()],
                    output_path: out_arc.to_string_lossy().into_owned(),
                    format: fmt,
                    password: pw.map(str::to_string),
                    overwrite: false,
                },
                &cancel,
                |_| {},
            )
            .expect("create archive succeeds");
            assert!(created.output_byte_length > 0);

            // Preview
            let preview = inspect_archive_impl(&created.output_path, pw).expect("preview");
            assert!(preview.total_entries >= 4);
            if pw.is_some() {
                assert!(preview.needs_password);
            }

            // Wrong password check for encrypted ZIPs -> must fail cleanly, zero leftover staging!
            let out_dir = dir.path().join(format!("out_{fname}"));
            fs::create_dir_all(&out_dir).expect("mkdir out");
            if let Some(real_pw) = pw {
                let mut wrong_map = HashMap::new();
                wrong_map.insert(created.output_path.clone(), "WRONG_PW".to_string());
                let bad_res = extract_archives_batch_with_limit(
                    "test-bad-pw",
                    &ExtractArchivesRequest {
                        archive_paths: vec![created.output_path.clone()],
                        output_parent_dir: out_dir.to_string_lossy().into_owned(),
                        passwords: wrong_map,
                        skip_macos_metadata: true,
                        conflict_policy: ExtractConflictPolicy::UniqueFolder,
                    },
                    DEFAULT_MAX_EXTRACT_BYTES_PER_ARCHIVE,
                    &cancel,
                    |_| {},
                )
                .expect("batch runs");
                assert_eq!(bad_res.items[0].status, ArchiveExtractStatus::WrongPassword);
                assert_eq!(
                    fs::read_dir(&out_dir).expect("rd").count(),
                    0,
                    "staging temp folder must be cleaned up on wrong password"
                );

                // Retry with correct password!
                let mut ok_map = HashMap::new();
                ok_map.insert(created.output_path.clone(), real_pw.to_string());
                let ok_res = extract_archives_batch_with_limit(
                    "test-ok-pw",
                    &ExtractArchivesRequest {
                        archive_paths: vec![created.output_path.clone()],
                        output_parent_dir: out_dir.to_string_lossy().into_owned(),
                        passwords: ok_map,
                        skip_macos_metadata: true,
                        conflict_policy: ExtractConflictPolicy::UniqueFolder,
                    },
                    DEFAULT_MAX_EXTRACT_BYTES_PER_ARCHIVE,
                    &cancel,
                    |_| {},
                )
                .expect("retry succeeds");
                assert_eq!(ok_res.items[0].status, ArchiveExtractStatus::Extracted);
                let dest = PathBuf::from(ok_res.items[0].output_dir.as_ref().unwrap());
                assert_eq!(
                    sha256_file(&dest.join("资料包_中文").join("报告_2026.txt")),
                    expected_cn_hash
                );
                assert_eq!(
                    sha256_file(&dest.join("资料包_中文").join("子目录").join("空文件.txt")),
                    expected_empty_hash
                );
                assert!(dest
                    .join("资料包_中文")
                    .join("子目录")
                    .join("空目录")
                    .is_dir());
            } else {
                let ok_res = extract_archives_batch_with_limit(
                    "test-plain",
                    &ExtractArchivesRequest {
                        archive_paths: vec![created.output_path.clone()],
                        output_parent_dir: out_dir.to_string_lossy().into_owned(),
                        passwords: HashMap::new(),
                        skip_macos_metadata: true,
                        conflict_policy: ExtractConflictPolicy::UniqueFolder,
                    },
                    DEFAULT_MAX_EXTRACT_BYTES_PER_ARCHIVE,
                    &cancel,
                    |_| {},
                )
                .expect("extract plain");
                assert_eq!(ok_res.items[0].status, ArchiveExtractStatus::Extracted);
                let dest = PathBuf::from(ok_res.items[0].output_dir.as_ref().unwrap());
                assert_eq!(
                    sha256_file(&dest.join("资料包_中文").join("报告_2026.txt")),
                    expected_cn_hash
                );
                assert_eq!(
                    sha256_file(&dest.join("资料包_中文").join("子目录").join("空文件.txt")),
                    expected_empty_hash
                );
            }
        }

        // Verify independent Windows bsdtar can list WinKit's created normal.zip & bundle.tar.gz & aes256.zip!
        #[cfg(windows)]
        {
            for name in ["normal.zip", "bundle.tar.gz", "aes256.zip", "zipcrypto.zip"] {
                let status = Command::new("tar")
                    .arg("-tf")
                    .arg(dir.path().join(name))
                    .status()
                    .expect("run host tar");
                assert!(status.success(), "host bsdtar failed listing {name}");
            }
            // Also verify independent host bsdtar actually extracts WinKit's AES-256 ZIP using `--passphrase`!
            let ext_aes_dir = dir.path().join("bsdtar_aes_verify");
            fs::create_dir_all(&ext_aes_dir).expect("mkdir");
            let ext_out = Command::new("tar")
                .args(["--passphrase", "Pass#2026!", "-xf"])
                .arg(dir.path().join("aes256.zip"))
                .arg("-C")
                .arg(&ext_aes_dir)
                .output()
                .expect("run host bsdtar extract aes256");
            assert!(
                ext_out.status.success(),
                "independent bsdtar failed decrypting WinKit AES-256 ZIP: {}",
                String::from_utf8_lossy(&ext_out.stderr)
            );
            assert_eq!(
                sha256_file(&ext_aes_dir.join("资料包_中文").join("报告_2026.txt")),
                expected_cn_hash
            );
        }
    }

    #[test]
    fn reads_external_bsdtar_7z_tar_xz_bz2_iso_single_streams_and_independent_rar4_rar5_fixtures() {
        let dir = tempdir().expect("tempdir");
        let cancel = AtomicBool::new(false);

        // 1) Independent BSD-2-Clause RAR4 (with symlink) and RAR5 fixtures from libarchive
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let fix_dir = manifest_dir
            .join("..")
            .join("tests")
            .join("fixtures")
            .join("f04");
        let rar4 = fix_dir.join("sample_rar4.rar");
        let rar5 = fix_dir.join("sample_rar5.rar");
        if rar4.exists() && rar5.exists() {
            let p4 = inspect_archive_impl(&rar4.to_string_lossy(), None).expect("preview rar4");
            assert_eq!(p4.format, ArchiveFormat::Rar);
            assert!(p4.entries.iter().any(|e| e.is_symlink));

            let p5 = inspect_archive_impl(&rar5.to_string_lossy(), None).expect("preview rar5");
            assert_eq!(p5.format, ArchiveFormat::Rar);
            assert_eq!(p5.total_entries, 1);

            let out_rar = dir.path().join("out_rar");
            fs::create_dir_all(&out_rar).expect("mkdir");
            let res = extract_archives_batch_with_limit(
                "test-rar",
                &ExtractArchivesRequest {
                    archive_paths: vec![
                        rar4.to_string_lossy().into_owned(),
                        rar5.to_string_lossy().into_owned(),
                    ],
                    output_parent_dir: out_rar.to_string_lossy().into_owned(),
                    passwords: HashMap::new(),
                    skip_macos_metadata: true,
                    conflict_policy: ExtractConflictPolicy::UniqueFolder,
                },
                DEFAULT_MAX_EXTRACT_BYTES_PER_ARCHIVE,
                &cancel,
                |_| {},
            )
            .expect("extract rar4+rar5");
            assert_eq!(res.succeeded_count, 2);
            // Symlink in RAR4 was skipped safely (not materialized!)
            assert!(res.items[0].skipped_entries >= 1);
            let r4_dir = PathBuf::from(res.items[0].output_dir.as_ref().unwrap());
            assert!(r4_dir.join("test.txt").is_file());
            assert!(!r4_dir.join("testlink").exists());
            let r5_dir = PathBuf::from(res.items[1].output_dir.as_ref().unwrap());
            assert_eq!(
                fs::read_to_string(r5_dir.join("helloworld.txt")).expect("read rar5"),
                "hello libarchive test suite!\n"
            );
        }

        // 2) External bsdtar-generated 7z, tar.xz, tar.bz2, iso, plus standalone .gz/.xz/.bz2
        #[cfg(windows)]
        {
            let sample_src = dir.path().join("ext_sample.txt");
            fs::write(&sample_src, b"External independent sample content 2026!").expect("write");
            let sample_hash = sha256_file(&sample_src);

            let arc_7z = dir.path().join("ext.7z");
            let arc_txz = dir.path().join("ext.tar.xz");
            let arc_tbz2 = dir.path().join("ext.tar.bz2");
            let arc_iso = dir.path().join("ext.iso");
            assert!(Command::new("tar")
                .args(["-a", "-cf"])
                .arg(&arc_7z)
                .arg("-C")
                .arg(dir.path())
                .arg("ext_sample.txt")
                .status()
                .expect("bsdtar 7z")
                .success());
            assert!(Command::new("tar")
                .args(["-cJf"])
                .arg(&arc_txz)
                .arg("-C")
                .arg(dir.path())
                .arg("ext_sample.txt")
                .status()
                .expect("bsdtar txz")
                .success());
            assert!(Command::new("tar")
                .args(["-cjf"])
                .arg(&arc_tbz2)
                .arg("-C")
                .arg(dir.path())
                .arg("ext_sample.txt")
                .status()
                .expect("bsdtar tbz2")
                .success());
            assert!(Command::new("tar")
                .args(["--format", "iso9660", "-cf"])
                .arg(&arc_iso)
                .arg("-C")
                .arg(dir.path())
                .arg("ext_sample.txt")
                .status()
                .expect("bsdtar iso")
                .success());

            // Standalone single-file .gz stream (distinguished from .tar.gz!)
            let single_gz = dir.path().join("alone.txt.gz");
            {
                let mut enc =
                    GzEncoder::new(File::create(&single_gz).unwrap(), Compression::default());
                enc.write_all(b"External independent sample content 2026!")
                    .unwrap();
                enc.finish().unwrap();
            }

            let out_ext = dir.path().join("out_ext");
            fs::create_dir_all(&out_ext).expect("mkdir out_ext");
            let batch = extract_archives_batch_with_limit(
                "test-ext",
                &ExtractArchivesRequest {
                    archive_paths: vec![
                        arc_7z.to_string_lossy().into_owned(),
                        arc_txz.to_string_lossy().into_owned(),
                        arc_tbz2.to_string_lossy().into_owned(),
                        arc_iso.to_string_lossy().into_owned(),
                        single_gz.to_string_lossy().into_owned(),
                    ],
                    output_parent_dir: out_ext.to_string_lossy().into_owned(),
                    passwords: HashMap::new(),
                    skip_macos_metadata: true,
                    conflict_policy: ExtractConflictPolicy::UniqueFolder,
                },
                DEFAULT_MAX_EXTRACT_BYTES_PER_ARCHIVE,
                &cancel,
                |_| {},
            )
            .expect("extract external formats");
            assert_eq!(batch.succeeded_count, 5, "items: {:?}", batch.items);
            assert_eq!(batch.items[4].format, Some(ArchiveFormat::SingleGz));
            let gz_dir = PathBuf::from(batch.items[4].output_dir.as_ref().unwrap());
            assert_eq!(sha256_file(&gz_dir.join("alone.txt")), sample_hash);
            let iso_dir = PathBuf::from(batch.items[3].output_dir.as_ref().unwrap());
            let iso_file = fs::read_dir(&iso_dir)
                .expect("rd iso")
                .next()
                .expect("iso file")
                .expect("entry")
                .path();
            assert_eq!(sha256_file(&iso_file), sample_hash);
        }
    }

    #[test]
    fn isolates_same_name_archives_protects_existing_output_blocks_zip_slip_skips_macos_junk_and_enforces_written_cap(
    ) {
        let dir = tempdir().expect("tempdir");
        let dir_a = dir.path().join("from_a");
        let dir_b = dir.path().join("from_b");
        fs::create_dir_all(&dir_a).expect("mkdir a");
        fs::create_dir_all(&dir_b).expect("mkdir b");

        // Two same-named archives `pack.zip` in different source directories
        let zip_a = dir_a.join("pack.zip");
        let zip_b = dir_b.join("pack.zip");
        {
            let mut z = ZipWriter::new(File::create(&zip_a).unwrap());
            let opts = SimpleFileOptions::default();
            z.start_file("a_only.txt", opts).unwrap();
            z.write_all(b"FROM_A").unwrap();
            z.start_file("__MACOSX/._a_only.txt", opts).unwrap();
            z.write_all(b"junk").unwrap();
            z.start_file(".DS_Store", opts).unwrap();
            z.write_all(b"junk2").unwrap();
            z.finish().unwrap();
        }
        {
            let mut z = ZipWriter::new(File::create(&zip_b).unwrap());
            let opts = SimpleFileOptions::default();
            z.start_file("b_only.txt", opts).unwrap();
            z.write_all(b"FROM_B").unwrap();
            z.finish().unwrap();
        }

        // Pre-existing file/folder `pack` in output directory must stay untouched!
        let out_parent = dir.path().join("dest");
        let existing_pack = out_parent.join("pack");
        fs::create_dir_all(&existing_pack).expect("mkdir existing pack");
        let sentinel = existing_pack.join("keep_existing.txt");
        fs::write(&sentinel, b"DO_NOT_OVERWRITE").expect("write sentinel");

        let cancel = AtomicBool::new(false);

        // 1) FailIfExists rejects overwriting existing `pack` cleanly
        let conflict_res = extract_archives_batch_with_limit(
            "test-conflict",
            &ExtractArchivesRequest {
                archive_paths: vec![zip_a.to_string_lossy().into_owned()],
                output_parent_dir: out_parent.to_string_lossy().into_owned(),
                passwords: HashMap::new(),
                skip_macos_metadata: true,
                conflict_policy: ExtractConflictPolicy::FailIfExists,
            },
            DEFAULT_MAX_EXTRACT_BYTES_PER_ARCHIVE,
            &cancel,
            |_| {},
        )
        .expect("conflict batch");
        assert_eq!(conflict_res.items[0].status, ArchiveExtractStatus::Conflict);
        assert_eq!(fs::read(&sentinel).unwrap(), b"DO_NOT_OVERWRITE");

        // 2) UniqueFolder isolates existing `pack`, `zip_a -> pack (2)`, `zip_b -> pack (3)`, and skips macOS junk!
        let unique_res = extract_archives_batch_with_limit(
            "test-unique",
            &ExtractArchivesRequest {
                archive_paths: vec![
                    zip_a.to_string_lossy().into_owned(),
                    zip_b.to_string_lossy().into_owned(),
                ],
                output_parent_dir: out_parent.to_string_lossy().into_owned(),
                passwords: HashMap::new(),
                skip_macos_metadata: true,
                conflict_policy: ExtractConflictPolicy::UniqueFolder,
            },
            DEFAULT_MAX_EXTRACT_BYTES_PER_ARCHIVE,
            &cancel,
            |_| {},
        )
        .expect("unique batch");
        assert_eq!(unique_res.succeeded_count, 2);
        assert_eq!(fs::read(&sentinel).unwrap(), b"DO_NOT_OVERWRITE");
        let d_a = PathBuf::from(unique_res.items[0].output_dir.as_ref().unwrap());
        let d_b = PathBuf::from(unique_res.items[1].output_dir.as_ref().unwrap());
        assert_ne!(d_a, d_b);
        assert_eq!(fs::read(d_a.join("a_only.txt")).unwrap(), b"FROM_A");
        assert!(!d_a.join("__MACOSX").exists());
        assert!(!d_a.join(".DS_Store").exists());
        assert_eq!(unique_res.items[0].skipped_entries, 2);
        assert_eq!(fs::read(d_b.join("b_only.txt")).unwrap(), b"FROM_B");

        // 3) Zip-Slip rejection + written-byte cap enforcement + cancellation cleanup
        assert!(validate_archive_relative_path("../escape.txt").is_err());
        assert!(validate_archive_relative_path("C:/Windows/evil.txt").is_err());
        assert!(validate_archive_relative_path("sub/CON.txt").is_err());

        let bomb_zip = dir.path().join("over_limit.zip");
        {
            let mut z = ZipWriter::new(File::create(&bomb_zip).unwrap());
            z.start_file("big.bin", SimpleFileOptions::default())
                .unwrap();
            z.write_all(&vec![0u8; 64 * 1024]).unwrap();
            z.finish().unwrap();
        }
        let bomb_out = dir.path().join("bomb_out");
        fs::create_dir_all(&bomb_out).expect("mkdir");
        let bomb_res = extract_archives_batch_with_limit(
            "test-bomb",
            &ExtractArchivesRequest {
                archive_paths: vec![bomb_zip.to_string_lossy().into_owned()],
                output_parent_dir: bomb_out.to_string_lossy().into_owned(),
                passwords: HashMap::new(),
                skip_macos_metadata: true,
                conflict_policy: ExtractConflictPolicy::UniqueFolder,
            },
            16 * 1024, // 16 KiB written limit
            &cancel,
            |_| {},
        )
        .expect("bomb batch");
        assert_eq!(bomb_res.items[0].status, ArchiveExtractStatus::Error);
        assert_eq!(
            fs::read_dir(&bomb_out).unwrap().count(),
            0,
            "staging directory must be cleaned up when written limit is exceeded"
        );
    }
}
