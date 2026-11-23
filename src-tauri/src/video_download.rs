//! V01 Video Downloader (`yt-dlp` + direct WinHTTP media engine + local FFmpeg/ffprobe).
//!
//! Features:
//! - Strict HTTP(S) URL validation (rejects non-HTTP(S) schemes and CLI flag injection).
//! - Direct media URLs (`.mp4`, `.m4a`, `.webm`, etc.) work independently even without `yt-dlp`
//!   and preserve bit-exact bytes (matching original SHA-256) on default downloads.
//! - Multi-resolution, separate video/audio streams, H.264 preference, multi-language track
//!   selection, and webpage parsing via local/managed `yt-dlp` + managed FFmpeg/ffprobe.
//! - Windows Job Object process-tree isolation so cancellation immediately terminates both
//!   `yt-dlp.exe` and any child `ffmpeg.exe`, leaving zero `.part`/`.tmp` files or orphan processes.
//! - Automatic redaction of userinfo, tokens, signatures, and sensitive query parameters in all
//!   displayed URLs, logs, and error messages.

use crate::error::AppError;
use crate::fs_guard::validate_user_path;
use crate::media_core::{
    allocate_non_colliding_output_path, configure_hidden_command, get_media_tools_status_impl,
    require_media_tools, run_ffmpeg_cancellable,
};
use crate::media_info::probe_media_info_impl;
use crate::ytdlp_core::{require_ytdlp, resolve_ytdlp_optional, JsRuntimeInfo};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

pub const VIDEO_DOWNLOAD_PROGRESS_EVENT: &str = "winkit://video-download-progress";

