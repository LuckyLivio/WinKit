//! V11 Trim Video — keyframe offset preview for Fast Stream Copy, plus lossless Stream Copy
//! and frame-accurate Transcode modes with portrait rotation, A/V sync, and silent-video support.

use crate::error::AppError;
use crate::fs_guard::validate_existing_input_file;
use crate::media_core::{
    require_media_tools, resolve_single_output_path, run_ffmpeg_cancellable, run_ffprobe_args,
    AtomicMediaOutput, MediaTaskProgressPayload,
};
use crate::media_info::probe_media_info_impl;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoTrimMode {
    StreamCopy,
    Accurate,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimKeyframeAnalysisRequest {
    pub path: String,
    pub start_sec: f64,
    pub end_sec: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimKeyframeAnalysis {
    pub requested_start_sec: f64,
    pub requested_end_sec: f64,
    pub actual_stream_copy_start_sec: f64,
    pub start_delta_sec: f64,
    pub estimated_stream_copy_duration_sec: f64,
    pub has_keyframe_shift: bool,
    pub nearest_next_keyframe_sec: Option<f64>,
    pub keyframe_count_sampled: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimVideoRequest {
    pub task_id: String,
    pub source_path: String,
    pub output_path: String,
    pub start_sec: f64,
    pub end_sec: f64,
    pub mode: VideoTrimMode,
    pub allow_overwrite: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimVideoResult {
    pub output_path: String,
    pub byte_size: u64,
    pub duration_sec: Option<f64>,
    pub display_width: Option<u32>,
    pub display_height: Option<u32>,
    pub rotation_degrees: Option<i32>,
    pub mode: VideoTrimMode,
    pub requested_start_sec: f64,
    pub requested_end_sec: f64,
    pub elapsed_ms: u64,
}

/// Computes the nearest preceding keyframe from a sorted list of keyframe timestamps.
pub fn compute_keyframe_alignment(
    keyframes: &[f64],
    requested_start: f64,
    requested_end: f64,
) -> TrimKeyframeAnalysis {
    let start = requested_start.max(0.0);
    let end = requested_end.max(start);

    let mut preceding: f64 = 0.0;
    let mut found_preceding = false;
    let mut next_kf: Option<f64> = None;

    for &kf in keyframes {
        if !kf.is_finite() || kf < 0.0 {
            continue;
        }
        if kf <= start + 0.005 {
            if !found_preceding || kf > preceding {
                preceding = kf;
                found_preceding = true;
            }
        } else if next_kf.is_none_or(|cur| kf < cur) {
            next_kf = Some(kf);
        }
    }

    let actual_start = if found_preceding { preceding } else { 0.0 };
    let delta = (start - actual_start).max(0.0);
    let est_duration = (end - actual_start).max(0.0);

    TrimKeyframeAnalysis {
        requested_start_sec: start,
        requested_end_sec: end,
        actual_stream_copy_start_sec: actual_start,
        start_delta_sec: delta,
        estimated_stream_copy_duration_sec: est_duration,
        has_keyframe_shift: delta > 0.04,
        nearest_next_keyframe_sec: next_kf,
        keyframe_count_sampled: keyframes.len(),
    }
}

pub fn analyze_trim_keyframes_impl(
    media_root: &Path,
    req: &TrimKeyframeAnalysisRequest,
) -> Result<TrimKeyframeAnalysis, AppError> {
    let (source_path, _) = validate_existing_input_file(&req.path)?;
    if !req.start_sec.is_finite()
        || !req.end_sec.is_finite()
        || req.start_sec < 0.0
        || req.end_sec <= req.start_sec
    {
        return Err(AppError::invalid_param(
            "End time must be strictly greater than start time.",
        ));
    }

    let tools = require_media_tools(media_root)?;
    let window_start = (req.start_sec - 20.0).max(0.0);
    let window_end = req.end_sec + 5.0;
    let interval = format!("{window_start:.3}%{window_end:.3}");

    let args = vec![
        "-v".into(),
        "error".into(),
        "-select_streams".into(),
        "v:0".into(),
        "-show_entries".into(),
        "packet=pts_time,dts_time,flags".into(),
        "-read_intervals".into(),
        interval,
        "-of".into(),
        "csv=p=0".into(),
        source_path.to_string_lossy().to_string(),
    ];

    let stdout = run_ffprobe_args(&tools.ffprobe, &args)?;
    let mut keyframes: Vec<f64> = Vec::new();
    for line in stdout.lines() {
        let cols: Vec<&str> = line.trim().split(',').collect();
        if cols.len() < 3 {
            continue;
        }
        let flags = cols[2].trim();
        if !flags.contains('K') {
            continue;
        }
        let ts = cols[0]
            .trim()
            .parse::<f64>()
            .ok()
            .or_else(|| cols[1].trim().parse::<f64>().ok());
        if let Some(v) = ts.filter(|v| v.is_finite() && *v >= 0.0) {
            keyframes.push(v);
        }
    }
    keyframes.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    Ok(compute_keyframe_alignment(
        &keyframes,
        req.start_sec,
        req.end_sec,
    ))
}

pub fn trim_video_file_impl(
    media_root: &Path,
    req: &TrimVideoRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(MediaTaskProgressPayload),
) -> Result<TrimVideoResult, AppError> {
    let t0 = Instant::now();
    let (source_path, _) = validate_existing_input_file(&req.source_path)?;
    if !req.start_sec.is_finite()
        || !req.end_sec.is_finite()
        || req.start_sec < 0.0
        || req.end_sec <= req.start_sec + 0.05
    {
        return Err(AppError::invalid_param(
            "Trim range must be at least 0.05 seconds long with end > start.",
        ));
    }

    let tools = require_media_tools(media_root)?;
    let probe = probe_media_info_impl(media_root, &req.source_path)?;
    if !probe.has_video {
        return Err(AppError::invalid_param(
            "Selected media file does not contain a video stream.",
        ));
    }

    let final_path = resolve_single_output_path(&req.output_path, &source_path)?;
    let allow_overwrite = req.allow_overwrite.unwrap_or(false);
    let atomic_out = AtomicMediaOutput::prepare(final_path, &source_path, allow_overwrite)?;
    let duration_sec = (req.end_sec - req.start_sec).max(0.05);

    let out_ext = atomic_out
        .final_path()
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_else(|| "mp4".into());

    let mut args: Vec<String> = Vec::new();
    match req.mode {
        VideoTrimMode::StreamCopy => {
            // Input-side -ss and -to copy from the preceding keyframe up to requested end time
            args.push("-ss".into());
            args.push(format!("{:.3}", req.start_sec));
            args.push("-to".into());
            args.push(format!("{:.3}", req.end_sec));
            args.push("-i".into());
            args.push(source_path.to_string_lossy().to_string());
            args.push("-map".into());
            args.push("0:v:0".into());
            if probe.has_audio {
                args.push("-map".into());
                args.push("0:a".into());
            }
            args.push("-c".into());
            args.push("copy".into());
            args.push("-avoid_negative_ts".into());
            args.push("make_zero".into());
            if matches!(out_ext.as_str(), "mp4" | "mov" | "m4v") {
                args.push("-movflags".into());
                args.push("+faststart".into());
            }
        }
        VideoTrimMode::Accurate => {
            // Fast input seek + decode/re-encode produces exact frame boundaries, auto-rotates
            // portrait videos upright, and aligns audio cleanly (or handles silent video).
            args.push("-ss".into());
            args.push(format!("{:.3}", req.start_sec));
            args.push("-i".into());
            args.push(source_path.to_string_lossy().to_string());
            args.push("-t".into());
            args.push(format!("{:.3}", duration_sec));
            args.push("-map".into());
            args.push("0:v:0".into());
            if probe.has_audio {
                args.push("-map".into());
                args.push("0:a".into());
            }

            if out_ext == "webm" {
                args.push("-c:v".into());
                args.push("libvpx-vp9".into());
                args.push("-crf".into());
                args.push("28".into());
                args.push("-b:v".into());
                args.push("0".into());
                if probe.has_audio {
                    args.push("-c:a".into());
                    args.push("libopus".into());
                    args.push("-b:a".into());
                    args.push("160k".into());
                    args.push("-af".into());
                    args.push("aresample=async=1:first_pts=0".into());
                }
            } else {
                // Ensure even dimensions for yuv420p compatibility without distorting portrait clips
                args.push("-vf".into());
                args.push("scale=trunc(iw/2)*2:trunc(ih/2)*2".into());
                args.push("-c:v".into());
                args.push("libx264".into());
                args.push("-preset".into());
                args.push("medium".into());
                args.push("-crf".into());
                args.push("18".into());
                args.push("-pix_fmt".into());
                args.push("yuv420p".into());
                if probe.has_audio {
                    args.push("-c:a".into());
                    args.push("aac".into());
                    args.push("-b:a".into());
                    args.push("192k".into());
                    args.push("-af".into());
                    args.push("aresample=async=1:first_pts=0".into());
                }
                if matches!(out_ext.as_str(), "mp4" | "mov" | "m4v") {
                    args.push("-movflags".into());
                    args.push("+faststart".into());
                }
            }
        }
    }

    args.push(atomic_out.temp_path().to_string_lossy().to_string());

    let file_name = source_path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string());
    let task_id = req.task_id.clone();

    on_progress(MediaTaskProgressPayload {
        task_id: task_id.clone(),
        tool_id: "V11".into(),
        phase: "running".into(),
        current_item: 1,
        total_items: 1,
        item_name: file_name.clone(),
        percent: Some(0.0),
        out_time_sec: Some(0.0),
        total_duration_sec: Some(duration_sec),
    });

    run_ffmpeg_cancellable(
        &tools.ffmpeg,
        &args,
        Some(duration_sec),
        cancel_flag,
        |out_sec, pct| {
            on_progress(MediaTaskProgressPayload {
                task_id: task_id.clone(),
                tool_id: "V11".into(),
                phase: "running".into(),
                current_item: 1,
                total_items: 1,
                item_name: file_name.clone(),
                percent: pct,
                out_time_sec: out_sec,
                total_duration_sec: Some(duration_sec),
            });
        },
    )?;

    let (committed_path, byte_size) = atomic_out.commit(allow_overwrite)?;
    let out_probe = probe_media_info_impl(media_root, &committed_path.to_string_lossy()).ok();
    let first_v = out_probe.as_ref().and_then(|p| p.video_streams.first());

    Ok(TrimVideoResult {
        output_path: committed_path.to_string_lossy().to_string(),
        byte_size,
        duration_sec: out_probe.as_ref().and_then(|p| p.duration_sec),
        display_width: first_v.and_then(|v| v.display_width),
        display_height: first_v.and_then(|v| v.display_height),
        rotation_degrees: first_v.and_then(|v| v.rotation_degrees),
        mode: req.mode,
        requested_start_sec: req.start_sec,
        requested_end_sec: req.end_sec,
        elapsed_ms: t0.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyframe_alignment_reports_shift_when_start_falls_between_keyframes() {
        let kfs = vec![0.0, 2.0, 4.0, 6.0];
        let a = compute_keyframe_alignment(&kfs, 1.25, 3.75);
        assert_eq!(a.actual_stream_copy_start_sec, 0.0);
        assert!((a.start_delta_sec - 1.25).abs() < 1e-6);
        assert!(a.has_keyframe_shift);
        assert_eq!(a.nearest_next_keyframe_sec, Some(2.0));

        let b = compute_keyframe_alignment(&kfs, 2.0, 4.0);
        assert_eq!(b.actual_stream_copy_start_sec, 2.0);
        assert!(!b.has_keyframe_shift);
    }

    #[test]
    fn real_ffmpeg_probe_keyframe_and_trim_modes_when_available() {
        use crate::media_core::{get_media_tools_status_impl, run_ffmpeg_cancellable};
        use tempfile::tempdir;

        let dir = tempdir().unwrap();
        let status = get_media_tools_status_impl(dir.path());
        if !status.ready {
            // Skip cleanly if runner has no local FFmpeg installed
            return;
        }
        let ffmpeg = Path::new(status.ffmpeg_path.as_deref().unwrap());
        let cancel = AtomicBool::new(false);

        // 1. Synthesize a 4-second 25fps H.264 clip with 2s GOP and 2 distinct audio tracks + Display Matrix rotate=90
        let sample_raw = dir.path().join("dual_raw.mp4");
        let sample = dir.path().join("dual_portrait.mp4");
        let gen_args: Vec<String> = vec![
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            "testsrc2=size=320x180:rate=25:duration=4".into(),
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            "sine=frequency=440:sample_rate=48000:duration=4".into(),
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            "sine=frequency=880:sample_rate=48000:duration=4".into(),
            "-map".into(),
            "0:v".into(),
            "-map".into(),
            "1:a".into(),
            "-map".into(),
            "2:a".into(),
            "-c:v".into(),
            "libx264".into(),
            "-g".into(),
            "50".into(),
            "-keyint_min".into(),
            "50".into(),
            "-sc_threshold".into(),
            "0".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "96k".into(),
            "-metadata:s:a:0".into(),
            "language=eng".into(),
            "-metadata:s:a:1".into(),
            "language=zho".into(),
            sample_raw.to_string_lossy().to_string(),
        ];
        run_ffmpeg_cancellable(ffmpeg, &gen_args, Some(4.0), &cancel, |_, _| {}).unwrap();
        let rot_args: Vec<String> = vec![
            "-display_rotation".into(),
            "90".into(),
            "-i".into(),
            sample_raw.to_string_lossy().to_string(),
            "-map".into(),
            "0".into(),
            "-c".into(),
            "copy".into(),
            sample.to_string_lossy().to_string(),
        ];
        run_ffmpeg_cancellable(ffmpeg, &rot_args, Some(4.0), &cancel, |_, _| {}).unwrap();

        // Probe V10
        let report = probe_media_info_impl(dir.path(), &sample.to_string_lossy()).unwrap();
        assert_eq!(report.audio_streams.len(), 2);
        assert_eq!(report.audio_streams[0].language.as_deref(), Some("eng"));
        assert_eq!(report.audio_streams[1].language.as_deref(), Some("zho"));
        let v0 = &report.video_streams[0];
        assert_eq!(v0.coded_width, Some(320));
        assert_eq!(v0.coded_height, Some(180));
        assert_eq!(v0.display_width, Some(180));
        assert_eq!(v0.display_height, Some(320));
        assert_eq!(v0.orientation.as_deref(), Some("portrait"));

        // Keyframe analysis at 1.2s (between 0s and 2s keyframes)
        let kf = analyze_trim_keyframes_impl(
            dir.path(),
            &TrimKeyframeAnalysisRequest {
                path: sample.to_string_lossy().to_string(),
                start_sec: 1.2,
                end_sec: 3.2,
            },
        )
        .unwrap();
        assert!(kf.has_keyframe_shift);
        assert!(kf.actual_stream_copy_start_sec < 0.2);

        // Accurate trim [1.0, 3.0] => 2.0s upright portrait 180x320 with both audio tracks preserved
        let out_acc = dir.path().join("acc_out.mp4");
        let res_acc = trim_video_file_impl(
            dir.path(),
            &TrimVideoRequest {
                task_id: "t-acc".into(),
                source_path: sample.to_string_lossy().to_string(),
                output_path: out_acc.to_string_lossy().to_string(),
                start_sec: 1.0,
                end_sec: 3.0,
                mode: VideoTrimMode::Accurate,
                allow_overwrite: Some(false),
            },
            &cancel,
            |_| {},
        )
        .unwrap();
        assert!(
            res_acc.duration_sec.unwrap_or(0.0) >= 1.85
                && res_acc.duration_sec.unwrap_or(9.0) <= 2.2
        );
        assert_eq!(res_acc.display_width, Some(180));
        assert_eq!(res_acc.display_height, Some(320));

        // Stream copy trim [1.2, 3.2] succeeds and preserves rotation/audio
        let out_copy = dir.path().join("copy_out.mp4");
        let res_copy = trim_video_file_impl(
            dir.path(),
            &TrimVideoRequest {
                task_id: "t-copy".into(),
                source_path: sample.to_string_lossy().to_string(),
                output_path: out_copy.to_string_lossy().to_string(),
                start_sec: 1.2,
                end_sec: 3.2,
                mode: VideoTrimMode::StreamCopy,
                allow_overwrite: Some(false),
            },
            &cancel,
            |_| {},
        )
        .unwrap();
        assert!(res_copy.byte_size > 0);
        assert_eq!(res_copy.display_width, Some(180));
        assert_eq!(res_copy.display_height, Some(320));
    }
}
