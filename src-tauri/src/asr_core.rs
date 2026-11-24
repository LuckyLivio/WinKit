//! Pure-Rust offline speech transcription engine for `T01` (and reusable by future `A02` / `V02`
//! integrations), powered by WinKit's already-bundled `onnxruntime.dll 1.23.2` (MIT) plus user-
//! downloaded, SHA-256 verified `SenseVoiceSmall INT8` + `Silero VAD v5` ONNX models.
//!
//! Pipeline:
//! 1. Media inspection & 16 kHz mono PCM decoding:
//!    - `.wav` PCM / IEEE-float files are decoded directly in pure Rust (works without FFmpeg).
//!    - Other audio/video containers (`.mp3`, `.m4a`, `.flac`, `.ogg`, `.opus`, `.mp4`, `.mkv`,
//!      `.mov`, `.webm`, etc.) reuse WinKit's FFmpeg/ffprobe discovery and anchor all segment
//!      timestamps to the original media stream's `start_time` timeline offset.
//! 2. Streaming `Silero VAD v5` (32 ms frames, 64-sample context, LSTM state) detects speech
//!    regions cleanly across background noise and long pauses without silence hallucinations, and
//!    splits >24 s continuous monologues at lowest-probability dips.
//! 3. Kaldi-compatible 80-dim Hamming FBank (`25 ms / 10 ms`, `preemph = 0.97`, DC removal) ->
//!    LFR (`window = 7, shift = 6` -> 560-dim) -> ONNX-embedded CMVN -> `SenseVoiceSmall INT8`
//!    greedy CTC decode + SentencePiece detokenization + CTC-aligned sub-splitting for long cues.
//! 4. Monotonic subtitle validation, SRT/TXT formatting, and non-destructive atomic export.

use crate::asr_models::ResolvedAsrAssets;
use crate::error::AppError;
use crate::fs_guard::{
    paths_refer_to_same_location, validate_existing_input_file, validate_user_path,
};
use crate::media_core::{
    configure_hidden_command, require_media_tools, run_ffmpeg_cancellable, AtomicMediaOutput,
};
use crate::ocr_ort::{resolve_ort_dll_path, OrtInput, OrtRuntime, OrtSession};
use serde::{Deserialize, Serialize};
use std::f32::consts::PI;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use uuid::Uuid;

pub const ASR_PROGRESS_EVENT: &str = "winkit://asr-progress";
pub const ASR_SAMPLE_RATE: u32 = 16_000;
const VAD_WINDOW_SAMPLES: usize = 512; // 32 ms @ 16 kHz
const VAD_CONTEXT_SAMPLES: usize = 64;
const VAD_STATE_LEN: usize = 2 * 128;
const FBANK_FRAME_LEN: usize = 400; // 25 ms @ 16 kHz
const FBANK_FRAME_SHIFT: usize = 160; // 10 ms @ 16 kHz
const FBANK_FFT_SIZE: usize = 512;
const FBANK_NUM_BINS: usize = 80;
const FBANK_LOW_FREQ: f32 = 20.0;
const FBANK_HIGH_FREQ: f32 = 8_000.0;
const FBANK_PREEMPH: f32 = 0.97;
const MAX_MEDIA_FILE_BYTES: u64 = 4 * 1024 * 1024 * 1024; // 4 GiB safety cap
pub const MAX_NATIVE_WAV_BYTES: u64 = 512 * 1024 * 1024; // Shared native-WAV size limit (inspect + decode)
const MAX_AUDIO_DURATION_SEC: f64 = 4.0 * 3600.0; // 4 hours safety cap

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AsrLanguage {
    #[default]
    Auto,
    Zh,
    En,
    Yue,
    Ja,
    Ko,
}

