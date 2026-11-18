use crate::error::AppError;
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_TEXT_FILE_BYTES: u64 = 16 * 1024 * 1024; // 16 MiB ceiling for interactive JSON editor files
const MAX_TABULAR_FILE_BYTES: u64 = 8 * 1024 * 1024; // 8 MiB ceiling for D14 CSV/TSV/JSON converter
const MAX_DIFF_FILE_BYTES: u64 = 4 * 1024 * 1024; // 4 MiB per-side ceiling for interactive line/word diff
const MAX_COORD_BATCH_FILE_BYTES: u64 = 1024 * 1024; // 1 MiB ceiling for D10 batch coordinate files
const WRITE_CHUNK_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFilePayload {
    pub path: String,
    pub file_name: String,
    pub byte_length: usize,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffTextFilePayload {
    pub path: String,
    pub file_name: String,
    pub byte_length: usize,
    pub has_utf8_bom: bool,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFileInfo {
    pub path: String,
    pub byte_length: u64,
}

pub fn validate_user_path(raw: &str, role: &str) -> Result<PathBuf, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::invalid_param(format!(
            "{role} path must not be empty."
        )));
    }
    if trimmed
        .chars()
        .any(|c| c == '\0' || (c.is_control() && c != '\t'))
    {
        return Err(AppError::invalid_param(format!(
            "{role} path contains invalid control characters."
        )));
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(AppError::invalid_param(format!(
            "{role} path must be an absolute filesystem path."
        )));
    }
    Ok(path)
}

pub fn validate_existing_input_file(raw: &str) -> Result<(PathBuf, u64), AppError> {
    let path = validate_user_path(raw, "Input")?;
    let meta =
        fs::metadata(&path).map_err(|e| AppError::from_io(e, "Unable to access input file"))?;
    if meta.is_dir() {
        return Err(AppError::new(
            "IS_DIRECTORY",
            "Selected input path is a directory, not a file.",
        ));
    }
    if !meta.is_file() {
        return Err(AppError::invalid_param(
            "Selected input path is not a regular file.",
        ));
    }
    Ok((path, meta.len()))
}

/// Normalize path for safe comparison on Windows so source files can never be overwritten,
/// even if casing, slash direction, or relative segments differ.
pub fn paths_refer_to_same_location(input: &Path, output: &Path) -> bool {
    let norm_in = fs::canonicalize(input).unwrap_or_else(|_| normalize_lexical(input));
    let norm_out = if output.exists() {
        fs::canonicalize(output).unwrap_or_else(|_| normalize_lexical(output))
    } else if let (Some(parent), Some(name)) = (output.parent(), output.file_name()) {
        let canon_parent = fs::canonicalize(parent).unwrap_or_else(|_| normalize_lexical(parent));
        canon_parent.join(name)
    } else {
        normalize_lexical(output)
    };

    #[cfg(windows)]
    {
        strip_verbatim_prefix(&norm_in).eq_ignore_ascii_case(&strip_verbatim_prefix(&norm_out))
            || strip_verbatim_prefix(&norm_in).to_lowercase()
                == strip_verbatim_prefix(&norm_out).to_lowercase()
    }
    #[cfg(not(windows))]
    {
        norm_in == norm_out
    }
}

#[cfg(windows)]
fn strip_verbatim_prefix(p: &Path) -> String {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

fn normalize_lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        out.push(comp);
    }
    out
}

/// Write bytes safely to `output_path`:
/// - Rejects writing over `source_path` if provided.
/// - Rejects existing destination unless `overwrite == true`.
/// - Writes via an exclusive temp file in the destination directory first, then commits,
///   ensuring read-only folders, disk errors, or cancellations never leave a half-written target.
pub fn write_output_bytes_safely(
    output_raw: &str,
    source_path: Option<&Path>,
    bytes: &[u8],
    overwrite: bool,
) -> Result<SavedFileInfo, AppError> {
    write_output_bytes_cancellable(output_raw, source_path, bytes, overwrite, None)
}

