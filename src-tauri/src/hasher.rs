use crate::error::AppError;
use crate::fs_guard::validate_existing_input_file;
use crate::tasks::{TaskLifecycleState, TaskProgressPayload, TaskRegistry, TaskTokenGuard};
use md5::Md5;
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha384, Sha512};
use std::fs::OpenOptions;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const STREAM_CHUNK_BYTES: usize = 256 * 1024; // 256 KiB fixed streaming buffer
pub const MAX_HASH_BATCH_ITEMS: usize = 1_000;
pub const HASH_BATCH_ITEM_EVENT: &str = "winkit://hash-batch-item";

#[cfg(windows)]
const WINDOWS_FILE_SHARE_READ_ONLY: u32 = 0x0000_0001; // FILE_SHARE_READ (denies concurrent write/delete)

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum HashAlgorithm {
    #[serde(rename = "MD5")]
    Md5,
    #[serde(rename = "SHA-1")]
    Sha1,
    #[serde(rename = "SHA-256")]
    Sha256,
    #[serde(rename = "SHA-384")]
    Sha384,
    #[serde(rename = "SHA-512")]
    Sha512,
}

impl HashAlgorithm {
    pub const ALL: [HashAlgorithm; 5] = [
        HashAlgorithm::Md5,
        HashAlgorithm::Sha1,
        HashAlgorithm::Sha256,
        HashAlgorithm::Sha384,
        HashAlgorithm::Sha512,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            HashAlgorithm::Md5 => "MD5",
            HashAlgorithm::Sha1 => "SHA-1",
            HashAlgorithm::Sha256 => "SHA-256",
            HashAlgorithm::Sha384 => "SHA-384",
            HashAlgorithm::Sha512 => "SHA-512",
        }
    }

    pub fn hex_length(self) -> usize {
        match self {
            HashAlgorithm::Md5 => 32,
            HashAlgorithm::Sha1 => 40,
            HashAlgorithm::Sha256 => 64,
            HashAlgorithm::Sha384 => 96,
            HashAlgorithm::Sha512 => 128,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlgorithmDigestEntry {
    pub algorithm: HashAlgorithm,
    pub hex_length: usize,
    pub digest_hex: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiTextHashResult {
    pub byte_length: usize,
    pub digests: Vec<AlgorithmDigestEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiFileHashResult {
    pub task_id: String,
    pub path: String,
    pub file_name: String,
    pub byte_length: u64,
    pub digests: Vec<AlgorithmDigestEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchHashInputItem {
    pub item_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BatchItemLifecycleState {
    Running,
    Completed,
    Cancelled,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HashBatchItemProgressPayload {
    pub batch_id: String,
    pub item_id: String,
    pub index: usize,
    pub total_items: usize,
    pub state: BatchItemLifecycleState,
    pub processed_bytes: u64,
    pub total_bytes: Option<u64>,
    pub percent: Option<f64>,
    pub byte_length: Option<u64>,
    pub digests: Option<Vec<AlgorithmDigestEntry>>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchFileItemResult {
    pub item_id: String,
    pub path: String,
    pub file_name: String,
    pub status: BatchItemLifecycleState,
    pub byte_length: Option<u64>,
    pub digests: Option<Vec<AlgorithmDigestEntry>>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiFileBatchHashResult {
    pub batch_id: String,
    pub cancelled: bool,
    pub items: Vec<BatchFileItemResult>,
}

fn to_lower_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

fn extract_display_file_name(raw_path: &str) -> String {
    Path::new(raw_path.trim())
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| raw_path.trim().to_string())
}

pub fn normalize_algorithms(algorithms: &[HashAlgorithm]) -> Result<Vec<HashAlgorithm>, AppError> {
    if algorithms.is_empty() {
        return Err(AppError::invalid_param(
            "At least one hash algorithm must be selected.",
        ));
    }
    let mut ordered = Vec::with_capacity(HashAlgorithm::ALL.len());
    for candidate in HashAlgorithm::ALL {
        if algorithms.contains(&candidate) {
            ordered.push(candidate);
        }
    }
    Ok(ordered)
}

struct MultiHasher {
    md5: Option<Md5>,
    sha1: Option<Sha1>,
    sha256: Option<Sha256>,
    sha384: Option<Sha384>,
    sha512: Option<Sha512>,
}

impl MultiHasher {
    fn new(selected: &[HashAlgorithm]) -> Self {
        Self {
            md5: selected.contains(&HashAlgorithm::Md5).then(Md5::new),
            sha1: selected.contains(&HashAlgorithm::Sha1).then(Sha1::new),
            sha256: selected.contains(&HashAlgorithm::Sha256).then(Sha256::new),
            sha384: selected.contains(&HashAlgorithm::Sha384).then(Sha384::new),
            sha512: selected.contains(&HashAlgorithm::Sha512).then(Sha512::new),
        }
    }

    #[inline]
    fn update(&mut self, chunk: &[u8]) {
        if let Some(h) = self.md5.as_mut() {
            h.update(chunk);
        }
        if let Some(h) = self.sha1.as_mut() {
            h.update(chunk);
        }
        if let Some(h) = self.sha256.as_mut() {
            h.update(chunk);
        }
        if let Some(h) = self.sha384.as_mut() {
            h.update(chunk);
        }
        if let Some(h) = self.sha512.as_mut() {
            h.update(chunk);
        }
    }

    fn finalize(self) -> Vec<AlgorithmDigestEntry> {
        let mut out = Vec::with_capacity(5);
        if let Some(h) = self.md5 {
            out.push(AlgorithmDigestEntry {
                algorithm: HashAlgorithm::Md5,
                hex_length: HashAlgorithm::Md5.hex_length(),
                digest_hex: to_lower_hex(&h.finalize()),
            });
        }
        if let Some(h) = self.sha1 {
            out.push(AlgorithmDigestEntry {
                algorithm: HashAlgorithm::Sha1,
                hex_length: HashAlgorithm::Sha1.hex_length(),
                digest_hex: to_lower_hex(&h.finalize()),
            });
        }
        if let Some(h) = self.sha256 {
            out.push(AlgorithmDigestEntry {
                algorithm: HashAlgorithm::Sha256,
                hex_length: HashAlgorithm::Sha256.hex_length(),
                digest_hex: to_lower_hex(&h.finalize()),
            });
        }
        if let Some(h) = self.sha384 {
            out.push(AlgorithmDigestEntry {
                algorithm: HashAlgorithm::Sha384,
                hex_length: HashAlgorithm::Sha384.hex_length(),
                digest_hex: to_lower_hex(&h.finalize()),
            });
        }
        if let Some(h) = self.sha512 {
            out.push(AlgorithmDigestEntry {
                algorithm: HashAlgorithm::Sha512,
                hex_length: HashAlgorithm::Sha512.hex_length(),
                digest_hex: to_lower_hex(&h.finalize()),
            });
        }
        out
    }
}

/// Computes all selected digests over the exact UTF-8 byte sequence of `text` with zero implicit trimming.
pub fn compute_text_hashes(
    text: &str,
    algorithms: &[HashAlgorithm],
) -> Result<MultiTextHashResult, AppError> {
    let normalized = normalize_algorithms(algorithms)?;
    let raw = text.as_bytes();
    let mut hasher = MultiHasher::new(&normalized);
    hasher.update(raw);
    Ok(MultiTextHashResult {
        byte_length: raw.len(),
        digests: hasher.finalize(),
    })
}

fn open_readonly_denying_write(path: &Path) -> Result<std::fs::File, AppError> {
    let mut opts = OpenOptions::new();
    opts.read(true).write(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        opts.share_mode(WINDOWS_FILE_SHARE_READ_ONLY);
    }
    opts.open(path)
        .map_err(|e| AppError::from_io(e, "Unable to open file for hashing"))
}

/// Streams `path` in fixed 256 KiB chunks in a SINGLE pass, updating all selected digest states
/// per chunk and checking `cancel_flag` on every iteration.
pub fn stream_file_hashes<F>(
    path: &Path,
    algorithms: &[HashAlgorithm],
    expected_total: u64,
    cancel_flag: &AtomicBool,
    on_progress: F,
) -> Result<(u64, Vec<AlgorithmDigestEntry>), AppError>
where
    F: FnMut(u64, Option<u64>),
{
    let mut processed = 0u64;
    stream_file_hashes_tracked(
        path,
        algorithms,
        expected_total,
        cancel_flag,
        &mut processed,
        on_progress,
    )
}

fn stream_file_hashes_tracked<F>(
    path: &Path,
    algorithms: &[HashAlgorithm],
    _expected_total_hint: u64,
    cancel_flag: &AtomicBool,
    processed_out: &mut u64,
    mut on_progress: F,
) -> Result<(u64, Vec<AlgorithmDigestEntry>), AppError>
where
    F: FnMut(u64, Option<u64>),
{
    *processed_out = 0;
    let normalized = normalize_algorithms(algorithms)?;
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let mut file = open_readonly_denying_write(path)?;
    let meta_before = file
        .metadata()
        .map_err(|e| AppError::from_io(e, "Unable to query open file metadata"))?;
    if meta_before.is_dir() {
        return Err(AppError::new(
            "IS_DIRECTORY",
            "Selected input path is a directory, not a file.",
        ));
    }
    if !meta_before.is_file() {
        return Err(AppError::invalid_param(
            "Selected input path is not a regular file.",
        ));
    }

    let handle_len_before = meta_before.len();
    let mtime_before = meta_before.modified().ok();
    let total_opt = Some(handle_len_before);
    on_progress(0, total_opt);

    let mut hasher = MultiHasher::new(&normalized);
    let mut buffer = vec![0u8; STREAM_CHUNK_BYTES];
    let mut last_emit = Instant::now();

    loop {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(AppError::cancelled());
        }

        let n = file
            .read(&mut buffer)
            .map_err(|e| AppError::from_io(e, "Error while streaming file bytes"))?;

        if n == 0 {
            break;
        }

        if cancel_flag.load(Ordering::Relaxed) {
            return Err(AppError::cancelled());
        }

        hasher.update(&buffer[..n]);
        *processed_out += n as u64;
        let processed = *processed_out;

        let now = Instant::now();
        if now.duration_since(last_emit) >= Duration::from_millis(25) {
            on_progress(processed, total_opt);
            last_emit = now;
        }
    }

    let processed = *processed_out;
    let meta_after = file
        .metadata()
        .map_err(|e| AppError::from_io(e, "Unable to verify file metadata after reading"))?;
    // Release the OS file handle promptly before finalizing digests or advancing a batch queue.
    drop(file);

    let mtime_changed = mtime_before.is_some() && meta_after.modified().ok() != mtime_before;
    if processed != handle_len_before || meta_after.len() != handle_len_before || mtime_changed {
        return Err(AppError::new(
            "FILE_MODIFIED_DURING_READ",
            "File size or modification time changed while reading; digest aborted.",
        ));
    }

    on_progress(processed, Some(processed));
    Ok((processed, hasher.finalize()))
}

pub fn prepare_file_hash_task(
    registry: &TaskRegistry,
    task_id: &str,
    algorithms: &[HashAlgorithm],
) -> Result<(TaskTokenGuard, Vec<HashAlgorithm>), AppError> {
    if task_id.trim().is_empty() {
        return Err(AppError::invalid_param("task_id must not be empty."));
    }
    let normalized = normalize_algorithms(algorithms)?;
    let guard = registry.register_checked(task_id, "D03", true)?;
    Ok((guard, normalized))
}

pub fn execute_file_hash_with_guard<E>(
    guard: TaskTokenGuard,
    raw_path: &str,
    normalized: &[HashAlgorithm],
    mut on_event: E,
) -> Result<MultiFileHashResult, AppError>
where
    E: FnMut(&TaskProgressPayload),
{
    let task_id = guard.task_id().to_string();
    let (path, file_len) = match validate_existing_input_file(raw_path) {
        Ok(v) => v,
        Err(err) => {
            drop(guard);
            on_event(&TaskProgressPayload::failed_or_cancelled(
                &task_id, "D03", 0, None, &err,
            ));
            return Err(err);
        }
    };

    let cancel_flag = guard.cancel_flag();
    let mut processed_so_far = 0u64;
    let result = stream_file_hashes_tracked(
        &path,
        normalized,
        file_len,
        &cancel_flag,
        &mut processed_so_far,
        |processed, total| {
            let percent = match total {
                Some(0) => Some(100.0),
                Some(t) => Some(((processed as f64 / t as f64) * 100.0).clamp(0.0, 100.0)),
                None => None,
            };
            on_event(&TaskProgressPayload {
                task_id: task_id.clone(),
                tool_id: "D03".to_string(),
                state: TaskLifecycleState::Running,
                processed_bytes: processed,
                total_bytes: total,
                percent,
                error_code: None,
                error_message: None,
            });
        },
    );

    drop(guard);

    match result {
        Ok((actual_bytes, digests)) => {
            on_event(&TaskProgressPayload::completed(
                &task_id,
                "D03",
                actual_bytes,
                Some(actual_bytes),
            ));
            let file_name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            Ok(MultiFileHashResult {
                task_id,
                path: path.to_string_lossy().into_owned(),
                file_name,
                byte_length: actual_bytes,
                digests,
            })
        }
        Err(err) => {
            on_event(&TaskProgressPayload::failed_or_cancelled(
                &task_id,
                "D03",
                processed_so_far,
                Some(file_len),
                &err,
            ));
            Err(err)
        }
    }
}

pub fn execute_file_hash_task<E>(
    registry: &TaskRegistry,
    task_id: &str,
    raw_path: &str,
    algorithms: &[HashAlgorithm],
    on_event: E,
) -> Result<MultiFileHashResult, AppError>
where
    E: FnMut(&TaskProgressPayload),
{
    let (guard, normalized) = prepare_file_hash_task(registry, task_id, algorithms)?;
    execute_file_hash_with_guard(guard, raw_path, &normalized, on_event)
}

pub fn prepare_batch_hash_task(
    registry: &TaskRegistry,
    batch_id: &str,
    items: &[BatchHashInputItem],
    algorithms: &[HashAlgorithm],
) -> Result<(TaskTokenGuard, Vec<HashAlgorithm>), AppError> {
    if batch_id.trim().is_empty() {
        return Err(AppError::invalid_param("batch_id must not be empty."));
    }
    if items.is_empty() {
        return Err(AppError::invalid_param(
            "At least one file item is required for batch hashing.",
        ));
    }
    if items.len() > MAX_HASH_BATCH_ITEMS {
        return Err(AppError::size_limit(format!(
            "Batch exceeds the {MAX_HASH_BATCH_ITEMS}-file limit ({} items).",
            items.len()
        )));
    }
    for item in items {
        if item.item_id.trim().is_empty() {
            return Err(AppError::invalid_param(
                "Each batch item must carry a non-empty itemId.",
            ));
        }
    }
    let normalized = normalize_algorithms(algorithms)?;
    // A single TaskTokenGuard spans the entire sequential batch attempt so there is NEVER a
    // between-file `active_count == 0` shutdown gap while queued items remain.
    let guard = registry.register_checked(batch_id, "D03", true)?;
    Ok((guard, normalized))
}

pub fn execute_batch_hash_with_guard<ETask, EItem>(
    guard: TaskTokenGuard,
    items: &[BatchHashInputItem],
    normalized: &[HashAlgorithm],
    on_task_event: ETask,
    on_item_event: EItem,
) -> MultiFileBatchHashResult
where
    ETask: FnMut(&TaskProgressPayload),
    EItem: FnMut(&HashBatchItemProgressPayload),
{
    execute_batch_hash_internal(
        guard,
        items,
        normalized,
        on_task_event,
        on_item_event,
        |_, _| {},
    )
}

fn execute_batch_hash_internal<ETask, EItem, HBetween>(
    guard: TaskTokenGuard,
    items: &[BatchHashInputItem],
    normalized: &[HashAlgorithm],
    mut on_task_event: ETask,
    mut on_item_event: EItem,
    mut on_between_files: HBetween,
) -> MultiFileBatchHashResult
where
    ETask: FnMut(&TaskProgressPayload),
    EItem: FnMut(&HashBatchItemProgressPayload),
    HBetween: FnMut(usize, &AtomicBool),
{
    let batch_id = guard.task_id().to_string();
    let cancel_flag = guard.cancel_flag();
    let total_items = items.len();
    let mut results = Vec::with_capacity(total_items);
    let mut cumulative_bytes = 0u64;
    let mut cancelled = false;

    on_task_event(&TaskProgressPayload::running(&batch_id, "D03", None));

    for (idx, item) in items.iter().enumerate() {
        if idx > 0 {
            on_between_files(idx, &cancel_flag);
        }

        if cancel_flag.load(Ordering::Relaxed) {
            cancelled = true;
            for rem in &items[idx..] {
                results.push(BatchFileItemResult {
                    item_id: rem.item_id.clone(),
                    path: rem.path.clone(),
                    file_name: extract_display_file_name(&rem.path),
                    status: BatchItemLifecycleState::Cancelled,
                    byte_length: None,
                    digests: None,
                    error_code: Some("TASK_CANCELLED".to_string()),
                    error_message: Some("Operation was cancelled by user.".to_string()),
                });
            }
            break;
        }

        let display_name = extract_display_file_name(&item.path);
        let (path_buf, file_len) = match validate_existing_input_file(&item.path) {
            Ok(v) => v,
            Err(err) => {
                on_item_event(&HashBatchItemProgressPayload {
                    batch_id: batch_id.clone(),
                    item_id: item.item_id.clone(),
                    index: idx,
                    total_items,
                    state: BatchItemLifecycleState::Error,
                    processed_bytes: 0,
                    total_bytes: None,
                    percent: None,
                    byte_length: None,
                    digests: None,
                    error_code: Some(err.code.to_string()),
                    error_message: Some(err.message.clone()),
                });
                results.push(BatchFileItemResult {
                    item_id: item.item_id.clone(),
                    path: item.path.clone(),
                    file_name: display_name,
                    status: BatchItemLifecycleState::Error,
                    byte_length: None,
                    digests: None,
                    error_code: Some(err.code.to_string()),
                    error_message: Some(err.message),
                });
                continue;
            }
        };

        let resolved_name = path_buf
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or(display_name);
        let resolved_path = path_buf.to_string_lossy().into_owned();

        let mut item_processed = 0u64;
        let stream_res = stream_file_hashes_tracked(
            &path_buf,
            normalized,
            file_len,
            &cancel_flag,
            &mut item_processed,
            |processed, total| {
                let item_pct = match total {
                    Some(0) => Some(100.0),
                    Some(t) => Some(((processed as f64 / t as f64) * 100.0).clamp(0.0, 100.0)),
                    None => None,
                };
                let batch_pct = Some(
                    (((idx as f64) + item_pct.unwrap_or(0.0) / 100.0) / (total_items as f64)
                        * 100.0)
                        .clamp(0.0, 99.99),
                );
                on_item_event(&HashBatchItemProgressPayload {
                    batch_id: batch_id.clone(),
                    item_id: item.item_id.clone(),
                    index: idx,
                    total_items,
                    state: BatchItemLifecycleState::Running,
                    processed_bytes: processed,
                    total_bytes: total,
                    percent: item_pct,
                    byte_length: total,
                    digests: None,
                    error_code: None,
                    error_message: None,
                });
                on_task_event(&TaskProgressPayload {
                    task_id: batch_id.clone(),
                    tool_id: "D03".to_string(),
                    state: TaskLifecycleState::Running,
                    processed_bytes: cumulative_bytes.saturating_add(processed),
                    total_bytes: None,
                    percent: batch_pct,
                    error_code: None,
                    error_message: None,
                });
            },
        );

        match stream_res {
            Ok((actual_bytes, digests)) => {
                cumulative_bytes = cumulative_bytes.saturating_add(actual_bytes);
                on_item_event(&HashBatchItemProgressPayload {
                    batch_id: batch_id.clone(),
                    item_id: item.item_id.clone(),
                    index: idx,
                    total_items,
                    state: BatchItemLifecycleState::Completed,
                    processed_bytes: actual_bytes,
                    total_bytes: Some(actual_bytes),
                    percent: Some(100.0),
                    byte_length: Some(actual_bytes),
                    digests: Some(digests.clone()),
                    error_code: None,
                    error_message: None,
                });
                results.push(BatchFileItemResult {
                    item_id: item.item_id.clone(),
                    path: resolved_path,
                    file_name: resolved_name,
                    status: BatchItemLifecycleState::Completed,
                    byte_length: Some(actual_bytes),
                    digests: Some(digests),
                    error_code: None,
                    error_message: None,
                });
            }
            Err(err) if err.code == "TASK_CANCELLED" => {
                cancelled = true;
                on_item_event(&HashBatchItemProgressPayload {
                    batch_id: batch_id.clone(),
                    item_id: item.item_id.clone(),
                    index: idx,
                    total_items,
                    state: BatchItemLifecycleState::Cancelled,
                    processed_bytes: item_processed,
                    total_bytes: Some(file_len),
                    percent: None,
                    byte_length: Some(file_len),
                    digests: None,
                    error_code: Some(err.code.to_string()),
                    error_message: Some(err.message.clone()),
                });
                results.push(BatchFileItemResult {
                    item_id: item.item_id.clone(),
                    path: resolved_path,
                    file_name: resolved_name,
                    status: BatchItemLifecycleState::Cancelled,
                    byte_length: Some(file_len),
                    digests: None,
                    error_code: Some(err.code.to_string()),
                    error_message: Some(err.message),
                });
                // Do NOT open or schedule any subsequent waiting files after cancellation
                for rem in &items[(idx + 1)..] {
                    results.push(BatchFileItemResult {
                        item_id: rem.item_id.clone(),
                        path: rem.path.clone(),
                        file_name: extract_display_file_name(&rem.path),
                        status: BatchItemLifecycleState::Cancelled,
                        byte_length: None,
                        digests: None,
                        error_code: Some("TASK_CANCELLED".to_string()),
                        error_message: Some("Operation was cancelled by user.".to_string()),
                    });
                }
                break;
            }
            Err(err) => {
                on_item_event(&HashBatchItemProgressPayload {
                    batch_id: batch_id.clone(),
                    item_id: item.item_id.clone(),
                    index: idx,
                    total_items,
                    state: BatchItemLifecycleState::Error,
                    processed_bytes: item_processed,
                    total_bytes: Some(file_len),
                    percent: None,
                    byte_length: Some(file_len),
                    digests: None,
                    error_code: Some(err.code.to_string()),
                    error_message: Some(err.message.clone()),
                });
                results.push(BatchFileItemResult {
                    item_id: item.item_id.clone(),
                    path: resolved_path,
                    file_name: resolved_name,
                    status: BatchItemLifecycleState::Error,
                    byte_length: Some(file_len),
                    digests: None,
                    error_code: Some(err.code.to_string()),
                    error_message: Some(err.message),
                });
            }
        }
    }

    // Drop the batch guard BEFORE emitting final event so TaskRegistry reaches 0 active count immediately
    drop(guard);

    if cancelled {
        let cancel_err = AppError::cancelled();
        on_task_event(&TaskProgressPayload::failed_or_cancelled(
            &batch_id,
            "D03",
            cumulative_bytes,
            None,
            &cancel_err,
        ));
    } else {
        on_task_event(&TaskProgressPayload::completed(
            &batch_id,
            "D03",
            cumulative_bytes,
            Some(cumulative_bytes),
        ));
    }

    MultiFileBatchHashResult {
        batch_id,
        cancelled,
        items: results,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::mpsc;
    use std::thread;
    use tempfile::tempdir;

    #[test]
    fn computes_all_five_rfc_nist_vectors_for_empty_abc_unicode_and_whitespace() {
        let empty = compute_text_hashes("", &HashAlgorithm::ALL).expect("empty hashes");
        assert_eq!(empty.byte_length, 0);
        assert_eq!(empty.digests.len(), 5);
        assert_eq!(
            empty.digests[0].digest_hex,
            "d41d8cd98f00b204e9800998ecf8427e"
        );
        assert_eq!(
            empty.digests[1].digest_hex,
            "da39a3ee5e6b4b0d3255bfef95601890afd80709"
        );
        assert_eq!(
            empty.digests[2].digest_hex,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            empty.digests[3].digest_hex,
            "38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da274edebfe76f65fbd51ad2f14898b95b"
        );
        assert_eq!(
            empty.digests[4].digest_hex,
            "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e"
        );

        let abc = compute_text_hashes("abc", &HashAlgorithm::ALL).expect("abc hashes");
        assert_eq!(abc.byte_length, 3);
        assert_eq!(
            abc.digests[0].digest_hex,
            "900150983cd24fb0d6963f7d28e17f72"
        );
        assert_eq!(
            abc.digests[1].digest_hex,
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(
            abc.digests[2].digest_hex,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            abc.digests[3].digest_hex,
            "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7"
        );
        assert_eq!(
            abc.digests[4].digest_hex,
            "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"
        );

        // Must NOT trim spaces or CRLF newlines implicitly
        let padded = compute_text_hashes(" abc\r\n", &[HashAlgorithm::Sha256]).expect("padded");
        assert_eq!(padded.byte_length, 6);
        assert_ne!(padded.digests[0].digest_hex, abc.digests[2].digest_hex);

        let unicode =
            compute_text_hashes("WinKit 桌面工具箱 🚀", &HashAlgorithm::ALL).expect("unicode");
        assert_eq!(unicode.byte_length, "WinKit 桌面工具箱 🚀".len());
        assert_eq!(unicode.digests[0].digest_hex.len(), 32);
        assert_eq!(unicode.digests[4].digest_hex.len(), 128);

        assert!(compute_text_hashes("abc", &[]).is_err());
    }

    #[test]
    fn streams_multi_chunk_file_single_pass_across_all_algorithms_without_mutating_file() {
        let dir = tempdir().expect("tempdir");
        let folder = dir.path().join("测试 空格 目录 多算法哈希");
        fs::create_dir_all(&folder).expect("mkdir");
        let file_path = folder.join("大文件 样本 01.bin");

        // NIST 1,000,000 'a' vector (spans 4 chunks of 256 KiB)
        let payload = vec![b'a'; 1_000_000];
        fs::write(&file_path, &payload).expect("write 1MB vector");

        let registry = TaskRegistry::default();
        let mut states = Vec::new();
        let res = execute_file_hash_task(
            &registry,
            "hash-vec-1m-all",
            &file_path.to_string_lossy(),
            &HashAlgorithm::ALL,
            |ev| states.push(ev.state),
        )
        .expect("hash 1MB vector");

        assert_eq!(res.byte_length, 1_000_000);
        assert_eq!(states.last(), Some(&TaskLifecycleState::Completed));
        assert_eq!(res.digests.len(), 5);
        assert_eq!(
            res.digests[0].digest_hex,
            "7707d6ae4e027c70eea2a935c2296f21"
        );
        assert_eq!(
            res.digests[1].digest_hex,
            "34aa973cd4c4daa4f61eeb2bdbad27316534016f"
        );
        assert_eq!(
            res.digests[2].digest_hex,
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
        assert_eq!(
            res.digests[3].digest_hex,
            "9d0e1809716474cb086e834e310a4a1ced149e9c00f248527972cec5704c2a5b07b8b3dc38ecc4ebae97ddd87f3d8985"
        );
        assert_eq!(
            res.digests[4].digest_hex,
            "e718483d0ce769644e2e42c7bc15b4638e1f98b13b2044285632a803afa973ebde0ff244877ea60a4cb0432ce577c31beb009c5c2c49aa2e4eadb217ad8cc09b"
        );
        assert_eq!(
            fs::read(&file_path).expect("verify intact").len(),
            1_000_000
        );
        assert_eq!(registry.running_count(), 0);
    }

    #[test]
    fn aborts_cleanly_when_cancelled_mid_stream() {
        let dir = tempdir().expect("tempdir");
        let file_path = dir.path().join("cancellable_2mb.bin");
        fs::write(&file_path, vec![0x5Au8; 2 * 1024 * 1024]).expect("write 2MB");

        let flag = AtomicBool::new(false);
        let mut progress_calls = 0usize;

        let err = stream_file_hashes(
            &file_path,
            &HashAlgorithm::ALL,
            2 * 1024 * 1024,
            &flag,
            |processed, _total| {
                progress_calls += 1;
                if processed == 0 {
                    flag.store(true, Ordering::SeqCst);
                }
            },
        )
        .unwrap_err();

        assert_eq!(err.code, "TASK_CANCELLED");
        assert!(progress_calls >= 1);
    }

    #[test]
    fn batch_handles_zero_byte_unicode_same_basename_bad_items_and_windows_write_share_conflict() {
        let dir = tempdir().expect("tempdir");
        let dir_a = dir.path().join("目录A 🔑");
        let dir_b = dir.path().join("目录B 🚀");
        fs::create_dir_all(&dir_a).expect("mkdir a");
        fs::create_dir_all(&dir_b).expect("mkdir b");

        // 1. Zero-byte file + two identically named files in different directories
        let zero_file = dir_a.join("empty 零字节.bin");
        let same_a = dir_a.join("payload.bin");
        let same_b = dir_b.join("payload.bin");
        let locked_file = dir_b.join("write_locked.bin");
        let missing_file = dir_b.join("does_not_exist.bin");

        fs::write(&zero_file, b"").expect("write zero");
        fs::write(&same_a, b"abc").expect("write same_a");
        fs::write(&same_b, b"xyz").expect("write same_b");
        fs::write(&locked_file, b"in-flight writer").expect("write locked");

        // Hold an open write handle on `locked_file`; on Windows, `FILE_SHARE_READ`-only open must fail with `FILE_LOCKED`
        let open_writer = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&locked_file)
            .expect("open writer");

        let items = vec![
            BatchHashInputItem {
                item_id: "i-zero".to_string(),
                path: zero_file.to_string_lossy().into_owned(),
            },
            BatchHashInputItem {
                item_id: "i-same-a".to_string(),
                path: same_a.to_string_lossy().into_owned(),
            },
            BatchHashInputItem {
                item_id: "i-dir".to_string(),
                path: dir_a.to_string_lossy().into_owned(),
            },
            BatchHashInputItem {
                item_id: "i-missing".to_string(),
                path: missing_file.to_string_lossy().into_owned(),
            },
            BatchHashInputItem {
                item_id: "i-locked".to_string(),
                path: locked_file.to_string_lossy().into_owned(),
            },
            BatchHashInputItem {
                item_id: "i-same-b".to_string(),
                path: same_b.to_string_lossy().into_owned(),
            },
        ];

        let registry = TaskRegistry::default();
        let (guard, normalized) =
            prepare_batch_hash_task(&registry, "batch-mixed-1", &items, &[HashAlgorithm::Sha256])
                .expect("prepare batch");

        let batch_res = execute_batch_hash_with_guard(guard, &items, &normalized, |_| {}, |_| {});
        drop(open_writer);

        assert!(!batch_res.cancelled);
        assert_eq!(batch_res.items.len(), 6);
        assert_eq!(registry.running_count(), 0);

        // Zero-byte succeeded
        assert_eq!(
            batch_res.items[0].status,
            BatchItemLifecycleState::Completed
        );
        assert_eq!(batch_res.items[0].byte_length, Some(0));
        assert_eq!(
            batch_res.items[0].digests.as_ref().unwrap()[0].digest_hex,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );

        // Same basename in dir_a ("abc") vs dir_b ("xyz") remain distinct and both succeed
        assert_eq!(
            batch_res.items[1].status,
            BatchItemLifecycleState::Completed
        );
        assert_eq!(
            batch_res.items[5].status,
            BatchItemLifecycleState::Completed
        );
        assert_eq!(batch_res.items[1].file_name, "payload.bin");
        assert_eq!(batch_res.items[5].file_name, "payload.bin");
        assert_ne!(batch_res.items[1].path, batch_res.items[5].path);
        assert_eq!(
            batch_res.items[1].digests.as_ref().unwrap()[0].digest_hex,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_ne!(
            batch_res.items[1].digests.as_ref().unwrap()[0].digest_hex,
            batch_res.items[5].digests.as_ref().unwrap()[0].digest_hex
        );

        // Directory & missing errors isolated without aborting later items
        assert_eq!(batch_res.items[2].status, BatchItemLifecycleState::Error);
        assert_eq!(
            batch_res.items[2].error_code.as_deref(),
            Some("IS_DIRECTORY")
        );
        assert_eq!(batch_res.items[3].status, BatchItemLifecycleState::Error);
        assert_eq!(
            batch_res.items[3].error_code.as_deref(),
            Some("FILE_NOT_FOUND")
        );

        #[cfg(windows)]
        {
            assert_eq!(batch_res.items[4].status, BatchItemLifecycleState::Error);
            assert_eq!(
                batch_res.items[4].error_code.as_deref(),
                Some("FILE_LOCKED")
            );
        }
    }

    #[test]
    fn batch_eliminates_between_file_shutdown_gap_releases_handles_and_never_prelocks_queue() {
        let dir = tempdir().expect("tempdir");
        let file1 = dir.path().join("first.bin");
        let file2 = dir.path().join("second.bin");
        fs::write(&file1, b"abc").expect("write 1");
        fs::write(&file2, b"def").expect("write 2");

        let items = vec![
            BatchHashInputItem {
                item_id: "f1".to_string(),
                path: file1.to_string_lossy().into_owned(),
            },
            BatchHashInputItem {
                item_id: "f2".to_string(),
                path: file2.to_string_lossy().into_owned(),
            },
        ];

        let registry = TaskRegistry::default();
        let (guard, normalized) =
            prepare_batch_hash_task(&registry, "batch-gapless", &items, &[HashAlgorithm::Sha256])
                .expect("prepare");

        // 1. Before worker starts file 1: close request MUST see active task (no pre-dispatch gap)
        let pre_decision = registry.evaluate_close_request();
        assert!(!pre_decision.immediate_close_allowed);
        assert_eq!(pre_decision.snapshot.active_count, 1);

        let (at_transition_tx, at_transition_rx) = mpsc::channel::<()>();
        let (resume_transition_tx, resume_transition_rx) = mpsc::channel::<()>();

        let items_clone = items.clone();
        let worker = thread::spawn(move || {
            execute_batch_hash_internal(
                guard,
                &items_clone,
                &normalized,
                |_| {},
                |_| {},
                |idx, _flag| {
                    if idx == 1 {
                        at_transition_tx.send(()).expect("signal between files");
                        resume_transition_rx.recv().expect("wait at transition");
                    }
                },
            )
        });

        // Wait until file 1 has finished and closed its handle, BEFORE file 2 is opened
        at_transition_rx.recv().expect("parked between files");

        // 2. Verify on Windows that BOTH file 1 (finished) AND file 2 (queued) are NOT locked!
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let ex1 = OpenOptions::new()
                .read(true)
                .write(true)
                .share_mode(0)
                .open(&file1)
                .expect("file1 handle must already be released");
            drop(ex1);

            let ex2 = OpenOptions::new()
                .read(true)
                .write(true)
                .share_mode(0)
                .open(&file2)
                .expect("queued file2 must NOT be pre-locked before its turn");
            drop(ex2);
        }

        // 3. Evaluate close request AT THE EXACT BETWEEN-FILE BOUNDARY: active_count MUST still be 1!
        let mid_decision = registry.evaluate_close_request();
        assert!(!mid_decision.immediate_close_allowed);
        assert_eq!(mid_decision.snapshot.active_count, 1);
        assert!(!mid_decision.snapshot.shutting_down);

        // 4. Begin graceful shutdown -> sets cancel_flag and drains once worker drops guard
        let reg_drain = registry.clone();
        let drain_thread =
            thread::spawn(move || reg_drain.begin_shutdown_and_drain(Duration::from_secs(2)));

        // Wait briefly until begin_shutdown_and_drain sets shutting_down == true, then release transition
        while !registry.snapshot().shutting_down {
            thread::sleep(Duration::from_millis(2));
        }
        resume_transition_tx.send(()).expect("release worker");

        let batch_res = worker.join().expect("worker joined");
        let drain_res = drain_thread.join().expect("drain joined");

        assert!(drain_res.ready_to_close);
        assert!(batch_res.cancelled);
        assert_eq!(
            batch_res.items[0].status,
            BatchItemLifecycleState::Completed
        );
        assert_eq!(
            batch_res.items[1].status,
            BatchItemLifecycleState::Cancelled
        );
        assert_eq!(registry.running_count(), 0);
    }
}