impl AsrLanguage {
    pub fn as_code(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Zh => "zh",
            Self::En => "en",
            Self::Yue => "yue",
            Self::Ja => "ja",
            Self::Ko => "ko",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub id: usize,
    /// Original media timeline start in seconds (`>= 0.0`).
    pub start_sec: f64,
    /// Original media timeline end in seconds (`> start_sec`).
    pub end_sec: f64,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeMediaInspectResult {
    pub path: String,
    pub file_name: String,
    pub byte_length: u64,
    pub is_wav_native: bool,
    pub requires_ffmpeg: bool,
    pub has_audio: bool,
    pub has_video: bool,
    pub duration_sec: Option<f64>,
    #[serde(default)]
    pub container_start_time_sec: f64,
    pub audio_start_time_sec: f64,
    pub audio_codec: Option<String>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
    pub container_format: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeMediaRequest {
    pub input_path: String,
    #[serde(default)]
    pub language: AsrLanguage,
    #[serde(default = "default_true")]
    pub use_itn: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeMediaResult {
    pub input_path: String,
    pub file_name: String,
    pub duration_sec: f64,
    pub timeline_offset_sec: f64,
    pub decoded_with_ffmpeg: bool,
    pub engine_name: String,
    pub segments: Vec<TranscriptSegment>,
    pub full_text: String,
    pub detected_languages: Vec<String>,
    pub speech_duration_sec: f64,
    pub elapsed_ms: u64,
    pub rtf: f64,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrProgressPayload {
    pub task_id: String,
    pub phase: String, // "decoding" | "vad" | "transcribing" | "completed"
    pub current_segment: usize,
    pub total_segments: usize,
    pub percent: f64,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptExportFormat {
    Txt,
    TxtTimestamped,
    Srt,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTranscriptRequest {
    pub output_path: String,
    pub format: TranscriptExportFormat,
    pub segments: Vec<TranscriptSegment>,
    #[serde(default)]
    pub forbidden_source_paths: Vec<String>,
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTranscriptResult {
    pub output_path: String,
    pub byte_size: u64,
    pub segment_count: usize,
    pub format: TranscriptExportFormat,
}

struct ScopedTempFile(PathBuf);

impl Drop for ScopedTempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// Decoded 16 kHz mono PCM waveform (`f32` in `[-1.0, +1.0]`) anchored to playback zero (`t = 0.0`).
/// Any audio-only delay and mid-stream PTS gaps are already preserved as silence inside `samples`,
/// while `timeline_offset_sec` records the informational relative audio stream delay for UI display.
pub struct DecodedMono16k {
    pub samples: Vec<f32>,
    pub duration_sec: f64,
    pub timeline_offset_sec: f64,
    pub decoded_with_ffmpeg: bool,
}

#[derive(Debug, Clone, Copy)]
struct WavHeaderInfo {
    audio_format: u16,
    channels: u16,
    sample_rate: u32,
    bits_per_sample: u16,
    data_offset: u64,
    data_len: u64,
    duration_sec: f64,
}

#[derive(Debug, Clone, Copy)]
struct NativeWavEligibility {
    header: WavHeaderInfo,
    can_decode_natively: bool,
}

/// Walks RIFF/WAVE chunks via `Seek` in O(1) memory, reading exact `fmt ` parameters and the
/// `data` chunk's declared byte length (clamped to EOF so trailing `LIST/INFO`/`id3 ` metadata
/// chunks never inflate duration or get decoded as audio).
fn parse_wav_header_from_file(
    path: &Path,
    file_len: u64,
) -> Result<Option<WavHeaderInfo>, AppError> {
    if file_len < 44 {
        return Ok(None);
    }
    let mut file = File::open(path).map_err(|e| AppError::from_io(e, "Unable to open WAV file"))?;
    let mut riff = [0u8; 12];
    if file.read_exact(&mut riff).is_err() {
        return Ok(None);
    }
    if &riff[0..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
        return Ok(None);
    }

    let mut pos = 12u64;
    let mut audio_format = 0u16;
    let mut channels = 0u16;
    let mut sample_rate = 0u32;
    let mut bits_per_sample = 0u16;
    let mut got_fmt = false;
    let mut data_offset = 0u64;
    let mut data_len = 0u64;
    let mut got_data = false;

    while pos + 8 <= file_len {
        if file.seek(SeekFrom::Start(pos)).is_err() {
            break;
        }
        let mut hdr = [0u8; 8];
        if file.read_exact(&mut hdr).is_err() {
            break;
        }
        let chunk_id = &hdr[0..4];
        let chunk_size = u64::from(u32::from_le_bytes([hdr[4], hdr[5], hdr[6], hdr[7]]));
        pos += 8;
        let avail = file_len.saturating_sub(pos);

        if chunk_id == b"fmt " && chunk_size >= 16 && avail >= 16 {
            let read_len = (chunk_size.min(avail).min(256)) as usize;
            let mut fmt_buf = vec![0u8; read_len];
            if file.read_exact(&mut fmt_buf).is_err() {
                break;
            }
            audio_format = u16::from_le_bytes([fmt_buf[0], fmt_buf[1]]);
            channels = u16::from_le_bytes([fmt_buf[2], fmt_buf[3]]);
            sample_rate = u32::from_le_bytes([fmt_buf[4], fmt_buf[5], fmt_buf[6], fmt_buf[7]]);
            bits_per_sample = u16::from_le_bytes([fmt_buf[14], fmt_buf[15]]);
            // Support WAVE_FORMAT_EXTENSIBLE (0xFFFE) if subformat is PCM (1) or IEEE float (3).
            if audio_format == 0xFFFE && read_len >= 40 {
                let sub_fmt = u16::from_le_bytes([fmt_buf[24], fmt_buf[25]]);
                if sub_fmt == 1 || sub_fmt == 3 {
                    audio_format = sub_fmt;
                }
            }
            got_fmt = true;
        } else if chunk_id == b"data" {
            data_offset = pos;
            // Respect the RIFF `data` chunk size so trailing LIST/INFO/id3 chunks are excluded.
            // Only fall back to remaining file bytes when streaming writers left 0 or 0xFFFF_FFFF.
            data_len = if chunk_size == 0 || chunk_size == u64::from(u32::MAX) {
                avail
            } else {
                chunk_size.min(avail)
            };
            got_data = true;
            if got_fmt {
                break;
            }
        }

        let padded = chunk_size.saturating_add(chunk_size & 1);
        match pos.checked_add(padded) {
            Some(next) if next > pos => pos = next,
            _ => break,
        }
    }

    if !got_fmt || !got_data || channels == 0 || sample_rate == 0 {
        return Ok(None);
    }
    let supported = (audio_format == 1 && matches!(bits_per_sample, 8 | 16 | 24 | 32))
        || (audio_format == 3 && bits_per_sample == 32);
    if !supported {
        return Ok(None);
    }
    let bytes_per_frame = u64::from(channels) * u64::from(bits_per_sample / 8);
    if bytes_per_frame == 0 {
        return Ok(None);
    }
    let total_frames = data_len / bytes_per_frame;
    let duration_sec = total_frames as f64 / f64::from(sample_rate);
    Ok(Some(WavHeaderInfo {
        audio_format,
        channels,
        sample_rate,
        bits_per_sample,
        data_offset,
        data_len,
        duration_sec,
    }))
}

fn is_wav_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("wav"))
        .unwrap_or(false)
}

/// Shared eligibility check used identically by inspection, preparation, and native WAV decoding.
fn inspect_wav_native_eligibility(
    path: &Path,
    file_len: u64,
) -> Result<Option<NativeWavEligibility>, AppError> {
    if !is_wav_extension(path) {
        return Ok(None);
    }
    let Some(header) = parse_wav_header_from_file(path, file_len)? else {
        return Ok(None);
    };
    Ok(Some(NativeWavEligibility {
        header,
        can_decode_natively: file_len <= MAX_NATIVE_WAV_BYTES,
    }))
}

/// Bounded-memory streaming pure-Rust decoder for standard PCM / IEEE-float WAV files ->
/// mono 16 kHz `f32` in `[-1.0, 1.0]`, reading strictly `data_len` bytes in 1 MiB frame chunks.
pub fn decode_wav_streaming_to_mono_16k(
    path: &Path,
    enforce_native_size_cap: bool,
) -> Result<Option<DecodedMono16k>, AppError> {
    let meta =
        fs::metadata(path).map_err(|e| AppError::from_io(e, "Unable to inspect WAV file"))?;
    let file_len = meta.len();
    if enforce_native_size_cap && file_len > MAX_NATIVE_WAV_BYTES {
        return Ok(None);
    }
    let Some(hdr) = parse_wav_header_from_file(path, file_len)? else {
        return Ok(None);
    };
    if hdr.duration_sec > MAX_AUDIO_DURATION_SEC {
        return Err(AppError::size_limit(
            "Audio file exceeds the 4-hour offline transcription safety limit.",
        ));
    }

    let ch = usize::from(hdr.channels);
    let bps = usize::from(hdr.bits_per_sample / 8);
    let frame_bytes = ch * bps;
    let total_src_frames = (hdr.data_len / frame_bytes as u64) as usize;
    if total_src_frames == 0 {
        return Ok(Some(DecodedMono16k {
            samples: Vec::new(),
            duration_sec: 0.0,
            timeline_offset_sec: 0.0,
            decoded_with_ffmpeg: false,
        }));
    }

    let ratio = f64::from(hdr.sample_rate) / f64::from(ASR_SAMPLE_RATE);
    let expected_out_frames = if hdr.sample_rate == ASR_SAMPLE_RATE {
        total_src_frames
    } else {
        ((total_src_frames as f64) / ratio).round().max(1.0) as usize
    };
    let mut out_samples = Vec::with_capacity(expected_out_frames);

    let mut file = File::open(path).map_err(|e| AppError::from_io(e, "Unable to open WAV file"))?;
    file.seek(SeekFrom::Start(hdr.data_offset))
        .map_err(|e| AppError::from_io(e, "Unable to seek to WAV data chunk"))?;

    // Align 1 MiB chunk buffer to whole PCM frames so every read decodes clean frames.
    let chunk_frames = ((1024 * 1024) / frame_bytes).max(1024);
    let mut raw_buf = vec![0u8; chunk_frames * frame_bytes];
    let mut remaining_bytes = hdr.data_len;

    let mut mono_chunk = Vec::with_capacity(chunk_frames);
    let mut src_frame_offset: u64 = 0;
    let mut out_idx: u64 = 0;
    let mut prev_tail_sample: Option<f32> = None;

    while remaining_bytes >= frame_bytes as u64 {
        let to_read =
            (remaining_bytes.min(raw_buf.len() as u64) as usize / frame_bytes) * frame_bytes;
        if to_read == 0 {
            break;
        }
        let n = read_exact_or_eof(&mut file, &mut raw_buf[..to_read])
            .map_err(|e| AppError::from_io(e, "Unable to stream WAV PCM data"))?;
        let usable = (n / frame_bytes) * frame_bytes;
        if usable == 0 {
            break;
        }
        remaining_bytes = remaining_bytes.saturating_sub(usable as u64);

        mono_chunk.clear();
        for frame in raw_buf[..usable].chunks_exact(frame_bytes) {
            let mut acc = 0.0f32;
            for c in 0..ch {
                let s = &frame[c * bps..(c + 1) * bps];
                let sample = match (hdr.audio_format, hdr.bits_per_sample) {
                    (1, 8) => (f32::from(s[0]) - 128.0) / 128.0,
                    (1, 16) => f32::from(i16::from_le_bytes([s[0], s[1]])) / 32768.0,
                    (1, 24) => {
                        let sign = if (s[2] & 0x80) != 0 { 0xFF } else { 0x00 };
                        let v = i32::from_le_bytes([s[0], s[1], s[2], sign]);
                        (v as f32) / 8_388_608.0
                    }
                    (1, 32) => {
                        (i32::from_le_bytes([s[0], s[1], s[2], s[3]]) as f64 / 2_147_483_648.0)
                            as f32
                    }
                    (3, 32) => f32::from_le_bytes([s[0], s[1], s[2], s[3]]).clamp(-1.0, 1.0),
                    _ => 0.0,
                };
                acc += sample;
            }
            mono_chunk.push((acc / ch as f32).clamp(-1.0, 1.0));
        }

        if hdr.sample_rate == ASR_SAMPLE_RATE {
            out_samples.extend_from_slice(&mono_chunk);
        } else {
            let chunk_len = mono_chunk.len() as u64;
            let chunk_end_frame = src_frame_offset + chunk_len;
            let is_last_chunk = remaining_bytes < frame_bytes as u64;
            let last_global = (total_src_frames - 1) as u64;

            while (out_idx as usize) < expected_out_frames {
                let pos = out_idx as f64 * ratio;
                let idx = (pos.floor() as u64).min(last_global);
                let next = (idx + 1).min(last_global);
                if next >= chunk_end_frame && !is_last_chunk {
                    break;
                }
                let s0 = if idx < src_frame_offset {
                    prev_tail_sample.unwrap_or(mono_chunk[0])
                } else {
                    let local = (idx - src_frame_offset) as usize;
                    mono_chunk[local.min(mono_chunk.len() - 1)]
                };
                let s1 = if next < src_frame_offset {
                    prev_tail_sample.unwrap_or(mono_chunk[0])
                } else {
                    let local = (next - src_frame_offset) as usize;
                    mono_chunk[local.min(mono_chunk.len() - 1)]
                };
                let frac = (pos - idx as f64) as f32;
                out_samples.push(s0 * (1.0 - frac) + s1 * frac);
                out_idx += 1;
            }
            prev_tail_sample = mono_chunk.last().copied();
            src_frame_offset = chunk_end_frame;
        }
    }

    let duration_sec = out_samples.len() as f64 / f64::from(ASR_SAMPLE_RATE);
    Ok(Some(DecodedMono16k {
        samples: out_samples,
        duration_sec,
        timeline_offset_sec: 0.0,
        decoded_with_ffmpeg: false,
    }))
}

fn read_exact_or_eof(reader: &mut File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0usize;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

/// Pure-Rust decoder for standard PCM / IEEE-float WAV files (`<= 512 MiB`) -> mono 16 kHz `f32`.
pub fn decode_wav_native_to_mono_16k(path: &Path) -> Result<Option<DecodedMono16k>, AppError> {
    decode_wav_streaming_to_mono_16k(path, true)
}

#[derive(Debug, Deserialize)]
struct FfprobeAudioTimeline {
    #[serde(default)]
    streams: Vec<FfprobeAudioStreamEntry>,
    format: Option<FfprobeFormatEntry>,
}

#[derive(Debug, Deserialize)]
struct FfprobeAudioStreamEntry {
    codec_type: Option<String>,
    codec_name: Option<String>,
    sample_rate: Option<String>,
    channels: Option<u32>,
    start_time: Option<String>,
    duration: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FfprobeFormatEntry {
    format_name: Option<String>,
    start_time: Option<String>,
    duration: Option<String>,
}

fn parse_opt_f64(raw: Option<&str>) -> Option<f64> {
    raw.and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|v| v.is_finite())
}

fn probe_via_ffprobe(ffprobe: &Path, input: &Path) -> Result<FfprobeAudioTimeline, AppError> {
    let mut cmd = Command::new(ffprobe);
    configure_hidden_command(&mut cmd);
    cmd.args([
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name,sample_rate,channels,start_time,duration:format=format_name,start_time,duration",
        "-of",
        "json",
    ])
    .arg(input)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

    let out = cmd
        .output()
        .map_err(|e| AppError::from_io(e, "Failed to invoke ffprobe"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(AppError::decode_failed(format!(
            "Unable to inspect media file with ffprobe: {}",
            stderr.trim()
        )));
    }
    serde_json::from_slice::<FfprobeAudioTimeline>(&out.stdout)
        .map_err(|e| AppError::decode_failed(format!("Failed to parse ffprobe JSON output: {e}")))
}

fn compute_container_start_time_sec(probed: &FfprobeAudioTimeline) -> f64 {
    let min_stream_start = probed
        .streams
        .iter()
        .filter(|s| matches!(s.codec_type.as_deref(), Some("video" | "audio")))
        .filter_map(|s| parse_opt_f64(s.start_time.as_deref()))
        .reduce(f64::min);
    let origin = probed
        .format
        .as_ref()
        .and_then(|f| parse_opt_f64(f.start_time.as_deref()))
        .or(min_stream_start)
        .unwrap_or(0.0);
    if origin.is_finite() && origin > 0.005 {
        round_ms(origin)
    } else {
        0.0
    }
}

/// Computes the audio stream's delay relative to the container's playback zero point (`format.start_time`).
/// - Whole container shifted to e.g. `10.0s` (both video & audio start at `10.0s`) -> `0.0s`
/// - Audio-only delay (`format=0.0s, video=0.0s, audio=2.5s`) -> `2.5s`
/// - Combined (`format=10.0s, video=10.0s, audio=12.5s`) -> `2.5s`
fn compute_relative_audio_delay_sec(
    probed: &FfprobeAudioTimeline,
    audio_stream: Option<&FfprobeAudioStreamEntry>,
) -> f64 {
    let min_stream_start = probed
        .streams
        .iter()
        .filter(|s| matches!(s.codec_type.as_deref(), Some("video" | "audio")))
        .filter_map(|s| parse_opt_f64(s.start_time.as_deref()))
        .reduce(f64::min);
    let container_origin = probed
        .format
        .as_ref()
        .and_then(|f| parse_opt_f64(f.start_time.as_deref()))
        .or(min_stream_start)
        .unwrap_or(0.0);
    let audio_start = audio_stream
        .and_then(|s| parse_opt_f64(s.start_time.as_deref()))
        .unwrap_or(container_origin);
    let rel = audio_start - container_origin;
    if rel.is_finite() && rel > 0.005 {
        round_ms(rel)
    } else {
        0.0
    }
}

/// Computes normalized playback duration (handling Matroska containers with non-zero start_time
/// where `format.duration` may reflect end-PTS rather than elapsed duration).
fn compute_playback_duration_sec(
    probed: &FfprobeAudioTimeline,
    audio_stream: Option<&FfprobeAudioStreamEntry>,
) -> Option<f64> {
    let format_start = probed
        .format
        .as_ref()
        .and_then(|f| parse_opt_f64(f.start_time.as_deref()))
        .unwrap_or(0.0);
    let raw_fmt_dur = probed
        .format
        .as_ref()
        .and_then(|f| parse_opt_f64(f.duration.as_deref()));
    let stream_dur = probed
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video"))
        .and_then(|s| parse_opt_f64(s.duration.as_deref()))
        .or_else(|| audio_stream.and_then(|s| parse_opt_f64(s.duration.as_deref())));
    let is_matroska = probed
        .format
        .as_ref()
        .and_then(|f| f.format_name.as_deref())
        .map(|n| n.contains("matroska") || n.contains("webm"))
        .unwrap_or(false);
    if is_matroska && format_start > 0.5 {
        if let Some(d) = raw_fmt_dur {
            if d > format_start {
                return Some(round_ms(d - format_start));
            }
        }
    }
    raw_fmt_dur.or(stream_dur)
}

/// Inspects an audio or video file for `T01`, sharing the exact same native-WAV eligibility rules
/// as transcription execution and reporting relative audio delay from playback zero.
pub fn inspect_transcribe_media_impl(
    media_root: &Path,
    path_raw: &str,
) -> Result<TranscribeMediaInspectResult, AppError> {
    let (canonical, byte_length) = validate_existing_input_file(path_raw)?;
    if byte_length == 0 {
        return Err(AppError::decode_failed("Media file is empty (0 bytes)."));
    }
    if byte_length > MAX_MEDIA_FILE_BYTES {
        return Err(AppError::size_limit(
            "Media file exceeds the 4 GiB safety limit.",
        ));
    }
    let file_name = canonical
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "media".to_string());

    if let Some(elig) = inspect_wav_native_eligibility(&canonical, byte_length)? {
        let hdr = elig.header;
        return Ok(TranscribeMediaInspectResult {
            path: canonical.to_string_lossy().into_owned(),
            file_name,
            byte_length,
            is_wav_native: elig.can_decode_natively,
            requires_ffmpeg: !elig.can_decode_natively,
            has_audio: true,
            has_video: false,
            duration_sec: Some(hdr.duration_sec),
            container_start_time_sec: 0.0,
            audio_start_time_sec: 0.0,
            audio_codec: Some(if hdr.audio_format == 3 {
                format!("pcm_f{}le", hdr.bits_per_sample)
            } else {
                format!("pcm_s{}le", hdr.bits_per_sample)
            }),
            sample_rate: Some(hdr.sample_rate),
            channels: Some(u32::from(hdr.channels)),
            container_format: Some("wav".to_string()),
        });
    }

    let tools = require_media_tools(media_root)?;
    let probed = probe_via_ffprobe(&tools.ffprobe, &canonical)?;
    let has_video = probed
        .streams
        .iter()
        .any(|s| s.codec_type.as_deref() == Some("video"));
    let audio_stream = probed
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("audio"));
    let has_audio = audio_stream.is_some();

    let container_start_time_sec = compute_container_start_time_sec(&probed);
    let audio_delay_sec = compute_relative_audio_delay_sec(&probed, audio_stream);
    let duration_sec = compute_playback_duration_sec(&probed, audio_stream);

    Ok(TranscribeMediaInspectResult {
        path: canonical.to_string_lossy().into_owned(),
        file_name,
        byte_length,
        is_wav_native: false,
        requires_ffmpeg: true,
        has_audio,
        has_video,
        duration_sec,
        container_start_time_sec,
        audio_start_time_sec: audio_delay_sec,
        audio_codec: audio_stream.and_then(|s| s.codec_name.clone()),
        sample_rate: audio_stream
            .and_then(|s| s.sample_rate.as_deref())
            .and_then(|s| s.parse::<u32>().ok()),
        channels: audio_stream.and_then(|s| s.channels),
        container_format: probed.format.and_then(|f| f.format_name),
    })
}

/// Decodes any local audio or video file into 16 kHz mono PCM `f32` samples aligned to media
/// playback zero (`t = 0.0`), preserving audio-only delays and mid-stream PTS gaps via FFmpeg
/// `aresample=async=1:first_pts=0`.
pub fn decode_media_to_mono_16k(
    media_root: &Path,
    canonical_input: &Path,
    cancel_flag: &AtomicBool,
    mut on_decode_progress: impl FnMut(f64),
) -> Result<DecodedMono16k, AppError> {
    let prepared = prepare_media_wav_for_asr(
        media_root,
        &canonical_input.to_string_lossy(),
        cancel_flag,
        &mut on_decode_progress,
    )?;
    let mut decoded =
        decode_wav_streaming_to_mono_16k(&prepared.wav_path, !prepared.decoded_with_ffmpeg)?
            .ok_or_else(|| {
                AppError::decode_failed("Decoded audio stream could not be read as 16 kHz PCM WAV.")
            })?;
    decoded.timeline_offset_sec = prepared.timeline_offset_sec;
    decoded.decoded_with_ffmpeg = prepared.decoded_with_ffmpeg;
    if let Some(d) = prepared.expected_duration_sec {
        decoded.duration_sec = decoded.duration_sec.max(d);
    }
    Ok(decoded)
}

/// Prepared PCM WAV source ready for `--asr-worker`, automatically deleting any FFmpeg temp WAV
/// once dropped (even if transcription fails or is cancelled).
pub struct PreparedAudioWav {
    pub wav_path: PathBuf,
    pub original_input_path: String,
    pub file_name: String,
    /// Informational relative audio-stream delay from media playback zero (already preserved as
    /// leading silence inside `wav_path` when decoded via FFmpeg `aresample=async=1:first_pts=0`).
    pub timeline_offset_sec: f64,
    pub expected_duration_sec: Option<f64>,
    pub decoded_with_ffmpeg: bool,
    _temp_guard: Option<ScopedTempFile>,
}

/// Prepares any audio/video input as a playback-zero-aligned WAV readable by `--asr-worker`.
/// - Standard PCM/float WAVs (`<= 512 MiB`) require zero FFmpeg and zero temp files.
/// - Other containers and `> 512 MiB` WAVs stream through WinKit's cancellable FFmpeg runner with
///   `-af aresample=async=1:first_pts=0` so whole-container non-zero start timestamps anchor to
///   playback zero (`0.0s`) while audio-only delays and mid-stream PTS gaps are preserved intact.
pub fn prepare_media_wav_for_asr(
    media_root: &Path,
    raw_input_path: &str,
    cancel_flag: &AtomicBool,
    mut on_decode_progress: impl FnMut(f64),
) -> Result<PreparedAudioWav, AppError> {
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }
    let (canonical_input, byte_length) = validate_existing_input_file(raw_input_path)?;
    if byte_length == 0 {
        return Err(AppError::decode_failed("Media file is empty (0 bytes)."));
    }
    if byte_length > MAX_MEDIA_FILE_BYTES {
        return Err(AppError::size_limit(
            "Media file exceeds the 4 GiB safety limit.",
        ));
    }
    let original_input_path = canonical_input.to_string_lossy().into_owned();
    let file_name = canonical_input
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "media".to_string());

    if let Some(elig) = inspect_wav_native_eligibility(&canonical_input, byte_length)? {
        if elig.can_decode_natively {
            if elig.header.duration_sec > MAX_AUDIO_DURATION_SEC {
                return Err(AppError::size_limit(
                    "Audio file exceeds the 4-hour offline transcription safety limit.",
                ));
            }
            on_decode_progress(100.0);
            return Ok(PreparedAudioWav {
                wav_path: canonical_input,
                original_input_path,
                file_name,
                timeline_offset_sec: 0.0,
                expected_duration_sec: Some(elig.header.duration_sec),
                decoded_with_ffmpeg: false,
                _temp_guard: None,
            });
        }
    }

    let tools = require_media_tools(media_root)?;
    let probed = probe_via_ffprobe(&tools.ffprobe, &canonical_input)?;
    let audio_stream = probed
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("audio"))
        .ok_or_else(|| {
            AppError::decode_failed("Selected media file contains no audio track to transcribe.")
        })?;

    let audio_delay_sec = compute_relative_audio_delay_sec(&probed, Some(audio_stream));
    let expected_dur = compute_playback_duration_sec(&probed, Some(audio_stream));

    if let Some(d) = expected_dur {
        if d > MAX_AUDIO_DURATION_SEC {
            return Err(AppError::size_limit(
                "Media file exceeds the 4-hour offline transcription safety limit.",
            ));
        }
    }

    let tmp_wav =
        ScopedTempFile(std::env::temp_dir().join(format!("winkit_t01_{}.wav", Uuid::new_v4())));
    // `aresample=async=1:first_pts=0` aligns sample 0 to FFmpeg's container playback zero while
    // inserting exact silence for audio-only initial delays and mid-stream audio PTS gaps.
    let args: Vec<String> = vec![
        "-i".into(),
        canonical_input.to_string_lossy().into_owned(),
        "-map".into(),
        "0:a:0".into(),
        "-vn".into(),
        "-sn".into(),
        "-dn".into(),
        "-af".into(),
        "aresample=async=1:first_pts=0".into(),
        "-ac".into(),
        "1".into(),
        "-ar".into(),
        ASR_SAMPLE_RATE.to_string(),
        "-c:a".into(),
        "pcm_s16le".into(),
        tmp_wav.0.to_string_lossy().into_owned(),
    ];

    run_ffmpeg_cancellable(
        &tools.ffmpeg,
        &args,
        expected_dur,
        cancel_flag,
        |_out_sec, pct| {
            if let Some(p) = pct {
                on_decode_progress(p.clamp(0.0, 99.0));
            }
        },
    )?;

    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }
    on_decode_progress(100.0);

    Ok(PreparedAudioWav {
        wav_path: tmp_wav.0.clone(),
        original_input_path,
        file_name,
        timeline_offset_sec: audio_delay_sec,
        expected_duration_sec: expected_dur,
        decoded_with_ffmpeg: true,
        _temp_guard: Some(tmp_wav),
    })
}

// ============================================================================
// Pure-Rust Kaldi 80-dim Hamming FBank + LFR + CMVN + Radix-2 512-pt FFT
// ============================================================================

struct KaldiFbankExtractor {
    hamming: [f32; FBANK_FRAME_LEN],
    mel_filters: Vec<Vec<(usize, f32)>>, // sparse non-zero FFT bin weights per mel band
    twiddle_re: [f32; FBANK_FFT_SIZE / 2],
    twiddle_im: [f32; FBANK_FFT_SIZE / 2],
    bit_rev: [usize; FBANK_FFT_SIZE],
}

impl KaldiFbankExtractor {
    fn new() -> Self {
        let mut hamming = [0.0f32; FBANK_FRAME_LEN];
        let denom = (FBANK_FRAME_LEN - 1) as f32;
        for (i, slot) in hamming.iter_mut().enumerate() {
            *slot = 0.54 - 0.46 * (2.0 * PI * (i as f32) / denom).cos();
        }

        let hz_to_mel = |hz: f32| -> f32 { 1127.0 * (1.0 + hz / 700.0).ln() };
        let low_mel = hz_to_mel(FBANK_LOW_FREQ);
        let high_mel = hz_to_mel(FBANK_HIGH_FREQ);
        let mel_delta = (high_mel - low_mel) / ((FBANK_NUM_BINS + 1) as f32);
        let fft_bin_width = (ASR_SAMPLE_RATE as f32) / (FBANK_FFT_SIZE as f32);
        let num_fft_bins = FBANK_FFT_SIZE / 2; // 0..256 (Kaldi omits Nyquist bin 256 or keeps 0..255)

        let mut mel_filters = Vec::with_capacity(FBANK_NUM_BINS);
        for m in 0..FBANK_NUM_BINS {
            let left_mel = low_mel + (m as f32) * mel_delta;
            let center_mel = left_mel + mel_delta;
            let right_mel = center_mel + mel_delta;
            let mut weights = Vec::new();
            for k in 0..num_fft_bins {
                let mel = hz_to_mel((k as f32) * fft_bin_width);
                let up = (mel - left_mel) / (center_mel - left_mel);
                let down = (right_mel - mel) / (right_mel - center_mel);
                let w = up.min(down);
                if w > 0.0 {
                    weights.push((k, w));
                }
            }
            mel_filters.push(weights);
        }

        let mut twiddle_re = [0.0f32; FBANK_FFT_SIZE / 2];
        let mut twiddle_im = [0.0f32; FBANK_FFT_SIZE / 2];
        for k in 0..(FBANK_FFT_SIZE / 2) {
            let angle = -2.0 * PI * (k as f32) / (FBANK_FFT_SIZE as f32);
            twiddle_re[k] = angle.cos();
            twiddle_im[k] = angle.sin();
        }

        let mut bit_rev = [0usize; FBANK_FFT_SIZE];
        let bits = FBANK_FFT_SIZE.trailing_zeros();
        for (i, slot) in bit_rev.iter_mut().enumerate() {
            *slot = i.reverse_bits() >> (usize::BITS - bits);
        }

        Self {
            hamming,
            mel_filters,
            twiddle_re,
            twiddle_im,
            bit_rev,
        }
    }

    fn fft_512_power(&self, frame: &[f32; FBANK_FRAME_LEN], power: &mut [f32; FBANK_FFT_SIZE / 2]) {
        let mut re = [0.0f32; FBANK_FFT_SIZE];
        let mut im = [0.0f32; FBANK_FFT_SIZE];
        for i in 0..FBANK_FRAME_LEN {
            re[self.bit_rev[i]] = frame[i];
        }

        let mut size = 2usize;
        while size <= FBANK_FFT_SIZE {
            let half = size / 2;
            let step = FBANK_FFT_SIZE / size;
            for start in (0..FBANK_FFT_SIZE).step_by(size) {
                for j in 0..half {
                    let tw = j * step;
                    let wr = self.twiddle_re[tw];
                    let wi = self.twiddle_im[tw];
                    let u_idx = start + j;
                    let v_idx = u_idx + half;
                    let tr = wr * re[v_idx] - wi * im[v_idx];
                    let ti = wr * im[v_idx] + wi * re[v_idx];
                    re[v_idx] = re[u_idx] - tr;
                    im[v_idx] = im[u_idx] - ti;
                    re[u_idx] += tr;
                    im[u_idx] += ti;
                }
            }
            size <<= 1;
        }

        for k in 0..(FBANK_FFT_SIZE / 2) {
            power[k] = re[k] * re[k] + im[k] * im[k];
        }
    }

    /// Computes Kaldi 80-dim log-mel FBank frames (`[num_frames, 80]`).
    /// When `scale_to_i16` is true (SenseVoiceSmall `normalize_samples == 0`), multiplies input
    /// `[-1, 1]` samples by `32768.0` to match FunASR / sherpa-onnx exact feature scale.
    fn compute_fbank(&self, samples: &[f32], scale_to_i16: bool) -> Vec<f32> {
        if samples.len() < FBANK_FRAME_LEN {
            return Vec::new();
        }
        let num_frames = (samples.len() - FBANK_FRAME_LEN) / FBANK_FRAME_SHIFT + 1;
        let mut feats = vec![0.0f32; num_frames * FBANK_NUM_BINS];
        let mut frame = [0.0f32; FBANK_FRAME_LEN];
        let mut power = [0.0f32; FBANK_FFT_SIZE / 2];
        let scale = if scale_to_i16 { 32_768.0f32 } else { 1.0f32 };

        for fidx in 0..num_frames {
            let start = fidx * FBANK_FRAME_SHIFT;
            let mut sum = 0.0f32;
            for i in 0..FBANK_FRAME_LEN {
                let v = samples[start + i] * scale;
                frame[i] = v;
                sum += v;
            }
            let mean = sum / (FBANK_FRAME_LEN as f32);
            for x in &mut frame {
                *x -= mean;
            }
            // Kaldi pre-emphasis (backwards pass so frame[i-1] is original DC-removed value)
            for i in (1..FBANK_FRAME_LEN).rev() {
                frame[i] -= FBANK_PREEMPH * frame[i - 1];
            }
            frame[0] -= FBANK_PREEMPH * frame[0];
            for (dst, &win) in frame.iter_mut().zip(self.hamming.iter()) {
                *dst *= win;
            }

            self.fft_512_power(&frame, &mut power);
            let out_row = &mut feats[fidx * FBANK_NUM_BINS..(fidx + 1) * FBANK_NUM_BINS];
            for (m, weights) in self.mel_filters.iter().enumerate() {
                let mut energy = 0.0f32;
                for &(bin, w) in weights {
                    energy += w * power[bin];
                }
                out_row[m] = energy.max(f32::EPSILON).ln();
            }
        }
        feats
    }
}

/// Applies sherpa-onnx / FunASR Low Frame Rate stacking (`window = 7, shift = 6`) and CMVN.
fn apply_lfr_and_cmvn(
    fbank: &[f32],
    num_frames: usize,
    lfr_window_size: usize,
    lfr_window_shift: usize,
    neg_mean: &[f32],
    inv_stddev: &[f32],
) -> (usize, Vec<f32>) {
    if num_frames == 0 {
        return (0, Vec::new());
    }
    let out_dim = FBANK_NUM_BINS * lfr_window_size;
    let out_frames = if num_frames >= lfr_window_size {
        (num_frames - lfr_window_size) / lfr_window_shift + 1
    } else {
        1
    };
    let mut out = vec![0.0f32; out_frames * out_dim];
    for t in 0..out_frames {
        let base_in = t * lfr_window_shift;
        let dst_row = &mut out[t * out_dim..(t + 1) * out_dim];
        for w in 0..lfr_window_size {
            let src_frame = (base_in + w).min(num_frames - 1);
            let src = &fbank[src_frame * FBANK_NUM_BINS..(src_frame + 1) * FBANK_NUM_BINS];
            let dst = &mut dst_row[w * FBANK_NUM_BINS..(w + 1) * FBANK_NUM_BINS];
            dst.copy_from_slice(src);
        }
        if neg_mean.len() == out_dim && inv_stddev.len() == out_dim {
            for d in 0..out_dim {
                dst_row[d] = (dst_row[d] + neg_mean[d]) * inv_stddev[d];
            }
        }
    }
    (out_frames, out)
}

#[derive(Debug, Clone, Copy)]
struct VadRegion {
    start_sample: usize,
    end_sample: usize,
}

#[derive(Debug, Clone)]
struct DecodedCtcToken {
    text: String,
    frame_idx: usize,
}

/// Persistent offline SenseVoiceSmall INT8 + Silero VAD v5 engine running on bundled `onnxruntime.dll`.
pub struct SenseVoiceAsrEngine {
    // SAFETY: `asr` and `vad` borrow `_runtime` pinned in `Box<OrtRuntime>` and declared BEFORE
    // `_runtime` so Rust's deterministic drop order always releases sessions before freeing the DLL.
    asr: OrtSession<'static>,
    vad: OrtSession<'static>,
    _runtime: Box<OrtRuntime>,
    fbank: KaldiFbankExtractor,
    tokens: Vec<String>,
    neg_mean: Vec<f32>,
    inv_stddev: Vec<f32>,
    lfr_window_size: usize,
    lfr_window_shift: usize,
    normalize_samples: bool,
    lang_ids: [i32; 6], // [auto, zh, en, yue, ja, ko]
    with_itn_id: i32,
    without_itn_id: i32,
    runtime_version: String,
}

impl SenseVoiceAsrEngine {
    pub fn load(assets: &ResolvedAsrAssets, resource_dir: Option<&Path>) -> Result<Self, AppError> {
        let (dll_path, qpdf_crt_dir) = resolve_ort_dll_path(resource_dir)?;
        let runtime = Box::new(OrtRuntime::load(&dll_path, qpdf_crt_dir.as_deref())?);
        let runtime_version = runtime.version_string().to_string();
        let threads = std::thread::available_parallelism()
            .map(|n| n.get().clamp(2, 4) as i32)
            .unwrap_or(4);

        // SAFETY: `runtime` is heap-pinned inside `Box<OrtRuntime>` and dropped strictly after `asr` and `vad`.
        let rt_ref: &'static OrtRuntime = unsafe { &*(&*runtime as *const OrtRuntime) };
        let asr = rt_ref.create_session(&assets.model_onnx_path, threads)?;
        let vad = rt_ref.create_session(&assets.vad_onnx_path, 1)?;

        let meta_usize = |key: &str, default: usize| -> usize {
            asr.lookup_custom_metadata(key)
                .ok()
                .flatten()
                .and_then(|s| s.trim().parse::<usize>().ok())
                .unwrap_or(default)
        };
        let meta_i32 = |key: &str, default: i32| -> i32 {
            asr.lookup_custom_metadata(key)
                .ok()
                .flatten()
                .and_then(|s| s.trim().parse::<i32>().ok())
                .unwrap_or(default)
        };
        let meta_f32_vec = |key: &str| -> Result<Vec<f32>, AppError> {
            let raw = asr.lookup_custom_metadata(key)?.ok_or_else(|| {
                AppError::new(
                    "ASR_MODEL_INVALID",
                    format!("SenseVoice ONNX model is missing '{key}' CMVN metadata."),
                )
            })?;
            raw.split(',')
                .map(|tok| {
                    tok.trim().parse::<f32>().map_err(|_| {
                        AppError::new(
                            "ASR_MODEL_INVALID",
                            format!("Invalid float in SenseVoice '{key}' metadata."),
                        )
                    })
                })
                .collect()
        };

        let lfr_window_size = meta_usize("lfr_window_size", 7);
        let lfr_window_shift = meta_usize("lfr_window_shift", 6);
        let normalize_samples = meta_i32("normalize_samples", 0) != 0;
        let neg_mean = meta_f32_vec("neg_mean")?;
        let inv_stddev = meta_f32_vec("inv_stddev")?;
        let lang_ids = [
            meta_i32("lang_auto", 0),
            meta_i32("lang_zh", 3),
            meta_i32("lang_en", 4),
            meta_i32("lang_yue", 7),
            meta_i32("lang_ja", 11),
            meta_i32("lang_ko", 12),
        ];
        let with_itn_id = meta_i32("with_itn", 14);
        let without_itn_id = meta_i32("without_itn", 15);

        let tokens = load_tokens_table(&assets.tokens_path)?;

        Ok(Self {
            asr,
            vad,
            _runtime: runtime,
            fbank: KaldiFbankExtractor::new(),
            tokens,
            neg_mean,
            inv_stddev,
            lfr_window_size,
            lfr_window_shift,
            normalize_samples,
            lang_ids,
            with_itn_id,
            without_itn_id,
            runtime_version,
        })
    }

    pub fn runtime_version(&self) -> &str {
        &self.runtime_version
    }

    fn language_id(&self, lang: AsrLanguage) -> i32 {
        match lang {
            AsrLanguage::Auto => self.lang_ids[0],
            AsrLanguage::Zh => self.lang_ids[1],
            AsrLanguage::En => self.lang_ids[2],
            AsrLanguage::Yue => self.lang_ids[3],
            AsrLanguage::Ja => self.lang_ids[4],
            AsrLanguage::Ko => self.lang_ids[5],
        }
    }

    /// Detects speech segments across `samples` (16 kHz mono in `[-1.0, 1.0]`) using Silero VAD v5.
    fn detect_vad_regions(
        &self,
        samples: &[f32],
        cancel_flag: &AtomicBool,
    ) -> Result<Vec<VadRegion>, AppError> {
        if samples.len() < VAD_WINDOW_SAMPLES {
            return Ok(Vec::new());
        }

        const SPEECH_THRESH: f32 = 0.45;
        const NEG_THRESH: f32 = 0.30;
        const MIN_SPEECH_FRAMES: usize = 8; // 256 ms
        const MIN_SILENCE_FRAMES: usize = 16; // 512 ms
        const PAD_SAMPLES: usize = 1_920; // 120 ms padding around speech edges
        const MAX_SPEECH_FRAMES: usize = 750; // 24.0 s ceiling per chunk before energy-dip split
        const MIN_SPLIT_FRAMES: usize = 560; // ~18.0 s search window start for split dip

        let num_frames = samples.len() / VAD_WINDOW_SAMPLES;
        let mut probs = Vec::with_capacity(num_frames);
        let mut state = vec![0.0f32; VAD_STATE_LEN];
        let mut context = [0.0f32; VAD_CONTEXT_SAMPLES];
        let mut in_buf = [0.0f32; VAD_CONTEXT_SAMPLES + VAD_WINDOW_SAMPLES];
        let sr = [i64::from(ASR_SAMPLE_RATE)];

        for f in 0..num_frames {
            if f % 64 == 0 && cancel_flag.load(Ordering::Relaxed) {
                return Err(AppError::cancelled());
            }
            let chunk = &samples[f * VAD_WINDOW_SAMPLES..(f + 1) * VAD_WINDOW_SAMPLES];
            in_buf[..VAD_CONTEXT_SAMPLES].copy_from_slice(&context);
            in_buf[VAD_CONTEXT_SAMPLES..].copy_from_slice(chunk);
            context.copy_from_slice(&chunk[VAD_WINDOW_SAMPLES - VAD_CONTEXT_SAMPLES..]);

            let outs = self.vad.run_multi_f32_outputs(
                &[
                    (
                        "input",
                        OrtInput::F32(
                            &[1, (VAD_CONTEXT_SAMPLES + VAD_WINDOW_SAMPLES) as i64],
                            &in_buf,
                        ),
                    ),
                    ("state", OrtInput::F32(&[2, 1, 128], &state)),
                    ("sr", OrtInput::I64(&[], &sr)),
                ],
                &["output", "stateN"],
            )?;
            let prob = outs[0].1.first().copied().unwrap_or(0.0);
            probs.push(prob);
            if outs[1].1.len() == VAD_STATE_LEN {
                state.copy_from_slice(&outs[1].1);
            }
        }

        // Hysteresis speech state machine with long-monologue dip splitting
        let mut raw_segments: Vec<(usize, usize)> = Vec::new();
        let mut in_speech = false;
        let mut seg_start_frame = 0usize;
        let mut silence_frames = 0usize;

        let mut f = 0usize;
        while f < probs.len() {
            let p = probs[f];
            if !in_speech {
                if p >= SPEECH_THRESH {
                    in_speech = true;
                    seg_start_frame = f;
                    silence_frames = 0;
                }
            } else {
                if p < NEG_THRESH {
                    silence_frames += 1;
                    if silence_frames >= MIN_SILENCE_FRAMES {
                        let end_frame = f.saturating_sub(silence_frames) + 1;
                        if end_frame.saturating_sub(seg_start_frame) >= MIN_SPEECH_FRAMES {
                            raw_segments.push((seg_start_frame, end_frame));
                        }
                        in_speech = false;
                        silence_frames = 0;
                    }
                } else {
                    silence_frames = 0;
                }

                if in_speech && f.saturating_sub(seg_start_frame) >= MAX_SPEECH_FRAMES {
                    // Find lowest speech probability dip between MIN_SPLIT_FRAMES and current frame
                    let search_start = seg_start_frame + MIN_SPLIT_FRAMES;
                    let mut best_frame = f;
                    let mut best_prob = f32::INFINITY;
                    for (cand, &prob) in probs.iter().enumerate().take(f + 1).skip(search_start) {
                        if prob < best_prob {
                            best_prob = prob;
                            best_frame = cand;
                        }
                    }
                    if best_frame > seg_start_frame + MIN_SPEECH_FRAMES {
                        raw_segments.push((seg_start_frame, best_frame));
                        seg_start_frame = best_frame;
                        silence_frames = 0;
                    }
                }
            }
            f += 1;
        }

        if in_speech {
            let end_frame = probs.len().saturating_sub(silence_frames);
            if end_frame.saturating_sub(seg_start_frame) >= MIN_SPEECH_FRAMES {
                raw_segments.push((seg_start_frame, end_frame));
            }
        }

        // Convert frames to padded sample spans and merge touching/overlapping regions cleanly
        let total_samples = samples.len();
        let mut regions: Vec<VadRegion> = Vec::with_capacity(raw_segments.len());
        for (sf, ef) in raw_segments {
            let s = (sf * VAD_WINDOW_SAMPLES).saturating_sub(PAD_SAMPLES);
            let e = (ef * VAD_WINDOW_SAMPLES + PAD_SAMPLES).min(total_samples);
            if let Some(prev) = regions.last_mut() {
                if s <= prev.end_sample
                    && (e - prev.start_sample) <= MAX_SPEECH_FRAMES * VAD_WINDOW_SAMPLES
                {
                    prev.end_sample = prev.end_sample.max(e);
                    continue;
                }
            }
            if e > s + FBANK_FRAME_LEN {
                regions.push(VadRegion {
                    start_sample: s,
                    end_sample: e,
                });
            }
        }

        Ok(regions)
    }

    /// Runs SenseVoiceSmall INT8 on a single speech slice and returns `(detected_lang, decoded_tokens)`.
    fn recognize_slice(
        &self,
        slice: &[f32],
        language: AsrLanguage,
        use_itn: bool,
    ) -> Result<(Option<String>, Vec<DecodedCtcToken>), AppError> {
        let fbank = self.fbank.compute_fbank(slice, !self.normalize_samples);
        let raw_frames = fbank.len() / FBANK_NUM_BINS;
        if raw_frames == 0 {
            return Ok((None, Vec::new()));
        }
        let (lfr_frames, lfr_feats) = apply_lfr_and_cmvn(
            &fbank,
            raw_frames,
            self.lfr_window_size,
            self.lfr_window_shift,
            &self.neg_mean,
            &self.inv_stddev,
        );
        if lfr_frames == 0 {
            return Ok((None, Vec::new()));
        }

        let feat_dim = (FBANK_NUM_BINS * self.lfr_window_size) as i64;
        let x_len = [lfr_frames as i32];
        let lang_val = [self.language_id(language)];
        let itn_val = [if use_itn {
            self.with_itn_id
        } else {
            self.without_itn_id
        }];

        let outs = self.asr.run_multi_f32_outputs(
            &[
                (
                    "x",
                    OrtInput::F32(&[1, lfr_frames as i64, feat_dim], &lfr_feats),
                ),
                ("x_length", OrtInput::I32(&[1], &x_len)),
                ("language", OrtInput::I32(&[1], &lang_val)),
                ("text_norm", OrtInput::I32(&[1], &itn_val)),
            ],
            &["logits"],
        )?;

        let (ref dims, ref logits) = outs[0];
        if dims.len() != 3 {
            return Err(AppError::new(
                "ASR_INFERENCE_FAILED",
                format!("Unexpected SenseVoice logits shape: {dims:?}"),
            ));
        }
        let total_steps = dims[1] as usize;
        let vocab_size = dims[2] as usize;
        if total_steps <= 4 || vocab_size == 0 {
            return Ok((None, Vec::new()));
        }

        // Prefix timestep 0 predicts the language tag (e.g. `<|zh|>`, `<|en|>`, `<|nospeech|>`).
        let lang_token = argmax_token(logits, 0, vocab_size)
            .and_then(|id| self.tokens.get(id))
            .map(|s| s.as_str())
            .unwrap_or("");
        if lang_token == "<|nospeech|>" {
            return Ok((None, Vec::new()));
        }
        let detected_lang = parse_sensevoice_lang_tag(lang_token);

        // Greedy CTC decode over acoustic timesteps `4..total_steps`
        let mut prev_id = 0usize;
        let mut decoded: Vec<DecodedCtcToken> = Vec::new();
        for t in 4..total_steps {
            let Some(best_id) = argmax_token(logits, t, vocab_size) else {
                continue;
            };
            if best_id != 0 && best_id != prev_id {
                if let Some(tok) = self.tokens.get(best_id) {
                    if !is_sensevoice_special_token(tok) {
                        decoded.push(DecodedCtcToken {
                            text: tok.clone(),
                            frame_idx: t - 4,
                        });
                    }
                }
            }
            prev_id = best_id;
        }

        Ok((detected_lang, decoded))
    }

    /// Runs full VAD + SenseVoiceSmall transcription on decoded 16 kHz mono audio, returning
    /// strictly monotonic, timeline-aligned subtitle segments.
    #[allow(clippy::too_many_arguments)]
    pub fn transcribe_samples<F>(
        &self,
        decoded: &DecodedMono16k,
        input_path: &str,
        file_name: &str,
        language: AsrLanguage,
        use_itn: bool,
        cancel_flag: &AtomicBool,
        mut on_progress: F,
    ) -> Result<TranscribeMediaResult, AppError>
    where
        F: FnMut(&str, usize, usize, f64, &str),
    {
        let t0 = Instant::now();
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(AppError::cancelled());
        }

        on_progress(
            "vad",
            0,
            0,
            12.0,
            "Detecting speech segments (Silero VAD v5)...",
        );
        let regions = self.detect_vad_regions(&decoded.samples, cancel_flag)?;
        let total_regions = regions.len();
        let mut segments: Vec<TranscriptSegment> = Vec::new();
        let mut lang_set: Vec<String> = Vec::new();
        let mut speech_duration_sec = 0.0f64;
        let mut warnings = Vec::new();

        if total_regions == 0 {
            warnings.push(
                "No speech segments were detected (the audio appears silent or below speech threshold)."
                    .to_string(),
            );
        }

        let frame_step_sec = (self.lfr_window_shift as f64) * (FBANK_FRAME_SHIFT as f64)
            / f64::from(ASR_SAMPLE_RATE);

        for (idx, reg) in regions.iter().enumerate() {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err(AppError::cancelled());
            }
            let pct = 18.0 + ((idx as f64) / (total_regions.max(1) as f64)) * 78.0;
            on_progress(
                "transcribing",
                idx + 1,
                total_regions,
                pct,
                &format!("Transcribing segment {}/{total_regions}...", idx + 1),
            );

            let slice = &decoded.samples[reg.start_sample..reg.end_sample];
            // Decoded WAV sample 0 is already aligned to media playback zero (with audio-only
            // initial delays and mid-stream PTS gaps preserved as silence inside `decoded.samples`).
            let reg_start_sec = reg.start_sample as f64 / f64::from(ASR_SAMPLE_RATE);
            let reg_end_sec = reg.end_sample as f64 / f64::from(ASR_SAMPLE_RATE);

            let (det_lang, ctc_tokens) = self.recognize_slice(slice, language, use_itn)?;
            if ctc_tokens.is_empty() {
                continue;
            }
            if let Some(ref l) = det_lang {
                if !lang_set.contains(l) {
                    lang_set.push(l.clone());
                }
            }

            let sub_segs = build_subsegments_from_ctc(
                &ctc_tokens,
                reg_start_sec,
                reg_end_sec,
                frame_step_sec,
                det_lang,
            );
            for mut seg in sub_segs {
                if seg.text.trim().is_empty() {
                    continue;
                }
                // Enforce strict monotonic non-overlapping timeline order
                if let Some(prev) = segments.last() {
                    if seg.start_sec < prev.end_sec {
                        seg.start_sec = prev.end_sec;
                    }
                }
                if seg.end_sec <= seg.start_sec + 0.02 {
                    seg.end_sec = seg.start_sec + 0.08;
                }
                if decoded.duration_sec > 0.0 && seg.end_sec > decoded.duration_sec + 0.05 {
                    seg.end_sec = decoded.duration_sec.max(seg.start_sec + 0.05);
                }
                seg.start_sec = round_ms(seg.start_sec);
                seg.end_sec = round_ms(seg.end_sec.max(seg.start_sec + 0.02));
                speech_duration_sec += (seg.end_sec - seg.start_sec).max(0.0);
                seg.id = segments.len() + 1;
                segments.push(seg);
            }
        }

        let full_text = segments
            .iter()
            .map(|s| s.text.trim())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n");

        let elapsed_ms = t0.elapsed().as_millis() as u64;
        let rtf = if decoded.duration_sec > 0.05 {
            ((elapsed_ms as f64 / 1000.0) / decoded.duration_sec * 10_000.0).round() / 10_000.0
        } else {
            0.0
        };

        on_progress(
            "completed",
            total_regions,
            total_regions,
            100.0,
            "Completed",
        );

        Ok(TranscribeMediaResult {
            input_path: input_path.to_string(),
            file_name: file_name.to_string(),
            duration_sec: round_ms(decoded.duration_sec),
            timeline_offset_sec: round_ms(decoded.timeline_offset_sec),
            decoded_with_ffmpeg: decoded.decoded_with_ffmpeg,
            engine_name: format!(
                "SenseVoiceSmall INT8 + Silero VAD v5 (ONNX Runtime {} CPU)",
                self.runtime_version
            ),
            segments,
            full_text,
            detected_languages: lang_set,
            speech_duration_sec: round_ms(speech_duration_sec),
            elapsed_ms,
            rtf,
            warnings,
        })
    }
}

