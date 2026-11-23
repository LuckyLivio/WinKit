pub mod archive;
pub mod audio_cleanup;
pub mod audio_convert;
pub mod audio_trim;
pub mod batch_rename;
pub mod beautifier;
pub mod codec;
pub mod color_picker;
pub mod error;
pub mod face_detect;
pub mod find_duplicates;
pub mod fs_guard;
pub mod hasher;
pub mod image_assets;
pub mod image_core;
pub mod image_metadata;
pub mod image_redact;
pub mod image_transform;
pub mod image_watermark;
pub mod iso_reader;
pub mod jwt;
pub mod media_compress;
pub mod media_convert;
pub mod media_core;
pub mod media_crop;
pub mod media_extract_audio;
pub mod media_frames;
pub mod media_gif;
pub mod media_info;
pub mod media_merge;
pub mod media_mute;
pub mod media_resize;
pub mod media_speed;
pub mod media_trim;
pub mod organize_downloads;
pub mod password_gen;
mod qr;
pub mod screen_capture;
pub mod tasks;
pub mod unicode_inspector;
pub mod uuid_tool;
pub mod video_replace_audio;
pub mod wic_heic;

use crate::archive::{
    create_archive_impl, extract_archives_batch_with_limit, inspect_archive_impl,
    open_local_directory_impl, ArchivePreviewResponse, CreateArchiveRequest, CreateArchiveResponse,
    ExtractArchivesBatchResponse, ExtractArchivesRequest, ARCHIVE_PROGRESS_EVENT,
    DEFAULT_MAX_EXTRACT_BYTES_PER_ARCHIVE,
};
use crate::audio_cleanup::{
    clean_up_audio_impl, preview_audio_cleanup_impl, CleanUpAudioRequest, CleanUpAudioResult,
    PreviewAudioCleanupRequest, PreviewAudioCleanupResult,
};
use crate::audio_convert::{
    convert_audio_batch_impl, ConvertAudioBatchRequest, ConvertAudioBatchResponse,
};
use crate::audio_trim::{
    extract_audio_waveform_impl, trim_audio_file_impl, AudioWaveformPayload, TrimAudioRequest,
    TrimAudioResult,
};
use crate::batch_rename::{
    execute_batch_rename_impl, inspect_sources_impl, undo_last_batch_rename_impl,
    BatchRenameExecuteResponse, BatchRenameInspectResponse, BatchRenameState,
    BatchRenameUndoStatus, RenamePairInput,
};
use crate::beautifier::{
    beautify_images_batch_impl, export_beautified_png_with_store, inspect_source_image,
    render_beautified_to_asset_impl, BeautifyBatchRequest, BeautifyExportParams,
    BeautifyExportResult, BeautifyRenderAssetRequest, SourceImageInspection,
};
use crate::codec::{
    compute_full_utf8_result, export_codec_result_to_file, transform_file_payload,
    transform_text_payload, CodecOptions, CodecTransformResponse,
};
use crate::color_picker::{
    extract_image_palette_impl, pick_screen_color_impl, sample_screen_pixel_at_impl,
    ExtractImagePaletteRequest, ImagePaletteResult, PickScreenColorRequest,
    SampleScreenPixelRequest, ScreenColorSample,
};
use crate::error::AppError;
use crate::face_detect::{
    blur_faces_batch_impl, detect_faces_in_asset_impl, detect_faces_in_file_impl,
    BlurFacesBatchRequest, DetectFacesAssetRequest, DetectFacesFileRequest, FaceDetectionResult,
};
use crate::find_duplicates::{
    recycle_duplicate_groups_impl, scan_duplicates_impl, DuplicateRecycleResponse,
    DuplicateScanOptions, DuplicateScanResult, RecycleGroupPlan, DUPLICATES_SCAN_PROGRESS_EVENT,
};
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
use crate::image_assets::{
    copy_png_to_system_clipboard, decode_png_data_url_or_base64, load_local_image_into_store,
    read_system_clipboard_image_into_store, save_png_bytes_to_disk, ImageAssetPayload,
    ImageAssetStore, SaveAssetFormat, SavedImageAssetResult,
};
use crate::image_core::{
    compress_images_batch_impl, convert_images_batch_impl, inspect_batch_images_impl,
    preview_compress_image_impl, preview_convert_image_impl, BatchImageJobResponse,
    CompressImagesBatchRequest, ConvertImagesBatchRequest, InspectBatchImagesResponse,
    PreviewCompressImageRequest, PreviewCompressImageResponse, PreviewConvertImageRequest,
    PreviewConvertImageResponse, IMAGE_BATCH_PROGRESS_EVENT,
};
use crate::image_metadata::{strip_images_metadata_batch_impl, StripMetadataBatchRequest};
use crate::image_redact::{
    apply_image_redactions_to_asset_impl, export_redacted_image_file_impl,
    ApplyRedactionsAssetRequest, ExportRedactedImageRequest, ExportRedactedImageResult,
};
use crate::image_transform::{
    preview_rotate_image_impl, resize_images_batch_impl, rotate_images_batch_impl,
    PreviewRotateImageRequest, PreviewRotateImageResponse, ResizeImagesBatchRequest,
    RotateImagesBatchRequest,
};
use crate::image_watermark::{
    render_watermarked_asset_impl, watermark_images_batch_impl, RenderWatermarkedAssetRequest,
    WatermarkImagesBatchRequest,
};
use crate::jwt::{verify_jwt_hmac_token, JwtHmacVerifyRequest, JwtHmacVerifyResponse};
use crate::media_compress::{
    compress_videos_batch_impl, probe_video_encoders_impl, CompressVideosBatchRequest,
    CompressVideosBatchResponse, VideoEncoderCapabilities,
};
use crate::media_convert::{
    convert_videos_batch_impl, inspect_video_convert_plan_impl, ConvertVideosBatchRequest,
    ConvertVideosBatchResponse, InspectVideoConvertPlanRequest, InspectVideoConvertPlanResponse,
};
use crate::media_core::{
    extract_media_poster_data_url_impl, get_media_tools_status_impl, handle_winkit_media_protocol,
    install_managed_media_tools_impl, resolve_media_data_root, set_media_tools_custom_dir_impl,
    MediaPreviewRegistration, MediaPreviewRegistry, MediaToolsStatus, MEDIA_SETUP_PROGRESS_EVENT,
    MEDIA_TASK_PROGRESS_EVENT,
};
use crate::media_crop::{
    crop_rotate_video_impl, extract_oriented_preview_frame_impl, CropRotateVideoRequest,
    CropRotateVideoResult, OrientedPreviewFrame,
};
use crate::media_extract_audio::{
    extract_audio_batch_impl, preview_audio_track_impl, AudioTrackPreviewResult,
    ExtractAudioBatchRequest, ExtractAudioBatchResponse,
};
use crate::media_frames::{extract_video_frames_impl, ExtractFramesRequest, ExtractFramesResponse};
use crate::media_gif::{
    convert_video_to_gif_impl, ConvertVideoToGifRequest, ConvertVideoToGifResult,
};
use crate::media_info::{probe_media_info_impl, MediaProbeReport};
use crate::media_merge::{merge_videos_impl, MergeVideosRequest, MergeVideosResult};
use crate::media_mute::{mute_videos_batch_impl, MuteVideosBatchRequest, MuteVideosBatchResponse};
use crate::media_resize::{
    resize_videos_batch_impl, ResizeVideosBatchRequest, ResizeVideosBatchResponse,
};
use crate::media_speed::{
    change_video_speed_batch_impl, ChangeVideoSpeedBatchRequest, ChangeVideoSpeedBatchResponse,
};
use crate::media_trim::{
    analyze_trim_keyframes_impl, trim_video_file_impl, TrimKeyframeAnalysis,
    TrimKeyframeAnalysisRequest, TrimVideoRequest, TrimVideoResult,
};
use crate::organize_downloads::{
    execute_organize_downloads_impl, preview_organize_downloads_impl, OrganizeExecuteRequest,
    OrganizeExecuteResponse, OrganizePreviewRequest, OrganizePreviewResponse,
};
use crate::password_gen::{generate_secrets_with_os_rng, SecretGenRequest, SecretGenResponse};
use crate::screen_capture::{
    capture_monitor_impl, capture_region_impl, capture_scroll_impl, capture_window_impl,
    list_capture_monitors_impl, list_capture_windows_impl, CaptureMonitorInfo,
    CaptureMonitorRequest, CaptureRegionRequest, CaptureResultPayload, CaptureScrollRequest,
    CaptureWindowInfo, CaptureWindowRequest, CAPTURE_PROGRESS_EVENT,
};
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
use crate::video_replace_audio::{
    preview_replace_audio_impl, replace_video_audio_impl, PreviewReplaceAudioRequest,
    PreviewReplaceAudioResult, ReplaceAudioRequest, ReplaceAudioResult,
};
use crate::wic_heic::{get_heic_capabilities, HeicCapabilities};
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

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
    store: Option<&ImageAssetStore>,
    mut on_event: E,
) -> Result<BeautifyExportResult, AppError>
where
    E: FnMut(&TaskProgressPayload),
{
    let task_id = guard.task_id().to_string();
    let tool_id = guard.tool_id().to_string();
    on_event(&TaskProgressPayload::running(&task_id, &tool_id, None));

    let cancel_flag = guard.cancel_flag();
    let res = export_beautified_png_with_store(params, store, Some(&cancel_flag));
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
    asset_store: State<'_, ImageAssetStore>,
    params: BeautifyExportParams,
) -> Result<BeautifyExportResult, AppError> {
    let task_id = next_internal_task_id("export-i03");
    let guard = registry.register_checked(&task_id, "I03", false)?;
    let store = asset_store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        execute_beautifier_export_with_guard(guard, &params, Some(&store), |payload| {
            let _ = app.emit(TASK_PROGRESS_EVENT, payload);
        })
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Background PNG exporter failed."))?
}