const YTDLP_PROBE_TIMEOUT_SECS: u64 = 35;
const MAX_HASH_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoDownloadQuality {
    Best,
    #[serde(rename = "max_1080p")]
    Max1080p,
    #[serde(rename = "max_720p")]
    Max720p,
    AudioM4a,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoDownloadProbeRequest {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoDownloadFormatOption {
    pub format_id: String,
    pub ext: String,
    pub resolution: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
    pub language: Option<String>,
    pub filesize_bytes: Option<u64>,
    pub has_video: bool,
    pub has_audio: bool,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoDownloadAudioTrackOption {
    pub language: String,
    pub label: String,
    pub codec: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoDownloadProbeResult {
    pub sanitized_url: String,
    pub title: String,
    pub extractor: String,
    pub webpage_domain: Option<String>,
    pub duration_sec: Option<f64>,
    pub is_direct_media: bool,
    pub used_ytdlp: bool,
    pub available_resolutions: Vec<u32>,
    pub available_audio_languages: Vec<VideoDownloadAudioTrackOption>,
    pub has_h264: bool,
    pub estimated_best_bytes: Option<u64>,
    pub warnings: Vec<String>,
    pub formats_summary: Vec<VideoDownloadFormatOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartVideoDownloadItemRequest {
    pub task_id: String,
    pub item_id: String,
    pub url: String,
    pub output_dir: String,
    pub suggested_title: Option<String>,
    pub quality: VideoDownloadQuality,
    pub prefer_h264: bool,
    pub preferred_audio_language: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoDownloadProgressPayload {
    pub task_id: String,
    pub item_id: String,
    pub phase: String,
    pub percent: Option<f64>,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub speed_bytes_per_sec: Option<f64>,
    pub eta_sec: Option<f64>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoDownloadItemResult {
    pub item_id: String,
    pub sanitized_url: String,
    pub output_path: String,
    pub file_name: String,
    pub byte_size: u64,
    pub sha256: Option<String>,
    pub title: String,
    pub extractor: String,
    pub used_ytdlp: bool,
    pub duration_sec: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub audio_language: Option<String>,
    pub container_format: Option<String>,
    pub renamed_for_collision: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ParsedHttpUrl {
    pub raw: String,
    pub is_https: bool,
    pub host: String,
    pub port: u16,
    pub path_and_query: String,
    pub path_only: String,
    pub file_extension: Option<String>,
    pub is_loopback: bool,
}

pub fn parse_http_url(raw_input: &str) -> Result<ParsedHttpUrl, AppError> {
    let trimmed = raw_input.trim();
    if trimmed.is_empty() {
        return Err(AppError::invalid_param(
            "Please enter an HTTP or HTTPS URL.",
        ));
    }
    if trimmed.starts_with('-') {
        return Err(AppError::invalid_param(
            "Invalid URL: link must start with http:// or https://.",
        ));
    }
    if trimmed.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(AppError::invalid_param(
            "Invalid URL: links cannot contain whitespace or control characters.",
        ));
    }

    let lower_prefix = trimmed.get(..8).unwrap_or(trimmed).to_ascii_lowercase();
    let (is_https, rest) = if lower_prefix.starts_with("https://") {
        (true, &trimmed[8..])
    } else if lower_prefix.starts_with("http://") {
        (false, &trimmed[7..])
    } else {
        return Err(AppError::invalid_param(
            "Only http:// and https:// URLs are supported.",
        ));
    };

    let no_frag = rest.split('#').next().unwrap_or(rest);
    let (authority_full, path_and_query) = match no_frag.find(['/', '?']) {
        Some(idx) => {
            let tail = &no_frag[idx..];
            if tail.starts_with('?') {
                (&no_frag[..idx], format!("/{tail}"))
            } else {
                (&no_frag[..idx], tail.to_string())
            }
        }
        None => (no_frag, "/".to_string()),
    };

    if authority_full.is_empty() {
        return Err(AppError::invalid_param("URL is missing a hostname."));
    }

    // Strip optional userinfo (`user:pass@`) when parsing host:port
    let host_port = match authority_full.rsplit_once('@') {
        Some((_, after)) => after,
        None => authority_full,
    };

    let default_port = if is_https { 443 } else { 80 };
    let (host, port) = if host_port.starts_with('[') {
        // IPv6 literal: [::1]:8080 or [::1]
        let close = host_port
            .find(']')
            .ok_or_else(|| AppError::invalid_param("Malformed IPv6 host in URL."))?;
        let h = &host_port[1..close];
        let rem = &host_port[close + 1..];
        let p = if let Some(port_s) = rem.strip_prefix(':') {
            port_s
                .parse::<u16>()
                .map_err(|_| AppError::invalid_param("Invalid port number in URL."))?
        } else if rem.is_empty() {
            default_port
        } else {
            return Err(AppError::invalid_param("Malformed host/port in URL."));
        };
        (h.to_string(), p)
    } else if let Some((h, port_s)) = host_port.rsplit_once(':') {
        let p = port_s
            .parse::<u16>()
            .map_err(|_| AppError::invalid_param("Invalid port number in URL."))?;
        (h.to_string(), p)
    } else {
        (host_port.to_string(), default_port)
    };

    if host.is_empty() {
        return Err(AppError::invalid_param("URL hostname cannot be empty."));
    }

    let path_only = path_and_query.split('?').next().unwrap_or("/").to_string();
    let file_extension = extract_url_path_extension(&path_only);
    let host_lower = host.to_ascii_lowercase();
    let is_loopback = host_lower == "localhost"
        || host_lower == "127.0.0.1"
        || host_lower == "::1"
        || host_lower.starts_with("127.");

    Ok(ParsedHttpUrl {
        raw: trimmed.to_string(),
        is_https,
        host,
        port,
        path_and_query,
        path_only,
        file_extension,
        is_loopback,
    })
}

fn extract_url_path_extension(path_only: &str) -> Option<String> {
    let last_seg = path_only.rsplit('/').next()?;
    let decoded = percent_decode_lossy(last_seg);
    let dot = decoded.rfind('.')?;
    let ext = &decoded[dot + 1..];
    if ext.is_empty() || ext.len() > 8 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(ext.to_ascii_lowercase())
}

fn is_manifest_extension(ext: Option<&str>) -> bool {
    matches!(ext, Some("m3u8" | "m3u" | "mpd" | "ism" | "f4m"))
}

fn is_direct_media_extension(ext: Option<&str>) -> bool {
    matches!(
        ext,
        Some(
            "mp4"
                | "m4v"
                | "mov"
                | "webm"
                | "mkv"
                | "avi"
                | "ts"
                | "m4a"
                | "mp3"
                | "wav"
                | "flac"
                | "ogg"
                | "opus"
                | "aac"
        )
    )
}

fn is_sensitive_query_key(key: &str) -> bool {
    let lower = key.trim().to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "token"
            | "access_token"
            | "refresh_token"
            | "id_token"
            | "auth"
            | "authorization"
            | "sig"
            | "signature"
            | "key"
            | "api_key"
            | "apikey"
            | "secret"
            | "password"
            | "passwd"
            | "pwd"
            | "session"
            | "sess"
            | "sid"
            | "cookie"
            | "credential"
            | "credentials"
            | "jwt"
            | "bearer"
            | "policy"
            | "key-pair-id"
            | "hdnts"
            | "hdnea"
            | "hmac"
            | "hash"
            | "ticket"
            | "code"
            | "pass"
            | "expires"
            | "e"
            | "st"
            | "h"
            | "sp"
            | "sr"
            | "se"
            | "sv"
            | "x-amz-signature"
            | "x-amz-credential"
            | "x-amz-security-token"
            | "x-goog-signature"
            | "x-goog-credential"
            | "x-ms-sig"
    ) {
        return true;
    }
    const SENSITIVE_SUBSTRINGS: [&str; 10] = [
        "token",
        "secret",
        "pass",
        "auth",
        "sig",
        "key",
        "cookie",
        "session",
        "credential",
        "bearer",
    ];
    SENSITIVE_SUBSTRINGS.iter().any(|s| lower.contains(s))
}

/// Redacts userinfo (`user:pass@`) and sensitive query parameters (`token`, `sig`, `auth`, `key`,
/// `session`, signed cloud URL params, etc.) from a single HTTP(S) URL.
pub fn redact_url_for_logs(raw: &str) -> String {
    let trimmed = raw.trim();
    let lower = trimmed.to_ascii_lowercase();
    let prefix_len = if lower.starts_with("https://") {
        8
    } else if lower.starts_with("http://") {
        7
    } else {
        return trimmed.to_string();
    };

    let scheme = &trimmed[..prefix_len];
    let rest = &trimmed[prefix_len..];
    let (without_frag, frag) = match rest.split_once('#') {
        Some((a, b)) => (a, Some(b)),
        None => (rest, None),
    };

    let (authority_raw, path_and_query) = match without_frag.find(['/', '?']) {
        Some(idx) => (&without_frag[..idx], &without_frag[idx..]),
        None => (without_frag, ""),
    };

    let safe_authority = match authority_raw.rsplit_once('@') {
        Some((_, host_port)) => format!("***@{host_port}"),
        None => authority_raw.to_string(),
    };

    let safe_path_and_query = match path_and_query.split_once('?') {
        Some((path_part, query_part)) => {
            let redacted_pairs: Vec<String> = query_part
                .split('&')
                .map(|pair| {
                    if let Some((k, v)) = pair.split_once('=') {
                        if is_sensitive_query_key(k) {
                            format!("{k}=[REDACTED]")
                        } else if v.len() >= 48 && v.chars().all(|c| !c.is_whitespace()) {
                            // Redact very long opaque values that may carry undocumented signed blobs
                            format!("{k}=[REDACTED]")
                        } else {
                            pair.to_string()
                        }
                    } else if is_sensitive_query_key(pair) {
                        format!("{pair}=[REDACTED]")
                    } else {
                        pair.to_string()
                    }
                })
                .collect();
            format!("{path_part}?{}", redacted_pairs.join("&"))
        }
        None => path_and_query.to_string(),
    };

    let mut out = format!("{scheme}{safe_authority}{safe_path_and_query}");
    if frag.is_some() {
        out.push_str("#[REDACTED]");
    }
    out
}

/// Scans arbitrary log or error text and redacts all embedded HTTP(S) URLs and bearer headers.
pub fn redact_sensitive_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        let rem = &text[i..];
        let rem_lower_prefix = rem.get(..8).unwrap_or(rem).to_ascii_lowercase();
        if rem_lower_prefix.starts_with("https://") || rem_lower_prefix.starts_with("http://") {
            let mut end = i;
            for (offset, ch) in rem.char_indices() {
                if ch.is_whitespace() || matches!(ch, '"' | '\'' | '<' | '>' | ')' | ']' | '}') {
                    break;
                }
                end = i + offset + ch.len_utf8();
            }
            let url_slice = &text[i..end];
            // Preserve trailing punctuation like `.` or `,`
            let trimmed_url = url_slice.trim_end_matches(['.', ',', ';']);
            let trailing = &url_slice[trimmed_url.len()..];
            out.push_str(&redact_url_for_logs(trimmed_url));
            out.push_str(trailing);
            i = end;
        } else if rem_lower_prefix.starts_with("bearer ") {
            out.push_str("Bearer [REDACTED]");
            i += 7;
            while i < bytes.len() && !text[i..].starts_with(char::is_whitespace) {
                if let Some(ch) = text[i..].chars().next() {
                    i += ch.len_utf8();
                } else {
                    break;
                }
            }
        } else if let Some(ch) = rem.chars().next() {
            out.push(ch);
            i += ch.len_utf8();
        } else {
            break;
        }
    }
    out
}

fn percent_decode_lossy(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex_str) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(val) = u8::from_str_radix(hex_str, 16) {
                    out.push(val);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn derive_title_from_url(parsed: &ParsedHttpUrl, content_disposition: Option<&str>) -> String {
    if let Some(cd) = content_disposition {
        if let Some(fname) = extract_filename_from_content_disposition(cd) {
            let p = Path::new(&fname);
            if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                let clean = stem.trim();
                if !clean.is_empty() {
                    return clean.to_string();
                }
            }
        }
    }

    if let Some(last_seg) = parsed.path_only.rsplit('/').find(|s| !s.is_empty()) {
        let decoded = percent_decode_lossy(last_seg);
        let p = Path::new(&decoded);
        if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
            let clean = stem.trim();
            if !clean.is_empty() {
                return clean.to_string();
            }
        }
    }
    format!("video_{}", parsed.host.replace('.', "_"))
}

fn extract_filename_from_content_disposition(cd: &str) -> Option<String> {
    for part in cd.split(';') {
        let trimmed = part.trim();
        let lower = trimmed.to_ascii_lowercase();
        if let Some(val) = lower.strip_prefix("filename*=") {
            let raw_val = &trimmed[trimmed.len() - val.len()..];
            let cleaned = raw_val
                .trim_matches('"')
                .split("''")
                .nth(1)
                .unwrap_or(raw_val);
            let decoded = percent_decode_lossy(cleaned);
            if !decoded.trim().is_empty() {
                return Some(decoded.trim().to_string());
            }
        } else if let Some(val) = lower.strip_prefix("filename=") {
            let raw_val = &trimmed[trimmed.len() - val.len()..];
            let cleaned = raw_val.trim().trim_matches('"');
            if !cleaned.is_empty() {
                return Some(cleaned.to_string());
            }
        }
    }
    None
}

fn extension_from_content_type(ct: &str) -> Option<&'static str> {
    let main = ct
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match main.as_str() {
        "video/mp4" => Some("mp4"),
        "video/webm" => Some("webm"),
        "video/quicktime" => Some("mov"),
        "video/x-matroska" => Some("mkv"),
        "video/x-msvideo" => Some("avi"),
        "video/mp2t" => Some("ts"),
        "audio/mp4" | "audio/x-m4a" | "audio/aac" => Some("m4a"),
        "audio/mpeg" => Some("mp3"),
        "audio/wav" | "audio/x-wav" => Some("wav"),
        "audio/flac" => Some("flac"),
        "audio/ogg" => Some("ogg"),
        "audio/opus" => Some("opus"),
        _ => None,
    }
}

fn is_manifest_content_type(ct: &str) -> bool {
    let lower = ct.to_ascii_lowercase();
    lower.contains("mpegurl") || lower.contains("dash+xml") || lower.contains("f4m+xml")
}

fn is_html_content_type(ct: &str) -> bool {
    let lower = ct.to_ascii_lowercase();
    lower.contains("text/html") || lower.contains("application/xhtml")
}

fn is_direct_media_content_type(ct: &str) -> bool {
    let lower = ct.trim().to_ascii_lowercase();
    (lower.starts_with("video/") || lower.starts_with("audio/"))
        && !is_manifest_content_type(&lower)
}

pub fn normalize_language_code(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("none")
        || trimmed.eq_ignore_ascii_case("na")
        || trimmed.eq_ignore_ascii_case("null")
        || trimmed.eq_ignore_ascii_case("und")
        || trimmed.eq_ignore_ascii_case("unknown")
    {
        return None;
    }
    // Keep clean BCP-47 / ISO-639 tags (letters, digits, `-`, `_`)
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    Some(trimmed.replace('_', "-"))
}

pub fn format_language_label(code: &str) -> String {
    let primary = code.split('-').next().unwrap_or(code).to_ascii_lowercase();
    let name = match primary.as_str() {
        "zh" | "zho" | "chi" => "中文 / Chinese",
        "en" | "eng" => "English",
        "ja" | "jpn" => "日本語 / Japanese",
        "ko" | "kor" => "한국어 / Korean",
        "fr" | "fra" | "fre" => "Français / French",
        "de" | "deu" | "ger" => "Deutsch / German",
        "es" | "spa" => "Español / Spanish",
        "ru" | "rus" => "Русский / Russian",
        "pt" | "por" => "Português / Portuguese",
        "it" | "ita" => "Italiano / Italian",
        "ar" | "ara" => "العربية / Arabic",
        _ => return code.to_string(),
    };
    format!("{name} ({code})")
}

/// Builds a deterministic `yt-dlp -f` format selector for quality cap, H.264 preference, and
/// preferred audio language, with safe fallbacks so downloads never fail unnecessarily if a
/// preferred codec or language is absent.
pub fn build_ytdlp_format_selector(
    quality: VideoDownloadQuality,
    prefer_h264: bool,
    preferred_audio_language: Option<&str>,
) -> String {
    let lang = preferred_audio_language.and_then(normalize_language_code);
    // Use base ISO prefix (e.g. "zh" from "zh-CN") so yt-dlp `[language^=...]` matches zh/zh-CN/zho cleanly.
    let lang_prefix = lang
        .as_deref()
        .map(|l| l.split('-').next().unwrap_or(l).to_ascii_lowercase());

    if quality == VideoDownloadQuality::AudioM4a {
        return match lang_prefix {
            Some(lp) => format!(
                "bestaudio[language^={lp}][ext=m4a]/bestaudio[language^={lp}]/bestaudio[ext=m4a]/bestaudio/best"
            ),
            None => "bestaudio[ext=m4a]/bestaudio/best".to_string(),
        };
    }

    let h = match quality {
        VideoDownloadQuality::Best => "",
        VideoDownloadQuality::Max1080p => "[height<=1080]",
        VideoDownloadQuality::Max720p => "[height<=720]",
        VideoDownloadQuality::AudioM4a => unreachable!(),
    };

    let mut parts: Vec<String> = Vec::new();
    match (prefer_h264, lang_prefix) {
        (true, Some(lp)) => {
            parts.push(format!(
                "bestvideo{h}[vcodec^=avc]+bestaudio[language^={lp}]"
            ));
            parts.push(format!(
                "bestvideo{h}[vcodec*=264]+bestaudio[language^={lp}]"
            ));
            parts.push(format!("bestvideo{h}+bestaudio[language^={lp}]"));
            parts.push(format!("bestvideo{h}[vcodec^=avc]+bestaudio[ext=m4a]"));
            parts.push(format!("bestvideo{h}[vcodec^=avc]+bestaudio"));
            parts.push(format!("bestvideo{h}+bestaudio"));
            parts.push(format!("best{h}[vcodec^=avc][language^={lp}]"));
            parts.push(format!("best{h}[vcodec^=avc]"));
            parts.push(format!("best{h}"));
        }
        (true, None) => {
            parts.push(format!("bestvideo{h}[vcodec^=avc]+bestaudio[ext=m4a]"));
            parts.push(format!("bestvideo{h}[vcodec^=avc]+bestaudio"));
            parts.push(format!("bestvideo{h}[vcodec*=264]+bestaudio"));
            parts.push(format!("bestvideo{h}+bestaudio"));
            parts.push(format!("best{h}[vcodec^=avc]"));
            parts.push(format!("best{h}"));
        }
        (false, Some(lp)) => {
            parts.push(format!("bestvideo{h}+bestaudio[language^={lp}]"));
            parts.push(format!("bestvideo{h}+bestaudio"));
            parts.push(format!("best{h}[language^={lp}]"));
            parts.push(format!("best{h}"));
        }
        (false, None) => {
            parts.push(format!("bestvideo{h}+bestaudio"));
            parts.push(format!("best{h}"));
        }
    }

    parts.join("/")
}

/// Classifies `yt-dlp` stderr output into accurate, redacted `AppError` codes & messages.
pub fn classify_ytdlp_error(raw_stderr: &str) -> AppError {
    let redacted = redact_sensitive_text(raw_stderr);
    let lower = redacted.to_ascii_lowercase();
    let last_err_line = redacted
        .lines()
        .rev()
        .find(|l| {
            let t = l.trim();
            !t.is_empty() && (t.starts_with("ERROR:") || !t.starts_with("WARNING:"))
        })
        .unwrap_or("yt-dlp failed to process this URL.")
        .trim()
        .to_string();

    if lower.contains("drm")
        || lower.contains("widevine")
        || lower.contains("playready")
        || lower.contains("fairplay")
        || lower.contains("this video is drm protected")
        || lower.contains("protected by drm")
    {
        return AppError::new(
            "DRM_PROTECTED",
            format!("This content is DRM-protected and cannot be downloaded: {last_err_line}"),
        );
    }

    if lower.contains("confirm your age")
        || lower.contains("age-restricted")
        || lower.contains("age gate")
    {
        return AppError::new(
            "AGE_RESTRICTED",
            format!(
                "This video is age-restricted and requires account verification: {last_err_line}"
            ),
        );
    }

    if lower.contains("sign in to confirm")
        || lower.contains("login required")
        || lower.contains("authentication required")
        || lower.contains("http error 401")
        || lower.contains("use --cookies")
        || lower.contains("members-only")
        || lower.contains("private video")
        || lower.contains("this video is private")
        || lower.contains("subscribers only")
    {
        return AppError::new(
            "LOGIN_REQUIRED",
            format!("This page requires login, cookies, or account permission: {last_err_line}"),
        );
    }

    if lower.contains("not available in your country")
        || lower.contains("not made this video available in your country")
        || lower.contains("geo-restricted")
        || lower.contains("geo restriction")
        || lower.contains("blocked it in your country")
        || lower.contains("http error 451")
    {
        return AppError::new(
            "GEO_BLOCKED",
            format!("This video is restricted in the current region: {last_err_line}"),
        );
    }

    if lower.contains("http error 403")
        || lower.contains("403: forbidden")
        || lower.contains("access denied")
    {
        return AppError::new(
            "ACCESS_FORBIDDEN",
            format!("Access was denied by the remote server (HTTP 403): {last_err_line}"),
        );
    }

    if lower.contains("http error 404")
        || lower.contains("video unavailable")
        || lower.contains("has been removed")
        || lower.contains("does not exist")
    {
        return AppError::new(
            "NOT_FOUND",
            format!("The requested video or media URL was not found (HTTP 404 / unavailable): {last_err_line}"),
        );
    }

    if lower.contains("no supported javascript runtime")
        || lower.contains("javascript runtime")
        || lower.contains("n challenge solving failed")
        || lower.contains("ejs")
    {
        return AppError::new(
            "JS_RUNTIME_REQUIRED",
            format!("This site requires an external JavaScript runtime (Deno or Node.js) for yt-dlp challenge solving: {last_err_line}"),
        );
    }

    if lower.contains("unsupported url") || lower.contains("no video formats found") {
        return AppError::new(
            "UNSUPPORTED_URL",
            format!("This link is not a supported video page or media stream: {last_err_line}"),
        );
    }

    if lower.contains("unable to download webpage")
        || lower.contains("connection reset")
        || lower.contains("connection refused")
        || lower.contains("timed out")
        || lower.contains("getaddrinfo")
        || lower.contains("name or service not known")
        || lower.contains("remotedisconnected")
        || lower.contains("incomplete read")
        || lower.contains("did not get any data blocks")
        || lower.contains("giving up after")
        || lower.contains("fragment")
        || lower.contains("eof occurred")
        || lower.contains("http error 5")
    {
        return AppError::new(
            "NETWORK_ERROR",
            format!("Network or server transfer error (you can retry): {last_err_line}"),
        );
    }

    AppError::new("DOWNLOAD_FAILED", last_err_line)
}

fn classify_http_status(status: u32, sanitized_url: &str) -> AppError {
    match status {
        401 => AppError::new(
            "LOGIN_REQUIRED",
            format!("Server requires authentication (HTTP 401) for {sanitized_url}."),
        ),
        403 => AppError::new(
            "ACCESS_FORBIDDEN",
            format!("Access forbidden by remote server (HTTP 403) for {sanitized_url}."),
        ),
        404 | 410 => AppError::new(
            "NOT_FOUND",
            format!("Remote media file not found (HTTP {status}) for {sanitized_url}."),
        ),
        451 => AppError::new(
            "GEO_BLOCKED",
            format!("Content unavailable due to regional or legal restrictions (HTTP 451) for {sanitized_url}."),
        ),
        429 | 500..=599 => AppError::new(
            "NETWORK_ERROR",
            format!("Remote server temporarily returned HTTP {status} for {sanitized_url}."),
        ),
        _ => AppError::new(
            "DOWNLOAD_FAILED",
            format!("Server returned HTTP {status} for {sanitized_url}."),
        ),
    }
}

/// RAII temporary staging directory inside `output_dir`. Guarantees zero `.part`/`.tmp` files
/// remain in the destination folder if a download is cancelled or fails.
struct StagingDirGuard {
    path: PathBuf,
}

impl StagingDirGuard {
    fn create_in(output_dir: &Path) -> Result<Self, AppError> {
        if !output_dir.is_dir() {
            fs::create_dir_all(output_dir)
                .map_err(|e| AppError::from_io(e, "Unable to create output directory"))?;
        }
        let path = output_dir.join(format!(".winkit-dl-{}", Uuid::new_v4()));
        fs::create_dir_all(&path)
            .map_err(|e| AppError::from_io(e, "Unable to create download staging directory"))?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for StagingDirGuard {
    fn drop(&mut self) {
        for _ in 0..8 {
            if !self.path.exists() {
                break;
            }
            if fs::remove_dir_all(&self.path).is_ok() {
                break;
            }
            thread::sleep(Duration::from_millis(40));
        }
    }
}

#[cfg(windows)]
struct ProcessTreeJob {
    handle: windows::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl ProcessTreeJob {
    fn attach(child: &Child) -> Option<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::{CloseHandle, HANDLE};
        use windows::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        unsafe {
            let job = CreateJobObjectW(None, None).ok()?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .is_err()
            {
                let _ = CloseHandle(job);
                return None;
            }
            let proc_handle = HANDLE(child.as_raw_handle());
            if AssignProcessToJobObject(job, proc_handle).is_err() {
                let _ = CloseHandle(job);
                return None;
            }
            Some(Self { handle: job })
        }
    }

    fn terminate(&self) {
        use windows::Win32::System::JobObjects::TerminateJobObject;
        unsafe {
            let _ = TerminateJobObject(self.handle, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessTreeJob {
    fn drop(&mut self) {
        use windows::Win32::Foundation::CloseHandle;
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

#[cfg(not(windows))]
struct ProcessTreeJob;

#[cfg(not(windows))]
impl ProcessTreeJob {
    fn attach(_child: &Child) -> Option<Self> {
        None
    }
    fn terminate(&self) {}
}

#[derive(Debug, Clone)]
struct HttpHeadMetadata {
    status_code: u32,
    content_type: Option<String>,
    content_length: Option<u64>,
    content_disposition: Option<String>,
}

#[cfg(windows)]
fn winhttp_query_header_string(request: *mut core::ffi::c_void, info_level: u32) -> Option<String> {
    use windows::core::PCWSTR;
    use windows::Win32::Networking::WinHttp::WinHttpQueryHeaders;

    let mut len_bytes: u32 = 0;
    unsafe {
        let _ = WinHttpQueryHeaders(
            request,
            info_level,
            PCWSTR::null(),
            None,
            &mut len_bytes,
            std::ptr::null_mut(),
        );
    }
    if len_bytes == 0 || len_bytes > 64 * 1024 {
        return None;
    }
    let mut wide = vec![0u16; (len_bytes as usize).div_ceil(2) + 1];
    let mut actual = len_bytes;
    let ok = unsafe {
        WinHttpQueryHeaders(
            request,
            info_level,
            PCWSTR::null(),
            Some(wide.as_mut_ptr() as *mut core::ffi::c_void),
            &mut actual,
            std::ptr::null_mut(),
        )
        .is_ok()
    };
    if !ok {
        return None;
    }
    let chars = (actual as usize) / 2;
    let slice = &wide[..chars.min(wide.len())];
    let s = String::from_utf16_lossy(slice)
        .trim_end_matches('\0')
        .trim()
        .to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

#[cfg(windows)]
fn winhttp_head_media(
    parsed: &ParsedHttpUrl,
    cancel_flag: &AtomicBool,
) -> Result<HttpHeadMetadata, AppError> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Networking::WinHttp::{
        WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryHeaders,
        WinHttpReceiveResponse, WinHttpSendRequest, WinHttpSetOption, WinHttpSetTimeouts,
        WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_FLAG_SECURE,
        WINHTTP_OPTION_REDIRECT_POLICY, WINHTTP_OPTION_REDIRECT_POLICY_DISALLOW_HTTPS_TO_HTTP,
        WINHTTP_QUERY_CONTENT_LENGTH, WINHTTP_QUERY_CONTENT_TYPE, WINHTTP_QUERY_CUSTOM,
        WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE,
    };

    struct WinHttpHandle(*mut core::ffi::c_void);
    impl Drop for WinHttpHandle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    let _ = WinHttpCloseHandle(self.0);
                }
            }
        }
    }

    fn to_wide(s: &str) -> Vec<u16> {
        OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let sanitized = redact_url_for_logs(&parsed.raw);
    let ua = to_wide(concat!("WinKit/", env!("CARGO_PKG_VERSION")));
    let access_type = if parsed.is_loopback {
        WINHTTP_ACCESS_TYPE_NO_PROXY
    } else {
        WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY
    };

    let session = unsafe {
        WinHttpOpen(
            PCWSTR(ua.as_ptr()),
            access_type,
            PCWSTR::null(),
            PCWSTR::null(),
            0,
        )
    };
    if session.is_null() {
        return Err(AppError::new(
            "NETWORK_ERROR",
            "Unable to initialize Windows HTTP client.",
        ));
    }
    let _session_guard = WinHttpHandle(session);
    unsafe {
        let _ = WinHttpSetTimeouts(session, 10_000, 10_000, 15_000, 15_000);
    }

    let host_w = to_wide(&parsed.host);
    let connect = unsafe { WinHttpConnect(session, PCWSTR(host_w.as_ptr()), parsed.port, 0) };
    if connect.is_null() {
        return Err(AppError::new(
            "NETWORK_ERROR",
            format!("Unable to connect to {}:{}", parsed.host, parsed.port),
        ));
    }
    let _connect_guard = WinHttpHandle(connect);

    let path_w = to_wide(&parsed.path_and_query);
    let flags = if parsed.is_https {
        WINHTTP_FLAG_SECURE
    } else {
        windows::Win32::Networking::WinHttp::WINHTTP_OPEN_REQUEST_FLAGS(0)
    };

    let try_method = |method: &str,
                      range_header: Option<&str>|
     -> Result<HttpHeadMetadata, AppError> {
        let method_w = to_wide(method);
        let request = unsafe {
            WinHttpOpenRequest(
                connect,
                PCWSTR(method_w.as_ptr()),
                PCWSTR(path_w.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                std::ptr::null(),
                flags,
            )
        };
        if request.is_null() {
            return Err(AppError::new(
                "NETWORK_ERROR",
                "Unable to open HTTP probe request.",
            ));
        }
        let _req_guard = WinHttpHandle(request);

        if parsed.is_https {
            let policy: u32 = WINHTTP_OPTION_REDIRECT_POLICY_DISALLOW_HTTPS_TO_HTTP;
            let bytes = policy.to_ne_bytes();
            unsafe {
                let _ =
                    WinHttpSetOption(Some(request), WINHTTP_OPTION_REDIRECT_POLICY, Some(&bytes));
            }
        }

        let headers_w = range_header.map(to_wide);
        unsafe {
            let hdr_slice = headers_w.as_ref().map(|w| &w[..w.len().saturating_sub(1)]);
            WinHttpSendRequest(request, hdr_slice, None, 0, 0, 0).map_err(|e| {
                AppError::new(
                    "NETWORK_ERROR",
                    redact_sensitive_text(&format!("Failed to reach {sanitized}: {e}")),
                )
            })?;
            WinHttpReceiveResponse(request, std::ptr::null_mut()).map_err(|e| {
                AppError::new(
                    "NETWORK_ERROR",
                    redact_sensitive_text(&format!("No response from {sanitized}: {e}")),
                )
            })?;
        }

        let mut status_code: u32 = 0;
        let mut status_len = std::mem::size_of::<u32>() as u32;
        unsafe {
            WinHttpQueryHeaders(
                request,
                WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                PCWSTR::null(),
                Some(&mut status_code as *mut u32 as *mut core::ffi::c_void),
                &mut status_len,
                std::ptr::null_mut(),
            )
            .map_err(|e| {
                AppError::new(
                    "NETWORK_ERROR",
                    format!("Unable to read HTTP status code: {e}"),
                )
            })?;
        }

        let content_type = winhttp_query_header_string(request, WINHTTP_QUERY_CONTENT_TYPE);
        let content_length = winhttp_query_header_string(request, WINHTTP_QUERY_CONTENT_LENGTH)
            .and_then(|s| s.parse::<u64>().ok());

        // Custom header lookup for Content-Disposition
        let cd_name_w = to_wide("Content-Disposition");
        let mut cd_len: u32 = 0;
        unsafe {
            let _ = WinHttpQueryHeaders(
                request,
                WINHTTP_QUERY_CUSTOM,
                PCWSTR(cd_name_w.as_ptr()),
                None,
                &mut cd_len,
                std::ptr::null_mut(),
            );
        }
        let content_disposition = if cd_len > 0 && cd_len < 16 * 1024 {
            let mut wide = vec![0u16; (cd_len as usize).div_ceil(2) + 1];
            let mut actual = cd_len;
            let ok = unsafe {
                WinHttpQueryHeaders(
                    request,
                    WINHTTP_QUERY_CUSTOM,
                    PCWSTR(cd_name_w.as_ptr()),
                    Some(wide.as_mut_ptr() as *mut core::ffi::c_void),
                    &mut actual,
                    std::ptr::null_mut(),
                )
                .is_ok()
            };
            if ok {
                let s = String::from_utf16_lossy(&wide[..(actual as usize) / 2])
                    .trim_end_matches('\0')
                    .trim()
                    .to_string();
                if s.is_empty() {
                    None
                } else {
                    Some(s)
                }
            } else {
                None
            }
        } else {
            None
        };

        Ok(HttpHeadMetadata {
            status_code,
            content_type,
            content_length,
            content_disposition,
        })
    };

    let head = try_method("HEAD", None)?;
    if head.status_code == 405 || head.status_code == 501 {
        return try_method("GET", Some("Range: bytes=0-0\r\n"));
    }
    Ok(head)
}

#[cfg(not(windows))]
fn winhttp_head_media(
    _parsed: &ParsedHttpUrl,
    _cancel_flag: &AtomicBool,
) -> Result<HttpHeadMetadata, AppError> {
    Err(AppError::new(
        "NETWORK_ERROR",
        "Direct HTTP probe is implemented for Windows.",
    ))
}

#[cfg(windows)]
fn winhttp_download_direct_with_sha256(
    parsed: &ParsedHttpUrl,
    dest_path: &Path,
    cancel_flag: &AtomicBool,
    mut on_chunk: impl FnMut(u64, Option<u64>, Option<f64>),
) -> Result<(u64, String, Option<String>, Option<String>), AppError> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Networking::WinHttp::{
        WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest,
        WinHttpQueryDataAvailable, WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse,
        WinHttpSendRequest, WinHttpSetOption, WinHttpSetTimeouts,
        WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_FLAG_SECURE,
        WINHTTP_OPTION_REDIRECT_POLICY, WINHTTP_OPTION_REDIRECT_POLICY_DISALLOW_HTTPS_TO_HTTP,
        WINHTTP_QUERY_CONTENT_LENGTH, WINHTTP_QUERY_CONTENT_TYPE, WINHTTP_QUERY_CUSTOM,
        WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE,
    };

    struct WinHttpHandle(*mut core::ffi::c_void);
    impl Drop for WinHttpHandle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    let _ = WinHttpCloseHandle(self.0);
                }
            }
        }
    }

    fn to_wide(s: &str) -> Vec<u16> {
        OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let sanitized = redact_url_for_logs(&parsed.raw);
    let ua = to_wide(concat!("WinKit/", env!("CARGO_PKG_VERSION")));
    let access_type = if parsed.is_loopback {
        WINHTTP_ACCESS_TYPE_NO_PROXY
    } else {
        WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY
    };

    let session = unsafe {
        WinHttpOpen(
            PCWSTR(ua.as_ptr()),
            access_type,
            PCWSTR::null(),
            PCWSTR::null(),
            0,
        )
    };
    if session.is_null() {
        return Err(AppError::new(
            "NETWORK_ERROR",
            "Unable to initialize Windows HTTP client.",
        ));
    }
    let _session_guard = WinHttpHandle(session);
    unsafe {
        let _ = WinHttpSetTimeouts(session, 15_000, 15_000, 30_000, 60_000);
    }

    let host_w = to_wide(&parsed.host);
    let path_w = to_wide(&parsed.path_and_query);
    let method_w = to_wide("GET");

    let connect = unsafe { WinHttpConnect(session, PCWSTR(host_w.as_ptr()), parsed.port, 0) };
    if connect.is_null() {
        return Err(AppError::new(
            "NETWORK_ERROR",
            format!("Unable to connect to {}:{}", parsed.host, parsed.port),
        ));
    }
    let _connect_guard = WinHttpHandle(connect);

    let flags = if parsed.is_https {
        WINHTTP_FLAG_SECURE
    } else {
        windows::Win32::Networking::WinHttp::WINHTTP_OPEN_REQUEST_FLAGS(0)
    };
    let request = unsafe {
        WinHttpOpenRequest(
            connect,
            PCWSTR(method_w.as_ptr()),
            PCWSTR(path_w.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            std::ptr::null(),
            flags,
        )
    };
    if request.is_null() {
        return Err(AppError::new(
            "NETWORK_ERROR",
            "Unable to open HTTP download request.",
        ));
    }
    let _request_guard = WinHttpHandle(request);

    if parsed.is_https {
        let policy: u32 = WINHTTP_OPTION_REDIRECT_POLICY_DISALLOW_HTTPS_TO_HTTP;
        let bytes = policy.to_ne_bytes();
        unsafe {
            let _ = WinHttpSetOption(Some(request), WINHTTP_OPTION_REDIRECT_POLICY, Some(&bytes));
        }
    }

    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    unsafe {
        WinHttpSendRequest(request, None, None, 0, 0, 0).map_err(|e| {
            AppError::new(
                "NETWORK_ERROR",
                redact_sensitive_text(&format!("Network request failed for {sanitized}: {e}")),
            )
        })?;
        WinHttpReceiveResponse(request, std::ptr::null_mut()).map_err(|e| {
            AppError::new(
                "NETWORK_ERROR",
                redact_sensitive_text(&format!(
                    "Failed waiting for response from {sanitized}: {e}"
                )),
            )
        })?;
    }

    let mut status_code: u32 = 0;
    let mut status_len = std::mem::size_of::<u32>() as u32;
    unsafe {
        WinHttpQueryHeaders(
            request,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            PCWSTR::null(),
            Some(&mut status_code as *mut u32 as *mut core::ffi::c_void),
            &mut status_len,
            std::ptr::null_mut(),
        )
        .map_err(|e| {
            AppError::new(
                "NETWORK_ERROR",
                format!("Unable to inspect HTTP response status: {e}"),
            )
        })?;
    }
    if status_code != 200 && status_code != 206 {
        return Err(classify_http_status(status_code, &sanitized));
    }

    let content_type = winhttp_query_header_string(request, WINHTTP_QUERY_CONTENT_TYPE);
    let content_length = winhttp_query_header_string(request, WINHTTP_QUERY_CONTENT_LENGTH)
        .and_then(|s| s.parse::<u64>().ok());

    let cd_name_w = to_wide("Content-Disposition");
    let mut cd_len: u32 = 0;
    unsafe {
        let _ = WinHttpQueryHeaders(
            request,
            WINHTTP_QUERY_CUSTOM,
            PCWSTR(cd_name_w.as_ptr()),
            None,
            &mut cd_len,
            std::ptr::null_mut(),
        );
    }
    let content_disposition = if cd_len > 0 && cd_len < 16 * 1024 {
        let mut wide = vec![0u16; (cd_len as usize).div_ceil(2) + 1];
        let mut actual = cd_len;
        let ok = unsafe {
            WinHttpQueryHeaders(
                request,
                WINHTTP_QUERY_CUSTOM,
                PCWSTR(cd_name_w.as_ptr()),
                Some(wide.as_mut_ptr() as *mut core::ffi::c_void),
                &mut actual,
                std::ptr::null_mut(),
            )
            .is_ok()
        };
        if ok {
            let s = String::from_utf16_lossy(&wide[..(actual as usize) / 2])
                .trim_end_matches('\0')
                .trim()
                .to_string();
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        } else {
            None
        }
    } else {
        None
    };

    let mut out_file = File::create(dest_path)
        .map_err(|e| AppError::from_io(e, "Unable to create temporary media download file"))?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let started_at = Instant::now();
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut buf = vec![0u8; 64 * 1024];

    loop {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(AppError::cancelled());
        }
        let mut avail: u32 = 0;
        unsafe {
            WinHttpQueryDataAvailable(request, &mut avail).map_err(|e| {
                AppError::new(
                    "NETWORK_ERROR",
                    format!("Connection interrupted during download: {e}"),
                )
            })?;
        }
        if avail == 0 {
            break;
        }
        let to_read = (avail as usize).min(buf.len()) as u32;
        let mut read_bytes: u32 = 0;
        unsafe {
            WinHttpReadData(
                request,
                buf.as_mut_ptr() as *mut core::ffi::c_void,
                to_read,
                &mut read_bytes,
            )
            .map_err(|e| {
                AppError::new(
                    "NETWORK_ERROR",
                    format!("Failed reading media download stream: {e}"),
                )
            })?;
        }
        if read_bytes == 0 {
            break;
        }
        let slice = &buf[..read_bytes as usize];
        out_file
            .write_all(slice)
            .map_err(|e| AppError::from_io(e, "Failed writing downloaded media stream"))?;
        hasher.update(slice);
        downloaded = downloaded.saturating_add(u64::from(read_bytes));
        if last_emit.elapsed() >= Duration::from_millis(120) {
            last_emit = Instant::now();
            let elapsed = started_at.elapsed().as_secs_f64().max(0.05);
            let speed = downloaded as f64 / elapsed;
            on_chunk(downloaded, content_length, Some(speed));
        }
    }

    out_file
        .flush()
        .map_err(|e| AppError::from_io(e, "Failed flushing downloaded media file"))?;

    if downloaded == 0 {
        return Err(AppError::new(
            "NETWORK_ERROR",
            "Remote server returned an empty response body.",
        ));
    }

    if let Some(expected) = content_length {
        if expected > 0 && downloaded < expected {
            return Err(AppError::new(
                "NETWORK_ERROR",
                format!(
                    "Download interrupted before completion ({downloaded} / {expected} bytes received). Please retry."
                ),
            ));
        }
    }

    let elapsed = started_at.elapsed().as_secs_f64().max(0.05);
    on_chunk(
        downloaded,
        content_length.or(Some(downloaded)),
        Some(downloaded as f64 / elapsed),
    );

    let digest = format!("{:x}", hasher.finalize());
    Ok((downloaded, digest, content_type, content_disposition))
}

#[cfg(not(windows))]
fn winhttp_download_direct_with_sha256(
    _parsed: &ParsedHttpUrl,
    _dest_path: &Path,
    _cancel_flag: &AtomicBool,
    _on_chunk: impl FnMut(u64, Option<u64>, Option<f64>),
) -> Result<(u64, String, Option<String>, Option<String>), AppError> {
    Err(AppError::new(
        "DOWNLOAD_FAILED",
        "Direct HTTP media download is implemented for Windows.",
    ))
}

fn append_js_runtime_args(cmd: &mut Command, runtimes: &[JsRuntimeInfo]) {
    for rt in runtimes {
        cmd.arg("--js-runtimes")
            .arg(format!("{}:{}", rt.name, rt.path));
    }
}

#[derive(Debug, Deserialize)]
struct YtdlpFormatJson {
    format_id: Option<String>,
    ext: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    fps: Option<f64>,
    vcodec: Option<String>,
    acodec: Option<String>,
    language: Option<String>,
    filesize: Option<u64>,
    filesize_approx: Option<u64>,
    format_note: Option<String>,
    has_drm: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct YtdlpInfoJson {
    title: Option<String>,
    extractor: Option<String>,
    extractor_key: Option<String>,
    webpage_url_domain: Option<String>,
    duration: Option<f64>,
    language: Option<String>,
    filesize: Option<u64>,
    filesize_approx: Option<u64>,
    has_drm: Option<bool>,
    #[serde(default)]
    formats: Vec<YtdlpFormatJson>,
}

fn clean_codec_field(raw: Option<&str>) -> Option<String> {
    let val = raw?.trim();
    if val.is_empty() || val.eq_ignore_ascii_case("none") {
        None
    } else {
        Some(val.to_string())
    }
}

fn is_h264_codec(vcodec: &str) -> bool {
    let lower = vcodec.to_ascii_lowercase();
    lower.starts_with("avc") || lower.contains("264")
}

fn probe_with_ytdlp(
    media_root: &Path,
    parsed: &ParsedHttpUrl,
    cancel_flag: &AtomicBool,
) -> Result<VideoDownloadProbeResult, AppError> {
    let ytdlp = require_ytdlp(media_root)?;
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let mut cmd = Command::new(&ytdlp.binary);
    cmd.arg("--dump-single-json")
        .arg("--no-config")
        .arg("--no-playlist")
        .arg("--skip-download")
        .arg("--no-color")
        .arg("--socket-timeout")
        .arg("18");

    if parsed.is_loopback {
        cmd.arg("--proxy").arg("");
    }
    append_js_runtime_args(&mut cmd, &ytdlp.js_runtimes);
    cmd.arg("--").arg(&parsed.raw);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_hidden_command(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| {
        AppError::new(
            "MEDIA_PROCESS_FAILED",
            format!("Failed to start yt-dlp: {e}"),
        )
    })?;
    let job = ProcessTreeJob::attach(&child);

    let stdout_handle = child.stdout.take().map(|mut out| {
        thread::spawn(move || {
            let mut s = String::new();
            let _ = out.read_to_string(&mut s);
            s
        })
    });
    let stderr_handle = child.stderr.take().map(|mut err| {
        thread::spawn(move || {
            let mut s = String::new();
            let _ = err.read_to_string(&mut s);
            s
        })
    });

    let deadline = Instant::now() + Duration::from_secs(YTDLP_PROBE_TIMEOUT_SECS);
    let status = loop {
        if cancel_flag.load(Ordering::Relaxed) {
            if let Some(ref j) = job {
                j.terminate();
            }
            let _ = child.kill();
            let _ = child.wait();
            if let Some(h) = stdout_handle {
                let _ = h.join();
            }
            if let Some(h) = stderr_handle {
                let _ = h.join();
            }
            return Err(AppError::cancelled());
        }
        if Instant::now() >= deadline {
            if let Some(ref j) = job {
                j.terminate();
            }
            let _ = child.kill();
            let _ = child.wait();
            if let Some(h) = stdout_handle {
                let _ = h.join();
            }
            if let Some(h) = stderr_handle {
                let _ = h.join();
            }
            return Err(AppError::new(
                "NETWORK_ERROR",
                "Timed out while inspecting this URL with yt-dlp.",
            ));
        }
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(e) => {
                if let Some(ref j) = job {
                    j.terminate();
                }
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::new(
                    "MEDIA_PROCESS_FAILED",
                    format!("Error polling yt-dlp probe: {e}"),
                ));
            }
        }
    };

    let stdout_text = stdout_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();
    let stderr_text = stderr_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();

    if !status.success() {
        return Err(classify_ytdlp_error(&stderr_text));
    }

    let info: YtdlpInfoJson = serde_json::from_str(&stdout_text).map_err(|e| {
        AppError::decode_failed(format!("Unable to parse yt-dlp metadata JSON: {e}"))
    })?;

    if info.has_drm == Some(true)
        || (!info.formats.is_empty() && info.formats.iter().all(|f| f.has_drm == Some(true)))
    {
        return Err(AppError::new(
            "DRM_PROTECTED",
            "This media stream is DRM-protected and cannot be downloaded.",
        ));
    }

    let mut heights: BTreeSet<u32> = BTreeSet::new();
    let mut audio_langs: BTreeMap<String, Option<String>> = BTreeMap::new();
    let mut has_h264 = false;
    let mut max_video_bytes: u64 = 0;
    let mut max_audio_bytes: u64 = 0;
    let mut summaries: Vec<VideoDownloadFormatOption> = Vec::new();

    for fmt in &info.formats {
        if fmt.has_drm == Some(true) {
            continue;
        }
        let vcodec_explicit_none = fmt
            .vcodec
            .as_deref()
            .is_some_and(|v| v.trim().eq_ignore_ascii_case("none"));
        let acodec_explicit_none = fmt
            .acodec
            .as_deref()
            .is_some_and(|a| a.trim().eq_ignore_ascii_case("none"));
        let vcodec = clean_codec_field(fmt.vcodec.as_deref());
        let acodec = clean_codec_field(fmt.acodec.as_deref());
        let has_video = !vcodec_explicit_none && (vcodec.is_some() || fmt.height.unwrap_or(0) > 0);
        // In yt-dlp HLS `#EXT-X-MEDIA:TYPE=AUDIO`, `vcodec` is `"none"` while `acodec` is omitted/null.
        let has_audio = !acodec_explicit_none
            && (acodec.is_some()
                || vcodec_explicit_none
                || fmt
                    .language
                    .as_deref()
                    .and_then(normalize_language_code)
                    .is_some());

        // Skip storyboard image formats (e.g. mhtml)
        if let Some(ref ext) = fmt.ext {
            if ext.eq_ignore_ascii_case("mhtml") {
                continue;
            }
        }

        if let Some(h) = fmt.height {
            if h >= 144 {
                heights.insert(h);
            }
        }
        if let Some(ref vc) = vcodec {
            if is_h264_codec(vc) {
                has_h264 = true;
            }
        }
        if has_audio {
            if let Some(lang) = fmt.language.as_deref().and_then(normalize_language_code) {
                audio_langs.entry(lang).or_insert_with(|| acodec.clone());
            }
        }
        let fsize = fmt.filesize.or(fmt.filesize_approx).unwrap_or(0);
        if has_video {
            max_video_bytes = max_video_bytes.max(fsize);
        } else if has_audio {
            max_audio_bytes = max_audio_bytes.max(fsize);
        }

        if has_video || has_audio {
            let resolution = match (fmt.width, fmt.height) {
                (Some(w), Some(h)) if w > 0 && h > 0 => Some(format!("{w}x{h}")),
                (_, Some(h)) if h > 0 => Some(format!("{h}p")),
                _ => None,
            };
            summaries.push(VideoDownloadFormatOption {
                format_id: fmt.format_id.clone().unwrap_or_default(),
                ext: fmt.ext.clone().unwrap_or_else(|| "mp4".into()),
                resolution,
                width: fmt.width,
                height: fmt.height,
                fps: fmt.fps,
                vcodec,
                acodec,
                language: fmt.language.as_deref().and_then(normalize_language_code),
                filesize_bytes: fmt.filesize.or(fmt.filesize_approx),
                has_video,
                has_audio,
                note: fmt.format_note.clone(),
            });
        }
    }

    if audio_langs.is_empty() {
        if let Some(lang) = info.language.as_deref().and_then(normalize_language_code) {
            audio_langs.insert(lang, None);
        }
    }

    let mut available_resolutions: Vec<u32> = heights.into_iter().collect();
    available_resolutions.sort_by(|a, b| b.cmp(a));

    let available_audio_languages: Vec<VideoDownloadAudioTrackOption> = audio_langs
        .into_iter()
        .map(|(language, codec)| VideoDownloadAudioTrackOption {
            label: format_language_label(&language),
            language,
            codec,
        })
        .collect();

    let mut warnings = Vec::new();
    let stderr_lower = stderr_text.to_ascii_lowercase();
    if stderr_lower.contains("javascript runtime") || stderr_lower.contains("ejs") {
        warnings.push(
            "yt-dlp reported a JavaScript runtime warning for this site; some formats may require Deno or Node.js."
                .to_string(),
        );
    }

    let estimated_best_bytes = if max_video_bytes > 0 || max_audio_bytes > 0 {
        Some(max_video_bytes.saturating_add(max_audio_bytes))
    } else {
        info.filesize.or(info.filesize_approx)
    };

    // Keep format summary concise (most useful formats sorted by height desc)
    summaries.sort_by(|a, b| {
        b.height
            .unwrap_or(0)
            .cmp(&a.height.unwrap_or(0))
            .then_with(|| b.has_audio.cmp(&a.has_audio))
    });
    summaries.truncate(24);

    let title = info
        .title
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| derive_title_from_url(parsed, None));
    let extractor = info
        .extractor_key
        .or(info.extractor)
        .unwrap_or_else(|| "yt-dlp".into());

    Ok(VideoDownloadProbeResult {
        sanitized_url: redact_url_for_logs(&parsed.raw),
        title,
        extractor,
        webpage_domain: info
            .webpage_url_domain
            .or_else(|| Some(parsed.host.clone())),
        duration_sec: info.duration,
        is_direct_media: false,
        used_ytdlp: true,
        available_resolutions,
        available_audio_languages,
        has_h264,
        estimated_best_bytes,
        warnings,
        formats_summary: summaries,
    })
}

fn try_probe_direct_media(
    parsed: &ParsedHttpUrl,
    head: &HttpHeadMetadata,
) -> VideoDownloadProbeResult {
    let ext = parsed
        .file_extension
        .clone()
        .or_else(|| {
            head.content_type
                .as_deref()
                .and_then(extension_from_content_type)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "mp4".into());
    let is_audio_only = matches!(
        ext.as_str(),
        "m4a" | "mp3" | "wav" | "flac" | "ogg" | "opus" | "aac"
    );
    let title = derive_title_from_url(parsed, head.content_disposition.as_deref());

    let fmt = VideoDownloadFormatOption {
        format_id: "direct".into(),
        ext: ext.clone(),
        resolution: None,
        width: None,
        height: None,
        fps: None,
        vcodec: None,
        acodec: None,
        language: None,
        filesize_bytes: head.content_length,
        has_video: !is_audio_only,
        has_audio: true,
        note: head.content_type.clone(),
    };

    VideoDownloadProbeResult {
        sanitized_url: redact_url_for_logs(&parsed.raw),
        title,
        extractor: "Direct HTTP(S) Media".into(),
        webpage_domain: Some(parsed.host.clone()),
        duration_sec: None,
        is_direct_media: true,
        used_ytdlp: false,
        available_resolutions: Vec::new(),
        available_audio_languages: Vec::new(),
        has_h264: ext == "mp4" || ext == "mov",
        estimated_best_bytes: head.content_length,
        warnings: Vec::new(),
        formats_summary: vec![fmt],
    }
}

fn should_use_direct_media_path(parsed: &ParsedHttpUrl, head: Option<&HttpHeadMetadata>) -> bool {
    if is_manifest_extension(parsed.file_extension.as_deref()) {
        return false;
    }
    if let Some(h) = head {
        if let Some(ref ct) = h.content_type {
            if is_manifest_content_type(ct) || is_html_content_type(ct) {
                return false;
            }
            if is_direct_media_content_type(ct) {
                return true;
            }
            let lower_ct = ct.to_ascii_lowercase();
            if (lower_ct.starts_with("application/octet-stream")
                || lower_ct.starts_with("binary/octet-stream"))
                && is_direct_media_extension(parsed.file_extension.as_deref())
            {
                return true;
            }
        }
    }
    is_direct_media_extension(parsed.file_extension.as_deref())
}

pub fn probe_video_download_url_impl(
    media_root: &Path,
    raw_url: &str,
    cancel_flag: &AtomicBool,
) -> Result<VideoDownloadProbeResult, AppError> {
    let parsed = parse_http_url(raw_url)?;
    let sanitized = redact_url_for_logs(&parsed.raw);

    // Manifest links (HLS .m3u8 / DASH .mpd) always require yt-dlp
    if is_manifest_extension(parsed.file_extension.as_deref()) {
        return probe_with_ytdlp(media_root, &parsed, cancel_flag);
    }

    // Direct media file extensions -> probe via WinHTTP HEAD first so they work even without yt-dlp
    if is_direct_media_extension(parsed.file_extension.as_deref()) {
        let head = winhttp_head_media(&parsed, cancel_flag)?;
        if head.status_code != 200 && head.status_code != 206 {
            return Err(classify_http_status(head.status_code, &sanitized));
        }
        if should_use_direct_media_path(&parsed, Some(&head)) {
            return Ok(try_probe_direct_media(&parsed, &head));
        }
        return probe_with_ytdlp(media_root, &parsed, cancel_flag);
    }

    // Non-media-extension URLs: if yt-dlp is installed, use yt-dlp directly;
    // if yt-dlp is missing, try WinHTTP HEAD in case it's an extensionless direct media URL.
    if resolve_ytdlp_optional(media_root).is_some() {
        return probe_with_ytdlp(media_root, &parsed, cancel_flag);
    }

    let head = winhttp_head_media(&parsed, cancel_flag)?;
    if head.status_code != 200 && head.status_code != 206 {
        return Err(classify_http_status(head.status_code, &sanitized));
    }
    if should_use_direct_media_path(&parsed, Some(&head)) {
        return Ok(try_probe_direct_media(&parsed, &head));
    }

    Err(AppError::new(
        "YTDLP_MISSING",
        "Web video pages require yt-dlp. Install the verified Windows yt-dlp component or select a local yt-dlp.exe above (direct media links work without yt-dlp).",
    ))
}

struct ParsedYtdlpProgress {
    status: String,
    downloaded: Option<u64>,
    total: Option<u64>,
    speed: Option<f64>,
    eta: Option<f64>,
}

fn parse_ytdlp_progress_line(line: &str) -> Option<ParsedYtdlpProgress> {
    let rest = line.strip_prefix("WINKIT_PROG|")?;
    let parts: Vec<&str> = rest.split('|').collect();
    if parts.len() < 6 {
        return None;
    }
    let parse_u64 = |s: &str| -> Option<u64> {
        let t = s.trim();
        if t.is_empty() || t == "NA" || t == "None" {
            None
        } else {
            t.parse::<f64>().ok().map(|v| v.max(0.0) as u64)
        }
    };
    let parse_f64 = |s: &str| -> Option<f64> {
        let t = s.trim();
        if t.is_empty() || t == "NA" || t == "None" {
            None
        } else {
            t.parse::<f64>().ok().filter(|v| v.is_finite() && *v >= 0.0)
        }
    };

    let status = parts[0].trim().to_string();
    let downloaded = parse_u64(parts[1]);
    let total = parse_u64(parts[2]).or_else(|| parse_u64(parts[3]));
    let speed = parse_f64(parts[4]);
    let eta = parse_f64(parts[5]);
    Some(ParsedYtdlpProgress {
        status,
        downloaded,
        total,
        speed,
        eta,
    })
}

fn compute_file_sha256_bounded(path: &Path, byte_size: u64) -> Option<String> {
    if byte_size > MAX_HASH_BYTES {
        return None;
    }
    let mut file = File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(format!("{:x}", hasher.finalize()))
}

fn find_produced_media_in_staging(
    staging_dir: &Path,
    reported_path: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(p) = reported_path {
        if p.is_file() {
            return Some(p.to_path_buf());
        }
    }
    let entries = fs::read_dir(staging_dir).ok()?;
    let mut candidates: Vec<(u64, PathBuf)> = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if name.ends_with(".part")
            || name.ends_with(".ytdl")
            || name.ends_with(".tmp")
            || name.ends_with(".temp")
            || name.ends_with(".json")
        {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if size > 0 {
            candidates.push((size, path));
        }
    }
    candidates.sort_by_key(|a| std::cmp::Reverse(a.0));
    candidates.into_iter().next().map(|(_, p)| p)
}

fn download_direct_media_impl(
    media_root: &Path,
    req: &StartVideoDownloadItemRequest,
    parsed: &ParsedHttpUrl,
    output_dir: &Path,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(VideoDownloadProgressPayload),
) -> Result<VideoDownloadItemResult, AppError> {
    let staging = StagingDirGuard::create_in(output_dir)?;
    let sanitized = redact_url_for_logs(&parsed.raw);
    let raw_ext = parsed
        .file_extension
        .clone()
        .unwrap_or_else(|| "mp4".into());
    let dl_tmp = staging.path().join(format!("source.{raw_ext}"));

    on_progress(VideoDownloadProgressPayload {
        task_id: req.task_id.clone(),
        item_id: req.item_id.clone(),
        phase: "downloading".into(),
        percent: Some(0.0),
        downloaded_bytes: Some(0),
        total_bytes: None,
        speed_bytes_per_sec: None,
        eta_sec: None,
        message: Some("Downloading direct media stream...".into()),
    });

    let dl_weight = if req.quality == VideoDownloadQuality::AudioM4a {
        80.0
    } else {
        98.0
    };

    let (downloaded_bytes, raw_sha256, content_type, content_disposition) =
        winhttp_download_direct_with_sha256(
            parsed,
            &dl_tmp,
            cancel_flag,
            |downloaded, total, speed| {
                let pct = total
                    .filter(|t| *t > 0)
                    .map(|t| ((downloaded as f64 / t as f64) * dl_weight).clamp(0.0, dl_weight));
                let eta = match (total, speed) {
                    (Some(t), Some(sp)) if t > downloaded && sp > 1.0 => {
                        Some((t - downloaded) as f64 / sp)
                    }
                    _ => None,
                };
                on_progress(VideoDownloadProgressPayload {
                    task_id: req.task_id.clone(),
                    item_id: req.item_id.clone(),
                    phase: "downloading".into(),
                    percent: pct,
                    downloaded_bytes: Some(downloaded),
                    total_bytes: total,
                    speed_bytes_per_sec: speed,
                    eta_sec: eta,
                    message: None,
                });
            },
        )?;

    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let detected_ext = parsed
        .file_extension
        .clone()
        .or_else(|| {
            content_type
                .as_deref()
                .and_then(extension_from_content_type)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "mp4".into());

    let title = req
        .suggested_title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| derive_title_from_url(parsed, content_disposition.as_deref()));

    let mut warnings = Vec::new();
    let (staged_final_file, final_ext, final_sha256) =
        if req.quality == VideoDownloadQuality::AudioM4a {
            let tools = require_media_tools(media_root)?;
            on_progress(VideoDownloadProgressPayload {
                task_id: req.task_id.clone(),
                item_id: req.item_id.clone(),
                phase: "extracting_audio".into(),
                percent: Some(85.0),
                downloaded_bytes: Some(downloaded_bytes),
                total_bytes: Some(downloaded_bytes),
                speed_bytes_per_sec: None,
                eta_sec: None,
                message: Some("Extracting M4A audio via local FFmpeg...".into()),
            });

            let probe_src = probe_media_info_impl(media_root, &dl_tmp.to_string_lossy()).ok();
            let src_duration = probe_src.as_ref().and_then(|p| p.duration_sec);
            let is_already_aac = probe_src
                .as_ref()
                .and_then(|p| p.audio_streams.first())
                .and_then(|a| a.codec_name.as_deref())
                .map(|c| c.eq_ignore_ascii_case("aac"))
                .unwrap_or(false);

            let out_m4a = staging.path().join("extracted.m4a");
            let mut args = vec![
                "-i".to_string(),
                dl_tmp.to_string_lossy().into_owned(),
                "-vn".to_string(),
                "-map".to_string(),
                "0:a:0".to_string(),
            ];
            if is_already_aac {
                args.push("-c:a".to_string());
                args.push("copy".to_string());
            } else {
                args.push("-c:a".to_string());
                args.push("aac".to_string());
                args.push("-b:a".to_string());
                args.push("192k".to_string());
            }
            args.push("-movflags".to_string());
            args.push("+faststart".to_string());
            args.push(out_m4a.to_string_lossy().into_owned());

            run_ffmpeg_cancellable(&tools.ffmpeg, &args, src_duration, cancel_flag, |_, pct| {
                let mapped = pct.map(|p| 82.0 + (p * 0.16));
                on_progress(VideoDownloadProgressPayload {
                    task_id: req.task_id.clone(),
                    item_id: req.item_id.clone(),
                    phase: "extracting_audio".into(),
                    percent: mapped,
                    downloaded_bytes: Some(downloaded_bytes),
                    total_bytes: Some(downloaded_bytes),
                    speed_bytes_per_sec: None,
                    eta_sec: None,
                    message: Some("Extracting M4A audio via local FFmpeg...".into()),
                });
            })?;
            let m4a_size = fs::metadata(&out_m4a).map(|m| m.len()).unwrap_or(0);
            let sha = compute_file_sha256_bounded(&out_m4a, m4a_size);
            (out_m4a, "m4a".to_string(), sha)
        } else {
            (dl_tmp, detected_ext, Some(raw_sha256))
        };

    let dummy_source = PathBuf::new();
    let final_path =
        allocate_non_colliding_output_path(output_dir, &title, "", &final_ext, &dummy_source)?;
    let expected_first = format!(
        "{}.{final_ext}",
        final_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&title)
    );
    let final_name = final_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&expected_first)
        .to_string();
    let renamed_for_collision =
        final_name.contains(" (") && final_name.ends_with(&format!(").{final_ext}"));

    fs::rename(&staged_final_file, &final_path)
        .map_err(|e| AppError::from_io(e, "Unable to move downloaded file to target folder"))?;
    let final_size = fs::metadata(&final_path)
        .map(|m| m.len())
        .unwrap_or(downloaded_bytes);

    let probe = if get_media_tools_status_impl(media_root).ready {
        probe_media_info_impl(media_root, &final_path.to_string_lossy()).ok()
    } else {
        None
    };

    let (width, height, video_codec, audio_codec, audio_language, duration_sec, container_format) =
        if let Some(ref report) = probe {
            let v = report.video_streams.first();
            let a = report.audio_streams.first();
            (
                v.and_then(|s| s.display_width.or(s.coded_width)),
                v.and_then(|s| s.display_height.or(s.coded_height)),
                v.and_then(|s| s.codec_name.clone()),
                a.and_then(|s| s.codec_name.clone()),
                a.and_then(|s| s.language.as_deref().and_then(normalize_language_code)),
                report.duration_sec,
                report.container_format.clone(),
            )
        } else {
            (None, None, None, None, None, None, Some(final_ext.clone()))
        };

    if matches!(
        req.quality,
        VideoDownloadQuality::Max1080p | VideoDownloadQuality::Max720p
    ) {
        let cap = if req.quality == VideoDownloadQuality::Max720p {
            720
        } else {
            1080
        };
        if let Some(h) = height {
            if h > cap {
                warnings.push(format!(
                    "Direct media links provide a single stream ({h}p) without alternate lower-resolution tracks; saved the original file unmodified."
                ));
            }
        }
    }

    on_progress(VideoDownloadProgressPayload {
        task_id: req.task_id.clone(),
        item_id: req.item_id.clone(),
        phase: "completed".into(),
        percent: Some(100.0),
        downloaded_bytes: Some(final_size),
        total_bytes: Some(final_size),
        speed_bytes_per_sec: None,
        eta_sec: Some(0.0),
        message: Some("Completed".into()),
    });

    Ok(VideoDownloadItemResult {
        item_id: req.item_id.clone(),
        sanitized_url: sanitized,
        output_path: final_path.to_string_lossy().into_owned(),
        file_name: final_name,
        byte_size: final_size,
        sha256: final_sha256,
        title,
        extractor: "Direct HTTP(S) Media".into(),
        used_ytdlp: false,
        duration_sec,
        width,
        height,
        video_codec,
        audio_codec,
        audio_language,
        container_format,
        renamed_for_collision,
        warnings,
    })
}

fn download_with_ytdlp_impl(
    media_root: &Path,
    req: &StartVideoDownloadItemRequest,
    parsed: &ParsedHttpUrl,
    output_dir: &Path,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(VideoDownloadProgressPayload),
) -> Result<VideoDownloadItemResult, AppError> {
    let ytdlp = require_ytdlp(media_root)?;
    let ffmpeg_status = get_media_tools_status_impl(media_root);
    if req.quality == VideoDownloadQuality::AudioM4a && !ffmpeg_status.ready {
        return Err(AppError::new(
            "MEDIA_TOOLS_MISSING",
            "Exporting audio-only M4A requires local FFmpeg / ffprobe. Configure media components first.",
        ));
    }

    let staging = StagingDirGuard::create_in(output_dir)?;
    let sanitized = redact_url_for_logs(&parsed.raw);
    let selector = build_ytdlp_format_selector(
        req.quality,
        req.prefer_h264,
        req.preferred_audio_language.as_deref(),
    );

    let mut cmd = Command::new(&ytdlp.binary);
    cmd.arg("--no-config")
        .arg("--no-playlist")
        .arg("--no-color")
        .arg("--newline")
        .arg("--no-simulate")
        .arg("--windows-filenames")
        .arg("--retries")
        .arg("2")
        .arg("--fragment-retries")
        .arg("2")
        .arg("--socket-timeout")
        .arg("20")
        .arg("--paths")
        .arg(staging.path())
        .arg("-o")
        .arg("%(title).120B.%(ext)s")
        .arg("--progress-template")
        .arg("download:WINKIT_PROG|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s")
        .arg("--print")
        .arg("before_dl:WINKIT_META|%(extractor_key)s|%(title)s|%(requested_formats.0.language)s|%(requested_formats.1.language)s|%(language)s")
        .arg("--print")
        .arg("after_move:WINKIT_RESULT|%(filepath)s")
        .arg("-f")
        .arg(&selector);

    if let Some(ref ff_path) = ffmpeg_status.ffmpeg_path {
        if let Some(ff_dir) = Path::new(ff_path).parent() {
            cmd.arg("--ffmpeg-location").arg(ff_dir);
        }
    }

    if req.quality == VideoDownloadQuality::AudioM4a {
        cmd.arg("-x")
            .arg("--audio-format")
            .arg("m4a")
            .arg("--audio-quality")
            .arg("0");
    } else if ffmpeg_status.ready {
        cmd.arg("--merge-output-format").arg("mp4");
    }

    if parsed.is_loopback {
        cmd.arg("--proxy").arg("");
    }
    append_js_runtime_args(&mut cmd, &ytdlp.js_runtimes);
    cmd.arg("--").arg(&parsed.raw);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_hidden_command(&mut cmd);

    on_progress(VideoDownloadProgressPayload {
        task_id: req.task_id.clone(),
        item_id: req.item_id.clone(),
        phase: "downloading".into(),
        percent: Some(0.0),
        downloaded_bytes: None,
        total_bytes: None,
        speed_bytes_per_sec: None,
        eta_sec: None,
        message: Some("Starting yt-dlp...".into()),
    });

    let mut child = cmd.spawn().map_err(|e| {
        AppError::new(
            "MEDIA_PROCESS_FAILED",
            format!("Failed to start yt-dlp: {e}"),
        )
    })?;
    let job = ProcessTreeJob::attach(&child);

    #[derive(Default)]
    struct SharedYtdlpOutput {
        phase: String,
        percent: Option<f64>,
        downloaded_bytes: Option<u64>,
        total_bytes: Option<u64>,
        speed_bytes_per_sec: Option<f64>,
        eta_sec: Option<f64>,
        reported_path: Option<PathBuf>,
        reported_title: Option<String>,
        reported_extractor: Option<String>,
        reported_audio_lang: Option<String>,
        dirty: bool,
    }

    let shared = Arc::new(Mutex::new(SharedYtdlpOutput {
        phase: "downloading".into(),
        ..SharedYtdlpOutput::default()
    }));

    let stdout_shared = Arc::clone(&shared);
    let stdout_handle = child.stdout.take().map(|out| {
        thread::spawn(move || {
            let reader = BufReader::new(out);
            for line in reader.lines().map_while(Result::ok) {
                let trimmed = line.trim();
                if let Some(p) = parse_ytdlp_progress_line(trimmed) {
                    if let Ok(mut g) = stdout_shared.lock() {
                        g.phase = if p.status == "finished" {
                            "merging".into()
                        } else {
                            "downloading".into()
                        };
                        g.downloaded_bytes = p.downloaded;
                        g.total_bytes = p.total;
                        g.speed_bytes_per_sec = p.speed;
                        g.eta_sec = p.eta;
                        g.percent = match (p.downloaded, p.total) {
                            (Some(d), Some(t)) if t > 0 => {
                                Some(((d as f64 / t as f64) * 92.0).clamp(0.0, 92.0))
                            }
                            _ if p.status == "finished" => Some(92.0),
                            _ => g.percent,
                        };
                        g.dirty = true;
                    }
                } else if let Some(rest) = trimmed.strip_prefix("WINKIT_META|") {
                    let parts: Vec<&str> = rest.split('|').collect();
                    if let Ok(mut g) = stdout_shared.lock() {
                        if let Some(ext) = parts
                            .first()
                            .map(|s| s.trim())
                            .filter(|s| !s.is_empty() && *s != "NA")
                        {
                            g.reported_extractor = Some(ext.to_string());
                        }
                        if let Some(title) = parts
                            .get(1)
                            .map(|s| s.trim())
                            .filter(|s| !s.is_empty() && *s != "NA")
                        {
                            g.reported_title = Some(title.to_string());
                        }
                        // Audio format is typically requested_formats.1 (video+audio merge) or requested_formats.0 (audio-only)
                        let lang = parts
                            .get(3)
                            .and_then(|s| normalize_language_code(s))
                            .or_else(|| parts.get(2).and_then(|s| normalize_language_code(s)))
                            .or_else(|| parts.get(4).and_then(|s| normalize_language_code(s)));
                        if lang.is_some() {
                            g.reported_audio_lang = lang;
                        }
                    }
                } else if let Some(path_str) = trimmed.strip_prefix("WINKIT_RESULT|") {
                    let p = path_str.trim();
                    if !p.is_empty() {
                        if let Ok(mut g) = stdout_shared.lock() {
                            g.reported_path = Some(PathBuf::from(p));
                        }
                    }
                } else if trimmed.starts_with("[Merger]") || trimmed.starts_with("[Fixup") {
                    if let Ok(mut g) = stdout_shared.lock() {
                        g.phase = "merging".into();
                        g.percent = Some(95.0);
                        g.dirty = true;
                    }
                } else if trimmed.starts_with("[ExtractAudio]") {
                    if let Ok(mut g) = stdout_shared.lock() {
                        g.phase = "extracting_audio".into();
                        g.percent = Some(95.0);
                        g.dirty = true;
                    }
                }
            }
        })
    });

    let stderr_handle = child.stderr.take().map(|mut err| {
        thread::spawn(move || {
            let mut s = String::new();
            let _ = err.read_to_string(&mut s);
            s
        })
    });

    let mut last_emit = Instant::now() - Duration::from_secs(1);

    let exit_status = loop {
        if cancel_flag.load(Ordering::Relaxed) {
            if let Some(ref j) = job {
                j.terminate();
            }
            let _ = child.kill();
            let _ = child.wait();
            if let Some(h) = stdout_handle {
                let _ = h.join();
            }
            if let Some(h) = stderr_handle {
                let _ = h.join();
            }
            return Err(AppError::cancelled());
        }

        if last_emit.elapsed() >= Duration::from_millis(120) {
            if let Ok(mut g) = shared.lock() {
                if g.dirty {
                    g.dirty = false;
                    last_emit = Instant::now();
                    on_progress(VideoDownloadProgressPayload {
                        task_id: req.task_id.clone(),
                        item_id: req.item_id.clone(),
                        phase: g.phase.clone(),
                        percent: g.percent,
                        downloaded_bytes: g.downloaded_bytes,
                        total_bytes: g.total_bytes,
                        speed_bytes_per_sec: g.speed_bytes_per_sec,
                        eta_sec: g.eta_sec,
                        message: None,
                    });
                }
            }
        }

        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(e) => {
                if let Some(ref j) = job {
                    j.terminate();
                }
                let _ = child.kill();
                let _ = child.wait();
                if let Some(h) = stdout_handle {
                    let _ = h.join();
                }
                if let Some(h) = stderr_handle {
                    let _ = h.join();
                }
                return Err(AppError::new(
                    "MEDIA_PROCESS_FAILED",
                    format!("Error monitoring yt-dlp process: {e}"),
                ));
            }
        }
    };

    if let Some(h) = stdout_handle {
        let _ = h.join();
    }
    let stderr_text = stderr_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();

    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    if !exit_status.success() {
        return Err(classify_ytdlp_error(&stderr_text));
    }

    let (reported_path, reported_title, reported_extractor, reported_audio_lang) = {
        let g = shared.lock().expect("shared yt-dlp mutex poisoned");
        (
            g.reported_path.clone(),
            g.reported_title.clone(),
            g.reported_extractor.clone(),
            g.reported_audio_lang.clone(),
        )
    };

    let produced = find_produced_media_in_staging(staging.path(), reported_path.as_deref())
        .ok_or_else(|| {
            AppError::new(
                "DOWNLOAD_FAILED",
                "yt-dlp exited successfully but no output media file was found in the staging folder.",
            )
        })?;

    let produced_stem = produced
        .file_stem()
        .and_then(|s| s.to_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| req.suggested_title.clone())
        .or_else(|| reported_title.clone())
        .unwrap_or_else(|| derive_title_from_url(parsed, None));
    let produced_ext = produced
        .extension()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_else(|| {
            if req.quality == VideoDownloadQuality::AudioM4a {
                "m4a".into()
            } else {
                "mp4".into()
            }
        });

    let dummy_source = PathBuf::new();
    let final_path = allocate_non_colliding_output_path(
        output_dir,
        &produced_stem,
        "",
        &produced_ext,
        &dummy_source,
    )?;
    let final_name = final_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("video")
        .to_string();
    let renamed_for_collision =
        final_name.contains(" (") && final_name.ends_with(&format!(").{produced_ext}"));

    fs::rename(&produced, &final_path)
        .map_err(|e| AppError::from_io(e, "Unable to move downloaded media into output folder"))?;

    let byte_size = fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0);
    let sha256 = compute_file_sha256_bounded(&final_path, byte_size);

    let probe = if ffmpeg_status.ready {
        probe_media_info_impl(media_root, &final_path.to_string_lossy()).ok()
    } else {
        None
    };

    let (
        width,
        height,
        video_codec,
        audio_codec,
        probed_audio_lang,
        duration_sec,
        container_format,
    ) = if let Some(ref report) = probe {
        let v = report.video_streams.first();
        let a = report.audio_streams.first();
        (
            v.and_then(|s| s.display_width.or(s.coded_width)),
            v.and_then(|s| s.display_height.or(s.coded_height)),
            v.and_then(|s| s.codec_name.clone()),
            a.and_then(|s| s.codec_name.clone()),
            a.and_then(|s| s.language.as_deref().and_then(normalize_language_code)),
            report.duration_sec,
            report.container_format.clone(),
        )
    } else {
        (None, None, None, None, None, None, Some(produced_ext))
    };

    let audio_language = probed_audio_lang.or(reported_audio_lang);
    let mut warnings = Vec::new();
    if !ffmpeg_status.ready {
        warnings.push(
            "Local FFmpeg / ffprobe is not configured, so separate high-resolution streams could not be merged or probed locally."
                .to_string(),
        );
    }

    on_progress(VideoDownloadProgressPayload {
        task_id: req.task_id.clone(),
        item_id: req.item_id.clone(),
        phase: "completed".into(),
        percent: Some(100.0),
        downloaded_bytes: Some(byte_size),
        total_bytes: Some(byte_size),
        speed_bytes_per_sec: None,
        eta_sec: Some(0.0),
        message: Some("Completed".into()),
    });

    Ok(VideoDownloadItemResult {
        item_id: req.item_id.clone(),
        sanitized_url: sanitized,
        output_path: final_path.to_string_lossy().into_owned(),
        file_name: final_name,
        byte_size,
        sha256,
        title: reported_title
            .or_else(|| req.suggested_title.clone())
            .unwrap_or(produced_stem),
        extractor: reported_extractor.unwrap_or_else(|| "yt-dlp".into()),
        used_ytdlp: true,
        duration_sec,
        width,
        height,
        video_codec,
        audio_codec,
        audio_language,
        container_format,
        renamed_for_collision,
        warnings,
    })
}