fn round_ms(sec: f64) -> f64 {
    if !sec.is_finite() || sec < 0.0 {
        0.0
    } else {
        (sec * 1000.0).round() / 1000.0
    }
}

fn argmax_token(logits: &[f32], step: usize, vocab_size: usize) -> Option<usize> {
    let base = step.checked_mul(vocab_size)?;
    let row = logits.get(base..base + vocab_size)?;
    let mut best_idx = 0usize;
    let mut best_val = f32::NEG_INFINITY;
    for (idx, &v) in row.iter().enumerate() {
        if v > best_val {
            best_val = v;
            best_idx = idx;
        }
    }
    Some(best_idx)
}

fn load_tokens_table(path: &Path) -> Result<Vec<String>, AppError> {
    let file = File::open(path)
        .map_err(|e| AppError::from_io(e, "Unable to open SenseVoice tokens.txt"))?;
    let reader = BufReader::new(file);
    let mut pairs: Vec<(usize, String)> = Vec::with_capacity(25_100);
    let mut max_id = 0usize;

    for line_res in reader.lines() {
        let line =
            line_res.map_err(|e| AppError::from_io(e, "Unable to read SenseVoice tokens.txt"))?;
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            continue;
        }
        let Some((tok, id_str)) = trimmed.rsplit_once(' ') else {
            continue;
        };
        if let Ok(id) = id_str.trim().parse::<usize>() {
            max_id = max_id.max(id);
            pairs.push((id, tok.to_string()));
        }
    }
    if pairs.is_empty() {
        return Err(AppError::new(
            "ASR_MODEL_INVALID",
            "SenseVoice tokens.txt is empty or malformed.",
        ));
    }
    let mut table = vec![String::new(); max_id + 1];
    for (id, tok) in pairs {
        table[id] = tok;
    }
    Ok(table)
}

