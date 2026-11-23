//! V10 Media Info (`ffprobe`-backed container, video, audio, and VFR inspection).
//!
//! Never fabricates `0` for missing or unknown fields — unknown values remain `None` (`null` in JSON)
//! so the UI displays them honestly.

use crate::error::AppError;
use crate::fs_guard::validate_existing_input_file;
use crate::media_core::{require_media_tools, run_ffprobe_args};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoStreamInfo {
    pub index: usize,
    pub codec_name: Option<String>,
    pub codec_long_name: Option<String>,
    pub profile: Option<String>,
    pub pixel_format: Option<String>,
    pub coded_width: Option<u32>,
    pub coded_height: Option<u32>,
    pub display_width: Option<u32>,
    pub display_height: Option<u32>,
    pub sample_aspect_ratio: Option<String>,
    pub rotation_degrees: Option<i32>,
    pub orientation: Option<String>,
    pub avg_frame_rate: Option<f64>,
    pub r_frame_rate: Option<f64>,
    pub avg_frame_rate_raw: Option<String>,
    pub r_frame_rate_raw: Option<String>,
    pub is_variable_frame_rate: Option<bool>,
    pub bitrate_bps: Option<u64>,
    pub color_space: Option<String>,
    pub color_transfer: Option<String>,
    pub color_primaries: Option<String>,
    pub duration_sec: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStreamInfo {
    pub index: usize,
    pub audio_track_index: usize,
    pub codec_name: Option<String>,
    pub codec_long_name: Option<String>,
    pub profile: Option<String>,
    pub language: Option<String>,
    pub title: Option<String>,
    pub channels: Option<u32>,
    pub channel_layout: Option<String>,
    pub sample_rate_hz: Option<u32>,
    pub sample_fmt: Option<String>,
    pub bits_per_sample: Option<u32>,
    pub bitrate_bps: Option<u64>,
    pub duration_sec: Option<f64>,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleStreamInfo {
    pub index: usize,
    pub codec_name: Option<String>,
    pub language: Option<String>,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbeReport {
    pub path: String,
    pub file_name: String,
    pub byte_size: u64,
    pub container_format: Option<String>,
    pub container_long_name: Option<String>,
    pub duration_sec: Option<f64>,
    pub overall_bitrate_bps: Option<u64>,
    pub stream_count: usize,
    pub has_video: bool,
    pub has_audio: bool,
    pub video_streams: Vec<VideoStreamInfo>,
    pub audio_streams: Vec<AudioStreamInfo>,
    pub subtitle_streams: Vec<SubtitleStreamInfo>,
    pub format_tags: BTreeMap<String, String>,
    pub summary_text: String,
    pub raw_json: String,
}

#[derive(Debug, Deserialize)]
struct FfprobeOutput {
    format: Option<FfprobeFormat>,
    #[serde(default)]
    streams: Vec<FfprobeStream>,
}

#[derive(Debug, Deserialize)]
struct FfprobeFormat {
    format_name: Option<String>,
    format_long_name: Option<String>,
    duration: Option<String>,
    bit_rate: Option<String>,
    #[serde(default)]
    tags: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct FfprobeStream {
    index: Option<usize>,
    codec_type: Option<String>,
    codec_name: Option<String>,
    codec_long_name: Option<String>,
    profile: Option<String>,
    pix_fmt: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    sample_aspect_ratio: Option<String>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
    bit_rate: Option<String>,
    duration: Option<String>,
    color_space: Option<String>,
    color_transfer: Option<String>,
    color_primaries: Option<String>,
    channels: Option<u32>,
    channel_layout: Option<String>,
    sample_rate: Option<String>,
    sample_fmt: Option<String>,
    bits_per_sample: Option<u32>,
    bits_per_raw_sample: Option<String>,
    #[serde(default)]
    disposition: BTreeMap<String, i64>,
    #[serde(default)]
    tags: BTreeMap<String, String>,
    #[serde(default)]
    side_data_list: Vec<FfprobeSideData>,
}

#[derive(Debug, Deserialize)]
struct FfprobeSideData {
    side_data_type: Option<String>,
    rotation: Option<serde_json::Value>,
}

pub fn parse_positive_f64(raw: Option<&str>) -> Option<f64> {
    let s = raw?.trim();
    if s.is_empty() || s.eq_ignore_ascii_case("N/A") {
        return None;
    }
    let val: f64 = s.parse().ok()?;
    if val.is_finite() && val > 0.0 {
        Some(val)
    } else {
        None
    }
}

pub fn parse_positive_u64(raw: Option<&str>) -> Option<u64> {
    let s = raw?.trim();
    if s.is_empty() || s.eq_ignore_ascii_case("N/A") {
        return None;
    }
    let val: u64 = s.parse().ok()?;
    if val > 0 {
        Some(val)
    } else {
        None
    }
}

pub fn parse_positive_u32(raw: Option<&str>) -> Option<u32> {
    let s = raw?.trim();
    if s.is_empty() || s.eq_ignore_ascii_case("N/A") {
        return None;
    }
    let val: u32 = s.parse().ok()?;
    if val > 0 {
        Some(val)
    } else {
        None
    }
}

pub fn parse_rational_fps(raw: Option<&str>) -> Option<f64> {
    let s = raw?.trim();
    if s.is_empty() || s.eq_ignore_ascii_case("N/A") {
        return None;
    }
    if let Some((num_s, den_s)) = s.split_once('/') {
        let num: f64 = num_s.trim().parse().ok()?;
        let den: f64 = den_s.trim().parse().ok()?;
        if !num.is_finite() || !den.is_finite() || num <= 0.0 || den <= 0.0 {
            return None;
        }
        let fps = num / den;
        if fps.is_finite() && fps > 0.0 && fps <= 2000.0 {
            Some(fps)
        } else {
            None
        }
    } else {
        parse_positive_f64(Some(s)).filter(|v| *v <= 2000.0)
    }
}

fn infer_pcm_bits(codec: Option<&str>) -> Option<u32> {
    let c = codec?.to_ascii_lowercase();
    if c.contains("64") {
        Some(64)
    } else if c.contains("32") {
        Some(32)
    } else if c.contains("24") {
        Some(24)
    } else if c.contains("16") {
        Some(16)
    } else if c.contains("u8") || c.contains("s8") {
        Some(8)
    } else {
        None
    }
}

fn non_empty_string(raw: Option<&str>) -> Option<String> {
    let s = raw?.trim();
    if s.is_empty() || s.eq_ignore_ascii_case("N/A") || s.eq_ignore_ascii_case("unknown") {
        None
    } else {
        Some(s.to_string())
    }
}

fn find_tag_ci(tags: &BTreeMap<String, String>, key: &str) -> Option<String> {
    for (k, v) in tags {
        if k.eq_ignore_ascii_case(key) {
            return non_empty_string(Some(v.as_str()));
        }
    }
    None
}

fn normalize_rotation_degrees(deg: f64) -> i32 {
    let rounded = deg.round() as i32;
    ((rounded % 360) + 360) % 360
}

fn extract_stream_rotation(stream: &FfprobeStream) -> Option<i32> {
    for sd in &stream.side_data_list {
        if let Some(rot_val) = &sd.rotation {
            if let Some(f) = rot_val.as_f64() {
                return Some(normalize_rotation_degrees(f));
            }
            if let Some(s) = rot_val.as_str() {
                if let Ok(f) = s.trim().parse::<f64>() {
                    return Some(normalize_rotation_degrees(f));
                }
            }
        }
        if sd
            .side_data_type
            .as_deref()
            .is_some_and(|t| t.eq_ignore_ascii_case("Display Matrix"))
        {
            if let Some(rot_val) = &sd.rotation {
                if let Some(f) = rot_val.as_f64() {
                    return Some(normalize_rotation_degrees(f));
                }
            }
        }
    }
    if let Some(rot_tag) = find_tag_ci(&stream.tags, "rotate") {
        if let Ok(f) = rot_tag.parse::<f64>() {
            return Some(normalize_rotation_degrees(f));
        }
    }
    None
}

/// Computes display dimensions accounting for Sample Aspect Ratio (SAR) and rotation.
pub fn compute_display_dimensions(
    coded_w: Option<u32>,
    coded_h: Option<u32>,
    sar: Option<&str>,
    rotation: Option<i32>,
) -> (Option<u32>, Option<u32>, Option<String>) {
    let (Some(w), Some(h)) = (coded_w, coded_h) else {
        return (None, None, None);
    };
    if w == 0 || h == 0 {
        return (None, None, None);
    }
    let mut disp_w = w as f64;
    let disp_h = h as f64;
    if let Some(sar_s) = sar {
        if let Some((num_s, den_s)) = sar_s.split_once(':') {
            if let (Ok(num), Ok(den)) = (num_s.trim().parse::<f64>(), den_s.trim().parse::<f64>()) {
                if num > 0.0 && den > 0.0 && (num - den).abs() > 1e-6 {
                    disp_w = (disp_w * num / den).round();
                }
            }
        }
    }

    let mut dw = disp_w.max(1.0).round() as u32;
    let mut dh = disp_h.max(1.0).round() as u32;
    let rot = rotation.unwrap_or(0);
    if rot == 90 || rot == 270 {
        std::mem::swap(&mut dw, &mut dh);
    }

    let orientation = if dw > dh {
        "landscape"
    } else if dh > dw {
        "portrait"
    } else {
        "square"
    };
    (Some(dw), Some(dh), Some(orientation.to_string()))
}

/// Evaluates whether sampled frame PTS timestamps indicate Variable Frame Rate (VFR).
///
/// When `pts_samples` comes from a bounded packet prefix (e.g. first 120 packets in DTS order),
/// B-frame reordering can leave small holes near the very end of the sorted PTS array because
/// packets referencing later decode indices were truncated. Excluding the trailing 8 sorted PTS
/// entries whenever enough samples exist eliminates false VFR positives on normal H.264/HEVC CFR streams.
pub fn detect_vfr_from_pts(pts_samples: &[f64]) -> Option<bool> {
    if pts_samples.len() < 4 {
        return None;
    }
    let mut sorted = pts_samples.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let slice = if sorted.len() >= 20 {
        &sorted[..sorted.len() - 8]
    } else {
        &sorted[..]
    };
    let mut deltas: Vec<f64> = Vec::new();
    for pair in slice.windows(2) {
        let d = pair[1] - pair[0];
        if d.is_finite() && d > 1e-4 {
            deltas.push(d);
        }
    }
    if deltas.len() < 3 {
        return None;
    }
    deltas.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = deltas[deltas.len() / 2];
    if median <= 0.0 {
        return None;
    }
    let min_d = deltas[0];
    let max_d = *deltas.last().unwrap_or(&median);
    let spread = (max_d - min_d) / median;
    Some(spread > 0.08)
}

fn sample_video_pts_for_vfr(ffprobe: &Path, source_path: &Path) -> Option<bool> {
    let args = vec![
        "-v".into(),
        "error".into(),
        "-select_streams".into(),
        "v:0".into(),
        "-show_entries".into(),
        "packet=pts_time".into(),
        "-read_intervals".into(),
        "%+#120".into(),
        "-of".into(),
        "csv=p=0".into(),
        source_path.to_string_lossy().to_string(),
    ];
    let stdout = run_ffprobe_args(ffprobe, &args).ok()?;
    let pts: Vec<f64> = stdout
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim().trim_end_matches(',');
            trimmed.parse::<f64>().ok().filter(|v| v.is_finite())
        })
        .collect();
    detect_vfr_from_pts(&pts)
}

pub fn format_duration_human(sec: Option<f64>) -> String {
    let Some(s) = sec else {
        return "Unknown".to_string();
    };
    if !s.is_finite() || s < 0.0 {
        return "Unknown".to_string();
    }
    let total_ms = (s * 1000.0).round() as u64;
    let hours = total_ms / 3_600_000;
    let mins = (total_ms % 3_600_000) / 60_000;
    let secs = (total_ms % 60_000) / 1000;
    let ms = total_ms % 1000;
    if hours > 0 {
        format!("{hours:02}:{mins:02}:{secs:02}.{ms:03}")
    } else {
        format!("{mins:02}:{secs:02}.{ms:03}")
    }
}

fn format_bytes_human(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KiB ({bytes} B)", bytes as f64 / 1024.0)
    } else if bytes < 1024 * 1024 * 1024 {
        format!("{:.2} MiB ({bytes} B)", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!(
            "{:.2} GiB ({bytes} B)",
            bytes as f64 / (1024.0 * 1024.0 * 1024.0)
        )
    }
}

fn format_bitrate_human(bps: Option<u64>) -> String {
    match bps {
        None => "Unknown".to_string(),
        Some(v) if v >= 1_000_000 => format!("{:.2} Mbps", v as f64 / 1_000_000.0),
        Some(v) => format!("{:.0} kbps", v as f64 / 1_000.0),
    }
}

fn build_summary_text(report: &MediaProbeReport) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("File: {}", report.file_name));
    lines.push(format!(
        "Container: {}",
        report
            .container_long_name
            .as_deref()
            .or(report.container_format.as_deref())
            .unwrap_or("Unknown")
    ));
    lines.push(format!(
        "Duration: {}",
        format_duration_human(report.duration_sec)
    ));
    lines.push(format!(
        "File Size: {}",
        format_bytes_human(report.byte_size)
    ));
    lines.push(format!(
        "Overall Bitrate: {}",
        format_bitrate_human(report.overall_bitrate_bps)
    ));

    for (i, v) in report.video_streams.iter().enumerate() {
        lines.push(format!(
            "--- Video Stream #{} (index {}) ---",
            i + 1,
            v.index
        ));
        lines.push(format!(
            "  Codec: {}",
            v.codec_long_name
                .as_deref()
                .or(v.codec_name.as_deref())
                .unwrap_or("Unknown")
        ));
        let coded = match (v.coded_width, v.coded_height) {
            (Some(w), Some(h)) => format!("{w}x{h}"),
            _ => "Unknown".into(),
        };
        let display = match (v.display_width, v.display_height) {
            (Some(w), Some(h)) => format!("{w}x{h}"),
            _ => "Unknown".into(),
        };
        lines.push(format!("  Dimensions: Storage {coded} / Display {display}"));
        lines.push(format!(
            "  Orientation / Rotation: {} ({})",
            v.orientation.as_deref().unwrap_or("Unknown"),
            v.rotation_degrees
                .map(|r| format!("{r} deg"))
                .unwrap_or_else(|| "0 deg".into())
        ));
        let fps_str = match (v.avg_frame_rate, v.r_frame_rate, v.is_variable_frame_rate) {
            (Some(avg), _, Some(true)) => format!("{avg:.3} fps (VFR)"),
            (Some(avg), _, Some(false)) => format!("{avg:.3} fps (CFR)"),
            (Some(avg), _, None) => format!("{avg:.3} fps"),
            (None, Some(r), Some(true)) => format!("VFR (nominal {r:.3} fps)"),
            (None, Some(r), _) => format!("{r:.3} fps"),
            (None, None, Some(true)) => "VFR (rate unknown)".into(),
            _ => "Unknown".into(),
        };
        lines.push(format!("  Frame Rate: {fps_str}"));
        lines.push(format!(
            "  Bitrate: {}",
            format_bitrate_human(v.bitrate_bps)
        ));
    }

    if report.audio_streams.is_empty() {
        lines.push("Audio Streams: None".to_string());
    } else {
        for a in &report.audio_streams {
            lines.push(format!(
                "--- Audio Track #{} (stream index {}) ---",
                a.audio_track_index + 1,
                a.index
            ));
            lines.push(format!(
                "  Codec: {}",
                a.codec_long_name
                    .as_deref()
                    .or(a.codec_name.as_deref())
                    .unwrap_or("Unknown")
            ));
            lines.push(format!(
                "  Language: {}",
                a.language.as_deref().unwrap_or("Unknown")
            ));
            if let Some(title) = &a.title {
                lines.push(format!("  Title: {title}"));
            }
            lines.push(format!(
                "  Channels: {}",
                match (a.channels, a.channel_layout.as_deref()) {
                    (Some(c), Some(l)) => format!("{c} ({l})"),
                    (Some(c), None) => format!("{c}"),
                    _ => "Unknown".into(),
                }
            ));
            lines.push(format!(
                "  Sample Rate: {}",
                a.sample_rate_hz
                    .map(|hz| format!("{hz} Hz"))
                    .unwrap_or_else(|| "Unknown".into())
            ));
            lines.push(format!(
                "  Bitrate: {}",
                format_bitrate_human(a.bitrate_bps)
            ));
        }
    }

    lines.join("\n")
}

