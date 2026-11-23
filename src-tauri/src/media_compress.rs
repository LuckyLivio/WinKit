//! V06 Compress Video — local H.264 / HEVC compression with High / Balanced / Small presets,
//! orientation-aware resolution capping (Original / 1080p / 720p / 480p, never upscaling),
//! verified hardware encoder detection via real short-clip trial encodes, and automatic
//! keep-original protection when re-encoding would enlarge an already-compact video.

use crate::error::AppError;
use crate::fs_guard::validate_existing_input_file;
use crate::media_core::{
    allocate_non_colliding_output_path, require_media_tools, run_ffmpeg_cancellable,
    AtomicMediaOutput, MediaTaskProgressPayload,
};
use crate::media_info::probe_media_info_impl;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompressQualityPreset {
    High,
    Balanced,
    Small,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompressVideoCodec {
    H264,
    Hevc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompressResolutionCap {
    Original,
    P1080,
    P720,
    P480,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoEncoderOption {
    pub id: String,
    pub codec: CompressVideoCodec,
    pub is_hardware: bool,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoEncoderCapabilities {
    pub ffmpeg_path: String,
    pub h264_encoders: Vec<VideoEncoderOption>,
    pub hevc_encoders: Vec<VideoEncoderOption>,
    pub has_hardware_h264: bool,
    pub has_hardware_hevc: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressVideosBatchRequest {
    pub task_id: String,
    pub source_paths: Vec<String>,
    pub output_dir: String,
    pub preset: CompressQualityPreset,
    pub codec: CompressVideoCodec,
    pub resolution_cap: CompressResolutionCap,
    /// `"software"`, `"auto_hardware"`, or an explicit verified encoder id such as `"h264_nvenc"`.
    pub encoder_preference: Option<String>,
    pub keep_audio: Option<bool>,
    pub keep_original_if_larger: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompressItemStatus {
    Compressed,
    KeptOriginal,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressVideoItemResult {
    pub source_path: String,
    pub file_name: String,
    pub status: CompressItemStatus,
    pub output_path: Option<String>,
    pub original_bytes: u64,
    pub output_bytes: Option<u64>,
    pub attempted_compressed_bytes: Option<u64>,
    pub saved_bytes: i64,
    pub saved_percent: f64,
    pub kept_original: bool,
    pub kept_original_reason: Option<String>,
    pub actual_encoder_used: Option<String>,
    pub used_hardware_encoder: bool,
    pub output_width: Option<u32>,
    pub output_height: Option<u32>,
    pub output_codec: Option<String>,
    pub elapsed_ms: u64,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressVideosBatchResponse {
    pub task_id: String,
    pub output_dir: String,
    pub cancelled: bool,
    pub compressed_count: usize,
    pub kept_original_count: usize,
    pub skipped_count: usize,
    pub failed_count: usize,
    pub total_original_bytes: u64,
    pub total_output_bytes: u64,
    pub total_saved_bytes: i64,
    pub total_saved_percent: f64,
    pub elapsed_ms: u64,
    pub items: Vec<CompressVideoItemResult>,
}

fn encoder_probe_cache() -> &'static Mutex<HashMap<String, VideoEncoderCapabilities>> {
    static CACHE: OnceLock<Mutex<HashMap<String, VideoEncoderCapabilities>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn trial_encode_works(ffmpeg: &Path, encoder_id: &str) -> bool {
    let mut cmd = Command::new(ffmpeg);
    cmd.args([
        "-hide_banner",
        "-y",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=256x256:r=30:d=0.1",
        "-frames:v",
        "3",
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        encoder_id,
        "-f",
        "null",
        "-",
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.status().is_ok_and(|s| s.success())
}

fn list_compiled_encoders(ffmpeg: &Path) -> String {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-encoders"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default()
}

/// Probes software and hardware video encoders using real short-clip trial encodes and caches
/// the verified capability table per FFmpeg binary path.
pub fn probe_video_encoders_impl(media_root: &Path) -> Result<VideoEncoderCapabilities, AppError> {
    let tools = require_media_tools(media_root)?;
    let key = tools.ffmpeg.to_string_lossy().to_string();

    if let Ok(cache) = encoder_probe_cache().lock() {
        if let Some(existing) = cache.get(&key) {
            return Ok(existing.clone());
        }
    }

    let compiled = list_compiled_encoders(&tools.ffmpeg);

    let h264_candidates: [(&str, bool, &str); 5] = [
        ("libx264", false, "Software (libx264 · CPU)"),
        ("h264_nvenc", true, "NVIDIA NVENC (h264_nvenc)"),
        ("h264_qsv", true, "Intel Quick Sync (h264_qsv)"),
        ("h264_amf", true, "AMD AMF (h264_amf)"),
        ("h264_mf", true, "Windows Media Foundation (h264_mf)"),
    ];
    let hevc_candidates: [(&str, bool, &str); 5] = [
        ("libx265", false, "Software (libx265 · CPU)"),
        ("hevc_nvenc", true, "NVIDIA NVENC (hevc_nvenc)"),
        ("hevc_qsv", true, "Intel Quick Sync (hevc_qsv)"),
        ("hevc_amf", true, "AMD AMF (hevc_amf)"),
        ("hevc_mf", true, "Windows Media Foundation (hevc_mf)"),
    ];

    let mut h264_encoders = Vec::new();
    for (id, is_hw, label) in h264_candidates {
        if !compiled.contains(id) {
            continue;
        }
        if !is_hw || trial_encode_works(&tools.ffmpeg, id) {
            h264_encoders.push(VideoEncoderOption {
                id: id.to_string(),
                codec: CompressVideoCodec::H264,
                is_hardware: is_hw,
                label: label.to_string(),
            });
        }
    }
    if h264_encoders.is_empty() {
        h264_encoders.push(VideoEncoderOption {
            id: "libx264".into(),
            codec: CompressVideoCodec::H264,
            is_hardware: false,
            label: "Software (libx264 · CPU)".into(),
        });
    }

    let mut hevc_encoders = Vec::new();
    for (id, is_hw, label) in hevc_candidates {
        if !compiled.contains(id) {
            continue;
        }
        if !is_hw || trial_encode_works(&tools.ffmpeg, id) {
            hevc_encoders.push(VideoEncoderOption {
                id: id.to_string(),
                codec: CompressVideoCodec::Hevc,
                is_hardware: is_hw,
                label: label.to_string(),
            });
        }
    }
    if hevc_encoders.is_empty() {
        hevc_encoders.push(VideoEncoderOption {
            id: "libx265".into(),
            codec: CompressVideoCodec::Hevc,
            is_hardware: false,
            label: "Software (libx265 · CPU)".into(),
        });
    }

    let caps = VideoEncoderCapabilities {
        ffmpeg_path: key.clone(),
        has_hardware_h264: h264_encoders.iter().any(|e| e.is_hardware),
        has_hardware_hevc: hevc_encoders.iter().any(|e| e.is_hardware),
        h264_encoders,
        hevc_encoders,
    };

    if let Ok(mut cache) = encoder_probe_cache().lock() {
        cache.insert(key, caps.clone());
    }
    Ok(caps)
}

/// Computes the exact capped dimensions for display `(w, h)` without upscaling, preserving aspect
/// ratio and guaranteeing even width & height for `yuv420p` compatibility.
pub fn compute_capped_dimensions(
    display_w: u32,
    display_h: u32,
    cap: CompressResolutionCap,
) -> (u32, u32, bool) {
    let make_even = |v: f64| -> u32 {
        let rounded = v.round().max(2.0) as u32;
        (rounded / 2) * 2
    };
    let (max_long, max_short) = match cap {
        CompressResolutionCap::Original => {
            return (
                make_even(display_w as f64),
                make_even(display_h as f64),
                false,
            )
        }
        CompressResolutionCap::P1080 => (1920u32, 1080u32),
        CompressResolutionCap::P720 => (1280u32, 720u32),
        CompressResolutionCap::P480 => (854u32, 480u32),
    };

    let is_landscape = display_w >= display_h;
    let (bound_w, bound_h) = if is_landscape {
        (max_long, max_short)
    } else {
        (max_short, max_long)
    };

    if display_w <= bound_w && display_h <= bound_h {
        return (
            make_even(display_w as f64),
            make_even(display_h as f64),
            false,
        );
    }

    let scale =
        (f64::from(bound_w) / f64::from(display_w)).min(f64::from(bound_h) / f64::from(display_h));
    let out_w = make_even(f64::from(display_w) * scale);
    let out_h = make_even(f64::from(display_h) * scale);
    (out_w, out_h, true)
}

fn build_cap_scale_filter(cap: CompressResolutionCap) -> String {
    match cap {
        CompressResolutionCap::Original => {
            "scale=trunc(iw/2)*2:trunc(ih/2)*2".to_string()
        }
        CompressResolutionCap::P1080 => {
            "scale='if(gte(iw,ih),min(1920,iw),min(1080,iw))':'if(gte(iw,ih),min(1080,ih),min(1920,ih))':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos".to_string()
        }
        CompressResolutionCap::P720 => {
            "scale='if(gte(iw,ih),min(1280,iw),min(720,iw))':'if(gte(iw,ih),min(720,ih),min(1280,ih))':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos".to_string()
        }
        CompressResolutionCap::P480 => {
            "scale='if(gte(iw,ih),min(854,iw),min(480,iw))':'if(gte(iw,ih),min(480,ih),min(854,ih))':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos".to_string()
        }
    }
}

fn select_encoder_chain(
    caps: &VideoEncoderCapabilities,
    codec: CompressVideoCodec,
    preference: Option<&str>,
) -> Vec<(String, bool)> {
    let available = match codec {
        CompressVideoCodec::H264 => &caps.h264_encoders,
        CompressVideoCodec::Hevc => &caps.hevc_encoders,
    };
    let software_id = match codec {
        CompressVideoCodec::H264 => "libx264".to_string(),
        CompressVideoCodec::Hevc => "libx265".to_string(),
    };
    let pref = preference.unwrap_or("software").trim();

    if pref.is_empty() || pref == "software" {
        return vec![(software_id, false)];
    }

    if pref == "auto_hardware" {
        if let Some(hw) = available.iter().find(|e| e.is_hardware) {
            return vec![(hw.id.clone(), true), (software_id, false)];
        }
        return vec![(software_id, false)];
    }

    if let Some(exact) = available.iter().find(|e| e.id == pref) {
        if exact.is_hardware {
            return vec![(exact.id.clone(), true), (software_id, false)];
        }
        return vec![(exact.id.clone(), false)];
    }

    vec![(software_id, false)]
}

#[allow(clippy::too_many_arguments)]
fn build_compress_ffmpeg_args(
    source_path: &Path,
    temp_out_path: &Path,
    encoder_id: &str,
    codec: CompressVideoCodec,
    preset: CompressQualityPreset,
    resolution_cap: CompressResolutionCap,
    keep_audio: bool,
    has_audio: bool,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-i".into(),
        source_path.to_string_lossy().to_string(),
        "-map".into(),
        "0:v:0".into(),
    ];
    if keep_audio && has_audio {
        args.extend(["-map".into(), "0:a?".into()]);
    } else {
        args.push("-an".into());
    }

    args.extend([
        "-vf".into(),
        build_cap_scale_filter(resolution_cap),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-c:v".into(),
        encoder_id.to_string(),
    ]);

    match encoder_id {
        "libx264" => {
            let crf = match preset {
                CompressQualityPreset::High => "20",
                CompressQualityPreset::Balanced => "24",
                CompressQualityPreset::Small => "29",
            };
            args.extend(["-crf".into(), crf.into(), "-preset".into(), "medium".into()]);
        }
        "libx265" => {
            let crf = match preset {
                CompressQualityPreset::High => "24",
                CompressQualityPreset::Balanced => "28",
                CompressQualityPreset::Small => "33",
            };
            args.extend([
                "-crf".into(),
                crf.into(),
                "-preset".into(),
                "medium".into(),
                "-x265-params".into(),
                "log-level=error".into(),
            ]);
        }
        "h264_nvenc" | "hevc_nvenc" => {
            let cq = match (codec, preset) {
                (CompressVideoCodec::H264, CompressQualityPreset::High) => "21",
                (CompressVideoCodec::H264, CompressQualityPreset::Balanced) => "26",
                (CompressVideoCodec::H264, CompressQualityPreset::Small) => "32",
                (CompressVideoCodec::Hevc, CompressQualityPreset::High) => "24",
                (CompressVideoCodec::Hevc, CompressQualityPreset::Balanced) => "29",
                (CompressVideoCodec::Hevc, CompressQualityPreset::Small) => "35",
            };
            args.extend([
                "-rc".into(),
                "vbr".into(),
                "-cq".into(),
                cq.into(),
                "-b:v".into(),
                "0".into(),
                "-preset".into(),
                "p5".into(),
            ]);
        }
        "h264_qsv" | "hevc_qsv" => {
            let q = match (codec, preset) {
                (CompressVideoCodec::H264, CompressQualityPreset::High) => "21",
                (CompressVideoCodec::H264, CompressQualityPreset::Balanced) => "26",
                (CompressVideoCodec::H264, CompressQualityPreset::Small) => "32",
                (CompressVideoCodec::Hevc, CompressQualityPreset::High) => "24",
                (CompressVideoCodec::Hevc, CompressQualityPreset::Balanced) => "29",
                (CompressVideoCodec::Hevc, CompressQualityPreset::Small) => "35",
            };
            args.extend(["-global_quality".into(), q.into()]);
        }
        "h264_amf" | "hevc_amf" => {
            let qp = match preset {
                CompressQualityPreset::High => "22",
                CompressQualityPreset::Balanced => "27",
                CompressQualityPreset::Small => "33",
            };
            args.extend([
                "-rc".into(),
                "cqp".into(),
                "-qp_i".into(),
                qp.into(),
                "-qp_p".into(),
                qp.into(),
            ]);
        }
        "h264_mf" | "hevc_mf" => {
            let q = match preset {
                CompressQualityPreset::High => "80",
                CompressQualityPreset::Balanced => "65",
                CompressQualityPreset::Small => "48",
            };
            args.extend([
                "-rate_control".into(),
                "quality".into(),
                "-quality".into(),
                q.into(),
            ]);
        }
        _ => {}
    }

    if codec == CompressVideoCodec::Hevc {
        args.extend(["-tag:v".into(), "hvc1".into()]);
    }

    if keep_audio && has_audio {
        let ab = match preset {
            CompressQualityPreset::High => "192k",
            CompressQualityPreset::Balanced => "128k",
            CompressQualityPreset::Small => "96k",
        };
        args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), ab.into()]);
    }

    args.extend([
        "-f".into(),
        "mp4".into(),
        "-movflags".into(),
        "+faststart".into(),
        temp_out_path.to_string_lossy().to_string(),
    ]);
    args
}

pub fn compress_videos_batch_impl(
    media_root: &Path,
    req: &CompressVideosBatchRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(MediaTaskProgressPayload),
) -> Result<CompressVideosBatchResponse, AppError> {
    let t0 = Instant::now();
    if req.source_paths.is_empty() {
        return Err(AppError::invalid_param(
            "Select at least one video file to compress.",
        ));
    }
    let out_dir = PathBuf::from(req.output_dir.trim());
    if !out_dir.is_absolute() {
        return Err(AppError::invalid_param(
            "Output directory must be an absolute path.",
        ));
    }

    let tools = require_media_tools(media_root)?;
    let caps = probe_video_encoders_impl(media_root)?;
    let encoder_chain = select_encoder_chain(&caps, req.codec, req.encoder_preference.as_deref());
    let keep_audio = req.keep_audio.unwrap_or(true);
    let keep_original_if_larger = req.keep_original_if_larger.unwrap_or(true);

    let total = req.source_paths.len();
    let mut results: Vec<CompressVideoItemResult> = Vec::with_capacity(total);
    let mut compressed_count = 0usize;
    let mut kept_original_count = 0usize;
    let mut skipped_count = 0usize;
    let mut failed_count = 0usize;
    let mut total_original_bytes = 0u64;
    let mut total_output_bytes = 0u64;
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
            results.push(CompressVideoItemResult {
                source_path: raw_src.clone(),
                file_name: fallback_name,
                status: CompressItemStatus::Skipped,
                output_path: None,
                original_bytes: 0,
                output_bytes: None,
                attempted_compressed_bytes: None,
                saved_bytes: 0,
                saved_percent: 0.0,
                kept_original: false,
                kept_original_reason: None,
                actual_encoder_used: None,
                used_hardware_encoder: false,
                output_width: None,
                output_height: None,
                output_codec: None,
                elapsed_ms: 0,
                message: Some("Cancelled before processing.".into()),
            });
            continue;
        }

        let (source_path, original_bytes) = match validate_existing_input_file(raw_src) {
            Ok(v) => v,
            Err(err) => {
                failed_count += 1;
                results.push(CompressVideoItemResult {
                    source_path: raw_src.clone(),
                    file_name: fallback_name,
                    status: CompressItemStatus::Failed,
                    output_path: None,
                    original_bytes: 0,
                    output_bytes: None,
                    attempted_compressed_bytes: None,
                    saved_bytes: 0,
                    saved_percent: 0.0,
                    kept_original: false,
                    kept_original_reason: None,
                    actual_encoder_used: None,
                    used_hardware_encoder: false,
                    output_width: None,
                    output_height: None,
                    output_codec: None,
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
                results.push(CompressVideoItemResult {
                    source_path: raw_src.clone(),
                    file_name: fallback_name,
                    status: CompressItemStatus::Failed,
                    output_path: None,
                    original_bytes,
                    output_bytes: None,
                    attempted_compressed_bytes: None,
                    saved_bytes: 0,
                    saved_percent: 0.0,
                    kept_original: false,
                    kept_original_reason: None,
                    actual_encoder_used: None,
                    used_hardware_encoder: false,
                    output_width: None,
                    output_height: None,
                    output_codec: None,
                    elapsed_ms: item_t0.elapsed().as_millis() as u64,
                    message: Some(err.message),
                });
                continue;
            }
        };

        if !probe.has_video {
            failed_count += 1;
            results.push(CompressVideoItemResult {
                source_path: raw_src.clone(),
                file_name: probe.file_name,
                status: CompressItemStatus::Failed,
                output_path: None,
                original_bytes,
                output_bytes: None,
                attempted_compressed_bytes: None,
                saved_bytes: 0,
                saved_percent: 0.0,
                kept_original: false,
                kept_original_reason: None,
                actual_encoder_used: None,
                used_hardware_encoder: false,
                output_width: None,
                output_height: None,
                output_codec: None,
                elapsed_ms: item_t0.elapsed().as_millis() as u64,
                message: Some("File contains no video stream.".into()),
            });
            continue;
        }

        let stem = source_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("video");
        let target_mp4 = match allocate_non_colliding_output_path(
            &out_dir,
            stem,
            "_compressed",
            "mp4",
            &source_path,
        ) {
            Ok(p) => p,
            Err(err) => {
                failed_count += 1;
                results.push(CompressVideoItemResult {
                    source_path: raw_src.clone(),
                    file_name: probe.file_name,
                    status: CompressItemStatus::Failed,
                    output_path: None,
                    original_bytes,
                    output_bytes: None,
                    attempted_compressed_bytes: None,
                    saved_bytes: 0,
                    saved_percent: 0.0,
                    kept_original: false,
                    kept_original_reason: None,
                    actual_encoder_used: None,
                    used_hardware_encoder: false,
                    output_width: None,
                    output_height: None,
                    output_codec: None,
                    elapsed_ms: item_t0.elapsed().as_millis() as u64,
                    message: Some(err.message),
                });
                continue;
            }
        };

        let atomic = match AtomicMediaOutput::prepare(target_mp4, &source_path, false) {
            Ok(a) => a,
            Err(err) => {
                failed_count += 1;
                results.push(CompressVideoItemResult {
                    source_path: raw_src.clone(),
                    file_name: probe.file_name,
                    status: CompressItemStatus::Failed,
                    output_path: None,
                    original_bytes,
                    output_bytes: None,
                    attempted_compressed_bytes: None,
                    saved_bytes: 0,
                    saved_percent: 0.0,
                    kept_original: false,
                    kept_original_reason: None,
                    actual_encoder_used: None,
                    used_hardware_encoder: false,
                    output_width: None,
                    output_height: None,
                    output_codec: None,
                    elapsed_ms: item_t0.elapsed().as_millis() as u64,
                    message: Some(err.message),
                });
                continue;
            }
        };

        let duration = probe.duration_sec;
        let item_name = probe.file_name.clone();
        on_progress(MediaTaskProgressPayload {
            task_id: req.task_id.clone(),
            tool_id: "V06".into(),
            phase: "running".into(),
            current_item: idx + 1,
            total_items: total,
            item_name: Some(item_name.clone()),
            percent: Some(((idx as f64) / (total as f64) * 100.0).clamp(0.0, 99.0)),
            out_time_sec: Some(0.0),
            total_duration_sec: duration,
        });

        let mut used_encoder: Option<(String, bool)> = None;
        let mut last_err: Option<AppError> = None;
        let mut item_cancelled = false;

        for (enc_id, is_hw) in &encoder_chain {
            let _ = fs::remove_file(atomic.temp_path());
            let args = build_compress_ffmpeg_args(
                &source_path,
                atomic.temp_path(),
                enc_id,
                req.codec,
                req.preset,
                req.resolution_cap,
                keep_audio,
                probe.has_audio,
            );
            match run_ffmpeg_cancellable(
                &tools.ffmpeg,
                &args,
                duration,
                cancel_flag,
                |out_t, ip| {
                    let overall = ip.map(|p| {
                        (((idx as f64) + (p / 100.0)) / (total as f64) * 100.0).clamp(0.0, 99.0)
                    });
                    on_progress(MediaTaskProgressPayload {
                        task_id: req.task_id.clone(),
                        tool_id: "V06".into(),
                        phase: "running".into(),
                        current_item: idx + 1,
                        total_items: total,
                        item_name: Some(item_name.clone()),
                        percent: overall,
                        out_time_sec: out_t,
                        total_duration_sec: duration,
                    });
                },
            ) {
                Ok(()) => {
                    used_encoder = Some((enc_id.clone(), *is_hw));
                    break;
                }
                Err(e) if e.code == "TASK_CANCELLED" => {
                    item_cancelled = true;
                    break;
                }
                Err(e) => {
                    last_err = Some(e);
                }
            }
        }

        if item_cancelled {
            drop(atomic);
            cancelled = true;
            skipped_count += 1;
            results.push(CompressVideoItemResult {
                source_path: raw_src.clone(),
                file_name: probe.file_name,
                status: CompressItemStatus::Skipped,
                output_path: None,
                original_bytes,
                output_bytes: None,
                attempted_compressed_bytes: None,
                saved_bytes: 0,
                saved_percent: 0.0,
                kept_original: false,
                kept_original_reason: None,
                actual_encoder_used: None,
                used_hardware_encoder: false,
                output_width: None,
                output_height: None,
                output_codec: None,
                elapsed_ms: item_t0.elapsed().as_millis() as u64,
                message: Some("Cancelled during compression.".into()),
            });
            continue;
        }

        let Some((encoder_used, used_hw)) = used_encoder else {
            drop(atomic);
            failed_count += 1;
            results.push(CompressVideoItemResult {
                source_path: raw_src.clone(),
                file_name: probe.file_name,
                status: CompressItemStatus::Failed,
                output_path: None,
                original_bytes,
                output_bytes: None,
                attempted_compressed_bytes: None,
                saved_bytes: 0,
                saved_percent: 0.0,
                kept_original: false,
                kept_original_reason: None,
                actual_encoder_used: None,
                used_hardware_encoder: false,
                output_width: None,
                output_height: None,
                output_codec: None,
                elapsed_ms: item_t0.elapsed().as_millis() as u64,
                message: Some(
                    last_err
                        .map(|e| e.message)
                        .unwrap_or_else(|| "Video compression failed.".into()),
                ),
            });
            continue;
        };

        let compressed_bytes = fs::metadata(atomic.temp_path())
            .map(|m| m.len())
            .unwrap_or(0);

        if keep_original_if_larger && compressed_bytes >= original_bytes {
            // Discard larger re-encode and write an exact untouched copy of the original to the output folder
            drop(atomic);
            let orig_ext = source_path
                .extension()
                .and_then(|e| e.to_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("mp4");
            let kept_target = allocate_non_colliding_output_path(
                &out_dir,
                stem,
                "_original",
                orig_ext,
                &source_path,
            );
            match kept_target.and_then(|dst| {
                let cp_atomic = AtomicMediaOutput::prepare(dst, &source_path, false)?;
                fs::copy(&source_path, cp_atomic.temp_path())
                    .map_err(|e| AppError::from_io(e, "Failed copying original video"))?;
                cp_atomic.commit(false)
            }) {
                Ok((final_path, final_bytes)) => {
                    kept_original_count += 1;
                    total_original_bytes = total_original_bytes.saturating_add(original_bytes);
                    total_output_bytes = total_output_bytes.saturating_add(final_bytes);
                    let v0 = probe.video_streams.first();
                    results.push(CompressVideoItemResult {
                        source_path: raw_src.clone(),
                        file_name: probe.file_name,
                        status: CompressItemStatus::KeptOriginal,
                        output_path: Some(final_path.to_string_lossy().to_string()),
                        original_bytes,
                        output_bytes: Some(final_bytes),
                        attempted_compressed_bytes: Some(compressed_bytes),
                        saved_bytes: 0,
                        saved_percent: 0.0,
                        kept_original: true,
                        kept_original_reason: Some(format!(
                            "Re-encoded output ({compressed_bytes} B) was not smaller than the already-compact source ({original_bytes} B); kept original bytes without quality loss."
                        )),
                        actual_encoder_used: Some(encoder_used),
                        used_hardware_encoder: used_hw,
                        output_width: v0.and_then(|v| v.display_width),
                        output_height: v0.and_then(|v| v.display_height),
                        output_codec: v0.and_then(|v| v.codec_name.clone()),
                        elapsed_ms: item_t0.elapsed().as_millis() as u64,
                        message: None,
                    });
                }
                Err(err) => {
                    failed_count += 1;
                    results.push(CompressVideoItemResult {
                        source_path: raw_src.clone(),
                        file_name: probe.file_name,
                        status: CompressItemStatus::Failed,
                        output_path: None,
                        original_bytes,
                        output_bytes: None,
                        attempted_compressed_bytes: Some(compressed_bytes),
                        saved_bytes: 0,
                        saved_percent: 0.0,
                        kept_original: false,
                        kept_original_reason: None,
                        actual_encoder_used: Some(encoder_used),
                        used_hardware_encoder: used_hw,
                        output_width: None,
                        output_height: None,
                        output_codec: None,
                        elapsed_ms: item_t0.elapsed().as_millis() as u64,
                        message: Some(err.message),
                    });
                }
            }
            continue;
        }

        match atomic.commit(false) {
            Ok((final_path, final_bytes)) => {
                let final_str = final_path.to_string_lossy().to_string();
                let out_probe = probe_media_info_impl(media_root, &final_str).ok();
                let ov = out_probe.as_ref().and_then(|p| p.video_streams.first());
                let saved_bytes = (original_bytes as i64) - (final_bytes as i64);
                let saved_percent = if original_bytes > 0 {
                    (saved_bytes as f64 / original_bytes as f64) * 100.0
                } else {
                    0.0
                };
                compressed_count += 1;
                total_original_bytes = total_original_bytes.saturating_add(original_bytes);
                total_output_bytes = total_output_bytes.saturating_add(final_bytes);

                results.push(CompressVideoItemResult {
                    source_path: raw_src.clone(),
                    file_name: probe.file_name,
                    status: CompressItemStatus::Compressed,
                    output_path: Some(final_str),
                    original_bytes,
                    output_bytes: Some(final_bytes),
                    attempted_compressed_bytes: Some(final_bytes),
                    saved_bytes,
                    saved_percent,
                    kept_original: false,
                    kept_original_reason: None,
                    actual_encoder_used: Some(encoder_used),
                    used_hardware_encoder: used_hw,
                    output_width: ov.and_then(|v| v.display_width),
                    output_height: ov.and_then(|v| v.display_height),
                    output_codec: ov.and_then(|v| v.codec_name.clone()),
                    elapsed_ms: item_t0.elapsed().as_millis() as u64,
                    message: None,
                });
            }
            Err(err) => {
                failed_count += 1;
                results.push(CompressVideoItemResult {
                    source_path: raw_src.clone(),
                    file_name: probe.file_name,
                    status: CompressItemStatus::Failed,
                    output_path: None,
                    original_bytes,
                    output_bytes: None,
                    attempted_compressed_bytes: Some(compressed_bytes),
                    saved_bytes: 0,
                    saved_percent: 0.0,
                    kept_original: false,
                    kept_original_reason: None,
                    actual_encoder_used: Some(encoder_used),
                    used_hardware_encoder: used_hw,
                    output_width: None,
                    output_height: None,
                    output_codec: None,
                    elapsed_ms: item_t0.elapsed().as_millis() as u64,
                    message: Some(err.message),
                });
            }
        }
    }

    let total_saved_bytes = (total_original_bytes as i64) - (total_output_bytes as i64);
    let total_saved_percent = if total_original_bytes > 0 {
        (total_saved_bytes as f64 / total_original_bytes as f64) * 100.0
    } else {
        0.0
    };

    on_progress(MediaTaskProgressPayload {
        task_id: req.task_id.clone(),
        tool_id: "V06".into(),
        phase: if cancelled { "cancelled" } else { "completed" }.into(),
        current_item: total,
        total_items: total,
        item_name: None,
        percent: Some(100.0),
        out_time_sec: None,
        total_duration_sec: None,
    });

    Ok(CompressVideosBatchResponse {
        task_id: req.task_id.clone(),
        output_dir: out_dir.to_string_lossy().to_string(),
        cancelled,
        compressed_count,
        kept_original_count,
        skipped_count,
        failed_count,
        total_original_bytes,
        total_output_bytes,
        total_saved_bytes,
        total_saved_percent,
        elapsed_ms: t0.elapsed().as_millis() as u64,
        items: results,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn resolution_cap_preserves_aspect_never_upscales_and_keeps_even_dims() {
        assert_eq!(
            compute_capped_dimensions(1920, 1080, CompressResolutionCap::P720),
            (1280, 720, true)
        );
        assert_eq!(
            compute_capped_dimensions(640, 360, CompressResolutionCap::P720),
            (640, 360, false)
        );
        assert_eq!(
            compute_capped_dimensions(1080, 1920, CompressResolutionCap::P720),
            (720, 1280, true)
        );
        assert_eq!(
            compute_capped_dimensions(360, 640, CompressResolutionCap::P1080),
            (360, 640, false)
        );
    }

    #[test]
    fn compresses_high_bitrate_clip_and_keeps_original_for_already_tiny_clip() {
        let dir = tempdir().unwrap();
        let Ok(tools) = require_media_tools(dir.path()) else {
            return;
        };
        let cancel = AtomicBool::new(false);

        let caps = probe_video_encoders_impl(dir.path()).unwrap();
        assert!(caps.h264_encoders.iter().any(|e| e.id == "libx264"));
        assert!(caps.hevc_encoders.iter().any(|e| e.id == "libx265"));

        // 1. High-bitrate noisy clip (easily shrinks substantially with Small preset)
        let big = dir.path().join("big_high_bitrate.mp4");
        run_ffmpeg_cancellable(
            &tools.ffmpeg,
            &[
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "testsrc2=size=960x540:rate=25:duration=2".into(),
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "sine=frequency=440:sample_rate=48000:duration=2".into(),
                "-c:v".into(),
                "libx264".into(),
                "-crf".into(),
                "4".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
                "-c:a".into(),
                "aac".into(),
                "-b:a".into(),
                "256k".into(),
                big.to_string_lossy().to_string(),
            ],
            Some(2.0),
            &cancel,
            |_, _| {},
        )
        .unwrap();

        // 2. Ultra-compact tiny clip (CRF 48 solid color, High preset would enlarge it!)
        let tiny = dir.path().join("already_tiny.mp4");
        run_ffmpeg_cancellable(
            &tools.ffmpeg,
            &[
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "color=c=navy:s=320x180:r=10:d=2".into(),
                "-c:v".into(),
                "libx264".into(),
                "-crf".into(),
                "48".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
                tiny.to_string_lossy().to_string(),
            ],
            Some(2.0),
            &cancel,
            |_, _| {},
        )
        .unwrap();

        let out_dir = dir.path().join("out_compress");
        let resp_big = compress_videos_batch_impl(
            dir.path(),
            &CompressVideosBatchRequest {
                task_id: "v06-big".into(),
                source_paths: vec![big.to_string_lossy().to_string()],
                output_dir: out_dir.to_string_lossy().to_string(),
                preset: CompressQualityPreset::Small,
                codec: CompressVideoCodec::H264,
                resolution_cap: CompressResolutionCap::P480,
                encoder_preference: Some("software".into()),
                keep_audio: Some(true),
                keep_original_if_larger: Some(true),
            },
            &cancel,
            |_| {},
        )
        .unwrap();
        assert_eq!(resp_big.compressed_count, 1);
        let item_big = &resp_big.items[0];
        assert_eq!(item_big.status, CompressItemStatus::Compressed);
        assert!(item_big.saved_bytes > 0 && item_big.saved_percent > 20.0);
        assert_eq!(item_big.actual_encoder_used.as_deref(), Some("libx264"));
        assert!(item_big.output_width.unwrap_or(9999) <= 854);

        let resp_tiny = compress_videos_batch_impl(
            dir.path(),
            &CompressVideosBatchRequest {
                task_id: "v06-tiny".into(),
                source_paths: vec![tiny.to_string_lossy().to_string()],
                output_dir: out_dir.to_string_lossy().to_string(),
                preset: CompressQualityPreset::High,
                codec: CompressVideoCodec::Hevc,
                resolution_cap: CompressResolutionCap::Original,
                encoder_preference: Some("software".into()),
                keep_audio: Some(true),
                keep_original_if_larger: Some(true),
            },
            &cancel,
            |_| {},
        )
        .unwrap();
        assert_eq!(resp_tiny.kept_original_count, 1);
        let item_tiny = &resp_tiny.items[0];
        assert_eq!(item_tiny.status, CompressItemStatus::KeptOriginal);
        assert!(item_tiny.kept_original);
        assert_eq!(item_tiny.output_bytes, Some(item_tiny.original_bytes));
        assert_eq!(item_tiny.actual_encoder_used.as_deref(), Some("libx265"));
    }
}
