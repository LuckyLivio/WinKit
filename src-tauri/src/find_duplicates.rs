use crate::error::AppError;
use crate::fs_guard::validate_user_path;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub const DUPLICATES_SCAN_PROGRESS_EVENT: &str = "winkit://duplicates-scan-progress";
const EDGE_CHUNK_BYTES: usize = 64 * 1024; // 64 KiB head + 64 KiB tail
const SMALL_FULL_READ_THRESHOLD: u64 = (EDGE_CHUNK_BYTES * 2) as u64; // 128 KiB
const STREAM_CHUNK_BYTES: usize = 256 * 1024; // 256 KiB streaming SHA-256 buffer
const EMPTY_SHA256_HEX: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DuplicateScanPhase {
    Walking,
    EdgeHashing,
    FullHashing,
    Completed,
    Cancelled,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateScanProgressPayload {
    pub task_id: String,
    pub phase: DuplicateScanPhase,
    pub scanned_files: usize,
    pub candidate_files: usize,
    pub processed_bytes: u64,
    pub total_candidate_bytes: Option<u64>,
    pub current_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateScanOptions {
    pub root_paths: Vec<String>,
    pub min_size_bytes: u64,
    pub include_hidden: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateFileEntry {
    pub path: String,
    pub parent_dir: String,
    pub file_name: String,
    pub byte_length: u64,
    pub modified_ms: Option<u64>,
    pub created_ms: Option<u64>,
    pub is_hidden: bool,
    pub hardlink_count: u32,
    pub file_id_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    pub group_id: String,
    pub sha256: String,
    pub byte_length: u64,
    pub reclaimable_bytes: u64,
    pub files: Vec<DuplicateFileEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateScanSkippedItem {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateHardlinkAlias {
    pub skipped_path: String,
    pub primary_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateScanResult {
    pub task_id: String,
    pub effective_roots: Vec<String>,
    pub collapsed_redundant_roots: Vec<String>,
    pub scanned_file_count: usize,
    pub total_duplicate_files: usize,
    pub total_reclaimable_bytes: u64,
    pub groups: Vec<DuplicateGroup>,
    pub skipped_items: Vec<DuplicateScanSkippedItem>,
    pub skipped_hardlinks: Vec<DuplicateHardlinkAlias>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateVerifyTarget {
    pub path: String,
    pub expected_file_id_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecycleGroupPlan {
    pub group_id: String,
    pub expected_size: u64,
    pub expected_sha256: String,
    pub remove_targets: Vec<DuplicateVerifyTarget>,
    pub keep_targets: Vec<DuplicateVerifyTarget>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecycleOutcomeStatus {
    Recycled,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecycleItemOutcome {
    pub group_id: String,
    pub path: String,
    pub byte_length: u64,
    pub status: RecycleOutcomeStatus,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateRecycleResponse {
    pub recycled_count: usize,
    pub recycled_bytes: u64,
    pub skipped_count: usize,
    pub failed_count: usize,
    pub outcomes: Vec<RecycleItemOutcome>,
}

fn system_time_to_ms(time: Result<SystemTime, std::io::Error>) -> Option<u64> {
    let ok = time.ok()?;
    let dur = ok.duration_since(UNIX_EPOCH).ok()?;
    u64::try_from(dur.as_millis()).ok()
}

fn bytes_to_lower_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0F) as usize] as char);
    }
    out
}

#[cfg(windows)]
fn strip_verbatim(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if let Some(stripped) = raw.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{stripped}"));
    }
    if let Some(stripped) = raw.strip_prefix(r"\\?\") {
        return PathBuf::from(stripped);
    }
    path.to_path_buf()
}

#[cfg(not(windows))]
fn strip_verbatim(path: &Path) -> PathBuf {
    path.to_path_buf()
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

#[cfg(windows)]
fn is_hidden_meta(meta: &fs::Metadata, _name: &str) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x0002;
    (meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN) != 0
}

#[cfg(not(windows))]
fn is_hidden_meta(_meta: &fs::Metadata, name: &str) -> bool {
    name.starts_with('.')
}

#[cfg(windows)]
fn open_shared_readonly(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    // FILE_SHARE_READ (1) | FILE_SHARE_WRITE (2) | FILE_SHARE_DELETE (4)
    fs::OpenOptions::new().read(true).share_mode(7).open(path)
}

#[cfg(not(windows))]
fn open_shared_readonly(path: &Path) -> std::io::Result<File> {
    File::open(path)
}

#[derive(Debug, Clone)]
struct PhysicalFileIdentity {
    key: Option<String>,
    hardlink_count: u32,
}

#[cfg(windows)]
fn query_physical_file_identity(file: &File) -> PhysicalFileIdentity {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileIdInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
        BY_HANDLE_FILE_INFORMATION, FILE_ID_INFO,
    };

    let raw_handle = file.as_raw_handle();
    let mut basic_info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let has_basic = unsafe { GetFileInformationByHandle(raw_handle as _, &mut basic_info) } != 0;
    let hardlink_count = if has_basic {
        basic_info.nNumberOfLinks.max(1)
    } else {
        1
    };

    // Prefer 128-bit FILE_ID_INFO (supports both NTFS and ReFS accurately)
    let mut id_info: FILE_ID_INFO = unsafe { std::mem::zeroed() };
    let has_128 = unsafe {
        GetFileInformationByHandleEx(
            raw_handle as _,
            FileIdInfo,
            (&mut id_info as *mut FILE_ID_INFO).cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    } != 0;

    if has_128 {
        let id_hex = bytes_to_lower_hex(&id_info.FileId.Identifier);
        return PhysicalFileIdentity {
            key: Some(format!("{:016x}:{id_hex}", id_info.VolumeSerialNumber)),
            hardlink_count,
        };
    }

    if has_basic {
        let idx64 = ((basic_info.nFileIndexHigh as u64) << 32) | (basic_info.nFileIndexLow as u64);
        return PhysicalFileIdentity {
            key: Some(format!(
                "{:08x}:{idx64:016x}",
                basic_info.dwVolumeSerialNumber
            )),
            hardlink_count,
        };
    }

    PhysicalFileIdentity {
        key: None,
        hardlink_count: 1,
    }
}

#[cfg(not(windows))]
fn query_physical_file_identity(file: &File) -> PhysicalFileIdentity {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let Ok(meta) = file.metadata() {
            return PhysicalFileIdentity {
                key: Some(format!("{:x}:{:x}", meta.dev(), meta.ino())),
                hardlink_count: u32::try_from(meta.nlink()).unwrap_or(1).max(1),
            };
        }
    }
    let _ = file;
    PhysicalFileIdentity {
        key: None,
        hardlink_count: 1,
    }
}

fn normalized_win_path_str(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

fn is_same_or_descendant_win_path(candidate: &Path, ancestor: &Path) -> bool {
    let cand = normalized_win_path_str(candidate);
    let anc = normalized_win_path_str(ancestor);
    if cand == anc {
        return true;
    }
    if anc.ends_with(':') {
        // Drive root like `d:` -> prefix `d:\`
        return cand.starts_with(&format!("{anc}\\"));
    }
    cand.starts_with(&format!("{anc}\\"))
}

/// Deduplicates repeated root directories and collapses child directories whose parent/ancestor
/// is also selected (`Root` + `Root\Sub` -> keeps `Root` only). Skips reparse-point roots.
pub fn resolve_and_deduplicate_roots(
    raw_roots: &[String],
    skipped_items: &mut Vec<DuplicateScanSkippedItem>,
) -> Result<(Vec<PathBuf>, Vec<String>), AppError> {
    let mut canonical_candidates: Vec<PathBuf> = Vec::new();

    for raw in raw_roots {
        if raw.trim().is_empty() {
            continue;
        }
        let user_path = validate_user_path(raw, "Scan folder")?;
        let sym_meta = match fs::symlink_metadata(&user_path) {
            Ok(m) => m,
            Err(err) => {
                skipped_items.push(DuplicateScanSkippedItem {
                    path: user_path.to_string_lossy().into_owned(),
                    reason: AppError::from_io(err, "Cannot access scan folder").message,
                });
                continue;
            }
        };

        if is_reparse_point_meta(&sym_meta) {
            skipped_items.push(DuplicateScanSkippedItem {
                path: user_path.to_string_lossy().into_owned(),
                reason: "Skipped directory junction or symbolic link root.".to_string(),
            });
            continue;
        }

        if !sym_meta.is_dir() {
            skipped_items.push(DuplicateScanSkippedItem {
                path: user_path.to_string_lossy().into_owned(),
                reason: "Selected path is not a folder.".to_string(),
            });
            continue;
        }

        let canon = match fs::canonicalize(&user_path) {
            Ok(c) => strip_verbatim(&c),
            Err(err) => {
                skipped_items.push(DuplicateScanSkippedItem {
                    path: user_path.to_string_lossy().into_owned(),
                    reason: AppError::from_io(err, "Cannot canonicalize scan folder").message,
                });
                continue;
            }
        };
        canonical_candidates.push(canon);
    }

    // Sort shortest / shallowest first so ancestors always precede descendants
    canonical_candidates.sort_by_key(|p| {
        let norm = normalized_win_path_str(p);
        (norm.matches('\\').count(), norm.len(), norm)
    });

    let mut accepted: Vec<PathBuf> = Vec::new();
    let mut collapsed: Vec<String> = Vec::new();

    for cand in canonical_candidates {
        if accepted
            .iter()
            .any(|anc| is_same_or_descendant_win_path(&cand, anc))
        {
            collapsed.push(cand.to_string_lossy().into_owned());
        } else {
            accepted.push(cand);
        }
    }

    Ok((accepted, collapsed))
}

fn check_cancelled(cancel_flag: &AtomicBool) -> Result<(), AppError> {
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }
    Ok(())
}

/// Computes either the full-file SHA-256 (if `expected_size <= 128 KiB`) OR the Stage-2
/// `[first 64 KiB || last 64 KiB]` edge fingerprint without mutating the file.
enum StageTwoDigest {
    CompleteFullSha256(String),
    EdgeFingerprint(String),
}

fn compute_stage_two_digest(
    path: &Path,
    expected_size: u64,
    cancel_flag: &AtomicBool,
) -> Result<StageTwoDigest, String> {
    if cancel_flag.load(Ordering::Relaxed) {
        return Err("TASK_CANCELLED".to_string());
    }
    let mut file = open_shared_readonly(path)
        .map_err(|e| AppError::from_io(e, "Cannot open file for edge comparison").message)?;
    let live_len = file
        .metadata()
        .map_err(|e| AppError::from_io(e, "Cannot read file metadata").message)?
        .len();
    if live_len != expected_size {
        return Err("File size changed during scan.".to_string());
    }

    if expected_size <= SMALL_FULL_READ_THRESHOLD {
        let mut buf = Vec::with_capacity(expected_size as usize);
        file.read_to_end(&mut buf)
            .map_err(|e| AppError::from_io(e, "Failed reading small file").message)?;
        if buf.len() as u64 != expected_size {
            return Err("File size changed while reading.".to_string());
        }
        let digest = Sha256::digest(&buf);
        return Ok(StageTwoDigest::CompleteFullSha256(bytes_to_lower_hex(
            &digest,
        )));
    }

    let mut head = vec![0u8; EDGE_CHUNK_BYTES];
    file.read_exact(&mut head)
        .map_err(|e| AppError::from_io(e, "Failed reading first 64 KiB").message)?;

    if cancel_flag.load(Ordering::Relaxed) {
        return Err("TASK_CANCELLED".to_string());
    }

    file.seek(SeekFrom::End(-(EDGE_CHUNK_BYTES as i64)))
        .map_err(|e| AppError::from_io(e, "Failed seeking to last 64 KiB").message)?;
    let mut tail = vec![0u8; EDGE_CHUNK_BYTES];
    file.read_exact(&mut tail)
        .map_err(|e| AppError::from_io(e, "Failed reading last 64 KiB").message)?;

    let mut hasher = Sha256::new();
    hasher.update(&head);
    hasher.update(&tail);
    Ok(StageTwoDigest::EdgeFingerprint(bytes_to_lower_hex(
        &hasher.finalize(),
    )))
}

fn compute_full_sha256_streaming<P>(
    path: &Path,
    expected_size: u64,
    cancel_flag: &AtomicBool,
    mut on_chunk_bytes: P,
) -> Result<String, String>
where
    P: FnMut(u64),
{
    let mut file = open_shared_readonly(path)
        .map_err(|e| AppError::from_io(e, "Cannot open file for SHA-256").message)?;
    let live_len = file
        .metadata()
        .map_err(|e| AppError::from_io(e, "Cannot inspect file before SHA-256").message)?
        .len();
    if live_len != expected_size {
        return Err("File size changed during scan.".to_string());
    }

    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; STREAM_CHUNK_BYTES];
    let mut total_read: u64 = 0;

    loop {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err("TASK_CANCELLED".to_string());
        }
        let n = file
            .read(&mut buf)
            .map_err(|e| AppError::from_io(e, "Read error during SHA-256").message)?;
        if n == 0 {
            break;
        }
        total_read = total_read.saturating_add(n as u64);
        if total_read > expected_size {
            return Err("File grew while computing SHA-256.".to_string());
        }
        hasher.update(&buf[..n]);
        on_chunk_bytes(n as u64);
    }

    if total_read != expected_size {
        return Err("File was truncated while computing SHA-256.".to_string());
    }

    Ok(bytes_to_lower_hex(&hasher.finalize()))
}

fn calculate_group_reclaimable_bytes(files: &[DuplicateFileEntry], byte_length: u64) -> u64 {
    if files.len() < 2 || byte_length == 0 {
        return 0;
    }
    // Keep 1 copy; among the remaining N - 1 copies, only copies with hardlink_count <= 1
    // immediately free physical blocks when recycled/deleted individually.
    // Prefer keeping a multi-hardlink copy first so independent copies are counted accurately.
    let mut sorted_links: Vec<u32> = files.iter().map(|f| f.hardlink_count).collect();
    sorted_links.sort_unstable_by(|a, b| b.cmp(a));
    let removable_independent = sorted_links
        .into_iter()
        .skip(1)
        .filter(|&links| links <= 1)
        .count() as u64;
    removable_independent.saturating_mul(byte_length)
}

pub fn scan_duplicates_impl<F>(
    task_id: &str,
    options: &DuplicateScanOptions,
    cancel_flag: &AtomicBool,
    mut on_progress: F,
) -> Result<DuplicateScanResult, AppError>
where
    F: FnMut(&DuplicateScanProgressPayload),
{
    if options.root_paths.is_empty() {
        return Err(AppError::invalid_param(
            "Select at least one folder to scan for duplicate files.",
        ));
    }

    let mut skipped_items: Vec<DuplicateScanSkippedItem> = Vec::new();
    let mut skipped_hardlinks: Vec<DuplicateHardlinkAlias> = Vec::new();
    let (effective_roots, collapsed_redundant_roots) =
        resolve_and_deduplicate_roots(&options.root_paths, &mut skipped_items)?;

    if effective_roots.is_empty() {
        return Err(AppError::invalid_param(
            "None of the selected scan paths are accessible regular folders.",
        ));
    }

    // Stage 1: Iterative walk, reparse skip, hardlink deduplication, and size grouping
    let mut seen_file_ids: HashMap<String, String> = HashMap::new();
    let mut seen_norm_paths: HashSet<String> = HashSet::new();
    let mut size_buckets: HashMap<u64, Vec<DuplicateFileEntry>> = HashMap::new();
    let mut scanned_file_count: usize = 0;
    let mut last_emit = Instant::now();

    on_progress(&DuplicateScanProgressPayload {
        task_id: task_id.to_string(),
        phase: DuplicateScanPhase::Walking,
        scanned_files: 0,
        candidate_files: 0,
        processed_bytes: 0,
        total_candidate_bytes: None,
        current_path: effective_roots
            .first()
            .map(|p| p.to_string_lossy().into_owned()),
    });

    let mut dir_stack: Vec<PathBuf> = effective_roots.iter().rev().cloned().collect();
    while let Some(current_dir) = dir_stack.pop() {
        check_cancelled(cancel_flag)?;

        let rd = match fs::read_dir(&current_dir) {
            Ok(r) => r,
            Err(err) => {
                skipped_items.push(DuplicateScanSkippedItem {
                    path: current_dir.to_string_lossy().into_owned(),
                    reason: AppError::from_io(err, "Cannot read directory").message,
                });
                continue;
            }
        };

        let mut subdirs: Vec<PathBuf> = Vec::new();
        for entry_res in rd {
            check_cancelled(cancel_flag)?;
            let entry = match entry_res {
                Ok(e) => e,
                Err(err) => {
                    skipped_items.push(DuplicateScanSkippedItem {
                        path: current_dir.to_string_lossy().into_owned(),
                        reason: AppError::from_io(err, "Unreadable directory entry").message,
                    });
                    continue;
                }
            };

            let child_path = entry.path();
            let exact_name = entry.file_name().to_string_lossy().into_owned();
            let sym_meta = match fs::symlink_metadata(&child_path) {
                Ok(m) => m,
                Err(err) => {
                    skipped_items.push(DuplicateScanSkippedItem {
                        path: child_path.to_string_lossy().into_owned(),
                        reason: AppError::from_io(err, "Cannot inspect item").message,
                    });
                    continue;
                }
            };

            if is_reparse_point_meta(&sym_meta) {
                // Default: skip junctions, directory symlinks, and file symlinks
                skipped_items.push(DuplicateScanSkippedItem {
                    path: child_path.to_string_lossy().into_owned(),
                    reason: "Skipped reparse point or symbolic link.".to_string(),
                });
                continue;
            }

            let hidden = is_hidden_meta(&sym_meta, &exact_name);
            if hidden && !options.include_hidden {
                continue;
            }

            if sym_meta.is_dir() {
                subdirs.push(child_path);
                continue;
            }

            if !sym_meta.is_file() {
                continue;
            }

            let byte_length = sym_meta.len();
            if byte_length < options.min_size_bytes {
                continue;
            }

            let norm_path = normalized_win_path_str(&child_path);
            if !seen_norm_paths.insert(norm_path) {
                continue;
            }

            let identity = match open_shared_readonly(&child_path) {
                Ok(f) => query_physical_file_identity(&f),
                Err(err) => {
                    skipped_items.push(DuplicateScanSkippedItem {
                        path: child_path.to_string_lossy().into_owned(),
                        reason: AppError::from_io(err, "Cannot open file").message,
                    });
                    continue;
                }
            };

            let full_path_str = child_path.to_string_lossy().into_owned();
            if let Some(ref fid) = identity.key {
                if let Some(existing_primary) = seen_file_ids.get(fid) {
                    // Hardlink pointing to an already-indexed physical file!
                    skipped_hardlinks.push(DuplicateHardlinkAlias {
                        skipped_path: full_path_str,
                        primary_path: existing_primary.clone(),
                    });
                    continue;
                }
                seen_file_ids.insert(fid.clone(), full_path_str.clone());
            }

            scanned_file_count += 1;
            let parent_str = child_path
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();

            size_buckets
                .entry(byte_length)
                .or_default()
                .push(DuplicateFileEntry {
                    path: full_path_str.clone(),
                    parent_dir: parent_str,
                    file_name: exact_name,
                    byte_length,
                    modified_ms: system_time_to_ms(sym_meta.modified()),
                    created_ms: system_time_to_ms(sym_meta.created()),
                    is_hidden: hidden,
                    hardlink_count: identity.hardlink_count,
                    file_id_key: identity.key,
                });

            if last_emit.elapsed().as_millis() >= 80 {
                last_emit = Instant::now();
                on_progress(&DuplicateScanProgressPayload {
                    task_id: task_id.to_string(),
                    phase: DuplicateScanPhase::Walking,
                    scanned_files: scanned_file_count,
                    candidate_files: 0,
                    processed_bytes: 0,
                    total_candidate_bytes: None,
                    current_path: Some(full_path_str),
                });
            }
        }

        // Push sorted subdirectories in reverse so traversal order is deterministic
        subdirs.sort_by_key(|d| normalized_win_path_str(d));
        for sub in subdirs.into_iter().rev() {
            dir_stack.push(sub);
        }
    }

    check_cancelled(cancel_flag)?;

    // Filter size buckets to those with >= 2 independent physical files
    let mut confirmed_groups: Vec<DuplicateGroup> = Vec::new();
    let mut nonzero_size_candidates: Vec<(u64, Vec<DuplicateFileEntry>)> = Vec::new();
    let mut candidate_file_total: usize = 0;

    for (size, mut bucket) in size_buckets {
        if bucket.len() < 2 {
            continue;
        }
        if size == 0 {
            // Re-verify 0-byte files still exist and are 0 bytes
            bucket.retain(|item| match fs::symlink_metadata(&item.path) {
                Ok(m) if m.is_file() && !is_reparse_point_meta(&m) && m.len() == 0 => true,
                Ok(_) => {
                    skipped_items.push(DuplicateScanSkippedItem {
                        path: item.path.clone(),
                        reason: "Empty file changed size during scan.".to_string(),
                    });
                    false
                }
                Err(err) => {
                    skipped_items.push(DuplicateScanSkippedItem {
                        path: item.path.clone(),
                        reason: AppError::from_io(err, "Empty file vanished during scan").message,
                    });
                    false
                }
            });
            if bucket.len() >= 2 {
                bucket.sort_by_key(|f| f.path.to_lowercase());
                confirmed_groups.push(DuplicateGroup {
                    group_id: format!("0:{EMPTY_SHA256_HEX}"),
                    sha256: EMPTY_SHA256_HEX.to_string(),
                    byte_length: 0,
                    reclaimable_bytes: 0,
                    files: bucket,
                });
            }
        } else {
            candidate_file_total += bucket.len();
            nonzero_size_candidates.push((size, bucket));
        }
    }

    nonzero_size_candidates.sort_by_key(|(sz, _)| std::cmp::Reverse(*sz));

    // Stage 2: First 64 KiB + Last 64 KiB comparison (or single-pass full SHA-256 for <= 128 KiB)
    on_progress(&DuplicateScanProgressPayload {
        task_id: task_id.to_string(),
        phase: DuplicateScanPhase::EdgeHashing,
        scanned_files: scanned_file_count,
        candidate_files: candidate_file_total,
        processed_bytes: 0,
        total_candidate_bytes: None,
        current_path: None,
    });

    let mut stage_three_buckets: Vec<(u64, Vec<DuplicateFileEntry>)> = Vec::new();

    for (size, bucket) in nonzero_size_candidates {
        check_cancelled(cancel_flag)?;
        let mut small_sha_groups: HashMap<String, Vec<DuplicateFileEntry>> = HashMap::new();
        let mut edge_groups: HashMap<String, Vec<DuplicateFileEntry>> = HashMap::new();

        for item in bucket {
            check_cancelled(cancel_flag)?;
            if last_emit.elapsed().as_millis() >= 80 {
                last_emit = Instant::now();
                on_progress(&DuplicateScanProgressPayload {
                    task_id: task_id.to_string(),
                    phase: DuplicateScanPhase::EdgeHashing,
                    scanned_files: scanned_file_count,
                    candidate_files: candidate_file_total,
                    processed_bytes: 0,
                    total_candidate_bytes: None,
                    current_path: Some(item.path.clone()),
                });
            }

            match compute_stage_two_digest(Path::new(&item.path), size, cancel_flag) {
                Ok(StageTwoDigest::CompleteFullSha256(full_hex)) => {
                    small_sha_groups.entry(full_hex).or_default().push(item);
                }
                Ok(StageTwoDigest::EdgeFingerprint(edge_hex)) => {
                    edge_groups.entry(edge_hex).or_default().push(item);
                }
                Err(msg) if msg == "TASK_CANCELLED" => {
                    return Err(AppError::cancelled());
                }
                Err(reason) => {
                    skipped_items.push(DuplicateScanSkippedItem {
                        path: item.path,
                        reason,
                    });
                }
            }
        }

        for (sha_hex, mut matched) in small_sha_groups {
            if matched.len() >= 2 {
                matched.sort_by_key(|f| f.path.to_lowercase());
                let reclaim = calculate_group_reclaimable_bytes(&matched, size);
                confirmed_groups.push(DuplicateGroup {
                    group_id: format!("{size}:{sha_hex}"),
                    sha256: sha_hex,
                    byte_length: size,
                    reclaimable_bytes: reclaim,
                    files: matched,
                });
            }
        }

        for (_edge_hex, candidates) in edge_groups {
            if candidates.len() >= 2 {
                stage_three_buckets.push((size, candidates));
            }
        }
    }

    // Stage 3: Full streaming SHA-256 for > 128 KiB files whose size + head 64 KiB + tail 64 KiB matched
    let total_stage_three_files: usize = stage_three_buckets.iter().map(|(_, v)| v.len()).sum();
    let total_stage_three_bytes: u64 = stage_three_buckets
        .iter()
        .map(|(sz, v)| sz.saturating_mul(v.len() as u64))
        .sum();
    let mut hashed_bytes_so_far: u64 = 0;

    if total_stage_three_files > 0 {
        on_progress(&DuplicateScanProgressPayload {
            task_id: task_id.to_string(),
            phase: DuplicateScanPhase::FullHashing,
            scanned_files: scanned_file_count,
            candidate_files: total_stage_three_files,
            processed_bytes: 0,
            total_candidate_bytes: Some(total_stage_three_bytes),
            current_path: None,
        });
    }

    for (size, candidates) in stage_three_buckets {
        check_cancelled(cancel_flag)?;
        let mut full_sha_map: HashMap<String, Vec<DuplicateFileEntry>> = HashMap::new();

        for item in candidates {
            check_cancelled(cancel_flag)?;
            let item_path = item.path.clone();
            let res = compute_full_sha256_streaming(
                Path::new(&item_path),
                size,
                cancel_flag,
                |chunk_n| {
                    hashed_bytes_so_far = hashed_bytes_so_far.saturating_add(chunk_n);
                    if last_emit.elapsed().as_millis() >= 80 {
                        last_emit = Instant::now();
                        on_progress(&DuplicateScanProgressPayload {
                            task_id: task_id.to_string(),
                            phase: DuplicateScanPhase::FullHashing,
                            scanned_files: scanned_file_count,
                            candidate_files: total_stage_three_files,
                            processed_bytes: hashed_bytes_so_far,
                            total_candidate_bytes: Some(total_stage_three_bytes),
                            current_path: Some(item_path.clone()),
                        });
                    }
                },
            );

            match res {
                Ok(full_hex) => {
                    full_sha_map.entry(full_hex).or_default().push(item);
                }
                Err(msg) if msg == "TASK_CANCELLED" => {
                    return Err(AppError::cancelled());
                }
                Err(reason) => {
                    skipped_items.push(DuplicateScanSkippedItem {
                        path: item.path,
                        reason,
                    });
                }
            }
        }

        for (sha_hex, mut matched) in full_sha_map {
            if matched.len() >= 2 {
                matched.sort_by_key(|f| f.path.to_lowercase());
                let reclaim = calculate_group_reclaimable_bytes(&matched, size);
                confirmed_groups.push(DuplicateGroup {
                    group_id: format!("{size}:{sha_hex}"),
                    sha256: sha_hex,
                    byte_length: size,
                    reclaimable_bytes: reclaim,
                    files: matched,
                });
            }
        }
    }

    // Sort groups by reclaimable space descending, then byte_length descending, then sha256
    confirmed_groups.sort_by(|a, b| {
        b.reclaimable_bytes
            .cmp(&a.reclaimable_bytes)
            .then_with(|| b.byte_length.cmp(&a.byte_length))
            .then_with(|| a.sha256.cmp(&b.sha256))
    });

    let total_duplicate_files: usize = confirmed_groups.iter().map(|g| g.files.len()).sum();
    let total_reclaimable_bytes: u64 = confirmed_groups
        .iter()
        .fold(0u64, |acc, g| acc.saturating_add(g.reclaimable_bytes));

    on_progress(&DuplicateScanProgressPayload {
        task_id: task_id.to_string(),
        phase: DuplicateScanPhase::Completed,
        scanned_files: scanned_file_count,
        candidate_files: total_duplicate_files,
        processed_bytes: total_stage_three_bytes,
        total_candidate_bytes: Some(total_stage_three_bytes),
        current_path: None,
    });

    Ok(DuplicateScanResult {
        task_id: task_id.to_string(),
        effective_roots: effective_roots
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        collapsed_redundant_roots,
        scanned_file_count,
        total_duplicate_files,
        total_reclaimable_bytes,
        groups: confirmed_groups,
        skipped_items,
        skipped_hardlinks,
    })
}

fn verify_target_matches_snapshot(
    target: &DuplicateVerifyTarget,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<(PathBuf, PhysicalFileIdentity), String> {
    let raw_trimmed = target.path.trim();
    if raw_trimmed.is_empty() {
        return Err("Empty file path.".to_string());
    }
    let path_buf = PathBuf::from(raw_trimmed);
    if !path_buf.is_absolute() {
        return Err("Path must be absolute.".to_string());
    }

    let sym_meta = fs::symlink_metadata(&path_buf)
        .map_err(|_| "File no longer exists or is inaccessible.".to_string())?;
    if is_reparse_point_meta(&sym_meta) {
        return Err("Path was replaced by a symbolic link or reparse point.".to_string());
    }
    if !sym_meta.is_file() {
        return Err("Path is no longer a regular file.".to_string());
    }
    if sym_meta.len() != expected_size {
        return Err(format!(
            "File size changed since scan (expected {expected_size} B, found {} B).",
            sym_meta.len()
        ));
    }

    let file = open_shared_readonly(&path_buf)
        .map_err(|e| AppError::from_io(e, "Cannot open file for verification").message)?;
    let identity = query_physical_file_identity(&file);
    drop(file);

    if let (Some(expected_id), Some(actual_id)) = (
        target.expected_file_id_key.as_deref(),
        identity.key.as_deref(),
    ) {
        if !expected_id.eq_ignore_ascii_case(actual_id) {
            return Err("File was replaced by a different file since scan.".to_string());
        }
    }

    let never_cancel = AtomicBool::new(false);
    let actual_sha = if expected_size == 0 {
        // Re-check 0-byte length
        let m2 = fs::symlink_metadata(&path_buf)
            .map_err(|_| "File vanished during verification.".to_string())?;
        if m2.len() != 0 {
            return Err("Empty file gained content since scan.".to_string());
        }
        EMPTY_SHA256_HEX.to_string()
    } else {
        compute_full_sha256_streaming(&path_buf, expected_size, &never_cancel, |_| {})?
    };

    if !actual_sha.eq_ignore_ascii_case(expected_sha256) {
        return Err("File content hash changed since scan.".to_string());
    }

    Ok((path_buf, identity))
}

#[derive(Debug)]
enum StrictRecycleError {
    Skipped(String),
    Failed(String),
}

#[cfg(windows)]
mod win_recycle {
    use super::StrictRecycleError;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::sync::{Arc, Mutex};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, REG_DWORD,
        REG_VALUE_TYPE,
    };
    use windows::Win32::UI::Shell::{
        FileOperation, IFileOperation, IFileOperationProgressSink, IFileOperationProgressSink_Impl,
        IShellItem, SHCreateItemFromParsingName, SHQueryRecycleBinW, FILEOPERATION_FLAGS,
        FOFX_RECYCLEONDELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
        SHQUERYRBINFO, SIGDN_FILESYSPATH, TSF_DELETE_RECYCLE_IF_POSSIBLE,
    };
    use windows_core::{implement, Error as WinError, Ref, HRESULT, PCWSTR};

    // Standard Win32 Shell error to abort IFileOperation cleanly inside PreDeleteItem
    const COPYENGINE_E_USER_CANCELLED: HRESULT = HRESULT(0x8027_0000_u32 as i32);

    fn to_wide_z(s: &OsStr) -> Vec<u16> {
        s.encode_wide().chain(Some(0)).collect()
    }

    fn read_reg_dword(hkey: HKEY, value_name: &str) -> Option<u32> {
        let name_w = to_wide_z(OsStr::new(value_name));
        let mut data: u32 = 0;
        let mut data_len: u32 = std::mem::size_of::<u32>() as u32;
        let mut kind = REG_VALUE_TYPE::default();
        let status = unsafe {
            RegQueryValueExW(
                hkey,
                PCWSTR(name_w.as_ptr()),
                None,
                Some(&mut kind),
                Some((&mut data as *mut u32).cast()),
                Some(&mut data_len),
            )
        };
        if status.is_ok() && kind == REG_DWORD {
            Some(data)
        } else {
            None
        }
    }

    /// Checks whether the user's Windows BitBucket registry policy has disabled the Recycle Bin
    /// (`NukeOnDelete == 1`) globally or for this specific volume GUID.
    fn check_bitbucket_policy_allows_recycle(volume_root_w: &[u16]) -> Result<(), String> {
        use windows_sys::Win32::Storage::FileSystem::GetVolumeNameForVolumeMountPointW;

        let mut vol_guid_buf = vec![0u16; 64];
        let has_guid = unsafe {
            GetVolumeNameForVolumeMountPointW(
                volume_root_w.as_ptr(),
                vol_guid_buf.as_mut_ptr(),
                vol_guid_buf.len() as u32,
            )
        } != 0;

        let guid_part = if has_guid {
            let len = vol_guid_buf
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(vol_guid_buf.len());
            let full = String::from_utf16_lossy(&vol_guid_buf[..len]);
            // Extract `{xxxxxxxx-...}` from `\\?\Volume{...}\`
            full.find('{').and_then(|start| {
                full[start..]
                    .find('}')
                    .map(|end_rel| full[start..=start + end_rel].to_string())
            })
        } else {
            None
        };

        let base_subkey = to_wide_z(OsStr::new(
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket",
        ));
        let mut base_key = HKEY::default();
        if unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(base_subkey.as_ptr()),
                Some(0),
                KEY_READ,
                &mut base_key,
            )
        }
        .is_ok()
        {
            let use_global = read_reg_dword(base_key, "UseGlobalSettings").unwrap_or(0);
            let global_nuke = read_reg_dword(base_key, "NukeOnDelete").unwrap_or(0);
            let _ = unsafe { RegCloseKey(base_key) };

            if use_global == 1 && global_nuke == 1 {
                return Err(
                    "Windows Recycle Bin is globally configured for immediate deletion; skipped to prevent permanent deletion."
                        .to_string(),
                );
            }

            if use_global == 0 {
                if let Some(guid) = guid_part {
                    let vol_subkey = to_wide_z(OsStr::new(&format!(
                        r"Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume\{guid}"
                    )));
                    let mut vol_key = HKEY::default();
                    if unsafe {
                        RegOpenKeyExW(
                            HKEY_CURRENT_USER,
                            PCWSTR(vol_subkey.as_ptr()),
                            Some(0),
                            KEY_READ,
                            &mut vol_key,
                        )
                    }
                    .is_ok()
                    {
                        let vol_nuke = read_reg_dword(vol_key, "NukeOnDelete").unwrap_or(0);
                        let _ = unsafe { RegCloseKey(vol_key) };
                        if vol_nuke == 1 {
                            return Err(
                                "Target volume Recycle Bin is configured for immediate deletion; skipped to prevent permanent deletion."
                                    .to_string(),
                            );
                        }
                    }
                }
            }
        }

        Ok(())
    }

    pub fn verify_volume_supports_recycle_bin(raw_path: &Path) -> Result<(), String> {
        use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetVolumePathNameW};

        let raw_str = raw_path.to_string_lossy();
        if raw_str.starts_with(r"\\") && !raw_str.starts_with(r"\\?\") {
            return Err(
                "Network / UNC paths do not use the local Windows Recycle Bin; skipped to prevent permanent deletion."
                    .to_string(),
            );
        }
        if raw_str.starts_with(r"\\?\UNC\") {
            return Err(
                "UNC network paths do not use the local Windows Recycle Bin; skipped to prevent permanent deletion."
                    .to_string(),
            );
        }

        let path_w = to_wide_z(raw_path.as_os_str());
        let mut vol_root_w = vec![0u16; 264];
        let ok_vol = unsafe {
            GetVolumePathNameW(
                path_w.as_ptr(),
                vol_root_w.as_mut_ptr(),
                vol_root_w.len() as u32,
            )
        };
        if ok_vol == 0 {
            return Err("Unable to determine target volume for Recycle Bin check.".to_string());
        }

        const DRIVE_FIXED: u32 = 3;
        let drive_type = unsafe { GetDriveTypeW(vol_root_w.as_ptr()) };
        if drive_type != DRIVE_FIXED {
            return Err(format!(
                "Target volume is not a fixed local drive (drive type {drive_type}); skipped because Recycle Bin cannot be guaranteed."
            ));
        }

        check_bitbucket_policy_allows_recycle(&vol_root_w)?;

        let mut rb_info = SHQUERYRBINFO {
            cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32,
            i64Size: 0,
            i64NumItems: 0,
        };
        let hr = unsafe { SHQueryRecycleBinW(PCWSTR(vol_root_w.as_ptr()), &mut rb_info) };
        if hr.is_err() {
            return Err(
                "Windows Recycle Bin query failed on target volume; skipped to prevent permanent deletion."
                    .to_string(),
            );
        }

        Ok(())
    }

    #[derive(Default)]
    struct SinkState {
        blocked_permanent_delete: bool,
        post_hr: Option<HRESULT>,
        recycled_item_path: Option<String>,
    }

    #[implement(IFileOperationProgressSink)]
    struct StrictRecycleSink {
        state: Arc<Mutex<SinkState>>,
    }

    impl IFileOperationProgressSink_Impl for StrictRecycleSink_Impl {
        fn StartOperations(&self) -> windows_core::Result<()> {
            Ok(())
        }

        fn FinishOperations(&self, _hrresult: HRESULT) -> windows_core::Result<()> {
            Ok(())
        }

        fn PreRenameItem(
            &self,
            _dwflags: u32,
            _psiitem: Ref<'_, IShellItem>,
            _psznewname: &PCWSTR,
        ) -> windows_core::Result<()> {
            Ok(())
        }

        fn PostRenameItem(
            &self,
            _dwflags: u32,
            _psiitem: Ref<'_, IShellItem>,
            _psznewname: &PCWSTR,
            _hrrename: HRESULT,
            _psinewlycreated: Ref<'_, IShellItem>,
        ) -> windows_core::Result<()> {
            Ok(())
        }

        fn PreMoveItem(
            &self,
            _dwflags: u32,
            _psiitem: Ref<'_, IShellItem>,
            _psidestinationfolder: Ref<'_, IShellItem>,
            _psznewname: &PCWSTR,
        ) -> windows_core::Result<()> {
            Ok(())
        }

        fn PostMoveItem(
            &self,
            _dwflags: u32,
            _psiitem: Ref<'_, IShellItem>,
            _psidestinationfolder: Ref<'_, IShellItem>,
            _psznewname: &PCWSTR,
            _hrmove: HRESULT,
            _psinewlycreated: Ref<'_, IShellItem>,
        ) -> windows_core::Result<()> {
            Ok(())
        }

        fn PreCopyItem(
            &self,
            _dwflags: u32,
            _psiitem: Ref<'_, IShellItem>,
            _psidestinationfolder: Ref<'_, IShellItem>,
            _psznewname: &PCWSTR,
        ) -> windows_core::Result<()> {
            Ok(())
        }

        fn PostCopyItem(
            &self,
            _dwflags: u32,
            _psiitem: Ref<'_, IShellItem>,
            _psidestinationfolder: Ref<'_, IShellItem>,
            _psznewname: &PCWSTR,
            _hrcopy: HRESULT,
            _psinewlycreated: Ref<'_, IShellItem>,
        ) -> windows_core::Result<()> {
            Ok(())
        }

        fn PreDeleteItem(
            &self,
            dwflags: u32,
            _psiitem: Ref<'_, IShellItem>,
        ) -> windows_core::Result<()> {
            let can_recycle = (dwflags & (TSF_DELETE_RECYCLE_IF_POSSIBLE.0 as u32)) != 0;
            if !can_recycle {
                if let Ok(mut guard) = self.state.lock() {
                    guard.blocked_permanent_delete = true;
                }
                return Err(WinError::from_hresult(COPYENGINE_E_USER_CANCELLED));
            }
            Ok(())
        }

        fn PostDeleteItem(
            &self,
            _dwflags: u32,
            _psiitem: Ref<'_, IShellItem>,
            hrdelete: HRESULT,
            psinewlycreated: Ref<'_, IShellItem>,
        ) -> windows_core::Result<()> {
            let recycled_path = psinewlycreated.as_ref().and_then(|item| unsafe {
                item.GetDisplayName(SIGDN_FILESYSPATH)
                    .ok()
                    .and_then(|pwstr| {
                        let s = pwstr.to_string().ok();
                        windows::Win32::System::Com::CoTaskMemFree(Some(pwstr.0.cast()));
                        s
                    })
            });
            if let Ok(mut guard) = self.state.lock() {
                guard.post_hr = Some(hrdelete);
                guard.recycled_item_path = recycled_path;
            }
            Ok(())
        }

        fn PreNewItem(
            &self,
            _dwflags: u32,
            _psidestinationfolder: Ref<'_, IShellItem>,
            _psznewname: &PCWSTR,
        ) -> windows_core::Result<()> {
            Ok(())
        }

        fn PostNewItem(
            &self,
            _dwflags: u32,
            _psidestinationfolder: Ref<'_, IShellItem>,
            _psznewname: &PCWSTR,
            _psztemplatename: &PCWSTR,
            _dwfileattributes: u32,
            _hrnew: HRESULT,
            _psinewitem: Ref<'_, IShellItem>,
        ) -> windows_core::Result<()> {
            Ok(())
        }

        fn UpdateProgress(&self, _iworktotal: u32, _iworksofar: u32) -> windows_core::Result<()> {
            Ok(())
        }

        fn ResetTimer(&self) -> windows_core::Result<()> {
            Ok(())
        }

        fn PauseTimer(&self) -> windows_core::Result<()> {
            Ok(())
        }

        fn ResumeTimer(&self) -> windows_core::Result<()> {
            Ok(())
        }
    }

    pub struct ComApartmentGuard {
        should_uninit: bool,
    }

    impl ComApartmentGuard {
        pub fn enter_sta() -> Result<Self, String> {
            let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            if hr.is_ok() {
                Ok(Self {
                    should_uninit: true,
                })
            } else {
                Err(format!("Failed to initialize COM STA ({hr:?})."))
            }
        }
    }

    impl Drop for ComApartmentGuard {
        fn drop(&mut self) {
            if self.should_uninit {
                unsafe { CoUninitialize() };
            }
        }
    }

    /// Moves a single verified file into the Windows Recycle Bin on an already-initialized STA thread.
    /// Returns the created `$Recycle.Bin\...\$R...` filesystem path on success.
    pub fn recycle_single_file_on_sta(
        raw_path: &Path,
    ) -> Result<Option<String>, StrictRecycleError> {
        if let Err(reason) = verify_volume_supports_recycle_bin(raw_path) {
            return Err(StrictRecycleError::Skipped(reason));
        }

        unsafe {
            let op: IFileOperation =
                CoCreateInstance(&FileOperation, None, CLSCTX_ALL).map_err(|e| {
                    StrictRecycleError::Failed(format!("IFileOperation init failed: {e}"))
                })?;

            let flags = FILEOPERATION_FLAGS(
                FOF_ALLOWUNDO.0
                    | FOFX_RECYCLEONDELETE.0
                    | FOF_SILENT.0
                    | FOF_NOERRORUI.0
                    | FOF_NOCONFIRMATION.0,
            );
            op.SetOperationFlags(flags).map_err(|e| {
                StrictRecycleError::Failed(format!("SetOperationFlags failed: {e}"))
            })?;

            let sink_state = Arc::new(Mutex::new(SinkState::default()));
            let sink: IFileOperationProgressSink = StrictRecycleSink {
                state: sink_state.clone(),
            }
            .into();
            let cookie = op
                .Advise(&sink)
                .map_err(|e| StrictRecycleError::Failed(format!("Advise failed: {e}")))?;

            let path_w = to_wide_z(raw_path.as_os_str());
            let item_res: windows_core::Result<IShellItem> =
                SHCreateItemFromParsingName(PCWSTR(path_w.as_ptr()), None);
            let shell_item = match item_res {
                Ok(it) => it,
                Err(e) => {
                    let _ = op.Unadvise(cookie);
                    return Err(StrictRecycleError::Failed(format!(
                        "Cannot bind Shell item: {e}"
                    )));
                }
            };

            if let Err(e) = op.DeleteItem(&shell_item, None) {
                let _ = op.Unadvise(cookie);
                return Err(StrictRecycleError::Failed(format!(
                    "DeleteItem queue failed: {e}"
                )));
            }

            let perf_res = op.PerformOperations();
            let aborted = op
                .GetAnyOperationsAborted()
                .map(|b| b.as_bool())
                .unwrap_or(false);
            let _ = op.Unadvise(cookie);

            let recorded = sink_state
                .lock()
                .map(|g| {
                    (
                        g.blocked_permanent_delete,
                        g.post_hr,
                        g.recycled_item_path.clone(),
                    )
                })
                .unwrap_or((false, None, None));

            if recorded.0 {
                return Err(StrictRecycleError::Skipped(
                    "Windows Shell reported that Recycle Bin placement is unavailable for this item (e.g. exceeds Recycle Bin capacity); permanent deletion was blocked."
                        .to_string(),
                ));
            }

            if let Some(item_hr) = recorded.1 {
                if item_hr.is_err() {
                    return Err(StrictRecycleError::Failed(format!(
                        "Recycle Bin operation failed ({item_hr:?})."
                    )));
                }
            }

            if let Err(e) = perf_res {
                if raw_path.exists() {
                    return Err(StrictRecycleError::Failed(format!(
                        "Recycle Bin operation did not complete: {e}"
                    )));
                }
            }

            if aborted && raw_path.exists() {
                return Err(StrictRecycleError::Skipped(
                    "Recycle Bin operation was aborted before modifying the file.".to_string(),
                ));
            }

            if raw_path.exists() {
                return Err(StrictRecycleError::Failed(
                    "File remained on disk after Recycle Bin request.".to_string(),
                ));
            }

            Ok(recorded.2)
        }
    }

    #[cfg(test)]
    pub fn restore_recycled_item_on_sta(
        recycled_r_path: &Path,
        original_parent: &Path,
        original_file_name: &str,
    ) -> Result<(), String> {
        unsafe {
            let op: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_ALL)
                .map_err(|e| format!("Restore CoCreateInstance failed: {e}"))?;
            let flags = FILEOPERATION_FLAGS(FOF_SILENT.0 | FOF_NOERRORUI.0 | FOF_NOCONFIRMATION.0);
            op.SetOperationFlags(flags)
                .map_err(|e| format!("Restore SetOperationFlags failed: {e}"))?;

            let rec_w = to_wide_z(recycled_r_path.as_os_str());
            let parent_w = to_wide_z(original_parent.as_os_str());
            let name_w = to_wide_z(OsStr::new(original_file_name));

            let rec_item: IShellItem = SHCreateItemFromParsingName(PCWSTR(rec_w.as_ptr()), None)
                .map_err(|e| format!("Bind recycled item failed: {e}"))?;
            let parent_item: IShellItem =
                SHCreateItemFromParsingName(PCWSTR(parent_w.as_ptr()), None)
                    .map_err(|e| format!("Bind parent folder failed: {e}"))?;

            op.MoveItem(&rec_item, &parent_item, PCWSTR(name_w.as_ptr()), None)
                .map_err(|e| format!("Queue MoveItem restore failed: {e}"))?;
            op.PerformOperations()
                .map_err(|e| format!("PerformOperations restore failed: {e}"))?;

            // Clean up companion `$I...` metadata file in `$Recycle.Bin` if `MoveItem` moved `$R...` directly
            if let (Some(rb_dir), Some(r_fname)) =
                (recycled_r_path.parent(), recycled_r_path.file_name())
            {
                let r_str = r_fname.to_string_lossy();
                if let Some(rest) = r_str.strip_prefix("$R") {
                    let i_companion = rb_dir.join(format!("$I{rest}"));
                    let _ = std::fs::remove_file(i_companion);
                }
            }
            Ok(())
        }
    }
}

