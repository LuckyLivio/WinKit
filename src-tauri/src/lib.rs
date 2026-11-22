pub mod batch_rename;
pub mod beautifier;
pub mod codec;
pub mod error;
pub mod fs_guard;
pub mod hasher;
pub mod jwt;
pub mod password_gen;
mod qr;
pub mod tasks;
pub mod unicode_inspector;
pub mod uuid_tool;

use crate::batch_rename::{
    execute_batch_rename_impl, inspect_sources_impl, undo_last_batch_rename_impl,
    BatchRenameExecuteResponse, BatchRenameInspectResponse, BatchRenameState,
    BatchRenameUndoStatus, RenamePairInput,
};
use crate::beautifier::{
    export_beautified_png_cancellable, inspect_source_image, BeautifyExportParams,
    BeautifyExportResult, SourceImageInspection,
};
use crate::codec::{
    compute_full_utf8_result, export_codec_result_to_file, transform_file_payload,
    transform_text_payload, CodecOptions, CodecTransformResponse,
};
use crate::error::AppError;
use crate::fs_guard::{
    paths_refer_to_same_location, read_strict_coord_batch_file, read_strict_diff_text_file,
    read_strict_tabular_text_file, read_utf8_text_file_bounded, suggest_safe_output_path,
    validate_user_path, write_output_bytes_cancellable, DiffTextFilePayload, SavedFileInfo,
    TextFilePayload,
};
use crate::hasher::{
    compute_text_hashes, execute_batch_hash_with_guard, execute_file_hash_with_guard,
    prepare_batch_hash_task, prepare_file_hash_task, BatchHashInputItem, HashAlgorithm,
    MultiFileBatchHashResult, MultiFileHashResult, MultiTextHashResult, HASH_BATCH_ITEM_EVENT,
};
use crate::jwt::{verify_jwt_hmac_token, JwtHmacVerifyRequest, JwtHmacVerifyResponse};
use crate::password_gen::{generate_secrets_with_os_rng, SecretGenRequest, SecretGenResponse};
use crate::tasks::{
    CloseRequestDecision, ShutdownDrainResult, TaskProgressPayload, TaskRegistry,
    TaskRegistrySnapshot, TaskTokenGuard, TASK_PROGRESS_EVENT,
};
use crate::unicode_inspector::{
    inspect_and_sanitize_unicode, UnicodeInspectionResponse, UnicodeSanitizeOptions,
};
use crate::uuid_tool::{
    generate_uuid_batch, inspect_uuid_string, UuidGenVersion, UuidInspectResult,
};
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime, State};

static INTERNAL_TASK_SEQ: AtomicU64 = AtomicU64::new(1);

fn next_internal_task_id(prefix: &str) -> String {
    let seq = INTERNAL_TASK_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{seq}")
}

fn sanitize_tool_id(tool_id: Option<&str>, fallback: &str) -> Result<String, AppError> {
    let raw = tool_id.map(str::trim).filter(|s| !s.is_empty());
    let candidate = raw.unwrap_or(fallback);
    if candidate.len() > 8
        || !candidate
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::invalid_param("Invalid tool identifier."));
    }
    Ok(candidate.to_string())
}

pub fn prepare_save_text_task(
    registry: &TaskRegistry,
    tool_id: Option<&str>,
) -> Result<TaskTokenGuard, AppError> {
    let resolved_tool = sanitize_tool_id(tool_id, "D01")?;
    let task_id = next_internal_task_id("save-text");
    registry.register_checked(&task_id, &resolved_tool, false)
}

