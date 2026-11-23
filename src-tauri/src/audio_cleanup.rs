//! A01 Clean Up Audio — local noise reduction (Light/Medium/Strong), optional low-frequency
//! rumble/hum filtering, 2-pass EBU R128 loudness normalization (default -16 LUFS, -1.5 dBTP),
//! optional silence removal for pure audio (never alters video timing), multi-track video
//! stream copy preserving untouched video & secondary tracks, and same-segment Before/After audition.

use crate::error::AppError;
use crate::fs_guard::validate_existing_input_file;
use crate::media_core::{
    configure_hidden_command, require_media_tools, run_ffmpeg_cancellable, AtomicMediaOutput,
    MediaPreviewRegistry, MediaTaskProgressPayload,
};
use crate::media_info::probe_media_info_impl;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioDenoiseLevel {
    Off,
    Light,
    Medium,
    Strong,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanUpAudioOptions {
    pub audio_track_index: usize,
    pub denoise_level: AudioDenoiseLevel,
    pub highpass_rumble: bool,
    pub normalize_loudness: bool,
    pub target_lufs: Option<f64>,
    /// Applied only when input is pure audio; strictly ignored for video inputs to keep A/V sync.
    pub remove_silence: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewAudioCleanupRequest {
    pub source_path: String,
    pub start_sec: f64,
    pub duration_sec: Option<f64>,
    pub options: CleanUpAudioOptions,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewAudioCleanupResult {
    pub before_url: String,
    pub after_url: String,
    pub start_sec: f64,
    pub preview_duration_sec: f64,
    pub before_lufs: Option<f64>,
    pub before_true_peak_db: Option<f64>,
    pub after_lufs: Option<f64>,
    pub after_true_peak_db: Option<f64>,
    pub is_all_silence: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanUpAudioRequest {
    pub task_id: String,
    pub source_path: String,
    pub output_path: String,
    pub options: CleanUpAudioOptions,
    pub allow_overwrite: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanUpAudioResult {
    pub output_path: String,
    pub byte_size: u64,
    pub duration_sec: Option<f64>,
    pub has_video: bool,
    pub video_stream_copied: bool,
    pub processed_track_index: usize,
    pub total_audio_tracks: usize,
    pub preserved_other_tracks: usize,
    pub is_all_silence: bool,
    pub silence_removal_applied: bool,
    pub measured_before_lufs: Option<f64>,
    pub measured_before_true_peak_db: Option<f64>,
    pub measured_after_lufs: Option<f64>,
    pub measured_after_true_peak_db: Option<f64>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone)]
pub struct LoudnormMeasurement {
    pub input_i: Option<f64>,
    pub input_tp: Option<f64>,
    pub input_lra: Option<f64>,
    pub input_thresh: Option<f64>,
    pub target_offset: Option<f64>,
    pub is_all_silence: bool,
}

fn parse_loudnorm_f64(val: Option<&serde_json::Value>) -> Option<f64> {
    let s = val?.as_str()?.trim();
    if s.eq_ignore_ascii_case("-inf")
        || s.eq_ignore_ascii_case("inf")
        || s.eq_ignore_ascii_case("nan")
    {
        return None;
    }
    s.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// Parses FFmpeg `loudnorm=...:print_format=json` stderr block cleanly, handling `-inf` all-silence tracks.
pub fn parse_loudnorm_json_from_stderr(stderr: &str) -> LoudnormMeasurement {
    if let Some(start) = stderr.rfind('{') {
        if let Some(end_rel) = stderr[start..].find('}') {
            let block = &stderr[start..=start + end_rel];
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(block) {
                let input_i = parse_loudnorm_f64(v.get("input_i"));
                let input_tp = parse_loudnorm_f64(v.get("input_tp"));
                let input_lra = parse_loudnorm_f64(v.get("input_lra"));
                let input_thresh = parse_loudnorm_f64(v.get("input_thresh"));
                let target_offset = parse_loudnorm_f64(v.get("target_offset"));
                let is_all_silence = input_i.map(|i| i < -65.0).unwrap_or(true);
                return LoudnormMeasurement {
                    input_i,
                    input_tp,
                    input_lra,
                    input_thresh,
                    target_offset,
                    is_all_silence,
                };
            }
        }
    }
    LoudnormMeasurement {
        input_i: None,
        input_tp: None,
        input_lra: None,
        input_thresh: None,
        target_offset: None,
        is_all_silence: true,
    }
}

pub fn build_pre_cleanup_filters(
    opts: &CleanUpAudioOptions,
    allow_silence_remove: bool,
) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    if opts.highpass_rumble {
        // Cut sub-85 Hz rumble plus gentle narrow AC mains 50/60 Hz hum notches
        parts.push("highpass=f=85:p=2".into());
        parts.push("equalizer=f=50:t=q:w=12:g=-10".into());
        parts.push("equalizer=f=60:t=q:w=12:g=-10".into());
    }
    match opts.denoise_level {
        AudioDenoiseLevel::Off => {}
        AudioDenoiseLevel::Light => parts.push("afftdn=nr=10:nf=-38:tn=1".into()),
        AudioDenoiseLevel::Medium => parts.push("afftdn=nr=18:nf=-30:tn=1".into()),
        AudioDenoiseLevel::Strong => parts.push("afftdn=nr=28:nf=-22:tn=1".into()),
    }
    if allow_silence_remove && opts.remove_silence {
        parts.push(
            "silenceremove=start_periods=1:start_duration=0.35:start_threshold=-45dB:stop_periods=-1:stop_duration=0.5:stop_threshold=-45dB"
                .into(),
        );
    }
    parts
}

/// Runs a fast FFmpeg analysis pass with `loudnorm=print_format=json` and returns integrated LUFS + true peak.
pub fn measure_loudness(
    ffmpeg: &Path,
    source_path: &Path,
    audio_track_index: usize,
    pre_filters: &[String],
    target_lufs: f64,
    clip_window: Option<(f64, f64)>,
) -> Result<LoudnormMeasurement, AppError> {
    let mut filters: Vec<String> = Vec::new();
    if let Some((st, dur)) = clip_window {
        filters.push(format!(
            "atrim=start={st:.6}:duration={dur:.6},asetpts=PTS-STARTPTS"
        ));
    }
    filters.extend(pre_filters.iter().cloned());
    filters.push(format!(
        "loudnorm=I={target_lufs:.2}:TP=-1.5:LRA=11:print_format=json"
    ));

    let mut cmd = Command::new(ffmpeg);
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "info",
        "-i",
        &source_path.to_string_lossy(),
        "-vn",
        "-map",
        &format!("0:a:{audio_track_index}"),
        "-af",
        &filters.join(","),
        "-f",
        "null",
        "-",
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::piped());
    configure_hidden_command(&mut cmd);

    let out = cmd.output().map_err(|e| {
        AppError::new(
            "MEDIA_PROCESS_FAILED",
            format!("Failed to measure audio loudness: {e}"),
        )
    })?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    Ok(parse_loudnorm_json_from_stderr(&stderr))
}

fn build_final_cleanup_filter_chain(
    pre_filters: &[String],
    normalize_loudness: bool,
    target_lufs: f64,
    measured: Option<&LoudnormMeasurement>,
) -> String {
    let mut parts: Vec<String> = pre_filters.to_vec();
    if normalize_loudness {
        if let Some(m) = measured {
            if !m.is_all_silence {
                if let (Some(ii), Some(itp), Some(ilra), Some(ith), Some(off)) = (
                    m.input_i,
                    m.input_tp,
                    m.input_lra,
                    m.input_thresh,
                    m.target_offset,
                ) {
                    parts.push(format!(
                        "loudnorm=I={target_lufs:.2}:TP=-1.5:LRA=11:measured_I={ii:.2}:measured_TP={itp:.2}:measured_LRA={ilra:.2}:measured_thresh={ith:.2}:offset={off:.2}:linear=true"
                    ));
                } else {
                    parts.push(format!("loudnorm=I={target_lufs:.2}:TP=-1.5:LRA=11"));
                }
            }
        } else {
            parts.push(format!("loudnorm=I={target_lufs:.2}:TP=-1.5:LRA=11"));
        }
    }
    if parts.is_empty() {
        "anull".into()
    } else {
        parts.join(",")
    }
}

fn is_video_codec_copy_compatible_for_ext(ext: &str, codec: Option<&str>) -> bool {
    let c = codec.unwrap_or("").to_ascii_lowercase();
    match ext {
        "mp4" | "m4v" => matches!(c.as_str(), "h264" | "hevc" | "vp9" | "av1" | "mpeg4"),
        "mov" => matches!(c.as_str(), "h264" | "hevc" | "prores" | "mpeg4" | "mjpeg"),
        "mkv" => !c.is_empty(),
        "webm" => matches!(c.as_str(), "vp9" | "vp8" | "av1"),
        _ => false,
    }
}

fn audio_codec_for_output_ext(ext: &str, src_bits: Option<u32>) -> (&'static str, Vec<String>) {
    match ext {
        "mp3" => ("libmp3lame", vec!["-b:a".into(), "192k".into()]),
        "wav" => {
            let c = match src_bits {
                Some(24) => "pcm_s24le",
                Some(32) => "pcm_s32le",
                _ => "pcm_s16le",
            };
            (c, Vec::new())
        }
        "flac" => ("flac", Vec::new()),
        "aif" | "aiff" => {
            let c = if src_bits == Some(24) {
                "pcm_s24be"
            } else {
                "pcm_s16be"
            };
            (c, Vec::new())
        }
        "webm" => ("libopus", vec!["-b:a".into(), "160k".into()]),
        _ => ("aac", vec!["-b:a".into(), "192k".into()]),
    }
}

fn muxer_for_ext(ext: &str) -> &'static str {
    match ext {
        "mp4" | "m4v" => "mp4",
        "mov" => "mov",
        "mkv" => "matroska",
        "webm" => "webm",
        "m4a" | "aac" => "ipod",
        "mp3" => "mp3",
        "wav" => "wav",
        "flac" => "flac",
        "aif" | "aiff" => "aiff",
        _ => "wav",
    }
}

/// Generates matched Before & After audition clips for the exact same time window so users can
/// A/B compare noise reduction and loudness normalization immediately.
pub fn preview_audio_cleanup_impl(
    media_root: &Path,
    preview_registry: &MediaPreviewRegistry,
    req: &PreviewAudioCleanupRequest,
) -> Result<PreviewAudioCleanupResult, AppError> {
    let (source_path, _) = validate_existing_input_file(&req.source_path)?;
    let tools = require_media_tools(media_root)?;
    let probe = probe_media_info_impl(media_root, &req.source_path)?;
    if probe.audio_streams.is_empty() {
        return Err(AppError::invalid_param(
            "Input file does not contain an audio stream.",
        ));
    }
    let track_idx = req
        .options
        .audio_track_index
        .min(probe.audio_streams.len().saturating_sub(1));
    let total_dur = probe.audio_streams[track_idx]
        .duration_sec
        .or(probe.duration_sec)
        .filter(|d| d.is_finite() && *d > 0.0)
        .unwrap_or(10.0);

    let start_sec = req.start_sec.clamp(0.0, (total_dur - 0.5).max(0.0));
    let preview_dur = req
        .duration_sec
        .unwrap_or(12.0)
        .clamp(1.0, 20.0)
        .min((total_dur - start_sec).max(0.5));
    let target_lufs = req.options.target_lufs.unwrap_or(-16.0).clamp(-24.0, -10.0);
    let allow_silence_rm = !probe.has_video;

    let cache_dir = media_root.join(".preview-cache");
    fs::create_dir_all(&cache_dir)
        .map_err(|e| AppError::from_io(e, "Unable to create cleanup preview cache"))?;

    let token_base = Uuid::new_v4();
    let before_path = cache_dir.join(format!("a01-before-{token_base}.m4a"));
    let after_path = cache_dir.join(format!("a01-after-{token_base}.m4a"));
    let cancel = AtomicBool::new(false);

    // 1. Before clip (untouched same segment)
    let before_meas = measure_loudness(
        &tools.ffmpeg,
        &source_path,
        track_idx,
        &[],
        target_lufs,
        Some((start_sec, preview_dur)),
    )?;
    run_ffmpeg_cancellable(
        &tools.ffmpeg,
        &[
            "-i".into(),
            source_path.to_string_lossy().to_string(),
            "-vn".into(),
            "-map".into(),
            format!("0:a:{track_idx}"),
            "-af".into(),
            format!("atrim=start={start_sec:.6}:duration={preview_dur:.6},asetpts=PTS-STARTPTS"),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "192k".into(),
            "-movflags".into(),
            "+faststart".into(),
            "-f".into(),
            "ipod".into(),
            before_path.to_string_lossy().to_string(),
        ],
        Some(preview_dur),
        &cancel,
        |_, _| {},
    )?;

    // 2. After clip (same segment through exact cleanup pipeline)
    let pre = build_pre_cleanup_filters(&req.options, allow_silence_rm);
    let pre_meas = measure_loudness(
        &tools.ffmpeg,
        &source_path,
        track_idx,
        &pre,
        target_lufs,
        Some((start_sec, preview_dur)),
    )?;
    let mut after_filters = vec![format!(
        "atrim=start={start_sec:.6}:duration={preview_dur:.6},asetpts=PTS-STARTPTS"
    )];
    let chain = build_final_cleanup_filter_chain(
        &pre,
        req.options.normalize_loudness,
        target_lufs,
        Some(&pre_meas),
    );
    if chain != "anull" {
        after_filters.push(chain);
    }

    run_ffmpeg_cancellable(
        &tools.ffmpeg,
        &[
            "-i".into(),
            source_path.to_string_lossy().to_string(),
            "-vn".into(),
            "-map".into(),
            format!("0:a:{track_idx}"),
            "-af".into(),
            after_filters.join(","),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "192k".into(),
            "-movflags".into(),
            "+faststart".into(),
            "-f".into(),
            "ipod".into(),
            after_path.to_string_lossy().to_string(),
        ],
        Some(preview_dur),
        &cancel,
        |_, _| {},
    )?;

    let after_meas = measure_loudness(&tools.ffmpeg, &after_path, 0, &[], target_lufs, None)?;

    let reg_before = preview_registry.register_path(&before_path.to_string_lossy())?;
    let reg_after = preview_registry.register_path(&after_path.to_string_lossy())?;

    Ok(PreviewAudioCleanupResult {
        before_url: reg_before.url,
        after_url: reg_after.url,
        start_sec,
        preview_duration_sec: preview_dur,
        before_lufs: before_meas.input_i,
        before_true_peak_db: before_meas.input_tp,
        after_lufs: after_meas.input_i,
        after_true_peak_db: after_meas.input_tp,
        is_all_silence: pre_meas.is_all_silence,
    })
}

pub fn clean_up_audio_impl(
    media_root: &Path,
    req: &CleanUpAudioRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(MediaTaskProgressPayload),
) -> Result<CleanUpAudioResult, AppError> {
    let t0 = Instant::now();
    let (source_path, _) = validate_existing_input_file(&req.source_path)?;
    let out_path = PathBuf::from(req.output_path.trim());
    if !out_path.is_absolute() {
        return Err(AppError::invalid_param(
            "Output file path must be an absolute path.",
        ));
    }

    let tools = require_media_tools(media_root)?;
    let probe = probe_media_info_impl(media_root, &req.source_path)?;
    if probe.audio_streams.is_empty() {
        return Err(AppError::new(
            "NO_AUDIO_STREAM",
            "Selected file has no audio track to clean up.",
        ));
    }

    let total_tracks = probe.audio_streams.len();
    let sel_track = req
        .options
        .audio_track_index
        .min(total_tracks.saturating_sub(1));
    let target_lufs = req.options.target_lufs.unwrap_or(-16.0).clamp(-24.0, -10.0);
    let has_video = probe.has_video;
    let silence_removal_applied = !has_video && req.options.remove_silence;
    let dur = probe.audio_streams[sel_track]
        .duration_sec
        .or(probe.duration_sec);

    let allow_overwrite = req.allow_overwrite.unwrap_or(false);
    let atomic = AtomicMediaOutput::prepare(out_path.clone(), &source_path, allow_overwrite)?;

    on_progress(MediaTaskProgressPayload {
        task_id: req.task_id.clone(),
        tool_id: "A01".into(),
        phase: "analyzing".into(),
        current_item: 1,
        total_items: 1,
        item_name: Some(probe.file_name.clone()),
        percent: Some(10.0),
        out_time_sec: Some(0.0),
        total_duration_sec: dur,
    });

    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let raw_before = measure_loudness(
        &tools.ffmpeg,
        &source_path,
        sel_track,
        &[],
        target_lufs,
        None,
    )?;
    let pre_filters = build_pre_cleanup_filters(&req.options, !has_video);
    let post_pre = if pre_filters.is_empty() {
        raw_before.clone()
    } else {
        measure_loudness(
            &tools.ffmpeg,
            &source_path,
            sel_track,
            &pre_filters,
            target_lufs,
            None,
        )?
    };

    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let filter_chain = build_final_cleanup_filter_chain(
        &pre_filters,
        req.options.normalize_loudness,
        target_lufs,
        Some(&post_pre),
    );

    let out_ext = out_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_else(|| {
            if has_video {
                "mp4".into()
            } else {
                "wav".into()
            }
        });
    let (aud_codec, aud_extra) =
        audio_codec_for_output_ext(&out_ext, probe.audio_streams[sel_track].bits_per_sample);
    let muxer = muxer_for_ext(&out_ext);

    let mut args: Vec<String> = vec!["-i".into(), source_path.to_string_lossy().to_string()];
    let mut video_copied = false;

    if has_video {
        let src_v_codec = probe
            .video_streams
            .first()
            .and_then(|v| v.codec_name.as_deref());
        args.extend(["-map".into(), "0:v:0".into()]);
        if is_video_codec_copy_compatible_for_ext(&out_ext, src_v_codec) {
            args.extend(["-c:v".into(), "copy".into()]);
            video_copied = true;
        } else {
            args.extend([
                "-c:v".into(),
                "libx264".into(),
                "-crf".into(),
                "20".into(),
                "-preset".into(),
                "medium".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
            ]);
        }

        // Map all audio tracks: clean ONLY sel_track and copy remaining tracks untouched!
        for t_idx in 0..total_tracks {
            args.extend(["-map".into(), format!("0:a:{t_idx}")]);
        }
        for t_idx in 0..total_tracks {
            if t_idx == sel_track {
                args.extend([format!("-filter:a:{t_idx}"), filter_chain.clone()]);
                args.extend([format!("-c:a:{t_idx}"), aud_codec.into()]);
                for x in &aud_extra {
                    if x == "-b:a" {
                        args.push(format!("-b:a:{t_idx}"));
                    } else {
                        args.push(x.clone());
                    }
                }
            } else {
                args.extend([format!("-c:a:{t_idx}"), "copy".into()]);
            }
        }
    } else {
        args.extend([
            "-vn".into(),
            "-map".into(),
            format!("0:a:{sel_track}"),
            "-af".into(),
            filter_chain,
            "-c:a".into(),
            aud_codec.into(),
        ]);
        args.extend(aud_extra);
    }

    if matches!(muxer, "mp4" | "mov" | "ipod") {
        args.extend(["-movflags".into(), "+faststart".into()]);
    }
    args.extend([
        "-f".into(),
        muxer.into(),
        atomic.temp_path().to_string_lossy().to_string(),
    ]);

    run_ffmpeg_cancellable(&tools.ffmpeg, &args, dur, cancel_flag, |out_t, pct| {
        let mapped = pct.map(|p| 25.0 + p * 0.70);
        on_progress(MediaTaskProgressPayload {
            task_id: req.task_id.clone(),
            tool_id: "A01".into(),
            phase: "running".into(),
            current_item: 1,
            total_items: 1,
            item_name: Some(probe.file_name.clone()),
            percent: mapped,
            out_time_sec: out_t,
            total_duration_sec: dur,
        });
    })?;

    let (committed, byte_size) = atomic.commit(allow_overwrite)?;
    let out_probe = probe_media_info_impl(media_root, &committed.to_string_lossy()).ok();
    let after_meas =
        measure_loudness(&tools.ffmpeg, &committed, sel_track, &[], target_lufs, None).ok();

    on_progress(MediaTaskProgressPayload {
        task_id: req.task_id.clone(),
        tool_id: "A01".into(),
        phase: "completed".into(),
        current_item: 1,
        total_items: 1,
        item_name: Some(probe.file_name),
        percent: Some(100.0),
        out_time_sec: dur,
        total_duration_sec: dur,
    });

    Ok(CleanUpAudioResult {
        output_path: committed.to_string_lossy().to_string(),
        byte_size,
        duration_sec: out_probe.as_ref().and_then(|p| p.duration_sec),
        has_video,
        video_stream_copied: video_copied,
        processed_track_index: sel_track,
        total_audio_tracks: total_tracks,
        preserved_other_tracks: if has_video {
            total_tracks.saturating_sub(1)
        } else {
            0
        },
        is_all_silence: post_pre.is_all_silence,
        silence_removal_applied,
        measured_before_lufs: raw_before.input_i,
        measured_before_true_peak_db: raw_before.input_tp,
        measured_after_lufs: after_meas.as_ref().and_then(|m| m.input_i),
        measured_after_true_peak_db: after_meas.as_ref().and_then(|m| m.input_tp),
        elapsed_ms: t0.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;
    use tempfile::tempdir;

    fn write_wav_mono(path: &Path, sr: u32, samples: &[i16]) {
        let data_bytes = (samples.len() * 2) as u32;
        let mut out = Vec::with_capacity(44 + data_bytes as usize);
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_bytes).to_le_bytes());
        out.extend_from_slice(b"WAVE");
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&sr.to_le_bytes());
        out.extend_from_slice(&(sr * 2).to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_bytes.to_le_bytes());
        for &s in samples {
            out.extend_from_slice(&s.to_le_bytes());
        }
        fs::write(path, out).unwrap();
    }

    fn decode_mono_16k(ffmpeg: &Path, path: &Path, track: usize) -> Vec<f64> {
        let out = Command::new(ffmpeg)
            .args([
                "-v",
                "error",
                "-i",
                &path.to_string_lossy(),
                "-vn",
                "-map",
                &format!("0:a:{track}"),
                "-ac",
                "1",
                "-ar",
                "16000",
                "-f",
                "s16le",
                "pipe:1",
            ])
            .output()
            .unwrap();
        assert!(out.status.success());
        out.stdout
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| i16::from_le_bytes(*c) as f64 / 32768.0)
            .collect()
    }

    fn rms(xs: &[f64]) -> f64 {
        if xs.is_empty() {
            return 0.0;
        }
        (xs.iter().map(|v| v * v).sum::<f64>() / xs.len() as f64).sqrt()
    }

    #[test]
    fn cleans_noisy_recording_hits_lufs_target_preserves_multitrack_video_and_handles_all_silence()
    {
        let dir = tempdir().unwrap();
        let Ok(tools) = require_media_tools(dir.path()) else {
            return;
        };
        let sr = 48_000u32;
        let n = (sr * 6) as usize;
        let mut samples = Vec::with_capacity(n);
        let mut rng: u64 = 0x1234_5678_9abc_def0;
        // 6s clip: [0..1.5s] noise+60Hz hum, [1.5..4.5s] low-level speech-band tone + noise+hum, [4.5..6.0s] noise+hum
        for i in 0..n {
            let t = i as f64 / f64::from(sr);
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
            let white = (((rng >> 33) as f64) / (u32::MAX as f64) * 2.0 - 1.0) * 0.015;
            let hum60 = 0.045 * (2.0 * PI * 60.0 * t).sin();
            let voice = if (1.5..4.5).contains(&t) {
                0.08 * (2.0 * PI * 380.0 * t).sin() + 0.05 * (2.0 * PI * 760.0 * t).sin()
            } else {
                0.0
            };
            let v = ((white + hum60 + voice).clamp(-0.99, 0.99) * 32767.0).round() as i16;
            samples.push(v);
        }
        let noisy = dir.path().join("noisy_voice.wav");
        write_wav_mono(&noisy, sr, &samples);

        let cancel = AtomicBool::new(false);
        let cleaned = dir.path().join("cleaned_voice.wav");
        let res = clean_up_audio_impl(
            dir.path(),
            &CleanUpAudioRequest {
                task_id: "a01-noisy".into(),
                source_path: noisy.to_string_lossy().to_string(),
                output_path: cleaned.to_string_lossy().to_string(),
                options: CleanUpAudioOptions {
                    audio_track_index: 0,
                    denoise_level: AudioDenoiseLevel::Medium,
                    highpass_rumble: true,
                    normalize_loudness: true,
                    target_lufs: Some(-16.0),
                    remove_silence: false,
                },
                allow_overwrite: Some(false),
            },
            &cancel,
            |_| {},
        )
        .unwrap();

        assert!(!res.is_all_silence);
        let after_lufs = res.measured_after_lufs.expect("after LUFS measured");
        assert!(
            (after_lufs - (-16.0)).abs() <= 2.0,
            "Expected ~-16 LUFS, got {after_lufs:.2} LUFS"
        );
        let after_tp = res.measured_after_true_peak_db.expect("after TP");
        assert!(
            after_tp <= -0.5,
            "True peak should stay controlled: {after_tp:.2}"
        );

        // Compare SNR improvement: noise-segment to voice-segment ratio must improve substantially
        let pcm_before = decode_mono_16k(&tools.ffmpeg, &noisy, 0);
        let pcm_after = decode_mono_16k(&tools.ffmpeg, &cleaned, 0);
        let snr_before = rms(&pcm_before[32000..64000]) / rms(&pcm_before[3200..19200]).max(1e-6);
        let snr_after = rms(&pcm_after[32000..64000]) / rms(&pcm_after[3200..19200]).max(1e-6);
        assert!(
            snr_after > snr_before * 2.0,
            "Expected SNR to improve >2x (before={snr_before:.2}, after={snr_after:.2})"
        );

        // 2. All-silence file must NOT crash or amplify noise
        let silent = dir.path().join("all_silence.wav");
        write_wav_mono(&silent, sr, &vec![0i16; (sr * 2) as usize]);
        let silent_out = dir.path().join("all_silence_clean.wav");
        let s_res = clean_up_audio_impl(
            dir.path(),
            &CleanUpAudioRequest {
                task_id: "a01-silence".into(),
                source_path: silent.to_string_lossy().to_string(),
                output_path: silent_out.to_string_lossy().to_string(),
                options: CleanUpAudioOptions {
                    audio_track_index: 0,
                    denoise_level: AudioDenoiseLevel::Medium,
                    highpass_rumble: true,
                    normalize_loudness: true,
                    target_lufs: Some(-16.0),
                    remove_silence: false,
                },
                allow_overwrite: Some(false),
            },
            &cancel,
            |_| {},
        )
        .unwrap();
        assert!(s_res.is_all_silence);

        // 3. Multi-track video: copies video stream and preserves track 1 untouched!
        let multi_vid = dir.path().join("multi_track.mp4");
        run_ffmpeg_cancellable(
            &tools.ffmpeg,
            &[
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "color=c=blue:s=320x180:r=25:d=3".into(),
                "-i".into(),
                noisy.to_string_lossy().to_string(),
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "sine=frequency=880:sample_rate=48000:duration=3".into(),
                "-map".into(),
                "0:v".into(),
                "-map".into(),
                "1:a".into(),
                "-map".into(),
                "2:a".into(),
                "-shortest".into(),
                "-c:v".into(),
                "libx264".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
                "-c:a".into(),
                "aac".into(),
                multi_vid.to_string_lossy().to_string(),
            ],
            Some(3.0),
            &cancel,
            |_, _| {},
        )
        .unwrap();

        let multi_out = dir.path().join("multi_track_clean.mp4");
        let v_res = clean_up_audio_impl(
            dir.path(),
            &CleanUpAudioRequest {
                task_id: "a01-video".into(),
                source_path: multi_vid.to_string_lossy().to_string(),
                output_path: multi_out.to_string_lossy().to_string(),
                options: CleanUpAudioOptions {
                    audio_track_index: 0,
                    denoise_level: AudioDenoiseLevel::Light,
                    highpass_rumble: true,
                    normalize_loudness: true,
                    target_lufs: Some(-16.0),
                    remove_silence: true, // must be ignored for video!
                },
                allow_overwrite: Some(false),
            },
            &cancel,
            |_| {},
        )
        .unwrap();
        assert!(v_res.has_video && v_res.video_stream_copied);
        assert_eq!(v_res.total_audio_tracks, 2);
        assert_eq!(v_res.preserved_other_tracks, 1);
        assert!(!v_res.silence_removal_applied);
    }
}
