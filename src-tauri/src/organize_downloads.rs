//! F05 Organize Downloads (`下载图片按来源归档`) backend.
//!
//! Operates strictly on a user-selected local image folder, reads existing NTFS
//! `:Zone.Identifier` Alternate Data Streams (`HostUrl` / `ReferrerUrl`) locally to
//! extract only the lowercase hostname (discarding full URLs and query parameters),
//! supports domain-boundary CDN/site alias rules, detects already-organized images on
//! repeat runs, re-verifies every source file right before moving, and moves files
//! atomically on the same volume via `MoveFileExW(..., 0)` so original `ZoneId` and
//! `:Zone.Identifier` bytes remain intact and existing targets are never overwritten.

use crate::error::AppError;
use crate::fs_guard::validate_user_path;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_ADS_READ_BYTES: u64 = 16 * 1024;
const HASH_BUF_BYTES: usize = 128 * 1024;

const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "heic", "heif", "tif", "tiff", "ico", "svg",
];

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrganizeNamingMode {
    SiteAlias,
    DomainOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OrganizeItemStatus {
    Ready,
    AlreadyOrganized,
    NoSource,
    MetadataUnreadable,
    UnsupportedFs,
    ConflictExists,
    InvalidTarget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OrganizeItemAction {
    Move,
    StayInPlace,
    AlreadyOrganized,
    SkipConflict,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainMappingRuleInput {
    pub domain: String,
    pub site_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizePreviewRequest {
    pub folder_path: String,
    pub naming_mode: OrganizeNamingMode,
    pub move_unknown_to_folder: bool,
    pub unknown_folder_name: String,
    #[serde(default)]
    pub mappings: Vec<DomainMappingRuleInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizePreviewItem {
    pub source_path: String,
    pub file_name: String,
    pub byte_length: u64,
    pub modified_ms: Option<u64>,
    pub file_id_key: Option<String>,
    pub content_sha256: Option<String>,
    pub zone_id: Option<u32>,
    pub source_field: Option<&'static str>,
    pub detected_domain: Option<String>,
    pub mapped_site_name: Option<String>,
    pub target_folder_name: Option<String>,
    pub target_rel_path: Option<String>,
    pub status: OrganizeItemStatus,
    pub action: OrganizeItemAction,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizePreviewResponse {
    pub folder_path: String,
    pub volume_supports_ads: bool,
    pub total_image_count: usize,
    pub non_image_count: usize,
    pub ready_count: usize,
    pub already_organized_count: usize,
    pub stay_in_place_count: usize,
    pub conflict_count: usize,
    pub items: Vec<OrganizePreviewItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeExecuteItemInput {
    pub source_path: String,
    pub file_name: String,
    pub target_folder_name: String,
    pub expected_byte_length: u64,
    pub expected_modified_ms: Option<u64>,
    pub expected_file_id_key: Option<String>,
    pub expected_sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeExecuteRequest {
    pub folder_path: String,
    pub items: Vec<OrganizeExecuteItemInput>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OrganizeExecuteOutcomeStatus {
    Moved,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeExecuteItemOutcome {
    pub source_path: String,
    pub target_path: Option<String>,
    pub file_name: String,
    pub status: OrganizeExecuteOutcomeStatus,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeExecuteResponse {
    pub folder_path: String,
    pub moved_count: usize,
    pub skipped_count: usize,
    pub failed_count: usize,
    pub outcomes: Vec<OrganizeExecuteItemOutcome>,
}

#[derive(Debug, Clone)]
enum AdsReadResult {
    Found {
        zone_id: Option<u32>,
        source_field: Option<&'static str>,
        domain: Option<String>,
    },
    NotPresent,
    UnsupportedFs,
    Unreadable(String),
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

fn metadata_modified_ms(meta: &fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .and_then(|d| u64::try_from(d.as_millis()).ok())
}

#[cfg(windows)]
fn read_file_id_key(file: &File) -> Option<String> {
    use std::mem::MaybeUninit;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut info = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) };
    if ok == 0 {
        return None;
    }
    let info = unsafe { info.assume_init() };
    let index = ((info.nFileIndexHigh as u64) << 32) | (info.nFileIndexLow as u64);
    Some(format!("{:08x}:{:016x}", info.dwVolumeSerialNumber, index))
}

#[cfg(not(windows))]
fn read_file_id_key(_file: &File) -> Option<String> {
    None
}

#[cfg(windows)]
fn volume_supports_named_streams(dir: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{GetVolumeInformationW, GetVolumePathNameW};

    const FILE_NAMED_STREAMS: u32 = 0x0004_0000;
    let wide_path: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut vol_buf = vec![0u16; 1024];
    let ok_vol = unsafe {
        GetVolumePathNameW(
            wide_path.as_ptr(),
            vol_buf.as_mut_ptr(),
            vol_buf.len() as u32,
        )
    };
    if ok_vol == 0 {
        // Fallback: assume NTFS ADS support and let per-file ADS open report cleanly if unsupported.
        return true;
    }
    let mut flags: u32 = 0;
    let ok_info = unsafe {
        GetVolumeInformationW(
            vol_buf.as_ptr(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut flags,
            std::ptr::null_mut(),
            0,
        )
    };
    if ok_info == 0 {
        return true;
    }
    (flags & FILE_NAMED_STREAMS) != 0
}

#[cfg(not(windows))]
fn volume_supports_named_streams(_dir: &Path) -> bool {
    false
}

fn is_supported_image_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|ext| IMAGE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn sha256_file_and_id(path: &Path) -> Result<(String, Option<String>, u64, Option<u64>), AppError> {
    let mut file = File::open(path).map_err(|e| AppError::from_io(e, "Cannot open image file"))?;
    let meta = file
        .metadata()
        .map_err(|e| AppError::from_io(e, "Cannot inspect image file metadata"))?;
    if !meta.is_file() {
        return Err(AppError::invalid_param(
            "Source path is not a regular file.",
        ));
    }
    let file_id = read_file_id_key(&file);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; HASH_BUF_BYTES];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| AppError::from_io(e, "Failed reading image file"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = format!("{:x}", hasher.finalize());
    Ok((digest, file_id, meta.len(), metadata_modified_ms(&meta)))
}

fn build_zone_identifier_path(path: &Path) -> OsString {
    let mut os = OsString::from(path.as_os_str());
    os.push(":Zone.Identifier");
    os
}

fn decode_ads_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFF, 0xFE]) && bytes.len() >= 2 {
        let u16s: Vec<u16> = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&u16s);
    }
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(&bytes[3..]).into_owned();
    }
    String::from_utf8_lossy(bytes).into_owned()
}

/// Extracts ONLY the lowercase domain/hostname from an HTTP(S) URL.
/// Discards scheme, credentials, port, path, query string, and fragment immediately.
fn extract_hostname_from_url(raw_url: &str) -> Option<String> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))?;

    // Strip path, query, and fragment immediately
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return None;
    }
    // Strip optional userinfo (`user:pass@host`)
    let host_port = authority.rsplit('@').next().unwrap_or("");
    if host_port.is_empty() || host_port.starts_with('[') {
        return None;
    }
    // Strip optional `:port`
    let host = host_port.split(':').next().unwrap_or("").trim_matches('.');
    if host.is_empty() || host.len() > 253 || !host.contains('.') {
        return None;
    }
    // Reject IPv4 literals or illegal hostname characters
    if host.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return None;
    }
    for label in host.split('.') {
        if label.is_empty()
            || label.len() > 63
            || label.starts_with('-')
            || label.ends_with('-')
            || !label
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            return None;
        }
    }
    Some(host.to_string())
}