#[tauri::command]
async fn render_beautified_asset(
    registry: State<'_, TaskRegistry>,
    asset_store: State<'_, ImageAssetStore>,
    req: BeautifyRenderAssetRequest,
) -> Result<ImageAssetPayload, AppError> {
    registry.ensure_not_shutting_down()?;
    let store = asset_store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || render_beautified_to_asset_impl(&req, &store))
        .await
        .map_err(|_| {
            AppError::new(
                "INTERNAL_JOIN_ERROR",
                "Background beautifier renderer failed.",
            )
        })?
}

#[tauri::command]
async fn beautify_images_batch<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    task_id: String,
    req: BeautifyBatchRequest,
) -> Result<BatchImageJobResponse, AppError> {
    let trimmed_id = task_id.trim();
    if trimmed_id.is_empty()
        || trimmed_id.len() > 64
        || !trimmed_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::invalid_param("Invalid beautify batch task ID."));
    }
    let guard = registry.register_checked(trimmed_id, "I03", true)?;
    tauri::async_runtime::spawn_blocking(move || {
        let tid = guard.task_id().to_string();
        let tool = guard.tool_id().to_string();
        let cancel_flag = guard.cancel_flag();
        let _ = app.emit(
            TASK_PROGRESS_EVENT,
            TaskProgressPayload::running(&tid, &tool, None),
        );
        let res = beautify_images_batch_impl(&tid, &req, &cancel_flag, |ev| {
            let _ = app.emit(IMAGE_BATCH_PROGRESS_EVENT, ev);
        });
        drop(guard);
        match &res {
            Ok(done) => {
                if done.cancelled {
                    let err = AppError::cancelled();
                    let _ = app.emit(
                        TASK_PROGRESS_EVENT,
                        TaskProgressPayload::failed_or_cancelled(&tid, &tool, 0, None, &err),
                    );
                } else {
                    let n = done.succeeded_count as u64;
                    let _ = app.emit(
                        TASK_PROGRESS_EVENT,
                        TaskProgressPayload::completed(&tid, &tool, n, Some(n)),
                    );
                }
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
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Batch beautifier worker failed."))?
}

struct MainWindowHideGuard<R: Runtime> {
    app: AppHandle<R>,
    was_hidden: bool,
}

impl<R: Runtime> MainWindowHideGuard<R> {
    fn hide_if(app: &AppHandle<R>, should_hide: bool) -> Self {
        let mut was_hidden = false;
        if should_hide {
            if let Some(win) = app.get_webview_window("main") {
                if win.is_visible().unwrap_or(true) && win.hide().is_ok() {
                    was_hidden = true;
                    std::thread::sleep(Duration::from_millis(140));
                }
            }
        }
        Self {
            app: app.clone(),
            was_hidden,
        }
    }
}

impl<R: Runtime> Drop for MainWindowHideGuard<R> {
    fn drop(&mut self) {
        if self.was_hidden {
            if let Some(win) = self.app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
    }
}

#[tauri::command]
async fn list_capture_monitors(
    registry: State<'_, TaskRegistry>,
) -> Result<Vec<CaptureMonitorInfo>, AppError> {
    registry.ensure_not_shutting_down()?;
    tauri::async_runtime::spawn_blocking(list_capture_monitors_impl)
        .await
        .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Monitor enumeration failed."))
}

#[tauri::command]
async fn list_capture_windows(
    registry: State<'_, TaskRegistry>,
) -> Result<Vec<CaptureWindowInfo>, AppError> {
    registry.ensure_not_shutting_down()?;
    tauri::async_runtime::spawn_blocking(list_capture_windows_impl)
        .await
        .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Window enumeration failed."))
}

#[tauri::command]
async fn capture_screen_region<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    asset_store: State<'_, ImageAssetStore>,
    task_id: String,
    req: CaptureRegionRequest,
) -> Result<CaptureResultPayload, AppError> {
    let trimmed_id = task_id.trim();
    if trimmed_id.is_empty() || trimmed_id.len() > 64 {
        return Err(AppError::invalid_param("Invalid capture task ID."));
    }
    let guard = registry.register_checked(trimmed_id, "I01", true)?;
    let store = asset_store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let tid = guard.task_id().to_string();
        let tool = guard.tool_id().to_string();
        let cancel_flag = guard.cancel_flag();
        let _ = app.emit(
            TASK_PROGRESS_EVENT,
            TaskProgressPayload::running(&tid, &tool, None),
        );
        let hide_guard = MainWindowHideGuard::hide_if(&app, req.hide_main_window.unwrap_or(true));
        let res = capture_region_impl(&tid, &req, &store, &cancel_flag, |ev| {
            let _ = app.emit(CAPTURE_PROGRESS_EVENT, ev);
        });
        drop(hide_guard);
        drop(guard);
        match &res {
            Ok(_) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::completed(&tid, &tool, 1, Some(1)),
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
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Region capture worker failed."))?
}

#[tauri::command]
async fn capture_screen_monitor<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    asset_store: State<'_, ImageAssetStore>,
    task_id: String,
    req: CaptureMonitorRequest,
) -> Result<CaptureResultPayload, AppError> {
    let trimmed_id = task_id.trim();
    if trimmed_id.is_empty() || trimmed_id.len() > 64 {
        return Err(AppError::invalid_param("Invalid capture task ID."));
    }
    let guard = registry.register_checked(trimmed_id, "I01", true)?;
    let store = asset_store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let tid = guard.task_id().to_string();
        let tool = guard.tool_id().to_string();
        let cancel_flag = guard.cancel_flag();
        let _ = app.emit(
            TASK_PROGRESS_EVENT,
            TaskProgressPayload::running(&tid, &tool, None),
        );
        let hide_guard = MainWindowHideGuard::hide_if(&app, req.hide_main_window.unwrap_or(true));
        let res = capture_monitor_impl(&tid, &req, &store, &cancel_flag, |ev| {
            let _ = app.emit(CAPTURE_PROGRESS_EVENT, ev);
        });
        drop(hide_guard);
        drop(guard);
        match &res {
            Ok(_) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::completed(&tid, &tool, 1, Some(1)),
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
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Monitor capture worker failed."))?
}

#[tauri::command]
async fn capture_screen_window<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    asset_store: State<'_, ImageAssetStore>,
    task_id: String,
    req: CaptureWindowRequest,
) -> Result<CaptureResultPayload, AppError> {
    let trimmed_id = task_id.trim();
    if trimmed_id.is_empty() || trimmed_id.len() > 64 {
        return Err(AppError::invalid_param("Invalid capture task ID."));
    }
    let guard = registry.register_checked(trimmed_id, "I01", true)?;
    let store = asset_store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let tid = guard.task_id().to_string();
        let tool = guard.tool_id().to_string();
        let cancel_flag = guard.cancel_flag();
        let _ = app.emit(
            TASK_PROGRESS_EVENT,
            TaskProgressPayload::running(&tid, &tool, None),
        );
        let hide_guard = MainWindowHideGuard::hide_if(&app, req.hide_main_window.unwrap_or(true));
        let res = capture_window_impl(&tid, &req, &store, &cancel_flag, |ev| {
            let _ = app.emit(CAPTURE_PROGRESS_EVENT, ev);
        });
        drop(hide_guard);
        drop(guard);
        match &res {
            Ok(_) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::completed(&tid, &tool, 1, Some(1)),
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
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Window capture worker failed."))?
}

#[tauri::command]
async fn capture_screen_scroll<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    asset_store: State<'_, ImageAssetStore>,
    task_id: String,
    req: CaptureScrollRequest,
) -> Result<CaptureResultPayload, AppError> {
    let trimmed_id = task_id.trim();
    if trimmed_id.is_empty() || trimmed_id.len() > 64 {
        return Err(AppError::invalid_param("Invalid scroll capture task ID."));
    }
    let guard = registry.register_checked(trimmed_id, "I01", true)?;
    let store = asset_store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let tid = guard.task_id().to_string();
        let tool = guard.tool_id().to_string();
        let cancel_flag = guard.cancel_flag();
        let _ = app.emit(
            TASK_PROGRESS_EVENT,
            TaskProgressPayload::running(&tid, &tool, None),
        );
        let hide_guard = MainWindowHideGuard::hide_if(&app, req.hide_main_window.unwrap_or(true));
        let res = capture_scroll_impl(&tid, &req, &store, &cancel_flag, |ev| {
            let _ = app.emit(CAPTURE_PROGRESS_EVENT, ev);
        });
        drop(hide_guard);
        drop(guard);
        match &res {
            Ok(done) => {
                let n = done.frame_count as u64;
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
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Scrolling capture worker failed."))?
}

#[tauri::command]
async fn store_png_asset(
    registry: State<'_, TaskRegistry>,
    asset_store: State<'_, ImageAssetStore>,
    data_url: String,
    label: String,
) -> Result<ImageAssetPayload, AppError> {
    registry.ensure_not_shutting_down()?;
    let store = asset_store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = decode_png_data_url_or_base64(&data_url)?;
        store.insert_png_bytes(bytes, label)
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Image asset storage failed."))?
}

#[tauri::command]
async fn load_file_as_image_asset(
    registry: State<'_, TaskRegistry>,
    asset_store: State<'_, ImageAssetStore>,
    path: String,
) -> Result<ImageAssetPayload, AppError> {
    registry.ensure_not_shutting_down()?;
    let store = asset_store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || load_local_image_into_store(&store, &path))
        .await
        .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Image file loader failed."))?
}

#[tauri::command]
async fn get_image_asset(
    registry: State<'_, TaskRegistry>,
    asset_store: State<'_, ImageAssetStore>,
    asset_id: String,
) -> Result<ImageAssetPayload, AppError> {
    registry.ensure_not_shutting_down()?;
    let store = asset_store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.get_payload(&asset_id))
        .await
        .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Image asset lookup failed."))?
}

#[tauri::command]
async fn copy_image_asset_to_clipboard(
    registry: State<'_, TaskRegistry>,
    asset_store: State<'_, ImageAssetStore>,
    asset_id: Option<String>,
    data_url: Option<String>,
) -> Result<(), AppError> {
    let guard = registry.register_checked(&next_internal_task_id("img-copy"), "I01", false)?;
    let store = asset_store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let bytes = if let Some(aid) = asset_id.as_deref().map(str::trim).filter(|s| !s.is_empty())
        {
            store.get_png_bytes(aid)?.0
        } else if let Some(du) = data_url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            decode_png_data_url_or_base64(du)?
        } else {
            return Err(AppError::invalid_param("Missing image payload to copy."));
        };
        copy_png_to_system_clipboard(&bytes)
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Clipboard image copy failed."))?
}

#[tauri::command]
async fn read_clipboard_image_as_asset(
    registry: State<'_, TaskRegistry>,
    asset_store: State<'_, ImageAssetStore>,
) -> Result<ImageAssetPayload, AppError> {
    registry.ensure_not_shutting_down()?;
    let store = asset_store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || read_system_clipboard_image_into_store(&store))
        .await
        .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Clipboard image read failed."))?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn save_image_asset_file<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    asset_store: State<'_, ImageAssetStore>,
    asset_id: Option<String>,
    data_url: Option<String>,
    output_path: String,
    format: SaveAssetFormat,
    jpeg_quality: Option<u8>,
    overwrite: bool,
    tool_id: Option<String>,
) -> Result<SavedImageAssetResult, AppError> {
    let resolved_tool = sanitize_tool_id(tool_id.as_deref(), "I01")?;
    let task_id = next_internal_task_id("save-img");
    let guard = registry.register_checked(&task_id, &resolved_tool, false)?;
    let store = asset_store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let tid = guard.task_id().to_string();
        let tool = guard.tool_id().to_string();
        let cancel_flag = guard.cancel_flag();
        let _ = app.emit(
            TASK_PROGRESS_EVENT,
            TaskProgressPayload::running(&tid, &tool, None),
        );
        let res = (|| {
            let bytes = if let Some(aid) =
                asset_id.as_deref().map(str::trim).filter(|s| !s.is_empty())
            {
                store.get_png_bytes(aid)?.0
            } else if let Some(du) = data_url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                decode_png_data_url_or_base64(du)?
            } else {
                return Err(AppError::invalid_param("Missing image payload to save."));
            };
            save_png_bytes_to_disk(
                &bytes,
                &output_path,
                None,
                format,
                jpeg_quality.unwrap_or(92),
                overwrite,
                Some(&cancel_flag),
            )
        })();
        drop(guard);
        match &res {
            Ok(saved) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::completed(
                        &tid,
                        &tool,
                        saved.byte_length,
                        Some(saved.byte_length),
                    ),
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
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Image file save failed."))?
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
async fn scan_duplicate_folders<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    task_id: String,
    options: DuplicateScanOptions,
) -> Result<DuplicateScanResult, AppError> {
    let trimmed_id = task_id.trim();
    if trimmed_id.is_empty()
        || trimmed_id.len() > 64
        || !trimmed_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::invalid_param("Invalid duplicate scan task ID."));
    }
    let owned_id = trimmed_id.to_string();
    let guard = registry.register_checked(&owned_id, "F03", true)?;

    tauri::async_runtime::spawn_blocking(move || {
        let tid = guard.task_id().to_string();
        let tool = guard.tool_id().to_string();
        let cancel_flag = guard.cancel_flag();
        let _ = app.emit(
            TASK_PROGRESS_EVENT,
            TaskProgressPayload::running(&tid, &tool, None),
        );

        let res = scan_duplicates_impl(&tid, &options, &cancel_flag, |scan_ev| {
            let _ = app.emit(DUPLICATES_SCAN_PROGRESS_EVENT, scan_ev);
        });

        drop(guard);

        match &res {
            Ok(done) => {
                let n = done.scanned_file_count as u64;
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
            "Background duplicate scanner failed.",
        )
    })?
}

