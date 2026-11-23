//! V09 Crop & Rotate Video — interactive display-coordinate crop, 90° left/right rotation,
//! and horizontal/vertical flipping.
//!
//! Operates strictly in the video's upright display orientation (matching phone portrait metadata),
//! applies rotation/flip transforms first and then crops `(crop_x, crop_y, crop_w, crop_h)` in the
//! transformed display canvas so what sits inside the user's crop box on screen matches the
//! exported video 1:1 with `setsar=1` and `rotate=0` (preventing double-rotation in any player).

use crate::error::AppError;
use crate::fs_guard::validate_existing_input_file;
use crate::media_core::{
    require_media_tools, run_ffmpeg_cancellable, AtomicMediaOutput, MediaTaskProgressPayload,
};
use crate::media_info::probe_media_info_impl;
use crate::media_resize::make_even_dim;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::Instant;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropRotateVideoRequest {
    pub task_id: String,
    pub source_path: String,
    pub output_path: String,
    /// Cumulative clockwise rotation in degrees applied to the upright display frame: 0, 90, 180, or 270.
    pub rotate_cw: u16,
    /// Horizontal flip applied AFTER `rotate_cw`.
    pub flip_h: bool,
    /// Vertical flip applied AFTER `flip_h`.
    pub flip_v: bool,
    /// Crop rectangle in the post-(rotate/flip) upright coordinate space.
    pub crop_x: u32,
    pub crop_y: u32,
    pub crop_width: u32,
    pub crop_height: u32,
    pub allow_overwrite: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CropRotateVideoResult {
    pub output_path: String,
    pub byte_size: u64,
    pub output_width: u32,
    pub output_height: u32,
    pub output_rotation: Option<i32>,
    pub duration_sec: Option<f64>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrientedPreviewFrame {
    pub data_url: String,
    pub display_width: u32,
    pub display_height: u32,
    pub timestamp_sec: f64,
}

/// Computes the oriented frame dimensions after applying `rotate_cw` to display `(disp_w, disp_h)`.
pub fn compute_oriented_dimensions(disp_w: u32, disp_h: u32, rotate_cw: u16) -> (u32, u32) {
    match rotate_cw % 360 {
        90 | 270 => (disp_h, disp_w),
        _ => (disp_w, disp_h),
    }
}

/// Sanitizes and clamps a crop rectangle inside `(oriented_w, oriented_h)` while guaranteeing
/// even output width & height for `yuv420p` H.264 compatibility.
pub fn normalize_crop_rect(
    oriented_w: u32,
    oriented_h: u32,
    crop_x: u32,
    crop_y: u32,
    crop_w: u32,
    crop_h: u32,
) -> Result<(u32, u32, u32, u32), AppError> {
    if oriented_w < 2 || oriented_h < 2 {
        return Err(AppError::invalid_param(
            "Video frame dimensions are too small.",
        ));
    }
    let max_w = (oriented_w / 2) * 2;
    let max_h = (oriented_h / 2) * 2;

    let mut x = crop_x.min(oriented_w.saturating_sub(2));
    let mut y = crop_y.min(oriented_h.saturating_sub(2));
    let mut w = make_even_dim(f64::from(crop_w.max(2))).min(max_w);
    let mut h = make_even_dim(f64::from(crop_h.max(2))).min(max_h);

    if x + w > oriented_w {
        x = oriented_w.saturating_sub(w);
    }
    if y + h > oriented_h {
        y = oriented_h.saturating_sub(h);
    }
    // Keep final crop bounds inside oriented frame
    w = w.min((oriented_w - x) / 2 * 2).max(2);
    h = h.min((oriented_h - y) / 2 * 2).max(2);
    Ok((x, y, w, h))
}

pub fn build_crop_rotate_vf(
    rotate_cw: u16,
    flip_h: bool,
    flip_v: bool,
    crop_x: u32,
    crop_y: u32,
    crop_w: u32,
    crop_h: u32,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    match rotate_cw % 360 {
        90 => parts.push("transpose=1".into()),
        180 => {
            parts.push("hflip".into());
            parts.push("vflip".into());
        }
        270 => parts.push("transpose=2".into()),
        _ => {}
    }
    if flip_h {
        parts.push("hflip".into());
    }
    if flip_v {
        parts.push("vflip".into());
    }
    parts.push(format!("crop={crop_w}:{crop_h}:{crop_x}:{crop_y}"));
    parts.push("setsar=1".into());
    parts.join(",")
}

/// Extracts an upright display-oriented frame as a JPEG data URL so the interactive V09 crop
/// canvas operates in exact display pixel coordinates even for rotated phone videos or codecs
/// WebView2 cannot natively decode.
pub fn extract_oriented_preview_frame_impl(
    media_root: &Path,
    source_path: &str,
    timestamp_sec: Option<f64>,
) -> Result<OrientedPreviewFrame, AppError> {
    let (src_path, _) = validate_existing_input_file(source_path)?;
    let tools = require_media_tools(media_root)?;
    let probe = probe_media_info_impl(media_root, source_path)?;
    let v0 = probe
        .video_streams
        .first()
        .ok_or_else(|| AppError::invalid_param("File contains no video stream."))?;
    let dur = probe.duration_sec.unwrap_or(0.0);
    let ts = timestamp_sec
        .unwrap_or_else(|| (dur * 0.1).min(0.5))
        .max(0.0)
        .min(dur.max(0.0));

    let tmp_dir = std::env::temp_dir();
    let tmp_jpg = tmp_dir.join(format!("winkit-v09-preview-{}.jpg", uuid::Uuid::new_v4()));
    let cancel = AtomicBool::new(false);

    let mut extracted = false;
    for attempt_ts in [ts, 0.0] {
        let _ = fs::remove_file(&tmp_jpg);
        let args = vec![
            "-ss".into(),
            format!("{attempt_ts:.3}"),
            "-i".into(),
            src_path.to_string_lossy().to_string(),
            "-frames:v".into(),
            "1".into(),
            "-q:v".into(),
            "3".into(),
            tmp_jpg.to_string_lossy().to_string(),
        ];
        if run_ffmpeg_cancellable(&tools.ffmpeg, &args, None, &cancel, |_, _| {}).is_ok()
            && fs::metadata(&tmp_jpg).is_ok_and(|m| m.len() > 0)
        {
            extracted = true;
            break;
        }
    }

    if !extracted {
        let _ = fs::remove_file(&tmp_jpg);
        return Err(AppError::decode_failed(
            "Unable to extract upright preview frame from video.",
        ));
    }

    let bytes =
        fs::read(&tmp_jpg).map_err(|e| AppError::from_io(e, "Failed reading preview frame"))?;
    let _ = fs::remove_file(&tmp_jpg);
    let dims = image::load_from_memory(&bytes)
        .map(|im| (im.width(), im.height()))
        .unwrap_or((
            v0.display_width.or(v0.coded_width).unwrap_or(1280),
            v0.display_height.or(v0.coded_height).unwrap_or(720),
        ));
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(OrientedPreviewFrame {
        data_url: format!("data:image/jpeg;base64,{b64}"),
        display_width: dims.0,
        display_height: dims.1,
        timestamp_sec: ts,
    })
}

pub fn crop_rotate_video_impl(
    media_root: &Path,
    req: &CropRotateVideoRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(MediaTaskProgressPayload),
) -> Result<CropRotateVideoResult, AppError> {
    let t0 = Instant::now();
    if !matches!(req.rotate_cw % 360, 0 | 90 | 180 | 270) {
        return Err(AppError::invalid_param(
            "Rotation angle must be 0, 90, 180, or 270 degrees.",
        ));
    }
    let (source_path, _) = validate_existing_input_file(&req.source_path)?;
    let out_path = PathBuf::from(req.output_path.trim());
    if !out_path.is_absolute() {
        return Err(AppError::invalid_param(
            "Output file path must be an absolute path.",
        ));
    }

    let tools = require_media_tools(media_root)?;
    let probe = probe_media_info_impl(media_root, &req.source_path)?;
    let v0 = probe
        .video_streams
        .first()
        .ok_or_else(|| AppError::invalid_param("File contains no video stream."))?;

    let disp_w = v0.display_width.or(v0.coded_width).unwrap_or(1280);
    let disp_h = v0.display_height.or(v0.coded_height).unwrap_or(720);
    let (oriented_w, oriented_h) = compute_oriented_dimensions(disp_w, disp_h, req.rotate_cw);
    let (cx, cy, cw, ch) = normalize_crop_rect(
        oriented_w,
        oriented_h,
        req.crop_x,
        req.crop_y,
        req.crop_width,
        req.crop_height,
    )?;

    let allow_overwrite = req.allow_overwrite.unwrap_or(false);
    let atomic = AtomicMediaOutput::prepare(out_path, &source_path, allow_overwrite)?;
    let vf = build_crop_rotate_vf(req.rotate_cw, req.flip_h, req.flip_v, cx, cy, cw, ch);

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
        "19".into(),
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
    let file_name = probe.file_name.clone();
    on_progress(MediaTaskProgressPayload {
        task_id: req.task_id.clone(),
        tool_id: "V09".into(),
        phase: "running".into(),
        current_item: 1,
        total_items: 1,
        item_name: Some(file_name.clone()),
        percent: Some(0.0),
        out_time_sec: Some(0.0),
        total_duration_sec: duration,
    });

    run_ffmpeg_cancellable(&tools.ffmpeg, &args, duration, cancel_flag, |out_t, pct| {
        on_progress(MediaTaskProgressPayload {
            task_id: req.task_id.clone(),
            tool_id: "V09".into(),
            phase: "running".into(),
            current_item: 1,
            total_items: 1,
            item_name: Some(file_name.clone()),
            percent: pct,
            out_time_sec: out_t,
            total_duration_sec: duration,
        });
    })?;

    let (final_path, byte_size) = atomic.commit(allow_overwrite)?;
    let final_str = final_path.to_string_lossy().to_string();
    let verified = probe_media_info_impl(media_root, &final_str).ok();
    let ov = verified.as_ref().and_then(|v| v.video_streams.first());

    on_progress(MediaTaskProgressPayload {
        task_id: req.task_id.clone(),
        tool_id: "V09".into(),
        phase: "completed".into(),
        current_item: 1,
        total_items: 1,
        item_name: Some(file_name),
        percent: Some(100.0),
        out_time_sec: duration,
        total_duration_sec: duration,
    });

    Ok(CropRotateVideoResult {
        output_path: final_str,
        byte_size,
        output_width: ov.and_then(|v| v.display_width).unwrap_or(cw),
        output_height: ov.and_then(|v| v.display_height).unwrap_or(ch),
        output_rotation: ov.and_then(|v| v.rotation_degrees),
        duration_sec: verified.as_ref().and_then(|v| v.duration_sec),
        elapsed_ms: t0.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn normalizes_crop_rectangles_to_even_dimensions_inside_oriented_bounds() {
        assert_eq!(compute_oriented_dimensions(360, 640, 90), (640, 360));
        assert_eq!(
            normalize_crop_rect(360, 640, 10, 20, 301, 301).unwrap(),
            (10, 20, 300, 300)
        );
        assert_eq!(
            normalize_crop_rect(360, 640, 300, 600, 200, 200).unwrap(),
            (160, 440, 200, 200)
        );
    }

    #[test]
    fn crops_and_flips_rotated_portrait_4corner_video_with_exact_pixel_and_dimension_fidelity() {
        let dir = tempdir().unwrap();
        let Ok(tools) = require_media_tools(dir.path()) else {
            return;
        };
        let cancel = AtomicBool::new(false);

        // Build upright 360x640 image (TL Red, TR Green, BL Blue, BR Yellow, white upward arrow)
        // Rotate 90 CW for stored landscape, then tag -display_rotation 90 so display is 360x640 upright
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
        let stored = image::imageops::rotate90(&upright);
        let raw_png = dir.path().join("stored_v09.png");
        stored.save(&raw_png).unwrap();
        let raw_mp4 = dir.path().join("raw_v09.mp4");
        let rot_mp4 = dir.path().join("portrait_rot90_v09.mp4");

        run_ffmpeg_cancellable(
            &tools.ffmpeg,
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
            &tools.ffmpeg,
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

        // Oriented preview must return upright 360x640
        let prev =
            extract_oriented_preview_frame_impl(dir.path(), &rot_mp4.to_string_lossy(), Some(0.2))
                .unwrap();
        assert_eq!((prev.display_width, prev.display_height), (360, 640));

        // Crop top half (360x320) AND Flip Horizontal:
        // Original top half has Left=Red, Right=Green -> flipped horizontally gives Left=Green, Right=Red!
        let out_mp4 = dir.path().join("cropped_flipped.mp4");
        let res = crop_rotate_video_impl(
            dir.path(),
            &CropRotateVideoRequest {
                task_id: "v09-crop-flip".into(),
                source_path: rot_mp4.to_string_lossy().to_string(),
                output_path: out_mp4.to_string_lossy().to_string(),
                rotate_cw: 0,
                flip_h: true,
                flip_v: false,
                crop_x: 0,
                crop_y: 0,
                crop_width: 360,
                crop_height: 320,
                allow_overwrite: Some(false),
            },
            &cancel,
            |_| {},
        )
        .unwrap();
        assert_eq!((res.output_width, res.output_height), (360, 320));
        assert!(res.output_rotation.unwrap_or(0) == 0);

        let check_png = dir.path().join("v09_check.png");
        run_ffmpeg_cancellable(
            &tools.ffmpeg,
            &[
                "-i".into(),
                out_mp4.to_string_lossy().to_string(),
                "-frames:v".into(),
                "1".into(),
                check_png.to_string_lossy().to_string(),
            ],
            None,
            &cancel,
            |_, _| {},
        )
        .unwrap();
        let im = image::open(&check_png).unwrap().to_rgb8();
        assert_eq!(im.dimensions(), (360, 320));
        let left_px = im.get_pixel(60, 160).0;
        let right_px = im.get_pixel(300, 160).0;
        assert!(
            left_px[1] > 120 && left_px[0] < 80,
            "expected Green on left after flip, got {left_px:?}"
        );
        assert!(
            right_px[0] > 170 && right_px[1] < 80,
            "expected Red on right after flip, got {right_px:?}"
        );
    }
}
