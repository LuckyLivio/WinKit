//! V07 Convert Video — single and batch container conversion across MP4, MOV, WebM, M4V, and MKV.
//!
//! Performs explicit per-track compatibility planning before conversion starts so users can inspect
//! exactly which video, audio, subtitle, and ancillary streams can be stream-copied losslessly,
//! which require re-encoding (e.g. VP9/Opus for WebM), and which hit target container limitations
//! (such as bitmap subtitles or MKV attachments in MP4/MOV/M4V/WebM) requiring explicit user consent
//! before dropping. Verifies every exported file via `ffprobe` for actual container, codecs, and streams.

use crate::error::AppError;
use crate::fs_guard::validate_existing_input_file;
use crate::media_core::{
    allocate_non_colliding_output_path, require_media_tools, run_ffmpeg_cancellable,
    AtomicMediaOutput, MediaTaskProgressPayload,
};
use crate::media_info::{probe_media_info_impl, MediaProbeReport};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoConvertFormat {
    Mp4,
    Mov,
    Webm,
    M4v,
    Mkv,
}

impl VideoConvertFormat {
    pub fn extension(self) -> &'static str {
        match self {
            VideoConvertFormat::Mp4 => "mp4",
            VideoConvertFormat::Mov => "mov",
            VideoConvertFormat::Webm => "webm",
            VideoConvertFormat::M4v => "m4v",
            VideoConvertFormat::Mkv => "mkv",
        }
    }

    pub fn display_label(self) -> &'static str {
        match self {
            VideoConvertFormat::Mp4 => "MP4",
            VideoConvertFormat::Mov => "MOV",
            VideoConvertFormat::Webm => "WebM",
            VideoConvertFormat::M4v => "M4V",
            VideoConvertFormat::Mkv => "MKV",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrackConvertAction {
    Copy,
    Transcode,
    Drop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvertOverallMode {
    RemuxOnly,
    Mixed,
    FullTranscode,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackConvertPlan {
    pub stream_index: usize,
    pub stream_type: String,
    pub source_codec: String,
    pub language: Option<String>,
    pub title: Option<String>,
    pub action: TrackConvertAction,
    pub target_codec: Option<String>,
    pub reason_code: String,
    pub reason_text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoConvertPlan {
    pub source_path: String,
    pub file_name: String,
    pub byte_size: u64,
    pub duration_sec: Option<f64>,
    pub source_container: Option<String>,
    pub target_format: VideoConvertFormat,
    pub overall_mode: ConvertOverallMode,
    pub copy_track_count: usize,
    pub transcode_track_count: usize,
    pub drop_track_count: usize,
    pub has_container_limitations: bool,
    pub limitation_messages: Vec<String>,
    pub tracks: Vec<TrackConvertPlan>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectVideoConvertPlanRequest {
    pub source_paths: Vec<String>,
    pub target_format: VideoConvertFormat,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectVideoConvertPlanItem {
    pub source_path: String,
    pub file_name: String,
    pub ok: bool,
    pub plan: Option<VideoConvertPlan>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectVideoConvertPlanResponse {
    pub target_format: VideoConvertFormat,
    pub items: Vec<InspectVideoConvertPlanItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertVideosBatchRequest {
    pub task_id: String,
    pub source_paths: Vec<String>,
    pub output_dir: String,
    pub target_format: VideoConvertFormat,
    pub allow_drop_incompatible: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvertItemStatus {
    Converted,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertVideoItemResult {
    pub source_path: String,
    pub file_name: String,
    pub status: ConvertItemStatus,
    pub output_path: Option<String>,
    pub output_bytes: Option<u64>,
    pub overall_mode: Option<ConvertOverallMode>,
    pub verified_container: Option<String>,
    pub verified_video_codecs: Vec<String>,
    pub verified_audio_codecs: Vec<String>,
    pub verified_subtitle_codecs: Vec<String>,
    pub verified_stream_count: Option<usize>,
    pub dropped_track_count: usize,
    pub elapsed_ms: u64,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertVideosBatchResponse {
    pub task_id: String,
    pub output_dir: String,
    pub target_format: VideoConvertFormat,
    pub cancelled: bool,
    pub converted_count: usize,
    pub skipped_count: usize,
    pub failed_count: usize,
    pub elapsed_ms: u64,
    pub items: Vec<ConvertVideoItemResult>,
}

fn is_video_copy_compatible(codec: &str, target: VideoConvertFormat) -> bool {
    match target {
        VideoConvertFormat::Mp4 => {
            matches!(codec, "h264" | "hevc" | "av1" | "mpeg4" | "vp9")
        }
        VideoConvertFormat::Mov => {
            matches!(
                codec,
                "h264" | "hevc" | "prores" | "mpeg4" | "mjpeg" | "dnxhd"
            )
        }
        VideoConvertFormat::M4v => matches!(codec, "h264" | "hevc" | "mpeg4"),
        VideoConvertFormat::Webm => matches!(codec, "vp9" | "vp8" | "av1"),
        VideoConvertFormat::Mkv => matches!(
            codec,
            "h264"
                | "hevc"
                | "vp9"
                | "vp8"
                | "av1"
                | "mpeg4"
                | "prores"
                | "ffv1"
                | "mjpeg"
                | "mpeg2video"
                | "theora"
                | "h263"
        ),
    }
}

fn is_audio_copy_compatible(codec: &str, target: VideoConvertFormat) -> bool {
    match target {
        VideoConvertFormat::Mp4 => {
            matches!(
                codec,
                "aac" | "mp3" | "ac3" | "eac3" | "alac" | "opus" | "flac"
            )
        }
        VideoConvertFormat::Mov => {
            matches!(
                codec,
                "aac"
                    | "alac"
                    | "mp3"
                    | "ac3"
                    | "eac3"
                    | "pcm_s16le"
                    | "pcm_s24le"
                    | "pcm_s16be"
                    | "pcm_s24be"
                    | "pcm_f32le"
            )
        }
        VideoConvertFormat::M4v => matches!(codec, "aac" | "ac3" | "alac"),
        VideoConvertFormat::Webm => matches!(codec, "opus" | "vorbis"),
        VideoConvertFormat::Mkv => {
            codec.starts_with("pcm_")
                || matches!(
                    codec,
                    "aac"
                        | "mp3"
                        | "opus"
                        | "vorbis"
                        | "flac"
                        | "ac3"
                        | "eac3"
                        | "dts"
                        | "alac"
                        | "truehd"
                )
        }
    }
}

fn is_text_subtitle_codec(codec: &str) -> bool {
    matches!(
        codec,
        "subrip" | "srt" | "ass" | "ssa" | "mov_text" | "webvtt" | "text" | "utf8"
    )
}

fn is_bitmap_subtitle_codec(codec: &str) -> bool {
    matches!(
        codec,
        "hdmv_pgs_subtitle" | "dvd_subtitle" | "dvb_subtitle" | "xsub" | "pgssub" | "vobsub"
    )
}

fn is_attached_pic_video(raw_json: &str, stream_index: usize) -> bool {
    let Ok(val) = serde_json::from_str::<serde_json::Value>(raw_json) else {
        return false;
    };
    let Some(streams) = val.get("streams").and_then(|s| s.as_array()) else {
        return false;
    };
    for s in streams {
        if s.get("index").and_then(|i| i.as_u64()) == Some(stream_index as u64)
            && s.get("disposition")
                .and_then(|d| d.get("attached_pic"))
                .and_then(|v| v.as_i64())
                == Some(1)
        {
            return true;
        }
    }
    false
}

/// Extracts non-AV/non-subtitle streams (data, attachment, unknown) directly from `ffprobe` raw JSON
/// so container limitations on attachments/timecodes are reported honestly instead of silently dropped.
fn extract_other_streams(raw_json: &str) -> Vec<(usize, String, String)> {
    let Ok(val) = serde_json::from_str::<serde_json::Value>(raw_json) else {
        return Vec::new();
    };
    let Some(streams) = val.get("streams").and_then(|s| s.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (fallback_idx, s) in streams.iter().enumerate() {
        let ctype = s
            .get("codec_type")
            .and_then(|v| v.as_str())
            .unwrap_or("other")
            .to_ascii_lowercase();
        if matches!(ctype.as_str(), "video" | "audio" | "subtitle") {
            continue;
        }
        let idx = s
            .get("index")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(fallback_idx);
        let cname = s
            .get("codec_name")
            .and_then(|v| v.as_str())
            .filter(|t| !t.trim().is_empty())
            .unwrap_or(&ctype)
            .to_ascii_lowercase();
        out.push((idx, ctype, cname));
    }
    out
}

/// Pure, deterministic per-track conversion planner for `V07`.
pub fn plan_video_conversion(
    probe: &MediaProbeReport,
    target_format: VideoConvertFormat,
) -> VideoConvertPlan {
    let mut tracks: Vec<TrackConvertPlan> = Vec::new();
    let mut limitation_messages: Vec<String> = Vec::new();
    let target_label = target_format.display_label();

    for v in &probe.video_streams {
        let codec = v
            .codec_name
            .as_deref()
            .unwrap_or("unknown")
            .to_ascii_lowercase();

        if is_attached_pic_video(&probe.raw_json, v.index)
            && matches!(target_format, VideoConvertFormat::Webm)
        {
            tracks.push(TrackConvertPlan {
                stream_index: v.index,
                stream_type: "other".into(),
                source_codec: codec.clone(),
                language: None,
                title: Some("Cover Art".into()),
                action: TrackConvertAction::Drop,
                target_codec: None,
                reason_code: "attached_pic_unsupported".into(),
                reason_text: format!(
                    "{target_label} container does not support embedded cover-art streams; this track will be omitted."
                ),
            });
            limitation_messages.push(format!(
                "Stream #{} embedded cover image ({}) is unsupported in {target_label} and will be omitted.",
                v.index, codec
            ));
            continue;
        }

        if is_video_copy_compatible(&codec, target_format) {
            tracks.push(TrackConvertPlan {
                stream_index: v.index,
                stream_type: "video".into(),
                source_codec: codec.clone(),
                language: None,
                title: None,
                action: TrackConvertAction::Copy,
                target_codec: Some("copy".into()),
                reason_code: "compatible_copy".into(),
                reason_text: format!(
                    "Video codec `{codec}` is compatible with {target_label} and will be stream-copied without re-encoding."
                ),
            });
        } else {
            let enc = match target_format {
                VideoConvertFormat::Webm => "libvpx-vp9",
                VideoConvertFormat::Mp4
                | VideoConvertFormat::Mov
                | VideoConvertFormat::M4v
                | VideoConvertFormat::Mkv => "libx264",
            };
            let enc_label = if enc == "libvpx-vp9" { "VP9" } else { "H.264" };
            tracks.push(TrackConvertPlan {
                stream_index: v.index,
                stream_type: "video".into(),
                source_codec: codec.clone(),
                language: None,
                title: None,
                action: TrackConvertAction::Transcode,
                target_codec: Some(enc.into()),
                reason_code: "container_requires_transcode".into(),
                reason_text: format!(
                    "Video codec `{codec}` is not directly compatible with {target_label}; will re-encode to {enc_label} ({enc})."
                ),
            });
        }
    }

    for a in &probe.audio_streams {
        let codec = a
            .codec_name
            .as_deref()
            .unwrap_or("unknown")
            .to_ascii_lowercase();
        if is_audio_copy_compatible(&codec, target_format) {
            tracks.push(TrackConvertPlan {
                stream_index: a.index,
                stream_type: "audio".into(),
                source_codec: codec.clone(),
                language: a.language.clone(),
                title: a.title.clone(),
                action: TrackConvertAction::Copy,
                target_codec: Some("copy".into()),
                reason_code: "compatible_copy".into(),
                reason_text: format!(
                    "Audio codec `{codec}` is compatible with {target_label} and will be stream-copied."
                ),
            });
        } else {
            let enc = match target_format {
                VideoConvertFormat::Webm => "libopus",
                VideoConvertFormat::Mp4
                | VideoConvertFormat::Mov
                | VideoConvertFormat::M4v
                | VideoConvertFormat::Mkv => "aac",
            };
            let enc_label = if enc == "libopus" { "Opus" } else { "AAC" };
            tracks.push(TrackConvertPlan {
                stream_index: a.index,
                stream_type: "audio".into(),
                source_codec: codec.clone(),
                language: a.language.clone(),
                title: a.title.clone(),
                action: TrackConvertAction::Transcode,
                target_codec: Some(enc.into()),
                reason_code: "container_requires_transcode".into(),
                reason_text: format!(
                    "Audio codec `{codec}` requires re-encoding to {enc_label} ({enc}) for {target_label}."
                ),
            });
        }
    }

    for s in &probe.subtitle_streams {
        let codec = s
            .codec_name
            .as_deref()
            .unwrap_or("unknown")
            .to_ascii_lowercase();

        match target_format {
            VideoConvertFormat::Mkv => {
                if codec == "mov_text" {
                    tracks.push(TrackConvertPlan {
                        stream_index: s.index,
                        stream_type: "subtitle".into(),
                        source_codec: codec.clone(),
                        language: s.language.clone(),
                        title: s.title.clone(),
                        action: TrackConvertAction::Transcode,
                        target_codec: Some("subrip".into()),
                        reason_code: "subtitle_converted".into(),
                        reason_text: "Text subtitle `mov_text` will be converted to SubRip (SRT) for MKV compatibility.".into(),
                    });
                } else {
                    tracks.push(TrackConvertPlan {
                        stream_index: s.index,
                        stream_type: "subtitle".into(),
                        source_codec: codec.clone(),
                        language: s.language.clone(),
                        title: s.title.clone(),
                        action: TrackConvertAction::Copy,
                        target_codec: Some("copy".into()),
                        reason_code: "compatible_copy".into(),
                        reason_text: format!("Subtitle `{codec}` will be stream-copied into MKV."),
                    });
                }
            }
            VideoConvertFormat::Mp4 | VideoConvertFormat::Mov | VideoConvertFormat::M4v => {
                if codec == "mov_text" {
                    tracks.push(TrackConvertPlan {
                        stream_index: s.index,
                        stream_type: "subtitle".into(),
                        source_codec: codec.clone(),
                        language: s.language.clone(),
                        title: s.title.clone(),
                        action: TrackConvertAction::Copy,
                        target_codec: Some("copy".into()),
                        reason_code: "compatible_copy".into(),
                        reason_text: format!(
                            "Subtitle `mov_text` is native to {target_label} and will be stream-copied."
                        ),
                    });
                } else if is_text_subtitle_codec(&codec) {
                    tracks.push(TrackConvertPlan {
                        stream_index: s.index,
                        stream_type: "subtitle".into(),
                        source_codec: codec.clone(),
                        language: s.language.clone(),
                        title: s.title.clone(),
                        action: TrackConvertAction::Transcode,
                        target_codec: Some("mov_text".into()),
                        reason_code: "subtitle_converted".into(),
                        reason_text: format!(
                            "Text subtitle `{codec}` will be converted to `mov_text` for {target_label} (rich ASS/SSA styling may simplify)."
                        ),
                    });
                } else {
                    let kind = if is_bitmap_subtitle_codec(&codec) {
                        "Bitmap subtitle"
                    } else {
                        "Subtitle"
                    };
                    tracks.push(TrackConvertPlan {
                        stream_index: s.index,
                        stream_type: "subtitle".into(),
                        source_codec: codec.clone(),
                        language: s.language.clone(),
                        title: s.title.clone(),
                        action: TrackConvertAction::Drop,
                        target_codec: None,
                        reason_code: "bitmap_subtitle_unsupported".into(),
                        reason_text: format!(
                            "{kind} `{codec}` cannot be stored in {target_label}; this subtitle track will be omitted (switch to MKV to keep it)."
                        ),
                    });
                    limitation_messages.push(format!(
                        "Stream #{} {kind} ({codec}) is unsupported in {target_label} and will be omitted.",
                        s.index
                    ));
                }
            }
            VideoConvertFormat::Webm => {
                if codec == "webvtt" {
                    tracks.push(TrackConvertPlan {
                        stream_index: s.index,
                        stream_type: "subtitle".into(),
                        source_codec: codec.clone(),
                        language: s.language.clone(),
                        title: s.title.clone(),
                        action: TrackConvertAction::Copy,
                        target_codec: Some("copy".into()),
                        reason_code: "compatible_copy".into(),
                        reason_text:
                            "Subtitle `webvtt` is native to WebM and will be stream-copied.".into(),
                    });
                } else if is_text_subtitle_codec(&codec) {
                    tracks.push(TrackConvertPlan {
                        stream_index: s.index,
                        stream_type: "subtitle".into(),
                        source_codec: codec.clone(),
                        language: s.language.clone(),
                        title: s.title.clone(),
                        action: TrackConvertAction::Transcode,
                        target_codec: Some("webvtt".into()),
                        reason_code: "subtitle_converted".into(),
                        reason_text: format!(
                            "Text subtitle `{codec}` will be converted to WebVTT for WebM."
                        ),
                    });
                } else {
                    tracks.push(TrackConvertPlan {
                        stream_index: s.index,
                        stream_type: "subtitle".into(),
                        source_codec: codec.clone(),
                        language: s.language.clone(),
                        title: s.title.clone(),
                        action: TrackConvertAction::Drop,
                        target_codec: None,
                        reason_code: "bitmap_subtitle_unsupported".into(),
                        reason_text: format!(
                            "Subtitle `{codec}` cannot be stored in WebM and will be omitted (switch to MKV to keep it)."
                        ),
                    });
                    limitation_messages.push(format!(
                        "Stream #{} subtitle ({codec}) is unsupported in WebM and will be omitted.",
                        s.index
                    ));
                }
            }
        }
    }

    for (idx, ctype, cname) in extract_other_streams(&probe.raw_json) {
        if target_format == VideoConvertFormat::Mkv && ctype == "attachment" {
            tracks.push(TrackConvertPlan {
                stream_index: idx,
                stream_type: ctype,
                source_codec: cname,
                language: None,
                title: None,
                action: TrackConvertAction::Copy,
                target_codec: Some("copy".into()),
                reason_code: "compatible_copy".into(),
                reason_text: "Attachment stream will be copied into MKV.".into(),
            });
        } else {
            tracks.push(TrackConvertPlan {
                stream_index: idx,
                stream_type: ctype.clone(),
                source_codec: cname.clone(),
                language: None,
                title: None,
                action: TrackConvertAction::Drop,
                target_codec: None,
                reason_code: "other_stream_unsupported".into(),
                reason_text: format!(
                    "Ancillary `{ctype}` stream (`{cname}`) is not supported in {target_label} and will be omitted."
                ),
            });
            limitation_messages.push(format!(
                "Stream #{idx} ({ctype}/{cname}) cannot be preserved in {target_label} and will be omitted."
            ));
        }
    }

    if probe.audio_streams.len() > 1 && target_format == VideoConvertFormat::M4v {
        limitation_messages.push(format!(
            "Contains {} audio tracks: all will be preserved as AAC/AC3/ALAC in M4V, though some Apple players default to Track #1.",
            probe.audio_streams.len()
        ));
    }

    let copy_track_count = tracks
        .iter()
        .filter(|t| t.action == TrackConvertAction::Copy)
        .count();
    let transcode_track_count = tracks
        .iter()
        .filter(|t| t.action == TrackConvertAction::Transcode)
        .count();
    let drop_track_count = tracks
        .iter()
        .filter(|t| t.action == TrackConvertAction::Drop)
        .count();

    let overall_mode = if transcode_track_count == 0 {
        ConvertOverallMode::RemuxOnly
    } else if copy_track_count > 0 {
        ConvertOverallMode::Mixed
    } else {
        ConvertOverallMode::FullTranscode
    };

    VideoConvertPlan {
        source_path: probe.path.clone(),
        file_name: probe.file_name.clone(),
        byte_size: probe.byte_size,
        duration_sec: probe.duration_sec,
        source_container: probe.container_format.clone(),
        target_format,
        overall_mode,
        copy_track_count,
        transcode_track_count,
        drop_track_count,
        has_container_limitations: drop_track_count > 0 || !limitation_messages.is_empty(),
        limitation_messages,
        tracks,
    }
}

pub fn inspect_video_convert_plan_impl(
    media_root: &Path,
    req: &InspectVideoConvertPlanRequest,
) -> Result<InspectVideoConvertPlanResponse, AppError> {
    let _tools = require_media_tools(media_root)?;
    let mut items = Vec::with_capacity(req.source_paths.len());
    for raw_src in &req.source_paths {
        let fallback_name = Path::new(raw_src)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(raw_src)
            .to_string();
        match probe_media_info_impl(media_root, raw_src) {
            Ok(probe) => {
                if !probe.has_video {
                    items.push(InspectVideoConvertPlanItem {
                        source_path: raw_src.clone(),
                        file_name: probe.file_name,
                        ok: false,
                        plan: None,
                        error: Some("File does not contain a video stream.".into()),
                    });
                } else {
                    let plan = plan_video_conversion(&probe, req.target_format);
                    items.push(InspectVideoConvertPlanItem {
                        source_path: raw_src.clone(),
                        file_name: plan.file_name.clone(),
                        ok: true,
                        plan: Some(plan),
                        error: None,
                    });
                }
            }
            Err(err) => {
                items.push(InspectVideoConvertPlanItem {
                    source_path: raw_src.clone(),
                    file_name: fallback_name,
                    ok: false,
                    plan: None,
                    error: Some(err.message),
                });
            }
        }
    }
    Ok(InspectVideoConvertPlanResponse {
        target_format: req.target_format,
        items,
    })
}

fn build_convert_ffmpeg_args(
    source_path: &Path,
    plan: &VideoConvertPlan,
    temp_out_path: &Path,
) -> Vec<String> {
    let mut args: Vec<String> = vec!["-i".into(), source_path.to_string_lossy().to_string()];

    // Track per-type output index counters so `-c:v:0`, `-c:a:1`, `-c:s:0` map precisely
    let mut out_v = 0usize;
    let mut out_a = 0usize;
    let mut out_s = 0usize;
    let mut out_t = 0usize;

    for track in &plan.tracks {
        if track.action == TrackConvertAction::Drop {
            continue;
        }
        args.push("-map".into());
        args.push(format!("0:{}", track.stream_index));

        match track.stream_type.as_str() {
            "video" => {
                if track.action == TrackConvertAction::Copy {
                    args.push(format!("-c:v:{out_v}"));
                    args.push("copy".into());
                    if track.source_codec == "hevc"
                        && matches!(
                            plan.target_format,
                            VideoConvertFormat::Mp4
                                | VideoConvertFormat::Mov
                                | VideoConvertFormat::M4v
                        )
                    {
                        args.push(format!("-tag:v:{out_v}"));
                        args.push("hvc1".into());
                    }
                } else {
                    let enc = track.target_codec.as_deref().unwrap_or("libx264");
                    args.push(format!("-c:v:{out_v}"));
                    args.push(enc.into());
                    if enc == "libvpx-vp9" {
                        args.extend([
                            format!("-crf:v:{out_v}"),
                            "31".into(),
                            format!("-b:v:{out_v}"),
                            "0".into(),
                            "-row-mt".into(),
                            "1".into(),
                            "-deadline".into(),
                            "good".into(),
                            "-cpu-used".into(),
                            "4".into(),
                            "-pix_fmt".into(),
                            "yuv420p".into(),
                        ]);
                    } else {
                        args.extend([
                            format!("-crf:v:{out_v}"),
                            "20".into(),
                            "-preset".into(),
                            "medium".into(),
                            "-pix_fmt".into(),
                            "yuv420p".into(),
                        ]);
                    }
                }
                out_v += 1;
            }
            "audio" => {
                if track.action == TrackConvertAction::Copy {
                    args.push(format!("-c:a:{out_a}"));
                    args.push("copy".into());
                } else {
                    let enc = track.target_codec.as_deref().unwrap_or("aac");
                    args.push(format!("-c:a:{out_a}"));
                    args.push(enc.into());
                    args.push(format!("-b:a:{out_a}"));
                    args.push(if enc == "libopus" {
                        "128k".into()
                    } else {
                        "192k".into()
                    });
                }
                out_a += 1;
            }
            "subtitle" => {
                let enc = if track.action == TrackConvertAction::Copy {
                    "copy"
                } else {
                    track.target_codec.as_deref().unwrap_or("mov_text")
                };
                args.push(format!("-c:s:{out_s}"));
                args.push(enc.into());
                out_s += 1;
            }
            "attachment" => {
                args.push(format!("-c:t:{out_t}"));
                args.push("copy".into());
                out_t += 1;
            }
            _ => {}
        }
    }

    match plan.target_format {
        VideoConvertFormat::Mp4 => {
            args.extend([
                "-f".into(),
                "mp4".into(),
                "-movflags".into(),
                "+faststart".into(),
            ]);
        }
        VideoConvertFormat::M4v => {
            args.extend([
                "-f".into(),
                "mp4".into(),
                "-movflags".into(),
                "+faststart".into(),
            ]);
        }
        VideoConvertFormat::Mov => {
            args.extend([
                "-f".into(),
                "mov".into(),
                "-movflags".into(),
                "+faststart".into(),
            ]);
        }
        VideoConvertFormat::Webm => {
            args.extend(["-f".into(), "webm".into()]);
        }
        VideoConvertFormat::Mkv => {
            args.extend(["-f".into(), "matroska".into()]);
        }
    }

    args.push(temp_out_path.to_string_lossy().to_string());
    args
}

pub fn convert_videos_batch_impl(
    media_root: &Path,
    req: &ConvertVideosBatchRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(MediaTaskProgressPayload),
) -> Result<ConvertVideosBatchResponse, AppError> {
    let t0 = Instant::now();
    if req.source_paths.is_empty() {
        return Err(AppError::invalid_param(
            "Select at least one video file to convert.",
        ));
    }
    let out_dir = PathBuf::from(req.output_dir.trim());
    if !out_dir.is_absolute() {
        return Err(AppError::invalid_param(
            "Output directory must be an absolute path.",
        ));
    }
    let tools = require_media_tools(media_root)?;
    let total = req.source_paths.len();
    let mut results: Vec<ConvertVideoItemResult> = Vec::with_capacity(total);
    let mut converted_count = 0usize;
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
            results.push(ConvertVideoItemResult {
                source_path: raw_src.clone(),
                file_name: fallback_name,
                status: ConvertItemStatus::Skipped,
                output_path: None,
                output_bytes: None,
                overall_mode: None,
                verified_container: None,
                verified_video_codecs: Vec::new(),
                verified_audio_codecs: Vec::new(),
                verified_subtitle_codecs: Vec::new(),
                verified_stream_count: None,
                dropped_track_count: 0,
                elapsed_ms: 0,
                message: Some("Cancelled before processing.".into()),
            });
            continue;
        }

        let (source_path, _) = match validate_existing_input_file(raw_src) {
            Ok(v) => v,
            Err(err) => {
                failed_count += 1;
                results.push(ConvertVideoItemResult {
                    source_path: raw_src.clone(),
                    file_name: fallback_name,
                    status: ConvertItemStatus::Failed,
                    output_path: None,
                    output_bytes: None,
                    overall_mode: None,
                    verified_container: None,
                    verified_video_codecs: Vec::new(),
                    verified_audio_codecs: Vec::new(),
                    verified_subtitle_codecs: Vec::new(),
                    verified_stream_count: None,
                    dropped_track_count: 0,
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
                results.push(ConvertVideoItemResult {
                    source_path: raw_src.clone(),
                    file_name: fallback_name,
                    status: ConvertItemStatus::Failed,
                    output_path: None,
                    output_bytes: None,
                    overall_mode: None,
                    verified_container: None,
                    verified_video_codecs: Vec::new(),
                    verified_audio_codecs: Vec::new(),
                    verified_subtitle_codecs: Vec::new(),
                    verified_stream_count: None,
                    dropped_track_count: 0,
                    elapsed_ms: item_t0.elapsed().as_millis() as u64,
                    message: Some(err.message),
                });
                continue;
            }
        };

        if !probe.has_video {
            failed_count += 1;
            results.push(ConvertVideoItemResult {
                source_path: raw_src.clone(),
                file_name: probe.file_name,
                status: ConvertItemStatus::Failed,
                output_path: None,
                output_bytes: None,
                overall_mode: None,
                verified_container: None,
                verified_video_codecs: Vec::new(),
                verified_audio_codecs: Vec::new(),
                verified_subtitle_codecs: Vec::new(),
                verified_stream_count: None,
                dropped_track_count: 0,
                elapsed_ms: item_t0.elapsed().as_millis() as u64,
                message: Some("File contains no video stream.".into()),
            });
            continue;
        }

        let plan = plan_video_conversion(&probe, req.target_format);
        if plan.drop_track_count > 0 && !req.allow_drop_incompatible {
            skipped_count += 1;
            results.push(ConvertVideoItemResult {
                source_path: raw_src.clone(),
                file_name: plan.file_name,
                status: ConvertItemStatus::Skipped,
                output_path: None,
                output_bytes: None,
                overall_mode: Some(plan.overall_mode),
                verified_container: None,
                verified_video_codecs: Vec::new(),
                verified_audio_codecs: Vec::new(),
                verified_subtitle_codecs: Vec::new(),
                verified_stream_count: None,
                dropped_track_count: plan.drop_track_count,
                elapsed_ms: item_t0.elapsed().as_millis() as u64,
                message: Some(
                    "Skipped because target container cannot hold all tracks and dropping incompatible streams was not confirmed.".into(),
                ),
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
            "",
            req.target_format.extension(),
            &source_path,
        ) {
            Ok(p) => p,
            Err(err) => {
                failed_count += 1;
                results.push(ConvertVideoItemResult {
                    source_path: raw_src.clone(),
                    file_name: plan.file_name,
                    status: ConvertItemStatus::Failed,
                    output_path: None,
                    output_bytes: None,
                    overall_mode: Some(plan.overall_mode),
                    verified_container: None,
                    verified_video_codecs: Vec::new(),
                    verified_audio_codecs: Vec::new(),
                    verified_subtitle_codecs: Vec::new(),
                    verified_stream_count: None,
                    dropped_track_count: plan.drop_track_count,
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
                results.push(ConvertVideoItemResult {
                    source_path: raw_src.clone(),
                    file_name: plan.file_name,
                    status: ConvertItemStatus::Failed,
                    output_path: None,
                    output_bytes: None,
                    overall_mode: Some(plan.overall_mode),
                    verified_container: None,
                    verified_video_codecs: Vec::new(),
                    verified_audio_codecs: Vec::new(),
                    verified_subtitle_codecs: Vec::new(),
                    verified_stream_count: None,
                    dropped_track_count: plan.drop_track_count,
                    elapsed_ms: item_t0.elapsed().as_millis() as u64,
                    message: Some(err.message),
                });
                continue;
            }
        };

        let args = build_convert_ffmpeg_args(&source_path, &plan, atomic.temp_path());
        let duration = probe.duration_sec;
        let item_name = plan.file_name.clone();

        on_progress(MediaTaskProgressPayload {
            task_id: req.task_id.clone(),
            tool_id: "V07".into(),
            phase: "running".into(),
            current_item: idx + 1,
            total_items: total,
            item_name: Some(item_name.clone()),
            percent: Some(((idx as f64) / (total as f64) * 100.0).clamp(0.0, 99.0)),
            out_time_sec: Some(0.0),
            total_duration_sec: duration,
        });

        let exec_res = run_ffmpeg_cancellable(
            &tools.ffmpeg,
            &args,
            duration,
            cancel_flag,
            |out_t, item_p| {
                let overall = item_p.map(|ip| {
                    (((idx as f64) + (ip / 100.0)) / (total as f64) * 100.0).clamp(0.0, 99.0)
                });
                on_progress(MediaTaskProgressPayload {
                    task_id: req.task_id.clone(),
                    tool_id: "V07".into(),
                    phase: "running".into(),
                    current_item: idx + 1,
                    total_items: total,
                    item_name: Some(item_name.clone()),
                    percent: overall,
                    out_time_sec: out_t,
                    total_duration_sec: duration,
                });
            },
        );

        match exec_res {
            Ok(()) => match atomic.commit(false) {
                Ok((final_path, byte_size)) => {
                    let final_str = final_path.to_string_lossy().to_string();
                    let verified = probe_media_info_impl(media_root, &final_str).ok();
                    let verified_container =
                        verified.as_ref().and_then(|v| v.container_format.clone());
                    let verified_video_codecs = verified
                        .as_ref()
                        .map(|v| {
                            v.video_streams
                                .iter()
                                .filter_map(|s| s.codec_name.clone())
                                .collect()
                        })
                        .unwrap_or_default();
                    let verified_audio_codecs = verified
                        .as_ref()
                        .map(|v| {
                            v.audio_streams
                                .iter()
                                .filter_map(|s| s.codec_name.clone())
                                .collect()
                        })
                        .unwrap_or_default();
                    let verified_subtitle_codecs = verified
                        .as_ref()
                        .map(|v| {
                            v.subtitle_streams
                                .iter()
                                .filter_map(|s| s.codec_name.clone())
                                .collect()
                        })
                        .unwrap_or_default();
                    let verified_stream_count = verified.as_ref().map(|v| v.stream_count);

                    converted_count += 1;
                    results.push(ConvertVideoItemResult {
                        source_path: raw_src.clone(),
                        file_name: plan.file_name,
                        status: ConvertItemStatus::Converted,
                        output_path: Some(final_str),
                        output_bytes: Some(byte_size),
                        overall_mode: Some(plan.overall_mode),
                        verified_container,
                        verified_video_codecs,
                        verified_audio_codecs,
                        verified_subtitle_codecs,
                        verified_stream_count,
                        dropped_track_count: plan.drop_track_count,
                        elapsed_ms: item_t0.elapsed().as_millis() as u64,
                        message: None,
                    });
                }
                Err(err) => {
                    failed_count += 1;
                    results.push(ConvertVideoItemResult {
                        source_path: raw_src.clone(),
                        file_name: plan.file_name,
                        status: ConvertItemStatus::Failed,
                        output_path: None,
                        output_bytes: None,
                        overall_mode: Some(plan.overall_mode),
                        verified_container: None,
                        verified_video_codecs: Vec::new(),
                        verified_audio_codecs: Vec::new(),
                        verified_subtitle_codecs: Vec::new(),
                        verified_stream_count: None,
                        dropped_track_count: plan.drop_track_count,
                        elapsed_ms: item_t0.elapsed().as_millis() as u64,
                        message: Some(err.message),
                    });
                }
            },
            Err(err) if err.code == "TASK_CANCELLED" => {
                drop(atomic);
                cancelled = true;
                skipped_count += 1;
                results.push(ConvertVideoItemResult {
                    source_path: raw_src.clone(),
                    file_name: plan.file_name,
                    status: ConvertItemStatus::Skipped,
                    output_path: None,
                    output_bytes: None,
                    overall_mode: Some(plan.overall_mode),
                    verified_container: None,
                    verified_video_codecs: Vec::new(),
                    verified_audio_codecs: Vec::new(),
                    verified_subtitle_codecs: Vec::new(),
                    verified_stream_count: None,
                    dropped_track_count: plan.drop_track_count,
                    elapsed_ms: item_t0.elapsed().as_millis() as u64,
                    message: Some("Cancelled during conversion.".into()),
                });
            }
            Err(err) => {
                drop(atomic);
                failed_count += 1;
                results.push(ConvertVideoItemResult {
                    source_path: raw_src.clone(),
                    file_name: plan.file_name,
                    status: ConvertItemStatus::Failed,
                    output_path: None,
                    output_bytes: None,
                    overall_mode: Some(plan.overall_mode),
                    verified_container: None,
                    verified_video_codecs: Vec::new(),
                    verified_audio_codecs: Vec::new(),
                    verified_subtitle_codecs: Vec::new(),
                    verified_stream_count: None,
                    dropped_track_count: plan.drop_track_count,
                    elapsed_ms: item_t0.elapsed().as_millis() as u64,
                    message: Some(err.message),
                });
            }
        }
    }

    on_progress(MediaTaskProgressPayload {
        task_id: req.task_id.clone(),
        tool_id: "V07".into(),
        phase: if cancelled { "cancelled" } else { "completed" }.into(),
        current_item: total,
        total_items: total,
        item_name: None,
        percent: Some(100.0),
        out_time_sec: None,
        total_duration_sec: None,
    });

    Ok(ConvertVideosBatchResponse {
        task_id: req.task_id.clone(),
        output_dir: out_dir.to_string_lossy().to_string(),
        target_format: req.target_format,
        cancelled,
        converted_count,
        skipped_count,
        failed_count,
        elapsed_ms: t0.elapsed().as_millis() as u64,
        items: results,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media_info::{AudioStreamInfo, SubtitleStreamInfo, VideoStreamInfo};
    use std::collections::BTreeMap;
    use tempfile::tempdir;

    fn sample_probe(
        video_codec: &str,
        audio_codecs: &[&str],
        subtitle_codecs: &[&str],
    ) -> MediaProbeReport {
        MediaProbeReport {
            path: "C:\\demo\\clip.mkv".into(),
            file_name: "clip.mkv".into(),
            byte_size: 1024 * 1024,
            container_format: Some("matroska,webm".into()),
            container_long_name: Some("Matroska / WebM".into()),
            duration_sec: Some(5.0),
            overall_bitrate_bps: Some(1_000_000),
            stream_count: 1 + audio_codecs.len() + subtitle_codecs.len(),
            has_video: true,
            has_audio: !audio_codecs.is_empty(),
            video_streams: vec![VideoStreamInfo {
                index: 0,
                codec_name: Some(video_codec.into()),
                codec_long_name: None,
                profile: None,
                pixel_format: Some("yuv420p".into()),
                coded_width: Some(1280),
                coded_height: Some(720),
                display_width: Some(1280),
                display_height: Some(720),
                sample_aspect_ratio: Some("1:1".into()),
                rotation_degrees: None,
                orientation: Some("landscape".into()),
                avg_frame_rate: Some(30.0),
                r_frame_rate: Some(30.0),
                avg_frame_rate_raw: Some("30/1".into()),
                r_frame_rate_raw: Some("30/1".into()),
                is_variable_frame_rate: Some(false),
                bitrate_bps: None,
                color_space: None,
                color_transfer: None,
                color_primaries: None,
                duration_sec: Some(5.0),
            }],
            audio_streams: audio_codecs
                .iter()
                .enumerate()
                .map(|(i, c)| AudioStreamInfo {
                    index: 1 + i,
                    audio_track_index: i,
                    codec_name: Some((*c).into()),
                    codec_long_name: None,
                    profile: None,
                    language: Some(if i == 0 { "eng" } else { "zho" }.into()),
                    title: None,
                    channels: Some(2),
                    channel_layout: Some("stereo".into()),
                    sample_rate_hz: Some(48000),
                    sample_fmt: None,
                    bits_per_sample: None,
                    bitrate_bps: Some(128_000),
                    duration_sec: Some(5.0),
                    is_default: i == 0,
                })
                .collect(),
            subtitle_streams: subtitle_codecs
                .iter()
                .enumerate()
                .map(|(i, c)| SubtitleStreamInfo {
                    index: 1 + audio_codecs.len() + i,
                    codec_name: Some((*c).into()),
                    language: Some("eng".into()),
                    title: None,
                })
                .collect(),
            format_tags: BTreeMap::new(),
            summary_text: String::new(),
            raw_json: "{}".into(),
        }
    }

    #[test]
    fn planner_distinguishes_remux_copy_transcode_and_container_limits() {
        // H.264 + AAC + PGS bitmap subtitle -> MP4 must copy V+A and flag PGS drop
        let p = sample_probe("h264", &["aac"], &["hdmv_pgs_subtitle"]);
        let plan_mp4 = plan_video_conversion(&p, VideoConvertFormat::Mp4);
        assert_eq!(plan_mp4.overall_mode, ConvertOverallMode::RemuxOnly);
        assert_eq!(plan_mp4.copy_track_count, 2);
        assert_eq!(plan_mp4.drop_track_count, 1);
        assert!(plan_mp4.has_container_limitations);

        // Same clip -> MKV copies all 3 tracks with zero drops
        let plan_mkv = plan_video_conversion(&p, VideoConvertFormat::Mkv);
        assert_eq!(plan_mkv.overall_mode, ConvertOverallMode::RemuxOnly);
        assert_eq!(plan_mkv.copy_track_count, 3);
        assert_eq!(plan_mkv.drop_track_count, 0);
        assert!(!plan_mkv.has_container_limitations);

        // H.264 + AAC -> WebM transcodes to libvpx-vp9 + libopus
        let p2 = sample_probe("h264", &["aac", "aac"], &["subrip"]);
        let plan_webm = plan_video_conversion(&p2, VideoConvertFormat::Webm);
        assert_eq!(plan_webm.overall_mode, ConvertOverallMode::FullTranscode);
        assert_eq!(
            plan_webm.tracks[0].target_codec.as_deref(),
            Some("libvpx-vp9")
        );
        assert_eq!(plan_webm.tracks[1].target_codec.as_deref(), Some("libopus"));
        assert_eq!(plan_webm.tracks[2].target_codec.as_deref(), Some("libopus"));
        assert_eq!(plan_webm.tracks[3].target_codec.as_deref(), Some("webvtt"));
        assert_eq!(plan_webm.drop_track_count, 0);

        // H.264 + MP3 -> M4V copies H.264 and transcodes MP3 to AAC
        let p3 = sample_probe("h264", &["mp3"], &[]);
        let plan_m4v = plan_video_conversion(&p3, VideoConvertFormat::M4v);
        assert_eq!(plan_m4v.overall_mode, ConvertOverallMode::Mixed);
        assert_eq!(plan_m4v.tracks[0].action, TrackConvertAction::Copy);
        assert_eq!(plan_m4v.tracks[1].action, TrackConvertAction::Transcode);
        assert_eq!(plan_m4v.tracks[1].target_codec.as_deref(), Some("aac"));
    }

    #[test]
    fn converts_real_clips_to_mkv_mp4_mov_m4v_and_webm_and_verifies_via_ffprobe() {
        let dir = tempdir().unwrap();
        let Ok(tools) = require_media_tools(dir.path()) else {
            return;
        };
        let cancel = AtomicBool::new(false);
        let src = dir.path().join("dual_src.mp4");
        run_ffmpeg_cancellable(
            &tools.ffmpeg,
            &[
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "testsrc2=size=320x180:rate=25:duration=1.5".into(),
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "sine=frequency=440:sample_rate=48000:duration=1.5".into(),
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "sine=frequency=880:sample_rate=48000:duration=1.5".into(),
                "-map".into(),
                "0:v".into(),
                "-map".into(),
                "1:a".into(),
                "-map".into(),
                "2:a".into(),
                "-c:v".into(),
                "libx264".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
                "-c:a".into(),
                "aac".into(),
                src.to_string_lossy().to_string(),
            ],
            Some(1.5),
            &cancel,
            |_, _| {},
        )
        .unwrap();

        let out_dir = dir.path().join("converted");
        for fmt in [
            VideoConvertFormat::Mkv,
            VideoConvertFormat::Mov,
            VideoConvertFormat::M4v,
            VideoConvertFormat::Webm,
        ] {
            let res = convert_videos_batch_impl(
                dir.path(),
                &ConvertVideosBatchRequest {
                    task_id: format!("v07-{fmt:?}"),
                    source_paths: vec![src.to_string_lossy().to_string()],
                    output_dir: out_dir.to_string_lossy().to_string(),
                    target_format: fmt,
                    allow_drop_incompatible: true,
                },
                &cancel,
                |_| {},
            )
            .unwrap();
            assert_eq!(
                res.converted_count, 1,
                "failed converting to {fmt:?}: {res:?}"
            );
            let item = &res.items[0];
            assert_eq!(item.verified_audio_codecs.len(), 2);
            if fmt == VideoConvertFormat::Webm {
                assert_eq!(item.verified_video_codecs, vec!["vp9"]);
                assert_eq!(item.verified_audio_codecs, vec!["opus", "opus"]);
            } else {
                assert_eq!(item.verified_video_codecs, vec!["h264"]);
                assert_eq!(item.verified_audio_codecs, vec!["aac", "aac"]);
            }
        }
    }
}