#[tauri::command]
async fn recycle_duplicate_groups<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    plans: Vec<RecycleGroupPlan>,
) -> Result<DuplicateRecycleResponse, AppError> {
    let task_id = next_internal_task_id("recycle-f03");
    let guard = registry.register_checked(&task_id, "F03", false)?;

    tauri::async_runtime::spawn_blocking(move || {
        let tid = guard.task_id().to_string();
        let tool = guard.tool_id().to_string();
        let _ = app.emit(
            TASK_PROGRESS_EVENT,
            TaskProgressPayload::running(&tid, &tool, None),
        );

        let res = recycle_duplicate_groups_impl(&plans);
        drop(guard);

        match &res {
            Ok(done) => {
                let n = done.recycled_count as u64;
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
            "Background duplicate recycle worker failed.",
        )
    })?
}

#[tauri::command]
async fn inspect_archive(
    registry: State<'_, TaskRegistry>,
    path: String,
    password: Option<String>,
) -> Result<ArchivePreviewResponse, AppError> {
    registry.ensure_not_shutting_down()?;
    tauri::async_runtime::spawn_blocking(move || inspect_archive_impl(&path, password.as_deref()))
        .await
        .map_err(|_| {
            AppError::new(
                "INTERNAL_JOIN_ERROR",
                "Background archive preview worker failed.",
            )
        })?
}

#[tauri::command]
async fn extract_archives_batch<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    task_id: String,
    req: ExtractArchivesRequest,
) -> Result<ExtractArchivesBatchResponse, AppError> {
    let trimmed_id = task_id.trim();
    if trimmed_id.is_empty()
        || trimmed_id.len() > 64
        || !trimmed_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::invalid_param(
            "Invalid archive extraction task ID.",
        ));
    }
    let owned_id = trimmed_id.to_string();
    let guard = registry.register_checked(&owned_id, "F04", true)?;

    tauri::async_runtime::spawn_blocking(move || {
        let tid = guard.task_id().to_string();
        let tool = guard.tool_id().to_string();
        let cancel_flag = guard.cancel_flag();
        let _ = app.emit(
            TASK_PROGRESS_EVENT,
            TaskProgressPayload::running(&tid, &tool, None),
        );

        let res = extract_archives_batch_with_limit(
            &tid,
            &req,
            DEFAULT_MAX_EXTRACT_BYTES_PER_ARCHIVE,
            &cancel_flag,
            |ev| {
                let _ = app.emit(ARCHIVE_PROGRESS_EVENT, ev);
            },
        );
        drop(guard);

        match &res {
            Ok(done) => {
                if done.cancelled {
                    let err = AppError::cancelled();
                    let _ = app.emit(
                        TASK_PROGRESS_EVENT,
                        TaskProgressPayload::failed_or_cancelled(&tid, &tool, 0, None, &err),
                    );
                } else {
                    let n = done.succeeded_count as u64;
                    let _ = app.emit(
                        TASK_PROGRESS_EVENT,
                        TaskProgressPayload::completed(&tid, &tool, n, Some(n)),
                    );
                }
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
            "Background archive extractor failed.",
        )
    })?
}

#[tauri::command]
async fn create_archive<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    task_id: String,
    req: CreateArchiveRequest,
) -> Result<CreateArchiveResponse, AppError> {
    let trimmed_id = task_id.trim();
    if trimmed_id.is_empty()
        || trimmed_id.len() > 64
        || !trimmed_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::invalid_param("Invalid archive creation task ID."));
    }
    let owned_id = trimmed_id.to_string();
    let guard = registry.register_checked(&owned_id, "F04", true)?;

    tauri::async_runtime::spawn_blocking(move || {
        let tid = guard.task_id().to_string();
        let tool = guard.tool_id().to_string();
        let cancel_flag = guard.cancel_flag();
        let _ = app.emit(
            TASK_PROGRESS_EVENT,
            TaskProgressPayload::running(&tid, &tool, None),
        );

        let res = create_archive_impl(&tid, &req, &cancel_flag, |ev| {
            let _ = app.emit(ARCHIVE_PROGRESS_EVENT, ev);
        });
        drop(guard);

        match &res {
            Ok(done) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::completed(
                        &tid,
                        &tool,
                        done.output_byte_length,
                        Some(done.output_byte_length),
                    ),
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
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Background archive creator failed."))?
}

#[tauri::command]
fn open_local_directory(registry: State<'_, TaskRegistry>, path: String) -> Result<(), AppError> {
    registry.ensure_not_shutting_down()?;
    open_local_directory_impl(&path)
}

#[tauri::command]
async fn get_image_heic_capabilities(
    registry: State<'_, TaskRegistry>,
) -> Result<HeicCapabilities, AppError> {
    registry.ensure_not_shutting_down()?;
    tauri::async_runtime::spawn_blocking(get_heic_capabilities)
        .await
        .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "HEIC capability probe failed."))
}

#[tauri::command]
async fn inspect_batch_images(
    registry: State<'_, TaskRegistry>,
    paths: Vec<String>,
) -> Result<InspectBatchImagesResponse, AppError> {
    registry.ensure_not_shutting_down()?;
    tauri::async_runtime::spawn_blocking(move || inspect_batch_images_impl(&paths))
        .await
        .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Image inspection worker failed."))
}

#[tauri::command]
async fn preview_convert_image(
    registry: State<'_, TaskRegistry>,
    req: PreviewConvertImageRequest,
) -> Result<PreviewConvertImageResponse, AppError> {
    registry.ensure_not_shutting_down()?;
    tauri::async_runtime::spawn_blocking(move || preview_convert_image_impl(&req))
        .await
        .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Convert preview worker failed."))?
}

