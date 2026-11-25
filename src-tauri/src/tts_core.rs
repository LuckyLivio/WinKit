//! Offline Windows Text-to-Speech (T06) core engine, paragraph/sentence chunking,
//! WAV PCM parser/writer, and unified native Windows voice enumeration & synthesis.
//!
//! Empirical Windows 11 x64 path selection:
//! - Primary engine: WinRT `Windows.Media.SpeechSynthesis.SpeechSynthesizer` (OneCore
//!   modern voices, including any speech packs installed by the user via
//!   `ms-settings:speech`; outputs 16 kHz / 16-bit / mono PCM WAV in memory with direct
//!   floating-point `Options.SpeakingRate`).
//! - Secondary supplement: Classic SAPI 5 COM (`ISpVoice` / `SPCAT_VOICES`), which on
//!   non-English Windows installs often provides installed English desktop voices (e.g.,
//!   `Microsoft Zira Desktop`, `en-US`) absent from OneCore. SAPI writes 22,050 Hz /
//!   16-bit / mono PCM directly into an in-memory COM `IStream` (`CreateStreamOnHGlobal`)
//!   with `SPF_IS_NOT_XML` so arbitrary user text is never interpreted as SSML/XML.
//! - Duplicate legacy SAPI Desktop entries whose base voice name + language are already
//!   provided by WinRT OneCore are deduplicated cleanly.

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::{Seek, SeekFrom, Write};