fn parse_zone_identifier_ini(content: &str) -> (Option<u32>, Option<&'static str>, Option<String>) {
    let mut in_zone_transfer = false;
    let mut zone_id: Option<u32> = None;
    let mut host_domain: Option<String> = None;
    let mut referrer_domain: Option<String> = None;

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            in_zone_transfer = line.eq_ignore_ascii_case("[ZoneTransfer]");
            continue;
        }
        if !in_zone_transfer {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            let key = k.trim();
            let val = v.trim();
            if key.eq_ignore_ascii_case("ZoneId") {
                zone_id = val.parse::<u32>().ok();
            } else if key.eq_ignore_ascii_case("HostUrl") && host_domain.is_none() {
                host_domain = extract_hostname_from_url(val);
            } else if key.eq_ignore_ascii_case("ReferrerUrl") && referrer_domain.is_none() {
                referrer_domain = extract_hostname_from_url(val);
            }
        }
    }

    if let Some(domain) = host_domain {
        (zone_id, Some("host_url"), Some(domain))
    } else if let Some(domain) = referrer_domain {
        (zone_id, Some("referrer_url"), Some(domain))
    } else {
        (zone_id, None, None)
    }
}

fn read_zone_identifier_ads(path: &Path, volume_supports_ads: bool) -> AdsReadResult {
    if !volume_supports_ads {
        return AdsReadResult::UnsupportedFs;
    }
    let ads_path = build_zone_identifier_path(path);
    match File::open(&ads_path) {
        Ok(file) => {
            let mut buf = Vec::new();
            match file.take(MAX_ADS_READ_BYTES).read_to_end(&mut buf) {
                Ok(_) => {
                    let text = decode_ads_text(&buf);
                    let (zone_id, source_field, domain) = parse_zone_identifier_ini(&text);
                    AdsReadResult::Found {
                        zone_id,
                        source_field,
                        domain,
                    }
                }
                Err(err) => AdsReadResult::Unreadable(err.to_string()),
            }
        }
        Err(err) => {
            if err.kind() == io::ErrorKind::NotFound {
                return AdsReadResult::NotPresent;
            }
            if matches!(err.raw_os_error(), Some(50) | Some(123)) {
                return AdsReadResult::UnsupportedFs;
            }
            AdsReadResult::Unreadable(err.to_string())
        }
    }
}

fn normalize_rule_domain(raw: &str) -> String {
    let mut s = raw.trim().to_ascii_lowercase();
    if let Some(rest) = s.strip_prefix("https://") {
        s = rest.to_string();
    } else if let Some(rest) = s.strip_prefix("http://") {
        s = rest.to_string();
    }
    if let Some((head, _)) = s.split_once('/') {
        s = head.to_string();
    }
    if let Some((head, _)) = s.split_once(':') {
        s = head.to_string();
    }
    s.trim_matches('.').to_string()
}