#[tauri::command]
async fn convert_images_batch<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    task_id: String,
    req: ConvertImagesBatchRequest,
) -> Result<BatchImageJobResponse, AppError> {
    let trimmed_id = task_id.trim();
    if trimmed_id.is_empty()
        || trimmed_id.len() > 64
        || !trimmed_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::invalid_param("Invalid image convert task ID."));
    }
    let guard = registry.register_checked(trimmed_id, "I05", true)?;
    tauri::async_runtime::spawn_blocking(move || {
        let tid = guard.task_id().to_string();
        let tool = guard.tool_id().to_string();
        let cancel_flag = guard.cancel_flag();
        let _ = app.emit(
            TASK_PROGRESS_EVENT,
            TaskProgressPayload::running(&tid, &tool, None),
        );
        let res = convert_images_batch_impl(&tid, &req, &cancel_flag, |ev| {
            let _ = app.emit(IMAGE_BATCH_PROGRESS_EVENT, ev);
        });
        drop(guard);
        match &res {
            Ok(done) => {
                if done.cancelled {
                    let err = AppError::cancelled();
                    let _ = app.emit(
                        TASK_PROGRESS_EVENT,
                        TaskProgressPayload::failed_or_cancelled(&tid, &tool, 0, None, &err),
                    );
                } else {
                    let n = done.succeeded_count as u64;
                    let _ = app.emit(
                        TASK_PROGRESS_EVENT,
                        TaskProgressPayload::completed(&tid, &tool, n, Some(n)),
                    );
                }
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
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Image convert worker failed."))?
}

#[tauri::command]
async fn preview_compress_image(
    registry: State<'_, TaskRegistry>,
    req: PreviewCompressImageRequest,
) -> Result<PreviewCompressImageResponse, AppError> {
    registry.ensure_not_shutting_down()?;
    tauri::async_runtime::spawn_blocking(move || preview_compress_image_impl(&req))
        .await
        .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Compress preview worker failed."))?
}

#[tauri::command]
async fn compress_images_batch<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    task_id: String,
    req: CompressImagesBatchRequest,
) -> Result<BatchImageJobResponse, AppError> {
    let trimmed_id = task_id.trim();
    if trimmed_id.is_empty()
        || trimmed_id.len() > 64
        || !trimmed_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::invalid_param("Invalid image compress task ID."));
    }
    let guard = registry.register_checked(trimmed_id, "I06", true)?;
    tauri::async_runtime::spawn_blocking(move || {
        let tid = guard.task_id().to_string();
        let tool = guard.tool_id().to_string();
        let cancel_flag = guard.cancel_flag();
        let _ = app.emit(
            TASK_PROGRESS_EVENT,
            TaskProgressPayload::running(&tid, &tool, None),
        );
        let res = compress_images_batch_impl(&tid, &req, &cancel_flag, |ev| {
            let _ = app.emit(IMAGE_BATCH_PROGRESS_EVENT, ev);
        });
        drop(guard);
        match &res {
            Ok(done) => {
                if done.cancelled {
                    let err = AppError::cancelled();
                    let _ = app.emit(
                        TASK_PROGRESS_EVENT,
                        TaskProgressPayload::failed_or_cancelled(&tid, &tool, 0, None, &err),
                    );
                } else {
                    let n = (done.succeeded_count + done.kept_original_count) as u64;
                    let _ = app.emit(
                        TASK_PROGRESS_EVENT,
                        TaskProgressPayload::completed(&tid, &tool, n, Some(n)),
                    );
                }
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
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Image compress worker failed."))?
}

#[tauri::command]
async fn resize_images_batch<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    task_id: String,
    req: ResizeImagesBatchRequest,
) -> Result<BatchImageJobResponse, AppError> {
    let trimmed_id = task_id.trim();
    if trimmed_id.is_empty()
        || trimmed_id.len() > 64
        || !trimmed_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::invalid_param("Invalid image resize task ID."));
    }
    let guard = registry.register_checked(trimmed_id, "I07", true)?;
    tauri::async_runtime::spawn_blocking(move || {
        let tid = guard.task_id().to_string();
        let tool = guard.tool_id().to_string();
        let cancel_flag = guard.cancel_flag();
        let _ = app.emit(
            TASK_PROGRESS_EVENT,
            TaskProgressPayload::running(&tid, &tool, None),
        );
        let res = resize_images_batch_impl(&tid, &req, &cancel_flag, |ev| {
            let _ = app.emit(IMAGE_BATCH_PROGRESS_EVENT, ev);
        });
        drop(guard);
        match &res {
            Ok(done) => {
                if done.cancelled {
                    let err = AppError::cancelled();
                    let _ = app.emit(
                        TASK_PROGRESS_EVENT,
                        TaskProgressPayload::failed_or_cancelled(&tid, &tool, 0, None, &err),
                    );
                } else {
                    let n = (done.succeeded_count + done.kept_original_count) as u64;
                    let _ = app.emit(
                        TASK_PROGRESS_EVENT,
                        TaskProgressPayload::completed(&tid, &tool, n, Some(n)),
                    );
                }
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
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Image resize worker failed."))?
}

#[tauri::command]
async fn preview_rotate_image(
    registry: State<'_, TaskRegistry>,
    req: PreviewRotateImageRequest,
) -> Result<PreviewRotateImageResponse, AppError> {
    registry.ensure_not_shutting_down()?;
    tauri::async_runtime::spawn_blocking(move || preview_rotate_image_impl(&req))
        .await
        .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Rotate preview worker failed."))?
}

#[tauri::command]
async fn rotate_images_batch<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    task_id: String,
    req: RotateImagesBatchRequest,
) -> Result<BatchImageJobResponse, AppError> {
    let trimmed_id = task_id.trim();
    if trimmed_id.is_empty()
        || trimmed_id.len() > 64
        || !trimmed_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::invalid_param("Invalid image rotate task ID."));
    }
    let guard = registry.register_checked(trimmed_id, "I08", true)?;
    tauri::async_runtime::spawn_blocking(move || {
        let tid = guard.task_id().to_string();
        let tool = guard.tool_id().to_string();
        let cancel_flag = guard.cancel_flag();
        let _ = app.emit(
            TASK_PROGRESS_EVENT,
            TaskProgressPayload::running(&tid, &tool, None),
        );
        let res = rotate_images_batch_impl(&tid, &req, &cancel_flag, |ev| {
            let _ = app.emit(IMAGE_BATCH_PROGRESS_EVENT, ev);
        });
        drop(guard);
        match &res {
            Ok(done) => {
                if done.cancelled {
                    let err = AppError::cancelled();
                    let _ = app.emit(
                        TASK_PROGRESS_EVENT,
                        TaskProgressPayload::failed_or_cancelled(&tid, &tool, 0, None, &err),
                    );
                } else {
                    let n = done.succeeded_count as u64;
                    let _ = app.emit(
                        TASK_PROGRESS_EVENT,
                        TaskProgressPayload::completed(&tid, &tool, n, Some(n)),
                    );
                }
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
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Image rotate worker failed."))?
}

#[tauri::command]
async fn strip_images_metadata_batch<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    task_id: String,
    req: StripMetadataBatchRequest,
) -> Result<BatchImageJobResponse, AppError> {
    let trimmed_id = task_id.trim();
    if trimmed_id.is_empty()
        || trimmed_id.len() > 64
        || !trimmed_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::invalid_param(
            "Invalid image metadata strip task ID.",
        ));
    }
    let guard = registry.register_checked(trimmed_id, "I09", true)?;
    tauri::async_runtime::spawn_blocking(move || {
        let tid = guard.task_id().to_string();
        let tool = guard.tool_id().to_string();
        let cancel_flag = guard.cancel_flag();
        let _ = app.emit(
            TASK_PROGRESS_EVENT,
            TaskProgressPayload::running(&tid, &tool, None),
        );
        let res = strip_images_metadata_batch_impl(&tid, &req, &cancel_flag, |ev| {
            let _ = app.emit(IMAGE_BATCH_PROGRESS_EVENT, ev);
        });
        drop(guard);
        match &res {
            Ok(done) => {
                if done.cancelled {
                    let err = AppError::cancelled();
                    let _ = app.emit(
                        TASK_PROGRESS_EVENT,
                        TaskProgressPayload::failed_or_cancelled(&tid, &tool, 0, None, &err),
                    );
                } else {
                    let n = done.succeeded_count as u64;
                    let _ = app.emit(
                        TASK_PROGRESS_EVENT,
                        TaskProgressPayload::completed(&tid, &tool, n, Some(n)),
                    );
                }
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
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Image metadata strip worker failed."))?
}

#[tauri::command]
async fn preview_organize_downloads(
    registry: State<'_, TaskRegistry>,
    req: OrganizePreviewRequest,
) -> Result<OrganizePreviewResponse, AppError> {
    registry.ensure_not_shutting_down()?;
    tauri::async_runtime::spawn_blocking(move || preview_organize_downloads_impl(&req))
        .await
        .map_err(|_| {
            AppError::new(
                "INTERNAL_JOIN_ERROR",
                "Background organize-downloads preview worker failed.",
            )
        })?
}

#[tauri::command]
async fn execute_organize_downloads<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    req: OrganizeExecuteRequest,
) -> Result<OrganizeExecuteResponse, AppError> {
    let task_id = next_internal_task_id("f05-organize");
    let guard = registry.register_checked(&task_id, "F05", false)?;

    tauri::async_runtime::spawn_blocking(move || {
        let tid = guard.task_id().to_string();
        let tool = guard.tool_id().to_string();
        let _ = app.emit(
            TASK_PROGRESS_EVENT,
            TaskProgressPayload::running(&tid, &tool, None),
        );

        let res = execute_organize_downloads_impl(&req);
        drop(guard);

        match &res {
            Ok(done) => {
                let n = done.moved_count as u64;
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
            "Background organize-downloads execution worker failed.",
        )
    })?
}

#[tauri::command]
async fn apply_image_redactions_to_asset(
    registry: State<'_, TaskRegistry>,
    store: State<'_, ImageAssetStore>,
    req: ApplyRedactionsAssetRequest,
) -> Result<ImageAssetPayload, AppError> {
    registry.ensure_not_shutting_down()?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || apply_image_redactions_to_asset_impl(&store, &req))
        .await
        .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Image redaction worker failed."))?
}

#[tauri::command]
async fn export_redacted_image_file<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    store: State<'_, ImageAssetStore>,
    req: ExportRedactedImageRequest,
) -> Result<ExportRedactedImageResult, AppError> {
    let task_id = next_internal_task_id("i11-redact-export");
    let guard = registry.register_checked(&task_id, "I11", false)?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let tid = guard.task_id().to_string();
        let tool = guard.tool_id().to_string();
        let cancel_flag = guard.cancel_flag();
        let _ = app.emit(
            TASK_PROGRESS_EVENT,
            TaskProgressPayload::running(&tid, &tool, None),
        );
        let res = export_redacted_image_file_impl(&store, &req, &cancel_flag);
        drop(guard);
        match &res {
            Ok(saved) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::completed(
                        &tid,
                        &tool,
                        saved.byte_length,
                        Some(saved.byte_length),
                    ),
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
            "Image redaction export worker failed.",
        )
    })?
}

#[tauri::command]
async fn render_watermarked_asset(
    registry: State<'_, TaskRegistry>,
    store: State<'_, ImageAssetStore>,
    req: RenderWatermarkedAssetRequest,
) -> Result<ImageAssetPayload, AppError> {
    registry.ensure_not_shutting_down()?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || render_watermarked_asset_impl(&store, &req))
        .await
        .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Image watermark worker failed."))?
}

#[tauri::command]
async fn watermark_images_batch<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    task_id: String,
    req: WatermarkImagesBatchRequest,
) -> Result<BatchImageJobResponse, AppError> {
    let trimmed_id = task_id.trim();
    if trimmed_id.is_empty()
        || trimmed_id.len() > 64
        || !trimmed_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::invalid_param("Invalid image watermark task ID."));
    }
    let guard = registry.register_checked(trimmed_id, "I13", true)?;
    tauri::async_runtime::spawn_blocking(move || {
        let tid = guard.task_id().to_string();
        let tool = guard.tool_id().to_string();
        let cancel_flag = guard.cancel_flag();
        let _ = app.emit(
            TASK_PROGRESS_EVENT,
            TaskProgressPayload::running(&tid, &tool, None),
        );
        let res = watermark_images_batch_impl(&tid, &req, &cancel_flag, |ev| {
            let _ = app.emit(IMAGE_BATCH_PROGRESS_EVENT, ev);
        });
        drop(guard);
        match &res {
            Ok(done) => {
                if done.cancelled {
                    let err = AppError::cancelled();
                    let _ = app.emit(
                        TASK_PROGRESS_EVENT,
                        TaskProgressPayload::failed_or_cancelled(&tid, &tool, 0, None, &err),
                    );
                } else {
                    let n = done.succeeded_count as u64;
                    let _ = app.emit(
                        TASK_PROGRESS_EVENT,
                        TaskProgressPayload::completed(&tid, &tool, n, Some(n)),
                    );
                }
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
            "Image watermark batch worker failed.",
        )
    })?
}

