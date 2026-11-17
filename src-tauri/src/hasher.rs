use crate::error::AppError;
use crate::fs_guard::validate_existing_input_file;
use crate::tasks::{TaskLifecycleState, TaskProgressPayload, TaskRegistry};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::OpenOptions;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const STREAM_CHUNK_BYTES: usize = 256 * 1024; // 256 KiB fixed streaming buffer

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextHashResult {
    pub algorithm: &'static str,
    pub byte_length: usize,
    pub digest_hex: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHashResult {
    pub task_id: String,
    pub algorithm: &'static str,
    pub path: String,
    pub file_name: String,
    pub byte_length: u64,
    pub digest_hex: String,
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

/// Computes SHA-256 over the exact UTF-8 byte sequence of `text` with zero implicit trimming.
pub fn compute_text_sha256(text: &str) -> TextHashResult {
    let raw = text.as_bytes();
    let digest = Sha256::digest(raw);
    TextHashResult {
        algorithm: "SHA-256",
        byte_length: raw.len(),
        digest_hex: to_lower_hex(&digest),
    }
}

/// Streams `path` in fixed 256 KiB chunks, checking `cancel_flag` on every chunk.
/// Never loads the whole file into memory and never modifies the file.
pub fn stream_file_sha256<F>(
    path: &Path,
    expected_total: u64,
    cancel_flag: &AtomicBool,
    mut on_progress: F,
) -> Result<(u64, String), AppError>
where
    F: FnMut(u64, Option<u64>),
{
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let mut file = OpenOptions::new()
        .read(true)
        .write(false)
        .open(path)
        .map_err(|e| AppError::from_io(e, "Unable to open file for SHA-256 hashing"))?;

    let total_opt = Some(expected_total);
    on_progress(0, total_opt);

    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; STREAM_CHUNK_BYTES];
    let mut processed: u64 = 0;
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
        processed += n as u64;

        let now = Instant::now();
        if now.duration_since(last_emit) >= Duration::from_millis(25) {
            on_progress(processed, total_opt);
            last_emit = now;
        }
    }

    let final_total = Some(processed.max(expected_total));
    on_progress(processed, final_total);
    let digest = hasher.finalize();
    Ok((processed, to_lower_hex(&digest)))
}

pub fn execute_file_hash_task<E>(
    registry: &TaskRegistry,
    task_id: &str,
    raw_path: &str,
    mut on_event: E,
) -> Result<FileHashResult, AppError>
where
    E: FnMut(&TaskProgressPayload),
{
    if task_id.trim().is_empty() {
        return Err(AppError::invalid_param("task_id must not be empty."));
    }
    let guard = registry.register(task_id);
    let (path, file_len) = match validate_existing_input_file(raw_path) {
        Ok(v) => v,
        Err(err) => {
            on_event(&TaskProgressPayload {
                task_id: task_id.to_string(),
                tool_id: "D03".to_string(),
                state: TaskLifecycleState::Error,
                processed_bytes: 0,
                total_bytes: None,
                percent: None,
                error_code: Some(err.code.to_string()),
                error_message: Some(err.message.clone()),
            });
            return Err(err);
        }
    };

    let cancel_flag = guard.cancel_flag();
    let result = stream_file_sha256(&path, file_len, &cancel_flag, |processed, total| {
        let percent = match total {
            Some(0) => Some(100.0),
            Some(t) => Some(((processed as f64 / t as f64) * 100.0).clamp(0.0, 100.0)),
            None => None,
        };
        on_event(&TaskProgressPayload {
            task_id: task_id.to_string(),
            tool_id: "D03".to_string(),
            state: TaskLifecycleState::Running,
            processed_bytes: processed,
            total_bytes: total,
            percent,
            error_code: None,
            error_message: None,
        });
    });

    match result {
        Ok((actual_bytes, digest_hex)) => {
            on_event(&TaskProgressPayload {
                task_id: task_id.to_string(),
                tool_id: "D03".to_string(),
                state: TaskLifecycleState::Completed,
                processed_bytes: actual_bytes,
                total_bytes: Some(actual_bytes),
                percent: Some(100.0),
                error_code: None,
                error_message: None,
            });
            let file_name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            Ok(FileHashResult {
                task_id: task_id.to_string(),
                algorithm: "SHA-256",
                path: path.to_string_lossy().into_owned(),
                file_name,
                byte_length: actual_bytes,
                digest_hex,
            })
        }
        Err(err) => {
            let state = if err.code == "TASK_CANCELLED" {
                TaskLifecycleState::Cancelled
            } else {
                TaskLifecycleState::Error
            };
            on_event(&TaskProgressPayload {
                task_id: task_id.to_string(),
                tool_id: "D03".to_string(),
                state,
                processed_bytes: 0,
                total_bytes: Some(file_len),
                percent: None,
                error_code: Some(err.code.to_string()),
                error_message: Some(err.message.clone()),
            });
            Err(err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn computes_known_vectors_empty_unicode_and_preserves_whitespace() {
        let empty = compute_text_sha256("");
        assert_eq!(empty.byte_length, 0);
        assert_eq!(
            empty.digest_hex,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );

        let abc = compute_text_sha256("abc");
        assert_eq!(abc.byte_length, 3);
        assert_eq!(
            abc.digest_hex,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );

        // Must NOT trim spaces or newlines implicitly
        let padded = compute_text_sha256(" abc\n");
        assert_eq!(padded.byte_length, 5);
        assert_ne!(padded.digest_hex, abc.digest_hex);

        let unicode = compute_text_sha256("WinKit 桌面工具箱 🚀");
        assert_eq!(unicode.byte_length, "WinKit 桌面工具箱 🚀".len());
        assert_eq!(unicode.digest_hex.len(), 64);
    }

    #[test]
    fn streams_multi_chunk_file_in_spaced_unicode_path_without_mutating_file() {
        let dir = tempdir().expect("tempdir");
        let folder = dir.path().join("测试 空格 目录 SHA256");
        fs::create_dir_all(&folder).expect("mkdir");
        let file_path = folder.join("大文件 样本 01.bin");

        // 1,000,000 'a' bytes (NIST 1M 'a' SHA-256 vector = cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0)
        // Spans 4 chunks of 256 KiB!
        let payload = vec![b'a'; 1_000_000];
        fs::write(&file_path, &payload).expect("write 1MB vector");

        let registry = TaskRegistry::default();
        let mut states = Vec::new();
        let res = execute_file_hash_task(
            &registry,
            "hash-vec-1m",
            &file_path.to_string_lossy(),
            |ev| states.push(ev.state),
        )
        .expect("hash 1MB vector");

        assert_eq!(res.byte_length, 1_000_000);
        assert_eq!(states.last(), Some(&TaskLifecycleState::Completed));
        assert_eq!(
            res.digest_hex,
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
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

        let err = stream_file_sha256(&file_path, 2 * 1024 * 1024, &flag, |processed, _total| {
            progress_calls += 1;
            if processed == 0 {
                // Trigger cancellation right after initial progress callback so first read aborts
                flag.store(true, Ordering::SeqCst);
            }
        })
        .unwrap_err();

        assert_eq!(err.code, "TASK_CANCELLED");
        assert!(progress_calls >= 1);
    }
}
