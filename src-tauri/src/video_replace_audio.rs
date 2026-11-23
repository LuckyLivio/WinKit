//! V14 Replace Audio — replaces or mixes a video's soundtrack using either an audio file or an
//! audio track from another video. Supports independent original/new volumes, Loop-to-Fill vs
//! Play-Once behavior for shorter tracks, silent target videos, non-jumping `amix(normalize=0)`,
//! lossless video stream copy when compatible, and live pre-export mix auditioning.

use crate::error::AppError;
use crate::fs_guard::{paths_refer_to_same_location, validate_existing_input_file};
use crate::media_core::{
    require_media_tools, run_ffmpeg_cancellable, AtomicMediaOutput, MediaPreviewRegistry,
    MediaTaskProgressPayload,
};
use crate::media_info::probe_media_info_impl;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::Instant;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplaceAudioMode {
    Replace,
    Mix,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShortAudioBehavior {
    LoopToFill,
    PlayOnce,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceAudioOptions {
    pub video_path: String,
    pub audio_source_path: String,
    pub audio_source_track_index: usize,
    pub mode: ReplaceAudioMode,
    /// Volume multiplier for target video's original audio (0.0..=2.0, used in Mix mode).
    pub original_volume: f64,
    /// Volume multiplier for new audio track (0.0..=2.0).
    pub new_audio_volume: f64,
    pub short_audio_behavior: ShortAudioBehavior,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewReplaceAudioRequest {
    pub options: ReplaceAudioOptions,
    pub start_sec: Option<f64>,
    pub max_duration_sec: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewReplaceAudioResult {
    pub preview_url: String,
    pub start_sec: f64,
    pub preview_duration_sec: f64,
    pub effective_mode: ReplaceAudioMode,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceAudioRequest {
    pub task_id: String,
    pub options: ReplaceAudioOptions,
    pub output_path: String,
    pub allow_overwrite: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceAudioResult {
    pub output_path: String,
    pub byte_size: u64,
    pub duration_sec: Option<f64>,
    pub video_stream_copied: bool,
    pub effective_mode: ReplaceAudioMode,
    pub target_video_had_audio: bool,
    pub has_output_audio: bool,
    pub elapsed_ms: u64,
}

fn build_replace_mix_filter(
    effective_mode: ReplaceAudioMode,
    audio_track_idx: usize,
    orig_vol: f64,
    new_vol: f64,
    short_behavior: ShortAudioBehavior,
    target_dur: f64,
    clip_start: f64,
) -> String {
    let ov = orig_vol.clamp(0.0, 2.0);
    let nv = new_vol.clamp(0.0, 2.0);
    let end_t = clip_start + target_dur;

    let new_chain = match short_behavior {
        ShortAudioBehavior::LoopToFill => format!(
            "[1:a:{audio_track_idx}]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=start={clip_start:.6}:end={end_t:.6},asetpts=PTS-STARTPTS,volume={nv:.4}[newa]"
        ),
        ShortAudioBehavior::PlayOnce => format!(
            "[1:a:{audio_track_idx}]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,apad,atrim=start={clip_start:.6}:end={end_t:.6},asetpts=PTS-STARTPTS,volume={nv:.4}[newa]"
        ),
    };

    match effective_mode {
        ReplaceAudioMode::Replace => format!("{new_chain};[newa]alimiter=limit=0.98[aout]"),
        ReplaceAudioMode::Mix => format!(
            "[0:a:0]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,apad,atrim=start={clip_start:.6}:end={end_t:.6},asetpts=PTS-STARTPTS,volume={ov:.4}[origa];{new_chain};[origa][newa]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.98[aout]"
        ),
    }
}

fn is_video_copy_ok(ext: &str, codec: Option<&str>) -> bool {
    let c = codec.unwrap_or("").to_ascii_lowercase();
    match ext {
        "mp4" | "m4v" => matches!(c.as_str(), "h264" | "hevc" | "vp9" | "av1" | "mpeg4"),
        "mov" => matches!(c.as_str(), "h264" | "hevc" | "prores" | "mpeg4"),
        "mkv" => !c.is_empty(),
        "webm" => matches!(c.as_str(), "vp9" | "vp8" | "av1"),
        _ => false,
    }
}

/// Renders an instant browser-playable audio mix preview (up to 20s) matching exact current volume,
/// mode, and loop/play-once settings so users can audition before full video export.
pub fn preview_replace_audio_impl(
    media_root: &Path,
    preview_registry: &MediaPreviewRegistry,
    req: &PreviewReplaceAudioRequest,
) -> Result<PreviewReplaceAudioResult, AppError> {
    let (video_path, _) = validate_existing_input_file(&req.options.video_path)?;
    let (audio_path, _) = validate_existing_input_file(&req.options.audio_source_path)?;
    let tools = require_media_tools(media_root)?;

    let v_probe = probe_media_info_impl(media_root, &req.options.video_path)?;
    if !v_probe.has_video {
        return Err(AppError::invalid_param(
            "Target file does not contain a video stream.",
        ));
    }
    let a_probe = probe_media_info_impl(media_root, &req.options.audio_source_path)?;
    if a_probe.audio_streams.is_empty() {
        return Err(AppError::invalid_param(
            "Selected audio source does not contain any audio stream.",
        ));
    }

    let vid_dur = v_probe
        .video_streams
        .first()
        .and_then(|v| v.duration_sec)
        .or(v_probe.duration_sec)
        .filter(|d| d.is_finite() && *d > 0.0)
        .ok_or_else(|| AppError::decode_failed("Unable to determine target video duration."))?;

    let start_sec = req
        .start_sec
        .unwrap_or(0.0)
        .clamp(0.0, (vid_dur - 0.5).max(0.0));
    let preview_dur = req
        .max_duration_sec
        .unwrap_or(20.0)
        .clamp(1.0, 25.0)
        .min((vid_dur - start_sec).max(0.5));

    let effective_mode = if v_probe.has_audio {
        req.options.mode
    } else {
        ReplaceAudioMode::Replace
    };
    let track_idx = req
        .options
        .audio_source_track_index
        .min(a_probe.audio_streams.len().saturating_sub(1));

    let filter = build_replace_mix_filter(
        effective_mode,
        track_idx,
        req.options.original_volume,
        req.options.new_audio_volume,
        req.options.short_audio_behavior,
        preview_dur,
        start_sec,
    );

    let cache_dir = media_root.join(".preview-cache");
    fs::create_dir_all(&cache_dir)
        .map_err(|e| AppError::from_io(e, "Unable to create V14 preview cache"))?;
    let out_m4a = cache_dir.join(format!("v14-preview-{}.m4a", Uuid::new_v4()));

    let mut args: Vec<String> = vec!["-i".into(), video_path.to_string_lossy().to_string()];
    if req.options.short_audio_behavior == ShortAudioBehavior::LoopToFill {
        args.extend(["-stream_loop".into(), "-1".into()]);
    }
    args.extend([
        "-i".into(),
        audio_path.to_string_lossy().to_string(),
        "-filter_complex".into(),
        filter,
        "-vn".into(),
        "-map".into(),
        "[aout]".into(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "192k".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-f".into(),
        "ipod".into(),
        out_m4a.to_string_lossy().to_string(),
    ]);

    let cancel = AtomicBool::new(false);
    run_ffmpeg_cancellable(&tools.ffmpeg, &args, Some(preview_dur), &cancel, |_, _| {})?;
    let reg = preview_registry.register_path(&out_m4a.to_string_lossy())?;

    Ok(PreviewReplaceAudioResult {
        preview_url: reg.url,
        start_sec,
        preview_duration_sec: preview_dur,
        effective_mode,
    })
}

pub fn replace_video_audio_impl(
    media_root: &Path,
    req: &ReplaceAudioRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(MediaTaskProgressPayload),
) -> Result<ReplaceAudioResult, AppError> {
    let t0 = Instant::now();
    let (video_path, _) = validate_existing_input_file(&req.options.video_path)?;
    let (audio_path, _) = validate_existing_input_file(&req.options.audio_source_path)?;
    let out_path = PathBuf::from(req.output_path.trim());
    if !out_path.is_absolute() {
        return Err(AppError::invalid_param(
            "Output file path must be an absolute path.",
        ));
    }
    if paths_refer_to_same_location(&video_path, &out_path)
        || paths_refer_to_same_location(&audio_path, &out_path)
    {
        return Err(AppError::same_input_output());
    }

    let tools = require_media_tools(media_root)?;
    let v_probe = probe_media_info_impl(media_root, &req.options.video_path)?;
    let v0 = v_probe
        .video_streams
        .first()
        .ok_or_else(|| AppError::invalid_param("Target file does not contain a video stream."))?;
    let a_probe = probe_media_info_impl(media_root, &req.options.audio_source_path)?;
    if a_probe.audio_streams.is_empty() {
        return Err(AppError::invalid_param(
            "Selected audio source does not contain an audio stream.",
        ));
    }

    let vid_dur = v0
        .duration_sec
        .or(v_probe.duration_sec)
        .filter(|d| d.is_finite() && *d > 0.0)
        .ok_or_else(|| AppError::decode_failed("Unable to determine target video duration."))?;

    let effective_mode = if v_probe.has_audio {
        req.options.mode
    } else {
        ReplaceAudioMode::Replace
    };
    let track_idx = req
        .options
        .audio_source_track_index
        .min(a_probe.audio_streams.len().saturating_sub(1));

    let allow_overwrite = req.allow_overwrite.unwrap_or(false);
    let atomic = AtomicMediaOutput::prepare(out_path.clone(), &video_path, allow_overwrite)?;

    let filter = build_replace_mix_filter(
        effective_mode,
        track_idx,
        req.options.original_volume,
        req.options.new_audio_volume,
        req.options.short_audio_behavior,
        vid_dur,
        0.0,
    );

    let out_ext = out_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_else(|| "mp4".into());
    let copy_v = is_video_copy_ok(&out_ext, v0.codec_name.as_deref());

    let mut args: Vec<String> = vec!["-i".into(), video_path.to_string_lossy().to_string()];
    if req.options.short_audio_behavior == ShortAudioBehavior::LoopToFill {
        args.extend(["-stream_loop".into(), "-1".into()]);
    }
    args.extend([
        "-i".into(),
        audio_path.to_string_lossy().to_string(),
        "-filter_complex".into(),
        filter,
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        "[aout]".into(),
    ]);

    if copy_v {
        args.extend(["-c:v".into(), "copy".into()]);
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

    let muxer = match out_ext.as_str() {
        "mov" => "mov",
        "mkv" => "matroska",
        "webm" => "webm",
        _ => "mp4",
    };
    if muxer == "webm" {
        args.extend([
            "-c:a".into(),
            "libopus".into(),
            "-b:a".into(),
            "160k".into(),
        ]);
    } else {
        args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
    }
    if matches!(muxer, "mp4" | "mov") {
        args.extend(["-movflags".into(), "+faststart".into()]);
    }
    args.extend([
        "-t".into(),
        format!("{vid_dur:.6}"),
        "-f".into(),
        muxer.into(),
        atomic.temp_path().to_string_lossy().to_string(),
    ]);

    on_progress(MediaTaskProgressPayload {
        task_id: req.task_id.clone(),
        tool_id: "V14".into(),
        phase: "running".into(),
        current_item: 1,
        total_items: 1,
        item_name: Some(v_probe.file_name.clone()),
        percent: Some(0.0),
        out_time_sec: Some(0.0),
        total_duration_sec: Some(vid_dur),
    });

    run_ffmpeg_cancellable(
        &tools.ffmpeg,
        &args,
        Some(vid_dur),
        cancel_flag,
        |out_t, pct| {
            on_progress(MediaTaskProgressPayload {
                task_id: req.task_id.clone(),
                tool_id: "V14".into(),
                phase: "running".into(),
                current_item: 1,
                total_items: 1,
                item_name: Some(v_probe.file_name.clone()),
                percent: pct,
                out_time_sec: out_t,
                total_duration_sec: Some(vid_dur),
            });
        },
    )?;

    let (committed, byte_size) = atomic.commit(allow_overwrite)?;
    let out_probe = probe_media_info_impl(media_root, &committed.to_string_lossy()).ok();

    on_progress(MediaTaskProgressPayload {
        task_id: req.task_id.clone(),
        tool_id: "V14".into(),
        phase: "completed".into(),
        current_item: 1,
        total_items: 1,
        item_name: Some(v_probe.file_name),
        percent: Some(100.0),
        out_time_sec: Some(vid_dur),
        total_duration_sec: Some(vid_dur),
    });

    Ok(ReplaceAudioResult {
        output_path: committed.to_string_lossy().to_string(),
        byte_size,
        duration_sec: out_probe.as_ref().and_then(|p| p.duration_sec),
        video_stream_copied: copy_v,
        effective_mode,
        target_video_had_audio: v_probe.has_audio,
        has_output_audio: out_probe.as_ref().map(|p| p.has_audio).unwrap_or(true),
        elapsed_ms: t0.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;
    use std::process::{Command, Stdio};
    use tempfile::tempdir;

    fn decode_mono_16k(ffmpeg: &Path, path: &Path) -> Vec<f64> {
        let out = Command::new(ffmpeg)
            .args([
                "-v",
                "error",
                "-i",
                &path.to_string_lossy(),
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-f",
                "s16le",
                "pipe:1",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
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

    fn tone_energy(xs: &[f64], freq_hz: f64, sr: f64) -> f64 {
        let n = xs.len().min(4096);
        if n == 0 {
            return 0.0;
        }
        let w = 2.0 * PI * freq_hz / sr;
        let mut re = 0.0;
        let mut im = 0.0;
        for (i, &s) in xs[..n].iter().enumerate() {
            let a = w * (i as f64);
            re += s * a.cos();
            im += s * a.sin();
        }
        (re * re + im * im).sqrt() / (n as f64)
    }

    #[test]
    fn verifies_replace_mix_loop_play_once_video_source_and_silent_target() {
        let dir = tempdir().unwrap();
        let Ok(tools) = require_media_tools(dir.path()) else {
            return;
        };
        let cancel = AtomicBool::new(false);

        // Target video: 4.0s with 440 Hz original audio (black [0..2], white flash [2..2.5], black [2.5..4])
        let target_vid = dir.path().join("target_440_4s.mp4");
        run_ffmpeg_cancellable(
            &tools.ffmpeg,
            &[
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "color=c=black:s=320x180:r=25:d=2.0".into(),
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "color=c=white:s=320x180:r=25:d=0.5".into(),
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "color=c=black:s=320x180:r=25:d=1.5".into(),
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "sine=frequency=440:sample_rate=48000:duration=4.0".into(),
                "-filter_complex".into(),
                "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v];[3:a]volume=4[a]".into(),
                "-map".into(),
                "[v]".into(),
                "-map".into(),
                "[a]".into(),
                "-c:v".into(),
                "libx264".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
                "-c:a".into(),
                "aac".into(),
                target_vid.to_string_lossy().to_string(),
            ],
            Some(4.0),
            &cancel,
            |_, _| {},
        )
        .unwrap();

        // Short 1.2s 880 Hz audio inside ANOTHER VIDEO file (tests picking audio from video!)
        let short_donor_vid = dir.path().join("donor_880_1p2s.mp4");
        run_ffmpeg_cancellable(
            &tools.ffmpeg,
            &[
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "color=c=green:s=160x90:r=25:d=1.2".into(),
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "sine=frequency=880:sample_rate=48000:duration=1.2".into(),
                "-af".into(),
                "volume=4".into(),
                "-c:v".into(),
                "libx264".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
                "-c:a".into(),
                "aac".into(),
                short_donor_vid.to_string_lossy().to_string(),
            ],
            Some(1.2),
            &cancel,
            |_, _| {},
        )
        .unwrap();

        // 1. Replace + LoopToFill -> 4.0s with continuous 880 Hz across seam and zero 440 Hz
        let out_rep = dir.path().join("replaced_loop.mp4");
        let r_rep = replace_video_audio_impl(
            dir.path(),
            &ReplaceAudioRequest {
                task_id: "v14-rep".into(),
                options: ReplaceAudioOptions {
                    video_path: target_vid.to_string_lossy().to_string(),
                    audio_source_path: short_donor_vid.to_string_lossy().to_string(),
                    audio_source_track_index: 0,
                    mode: ReplaceAudioMode::Replace,
                    original_volume: 1.0,
                    new_audio_volume: 1.0,
                    short_audio_behavior: ShortAudioBehavior::LoopToFill,
                },
                output_path: out_rep.to_string_lossy().to_string(),
                allow_overwrite: Some(false),
            },
            &cancel,
            |_| {},
        )
        .unwrap();
        assert!(r_rep.video_stream_copied);
        assert!((r_rep.duration_sec.unwrap() - 4.0).abs() < 0.15);
        let pcm_rep = decode_mono_16k(&tools.ffmpeg, &out_rep);
        // Check before seam (0.5s) and after seam (2.6s) -> both strong 880 Hz, near-zero 440 Hz
        for offset in [8000usize, 41600usize] {
            let seg = &pcm_rep[offset..offset + 4096];
            assert!(tone_energy(seg, 880.0, 16000.0) > 0.10);
            assert!(tone_energy(seg, 440.0, 16000.0) < 0.01);
        }

        // 2. Mix + PlayOnce -> [0.3..0.8s] has BOTH 440 & 880; [2.5..3.0s] has steady 440 only (no volume jump!)
        let out_mix = dir.path().join("mixed_once.mp4");
        let r_mix = replace_video_audio_impl(
            dir.path(),
            &ReplaceAudioRequest {
                task_id: "v14-mix".into(),
                options: ReplaceAudioOptions {
                    video_path: target_vid.to_string_lossy().to_string(),
                    audio_source_path: short_donor_vid.to_string_lossy().to_string(),
                    audio_source_track_index: 0,
                    mode: ReplaceAudioMode::Mix,
                    original_volume: 0.8,
                    new_audio_volume: 0.8,
                    short_audio_behavior: ShortAudioBehavior::PlayOnce,
                },
                output_path: out_mix.to_string_lossy().to_string(),
                allow_overwrite: Some(false),
            },
            &cancel,
            |_| {},
        )
        .unwrap();
        assert!(r_mix.video_stream_copied);
        let pcm_mix = decode_mono_16k(&tools.ffmpeg, &out_mix);
        let early = &pcm_mix[4800..8896];
        let late = &pcm_mix[40000..44096];
        let e440_early = tone_energy(early, 440.0, 16000.0);
        let e880_early = tone_energy(early, 880.0, 16000.0);
        let e440_late = tone_energy(late, 440.0, 16000.0);
        let e880_late = tone_energy(late, 880.0, 16000.0);
        assert!(
            e440_early > 0.08 && e880_early > 0.08,
            "early mix expected both 440 & 880"
        );
        assert!(
            e880_late < 0.01,
            "880 Hz should stop after 1.2s PlayOnce, got {e880_late}"
        );
        assert!(
            (e440_late - e440_early).abs() < 0.04,
            "440 Hz original volume must stay steady without jump: early={e440_early:.3}, late={e440_late:.3}"
        );

        // 3. Silent target video works seamlessly
        let silent_vid = dir.path().join("silent_vid.mp4");
        run_ffmpeg_cancellable(
            &tools.ffmpeg,
            &[
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "color=c=red:s=320x180:r=25:d=2.0".into(),
                "-c:v".into(),
                "libx264".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
                silent_vid.to_string_lossy().to_string(),
            ],
            Some(2.0),
            &cancel,
            |_, _| {},
        )
        .unwrap();
        let silent_dubbed = dir.path().join("silent_dubbed.mp4");
        let r_sil = replace_video_audio_impl(
            dir.path(),
            &ReplaceAudioRequest {
                task_id: "v14-silent".into(),
                options: ReplaceAudioOptions {
                    video_path: silent_vid.to_string_lossy().to_string(),
                    audio_source_path: short_donor_vid.to_string_lossy().to_string(),
                    audio_source_track_index: 0,
                    mode: ReplaceAudioMode::Mix,
                    original_volume: 1.0,
                    new_audio_volume: 1.0,
                    short_audio_behavior: ShortAudioBehavior::LoopToFill,
                },
                output_path: silent_dubbed.to_string_lossy().to_string(),
                allow_overwrite: Some(false),
            },
            &cancel,
            |_| {},
        )
        .unwrap();
        assert!(!r_sil.target_video_had_audio);
        assert!(r_sil.has_output_audio);
        assert_eq!(r_sil.effective_mode, ReplaceAudioMode::Replace);
    }
}