#[tauri::command]
async fn detect_faces_in_asset<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    store: State<'_, ImageAssetStore>,
    req: DetectFacesAssetRequest,
) -> Result<FaceDetectionResult, AppError> {
    registry.ensure_not_shutting_down()?;
    let store = store.inner().clone();
    let res_dir = app.path().resource_dir().ok();
    tauri::async_runtime::spawn_blocking(move || {
        detect_faces_in_asset_impl(&store, res_dir.as_deref(), &req)
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Face detection worker failed."))?
}

#[tauri::command]
async fn detect_faces_in_file<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    req: DetectFacesFileRequest,
) -> Result<FaceDetectionResult, AppError> {
    registry.ensure_not_shutting_down()?;
    let res_dir = app.path().resource_dir().ok();
    tauri::async_runtime::spawn_blocking(move || {
        detect_faces_in_file_impl(res_dir.as_deref(), &req)
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Face detection worker failed."))?
}

#[tauri::command]
async fn blur_faces_batch<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    task_id: String,
    req: BlurFacesBatchRequest,
) -> Result<BatchImageJobResponse, AppError> {
    let trimmed_id = task_id.trim();
    if trimmed_id.is_empty()
        || trimmed_id.len() > 64
        || !trimmed_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::invalid_param("Invalid face blur task ID."));
    }
    let guard = registry.register_checked(trimmed_id, "I02", true)?;
    let res_dir = app.path().resource_dir().ok();
    tauri::async_runtime::spawn_blocking(move || {
        let tid = guard.task_id().to_string();
        let tool = guard.tool_id().to_string();
        let cancel_flag = guard.cancel_flag();
        let _ = app.emit(
            TASK_PROGRESS_EVENT,
            TaskProgressPayload::running(&tid, &tool, None),
        );
        let res = blur_faces_batch_impl(&tid, res_dir.as_deref(), &req, &cancel_flag, |ev| {
            let _ = app.emit(IMAGE_BATCH_PROGRESS_EVENT, ev);
        });
        drop(guard);
        match &res {
            Ok(done) => {
                if done.cancelled {
                    let err = AppError::cancelled();
                    let _ = app.emit(
                        TASK_PROGRESS_EVENT,
                        TaskProgressPayload::failed_or_cancelled(&tid, &tool, 0, None, &err),
                    );
                } else {
                    let n = (done.succeeded_count + done.kept_original_count) as u64;
                    let _ = app.emit(
                        TASK_PROGRESS_EVENT,
                        TaskProgressPayload::completed(&tid, &tool, n, Some(n)),
                    );
                }
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
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Face blur batch worker failed."))?
}

#[tauri::command]
async fn pick_screen_color<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    req: Option<PickScreenColorRequest>,
) -> Result<ScreenColorSample, AppError> {
    let task_id = next_internal_task_id("i10-pick-color");
    let guard = registry.register_checked(&task_id, "I10", true)?;
    let hide = req.and_then(|r| r.hide_main_window).unwrap_or(true);
    tauri::async_runtime::spawn_blocking(move || {
        let cancel_flag = guard.cancel_flag();
        let hide_guard = MainWindowHideGuard::hide_if(&app, hide);
        let res = pick_screen_color_impl(&cancel_flag);
        drop(hide_guard);
        drop(guard);
        res
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Screen color picker worker failed."))?
}

#[tauri::command]
async fn sample_screen_pixel_at<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    req: SampleScreenPixelRequest,
) -> Result<ScreenColorSample, AppError> {
    registry.ensure_not_shutting_down()?;
    let hide = req.hide_main_window.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let hide_guard = MainWindowHideGuard::hide_if(&app, hide);
        let res = sample_screen_pixel_at_impl(req.physical_x, req.physical_y);
        drop(hide_guard);
        res
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Screen pixel sampler worker failed."))?
}

#[tauri::command]
async fn extract_image_palette(
    registry: State<'_, TaskRegistry>,
    store: State<'_, ImageAssetStore>,
    req: ExtractImagePaletteRequest,
) -> Result<ImagePaletteResult, AppError> {
    registry.ensure_not_shutting_down()?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || extract_image_palette_impl(&store, &req))
        .await
        .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Image palette worker failed."))?
}

fn app_media_root<R: Runtime>(app: &AppHandle<R>) -> std::path::PathBuf {
    let local_dir = app.path().app_local_data_dir().ok();
    resolve_media_data_root(local_dir.as_deref())
}

#[tauri::command]
async fn get_media_tools_status<R: Runtime>(
    app: AppHandle<R>,
) -> Result<MediaToolsStatus, AppError> {
    let root = app_media_root(&app);
    tauri::async_runtime::spawn_blocking(move || get_media_tools_status_impl(&root))
        .await
        .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Media status worker failed."))
}

#[tauri::command]
async fn set_media_tools_custom_dir<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    dir: Option<String>,
) -> Result<MediaToolsStatus, AppError> {
    registry.ensure_not_shutting_down()?;
    let root = app_media_root(&app);
    tauri::async_runtime::spawn_blocking(move || set_media_tools_custom_dir_impl(&root, dir))
        .await
        .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Media config worker failed."))?
}

#[tauri::command]
async fn install_managed_media_tools<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    task_id: String,
) -> Result<MediaToolsStatus, AppError> {
    let tid = task_id.trim().to_string();
    if tid.is_empty() || tid.len() > 128 {
        return Err(AppError::invalid_param("Invalid media setup task ID."));
    }
    let guard = registry.register_checked(&tid, "media-setup", true)?;
    let root = app_media_root(&app);
    let _ = app.emit(
        TASK_PROGRESS_EVENT,
        TaskProgressPayload::running(
            &tid,
            "media-setup",
            Some(crate::media_core::MANAGED_FFMPEG_DOWNLOAD_BYTES),
        ),
    );

    tauri::async_runtime::spawn_blocking(move || {
        let cancel_flag = guard.cancel_flag();
        let res = install_managed_media_tools_impl(&tid, &root, &cancel_flag, |ev| {
            let _ = app.emit(MEDIA_SETUP_PROGRESS_EVENT, &ev);
            let _ = app.emit(
                TASK_PROGRESS_EVENT,
                TaskProgressPayload {
                    task_id: tid.clone(),
                    tool_id: "media-setup".into(),
                    state: crate::tasks::TaskLifecycleState::Running,
                    processed_bytes: ev.downloaded_bytes,
                    total_bytes: Some(ev.total_bytes),
                    percent: ev.percent,
                    error_code: None,
                    error_message: None,
                },
            );
        });
        match &res {
            Ok(_) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::completed(
                        &tid,
                        "media-setup",
                        crate::media_core::MANAGED_FFMPEG_DOWNLOAD_BYTES,
                        Some(crate::media_core::MANAGED_FFMPEG_DOWNLOAD_BYTES),
                    ),
                );
            }
            Err(err) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::failed_or_cancelled(
                        &tid,
                        "media-setup",
                        0,
                        Some(crate::media_core::MANAGED_FFMPEG_DOWNLOAD_BYTES),
                        err,
                    ),
                );
            }
        }
        drop(guard);
        res
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Media installation worker failed."))?
}

#[tauri::command]
fn register_media_preview_path(
    preview_reg: State<'_, MediaPreviewRegistry>,
    path: String,
) -> Result<MediaPreviewRegistration, AppError> {
    preview_reg.register_path(&path)
}

