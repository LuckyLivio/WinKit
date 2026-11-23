//! V02 Burn In Subtitles — offline SRT & WebVTT parser with actionable line/cue/timestamp
//! diagnostics, styled ASS subtitle generator using built-in Windows Chinese fonts
//! (`Microsoft YaHei` via `fontsdir='C\:/Windows/Fonts'`), instant cue-click frame preview,
//! and full video subtitle burn-in baking upright orientation and preserving audio.

use crate::error::AppError;
use crate::fs_guard::validate_existing_input_file;
use crate::media_core::{
    configure_hidden_command, require_media_tools, run_ffmpeg_cancellable_in_dir,
    AtomicMediaOutput, MediaTaskProgressPayload,
};
use crate::media_info::probe_media_info_impl;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::AtomicBool;
use std::time::Instant;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubtitleFormat {
    Srt,
    WebVtt,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleCue {
    pub index: usize,
    pub start_sec: f64,
    pub end_sec: f64,
    pub text: String,
    pub source_line: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedSubtitleFile {
    pub path: String,
    pub file_name: String,
    pub format: SubtitleFormat,
    pub cue_count: usize,
    pub total_duration_sec: f64,
    pub cues: Vec<SubtitleCue>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubtitlePosition {
    Bottom,
    Top,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubtitleBoxStyle {
    OutlineShadow,
    BlackBox,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleBurnStyle {
    /// Font size in 720p-normalized pixels (18..=84, default 38).
    pub font_size: u32,
    pub position: SubtitlePosition,
    pub box_style: SubtitleBoxStyle,
    /// Optional explicit font name; defaults to `"Microsoft YaHei"` for crisp offline CJK+Latin.
    pub font_name: Option<String>,
    /// Vertical margin from bottom/top edge in 720p-normalized pixels (12..=160, default 36).
    pub margin_v: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSubtitleFrameRequest {
    pub video_path: String,
    pub subtitle_path: String,
    pub timestamp_sec: f64,
    pub style: SubtitleBurnStyle,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSubtitleFrameResult {
    pub data_url: String,
    pub timestamp_sec: f64,
    pub active_cue_indices: Vec<usize>,
    pub display_width: u32,
    pub display_height: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BurnInSubtitlesRequest {
    pub task_id: String,
    pub video_path: String,
    pub subtitle_path: String,
    pub output_path: String,
    pub style: SubtitleBurnStyle,
    pub allow_overwrite: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BurnInSubtitlesResult {
    pub output_path: String,
    pub byte_size: u64,
    pub output_width: u32,
    pub output_height: u32,
    pub output_rotation: Option<i32>,
    pub duration_sec: Option<f64>,
    pub burned_cue_count: usize,
    pub has_audio: bool,
    pub audio_copied: bool,
    pub subtitle_streams_in_output: usize,
    pub elapsed_ms: u64,
}

struct ScopedTempFile(PathBuf);

impl Drop for ScopedTempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn ensure_even(v: u32) -> u32 {
    (v & !1).max(2)
}

/// Parses an SRT (`HH:MM:SS,mmm` or `HH:MM:SS.mmm`) or WebVTT (`[HH:]MM:SS.mmm`) timestamp to seconds.
fn parse_timestamp_token(raw: &str, allow_short_mm_ss: bool) -> Result<f64, String> {
    let token = raw.trim();
    if token.is_empty() {
        return Err("empty timestamp".into());
    }
    let normalized = token.replace(',', ".");
    let parts: Vec<&str> = normalized.split(':').collect();
    let (h, m, s_str) = match parts.as_slice() {
        [hh, mm, ss] => {
            let h: u64 = hh
                .parse()
                .map_err(|_| format!("invalid hours '{hh}' in '{token}'"))?;
            let m: u64 = mm
                .parse()
                .map_err(|_| format!("invalid minutes '{mm}' in '{token}'"))?;
            (h, m, *ss)
        }
        [mm, ss] if allow_short_mm_ss => {
            let m: u64 = mm
                .parse()
                .map_err(|_| format!("invalid minutes '{mm}' in '{token}'"))?;
            (0u64, m, *ss)
        }
        _ => {
            return Err(format!(
                "invalid timestamp format '{token}' (expected HH:MM:SS,mmm or MM:SS.mmm)"
            ));
        }
    };
    if m >= 60 {
        return Err(format!("minutes out of range (0-59) in '{token}'"));
    }
    let sec_parts: Vec<&str> = s_str.split('.').collect();
    if sec_parts.len() > 2 {
        return Err(format!("malformed seconds '{s_str}' in '{token}'"));
    }
    let sec_whole: u64 = sec_parts[0]
        .parse()
        .map_err(|_| format!("invalid seconds '{}' in '{token}'", sec_parts[0]))?;
    if sec_whole >= 60 {
        return Err(format!("seconds out of range (0-59) in '{token}'"));
    }
    let frac = if sec_parts.len() == 2 {
        let f = sec_parts[1];
        if f.is_empty() || !f.chars().all(|c| c.is_ascii_digit()) {
            return Err(format!("invalid milliseconds '{f}' in '{token}'"));
        }
        let val: f64 = f
            .parse()
            .map_err(|_| format!("invalid fraction in '{token}'"))?;
        val / 10f64.powi(f.len() as i32)
    } else {
        0.0
    };
    Ok((h as f64) * 3600.0 + (m as f64) * 60.0 + (sec_whole as f64) + frac)
}

fn clean_cue_inline_markup(raw: &str) -> String {
    // Convert basic SRT/VTT <i>, <b>, <u> tags into ASS tags or strip unknown cue tags cleanly.
    let mut out = String::with_capacity(raw.len());
    let chars: Vec<char> = raw.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '<' {
            if let Some(rel_end) = chars[i + 1..].iter().position(|&c| c == '>') {
                let tag: String = chars[i + 1..i + 1 + rel_end].iter().collect();
                let lower = tag.trim().to_ascii_lowercase();
                match lower.as_str() {
                    "i" => out.push_str("{\\i1}"),
                    "/i" => out.push_str("{\\i0}"),
                    "b" => out.push_str("{\\b1}"),
                    "/b" => out.push_str("{\\b0}"),
                    "u" => out.push_str("{\\u1}"),
                    "/u" => out.push_str("{\\u0}"),
                    "br" | "br/" | "br /" => out.push('\n'),
                    _ => {} // strip VTT class/voice/timestamp tags like <v Speaker> or <c.color>
                }
                i += rel_end + 2;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Strictly parses SRT or WebVTT text (UTF-8, optional BOM, CRLF/LF/CR) returning structured cues
/// or an actionable error naming exact 1-based line number and cue detail.
pub fn parse_subtitle_content(
    content: &str,
    ext_hint: Option<&str>,
) -> Result<(SubtitleFormat, Vec<SubtitleCue>, Vec<String>), AppError> {
    let stripped = content.strip_prefix('\u{feff}').unwrap_or(content);
    let normalized = stripped.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();

    let first_non_empty = lines.iter().enumerate().find(|(_, l)| !l.trim().is_empty());
    let Some((first_idx, first_line)) = first_non_empty else {
        return Err(AppError::invalid_param(
            "Subtitle file is empty (no cues found).",
        ));
    };

    let is_vtt_header = first_line.trim_start().starts_with("WEBVTT");
    let format = if is_vtt_header
        || ext_hint
            .map(|e| e.eq_ignore_ascii_case("vtt"))
            .unwrap_or(false)
    {
        if !is_vtt_header {
            return Err(AppError::invalid_param(format!(
                "Line {}: WebVTT file must start with a 'WEBVTT' header line.",
                first_idx + 1
            )));
        }
        SubtitleFormat::WebVtt
    } else {
        SubtitleFormat::Srt
    };

    let mut cues: Vec<SubtitleCue> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    let mut i = if is_vtt_header { first_idx + 1 } else { 0 };
    // Skip WebVTT header metadata lines immediately following WEBVTT until blank line
    if is_vtt_header {
        while i < lines.len() && !lines[i].trim().is_empty() {
            i += 1;
        }
    }

    let mut block_num = 0usize;
    while i < lines.len() {
        // Skip blank lines
        while i < lines.len() && lines[i].trim().is_empty() {
            i += 1;
        }
        if i >= lines.len() {
            break;
        }

        let block_start = i;
        while i < lines.len() && !lines[i].trim().is_empty() {
            i += 1;
        }
        let block = &lines[block_start..i];
        if block.is_empty() {
            continue;
        }

        // Ignore WebVTT NOTE / STYLE / REGION blocks cleanly
        let head = block[0].trim();
        if format == SubtitleFormat::WebVtt
            && (head == "NOTE"
                || head.starts_with("NOTE ")
                || head.starts_with("NOTE\t")
                || head == "STYLE"
                || head == "REGION")
        {
            continue;
        }

        block_num += 1;
        let timing_rel = if block[0].contains("-->") {
            0usize
        } else if block.len() >= 2 && block[1].contains("-->") {
            1usize
        } else {
            return Err(AppError::invalid_param(format!(
                "Line {} (cue #{}): missing timing separator '-->' in block '{}'.",
                block_start + 1,
                block_num,
                head.chars().take(48).collect::<String>()
            )));
        };

        let timing_line_no = block_start + timing_rel + 1;
        let timing_line = block[timing_rel];
        let mut split_arrow = timing_line.splitn(2, "-->");
        let raw_start = split_arrow.next().unwrap_or("").trim();
        let raw_rest = split_arrow.next().unwrap_or("").trim();
        // End token is the first whitespace-delimited token (VTT allows cue settings like align:middle after it)
        let raw_end = raw_rest.split_whitespace().next().unwrap_or("");

        let allow_short = format == SubtitleFormat::WebVtt;
        let start_sec = parse_timestamp_token(raw_start, allow_short).map_err(|msg| {
            AppError::invalid_param(format!(
                "Line {timing_line_no} (cue #{block_num}): start timestamp error — {msg}."
            ))
        })?;
        let end_sec = parse_timestamp_token(raw_end, allow_short).map_err(|msg| {
            AppError::invalid_param(format!(
                "Line {timing_line_no} (cue #{block_num}): end timestamp error — {msg}."
            ))
        })?;

        if end_sec <= start_sec {
            return Err(AppError::invalid_param(format!(
                "Line {timing_line_no} (cue #{block_num}): end time ({raw_end}) must be after start time ({raw_start})."
            )));
        }

        let text_lines = &block[timing_rel + 1..];
        let text = text_lines
            .iter()
            .map(|l| l.trim_end())
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string();

        if text.is_empty() {
            warnings.push(format!(
                "Line {timing_line_no} (cue #{block_num}): skipped cue with empty text."
            ));
            continue;
        }

        cues.push(SubtitleCue {
            index: cues.len() + 1,
            start_sec,
            end_sec,
            text,
            source_line: timing_line_no,
        });
    }

    if cues.is_empty() {
        return Err(AppError::invalid_param(
            "No valid subtitle cues with text were found in the file.",
        ));
    }

    Ok((format, cues, warnings))
}

pub fn parse_subtitle_file_impl(path_str: &str) -> Result<ParsedSubtitleFile, AppError> {
    let (path, byte_len) = validate_existing_input_file(path_str)?;
    if byte_len > 20 * 1024 * 1024 {
        return Err(AppError::invalid_param(
            "Subtitle file exceeds the 20 MiB safety limit.",
        ));
    }
    let bytes =
        fs::read(&path).map_err(|e| AppError::from_io(e, "Failed reading subtitle file"))?;
    let content = String::from_utf8(bytes).map_err(|_| {
        AppError::invalid_param(
            "Subtitle file is not valid UTF-8 text. Please re-save it as UTF-8 (.srt or .vtt).",
        )
    })?;
    let ext = path.extension().and_then(|e| e.to_str());
    let (format, cues, warnings) = parse_subtitle_content(&content, ext)?;
    let total_duration_sec = cues.iter().map(|c| c.end_sec).fold(0.0f64, f64::max);
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("subtitles")
        .to_string();

    Ok(ParsedSubtitleFile {
        path: path.to_string_lossy().to_string(),
        file_name,
        format,
        cue_count: cues.len(),
        total_duration_sec,
        cues,
        warnings,
    })
}

fn format_ass_time(sec: f64) -> String {
    let clamped = sec.max(0.0);
    let total_cs = (clamped * 100.0).round() as u64;
    let h = total_cs / 360_000;
    let m = (total_cs % 360_000) / 6_000;
    let s = (total_cs % 6_000) / 100;
    let cs = total_cs % 100;
    format!("{h}:{m:02}:{s:02}.{cs:02}")
}

fn escape_ass_dialogue_text(raw: &str) -> String {
    let styled = clean_cue_inline_markup(raw);
    styled.replace('\n', "\\N")
}

/// Builds a self-contained ASS document normalized to `PlayResY = 720` with proportional `PlayResX`
/// so subtitles render at crisp, predictable proportions on both portrait and landscape videos
/// using built-in Windows CJK+Latin fonts (`Microsoft YaHei`).
pub fn build_ass_document(
    cues: &[SubtitleCue],
    display_w: u32,
    display_h: u32,
    style: &SubtitleBurnStyle,
) -> String {
    let play_res_y: u32 = 720;
    let play_res_x: u32 = ((f64::from(play_res_y) * f64::from(display_w.max(2)))
        / f64::from(display_h.max(2)))
    .round()
    .clamp(240.0, 2880.0) as u32;

    let font_size = style.font_size.clamp(18, 84);
    let margin_v = style.margin_v.unwrap_or(36).clamp(12, 160);
    let margin_lr = ((f64::from(play_res_x) * 0.05).round() as u32).clamp(16, 80);
    let alignment = match style.position {
        SubtitlePosition::Bottom => 2,
        SubtitlePosition::Top => 8,
    };
    let font_name = style
        .font_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Microsoft YaHei");

    // BorderStyle 1 = crisp outline + drop shadow; BorderStyle 3 = semi-transparent black box
    let (border_style, outline_color, back_color, outline_w, shadow_w) = match style.box_style {
        SubtitleBoxStyle::OutlineShadow => (1, "&H00121212", "&H90000000", "2.6", "1.4"),
        SubtitleBoxStyle::BlackBox => (3, "&H52000000", "&H52000000", "8.0", "0.0"),
    };

    let mut ass = String::with_capacity(1024 + cues.len() * 80);
    ass.push_str("[Script Info]\n");
    ass.push_str("ScriptType: v4.00+\n");
    ass.push_str("WrapStyle: 0\n");
    ass.push_str("ScaledBorderAndShadow: yes\n");
    ass.push_str(&format!("PlayResX: {play_res_x}\n"));
    ass.push_str(&format!("PlayResY: {play_res_y}\n\n"));

    ass.push_str("[V4+ Styles]\n");
    ass.push_str("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n");
    ass.push_str(&format!(
        "Style: Default,{font_name},{font_size},&H00FFFFFF,&H0000FFFF,{outline_color},{back_color},0,0,0,0,100,100,0,0,{border_style},{outline_w},{shadow_w},{alignment},{margin_lr},{margin_lr},{margin_v},1\n\n"
    ));

    ass.push_str("[Events]\n");
    ass.push_str(
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n",
    );
    for cue in cues {
        let start = format_ass_time(cue.start_sec);
        let end = format_ass_time(cue.end_sec);
        let text = escape_ass_dialogue_text(&cue.text);
        ass.push_str(&format!(
            "Dialogue: 0,{start},{end},Default,,0,0,0,,{text}\n"
        ));
    }
    ass
}

fn windows_fonts_dir_filter_arg() -> String {
    let win_dir = std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".into());
    let fonts = PathBuf::from(win_dir).join("Fonts");
    let raw = fonts.to_string_lossy().replace('\\', "/");
    // Escape ':' as '\:' for FFmpeg filtergraph option parser
    raw.replace(':', "\\:")
}

/// Renders a single upright video frame at `timestamp_sec` with the exact active burned-in
/// subtitle(s) overlaid using the same ASS generator & offline Windows font path as final export.
pub fn preview_burned_subtitle_frame_impl(
    media_root: &Path,
    req: &PreviewSubtitleFrameRequest,
) -> Result<PreviewSubtitleFrameResult, AppError> {
    let (video_path, _) = validate_existing_input_file(&req.video_path)?;
    let parsed = parse_subtitle_file_impl(&req.subtitle_path)?;
    let tools = require_media_tools(media_root)?;
    let probe = probe_media_info_impl(media_root, &req.video_path)?;

    let v_stream = probe
        .video_streams
        .first()
        .ok_or_else(|| AppError::invalid_param("Selected file does not contain a video stream."))?;
    let disp_w = ensure_even(
        v_stream
            .display_width
            .or(v_stream.coded_width)
            .unwrap_or(1280),
    );
    let disp_h = ensure_even(
        v_stream
            .display_height
            .or(v_stream.coded_height)
            .unwrap_or(720),
    );

    let max_t = probe
        .duration_sec
        .map(|d| (d - 0.05).max(0.0))
        .unwrap_or(req.timestamp_sec.max(0.0));
    let ts = req.timestamp_sec.clamp(0.0, max_t);

    // Collect cues active at `ts` and place them at 0.0..5.0s so fast input seeking (-ss before -i)
    // renders the exact burned subtitle instantly without scanning the whole file!
    let mut active_indices = Vec::new();
    let mut preview_cues = Vec::new();
    for cue in &parsed.cues {
        if ts >= cue.start_sec - 0.001 && ts <= cue.end_sec + 0.001 {
            active_indices.push(cue.index);
            preview_cues.push(SubtitleCue {
                index: cue.index,
                start_sec: 0.0,
                end_sec: 5.0,
                text: cue.text.clone(),
                source_line: cue.source_line,
            });
        }
    }

    let tmp_dir = std::env::temp_dir();
    let ass_filename = format!("winkit_v02_prev_{}.ass", Uuid::new_v4());
    let ass_path = tmp_dir.join(&ass_filename);
    let ass_content = build_ass_document(&preview_cues, disp_w, disp_h, &req.style);
    fs::write(&ass_path, ass_content.as_bytes())
        .map_err(|e| AppError::from_io(e, "Failed writing temporary ASS preview file"))?;
    let _ass_guard = ScopedTempFile(ass_path);

    let fonts_arg = windows_fonts_dir_filter_arg();
    let vf = format!(
        "scale={disp_w}:{disp_h},setsar=1,ass='{ass_filename}':fontsdir='{fonts_arg}',scale='min(960,iw)':-2"
    );

    let mut cmd = Command::new(&tools.ffmpeg);
    cmd.current_dir(&tmp_dir)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            &format!("{ts:.3}"),
            "-i",
            &video_path.to_string_lossy(),
            "-frames:v",
            "1",
            "-vf",
            &vf,
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "-q:v",
            "3",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_hidden_command(&mut cmd);

    let output = cmd.output().map_err(|e| {
        AppError::new(
            "MEDIA_PROCESS_FAILED",
            format!("Failed running ffmpeg subtitle frame preview: {e}"),
        )
    })?;
    if !output.status.success() || output.stdout.is_empty() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::decode_failed(format!(
            "Failed rendering subtitle preview frame: {}",
            err.lines()
                .rev()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("empty output")
        )));
    }

    let b64 = BASE64_STANDARD.encode(&output.stdout);
    Ok(PreviewSubtitleFrameResult {
        data_url: format!("data:image/jpeg;base64,{b64}"),
        timestamp_sec: ts,
        active_cue_indices: active_indices,
        display_width: disp_w,
        display_height: disp_h,
    })
}

fn is_audio_copy_ok(ext: &str, codecs: &[Option<String>]) -> bool {
    if codecs.is_empty() {
        return true;
    }
    match ext {
        "mp4" | "m4v" => codecs.iter().all(|c| {
            matches!(
                c.as_deref().unwrap_or("").to_ascii_lowercase().as_str(),
                "aac" | "mp3" | "ac3" | "eac3" | "alac" | "opus"
            )
        }),
        "mov" => codecs.iter().all(|c| {
            matches!(
                c.as_deref().unwrap_or("").to_ascii_lowercase().as_str(),
                "aac" | "mp3" | "alac" | "pcm_s16le" | "pcm_s24le"
            )
        }),
        "mkv" => true,
        "webm" => codecs.iter().all(|c| {
            matches!(
                c.as_deref().unwrap_or("").to_ascii_lowercase().as_str(),
                "opus" | "vorbis"
            )
        }),
        _ => false,
    }
}

pub fn burn_in_subtitles_impl(
    media_root: &Path,
    req: &BurnInSubtitlesRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(MediaTaskProgressPayload),
) -> Result<BurnInSubtitlesResult, AppError> {
    let t0 = Instant::now();
    let (video_path, _) = validate_existing_input_file(&req.video_path)?;
    let parsed = parse_subtitle_file_impl(&req.subtitle_path)?;
    let tools = require_media_tools(media_root)?;
    let probe = probe_media_info_impl(media_root, &req.video_path)?;

    let v_stream = probe
        .video_streams
        .first()
        .ok_or_else(|| AppError::invalid_param("Selected file does not contain a video stream."))?;
    let out_w = ensure_even(v_stream.display_width.or(v_stream.coded_width).unwrap_or(0));
    let out_h = ensure_even(
        v_stream
            .display_height
            .or(v_stream.coded_height)
            .unwrap_or(0),
    );
    if out_w < 2 || out_h < 2 {
        return Err(AppError::decode_failed(
            "Unable to determine source video dimensions.",
        ));
    }

    let tmp_dir = std::env::temp_dir();
    let ass_filename = format!("winkit_v02_burn_{}.ass", Uuid::new_v4());
    let ass_path = tmp_dir.join(&ass_filename);
    let ass_content = build_ass_document(&parsed.cues, out_w, out_h, &req.style);
    fs::write(&ass_path, ass_content.as_bytes())
        .map_err(|e| AppError::from_io(e, "Failed writing temporary ASS subtitle file"))?;
    let _ass_guard = ScopedTempFile(ass_path);

    let allow_overwrite = req.allow_overwrite.unwrap_or(true);
    let final_path = PathBuf::from(req.output_path.trim());
    let ext = final_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_else(|| "mp4".into());

    let atomic = AtomicMediaOutput::prepare(final_path, &video_path, allow_overwrite)?;
    let duration = probe.duration_sec;
    let file_name = probe.file_name.clone();

    on_progress(MediaTaskProgressPayload {
        task_id: req.task_id.clone(),
        tool_id: "V02".into(),
        phase: "running".into(),
        current_item: 1,
        total_items: 1,
        item_name: Some(file_name.clone()),
        percent: Some(0.0),
        out_time_sec: Some(0.0),
        total_duration_sec: duration,
    });

    let fonts_arg = windows_fonts_dir_filter_arg();
    let vf = format!(
        "scale={out_w}:{out_h},setsar=1,ass='{ass_filename}':fontsdir='{fonts_arg}',format=yuv420p"
    );

    let audio_codecs: Vec<Option<String>> = probe
        .audio_streams
        .iter()
        .map(|a| a.codec_name.clone())
        .collect();
    let audio_copy = probe.has_audio && is_audio_copy_ok(&ext, &audio_codecs);

    let mut args: Vec<String> = vec![
        "-i".into(),
        video_path.to_string_lossy().to_string(),
        "-map".into(),
        "0:v:0".into(),
    ];
    if probe.has_audio {
        args.extend(["-map".into(), "0:a?".into()]);
    } else {
        args.push("-an".into());
    }
    // Explicitly drop soft subtitle streams so players see hard-burned pixels even with subtitles off
    args.extend(["-sn".into(), "-vf".into(), vf]);

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

    run_ffmpeg_cancellable_in_dir(
        &tools.ffmpeg,
        &args,
        Some(&tmp_dir),
        duration,
        cancel_flag,
        |out_t, pct| {
            on_progress(MediaTaskProgressPayload {
                task_id: req.task_id.clone(),
                tool_id: "V02".into(),
                phase: "running".into(),
                current_item: 1,
                total_items: 1,
                item_name: Some(file_name.clone()),
                percent: pct,
                out_time_sec: out_t,
                total_duration_sec: duration,
            });
        },
    )?;

    let (committed_path, byte_size) = atomic.commit(allow_overwrite)?;
    let final_str = committed_path.to_string_lossy().to_string();
    let verified = probe_media_info_impl(media_root, &final_str).ok();
    let ov = verified.as_ref().and_then(|v| v.video_streams.first());

    on_progress(MediaTaskProgressPayload {
        task_id: req.task_id.clone(),
        tool_id: "V02".into(),
        phase: "completed".into(),
        current_item: 1,
        total_items: 1,
        item_name: Some(file_name),
        percent: Some(100.0),
        out_time_sec: duration,
        total_duration_sec: duration,
    });

    Ok(BurnInSubtitlesResult {
        output_path: final_str,
        byte_size,
        output_width: ov.and_then(|v| v.display_width).unwrap_or(out_w),
        output_height: ov.and_then(|v| v.display_height).unwrap_or(out_h),
        output_rotation: ov.and_then(|v| v.rotation_degrees),
        duration_sec: verified.as_ref().and_then(|v| v.duration_sec),
        burned_cue_count: parsed.cue_count,
        has_audio: verified
            .as_ref()
            .map(|v| v.has_audio)
            .unwrap_or(probe.has_audio),
        audio_copied: audio_copy,
        subtitle_streams_in_output: verified
            .as_ref()
            .map(|v| v.subtitle_streams.len())
            .unwrap_or(0),
        elapsed_ms: t0.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_srt_and_webvtt_with_bom_crlf_cjk_multiline_and_reports_exact_errors() {
        let srt = "\u{feff}1\r\n00:00:00,800 --> 00:00:02,200\r\n你好 WinKit 字幕测试\r\nSecond English line\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,500\r\n第二句中文说明\r\n";
        let (fmt, cues, warnings) = parse_subtitle_content(srt, Some("srt")).unwrap();
        assert_eq!(fmt, SubtitleFormat::Srt);
        assert_eq!(cues.len(), 2);
        assert!(warnings.is_empty());
        assert!((cues[0].start_sec - 0.8).abs() < 1e-6);
        assert!(cues[0].text.contains("你好 WinKit"));
        assert!(cues[0].text.contains('\n'));

        let vtt = "WEBVTT - Demo\n\nNOTE ignore comment\n\ncue-a\n00:01.250 --> 00:02.750 align:middle\n中文与 English\n";
        let (fmt2, cues2, _) = parse_subtitle_content(vtt, Some("vtt")).unwrap();
        assert_eq!(fmt2, SubtitleFormat::WebVtt);
        assert_eq!(cues2.len(), 1);
        assert!((cues2[0].start_sec - 1.25).abs() < 1e-6);
        assert!((cues2[0].end_sec - 2.75).abs() < 1e-6);

        // Bad timestamp reports exact line number
        let bad_ts = "1\n00:00:02,500 --> 00:00:01,000\nReversed timing\n";
        let err = parse_subtitle_content(bad_ts, Some("srt")).unwrap_err();
        assert!(err.message.contains("Line 2"), "got: {}", err.message);

        let missing_arrow = "1\nnot a timing line\nhello\n";
        let err2 = parse_subtitle_content(missing_arrow, Some("srt")).unwrap_err();
        assert!(err2.message.contains("Line 1"), "got: {}", err2.message);
    }

    #[test]
    fn burns_chinese_english_subtitles_into_rotated_portrait_video_in_unicode_dir_with_exact_timing(
    ) {
        let tmp = std::env::temp_dir().join(format!("winkit_v02_字幕 测试_{}", Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let tools = match require_media_tools(&tmp) {
            Ok(t) => t,
            Err(_) => {
                let _ = fs::remove_dir_all(&tmp);
                return;
            }
        };

        // Create 4.5s 90°-rotated dark video (coded 640x360, display_rotation 90 -> display 360x640)
        let raw_vid = tmp.join("raw_640x360.mp4");
        let src_vid = tmp.join("竖屏 样片.mp4");
        let mut cmd0 = Command::new(&tools.ffmpeg);
        configure_hidden_command(&mut cmd0);
        assert!(cmd0
            .args([
                "-hide_banner",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=0x101828:s=640x360:r=24:d=4.5",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=4.5",
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

        let srt_path = tmp.join("中文字幕 测试.srt");
        let srt_body = "\u{feff}1\r\n00:00:00,800 --> 00:00:02,000\r\n离线烧录中文字幕\r\nWinKit Offline Test\r\n\r\n2\r\n00:00:02,800 --> 00:00:04,000\r\n第二段定时字幕展示\r\n";
        fs::write(&srt_path, srt_body.as_bytes()).unwrap();

        let style = SubtitleBurnStyle {
            font_size: 42,
            position: SubtitlePosition::Bottom,
            box_style: SubtitleBoxStyle::BlackBox,
            font_name: None,
            margin_v: Some(38),
        };

        // 1. Cue-click preview at 1.4s should include cue #1 and return valid JPEG data URL
        let prev = preview_burned_subtitle_frame_impl(
            &tmp,
            &PreviewSubtitleFrameRequest {
                video_path: src_vid.to_string_lossy().to_string(),
                subtitle_path: srt_path.to_string_lossy().to_string(),
                timestamp_sec: 1.4,
                style: style.clone(),
            },
        )
        .unwrap();
        assert_eq!(prev.active_cue_indices, vec![1]);
        assert!(prev.data_url.starts_with("data:image/jpeg;base64,"));
        assert_eq!((prev.display_width, prev.display_height), (360, 640));

        // 2. Burn in full video
        let out_vid = tmp.join("输出 带字幕.mp4");
        let cancel = AtomicBool::new(false);
        let res = burn_in_subtitles_impl(
            &tmp,
            &BurnInSubtitlesRequest {
                task_id: "t-v02".into(),
                video_path: src_vid.to_string_lossy().to_string(),
                subtitle_path: srt_path.to_string_lossy().to_string(),
                output_path: out_vid.to_string_lossy().to_string(),
                style,
                allow_overwrite: Some(true),
            },
            &cancel,
            |_| {},
        )
        .unwrap();

        assert_eq!((res.output_width, res.output_height), (360, 640));
        assert_eq!(res.output_rotation.unwrap_or(0), 0);
        assert_eq!(res.subtitle_streams_in_output, 0);
        assert_eq!(res.burned_cue_count, 2);
        assert!(res.has_audio);
        assert!(res.audio_copied);

        // Helper: count bright white pixels (R>180,G>180,B>180) in bottom third of upright portrait frame
        let count_bright_bottom = |sec: &str, name: &str| -> usize {
            let p = tmp.join(name);
            let mut cmd_f = Command::new(&tools.ffmpeg);
            configure_hidden_command(&mut cmd_f);
            let s = cmd_f
                .args([
                    "-hide_banner",
                    "-y",
                    "-ss",
                    sec,
                    "-i",
                    out_vid.to_str().unwrap(),
                    "-frames:v",
                    "1",
                    p.to_str().unwrap(),
                ])
                .status()
                .unwrap();
            assert!(s.success());
            let im = image::open(&p).unwrap().to_rgb8();
            assert_eq!(im.dimensions(), (360, 640));
            let mut n = 0usize;
            for y in 420..640 {
                for x in 0..360 {
                    let px = im.get_pixel(x, y).0;
                    if px[0] > 180 && px[1] > 180 && px[2] > 180 {
                        n += 1;
                    }
                }
            }
            n
        };

        let before_c1 = count_bright_bottom("0.30", "f_030.png");
        let during_c1 = count_bright_bottom("1.40", "f_140.png");
        let between_c = count_bright_bottom("2.40", "f_240.png");
        let during_c2 = count_bright_bottom("3.40", "f_340.png");

        assert_eq!(before_c1, 0, "No subtitle expected at 0.30s");
        assert!(
            during_c1 > 400,
            "Expected visible white Chinese+English subtitle glyph pixels at 1.40s, got {during_c1}"
        );
        assert_eq!(between_c, 0, "No subtitle expected between cues at 2.40s");
        assert!(
            during_c2 > 200,
            "Expected visible white subtitle glyph pixels for cue 2 at 3.40s, got {during_c2}"
        );

        let _ = fs::remove_dir_all(&tmp);
    }
}