fn is_sensevoice_special_token(tok: &str) -> bool {
    tok.is_empty()
        || tok == "<unk>"
        || tok == "<s>"
        || tok == "</s>"
        || (tok.starts_with("<|") && tok.ends_with("|>"))
}

fn parse_sensevoice_lang_tag(tok: &str) -> Option<String> {
    let inner = tok.strip_prefix("<|")?.strip_suffix("|>")?;
    match inner {
        "zh" | "en" | "yue" | "ja" | "ko" => Some(inner.to_string()),
        _ => None,
    }
}

/// Joins SentencePiece subwords (`▁` = U+2581) into natural Chinese + English text.
fn detokenize_sentencepiece(tokens: &[DecodedCtcToken]) -> String {
    let mut raw = String::new();
    for tok in tokens {
        raw.push_str(&tok.text.replace('\u{2581}', " "));
    }
    let mut out = String::with_capacity(raw.len());
    let mut prev_was_space = false;
    for ch in raw.chars() {
        if ch.is_whitespace() {
            if !out.is_empty() && !prev_was_space {
                out.push(' ');
                prev_was_space = true;
            }
        } else {
            out.push(ch);
            prev_was_space = false;
        }
    }
    out.trim().to_string()
}

fn is_sentence_break_token(tok: &str) -> bool {
    let cleaned = tok.replace('\u{2581}', "");
    cleaned.ends_with('。')
        || cleaned.ends_with('！')
        || cleaned.ends_with('？')
        || cleaned.ends_with('.')
        || cleaned.ends_with('!')
        || cleaned.ends_with('?')
}