#[tauri::command]
async fn extract_media_poster_data_url<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    path: String,
    time_sec: Option<f64>,
) -> Result<String, AppError> {
    registry.ensure_not_shutting_down()?;
    let root = app_media_root(&app);
    tauri::async_runtime::spawn_blocking(move || {
        extract_media_poster_data_url_impl(&root, &path, time_sec)
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Media poster worker failed."))?
}

#[tauri::command]
async fn probe_media_info<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    path: String,
) -> Result<MediaProbeReport, AppError> {
    registry.ensure_not_shutting_down()?;
    let root = app_media_root(&app);
    tauri::async_runtime::spawn_blocking(move || probe_media_info_impl(&root, &path))
        .await
        .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Media probe worker failed."))?
}

#[tauri::command]
async fn analyze_trim_keyframes<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    req: TrimKeyframeAnalysisRequest,
) -> Result<TrimKeyframeAnalysis, AppError> {
    registry.ensure_not_shutting_down()?;
    let root = app_media_root(&app);
    tauri::async_runtime::spawn_blocking(move || analyze_trim_keyframes_impl(&root, &req))
        .await
        .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Keyframe analysis worker failed."))?
}

#[tauri::command]
async fn trim_video_file<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    req: TrimVideoRequest,
) -> Result<TrimVideoResult, AppError> {
    let tid = req.task_id.trim().to_string();
    if tid.is_empty() || tid.len() > 128 {
        return Err(AppError::invalid_param("Invalid trim task ID."));
    }
    let guard = registry.register_checked(&tid, "V11", true)?;
    let root = app_media_root(&app);
    let _ = app.emit(
        TASK_PROGRESS_EVENT,
        TaskProgressPayload::running(&tid, "V11", None),
    );

    tauri::async_runtime::spawn_blocking(move || {
        let cancel_flag = guard.cancel_flag();
        let res = trim_video_file_impl(&root, &req, &cancel_flag, |ev| {
            let _ = app.emit(MEDIA_TASK_PROGRESS_EVENT, &ev);
            let _ = app.emit(
                TASK_PROGRESS_EVENT,
                TaskProgressPayload {
                    task_id: tid.clone(),
                    tool_id: "V11".into(),
                    state: crate::tasks::TaskLifecycleState::Running,
                    processed_bytes: 0,
                    total_bytes: None,
                    percent: ev.percent,
                    error_code: None,
                    error_message: None,
                },
            );
        });
        match &res {
            Ok(out) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::completed(&tid, "V11", out.byte_size, Some(out.byte_size)),
                );
            }
            Err(err) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::failed_or_cancelled(&tid, "V11", 0, None, err),
                );
            }
        }
        drop(guard);
        res
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Video trim worker failed."))?
}

#[tauri::command]
async fn mute_videos_batch<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    req: MuteVideosBatchRequest,
) -> Result<MuteVideosBatchResponse, AppError> {
    let tid = req.task_id.trim().to_string();
    if tid.is_empty() || tid.len() > 128 {
        return Err(AppError::invalid_param("Invalid mute task ID."));
    }
    let guard = registry.register_checked(&tid, "V13", true)?;
    let root = app_media_root(&app);
    let _ = app.emit(
        TASK_PROGRESS_EVENT,
        TaskProgressPayload::running(&tid, "V13", None),
    );

    tauri::async_runtime::spawn_blocking(move || {
        let cancel_flag = guard.cancel_flag();
        let res = mute_videos_batch_impl(&root, &req, &cancel_flag, |ev| {
            let _ = app.emit(MEDIA_TASK_PROGRESS_EVENT, &ev);
            let _ = app.emit(
                TASK_PROGRESS_EVENT,
                TaskProgressPayload {
                    task_id: tid.clone(),
                    tool_id: "V13".into(),
                    state: crate::tasks::TaskLifecycleState::Running,
                    processed_bytes: 0,
                    total_bytes: None,
                    percent: ev.percent,
                    error_code: None,
                    error_message: None,
                },
            );
        });
        match &res {
            Ok(_) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::completed(&tid, "V13", 0, None),
                );
            }
            Err(err) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::failed_or_cancelled(&tid, "V13", 0, None, err),
                );
            }
        }
        drop(guard);
        res
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Video mute worker failed."))?
}

#[tauri::command]
async fn preview_audio_track<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    preview_reg: State<'_, MediaPreviewRegistry>,
    path: String,
    audio_track_index: usize,
) -> Result<AudioTrackPreviewResult, AppError> {
    registry.ensure_not_shutting_down()?;
    let root = app_media_root(&app);
    let reg = preview_reg.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        preview_audio_track_impl(&root, &reg, &path, audio_track_index)
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Audio track preview worker failed."))?
}

#[tauri::command]
async fn extract_audio_batch<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    req: ExtractAudioBatchRequest,
) -> Result<ExtractAudioBatchResponse, AppError> {
    let tid = req.task_id.trim().to_string();
    if tid.is_empty() || tid.len() > 128 {
        return Err(AppError::invalid_param("Invalid audio extract task ID."));
    }
    let guard = registry.register_checked(&tid, "A04", true)?;
    let root = app_media_root(&app);
    let _ = app.emit(
        TASK_PROGRESS_EVENT,
        TaskProgressPayload::running(&tid, "A04", None),
    );

    tauri::async_runtime::spawn_blocking(move || {
        let cancel_flag = guard.cancel_flag();
        let res = extract_audio_batch_impl(&root, &req, &cancel_flag, |ev| {
            let _ = app.emit(MEDIA_TASK_PROGRESS_EVENT, &ev);
            let _ = app.emit(
                TASK_PROGRESS_EVENT,
                TaskProgressPayload {
                    task_id: tid.clone(),
                    tool_id: "A04".into(),
                    state: crate::tasks::TaskLifecycleState::Running,
                    processed_bytes: 0,
                    total_bytes: None,
                    percent: ev.percent,
                    error_code: None,
                    error_message: None,
                },
            );
        });
        match &res {
            Ok(_) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::completed(&tid, "A04", 0, None),
                );
            }
            Err(err) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::failed_or_cancelled(&tid, "A04", 0, None, err),
                );
            }
        }
        drop(guard);
        res
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Audio extract worker failed."))?
}

#[tauri::command]
async fn extract_video_frames<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    req: ExtractFramesRequest,
) -> Result<ExtractFramesResponse, AppError> {
    let tid = req.task_id.trim().to_string();
    if tid.is_empty() || tid.len() > 128 {
        return Err(AppError::invalid_param("Invalid frame extract task ID."));
    }
    let guard = registry.register_checked(&tid, "V04", true)?;
    let root = app_media_root(&app);
    let _ = app.emit(
        TASK_PROGRESS_EVENT,
        TaskProgressPayload::running(&tid, "V04", None),
    );

    tauri::async_runtime::spawn_blocking(move || {
        let cancel_flag = guard.cancel_flag();
        let res = extract_video_frames_impl(&root, &req, &cancel_flag, |ev| {
            let _ = app.emit(MEDIA_TASK_PROGRESS_EVENT, &ev);
            let _ = app.emit(
                TASK_PROGRESS_EVENT,
                TaskProgressPayload {
                    task_id: tid.clone(),
                    tool_id: "V04".into(),
                    state: crate::tasks::TaskLifecycleState::Running,
                    processed_bytes: 0,
                    total_bytes: None,
                    percent: ev.percent,
                    error_code: None,
                    error_message: None,
                },
            );
        });
        match &res {
            Ok(_) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::completed(&tid, "V04", 0, None),
                );
            }
            Err(err) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::failed_or_cancelled(&tid, "V04", 0, None, err),
                );
            }
        }
        drop(guard);
        res
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Frame extract worker failed."))?
}

#[tauri::command]
async fn convert_video_to_gif<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    preview_reg: State<'_, MediaPreviewRegistry>,
    req: ConvertVideoToGifRequest,
) -> Result<ConvertVideoToGifResult, AppError> {
    let tid = req.task_id.trim().to_string();
    if tid.is_empty() || tid.len() > 128 {
        return Err(AppError::invalid_param("Invalid GIF conversion task ID."));
    }
    let guard = registry.register_checked(&tid, "V15", true)?;
    let root = app_media_root(&app);
    let reg = preview_reg.inner().clone();
    let _ = app.emit(
        TASK_PROGRESS_EVENT,
        TaskProgressPayload::running(&tid, "V15", None),
    );

    tauri::async_runtime::spawn_blocking(move || {
        let cancel_flag = guard.cancel_flag();
        let res = convert_video_to_gif_impl(&root, &reg, &req, &cancel_flag, |ev| {
            let _ = app.emit(MEDIA_TASK_PROGRESS_EVENT, &ev);
            let _ = app.emit(
                TASK_PROGRESS_EVENT,
                TaskProgressPayload {
                    task_id: tid.clone(),
                    tool_id: "V15".into(),
                    state: crate::tasks::TaskLifecycleState::Running,
                    processed_bytes: 0,
                    total_bytes: None,
                    percent: ev.percent,
                    error_code: None,
                    error_message: None,
                },
            );
        });
        match &res {
            Ok(out) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::completed(&tid, "V15", out.byte_size, Some(out.byte_size)),
                );
            }
            Err(err) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::failed_or_cancelled(&tid, "V15", 0, None, err),
                );
            }
        }
        drop(guard);
        res
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "GIF conversion worker failed."))?
}

#[tauri::command]
async fn inspect_video_convert_plan<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    req: InspectVideoConvertPlanRequest,
) -> Result<InspectVideoConvertPlanResponse, AppError> {
    registry.ensure_not_shutting_down()?;
    let root = app_media_root(&app);
    tauri::async_runtime::spawn_blocking(move || inspect_video_convert_plan_impl(&root, &req))
        .await
        .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Convert plan worker failed."))?
}