/// Strict domain-boundary matcher (`host == domain || host.ends_with(".{domain}")`).
/// Picks the longest (most specific) matching rule.
fn match_domain_mapping(host: &str, mappings: &[DomainMappingRuleInput]) -> Option<String> {
    let mut best_len = 0usize;
    let mut best_site: Option<String> = None;

    for rule in mappings {
        let domain = normalize_rule_domain(&rule.domain);
        let site = rule.site_name.trim();
        if domain.is_empty() || site.is_empty() {
            continue;
        }
        let matched = host == domain
            || (host.len() > domain.len()
                && host.ends_with(&domain)
                && host.as_bytes()[host.len() - domain.len() - 1] == b'.');
        if matched && domain.len() > best_len {
            best_len = domain.len();
            best_site = Some(site.to_string());
        }
    }

    best_site
}

fn sanitize_folder_name(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches(['.', ' ']);
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return None;
    }
    let mut out = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || ch.is_control() {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let cleaned = out.trim().trim_end_matches(['.', ' ']).to_string();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return None;
    }
    let stem = cleaned.split('.').next().unwrap_or(&cleaned);
    let upper = stem.to_uppercase();
    if RESERVED_DOS_NAMES.contains(&upper.as_str()) {
        return None;
    }
    Some(cleaned)
}

fn resolve_target_folder_for_domain(
    domain: &str,
    naming_mode: OrganizeNamingMode,
    mappings: &[DomainMappingRuleInput],
) -> (Option<String>, Option<String>) {
    let mapped_site = match_domain_mapping(domain, mappings);
    let raw_folder = match naming_mode {
        OrganizeNamingMode::SiteAlias => {
            if let Some(ref site) = mapped_site {
                site.as_str()
            } else {
                domain.strip_prefix("www.").unwrap_or(domain)
            }
        }
        OrganizeNamingMode::DomainOnly => domain,
    };
    let sanitized = sanitize_folder_name(raw_folder);
    (mapped_site, sanitized)
}

fn move_file_same_volume_no_overwrite(from: &Path, to: &Path) -> Result<(), AppError> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

        let from_w: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let to_w: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
        // dwFlags = 0: strictly atomic same-volume move, refuses overwriting existing targets,
        // and preserves all NTFS Alternate Data Streams (including :Zone.Identifier) byte-for-byte.
        let ok = unsafe { MoveFileExW(from_w.as_ptr(), to_w.as_ptr(), 0) };
        if ok == 0 {
            let io_err = io::Error::last_os_error();
            if matches!(io_err.raw_os_error(), Some(80) | Some(183)) {
                return Err(AppError::target_exists());
            }
            return Err(AppError::from_io(io_err, "Failed moving image file"));
        }
        Ok(())
    }

    #[cfg(not(windows))]
    {
        if fs::symlink_metadata(to).is_ok() {
            return Err(AppError::target_exists());
        }
        fs::rename(from, to).map_err(|e| AppError::from_io(e, "Failed moving image file"))
    }
}