pub fn execute_save_text_with_guard<E>(
    guard: TaskTokenGuard,
    output_path: &str,
    source_path: Option<&str>,
    content: &str,
    overwrite: bool,
    mut on_event: E,
) -> Result<SavedFileInfo, AppError>
where
    E: FnMut(&TaskProgressPayload),
{
    execute_save_text_multi_source_with_guard(
        guard,
        output_path,
        source_path,
        None,
        &[],
        content,
        overwrite,
        &mut on_event,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn execute_save_text_multi_source_with_guard<E>(
    guard: TaskTokenGuard,
    output_path: &str,
    source_path: Option<&str>,
    secondary_source_path: Option<&str>,
    extra_forbidden_sources: &[String],
    content: &str,
    overwrite: bool,
    mut on_event: E,
) -> Result<SavedFileInfo, AppError>
where
    E: FnMut(&TaskProgressPayload),
{
    let task_id = guard.task_id().to_string();
    let tool_id = guard.tool_id().to_string();
    let total_bytes = Some(content.len() as u64);

    on_event(&TaskProgressPayload::running(
        &task_id,
        &tool_id,
        total_bytes,
    ));

    let cancel_flag = guard.cancel_flag();
    let res = (|| {
        let out_buf = validate_user_path(output_path, "Output")?;
        let src_buf = match source_path {
            Some(raw) if !raw.trim().is_empty() => Some(validate_user_path(raw, "Source")?),
            _ => None,
        };
        if let Some(raw_sec) = secondary_source_path.filter(|s| !s.trim().is_empty()) {
            let sec_buf = validate_user_path(raw_sec, "Secondary source")?;
            if paths_refer_to_same_location(&sec_buf, &out_buf) {
                return Err(AppError::same_input_output());
            }
        }
        for extra in extra_forbidden_sources {
            if !extra.trim().is_empty() {
                let extra_buf = validate_user_path(extra, "Batch source")?;
                if paths_refer_to_same_location(&extra_buf, &out_buf) {
                    return Err(AppError::same_input_output());
                }
            }
        }
        write_output_bytes_cancellable(
            output_path,
            src_buf.as_deref(),
            content.as_bytes(),
            overwrite,
            Some(&cancel_flag),
        )
    })();

    drop(guard);

    match &res {
        Ok(saved) => {
            on_event(&TaskProgressPayload::completed(
                &task_id,
                &tool_id,
                saved.byte_length,
                Some(saved.byte_length),
            ));
        }
        Err(err) => {
            on_event(&TaskProgressPayload::failed_or_cancelled(
                &task_id,
                &tool_id,
                0,
                total_bytes,
                err,
            ));
        }
    }
    res
}

pub fn execute_codec_transform_file_with_guard<E>(
    guard: TaskTokenGuard,
    path: &str,
    options: &CodecOptions,
    mut on_event: E,
) -> Result<CodecTransformResponse, AppError>
where
    E: FnMut(&TaskProgressPayload),
{
    let task_id = guard.task_id().to_string();
    let tool_id = guard.tool_id().to_string();
    on_event(&TaskProgressPayload::running(&task_id, &tool_id, None));

    let cancel_flag = guard.cancel_flag();
    let res = transform_file_payload(path, options, Some(&cancel_flag));
    drop(guard);

    match &res {
        Ok(resp) => {
            let done_bytes = resp.input_byte_length as u64;
            on_event(&TaskProgressPayload::completed(
                &task_id,
                &tool_id,
                done_bytes,
                Some(done_bytes),
            ));
        }
        Err(err) => {
            on_event(&TaskProgressPayload::failed_or_cancelled(
                &task_id, &tool_id, 0, None, err,
            ));
        }
    }
    res
}

pub fn execute_codec_save_with_guard<E>(
    guard: TaskTokenGuard,
    text_input: Option<&str>,
    source_file_path: Option<&str>,
    output_path: &str,
    overwrite: bool,
    options: &CodecOptions,
    mut on_event: E,
) -> Result<SavedFileInfo, AppError>
where
    E: FnMut(&TaskProgressPayload),
{
    let task_id = guard.task_id().to_string();
    let tool_id = guard.tool_id().to_string();
    on_event(&TaskProgressPayload::running(&task_id, &tool_id, None));

    let cancel_flag = guard.cancel_flag();
    let res = export_codec_result_to_file(
        text_input,
        source_file_path,
        output_path,
        overwrite,
        options,
        Some(&cancel_flag),
    );
    drop(guard);

    match &res {
        Ok(saved) => {
            on_event(&TaskProgressPayload::completed(
                &task_id,
                &tool_id,
                saved.byte_length,
                Some(saved.byte_length),
            ));
        }
        Err(err) => {
            on_event(&TaskProgressPayload::failed_or_cancelled(
                &task_id, &tool_id, 0, None, err,
            ));
        }
    }
    res
}

pub fn execute_beautifier_export_with_guard<E>(
    guard: TaskTokenGuard,
    params: &BeautifyExportParams,
    mut on_event: E,
) -> Result<BeautifyExportResult, AppError>
where
    E: FnMut(&TaskProgressPayload),
{
    let task_id = guard.task_id().to_string();
    let tool_id = guard.tool_id().to_string();
    on_event(&TaskProgressPayload::running(&task_id, &tool_id, None));

    let cancel_flag = guard.cancel_flag();
    let res = export_beautified_png_cancellable(params, Some(&cancel_flag));
    drop(guard);

    match &res {
        Ok(saved) => {
            on_event(&TaskProgressPayload::completed(
                &task_id,
                &tool_id,
                saved.byte_length,
                Some(saved.byte_length),
            ));
        }
        Err(err) => {
            on_event(&TaskProgressPayload::failed_or_cancelled(
                &task_id, &tool_id, 0, None, err,
            ));
        }
    }
    res
}

#[derive(Debug, Clone, Serialize)]
pub struct AppRuntimeInfo {
    pub name: &'static str,
    pub version: &'static str,
    pub platform: &'static str,
    pub arch: &'static str,
}

#[tauri::command]
fn get_runtime_info() -> AppRuntimeInfo {
    AppRuntimeInfo {
        name: "WinKit",
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    }
}

#[tauri::command]
fn read_clipboard_text(registry: State<'_, TaskRegistry>) -> Result<String, AppError> {
    registry.ensure_not_shutting_down()?;
    let mut clipboard = arboard::Clipboard::new().map_err(|_| {
        AppError::new(
            "CLIPBOARD_UNAVAILABLE",
            "Unable to access system clipboard.",
        )
    })?;
    match clipboard.get_text() {
        Ok(text) => Ok(text),
        Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
        Err(_) => Err(AppError::new(
            "CLIPBOARD_READ_FAILED",
            "Clipboard does not contain readable plain text.",
        )),
    }
}

#[tauri::command]
fn write_clipboard_text(registry: State<'_, TaskRegistry>, text: String) -> Result<(), AppError> {
    registry.ensure_not_shutting_down()?;
    let mut clipboard = arboard::Clipboard::new().map_err(|_| {
        AppError::new(
            "CLIPBOARD_UNAVAILABLE",
            "Unable to access system clipboard.",
        )
    })?;
    clipboard
        .set_text(text)
        .map_err(|_| AppError::new("CLIPBOARD_WRITE_FAILED", "Unable to update clipboard text."))
}

#[tauri::command]
async fn read_text_file(
    registry: State<'_, TaskRegistry>,
    path: String,
) -> Result<TextFilePayload, AppError> {
    registry.ensure_not_shutting_down()?;
    tauri::async_runtime::spawn_blocking(move || read_utf8_text_file_bounded(&path))
        .await
        .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Background file reader failed."))?
}

#[tauri::command]
async fn read_diff_text_file(
    registry: State<'_, TaskRegistry>,
    path: String,
    tool_id: Option<String>,
) -> Result<DiffTextFilePayload, AppError> {
    let resolved_tool = sanitize_tool_id(tool_id.as_deref(), "D07")?;
    let task_id = next_internal_task_id("read-diff");
    let guard = registry.register_checked(&task_id, &resolved_tool, true)?;
    tauri::async_runtime::spawn_blocking(move || {
        let res = read_strict_diff_text_file(&path);
        drop(guard);
        res
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Background diff file reader failed."))?
}

#[tauri::command]
async fn read_tabular_text_file(
    registry: State<'_, TaskRegistry>,
    path: String,
) -> Result<DiffTextFilePayload, AppError> {
    let task_id = next_internal_task_id("read-tabular");
    let guard = registry.register_checked(&task_id, "D14", true)?;
    tauri::async_runtime::spawn_blocking(move || {
        let res = read_strict_tabular_text_file(&path);
        drop(guard);
        res
    })
    .await
    .map_err(|_| {
        AppError::new(
            "INTERNAL_JOIN_ERROR",
            "Background tabular file reader failed.",
        )
    })?
}

#[tauri::command]
async fn read_coord_batch_text_file(
    registry: State<'_, TaskRegistry>,
    path: String,
) -> Result<DiffTextFilePayload, AppError> {
    let task_id = next_internal_task_id("read-coord-batch");
    let guard = registry.register_checked(&task_id, "D10", true)?;
    tauri::async_runtime::spawn_blocking(move || {
        let res = read_strict_coord_batch_file(&path);
        drop(guard);
        res
    })
    .await
    .map_err(|_| {
        AppError::new(
            "INTERNAL_JOIN_ERROR",
            "Background coordinate batch file reader failed.",
        )
    })?
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveTextFileParams {
    output_path: String,
    source_path: Option<String>,
    secondary_source_path: Option<String>,
    forbidden_source_paths: Option<Vec<String>>,
    content: String,
    overwrite: bool,
    tool_id: Option<String>,
}

#[tauri::command]
async fn save_text_file<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    params: SaveTextFileParams,
) -> Result<SavedFileInfo, AppError> {
    let guard = prepare_save_text_task(registry.inner(), params.tool_id.as_deref())?;
    let extra_sources = params.forbidden_source_paths.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        execute_save_text_multi_source_with_guard(
            guard,
            &params.output_path,
            params.source_path.as_deref(),
            params.secondary_source_path.as_deref(),
            &extra_sources,
            &params.content,
            params.overwrite,
            |payload| {
                let _ = app.emit(TASK_PROGRESS_EVENT, payload);
            },
        )
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Background file writer failed."))?
}

#[tauri::command]
fn suggest_output_path(
    input_path: String,
    suffix: String,
    extension: String,
) -> Result<String, AppError> {
    suggest_safe_output_path(&input_path, &suffix, &extension)
}

#[tauri::command]
fn hash_text_multi(
    text: String,
    algorithms: Vec<HashAlgorithm>,
) -> Result<MultiTextHashResult, AppError> {
    compute_text_hashes(&text, &algorithms)
}

#[tauri::command]
async fn hash_file_multi<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    task_id: String,
    path: String,
    algorithms: Vec<HashAlgorithm>,
) -> Result<MultiFileHashResult, AppError> {
    let (guard, normalized) = prepare_file_hash_task(registry.inner(), &task_id, &algorithms)?;
    tauri::async_runtime::spawn_blocking(move || {
        execute_file_hash_with_guard(guard, &path, &normalized, |payload| {
            let _ = app.emit(TASK_PROGRESS_EVENT, payload);
        })
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Background hash worker failed."))?
}

#[tauri::command]
async fn hash_files_batch<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    batch_id: String,
    items: Vec<BatchHashInputItem>,
    algorithms: Vec<HashAlgorithm>,
) -> Result<MultiFileBatchHashResult, AppError> {
    let (guard, normalized) =
        prepare_batch_hash_task(registry.inner(), &batch_id, &items, &algorithms)?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(execute_batch_hash_with_guard(
            guard,
            &items,
            &normalized,
            |task_ev| {
                let _ = app.emit(TASK_PROGRESS_EVENT, task_ev);
            },
            |item_ev| {
                let _ = app.emit(HASH_BATCH_ITEM_EVENT, item_ev);
            },
        ))
    })
    .await
    .map_err(|_| {
        AppError::new(
            "INTERNAL_JOIN_ERROR",
            "Background batch hash worker failed.",
        )
    })?
}

#[tauri::command]
async fn codec_transform_text(
    registry: State<'_, TaskRegistry>,
    text: String,
    options: CodecOptions,
) -> Result<CodecTransformResponse, AppError> {
    registry.ensure_not_shutting_down()?;
    tauri::async_runtime::spawn_blocking(move || transform_text_payload(&text, &options, None))
        .await
        .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Background codec worker failed."))?
}

#[tauri::command]
async fn codec_transform_file<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    path: String,
    options: CodecOptions,
) -> Result<CodecTransformResponse, AppError> {
    let task_id = next_internal_task_id("codec-file");
    let guard = registry.register_checked(&task_id, "D02", true)?;
    tauri::async_runtime::spawn_blocking(move || {
        execute_codec_transform_file_with_guard(guard, &path, &options, |payload| {
            let _ = app.emit(TASK_PROGRESS_EVENT, payload);
        })
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Background file codec failed."))?
}

#[tauri::command]
async fn codec_get_full_text(
    registry: State<'_, TaskRegistry>,
    text_input: Option<String>,
    file_path: Option<String>,
    options: CodecOptions,
) -> Result<String, AppError> {
    registry.ensure_not_shutting_down()?;
    tauri::async_runtime::spawn_blocking(move || {
        compute_full_utf8_result(text_input.as_deref(), file_path.as_deref(), &options, None)
    })
    .await
    .map_err(|_| {
        AppError::new(
            "INTERNAL_JOIN_ERROR",
            "Background full-text builder failed.",
        )
    })?
}

#[tauri::command]
async fn codec_save_output<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    text_input: Option<String>,
    source_file_path: Option<String>,
    output_path: String,
    overwrite: bool,
    options: CodecOptions,
) -> Result<SavedFileInfo, AppError> {
    let task_id = next_internal_task_id("save-d02");
    let guard = registry.register_checked(&task_id, "D02", false)?;
    tauri::async_runtime::spawn_blocking(move || {
        execute_codec_save_with_guard(
            guard,
            text_input.as_deref(),
            source_file_path.as_deref(),
            &output_path,
            overwrite,
            &options,
            |payload| {
                let _ = app.emit(TASK_PROGRESS_EVENT, payload);
            },
        )
    })
    .await
    .map_err(|_| {
        AppError::new(
            "INTERNAL_JOIN_ERROR",
            "Background codec file writer failed.",
        )
    })?
}

#[tauri::command]
fn generate_uuids(version: UuidGenVersion, count: usize) -> Result<Vec<String>, AppError> {
    generate_uuid_batch(version, count)
}

#[tauri::command]
fn inspect_uuid(input: String) -> Result<UuidInspectResult, AppError> {
    inspect_uuid_string(&input)
}

#[tauri::command]
fn generate_secrets(
    registry: State<'_, TaskRegistry>,
    req: SecretGenRequest,
) -> Result<SecretGenResponse, AppError> {
    registry.ensure_not_shutting_down()?;
    generate_secrets_with_os_rng(&req)
}

#[tauri::command]
fn verify_jwt_hmac(
    registry: State<'_, TaskRegistry>,
    req: JwtHmacVerifyRequest,
) -> Result<JwtHmacVerifyResponse, AppError> {
    registry.ensure_not_shutting_down()?;
    verify_jwt_hmac_token(&req)
}

#[tauri::command]
async fn inspect_unicode_text(
    registry: State<'_, TaskRegistry>,
    text: String,
    options: UnicodeSanitizeOptions,
) -> Result<UnicodeInspectionResponse, AppError> {
    registry.ensure_not_shutting_down()?;
    tauri::async_runtime::spawn_blocking(move || inspect_and_sanitize_unicode(&text, &options))
        .await
        .map_err(|_| {
            AppError::new(
                "INTERNAL_JOIN_ERROR",
                "Background Unicode inspector failed.",
            )
        })?
}

#[tauri::command]
async fn inspect_beautifier_image(
    registry: State<'_, TaskRegistry>,
    path: String,
) -> Result<SourceImageInspection, AppError> {
    registry.ensure_not_shutting_down()?;
    tauri::async_runtime::spawn_blocking(move || inspect_source_image(&path))
        .await
        .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Background image inspector failed."))?
}

#[tauri::command]
async fn export_beautified_png<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    params: BeautifyExportParams,
) -> Result<BeautifyExportResult, AppError> {
    let task_id = next_internal_task_id("export-i03");
    let guard = registry.register_checked(&task_id, "I03", false)?;
    tauri::async_runtime::spawn_blocking(move || {
        execute_beautifier_export_with_guard(guard, &params, |payload| {
            let _ = app.emit(TASK_PROGRESS_EVENT, payload);
        })
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Background PNG exporter failed."))?
}

#[tauri::command]
async fn inspect_batch_rename_sources(
    registry: State<'_, TaskRegistry>,
    paths: Vec<String>,
) -> Result<BatchRenameInspectResponse, AppError> {
    registry.ensure_not_shutting_down()?;
    tauri::async_runtime::spawn_blocking(move || inspect_sources_impl(&paths))
        .await
        .map_err(|_| {
            AppError::new(
                "INTERNAL_JOIN_ERROR",
                "Background batch rename source inspector failed.",
            )
        })?
}

#[tauri::command]
async fn execute_batch_rename<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    rename_state: State<'_, BatchRenameState>,
    operations: Vec<RenamePairInput>,
    current_paths: Vec<String>,
) -> Result<BatchRenameExecuteResponse, AppError> {
    let task_id = next_internal_task_id("rename-f02");
    let guard = registry.register_checked(&task_id, "F02", false)?;
    let state_clone = rename_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let tid = guard.task_id().to_string();
        let tool = guard.tool_id().to_string();
        let total = Some(operations.len() as u64);
        let _ = app.emit(
            TASK_PROGRESS_EVENT,
            TaskProgressPayload::running(&tid, &tool, total),
        );
        let res = execute_batch_rename_impl(&state_clone, &operations, &current_paths);
        drop(guard);
        match &res {
            Ok(done) => {
                let n = done.renamed_count as u64;
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::completed(&tid, &tool, n, Some(n)),
                );
            }
            Err(err) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::failed_or_cancelled(&tid, &tool, 0, total, err),
                );
            }
        }
        res
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Background batch renamer failed."))?
}