#[tauri::command]
async fn convert_videos_batch<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    req: ConvertVideosBatchRequest,
) -> Result<ConvertVideosBatchResponse, AppError> {
    let tid = req.task_id.trim().to_string();
    if tid.is_empty() || tid.len() > 128 {
        return Err(AppError::invalid_param("Invalid video convert task ID."));
    }
    let guard = registry.register_checked(&tid, "V07", true)?;
    let root = app_media_root(&app);
    let _ = app.emit(
        TASK_PROGRESS_EVENT,
        TaskProgressPayload::running(&tid, "V07", None),
    );

    tauri::async_runtime::spawn_blocking(move || {
        let cancel_flag = guard.cancel_flag();
        let res = convert_videos_batch_impl(&root, &req, &cancel_flag, |ev| {
            let _ = app.emit(MEDIA_TASK_PROGRESS_EVENT, &ev);
            let _ = app.emit(
                TASK_PROGRESS_EVENT,
                TaskProgressPayload {
                    task_id: tid.clone(),
                    tool_id: "V07".into(),
                    state: crate::tasks::TaskLifecycleState::Running,
                    processed_bytes: 0,
                    total_bytes: None,
                    percent: ev.percent,
                    error_code: None,
                    error_message: None,
                },
            );
        });
        match &res {
            Ok(_) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::completed(&tid, "V07", 0, None),
                );
            }
            Err(err) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::failed_or_cancelled(&tid, "V07", 0, None, err),
                );
            }
        }
        drop(guard);
        res
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Video convert worker failed."))?
}

#[tauri::command]
async fn probe_video_encoders<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
) -> Result<VideoEncoderCapabilities, AppError> {
    registry.ensure_not_shutting_down()?;
    let root = app_media_root(&app);
    tauri::async_runtime::spawn_blocking(move || probe_video_encoders_impl(&root))
        .await
        .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Encoder probe worker failed."))?
}

#[tauri::command]
async fn compress_videos_batch<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    req: CompressVideosBatchRequest,
) -> Result<CompressVideosBatchResponse, AppError> {
    let tid = req.task_id.trim().to_string();
    if tid.is_empty() || tid.len() > 128 {
        return Err(AppError::invalid_param("Invalid video compress task ID."));
    }
    let guard = registry.register_checked(&tid, "V06", true)?;
    let root = app_media_root(&app);
    let _ = app.emit(
        TASK_PROGRESS_EVENT,
        TaskProgressPayload::running(&tid, "V06", None),
    );

    tauri::async_runtime::spawn_blocking(move || {
        let cancel_flag = guard.cancel_flag();
        let res = compress_videos_batch_impl(&root, &req, &cancel_flag, |ev| {
            let _ = app.emit(MEDIA_TASK_PROGRESS_EVENT, &ev);
            let _ = app.emit(
                TASK_PROGRESS_EVENT,
                TaskProgressPayload {
                    task_id: tid.clone(),
                    tool_id: "V06".into(),
                    state: crate::tasks::TaskLifecycleState::Running,
                    processed_bytes: 0,
                    total_bytes: None,
                    percent: ev.percent,
                    error_code: None,
                    error_message: None,
                },
            );
        });
        match &res {
            Ok(_) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::completed(&tid, "V06", 0, None),
                );
            }
            Err(err) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::failed_or_cancelled(&tid, "V06", 0, None, err),
                );
            }
        }
        drop(guard);
        res
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Video compress worker failed."))?
}

#[tauri::command]
async fn resize_videos_batch<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    req: ResizeVideosBatchRequest,
) -> Result<ResizeVideosBatchResponse, AppError> {
    let tid = req.task_id.trim().to_string();
    if tid.is_empty() || tid.len() > 128 {
        return Err(AppError::invalid_param("Invalid video resize task ID."));
    }
    let guard = registry.register_checked(&tid, "V08", true)?;
    let root = app_media_root(&app);
    let _ = app.emit(
        TASK_PROGRESS_EVENT,
        TaskProgressPayload::running(&tid, "V08", None),
    );

    tauri::async_runtime::spawn_blocking(move || {
        let cancel_flag = guard.cancel_flag();
        let res = resize_videos_batch_impl(&root, &req, &cancel_flag, |ev| {
            let _ = app.emit(MEDIA_TASK_PROGRESS_EVENT, &ev);
            let _ = app.emit(
                TASK_PROGRESS_EVENT,
                TaskProgressPayload {
                    task_id: tid.clone(),
                    tool_id: "V08".into(),
                    state: crate::tasks::TaskLifecycleState::Running,
                    processed_bytes: 0,
                    total_bytes: None,
                    percent: ev.percent,
                    error_code: None,
                    error_message: None,
                },
            );
        });
        match &res {
            Ok(_) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::completed(&tid, "V08", 0, None),
                );
            }
            Err(err) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::failed_or_cancelled(&tid, "V08", 0, None, err),
                );
            }
        }
        drop(guard);
        res
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Video resize worker failed."))?
}

#[tauri::command]
async fn extract_oriented_preview_frame<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    source_path: String,
    timestamp_sec: Option<f64>,
) -> Result<OrientedPreviewFrame, AppError> {
    registry.ensure_not_shutting_down()?;
    let root = app_media_root(&app);
    tauri::async_runtime::spawn_blocking(move || {
        extract_oriented_preview_frame_impl(&root, &source_path, timestamp_sec)
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Preview frame worker failed."))?
}

#[tauri::command]
async fn crop_rotate_video<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    req: CropRotateVideoRequest,
) -> Result<CropRotateVideoResult, AppError> {
    let tid = req.task_id.trim().to_string();
    if tid.is_empty() || tid.len() > 128 {
        return Err(AppError::invalid_param("Invalid crop/rotate task ID."));
    }
    let guard = registry.register_checked(&tid, "V09", true)?;
    let root = app_media_root(&app);
    let _ = app.emit(
        TASK_PROGRESS_EVENT,
        TaskProgressPayload::running(&tid, "V09", None),
    );

    tauri::async_runtime::spawn_blocking(move || {
        let cancel_flag = guard.cancel_flag();
        let res = crop_rotate_video_impl(&root, &req, &cancel_flag, |ev| {
            let _ = app.emit(MEDIA_TASK_PROGRESS_EVENT, &ev);
            let _ = app.emit(
                TASK_PROGRESS_EVENT,
                TaskProgressPayload {
                    task_id: tid.clone(),
                    tool_id: "V09".into(),
                    state: crate::tasks::TaskLifecycleState::Running,
                    processed_bytes: 0,
                    total_bytes: None,
                    percent: ev.percent,
                    error_code: None,
                    error_message: None,
                },
            );
        });
        match &res {
            Ok(out) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::completed(&tid, "V09", out.byte_size, Some(out.byte_size)),
                );
            }
            Err(err) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::failed_or_cancelled(&tid, "V09", 0, None, err),
                );
            }
        }
        drop(guard);
        res
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Video crop/rotate worker failed."))?
}

#[tauri::command]
async fn change_video_speed_batch<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    req: ChangeVideoSpeedBatchRequest,
) -> Result<ChangeVideoSpeedBatchResponse, AppError> {
    let tid = req.task_id.trim().to_string();
    if tid.is_empty() || tid.len() > 128 {
        return Err(AppError::invalid_param("Invalid video speed task ID."));
    }
    let guard = registry.register_checked(&tid, "V03", true)?;
    let root = app_media_root(&app);
    let _ = app.emit(
        TASK_PROGRESS_EVENT,
        TaskProgressPayload::running(&tid, "V03", None),
    );

    tauri::async_runtime::spawn_blocking(move || {
        let cancel_flag = guard.cancel_flag();
        let res = change_video_speed_batch_impl(&root, &req, &cancel_flag, |ev| {
            let _ = app.emit(MEDIA_TASK_PROGRESS_EVENT, &ev);
            let _ = app.emit(
                TASK_PROGRESS_EVENT,
                TaskProgressPayload {
                    task_id: tid.clone(),
                    tool_id: "V03".into(),
                    state: crate::tasks::TaskLifecycleState::Running,
                    processed_bytes: 0,
                    total_bytes: None,
                    percent: ev.percent,
                    error_code: None,
                    error_message: None,
                },
            );
        });
        match &res {
            Ok(_) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::completed(&tid, "V03", 0, None),
                );
            }
            Err(err) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::failed_or_cancelled(&tid, "V03", 0, None, err),
                );
            }
        }
        drop(guard);
        res
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Video speed worker failed."))?
}

#[tauri::command]
async fn merge_videos<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    req: MergeVideosRequest,
) -> Result<MergeVideosResult, AppError> {
    let tid = req.task_id.trim().to_string();
    if tid.is_empty() || tid.len() > 128 {
        return Err(AppError::invalid_param("Invalid video merge task ID."));
    }
    let guard = registry.register_checked(&tid, "V12", true)?;
    let root = app_media_root(&app);
    let _ = app.emit(
        TASK_PROGRESS_EVENT,
        TaskProgressPayload::running(&tid, "V12", None),
    );

    tauri::async_runtime::spawn_blocking(move || {
        let cancel_flag = guard.cancel_flag();
        let res = merge_videos_impl(&root, &req, &cancel_flag, |ev| {
            let _ = app.emit(MEDIA_TASK_PROGRESS_EVENT, &ev);
            let _ = app.emit(
                TASK_PROGRESS_EVENT,
                TaskProgressPayload {
                    task_id: tid.clone(),
                    tool_id: "V12".into(),
                    state: crate::tasks::TaskLifecycleState::Running,
                    processed_bytes: 0,
                    total_bytes: None,
                    percent: ev.percent,
                    error_code: None,
                    error_message: None,
                },
            );
        });
        match &res {
            Ok(out) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::completed(&tid, "V12", out.byte_size, Some(out.byte_size)),
                );
            }
            Err(err) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::failed_or_cancelled(&tid, "V12", 0, None, err),
                );
            }
        }
        drop(guard);
        res
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Video merge worker failed."))?
}

#[tauri::command]
async fn extract_audio_waveform<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    preview_registry: State<'_, MediaPreviewRegistry>,
    source_path: String,
    buckets: Option<usize>,
) -> Result<AudioWaveformPayload, AppError> {
    registry.ensure_not_shutting_down()?;
    let root = app_media_root(&app);
    let preview_reg = preview_registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        extract_audio_waveform_impl(&root, &preview_reg, &source_path, buckets)
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Audio waveform worker failed."))?
}