pub fn write_output_bytes_cancellable(
    output_raw: &str,
    source_path: Option<&Path>,
    bytes: &[u8],
    overwrite: bool,
    cancel_flag: Option<&AtomicBool>,
) -> Result<SavedFileInfo, AppError> {
    let is_cancelled = || cancel_flag.is_some_and(|f| f.load(Ordering::Relaxed));
    if is_cancelled() {
        return Err(AppError::cancelled());
    }

    let output_path = validate_user_path(output_raw, "Output")?;
    if output_path.is_dir() {
        return Err(AppError::new(
            "IS_DIRECTORY",
            "Output path points to an existing directory.",
        ));
    }

    if let Some(src) = source_path {
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

    // Always stage into a sibling temporary file first so neither the source file nor an
    // existing target file can ever be left partially written on error or cancellation.
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    let base_name = output_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "output".to_string());
    let tmp_path = parent.join(format!(".{base_name}.winkit-{pid}-{stamp}.tmp"));

    let mut tmp_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp_path)
        .map_err(|e| AppError::from_io(e, "Unable to create temporary file in output directory"))?;

    for chunk in bytes.chunks(WRITE_CHUNK_BYTES) {
        if is_cancelled() {
            drop(tmp_file);
            let _ = fs::remove_file(&tmp_path);
            return Err(AppError::cancelled());
        }
        if let Err(err) = tmp_file.write_all(chunk) {
            drop(tmp_file);
            let _ = fs::remove_file(&tmp_path);
            return Err(AppError::from_io(
                err,
                "Failed while writing temporary output file",
            ));
        }
    }

    if let Err(err) = tmp_file.flush() {
        drop(tmp_file);
        let _ = fs::remove_file(&tmp_path);
        return Err(AppError::from_io(
            err,
            "Failed while flushing temporary output file",
        ));
    }
    drop(tmp_file);

    if is_cancelled() {
        let _ = fs::remove_file(&tmp_path);
        return Err(AppError::cancelled());
    }

    // Final non-interruptible atomic commit step
    if !overwrite {
        match fs::hard_link(&tmp_path, &output_path) {
            Ok(()) => {
                let _ = fs::remove_file(&tmp_path);
            }
            Err(err) if err.kind() == ErrorKind::AlreadyExists => {
                let _ = fs::remove_file(&tmp_path);
                return Err(AppError::target_exists());
            }
            Err(_) => {
                // Fallback for filesystems without hard_link support (e.g. exFAT/FAT32)
                if output_path.exists() {
                    let _ = fs::remove_file(&tmp_path);
                    return Err(AppError::target_exists());
                }
                if let Err(ren_err) = fs::rename(&tmp_path, &output_path) {
                    let _ = fs::remove_file(&tmp_path);
                    return Err(AppError::from_io(ren_err, "Unable to finalize output file"));
                }
            }
        }
    } else if let Err(err) = fs::rename(&tmp_path, &output_path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(AppError::from_io(
            err,
            "Unable to replace existing target file",
        ));
    }

    Ok(SavedFileInfo {
        path: output_path.to_string_lossy().into_owned(),
        byte_length: bytes.len() as u64,
    })
}

pub fn read_utf8_text_file_bounded(raw_path: &str) -> Result<TextFilePayload, AppError> {
    let (path, len) = validate_existing_input_file(raw_path)?;
    if len > MAX_TEXT_FILE_BYTES {
        return Err(AppError::size_limit(format!(
            "File exceeds the 16 MB interactive text editor limit ({:.2} MB).",
            len as f64 / (1024.0 * 1024.0)
        )));
    }

    let mut file =
        fs::File::open(&path).map_err(|e| AppError::from_io(e, "Unable to open input file"))?;
    let mut buf = Vec::with_capacity(len as usize);
    file.read_to_end(&mut buf)
        .map_err(|e| AppError::from_io(e, "Unable to read input file"))?;

    let content = String::from_utf8(buf)
        .map_err(|_| AppError::decode_failed("File is not valid UTF-8 text."))?;
    let content = content
        .strip_prefix('\u{feff}')
        .unwrap_or(&content)
        .to_string();
    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();

    Ok(TextFilePayload {
        path: path.to_string_lossy().into_owned(),
        file_name,
        byte_length: content.len(),
        content,
    })
}

