use crate::error::AppError;
use crate::fs_guard::validate_existing_input_file;
use crate::tasks::{TaskLifecycleState, TaskProgressPayload, TaskRegistry};
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

fn to_lower_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
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

/// Streams `path` in fixed 256 KiB chunks in a SINGLE pass, updating all selected digest states
/// per chunk and checking `cancel_flag` on every iteration.
pub fn stream_file_hashes<F>(
    path: &Path,
    algorithms: &[HashAlgorithm],
    expected_total: u64,
    cancel_flag: &AtomicBool,
    mut on_progress: F,
) -> Result<(u64, Vec<AlgorithmDigestEntry>), AppError>
where
    F: FnMut(u64, Option<u64>),
{
    let normalized = normalize_algorithms(algorithms)?;
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let mut file = OpenOptions::new()
        .read(true)
        .write(false)
        .open(path)
        .map_err(|e| AppError::from_io(e, "Unable to open file for hashing"))?;

    let total_opt = Some(expected_total);
    on_progress(0, total_opt);

    let mut hasher = MultiHasher::new(&normalized);
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
    Ok((processed, hasher.finalize()))
}

pub fn execute_file_hash_task<E>(
    registry: &TaskRegistry,
    task_id: &str,
    raw_path: &str,
    algorithms: &[HashAlgorithm],
    mut on_event: E,
) -> Result<MultiFileHashResult, AppError>
where
    E: FnMut(&TaskProgressPayload),
{
    if task_id.trim().is_empty() {
        return Err(AppError::invalid_param("task_id must not be empty."));
    }
    let normalized = normalize_algorithms(algorithms)?;
    let guard = registry.register_checked(task_id, "D03", true)?;
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
    let result = stream_file_hashes(
        &path,
        &normalized,
        file_len,
        &cancel_flag,
        |processed, total| {
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
        },
    );

    match result {
        Ok((actual_bytes, digests)) => {
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
            Ok(MultiFileHashResult {
                task_id: task_id.to_string(),
                path: path.to_string_lossy().into_owned(),
                file_name,
                byte_length: actual_bytes,
                digests,
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
        // NIST known 1,000,000 'a' digests:
        assert_eq!(
            res.digests[0].digest_hex,
            "7707d6ae4e027c70eea2a935c2296f21"
        ); // MD5
        assert_eq!(
            res.digests[1].digest_hex,
            "34aa973cd4c4daa4f61eeb2bdbad27316534016f"
        ); // SHA-1
        assert_eq!(
            res.digests[2].digest_hex,
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        ); // SHA-256
        assert_eq!(
            res.digests[3].digest_hex,
            "9d0e1809716474cb086e834e310a4a1ced149e9c00f248527972cec5704c2a5b07b8b3dc38ecc4ebae97ddd87f3d8985"
        ); // SHA-384
        assert_eq!(
            res.digests[4].digest_hex,
            "e718483d0ce769644e2e42c7bc15b4638e1f98b13b2044285632a803afa973ebde0ff244877ea60a4cb0432ce577c31beb009c5c2c49aa2e4eadb217ad8cc09b"
        ); // SHA-512
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
}