#[tauri::command]
async fn undo_last_batch_rename<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    rename_state: State<'_, BatchRenameState>,
    current_paths: Vec<String>,
) -> Result<BatchRenameExecuteResponse, AppError> {
    let task_id = next_internal_task_id("undo-f02");
    let guard = registry.register_checked(&task_id, "F02", false)?;
    let state_clone = rename_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let tid = guard.task_id().to_string();
        let tool = guard.tool_id().to_string();
        let _ = app.emit(
            TASK_PROGRESS_EVENT,
            TaskProgressPayload::running(&tid, &tool, None),
        );
        let res = undo_last_batch_rename_impl(&state_clone, &current_paths);
        drop(guard);
        match &res {
            Ok(done) => {
                let n = done.renamed_count as u64;
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::completed(&tid, &tool, n, Some(n)),
                );
            }
            Err(err) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::failed_or_cancelled(&tid, &tool, 0, None, err),
                );
            }
        }
        res
    })
    .await
    .map_err(|_| {
        AppError::new(
            "INTERNAL_JOIN_ERROR",
            "Background batch rename undo failed.",
        )
    })?
}

#[tauri::command]
fn get_batch_rename_undo_status(
    rename_state: State<'_, BatchRenameState>,
) -> BatchRenameUndoStatus {
    rename_state.status()
}

