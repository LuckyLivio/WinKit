pub mod beautifier;
pub mod error;
pub mod fs_guard;
pub mod hasher;
pub mod tasks;

use crate::beautifier::{
    export_beautified_png_cancellable, inspect_source_image, BeautifyExportParams,
    BeautifyExportResult, SourceImageInspection,
};
use crate::error::AppError;
use crate::fs_guard::{
    read_utf8_text_file_bounded, suggest_safe_output_path, validate_user_path,
    write_output_bytes_cancellable, SavedFileInfo, TextFilePayload,
};
use crate::hasher::{compute_text_sha256, execute_file_hash_task, FileHashResult, TextHashResult};
use crate::tasks::{
    ShutdownDrainResult, TaskLifecycleState, TaskProgressPayload, TaskRegistry,
    TaskRegistrySnapshot, TASK_PROGRESS_EVENT,
};
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime, State};

static INTERNAL_WRITE_SEQ: AtomicU64 = AtomicU64::new(1);

fn next_internal_task_id(prefix: &str) -> String {
    let seq = INTERNAL_WRITE_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{seq}")
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
async fn read_text_file(path: String) -> Result<TextFilePayload, AppError> {
    tauri::async_runtime::spawn_blocking(move || read_utf8_text_file_bounded(&path))
        .await
        .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Background file reader failed."))?
}

#[tauri::command]
async fn save_text_file<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    output_path: String,
    source_path: Option<String>,
    content: String,
    overwrite: bool,
) -> Result<SavedFileInfo, AppError> {
    let reg = registry.inner().clone();
    let task_id = next_internal_task_id("save-text");
    tauri::async_runtime::spawn_blocking(move || {
        let guard = reg.register_checked(&task_id, "D01", false)?;
        let _ = app.emit(
            TASK_PROGRESS_EVENT,
            &TaskProgressPayload {
                task_id: task_id.clone(),
                tool_id: "D01".to_string(),
                state: TaskLifecycleState::Running,
                processed_bytes: 0,
                total_bytes: Some(content.len() as u64),
                percent: None,
                error_code: None,
                error_message: None,
            },
        );
        let cancel_flag = guard.cancel_flag();
        let res = (|| {
            let src_buf = match source_path {
                Some(ref raw) if !raw.trim().is_empty() => Some(validate_user_path(raw, "Source")?),
                _ => None,
            };
            write_output_bytes_cancellable(
                &output_path,
                src_buf.as_deref(),
                content.as_bytes(),
                overwrite,
                Some(&cancel_flag),
            )
        })();
        let end_state = match &res {
            Ok(_) => TaskLifecycleState::Completed,
            Err(e) if e.code == "TASK_CANCELLED" => TaskLifecycleState::Cancelled,
            Err(_) => TaskLifecycleState::Error,
        };
        drop(guard);
        let _ = app.emit(
            TASK_PROGRESS_EVENT,
            &TaskProgressPayload {
                task_id,
                tool_id: "D01".to_string(),
                state: end_state,
                processed_bytes: content.len() as u64,
                total_bytes: Some(content.len() as u64),
                percent: Some(100.0),
                error_code: None,
                error_message: None,
            },
        );
        res
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
fn hash_text_sha256(text: String) -> TextHashResult {
    compute_text_sha256(&text)
}

#[tauri::command]
async fn hash_file_sha256<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    task_id: String,
    path: String,
) -> Result<FileHashResult, AppError> {
    let reg = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        execute_file_hash_task(&reg, &task_id, &path, |payload| {
            let _ = app.emit(TASK_PROGRESS_EVENT, payload);
        })
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Background hash worker failed."))?
}

#[tauri::command]
async fn inspect_beautifier_image(path: String) -> Result<SourceImageInspection, AppError> {
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
    let reg = registry.inner().clone();
    let task_id = next_internal_task_id("export-i03");
    tauri::async_runtime::spawn_blocking(move || {
        let guard = reg.register_checked(&task_id, "I03", false)?;
        let _ = app.emit(
            TASK_PROGRESS_EVENT,
            &TaskProgressPayload {
                task_id: task_id.clone(),
                tool_id: "I03".to_string(),
                state: TaskLifecycleState::Running,
                processed_bytes: 0,
                total_bytes: None,
                percent: None,
                error_code: None,
                error_message: None,
            },
        );
        let cancel_flag = guard.cancel_flag();
        let res = export_beautified_png_cancellable(&params, Some(&cancel_flag));
        let end_state = match &res {
            Ok(_) => TaskLifecycleState::Completed,
            Err(e) if e.code == "TASK_CANCELLED" => TaskLifecycleState::Cancelled,
            Err(_) => TaskLifecycleState::Error,
        };
        drop(guard);
        let _ = app.emit(
            TASK_PROGRESS_EVENT,
            &TaskProgressPayload {
                task_id,
                tool_id: "I03".to_string(),
                state: end_state,
                processed_bytes: 0,
                total_bytes: None,
                percent: Some(100.0),
                error_code: None,
                error_message: None,
            },
        );
        res
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Background PNG exporter failed."))?
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
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_runtime_info,
            read_text_file,
            save_text_file,
            suggest_output_path,
            hash_text_sha256,
            hash_file_sha256,
            inspect_beautifier_image,
            export_beautified_png,
            cancel_task,
            get_running_task_count,
            get_task_snapshot,
            begin_graceful_shutdown,
            abort_graceful_shutdown
        ])
        .run(tauri::generate_context!())
        .expect("error while running WinKit application");
}

#[cfg(test)]
mod tests {
    use super::get_runtime_info;

    #[test]
    fn runtime_info_returns_winkit_identity() {
        let info = get_runtime_info();
        assert_eq!(info.name, "WinKit");
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
    }
}
