//! A03 Trim Audio — bounded-memory streaming waveform generation, playable browser audition
//! preparation, sample-accurate audio trimming (`atrim`), and separate Fade-In / Fade-Out
//! envelopes with explicit valid range calculation for short selections.

use crate::error::AppError;
use crate::fs_guard::validate_existing_input_file;
use crate::media_core::{
    configure_hidden_command, require_media_tools, run_ffmpeg_cancellable, AtomicMediaOutput,
    MediaPreviewRegistry, MediaTaskProgressPayload,
};
use crate::media_info::probe_media_info_impl;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::AtomicBool;
use std::time::Instant;
use uuid::Uuid;

pub const DEFAULT_WAVEFORM_BUCKETS: usize = 960;
pub const MIN_WAVEFORM_BUCKETS: usize = 64;
pub const MAX_WAVEFORM_BUCKETS: usize = 2400;
pub const MAX_FADE_CAP_SEC: f64 = 30.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioWaveformPayload {
    pub source_path: String,
    pub file_name: String,
    pub duration_sec: f64,
    pub sample_rate_hz: Option<u32>,
    pub channels: Option<u32>,
    pub codec_name: Option<String>,
    pub bits_per_sample: Option<u32>,
    pub analysis_sample_rate_hz: u32,
    pub bucket_count: usize,
    /// Signed minimum peak per bucket in `[-1.0, 0.0]`.
    pub min_peaks: Vec<f32>,
    /// Signed maximum peak per bucket in `[0.0, 1.0]`.
    pub max_peaks: Vec<f32>,
    /// Playable browser URL served via `winkitmedia` for auditioning.
    pub audition_url: String,
    pub audition_transcoded: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveFadeBounds {
    pub selection_duration_sec: f64,
    pub max_fade_in_sec: f64,
    pub max_fade_out_sec: f64,
    pub effective_fade_in_sec: f64,
    pub effective_fade_out_sec: f64,
}

/// Pure fade-bound calculation shared with UI & tests.
/// When both fade-in and fade-out are enabled on a short selection, each side is bounded to
/// half the selection duration so envelopes never overlap or corrupt short trims.
pub fn compute_effective_fade_bounds(
    start_sec: f64,
    end_sec: f64,
    fade_in_enabled: bool,
    fade_in_sec: f64,
    fade_out_enabled: bool,
    fade_out_sec: f64,
) -> EffectiveFadeBounds {
    let sel_dur = if start_sec.is_finite() && end_sec.is_finite() {
        (end_sec - start_sec).max(0.0)
    } else {
        0.0
    };
    let shared_cap = if fade_in_enabled && fade_out_enabled {
        (sel_dur * 0.5).min(MAX_FADE_CAP_SEC)
    } else {
        sel_dur.min(MAX_FADE_CAP_SEC)
    };
    let max_in = if fade_in_enabled {
        shared_cap
    } else {
        sel_dur.min(MAX_FADE_CAP_SEC)
    };
    let max_out = if fade_out_enabled {
        shared_cap
    } else {
        sel_dur.min(MAX_FADE_CAP_SEC)
    };
    let eff_in = if fade_in_enabled && fade_in_sec.is_finite() && fade_in_sec > 0.0 {
        fade_in_sec.min(max_in)
    } else {
        0.0
    };
    let eff_out = if fade_out_enabled && fade_out_sec.is_finite() && fade_out_sec > 0.0 {
        fade_out_sec.min(max_out)
    } else {
        0.0
    };
    EffectiveFadeBounds {
        selection_duration_sec: sel_dur,
        max_fade_in_sec: max_in,
        max_fade_out_sec: max_out,
        effective_fade_in_sec: eff_in,
        effective_fade_out_sec: eff_out,
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimAudioRequest {
    pub task_id: String,
    pub source_path: String,
    pub output_path: String,
    pub start_sec: f64,
    pub end_sec: f64,
    pub fade_in_enabled: bool,
    pub fade_in_sec: f64,
    pub fade_out_enabled: bool,
    pub fade_out_sec: f64,
    pub allow_overwrite: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimAudioResult {
    pub output_path: String,
    pub byte_size: u64,
    pub duration_sec: Option<f64>,
    pub output_codec: Option<String>,
    pub sample_rate_hz: Option<u32>,
    pub channels: Option<u32>,
    pub requested_start_sec: f64,
    pub requested_end_sec: f64,
    pub applied_fade_in_sec: f64,
    pub applied_fade_out_sec: f64,
    pub elapsed_ms: u64,
}

fn is_browser_natively_playable_audio(
    path: &Path,
    codec_name: Option<&str>,
    bits: Option<u32>,
) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    if matches!(ext.as_str(), "mp3" | "m4a" | "ogg" | "opus" | "flac") {
        return true;
    }
    if ext == "wav" {
        // Chromium/WebView2 reliably plays 8/16-bit PCM WAV; transcode 24/32-bit exotic PCM for safe audition
        let c = codec_name.unwrap_or("").to_ascii_lowercase();
        return bits.unwrap_or(16) <= 16 && (c.is_empty() || c == "pcm_s16le" || c == "pcm_u8");
    }
    false
}

/// Streams decoded mono `s16le` PCM at an adaptive low sample rate in fixed 32 KiB chunks into
/// `bucket_count` min/max peak buckets so even multi-hour audio stays strictly O(buckets) RAM.
pub fn extract_audio_waveform_impl(
    media_root: &Path,
    preview_registry: &MediaPreviewRegistry,
    source_raw: &str,
    requested_buckets: Option<usize>,
) -> Result<AudioWaveformPayload, AppError> {
    let (source_path, _) = validate_existing_input_file(source_raw)?;
    let tools = require_media_tools(media_root)?;
    let probe = probe_media_info_impl(media_root, source_raw)?;
    let a0 = probe.audio_streams.first().ok_or_else(|| {
        AppError::invalid_param("Selected file does not contain an audio stream.")
    })?;

    let duration_sec = a0
        .duration_sec
        .or(probe.duration_sec)
        .filter(|d| d.is_finite() && *d > 0.0)
        .ok_or_else(|| AppError::decode_failed("Unable to determine audio duration."))?;

    let buckets = requested_buckets
        .unwrap_or(DEFAULT_WAVEFORM_BUCKETS)
        .clamp(MIN_WAVEFORM_BUCKETS, MAX_WAVEFORM_BUCKETS);

    // Choose adaptive streaming sample rate: ~48 samples per bucket, bounded to [400, 8000] Hz
    let ideal_sr = ((buckets as f64 * 48.0) / duration_sec).ceil() as u32;
    let analysis_sr = ideal_sr.clamp(400, 8000);
    let expected_samples = (duration_sec * f64::from(analysis_sr)).max(buckets as f64);

    let mut cmd = Command::new(&tools.ffmpeg);
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        &source_path.to_string_lossy(),
        "-vn",
        "-map",
        "0:a:0",
        "-ac",
        "1",
        "-ar",
        &analysis_sr.to_string(),
        "-f",
        "s16le",
        "pipe:1",
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    configure_hidden_command(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| {
        AppError::new(
            "MEDIA_PROCESS_FAILED",
            format!("Failed to start FFmpeg waveform reader: {e}"),
        )
    })?;

    let mut min_peaks = vec![0.0f32; buckets];
    let mut max_peaks = vec![0.0f32; buckets];
    let mut seen_bucket = vec![false; buckets];

    let mut total_samples: u64 = 0;
    let mut carry_byte: Option<u8> = None;
    let mut buf = [0u8; 32 * 1024];

    if let Some(mut stdout) = child.stdout.take() {
        loop {
            let n = stdout.read(&mut buf).map_err(|e| {
                AppError::from_io(e, "Failed reading PCM stream for audio waveform")
            })?;
            if n == 0 {
                break;
            }
            let mut offset = 0usize;
            if let Some(prev) = carry_byte.take() {
                let sample = i16::from_le_bytes([prev, buf[0]]) as f32 / 32768.0;
                let idx = (((total_samples as f64 / expected_samples) * buckets as f64) as usize)
                    .min(buckets - 1);
                if !seen_bucket[idx] {
                    min_peaks[idx] = sample.min(0.0);
                    max_peaks[idx] = sample.max(0.0);
                    seen_bucket[idx] = true;
                } else {
                    if sample < min_peaks[idx] {
                        min_peaks[idx] = sample;
                    }
                    if sample > max_peaks[idx] {
                        max_peaks[idx] = sample;
                    }
                }
                total_samples += 1;
                offset = 1;
            }
            let slice = &buf[offset..n];
            let (chunks, rem) = slice.as_chunks::<2>();
            for c in chunks {
                let sample = i16::from_le_bytes(*c) as f32 / 32768.0;
                let idx = (((total_samples as f64 / expected_samples) * buckets as f64) as usize)
                    .min(buckets - 1);
                if !seen_bucket[idx] {
                    min_peaks[idx] = sample.min(0.0);
                    max_peaks[idx] = sample.max(0.0);
                    seen_bucket[idx] = true;
                } else {
                    if sample < min_peaks[idx] {
                        min_peaks[idx] = sample;
                    }
                    if sample > max_peaks[idx] {
                        max_peaks[idx] = sample;
                    }
                }
                total_samples += 1;
            }
            if let Some(&b) = rem.first() {
                carry_byte = Some(b);
            }
        }
    }

    let status = child.wait_with_output().map_err(|e| {
        AppError::new(
            "MEDIA_PROCESS_FAILED",
            format!("Waveform reader error: {e}"),
        )
    })?;
    if !status.status.success() && total_samples == 0 {
        let stderr = String::from_utf8_lossy(&status.stderr).trim().to_string();
        return Err(AppError::decode_failed(if stderr.is_empty() {
            "Unable to decode audio stream for waveform.".into()
        } else {
            stderr
        }));
    }

    // Prepare browser-playable audition URL
    let (audition_url, audition_transcoded) = if is_browser_natively_playable_audio(
        &source_path,
        a0.codec_name.as_deref(),
        a0.bits_per_sample,
    ) {
        let reg = preview_registry.register_path(source_raw)?;
        (reg.url, false)
    } else {
        let cache_dir = media_root.join(".preview-cache");
        fs::create_dir_all(&cache_dir)
            .map_err(|e| AppError::from_io(e, "Unable to create audio preview cache directory"))?;
        let preview_path = cache_dir.join(format!("a03-audition-{}.m4a", Uuid::new_v4()));
        let cancel = AtomicBool::new(false);
        run_ffmpeg_cancellable(
            &tools.ffmpeg,
            &[
                "-i".into(),
                source_path.to_string_lossy().to_string(),
                "-vn".into(),
                "-map".into(),
                "0:a:0".into(),
                "-c:a".into(),
                "aac".into(),
                "-b:a".into(),
                "192k".into(),
                "-movflags".into(),
                "+faststart".into(),
                preview_path.to_string_lossy().to_string(),
            ],
            Some(duration_sec),
            &cancel,
            |_, _| {},
        )?;
        let reg = preview_registry.register_path(&preview_path.to_string_lossy())?;
        (reg.url, true)
    };

    Ok(AudioWaveformPayload {
        source_path: source_path.to_string_lossy().to_string(),
        file_name: probe.file_name,
        duration_sec,
        sample_rate_hz: a0.sample_rate_hz,
        channels: a0.channels,
        codec_name: a0.codec_name.clone(),
        bits_per_sample: a0.bits_per_sample,
        analysis_sample_rate_hz: analysis_sr,
        bucket_count: buckets,
        min_peaks,
        max_peaks,
        audition_url,
        audition_transcoded,
    })
}

fn push_output_codec_args(
    out_path: &Path,
    src_bits: Option<u32>,
    src_sample_fmt: Option<&str>,
    args: &mut Vec<String>,
) {
    let ext = out_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_else(|| "wav".into());
    match ext.as_str() {
        "mp3" => {
            args.extend([
                "-c:a".into(),
                "libmp3lame".into(),
                "-b:a".into(),
                "192k".into(),
                "-f".into(),
                "mp3".into(),
            ]);
        }
        "m4a" | "aac" => {
            args.extend([
                "-c:a".into(),
                "aac".into(),
                "-b:a".into(),
                "192k".into(),
                "-movflags".into(),
                "+faststart".into(),
                "-f".into(),
                "ipod".into(),
            ]);
        }
        "flac" => {
            args.extend(["-c:a".into(), "flac".into()]);
            if src_bits.unwrap_or(16) >= 24 {
                args.extend(["-sample_fmt".into(), "s32".into()]);
            }
            args.extend(["-f".into(), "flac".into()]);
        }
        "aif" | "aiff" => {
            let pcm = match src_bits {
                Some(24) => "pcm_s24be",
                Some(32) => "pcm_s32be",
                _ => "pcm_s16be",
            };
            args.extend(["-c:a".into(), pcm.into(), "-f".into(), "aiff".into()]);
        }
        "ogg" => {
            args.extend([
                "-c:a".into(),
                "libvorbis".into(),
                "-q:a".into(),
                "5".into(),
                "-f".into(),
                "ogg".into(),
            ]);
        }
        "opus" => {
            args.extend([
                "-c:a".into(),
                "libopus".into(),
                "-b:a".into(),
                "160k".into(),
                "-f".into(),
                "opus".into(),
            ]);
        }
        _ => {
            let is_float = src_sample_fmt.map(|f| f.contains("flt")).unwrap_or(false);
            let pcm = match (src_bits, is_float) {
                (Some(32), true) => "pcm_f32le",
                (Some(32), false) => "pcm_s32le",
                (Some(24), _) => "pcm_s24le",
                (Some(8), _) => "pcm_u8",
                _ => "pcm_s16le",
            };
            args.extend(["-c:a".into(), pcm.into(), "-f".into(), "wav".into()]);
        }
    }
}

pub fn trim_audio_file_impl(
    media_root: &Path,
    req: &TrimAudioRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(MediaTaskProgressPayload),
) -> Result<TrimAudioResult, AppError> {
    let t0 = Instant::now();
    let (source_path, _) = validate_existing_input_file(&req.source_path)?;
    let out_path = PathBuf::from(req.output_path.trim());
    if !out_path.is_absolute() {
        return Err(AppError::invalid_param(
            "Output file path must be an absolute path.",
        ));
    }

    let tools = require_media_tools(media_root)?;
    let probe = probe_media_info_impl(media_root, &req.source_path)?;
    let a0 = probe.audio_streams.first().ok_or_else(|| {
        AppError::invalid_param("Selected file does not contain an audio stream.")
    })?;
    let total_dur = a0
        .duration_sec
        .or(probe.duration_sec)
        .filter(|d| d.is_finite() && *d > 0.0)
        .ok_or_else(|| AppError::decode_failed("Unable to determine audio duration."))?;

    if !req.start_sec.is_finite()
        || !req.end_sec.is_finite()
        || req.start_sec < 0.0
        || req.end_sec <= req.start_sec + 0.02
    {
        return Err(AppError::invalid_param(
            "End time must be at least 0.02 seconds greater than start time.",
        ));
    }
    let start_sec = req.start_sec.clamp(0.0, (total_dur - 0.02).max(0.0));
    let end_sec = req.end_sec.clamp(start_sec + 0.02, total_dur);
    let sel_dur = end_sec - start_sec;

    let bounds = compute_effective_fade_bounds(
        start_sec,
        end_sec,
        req.fade_in_enabled,
        req.fade_in_sec,
        req.fade_out_enabled,
        req.fade_out_sec,
    );

    let allow_overwrite = req.allow_overwrite.unwrap_or(false);
    let atomic = AtomicMediaOutput::prepare(out_path.clone(), &source_path, allow_overwrite)?;

    // For long files where start > 10s, fast coarse pre-seek before -i, then exact sample-level `atrim`
    let pre_seek = if start_sec > 10.0 {
        (start_sec - 2.0).max(0.0)
    } else {
        0.0
    };
    let rel_start = start_sec - pre_seek;
    let rel_end = end_sec - pre_seek;

    let mut filters: Vec<String> = vec![format!(
        "atrim=start={rel_start:.6}:end={rel_end:.6},asetpts=PTS-STARTPTS"
    )];
    if bounds.effective_fade_in_sec > 1e-4 {
        filters.push(format!(
            "afade=t=in:st=0:d={:.6}",
            bounds.effective_fade_in_sec
        ));
    }
    if bounds.effective_fade_out_sec > 1e-4 {
        let fade_out_start = (sel_dur - bounds.effective_fade_out_sec).max(0.0);
        filters.push(format!(
            "afade=t=out:st={fade_out_start:.6}:d={:.6}",
            bounds.effective_fade_out_sec
        ));
    }

    let mut args: Vec<String> = Vec::new();
    if pre_seek > 0.0 {
        args.extend(["-ss".into(), format!("{pre_seek:.6}")]);
    }
    args.extend([
        "-i".into(),
        source_path.to_string_lossy().to_string(),
        "-vn".into(),
        "-map".into(),
        "0:a:0".into(),
        "-af".into(),
        filters.join(","),
    ]);
    push_output_codec_args(
        &out_path,
        a0.bits_per_sample,
        a0.sample_fmt.as_deref(),
        &mut args,
    );
    args.push(atomic.temp_path().to_string_lossy().to_string());

    on_progress(MediaTaskProgressPayload {
        task_id: req.task_id.clone(),
        tool_id: "A03".into(),
        phase: "running".into(),
        current_item: 1,
        total_items: 1,
        item_name: Some(probe.file_name.clone()),
        percent: Some(0.0),
        out_time_sec: Some(0.0),
        total_duration_sec: Some(sel_dur),
    });

    run_ffmpeg_cancellable(
        &tools.ffmpeg,
        &args,
        Some(sel_dur),
        cancel_flag,
        |out_t, pct| {
            on_progress(MediaTaskProgressPayload {
                task_id: req.task_id.clone(),
                tool_id: "A03".into(),
                phase: "running".into(),
                current_item: 1,
                total_items: 1,
                item_name: Some(probe.file_name.clone()),
                percent: pct,
                out_time_sec: out_t,
                total_duration_sec: Some(sel_dur),
            });
        },
    )?;

    let (committed, byte_size) = atomic.commit(allow_overwrite)?;
    let out_probe = probe_media_info_impl(media_root, &committed.to_string_lossy()).ok();
    let out_a = out_probe.as_ref().and_then(|p| p.audio_streams.first());

    on_progress(MediaTaskProgressPayload {
        task_id: req.task_id.clone(),
        tool_id: "A03".into(),
        phase: "completed".into(),
        current_item: 1,
        total_items: 1,
        item_name: Some(probe.file_name),
        percent: Some(100.0),
        out_time_sec: Some(sel_dur),
        total_duration_sec: Some(sel_dur),
    });

    Ok(TrimAudioResult {
        output_path: committed.to_string_lossy().to_string(),
        byte_size,
        duration_sec: out_a
            .and_then(|a| a.duration_sec)
            .or_else(|| out_probe.as_ref().and_then(|p| p.duration_sec)),
        output_codec: out_a.and_then(|a| a.codec_name.clone()),
        sample_rate_hz: out_a.and_then(|a| a.sample_rate_hz),
        channels: out_a.and_then(|a| a.channels),
        requested_start_sec: start_sec,
        requested_end_sec: end_sec,
        applied_fade_in_sec: bounds.effective_fade_in_sec,
        applied_fade_out_sec: bounds.effective_fade_out_sec,
        elapsed_ms: t0.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;
    use tempfile::tempdir;

    #[test]
    fn fade_bounds_clamp_short_selections_explicitly_without_overlap() {
        // 1.0s selection with both fade-in and fade-out enabled -> max 0.5s per side
        let b = compute_effective_fade_bounds(2.0, 3.0, true, 1.2, true, 0.8);
        assert!((b.selection_duration_sec - 1.0).abs() < 1e-6);
        assert!((b.max_fade_in_sec - 0.5).abs() < 1e-6);
        assert!((b.max_fade_out_sec - 0.5).abs() < 1e-6);
        assert!((b.effective_fade_in_sec - 0.5).abs() < 1e-6);
        assert!((b.effective_fade_out_sec - 0.5).abs() < 1e-6);

        // Only fade-in enabled on 0.6s selection -> can span up to 0.6s
        let b2 = compute_effective_fade_bounds(0.0, 0.6, true, 0.5, false, 0.5);
        assert!((b2.max_fade_in_sec - 0.6).abs() < 1e-6);
        assert!((b2.effective_fade_in_sec - 0.5).abs() < 1e-6);
        assert!((b2.effective_fade_out_sec - 0.0).abs() < 1e-6);
    }

    fn write_pcm16_stereo_wav(path: &Path, sr: u32, samples_lr: &[(i16, i16)]) {
        let data_bytes = (samples_lr.len() * 4) as u32;
        let mut out = Vec::with_capacity(44 + data_bytes as usize);
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_bytes).to_le_bytes());
        out.extend_from_slice(b"WAVE");
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes()); // PCM
        out.extend_from_slice(&2u16.to_le_bytes()); // stereo
        out.extend_from_slice(&sr.to_le_bytes());
        out.extend_from_slice(&(sr * 4).to_le_bytes());
        out.extend_from_slice(&4u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_bytes.to_le_bytes());
        for &(l, r) in samples_lr {
            out.extend_from_slice(&l.to_le_bytes());
            out.extend_from_slice(&r.to_le_bytes());
        }
        fs::write(path, out).unwrap();
    }

    fn decode_mono_16k(ffmpeg: &Path, path: &Path) -> Vec<f64> {
        let out = Command::new(ffmpeg)
            .args([
                "-v",
                "error",
                "-i",
                &path.to_string_lossy(),
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-f",
                "s16le",
                "pipe:1",
            ])
            .output()
            .unwrap();
        assert!(out.status.success());
        out.stdout
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| i16::from_le_bytes(*c) as f64 / 32768.0)
            .collect()
    }

    fn rms(xs: &[f64]) -> f64 {
        if xs.is_empty() {
            return 0.0;
        }
        (xs.iter().map(|v| v * v).sum::<f64>() / xs.len() as f64).sqrt()
    }

    fn peak_freq_hz(xs: &[f64], sr: f64) -> f64 {
        let n = xs.len().min(4096);
        let mut best_f = 0.0;
        let mut best_mag = -1.0;
        for f in (200..=1200).step_by(5) {
            let w = 2.0 * PI * (f as f64) / sr;
            let mut re = 0.0;
            let mut im = 0.0;
            for (i, &s) in xs[..n].iter().enumerate() {
                let a = w * (i as f64);
                re += s * a.cos();
                im += s * a.sin();
            }
            let mag = re * re + im * im;
            if mag > best_mag {
                best_mag = mag;
                best_f = f as f64;
            }
        }
        best_f
    }

    #[test]
    fn verifies_waveform_extraction_onset_cut_points_and_fade_envelopes() {
        let dir = tempdir().unwrap();
        let Ok(tools) = require_media_tools(dir.path()) else {
            return;
        };
        let sr = 48_000u32;
        let total = (sr * 4) as usize;
        let mut samples = Vec::with_capacity(total);
        // [0..1.0s] silence, [1.0..2.0s] 440 Hz tone, [2.0..3.0s] 880 Hz tone, [3.0..4.0s] silence
        for i in 0..total {
            let t = i as f64 / f64::from(sr);
            let v = if (1.0..2.0).contains(&t) {
                (0.75 * (2.0 * PI * 440.0 * t).sin() * 32767.0).round() as i16
            } else if (2.0..3.0).contains(&t) {
                (0.75 * (2.0 * PI * 880.0 * t).sin() * 32767.0).round() as i16
            } else {
                0
            };
            samples.push((v, v));
        }
        let src = dir.path().join("onset_4s.wav");
        write_pcm16_stereo_wav(&src, sr, &samples);

        // 1. Bounded-memory waveform extraction reflects silence [0..1s], active [1..3s], silence [3..4s]
        let reg = MediaPreviewRegistry::default();
        let wf = extract_audio_waveform_impl(dir.path(), &reg, &src.to_string_lossy(), Some(400))
            .unwrap();
        assert_eq!(wf.bucket_count, 400);
        assert!((wf.duration_sec - 4.0).abs() < 0.02);
        assert!(wf.max_peaks[20] < 0.01, "0.2s should be silent in waveform");
        assert!(wf.max_peaks[150] > 0.5, "1.5s should be active in waveform");
        assert!(
            wf.max_peaks[360] < 0.01,
            "3.6s should be silent in waveform"
        );

        // 2. Trim [1.0s, 3.0s] with 0.4s fade-in and 0.4s fade-out
        let out = dir.path().join("trimmed_faded.wav");
        let cancel = AtomicBool::new(false);
        let res = trim_audio_file_impl(
            dir.path(),
            &TrimAudioRequest {
                task_id: "a03-test".into(),
                source_path: src.to_string_lossy().to_string(),
                output_path: out.to_string_lossy().to_string(),
                start_sec: 1.0,
                end_sec: 3.0,
                fade_in_enabled: true,
                fade_in_sec: 0.4,
                fade_out_enabled: true,
                fade_out_sec: 0.4,
                allow_overwrite: Some(false),
            },
            &cancel,
            |_| {},
        )
        .unwrap();
        assert!((res.duration_sec.unwrap() - 2.0).abs() < 0.02);

        let pcm = decode_mono_16k(&tools.ffmpeg, &out);
        let r_start = rms(&pcm[160..800]); // 0.01..0.05s (early fade-in)
        let r_mid_in = rms(&pcm[3200..4000]); // 0.20..0.25s (halfway fade-in)
        let r_steady_1 = rms(&pcm[9600..14400]); // 0.60..0.90s (steady 440 Hz)
        let r_steady_2 = rms(&pcm[17600..22400]); // 1.10..1.40s (steady 880 Hz)
        let r_mid_out = rms(&pcm[28000..28800]); // 1.75..1.80s (halfway fade-out)
        let r_end = rms(&pcm[31000..pcm.len().min(31840)]); // 1.94..1.99s (late fade-out)

        assert!(
            r_start < r_mid_in && r_mid_in < r_steady_1,
            "Fade-in must rise monotonically: {r_start:.4} < {r_mid_in:.4} < {r_steady_1:.4}"
        );
        assert!(
            r_start < r_steady_1 * 0.25,
            "Fade-in start should be attenuated: {r_start:.4} vs {r_steady_1:.4}"
        );
        assert!(
            r_steady_2 > r_mid_out && r_mid_out > r_end,
            "Fade-out must decay monotonically: {r_steady_2:.4} > {r_mid_out:.4} > {r_end:.4}"
        );
        assert!(
            r_end < r_steady_2 * 0.25,
            "Fade-out tail should be attenuated: {r_end:.4} vs {r_steady_2:.4}"
        );
        assert!((peak_freq_hz(&pcm[9600..14400], 16000.0) - 440.0).abs() <= 20.0);
        assert!((peak_freq_hz(&pcm[17600..22400], 16000.0) - 880.0).abs() <= 20.0);
    }
}