#[tauri::command]
fn cancel_task(registry: State<'_, TaskRegistry>, task_id: String) -> bool {
    registry.cancel(&task_id)
}

#[tauri::command]
fn get_running_task_count(registry: State<'_, TaskRegistry>) -> usize {
    registry.running_count()
}

#[tauri::command]
fn get_task_snapshot(registry: State<'_, TaskRegistry>) -> TaskRegistrySnapshot {
    registry.snapshot()
}

#[tauri::command]
fn request_window_close(registry: State<'_, TaskRegistry>) -> CloseRequestDecision {
    registry.evaluate_close_request()
}

#[tauri::command]
async fn begin_graceful_shutdown(
    registry: State<'_, TaskRegistry>,
    timeout_ms: Option<u64>,
) -> Result<ShutdownDrainResult, AppError> {
    let reg = registry.inner().clone();
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(8_000).clamp(100, 30_000));
    tauri::async_runtime::spawn_blocking(move || reg.begin_shutdown_and_drain(timeout))
        .await
        .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Shutdown coordinator failed."))
}

#[tauri::command]
fn abort_graceful_shutdown(registry: State<'_, TaskRegistry>) {
    registry.abort_shutdown();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(TaskRegistry::default())
        .manage(BatchRenameState::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_runtime_info,
            read_clipboard_text,
            write_clipboard_text,
            read_text_file,
            read_diff_text_file,
            read_tabular_text_file,
            read_coord_batch_text_file,
            save_text_file,
            suggest_output_path,
            hash_text_multi,
            hash_file_multi,
            hash_files_batch,
            codec_transform_text,
            codec_transform_file,
            codec_get_full_text,
            codec_save_output,
            generate_uuids,
            inspect_uuid,
            generate_secrets,
            verify_jwt_hmac,
            inspect_unicode_text,
            qr::qr_read_image_file,
            qr::qr_read_clipboard_image,
            qr::qr_copy_image,
            qr::qr_copy_text,
            qr::qr_save_image,
            qr::qr_open_http_url,
            inspect_batch_rename_sources,
            execute_batch_rename,
            undo_last_batch_rename,
            get_batch_rename_undo_status,
            inspect_beautifier_image,
            export_beautified_png,
            cancel_task,
            get_running_task_count,
            get_task_snapshot,
            request_window_close,
            begin_graceful_shutdown,
            abort_graceful_shutdown
        ])
        .run(tauri::generate_context!())
        .expect("error while running WinKit application");
}