pub fn recycle_duplicate_groups_impl(
    plans: &[RecycleGroupPlan],
) -> Result<DuplicateRecycleResponse, AppError> {
    if plans.is_empty() {
        return Err(AppError::invalid_param(
            "No duplicate items were selected to move to the Recycle Bin.",
        ));
    }

    let plans_owned = plans.to_vec();
    // Run inside a dedicated OS thread so COM STA (`COINIT_APARTMENTTHREADED`) is guaranteed clean
    let handle = std::thread::spawn(move || -> Result<DuplicateRecycleResponse, AppError> {
        #[cfg(windows)]
        let _com_guard = win_recycle::ComApartmentGuard::enter_sta()
            .map_err(|msg| AppError::new("RECYCLE_COM_ERROR", msg))?;

        let mut outcomes: Vec<RecycleItemOutcome> = Vec::new();
        let mut recycled_count: usize = 0;
        let mut recycled_bytes: u64 = 0;
        let mut skipped_count: usize = 0;
        let mut failed_count: usize = 0;

        for plan in &plans_owned {
            if plan.remove_targets.is_empty() {
                continue;
            }
            if plan.keep_targets.is_empty() {
                for rem in &plan.remove_targets {
                    skipped_count += 1;
                    outcomes.push(RecycleItemOutcome {
                        group_id: plan.group_id.clone(),
                        path: rem.path.clone(),
                        byte_length: plan.expected_size,
                        status: RecycleOutcomeStatus::Skipped,
                        reason: Some(
                            "Skipped group because at least one copy must be kept.".to_string(),
                        ),
                    });
                }
                continue;
            }

            let remove_norm_set: HashSet<String> = plan
                .remove_targets
                .iter()
                .map(|r| normalized_win_path_str(Path::new(&r.path)))
                .collect();

            // 1. Re-verify ALL declared kept copies in this group BEFORE recycling any file!
            let mut group_abort_reason: Option<String> = None;
            let mut verified_keep_ids: HashSet<String> = HashSet::new();

            for kept in &plan.keep_targets {
                if remove_norm_set.contains(&normalized_win_path_str(Path::new(&kept.path))) {
                    group_abort_reason = Some(
                        "Conflicting plan: kept copy also appeared in removal list.".to_string(),
                    );
                    break;
                }
                match verify_target_matches_snapshot(
                    kept,
                    plan.expected_size,
                    &plan.expected_sha256,
                ) {
                    Ok((_p, id)) => {
                        if let Some(fid) = id.key {
                            verified_keep_ids.insert(fid);
                        }
                    }
                    Err(reason) => {
                        group_abort_reason = Some(format!(
                            "Kept copy \"{}\" failed verification ({reason}); skipped entire group to protect remaining copies.",
                            kept.path
                        ));
                        break;
                    }
                }
            }

            if let Some(reason) = group_abort_reason {
                for rem in &plan.remove_targets {
                    skipped_count += 1;
                    outcomes.push(RecycleItemOutcome {
                        group_id: plan.group_id.clone(),
                        path: rem.path.clone(),
                        byte_length: plan.expected_size,
                        status: RecycleOutcomeStatus::Skipped,
                        reason: Some(reason.clone()),
                    });
                }
                continue;
            }

            // 2. Process each removal target individually after re-verifying its own hash & identity
            for rem in &plan.remove_targets {
                let raw_path = PathBuf::from(rem.path.trim());

                // Check volume Recycle Bin support on raw path BEFORE opening/touching
                #[cfg(windows)]
                if let Err(vol_reason) = win_recycle::verify_volume_supports_recycle_bin(&raw_path)
                {
                    skipped_count += 1;
                    outcomes.push(RecycleItemOutcome {
                        group_id: plan.group_id.clone(),
                        path: rem.path.clone(),
                        byte_length: plan.expected_size,
                        status: RecycleOutcomeStatus::Skipped,
                        reason: Some(vol_reason),
                    });
                    continue;
                }

                let (verified_path, rem_identity) = match verify_target_matches_snapshot(
                    rem,
                    plan.expected_size,
                    &plan.expected_sha256,
                ) {
                    Ok(v) => v,
                    Err(reason) => {
                        skipped_count += 1;
                        outcomes.push(RecycleItemOutcome {
                            group_id: plan.group_id.clone(),
                            path: rem.path.clone(),
                            byte_length: plan.expected_size,
                            status: RecycleOutcomeStatus::Skipped,
                            reason: Some(format!(
                                "Selected file failed pre-recycle check ({reason}); skipped."
                            )),
                        });
                        continue;
                    }
                };

                if let Some(ref rem_fid) = rem_identity.key {
                    if verified_keep_ids.len() == 1 && verified_keep_ids.contains(rem_fid) {
                        skipped_count += 1;
                        outcomes.push(RecycleItemOutcome {
                            group_id: plan.group_id.clone(),
                            path: rem.path.clone(),
                            byte_length: plan.expected_size,
                            status: RecycleOutcomeStatus::Skipped,
                            reason: Some(
                                "Selected path is a hardlink to the sole kept file; skipped."
                                    .to_string(),
                            ),
                        });
                        continue;
                    }
                }

                #[cfg(windows)]
                {
                    match win_recycle::recycle_single_file_on_sta(&verified_path) {
                        Ok(_recycled_shell_path) => {
                            recycled_count += 1;
                            recycled_bytes = recycled_bytes.saturating_add(plan.expected_size);
                            outcomes.push(RecycleItemOutcome {
                                group_id: plan.group_id.clone(),
                                path: rem.path.clone(),
                                byte_length: plan.expected_size,
                                status: RecycleOutcomeStatus::Recycled,
                                reason: None,
                            });
                        }
                        Err(StrictRecycleError::Skipped(reason)) => {
                            skipped_count += 1;
                            outcomes.push(RecycleItemOutcome {
                                group_id: plan.group_id.clone(),
                                path: rem.path.clone(),
                                byte_length: plan.expected_size,
                                status: RecycleOutcomeStatus::Skipped,
                                reason: Some(reason),
                            });
                        }
                        Err(StrictRecycleError::Failed(reason)) => {
                            failed_count += 1;
                            outcomes.push(RecycleItemOutcome {
                                group_id: plan.group_id.clone(),
                                path: rem.path.clone(),
                                byte_length: plan.expected_size,
                                status: RecycleOutcomeStatus::Failed,
                                reason: Some(reason),
                            });
                        }
                    }
                }

                #[cfg(not(windows))]
                {
                    let _ = verified_path;
                    let _ = StrictRecycleError::Failed(String::new());
                    skipped_count += 1;
                    outcomes.push(RecycleItemOutcome {
                        group_id: plan.group_id.clone(),
                        path: rem.path.clone(),
                        byte_length: plan.expected_size,
                        status: RecycleOutcomeStatus::Skipped,
                        reason: Some(
                            "Windows Recycle Bin is only supported on Windows.".to_string(),
                        ),
                    });
                }
            }
        }

        Ok(DuplicateRecycleResponse {
            recycled_count,
            recycled_bytes,
            skipped_count,
            failed_count,
            outcomes,
        })
    });

    handle.join().map_err(|_| {
        AppError::new(
            "INTERNAL_JOIN_ERROR",
            "Recycle Bin worker thread terminated unexpectedly.",
        )
    })?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn scenario_1_identical_content_grouped_while_same_size_and_head_tail_with_different_middle_separated(
    ) {
        let dir = tempdir().expect("tempdir");
        let dup_a = dir.path().join("photo_original.bin");
        let dup_b = dir.path().join("backup_copy_renamed.bin");
        let payload_dup: Vec<u8> = (0..200_000u32)
            .map(|i| ((i * 31 + 7) & 0xFF) as u8)
            .collect();
        fs::write(&dup_a, &payload_dup).expect("write dup_a");
        fs::write(&dup_b, &payload_dup).expect("write dup_b");

        // Two 256 KiB files: identical size (262,144 B), identical first 64 KiB, identical last 64 KiB,
        // different byte at middle offset 131,072!
        let mid_1 = dir.path().join("stream_variant_1.bin");
        let mid_2 = dir.path().join("stream_variant_2.bin");
        let mut buf_1 = vec![0xABu8; 256 * 1024];
        for (idx, b) in buf_1[..EDGE_CHUNK_BYTES].iter_mut().enumerate() {
            *b = (idx & 0xFF) as u8;
        }
        let tail_start = buf_1.len() - EDGE_CHUNK_BYTES;
        for (idx, b) in buf_1[tail_start..].iter_mut().enumerate() {
            *b = ((idx * 3) & 0xFF) as u8;
        }
        let mut buf_2 = buf_1.clone();
        buf_1[131_072] = 0x11;
        buf_2[131_072] = 0x22;
        fs::write(&mid_1, &buf_1).expect("write mid_1");
        fs::write(&mid_2, &buf_2).expect("write mid_2");

        let cancel = AtomicBool::new(false);
        let res = scan_duplicates_impl(
            "test-s1",
            &DuplicateScanOptions {
                root_paths: vec![dir.path().to_string_lossy().into_owned()],
                min_size_bytes: 0,
                include_hidden: true,
            },
            &cancel,
            |_| {},
        )
        .expect("scan succeeds");

        assert_eq!(
            res.groups.len(),
            1,
            "only exact full-content match may group"
        );
        assert_eq!(res.groups[0].byte_length, 200_000);
        assert_eq!(res.groups[0].reclaimable_bytes, 200_000);
        let grouped_names: Vec<&str> = res.groups[0]
            .files
            .iter()
            .map(|f| f.file_name.as_str())
            .collect();
        assert_eq!(
            grouped_names,
            vec!["backup_copy_renamed.bin", "photo_original.bin"]
        );
    }

    #[test]
    fn scenario_2_parent_child_dedup_empty_files_hardlinks_and_cancel_then_rescan() {
        let dir = tempdir().expect("tempdir");
        let sub = dir.path().join("sub_folder");
        fs::create_dir_all(&sub).expect("mkdir sub");

        // Two independent 0-byte empty files
        let empty_1 = dir.path().join("empty_a.txt");
        let empty_2 = sub.join("empty_b.txt");
        fs::write(&empty_1, b"").expect("write empty 1");
        fs::write(&empty_2, b"").expect("write empty 2");

        // NTFS hardlink pair (`hard_primary.dat` and `hard_alias.dat` share the exact same file allocation!)
        let hard_primary = dir.path().join("hard_primary.dat");
        let hard_alias = sub.join("hard_alias.dat");
        fs::write(&hard_primary, vec![0x5Au8; 8192]).expect("write hard_primary");
        fs::hard_link(&hard_primary, &hard_alias).expect("create hardlink");

        // 1) Pre-set cancel flag -> returns TASK_CANCELLED cleanly
        let pre_cancelled = AtomicBool::new(true);
        let cancel_err = scan_duplicates_impl(
            "test-cancel",
            &DuplicateScanOptions {
                root_paths: vec![dir.path().to_string_lossy().into_owned()],
                min_size_bytes: 0,
                include_hidden: true,
            },
            &pre_cancelled,
            |_| {},
        )
        .expect_err("cancelled scan must return error");
        assert_eq!(cancel_err.code, "TASK_CANCELLED");

        // 2) Re-scan with repeated root + child directory (`root`, `root`, `root\sub_folder`)
        let fresh_cancel = AtomicBool::new(false);
        let root_str = dir.path().to_string_lossy().into_owned();
        let sub_str = sub.to_string_lossy().into_owned();
        let res = scan_duplicates_impl(
            "test-rescan",
            &DuplicateScanOptions {
                root_paths: vec![root_str.clone(), root_str, sub_str],
                min_size_bytes: 0,
                include_hidden: true,
            },
            &fresh_cancel,
            |_| {},
        )
        .expect("rescan succeeds");

        assert_eq!(res.effective_roots.len(), 1);
        assert_eq!(res.collapsed_redundant_roots.len(), 2);
        // Hardlink alias was detected and NOT counted as an independent reclaimable copy!
        assert_eq!(res.skipped_hardlinks.len(), 1);
        assert_eq!(res.total_reclaimable_bytes, 0);
        // Only the 2 independent 0-byte files form a duplicate group
        assert_eq!(res.groups.len(), 1);
        assert_eq!(res.groups[0].byte_length, 0);
        assert_eq!(res.groups[0].files.len(), 2);
    }

    #[test]
    fn scenario_3_skips_group_and_protects_remaining_copies_when_kept_copy_moved_or_modified() {
        let dir = tempdir().expect("tempdir");
        let keep_file = dir.path().join("keep_me.txt");
        let extra_file = dir.path().join("remove_me.txt");
        fs::write(&keep_file, b"CRITICAL_SHARED_DOCUMENT_V1").expect("write keep");
        fs::write(&extra_file, b"CRITICAL_SHARED_DOCUMENT_V1").expect("write extra");

        let cancel = AtomicBool::new(false);
        let scan = scan_duplicates_impl(
            "test-s3",
            &DuplicateScanOptions {
                root_paths: vec![dir.path().to_string_lossy().into_owned()],
                min_size_bytes: 0,
                include_hidden: true,
            },
            &cancel,
            |_| {},
        )
        .expect("scan");
        assert_eq!(scan.groups.len(), 1);
        let g = &scan.groups[0];
        let keep_entry = g
            .files
            .iter()
            .find(|f| f.file_name == "keep_me.txt")
            .expect("keep entry");
        let rem_entry = g
            .files
            .iter()
            .find(|f| f.file_name == "remove_me.txt")
            .expect("rem entry");

        // Case 3A: Modify content of kept copy after scan -> group must be skipped & extra_file intact!
        fs::write(&keep_file, b"MODIFIED_DIFFERENT_LENGTH_OR_BYTES!").expect("mutate kept");
        let resp_modified = recycle_duplicate_groups_impl(&[RecycleGroupPlan {
            group_id: g.group_id.clone(),
            expected_size: g.byte_length,
            expected_sha256: g.sha256.clone(),
            remove_targets: vec![DuplicateVerifyTarget {
                path: rem_entry.path.clone(),
                expected_file_id_key: rem_entry.file_id_key.clone(),
            }],
            keep_targets: vec![DuplicateVerifyTarget {
                path: keep_entry.path.clone(),
                expected_file_id_key: keep_entry.file_id_key.clone(),
            }],
        }])
        .expect("recycle response");

        assert_eq!(resp_modified.recycled_count, 0);
        assert_eq!(resp_modified.skipped_count, 1);
        assert_eq!(
            fs::read(&extra_file).expect("extra_file must remain untouched"),
            b"CRITICAL_SHARED_DOCUMENT_V1"
        );

        // Case 3B: Move away/delete kept copy after scan -> group must be skipped & extra_file intact!
        fs::remove_file(&keep_file).expect("remove kept");
        let resp_missing = recycle_duplicate_groups_impl(&[RecycleGroupPlan {
            group_id: g.group_id.clone(),
            expected_size: g.byte_length,
            expected_sha256: g.sha256.clone(),
            remove_targets: vec![DuplicateVerifyTarget {
                path: rem_entry.path.clone(),
                expected_file_id_key: rem_entry.file_id_key.clone(),
            }],
            keep_targets: vec![DuplicateVerifyTarget {
                path: keep_entry.path.clone(),
                expected_file_id_key: keep_entry.file_id_key.clone(),
            }],
        }])
        .expect("recycle response");

        assert_eq!(resp_missing.recycled_count, 0);
        assert_eq!(resp_missing.skipped_count, 1);
        assert_eq!(
            fs::read(&extra_file).expect("extra_file still intact when kept copy vanished"),
            b"CRITICAL_SHARED_DOCUMENT_V1"
        );
    }

    #[cfg(windows)]
    #[test]
    fn scenario_4_moves_real_sample_to_windows_recycle_bin_restores_and_verifies_hash_and_skips_unrecyclable_unc(
    ) {
        let dir = tempdir().expect("tempdir");
        let keep_path = dir.path().join("winkit_f03_keep_sample.txt");
        let recycle_path = dir.path().join("winkit_f03_recycle_restore_sample.txt");
        let sample_bytes = b"WinKit F03 Real Windows Recycle Bin Roundtrip Payload 2026-11-22\n";
        fs::write(&keep_path, sample_bytes).expect("write keep");
        fs::write(&recycle_path, sample_bytes).expect("write recycle sample");

        let expected_hash = bytes_to_lower_hex(&Sha256::digest(sample_bytes));

        // 1) Test unrecyclable UNC path guard -> must skip and leave physical file on disk untouched!
        let canon_recycle = strip_verbatim(&fs::canonicalize(&recycle_path).expect("canon"));
        let raw_s = canon_recycle.to_string_lossy();
        // Convert `C:\...` -> `\\127.0.0.1\c$\...` UNC form to verify UNC Recycle Bin rejection
        let unc_candidate = if raw_s.len() > 3 && raw_s.as_bytes()[1] == b':' {
            let drive = (raw_s.as_bytes()[0] as char).to_ascii_lowercase();
            format!(r"\\127.0.0.1\{drive}$\{}", &raw_s[3..])
        } else {
            r"\\127.0.0.1\share\nonrecyclable.txt".to_string()
        };

        let unc_resp = recycle_duplicate_groups_impl(&[RecycleGroupPlan {
            group_id: format!("{}:{expected_hash}", sample_bytes.len()),
            expected_size: sample_bytes.len() as u64,
            expected_sha256: expected_hash.clone(),
            remove_targets: vec![DuplicateVerifyTarget {
                path: unc_candidate,
                expected_file_id_key: None,
            }],
            keep_targets: vec![DuplicateVerifyTarget {
                path: keep_path.to_string_lossy().into_owned(),
                expected_file_id_key: None,
            }],
        }])
        .expect("unc check");
        assert_eq!(unc_resp.recycled_count, 0);
        assert_eq!(unc_resp.skipped_count, 1);
        assert!(
            recycle_path.exists(),
            "source file must remain intact when Recycle Bin cannot be guaranteed"
        );

        // 2) Move `recycle_path` to the real Windows Recycle Bin on local fixed drive,
        // capture its `$Recycle.Bin\...\$R...` item path, restore it via IFileOperation::MoveItem,
        // and verify exact restored path + SHA-256!
        let _sta = win_recycle::ComApartmentGuard::enter_sta().expect("enter STA");
        let recycled_shell_path = win_recycle::recycle_single_file_on_sta(&canon_recycle)
            .expect("real Windows Recycle Bin move succeeds")
            .expect("PostDeleteItem must report created $Recycle.Bin item path");

        assert!(
            !canon_recycle.exists(),
            "file must no longer exist at original location after moving to Recycle Bin"
        );
        let recycled_r_buf = PathBuf::from(&recycled_shell_path);
        assert!(
            recycled_r_buf.exists(),
            "recycled item must exist inside Windows $Recycle.Bin"
        );

        win_recycle::restore_recycled_item_on_sta(
            &recycled_r_buf,
            canon_recycle.parent().expect("parent"),
            "winkit_f03_recycle_restore_sample.txt",
        )
        .expect("restore from Windows Recycle Bin succeeds");

        assert!(
            canon_recycle.exists(),
            "restored file must reappear at exact original path"
        );
        let restored_bytes = fs::read(&canon_recycle).expect("read restored file");
        let restored_hash = bytes_to_lower_hex(&Sha256::digest(&restored_bytes));
        assert_eq!(restored_hash, expected_hash);
        assert_eq!(restored_bytes.as_slice(), sample_bytes);
    }
}