/// Keeps normal VAD segments intact, and splits long >10 s utterances cleanly on sentence-ending
/// punctuation using CTC frame timestamps so exported SRT subtitles remain readable.
fn build_subsegments_from_ctc(
    tokens: &[DecodedCtcToken],
    reg_start_sec: f64,
    reg_end_sec: f64,
    frame_step_sec: f64,
    language: Option<String>,
) -> Vec<TranscriptSegment> {
    let reg_dur = (reg_end_sec - reg_start_sec).max(0.05);
    let full = detokenize_sentencepiece(tokens);
    if full.is_empty() {
        return Vec::new();
    }
    if reg_dur <= 10.5 && full.chars().count() <= 80 {
        return vec![TranscriptSegment {
            id: 0,
            start_sec: reg_start_sec,
            end_sec: reg_end_sec,
            text: full,
            language,
        }];
    }

    let mut out = Vec::new();
    let mut group_start = 0usize;
    let mut prev_end_sec = reg_start_sec;

    for i in 0..tokens.len() {
        let is_last = i + 1 == tokens.len();
        let should_break = if is_last {
            true
        } else if is_sentence_break_token(&tokens[i].text) {
            let chunk_start_t =
                reg_start_sec + (tokens[group_start].frame_idx as f64) * frame_step_sec;
            let chunk_end_t = reg_start_sec + ((tokens[i].frame_idx + 1) as f64) * frame_step_sec;
            (chunk_end_t - chunk_start_t) >= 2.2
        } else {
            false
        };

        if should_break {
            let text = detokenize_sentencepiece(&tokens[group_start..=i]);
            if !text.is_empty() {
                let s = if out.is_empty() {
                    reg_start_sec
                } else {
                    (reg_start_sec + (tokens[group_start].frame_idx as f64) * frame_step_sec)
                        .max(prev_end_sec)
                        .min(reg_end_sec - 0.05)
                };
                let e = if is_last {
                    reg_end_sec
                } else {
                    (reg_start_sec + ((tokens[i].frame_idx + 2) as f64) * frame_step_sec)
                        .max(s + 0.1)
                        .min(reg_end_sec)
                };
                prev_end_sec = e;
                out.push(TranscriptSegment {
                    id: 0,
                    start_sec: s,
                    end_sec: e,
                    text,
                    language: language.clone(),
                });
            }
            group_start = i + 1;
        }
    }

    if out.is_empty() {
        out.push(TranscriptSegment {
            id: 0,
            start_sec: reg_start_sec,
            end_sec: reg_end_sec,
            text: full,
            language,
        });
    }
    out
}

