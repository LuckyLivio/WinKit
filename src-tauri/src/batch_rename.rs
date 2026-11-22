use crate::error::AppError;
use crate::fs_guard::validate_user_path;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_BATCH_RENAME_FILES: usize = 2_000;

static RENAME_BATCH_SEQ: AtomicU64 = AtomicU64::new(1);

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRenameSourceEntry {
    pub path: String,
    pub parent_dir: String,
    pub file_name: String,
    pub byte_length: u64,
    pub created_ms: Option<u64>,
    pub modified_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRenameSkippedItem {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRenameInspectResponse {
    pub entries: Vec<BatchRenameSourceEntry>,
    pub existing_dir_siblings: HashMap<String, Vec<String>>,
    pub skipped: Vec<BatchRenameSkippedItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamePairInput {
    pub source_path: String,
    pub new_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamedItemReport {
    pub old_path: String,
    pub new_path: String,
    pub old_name: String,
    pub new_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRenameUndoStatus {
    pub available: bool,
    pub item_count: usize,
    pub completed_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRenameExecuteResponse {
    pub renamed_count: usize,
    pub items: Vec<RenamedItemReport>,
    pub updated_inspection: BatchRenameInspectResponse,
    pub undo_status: BatchRenameUndoStatus,
}

#[derive(Debug, Clone)]
struct CommittedRenamePair {
    original_path: PathBuf,
    original_name: String,
    renamed_path: PathBuf,
    renamed_name: String,
}

#[derive(Debug, Clone)]
struct LastBatchUndoRecord {
    completed_at_ms: u64,
    pairs: Vec<CommittedRenamePair>,
}

#[derive(Clone, Default)]
pub struct BatchRenameState {
    last_undo: Arc<Mutex<Option<LastBatchUndoRecord>>>,
}

impl BatchRenameState {
    pub fn status(&self) -> BatchRenameUndoStatus {
        let guard = self
            .last_undo
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match guard.as_ref() {
            Some(rec) => BatchRenameUndoStatus {
                available: !rec.pairs.is_empty(),
                item_count: rec.pairs.len(),
                completed_at_ms: Some(rec.completed_at_ms),
            },
            None => BatchRenameUndoStatus {
                available: false,
                item_count: 0,
                completed_at_ms: None,
            },
        }
    }

    fn store_undo(&self, record: LastBatchUndoRecord) -> BatchRenameUndoStatus {
        let mut guard = self
            .last_undo
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let status = BatchRenameUndoStatus {
            available: !record.pairs.is_empty(),
            item_count: record.pairs.len(),
            completed_at_ms: Some(record.completed_at_ms),
        };
        *guard = Some(record);
        status
    }

    fn peek_undo(&self) -> Option<LastBatchUndoRecord> {
        let guard = self
            .last_undo
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.clone()
    }

    fn clear_undo(&self) -> BatchRenameUndoStatus {
        let mut guard = self
            .last_undo
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = None;
        BatchRenameUndoStatus {
            available: false,
            item_count: 0,
            completed_at_ms: None,
        }
    }
}

fn system_time_to_ms(time: Result<SystemTime, std::io::Error>) -> Option<u64> {
    let ok = time.ok()?;
    let dur = ok.duration_since(UNIX_EPOCH).ok()?;
    u64::try_from(dur.as_millis()).ok()
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
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

fn normalized_dir_key(dir: &Path) -> String {
    let canon = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let clean = strip_verbatim(&canon);
    clean
        .to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_lowercase()
}

fn normalized_slot_key(parent_dir: &Path, file_name: &str) -> String {
    format!(
        "{}\\{}",
        normalized_dir_key(parent_dir),
        file_name.to_lowercase()
    )
}

pub fn validate_windows_target_name(name: &str) -> Result<(), AppError> {
    if name.is_empty() {
        return Err(AppError::invalid_param("Target filename cannot be empty."));
    }
    if name.encode_utf16().count() > 255 {
        return Err(AppError::invalid_param(
            "Target filename exceeds the 255-character Windows limit.",
        ));
    }
    if name == "." || name == ".." {
        return Err(AppError::invalid_param("Filename cannot be '.' or '..'."));
    }
    for ch in name.chars() {
        if (ch as u32) <= 0x1F || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        {
            return Err(AppError::invalid_param(format!(
                "Filename \"{name}\" contains characters disallowed on Windows."
            )));
        }
    }
    if name.ends_with(' ') || name.ends_with('.') {
        return Err(AppError::invalid_param(format!(
            "Filename \"{name}\" cannot end with a space or period on Windows."
        )));
    }
    let stem_candidate = name.split('.').next().unwrap_or("").trim().to_uppercase();
    if RESERVED_DOS_NAMES.contains(&stem_candidate.as_str()) {
        return Err(AppError::invalid_param(format!(
            "Filename \"{name}\" uses a reserved Windows device name."
        )));
    }
    Ok(())
}

/// Atomically moves/renames a file WITHOUT `MOVEFILE_REPLACE_EXISTING`.
/// Guaranteed never to overwrite an existing file or directory.
fn move_file_no_overwrite(from: &Path, to: &Path, context: &str) -> Result<(), AppError> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

        let from_w: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let to_w: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();

        // dwFlags = 0: forbids overwriting existing targets and forbids cross-volume copy fallback.
        let ok = unsafe { MoveFileExW(from_w.as_ptr(), to_w.as_ptr(), 0) };
        if ok == 0 {
            let io_err = std::io::Error::last_os_error();
            if matches!(io_err.raw_os_error(), Some(80) | Some(183)) {
                return Err(AppError::new(
                    "TARGET_ALREADY_EXISTS",
                    format!("{context}: target filename is already occupied."),
                ));
            }
            return Err(AppError::from_io(io_err, context));
        }
        Ok(())
    }

    #[cfg(not(windows))]
    {
        if fs::symlink_metadata(to).is_ok() {
            return Err(AppError::new(
                "TARGET_ALREADY_EXISTS",
                format!("{context}: target filename is already occupied."),
            ));
        }
        fs::rename(from, to).map_err(|e| AppError::from_io(e, context))
    }
}

fn build_entry_from_verified_file(
    raw_or_entry_path: &Path,
    meta: &fs::Metadata,
    known_exact_name: Option<String>,
) -> Result<(String, BatchRenameSourceEntry), AppError> {
    let canon = fs::canonicalize(raw_or_entry_path)
        .map(|p| strip_verbatim(&p))
        .unwrap_or_else(|_| raw_or_entry_path.to_path_buf());

    let file_name = match known_exact_name {
        Some(n) => n,
        None => canon
            .file_name()
            .or_else(|| raw_or_entry_path.file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| AppError::invalid_param("Unable to determine filename."))?,
    };

    let parent_buf = canon
        .parent()
        .or_else(|| raw_or_entry_path.parent())
        .ok_or_else(|| AppError::invalid_param("File has no parent directory."))?
        .to_path_buf();

    let exact_path = parent_buf.join(&file_name);
    let dedup_key = normalized_slot_key(&parent_buf, &file_name);

    Ok((
        dedup_key,
        BatchRenameSourceEntry {
            path: exact_path.to_string_lossy().into_owned(),
            parent_dir: parent_buf.to_string_lossy().into_owned(),
            file_name,
            byte_length: meta.len(),
            created_ms: system_time_to_ms(meta.created()),
            modified_ms: system_time_to_ms(meta.modified()),
        },
    ))
}

pub fn inspect_sources_impl(raw_paths: &[String]) -> Result<BatchRenameInspectResponse, AppError> {
    let mut entries = Vec::new();
    let mut seen_keys = HashSet::new();
    let mut skipped = Vec::new();
    let mut parent_dirs_to_scan: HashMap<String, PathBuf> = HashMap::new();

    for raw in raw_paths {
        if raw.trim().is_empty() {
            continue;
        }
        let user_path = validate_user_path(raw, "Input")?;
        let sym_meta = match fs::symlink_metadata(&user_path) {
            Ok(m) => m,
            Err(err) => {
                skipped.push(BatchRenameSkippedItem {
                    path: user_path.to_string_lossy().into_owned(),
                    reason: AppError::from_io(err, "Cannot access path").message,
                });
                continue;
            }
        };

        if is_reparse_point_meta(&sym_meta) {
            skipped.push(BatchRenameSkippedItem {
                path: user_path.to_string_lossy().into_owned(),
                reason: "Skipped symbolic link or reparse point.".to_string(),
            });
            continue;
        }

        if sym_meta.is_file() {
            let (dedup_key, entry) = build_entry_from_verified_file(&user_path, &sym_meta, None)?;
            if seen_keys.insert(dedup_key) {
                if entries.len() >= MAX_BATCH_RENAME_FILES {
                    return Err(AppError::size_limit(format!(
                        "Batch Rename supports at most {MAX_BATCH_RENAME_FILES} files per batch."
                    )));
                }
                let p_buf = PathBuf::from(&entry.parent_dir);
                parent_dirs_to_scan
                    .entry(entry.parent_dir.clone())
                    .or_insert(p_buf);
                entries.push(entry);
            }
            continue;
        }

        if sym_meta.is_dir() {
            let read_dir = match fs::read_dir(&user_path) {
                Ok(rd) => rd,
                Err(err) => {
                    skipped.push(BatchRenameSkippedItem {
                        path: user_path.to_string_lossy().into_owned(),
                        reason: AppError::from_io(err, "Cannot read directory").message,
                    });
                    continue;
                }
            };

            let mut dir_children: Vec<(PathBuf, String)> = Vec::new();
            for child_res in read_dir {
                match child_res {
                    Ok(child) => {
                        let name = child.file_name().to_string_lossy().into_owned();
                        dir_children.push((child.path(), name));
                    }
                    Err(err) => {
                        skipped.push(BatchRenameSkippedItem {
                            path: user_path.to_string_lossy().into_owned(),
                            reason: AppError::from_io(err, "Directory entry unreadable").message,
                        });
                    }
                }
            }
            dir_children.sort_by_key(|a| a.1.to_lowercase());

            for (child_path, exact_name) in dir_children {
                let child_meta = match fs::symlink_metadata(&child_path) {
                    Ok(m) => m,
                    Err(err) => {
                        skipped.push(BatchRenameSkippedItem {
                            path: child_path.to_string_lossy().into_owned(),
                            reason: AppError::from_io(err, "Cannot inspect file").message,
                        });
                        continue;
                    }
                };
                if is_reparse_point_meta(&child_meta) {
                    skipped.push(BatchRenameSkippedItem {
                        path: child_path.to_string_lossy().into_owned(),
                        reason: "Skipped symbolic link or reparse point.".to_string(),
                    });
                    continue;
                }
                if child_meta.is_dir() || !child_meta.is_file() {
                    // Direct regular files only when dropping a folder into F02
                    continue;
                }

                let (dedup_key, entry) =
                    build_entry_from_verified_file(&child_path, &child_meta, Some(exact_name))?;
                if seen_keys.insert(dedup_key) {
                    if entries.len() >= MAX_BATCH_RENAME_FILES {
                        return Err(AppError::size_limit(format!(
                            "Batch Rename supports at most {MAX_BATCH_RENAME_FILES} files per batch."
                        )));
                    }
                    let p_buf = PathBuf::from(&entry.parent_dir);
                    parent_dirs_to_scan
                        .entry(entry.parent_dir.clone())
                        .or_insert(p_buf);
                    entries.push(entry);
                }
            }
        }
    }

    let mut existing_dir_siblings: HashMap<String, Vec<String>> = HashMap::new();
    for (dir_label, dir_buf) in parent_dirs_to_scan {
        if let Ok(rd) = fs::read_dir(&dir_buf) {
            let mut names: Vec<String> = rd
                .filter_map(|e| {
                    e.ok()
                        .map(|item| item.file_name().to_string_lossy().into_owned())
                })
                .collect();
            names.sort_by_key(|a| a.to_lowercase());
            existing_dir_siblings.insert(dir_label, names);
        }
    }

    Ok(BatchRenameInspectResponse {
        entries,
        existing_dir_siblings,
        skipped,
    })
}

#[derive(Debug, Clone)]
struct PlannedRenameStep {
    source_path: PathBuf,
    temp_path: PathBuf,
    target_path: PathBuf,
    old_name: String,
    new_name: String,
}

fn allocate_temp_path(parent_dir: &Path, batch_seq: u64, index: usize) -> PathBuf {
    let pid = std::process::id();
    let mut attempt: u32 = 0;
    loop {
        let candidate = if attempt == 0 {
            parent_dir.join(format!(".winkit-ren-{pid}-{batch_seq:x}-{index}.tmp"))
        } else {
            parent_dir.join(format!(
                ".winkit-ren-{pid}-{batch_seq:x}-{index}-{attempt}.tmp"
            ))
        };
        if fs::symlink_metadata(&candidate).is_err() {
            return candidate;
        }
        attempt = attempt.saturating_add(1);
    }
}

/// Executes a validated two-phase non-overwriting rename plan (`source -> temp -> target`).
/// On any mid-batch failure in Phase 1 or Phase 2, performs deterministic 2-step reverse rollback
/// (`committed target -> temp`, then `staged temp -> source`) so cycles/swaps never collide.
fn run_two_phase_plan(plan: &[PlannedRenameStep], op_label: &str) -> Result<(), AppError> {
    let mut staged_indices: Vec<usize> = Vec::with_capacity(plan.len());

    // Phase 1: move every source_path -> temp_path
    for (idx, step) in plan.iter().enumerate() {
        if let Err(stage_err) = move_file_no_overwrite(
            &step.source_path,
            &step.temp_path,
            &format!("{op_label} (stage \"{}\")", step.old_name),
        ) {
            let mut rollback_failures = Vec::new();
            for &done_idx in staged_indices.iter().rev() {
                let done_step = &plan[done_idx];
                if let Err(rb_err) = move_file_no_overwrite(
                    &done_step.temp_path,
                    &done_step.source_path,
                    "Rollback staged file",
                ) {
                    rollback_failures.push(format!("{}: {}", done_step.old_name, rb_err.message));
                }
            }

            if rollback_failures.is_empty() {
                return Err(AppError::new(
                    stage_err.code,
                    format!(
                        "{} All previously staged files in this batch were safely rolled back.",
                        stage_err.message
                    ),
                ));
            }
            return Err(AppError::new(
                "RENAME_ROLLBACK_INCOMPLETE",
                format!(
                    "{}; rollback encountered {} issue(s): {}",
                    stage_err.message,
                    rollback_failures.len(),
                    rollback_failures.join("; ")
                ),
            ));
        }
        staged_indices.push(idx);
    }

    // Phase 2: move every temp_path -> target_path
    let mut committed_indices: Vec<usize> = Vec::with_capacity(plan.len());
    for (idx, step) in plan.iter().enumerate() {
        if let Err(commit_err) = move_file_no_overwrite(
            &step.temp_path,
            &step.target_path,
            &format!("{op_label} (commit \"{}\")", step.new_name),
        ) {
            let mut rollback_failures = Vec::new();
            // Step A: move already-committed targets back to their vacant temp_paths first
            // so swaps/cycles (`a.txt <-> b.txt`) never collide during rollback!
            for &comm_idx in committed_indices.iter().rev() {
                let comm_step = &plan[comm_idx];
                if let Err(rb_err) = move_file_no_overwrite(
                    &comm_step.target_path,
                    &comm_step.temp_path,
                    "Rollback committed target to staging",
                ) {
                    rollback_failures.push(format!("{}: {}", comm_step.new_name, rb_err.message));
                }
            }
            // Step B: move all temp_paths back to their original source_paths
            for &staged_idx in staged_indices.iter().rev() {
                let staged_step = &plan[staged_idx];
                if fs::symlink_metadata(&staged_step.temp_path).is_ok() {
                    if let Err(rb_err) = move_file_no_overwrite(
                        &staged_step.temp_path,
                        &staged_step.source_path,
                        "Rollback staged file to original name",
                    ) {
                        rollback_failures
                            .push(format!("{}: {}", staged_step.old_name, rb_err.message));
                    }
                }
            }

            if rollback_failures.is_empty() {
                return Err(AppError::new(
                    commit_err.code,
                    format!(
                        "{} All files in this batch were safely rolled back to their original names.",
                        commit_err.message
                    ),
                ));
            }
            return Err(AppError::new(
                "RENAME_ROLLBACK_INCOMPLETE",
                format!(
                    "{}; rollback encountered {} issue(s): {}",
                    commit_err.message,
                    rollback_failures.len(),
                    rollback_failures.join("; ")
                ),
            ));
        }
        committed_indices.push(idx);
    }

    Ok(())
}

/// Reads the true directory-entry casing of `target_file` inside `parent_dir` if present,
/// ensuring case-sensitive detection on case-insensitive NTFS volumes.
fn find_exact_on_disk_name(parent_dir: &Path, candidate_name: &str) -> Option<String> {
    let rd = fs::read_dir(parent_dir).ok()?;
    for entry in rd.flatten() {
        let entry_name = entry.file_name().to_string_lossy().into_owned();
        if entry_name.eq_ignore_ascii_case(candidate_name)
            || entry_name.to_lowercase() == candidate_name.to_lowercase()
        {
            return Some(entry_name);
        }
    }
    None
}

pub fn execute_batch_rename_impl(
    state: &BatchRenameState,
    operations: &[RenamePairInput],
    all_current_paths: &[String],
) -> Result<BatchRenameExecuteResponse, AppError> {
    if operations.is_empty() {
        return Err(AppError::invalid_param(
            "No rename operations were submitted.",
        ));
    }
    if operations.len() > MAX_BATCH_RENAME_FILES {
        return Err(AppError::size_limit(format!(
            "Batch Rename supports at most {MAX_BATCH_RENAME_FILES} files per batch."
        )));
    }

    let batch_seq = RENAME_BATCH_SEQ.fetch_add(1, Ordering::Relaxed);
    let mut seen_old_slots = HashSet::new();
    let mut seen_new_slots = HashSet::new();
    let mut raw_steps: Vec<(PathBuf, PathBuf, String, String, String, String)> = Vec::new();

    for op in operations {
        let src_input = validate_user_path(&op.source_path, "Source")?;
        let sym_meta = fs::symlink_metadata(&src_input)
            .map_err(|e| AppError::from_io(e, "Source file check failed"))?;
        if is_reparse_point_meta(&sym_meta) {
            return Err(AppError::invalid_param(
                "Symbolic links and reparse points cannot be batch renamed.",
            ));
        }
        if !sym_meta.is_file() {
            return Err(AppError::invalid_param(
                "Only regular files can be renamed.",
            ));
        }

        let parent_dir = src_input
            .parent()
            .ok_or_else(|| AppError::invalid_param("Source file has no parent directory."))?
            .to_path_buf();
        let requested_old_name = src_input
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| AppError::invalid_param("Invalid source filename."))?;

        let exact_old_name =
            find_exact_on_disk_name(&parent_dir, &requested_old_name).ok_or_else(|| {
                AppError::new(
                    "FILE_NOT_FOUND",
                    format!("Source file \"{requested_old_name}\" no longer exists."),
                )
            })?;

        validate_windows_target_name(&op.new_name)?;

        let old_slot = normalized_slot_key(&parent_dir, &exact_old_name);
        if !seen_old_slots.insert(old_slot.clone()) {
            return Err(AppError::invalid_param(format!(
                "Duplicate source file \"{exact_old_name}\" in rename batch."
            )));
        }

        let new_slot = normalized_slot_key(&parent_dir, &op.new_name);
        if !seen_new_slots.insert(new_slot.clone()) {
            return Err(AppError::new(
                "BATCH_TARGET_CONFLICT",
                format!(
                    "Multiple files in this batch resolve to the same target name \"{}\".",
                    op.new_name
                ),
            ));
        }

        if exact_old_name == op.new_name {
            // Exact no-op; keep slot registered in seen_old_slots/seen_new_slots above
            // so no other item in the batch can overwrite an unchanged file!
            continue;
        }

        let exact_source_path = parent_dir.join(&exact_old_name);
        raw_steps.push((
            parent_dir,
            exact_source_path,
            exact_old_name,
            op.new_name.clone(),
            old_slot,
            new_slot,
        ));
    }

    if raw_steps.is_empty() {
        return Err(AppError::invalid_param(
            "No files have effective name changes to apply.",
        ));
    }

    // Pre-check external destination collisions (e.g. a file created in Explorer after preview!)
    for (parent_dir, _, _, new_name, _, new_slot) in &raw_steps {
        if !seen_old_slots.contains(new_slot) {
            let candidate_target = parent_dir.join(new_name);
            if fs::symlink_metadata(&candidate_target).is_ok()
                || find_exact_on_disk_name(parent_dir, new_name).is_some()
            {
                return Err(AppError::new(
                    "TARGET_ALREADY_EXISTS",
                    format!(
                        "Target filename \"{new_name}\" already exists on disk. Existing file was protected and no files were renamed."
                    ),
                ));
            }
        }
    }

    let mut plan: Vec<PlannedRenameStep> = Vec::with_capacity(raw_steps.len());
    for (idx, (parent_dir, source_path, old_name, new_name, _, _)) in
        raw_steps.into_iter().enumerate()
    {
        let temp_path = allocate_temp_path(&parent_dir, batch_seq, idx);
        let target_path = parent_dir.join(&new_name);
        plan.push(PlannedRenameStep {
            source_path,
            temp_path,
            target_path,
            old_name,
            new_name,
        });
    }

    run_two_phase_plan(&plan, "Batch rename")?;

    let mut renamed_lookup: HashMap<String, PathBuf> = HashMap::with_capacity(plan.len());
    let mut reports: Vec<RenamedItemReport> = Vec::with_capacity(plan.len());
    let mut undo_pairs: Vec<CommittedRenamePair> = Vec::with_capacity(plan.len());

    for step in &plan {
        if let Some(parent) = step.source_path.parent() {
            renamed_lookup.insert(
                normalized_slot_key(parent, &step.old_name),
                step.target_path.clone(),
            );
        }
        reports.push(RenamedItemReport {
            old_path: step.source_path.to_string_lossy().into_owned(),
            new_path: step.target_path.to_string_lossy().into_owned(),
            old_name: step.old_name.clone(),
            new_name: step.new_name.clone(),
        });
        undo_pairs.push(CommittedRenamePair {
            original_path: step.source_path.clone(),
            original_name: step.old_name.clone(),
            renamed_path: step.target_path.clone(),
            renamed_name: step.new_name.clone(),
        });
    }

    let undo_status = state.store_undo(LastBatchUndoRecord {
        completed_at_ms: now_epoch_ms(),
        pairs: undo_pairs,
    });

    // Map caller's current workspace path list so renamed files stay loaded under their new paths
    let next_paths: Vec<String> = if all_current_paths.is_empty() {
        reports.iter().map(|r| r.new_path.clone()).collect()
    } else {
        all_current_paths
            .iter()
            .map(|raw| {
                let p = PathBuf::from(raw);
                if let (Some(parent), Some(fname)) = (p.parent(), p.file_name()) {
                    let slot = normalized_slot_key(parent, &fname.to_string_lossy());
                    if let Some(updated) = renamed_lookup.get(&slot) {
                        return updated.to_string_lossy().into_owned();
                    }
                }
                raw.clone()
            })
            .collect()
    };

    let updated_inspection = inspect_sources_impl(&next_paths)?;

    Ok(BatchRenameExecuteResponse {
        renamed_count: reports.len(),
        items: reports,
        updated_inspection,
        undo_status,
    })
}

pub fn undo_last_batch_rename_impl(
    state: &BatchRenameState,
    all_current_paths: &[String],
) -> Result<BatchRenameExecuteResponse, AppError> {
    let record = state.peek_undo().ok_or_else(|| {
        AppError::invalid_param("There is no recent rename batch available to undo.")
    })?;
    if record.pairs.is_empty() {
        return Err(AppError::invalid_param(
            "There is no recent rename batch available to undo.",
        ));
    }

    let batch_seq = RENAME_BATCH_SEQ.fetch_add(1, Ordering::Relaxed);
    let mut undo_old_slots = HashSet::new();
    for pair in &record.pairs {
        let sym_meta = fs::symlink_metadata(&pair.renamed_path).map_err(|_| {
            AppError::new(
                "UNDO_SOURCE_MISSING",
                format!(
                    "Cannot undo batch: renamed file \"{}\" was moved or deleted.",
                    pair.renamed_name
                ),
            )
        })?;
        if is_reparse_point_meta(&sym_meta) || !sym_meta.is_file() {
            return Err(AppError::new(
                "UNDO_SOURCE_INVALID",
                format!(
                    "Cannot undo batch: \"{}\" is no longer a regular file.",
                    pair.renamed_name
                ),
            ));
        }
        if let Some(parent) = pair.renamed_path.parent() {
            undo_old_slots.insert(normalized_slot_key(parent, &pair.renamed_name));
        }
    }

    // Protect any newly-created external file occupying an original filename!
    for pair in &record.pairs {
        let parent = pair
            .original_path
            .parent()
            .ok_or_else(|| AppError::invalid_param("Invalid original parent path."))?;
        let target_slot = normalized_slot_key(parent, &pair.original_name);
        if !undo_old_slots.contains(&target_slot)
            && (fs::symlink_metadata(&pair.original_path).is_ok()
                || find_exact_on_disk_name(parent, &pair.original_name).is_some())
        {
            return Err(AppError::new(
                "UNDO_TARGET_OCCUPIED",
                format!(
                    "Cannot undo batch: original filename \"{}\" is now occupied by another file. Existing files were left untouched.",
                    pair.original_name
                ),
            ));
        }
    }

    let mut plan: Vec<PlannedRenameStep> = Vec::with_capacity(record.pairs.len());
    for (idx, pair) in record.pairs.iter().enumerate() {
        let parent = pair
            .renamed_path
            .parent()
            .ok_or_else(|| AppError::invalid_param("Invalid parent directory."))?;
        let temp_path = allocate_temp_path(parent, batch_seq, idx);
        plan.push(PlannedRenameStep {
            source_path: pair.renamed_path.clone(),
            temp_path,
            target_path: pair.original_path.clone(),
            old_name: pair.renamed_name.clone(),
            new_name: pair.original_name.clone(),
        });
    }

    run_two_phase_plan(&plan, "Undo batch rename")?;

    let undo_status = state.clear_undo();

    let mut restored_lookup: HashMap<String, PathBuf> = HashMap::with_capacity(plan.len());
    let mut reports: Vec<RenamedItemReport> = Vec::with_capacity(plan.len());
    for step in &plan {
        if let Some(parent) = step.source_path.parent() {
            restored_lookup.insert(
                normalized_slot_key(parent, &step.old_name),
                step.target_path.clone(),
            );
        }
        reports.push(RenamedItemReport {
            old_path: step.source_path.to_string_lossy().into_owned(),
            new_path: step.target_path.to_string_lossy().into_owned(),
            old_name: step.old_name.clone(),
            new_name: step.new_name.clone(),
        });
    }

    let next_paths: Vec<String> = if all_current_paths.is_empty() {
        reports.iter().map(|r| r.new_path.clone()).collect()
    } else {
        all_current_paths
            .iter()
            .map(|raw| {
                let p = PathBuf::from(raw);
                if let (Some(parent), Some(fname)) = (p.parent(), p.file_name()) {
                    let slot = normalized_slot_key(parent, &fname.to_string_lossy());
                    if let Some(updated) = restored_lookup.get(&slot) {
                        return updated.to_string_lossy().into_owned();
                    }
                }
                raw.clone()
            })
            .collect()
    };

    let updated_inspection = inspect_sources_impl(&next_paths)?;

    Ok(BatchRenameExecuteResponse {
        renamed_count: reports.len(),
        items: reports,
        updated_inspection,
        undo_status,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn list_exact_dir_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .expect("read_dir")
            .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn case_only_rename_and_undo_preserve_exact_casing_and_contents() {
        let dir = tempdir().expect("tempdir");
        let file_lower = dir.path().join("readme.txt");
        fs::write(&file_lower, b"case-only payload 001").expect("write");

        let state = BatchRenameState::default();
        let initial_paths = vec![file_lower.to_string_lossy().into_owned()];
        let inspected = inspect_sources_impl(&initial_paths).expect("inspect");
        assert_eq!(inspected.entries.len(), 1);
        assert_eq!(inspected.entries[0].file_name, "readme.txt");

        let exec = execute_batch_rename_impl(
            &state,
            &[RenamePairInput {
                source_path: inspected.entries[0].path.clone(),
                new_name: "README.txt".to_string(),
            }],
            &initial_paths,
        )
        .expect("case-only execute");

        assert_eq!(exec.renamed_count, 1);
        assert!(exec.undo_status.available);
        assert_eq!(list_exact_dir_names(dir.path()), vec!["README.txt"]);
        assert_eq!(
            fs::read(dir.path().join("README.txt")).expect("read"),
            b"case-only payload 001"
        );

        let after_paths = vec![exec.items[0].new_path.clone()];
        let undone = undo_last_batch_rename_impl(&state, &after_paths).expect("case-only undo");
        assert_eq!(undone.renamed_count, 1);
        assert!(!undone.undo_status.available);
        assert_eq!(list_exact_dir_names(dir.path()), vec!["readme.txt"]);
        assert_eq!(
            fs::read(dir.path().join("readme.txt")).expect("read"),
            b"case-only payload 001"
        );
    }

    #[test]
    fn two_file_swap_and_undo_preserve_distinct_file_contents() {
        let dir = tempdir().expect("tempdir");
        let a_path = dir.path().join("alpha.txt");
        let b_path = dir.path().join("beta.txt");
        fs::write(&a_path, b"CONTENT_FROM_ALPHA").expect("write alpha");
        fs::write(&b_path, b"CONTENT_FROM_BETA").expect("write beta");

        let state = BatchRenameState::default();
        let paths = vec![
            a_path.to_string_lossy().into_owned(),
            b_path.to_string_lossy().into_owned(),
        ];

        let exec = execute_batch_rename_impl(
            &state,
            &[
                RenamePairInput {
                    source_path: a_path.to_string_lossy().into_owned(),
                    new_name: "beta.txt".to_string(),
                },
                RenamePairInput {
                    source_path: b_path.to_string_lossy().into_owned(),
                    new_name: "alpha.txt".to_string(),
                },
            ],
            &paths,
        )
        .expect("swap execute");

        assert_eq!(exec.renamed_count, 2);
        assert_eq!(
            list_exact_dir_names(dir.path()),
            vec!["alpha.txt", "beta.txt"]
        );
        assert_eq!(
            fs::read(&a_path).expect("read new alpha"),
            b"CONTENT_FROM_BETA"
        );
        assert_eq!(
            fs::read(&b_path).expect("read new beta"),
            b"CONTENT_FROM_ALPHA"
        );

        let undone = undo_last_batch_rename_impl(&state, &paths).expect("swap undo");
        assert_eq!(undone.renamed_count, 2);
        assert_eq!(
            fs::read(&a_path).expect("restored alpha"),
            b"CONTENT_FROM_ALPHA"
        );
        assert_eq!(
            fs::read(&b_path).expect("restored beta"),
            b"CONTENT_FROM_BETA"
        );
    }

    #[cfg(windows)]
    #[test]
    fn mid_batch_lock_failure_rolls_back_earlier_files_cleanly() {
        use std::os::windows::fs::OpenOptionsExt;

        let dir = tempdir().expect("tempdir");
        let f1 = dir.path().join("one.txt");
        let f2 = dir.path().join("two.txt");
        let f3 = dir.path().join("three.txt");
        fs::write(&f1, b"payload-1").expect("write 1");
        fs::write(&f2, b"payload-2").expect("write 2");
        fs::write(&f3, b"payload-3").expect("write 3");

        // Hold f2 open WITHOUT FILE_SHARE_DELETE (share_mode = FILE_SHARE_READ = 1)
        // so MoveFileExW fails on item #2 after item #1 has already been staged to .tmp!
        let locked_handle = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&f2)
            .expect("lock f2 without FILE_SHARE_DELETE");

        let state = BatchRenameState::default();
        let err = execute_batch_rename_impl(
            &state,
            &[
                RenamePairInput {
                    source_path: f1.to_string_lossy().into_owned(),
                    new_name: "renamed-1.txt".to_string(),
                },
                RenamePairInput {
                    source_path: f2.to_string_lossy().into_owned(),
                    new_name: "renamed-2.txt".to_string(),
                },
                RenamePairInput {
                    source_path: f3.to_string_lossy().into_owned(),
                    new_name: "renamed-3.txt".to_string(),
                },
            ],
            &[],
        )
        .expect_err("mid-batch locked file must fail and roll back");

        drop(locked_handle);

        assert_eq!(err.code, "FILE_LOCKED");
        assert!(err.message.contains("rolled back"));
        assert!(!state.status().available);
        assert_eq!(
            list_exact_dir_names(dir.path()),
            vec!["one.txt", "three.txt", "two.txt"]
        );
        assert_eq!(fs::read(&f1).expect("f1 intact"), b"payload-1");
        assert_eq!(fs::read(&f2).expect("f2 intact"), b"payload-2");
        assert_eq!(fs::read(&f3).expect("f3 intact"), b"payload-3");
    }

    #[test]
    fn protects_external_file_created_after_preview_and_protects_occupied_undo_target() {
        let dir = tempdir().expect("tempdir");
        let src = dir.path().join("draft.txt");
        fs::write(&src, b"OUR_DRAFT_CONTENT").expect("write draft");

        // 1. External file appears at target path right after preview before execute
        let ext = dir.path().join("final.txt");
        fs::write(&ext, b"EXTERNAL_EXISTING_FILE").expect("write external");

        let state = BatchRenameState::default();
        let blocked = execute_batch_rename_impl(
            &state,
            &[RenamePairInput {
                source_path: src.to_string_lossy().into_owned(),
                new_name: "final.txt".to_string(),
            }],
            &[],
        )
        .expect_err("must refuse overwriting post-preview external file");

        assert_eq!(blocked.code, "TARGET_ALREADY_EXISTS");
        assert_eq!(
            fs::read(&ext).expect("ext intact"),
            b"EXTERNAL_EXISTING_FILE"
        );
        assert_eq!(fs::read(&src).expect("src intact"), b"OUR_DRAFT_CONTENT");

        // Remove external file and perform valid rename draft.txt -> published.txt
        fs::remove_file(&ext).expect("remove ext");
        let exec = execute_batch_rename_impl(
            &state,
            &[RenamePairInput {
                source_path: src.to_string_lossy().into_owned(),
                new_name: "published.txt".to_string(),
            }],
            &[],
        )
        .expect("valid rename");
        assert_eq!(exec.renamed_count, 1);

        // 2. Now create a brand-new file occupying the original name `draft.txt` BEFORE Undo!
        fs::write(&src, b"NEW_FILE_AT_OLD_NAME").expect("occupy old name");
        let undo_err = undo_last_batch_rename_impl(&state, &[])
            .expect_err("undo must refuse overwriting newly created file at original name");
        assert_eq!(undo_err.code, "UNDO_TARGET_OCCUPIED");

        let published = dir.path().join("published.txt");
        assert_eq!(
            fs::read(&src).expect("occupying file intact"),
            b"NEW_FILE_AT_OLD_NAME"
        );
        assert_eq!(
            fs::read(&published).expect("renamed file intact"),
            b"OUR_DRAFT_CONTENT"
        );
        // Undo record remains available once user resolves collision
        assert!(state.status().available);

        fs::remove_file(&src).expect("clear occupying file");
        let undo_ok =
            undo_last_batch_rename_impl(&state, &[]).expect("undo succeeds after clearing");
        assert_eq!(undo_ok.renamed_count, 1);
        assert_eq!(
            fs::read(&src).expect("restored draft"),
            b"OUR_DRAFT_CONTENT"
        );
        assert!(!published.exists());
    }

    #[test]
    fn folder_inspection_collects_direct_regular_files_and_ignores_subdirectories() {
        let dir = tempdir().expect("tempdir");
        fs::write(dir.path().join("b.txt"), b"b").expect("write b");
        fs::write(dir.path().join("a.txt"), b"a").expect("write a");
        let sub = dir.path().join("nested");
        fs::create_dir_all(&sub).expect("mkdir sub");
        fs::write(sub.join("inside.txt"), b"nested").expect("write nested");

        let res = inspect_sources_impl(&[
            dir.path().to_string_lossy().into_owned(),
            dir.path().join("a.txt").to_string_lossy().into_owned(),
        ])
        .expect("inspect dir + duplicate file");

        assert_eq!(
            res.entries
                .iter()
                .map(|e| e.file_name.as_str())
                .collect::<Vec<_>>(),
            vec!["a.txt", "b.txt"]
        );
        let siblings = res
            .existing_dir_siblings
            .values()
            .next()
            .expect("siblings present");
        assert!(siblings.contains(&"nested".to_string()));
    }

    #[test]
    fn phase_two_failure_rolls_back_already_committed_swap_without_collision() {
        let dir = tempdir().expect("tempdir");
        let a_path = dir.path().join("swap_a.txt");
        let b_path = dir.path().join("swap_b.txt");
        let c_path = dir.path().join("item_c.txt");
        let external_path = dir.path().join("sudden_external.txt");

        fs::write(&a_path, b"ORIG_A").expect("write a");
        fs::write(&b_path, b"ORIG_B").expect("write b");
        fs::write(&c_path, b"ORIG_C").expect("write c");
        // Simulate external file appearing right before Phase 2 commits item #3
        fs::write(&external_path, b"UNTOUCHED_EXTERNAL").expect("write ext");

        let plan = vec![
            PlannedRenameStep {
                source_path: a_path.clone(),
                temp_path: allocate_temp_path(dir.path(), 999, 0),
                target_path: b_path.clone(),
                old_name: "swap_a.txt".to_string(),
                new_name: "swap_b.txt".to_string(),
            },
            PlannedRenameStep {
                source_path: b_path.clone(),
                temp_path: allocate_temp_path(dir.path(), 999, 1),
                target_path: a_path.clone(),
                old_name: "swap_b.txt".to_string(),
                new_name: "swap_a.txt".to_string(),
            },
            PlannedRenameStep {
                source_path: c_path.clone(),
                temp_path: allocate_temp_path(dir.path(), 999, 2),
                target_path: external_path.clone(),
                old_name: "item_c.txt".to_string(),
                new_name: "sudden_external.txt".to_string(),
            },
        ];

        let err = run_two_phase_plan(&plan, "Simulated race")
            .expect_err("phase 2 collision must abort and roll back swap");
        assert_eq!(err.code, "TARGET_ALREADY_EXISTS");
        assert!(err.message.contains("rolled back"));

        assert_eq!(fs::read(&a_path).expect("a restored"), b"ORIG_A");
        assert_eq!(fs::read(&b_path).expect("b restored"), b"ORIG_B");
        assert_eq!(fs::read(&c_path).expect("c restored"), b"ORIG_C");
        assert_eq!(
            fs::read(&external_path).expect("external protected"),
            b"UNTOUCHED_EXTERNAL"
        );
        assert_eq!(
            list_exact_dir_names(dir.path()),
            vec![
                "item_c.txt",
                "sudden_external.txt",
                "swap_a.txt",
                "swap_b.txt"
            ]
        );
    }
}