/// Parses ffprobe JSON into a structured, honest `MediaProbeReport`.
pub fn parse_ffprobe_json(
    raw_json: &str,
    path: &Path,
    byte_size: u64,
    vfr_packet_hint: Option<bool>,
) -> Result<MediaProbeReport, AppError> {
    let parsed: FfprobeOutput = serde_json::from_str(raw_json)
        .map_err(|e| AppError::decode_failed(format!("Invalid ffprobe JSON output: {e}")))?;

    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("media")
        .to_string();

    let fmt = parsed.format.as_ref();
    let container_format = fmt.and_then(|f| non_empty_string(f.format_name.as_deref()));
    let container_long_name = fmt.and_then(|f| non_empty_string(f.format_long_name.as_deref()));
    let format_duration = fmt.and_then(|f| parse_positive_f64(f.duration.as_deref()));
    let overall_bitrate_bps = fmt.and_then(|f| parse_positive_u64(f.bit_rate.as_deref()));
    let format_tags = fmt.map(|f| f.tags.clone()).unwrap_or_default();

    let mut video_streams: Vec<VideoStreamInfo> = Vec::new();
    let mut audio_streams: Vec<AudioStreamInfo> = Vec::new();
    let mut subtitle_streams: Vec<SubtitleStreamInfo> = Vec::new();

    for (pos, st) in parsed.streams.iter().enumerate() {
        let idx = st.index.unwrap_or(pos);
        let ctype = st.codec_type.as_deref().unwrap_or("");
        let is_attached_pic = st.disposition.get("attached_pic").copied().unwrap_or(0) == 1;

        match ctype {
            "video" if !is_attached_pic => {
                let coded_w = st.width.filter(|&w| w > 0);
                let coded_h = st.height.filter(|&h| h > 0);
                let sar = non_empty_string(st.sample_aspect_ratio.as_deref());
                let rot = extract_stream_rotation(st);
                let (display_w, display_h, orientation) =
                    compute_display_dimensions(coded_w, coded_h, sar.as_deref(), rot);

                let avg_fps = parse_rational_fps(st.avg_frame_rate.as_deref());
                let r_fps = parse_rational_fps(st.r_frame_rate.as_deref());
                let header_vfr = match (avg_fps, r_fps) {
                    (Some(a), Some(r)) if r > 0.0 => Some(((a - r).abs() / r) > 0.02),
                    (None, Some(_)) => Some(true),
                    _ => None,
                };
                // Prefer direct packet PTS measurement on the primary video stream when available
                let is_vfr = if video_streams.is_empty() {
                    match (vfr_packet_hint, header_vfr) {
                        (Some(true), _) | (_, Some(true)) => Some(true),
                        (Some(false), _) => Some(false),
                        (None, other) => other,
                    }
                } else {
                    header_vfr
                };

                let stream_dur = parse_positive_f64(st.duration.as_deref())
                    .or_else(|| parse_tag_duration(&st.tags));

                video_streams.push(VideoStreamInfo {
                    index: idx,
                    codec_name: non_empty_string(st.codec_name.as_deref()),
                    codec_long_name: non_empty_string(st.codec_long_name.as_deref()),
                    profile: non_empty_string(st.profile.as_deref()),
                    pixel_format: non_empty_string(st.pix_fmt.as_deref()),
                    coded_width: coded_w,
                    coded_height: coded_h,
                    display_width: display_w,
                    display_height: display_h,
                    sample_aspect_ratio: sar,
                    rotation_degrees: rot,
                    orientation,
                    avg_frame_rate: avg_fps,
                    r_frame_rate: r_fps,
                    avg_frame_rate_raw: non_empty_string(st.avg_frame_rate.as_deref()),
                    r_frame_rate_raw: non_empty_string(st.r_frame_rate.as_deref()),
                    is_variable_frame_rate: is_vfr,
                    bitrate_bps: parse_positive_u64(st.bit_rate.as_deref()),
                    color_space: non_empty_string(st.color_space.as_deref()),
                    color_transfer: non_empty_string(st.color_transfer.as_deref()),
                    color_primaries: non_empty_string(st.color_primaries.as_deref()),
                    duration_sec: stream_dur,
                });
            }
            "audio" => {
                let track_idx = audio_streams.len();
                let stream_dur = parse_positive_f64(st.duration.as_deref())
                    .or_else(|| parse_tag_duration(&st.tags));
                let codec_name = non_empty_string(st.codec_name.as_deref());
                let sample_fmt = non_empty_string(st.sample_fmt.as_deref());
                let inferred_bits = parse_positive_u32(st.bits_per_raw_sample.as_deref())
                    .or_else(|| st.bits_per_sample.filter(|&b| b > 0))
                    .or_else(|| infer_pcm_bits(codec_name.as_deref()));
                audio_streams.push(AudioStreamInfo {
                    index: idx,
                    audio_track_index: track_idx,
                    codec_name,
                    codec_long_name: non_empty_string(st.codec_long_name.as_deref()),
                    profile: non_empty_string(st.profile.as_deref()),
                    language: find_tag_ci(&st.tags, "language"),
                    title: find_tag_ci(&st.tags, "title"),
                    channels: st.channels.filter(|&c| c > 0),
                    channel_layout: non_empty_string(st.channel_layout.as_deref()),
                    sample_rate_hz: parse_positive_u32(st.sample_rate.as_deref()),
                    sample_fmt,
                    bits_per_sample: inferred_bits,
                    bitrate_bps: parse_positive_u64(st.bit_rate.as_deref()),
                    duration_sec: stream_dur,
                    is_default: st.disposition.get("default").copied().unwrap_or(0) == 1,
                });
            }
            "subtitle" => {
                subtitle_streams.push(SubtitleStreamInfo {
                    index: idx,
                    codec_name: non_empty_string(st.codec_name.as_deref()),
                    language: find_tag_ci(&st.tags, "language"),
                    title: find_tag_ci(&st.tags, "title"),
                });
            }
            _ => {}
        }
    }

    if video_streams.is_empty() && audio_streams.is_empty() && container_format.is_none() {
        return Err(AppError::decode_failed(
            "File does not contain any recognizable video or audio streams.",
        ));
    }

    // Use format duration, falling back to longest known stream duration only if genuinely present
    let effective_duration = format_duration.or_else(|| {
        video_streams
            .iter()
            .filter_map(|v| v.duration_sec)
            .chain(audio_streams.iter().filter_map(|a| a.duration_sec))
            .fold(None, |acc: Option<f64>, d| {
                Some(acc.map_or(d, |cur| cur.max(d)))
            })
    });

    let mut report = MediaProbeReport {
        path: path.to_string_lossy().to_string(),
        file_name,
        byte_size,
        container_format,
        container_long_name,
        duration_sec: effective_duration,
        overall_bitrate_bps,
        stream_count: parsed.streams.len(),
        has_video: !video_streams.is_empty(),
        has_audio: !audio_streams.is_empty(),
        video_streams,
        audio_streams,
        subtitle_streams,
        format_tags,
        summary_text: String::new(),
        raw_json: raw_json.to_string(),
    };
    report.summary_text = build_summary_text(&report);
    Ok(report)
}