pub fn download_video_item_impl(
    media_root: &Path,
    req: &StartVideoDownloadItemRequest,
    cancel_flag: &AtomicBool,
    on_progress: impl FnMut(VideoDownloadProgressPayload),
) -> Result<VideoDownloadItemResult, AppError> {
    let parsed = parse_http_url(&req.url)?;
    let output_dir = validate_user_path(&req.output_dir, "Output folder")?;
    if output_dir.is_file() {
        return Err(AppError::invalid_param(
            "Output destination must be a folder, not a file.",
        ));
    }

    // Manifest links always go through yt-dlp
    if is_manifest_extension(parsed.file_extension.as_deref()) {
        return download_with_ytdlp_impl(
            media_root,
            req,
            &parsed,
            &output_dir,
            cancel_flag,
            on_progress,
        );
    }

    // Direct media extensions use our direct WinHTTP path (bit-exact SHA-256 + works without yt-dlp)
    if is_direct_media_extension(parsed.file_extension.as_deref()) {
        let head = winhttp_head_media(&parsed, cancel_flag)?;
        if head.status_code != 200 && head.status_code != 206 {
            return Err(classify_http_status(
                head.status_code,
                &redact_url_for_logs(&parsed.raw),
            ));
        }
        if should_use_direct_media_path(&parsed, Some(&head)) {
            return download_direct_media_impl(
                media_root,
                req,
                &parsed,
                &output_dir,
                cancel_flag,
                on_progress,
            );
        }
        return download_with_ytdlp_impl(
            media_root,
            req,
            &parsed,
            &output_dir,
            cancel_flag,
            on_progress,
        );
    }

    // Extensionless / webpage links: prefer yt-dlp if configured; fallback to direct media HEAD check if not.
    if resolve_ytdlp_optional(media_root).is_some() {
        return download_with_ytdlp_impl(
            media_root,
            req,
            &parsed,
            &output_dir,
            cancel_flag,
            on_progress,
        );
    }

    let head = winhttp_head_media(&parsed, cancel_flag)?;
    if head.status_code != 200 && head.status_code != 206 {
        return Err(classify_http_status(
            head.status_code,
            &redact_url_for_logs(&parsed.raw),
        ));
    }
    if should_use_direct_media_path(&parsed, Some(&head)) {
        return download_direct_media_impl(
            media_root,
            req,
            &parsed,
            &output_dir,
            cancel_flag,
            on_progress,
        );
    }

    Err(AppError::new(
        "YTDLP_MISSING",
        "Web video pages require yt-dlp. Configure yt-dlp first (direct media links work without yt-dlp).",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn url_validation_rejects_non_http_and_flag_injection() {
        assert!(parse_http_url("https://example.com/video.mp4").is_ok());
        assert!(parse_http_url("http://127.0.0.1:8765/master.m3u8?v=1").is_ok());
        assert!(parse_http_url("--exec calc.exe").is_err());
        assert!(parse_http_url("file:///C:/Windows/win.ini").is_err());
        assert!(parse_http_url("ftp://example.com/a.mp4").is_err());
        assert!(parse_http_url("https://example.com/a b.mp4").is_err());
        assert!(parse_http_url("").is_err());
    }

    #[test]
    fn sensitive_url_and_log_redaction_masks_userinfo_tokens_and_signatures() {
        let raw = "https://alice:s3cr3t@cdn.example.com/watch?v=12345&token=eyJhbGciOi&X-Amz-Signature=deadbeef&auth_key=xyz999&lang=zh#access_token=abc";
        let safe = redact_url_for_logs(raw);
        assert!(!safe.contains("alice"));
        assert!(!safe.contains("s3cr3t"));
        assert!(!safe.contains("eyJhbGciOi"));
        assert!(!safe.contains("deadbeef"));
        assert!(!safe.contains("xyz999"));
        assert!(!safe.contains("access_token=abc"));
        assert!(safe.contains("***@cdn.example.com"));
        assert!(safe.contains("v=12345"));
        assert!(safe.contains("lang=zh"));
        assert!(safe.contains("token=[REDACTED]"));
        assert!(safe.contains("X-Amz-Signature=[REDACTED]"));
        assert!(safe.contains("auth_key=[REDACTED]"));

        let stderr =
            format!("ERROR: HTTP Error 403 when fetching {raw} with Bearer TOP_SECRET_JWT_123");
        let redacted_err = classify_ytdlp_error(&stderr);
        assert_eq!(redacted_err.code, "ACCESS_FORBIDDEN");
        assert!(!redacted_err.message.contains("eyJhbGciOi"));
        assert!(!redacted_err.message.contains("TOP_SECRET_JWT_123"));
        assert!(!redacted_err.message.contains("s3cr3t"));
        assert!(redacted_err.message.contains("[REDACTED]"));
    }

    #[test]
    fn quality_preset_serializes_with_explicit_snake_case_names() {
        assert_eq!(
            serde_json::to_string(&VideoDownloadQuality::Best).unwrap(),
            "\"best\""
        );
        assert_eq!(
            serde_json::to_string(&VideoDownloadQuality::Max1080p).unwrap(),
            "\"max_1080p\""
        );
        assert_eq!(
            serde_json::to_string(&VideoDownloadQuality::Max720p).unwrap(),
            "\"max_720p\""
        );
        assert_eq!(
            serde_json::to_string(&VideoDownloadQuality::AudioM4a).unwrap(),
            "\"audio_m4a\""
        );
        assert_eq!(
            serde_json::from_str::<VideoDownloadQuality>("\"max_720p\"").unwrap(),
            VideoDownloadQuality::Max720p
        );
    }

    #[test]
    fn format_selector_builds_h264_resolution_and_language_fallbacks() {
        let sel = build_ytdlp_format_selector(VideoDownloadQuality::Max720p, true, Some("zh-CN"));
        assert!(sel.starts_with("bestvideo[height<=720][vcodec^=avc]+bestaudio[language^=zh]/"));
        assert!(sel.ends_with("/best[height<=720]"));

        let audio = build_ytdlp_format_selector(VideoDownloadQuality::AudioM4a, false, Some("en"));
        assert_eq!(
            audio,
            "bestaudio[language^=en][ext=m4a]/bestaudio[language^=en]/bestaudio[ext=m4a]/bestaudio/best"
        );

        let best = build_ytdlp_format_selector(VideoDownloadQuality::Best, false, None);
        assert_eq!(best, "bestvideo+bestaudio/best");
    }

    #[test]
    fn error_classifier_maps_auth_geo_drm_js_and_network_accurately() {
        assert_eq!(
            classify_ytdlp_error("ERROR: Sign in to confirm you're not a bot. Use --cookies").code,
            "LOGIN_REQUIRED"
        );
        assert_eq!(
            classify_ytdlp_error(
                "ERROR: Sign in to confirm your age. This video may be inappropriate"
            )
            .code,
            "AGE_RESTRICTED"
        );
        assert_eq!(
            classify_ytdlp_error(
                "ERROR: The uploader has not made this video available in your country"
            )
            .code,
            "GEO_BLOCKED"
        );
        assert_eq!(
            classify_ytdlp_error("ERROR: This video is DRM protected (Widevine)").code,
            "DRM_PROTECTED"
        );
        assert_eq!(
            classify_ytdlp_error("ERROR: No supported JavaScript runtime could be found (EJS)")
                .code,
            "JS_RUNTIME_REQUIRED"
        );
        assert_eq!(
            classify_ytdlp_error("ERROR: Unsupported URL: https://example.com/about").code,
            "UNSUPPORTED_URL"
        );
        assert_eq!(
            classify_ytdlp_error("ERROR: [Errno 10054] Connection reset by peer").code,
            "NETWORK_ERROR"
        );
    }

    #[test]
    fn staging_dir_guard_removes_partial_files_on_drop() {
        let dir = tempdir().expect("tempdir");
        let staged_path = {
            let guard = StagingDirGuard::create_in(dir.path()).expect("create staging");
            fs::write(guard.path().join("video.mp4.part"), b"partial data").expect("write part");
            fs::write(guard.path().join("video.mp4.ytdl"), b"{}").expect("write ytdl");
            guard.path().to_path_buf()
        };
        assert!(!staged_path.exists());
        let leftover: Vec<_> = fs::read_dir(dir.path()).unwrap().collect();
        assert!(
            leftover.is_empty(),
            "output folder must have zero leftover .part/.tmp files"
        );
    }
}