/// Reads a UTF-8 text file for exact diff / Unicode inspection without stripping UTF-8 BOM or
/// normalizing line endings, while explicitly rejecting binary files (NUL bytes), UTF-16 BOMs,
/// and non-UTF-8 encodings instead of inserting U+FFFD replacement characters.
pub fn read_strict_diff_text_file(raw_path: &str) -> Result<DiffTextFilePayload, AppError> {
    read_strict_utf8_file_with_limit(raw_path, MAX_DIFF_FILE_BYTES, "4 MiB per-side diff")
}

pub fn read_strict_tabular_text_file(raw_path: &str) -> Result<DiffTextFilePayload, AppError> {
    read_strict_utf8_file_with_limit(raw_path, MAX_TABULAR_FILE_BYTES, "8 MiB tabular")
}

pub fn read_strict_coord_batch_file(raw_path: &str) -> Result<DiffTextFilePayload, AppError> {
    read_strict_utf8_file_with_limit(
        raw_path,
        MAX_COORD_BATCH_FILE_BYTES,
        "1 MiB coordinate batch",
    )
}

fn read_strict_utf8_file_with_limit(
    raw_path: &str,
    max_bytes: u64,
    limit_label: &str,
) -> Result<DiffTextFilePayload, AppError> {
    let (path, len) = validate_existing_input_file(raw_path)?;
    if len > max_bytes {
        return Err(AppError::size_limit(format!(
            "File exceeds the {limit_label} limit ({:.2} MiB).",
            len as f64 / (1024.0 * 1024.0)
        )));
    }

    let mut file =
        fs::File::open(&path).map_err(|e| AppError::from_io(e, "Unable to open input file"))?;
    let mut buf = Vec::with_capacity(len as usize);
    file.read_to_end(&mut buf)
        .map_err(|e| AppError::from_io(e, "Unable to read input file"))?;

    if buf.starts_with(&[0xFF, 0xFE]) || buf.starts_with(&[0xFE, 0xFF]) {
        return Err(AppError::decode_failed(
            "UTF-16 encoded file detected; only UTF-8 text files are supported in this phase.",
        ));
    }

    if buf.contains(&0u8) {
        return Err(AppError::decode_failed(
            "Binary file detected (contains NUL bytes); cannot compare as plain UTF-8 text.",
        ));
    }

    let raw_byte_length = buf.len();
    let has_utf8_bom = buf.starts_with(&[0xEF, 0xBB, 0xBF]);
    let content = String::from_utf8(buf).map_err(|_| {
        AppError::decode_failed(
            "File is not valid UTF-8 text (unsupported legacy encoding or binary data).",
        )
    })?;

    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();

    Ok(DiffTextFilePayload {
        path: path.to_string_lossy().into_owned(),
        file_name,
        byte_length: raw_byte_length,
        has_utf8_bom,
        content,
    })
}

