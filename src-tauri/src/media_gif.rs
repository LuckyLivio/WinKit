//! V15 Video to GIF — converts full video or a selected time range into a high-quality
//! palette-optimized animated GIF (`palettegen` + `paletteuse`), preserving upright rotation,
//! aspect ratio, non-upscaling by default, configurable fps (10/15/24), width (320/480/640/original),
//! and loop mode (infinite vs play once).

use crate::error::AppError;
use crate::fs_guard::validate_existing_input_file;
use crate::media_core::{
    require_media_tools, resolve_single_output_path, run_ffmpeg_cancellable, AtomicMediaOutput,
    MediaPreviewRegistry, MediaTaskProgressPayload,
};
use crate::media_info::probe_media_info_impl;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GifWidthPreset {
    W320,
    W480,
    W640,
    Original,
}

impl GifWidthPreset {
    pub fn max_width_px(self) -> Option<u32> {
        match self {
            GifWidthPreset::W320 => Some(320),
            GifWidthPreset::W480 => Some(480),
            GifWidthPreset::W640 => Some(640),
            GifWidthPreset::Original => None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertVideoToGifRequest {
    pub task_id: String,
    pub source_path: String,
    pub output_path: String,
    pub start_sec: Option<f64>,
    pub end_sec: Option<f64>,
    pub fps: u32,
    pub width_preset: GifWidthPreset,
    pub loop_forever: bool,
    pub allow_upscale: Option<bool>,
    pub allow_overwrite: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertVideoToGifResult {
    pub output_path: String,
    pub preview_url: String,
    pub byte_size: u64,
    pub width: u32,
    pub height: u32,
    pub frame_count: usize,
    pub duration_sec: f64,
    pub fps: u32,
    pub loop_forever: bool,
    pub elapsed_ms: u64,
}

pub fn build_gif_filter_complex(
    fps: u32,
    width_preset: GifWidthPreset,
    allow_upscale: bool,
) -> String {
    let scale_part = match width_preset.max_width_px() {
        None => String::new(),
        Some(w) if allow_upscale => format!(",scale={w}:-2:flags=lanczos"),
        Some(w) => format!(",scale='min({w},iw)':-2:flags=lanczos"),
    };
    format!(
        "fps={fps}{scale_part},split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=sierra2_4a"
    )
}

#[derive(Debug)]
struct GifInspection {
    width: u32,
    height: u32,
    frame_count: usize,
    duration_sec: f64,
}

fn inspect_gif_file(path: &Path) -> Result<GifInspection, AppError> {
    let file = File::open(path)
        .map_err(|e| AppError::from_io(e, "Unable to open exported GIF for inspection"))?;
    let mut opts = gif::DecodeOptions::new();
    opts.set_color_output(gif::ColorOutput::Indexed);
    let mut decoder = opts
        .read_info(file)
        .map_err(|e| AppError::decode_failed(format!("Generated GIF header invalid: {e}")))?;
    let width = u32::from(decoder.width());
    let height = u32::from(decoder.height());
    let mut frame_count = 0usize;
    let mut total_cs: u64 = 0;
    while let Some(frame) = decoder
        .read_next_frame()
        .map_err(|e| AppError::decode_failed(format!("Error reading GIF frames: {e}")))?
    {
        frame_count += 1;
        total_cs = total_cs.saturating_add(u64::from(frame.delay));
    }
    Ok(GifInspection {
        width,
        height,
        frame_count,
        duration_sec: total_cs as f64 / 100.0,
    })
}

pub fn convert_video_to_gif_impl(
    media_root: &Path,
    preview_registry: &MediaPreviewRegistry,
    req: &ConvertVideoToGifRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(MediaTaskProgressPayload),
) -> Result<ConvertVideoToGifResult, AppError> {
    let t0 = Instant::now();
    let (source_path, _) = validate_existing_input_file(&req.source_path)?;
    if !matches!(req.fps, 10 | 15 | 24) {
        return Err(AppError::invalid_param(
            "GIF frame rate must be 10, 15, or 24 fps.",
        ));
    }

    let tools = require_media_tools(media_root)?;
    let probe = probe_media_info_impl(media_root, &req.source_path)?;
    if !probe.has_video {
        return Err(AppError::invalid_param(
            "Selected file contains no video stream.",
        ));
    }

    let start_sec = req.start_sec.unwrap_or(0.0).max(0.0);
    let end_sec = req.end_sec.or(probe.duration_sec);
    let target_dur = match end_sec {
        Some(e) if e > start_sec + 0.05 => Some(e - start_sec),
        Some(_) => {
            return Err(AppError::invalid_param(
                "End time must be at least 0.05 seconds after start time.",
            ))
        }
        None => probe.duration_sec,
    };

    let final_path = resolve_single_output_path(&req.output_path, &source_path)?;
    let allow_overwrite = req.allow_overwrite.unwrap_or(false);
    let atomic_out = AtomicMediaOutput::prepare(final_path, &source_path, allow_overwrite)?;
    let allow_upscale = req.allow_upscale.unwrap_or(false);
    let filter_complex = build_gif_filter_complex(req.fps, req.width_preset, allow_upscale);

    let mut args: Vec<String> = Vec::new();
    if start_sec > 0.0 {
        args.push("-ss".into());
        args.push(format!("{start_sec:.3}"));
    }
    args.push("-i".into());
    args.push(source_path.to_string_lossy().to_string());
    if let (Some(e), true) = (end_sec, req.end_sec.is_some()) {
        args.push("-t".into());
        args.push(format!("{:.3}", (e - start_sec).max(0.05)));
    }
    args.push("-an".into());
    args.push("-vf".into());
    args.push(filter_complex);
    args.push("-loop".into());
    // FFmpeg GIF muxer: 0 = infinite loop, -1 = no loop (play once)
    args.push(if req.loop_forever { "0" } else { "-1" }.into());
    args.push(atomic_out.temp_path().to_string_lossy().to_string());

    let file_name = source_path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string());
    let task_id = req.task_id.clone();

    on_progress(MediaTaskProgressPayload {
        task_id: task_id.clone(),
        tool_id: "V15".into(),
        phase: "running".into(),
        current_item: 1,
        total_items: 1,
        item_name: file_name.clone(),
        percent: Some(0.0),
        out_time_sec: Some(0.0),
        total_duration_sec: target_dur,
    });

    run_ffmpeg_cancellable(
        &tools.ffmpeg,
        &args,
        target_dur,
        cancel_flag,
        |out_sec, pct| {
            on_progress(MediaTaskProgressPayload {
                task_id: task_id.clone(),
                tool_id: "V15".into(),
                phase: "running".into(),
                current_item: 1,
                total_items: 1,
                item_name: file_name.clone(),
                percent: pct,
                out_time_sec: out_sec,
                total_duration_sec: target_dur,
            });
        },
    )?;

    let (committed_path, byte_size) = atomic_out.commit(allow_overwrite)?;
    let info = inspect_gif_file(&committed_path)?;
    let reg = preview_registry.register_path(&committed_path.to_string_lossy())?;

    Ok(ConvertVideoToGifResult {
        output_path: committed_path.to_string_lossy().to_string(),
        preview_url: reg.url,
        byte_size,
        width: info.width,
        height: info.height,
        frame_count: info.frame_count,
        duration_sec: info.duration_sec,
        fps: req.fps,
        loop_forever: req.loop_forever,
        elapsed_ms: t0.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media_core::get_media_tools_status_impl;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn gif_filter_complex_respects_no_upscale_default() {
        let f = build_gif_filter_complex(15, GifWidthPreset::W640, false);
        assert!(f.contains("fps=15"));
        assert!(f.contains("min(640,iw)"));
        assert!(f.contains("palettegen"));
        assert!(f.contains("paletteuse"));

        let f_orig = build_gif_filter_complex(10, GifWidthPreset::Original, false);
        assert!(!f_orig.contains("scale="));
    }

    #[test]
    fn converts_portrait_video_to_palette_gif_preserving_orientation_no_upscale_and_loop_bytes() {
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
                "testsrc2=size=320x180:rate=25:duration=2".into(),
                "-c:v".into(),
                "libx264".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
                raw.to_string_lossy().to_string(),
            ],
            Some(2.0),
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
            Some(2.0),
            &cancel,
            |_, _| {},
        )
        .unwrap();

        let reg = MediaPreviewRegistry::default();
        let out_loop = dir.path().join("out_loop.gif");
        let res_loop = convert_video_to_gif_impl(
            dir.path(),
            &reg,
            &ConvertVideoToGifRequest {
                task_id: "v15-loop".into(),
                source_path: portrait.to_string_lossy().to_string(),
                output_path: out_loop.to_string_lossy().to_string(),
                start_sec: Some(0.2),
                end_sec: Some(1.2),
                fps: 10,
                width_preset: GifWidthPreset::W640, // must NOT upscale 180px portrait!
                loop_forever: true,
                allow_upscale: Some(false),
                allow_overwrite: Some(false),
            },
            &cancel,
            |_| {},
        )
        .unwrap();

        assert_eq!(res_loop.width, 180);
        assert_eq!(res_loop.height, 320);
        assert!((8..=13).contains(&res_loop.frame_count));
        let loop_bytes = fs::read(&out_loop).unwrap();
        assert!(loop_bytes.windows(11).any(|w| w == b"NETSCAPE2.0"));

        let out_once = dir.path().join("out_once.gif");
        let res_once = convert_video_to_gif_impl(
            dir.path(),
            &reg,
            &ConvertVideoToGifRequest {
                task_id: "v15-once".into(),
                source_path: portrait.to_string_lossy().to_string(),
                output_path: out_once.to_string_lossy().to_string(),
                start_sec: Some(0.0),
                end_sec: Some(1.0),
                fps: 10,
                width_preset: GifWidthPreset::W320,
                loop_forever: false,
                allow_upscale: Some(false),
                allow_overwrite: Some(false),
            },
            &cancel,
            |_| {},
        )
        .unwrap();
        assert_eq!(res_once.width, 180);
        assert_eq!(res_once.height, 320);
        let once_bytes = fs::read(&out_once).unwrap();
        assert!(!once_bytes.windows(11).any(|w| w == b"NETSCAPE2.0"));
    }
}