// ============================================================================
// Subtitle Order Validation, SRT / TXT Formatting & Safe Non-Destructive Export
// ============================================================================

pub fn format_srt_timestamp(sec: f64) -> String {
    let total_ms = if sec.is_finite() && sec > 0.0 {
        (sec * 1000.0).round() as u64
    } else {
        0
    };
    let ms = total_ms % 1000;
    let total_s = total_ms / 1000;
    let s = total_s % 60;
    let total_m = total_s / 60;
    let m = total_m % 60;
    let h = total_m / 60;
    format!("{h:02}:{m:02}:{s:02},{ms:03}")
}

/// Strictly validates subtitle cue ordering (`start >= 0`, `end > start`, monotonic non-overlapping).
pub fn validate_subtitle_segments(segments: &[TranscriptSegment]) -> Result<(), AppError> {
    if segments.is_empty() {
        return Err(AppError::invalid_param(
            "No transcript segments are available to export.",
        ));
    }
    let mut prev_start = -1.0f64;
    let mut prev_end = -1.0f64;
    for (idx, seg) in segments.iter().enumerate() {
        let num = idx + 1;
        if !seg.start_sec.is_finite() || !seg.end_sec.is_finite() {
            return Err(AppError::invalid_param(format!(
                "Subtitle cue #{num} contains a non-finite timestamp."
            )));
        }
        if seg.start_sec < 0.0 {
            return Err(AppError::invalid_param(format!(
                "Subtitle cue #{num} has a negative start time ({:.3}s).",
                seg.start_sec
            )));
        }
        if seg.end_sec <= seg.start_sec {
            return Err(AppError::invalid_param(format!(
                "Subtitle cue #{num} end time ({:.3}s) must be greater than start time ({:.3}s).",
                seg.end_sec, seg.start_sec
            )));
        }
        if idx > 0 {
            if seg.start_sec + 1e-6 < prev_start {
                return Err(AppError::invalid_param(format!(
                    "Subtitle cue #{num} starts ({:.3}s) before cue #{} ({:.3}s).",
                    seg.start_sec, idx, prev_start
                )));
            }
            if seg.start_sec + 1e-6 < prev_end {
                return Err(AppError::invalid_param(format!(
                    "Subtitle cue #{num} ({:.3}s) overlaps cue #{} end ({:.3}s).",
                    seg.start_sec, idx, prev_end
                )));
            }
        }
        prev_start = seg.start_sec;
        prev_end = seg.end_sec;
    }
    Ok(())
}

/// Normalizes a single subtitle cue's text identically across frontend copy and Rust export:
/// preserves normal multi-line subtitles while stripping blank lines and whitespace-only lines
/// (including spaces, tabs, and full-width spaces) so one cue can never split into malformed SRT blocks.
pub fn sanitize_srt_cue_text(raw: &str) -> String {
    raw.replace("\r\n", "\n")
        .replace('\r', "\n")
        .split('\n')
        .map(|line| line.trim_end())
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\r\n")
}

pub fn format_segments_to_srt(segments: &[TranscriptSegment]) -> Result<String, AppError> {
    let mut sanitized: Vec<TranscriptSegment> = Vec::with_capacity(segments.len());
    for seg in segments {
        let body = sanitize_srt_cue_text(&seg.text);
        if body.is_empty() {
            continue;
        }
        let mut cloned = seg.clone();
        cloned.text = body;
        sanitized.push(cloned);
    }
    if sanitized.is_empty() {
        return Err(AppError::invalid_param(
            "No non-empty transcript segments to export as SRT.",
        ));
    }
    validate_subtitle_segments(&sanitized)?;

    let mut out = String::with_capacity(sanitized.len() * 64);
    for (idx, seg) in sanitized.iter().enumerate() {
        let num = idx + 1;
        let start = format_srt_timestamp(seg.start_sec);
        let end = format_srt_timestamp(seg.end_sec);
        out.push_str(&format!(
            "{num}\r\n{start} --> {end}\r\n{}\r\n\r\n",
            seg.text
        ));
    }
    Ok(out)
}

pub fn format_segments_to_txt(segments: &[TranscriptSegment], include_timestamps: bool) -> String {
    let mut lines = Vec::new();
    for seg in segments {
        let body = sanitize_srt_cue_text(&seg.text);
        if body.is_empty() {
            continue;
        }
        if include_timestamps {
            lines.push(format!(
                "[{} -> {}] {}",
                format_srt_timestamp(seg.start_sec),
                format_srt_timestamp(seg.end_sec),
                body
            ));
        } else {
            lines.push(body);
        }
    }
    lines.join("\r\n")
}

