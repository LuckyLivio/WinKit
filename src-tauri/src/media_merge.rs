//! V12 Merge Videos — concatenates two or more video clips into a single H.264 MP4
//! in user-specified order, with automatic resolution normalization (match first clip
//! or target preset), proportional letterboxing for mixed landscape/portrait clips,
//! and exact silence synthesis for silent middle/outer clips so audio always stays synced.

use crate::error::AppError;
use crate::fs_guard::validate_existing_input_file;
use crate::media_core::{
    require_media_tools, run_ffmpeg_cancellable, AtomicMediaOutput, MediaTaskProgressPayload,
};
use crate::media_info::probe_media_info_impl;
use crate::media_resize::make_even_dim;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MergeResolutionPreset {
    MatchFirst,
    P1080,
    P720,
    Vertical1080,
    Square1080,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MergeFitMode {
    Pad,
    Fill,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeVideosRequest {
    pub task_id: String,
    pub source_paths: Vec<String>,
    pub output_path: String,
    pub resolution_preset: MergeResolutionPreset,
    pub fit_mode: Option<MergeFitMode>,
    pub allow_overwrite: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeVideosResult {
    pub output_path: String,
    pub byte_size: u64,
    pub clip_count: usize,
    pub output_width: u32,
    pub output_height: u32,
    pub output_duration_sec: Option<f64>,
    pub has_audio: bool,
    pub elapsed_ms: u64,
}

struct MergeClipSpec {
    path: PathBuf,
    display_width: u32,
    display_height: u32,
    duration_sec: f64,
    has_audio: bool,
    fps: f64,
}

pub fn resolve_merge_target_dimensions(
    first_w: u32,
    first_h: u32,
    preset: MergeResolutionPreset,
) -> (u32, u32) {
    match preset {
        MergeResolutionPreset::MatchFirst => (
            make_even_dim(f64::from(first_w.max(16))),
            make_even_dim(f64::from(first_h.max(16))),
        ),
        MergeResolutionPreset::P1080 => (1920, 1080),
        MergeResolutionPreset::P720 => (1280, 720),
        MergeResolutionPreset::Vertical1080 => (1080, 1920),
        MergeResolutionPreset::Square1080 => (1080, 1080),
    }
}

pub fn merge_videos_impl(
    media_root: &Path,
    req: &MergeVideosRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(MediaTaskProgressPayload),
) -> Result<MergeVideosResult, AppError> {
    let t0 = Instant::now();
    if req.source_paths.len() < 2 {
        return Err(AppError::invalid_param(
            "Select at least two video clips to merge.",
        ));
    }
    let out_path = PathBuf::from(req.output_path.trim());
    if !out_path.is_absolute() {
        return Err(AppError::invalid_param(
            "Output file path must be an absolute path.",
        ));
    }

    let tools = require_media_tools(media_root)?;
    let mut clips: Vec<MergeClipSpec> = Vec::with_capacity(req.source_paths.len());

    for raw_src in &req.source_paths {
        let (path, _) = validate_existing_input_file(raw_src)?;
        let probe = probe_media_info_impl(media_root, raw_src)?;
        let v0 = probe.video_streams.first().ok_or_else(|| {
            AppError::invalid_param(format!(
                "Clip '{}' does not contain a video stream.",
                probe.file_name
            ))
        })?;
        let disp_w = v0.display_width.or(v0.coded_width).unwrap_or(1280);
        let disp_h = v0.display_height.or(v0.coded_height).unwrap_or(720);
        let dur = v0
            .duration_sec
            .or(probe.duration_sec)
            .filter(|d| d.is_finite() && *d > 0.0)
            .unwrap_or(1.0);
        let fps = v0
            .avg_frame_rate
            .or(v0.r_frame_rate)
            .filter(|f| f.is_finite() && *f > 1.0)
            .unwrap_or(30.0);
        clips.push(MergeClipSpec {
            path,
            display_width: disp_w,
            display_height: disp_h,
            duration_sec: dur,
            has_audio: probe.has_audio,
            fps,
        });
    }

    // Ensure output never overwrites ANY of the input clips
    let allow_overwrite = req.allow_overwrite.unwrap_or(false);
    for clip in &clips {
        if crate::fs_guard::paths_refer_to_same_location(&clip.path, &out_path) {
            return Err(AppError::same_input_output());
        }
    }
    let atomic = AtomicMediaOutput::prepare(out_path, &clips[0].path, allow_overwrite)?;

    let (target_w, target_h) = resolve_merge_target_dimensions(
        clips[0].display_width,
        clips[0].display_height,
        req.resolution_preset,
    );
    let target_fps = clips[0].fps.clamp(24.0, 60.0);
    let fit_mode = req.fit_mode.unwrap_or(MergeFitMode::Pad);
    let any_audio = clips.iter().any(|c| c.has_audio);
    let total_dur: f64 = clips.iter().map(|c| c.duration_sec).sum();

    let mut args: Vec<String> = Vec::new();
    for clip in &clips {
        args.push("-i".into());
        args.push(clip.path.to_string_lossy().to_string());
    }

    let mut filter_parts: Vec<String> = Vec::new();
    let mut concat_inputs = String::new();

    for (i, clip) in clips.iter().enumerate() {
        let v_scale = match fit_mode {
            MergeFitMode::Pad => format!(
                "[{i}:v]scale={target_w}:{target_h}:force_original_aspect_ratio=decrease:flags=lanczos,pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps={target_fps:.3},format=yuv420p,setpts=PTS-STARTPTS[v{i}]"
            ),
            MergeFitMode::Fill => format!(
                "[{i}:v]scale={target_w}:{target_h}:force_original_aspect_ratio=increase:flags=lanczos,crop={target_w}:{target_h},setsar=1,fps={target_fps:.3},format=yuv420p,setpts=PTS-STARTPTS[v{i}]"
            ),
        };
        filter_parts.push(v_scale);

        if any_audio {
            if clip.has_audio {
                // Pad short trailing audio gaps with silence & trim to exact video duration so
                // subsequent segments stay tightly synchronized across seams.
                filter_parts.push(format!(
                    "[{i}:a:0]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aresample=async=1:first_pts=0,apad,atrim=0:{:.6},asetpts=PTS-STARTPTS[a{i}]",
                    clip.duration_sec
                ));
            } else {
                // Synthesize pure silence matching the silent segment's exact duration
                filter_parts.push(format!(
                    "anullsrc=r=48000:cl=stereo,atrim=0:{:.6},asetpts=PTS-STARTPTS[a{i}]",
                    clip.duration_sec
                ));
            }
            concat_inputs.push_str(&format!("[v{i}][a{i}]"));
        } else {
            concat_inputs.push_str(&format!("[v{i}]"));
        }
    }

    let n = clips.len();
    if any_audio {
        filter_parts.push(format!("{concat_inputs}concat=n={n}:v=1:a=1[vout][aout]"));
    } else {
        filter_parts.push(format!("{concat_inputs}concat=n={n}:v=1:a=0[vout]"));
    }

    let filter_complex = filter_parts.join(";");
    args.extend([
        "-filter_complex".into(),
        filter_complex,
        "-map".into(),
        "[vout]".into(),
    ]);
    if any_audio {
        args.extend([
            "-map".into(),
            "[aout]".into(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "192k".into(),
        ]);
    } else {
        args.push("-an".into());
    }
    args.extend([
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
        "-f".into(),
        "mp4".into(),
        "-movflags".into(),
        "+faststart".into(),
        atomic.temp_path().to_string_lossy().to_string(),
    ]);

    on_progress(MediaTaskProgressPayload {
        task_id: req.task_id.clone(),
        tool_id: "V12".into(),
        phase: "running".into(),
        current_item: 1,
        total_items: n,
        item_name: Some(format!("{n} clips")),
        percent: Some(0.0),
        out_time_sec: Some(0.0),
        total_duration_sec: Some(total_dur),
    });

    run_ffmpeg_cancellable(
        &tools.ffmpeg,
        &args,
        Some(total_dur),
        cancel_flag,
        |out_t, pct| {
            on_progress(MediaTaskProgressPayload {
                task_id: req.task_id.clone(),
                tool_id: "V12".into(),
                phase: "running".into(),
                current_item: 1,
                total_items: n,
                item_name: Some(format!("{n} clips")),
                percent: pct,
                out_time_sec: out_t,
                total_duration_sec: Some(total_dur),
            });
        },
    )?;

    let (final_path, byte_size) = atomic.commit(allow_overwrite)?;
    let final_str = final_path.to_string_lossy().to_string();
    let verified = probe_media_info_impl(media_root, &final_str).ok();
    let ov = verified.as_ref().and_then(|v| v.video_streams.first());

    on_progress(MediaTaskProgressPayload {
        task_id: req.task_id.clone(),
        tool_id: "V12".into(),
        phase: "completed".into(),
        current_item: n,
        total_items: n,
        item_name: None,
        percent: Some(100.0),
        out_time_sec: Some(total_dur),
        total_duration_sec: Some(total_dur),
    });

    Ok(MergeVideosResult {
        output_path: final_str,
        byte_size,
        clip_count: n,
        output_width: ov.and_then(|v| v.display_width).unwrap_or(target_w),
        output_height: ov.and_then(|v| v.display_height).unwrap_or(target_h),
        output_duration_sec: verified
            .as_ref()
            .and_then(|v| v.duration_sec)
            .or(Some(total_dur)),
        has_audio: verified.as_ref().map(|v| v.has_audio).unwrap_or(any_audio),
        elapsed_ms: t0.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;
    use std::process::{Command, Stdio};
    use tempfile::tempdir;

    fn decode_pcm_16k(ffmpeg: &Path, path: &Path) -> Vec<f64> {
        let out = Command::new(ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                &path.to_string_lossy(),
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

    fn rms(slice: &[f64]) -> f64 {
        if slice.is_empty() {
            return 0.0;
        }
        (slice.iter().map(|s| s * s).sum::<f64>() / slice.len() as f64).sqrt()
    }

    fn peak_freq(slice: &[f64], sr: f64) -> f64 {
        let n = slice.len().min(4096);
        let mut best_f = 0.0;
        let mut best_m = -1.0;
        for fi in (200..=1200).step_by(10) {
            let f = fi as f64;
            let w = 2.0 * PI * f / sr;
            let (mut re, mut im) = (0.0, 0.0);
            for (i, &s) in slice.iter().take(n).enumerate() {
                re += s * (w * i as f64).cos();
                im -= s * (w * i as f64).sin();
            }
            let m = re * re + im * im;
            if m > best_m {
                best_m = m;
                best_f = f;
            }
        }
        best_f
    }

    #[test]
    fn merges_reordered_audio_silent_portrait_and_audio_clips_preserving_seams_silence_and_sync() {
        let dir = tempdir().unwrap();
        let Ok(tools) = require_media_tools(dir.path()) else {
            return;
        };
        let cancel = AtomicBool::new(false);

        // Clip A: Red 320x180, 1.5s, 440 Hz
        let clip_a = dir.path().join("clip_a_red_440.mp4");
        run_ffmpeg_cancellable(
            &tools.ffmpeg,
            &[
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "color=c=red:s=320x180:r=25:d=1.5".into(),
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "sine=frequency=440:sample_rate=48000:duration=1.5".into(),
                "-af".into(),
                "volume=6".into(),
                "-c:v".into(),
                "libx264".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
                "-c:a".into(),
                "aac".into(),
                clip_a.to_string_lossy().to_string(),
            ],
            Some(1.5),
            &cancel,
            |_, _| {},
        )
        .unwrap();

        // Clip B: Green 180x320 PORTRAIT, 1.5s, SILENT (0 audio streams)
        let clip_b = dir.path().join("clip_b_green_silent.mp4");
        run_ffmpeg_cancellable(
            &tools.ffmpeg,
            &[
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "color=c=green:s=180x320:r=25:d=1.5".into(),
                "-c:v".into(),
                "libx264".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
                clip_b.to_string_lossy().to_string(),
            ],
            Some(1.5),
            &cancel,
            |_, _| {},
        )
        .unwrap();

        // Clip C: Blue 320x180, 1.5s, 880 Hz
        let clip_c = dir.path().join("clip_c_blue_880.mp4");
        run_ffmpeg_cancellable(
            &tools.ffmpeg,
            &[
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "color=c=blue:s=320x180:r=25:d=1.5".into(),
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "sine=frequency=880:sample_rate=48000:duration=1.5".into(),
                "-af".into(),
                "volume=6".into(),
                "-c:v".into(),
                "libx264".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
                "-c:a".into(),
                "aac".into(),
                clip_c.to_string_lossy().to_string(),
            ],
            Some(1.5),
            &cancel,
            |_, _| {},
        )
        .unwrap();

        // Reorder as [C (Blue 880Hz), B (Green portrait silent), A (Red 440Hz)]
        let merged = dir.path().join("merged_cba.mp4");
        let res = merge_videos_impl(
            dir.path(),
            &MergeVideosRequest {
                task_id: "v12-cba".into(),
                source_paths: vec![
                    clip_c.to_string_lossy().to_string(),
                    clip_b.to_string_lossy().to_string(),
                    clip_a.to_string_lossy().to_string(),
                ],
                output_path: merged.to_string_lossy().to_string(),
                resolution_preset: MergeResolutionPreset::MatchFirst,
                fit_mode: Some(MergeFitMode::Pad),
                allow_overwrite: Some(false),
            },
            &cancel,
            |_| {},
        )
        .unwrap();

        assert_eq!((res.output_width, res.output_height), (320, 180));
        assert!(res.has_audio);
        assert!((res.output_duration_sec.unwrap() - 4.5).abs() < 0.2);

        // Verify seams & frames: 0.3s=Blue, 1.8s=Green+black bars, 3.6s=Red
        for (tag, ts, expected) in [("s0", 0.3, 'B'), ("s1", 2.2, 'G'), ("s2", 3.8, 'R')] {
            let p = dir.path().join(format!("m_{tag}.png"));
            run_ffmpeg_cancellable(
                &tools.ffmpeg,
                &[
                    "-ss".into(),
                    format!("{ts:.2}"),
                    "-i".into(),
                    merged.to_string_lossy().to_string(),
                    "-frames:v".into(),
                    "1".into(),
                    p.to_string_lossy().to_string(),
                ],
                None,
                &cancel,
                |_, _| {},
            )
            .unwrap();
            let im = image::open(&p).unwrap().to_rgb8();
            let center = im.get_pixel(160, 90).0;
            match expected {
                'B' => assert!(
                    center[2] > 180 && center[0] < 50,
                    "0.3s expected Blue, got {center:?}"
                ),
                'G' => {
                    assert!(
                        center[1] > 100 && center[0] < 50,
                        "2.2s expected Green center, got {center:?}"
                    );
                    let bar = im.get_pixel(10, 90).0;
                    assert!(
                        bar[0] < 20 && bar[1] < 20 && bar[2] < 20,
                        "portrait letterbox bar expected black, got {bar:?}"
                    );
                }
                'R' => assert!(
                    center[0] > 180 && center[2] < 50,
                    "3.8s expected Red, got {center:?}"
                ),
                _ => unreachable!(),
            }
        }

        // Verify audio timeline: [0.3..1.2s]=880Hz, [1.7..2.8s]=SILENT, [3.3..4.2s]=440Hz
        let pcm = decode_pcm_16k(&tools.ffmpeg, &merged);
        let seg_c = &pcm[4800..19200];
        let seg_b = &pcm[27200..44800];
        let seg_a = &pcm[52800..pcm.len().min(67200)];

        assert!(rms(seg_c) > 0.2, "first segment C audio should be loud");
        assert!((peak_freq(seg_c, 16000.0) - 880.0).abs() <= 25.0);
        assert!(
            rms(seg_b) < 0.005,
            "middle segment B must stay silent, got rms={}",
            rms(seg_b)
        );
        assert!(
            rms(seg_a) > 0.2,
            "final segment A audio must resume after silent B"
        );
        assert!((peak_freq(seg_a, 16000.0) - 440.0).abs() <= 25.0);
    }
}
