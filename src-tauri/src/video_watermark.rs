//! I13 Video Watermark — reuses `WatermarkStyleConfig` and `render_watermark_overlay_rgba`
//! from `image_watermark` so image and video watermarking share identical 9-grid placement,
//! margin, proportional scale, opacity, diagonal tiling, Chinese text stamps, and transparent
//! PNG logos across landscape, portrait, and 90°-display-rotation videos while preserving audio
//! and exact video duration.

use crate::error::AppError;
use crate::fs_guard::validate_existing_input_file;
use crate::image_watermark::{render_watermark_overlay_rgba, WatermarkStyleConfig};
use crate::media_core::{
    require_media_tools, run_ffmpeg_cancellable, AtomicMediaOutput, MediaTaskProgressPayload,
};
use crate::media_info::probe_media_info_impl;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::Instant;
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkVideoRequest {
    pub task_id: String,
    pub source_path: String,
    pub output_path: String,
    pub style: WatermarkStyleConfig,
    pub allow_overwrite: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkVideoResult {
    pub output_path: String,
    pub byte_size: u64,
    pub output_width: u32,
    pub output_height: u32,
    pub output_rotation: Option<i32>,
    pub duration_sec: Option<f64>,
    pub has_audio: bool,
    pub audio_copied: bool,
    pub elapsed_ms: u64,
}

struct ScopedTempFile(PathBuf);

impl Drop for ScopedTempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn ensure_even(v: u32) -> u32 {
    let e = v & !1;
    e.max(2)
}

fn is_audio_copy_compatible(ext: &str, audio_codecs: &[Option<String>]) -> bool {
    if audio_codecs.is_empty() {
        return true;
    }
    match ext {
        "mp4" | "m4v" => audio_codecs.iter().all(|c| {
            matches!(
                c.as_deref().unwrap_or("").to_ascii_lowercase().as_str(),
                "aac" | "mp3" | "ac3" | "eac3" | "alac" | "opus"
            )
        }),
        "mov" => audio_codecs.iter().all(|c| {
            matches!(
                c.as_deref().unwrap_or("").to_ascii_lowercase().as_str(),
                "aac" | "mp3" | "alac" | "pcm_s16le" | "pcm_s24le" | "pcm_s16be" | "pcm_s24be"
            )
        }),
        "mkv" => true,
        "webm" => audio_codecs.iter().all(|c| {
            matches!(
                c.as_deref().unwrap_or("").to_ascii_lowercase().as_str(),
                "opus" | "vorbis"
            )
        }),
        _ => false,
    }
}

pub fn watermark_video_impl(
    media_root: &Path,
    req: &WatermarkVideoRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(MediaTaskProgressPayload),
) -> Result<WatermarkVideoResult, AppError> {
    let t0 = Instant::now();
    let (source_path, _) = validate_existing_input_file(&req.source_path)?;
    let tools = require_media_tools(media_root)?;
    let probe = probe_media_info_impl(media_root, &req.source_path)?;

    let v_stream = probe
        .video_streams
        .first()
        .ok_or_else(|| AppError::invalid_param("Selected file does not contain a video stream."))?;

    let raw_w = v_stream.display_width.or(v_stream.coded_width).unwrap_or(0);
    let raw_h = v_stream
        .display_height
        .or(v_stream.coded_height)
        .unwrap_or(0);
    if raw_w == 0 || raw_h == 0 {
        return Err(AppError::decode_failed(
            "Unable to determine display dimensions of the source video.",
        ));
    }
    let out_w = ensure_even(raw_w);
    let out_h = ensure_even(raw_h);

    // Render full-resolution transparent RGBA watermark overlay using exact image_watermark math.
    let overlay_rgba = render_watermark_overlay_rgba(out_w, out_h, &req.style)?;
    let overlay_path =
        std::env::temp_dir().join(format!("winkit_i13_overlay_{}.png", Uuid::new_v4()));
    overlay_rgba.save(&overlay_path).map_err(|e| {
        AppError::decode_failed(format!("Failed writing watermark overlay PNG: {e}"))
    })?;
    let _overlay_guard = ScopedTempFile(overlay_path.clone());

    let allow_overwrite = req.allow_overwrite.unwrap_or(true);
    let final_path = PathBuf::from(req.output_path.trim());
    let ext = final_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_else(|| "mp4".into());

    let atomic = AtomicMediaOutput::prepare(final_path, &source_path, allow_overwrite)?;
    let duration = probe.duration_sec;
    let file_name = probe.file_name.clone();

    on_progress(MediaTaskProgressPayload {
        task_id: req.task_id.clone(),
        tool_id: "I13".into(),
        phase: "running".into(),
        current_item: 1,
        total_items: 1,
        item_name: Some(file_name.clone()),
        percent: Some(0.0),
        out_time_sec: Some(0.0),
        total_duration_sec: duration,
    });

    // FFmpeg auto-rotates input video frames to upright display orientation before filter_complex;
    // scale to exact even upright display dims + setsar=1, composite transparent RGBA overlay,
    // and clear rotation metadata so players never double-rotate.
    let filter_complex = format!(
        "[0:v]scale={out_w}:{out_h},setsar=1[base];[base][1:v]overlay=0:0:format=auto,format=yuv420p[vout]"
    );

    let audio_codecs: Vec<Option<String>> = probe
        .audio_streams
        .iter()
        .map(|a| a.codec_name.clone())
        .collect();
    let audio_copy = probe.has_audio && is_audio_copy_compatible(&ext, &audio_codecs);

    let mut args: Vec<String> = vec![
        "-i".into(),
        source_path.to_string_lossy().to_string(),
        "-i".into(),
        overlay_path.to_string_lossy().to_string(),
        "-filter_complex".into(),
        filter_complex,
        "-map".into(),
        "[vout]".into(),
    ];

    if probe.has_audio {
        args.extend(["-map".into(), "0:a?".into()]);
    } else {
        args.push("-an".into());
    }
    args.push("-sn".into());

    match ext.as_str() {
        "webm" => {
            args.extend([
                "-c:v".into(),
                "libvpx-vp9".into(),
                "-crf".into(),
                "28".into(),
                "-b:v".into(),
                "0".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
            ]);
            if probe.has_audio {
                if audio_copy {
                    args.extend(["-c:a".into(), "copy".into()]);
                } else {
                    args.extend([
                        "-c:a".into(),
                        "libopus".into(),
                        "-b:a".into(),
                        "128k".into(),
                    ]);
                }
            }
            args.extend([
                "-metadata:s:v:0".into(),
                "rotate=0".into(),
                "-f".into(),
                "webm".into(),
            ]);
        }
        "mkv" => {
            args.extend([
                "-c:v".into(),
                "libx264".into(),
                "-preset".into(),
                "medium".into(),
                "-crf".into(),
                "19".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
            ]);
            if probe.has_audio {
                args.extend(["-c:a".into(), "copy".into()]);
            }
            args.extend([
                "-metadata:s:v:0".into(),
                "rotate=0".into(),
                "-f".into(),
                "matroska".into(),
            ]);
        }
        "mov" => {
            args.extend([
                "-c:v".into(),
                "libx264".into(),
                "-preset".into(),
                "medium".into(),
                "-crf".into(),
                "19".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
            ]);
            if probe.has_audio {
                if audio_copy {
                    args.extend(["-c:a".into(), "copy".into()]);
                } else {
                    args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
                }
            }
            args.extend([
                "-metadata:s:v:0".into(),
                "rotate=0".into(),
                "-movflags".into(),
                "+faststart".into(),
                "-f".into(),
                "mov".into(),
            ]);
        }
        _ => {
            args.extend([
                "-c:v".into(),
                "libx264".into(),
                "-preset".into(),
                "medium".into(),
                "-crf".into(),
                "19".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
            ]);
            if probe.has_audio {
                if audio_copy {
                    args.extend(["-c:a".into(), "copy".into()]);
                } else {
                    args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
                }
            }
            args.extend([
                "-metadata:s:v:0".into(),
                "rotate=0".into(),
                "-movflags".into(),
                "+faststart".into(),
                "-f".into(),
                "mp4".into(),
            ]);
        }
    }

    args.push(atomic.temp_path().to_string_lossy().to_string());

    run_ffmpeg_cancellable(&tools.ffmpeg, &args, duration, cancel_flag, |out_t, pct| {
        on_progress(MediaTaskProgressPayload {
            task_id: req.task_id.clone(),
            tool_id: "I13".into(),
            phase: "running".into(),
            current_item: 1,
            total_items: 1,
            item_name: Some(file_name.clone()),
            percent: pct,
            out_time_sec: out_t,
            total_duration_sec: duration,
        });
    })?;

    let (committed_path, byte_size) = atomic.commit(allow_overwrite)?;
    let final_str = committed_path.to_string_lossy().to_string();
    let verified = probe_media_info_impl(media_root, &final_str).ok();
    let ov = verified.as_ref().and_then(|v| v.video_streams.first());

    on_progress(MediaTaskProgressPayload {
        task_id: req.task_id.clone(),
        tool_id: "I13".into(),
        phase: "completed".into(),
        current_item: 1,
        total_items: 1,
        item_name: Some(file_name),
        percent: Some(100.0),
        out_time_sec: duration,
        total_duration_sec: duration,
    });

    Ok(WatermarkVideoResult {
        output_path: final_str,
        byte_size,
        output_width: ov.and_then(|v| v.display_width).unwrap_or(out_w),
        output_height: ov.and_then(|v| v.display_height).unwrap_or(out_h),
        output_rotation: ov.and_then(|v| v.rotation_degrees),
        duration_sec: verified.as_ref().and_then(|v| v.duration_sec),
        has_audio: verified
            .as_ref()
            .map(|v| v.has_audio)
            .unwrap_or(probe.has_audio),
        audio_copied: audio_copy,
        elapsed_ms: t0.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image_watermark::WatermarkPlacement;
    use crate::media_core::configure_hidden_command;
    use image::{Rgba, RgbaImage};
    use std::process::Command;

    #[test]
    fn watermarks_rotated_portrait_video_in_exact_upright_corner_preserving_audio_and_duration() {
        let tmp = std::env::temp_dir().join(format!("winkit_i13_vid_test_{}", Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let tools = match require_media_tools(&tmp) {
            Ok(t) => t,
            Err(_) => {
                let _ = fs::remove_dir_all(&tmp);
                return;
            }
        };

        // 1. Create a 90°-rotated portrait video (coded 320x180, display_rotation 90 -> display 180x320)
        //    on dark blue background with audio tone.
        let raw_vid = tmp.join("raw_320x180.mp4");
        let src_vid = tmp.join("竖屏 旋转 视频.mp4");
        let mut cmd0 = Command::new(&tools.ffmpeg);
        configure_hidden_command(&mut cmd0);
        assert!(cmd0
            .args([
                "-hide_banner",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=0x102030:s=320x180:r=24:d=2.0",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=520:sample_rate=48000:duration=2.0",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                raw_vid.to_str().unwrap(),
            ])
            .status()
            .unwrap()
            .success());
        let mut cmd1 = Command::new(&tools.ffmpeg);
        configure_hidden_command(&mut cmd1);
        let st = cmd1
            .args([
                "-hide_banner",
                "-y",
                "-display_rotation",
                "90",
                "-i",
                raw_vid.to_str().unwrap(),
                "-c",
                "copy",
                src_vid.to_str().unwrap(),
            ])
            .status()
            .unwrap();
        assert!(st.success());

        // 2. Create a bright red semi-transparent PNG logo (alpha=220, RGB 255,40,40).
        let logo_path = tmp.join("logo 透明.png");
        let logo = RgbaImage::from_pixel(80, 80, Rgba([255, 40, 40, 220]));
        logo.save(&logo_path).unwrap();

        let out_vid = tmp.join("竖屏_watermarked.mp4");
        let cancel = AtomicBool::new(false);
        let res = watermark_video_impl(
            &tmp,
            &WatermarkVideoRequest {
                task_id: "t-i13-vid".into(),
                source_path: src_vid.to_string_lossy().to_string(),
                output_path: out_vid.to_string_lossy().to_string(),
                style: WatermarkStyleConfig {
                    stamp_png_data_url: None,
                    logo_path: Some(logo_path.to_string_lossy().to_string()),
                    placement: WatermarkPlacement::BottomRight,
                    scale_percent: 30.0,
                    margin_percent: 5.0,
                    opacity_percent: 90.0,
                    tile_angle_deg: None,
                    tile_spacing_percent: None,
                },
                allow_overwrite: Some(true),
            },
            &cancel,
            |_| {},
        )
        .unwrap();

        assert_eq!(res.output_width, 180);
        assert_eq!(res.output_height, 320);
        assert!(res.output_rotation.unwrap_or(0) == 0);
        assert!(res.has_audio);
        assert!(res.audio_copied);
        assert!((res.duration_sec.unwrap() - 2.0).abs() < 0.2);

        // Extract a frame at 1.0s and verify red logo landed in upright bottom-right corner, NOT top-left!
        let frame_png = tmp.join("check_frame.png");
        let mut cmd2 = Command::new(&tools.ffmpeg);
        configure_hidden_command(&mut cmd2);
        let st2 = cmd2
            .args([
                "-hide_banner",
                "-y",
                "-ss",
                "1.0",
                "-i",
                out_vid.to_str().unwrap(),
                "-frames:v",
                "1",
                frame_png.to_str().unwrap(),
            ])
            .status()
            .unwrap();
        assert!(st2.success());

        let img = image::open(&frame_png).unwrap().to_rgb8();
        assert_eq!(img.dimensions(), (180, 320));
        // Bottom-right region around (145, 285) should be strongly red (R > 160, B < 90)
        let br = img.get_pixel(145, 285).0;
        let tl = img.get_pixel(25, 25).0;
        assert!(
            br[0] > 150 && br[0] > br[2] + 80,
            "Expected red watermark in upright bottom-right, got {br:?}"
        );
        assert!(
            tl[0] < 50 && tl[2] >= tl[0],
            "Expected clean dark-blue background in top-left, got {tl:?}"
        );

        let _ = fs::remove_dir_all(&tmp);
    }
}
