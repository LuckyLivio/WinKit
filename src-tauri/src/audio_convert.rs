//! A05 Convert Audio — single and batch conversion across MP3, M4A (AAC), WAV, FLAC, and AIFF.
//! Lossless targets preserve expressible source bit depth, sample rate, and channels by default,
//! verified with a bit-exact 24-bit stereo (L != R) WAV -> FLAC -> WAV roundtrip test.

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioConvertFormat {
    Mp3,
    M4a,
    Wav,
    Flac,
    Aiff,
}

impl AudioConvertFormat {
    pub fn extension(self) -> &'static str {
        match self {
            AudioConvertFormat::Mp3 => "mp3",
            AudioConvertFormat::M4a => "m4a",
            AudioConvertFormat::Wav => "wav",
            AudioConvertFormat::Flac => "flac",
            AudioConvertFormat::Aiff => "aiff",
        }
    }

    pub fn is_lossless(self) -> bool {
        matches!(
            self,
            AudioConvertFormat::Wav | AudioConvertFormat::Flac | AudioConvertFormat::Aiff
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioBitDepthOption {
    Source,
    Bits16,
    Bits24,
    Bits32Float,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertAudioBatchRequest {
    pub task_id: String,
    pub source_paths: Vec<String>,
    pub output_dir: String,
    pub target_format: AudioConvertFormat,
    /// Applicable to lossy formats (MP3 / M4A): e.g. 128, 192, 256, 320.
    pub bitrate_kbps: Option<u32>,
    /// Optional sample rate override (Hz); `None` preserves source sample rate.
    pub sample_rate_hz: Option<u32>,
    /// Applicable to lossless formats (WAV / FLAC / AIFF); defaults to `Source`.
    pub bit_depth: Option<AudioBitDepthOption>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioConvertItemStatus {
    Converted,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertAudioItemResult {
    pub source_path: String,
    pub file_name: String,
    pub status: AudioConvertItemStatus,
    pub output_path: Option<String>,
    pub output_bytes: Option<u64>,
    pub output_codec: Option<String>,
    pub output_sample_rate_hz: Option<u32>,
    pub output_channels: Option<u32>,
    pub output_bits_per_sample: Option<u32>,
    pub output_duration_sec: Option<f64>,
    pub elapsed_ms: u64,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertAudioBatchResponse {
    pub task_id: String,
    pub output_dir: String,
    pub target_format: AudioConvertFormat,
    pub cancelled: bool,
    pub converted_count: usize,
    pub skipped_count: usize,
    pub failed_count: usize,
    pub elapsed_ms: u64,
    pub items: Vec<ConvertAudioItemResult>,
}

fn append_audio_convert_codec_args(
    target_format: AudioConvertFormat,
    bitrate_kbps: Option<u32>,
    sample_rate_hz: Option<u32>,
    bit_depth: AudioBitDepthOption,
    src_bits: Option<u32>,
    src_sample_fmt: Option<&str>,
    args: &mut Vec<String>,
) {
    if let Some(sr) = sample_rate_hz.filter(|&r| (8_000..=192_000).contains(&r)) {
        args.extend(["-ar".into(), sr.to_string()]);
    }
    let src_is_float = src_sample_fmt
        .map(|s| s.to_ascii_lowercase().contains("flt"))
        .unwrap_or(false);

    match target_format {
        AudioConvertFormat::Mp3 => {
            let br = bitrate_kbps.unwrap_or(192).clamp(64, 320);
            args.extend([
                "-c:a".into(),
                "libmp3lame".into(),
                "-b:a".into(),
                format!("{br}k"),
                "-f".into(),
                "mp3".into(),
            ]);
        }
        AudioConvertFormat::M4a => {
            let br = bitrate_kbps.unwrap_or(192).clamp(64, 320);
            args.extend([
                "-c:a".into(),
                "aac".into(),
                "-b:a".into(),
                format!("{br}k"),
                "-movflags".into(),
                "+faststart".into(),
                "-f".into(),
                "ipod".into(),
            ]);
        }
        AudioConvertFormat::Wav => {
            let pcm = match bit_depth {
                AudioBitDepthOption::Bits16 => "pcm_s16le",
                AudioBitDepthOption::Bits24 => "pcm_s24le",
                AudioBitDepthOption::Bits32Float => "pcm_f32le",
                AudioBitDepthOption::Source => match (src_bits, src_is_float) {
                    (Some(32), true) => "pcm_f32le",
                    (Some(32), false) => "pcm_s32le",
                    (Some(24), _) => "pcm_s24le",
                    (Some(8), _) => "pcm_u8",
                    _ => "pcm_s16le",
                },
            };
            args.extend(["-c:a".into(), pcm.into(), "-f".into(), "wav".into()]);
        }
        AudioConvertFormat::Flac => {
            args.extend(["-c:a".into(), "flac".into()]);
            match bit_depth {
                AudioBitDepthOption::Bits16 => {
                    args.extend(["-sample_fmt".into(), "s16".into()]);
                }
                AudioBitDepthOption::Bits24 | AudioBitDepthOption::Bits32Float => {
                    args.extend(["-sample_fmt".into(), "s32".into()]);
                }
                AudioBitDepthOption::Source => {
                    // When source is already 24-bit PCM/FLAC, omit forced s16 so FFmpeg preserves
                    // exact 24-bit raw sample precision natively (bits_per_raw_sample = 24).
                    if src_bits.unwrap_or(16) >= 24 {
                        args.extend(["-sample_fmt".into(), "s32".into()]);
                    }
                }
            }
            args.extend(["-f".into(), "flac".into()]);
        }
        AudioConvertFormat::Aiff => {
            let pcm = match bit_depth {
                AudioBitDepthOption::Bits16 => "pcm_s16be",
                AudioBitDepthOption::Bits24 => "pcm_s24be",
                AudioBitDepthOption::Bits32Float => "pcm_s32be",
                AudioBitDepthOption::Source => match src_bits {
                    Some(32) => "pcm_s32be",
                    Some(24) => "pcm_s24be",
                    _ => "pcm_s16be",
                },
            };
            args.extend(["-c:a".into(), pcm.into(), "-f".into(), "aiff".into()]);
        }
    }
}

pub fn convert_audio_batch_impl(
    media_root: &Path,
    req: &ConvertAudioBatchRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(MediaTaskProgressPayload),
) -> Result<ConvertAudioBatchResponse, AppError> {
    let t0 = Instant::now();
    if req.source_paths.is_empty() {
        return Err(AppError::invalid_param(
            "Select at least one audio file to convert.",
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
    let bit_depth = req.bit_depth.unwrap_or(AudioBitDepthOption::Source);

    let mut results = Vec::with_capacity(total);
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
            results.push(ConvertAudioItemResult {
                source_path: raw_src.clone(),
                file_name: fallback_name,
                status: AudioConvertItemStatus::Skipped,
                output_path: None,
                output_bytes: None,
                output_codec: None,
                output_sample_rate_hz: None,
                output_channels: None,
                output_bits_per_sample: None,
                output_duration_sec: None,
                elapsed_ms: 0,
                message: Some("Cancelled before processing.".into()),
            });
            continue;
        }

        let (source_path, _) = match validate_existing_input_file(raw_src) {
            Ok(v) => v,
            Err(err) => {
                failed_count += 1;
                results.push(ConvertAudioItemResult {
                    source_path: raw_src.clone(),
                    file_name: fallback_name,
                    status: AudioConvertItemStatus::Failed,
                    output_path: None,
                    output_bytes: None,
                    output_codec: None,
                    output_sample_rate_hz: None,
                    output_channels: None,
                    output_bits_per_sample: None,
                    output_duration_sec: None,
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
                results.push(ConvertAudioItemResult {
                    source_path: raw_src.clone(),
                    file_name: fallback_name,
                    status: AudioConvertItemStatus::Failed,
                    output_path: None,
                    output_bytes: None,
                    output_codec: None,
                    output_sample_rate_hz: None,
                    output_channels: None,
                    output_bits_per_sample: None,
                    output_duration_sec: None,
                    elapsed_ms: item_t0.elapsed().as_millis() as u64,
                    message: Some(err.message),
                });
                continue;
            }
        };

        let Some(a0) = probe.audio_streams.first() else {
            failed_count += 1;
            results.push(ConvertAudioItemResult {
                source_path: raw_src.clone(),
                file_name: probe.file_name,
                status: AudioConvertItemStatus::Failed,
                output_path: None,
                output_bytes: None,
                output_codec: None,
                output_sample_rate_hz: None,
                output_channels: None,
                output_bits_per_sample: None,
                output_duration_sec: None,
                elapsed_ms: item_t0.elapsed().as_millis() as u64,
                message: Some("Input file does not contain an audio stream.".into()),
            });
            continue;
        };

        let stem = source_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("audio");
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
                results.push(ConvertAudioItemResult {
                    source_path: raw_src.clone(),
                    file_name: probe.file_name,
                    status: AudioConvertItemStatus::Failed,
                    output_path: None,
                    output_bytes: None,
                    output_codec: None,
                    output_sample_rate_hz: None,
                    output_channels: None,
                    output_bits_per_sample: None,
                    output_duration_sec: None,
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
                results.push(ConvertAudioItemResult {
                    source_path: raw_src.clone(),
                    file_name: probe.file_name,
                    status: AudioConvertItemStatus::Failed,
                    output_path: None,
                    output_bytes: None,
                    output_codec: None,
                    output_sample_rate_hz: None,
                    output_channels: None,
                    output_bits_per_sample: None,
                    output_duration_sec: None,
                    elapsed_ms: item_t0.elapsed().as_millis() as u64,
                    message: Some(err.message),
                });
                continue;
            }
        };

        let mut args: Vec<String> = vec![
            "-i".into(),
            source_path.to_string_lossy().to_string(),
            "-vn".into(),
            "-map".into(),
            "0:a:0".into(),
        ];
        append_audio_convert_codec_args(
            req.target_format,
            req.bitrate_kbps,
            req.sample_rate_hz,
            bit_depth,
            a0.bits_per_sample,
            a0.sample_fmt.as_deref(),
            &mut args,
        );
        args.push(atomic.temp_path().to_string_lossy().to_string());

        let dur = a0.duration_sec.or(probe.duration_sec);
        let item_name = probe.file_name.clone();
        on_progress(MediaTaskProgressPayload {
            task_id: req.task_id.clone(),
            tool_id: "A05".into(),
            phase: "running".into(),
            current_item: idx + 1,
            total_items: total,
            item_name: Some(item_name.clone()),
            percent: Some(((idx as f64) / (total as f64) * 100.0).clamp(0.0, 99.0)),
            out_time_sec: Some(0.0),
            total_duration_sec: dur,
        });

        let exec_res =
            run_ffmpeg_cancellable(&tools.ffmpeg, &args, dur, cancel_flag, |out_t, ip| {
                let item_frac = ip.unwrap_or(0.0) / 100.0;
                let overall =
                    (((idx as f64) + item_frac) / (total as f64) * 100.0).clamp(0.0, 99.5);
                on_progress(MediaTaskProgressPayload {
                    task_id: req.task_id.clone(),
                    tool_id: "A05".into(),
                    phase: "running".into(),
                    current_item: idx + 1,
                    total_items: total,
                    item_name: Some(item_name.clone()),
                    percent: Some(overall),
                    out_time_sec: out_t,
                    total_duration_sec: dur,
                });
            });

        match exec_res {
            Ok(()) => match atomic.commit(false) {
                Ok((committed, out_bytes)) => {
                    let out_probe =
                        probe_media_info_impl(media_root, &committed.to_string_lossy()).ok();
                    let out_a = out_probe.as_ref().and_then(|p| p.audio_streams.first());
                    converted_count += 1;
                    results.push(ConvertAudioItemResult {
                        source_path: raw_src.clone(),
                        file_name: probe.file_name,
                        status: AudioConvertItemStatus::Converted,
                        output_path: Some(committed.to_string_lossy().to_string()),
                        output_bytes: Some(out_bytes),
                        output_codec: out_a.and_then(|a| a.codec_name.clone()),
                        output_sample_rate_hz: out_a.and_then(|a| a.sample_rate_hz),
                        output_channels: out_a.and_then(|a| a.channels),
                        output_bits_per_sample: out_a.and_then(|a| a.bits_per_sample),
                        output_duration_sec: out_a
                            .and_then(|a| a.duration_sec)
                            .or_else(|| out_probe.as_ref().and_then(|p| p.duration_sec)),
                        elapsed_ms: item_t0.elapsed().as_millis() as u64,
                        message: None,
                    });
                }
                Err(err) => {
                    failed_count += 1;
                    results.push(ConvertAudioItemResult {
                        source_path: raw_src.clone(),
                        file_name: probe.file_name,
                        status: AudioConvertItemStatus::Failed,
                        output_path: None,
                        output_bytes: None,
                        output_codec: None,
                        output_sample_rate_hz: None,
                        output_channels: None,
                        output_bits_per_sample: None,
                        output_duration_sec: None,
                        elapsed_ms: item_t0.elapsed().as_millis() as u64,
                        message: Some(err.message),
                    });
                }
            },
            Err(err) if err.code == "TASK_CANCELLED" => {
                drop(atomic);
                cancelled = true;
                skipped_count += 1;
                results.push(ConvertAudioItemResult {
                    source_path: raw_src.clone(),
                    file_name: probe.file_name,
                    status: AudioConvertItemStatus::Skipped,
                    output_path: None,
                    output_bytes: None,
                    output_codec: None,
                    output_sample_rate_hz: None,
                    output_channels: None,
                    output_bits_per_sample: None,
                    output_duration_sec: None,
                    elapsed_ms: item_t0.elapsed().as_millis() as u64,
                    message: Some("Cancelled during conversion.".into()),
                });
            }
            Err(err) => {
                drop(atomic);
                failed_count += 1;
                results.push(ConvertAudioItemResult {
                    source_path: raw_src.clone(),
                    file_name: probe.file_name,
                    status: AudioConvertItemStatus::Failed,
                    output_path: None,
                    output_bytes: None,
                    output_codec: None,
                    output_sample_rate_hz: None,
                    output_channels: None,
                    output_bits_per_sample: None,
                    output_duration_sec: None,
                    elapsed_ms: item_t0.elapsed().as_millis() as u64,
                    message: Some(err.message),
                });
            }
        }
    }

    on_progress(MediaTaskProgressPayload {
        task_id: req.task_id.clone(),
        tool_id: "A05".into(),
        phase: if cancelled { "cancelled" } else { "completed" }.into(),
        current_item: total,
        total_items: total,
        item_name: None,
        percent: if cancelled { None } else { Some(100.0) },
        out_time_sec: None,
        total_duration_sec: None,
    });

    Ok(ConvertAudioBatchResponse {
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
    use std::f64::consts::PI;
    use std::fs;
    use tempfile::tempdir;

    /// Writes a canonical stereo 24-bit signed little-endian PCM WAV file (`pcm_s24le`).
    fn write_pcm24_stereo_wav(path: &Path, sr: u32, frames_lr: &[(i32, i32)]) {
        let data_bytes = (frames_lr.len() * 6) as u32;
        let mut out = Vec::with_capacity(44 + data_bytes as usize);
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_bytes).to_le_bytes());
        out.extend_from_slice(b"WAVE");
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes()); // PCM
        out.extend_from_slice(&2u16.to_le_bytes()); // 2 channels
        out.extend_from_slice(&sr.to_le_bytes());
        out.extend_from_slice(&(sr * 6).to_le_bytes());
        out.extend_from_slice(&6u16.to_le_bytes()); // block align = 2ch * 3 bytes
        out.extend_from_slice(&24u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_bytes.to_le_bytes());
        for &(l, r) in frames_lr {
            let lb = l.to_le_bytes();
            let rb = r.to_le_bytes();
            out.extend_from_slice(&lb[0..3]);
            out.extend_from_slice(&rb[0..3]);
        }
        fs::write(path, out).unwrap();
    }

    /// Independently parses RIFF/WAVE `fmt ` & `data` chunks and returns interleaved 24-bit signed (L, R) samples.
    fn parse_pcm24_stereo_wav(path: &Path) -> (u32, u16, u16, Vec<(i32, i32)>) {
        let bytes = fs::read(path).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        let mut pos = 12usize;
        let mut sr = 0u32;
        let mut ch = 0u16;
        let mut bits = 0u16;
        let mut data_slice: Option<&[u8]> = None;

        while pos + 8 <= bytes.len() {
            let id = &bytes[pos..pos + 4];
            let sz = u32::from_le_bytes([
                bytes[pos + 4],
                bytes[pos + 5],
                bytes[pos + 6],
                bytes[pos + 7],
            ]) as usize;
            let body_start = pos + 8;
            let body_end = (body_start + sz).min(bytes.len());
            if id == b"fmt " {
                ch = u16::from_le_bytes([bytes[body_start + 2], bytes[body_start + 3]]);
                sr = u32::from_le_bytes([
                    bytes[body_start + 4],
                    bytes[body_start + 5],
                    bytes[body_start + 6],
                    bytes[body_start + 7],
                ]);
                bits = u16::from_le_bytes([bytes[body_start + 14], bytes[body_start + 15]]);
            } else if id == b"data" {
                data_slice = Some(&bytes[body_start..body_end]);
            }
            pos = body_start + sz + (sz % 2);
        }

        let data = data_slice.expect("missing WAV data chunk");
        assert_eq!(bits, 24);
        assert_eq!(ch, 2);
        assert_eq!(data.len() % 6, 0);

        let sign_ext_24 = |b0: u8, b1: u8, b2: u8| -> i32 {
            let raw = (b0 as i32) | ((b1 as i32) << 8) | ((b2 as i32) << 16);
            if (raw & 0x80_0000) != 0 {
                raw | !0xFF_FFFF
            } else {
                raw
            }
        };

        let mut samples = Vec::with_capacity(data.len() / 6);
        for chunk in data.as_chunks::<6>().0 {
            samples.push((
                sign_ext_24(chunk[0], chunk[1], chunk[2]),
                sign_ext_24(chunk[3], chunk[4], chunk[5]),
            ));
        }
        (sr, ch, bits, samples)
    }

    #[test]
    fn verifies_24bit_stereo_distinct_lr_wav_flac_wav_bit_exact_and_other_formats() {
        let dir = tempdir().unwrap();
        if require_media_tools(dir.path()).is_err() {
            return;
        }
        let sr = 48_000u32;
        let n_frames = (sr / 2) as usize; // 0.5s = 24,000 stereo 24-bit frames
        let mut orig_lr: Vec<(i32, i32)> = Vec::with_capacity(n_frames);
        for i in 0..n_frames {
            let t = i as f64 / f64::from(sr);
            // Distinct Left (440 Hz + LSB ramp exercising all 24 bits) vs Right (660 Hz triangle + phase)
            let l_base = (0.65 * (2.0 * PI * 440.0 * t).sin() * 8_000_000.0).round() as i32;
            let l_lsb = ((i as i32 * 37) % 511) - 255;
            let l = (l_base + l_lsb).clamp(-8_388_607, 8_388_607);

            let r_base = (0.55 * (2.0 * PI * 660.0 * t + 0.9).cos() * 8_000_000.0).round() as i32;
            let r_lsb = ((i as i32 * 53) % 509) - 254;
            let r = (r_base + r_lsb).clamp(-8_388_607, 8_388_607);
            orig_lr.push((l, r));
        }

        let src_wav = dir.path().join("stereo_24bit_lr.wav");
        write_pcm24_stereo_wav(&src_wav, sr, &orig_lr);

        let cancel = AtomicBool::new(false);
        let flac_dir = dir.path().join("out_flac");
        let r_flac = convert_audio_batch_impl(
            dir.path(),
            &ConvertAudioBatchRequest {
                task_id: "a05-wav-flac".into(),
                source_paths: vec![src_wav.to_string_lossy().to_string()],
                output_dir: flac_dir.to_string_lossy().to_string(),
                target_format: AudioConvertFormat::Flac,
                bitrate_kbps: None,
                sample_rate_hz: None,
                bit_depth: Some(AudioBitDepthOption::Source),
            },
            &cancel,
            |_| {},
        )
        .unwrap();
        assert_eq!(r_flac.converted_count, 1);
        let flac_item = &r_flac.items[0];
        assert_eq!(flac_item.output_bits_per_sample, Some(24));
        assert_eq!(flac_item.output_sample_rate_hz, Some(48_000));
        assert_eq!(flac_item.output_channels, Some(2));
        let flac_path = flac_item.output_path.clone().unwrap();

        let wav2_dir = dir.path().join("out_wav2");
        let r_wav2 = convert_audio_batch_impl(
            dir.path(),
            &ConvertAudioBatchRequest {
                task_id: "a05-flac-wav".into(),
                source_paths: vec![flac_path],
                output_dir: wav2_dir.to_string_lossy().to_string(),
                target_format: AudioConvertFormat::Wav,
                bitrate_kbps: None,
                sample_rate_hz: None,
                bit_depth: Some(AudioBitDepthOption::Source),
            },
            &cancel,
            |_| {},
        )
        .unwrap();
        assert_eq!(r_wav2.converted_count, 1);
        let wav2_path = PathBuf::from(r_wav2.items[0].output_path.as_ref().unwrap());
        let (rt_sr, rt_ch, rt_bits, rt_lr) = parse_pcm24_stereo_wav(&wav2_path);
        assert_eq!((rt_sr, rt_ch, rt_bits), (48_000, 2, 24));
        assert_eq!(rt_lr.len(), orig_lr.len());
        let mismatch = orig_lr
            .iter()
            .zip(rt_lr.iter())
            .enumerate()
            .find(|(_, (a, b))| a != b);
        assert!(
            mismatch.is_none(),
            "24-bit WAV->FLAC->WAV roundtrip sample mismatch at {mismatch:?}"
        );

        // Also test AIFF (preserving 24-bit), MP3, M4A, corrupted file isolation & duplicate output numbering
        let bad_file = dir.path().join("corrupted.wav");
        fs::write(&bad_file, b"CORRUPTED_AUDIO_HEADER_BYTES").unwrap();

        for (fmt, exp_codec) in [
            (AudioConvertFormat::Aiff, "pcm_s24be"),
            (AudioConvertFormat::Mp3, "mp3"),
            (AudioConvertFormat::M4a, "aac"),
        ] {
            let sub = dir.path().join(format!("out_{}", fmt.extension()));
            let res = convert_audio_batch_impl(
                dir.path(),
                &ConvertAudioBatchRequest {
                    task_id: format!("a05-{}", fmt.extension()),
                    source_paths: vec![
                        src_wav.to_string_lossy().to_string(),
                        bad_file.to_string_lossy().to_string(),
                    ],
                    output_dir: sub.to_string_lossy().to_string(),
                    target_format: fmt,
                    bitrate_kbps: Some(192),
                    sample_rate_hz: None,
                    bit_depth: Some(AudioBitDepthOption::Source),
                },
                &cancel,
                |_| {},
            )
            .unwrap();
            assert_eq!(res.converted_count, 1);
            assert_eq!(res.failed_count, 1);
            assert_eq!(res.items[0].output_codec.as_deref(), Some(exp_codec));
        }

        // Duplicate filename protection
        let dup = convert_audio_batch_impl(
            dir.path(),
            &ConvertAudioBatchRequest {
                task_id: "a05-dup".into(),
                source_paths: vec![src_wav.to_string_lossy().to_string()],
                output_dir: flac_dir.to_string_lossy().to_string(),
                target_format: AudioConvertFormat::Flac,
                bitrate_kbps: None,
                sample_rate_hz: None,
                bit_depth: Some(AudioBitDepthOption::Source),
            },
            &cancel,
            |_| {},
        )
        .unwrap();
        assert_eq!(dup.converted_count, 1);
        assert!(dup.items[0].output_path.as_deref().unwrap().contains("(2)"));
    }
}
