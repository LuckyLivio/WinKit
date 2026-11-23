//! V08 Resize Video — batch & single video resizing with common resolutions, square (1:1),
//! vertical (9:16), and custom dimensions. Clearly separates Fit (proportional inside bounds),
//! Pad (letterbox/pillarbox to exact target), Fill (crop to cover exact target), and Stretch
//! (only allowed when user explicitly unlocks aspect ratio). Always bakes upright display
//! pixels with `setsar=1` and zero residual rotation metadata.

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

const MIN_DIMENSION: u32 = 16;
const MAX_DIMENSION: u32 = 7680;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoResizeMode {
    Fit,
    Pad,
    Fill,
    Stretch,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeVideosBatchRequest {
    pub task_id: String,
    pub source_paths: Vec<String>,
    pub output_dir: String,
    pub target_width: u32,
    pub target_height: u32,
    pub mode: VideoResizeMode,
    pub lock_aspect_ratio: bool,
    pub prevent_upscale: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResizeItemStatus {
    Resized,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeVideoItemResult {
    pub source_path: String,
    pub file_name: String,
    pub status: ResizeItemStatus,
    pub output_path: Option<String>,
    pub output_bytes: Option<u64>,
    pub source_display_width: Option<u32>,
    pub source_display_height: Option<u32>,
    pub output_width: Option<u32>,
    pub output_height: Option<u32>,
    pub output_rotation: Option<i32>,
    pub elapsed_ms: u64,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeVideosBatchResponse {
    pub task_id: String,
    pub output_dir: String,
    pub cancelled: bool,
    pub resized_count: usize,
    pub skipped_count: usize,
    pub failed_count: usize,
    pub elapsed_ms: u64,
    pub items: Vec<ResizeVideoItemResult>,
}

pub fn make_even_dim(val: f64) -> u32 {
    let rounded = val.round().max(2.0) as u32;
    let even = (rounded / 2) * 2;
    even.max(2)
}

/// Computes exact output `(width, height)` for a display-oriented source `(src_w, src_h)`
/// under the selected resize mode. Matches the FFmpeg filtergraph 1:1.
pub fn compute_resize_output_dimensions(
    src_w: u32,
    src_h: u32,
    target_w: u32,
    target_h: u32,
    mode: VideoResizeMode,
    prevent_upscale: bool,
) -> (u32, u32) {
    let tw = make_even_dim(f64::from(target_w.clamp(MIN_DIMENSION, MAX_DIMENSION)));
    let th = make_even_dim(f64::from(target_h.clamp(MIN_DIMENSION, MAX_DIMENSION)));
    if src_w == 0 || src_h == 0 {
        return (tw, th);
    }

    match mode {
        VideoResizeMode::Pad | VideoResizeMode::Fill | VideoResizeMode::Stretch => (tw, th),
        VideoResizeMode::Fit => {
            let mut scale =
                (f64::from(tw) / f64::from(src_w)).min(f64::from(th) / f64::from(src_h));
            if prevent_upscale && scale > 1.0 {
                scale = 1.0;
            }
            let out_w = make_even_dim(f64::from(src_w) * scale).min(tw);
            let out_h = make_even_dim(f64::from(src_h) * scale).min(th);
            (out_w, out_h)
        }
    }
}

fn build_resize_vf(
    src_w: u32,
    src_h: u32,
    target_w: u32,
    target_h: u32,
    mode: VideoResizeMode,
    prevent_upscale: bool,
) -> String {
    let (out_w, out_h) =
        compute_resize_output_dimensions(src_w, src_h, target_w, target_h, mode, prevent_upscale);
    match mode {
        VideoResizeMode::Fit => {
            format!("scale={out_w}:{out_h}:flags=lanczos,setsar=1")
        }
        VideoResizeMode::Pad => {
            // Compute exact proportional inner size to guarantee even inner dims & zero distortion
            let scale = (f64::from(out_w) / f64::from(src_w.max(1)))
                .min(f64::from(out_h) / f64::from(src_h.max(1)));
            let inner_w = make_even_dim(f64::from(src_w.max(1)) * scale).min(out_w);
            let inner_h = make_even_dim(f64::from(src_h.max(1)) * scale).min(out_h);
            let pad_x = (out_w.saturating_sub(inner_w)) / 2;
            let pad_y = (out_h.saturating_sub(inner_h)) / 2;
            format!(
                "scale={inner_w}:{inner_h}:flags=lanczos,pad={out_w}:{out_h}:{pad_x}:{pad_y}:color=black,setsar=1"
            )
        }
        VideoResizeMode::Fill => {
            // Scale proportionally so both dims >= target, then exact center crop
            let scale = (f64::from(out_w) / f64::from(src_w.max(1)))
                .max(f64::from(out_h) / f64::from(src_h.max(1)));
            let cover_w = make_even_dim((f64::from(src_w.max(1)) * scale).ceil()).max(out_w);
            let cover_h = make_even_dim((f64::from(src_h.max(1)) * scale).ceil()).max(out_h);
            let crop_x = (cover_w.saturating_sub(out_w)) / 2;
            let crop_y = (cover_h.saturating_sub(out_h)) / 2;
            format!(
                "scale={cover_w}:{cover_h}:flags=lanczos,crop={out_w}:{out_h}:{crop_x}:{crop_y},setsar=1"
            )
        }
        VideoResizeMode::Stretch => {
            format!("scale={out_w}:{out_h}:flags=lanczos,setsar=1")
        }
    }
}

pub fn resize_videos_batch_impl(
    media_root: &Path,
    req: &ResizeVideosBatchRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(MediaTaskProgressPayload),
) -> Result<ResizeVideosBatchResponse, AppError> {
    let t0 = Instant::now();
    if req.source_paths.is_empty() {
        return Err(AppError::invalid_param(
            "Select at least one video file to resize.",
        ));
    }
    if req.target_width < MIN_DIMENSION
        || req.target_width > MAX_DIMENSION
        || req.target_height < MIN_DIMENSION
        || req.target_height > MAX_DIMENSION
    {
        return Err(AppError::invalid_param(format!(
            "Target width and height must be between {MIN_DIMENSION} and {MAX_DIMENSION} pixels."
        )));
    }
    if req.mode == VideoResizeMode::Stretch && req.lock_aspect_ratio {
        return Err(AppError::invalid_param(
            "Stretch mode requires explicitly unlocking aspect ratio.",
        ));
    }
    let out_dir = PathBuf::from(req.output_dir.trim());
    if !out_dir.is_absolute() {
        return Err(AppError::invalid_param(
            "Output directory must be an absolute path.",
        ));
    }

    let tools = require_media_tools(media_root)?;
    let prevent_upscale = req.prevent_upscale.unwrap_or(false);
    let total = req.source_paths.len();

    let mut results = Vec::with_capacity(total);
    let mut resized_count = 0usize;
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
            results.push(ResizeVideoItemResult {
                source_path: raw_src.clone(),
                file_name: fallback_name,
                status: ResizeItemStatus::Skipped,
                output_path: None,
                output_bytes: None,
                source_display_width: None,
                source_display_height: None,
                output_width: None,
                output_height: None,
                output_rotation: None,
                elapsed_ms: 0,
                message: Some("Cancelled before processing.".into()),
            });
            continue;
        }

        let (source_path, _) = match validate_existing_input_file(raw_src) {
            Ok(v) => v,
            Err(err) => {
                failed_count += 1;
                results.push(ResizeVideoItemResult {
                    source_path: raw_src.clone(),
                    file_name: fallback_name,
                    status: ResizeItemStatus::Failed,
                    output_path: None,
                    output_bytes: None,
                    source_display_width: None,
                    source_display_height: None,
                    output_width: None,
                    output_height: None,
                    output_rotation: None,
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
                results.push(ResizeVideoItemResult {
                    source_path: raw_src.clone(),
                    file_name: fallback_name,
                    status: ResizeItemStatus::Failed,
                    output_path: None,
                    output_bytes: None,
                    source_display_width: None,
                    source_display_height: None,
                    output_width: None,
                    output_height: None,
                    output_rotation: None,
                    elapsed_ms: item_t0.elapsed().as_millis() as u64,
                    message: Some(err.message),
                });
                continue;
            }
        };

        let Some(v0) = probe.video_streams.first() else {
            failed_count += 1;
            results.push(ResizeVideoItemResult {
                source_path: raw_src.clone(),
                file_name: probe.file_name,
                status: ResizeItemStatus::Failed,
                output_path: None,
                output_bytes: None,
                source_display_width: None,
                source_display_height: None,
                output_width: None,
                output_height: None,
                output_rotation: None,
                elapsed_ms: item_t0.elapsed().as_millis() as u64,
                message: Some("File contains no video stream.".into()),
            });
            continue;
        };

        let src_disp_w = v0.display_width.or(v0.coded_width).unwrap_or(1920);
        let src_disp_h = v0.display_height.or(v0.coded_height).unwrap_or(1080);
        let (expected_w, expected_h) = compute_resize_output_dimensions(
            src_disp_w,
            src_disp_h,
            req.target_width,
            req.target_height,
            req.mode,
            prevent_upscale,
        );
        let vf = build_resize_vf(
            src_disp_w,
            src_disp_h,
            req.target_width,
            req.target_height,
            req.mode,
            prevent_upscale,
        );

        let stem = source_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("video");
        let suffix = format!("_{expected_w}x{expected_h}");
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
                results.push(ResizeVideoItemResult {
                    source_path: raw_src.clone(),
                    file_name: probe.file_name,
                    status: ResizeItemStatus::Failed,
                    output_path: None,
                    output_bytes: None,
                    source_display_width: Some(src_disp_w),
                    source_display_height: Some(src_disp_h),
                    output_width: None,
                    output_height: None,
                    output_rotation: None,
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
                results.push(ResizeVideoItemResult {
                    source_path: raw_src.clone(),
                    file_name: probe.file_name,
                    status: ResizeItemStatus::Failed,
                    output_path: None,
                    output_bytes: None,
                    source_display_width: Some(src_disp_w),
                    source_display_height: Some(src_disp_h),
                    output_width: None,
                    output_height: None,
                    output_rotation: None,
                    elapsed_ms: item_t0.elapsed().as_millis() as u64,
                    message: Some(err.message),
                });
                continue;
            }
        };

        let mut args: Vec<String> = vec![
            "-i".into(),
            source_path.to_string_lossy().to_string(),
            "-map".into(),
            "0:v:0".into(),
        ];
        if probe.has_audio {
            args.extend(["-map".into(), "0:a?".into()]);
        } else {
            args.push("-an".into());
        }
        args.extend([
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
        ]);
        if probe.has_audio {
            args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "160k".into()]);
        }
        args.extend([
            "-f".into(),
            "mp4".into(),
            "-movflags".into(),
            "+faststart".into(),
            atomic.temp_path().to_string_lossy().to_string(),
        ]);

        let duration = probe.duration_sec;
        let item_name = probe.file_name.clone();
        on_progress(MediaTaskProgressPayload {
            task_id: req.task_id.clone(),
            tool_id: "V08".into(),
            phase: "running".into(),
            current_item: idx + 1,
            total_items: total,
            item_name: Some(item_name.clone()),
            percent: Some(((idx as f64) / (total as f64) * 100.0).clamp(0.0, 99.0)),
            out_time_sec: Some(0.0),
            total_duration_sec: duration,
        });

        let exec_res =
            run_ffmpeg_cancellable(&tools.ffmpeg, &args, duration, cancel_flag, |out_t, ip| {
                let overall = ip.map(|p| {
                    (((idx as f64) + (p / 100.0)) / (total as f64) * 100.0).clamp(0.0, 99.0)
                });
                on_progress(MediaTaskProgressPayload {
                    task_id: req.task_id.clone(),
                    tool_id: "V08".into(),
                    phase: "running".into(),
                    current_item: idx + 1,
                    total_items: total,
                    item_name: Some(item_name.clone()),
                    percent: overall,
                    out_time_sec: out_t,
                    total_duration_sec: duration,
                });
            });

        match exec_res {
            Ok(()) => match atomic.commit(false) {
                Ok((final_path, byte_size)) => {
                    let final_str = final_path.to_string_lossy().to_string();
                    let verified = probe_media_info_impl(media_root, &final_str).ok();
                    let ov = verified.as_ref().and_then(|v| v.video_streams.first());
                    resized_count += 1;
                    results.push(ResizeVideoItemResult {
                        source_path: raw_src.clone(),
                        file_name: probe.file_name,
                        status: ResizeItemStatus::Resized,
                        output_path: Some(final_str),
                        output_bytes: Some(byte_size),
                        source_display_width: Some(src_disp_w),
                        source_display_height: Some(src_disp_h),
                        output_width: ov.and_then(|v| v.display_width).or(Some(expected_w)),
                        output_height: ov.and_then(|v| v.display_height).or(Some(expected_h)),
                        output_rotation: ov.and_then(|v| v.rotation_degrees),
                        elapsed_ms: item_t0.elapsed().as_millis() as u64,
                        message: None,
                    });
                }
                Err(err) => {
                    failed_count += 1;
                    results.push(ResizeVideoItemResult {
                        source_path: raw_src.clone(),
                        file_name: probe.file_name,
                        status: ResizeItemStatus::Failed,
                        output_path: None,
                        output_bytes: None,
                        source_display_width: Some(src_disp_w),
                        source_display_height: Some(src_disp_h),
                        output_width: None,
                        output_height: None,
                        output_rotation: None,
                        elapsed_ms: item_t0.elapsed().as_millis() as u64,
                        message: Some(err.message),
                    });
                }
            },
            Err(err) if err.code == "TASK_CANCELLED" => {
                drop(atomic);
                cancelled = true;
                skipped_count += 1;
                results.push(ResizeVideoItemResult {
                    source_path: raw_src.clone(),
                    file_name: probe.file_name,
                    status: ResizeItemStatus::Skipped,
                    output_path: None,
                    output_bytes: None,
                    source_display_width: Some(src_disp_w),
                    source_display_height: Some(src_disp_h),
                    output_width: None,
                    output_height: None,
                    output_rotation: None,
                    elapsed_ms: item_t0.elapsed().as_millis() as u64,
                    message: Some("Cancelled during resize.".into()),
                });
            }
            Err(err) => {
                drop(atomic);
                failed_count += 1;
                results.push(ResizeVideoItemResult {
                    source_path: raw_src.clone(),
                    file_name: probe.file_name,
                    status: ResizeItemStatus::Failed,
                    output_path: None,
                    output_bytes: None,
                    source_display_width: Some(src_disp_w),
                    source_display_height: Some(src_disp_h),
                    output_width: None,
                    output_height: None,
                    output_rotation: None,
                    elapsed_ms: item_t0.elapsed().as_millis() as u64,
                    message: Some(err.message),
                });
            }
        }
    }

    on_progress(MediaTaskProgressPayload {
        task_id: req.task_id.clone(),
        tool_id: "V08".into(),
        phase: if cancelled { "cancelled" } else { "completed" }.into(),
        current_item: total,
        total_items: total,
        item_name: None,
        percent: Some(100.0),
        out_time_sec: None,
        total_duration_sec: None,
    });

    Ok(ResizeVideosBatchResponse {
        task_id: req.task_id.clone(),
        output_dir: out_dir.to_string_lossy().to_string(),
        cancelled,
        resized_count,
        skipped_count,
        failed_count,
        elapsed_ms: t0.elapsed().as_millis() as u64,
        items: results,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn computes_exact_fit_pad_fill_and_stretch_dimensions() {
        assert_eq!(
            compute_resize_output_dimensions(360, 640, 1080, 1080, VideoResizeMode::Fit, false),
            (608, 1080)
        );
        assert_eq!(
            compute_resize_output_dimensions(360, 640, 1080, 1080, VideoResizeMode::Fit, true),
            (360, 640)
        );
        assert_eq!(
            compute_resize_output_dimensions(360, 640, 1080, 1080, VideoResizeMode::Pad, false),
            (1080, 1080)
        );
        assert_eq!(
            compute_resize_output_dimensions(360, 640, 640, 360, VideoResizeMode::Fill, false),
            (640, 360)
        );
    }

    /// Generates a 90°-rotation-metadata portrait video (stored 640x360, display 360x640 upright)
    /// whose upright display corners are:
    /// TL = Red (220,38,38), TR = Green (22,163,74), BL = Blue (37,99,235), BR = Yellow (234,179,8),
    /// with a bright white upward arrow in the center.
    fn create_rotated_four_corner_clip(ffmpeg: &Path, dir: &Path) -> PathBuf {
        let cancel = AtomicBool::new(false);
        // Build upright 360x640 image first, then rotate 90 deg CW so that FFmpeg -display_rotation 90
        // (which rotates 90 deg CCW for display) restores the EXACT upright image!
        let mut upright = image::RgbImage::new(360, 640);
        for y in 0..640u32 {
            for x in 0..360u32 {
                let col = match (x < 180, y < 320) {
                    (true, true) => image::Rgb([220, 38, 38]),   // TL Red
                    (false, true) => image::Rgb([22, 163, 74]),  // TR Green
                    (true, false) => image::Rgb([37, 99, 235]),  // BL Blue
                    (false, false) => image::Rgb([234, 179, 8]), // BR Yellow
                };
                upright.put_pixel(x, y, col);
            }
        }
        // White upward arrow shaft + triangular head pointing UP (towards y=120)
        for y in 200..460u32 {
            for x in 170..190u32 {
                upright.put_pixel(x, y, image::Rgb([250, 250, 250]));
            }
        }
        for dy in 0..70u32 {
            let y = 130 + dy;
            for x in (180 - dy)..=(180 + dy) {
                upright.put_pixel(x, y, image::Rgb([250, 250, 250]));
            }
        }
        let stored = image::imageops::rotate90(&upright); // 640x360 stored landscape
        let raw_png = dir.join("stored_4corner.png");
        stored.save(&raw_png).unwrap();

        let raw_mp4 = dir.join("raw_4corner.mp4");
        let rot_mp4 = dir.join("portrait_rot90_4corner.mp4");
        run_ffmpeg_cancellable(
            ffmpeg,
            &[
                "-loop".into(),
                "1".into(),
                "-framerate".into(),
                "25".into(),
                "-t".into(),
                "1.5".into(),
                "-i".into(),
                raw_png.to_string_lossy().to_string(),
                "-c:v".into(),
                "libx264".into(),
                "-crf".into(),
                "12".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
                raw_mp4.to_string_lossy().to_string(),
            ],
            Some(1.5),
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
                raw_mp4.to_string_lossy().to_string(),
                "-map".into(),
                "0".into(),
                "-c".into(),
                "copy".into(),
                rot_mp4.to_string_lossy().to_string(),
            ],
            Some(1.5),
            &cancel,
            |_, _| {},
        )
        .unwrap();
        rot_mp4
    }

    #[test]
    fn resizes_rotated_portrait_in_pad_and_fill_modes_with_upright_corners_and_zero_rotation() {
        let dir = tempdir().unwrap();
        let Ok(tools) = require_media_tools(dir.path()) else {
            return;
        };
        let cancel = AtomicBool::new(false);
        let src = create_rotated_four_corner_clip(&tools.ffmpeg, dir.path());

        let out_dir = dir.path().join("resized");
        // 1. Pad to 640x640 (square): 360x640 portrait centered inside 640x640 -> black bars left/right!
        let res_pad = resize_videos_batch_impl(
            dir.path(),
            &ResizeVideosBatchRequest {
                task_id: "v08-pad".into(),
                source_paths: vec![src.to_string_lossy().to_string()],
                output_dir: out_dir.to_string_lossy().to_string(),
                target_width: 640,
                target_height: 640,
                mode: VideoResizeMode::Pad,
                lock_aspect_ratio: true,
                prevent_upscale: Some(false),
            },
            &cancel,
            |_| {},
        )
        .unwrap();
        assert_eq!(res_pad.resized_count, 1);
        let pad_item = &res_pad.items[0];
        assert_eq!(pad_item.output_width, Some(640));
        assert_eq!(pad_item.output_height, Some(640));
        assert!(pad_item.output_rotation.unwrap_or(0) == 0);

        let pad_png = dir.path().join("pad_check.png");
        run_ffmpeg_cancellable(
            &tools.ffmpeg,
            &[
                "-i".into(),
                pad_item.output_path.clone().unwrap(),
                "-frames:v".into(),
                "1".into(),
                pad_png.to_string_lossy().to_string(),
            ],
            None,
            &cancel,
            |_, _| {},
        )
        .unwrap();
        let im_pad = image::open(&pad_png).unwrap().to_rgb8();
        assert_eq!(im_pad.dimensions(), (640, 640));
        // Left & right pillarbox bars must be black
        let left_bar = im_pad.get_pixel(30, 320).0;
        let right_bar = im_pad.get_pixel(610, 320).0;
        assert!(
            left_bar[0] < 25 && left_bar[1] < 25 && left_bar[2] < 25,
            "left bar {left_bar:?}"
        );
        assert!(
            right_bar[0] < 25 && right_bar[1] < 25 && right_bar[2] < 25,
            "right bar {right_bar:?}"
        );
        // Content sits at x=140..500: TL Red, TR Green, BL Blue, BR Yellow
        let tl = im_pad.get_pixel(190, 60).0;
        let tr = im_pad.get_pixel(450, 60).0;
        let bl = im_pad.get_pixel(190, 580).0;
        let br = im_pad.get_pixel(450, 580).0;
        assert!(tl[0] > 170 && tl[1] < 80, "pad TL expected Red, got {tl:?}");
        assert!(
            tr[1] > 120 && tr[0] < 80,
            "pad TR expected Green, got {tr:?}"
        );
        assert!(
            bl[2] > 170 && bl[0] < 80,
            "pad BL expected Blue, got {bl:?}"
        );
        assert!(
            br[0] > 180 && br[1] > 140 && br[2] < 70,
            "pad BR expected Yellow, got {br:?}"
        );

        // 2. Fill to 360x360 (center crop of 360x640 upright -> exact 360x360 center with all 4 corners!)
        let res_fill = resize_videos_batch_impl(
            dir.path(),
            &ResizeVideosBatchRequest {
                task_id: "v08-fill".into(),
                source_paths: vec![src.to_string_lossy().to_string()],
                output_dir: out_dir.to_string_lossy().to_string(),
                target_width: 360,
                target_height: 360,
                mode: VideoResizeMode::Fill,
                lock_aspect_ratio: true,
                prevent_upscale: Some(false),
            },
            &cancel,
            |_| {},
        )
        .unwrap();
        assert_eq!(res_fill.resized_count, 1);
        let fill_item = &res_fill.items[0];
        assert_eq!(fill_item.output_width, Some(360));
        assert_eq!(fill_item.output_height, Some(360));
        assert!(fill_item.output_rotation.unwrap_or(0) == 0);

        let fill_png = dir.path().join("fill_check.png");
        run_ffmpeg_cancellable(
            &tools.ffmpeg,
            &[
                "-i".into(),
                fill_item.output_path.clone().unwrap(),
                "-frames:v".into(),
                "1".into(),
                fill_png.to_string_lossy().to_string(),
            ],
            None,
            &cancel,
            |_, _| {},
        )
        .unwrap();
        let im_fill = image::open(&fill_png).unwrap().to_rgb8();
        assert_eq!(im_fill.dimensions(), (360, 360));
        // Zero black bars: corners of 360x360 center crop are Red, Green, Blue, Yellow!
        let ftl = im_fill.get_pixel(40, 40).0;
        let ftr = im_fill.get_pixel(320, 40).0;
        let fbl = im_fill.get_pixel(40, 320).0;
        let fbr = im_fill.get_pixel(320, 320).0;
        assert!(
            ftl[0] > 170 && ftl[1] < 80,
            "fill TL expected Red, got {ftl:?}"
        );
        assert!(
            ftr[1] > 120 && ftr[0] < 80,
            "fill TR expected Green, got {ftr:?}"
        );
        assert!(
            fbl[2] > 170 && fbl[0] < 80,
            "fill BL expected Blue, got {fbl:?}"
        );
        assert!(
            fbr[0] > 180 && fbr[1] > 140 && fbr[2] < 70,
            "fill BR expected Yellow, got {fbr:?}"
        );
    }
}