#[cfg(test)]
mod tests {
    use super::{
        execute_codec_save_with_guard, execute_save_text_with_guard, get_runtime_info,
        prepare_save_text_task,
    };
    use crate::codec::{Base64WrapWidth, CodecFormat, CodecOperation, CodecOptions};
    use crate::hasher::{execute_file_hash_task, HashAlgorithm};
    use crate::tasks::{TaskLifecycleState, TaskProgressPayload, TaskRegistry};
    use std::fs;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;
    use tempfile::tempdir;

    #[test]
    fn runtime_info_returns_winkit_identity() {
        let info = get_runtime_info();
        assert_eq!(info.name, "WinKit");
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn rejected_save_after_idle_close_creates_zero_files_while_admitted_save_completes_and_releases_handle(
    ) {
        let dir = tempdir().expect("tempdir");
        let admitted_out = dir.path().join("admitted_result.json");
        let reg = TaskRegistry::default();

        // 1. Pre-queue admission happens synchronously before worker starts
        let guard = prepare_save_text_task(&reg, Some("D01")).expect("admitted before close");
        let (worker_ready_tx, worker_ready_rx) = mpsc::channel::<()>();
        let (worker_go_tx, worker_go_rx) = mpsc::channel::<()>();

        let admitted_out_str = admitted_out.to_string_lossy().into_owned();
        let worker = thread::spawn(move || {
            worker_ready_tx.send(()).expect("ready");
            worker_go_rx.recv().expect("go");
            let mut events = Vec::new();
            let saved = execute_save_text_with_guard(
                guard,
                &admitted_out_str,
                None,
                r#"{"admitted":true}"#,
                false,
                |ev| events.push(ev.clone()),
            )
            .expect("admitted write succeeds");
            (saved, events)
        });

        worker_ready_rx.recv().expect("worker parked before write");

        // Close check sees queued task -> does NOT allow immediate close and does NOT cancel task
        let decision = reg.evaluate_close_request();
        assert!(!decision.immediate_close_allowed);
        assert_eq!(decision.snapshot.active_count, 1);

        // User confirms exit -> drain waits until worker commits file and drops guard
        let reg_drain = reg.clone();
        let drain_thread =
            thread::spawn(move || reg_drain.begin_shutdown_and_drain(Duration::from_secs(2)));

        worker_go_tx.send(()).expect("allow worker write");
        let (saved, events) = worker.join().expect("worker finished");
        let drain = drain_thread.join().expect("drain finished");
        assert!(drain.ready_to_close);
        assert_eq!(saved.byte_length, 17);
        assert_eq!(events.last().map(|e| e.percent), Some(Some(100.0)));

        // Verify exclusive lock (share_mode(0) on Windows) succeeds immediately after drain
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let exclusive = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .share_mode(0)
                .open(&admitted_out)
                .expect("file handle must be fully released after drain");
            drop(exclusive);
        }

        // 2. Now registry is in shutting_down == true state; a new save request must be rejected
        // BEFORE creating any target or temporary files in a clean directory.
        let clean_sub = dir.path().join("clean_after_shutdown");
        fs::create_dir_all(&clean_sub).expect("mkdir clean_sub");
        let rejected_res = prepare_save_text_task(&reg, Some("D01"));
        assert_eq!(
            rejected_res.err().map(|e| e.code),
            Some("APP_SHUTTING_DOWN")
        );
        let remaining_entries: Vec<_> = fs::read_dir(&clean_sub).expect("read_dir").collect();
        assert!(
            remaining_entries.is_empty(),
            "rejected task must not create output or .tmp files"
        );
    }

