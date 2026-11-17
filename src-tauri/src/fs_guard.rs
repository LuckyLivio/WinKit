use crate::error::AppError;
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_TEXT_FILE_BYTES: u64 = 16 * 1024 * 1024; // 16 MiB ceiling for interactive JSON editor files

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

    if !overwrite {
        // Atomic exclusive file creation (`CREATE_NEW` on Windows) prevents TOCTOU silent overwrite
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output_path)
            .map_err(|e| AppError::from_io(e, "Unable to create output file"))?;

        if let Err(err) = file.write_all(bytes).and_then(|()| file.flush()) {
            let _ = fs::remove_file(&output_path);
            return Err(AppError::from_io(err, "Failed while writing output file"));
        }
    } else {
        // Write to sibling temporary file first, then atomically replace destination
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
            .map_err(|e| {
                AppError::from_io(e, "Unable to create temporary file in output directory")
            })?;

        if let Err(err) = tmp_file.write_all(bytes).and_then(|()| tmp_file.flush()) {
            drop(tmp_file);
            let _ = fs::remove_file(&tmp_path);
            return Err(AppError::from_io(
                err,
                "Failed while writing temporary output file",
            ));
        }
        drop(tmp_file);

        if let Err(err) = fs::rename(&tmp_path, &output_path) {
            let _ = fs::remove_file(&tmp_path);
            return Err(AppError::from_io(
                err,
                "Unable to replace existing target file",
            ));
        }
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
}