pub const MAX_TTS_INPUT_BYTES: usize = 1024 * 1024; // 1 MiB UTF-8 ceiling
pub const MAX_TTS_INPUT_CHARS: usize = 200_000;
pub const DEFAULT_TTS_CHUNK_MAX_CHARS: usize = 500;
pub const MIN_TTS_RATE: f64 = 0.5;
pub const MAX_TTS_RATE: f64 = 2.0;
pub const PARAGRAPH_PAUSE_MS: u32 = 280;
pub const SUBCHUNK_PAUSE_MS: u32 = 80;
pub const MAX_TTS_CHUNK_WAV_BYTES: usize = 64 * 1024 * 1024;
pub const TTS_PROGRESS_EVENT: &str = "winkit://tts-progress";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TtsVoiceEngine {
    WinrtOneCore,
    SapiDesktop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TtsVoiceGender {
    Female,
    Male,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsVoiceInfo {
    pub id: String,
    pub name: String,
    pub language: String,
    pub gender: TtsVoiceGender,
    pub engine: TtsVoiceEngine,
    pub is_default: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsVoicesResponse {
    pub voices: Vec<TtsVoiceInfo>,
    pub default_voice_id: Option<String>,
    pub has_chinese_voice: bool,
    pub has_english_voice: bool,
    pub winrt_count: usize,
    pub sapi_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsTextSegment {
    pub index: usize,
    pub paragraph_index: usize,
    pub text: String,
    pub char_count: usize,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsProgressPayload {
    pub task_id: String,
    pub phase: String,
    pub current_segment: usize,
    pub total_segments: usize,
    pub percent: f64,
    pub detail: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesizeTtsRequest {
    pub text: String,
    pub voice_id: String,
    pub rate: f64,
    pub source_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesizeTtsResult {
    pub result_id: String,
    pub voice_id: String,
    pub voice_name: String,
    pub voice_language: String,
    pub engine: TtsVoiceEngine,
    pub rate: f64,
    pub segment_count: usize,
    pub paragraph_count: usize,
    pub char_count: usize,
    pub sample_rate: u32,
    pub channels: u16,
    pub bits_per_sample: u16,
    pub duration_sec: f64,
    pub wav_byte_length: u64,
    pub preview_url: String,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TtsExportFormat {
    Wav,
    Mp3,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTtsAudioRequest {
    pub result_id: String,
    pub output_path: String,
    pub source_path: Option<String>,
    pub format: TtsExportFormat,
    pub mp3_bitrate_kbps: Option<u32>,
    pub overwrite: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTtsAudioResult {
    pub output_path: String,
    pub format: TtsExportFormat,
    pub duration_sec: f64,
    pub sample_rate: u32,
    pub channels: u16,
    pub byte_length: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PcmWavChunk {
    pub sample_rate: u32,
    pub channels: u16,
    pub bits_per_sample: u16,
    pub pcm_data: Vec<u8>,
}

pub fn validate_tts_rate(rate: f64) -> Result<f64, AppError> {
    if !rate.is_finite() || !(MIN_TTS_RATE..=MAX_TTS_RATE).contains(&rate) {
        return Err(AppError::invalid_param(format!(
            "Speaking rate must be between {MIN_TTS_RATE} and {MAX_TTS_RATE}."
        )));
    }
    Ok((rate * 100.0).round() / 100.0)
}

/// Maps a linear speed multiplier (`0.5..=2.0`) to SAPI 5 `ISpVoice::SetRate` (`-10..=10`),
/// where SAPI defines `rate = 0` as 1× and `±10` as roughly `3^(rate / 10)`.
pub fn speed_ratio_to_sapi_rate(rate: f64) -> i32 {
    let clamped = rate.clamp(MIN_TTS_RATE, MAX_TTS_RATE);
    let raw = 10.0 * (clamped.ln() / 3.0_f64.ln());
    (raw.round() as i32).clamp(-10, 10)
}

fn make_preview(text: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for (count, ch) in text.chars().enumerate() {
        let mapped = if ch.is_whitespace() { ' ' } else { ch };
        if count >= max_chars {
            out.push('…');
            break;
        }
        out.push(mapped);
    }
    out.trim().to_string()
}

fn is_sentence_boundary(ch: char) -> bool {
    matches!(ch, '。' | '！' | '？' | '；' | '.' | '!' | '?' | ';')
}

fn is_clause_boundary(ch: char) -> bool {
    matches!(ch, '，' | ',' | '、' | '：' | ':' | '—' | '–')
}

fn split_paragraph_into_chunks(paragraph: &str, max_chars: usize) -> Vec<String> {
    let limit = max_chars.max(20);
    let trimmed = paragraph.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let chars: Vec<(usize, char)> = trimmed.char_indices().collect();
    if chars.len() <= limit {
        return vec![trimmed.to_string()];
    }

    let mut chunks = Vec::new();
    let mut start_idx = 0usize;
    while start_idx < chars.len() {
        let remaining = chars.len() - start_idx;
        if remaining <= limit {
            let byte_start = chars[start_idx].0;
            let piece = trimmed[byte_start..].trim();
            if !piece.is_empty() {
                chunks.push(piece.to_string());
            }
            break;
        }

        let end_window = start_idx + limit;
        let min_search = start_idx + (limit / 3).max(1);

        // Prefer sentence terminator -> clause boundary -> whitespace -> exact char limit.
        let mut split_at = None;
        for i in (min_search..end_window).rev() {
            if is_sentence_boundary(chars[i].1) {
                split_at = Some(i + 1);
                break;
            }
        }
        if split_at.is_none() {
            for i in (min_search..end_window).rev() {
                if is_clause_boundary(chars[i].1) {
                    split_at = Some(i + 1);
                    break;
                }
            }
        }
        if split_at.is_none() {
            for i in (min_search..end_window).rev() {
                if chars[i].1.is_whitespace() {
                    split_at = Some(i + 1);
                    break;
                }
            }
        }
        let next_idx = split_at.unwrap_or(end_window);
        let byte_start = chars[start_idx].0;
        let byte_end = if next_idx < chars.len() {
            chars[next_idx].0
        } else {
            trimmed.len()
        };
        let piece = trimmed[byte_start..byte_end].trim();
        if !piece.is_empty() {
            chunks.push(piece.to_string());
        }
        start_idx = next_idx;
        while start_idx < chars.len() && chars[start_idx].1.is_whitespace() {
            start_idx += 1;
        }
    }
    chunks
}

/// Splits input text into ordered paragraph/sentence segments suitable for sequential
/// offline synthesis with deterministic ordering, responsive progress, and safe bounds.
pub fn split_tts_segments(
    text: &str,
    max_chars: usize,
) -> Result<(Vec<TtsTextSegment>, usize), AppError> {
    if text.len() > MAX_TTS_INPUT_BYTES {
        return Err(AppError::size_limit(format!(
            "Text exceeds the {} KiB limit for offline speech synthesis.",
            MAX_TTS_INPUT_BYTES / 1024
        )));
    }
    let cleaned = text.trim_start_matches('\u{FEFF}');
    let total_chars = cleaned.chars().count();
    if total_chars > MAX_TTS_INPUT_CHARS {
        return Err(AppError::size_limit(format!(
            "Text exceeds the {MAX_TTS_INPUT_CHARS} character limit for offline speech synthesis."
        )));
    }

    let mut segments = Vec::new();
    let mut paragraph_index = 0usize;
    let mut global_index = 0usize;

    for raw_line in cleaned
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split('\n')
    {
        let para = raw_line.trim();
        if para.is_empty() {
            continue;
        }
        paragraph_index += 1;
        for chunk in split_paragraph_into_chunks(para, max_chars) {
            global_index += 1;
            let char_count = chunk.chars().count();
            let preview = make_preview(&chunk, 48);
            segments.push(TtsTextSegment {
                index: global_index,
                paragraph_index,
                text: chunk,
                char_count,
                preview,
            });
        }
    }

    if segments.is_empty() {
        return Err(AppError::invalid_param(
            "Please enter or load some text before starting speech synthesis.",
        ));
    }

    Ok((segments, paragraph_index))
}

/// Parses a standard uncompressed 16-bit PCM RIFF/WAVE buffer into format metadata and raw PCM bytes.
pub fn parse_pcm_wav(bytes: &[u8]) -> Result<PcmWavChunk, AppError> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(AppError::decode_failed(
            "Synthesized audio payload is not a valid RIFF WAVE stream.",
        ));
    }

    let mut offset = 12usize;
    let mut sample_rate: Option<u32> = None;
    let mut channels: Option<u16> = None;
    let mut bits_per_sample: Option<u16> = None;
    let mut pcm_data: Option<Vec<u8>> = None;

    while offset + 8 <= bytes.len() {
        let chunk_id = &bytes[offset..offset + 4];
        let chunk_size = u32::from_le_bytes([
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7],
        ]) as usize;
        offset += 8;
        let end = offset.saturating_add(chunk_size).min(bytes.len());
        let body = &bytes[offset..end];

        if chunk_id == b"fmt " {
            if body.len() < 16 {
                return Err(AppError::decode_failed("WAV fmt chunk is truncated."));
            }
            let audio_format = u16::from_le_bytes([body[0], body[1]]);
            let ch = u16::from_le_bytes([body[2], body[3]]);
            let sr = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
            let bps = u16::from_le_bytes([body[14], body[15]]);
            if audio_format != 1
                || bps != 16
                || !(1..=2).contains(&ch)
                || !(8_000..=96_000).contains(&sr)
            {
                return Err(AppError::decode_failed(format!(
                    "Unsupported synthesized WAV PCM format (fmt={audio_format}, ch={ch}, sr={sr}, bps={bps})."
                )));
            }
            sample_rate = Some(sr);
            channels = Some(ch);
            bits_per_sample = Some(bps);
        } else if chunk_id == b"data" {
            let aligned_len = body.len() - (body.len() % 2);
            pcm_data = Some(body[..aligned_len].to_vec());
        }

        let padded = chunk_size + (chunk_size % 2);
        offset = offset.saturating_add(padded);
    }

    match (sample_rate, channels, bits_per_sample, pcm_data) {
        (Some(sr), Some(ch), Some(bps), Some(data)) => Ok(PcmWavChunk {
            sample_rate: sr,
            channels: ch,
            bits_per_sample: bps,
            pcm_data: data,
        }),
        _ => Err(AppError::decode_failed(
            "Synthesized WAV stream is missing fmt or data chunk.",
        )),
    }
}

/// Writes a placeholder 44-byte PCM RIFF/WAVE header before streaming sample chunks.
pub fn write_pcm16_wav_header<W: Write>(
    writer: &mut W,
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
    data_bytes: u32,
) -> Result<(), AppError> {
    let block_align = channels
        .checked_mul(bits_per_sample / 8)
        .ok_or_else(|| AppError::invalid_param("Invalid WAV block alignment."))?;
    let byte_rate = sample_rate
        .checked_mul(u32::from(block_align))
        .ok_or_else(|| AppError::invalid_param("Invalid WAV byte rate."))?;
    let riff_size = 36u32.saturating_add(data_bytes);

    let mut hdr = [0u8; 44];
    hdr[0..4].copy_from_slice(b"RIFF");
    hdr[4..8].copy_from_slice(&riff_size.to_le_bytes());
    hdr[8..12].copy_from_slice(b"WAVE");
    hdr[12..16].copy_from_slice(b"fmt ");
    hdr[16..20].copy_from_slice(&16u32.to_le_bytes());
    hdr[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM
    hdr[22..24].copy_from_slice(&channels.to_le_bytes());
    hdr[24..28].copy_from_slice(&sample_rate.to_le_bytes());
    hdr[28..32].copy_from_slice(&byte_rate.to_le_bytes());
    hdr[32..34].copy_from_slice(&block_align.to_le_bytes());
    hdr[34..36].copy_from_slice(&bits_per_sample.to_le_bytes());
    hdr[36..40].copy_from_slice(b"data");
    hdr[40..44].copy_from_slice(&data_bytes.to_le_bytes());

    writer
        .write_all(&hdr)
        .map_err(|e| AppError::from_io(e, "Failed to write WAV header"))
}

/// Seeks back to byte 0 and updates the RIFF and data chunk sizes in a finalized PCM WAV file.
pub fn finalize_pcm16_wav_header<W: Write + Seek>(
    writer: &mut W,
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
    total_data_bytes: u64,
) -> Result<(), AppError> {
    let data_bytes = u32::try_from(total_data_bytes)
        .map_err(|_| AppError::size_limit("Synthesized WAV exceeds 4 GiB RIFF format limit."))?;
    writer
        .seek(SeekFrom::Start(0))
        .map_err(|e| AppError::from_io(e, "Failed to seek WAV header"))?;
    write_pcm16_wav_header(writer, sample_rate, channels, bits_per_sample, data_bytes)?;
    writer
        .flush()
        .map_err(|e| AppError::from_io(e, "Failed to flush finalized WAV"))
}

pub fn silence_pcm16_bytes(sample_rate: u32, channels: u16, duration_ms: u32) -> Vec<u8> {
    let frames = (u64::from(sample_rate) * u64::from(duration_ms)) / 1000;
    let bytes = frames as usize * usize::from(channels) * 2;
    vec![0u8; bytes]
}

pub fn compute_pcm16_rms(pcm: &[u8]) -> f64 {
    let (chunks, _) = pcm.as_chunks::<2>();
    if chunks.is_empty() {
        return 0.0;
    }
    let mut sum_sq = 0.0f64;
    for &[lo, hi] in chunks {
        let s = i16::from_le_bytes([lo, hi]) as f64 / 32768.0;
        sum_sq += s * s;
    }
    (sum_sq / chunks.len() as f64).sqrt()
}

fn normalize_voice_dedup_key(name: &str, language: &str) -> (String, String) {
    let base = name
        .split(" - ")
        .next()
        .unwrap_or(name)
        .trim()
        .to_ascii_lowercase();
    let stripped = base
        .strip_suffix(" desktop")
        .unwrap_or(&base)
        .trim()
        .to_string();
    let lang = language.trim().replace('_', "-").to_ascii_lowercase();
    (stripped, lang)
}

/// Combines WinRT OneCore voices (primary) with Classic SAPI Desktop voices (secondary),
/// deduplicating legacy SAPI Desktop voices already represented in WinRT OneCore.
pub fn merge_and_deduplicate_voices(
    winrt_voices: Vec<TtsVoiceInfo>,
    sapi_voices: Vec<TtsVoiceInfo>,
) -> TtsVoicesResponse {
    let winrt_count = winrt_voices.len();
    let mut seen = HashSet::new();
    let mut combined = Vec::with_capacity(winrt_voices.len() + sapi_voices.len());

    for v in winrt_voices {
        seen.insert(normalize_voice_dedup_key(&v.name, &v.language));
        combined.push(v);
    }

    let mut sapi_kept = 0usize;
    for mut v in sapi_voices {
        let key = normalize_voice_dedup_key(&v.name, &v.language);
        if seen.contains(&key) {
            continue;
        }
        seen.insert(key);
        if combined.iter().any(|existing| existing.is_default) {
            v.is_default = false;
        }
        sapi_kept += 1;
        combined.push(v);
    }

    // Ensure exactly one default if any voices exist.
    if !combined.is_empty() && !combined.iter().any(|v| v.is_default) {
        combined[0].is_default = true;
    }

    // Sort: default first, then WinRT before SAPI, then Chinese/English/other alphabetically.
    combined.sort_by(|a, b| {
        b.is_default
            .cmp(&a.is_default)
            .then_with(|| {
                let ea = matches!(a.engine, TtsVoiceEngine::SapiDesktop);
                let eb = matches!(b.engine, TtsVoiceEngine::SapiDesktop);
                ea.cmp(&eb)
            })
            .then_with(|| {
                a.language
                    .to_ascii_lowercase()
                    .cmp(&b.language.to_ascii_lowercase())
            })
            .then_with(|| {
                a.name
                    .to_ascii_lowercase()
                    .cmp(&b.name.to_ascii_lowercase())
            })
    });

    let default_voice_id = combined
        .iter()
        .find(|v| v.is_default)
        .or_else(|| combined.first())
        .map(|v| v.id.clone());
    let has_chinese_voice = combined
        .iter()
        .any(|v| v.language.to_ascii_lowercase().starts_with("zh"));
    let has_english_voice = combined
        .iter()
        .any(|v| v.language.to_ascii_lowercase().starts_with("en"));

    TtsVoicesResponse {
        voices: combined,
        default_voice_id,
        has_chinese_voice,
        has_english_voice,
        winrt_count,
        sapi_count: sapi_kept,
    }
}

#[cfg(windows)]
mod win_impl {
    use super::*;
    use windows::core::{w, GUID, HSTRING, PCWSTR, PWSTR};
    use windows::Media::SpeechSynthesis::{SpeechSynthesizer, VoiceGender};
    use windows::Storage::Streams::DataReader;
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::Globalization::LCIDToLocaleName;
    use windows::Win32::Media::Audio::WAVEFORMATEX;
    use windows::Win32::Media::Speech::{
        ISpDataKey, ISpObjectToken, ISpObjectTokenCategory, ISpStream, ISpVoice,
        SpObjectTokenCategory, SpStream, SpVoice, SPCAT_VOICES, SPF_IS_NOT_XML,
    };
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IStream, CLSCTX_ALL,
        COINIT_MULTITHREADED, STREAM_SEEK_END, STREAM_SEEK_SET,
    };
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    // SPDFID_WaveFormatEx = {C31ADBAE-527F-4ff5-A230-F62BB61FF70C}
    const SPDFID_WAVE_FORMAT_EX: GUID = GUID::from_u128(0xc31adbae_527f_4ff5_a230_f62bb61ff70c);

    struct ThreadComInit {
        should_uninit: bool,
    }

    impl Drop for ThreadComInit {
        fn drop(&mut self) {
            if self.should_uninit {
                unsafe { CoUninitialize() };
            }
        }
    }

    thread_local! {
        static THREAD_COM: ThreadComInit = {
            let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            ThreadComInit { should_uninit: hr.is_ok() }
        };
    }

    fn ensure_thread_com_initialized() {
        THREAD_COM.with(|_| {});
    }

    fn speech_com_lock() -> &'static std::sync::Mutex<()> {
        static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
    }

    struct ComApartmentGuard {
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl ComApartmentGuard {
        fn enter() -> Self {
            ensure_thread_com_initialized();
            let lock = speech_com_lock()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            Self { _lock: lock }
        }
    }

    unsafe fn pwstr_to_string_and_free(ptr: PWSTR) -> String {
        if ptr.is_null() {
            return String::new();
        }
        let s = ptr.to_string().unwrap_or_default();
        CoTaskMemFree(Some(ptr.0 as *const std::ffi::c_void));
        s
    }

    fn lcid_hex_to_bcp47(raw: &str) -> String {
        let first = raw.split(';').next().unwrap_or(raw).trim();
        let Ok(lcid) = u32::from_str_radix(first.trim_start_matches("0x"), 16) else {
            return first.to_string();
        };
        let mut buf = [0u16; 85];
        let written = unsafe { LCIDToLocaleName(lcid, Some(&mut buf), 0) };
        if written > 1 {
            String::from_utf16_lossy(&buf[..(written as usize - 1)])
        } else {
            match lcid {
                0x0804 => "zh-CN".to_string(),
                0x0404 => "zh-TW".to_string(),
                0x0C04 => "zh-HK".to_string(),
                0x0409 => "en-US".to_string(),
                0x0809 => "en-GB".to_string(),
                0x0411 => "ja-JP".to_string(),
                0x0412 => "ko-KR".to_string(),
                _ => format!("lcid-{lcid:x}"),
            }
        }
    }

    fn winrt_voice_key(raw_id: &str, display_name: &str, language: &str) -> String {
        let trimmed = raw_id.trim();
        if !trimmed.is_empty() {
            format!("winrt::{trimmed}")
        } else {
            format!("winrt::{display_name}::{language}")
        }
    }

    fn parse_gender_str(raw: &str) -> TtsVoiceGender {
        match raw.trim().to_ascii_lowercase().as_str() {
            "female" => TtsVoiceGender::Female,
            "male" => TtsVoiceGender::Male,
            _ => TtsVoiceGender::Unknown,
        }
    }

    pub fn list_winrt_voices() -> Vec<TtsVoiceInfo> {
        let _com = ComApartmentGuard::enter();
        let default_key = SpeechSynthesizer::DefaultVoice().ok().map(|v| {
            let id = v.Id().map(|h| h.to_string()).unwrap_or_default();
            let name = v.DisplayName().map(|h| h.to_string()).unwrap_or_default();
            let lang = v.Language().map(|h| h.to_string()).unwrap_or_default();
            winrt_voice_key(&id, &name, &lang)
        });

        let Ok(all) = SpeechSynthesizer::AllVoices() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for v in all {
            let Ok(name_h) = v.DisplayName() else {
                continue;
            };
            let name = name_h.to_string();
            let language = v.Language().map(|h| h.to_string()).unwrap_or_default();
            let raw_id = v.Id().map(|h| h.to_string()).unwrap_or_default();
            let key = winrt_voice_key(&raw_id, &name, &language);
            let gender = match v.Gender() {
                Ok(g) if g == VoiceGender::Female => TtsVoiceGender::Female,
                Ok(g) if g == VoiceGender::Male => TtsVoiceGender::Male,
                _ => TtsVoiceGender::Unknown,
            };
            let is_default = default_key.as_deref() == Some(key.as_str());
            out.push(TtsVoiceInfo {
                id: key,
                name,
                language,
                gender,
                engine: TtsVoiceEngine::WinrtOneCore,
                is_default,
            });
        }
        out
    }

    pub fn list_sapi_voices() -> Vec<TtsVoiceInfo> {
        let _com = ComApartmentGuard::enter();
        let mut out = Vec::new();
        unsafe {
            let Ok(category) = CoCreateInstance::<_, ISpObjectTokenCategory>(
                &SpObjectTokenCategory,
                None,
                CLSCTX_ALL,
            ) else {
                return out;
            };
            if category.SetId(SPCAT_VOICES, false).is_err() {
                return out;
            }
            let Ok(tokens) = category.EnumTokens(PCWSTR::null(), PCWSTR::null()) else {
                return out;
            };
            let mut count = 0u32;
            if tokens.GetCount(&mut count).is_err() {
                return out;
            }
            for i in 0..count {
                let Ok(token) = tokens.Item(i) else {
                    continue;
                };
                let token_id = match token.GetId() {
                    Ok(p) => pwstr_to_string_and_free(p),
                    Err(_) => continue,
                };
                if token_id.trim().is_empty() {
                    continue;
                }
                let mut name = token
                    .GetStringValue(PCWSTR::null())
                    .map(|p| pwstr_to_string_and_free(p))
                    .unwrap_or_default();
                let mut language = String::new();
                let mut gender = TtsVoiceGender::Unknown;

                if let Ok(attrs) = token.OpenKey(w!("Attributes")) {
                    let attrs_key: ISpDataKey = attrs;
                    if let Ok(p) = attrs_key.GetStringValue(w!("Name")) {
                        let attr_name = pwstr_to_string_and_free(p);
                        if !attr_name.trim().is_empty() {
                            name = attr_name;
                        }
                    }
                    if let Ok(p) = attrs_key.GetStringValue(w!("Language")) {
                        language = lcid_hex_to_bcp47(&pwstr_to_string_and_free(p));
                    }
                    if let Ok(p) = attrs_key.GetStringValue(w!("Gender")) {
                        gender = parse_gender_str(&pwstr_to_string_and_free(p));
                    }
                }
                if name.trim().is_empty() {
                    name = token_id
                        .rsplit('\\')
                        .next()
                        .unwrap_or(&token_id)
                        .to_string();
                }
                out.push(TtsVoiceInfo {
                    id: format!("sapi::{token_id}"),
                    name,
                    language,
                    gender,
                    engine: TtsVoiceEngine::SapiDesktop,
                    is_default: false,
                });
            }
        }
        out
    }

    pub fn list_all_installed_voices() -> TtsVoicesResponse {
        let winrt = list_winrt_voices();
        let sapi = list_sapi_voices();
        merge_and_deduplicate_voices(winrt, sapi)
    }

    pub fn synthesize_chunk(
        voice_id: &str,
        text: &str,
        rate: f64,
    ) -> Result<PcmWavChunk, AppError> {
        let rate = validate_tts_rate(rate)?;
        if let Some(rest) = voice_id.strip_prefix("winrt::") {
            synthesize_winrt_chunk(voice_id, rest, text, rate)
        } else if let Some(token_id) = voice_id.strip_prefix("sapi::") {
            synthesize_sapi_chunk(token_id, text, rate)
        } else {
            Err(AppError::invalid_param(format!(
                "Unknown TTS voice identifier: '{voice_id}'."
            )))
        }
    }

    fn synthesize_winrt_chunk(
        full_key: &str,
        _rest: &str,
        text: &str,
        rate: f64,
    ) -> Result<PcmWavChunk, AppError> {
        let _com = ComApartmentGuard::enter();
        let synth = SpeechSynthesizer::new().map_err(|e| {
            AppError::new(
                "TTS_ENGINE_ERROR",
                format!("Failed to initialize Windows SpeechSynthesizer: {e}"),
            )
        })?;

        let all = SpeechSynthesizer::AllVoices().map_err(|e| {
            AppError::new(
                "TTS_VOICE_LIST_FAILED",
                format!("Failed to query Windows installed voices: {e}"),
            )
        })?;
        let mut matched = None;
        for v in all {
            let id = v.Id().map(|h| h.to_string()).unwrap_or_default();
            let name = v.DisplayName().map(|h| h.to_string()).unwrap_or_default();
            let lang = v.Language().map(|h| h.to_string()).unwrap_or_default();
            if winrt_voice_key(&id, &name, &lang) == full_key {
                matched = Some(v);
                break;
            }
        }
        let voice = matched.ok_or_else(|| {
            AppError::new(
                "TTS_VOICE_NOT_FOUND",
                "Selected Windows speech voice is no longer installed.",
            )
        })?;

        synth.SetVoice(&voice).map_err(|e| {
            AppError::new(
                "TTS_ENGINE_ERROR",
                format!("Failed to select Windows speech voice: {e}"),
            )
        })?;
        if let Ok(opts) = synth.Options() {
            let _ = opts.SetSpeakingRate(rate);
        }

        let op = synth
            .SynthesizeTextToStreamAsync(&HSTRING::from(text))
            .map_err(|e| {
                AppError::new(
                    "TTS_SYNTHESIS_FAILED",
                    format!("Windows SpeechSynthesizer failed to start synthesis: {e}"),
                )
            })?;
        let stream = op.join().map_err(|e| {
            AppError::new(
                "TTS_SYNTHESIS_FAILED",
                format!("Windows SpeechSynthesizer failed while generating speech: {e}"),
            )
        })?;

        let total_size = stream.Size().map_err(|e| {
            AppError::new(
                "TTS_SYNTHESIS_FAILED",
                format!("Unable to query synthesized audio size: {e}"),
            )
        })?;
        if total_size == 0 || total_size > MAX_TTS_CHUNK_WAV_BYTES as u64 {
            return Err(AppError::size_limit(
                "Synthesized audio segment is empty or exceeded safety memory limit.",
            ));
        }

        let input = stream.GetInputStreamAt(0).map_err(|e| {
            AppError::new(
                "TTS_SYNTHESIS_FAILED",
                format!("Unable to open synthesized audio stream: {e}"),
            )
        })?;
        let reader = DataReader::CreateDataReader(&input).map_err(|e| {
            AppError::new(
                "TTS_SYNTHESIS_FAILED",
                format!("Unable to read synthesized audio stream: {e}"),
            )
        })?;

        let mut wav_bytes = Vec::with_capacity(total_size as usize);
        let mut remaining = total_size as usize;
        while remaining > 0 {
            let step = remaining.min(64 * 1024);
            let loaded = reader
                .LoadAsync(step as u32)
                .and_then(|load_op| load_op.join())
                .map_err(|e| {
                    AppError::new(
                        "TTS_SYNTHESIS_FAILED",
                        format!("Failed reading synthesized audio bytes: {e}"),
                    )
                })? as usize;
            if loaded == 0 {
                break;
            }
            let mut buf = vec![0u8; loaded];
            reader.ReadBytes(&mut buf).map_err(|e| {
                AppError::new(
                    "TTS_SYNTHESIS_FAILED",
                    format!("Failed copying synthesized audio bytes: {e}"),
                )
            })?;
            wav_bytes.extend_from_slice(&buf);
            remaining = remaining.saturating_sub(loaded);
        }

        parse_pcm_wav(&wav_bytes)
    }

    fn synthesize_sapi_chunk(
        token_id: &str,
        text: &str,
        rate: f64,
    ) -> Result<PcmWavChunk, AppError> {
        let _com = ComApartmentGuard::enter();
        unsafe {
            let category: ISpObjectTokenCategory =
                CoCreateInstance(&SpObjectTokenCategory, None, CLSCTX_ALL).map_err(|e| {
                    AppError::new(
                        "TTS_ENGINE_ERROR",
                        format!("Failed to initialize Windows SAPI voice category: {e}"),
                    )
                })?;
            category.SetId(SPCAT_VOICES, false).map_err(|e| {
                AppError::new(
                    "TTS_ENGINE_ERROR",
                    format!("Failed to open Windows SAPI voice store: {e}"),
                )
            })?;
            let tokens = category
                .EnumTokens(PCWSTR::null(), PCWSTR::null())
                .map_err(|e| {
                    AppError::new(
                        "TTS_VOICE_LIST_FAILED",
                        format!("Failed to enumerate Windows SAPI voices: {e}"),
                    )
                })?;
            let mut count = 0u32;
            tokens.GetCount(&mut count).map_err(|e| {
                AppError::new(
                    "TTS_VOICE_LIST_FAILED",
                    format!("Failed to count Windows SAPI voices: {e}"),
                )
            })?;

            let mut matched_token: Option<ISpObjectToken> = None;
            for i in 0..count {
                let Ok(tok) = tokens.Item(i) else {
                    continue;
                };
                let Ok(id_ptr) = tok.GetId() else {
                    continue;
                };
                let id_str = pwstr_to_string_and_free(id_ptr);
                if id_str.eq_ignore_ascii_case(token_id) {
                    matched_token = Some(tok);
                    break;
                }
            }
            let token = matched_token.ok_or_else(|| {
                AppError::new(
                    "TTS_VOICE_NOT_FOUND",
                    "Selected Windows SAPI voice is no longer installed.",
                )
            })?;

            let voice: ISpVoice = CoCreateInstance(&SpVoice, None, CLSCTX_ALL).map_err(|e| {
                AppError::new(
                    "TTS_ENGINE_ERROR",
                    format!("Failed to initialize Windows SAPI voice: {e}"),
                )
            })?;
            voice.SetVoice(&token).map_err(|e| {
                AppError::new(
                    "TTS_ENGINE_ERROR",
                    format!("Failed to assign Windows SAPI voice: {e}"),
                )
            })?;
            voice.SetRate(speed_ratio_to_sapi_rate(rate)).map_err(|e| {
                AppError::new(
                    "TTS_ENGINE_ERROR",
                    format!("Failed to configure Windows SAPI speaking rate: {e}"),
                )
            })?;

            let mem_stream: IStream =
                CreateStreamOnHGlobal(HGLOBAL::default(), true).map_err(|e| {
                    AppError::new(
                        "TTS_ENGINE_ERROR",
                        format!("Failed to allocate in-memory audio stream: {e}"),
                    )
                })?;

            const SAMPLE_RATE: u32 = 22_050;
            const CHANNELS: u16 = 1;
            const BITS: u16 = 16;
            let wfx = WAVEFORMATEX {
                wFormatTag: 1, // WAVE_FORMAT_PCM
                nChannels: CHANNELS,
                nSamplesPerSec: SAMPLE_RATE,
                nAvgBytesPerSec: SAMPLE_RATE * u32::from(CHANNELS) * u32::from(BITS / 8),
                nBlockAlign: CHANNELS * (BITS / 8),
                wBitsPerSample: BITS,
                cbSize: 0,
            };

            let sp_stream: ISpStream =
                CoCreateInstance(&SpStream, None, CLSCTX_ALL).map_err(|e| {
                    AppError::new(
                        "TTS_ENGINE_ERROR",
                        format!("Failed to initialize Windows SAPI audio stream: {e}"),
                    )
                })?;
            sp_stream
                .SetBaseStream(&mem_stream, &SPDFID_WAVE_FORMAT_EX, &wfx)
                .map_err(|e| {
                    AppError::new(
                        "TTS_ENGINE_ERROR",
                        format!("Failed to bind SAPI in-memory PCM stream: {e}"),
                    )
                })?;

            voice.SetOutput(&sp_stream, false).map_err(|e| {
                AppError::new(
                    "TTS_ENGINE_ERROR",
                    format!("Failed to set SAPI audio output stream: {e}"),
                )
            })?;

            let wide_text: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
            let speak_res = voice.Speak(PCWSTR(wide_text.as_ptr()), SPF_IS_NOT_XML.0 as u32, None);
            // Always detach stream cleanly before reading or returning errors.
            let _ = voice.SetOutput(None, false);
            speak_res.map_err(|e| {
                AppError::new(
                    "TTS_SYNTHESIS_FAILED",
                    format!("Windows SAPI failed while generating speech: {e}"),
                )
            })?;

            let mut end_pos = 0u64;
            mem_stream
                .Seek(0, STREAM_SEEK_END, Some(&mut end_pos))
                .map_err(|e| {
                    AppError::new(
                        "TTS_SYNTHESIS_FAILED",
                        format!("Failed to measure SAPI audio stream: {e}"),
                    )
                })?;
            if end_pos == 0 || end_pos > MAX_TTS_CHUNK_WAV_BYTES as u64 {
                return Err(AppError::size_limit(
                    "SAPI audio segment is empty or exceeded safety memory limit.",
                ));
            }
            mem_stream.Seek(0, STREAM_SEEK_SET, None).map_err(|e| {
                AppError::new(
                    "TTS_SYNTHESIS_FAILED",
                    format!("Failed to rewind SAPI audio stream: {e}"),
                )
            })?;

            let total_len = end_pos as usize;
            let mut pcm = vec![0u8; total_len];
            let mut read_total = 0usize;
            while read_total < total_len {
                let mut got = 0u32;
                let remaining = (total_len - read_total) as u32;
                let hr = mem_stream.Read(
                    pcm[read_total..].as_mut_ptr() as *mut std::ffi::c_void,
                    remaining,
                    Some(&mut got),
                );
                if hr.is_err() || got == 0 {
                    break;
                }
                read_total += got as usize;
            }
            pcm.truncate(read_total - (read_total % 2));

            Ok(PcmWavChunk {
                sample_rate: SAMPLE_RATE,
                channels: CHANNELS,
                bits_per_sample: BITS,
                pcm_data: pcm,
            })
        }
    }

    /// Safely opens Windows Settings -> Time & language -> Speech using the hardcoded URI.
    pub fn open_windows_speech_settings_impl() -> Result<(), AppError> {
        let res = unsafe {
            ShellExecuteW(
                None,
                w!("open"),
                w!("ms-settings:speech"),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        if (res.0 as isize) <= 32 {
            return Err(AppError::new(
                "OPEN_SETTINGS_FAILED",
                "Unable to open Windows Speech settings (ms-settings:speech).",
            ));
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod win_impl {
    use super::*;

    pub fn list_all_installed_voices() -> TtsVoicesResponse {
        TtsVoicesResponse {
            voices: Vec::new(),
            default_voice_id: None,
            has_chinese_voice: false,
            has_english_voice: false,
            winrt_count: 0,
            sapi_count: 0,
        }
    }

    pub fn synthesize_chunk(
        _voice_id: &str,
        _text: &str,
        _rate: f64,
    ) -> Result<PcmWavChunk, AppError> {
        Err(AppError::new(
            "TTS_UNSUPPORTED_PLATFORM",
            "Offline Windows speech synthesis is only available on Windows.",
        ))
    }

    pub fn open_windows_speech_settings_impl() -> Result<(), AppError> {
        Err(AppError::new(
            "OPEN_SETTINGS_FAILED",
            "Windows Speech settings are only available on Windows.",
        ))
    }
}

pub use win_impl::{
    list_all_installed_voices, open_windows_speech_settings_impl, synthesize_chunk,
};

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn splits_multiparagraph_and_long_mixed_text_in_exact_order() {
        let input = "\u{FEFF}第一段中文内容。\r\n\r\nSecond paragraph in English! Next sentence here.\n   \n第三段包含很长的连续描述，测试句子切分是否保持严格顺序。这是第三段第二句！This is the third sentence.";
        let (segments, para_count) = split_tts_segments(input, 32).expect("split ok");
        assert_eq!(para_count, 3);
        assert!(segments.len() >= 5);
        assert_eq!(segments[0].index, 1);
        assert_eq!(segments[0].paragraph_index, 1);
        assert_eq!(segments[0].text, "第一段中文内容。");
        // Strictly monotonic segment and paragraph order
        for pair in segments.windows(2) {
            assert_eq!(pair[1].index, pair[0].index + 1);
            assert!(pair[1].paragraph_index >= pair[0].paragraph_index);
        }
        // Reconstructed text preserves every word in exact order
        let joined: String = segments
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(joined.contains("第一段中文内容。"));
        assert!(joined.contains("Second paragraph in English!"));
        assert!(joined.contains("Next sentence here."));
        assert!(joined.contains("这是第三段第二句！"));
        assert!(joined.contains("This is the third sentence."));
    }

    #[test]
    fn rejects_empty_oversized_and_invalid_rate() {
        assert_eq!(
            split_tts_segments("   \r\n\t ", 500).unwrap_err().code,
            "INVALID_PARAMETER"
        );
        let huge = "a".repeat(MAX_TTS_INPUT_CHARS + 1);
        assert_eq!(
            split_tts_segments(&huge, 500).unwrap_err().code,
            "SIZE_LIMIT_EXCEEDED"
        );
        assert!(validate_tts_rate(0.49).is_err());
        assert!(validate_tts_rate(2.01).is_err());
        assert!(validate_tts_rate(f64::NAN).is_err());
        assert_eq!(validate_tts_rate(1.25).unwrap(), 1.25);
        assert_eq!(speed_ratio_to_sapi_rate(1.0), 0);
        assert!(speed_ratio_to_sapi_rate(0.5) < 0);
        assert!(speed_ratio_to_sapi_rate(2.0) > 0);
    }

    #[test]
    fn deduplicates_sapi_desktop_voice_already_covered_by_winrt_while_keeping_distinct_languages() {
        let winrt = vec![
            TtsVoiceInfo {
                id: "winrt::huihui".into(),
                name: "Microsoft Huihui".into(),
                language: "zh-CN".into(),
                gender: TtsVoiceGender::Female,
                engine: TtsVoiceEngine::WinrtOneCore,
                is_default: true,
            },
            TtsVoiceInfo {
                id: "winrt::kangkang".into(),
                name: "Microsoft Kangkang".into(),
                language: "zh-CN".into(),
                gender: TtsVoiceGender::Male,
                engine: TtsVoiceEngine::WinrtOneCore,
                is_default: false,
            },
        ];
        let sapi = vec![
            TtsVoiceInfo {
                id: "sapi::huihui_desktop".into(),
                name: "Microsoft Huihui Desktop".into(),
                language: "zh-CN".into(),
                gender: TtsVoiceGender::Female,
                engine: TtsVoiceEngine::SapiDesktop,
                is_default: false,
            },
            TtsVoiceInfo {
                id: "sapi::zira_desktop".into(),
                name: "Microsoft Zira Desktop".into(),
                language: "en-US".into(),
                gender: TtsVoiceGender::Female,
                engine: TtsVoiceEngine::SapiDesktop,
                is_default: false,
            },
        ];
        let merged = merge_and_deduplicate_voices(winrt, sapi);
        assert_eq!(merged.voices.len(), 3);
        assert_eq!(merged.winrt_count, 2);
        assert_eq!(merged.sapi_count, 1);
        assert!(merged.has_chinese_voice);
        assert!(merged.has_english_voice);
        assert_eq!(merged.default_voice_id.as_deref(), Some("winrt::huihui"));
        assert!(merged.voices.iter().any(|v| v.id == "sapi::zira_desktop"));
        assert!(!merged.voices.iter().any(|v| v.id == "sapi::huihui_desktop"));
    }

    #[test]
    fn wav_header_roundtrips_and_measures_non_silent_rms() {
        let mut cursor = Cursor::new(Vec::new());
        let mut pcm = Vec::new();
        for i in 0..1600 {
            let sample = (((i as f64) * 0.15).sin() * 12000.0) as i16;
            pcm.extend_from_slice(&sample.to_le_bytes());
        }
        write_pcm16_wav_header(&mut cursor, 16_000, 1, 16, 0).expect("hdr");
        cursor.write_all(&pcm).expect("pcm");
        finalize_pcm16_wav_header(&mut cursor, 16_000, 1, 16, pcm.len() as u64).expect("finalize");
        let parsed = parse_pcm_wav(cursor.get_ref()).expect("parse wav");
        assert_eq!(parsed.sample_rate, 16_000);
        assert_eq!(parsed.channels, 1);
        assert_eq!(parsed.bits_per_sample, 16);
        assert_eq!(parsed.pcm_data.len(), pcm.len());
        assert!(compute_pcm16_rms(&parsed.pcm_data) > 0.1);
    }

    #[cfg(windows)]
    #[test]
    fn enumerates_real_windows_voices_and_synthesizes_non_silent_offline_audio() {
        let resp = list_all_installed_voices();
        assert!(
            !resp.voices.is_empty(),
            "Windows runner should have at least one installed TTS voice"
        );
        let voice = resp
            .voices
            .iter()
            .find(|v| Some(v.id.as_str()) == resp.default_voice_id.as_deref())
            .unwrap_or(&resp.voices[0]);
        let text = if voice.language.to_ascii_lowercase().starts_with("zh") {
            "你好，这是离线文本朗读单元测试。"
        } else {
            "Hello, this is an offline text to speech test."
        };
        let chunk = synthesize_chunk(&voice.id, text, 1.0).expect("offline synth should succeed");
        assert!(chunk.sample_rate >= 8_000);
        assert!(!chunk.pcm_data.is_empty());
        assert!(
            compute_pcm16_rms(&chunk.pcm_data) > 0.005,
            "Synthesized audio should be non-silent"
        );
    }
}