    #[test]
    fn terminal_progress_events_accurately_distinguish_completed_error_and_cancelled() {
        let dir = tempdir().expect("tempdir");
        let reg = TaskRegistry::default();
        let secret_like_content = "PRIVATE_PAYLOAD_DO_NOT_LEAK_12345";

        // 1. Success -> state == Completed, percent == Some(100.0), exact byte count, no error fields
        let out_ok = dir.path().join("ok.txt");
        let guard_ok = prepare_save_text_task(&reg, Some("D01")).expect("guard ok");
        let mut ok_events: Vec<TaskProgressPayload> = Vec::new();
        execute_save_text_with_guard(
            guard_ok,
            &out_ok.to_string_lossy(),
            None,
            secret_like_content,
            false,
            |ev| ok_events.push(ev.clone()),
        )
        .expect("save ok");
        let final_ok = ok_events.last().expect("final ok event");
        assert_eq!(final_ok.state, TaskLifecycleState::Completed);
        assert_eq!(final_ok.percent, Some(100.0));
        assert_eq!(final_ok.processed_bytes, secret_like_content.len() as u64);
        assert_eq!(final_ok.error_code, None);
        assert_eq!(final_ok.error_message, None);

        // 2. Error (TARGET_ALREADY_EXISTS with overwrite=false) -> percent is None (NOT 100%),
        // processed_bytes is 0 (NOT content.len()), real error_code & sanitized error_message
        let guard_err = prepare_save_text_task(&reg, Some("D01")).expect("guard err");
        let mut err_events: Vec<TaskProgressPayload> = Vec::new();
        let err_res = execute_save_text_with_guard(
            guard_err,
            &out_ok.to_string_lossy(),
            None,
            secret_like_content,
            false,
            |ev| err_events.push(ev.clone()),
        );
        assert!(err_res.is_err());
        let final_err = err_events.last().expect("final err event");
        assert_eq!(final_err.state, TaskLifecycleState::Error);
        assert_eq!(final_err.percent, None);
        assert_eq!(final_err.processed_bytes, 0);
        assert_eq!(
            final_err.error_code.as_deref(),
            Some("TARGET_ALREADY_EXISTS")
        );
        let msg = final_err
            .error_message
            .as_deref()
            .expect("error_message populated");
        assert!(!msg.is_empty());
        assert!(!msg.contains(secret_like_content));

        // Also verify D02 codec_save_output error event does not emit 100%
        let d02_guard = reg.register_checked("d02-err", "D02", false).expect("d02");
        let mut d02_events = Vec::new();
        let bad_opts = CodecOptions {
            format: CodecFormat::Hex,
            operation: CodecOperation::Decode,
            padding: true,
            wrap: Base64WrapWidth::None,
            ignore_whitespace: true,
            uppercase_hex: false,
            group_bits: false,
        };
        let d02_res = execute_codec_save_with_guard(
            d02_guard,
            Some("ZZ_NOT_HEX"),
            None,
            &dir.path().join("d02_out.bin").to_string_lossy(),
            false,
            &bad_opts,
            |ev| d02_events.push(ev.clone()),
        );
        assert!(d02_res.is_err());
        let final_d02 = d02_events.last().expect("d02 terminal event");
        assert_eq!(final_d02.state, TaskLifecycleState::Error);
        assert_eq!(final_d02.percent, None);
        assert_eq!(final_d02.error_code.as_deref(), Some("DECODE_FAILED"));

        // 3. Cancelled mid-stream file hash -> preserves actual known processed_bytes (< total),
        // never fabricates 100%, and populates TASK_CANCELLED code & message
        let hash_file = dir.path().join("cancel_mid.bin");
        fs::write(&hash_file, vec![0x42u8; 1024 * 1024]).expect("write 1MiB");
        let mut hash_events = Vec::new();
        let hash_err = execute_file_hash_task(
            &reg,
            "hash-cancel-mid",
            &hash_file.to_string_lossy(),
            &[HashAlgorithm::Sha256],
            |ev| {
                if ev.state == TaskLifecycleState::Running && ev.processed_bytes == 0 {
                    // Cancel right after initial 0-byte Running event -> stops before/at first chunk
                    reg.cancel("hash-cancel-mid");
                }
                hash_events.push(ev.clone());
            },
        )
        .unwrap_err();
        assert_eq!(hash_err.code, "TASK_CANCELLED");
        let final_cancel = hash_events.last().expect("final cancel event");
        assert_eq!(final_cancel.state, TaskLifecycleState::Cancelled);
        assert_ne!(final_cancel.percent, Some(100.0));
        assert_eq!(final_cancel.error_code.as_deref(), Some("TASK_CANCELLED"));
        assert!(final_cancel.error_message.is_some());
    }
}
