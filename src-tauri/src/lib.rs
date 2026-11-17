pub mod error;
pub mod fs_guard;
pub mod tasks;

use crate::error::AppError;
use crate::fs_guard::{
    read_utf8_text_file_bounded, suggest_safe_output_path, validate_user_path,
    write_output_bytes_safely, SavedFileInfo, TextFilePayload,
};
use crate::tasks::TaskRegistry;
use serde::Serialize;
use tauri::State;

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
async fn save_text_file(
    output_path: String,
    source_path: Option<String>,
    content: String,
    overwrite: bool,
) -> Result<SavedFileInfo, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let src_buf = match source_path {
            Some(ref raw) if !raw.trim().is_empty() => Some(validate_user_path(raw, "Source")?),
            _ => None,
        };
        write_output_bytes_safely(
            &output_path,
            src_buf.as_deref(),
            content.as_bytes(),
            overwrite,
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
fn cancel_task(registry: State<'_, TaskRegistry>, task_id: String) -> bool {
    registry.cancel(&task_id)
}

#[tauri::command]
fn get_running_task_count(registry: State<'_, TaskRegistry>) -> usize {
    registry.running_count()
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
            cancel_task,
            get_running_task_count
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
        assert_eq!(info.version, "0.1.0");
    }
}
