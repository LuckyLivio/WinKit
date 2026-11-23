//! V04 Extract Frames — supports single-timestamp capture, fixed-interval extraction (every N sec),
//! and evenly spaced frame counts across a duration/range.
//!
//! Exports upright display-oriented frames for rotated portrait videos, uses presentation-timestamp
//! seeking for VFR accuracy, supports Original / 1080p / 720p (never upscaling), and supports
//! PNG, JPEG, WebP, plus Windows WIC HEIC reusing I05's capability probe & encoder.

use crate::error::AppError;
use crate::fs_guard::validate_existing_input_file;
use crate::media_core::{
    allocate_non_colliding_output_path, require_media_tools, run_ffmpeg_cancellable,
    AtomicMediaOutput, MediaTaskProgressPayload,
};
use crate::media_info::probe_media_info_impl;
use crate::wic_heic::{encode_heic_bytes_via_wic, get_heic_capabilities};
use base64::Engine;
use image::imageops::FilterType;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

const MAX_EXTRACTED_FRAMES: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FrameExtractMode {
    SingleTime,
    IntervalSeconds,
    EvenCount,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FrameResolutionPreset {
    Original,
    P1080,
    P720,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FrameImageFormat {
    Png,
    Jpeg,
    Webp,
    Heic,
}

impl FrameImageFormat {
    pub fn extension(self) -> &'static str {
        match self {
            FrameImageFormat::Png => "png",
            FrameImageFormat::Jpeg => "jpg",
            FrameImageFormat::Webp => "webp",
            FrameImageFormat::Heic => "heic",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractFramesRequest {
    pub task_id: String,
    pub source_path: String,
    pub output_dir: String,
    pub mode: FrameExtractMode,
    pub timestamp_sec: Option<f64>,
    pub interval_sec: Option<f64>,
    pub frame_count: Option<usize>,
    pub start_sec: Option<f64>,
    pub end_sec: Option<f64>,
    pub resolution: FrameResolutionPreset,
    pub format: FrameImageFormat,
    pub quality: Option<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedFrameItem {
    pub index: usize,
    pub timestamp_sec: f64,
    pub output_path: String,
    pub file_name: String,
    pub width: u32,
    pub height: u32,
    pub byte_size: u64,
    pub thumbnail_data_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractFramesResponse {
    pub task_id: String,
    pub output_dir: String,
    pub cancelled: bool,
    pub extracted_count: usize,
    pub requested_count: usize,
    pub elapsed_ms: u64,
    pub frames: Vec<ExtractedFrameItem>,
}

/// Computes exact presentation timestamps to extract for any of the three modes.
pub fn compute_frame_timestamps(
    mode: FrameExtractMode,
    duration_sec: f64,
    timestamp_sec: Option<f64>,
    interval_sec: Option<f64>,
    frame_count: Option<usize>,
    start_sec: Option<f64>,
    end_sec: Option<f64>,
) -> Result<Vec<f64>, AppError> {
    let safe_dur = if duration_sec.is_finite() && duration_sec > 0.0 {
        duration_sec
    } else {
        0.0
    };

    match mode {
        FrameExtractMode::SingleTime => {
            let t = timestamp_sec.unwrap_or(0.0);
            if !t.is_finite() || t < 0.0 {
                return Err(AppError::invalid_param("Timestamp must be >= 0."));
            }
            let clamped = if safe_dur > 0.0 {
                t.min((safe_dur - 0.01).max(0.0))
            } else {
                t
            };
            Ok(vec![clamped])
        }
        FrameExtractMode::IntervalSeconds => {
            let step = interval_sec.unwrap_or(1.0);
            if !step.is_finite() || step < 0.1 {
                return Err(AppError::invalid_param(
                    "Interval must be at least 0.1 seconds.",
                ));
            }
            if safe_dur <= 0.0 {
                return Err(AppError::invalid_param(
                    "Video duration is unknown; use single-timestamp extraction instead.",
                ));
            }
            let s = start_sec.unwrap_or(0.0).max(0.0).min(safe_dur);
            let e = end_sec.unwrap_or(safe_dur).max(s).min(safe_dur);
            let max_end = (e - 0.01).max(s);
            let mut out = Vec::new();
            let mut cur = s;
            while cur <= max_end + 1e-6 && out.len() < MAX_EXTRACTED_FRAMES {
                out.push(cur.min(max_end));
                cur += step;
            }
            if out.is_empty() {
                out.push(s);
            }
            Ok(out)
        }
        FrameExtractMode::EvenCount => {
            let count = frame_count.unwrap_or(6);
            if count == 0 || count > MAX_EXTRACTED_FRAMES {
                return Err(AppError::invalid_param(format!(
                    "Frame count must be between 1 and {MAX_EXTRACTED_FRAMES}."
                )));
            }
            if safe_dur <= 0.0 {
                return Err(AppError::invalid_param(
                    "Video duration is unknown; use single-timestamp extraction instead.",
                ));
            }
            let s = start_sec.unwrap_or(0.0).max(0.0).min(safe_dur);
            let e = end_sec.unwrap_or(safe_dur).max(s).min(safe_dur);
            let safe_end = (e - 0.02).max(s);
            let span = (safe_end - s).max(0.0);
            if count == 1 || span <= 1e-4 {
                return Ok(vec![s + span * 0.5]);
            }
            let mut out = Vec::with_capacity(count);
            for i in 0..count {
                let ratio = (i as f64) / ((count - 1) as f64);
                out.push(s + span * ratio);
            }
            Ok(out)
        }
    }
}

fn build_resolution_scale_filter(preset: FrameResolutionPreset) -> Option<&'static str> {
    match preset {
        FrameResolutionPreset::Original => None,
        FrameResolutionPreset::P1080 => Some(
            "scale='if(gte(iw,ih),min(1920,iw),min(1080,iw))':'if(gte(iw,ih),min(1080,ih),min(1920,ih))':force_original_aspect_ratio=decrease:flags=lanczos",
        ),
        FrameResolutionPreset::P720 => Some(
            "scale='if(gte(iw,ih),min(1280,iw),min(720,iw))':'if(gte(iw,ih),min(720,ih),min(1280,ih))':force_original_aspect_ratio=decrease:flags=lanczos",
        ),
    }
}

fn format_ts_filename_tag(sec: f64) -> String {
    let total_ms = (sec.max(0.0) * 1000.0).round() as u64;
    let mins = total_ms / 60_000;
    let secs = (total_ms % 60_000) / 1000;
    let ms = total_ms % 1000;
    format!("{mins:02}m{secs:02}s{ms:03}ms")
}

fn make_thumbnail_data_url(img: &image::DynamicImage) -> String {
    let thumb = if img.width() > 320 || img.height() > 240 {
        img.resize(320, 240, FilterType::Triangle)
    } else {
        img.clone()
    };
    let rgb = thumb.to_rgb8();
    let mut jpg_bytes = Vec::new();
    let enc = jpeg_encoder::Encoder::new(&mut jpg_bytes, 80);
    if enc
        .encode(
            rgb.as_raw(),
            rgb.width() as u16,
            rgb.height() as u16,
            jpeg_encoder::ColorType::Rgb,
        )
        .is_ok()
    {
        let b64 = base64::engine::general_purpose::STANDARD.encode(&jpg_bytes);
        format!("data:image/jpeg;base64,{b64}")
    } else {
        String::new()
    }
}

pub fn extract_video_frames_impl(
    media_root: &Path,
    req: &ExtractFramesRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(MediaTaskProgressPayload),
) -> Result<ExtractFramesResponse, AppError> {
    let t0 = Instant::now();
    let (source_path, _) = validate_existing_input_file(&req.source_path)?;
    let out_dir = PathBuf::from(req.output_dir.trim());
    if !out_dir.is_absolute() {
        return Err(AppError::invalid_param(
            "Output directory must be an absolute path.",
        ));
    }

    if req.format == FrameImageFormat::Heic {
        let caps = get_heic_capabilities();
        if !caps.encode_available {
            return Err(AppError::decode_failed(format!(
                "HEIC encoding is unavailable on this Windows system: {}",
                caps.encode_note
            )));
        }
    }

    let tools = require_media_tools(media_root)?;
    let probe = probe_media_info_impl(media_root, &req.source_path)?;
    if !probe.has_video {
        return Err(AppError::invalid_param(
            "Selected file contains no video stream.",
        ));
    }

    let duration_sec = probe.duration_sec.unwrap_or(0.0);
    let timestamps = compute_frame_timestamps(
        req.mode,
        duration_sec,
        req.timestamp_sec,
        req.interval_sec,
        req.frame_count,
        req.start_sec,
        req.end_sec,
    )?;

    let stem = source_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video");
    let quality = req.quality.unwrap_or(90).clamp(50, 100);
    let scale_vf = build_resolution_scale_filter(req.resolution);
    let total = timestamps.len();

    let mut frames: Vec<ExtractedFrameItem> = Vec::with_capacity(total);
    let mut cancelled = false;

    for (idx, &ts) in timestamps.iter().enumerate() {
        if cancel_flag.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }

        let suffix = format!("_frame_{:03}_{}", idx + 1, format_ts_filename_tag(ts));
        let target_path = allocate_non_colliding_output_path(
            &out_dir,
            stem,
            &suffix,
            req.format.extension(),
            &source_path,
        )?;
        let file_name = target_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("frame")
            .to_string();

        on_progress(MediaTaskProgressPayload {
            task_id: req.task_id.clone(),
            tool_id: "V04".into(),
            phase: "running".into(),
            current_item: idx + 1,
            total_items: total,
            item_name: Some(file_name.clone()),
            percent: Some(((idx as f64) / (total as f64) * 100.0).clamp(0.0, 99.0)),
            out_time_sec: Some(ts),
            total_duration_sec: probe.duration_sec,
        });

        // For HEIC we decode an intermediate lossless PNG via FFmpeg, then encode via Windows WIC
        let (extract_target, is_heic) = if req.format == FrameImageFormat::Heic {
            let tmp_png = out_dir.join(format!(".winkit-heic-src-{}.png", uuid::Uuid::new_v4()));
            (tmp_png, true)
        } else {
            (target_path.clone(), false)
        };

        let atomic_direct = if !is_heic {
            Some(AtomicMediaOutput::prepare(
                target_path.clone(),
                &source_path,
                false,
            )?)
        } else {
            None
        };
        let ffmpeg_out_path = atomic_direct
            .as_ref()
            .map(|a| a.temp_path().to_path_buf())
            .unwrap_or_else(|| extract_target.clone());

        // Attempt 1: Active-frame VFR-accurate seek using a 3s pre-roll + `fps=50:round=down:eof_action=pass,trim=start=rem`
        // so VFR streams (which hold a frame across non-uniform intervals) yield the exact frame displayed at `ts`
        // instead of skipping forward to the next packet whose PTS >= ts.
        // Fallback attempts: direct `-ss` seek for very sparse streams or timestamps right at EOF.
        #[derive(Clone, Copy)]
        enum FrameSeekStrategy {
            VfrHoldAccurate(f64),
            DirectSeek(f64),
        }

        let mut actual_ts = ts;
        let mut attempts = vec![
            FrameSeekStrategy::VfrHoldAccurate(ts),
            FrameSeekStrategy::DirectSeek(ts),
        ];
        if ts > 0.08 {
            attempts.push(FrameSeekStrategy::DirectSeek((ts - 0.08).max(0.0)));
        }

        let mut extracted_ok = false;
        let mut last_err: Option<AppError> = None;

        for strategy in attempts {
            let _ = fs::remove_file(&ffmpeg_out_path);
            let (attempt_ts, mut args) = match strategy {
                FrameSeekStrategy::VfrHoldAccurate(target_ts) => {
                    let fast_seek = (target_ts - 3.0).max(0.0);
                    let rem = (target_ts - fast_seek).max(0.0);
                    let trim_start = (rem - 0.001).max(0.0);
                    let mut vf = format!(
                        "fps=fps=50:round=down:eof_action=pass,trim=start={trim_start:.4},setpts=PTS-STARTPTS"
                    );
                    if let Some(scale) = scale_vf {
                        vf.push(',');
                        vf.push_str(scale);
                    }
                    let cmd_args: Vec<String> = vec![
                        "-ss".into(),
                        format!("{fast_seek:.3}"),
                        "-i".into(),
                        source_path.to_string_lossy().to_string(),
                        "-vf".into(),
                        vf,
                        "-frames:v".into(),
                        "1".into(),
                    ];
                    (target_ts, cmd_args)
                }
                FrameSeekStrategy::DirectSeek(target_ts) => {
                    let mut cmd_args: Vec<String> = vec![
                        "-ss".into(),
                        format!("{target_ts:.3}"),
                        "-i".into(),
                        source_path.to_string_lossy().to_string(),
                        "-frames:v".into(),
                        "1".into(),
                    ];
                    if let Some(vf) = scale_vf {
                        cmd_args.push("-vf".into());
                        cmd_args.push(vf.to_string());
                    }
                    (target_ts, cmd_args)
                }
            };
            if !is_heic {
                match req.format {
                    FrameImageFormat::Png => {
                        args.push("-c:v".into());
                        args.push("png".into());
                    }
                    FrameImageFormat::Jpeg => {
                        // Map 50..100 quality to ffmpeg mjpeg qscale 10..2
                        let qscale = (2.0 + ((100.0 - f64::from(quality)) / 50.0) * 8.0)
                            .round()
                            .clamp(2.0, 12.0) as u32;
                        args.push("-q:v".into());
                        args.push(qscale.to_string());
                    }
                    FrameImageFormat::Webp => {
                        args.push("-c:v".into());
                        args.push("libwebp".into());
                        args.push("-quality".into());
                        args.push(quality.to_string());
                    }
                    FrameImageFormat::Heic => {}
                }
            } else {
                args.push("-c:v".into());
                args.push("png".into());
            }
            args.push(ffmpeg_out_path.to_string_lossy().to_string());

            match run_ffmpeg_cancellable(&tools.ffmpeg, &args, None, cancel_flag, |_, _| {}) {
                Ok(()) => {
                    if fs::metadata(&ffmpeg_out_path).is_ok_and(|m| m.len() > 0) {
                        actual_ts = attempt_ts;
                        extracted_ok = true;
                        break;
                    }
                }
                Err(e) if e.code == "TASK_CANCELLED" => {
                    let _ = fs::remove_file(&ffmpeg_out_path);
                    cancelled = true;
                    break;
                }
                Err(e) => {
                    last_err = Some(e);
                }
            }
        }

        if cancelled {
            break;
        }
        if !extracted_ok {
            let _ = fs::remove_file(&ffmpeg_out_path);
            if total == 1 {
                return Err(last_err.unwrap_or_else(|| {
                    AppError::decode_failed("Unable to extract frame at the requested timestamp.")
                }));
            }
            continue;
        }

        let decoded_img = image::open(&ffmpeg_out_path).map_err(|e| {
            let _ = fs::remove_file(&ffmpeg_out_path);
            AppError::decode_failed(format!("Failed reading extracted frame: {e}"))
        })?;
        let width = decoded_img.width();
        let height = decoded_img.height();
        let thumb_url = make_thumbnail_data_url(&decoded_img);

        let (final_path, byte_size) = if is_heic {
            let rgba = decoded_img.to_rgba8();
            let _ = fs::remove_file(&ffmpeg_out_path);
            let heic_bytes = encode_heic_bytes_via_wic(&rgba, quality, None)?;
            let atomic_heic = AtomicMediaOutput::prepare(target_path.clone(), &source_path, false)?;
            fs::write(atomic_heic.temp_path(), &heic_bytes)
                .map_err(|e| AppError::from_io(e, "Failed writing HEIC frame"))?;
            atomic_heic.commit(false)?
        } else {
            atomic_direct.unwrap().commit(false)?
        };

        frames.push(ExtractedFrameItem {
            index: idx + 1,
            timestamp_sec: actual_ts,
            output_path: final_path.to_string_lossy().to_string(),
            file_name,
            width,
            height,
            byte_size,
            thumbnail_data_url: thumb_url,
        });
    }

    Ok(ExtractFramesResponse {
        task_id: req.task_id.clone(),
        output_dir: out_dir.to_string_lossy().to_string(),
        cancelled,
        extracted_count: frames.len(),
        requested_count: total,
        elapsed_ms: t0.elapsed().as_millis() as u64,
        frames,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media_core::get_media_tools_status_impl;
    use tempfile::tempdir;

    #[test]
    fn computes_single_interval_and_even_timestamps_cleanly() {
        assert_eq!(
            compute_frame_timestamps(
                FrameExtractMode::SingleTime,
                5.0,
                Some(2.25),
                None,
                None,
                None,
                None
            )
            .unwrap(),
            vec![2.25]
        );
        let iv = compute_frame_timestamps(
            FrameExtractMode::IntervalSeconds,
            5.0,
            None,
            Some(1.5),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(iv.len(), 4);
        assert!((iv[0] - 0.0).abs() < 1e-6);
        assert!((iv[1] - 1.5).abs() < 1e-6);

        let ev = compute_frame_timestamps(
            FrameExtractMode::EvenCount,
            4.0,
            None,
            None,
            Some(5),
            None,
            None,
        )
        .unwrap();
        assert_eq!(ev.len(), 5);
        assert!((ev[0] - 0.0).abs() < 1e-6);
        assert!(ev[4] > 3.9);
    }

    #[test]
    fn extracts_upright_portrait_frames_without_upscaling_small_clips() {
        let dir = tempdir().unwrap();
        let status = get_media_tools_status_impl(dir.path());
        if !status.ready {
            return;
        }
        let ffmpeg = Path::new(status.ffmpeg_path.as_deref().unwrap());
        let cancel = AtomicBool::new(false);

        let raw = dir.path().join("raw.mp4");
        let portrait = dir.path().join("portrait.mp4");
        run_ffmpeg_cancellable(
            ffmpeg,
            &[
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "testsrc2=size=320x180:rate=25:duration=3".into(),
                "-c:v".into(),
                "libx264".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
                raw.to_string_lossy().to_string(),
            ],
            Some(3.0),
            &cancel,
            |_, _| {},
        )
        .unwrap();
        run_ffmpeg_cancellable(
            ffmpeg,
            &[
                "-display_rotation".into(),
                "90".into(),
                "-i".into(),
                raw.to_string_lossy().to_string(),
                "-c".into(),
                "copy".into(),
                portrait.to_string_lossy().to_string(),
            ],
            Some(3.0),
            &cancel,
            |_, _| {},
        )
        .unwrap();

        let out_dir = dir.path().join("frames_out");
        let resp = extract_video_frames_impl(
            dir.path(),
            &ExtractFramesRequest {
                task_id: "v04-test".into(),
                source_path: portrait.to_string_lossy().to_string(),
                output_dir: out_dir.to_string_lossy().to_string(),
                mode: FrameExtractMode::EvenCount,
                timestamp_sec: None,
                interval_sec: None,
                frame_count: Some(3),
                start_sec: None,
                end_sec: None,
                resolution: FrameResolutionPreset::P720,
                format: FrameImageFormat::Png,
                quality: Some(90),
            },
            &cancel,
            |_| {},
        )
        .unwrap();

        assert_eq!(resp.extracted_count, 3);
        for f in &resp.frames {
            // Portrait display size is 180x320; 720p cap must NEVER upscale it!
            assert_eq!(f.width, 180);
            assert_eq!(f.height, 320);
            assert!(Path::new(&f.output_path).is_file());
            assert!(f.thumbnail_data_url.starts_with("data:image/jpeg;base64,"));
        }
    }

    #[test]
    fn v04_extract_frames_vfr_timestamp_accuracy() {
        let dir = tempdir().unwrap();
        let Ok(tools) = require_media_tools(dir.path()) else {
            return;
        };
        let cancel = AtomicBool::new(false);
        let mkv = dir.path().join("vfr_hold.mkv");
        let list_path = dir.path().join("vfr_list.txt");

        let colors = [
            ("red.png", [220u8, 38, 38], 0.50),
            ("blue.png", [37u8, 99, 235], 1.50),
            ("yellow.png", [202u8, 138, 4], 1.00),
        ];
        let mut concat_txt = String::new();
        for (name, rgb, dur) in colors {
            let p = dir.path().join(name);
            let mut img = image::RgbImage::new(160, 120);
            for px in img.pixels_mut() {
                *px = image::Rgb(rgb);
            }
            img.save(&p).unwrap();
            let norm = p.to_string_lossy().replace('\\', "/");
            concat_txt.push_str(&format!("file '{norm}'\nduration {dur}\n"));
        }
        let last_norm = dir
            .path()
            .join("yellow.png")
            .to_string_lossy()
            .replace('\\', "/");
        concat_txt.push_str(&format!("file '{last_norm}'\n"));
        fs::write(&list_path, concat_txt).unwrap();

        run_ffmpeg_cancellable(
            &tools.ffmpeg,
            &[
                "-f".into(),
                "concat".into(),
                "-safe".into(),
                "0".into(),
                "-i".into(),
                list_path.to_string_lossy().to_string(),
                "-fps_mode".into(),
                "vfr".into(),
                "-c:v".into(),
                "libx264".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
                mkv.to_string_lossy().to_string(),
            ],
            Some(3.0),
            &cancel,
            |_, _| {},
        )
        .unwrap();

        let out_dir = dir.path().join("vfr_out");
        // At t=0.10s -> Red; at t=1.10s -> Blue; at t=2.40s -> Yellow
        for (idx, (ts, expected)) in [(0.10, 'R'), (1.10, 'B'), (2.40, 'Y')]
            .into_iter()
            .enumerate()
        {
            let resp = extract_video_frames_impl(
                dir.path(),
                &ExtractFramesRequest {
                    task_id: format!("v04-vfr-{idx}"),
                    source_path: mkv.to_string_lossy().to_string(),
                    output_dir: out_dir.to_string_lossy().to_string(),
                    mode: FrameExtractMode::SingleTime,
                    timestamp_sec: Some(ts),
                    interval_sec: None,
                    frame_count: None,
                    start_sec: None,
                    end_sec: None,
                    resolution: FrameResolutionPreset::Original,
                    format: FrameImageFormat::Png,
                    quality: Some(90),
                },
                &cancel,
                |_| {},
            )
            .unwrap();
            assert_eq!(resp.extracted_count, 1);
            let rgb = image::open(&resp.frames[0].output_path)
                .unwrap()
                .to_rgb8()
                .get_pixel(80, 60)
                .0;
            match expected {
                'R' => assert!(
                    rgb[0] > 170 && rgb[2] < 90,
                    "t={ts} expected Red, got {rgb:?}"
                ),
                'B' => assert!(
                    rgb[2] > 170 && rgb[0] < 90,
                    "t={ts} expected Blue, got {rgb:?}"
                ),
                'Y' => assert!(
                    rgb[0] > 150 && rgb[1] > 100 && rgb[2] < 70,
                    "t={ts} expected Yellow, got {rgb:?}"
                ),
                _ => unreachable!(),
            }
        }
    }
}
