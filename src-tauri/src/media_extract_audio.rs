//! A04 Extract Audio — selects a specific audio track from videos and exports to
//! M4A, MP3, WAV, or FLAC. Performs lossless stream copy when compatible and no transcode/bitrate
//! override is requested, and clearly reports transcoding otherwise. Never writes empty files
//! for silent videos.

use crate::error::AppError;
use crate::fs_guard::validate_existing_input_file;
use crate::media_core::{
    allocate_non_colliding_output_path, require_media_tools, run_ffmpeg_cancellable,
    AtomicMediaOutput, MediaPreviewRegistry, MediaTaskProgressPayload,
};
use crate::media_info::probe_media_info_impl;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioExtractFormat {
    M4a,
    Mp3,
    Wav,
    Flac,
}

impl AudioExtractFormat {
    pub fn extension(self) -> &'static str {
        match self {
            AudioExtractFormat::M4a => "m4a",
            AudioExtractFormat::Mp3 => "mp3",
            AudioExtractFormat::Wav => "wav",
            AudioExtractFormat::Flac => "flac",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioExtractionPlan {
    pub will_stream_copy: bool,
    pub source_codec: Option<String>,
    pub target_format: AudioExtractFormat,
    pub target_codec_label: String,
    pub target_bitrate_kbps: Option<u32>,
}

/// Pure compatibility planner shared between UI preview and backend execution.
pub fn plan_audio_extraction(
    source_codec: Option<&str>,
    target_format: AudioExtractFormat,
    prefer_stream_copy: bool,
    bitrate_kbps: Option<u32>,
) -> AudioExtractionPlan {
    let norm = source_codec
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty());

    let copy_compatible = matches!(
        (target_format, norm.as_deref()),
        (AudioExtractFormat::M4a, Some("aac" | "alac"))
            | (AudioExtractFormat::Mp3, Some("mp3"))
            | (AudioExtractFormat::Flac, Some("flac"))
            | (
                AudioExtractFormat::Wav,
                Some("pcm_s16le" | "pcm_s24le" | "pcm_s32le" | "pcm_f32le" | "pcm_u8"),
            )
    );

    // If user explicitly requests a specific bitrate on lossy targets, transcode honestly
    let bitrate_forces_transcode = match target_format {
        AudioExtractFormat::M4a | AudioExtractFormat::Mp3 => bitrate_kbps.is_some(),
        AudioExtractFormat::Wav | AudioExtractFormat::Flac => false,
    };

    let will_stream_copy = prefer_stream_copy && copy_compatible && !bitrate_forces_transcode;

    let (target_codec_label, eff_bitrate) = if will_stream_copy {
        (
            format!(
                "{} (copy)",
                norm.as_deref().unwrap_or("stream").to_ascii_uppercase()
            ),
            None,
        )
    } else {
        match target_format {
            AudioExtractFormat::M4a => ("AAC".into(), Some(bitrate_kbps.unwrap_or(192))),
            AudioExtractFormat::Mp3 => ("MP3 (LAME)".into(), Some(bitrate_kbps.unwrap_or(192))),
            AudioExtractFormat::Wav => ("PCM 16-bit".into(), None),
            AudioExtractFormat::Flac => ("FLAC (Lossless)".into(), None),
        }
    };

    AudioExtractionPlan {
        will_stream_copy,
        source_codec: norm,
        target_format,
        target_codec_label,
        target_bitrate_kbps: eff_bitrate,
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractAudioItemInput {
    pub source_path: String,
    pub audio_track_index: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractAudioBatchRequest {
    pub task_id: String,
    pub items: Vec<ExtractAudioItemInput>,
    pub output_dir: String,
    pub format: AudioExtractFormat,
    pub prefer_stream_copy: bool,
    pub bitrate_kbps: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtractAudioItemStatus {
    Extracted,
    NoAudio,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractAudioItemResult {
    pub source_path: String,
    pub file_name: String,
    pub audio_track_index: usize,
    pub track_language: Option<String>,
    pub status: ExtractAudioItemStatus,
    pub used_stream_copy: bool,
    pub output_path: Option<String>,
    pub byte_size: Option<u64>,
    pub duration_sec: Option<f64>,
    pub output_codec: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractAudioBatchResponse {
    pub task_id: String,
    pub output_dir: String,
    pub cancelled: bool,
    pub extracted_count: usize,
    pub no_audio_count: usize,
    pub skipped_count: usize,
    pub failed_count: usize,
    pub elapsed_ms: u64,
    pub items: Vec<ExtractAudioItemResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrackPreviewResult {
    pub preview_url: String,
    pub audio_track_index: usize,
    pub duration_sec: Option<f64>,
}

/// Extracts a short playable M4A sample (up to 30 seconds) of the exact selected audio track
/// `0:a:<audio_track_index>` so users can audition and distinguish multi-language tracks in WebView2.
pub fn preview_audio_track_impl(
    media_root: &Path,
    preview_registry: &MediaPreviewRegistry,
    source_raw: &str,
    audio_track_index: usize,
) -> Result<AudioTrackPreviewResult, AppError> {
    let (source_path, _) = validate_existing_input_file(source_raw)?;
    let tools = require_media_tools(media_root)?;
    let probe = probe_media_info_impl(media_root, source_raw)?;
    if probe.audio_streams.is_empty() {
        return Err(AppError::invalid_param(
            "This file has no audio tracks to preview.",
        ));
    }
    if audio_track_index >= probe.audio_streams.len() {
        return Err(AppError::invalid_param(
            "Selected audio track index is out of range.",
        ));
    }

    let preview_dir = std::env::temp_dir().join("winkit-audio-preview");
    fs::create_dir_all(&preview_dir)
        .map_err(|e| AppError::from_io(e, "Unable to create temporary preview folder"))?;
    let out_file = preview_dir.join(format!(
        "track-{}-{}.m4a",
        audio_track_index,
        Uuid::new_v4()
    ));

    let cancel = AtomicBool::new(false);
    let args: Vec<String> = vec![
        "-i".into(),
        source_path.to_string_lossy().to_string(),
        "-vn".into(),
        "-map".into(),
        format!("0:a:{audio_track_index}"),
        "-t".into(),
        "30".into(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "128k".into(),
        "-movflags".into(),
        "+faststart".into(),
        out_file.to_string_lossy().to_string(),
    ];

    run_ffmpeg_cancellable(&tools.ffmpeg, &args, Some(30.0), &cancel, |_, _| {})?;
    let reg = preview_registry.register_path(&out_file.to_string_lossy())?;
    Ok(AudioTrackPreviewResult {
        preview_url: reg.url,
        audio_track_index,
        duration_sec: probe.duration_sec.map(|d| d.min(30.0)),
    })
}

pub fn extract_audio_batch_impl(
    media_root: &Path,
    req: &ExtractAudioBatchRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(MediaTaskProgressPayload),
) -> Result<ExtractAudioBatchResponse, AppError> {
    let t0 = Instant::now();
    if req.items.is_empty() {
        return Err(AppError::invalid_param(
            "Select at least one media file to extract audio.",
        ));
    }
    let out_dir = PathBuf::from(req.output_dir.trim());
    if !out_dir.is_absolute() {
        return Err(AppError::invalid_param(
            "Output directory must be an absolute path.",
        ));
    }
    if let Some(kbps) = req.bitrate_kbps {
        if !(32..=512).contains(&kbps) {
            return Err(AppError::invalid_param(
                "Audio bitrate must be between 32 and 512 kbps.",
            ));
        }
    }
    let tools = require_media_tools(media_root)?;

    let total = req.items.len();
    let mut results: Vec<ExtractAudioItemResult> = Vec::with_capacity(total);
    let mut extracted_count = 0usize;
    let mut no_audio_count = 0usize;
    let mut skipped_count = 0usize;
    let mut failed_count = 0usize;
    let mut cancelled = false;

    for (idx, item) in req.items.iter().enumerate() {
        let fallback_name = Path::new(&item.source_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&item.source_path)
            .to_string();

        if cancel_flag.load(Ordering::Relaxed) {
            cancelled = true;
            skipped_count += 1;
            results.push(ExtractAudioItemResult {
                source_path: item.source_path.clone(),
                file_name: fallback_name,
                audio_track_index: item.audio_track_index,
                track_language: None,
                status: ExtractAudioItemStatus::Skipped,
                used_stream_copy: false,
                output_path: None,
                byte_size: None,
                duration_sec: None,
                output_codec: None,
                message: Some("Cancelled before processing.".into()),
            });
            continue;
        }

        on_progress(MediaTaskProgressPayload {
            task_id: req.task_id.clone(),
            tool_id: "A04".into(),
            phase: "running".into(),
            current_item: idx + 1,
            total_items: total,
            item_name: Some(fallback_name.clone()),
            percent: Some(((idx as f64) / (total as f64) * 100.0).clamp(0.0, 99.0)),
            out_time_sec: None,
            total_duration_sec: None,
        });

        let (source_path, _) = match validate_existing_input_file(&item.source_path) {
            Ok(v) => v,
            Err(e) => {
                failed_count += 1;
                results.push(ExtractAudioItemResult {
                    source_path: item.source_path.clone(),
                    file_name: fallback_name,
                    audio_track_index: item.audio_track_index,
                    track_language: None,
                    status: ExtractAudioItemStatus::Failed,
                    used_stream_copy: false,
                    output_path: None,
                    byte_size: None,
                    duration_sec: None,
                    output_codec: None,
                    message: Some(e.message),
                });
                continue;
            }
        };

        let probe = match probe_media_info_impl(media_root, &item.source_path) {
            Ok(p) => p,
            Err(e) => {
                failed_count += 1;
                results.push(ExtractAudioItemResult {
                    source_path: item.source_path.clone(),
                    file_name: fallback_name,
                    audio_track_index: item.audio_track_index,
                    track_language: None,
                    status: ExtractAudioItemStatus::Failed,
                    used_stream_copy: false,
                    output_path: None,
                    byte_size: None,
                    duration_sec: None,
                    output_codec: None,
                    message: Some(e.message),
                });
                continue;
            }
        };

        if probe.audio_streams.is_empty() {
            no_audio_count += 1;
            results.push(ExtractAudioItemResult {
                source_path: item.source_path.clone(),
                file_name: probe.file_name,
                audio_track_index: 0,
                track_language: None,
                status: ExtractAudioItemStatus::NoAudio,
                used_stream_copy: false,
                output_path: None,
                byte_size: None,
                duration_sec: probe.duration_sec,
                output_codec: None,
                message: Some("Source file has no audio tracks; no file was created.".into()),
            });
            continue;
        }

        let safe_track_idx = if item.audio_track_index < probe.audio_streams.len() {
            item.audio_track_index
        } else {
            0
        };
        let track = &probe.audio_streams[safe_track_idx];
        let plan = plan_audio_extraction(
            track.codec_name.as_deref(),
            req.format,
            req.prefer_stream_copy,
            req.bitrate_kbps,
        );

        let stem = source_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("audio");
        let suffix = if probe.audio_streams.len() > 1 {
            if let Some(lang) = &track.language {
                format!("_track{}_{}", safe_track_idx + 1, lang)
            } else {
                format!("_track{}", safe_track_idx + 1)
            }
        } else {
            String::new()
        };

        let target_path = match allocate_non_colliding_output_path(
            &out_dir,
            stem,
            &suffix,
            req.format.extension(),
            &source_path,
        ) {
            Ok(p) => p,
            Err(e) => {
                failed_count += 1;
                results.push(ExtractAudioItemResult {
                    source_path: item.source_path.clone(),
                    file_name: probe.file_name,
                    audio_track_index: safe_track_idx,
                    track_language: track.language.clone(),
                    status: ExtractAudioItemStatus::Failed,
                    used_stream_copy: false,
                    output_path: None,
                    byte_size: None,
                    duration_sec: probe.duration_sec,
                    output_codec: None,
                    message: Some(e.message),
                });
                continue;
            }
        };

        let atomic_out = match AtomicMediaOutput::prepare(target_path, &source_path, false) {
            Ok(a) => a,
            Err(e) => {
                failed_count += 1;
                results.push(ExtractAudioItemResult {
                    source_path: item.source_path.clone(),
                    file_name: probe.file_name,
                    audio_track_index: safe_track_idx,
                    track_language: track.language.clone(),
                    status: ExtractAudioItemStatus::Failed,
                    used_stream_copy: false,
                    output_path: None,
                    byte_size: None,
                    duration_sec: probe.duration_sec,
                    output_codec: None,
                    message: Some(e.message),
                });
                continue;
            }
        };

        let mut args: Vec<String> = vec![
            "-i".into(),
            source_path.to_string_lossy().to_string(),
            "-vn".into(),
            "-sn".into(),
            "-dn".into(),
            "-map".into(),
            format!("0:a:{safe_track_idx}"),
        ];

        if plan.will_stream_copy {
            args.push("-c:a".into());
            args.push("copy".into());
        } else {
            match req.format {
                AudioExtractFormat::M4a => {
                    let br = plan.target_bitrate_kbps.unwrap_or(192);
                    args.push("-c:a".into());
                    args.push("aac".into());
                    args.push("-b:a".into());
                    args.push(format!("{br}k"));
                }
                AudioExtractFormat::Mp3 => {
                    let br = plan.target_bitrate_kbps.unwrap_or(192);
                    args.push("-c:a".into());
                    args.push("libmp3lame".into());
                    args.push("-b:a".into());
                    args.push(format!("{br}k"));
                }
                AudioExtractFormat::Wav => {
                    args.push("-c:a".into());
                    args.push("pcm_s16le".into());
                }
                AudioExtractFormat::Flac => {
                    args.push("-c:a".into());
                    args.push("flac".into());
                }
            }
        }
        if req.format == AudioExtractFormat::M4a {
            args.push("-movflags".into());
            args.push("+faststart".into());
        }
        args.push(atomic_out.temp_path().to_string_lossy().to_string());

        let base_pct = (idx as f64) / (total as f64) * 100.0;
        let span_pct = 100.0 / (total as f64);
        let item_name_for_cb = probe.file_name.clone();
        let task_id_for_cb = req.task_id.clone();
        let dur_for_cb = probe.duration_sec;

        let run_res = run_ffmpeg_cancellable(
            &tools.ffmpeg,
            &args,
            probe.duration_sec,
            cancel_flag,
            |out_sec, item_pct| {
                let overall = base_pct + (item_pct.unwrap_or(0.0) / 100.0) * span_pct;
                on_progress(MediaTaskProgressPayload {
                    task_id: task_id_for_cb.clone(),
                    tool_id: "A04".into(),
                    phase: "running".into(),
                    current_item: idx + 1,
                    total_items: total,
                    item_name: Some(item_name_for_cb.clone()),
                    percent: Some(overall.clamp(0.0, 99.0)),
                    out_time_sec: out_sec,
                    total_duration_sec: dur_for_cb,
                });
            },
        );

        match run_res {
            Ok(()) => match atomic_out.commit(false) {
                Ok((committed_path, byte_size)) => {
                    let out_probe =
                        probe_media_info_impl(media_root, &committed_path.to_string_lossy()).ok();
                    extracted_count += 1;
                    results.push(ExtractAudioItemResult {
                        source_path: item.source_path.clone(),
                        file_name: probe.file_name,
                        audio_track_index: safe_track_idx,
                        track_language: track.language.clone(),
                        status: ExtractAudioItemStatus::Extracted,
                        used_stream_copy: plan.will_stream_copy,
                        output_path: Some(committed_path.to_string_lossy().to_string()),
                        byte_size: Some(byte_size),
                        duration_sec: out_probe
                            .as_ref()
                            .and_then(|p| p.duration_sec)
                            .or(probe.duration_sec),
                        output_codec: out_probe
                            .as_ref()
                            .and_then(|p| p.audio_streams.first())
                            .and_then(|a| a.codec_name.clone()),
                        message: None,
                    });
                }
                Err(e) => {
                    failed_count += 1;
                    results.push(ExtractAudioItemResult {
                        source_path: item.source_path.clone(),
                        file_name: probe.file_name,
                        audio_track_index: safe_track_idx,
                        track_language: track.language.clone(),
                        status: ExtractAudioItemStatus::Failed,
                        used_stream_copy: false,
                        output_path: None,
                        byte_size: None,
                        duration_sec: probe.duration_sec,
                        output_codec: None,
                        message: Some(e.message),
                    });
                }
            },
            Err(e) if e.code == "TASK_CANCELLED" => {
                drop(atomic_out);
                cancelled = true;
                skipped_count += 1;
                results.push(ExtractAudioItemResult {
                    source_path: item.source_path.clone(),
                    file_name: probe.file_name,
                    audio_track_index: safe_track_idx,
                    track_language: track.language.clone(),
                    status: ExtractAudioItemStatus::Skipped,
                    used_stream_copy: false,
                    output_path: None,
                    byte_size: None,
                    duration_sec: probe.duration_sec,
                    output_codec: None,
                    message: Some("Cancelled by user.".into()),
                });
            }
            Err(e) => {
                drop(atomic_out);
                failed_count += 1;
                results.push(ExtractAudioItemResult {
                    source_path: item.source_path.clone(),
                    file_name: probe.file_name,
                    audio_track_index: safe_track_idx,
                    track_language: track.language.clone(),
                    status: ExtractAudioItemStatus::Failed,
                    used_stream_copy: false,
                    output_path: None,
                    byte_size: None,
                    duration_sec: probe.duration_sec,
                    output_codec: None,
                    message: Some(e.message),
                });
            }
        }
    }

    Ok(ExtractAudioBatchResponse {
        task_id: req.task_id.clone(),
        output_dir: out_dir.to_string_lossy().to_string(),
        cancelled,
        extracted_count,
        no_audio_count,
        skipped_count,
        failed_count,
        elapsed_ms: t0.elapsed().as_millis() as u64,
        items: results,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media_core::get_media_tools_status_impl;
    use tempfile::tempdir;

    #[test]
    fn audio_plan_distinguishes_stream_copy_vs_transcode_accurately() {
        let p_copy = plan_audio_extraction(Some("aac"), AudioExtractFormat::M4a, true, None);
        assert!(p_copy.will_stream_copy);

        let p_bitrate =
            plan_audio_extraction(Some("aac"), AudioExtractFormat::M4a, true, Some(256));
        assert!(!p_bitrate.will_stream_copy);
        assert_eq!(p_bitrate.target_bitrate_kbps, Some(256));

        let p_mp3 = plan_audio_extraction(Some("aac"), AudioExtractFormat::Mp3, true, None);
        assert!(!p_mp3.will_stream_copy);
        assert_eq!(p_mp3.target_bitrate_kbps, Some(192));

        let p_flac = plan_audio_extraction(Some("flac"), AudioExtractFormat::Flac, true, None);
        assert!(p_flac.will_stream_copy);
    }

    #[test]
    fn extracts_selected_track_copy_or_transcode_and_creates_zero_files_for_silent_video() {
        let dir = tempdir().unwrap();
        let status = get_media_tools_status_impl(dir.path());
        if !status.ready {
            return;
        }
        let ffmpeg = Path::new(status.ffmpeg_path.as_deref().unwrap());
        let cancel = AtomicBool::new(false);

        let dual = dir.path().join("dual_audio.mp4");
        run_ffmpeg_cancellable(
            ffmpeg,
            &[
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "testsrc2=size=320x180:rate=25:duration=2".into(),
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "sine=frequency=440:sample_rate=48000:duration=2".into(),
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "sine=frequency=880:sample_rate=48000:duration=2".into(),
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
                "-b:a".into(),
                "96k".into(),
                "-metadata:s:a:0".into(),
                "language=eng".into(),
                "-metadata:s:a:1".into(),
                "language=zho".into(),
                dual.to_string_lossy().to_string(),
            ],
            Some(2.0),
            &cancel,
            |_, _| {},
        )
        .unwrap();

        let silent = dir.path().join("silent.mp4");
        run_ffmpeg_cancellable(
            ffmpeg,
            &[
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "testsrc2=size=320x180:rate=25:duration=1".into(),
                "-c:v".into(),
                "libx264".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
                silent.to_string_lossy().to_string(),
            ],
            Some(1.0),
            &cancel,
            |_, _| {},
        )
        .unwrap();

        let out_m4a = dir.path().join("out_m4a");
        let resp_copy = extract_audio_batch_impl(
            dir.path(),
            &ExtractAudioBatchRequest {
                task_id: "a04-copy".into(),
                items: vec![
                    ExtractAudioItemInput {
                        source_path: dual.to_string_lossy().to_string(),
                        audio_track_index: 1,
                    },
                    ExtractAudioItemInput {
                        source_path: silent.to_string_lossy().to_string(),
                        audio_track_index: 0,
                    },
                ],
                output_dir: out_m4a.to_string_lossy().to_string(),
                format: AudioExtractFormat::M4a,
                prefer_stream_copy: true,
                bitrate_kbps: None,
            },
            &cancel,
            |_| {},
        )
        .unwrap();

        assert_eq!(resp_copy.extracted_count, 1);
        assert_eq!(resp_copy.no_audio_count, 1);
        assert!(resp_copy.items[0].used_stream_copy);
        assert_eq!(resp_copy.items[0].track_language.as_deref(), Some("zho"));
        assert!(resp_copy.items[1].output_path.is_none());
        // Exactly 1 output file exists in out_m4a (silent video created zero files)
        let files: Vec<_> = fs::read_dir(&out_m4a).unwrap().collect();
        assert_eq!(files.len(), 1);

        // Transcode track 0 to WAV & FLAC
        let out_wav = dir.path().join("out_wav");
        let resp_wav = extract_audio_batch_impl(
            dir.path(),
            &ExtractAudioBatchRequest {
                task_id: "a04-wav".into(),
                items: vec![ExtractAudioItemInput {
                    source_path: dual.to_string_lossy().to_string(),
                    audio_track_index: 0,
                }],
                output_dir: out_wav.to_string_lossy().to_string(),
                format: AudioExtractFormat::Wav,
                prefer_stream_copy: true,
                bitrate_kbps: None,
            },
            &cancel,
            |_| {},
        )
        .unwrap();
        assert_eq!(resp_wav.extracted_count, 1);
        assert!(!resp_wav.items[0].used_stream_copy);
        assert_eq!(resp_wav.items[0].output_codec.as_deref(), Some("pcm_s16le"));
    }
}