/// Atomically writes TXT or validated SRT transcript output while rejecting overwrites of any
/// source media file (`SAME_INPUT_AND_OUTPUT`) or existing target unless `overwrite = true`.
pub fn export_transcript_file_impl(
    req: &ExportTranscriptRequest,
) -> Result<ExportTranscriptResult, AppError> {
    let out_path = validate_user_path(&req.output_path, "Transcript output path")?;
    let mut forbidden: Vec<PathBuf> = Vec::with_capacity(req.forbidden_source_paths.len());
    for raw in &req.forbidden_source_paths {
        if raw.trim().is_empty() {
            continue;
        }
        let p = PathBuf::from(raw.trim());
        if paths_refer_to_same_location(&p, &out_path) {
            return Err(AppError::new(
                "SAME_INPUT_AND_OUTPUT",
                "Cannot overwrite the source audio/video file with a transcript export. Choose a different output path.",
            ));
        }
        forbidden.push(p);
    }

    let content = match req.format {
        TranscriptExportFormat::Srt => format_segments_to_srt(&req.segments)?,
        TranscriptExportFormat::Txt => format_segments_to_txt(&req.segments, false),
        TranscriptExportFormat::TxtTimestamped => format_segments_to_txt(&req.segments, true),
    };

    if content.trim().is_empty() {
        return Err(AppError::invalid_param(
            "Transcript text is empty; nothing to export.",
        ));
    }

    let primary_source = forbidden
        .first()
        .map(|p| p.as_path())
        .unwrap_or_else(|| Path::new(""));
    let atomic = AtomicMediaOutput::prepare(out_path, primary_source, req.overwrite)?;
    let bytes = content.as_bytes();
    fs::write(atomic.temp_path(), bytes)
        .map_err(|e| AppError::from_io(e, "Failed to write temporary transcript file"))?;
    let (final_path, byte_size) = atomic.commit(req.overwrite)?;
    let segment_count = req
        .segments
        .iter()
        .filter(|s| !sanitize_srt_cue_text(&s.text).is_empty())
        .count();

    Ok(ExportTranscriptResult {
        output_path: final_path.to_string_lossy().into_owned(),
        byte_size,
        segment_count,
        format: req.format,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media_subtitles::parse_subtitle_file_impl;
    use tempfile::tempdir;

    #[test]
    fn srt_formatting_validates_monotonic_order_and_roundtrips_through_v02_parser() {
        let dir = tempdir().expect("tempdir");
        let segs = vec![
            TranscriptSegment {
                id: 1,
                start_sec: 0.512,
                end_sec: 4.25,
                text: "欢迎使用 WinKit 离线转写".into(),
                language: Some("zh".into()),
            },
            TranscriptSegment {
                id: 2,
                start_sec: 10.75,
                end_sec: 14.9,
                text: "Every file stays local with zero uploads.".into(),
                language: Some("en".into()),
            },
        ];

        let srt = format_segments_to_srt(&segs).expect("format srt");
        assert!(srt.contains("00:00:00,512 --> 00:00:04,250"));
        assert!(srt.contains("00:00:10,750 --> 00:00:14,900"));

        let srt_path = dir.path().join("roundtrip_字幕.srt");
        let src_wav = dir.path().join("source.wav");
        fs::write(&src_wav, b"RIFF0000WAVE").expect("write source");

        // Same-path overwrite against source media must be rejected!
        let same_err = export_transcript_file_impl(&ExportTranscriptRequest {
            output_path: src_wav.to_string_lossy().into_owned(),
            format: TranscriptExportFormat::Srt,
            segments: segs.clone(),
            forbidden_source_paths: vec![src_wav.to_string_lossy().into_owned()],
            overwrite: true,
        })
        .unwrap_err();
        assert_eq!(same_err.code, "SAME_INPUT_AND_OUTPUT");

        // Export valid SRT and verify WinKit's own V02 subtitle parser parses it cleanly!
        let res = export_transcript_file_impl(&ExportTranscriptRequest {
            output_path: srt_path.to_string_lossy().into_owned(),
            format: TranscriptExportFormat::Srt,
            segments: segs,
            forbidden_source_paths: vec![src_wav.to_string_lossy().into_owned()],
            overwrite: false,
        })
        .expect("export srt");
        assert_eq!(res.segment_count, 2);

        let parsed = parse_subtitle_file_impl(&srt_path.to_string_lossy()).expect("v02 parse srt");
        assert_eq!(parsed.cue_count, 2);
        assert!((parsed.cues[0].start_sec - 0.512).abs() < 0.002);
        assert!((parsed.cues[1].end_sec - 14.9).abs() < 0.002);
        assert!(parsed.cues[0].text.contains("WinKit"));
        assert!(parsed.cues[1].text.contains("zero uploads"));

        // Out-of-order / overlapping timestamps MUST be rejected!
        let overlap_err = format_segments_to_srt(&[
            TranscriptSegment {
                id: 1,
                start_sec: 2.0,
                end_sec: 5.0,
                text: "First".into(),
                language: None,
            },
            TranscriptSegment {
                id: 2,
                start_sec: 4.5,
                end_sec: 6.0,
                text: "Overlaps first".into(),
                language: None,
            },
        ])
        .unwrap_err();
        assert_eq!(overlap_err.code, "INVALID_PARAMETER");
    }

    #[test]
    fn native_wav_decoder_reads_pcm16_stereo_48k_and_resamples_to_mono_16k() {
        let dir = tempdir().expect("tempdir");
        let wav_path = dir.path().join("test_48k_stereo.wav");
        // Write 0.5 s of 48 kHz 16-bit stereo 440 Hz sine wave
        let sr = 48_000u32;
        let frames = (sr / 2) as usize;
        let data_len = (frames * 4) as u32;
        let mut buf = Vec::with_capacity(44 + data_len as usize);
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&(36 + data_len).to_le_bytes());
        buf.extend_from_slice(b"WAVEfmt ");
        buf.extend_from_slice(&16u32.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes()); // PCM
        buf.extend_from_slice(&2u16.to_le_bytes()); // stereo
        buf.extend_from_slice(&sr.to_le_bytes());
        buf.extend_from_slice(&(sr * 4).to_le_bytes());
        buf.extend_from_slice(&4u16.to_le_bytes());
        buf.extend_from_slice(&16u16.to_le_bytes());
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&data_len.to_le_bytes());
        for i in 0..frames {
            let s = ((2.0 * PI * 440.0 * (i as f32) / (sr as f32)).sin() * 16000.0) as i16;
            buf.extend_from_slice(&s.to_le_bytes());
            buf.extend_from_slice(&s.to_le_bytes());
        }
        fs::write(&wav_path, &buf).expect("write wav");

        let decoded = decode_wav_native_to_mono_16k(&wav_path)
            .expect("decode wav")
            .expect("native pcm wav");
        assert!(!decoded.decoded_with_ffmpeg);
        assert!((decoded.duration_sec - 0.5).abs() < 0.01);
        assert!((decoded.samples.len() as isize - 8_000).abs() <= 4);

        let fbank = KaldiFbankExtractor::new();
        let fb = fbank.compute_fbank(&decoded.samples, true);
        let n_frames = fb.len() / FBANK_NUM_BINS;
        assert!((45..=52).contains(&n_frames), "got {n_frames} fbank frames");
        assert!(fb.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn multiline_srt_with_blank_and_whitespace_lines_roundtrips_as_single_cue_in_v02() {
        let dir = tempdir().expect("tempdir");
        let segs = vec![
            TranscriptSegment {
                id: 1,
                start_sec: 0.5,
                end_sec: 4.2,
                text: "第一行中文校对   \r\n\r\n   \n\t\n\u{3000}\nSecond English line\n\n".into(),
                language: Some("zh".into()),
            },
            TranscriptSegment {
                id: 2,
                start_sec: 4.5,
                end_sec: 6.0,
                text: "   \n\t\n\u{3000}  ".into(), // whitespace-only cue must be skipped cleanly
                language: None,
            },
            TranscriptSegment {
                id: 3,
                start_sec: 6.2,
                end_sec: 9.8,
                text: "Line A\rLine B  \n\n\n第三行中英混排".into(),
                language: Some("en".into()),
            },
        ];

        let srt = format_segments_to_srt(&segs).expect("format srt");
        assert!(srt.contains(
            "1\r\n00:00:00,500 --> 00:00:04,200\r\n第一行中文校对\r\nSecond English line\r\n\r\n"
        ));
        assert!(srt.contains(
            "2\r\n00:00:06,200 --> 00:00:09,800\r\nLine A\r\nLine B\r\n第三行中英混排\r\n\r\n"
        ));

        let out_srt = dir.path().join("multiline_bilingual.srt");
        let res = export_transcript_file_impl(&ExportTranscriptRequest {
            output_path: out_srt.to_string_lossy().into_owned(),
            format: TranscriptExportFormat::Srt,
            segments: segs,
            forbidden_source_paths: vec![],
            overwrite: false,
        })
        .expect("export multiline srt");
        assert_eq!(res.segment_count, 2);

        // Roundtrip through V02 subtitle parser — each edited segment MUST stay ONE cue!
        let parsed = parse_subtitle_file_impl(&out_srt.to_string_lossy()).expect("v02 parse");
        assert_eq!(parsed.cue_count, 2);
        assert_eq!(parsed.cues[0].text, "第一行中文校对\nSecond English line");
        assert_eq!(parsed.cues[1].text, "Line A\nLine B\n第三行中英混排");
    }

    #[test]
    fn wav_inspect_and_decode_honor_riff_data_chunk_and_shared_512mib_cap() {
        let dir = tempdir().expect("tempdir");
        let wav_path = dir.path().join("with_trailing_list.wav");
        let sr = 16_000u32;
        let frames = 8_000usize; // exact 0.500 s
        let data_len = (frames * 2) as u32;
        let junk_payload = vec![0x7Fu8; 40_000]; // 40 KB trailing LIST/INFO chunk (~1.25 s if wrongly counted!)
        let riff_size = 36 + data_len + 8 + junk_payload.len() as u32;

        let mut buf = Vec::with_capacity((riff_size + 8) as usize);
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&riff_size.to_le_bytes());
        buf.extend_from_slice(b"WAVEfmt ");
        buf.extend_from_slice(&16u32.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes());
        buf.extend_from_slice(&sr.to_le_bytes());
        buf.extend_from_slice(&(sr * 2).to_le_bytes());
        buf.extend_from_slice(&2u16.to_le_bytes());
        buf.extend_from_slice(&16u16.to_le_bytes());
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&data_len.to_le_bytes());
        for i in 0..frames {
            let s = ((2.0 * PI * 440.0 * (i as f32) / (sr as f32)).sin() * 12000.0) as i16;
            buf.extend_from_slice(&s.to_le_bytes());
        }
        buf.extend_from_slice(b"LIST");
        buf.extend_from_slice(&(junk_payload.len() as u32).to_le_bytes());
        buf.extend_from_slice(&junk_payload);
        fs::write(&wav_path, &buf).expect("write wav with trailing LIST");

        // Inspection must compute exact 0.500 s from RIFF `data` chunk (ignoring trailing 40 KB LIST)
        let inspected = inspect_transcribe_media_impl(dir.path(), &wav_path.to_string_lossy())
            .expect("inspect wav");
        assert!(inspected.is_wav_native);
        assert!(!inspected.requires_ffmpeg);
        let dur = inspected.duration_sec.expect("duration");
        assert!(
            (dur - 0.5).abs() < 0.005,
            "expected 0.5s from data chunk, got {dur}s"
        );

        // Native streaming decode must read exact 8,000 samples (ignoring trailing LIST metadata)
        let decoded = decode_wav_native_to_mono_16k(&wav_path)
            .expect("decode")
            .expect("native");
        assert_eq!(decoded.samples.len(), 8_000);
        assert!((decoded.duration_sec - 0.5).abs() < 0.005);

        // Shared eligibility check: a file exceeding MAX_NATIVE_WAV_BYTES reports requires_ffmpeg=true
        let over_cap = inspect_wav_native_eligibility(&wav_path, MAX_NATIVE_WAV_BYTES + 1024)
            .expect("elig")
            .expect("wav header");
        assert!(!over_cap.can_decode_natively);
        assert!((over_cap.header.duration_sec - 0.5).abs() < 0.005);
    }

    #[test]
    fn timeline_alignment_handles_container_offset_audio_delay_and_midstream_gap_with_v02_burnin() {
        use crate::media_subtitles::{
            burn_in_subtitles_impl, BurnInSubtitlesRequest, SubtitleBoxStyle, SubtitleBurnStyle,
            SubtitlePosition,
        };
        let dir = tempdir().expect("tempdir");
        let Ok(tools) = require_media_tools(dir.path()) else {
            return;
        };
        let run_ff = |args: &[&str]| {
            let mut cmd = Command::new(&tools.ffmpeg);
            configure_hidden_command(&mut cmd);
            let out = cmd
                .args(["-y", "-hide_banner", "-loglevel", "error"])
                .args(args)
                .output()
                .expect("run ffmpeg");
            assert!(
                out.status.success(),
                "ffmpeg failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };

        let tone = dir.path().join("tone.wav");
        run_ff(&[
            "-f",
            "lavfi",
            "-i",
            "sine=f=440:r=16000:d=1.5",
            &tone.to_string_lossy(),
        ]);

        // 1. Whole container non-zero start (+10.0s)
        let case1 = dir.path().join("case1_container_10s.mkv");
        run_ff(&[
            "-f",
            "lavfi",
            "-i",
            "color=c=#102040:s=320x240:r=24:d=4.0",
            "-i",
            &tone.to_string_lossy(),
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-output_ts_offset",
            "10.0",
            &case1.to_string_lossy(),
        ]);

        // 2. Audio-only delay (+2.5s)
        let case2 = dir.path().join("case2_audio_delay.mp4");
        run_ff(&[
            "-f",
            "lavfi",
            "-i",
            "color=c=#102040:s=320x240:r=24:d=5.5",
            "-itsoffset",
            "2.5",
            "-i",
            &tone.to_string_lossy(),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-t",
            "5.5",
            &case2.to_string_lossy(),
        ]);

        // 3. Mid-stream audio PTS gap (0.5..2.0s, 4.0s gap, 6.0..7.5s)
        let case3 = dir.path().join("case3_midgap.mkv");
        run_ff(&[
            "-f",
            "lavfi",
            "-i",
            "color=c=#102040:s=320x240:r=24:d=8.5",
            "-f",
            "lavfi",
            "-i",
            "sine=f=440:r=16000:d=3.0",
            "-filter_complex",
            "[1:a]asetpts=if(lt(T\\,1.5)\\,PTS+0.5/TB\\,PTS+4.5/TB)[agap]",
            "-map",
            "0:v:0",
            "-map",
            "[agap]",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-t",
            "8.5",
            &case3.to_string_lossy(),
        ]);

        let active_ranges = |samples: &[f32]| -> Vec<(f64, f64)> {
            let win = (ASR_SAMPLE_RATE / 20) as usize; // 50 ms
            let mut out = Vec::new();
            let mut in_seg = false;
            let mut s0 = 0.0;
            for (idx, chunk) in samples.chunks(win).enumerate() {
                let peak = chunk.iter().map(|v| v.abs()).fold(0.0f32, f32::max);
                let t = (idx * win) as f64 / f64::from(ASR_SAMPLE_RATE);
                if peak > 0.05 && !in_seg {
                    in_seg = true;
                    s0 = t;
                } else if peak <= 0.05 && in_seg {
                    in_seg = false;
                    out.push((s0, t));
                }
            }
            if in_seg {
                out.push((s0, samples.len() as f64 / f64::from(ASR_SAMPLE_RATE)));
            }
            out
        };

        let cancel = AtomicBool::new(false);

        // Verify Case 1: whole container +10s -> playback zero (0.0s)
        let i1 = inspect_transcribe_media_impl(dir.path(), &case1.to_string_lossy()).expect("i1");
        assert!(
            i1.audio_start_time_sec < 0.05,
            "whole-container offset must normalize to 0.0s, got {}",
            i1.audio_start_time_sec
        );
        let d1 = decode_media_to_mono_16k(dir.path(), &case1, &cancel, |_| {}).expect("d1");
        let r1 = active_ranges(&d1.samples);
        assert_eq!(r1.len(), 1, "case1 active ranges: {r1:?}");
        assert!(r1[0].0 < 0.15, "case1 should begin near 0.0s: {r1:?}");

        // Verify Case 2: audio-only delay +2.5s -> preserved at 2.5s
        let i2 = inspect_transcribe_media_impl(dir.path(), &case2.to_string_lossy()).expect("i2");
        assert!(
            (i2.audio_start_time_sec - 2.45).abs() < 0.25,
            "case2 relative delay expected ~2.5s, got {}",
            i2.audio_start_time_sec
        );
        let d2 = decode_media_to_mono_16k(dir.path(), &case2, &cancel, |_| {}).expect("d2");
        let r2 = active_ranges(&d2.samples);
        assert_eq!(r2.len(), 1, "case2 active ranges: {r2:?}");
        assert!(
            (r2[0].0 - 2.5).abs() < 0.15,
            "case2 audio onset should stay at ~2.5s: {r2:?}"
        );

        // Verify Case 3: mid-stream gap -> BOTH 0.5s initial delay AND 4.0s gap preserved!
        let d3 = decode_media_to_mono_16k(dir.path(), &case3, &cancel, |_| {}).expect("d3");
        let r3 = active_ranges(&d3.samples);
        assert_eq!(r3.len(), 2, "case3 must preserve mid-stream gap: {r3:?}");
        assert!(
            (r3[0].0 - 0.5).abs() < 0.15,
            "case3 seg1 start ~0.5s: {r3:?}"
        );
        assert!(
            (r3[1].0 - 6.0).abs() < 0.2,
            "case3 seg2 start ~6.0s: {r3:?}"
        );

        // Verify V02 actual burn-in pixel timing using SRT exported directly from Case 3 decoded ranges!
        let srt3 = dir.path().join("case3.srt");
        export_transcript_file_impl(&ExportTranscriptRequest {
            output_path: srt3.to_string_lossy().into_owned(),
            format: TranscriptExportFormat::Srt,
            segments: vec![
                TranscriptSegment {
                    id: 1,
                    start_sec: r3[0].0,
                    end_sec: r3[0].1,
                    text: "GAP_SEG_ONE".into(),
                    language: None,
                },
                TranscriptSegment {
                    id: 2,
                    start_sec: r3[1].0,
                    end_sec: r3[1].1,
                    text: "GAP_SEG_TWO".into(),
                    language: None,
                },
            ],
            forbidden_source_paths: vec![case3.to_string_lossy().into_owned()],
            overwrite: false,
        })
        .expect("export case3 srt");

        let burned3 = dir.path().join("case3_burned.mp4");
        burn_in_subtitles_impl(
            dir.path(),
            &BurnInSubtitlesRequest {
                task_id: "t01-v02-gap-check".into(),
                video_path: case3.to_string_lossy().into_owned(),
                subtitle_path: srt3.to_string_lossy().into_owned(),
                output_path: burned3.to_string_lossy().into_owned(),
                style: SubtitleBurnStyle {
                    font_size: 72,
                    position: SubtitlePosition::Bottom,
                    box_style: SubtitleBoxStyle::OutlineShadow,
                    font_name: None,
                    margin_v: Some(24),
                },
                allow_overwrite: Some(true),
            },
            &cancel,
            |_| {},
        )
        .expect("v02 burn case3");

        let count_bright_bottom_pixels = |mp4: &Path, t_sec: f64| -> usize {
            let png = dir.path().join(format!("frame_{:.1}.png", t_sec));
            run_ff(&[
                "-ss",
                &format!("{t_sec:.2}"),
                "-i",
                &mp4.to_string_lossy(),
                "-frames:v",
                "1",
                &png.to_string_lossy(),
            ]);
            let img = image::open(&png).expect("open frame").to_rgb8();
            let (w, h) = img.dimensions();
            let mut bright = 0usize;
            for y in (h / 2)..h {
                for x in 0..w {
                    let p = img.get_pixel(x, y);
                    if p[0] > 190 && p[1] > 190 && p[2] > 190 {
                        bright += 1;
                    }
                }
            }
            bright
        };

        let px_seg1 = count_bright_bottom_pixels(&burned3, 1.2);
        let px_gap = count_bright_bottom_pixels(&burned3, 4.0);
        let px_seg2 = count_bright_bottom_pixels(&burned3, 6.7);
        assert!(
            px_seg1 > 50,
            "expected burned subtitle in seg1 (1.2s), got {px_seg1}"
        );
        assert_eq!(
            px_gap, 0,
            "expected ZERO subtitle pixels inside 4.0s gap, got {px_gap}"
        );
        assert!(
            px_seg2 > 50,
            "expected burned subtitle in seg2 (6.7s), got {px_seg2}"
        );

        // Also verify V02 burn-in pixel timing on Case 1 (container +10s -> plays from 0.0s) and Case 2 (audio delay +2.5s)!
        let srt1 = dir.path().join("case1.srt");
        export_transcript_file_impl(&ExportTranscriptRequest {
            output_path: srt1.to_string_lossy().into_owned(),
            format: TranscriptExportFormat::Srt,
            segments: vec![TranscriptSegment {
                id: 1,
                start_sec: r1[0].0,
                end_sec: r1[0].1,
                text: "CONTAINER_ZERO".into(),
                language: None,
            }],
            forbidden_source_paths: vec![case1.to_string_lossy().into_owned()],
            overwrite: false,
        })
        .expect("export case1 srt");
        let burned1 = dir.path().join("case1_burned.mp4");
        burn_in_subtitles_impl(
            dir.path(),
            &BurnInSubtitlesRequest {
                task_id: "t01-v02-c1".into(),
                video_path: case1.to_string_lossy().into_owned(),
                subtitle_path: srt1.to_string_lossy().into_owned(),
                output_path: burned1.to_string_lossy().into_owned(),
                style: SubtitleBurnStyle {
                    font_size: 72,
                    position: SubtitlePosition::Bottom,
                    box_style: SubtitleBoxStyle::OutlineShadow,
                    font_name: None,
                    margin_v: Some(24),
                },
                allow_overwrite: Some(true),
            },
            &cancel,
            |_| {},
        )
        .expect("v02 burn case1");
        assert!(
            count_bright_bottom_pixels(&burned1, 0.8) > 50,
            "case1 subtitle must burn at playback 0.8s"
        );
        assert_eq!(
            count_bright_bottom_pixels(&burned1, 3.0),
            0,
            "case1 subtitle must disappear after 1.5s"
        );

        let srt2 = dir.path().join("case2.srt");
        export_transcript_file_impl(&ExportTranscriptRequest {
            output_path: srt2.to_string_lossy().into_owned(),
            format: TranscriptExportFormat::Srt,
            segments: vec![TranscriptSegment {
                id: 1,
                start_sec: r2[0].0,
                end_sec: r2[0].1,
                text: "AUDIO_DELAYED".into(),
                language: None,
            }],
            forbidden_source_paths: vec![case2.to_string_lossy().into_owned()],
            overwrite: false,
        })
        .expect("export case2 srt");
        let burned2 = dir.path().join("case2_burned.mp4");
        burn_in_subtitles_impl(
            dir.path(),
            &BurnInSubtitlesRequest {
                task_id: "t01-v02-c2".into(),
                video_path: case2.to_string_lossy().into_owned(),
                subtitle_path: srt2.to_string_lossy().into_owned(),
                output_path: burned2.to_string_lossy().into_owned(),
                style: SubtitleBurnStyle {
                    font_size: 72,
                    position: SubtitlePosition::Bottom,
                    box_style: SubtitleBoxStyle::OutlineShadow,
                    font_name: None,
                    margin_v: Some(24),
                },
                allow_overwrite: Some(true),
            },
            &cancel,
            |_| {},
        )
        .expect("v02 burn case2");
        assert_eq!(
            count_bright_bottom_pixels(&burned2, 1.0),
            0,
            "case2 must have zero subtitle pixels before +2.5s audio delay"
        );
        assert!(
            count_bright_bottom_pixels(&burned2, 3.2) > 50,
            "case2 subtitle must burn during delayed speech at 3.2s"
        );
    }

    #[test]
    #[ignore]
    fn pure_rust_sensevoice_parity_on_local_benchmark_corpus() {
        let model_dir = PathBuf::from(
            r"C:\Temp\WinKitDemo\t01_bench\sherpa\model\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
        );
        let vad_path = PathBuf::from(r"C:\Temp\WinKitDemo\t01_bench\sherpa\silero_vad_v5.onnx");
        assert!(model_dir.is_dir(), "benchmark model dir missing");
        assert!(vad_path.is_file(), "benchmark vad file missing");

        let assets = ResolvedAsrAssets {
            model_dir: model_dir.clone(),
            model_onnx_path: model_dir.join("model.int8.onnx"),
            tokens_path: model_dir.join("tokens.txt"),
            vad_onnx_path: vad_path,
        };
        let res_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        let engine = SenseVoiceAsrEngine::load(&assets, Some(&res_dir)).expect("load SenseVoice");
        let cancel = AtomicBool::new(false);

        for name in [
            "01_bilingual_clean.wav",
            "02_bilingual_noisy.wav",
            "03_long_pauses.wav",
            "04_alternating_noisy.wav",
        ] {
            let wav_path = PathBuf::from(r"C:\Temp\WinKitDemo\t01_bench\corpus").join(name);
            let decoded = decode_wav_native_to_mono_16k(&wav_path)
                .expect("decode")
                .expect("wav");
            let res = engine
                .transcribe_samples(
                    &decoded,
                    &wav_path.to_string_lossy(),
                    name,
                    AsrLanguage::Auto,
                    true,
                    &cancel,
                    |_, _, _, _, _| {},
                )
                .expect("transcribe");
            println!(
                "=== {name} === dur={:.2}s elapsed={}ms rtf={:.4} segs={}",
                res.duration_sec,
                res.elapsed_ms,
                res.rtf,
                res.segments.len()
            );
            for s in &res.segments {
                println!(
                    "  [{:.3} -> {:.3}] ({:?}) {}",
                    s.start_sec, s.end_sec, s.language, s.text
                );
            }
            assert!(!res.segments.is_empty(), "expected segments for {name}");
            validate_subtitle_segments(&res.segments).expect("monotonic order");
        }

        // Also test real human zh.wav & en.wav
        for sample in ["zh.wav", "en.wav"] {
            let wav_path = model_dir.join("test_wavs").join(sample);
            let decoded = decode_wav_native_to_mono_16k(&wav_path)
                .expect("decode")
                .expect("wav");
            let res = engine
                .transcribe_samples(
                    &decoded,
                    &wav_path.to_string_lossy(),
                    sample,
                    AsrLanguage::Auto,
                    true,
                    &cancel,
                    |_, _, _, _, _| {},
                )
                .expect("transcribe sample");
            println!("=== human {sample} === {}", res.full_text);
            assert!(!res.full_text.is_empty());
        }

        // Pure silence WAV must produce 0 segments and a friendly warning (zero hallucinations!)
        let silent = DecodedMono16k {
            samples: vec![0.0f32; 16_000 * 6],
            duration_sec: 6.0,
            timeline_offset_sec: 0.0,
            decoded_with_ffmpeg: false,
        };
        let silent_res = engine
            .transcribe_samples(
                &silent,
                "silent.wav",
                "silent.wav",
                AsrLanguage::Auto,
                true,
                &cancel,
                |_, _, _, _, _| {},
            )
            .expect("silent transcribe");
        println!(
            "=== silent === segs={} warnings={:?}",
            silent_res.segments.len(),
            silent_res.warnings
        );
        assert!(
            silent_res.segments.is_empty(),
            "silence must not hallucinate"
        );
        assert!(!silent_res.warnings.is_empty());
    }
}
