//! V03 Change Speed — single and batch video speed adjustment from 0.25x to 4.0x
//! with default pitch preservation (chained `atempo` filters), optional mute,
//! accurate A/V synchronization, and seamless handling of silent (no-audio) clips.

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

pub const MIN_SPEED_FACTOR: f64 = 0.25;
pub const MAX_SPEED_FACTOR: f64 = 4.0;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeVideoSpeedBatchRequest {
    pub task_id: String,
    pub source_paths: Vec<String>,
    pub output_dir: String,
    pub speed_factor: f64,
    pub preserve_pitch: Option<bool>,
    pub mute_audio: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeedItemStatus {
    Completed,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeVideoSpeedItemResult {
    pub source_path: String,
    pub file_name: String,
    pub status: SpeedItemStatus,
    pub output_path: Option<String>,
    pub output_bytes: Option<u64>,
    pub source_duration_sec: Option<f64>,
    pub output_duration_sec: Option<f64>,
    pub has_output_audio: bool,
    pub speed_factor: f64,
    pub elapsed_ms: u64,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeVideoSpeedBatchResponse {
    pub task_id: String,
    pub output_dir: String,
    pub speed_factor: f64,
    pub cancelled: bool,
    pub completed_count: usize,
    pub skipped_count: usize,
    pub failed_count: usize,
    pub elapsed_ms: u64,
    pub items: Vec<ChangeVideoSpeedItemResult>,
}

/// Builds a chained FFmpeg `atempo` filter string where every individual stage stays within
/// `[0.5, 2.0]` for maximum cross-build compatibility and clean WSOLA pitch preservation.
pub fn build_atempo_filter_chain(speed: f64) -> String {
    let mut rem = speed.clamp(MIN_SPEED_FACTOR, MAX_SPEED_FACTOR);
    let mut stages: Vec<String> = Vec::new();
    while rem < 0.5 - 1e-6 {
        stages.push("atempo=0.5".to_string());
        rem /= 0.5;
    }
    while rem > 2.0 + 1e-6 {
        stages.push("atempo=2.0".to_string());
        rem /= 2.0;
    }
    if stages.is_empty() || (rem - 1.0).abs() > 1e-5 {
        stages.push(format!("atempo={rem:.6}"));
    }
    format!("asetpts=PTS-STARTPTS,{}", stages.join(","))
}

fn format_speed_tag(speed: f64) -> String {
    let s = format!("{speed:.2}");
    let trimmed = s.trim_end_matches('0').trim_end_matches('.');
    format!("_{}x", trimmed.replace('.', "p"))
}

pub fn change_video_speed_batch_impl(
    media_root: &Path,
    req: &ChangeVideoSpeedBatchRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(MediaTaskProgressPayload),
) -> Result<ChangeVideoSpeedBatchResponse, AppError> {
    let t0 = Instant::now();
    if req.source_paths.is_empty() {
        return Err(AppError::invalid_param(
            "Select at least one video file to change speed.",
        ));
    }
    if !req.speed_factor.is_finite()
        || req.speed_factor < MIN_SPEED_FACTOR - 1e-6
        || req.speed_factor > MAX_SPEED_FACTOR + 1e-6
    {
        return Err(AppError::invalid_param(format!(
            "Speed factor must be between {MIN_SPEED_FACTOR}x and {MAX_SPEED_FACTOR}x."
        )));
    }
    let speed = req.speed_factor.clamp(MIN_SPEED_FACTOR, MAX_SPEED_FACTOR);
    let preserve_pitch = req.preserve_pitch.unwrap_or(true);
    let mute_audio = req.mute_audio.unwrap_or(false);

    let out_dir = PathBuf::from(req.output_dir.trim());
    if !out_dir.is_absolute() {
        return Err(AppError::invalid_param(
            "Output directory must be an absolute path.",
        ));
    }

    let tools = require_media_tools(media_root)?;
    let total = req.source_paths.len();
    let suffix = format_speed_tag(speed);

    let mut results = Vec::with_capacity(total);
    let mut completed_count = 0usize;
    let mut skipped_count = 0usize;
    let mut failed_count = 0usize;
    let mut cancelled = false;

    for (idx, raw_src) in req.source_paths.iter().enumerate() {
        let item_t0 = Instant::now();
        let fallback_name = Path::new(raw_src)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(raw_src)
            .to_string();

        if cancel_flag.load(Ordering::Relaxed) {
            cancelled = true;
            skipped_count += 1;
            results.push(ChangeVideoSpeedItemResult {
                source_path: raw_src.clone(),
                file_name: fallback_name,
                status: SpeedItemStatus::Skipped,
                output_path: None,
                output_bytes: None,
                source_duration_sec: None,
                output_duration_sec: None,
                has_output_audio: false,
                speed_factor: speed,
                elapsed_ms: 0,
                message: Some("Cancelled before processing.".into()),
            });
            continue;
        }

        let (source_path, _) = match validate_existing_input_file(raw_src) {
            Ok(v) => v,
            Err(err) => {
                failed_count += 1;
                results.push(ChangeVideoSpeedItemResult {
                    source_path: raw_src.clone(),
                    file_name: fallback_name,
                    status: SpeedItemStatus::Failed,
                    output_path: None,
                    output_bytes: None,
                    source_duration_sec: None,
                    output_duration_sec: None,
                    has_output_audio: false,
                    speed_factor: speed,
                    elapsed_ms: item_t0.elapsed().as_millis() as u64,
                    message: Some(err.message),
                });
                continue;
            }
        };

        let probe = match probe_media_info_impl(media_root, raw_src) {
            Ok(p) => p,
            Err(err) => {
                failed_count += 1;
                results.push(ChangeVideoSpeedItemResult {
                    source_path: raw_src.clone(),
                    file_name: fallback_name,
                    status: SpeedItemStatus::Failed,
                    output_path: None,
                    output_bytes: None,
                    source_duration_sec: None,
                    output_duration_sec: None,
                    has_output_audio: false,
                    speed_factor: speed,
                    elapsed_ms: item_t0.elapsed().as_millis() as u64,
                    message: Some(err.message),
                });
                continue;
            }
        };

        if !probe.has_video {
            failed_count += 1;
            results.push(ChangeVideoSpeedItemResult {
                source_path: raw_src.clone(),
                file_name: probe.file_name,
                status: SpeedItemStatus::Failed,
                output_path: None,
                output_bytes: None,
                source_duration_sec: probe.duration_sec,
                output_duration_sec: None,
                has_output_audio: false,
                speed_factor: speed,
                elapsed_ms: item_t0.elapsed().as_millis() as u64,
                message: Some("File contains no video stream.".into()),
            });
            continue;
        }

        let stem = source_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("video");
        let target_path = match allocate_non_colliding_output_path(
            &out_dir,
            stem,
            &suffix,
            "mp4",
            &source_path,
        ) {
            Ok(p) => p,
            Err(err) => {
                failed_count += 1;
                results.push(ChangeVideoSpeedItemResult {
                    source_path: raw_src.clone(),
                    file_name: probe.file_name,
                    status: SpeedItemStatus::Failed,
                    output_path: None,
                    output_bytes: None,
                    source_duration_sec: probe.duration_sec,
                    output_duration_sec: None,
                    has_output_audio: false,
                    speed_factor: speed,
                    elapsed_ms: item_t0.elapsed().as_millis() as u64,
                    message: Some(err.message),
                });
                continue;
            }
        };

        let atomic = match AtomicMediaOutput::prepare(target_path, &source_path, false) {
            Ok(a) => a,
            Err(err) => {
                failed_count += 1;
                results.push(ChangeVideoSpeedItemResult {
                    source_path: raw_src.clone(),
                    file_name: probe.file_name,
                    status: SpeedItemStatus::Failed,
                    output_path: None,
                    output_bytes: None,
                    source_duration_sec: probe.duration_sec,
                    output_duration_sec: None,
                    has_output_audio: false,
                    speed_factor: speed,
                    elapsed_ms: item_t0.elapsed().as_millis() as u64,
                    message: Some(err.message),
                });
                continue;
            }
        };

        let include_audio = probe.has_audio && !mute_audio;
        let expected_dur = probe.duration_sec.map(|d| d / speed);
        let src_fps = probe
            .video_streams
            .first()
            .and_then(|v| v.avg_frame_rate.or(v.r_frame_rate))
            .filter(|f| f.is_finite() && *f > 1.0)
            .unwrap_or(30.0);
        // Keep output frame rate smooth and player-friendly (e.g. 24..60 fps) while preserving exact timestamps
        let out_fps = src_fps.clamp(24.0, 60.0);
        let vf = format!(
            "setpts=(PTS-STARTPTS)/{speed:.6},fps={out_fps:.3},scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1"
        );

        let mut args: Vec<String> = vec![
            "-i".into(),
            source_path.to_string_lossy().to_string(),
            "-map".into(),
            "0:v:0".into(),
            "-vf".into(),
            vf,
            "-c:v".into(),
            "libx264".into(),
            "-crf".into(),
            "20".into(),
            "-preset".into(),
            "medium".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-metadata:s:v:0".into(),
            "rotate=0".into(),
        ];

        if include_audio {
            let sr = probe
                .audio_streams
                .first()
                .and_then(|a| a.sample_rate_hz)
                .filter(|&r| (8_000..=192_000).contains(&r))
                .unwrap_or(48_000);
            let af = if preserve_pitch {
                build_atempo_filter_chain(speed)
            } else {
                let shifted_sr = ((f64::from(sr) * speed).round() as u32).clamp(4_000, 384_000);
                format!("asetpts=PTS-STARTPTS,asetrate={shifted_sr},aresample={sr}")
            };
            args.extend([
                "-map".into(),
                "0:a:0".into(),
                "-af".into(),
                af,
                "-c:a".into(),
                "aac".into(),
                "-b:a".into(),
                "160k".into(),
            ]);
        } else {
            args.push("-an".into());
        }

        args.extend([
            "-f".into(),
            "mp4".into(),
            "-movflags".into(),
            "+faststart".into(),
            atomic.temp_path().to_string_lossy().to_string(),
        ]);

        let item_name = probe.file_name.clone();
        on_progress(MediaTaskProgressPayload {
            task_id: req.task_id.clone(),
            tool_id: "V03".into(),
            phase: "running".into(),
            current_item: idx + 1,
            total_items: total,
            item_name: Some(item_name.clone()),
            percent: Some(((idx as f64) / (total as f64) * 100.0).clamp(0.0, 99.0)),
            out_time_sec: Some(0.0),
            total_duration_sec: expected_dur,
        });

        let exec_res = run_ffmpeg_cancellable(
            &tools.ffmpeg,
            &args,
            expected_dur,
            cancel_flag,
            |out_t, ip| {
                let overall = ip.map(|p| {
                    (((idx as f64) + (p / 100.0)) / (total as f64) * 100.0).clamp(0.0, 99.0)
                });
                on_progress(MediaTaskProgressPayload {
                    task_id: req.task_id.clone(),
                    tool_id: "V03".into(),
                    phase: "running".into(),
                    current_item: idx + 1,
                    total_items: total,
                    item_name: Some(item_name.clone()),
                    percent: overall,
                    out_time_sec: out_t,
                    total_duration_sec: expected_dur,
                });
            },
        );

        match exec_res {
            Ok(()) => match atomic.commit(false) {
                Ok((final_path, byte_size)) => {
                    let final_str = final_path.to_string_lossy().to_string();
                    let verified = probe_media_info_impl(media_root, &final_str).ok();
                    completed_count += 1;
                    results.push(ChangeVideoSpeedItemResult {
                        source_path: raw_src.clone(),
                        file_name: probe.file_name,
                        status: SpeedItemStatus::Completed,
                        output_path: Some(final_str),
                        output_bytes: Some(byte_size),
                        source_duration_sec: probe.duration_sec,
                        output_duration_sec: verified
                            .as_ref()
                            .and_then(|v| v.duration_sec)
                            .or(expected_dur),
                        has_output_audio: verified
                            .as_ref()
                            .map(|v| v.has_audio)
                            .unwrap_or(include_audio),
                        speed_factor: speed,
                        elapsed_ms: item_t0.elapsed().as_millis() as u64,
                        message: None,
                    });
                }
                Err(err) => {
                    failed_count += 1;
                    results.push(ChangeVideoSpeedItemResult {
                        source_path: raw_src.clone(),
                        file_name: probe.file_name,
                        status: SpeedItemStatus::Failed,
                        output_path: None,
                        output_bytes: None,
                        source_duration_sec: probe.duration_sec,
                        output_duration_sec: None,
                        has_output_audio: false,
                        speed_factor: speed,
                        elapsed_ms: item_t0.elapsed().as_millis() as u64,
                        message: Some(err.message),
                    });
                }
            },
            Err(err) if err.code == "TASK_CANCELLED" => {
                drop(atomic);
                cancelled = true;
                skipped_count += 1;
                results.push(ChangeVideoSpeedItemResult {
                    source_path: raw_src.clone(),
                    file_name: probe.file_name,
                    status: SpeedItemStatus::Skipped,
                    output_path: None,
                    output_bytes: None,
                    source_duration_sec: probe.duration_sec,
                    output_duration_sec: None,
                    has_output_audio: false,
                    speed_factor: speed,
                    elapsed_ms: item_t0.elapsed().as_millis() as u64,
                    message: Some("Cancelled during speed change.".into()),
                });
            }
            Err(err) => {
                drop(atomic);
                failed_count += 1;
                results.push(ChangeVideoSpeedItemResult {
                    source_path: raw_src.clone(),
                    file_name: probe.file_name,
                    status: SpeedItemStatus::Failed,
                    output_path: None,
                    output_bytes: None,
                    source_duration_sec: probe.duration_sec,
                    output_duration_sec: None,
                    has_output_audio: false,
                    speed_factor: speed,
                    elapsed_ms: item_t0.elapsed().as_millis() as u64,
                    message: Some(err.message),
                });
            }
        }
    }

    on_progress(MediaTaskProgressPayload {
        task_id: req.task_id.clone(),
        tool_id: "V03".into(),
        phase: if cancelled { "cancelled" } else { "completed" }.into(),
        current_item: total,
        total_items: total,
        item_name: None,
        percent: Some(100.0),
        out_time_sec: None,
        total_duration_sec: None,
    });

    Ok(ChangeVideoSpeedBatchResponse {
        task_id: req.task_id.clone(),
        output_dir: out_dir.to_string_lossy().to_string(),
        speed_factor: speed,
        cancelled,
        completed_count,
        skipped_count,
        failed_count,
        elapsed_ms: t0.elapsed().as_millis() as u64,
        items: results,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;
    use std::process::{Command, Stdio};
    use tempfile::tempdir;

    #[test]
    fn builds_chained_atempo_within_valid_bounds_for_extreme_speeds() {
        assert_eq!(
            build_atempo_filter_chain(0.25),
            "asetpts=PTS-STARTPTS,atempo=0.5,atempo=0.500000"
        );
        assert_eq!(
            build_atempo_filter_chain(4.0),
            "asetpts=PTS-STARTPTS,atempo=2.0,atempo=2.000000"
        );
        assert_eq!(
            build_atempo_filter_chain(2.0),
            "asetpts=PTS-STARTPTS,atempo=2.000000"
        );
    }

    fn decode_pcm_mono_16k(ffmpeg: &Path, media_path: &Path) -> Vec<f64> {
        let out = Command::new(ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                &media_path.to_string_lossy(),
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
            .map(|c| i16::from_le_bytes([c[0], c[1]]) as f64 / 32768.0)
            .collect()
    }

    /// Computes dominant frequency (Hz) in a PCM window via Goertzel/DFT scan across 200..1200 Hz.
    fn dominant_freq_hz(samples: &[f64], sr: f64) -> f64 {
        let n = samples.len().min(4096);
        let mut best_f = 0.0;
        let mut best_mag = -1.0;
        for f_int in (200..=1200).step_by(5) {
            let f = f_int as f64;
            let w = 2.0 * PI * f / sr;
            let mut re = 0.0;
            let mut im = 0.0;
            for (i, &s) in samples.iter().take(n).enumerate() {
                let angle = w * (i as f64);
                re += s * angle.cos();
                im -= s * angle.sin();
            }
            let mag = re * re + im * im;
            if mag > best_mag {
                best_mag = mag;
                best_f = f;
            }
        }
        best_f
    }

    #[test]
    fn verifies_025x_05x_2x_4x_duration_pitch_preservation_av_sync_and_silent_clip() {
        let dir = tempdir().unwrap();
        let Ok(tools) = require_media_tools(dir.path()) else {
            return;
        };
        let cancel = AtomicBool::new(false);

        // Build 4.0s clip: [0..2.0s] dark + silent, [2.0..2.5s] WHITE FLASH + 440 Hz beep, [2.5..4.0s] dark + silent
        let sync_clip = dir.path().join("flash_beep_4s.mp4");
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
                "anullsrc=r=48000:cl=stereo:d=2.0".into(),
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "sine=frequency=440:sample_rate=48000:duration=0.5".into(),
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "anullsrc=r=48000:cl=stereo:d=1.5".into(),
                "-filter_complex".into(),
                "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v];[4:a]aformat=channel_layouts=stereo,volume=6[beep];[3:a][beep][5:a]concat=n=3:v=0:a=1[a]".into(),
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
                "-b:a".into(),
                "128k".into(),
                sync_clip.to_string_lossy().to_string(),
            ],
            Some(4.0),
            &cancel,
            |_, _| {},
        )
        .unwrap();

        let out_dir = dir.path().join("speed_out");
        for speed in [0.5, 2.0, 0.25, 4.0] {
            let res = change_video_speed_batch_impl(
                dir.path(),
                &ChangeVideoSpeedBatchRequest {
                    task_id: format!("v03-{speed}"),
                    source_paths: vec![sync_clip.to_string_lossy().to_string()],
                    output_dir: out_dir.to_string_lossy().to_string(),
                    speed_factor: speed,
                    preserve_pitch: Some(true),
                    mute_audio: Some(false),
                },
                &cancel,
                |_| {},
            )
            .unwrap();
            assert_eq!(res.completed_count, 1);
            let item = &res.items[0];
            let expected_dur = 4.0 / speed;
            let got_dur = item.output_duration_sec.unwrap();
            assert!(
                (got_dur - expected_dur).abs() < 0.25,
                "speed {speed}x: expected dur {expected_dur}, got {got_dur}"
            );

            let out_path = PathBuf::from(item.output_path.as_ref().unwrap());
            let pcm = decode_pcm_mono_16k(&tools.ffmpeg, &out_path);
            // Locate center of audio beep energy (threshold > 0.15)
            let active_indices: Vec<usize> = pcm
                .iter()
                .enumerate()
                .filter_map(|(i, &s)| if s.abs() > 0.15 { Some(i) } else { None })
                .collect();
            assert!(!active_indices.is_empty(), "No beep found at {speed}x");
            let beep_start_sec = active_indices[0] as f64 / 16000.0;
            let beep_mid = (active_indices[0] + *active_indices.last().unwrap()) / 2;
            let expected_beep_start = 2.0 / speed;
            assert!(
                (beep_start_sec - expected_beep_start).abs() < 0.18,
                "speed {speed}x: beep start {beep_start_sec:.3}s vs expected {expected_beep_start:.3}s"
            );

            // Check pitch preserved near 440 Hz
            let win_start = beep_mid.saturating_sub(512);
            let win_end = (win_start + 2048).min(pcm.len());
            let freq = dominant_freq_hz(&pcm[win_start..win_end], 16000.0);
            assert!(
                (freq - 440.0).abs() <= 25.0,
                "speed {speed}x: expected ~440 Hz pitch preserved, got {freq} Hz"
            );

            // Verify video white flash is present at expected midpoint (2.25 / speed)
            let flash_mid = 2.25 / speed;
            let flash_png = dir.path().join(format!("flash_{speed}.png"));
            run_ffmpeg_cancellable(
                &tools.ffmpeg,
                &[
                    "-ss".into(),
                    format!("{flash_mid:.3}"),
                    "-i".into(),
                    out_path.to_string_lossy().to_string(),
                    "-frames:v".into(),
                    "1".into(),
                    flash_png.to_string_lossy().to_string(),
                ],
                None,
                &cancel,
                |_, _| {},
            )
            .unwrap();
            let px = image::open(&flash_png)
                .unwrap()
                .to_rgb8()
                .get_pixel(160, 90)
                .0;
            assert!(
                px[0] > 200 && px[1] > 200 && px[2] > 200,
                "speed {speed}x: expected white flash at {flash_mid:.3}s, got {px:?}"
            );
        }

        // Silent clip speed change must also succeed cleanly
        let silent = dir.path().join("silent_2s.mp4");
        run_ffmpeg_cancellable(
            &tools.ffmpeg,
            &[
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "testsrc2=size=320x180:rate=25:duration=2".into(),
                "-c:v".into(),
                "libx264".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
                silent.to_string_lossy().to_string(),
            ],
            Some(2.0),
            &cancel,
            |_, _| {},
        )
        .unwrap();
        let res_silent = change_video_speed_batch_impl(
            dir.path(),
            &ChangeVideoSpeedBatchRequest {
                task_id: "v03-silent".into(),
                source_paths: vec![silent.to_string_lossy().to_string()],
                output_dir: out_dir.to_string_lossy().to_string(),
                speed_factor: 2.0,
                preserve_pitch: Some(true),
                mute_audio: Some(false),
            },
            &cancel,
            |_| {},
        )
        .unwrap();
        assert_eq!(res_silent.completed_count, 1);
        assert!(!res_silent.items[0].has_output_audio);
        assert!((res_silent.items[0].output_duration_sec.unwrap() - 1.0).abs() < 0.15);
    }
}