/// Suggests a non-colliding sibling output path such as `dir/name_framed.png` or `dir/name_framed (2).png`.
pub fn suggest_safe_output_path(
    input_raw: &str,
    suffix: &str,
    extension: &str,
) -> Result<String, AppError> {
    let (input_path, _) = validate_existing_input_file(input_raw)?;
    let parent = input_path
        .parent()
        .ok_or_else(|| AppError::invalid_param("Input file has no parent directory."))?;
    let stem = input_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "output".to_string());
    let ext = extension.trim_start_matches('.');

    let first = parent.join(format!("{stem}{suffix}.{ext}"));
    if !first.exists() && !paths_refer_to_same_location(&input_path, &first) {
        return Ok(first.to_string_lossy().into_owned());
    }

    for index in 2..=999 {
        let candidate = parent.join(format!("{stem}{suffix} ({index}).{ext}"));
        if !candidate.exists() && !paths_refer_to_same_location(&input_path, &candidate) {
            return Ok(candidate.to_string_lossy().into_owned());
        }
    }

    Ok(first.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn handles_unicode_and_spaces_and_prevents_overwriting_source() {
        let dir = tempdir().expect("tempdir");
        let sub = dir.path().join("中文 空格 目录");
        fs::create_dir_all(&sub).expect("mkdir");

        let src = sub.join("样例 配置 01.json");
        fs::write(&src, br#"{"ok":true}"#).expect("write src");

        let loaded = read_utf8_text_file_bounded(&src.to_string_lossy()).expect("read utf8");
        assert_eq!(loaded.content, r#"{"ok":true}"#);

        // Must refuse overwriting source even with overwrite = true
        let same_err =
            write_output_bytes_safely(&src.to_string_lossy(), Some(&src), b"{}", true).unwrap_err();
        assert_eq!(same_err.code, "SAME_INPUT_AND_OUTPUT");

        // Must refuse overwriting another existing file when overwrite = false
        let existing = sub.join("existing.json");
        fs::write(&existing, b"old").expect("write existing");
        let exists_err =
            write_output_bytes_safely(&existing.to_string_lossy(), Some(&src), b"new", false)
                .unwrap_err();
        assert_eq!(exists_err.code, "TARGET_ALREADY_EXISTS");
        assert_eq!(fs::read(&existing).expect("read existing"), b"old");

        // Must allow explicit overwrite on a distinct file
        let saved =
            write_output_bytes_safely(&existing.to_string_lossy(), Some(&src), b"updated", true)
                .expect("explicit overwrite");
        assert_eq!(saved.byte_length, 7);
        assert_eq!(fs::read(&existing).expect("read updated"), b"updated");
    }

    #[test]
    fn suggests_non_colliding_sibling_names() {
        let dir = tempdir().expect("tempdir");
        let src = dir.path().join("capture.png");
        fs::write(&src, b"png").expect("src");

        let first = suggest_safe_output_path(&src.to_string_lossy(), "_beautified", "png")
            .expect("suggest 1");
        assert!(first.ends_with("capture_beautified.png"));

        fs::write(&first, b"taken").expect("occupy first");
        let second = suggest_safe_output_path(&src.to_string_lossy(), "_beautified", "png")
            .expect("suggest 2");
        assert!(second.ends_with("capture_beautified (2).png"));
    }

    #[test]
    fn strict_diff_reader_preserves_bom_and_crlf_and_rejects_binary_or_non_utf8() {
        let dir = tempdir().expect("tempdir");
        let bom_crlf = dir.path().join("bom_crlf.txt");
        fs::write(&bom_crlf, b"\xEF\xBB\xBFline1\r\nline2").expect("write bom_crlf");

        let loaded = read_strict_diff_text_file(&bom_crlf.to_string_lossy()).expect("load bom");
        assert!(loaded.has_utf8_bom);
        assert_eq!(loaded.content, "\u{feff}line1\r\nline2");

        let bin_file = dir.path().join("sample.bin");
        fs::write(&bin_file, b"ABC\x00DEF").expect("write bin");
        let bin_err = read_strict_diff_text_file(&bin_file.to_string_lossy()).unwrap_err();
        assert_eq!(bin_err.code, "DECODE_FAILED");
        assert!(bin_err.message.contains("Binary file"));

        let utf16_file = dir.path().join("utf16.txt");
        fs::write(&utf16_file, [0xFF, 0xFE, b'a', 0x00]).expect("write utf16");
        let utf16_err = read_strict_diff_text_file(&utf16_file.to_string_lossy()).unwrap_err();
        assert_eq!(utf16_err.code, "DECODE_FAILED");
        assert!(utf16_err.message.contains("UTF-16"));

        let invalid_utf8 = dir.path().join("gbk.txt");
        fs::write(&invalid_utf8, [0xC4, 0xE3, 0xBA, 0xC3, 0xFF]).expect("write non-utf8");
        let enc_err = read_strict_diff_text_file(&invalid_utf8.to_string_lossy()).unwrap_err();
        assert_eq!(enc_err.code, "DECODE_FAILED");
    }
}