pub fn preview_organize_downloads_impl(
    req: &OrganizePreviewRequest,
) -> Result<OrganizePreviewResponse, AppError> {
    let root_dir = validate_user_path(&req.folder_path, "Selected folder")?;
    let root_meta = fs::symlink_metadata(&root_dir)
        .map_err(|e| AppError::from_io(e, "Cannot inspect selected folder"))?;
    if !root_meta.is_dir() || is_reparse_point_meta(&root_meta) {
        return Err(AppError::invalid_param(
            "Selected path must be a regular local folder.",
        ));
    }

    let volume_supports_ads = volume_supports_named_streams(&root_dir);
    let sanitized_unknown_folder = sanitize_folder_name(&req.unknown_folder_name);

    let mut top_image_paths: Vec<PathBuf> = Vec::new();
    let mut child_dirs: Vec<(String, PathBuf)> = Vec::new();
    let mut non_image_count = 0usize;

    let read_dir =
        fs::read_dir(&root_dir).map_err(|e| AppError::from_io(e, "Cannot read selected folder"))?;
    for entry in read_dir.flatten() {
        let path = entry.path();
        let meta = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if is_reparse_point_meta(&meta) {
            continue;
        }
        if meta.is_file() {
            if is_supported_image_file(&path) {
                top_image_paths.push(path);
            } else {
                non_image_count += 1;
            }
        } else if meta.is_dir() {
            if let Some(dir_name) = path.file_name().and_then(|n| n.to_str()) {
                child_dirs.push((dir_name.to_string(), path));
            }
        }
    }

    top_image_paths.sort_by(|a, b| {
        a.file_name()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .cmp(&b.file_name().unwrap_or_default().to_ascii_lowercase())
    });
    child_dirs.sort_by_key(|a| a.0.to_ascii_lowercase());

    let mut items: Vec<OrganizePreviewItem> = Vec::new();
    let mut planned_targets_ci: HashSet<String> = HashSet::new();

    // 1) Inspect top-level images in the selected folder
    for path in top_image_paths {
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let meta = match fs::symlink_metadata(&path) {
            Ok(m) if m.is_file() && !is_reparse_point_meta(&m) => m,
            _ => continue,
        };
        let byte_length = meta.len();
        let modified_ms = metadata_modified_ms(&meta);

        let ads = read_zone_identifier_ads(&path, volume_supports_ads);
        let (zone_id, source_field, detected_domain, missing_status, missing_reason) = match ads {
            AdsReadResult::Found {
                zone_id,
                source_field,
                domain,
            } => (
                zone_id,
                source_field,
                domain,
                OrganizeItemStatus::NoSource,
                Some("No web domain recorded in Zone.Identifier".to_string()),
            ),
            AdsReadResult::NotPresent => (
                None,
                None,
                None,
                OrganizeItemStatus::NoSource,
                Some("No Zone.Identifier download source stream".to_string()),
            ),
            AdsReadResult::UnsupportedFs => (
                None,
                None,
                None,
                OrganizeItemStatus::UnsupportedFs,
                Some("Volume does not support NTFS Zone.Identifier streams".to_string()),
            ),
            AdsReadResult::Unreadable(msg) => (
                None,
                None,
                None,
                OrganizeItemStatus::MetadataUnreadable,
                Some(format!("Unable to read Zone.Identifier stream: {msg}")),
            ),
        };

        let (mapped_site_name, target_folder_name) = if let Some(ref dom) = detected_domain {
            resolve_target_folder_for_domain(dom, req.naming_mode, &req.mappings)
        } else if req.move_unknown_to_folder {
            (None, sanitized_unknown_folder.clone())
        } else {
            (None, None)
        };

        if detected_domain.is_none() && !req.move_unknown_to_folder {
            items.push(OrganizePreviewItem {
                source_path: path.to_string_lossy().into_owned(),
                file_name,
                byte_length,
                modified_ms,
                file_id_key: None,
                content_sha256: None,
                zone_id,
                source_field,
                detected_domain: None,
                mapped_site_name: None,
                target_folder_name: None,
                target_rel_path: None,
                status: missing_status,
                action: OrganizeItemAction::StayInPlace,
                reason: missing_reason,
            });
            continue;
        }

        let Some(folder_name) = target_folder_name else {
            items.push(OrganizePreviewItem {
                source_path: path.to_string_lossy().into_owned(),
                file_name,
                byte_length,
                modified_ms,
                file_id_key: None,
                content_sha256: None,
                zone_id,
                source_field,
                detected_domain,
                mapped_site_name,
                target_folder_name: None,
                target_rel_path: None,
                status: OrganizeItemStatus::InvalidTarget,
                action: OrganizeItemAction::SkipConflict,
                reason: Some("Target folder name is invalid on Windows".to_string()),
            });
            continue;
        };

        let target_dir = root_dir.join(&folder_name);
        let target_path = target_dir.join(&file_name);
        let target_rel_path = format!("{folder_name}\\{file_name}");
        let target_key_ci = target_rel_path.to_ascii_lowercase();

        // Check if target directory path is occupied by a regular file or reparse point
        let dir_blocked = match fs::symlink_metadata(&target_dir) {
            Ok(m) => !m.is_dir() || is_reparse_point_meta(&m),
            Err(_) => false,
        };
        let target_exists = fs::symlink_metadata(&target_path).is_ok();
        let batch_dup = planned_targets_ci.contains(&target_key_ci);

        if dir_blocked || target_exists || batch_dup {
            let reason = if dir_blocked {
                format!("A file already exists with folder name '{folder_name}'")
            } else {
                format!("Target file already exists: {target_rel_path}")
            };
            items.push(OrganizePreviewItem {
                source_path: path.to_string_lossy().into_owned(),
                file_name,
                byte_length,
                modified_ms,
                file_id_key: None,
                content_sha256: None,
                zone_id,
                source_field,
                detected_domain,
                mapped_site_name,
                target_folder_name: Some(folder_name),
                target_rel_path: Some(target_rel_path),
                status: OrganizeItemStatus::ConflictExists,
                action: OrganizeItemAction::SkipConflict,
                reason: Some(reason),
            });
            continue;
        }

        // Compute pre-move verification snapshot (SHA-256 + NTFS File ID + exact length/mtime)
        match sha256_file_and_id(&path) {
            Ok((sha256, file_id_key, exact_len, exact_mtime)) => {
                planned_targets_ci.insert(target_key_ci);
                items.push(OrganizePreviewItem {
                    source_path: path.to_string_lossy().into_owned(),
                    file_name,
                    byte_length: exact_len,
                    modified_ms: exact_mtime,
                    file_id_key,
                    content_sha256: Some(sha256),
                    zone_id,
                    source_field,
                    detected_domain,
                    mapped_site_name,
                    target_folder_name: Some(folder_name),
                    target_rel_path: Some(target_rel_path),
                    status: OrganizeItemStatus::Ready,
                    action: OrganizeItemAction::Move,
                    reason: None,
                });
            }
            Err(err) => {
                items.push(OrganizePreviewItem {
                    source_path: path.to_string_lossy().into_owned(),
                    file_name,
                    byte_length,
                    modified_ms,
                    file_id_key: None,
                    content_sha256: None,
                    zone_id,
                    source_field,
                    detected_domain,
                    mapped_site_name,
                    target_folder_name: Some(folder_name),
                    target_rel_path: Some(target_rel_path),
                    status: OrganizeItemStatus::MetadataUnreadable,
                    action: OrganizeItemAction::StayInPlace,
                    reason: Some(err.message),
                });
            }
        }
    }

    // 2) Inspect 1-level direct subfolders to recognize already-organized images on repeat runs
    for (dir_name, dir_path) in child_dirs {
        let sub_entries = match fs::read_dir(&dir_path) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        let mut sub_images: Vec<PathBuf> = Vec::new();
        for entry in sub_entries.flatten() {
            let p = entry.path();
            if let Ok(m) = fs::symlink_metadata(&p) {
                if m.is_file() && !is_reparse_point_meta(&m) && is_supported_image_file(&p) {
                    sub_images.push(p);
                }
            }
        }
        sub_images.sort_by(|a, b| {
            a.file_name()
                .unwrap_or_default()
                .to_ascii_lowercase()
                .cmp(&b.file_name().unwrap_or_default().to_ascii_lowercase())
        });

        for img_path in sub_images {
            let ads = read_zone_identifier_ads(&img_path, volume_supports_ads);
            let (zone_id, source_field, detected_domain) = match ads {
                AdsReadResult::Found {
                    zone_id,
                    source_field,
                    domain,
                } => (zone_id, source_field, domain),
                _ => (None, None, None),
            };

            let (mapped_site, expected_folder) = if let Some(ref dom) = detected_domain {
                resolve_target_folder_for_domain(dom, req.naming_mode, &req.mappings)
            } else if req.move_unknown_to_folder {
                (None, sanitized_unknown_folder.clone())
            } else {
                (None, None)
            };

            let matches_parent = expected_folder
                .as_deref()
                .map(|exp| exp.eq_ignore_ascii_case(&dir_name))
                .unwrap_or(false);
            if !matches_parent {
                continue;
            }

            let meta = match fs::symlink_metadata(&img_path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let file_name = img_path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let rel = format!("{dir_name}\\{file_name}");
            items.push(OrganizePreviewItem {
                source_path: img_path.to_string_lossy().into_owned(),
                file_name,
                byte_length: meta.len(),
                modified_ms: metadata_modified_ms(&meta),
                file_id_key: None,
                content_sha256: None,
                zone_id,
                source_field,
                detected_domain,
                mapped_site_name: mapped_site,
                target_folder_name: Some(dir_name.clone()),
                target_rel_path: Some(rel),
                status: OrganizeItemStatus::AlreadyOrganized,
                action: OrganizeItemAction::AlreadyOrganized,
                reason: Some("Already in matching source folder".to_string()),
            });
        }
    }

    let ready_count = items
        .iter()
        .filter(|i| i.action == OrganizeItemAction::Move)
        .count();
    let already_organized_count = items
        .iter()
        .filter(|i| i.action == OrganizeItemAction::AlreadyOrganized)
        .count();
    let stay_in_place_count = items
        .iter()
        .filter(|i| i.action == OrganizeItemAction::StayInPlace)
        .count();
    let conflict_count = items
        .iter()
        .filter(|i| i.action == OrganizeItemAction::SkipConflict)
        .count();

    Ok(OrganizePreviewResponse {
        folder_path: root_dir.to_string_lossy().into_owned(),
        volume_supports_ads,
        total_image_count: items.len(),
        non_image_count,
        ready_count,
        already_organized_count,
        stay_in_place_count,
        conflict_count,
        items,
    })
}

pub fn execute_organize_downloads_impl(
    req: &OrganizeExecuteRequest,
) -> Result<OrganizeExecuteResponse, AppError> {
    let root_dir = validate_user_path(&req.folder_path, "Selected folder")?;
    let root_meta = fs::symlink_metadata(&root_dir)
        .map_err(|e| AppError::from_io(e, "Cannot inspect selected folder"))?;
    if !root_meta.is_dir() || is_reparse_point_meta(&root_meta) {
        return Err(AppError::invalid_param(
            "Selected path must be a regular local folder.",
        ));
    }
    let root_canon = fs::canonicalize(&root_dir)
        .map_err(|e| AppError::from_io(e, "Cannot resolve selected folder"))?;

    let mut outcomes = Vec::with_capacity(req.items.len());
    let mut moved_count = 0usize;
    let mut skipped_count = 0usize;
    let mut failed_count = 0usize;

    for item in &req.items {
        let src_path = match validate_user_path(&item.source_path, "Source image") {
            Ok(p) => p,
            Err(err) => {
                failed_count += 1;
                outcomes.push(OrganizeExecuteItemOutcome {
                    source_path: item.source_path.clone(),
                    target_path: None,
                    file_name: item.file_name.clone(),
                    status: OrganizeExecuteOutcomeStatus::Failed,
                    reason: Some(err.message),
                });
                continue;
            }
        };

        // Ensure source is a direct child of selected root_dir
        let src_parent_ok = src_path
            .parent()
            .and_then(|p| fs::canonicalize(p).ok())
            .map(|p| p == root_canon)
            .unwrap_or(false);
        if !src_parent_ok {
            skipped_count += 1;
            outcomes.push(OrganizeExecuteItemOutcome {
                source_path: item.source_path.clone(),
                target_path: None,
                file_name: item.file_name.clone(),
                status: OrganizeExecuteOutcomeStatus::Skipped,
                reason: Some("Source image is not directly inside the selected folder".to_string()),
            });
            continue;
        }

        // Strict target folder name check
        let Some(clean_folder) = sanitize_folder_name(&item.target_folder_name) else {
            skipped_count += 1;
            outcomes.push(OrganizeExecuteItemOutcome {
                source_path: item.source_path.clone(),
                target_path: None,
                file_name: item.file_name.clone(),
                status: OrganizeExecuteOutcomeStatus::Skipped,
                reason: Some("Invalid target folder name".to_string()),
            });
            continue;
        };
        if clean_folder != item.target_folder_name.trim() {
            skipped_count += 1;
            outcomes.push(OrganizeExecuteItemOutcome {
                source_path: item.source_path.clone(),
                target_path: None,
                file_name: item.file_name.clone(),
                status: OrganizeExecuteOutcomeStatus::Skipped,
                reason: Some("Target folder name contains illegal characters".to_string()),
            });
            continue;
        }

        // Re-verify source file integrity (symlink check + size + mtime + file ID + SHA-256)
        let src_meta = match fs::symlink_metadata(&src_path) {
            Ok(m) if m.is_file() && !is_reparse_point_meta(&m) => m,
            Ok(_) => {
                skipped_count += 1;
                outcomes.push(OrganizeExecuteItemOutcome {
                    source_path: item.source_path.clone(),
                    target_path: None,
                    file_name: item.file_name.clone(),
                    status: OrganizeExecuteOutcomeStatus::Skipped,
                    reason: Some("Source is no longer a regular file".to_string()),
                });
                continue;
            }
            Err(_) => {
                skipped_count += 1;
                outcomes.push(OrganizeExecuteItemOutcome {
                    source_path: item.source_path.clone(),
                    target_path: None,
                    file_name: item.file_name.clone(),
                    status: OrganizeExecuteOutcomeStatus::Skipped,
                    reason: Some("Source file no longer exists".to_string()),
                });
                continue;
            }
        };

        let (cur_sha, cur_id, cur_len, cur_mtime) = match sha256_file_and_id(&src_path) {
            Ok(v) => v,
            Err(err) => {
                failed_count += 1;
                outcomes.push(OrganizeExecuteItemOutcome {
                    source_path: item.source_path.clone(),
                    target_path: None,
                    file_name: item.file_name.clone(),
                    status: OrganizeExecuteOutcomeStatus::Failed,
                    reason: Some(err.message),
                });
                continue;
            }
        };

        let meta_changed = cur_len != item.expected_byte_length
            || cur_len != src_meta.len()
            || cur_mtime != item.expected_modified_ms
            || (item.expected_file_id_key.is_some() && cur_id != item.expected_file_id_key)
            || !cur_sha.eq_ignore_ascii_case(&item.expected_sha256);

        if meta_changed {
            skipped_count += 1;
            outcomes.push(OrganizeExecuteItemOutcome {
                source_path: item.source_path.clone(),
                target_path: None,
                file_name: item.file_name.clone(),
                status: OrganizeExecuteOutcomeStatus::Skipped,
                reason: Some("Source file was modified or replaced after preview".to_string()),
            });
            continue;
        }

        // Prepare target folder safely (refuse file/reparse collision)
        let target_dir = root_dir.join(&clean_folder);
        match fs::symlink_metadata(&target_dir) {
            Ok(m) => {
                if !m.is_dir() || is_reparse_point_meta(&m) {
                    skipped_count += 1;
                    outcomes.push(OrganizeExecuteItemOutcome {
                        source_path: item.source_path.clone(),
                        target_path: None,
                        file_name: item.file_name.clone(),
                        status: OrganizeExecuteOutcomeStatus::Skipped,
                        reason: Some(format!(
                            "Cannot create folder '{clean_folder}': path is occupied"
                        )),
                    });
                    continue;
                }
            }
            Err(_) => {
                if let Err(err) = fs::create_dir(&target_dir) {
                    failed_count += 1;
                    outcomes.push(OrganizeExecuteItemOutcome {
                        source_path: item.source_path.clone(),
                        target_path: None,
                        file_name: item.file_name.clone(),
                        status: OrganizeExecuteOutcomeStatus::Failed,
                        reason: Some(format!("Failed creating target folder: {err}")),
                    });
                    continue;
                }
            }
        }

        let Some(base_name) = src_path.file_name() else {
            skipped_count += 1;
            continue;
        };
        let target_path = target_dir.join(base_name);

        if fs::symlink_metadata(&target_path).is_ok() {
            skipped_count += 1;
            outcomes.push(OrganizeExecuteItemOutcome {
                source_path: item.source_path.clone(),
                target_path: Some(target_path.to_string_lossy().into_owned()),
                file_name: item.file_name.clone(),
                status: OrganizeExecuteOutcomeStatus::Skipped,
                reason: Some("Target file already exists (protected)".to_string()),
            });
            continue;
        }

        match move_file_same_volume_no_overwrite(&src_path, &target_path) {
            Ok(()) => {
                moved_count += 1;
                outcomes.push(OrganizeExecuteItemOutcome {
                    source_path: item.source_path.clone(),
                    target_path: Some(target_path.to_string_lossy().into_owned()),
                    file_name: item.file_name.clone(),
                    status: OrganizeExecuteOutcomeStatus::Moved,
                    reason: None,
                });
            }
            Err(err) if err.code == "TARGET_ALREADY_EXISTS" => {
                skipped_count += 1;
                outcomes.push(OrganizeExecuteItemOutcome {
                    source_path: item.source_path.clone(),
                    target_path: Some(target_path.to_string_lossy().into_owned()),
                    file_name: item.file_name.clone(),
                    status: OrganizeExecuteOutcomeStatus::Skipped,
                    reason: Some("Target file already exists (protected)".to_string()),
                });
            }
            Err(err) => {
                failed_count += 1;
                outcomes.push(OrganizeExecuteItemOutcome {
                    source_path: item.source_path.clone(),
                    target_path: Some(target_path.to_string_lossy().into_owned()),
                    file_name: item.file_name.clone(),
                    status: OrganizeExecuteOutcomeStatus::Failed,
                    reason: Some(err.message),
                });
            }
        }
    }

    Ok(OrganizeExecuteResponse {
        folder_path: root_dir.to_string_lossy().into_owned(),
        moved_count,
        skipped_count,
        failed_count,
        outcomes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    fn write_ads(file_path: &Path, ads_bytes: &[u8]) {
        let ads_path = build_zone_identifier_path(file_path);
        let mut f = File::create(&ads_path).expect("create Zone.Identifier ADS");
        f.write_all(ads_bytes).expect("write Zone.Identifier ADS");
    }

    fn read_ads_bytes(file_path: &Path) -> Vec<u8> {
        let ads_path = build_zone_identifier_path(file_path);
        fs::read(&ads_path).expect("read Zone.Identifier ADS")
    }

    fn sample_mappings() -> Vec<DomainMappingRuleInput> {
        vec![
            DomainMappingRuleInput {
                domain: "pbs.twimg.com".into(),
                site_name: "X (Twitter)".into(),
            },
            DomainMappingRuleInput {
                domain: "github.com".into(),
                site_name: "GitHub".into(),
            },
            DomainMappingRuleInput {
                domain: "sinaimg.cn".into(),
                site_name: "Weibo".into(),
            },
        ]
    }

    #[test]
    fn enforces_domain_boundary_and_strips_full_urls_and_query_params() {
        assert_eq!(
            extract_hostname_from_url(
                "https://PBS.TWIMG.COM:443/media/Fx123.jpg?format=jpg&secret=token"
            ),
            Some("pbs.twimg.com".to_string())
        );
        assert_eq!(extract_hostname_from_url("about:internet"), None);
        assert_eq!(extract_hostname_from_url("file:///C:/secret/a.png"), None);
        assert_eq!(extract_hostname_from_url("https://127.0.0.1/a.png"), None);

        let rules = sample_mappings();
        assert_eq!(
            match_domain_mapping("pbs.twimg.com", &rules),
            Some("X (Twitter)".to_string())
        );
        assert_eq!(
            match_domain_mapping("wx3.sinaimg.cn", &rules),
            Some("Weibo".to_string())
        );
        // Domain boundary check: must NOT match `notgithub.com`
        assert_eq!(match_domain_mapping("notgithub.com", &rules), None);
    }

    #[cfg(windows)]
    #[test]
    fn scenarios_3_and_4_ntfs_zone_identifier_preserve_ads_skip_modified_and_idempotent_second_run()
    {
        let dir = tempdir().expect("tempdir");
        if !volume_supports_named_streams(dir.path()) {
            return;
        }

        // 1) CDN-aliased image with sensitive query params in HostUrl + ReferrerUrl
        let img_x = dir.path().join("tweet_art.png");
        let bytes_x = b"\x89PNG\r\n\x1a\nFAKE_PNG_DATA_X_2026";
        fs::write(&img_x, bytes_x).expect("write img_x");
        let ads_x = b"[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://x.com/alice/status/999?private=1\r\nHostUrl=https://pbs.twimg.com/media/abc123.png?format=png&auth=secret_token\r\n";
        write_ads(&img_x, ads_x);

        // 2) Referrer fallback image (HostUrl=about:internet)
        let img_gh = dir.path().join("release_badge.jpg");
        let bytes_gh = b"\xFF\xD8\xFF\xE0FAKE_JPG_GH";
        fs::write(&img_gh, bytes_gh).expect("write img_gh");
        let ads_gh = b"[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=about:internet\r\nReferrerUrl=https://github.com/LuckyLivio/WinKit?tab=readme\r\n";
        write_ads(&img_gh, ads_gh);

        // 3) Domain-fallback image (not in CDN map, also tests non-matching `notgithub.com`)
        let img_dom = dir.path().join("diagram.webp");
        let bytes_dom = b"RIFF0000WEBP_DATA";
        fs::write(&img_dom, bytes_dom).expect("write img_dom");
        let ads_dom = b"[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://notgithub.com/assets/diagram.webp?k=v\r\n";
        write_ads(&img_dom, ads_dom);

        // 4) Unsourced image (no ADS -> must stay in place by default)
        let img_unknown = dir.path().join("local_screenshot.png");
        fs::write(&img_unknown, b"LOCAL_ONLY_PNG").expect("write unknown");

        // 5) Conflicting target image (pre-existing file inside `X (Twitter)`)
        let existing_x_dir = dir.path().join("X (Twitter)");
        fs::create_dir_all(&existing_x_dir).expect("mkdir existing X");
        let existing_conflict_dst = existing_x_dir.join("dup.png");
        fs::write(&existing_conflict_dst, b"EXISTING_TARGET_DO_NOT_TOUCH").expect("write dst");
        let img_conflict = dir.path().join("dup.png");
        fs::write(&img_conflict, b"NEW_CONFLICTING_IMAGE").expect("write conflict src");
        write_ads(
            &img_conflict,
            b"[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://pbs.twimg.com/media/dup.png\r\n",
        );

        // 6) Image that will be modified AFTER preview and BEFORE execute (must be skipped!)
        let img_mutated = dir.path().join("mutated_after_preview.png");
        fs::write(&img_mutated, b"ORIGINAL_BEFORE_PREVIEW").expect("write mutated");
        write_ads(
            &img_mutated,
            b"[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://wx1.sinaimg.cn/large/photo.png\r\n",
        );

        // 7) Non-image file (ignored)
        fs::write(dir.path().join("notes.txt"), b"leave alone").expect("write txt");

        // --- Preview Run 1 (default: unknown stays in place) ---
        let preview = preview_organize_downloads_impl(&OrganizePreviewRequest {
            folder_path: dir.path().to_string_lossy().into_owned(),
            naming_mode: OrganizeNamingMode::SiteAlias,
            move_unknown_to_folder: false,
            unknown_folder_name: "未知来源".into(),
            mappings: sample_mappings(),
        })
        .expect("preview run 1");

        // Privacy check: serialized preview JSON MUST NOT contain any URL path or query parameter
        let preview_json = serde_json::to_string(&preview).expect("serialize preview");
        assert!(!preview_json.contains("secret_token"));
        assert!(!preview_json.contains("private=1"));
        assert!(!preview_json.contains("tab=readme"));
        assert!(!preview_json.contains("https://"));

        assert!(preview.volume_supports_ads);
        assert_eq!(preview.non_image_count, 1);
        assert_eq!(preview.ready_count, 4); // img_x, img_gh, img_dom, img_mutated
        assert_eq!(preview.stay_in_place_count, 1); // img_unknown
        assert_eq!(preview.conflict_count, 1); // img_conflict

        // Verify `notgithub.com` did NOT match GitHub
        let dom_item = preview
            .items
            .iter()
            .find(|i| i.file_name == "diagram.webp")
            .unwrap();
        assert_eq!(
            dom_item.target_folder_name.as_deref(),
            Some("notgithub.com")
        );

        // Mutate `img_mutated` AFTER preview before execute!
        fs::write(&img_mutated, b"TAMPERED_AFTER_PREVIEW_BYTES").expect("tamper after preview");

        let exec_items: Vec<OrganizeExecuteItemInput> = preview
            .items
            .iter()
            .filter(|i| i.action == OrganizeItemAction::Move)
            .map(|i| OrganizeExecuteItemInput {
                source_path: i.source_path.clone(),
                file_name: i.file_name.clone(),
                target_folder_name: i.target_folder_name.clone().unwrap(),
                expected_byte_length: i.byte_length,
                expected_modified_ms: i.modified_ms,
                expected_file_id_key: i.file_id_key.clone(),
                expected_sha256: i.content_sha256.clone().unwrap(),
            })
            .collect();

        let exec_res = execute_organize_downloads_impl(&OrganizeExecuteRequest {
            folder_path: dir.path().to_string_lossy().into_owned(),
            items: exec_items,
        })
        .expect("execute run 1");

        assert_eq!(exec_res.moved_count, 3);
        assert_eq!(exec_res.skipped_count, 1); // mutated_after_preview.png skipped!
        assert_eq!(exec_res.failed_count, 0);

        // Verify mutated file was NOT moved
        assert!(img_mutated.is_file());
        assert!(!dir
            .path()
            .join("Weibo")
            .join("mutated_after_preview.png")
            .exists());

        // Verify unknown image stayed in place & conflict target untouched
        assert!(img_unknown.is_file());
        assert!(img_conflict.is_file());
        assert_eq!(
            fs::read(&existing_conflict_dst).unwrap(),
            b"EXISTING_TARGET_DO_NOT_TOUCH"
        );

        // Verify Scenario 4: byte-for-byte image content AND byte-for-byte `:Zone.Identifier` ADS preserved!
        let moved_x = dir.path().join("X (Twitter)").join("tweet_art.png");
        assert_eq!(fs::read(&moved_x).unwrap(), bytes_x);
        assert_eq!(read_ads_bytes(&moved_x), ads_x);

        let moved_gh = dir.path().join("GitHub").join("release_badge.jpg");
        assert_eq!(fs::read(&moved_gh).unwrap(), bytes_gh);
        assert_eq!(read_ads_bytes(&moved_gh), ads_gh);

        let moved_dom = dir.path().join("notgithub.com").join("diagram.webp");
        assert_eq!(fs::read(&moved_dom).unwrap(), bytes_dom);
        assert_eq!(read_ads_bytes(&moved_dom), ads_dom);

        // --- Preview Run 2: idempotent! Recognizes already-organized images and does NOT re-move/nest ---
        // Remove the tampered file first to check pure idempotency on already-organized items
        fs::remove_file(&img_mutated).unwrap();
        let preview2 = preview_organize_downloads_impl(&OrganizePreviewRequest {
            folder_path: dir.path().to_string_lossy().into_owned(),
            naming_mode: OrganizeNamingMode::SiteAlias,
            move_unknown_to_folder: false,
            unknown_folder_name: "未知来源".into(),
            mappings: sample_mappings(),
        })
        .expect("preview run 2");

        assert_eq!(preview2.ready_count, 0);
        assert_eq!(preview2.already_organized_count, 3); // tweet_art, release_badge, diagram
        assert_eq!(preview2.stay_in_place_count, 1); // local_screenshot.png
        assert_eq!(preview2.conflict_count, 1); // dup.png

        // Opt-in moveUnknownToFolder = true moves `local_screenshot.png` into `未知来源`
        let preview3 = preview_organize_downloads_impl(&OrganizePreviewRequest {
            folder_path: dir.path().to_string_lossy().into_owned(),
            naming_mode: OrganizeNamingMode::SiteAlias,
            move_unknown_to_folder: true,
            unknown_folder_name: "未知来源".into(),
            mappings: sample_mappings(),
        })
        .expect("preview run 3 opt-in unknown");
        assert_eq!(preview3.ready_count, 1);
        let unk_item = preview3
            .items
            .iter()
            .find(|i| i.file_name == "local_screenshot.png")
            .unwrap();
        assert_eq!(unk_item.target_folder_name.as_deref(), Some("未知来源"));
    }
}