#[tauri::command]
async fn trim_audio_file<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    req: TrimAudioRequest,
) -> Result<TrimAudioResult, AppError> {
    let tid = req.task_id.trim().to_string();
    if tid.is_empty() || tid.len() > 128 {
        return Err(AppError::invalid_param("Invalid audio trim task ID."));
    }
    let guard = registry.register_checked(&tid, "A03", true)?;
    let root = app_media_root(&app);
    let _ = app.emit(
        TASK_PROGRESS_EVENT,
        TaskProgressPayload::running(&tid, "A03", None),
    );

    tauri::async_runtime::spawn_blocking(move || {
        let cancel_flag = guard.cancel_flag();
        let res = trim_audio_file_impl(&root, &req, &cancel_flag, |ev| {
            let _ = app.emit(MEDIA_TASK_PROGRESS_EVENT, &ev);
            let _ = app.emit(
                TASK_PROGRESS_EVENT,
                TaskProgressPayload {
                    task_id: tid.clone(),
                    tool_id: "A03".into(),
                    state: crate::tasks::TaskLifecycleState::Running,
                    processed_bytes: 0,
                    total_bytes: None,
                    percent: ev.percent,
                    error_code: None,
                    error_message: None,
                },
            );
        });
        match &res {
            Ok(out) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::completed(&tid, "A03", out.byte_size, Some(out.byte_size)),
                );
            }
            Err(err) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::failed_or_cancelled(&tid, "A03", 0, None, err),
                );
            }
        }
        drop(guard);
        res
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Audio trim worker failed."))?
}

#[tauri::command]
async fn convert_audio_batch<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    req: ConvertAudioBatchRequest,
) -> Result<ConvertAudioBatchResponse, AppError> {
    let tid = req.task_id.trim().to_string();
    if tid.is_empty() || tid.len() > 128 {
        return Err(AppError::invalid_param("Invalid audio convert task ID."));
    }
    let guard = registry.register_checked(&tid, "A05", true)?;
    let root = app_media_root(&app);
    let _ = app.emit(
        TASK_PROGRESS_EVENT,
        TaskProgressPayload::running(&tid, "A05", None),
    );

    tauri::async_runtime::spawn_blocking(move || {
        let cancel_flag = guard.cancel_flag();
        let res = convert_audio_batch_impl(&root, &req, &cancel_flag, |ev| {
            let _ = app.emit(MEDIA_TASK_PROGRESS_EVENT, &ev);
            let _ = app.emit(
                TASK_PROGRESS_EVENT,
                TaskProgressPayload {
                    task_id: tid.clone(),
                    tool_id: "A05".into(),
                    state: crate::tasks::TaskLifecycleState::Running,
                    processed_bytes: 0,
                    total_bytes: None,
                    percent: ev.percent,
                    error_code: None,
                    error_message: None,
                },
            );
        });
        match &res {
            Ok(_) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::completed(&tid, "A05", 0, None),
                );
            }
            Err(err) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::failed_or_cancelled(&tid, "A05", 0, None, err),
                );
            }
        }
        drop(guard);
        res
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Audio convert worker failed."))?
}

#[tauri::command]
async fn preview_audio_cleanup<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    preview_registry: State<'_, MediaPreviewRegistry>,
    req: PreviewAudioCleanupRequest,
) -> Result<PreviewAudioCleanupResult, AppError> {
    registry.ensure_not_shutting_down()?;
    let root = app_media_root(&app);
    let preview_reg = preview_registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        preview_audio_cleanup_impl(&root, &preview_reg, &req)
    })
    .await
    .map_err(|_| {
        AppError::new(
            "INTERNAL_JOIN_ERROR",
            "Audio cleanup preview worker failed.",
        )
    })?
}

#[tauri::command]
async fn clean_up_audio<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    req: CleanUpAudioRequest,
) -> Result<CleanUpAudioResult, AppError> {
    let tid = req.task_id.trim().to_string();
    if tid.is_empty() || tid.len() > 128 {
        return Err(AppError::invalid_param("Invalid audio cleanup task ID."));
    }
    let guard = registry.register_checked(&tid, "A01", true)?;
    let root = app_media_root(&app);
    let _ = app.emit(
        TASK_PROGRESS_EVENT,
        TaskProgressPayload::running(&tid, "A01", None),
    );

    tauri::async_runtime::spawn_blocking(move || {
        let cancel_flag = guard.cancel_flag();
        let res = clean_up_audio_impl(&root, &req, &cancel_flag, |ev| {
            let _ = app.emit(MEDIA_TASK_PROGRESS_EVENT, &ev);
            let _ = app.emit(
                TASK_PROGRESS_EVENT,
                TaskProgressPayload {
                    task_id: tid.clone(),
                    tool_id: "A01".into(),
                    state: crate::tasks::TaskLifecycleState::Running,
                    processed_bytes: 0,
                    total_bytes: None,
                    percent: ev.percent,
                    error_code: None,
                    error_message: None,
                },
            );
        });
        match &res {
            Ok(out) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::completed(&tid, "A01", out.byte_size, Some(out.byte_size)),
                );
            }
            Err(err) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::failed_or_cancelled(&tid, "A01", 0, None, err),
                );
            }
        }
        drop(guard);
        res
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Audio cleanup worker failed."))?
}

#[tauri::command]
async fn preview_replace_audio<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    preview_registry: State<'_, MediaPreviewRegistry>,
    req: PreviewReplaceAudioRequest,
) -> Result<PreviewReplaceAudioResult, AppError> {
    registry.ensure_not_shutting_down()?;
    let root = app_media_root(&app);
    let preview_reg = preview_registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        preview_replace_audio_impl(&root, &preview_reg, &req)
    })
    .await
    .map_err(|_| {
        AppError::new(
            "INTERNAL_JOIN_ERROR",
            "Replace audio preview worker failed.",
        )
    })?
}

#[tauri::command]
async fn replace_video_audio<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, TaskRegistry>,
    req: ReplaceAudioRequest,
) -> Result<ReplaceAudioResult, AppError> {
    let tid = req.task_id.trim().to_string();
    if tid.is_empty() || tid.len() > 128 {
        return Err(AppError::invalid_param("Invalid replace audio task ID."));
    }
    let guard = registry.register_checked(&tid, "V14", true)?;
    let root = app_media_root(&app);
    let _ = app.emit(
        TASK_PROGRESS_EVENT,
        TaskProgressPayload::running(&tid, "V14", None),
    );

    tauri::async_runtime::spawn_blocking(move || {
        let cancel_flag = guard.cancel_flag();
        let res = replace_video_audio_impl(&root, &req, &cancel_flag, |ev| {
            let _ = app.emit(MEDIA_TASK_PROGRESS_EVENT, &ev);
            let _ = app.emit(
                TASK_PROGRESS_EVENT,
                TaskProgressPayload {
                    task_id: tid.clone(),
                    tool_id: "V14".into(),
                    state: crate::tasks::TaskLifecycleState::Running,
                    processed_bytes: 0,
                    total_bytes: None,
                    percent: ev.percent,
                    error_code: None,
                    error_message: None,
                },
            );
        });
        match &res {
            Ok(out) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::completed(&tid, "V14", out.byte_size, Some(out.byte_size)),
                );
            }
            Err(err) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::failed_or_cancelled(&tid, "V14", 0, None, err),
                );
            }
        }
        drop(guard);
        res
    })
    .await
    .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Replace audio worker failed."))?
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
    let preview_registry = MediaPreviewRegistry::default();
    let preview_registry_for_proto = preview_registry.clone();

    tauri::Builder::default()
        .manage(TaskRegistry::default())
        .manage(BatchRenameState::default())
        .manage(ImageAssetStore::default())
        .manage(preview_registry)
        .register_uri_scheme_protocol("winkitmedia", move |_ctx, request| {
            handle_winkit_media_protocol(&preview_registry_for_proto, request)
        })
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
            scan_duplicate_folders,
            recycle_duplicate_groups,
            inspect_archive,
            extract_archives_batch,
            create_archive,
            open_local_directory,
            preview_organize_downloads,
            execute_organize_downloads,
            get_image_heic_capabilities,
            inspect_batch_images,
            preview_convert_image,
            convert_images_batch,
            preview_compress_image,
            compress_images_batch,
            resize_images_batch,
            preview_rotate_image,
            rotate_images_batch,
            strip_images_metadata_batch,
            inspect_beautifier_image,
            export_beautified_png,
            render_beautified_asset,
            beautify_images_batch,
            list_capture_monitors,
            list_capture_windows,
            capture_screen_region,
            capture_screen_monitor,
            capture_screen_window,
            capture_screen_scroll,
            store_png_asset,
            load_file_as_image_asset,
            get_image_asset,
            copy_image_asset_to_clipboard,
            read_clipboard_image_as_asset,
            save_image_asset_file,
            apply_image_redactions_to_asset,
            export_redacted_image_file,
            render_watermarked_asset,
            watermark_images_batch,
            detect_faces_in_asset,
            detect_faces_in_file,
            blur_faces_batch,
            pick_screen_color,
            sample_screen_pixel_at,
            extract_image_palette,
            get_media_tools_status,
            set_media_tools_custom_dir,
            install_managed_media_tools,
            register_media_preview_path,
            extract_media_poster_data_url,
            probe_media_info,
            analyze_trim_keyframes,
            trim_video_file,
            mute_videos_batch,
            preview_audio_track,
            extract_audio_batch,
            extract_video_frames,
            convert_video_to_gif,
            inspect_video_convert_plan,
            convert_videos_batch,
            probe_video_encoders,
            compress_videos_batch,
            resize_videos_batch,
            extract_oriented_preview_frame,
            crop_rotate_video,
            change_video_speed_batch,
            merge_videos,
            extract_audio_waveform,
            trim_audio_file,
            convert_audio_batch,
            preview_audio_cleanup,
            clean_up_audio,
            preview_replace_audio,
            replace_video_audio,
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
