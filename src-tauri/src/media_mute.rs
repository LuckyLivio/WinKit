//! V13 Mute Video — removes ALL audio streams losslessly (`-map 0:v -an -c:v copy`)
//! while preserving original container, video codec, display rotation, and duration.
//! Explicitly flags already-silent videos without writing deceptive duplicates.

use crate::error::AppError;
use crate::fs_guard::validate_existing_input_file;
use crate::media_core::{
    allocate_non_colliding_output_path, require_media_tools, run_ffmpeg_cancellable,
    AtomicMediaOutput, MediaTaskProgressPayload,
};
use crate::media_info::probe_media_info_impl;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MuteVideosBatchRequest {
    pub task_id: String,
    pub source_paths: Vec<String>,
    pub output_dir: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MuteItemStatus {
    Muted,
    AlreadyMuted,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MuteVideoItemResult {
    pub source_path: String,
    pub file_name: String,
    pub status: MuteItemStatus,
    pub output_path: Option<String>,
    pub byte_size: Option<u64>,
    pub removed_audio_tracks: usize,
    pub duration_sec: Option<f64>,
    pub display_width: Option<u32>,
    pub display_height: Option<u32>,
    pub rotation_degrees: Option<i32>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MuteVideosBatchResponse {
    pub task_id: String,
    pub output_dir: String,
    pub cancelled: bool,
    pub muted_count: usize,
    pub already_muted_count: usize,
    pub skipped_count: usize,
    pub failed_count: usize,
    pub elapsed_ms: u64,
    pub items: Vec<MuteVideoItemResult>,
}

pub fn mute_videos_batch_impl(
    media_root: &Path,
    req: &MuteVideosBatchRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(MediaTaskProgressPayload),
) -> Result<MuteVideosBatchResponse, AppError> {
    let t0 = Instant::now();
    if req.source_paths.is_empty() {
        return Err(AppError::invalid_param(
            "Select at least one video file to mute.",
        ));
    }
    let out_dir = PathBuf::from(req.output_dir.trim());
    if !out_dir.is_absolute() {
        return Err(AppError::invalid_param(
            "Output directory must be an absolute path.",
        ));
    }
    let tools = require_media_tools(media_root)?;

    let total = req.source_paths.len();
    let mut results: Vec<MuteVideoItemResult> = Vec::with_capacity(total);
    let mut muted_count = 0usize;
    let mut already_muted_count = 0usize;
    let mut skipped_count = 0usize;
    let mut failed_count = 0usize;
    let mut cancelled = false;

    for (idx, raw_src) in req.source_paths.iter().enumerate() {
        let fallback_name = Path::new(raw_src)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(raw_src)
            .to_string();

        if cancel_flag.load(Ordering::Relaxed) {
            cancelled = true;
            skipped_count += 1;
            results.push(MuteVideoItemResult {
                source_path: raw_src.clone(),
                file_name: fallback_name,
                status: MuteItemStatus::Skipped,
                output_path: None,
                byte_size: None,
                removed_audio_tracks: 0,
                duration_sec: None,
                display_width: None,
                display_height: None,
                rotation_degrees: None,
                message: Some("Cancelled before processing.".into()),
            });
            continue;
        }

        on_progress(MediaTaskProgressPayload {
            task_id: req.task_id.clone(),
            tool_id: "V13".into(),
            phase: "running".into(),
            current_item: idx + 1,
            total_items: total,
            item_name: Some(fallback_name.clone()),
            percent: Some(((idx as f64) / (total as f64) * 100.0).clamp(0.0, 99.0)),
            out_time_sec: None,
            total_duration_sec: None,
        });

        let (source_path, _) = match validate_existing_input_file(raw_src) {
            Ok(v) => v,
            Err(e) => {
                failed_count += 1;
                results.push(MuteVideoItemResult {
                    source_path: raw_src.clone(),
                    file_name: fallback_name,
                    status: MuteItemStatus::Failed,
                    output_path: None,
                    byte_size: None,
                    removed_audio_tracks: 0,
                    duration_sec: None,
                    display_width: None,
                    display_height: None,
                    rotation_degrees: None,
                    message: Some(e.message),
                });
                continue;
            }
        };

        let probe = match probe_media_info_impl(media_root, raw_src) {
            Ok(p) => p,
            Err(e) => {
                failed_count += 1;
                results.push(MuteVideoItemResult {
                    source_path: raw_src.clone(),
                    file_name: fallback_name,
                    status: MuteItemStatus::Failed,
                    output_path: None,
                    byte_size: None,
                    removed_audio_tracks: 0,
                    duration_sec: None,
                    display_width: None,
                    display_height: None,
                    rotation_degrees: None,
                    message: Some(e.message),
                });
                continue;
            }
        };

        if !probe.has_video {
            failed_count += 1;
            results.push(MuteVideoItemResult {
                source_path: raw_src.clone(),
                file_name: probe.file_name,
                status: MuteItemStatus::Failed,
                output_path: None,
                byte_size: None,
                removed_audio_tracks: 0,
                duration_sec: probe.duration_sec,
                display_width: None,
                display_height: None,
                rotation_degrees: None,
                message: Some("File contains no video stream.".into()),
            });
            continue;
        }

        let first_v = probe.video_streams.first();
        if probe.audio_streams.is_empty() {
            already_muted_count += 1;
            results.push(MuteVideoItemResult {
                source_path: raw_src.clone(),
                file_name: probe.file_name,
                status: MuteItemStatus::AlreadyMuted,
                output_path: None,
                byte_size: None,
                removed_audio_tracks: 0,
                duration_sec: probe.duration_sec,
                display_width: first_v.and_then(|v| v.display_width),
                display_height: first_v.and_then(|v| v.display_height),
                rotation_degrees: first_v.and_then(|v| v.rotation_degrees),
                message: Some("Video already has no audio tracks.".into()),
            });
            continue;
        }

        let stem = source_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("video");
        let ext = source_path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "mp4".into());

        let target_path = match allocate_non_colliding_output_path(
            &out_dir,
            stem,
            "_muted",
            &ext,
            &source_path,
        ) {
            Ok(p) => p,
            Err(e) => {
                failed_count += 1;
                results.push(MuteVideoItemResult {
                    source_path: raw_src.clone(),
                    file_name: probe.file_name,
                    status: MuteItemStatus::Failed,
                    output_path: None,
                    byte_size: None,
                    removed_audio_tracks: 0,
                    duration_sec: probe.duration_sec,
                    display_width: first_v.and_then(|v| v.display_width),
                    display_height: first_v.and_then(|v| v.display_height),
                    rotation_degrees: first_v.and_then(|v| v.rotation_degrees),
                    message: Some(e.message),
                });
                continue;
            }
        };

        let atomic_out = match AtomicMediaOutput::prepare(target_path, &source_path, false) {
            Ok(a) => a,
            Err(e) => {
                failed_count += 1;
                results.push(MuteVideoItemResult {
                    source_path: raw_src.clone(),
                    file_name: probe.file_name,
                    status: MuteItemStatus::Failed,
                    output_path: None,
                    byte_size: None,
                    removed_audio_tracks: 0,
                    duration_sec: probe.duration_sec,
                    display_width: first_v.and_then(|v| v.display_width),
                    display_height: first_v.and_then(|v| v.display_height),
                    rotation_degrees: first_v.and_then(|v| v.rotation_degrees),
                    message: Some(e.message),
                });
                continue;
            }
        };

        // Map all video streams, explicitly strip EVERY audio stream (-an), copy video losslessly
        let mut args: Vec<String> = vec![
            "-i".into(),
            source_path.to_string_lossy().to_string(),
            "-map".into(),
            "0:v".into(),
            "-an".into(),
            "-c:v".into(),
            "copy".into(),
        ];
        if matches!(ext.as_str(), "mp4" | "mov" | "m4v") {
            args.push("-movflags".into());
            args.push("+faststart".into());
        }
        args.push(atomic_out.temp_path().to_string_lossy().to_string());

        let base_pct = (idx as f64) / (total as f64) * 100.0;
        let span_pct = 100.0 / (total as f64);
        let item_name_for_cb = probe.file_name.clone();
        let task_id_for_cb = req.task_id.clone();
        let dur_for_cb = probe.duration_sec;

        let run_res = run_ffmpeg_cancellable(
            &tools.ffmpeg,
            &args,
            probe.duration_sec,
            cancel_flag,
            |out_sec, item_pct| {
                let overall = base_pct + (item_pct.unwrap_or(0.0) / 100.0) * span_pct;
                on_progress(MediaTaskProgressPayload {
                    task_id: task_id_for_cb.clone(),
                    tool_id: "V13".into(),
                    phase: "running".into(),
                    current_item: idx + 1,
                    total_items: total,
                    item_name: Some(item_name_for_cb.clone()),
                    percent: Some(overall.clamp(0.0, 99.0)),
                    out_time_sec: out_sec,
                    total_duration_sec: dur_for_cb,
                });
            },
        );

        match run_res {
            Ok(()) => match atomic_out.commit(false) {
                Ok((committed_path, byte_size)) => {
                    let out_probe =
                        probe_media_info_impl(media_root, &committed_path.to_string_lossy()).ok();
                    let out_v = out_probe.as_ref().and_then(|p| p.video_streams.first());
                    let remaining_audio = out_probe.as_ref().map_or(0, |p| p.audio_streams.len());
                    if remaining_audio > 0 {
                        failed_count += 1;
                        results.push(MuteVideoItemResult {
                            source_path: raw_src.clone(),
                            file_name: probe.file_name,
                            status: MuteItemStatus::Failed,
                            output_path: Some(committed_path.to_string_lossy().to_string()),
                            byte_size: Some(byte_size),
                            removed_audio_tracks: 0,
                            duration_sec: out_probe.as_ref().and_then(|p| p.duration_sec),
                            display_width: out_v.and_then(|v| v.display_width),
                            display_height: out_v.and_then(|v| v.display_height),
                            rotation_degrees: out_v.and_then(|v| v.rotation_degrees),
                            message: Some("Verification detected remaining audio streams.".into()),
                        });
                    } else {
                        muted_count += 1;
                        results.push(MuteVideoItemResult {
                            source_path: raw_src.clone(),
                            file_name: probe.file_name,
                            status: MuteItemStatus::Muted,
                            output_path: Some(committed_path.to_string_lossy().to_string()),
                            byte_size: Some(byte_size),
                            removed_audio_tracks: probe.audio_streams.len(),
                            duration_sec: out_probe
                                .as_ref()
                                .and_then(|p| p.duration_sec)
                                .or(probe.duration_sec),
                            display_width: out_v
                                .and_then(|v| v.display_width)
                                .or_else(|| first_v.and_then(|v| v.display_width)),
                            display_height: out_v
                                .and_then(|v| v.display_height)
                                .or_else(|| first_v.and_then(|v| v.display_height)),
                            rotation_degrees: out_v
                                .and_then(|v| v.rotation_degrees)
                                .or_else(|| first_v.and_then(|v| v.rotation_degrees)),
                            message: None,
                        });
                    }
                }
                Err(e) => {
                    failed_count += 1;
                    results.push(MuteVideoItemResult {
                        source_path: raw_src.clone(),
                        file_name: probe.file_name,
                        status: MuteItemStatus::Failed,
                        output_path: None,
                        byte_size: None,
                        removed_audio_tracks: 0,
                        duration_sec: probe.duration_sec,
                        display_width: first_v.and_then(|v| v.display_width),
                        display_height: first_v.and_then(|v| v.display_height),
                        rotation_degrees: first_v.and_then(|v| v.rotation_degrees),
                        message: Some(e.message),
                    });
                }
            },
            Err(e) if e.code == "TASK_CANCELLED" => {
                drop(atomic_out);
                cancelled = true;
                skipped_count += 1;
                results.push(MuteVideoItemResult {
                    source_path: raw_src.clone(),
                    file_name: probe.file_name,
                    status: MuteItemStatus::Skipped,
                    output_path: None,
                    byte_size: None,
                    removed_audio_tracks: 0,
                    duration_sec: probe.duration_sec,
                    display_width: first_v.and_then(|v| v.display_width),
                    display_height: first_v.and_then(|v| v.display_height),
                    rotation_degrees: first_v.and_then(|v| v.rotation_degrees),
                    message: Some("Cancelled by user.".into()),
                });
            }
            Err(e) => {
                drop(atomic_out);
                failed_count += 1;
                results.push(MuteVideoItemResult {
                    source_path: raw_src.clone(),
                    file_name: probe.file_name,
                    status: MuteItemStatus::Failed,
                    output_path: None,
                    byte_size: None,
                    removed_audio_tracks: 0,
                    duration_sec: probe.duration_sec,
                    display_width: first_v.and_then(|v| v.display_width),
                    display_height: first_v.and_then(|v| v.display_height),
                    rotation_degrees: first_v.and_then(|v| v.rotation_degrees),
                    message: Some(e.message),
                });
            }
        }
    }

    Ok(MuteVideosBatchResponse {
        task_id: req.task_id.clone(),
        output_dir: out_dir.to_string_lossy().to_string(),
        cancelled,
        muted_count,
        already_muted_count,
        skipped_count,
        failed_count,
        elapsed_ms: t0.elapsed().as_millis() as u64,
        items: results,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media_core::get_media_tools_status_impl;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn mutes_dual_audio_portrait_video_flags_silent_and_isolates_corrupted_item() {
        let dir = tempdir().unwrap();
        let status = get_media_tools_status_impl(dir.path());
        if !status.ready {
            return;
        }
        let ffmpeg = Path::new(status.ffmpeg_path.as_deref().unwrap());
        let cancel = AtomicBool::new(false);

        // Dual-audio portrait clip
        let raw_dual = dir.path().join("raw_dual.mp4");
        let dual = dir.path().join("dual_lang.mp4");
        let gen_dual: Vec<String> = vec![
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            "testsrc2=size=320x180:rate=25:duration=2".into(),
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            "sine=frequency=440:sample_rate=48000:duration=2".into(),
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            "sine=frequency=880:sample_rate=48000:duration=2".into(),
            "-map".into(),
            "0:v".into(),
            "-map".into(),
            "1:a".into(),
            "-map".into(),
            "2:a".into(),
            "-c:v".into(),
            "libx264".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-c:a".into(),
            "aac".into(),
            raw_dual.to_string_lossy().to_string(),
        ];
        run_ffmpeg_cancellable(ffmpeg, &gen_dual, Some(2.0), &cancel, |_, _| {}).unwrap();
        run_ffmpeg_cancellable(
            ffmpeg,
            &[
                "-display_rotation".into(),
                "90".into(),
                "-i".into(),
                raw_dual.to_string_lossy().to_string(),
                "-map".into(),
                "0".into(),
                "-c".into(),
                "copy".into(),
                dual.to_string_lossy().to_string(),
            ],
            Some(2.0),
            &cancel,
            |_, _| {},
        )
        .unwrap();

        // Already silent clip
        let silent = dir.path().join("already_silent.mp4");
        run_ffmpeg_cancellable(
            ffmpeg,
            &[
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "testsrc2=size=320x180:rate=25:duration=1".into(),
                "-c:v".into(),
                "libx264".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
                silent.to_string_lossy().to_string(),
            ],
            Some(1.0),
            &cancel,
            |_, _| {},
        )
        .unwrap();

        // Corrupted file
        let bad = dir.path().join("broken.mp4");
        fs::write(&bad, b"not a valid video").unwrap();

        let out_dir = dir.path().join("muted_out");
        let resp = mute_videos_batch_impl(
            dir.path(),
            &MuteVideosBatchRequest {
                task_id: "v13-test".into(),
                source_paths: vec![
                    dual.to_string_lossy().to_string(),
                    silent.to_string_lossy().to_string(),
                    bad.to_string_lossy().to_string(),
                ],
                output_dir: out_dir.to_string_lossy().to_string(),
            },
            &cancel,
            |_| {},
        )
        .unwrap();

        assert_eq!(resp.muted_count, 1);
        assert_eq!(resp.already_muted_count, 1);
        assert_eq!(resp.failed_count, 1);
        assert_eq!(resp.items[0].removed_audio_tracks, 2);
        assert_eq!(resp.items[0].display_width, Some(180));
        assert_eq!(resp.items[0].display_height, Some(320));
        let muted_path = resp.items[0].output_path.as_deref().unwrap();
        let verify = probe_media_info_impl(dir.path(), muted_path).unwrap();
        assert_eq!(verify.audio_streams.len(), 0);
        assert_eq!(verify.video_streams[0].display_width, Some(180));
        assert_eq!(verify.video_streams[0].display_height, Some(320));
        assert!(resp.items[1].output_path.is_none());
    }
}