/// Parses Matroska-style `DURATION` tag like `00:00:05.500000000` when stream/format duration is missing.
fn parse_tag_duration(tags: &BTreeMap<String, String>) -> Option<f64> {
    let raw = find_tag_ci(tags, "DURATION")?;
    let parts: Vec<&str> = raw.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h: f64 = parts[0].trim().parse().ok()?;
    let m: f64 = parts[1].trim().parse().ok()?;
    let s: f64 = parts[2].trim().parse().ok()?;
    let total = h * 3600.0 + m * 60.0 + s;
    if total.is_finite() && total > 0.0 {
        Some(total)
    } else {
        None
    }
}

pub fn probe_media_info_impl(
    media_root: &Path,
    source_raw: &str,
) -> Result<MediaProbeReport, AppError> {
    let (source_path, byte_size) = validate_existing_input_file(source_raw)?;
    let tools = require_media_tools(media_root)?;

    let args = vec![
        "-v".into(),
        "error".into(),
        "-print_format".into(),
        "json".into(),
        "-show_format".into(),
        "-show_streams".into(),
        "-show_chapters".into(),
        source_path.to_string_lossy().to_string(),
    ];
    let raw_json = run_ffprobe_args(&tools.ffprobe, &args)?;

    // Quick initial check for video stream presence before doing bounded VFR packet probe
    let quick: FfprobeOutput = serde_json::from_str(&raw_json)
        .map_err(|e| AppError::decode_failed(format!("Invalid ffprobe JSON output: {e}")))?;
    let has_video = quick.streams.iter().any(|s| {
        s.codec_type.as_deref() == Some("video")
            && s.disposition.get("attached_pic").copied().unwrap_or(0) != 1
    });

    let vfr_hint = if has_video {
        sample_video_pts_for_vfr(&tools.ffprobe, &source_path)
    } else {
        None
    };

    parse_ffprobe_json(&raw_json, &source_path, byte_size, vfr_hint)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_fields_and_zero_rationals_stay_none_instead_of_zero() {
        let json = r#"{
            "format": {
                "format_name": "matroska,webm",
                "format_long_name": "Matroska / WebM",
                "duration": "N/A",
                "bit_rate": "0"
            },
            "streams": [
                {
                    "index": 0,
                    "codec_type": "video",
                    "codec_name": "h264",
                    "width": 1920,
                    "height": 1080,
                    "avg_frame_rate": "0/0",
                    "r_frame_rate": "30/1",
                    "side_data_list": [{ "side_data_type": "Display Matrix", "rotation": -90 }]
                },
                {
                    "index": 1,
                    "codec_type": "audio",
                    "codec_name": "aac",
                    "channels": 2,
                    "sample_rate": "48000",
                    "tags": { "language": "eng", "title": "English Track" },
                    "disposition": { "default": 1 }
                },
                {
                    "index": 2,
                    "codec_type": "audio",
                    "codec_name": "opus",
                    "channels": 2,
                    "sample_rate": "48000",
                    "tags": { "language": "zho" }
                }
            ]
        }"#;
        let report =
            parse_ffprobe_json(json, Path::new("C:\\demo\\clip.mkv"), 12345, Some(true)).unwrap();
        assert_eq!(report.duration_sec, None);
        assert_eq!(report.overall_bitrate_bps, None);
        assert_eq!(report.video_streams.len(), 1);
        let v = &report.video_streams[0];
        assert_eq!(v.coded_width, Some(1920));
        assert_eq!(v.coded_height, Some(1080));
        assert_eq!(v.display_width, Some(1080));
        assert_eq!(v.display_height, Some(1920));
        assert_eq!(v.rotation_degrees, Some(270));
        assert_eq!(v.orientation.as_deref(), Some("portrait"));
        assert_eq!(v.avg_frame_rate, None);
        assert_eq!(v.is_variable_frame_rate, Some(true));
        assert_eq!(v.bitrate_bps, None);

        assert_eq!(report.audio_streams.len(), 2);
        assert_eq!(report.audio_streams[0].language.as_deref(), Some("eng"));
        assert_eq!(report.audio_streams[1].language.as_deref(), Some("zho"));
        assert_eq!(report.audio_streams[1].audio_track_index, 1);
        assert_eq!(report.audio_streams[1].bitrate_bps, None);
    }

    #[test]
    fn vfr_pts_detector_distinguishes_cfr_and_vfr_timestamps() {
        let cfr: Vec<f64> = (0..30).map(|i| i as f64 / 30.0).collect();
        assert_eq!(detect_vfr_from_pts(&cfr), Some(false));

        // Simulate bounded DTS prefix truncation where the last B-frame (frame 119) is missing
        let mut cfr_bframe_tail: Vec<f64> = (0..119).map(|i| i as f64 * 0.04).collect();
        cfr_bframe_tail.push(120.0 * 0.04);
        assert_eq!(detect_vfr_from_pts(&cfr_bframe_tail), Some(false));

        let vfr = vec![0.0, 0.04, 0.08, 0.48, 0.52, 1.32, 1.36, 2.50];
        assert_eq!(detect_vfr_from_pts(&vfr), Some(true));

        assert_eq!(detect_vfr_from_pts(&[0.0, 1.0]), None);
    }
}
