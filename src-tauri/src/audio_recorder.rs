//! Phase 4B2 Batch 2 backend: A02 Audio Recorder (WASAPI microphone capture).
//!
//! Privacy-first: enumerating devices never opens a capture stream. Capture starts
//! only on explicit user action (Enable Monitor or Start Recording). Streams PCM
//! directly into a bounded-memory temporary WAV file, excludes pause duration from
//! the written samples, preserves already-recorded audio on device disconnect,
//! releases the Windows audio device synchronously before stop/discard returns,
//! and supports saving as lossless WAV (zero external dependencies) or M4A/AAC
//! (via local FFmpeg).

use crate::audio_wasapi::{
    compute_audio_levels, list_audio_devices_impl, AudioDeviceInfo, AudioEndpointFlow,
    FinalizedWavInfo, StreamingWavWriter, WasapiCaptureMode, WasapiCaptureStream,
    WasapiPacketStatus,
};
use crate::error::AppError;
use crate::fs_guard::validate_user_path;
use crate::media_core::{
    require_media_tools, run_ffmpeg_cancellable, AtomicMediaOutput, MediaPreviewRegistry,
};
use crate::tasks::{TaskProgressPayload, TaskRegistry, TASK_PROGRESS_EVENT};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

pub const AUDIO_RECORDER_STATE_EVENT: &str = "winkit://audio-recorder-state";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecorderPhase {
    Idle,
    Monitoring,
    Recording,
    Paused,
    StoppedReady,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioRecordOutputFormat {
    Wav,
    M4a,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioRecorderSnapshot {
    pub phase: RecorderPhase,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u16>,
    pub elapsed_sec: f64,
    pub level_rms: f32,
    pub level_peak: f32,
    pub db_fs: f32,
    pub clipping: bool,
    pub preview_url: Option<String>,
    pub temp_wav_path: Option<String>,
    pub byte_size: Option<u64>,
    pub interrupted_reason: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

impl Default for AudioRecorderSnapshot {
    fn default() -> Self {
        Self {
            phase: RecorderPhase::Idle,
            device_id: None,
            device_name: None,
            sample_rate: None,
            channels: None,
            elapsed_sec: 0.0,
            level_rms: 0.0,
            level_peak: 0.0,
            db_fs: -96.0,
            clipping: false,
            preview_url: None,
            temp_wav_path: None,
            byte_size: None,
            interrupted_reason: None,
            error_code: None,
            error_message: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAudioRecordingRequest {
    pub task_id: String,
    pub output_path: String,
    pub format: AudioRecordOutputFormat,
    pub bitrate_kbps: Option<u32>,
    pub allow_overwrite: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAudioRecordingResult {
    pub output_path: String,
    pub format: AudioRecordOutputFormat,
    pub duration_sec: f64,
    pub sample_rate: u32,
    pub channels: u16,
    pub byte_size: u64,
}

struct ActiveWorker {
    is_recording: bool,
    stop_flag: Arc<AtomicBool>,
    paused_flag: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

struct ReadyTake {
    info: FinalizedWavInfo,
    preview_url: String,
    device_id: String,
    device_name: String,
    interrupted_reason: Option<String>,
}

#[derive(Default)]
struct RecorderInner {
    snapshot: AudioRecorderSnapshot,
    worker: Option<ActiveWorker>,
    ready_take: Option<ReadyTake>,
}

#[derive(Clone, Default)]
pub struct AudioRecorderManager {
    inner: Arc<Mutex<RecorderInner>>,
}

fn recorder_temp_dir() -> PathBuf {
    std::env::temp_dir().join("winkit-recordings")
}

fn new_temp_wav_path() -> PathBuf {
    recorder_temp_dir().join(format!("rec_{}.wav", Uuid::new_v4()))
}

fn remove_file_quiet(path: &Path) {
    let _ = fs::remove_file(path);
}

impl AudioRecorderManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn snapshot(&self) -> AudioRecorderSnapshot {
        self.inner
            .lock()
            .expect("audio recorder mutex poisoned")
            .snapshot
            .clone()
    }

    pub fn has_active_recording(&self) -> bool {
        let guard = self.inner.lock().expect("audio recorder mutex poisoned");
        matches!(
            guard.snapshot.phase,
            RecorderPhase::Recording | RecorderPhase::Paused
        )
    }

    /// Stops any active worker (monitor or recording), joins the thread so WASAPI is 100% released.
    fn stop_active_worker(&self) {
        let handle = {
            let mut guard = self.inner.lock().expect("audio recorder mutex poisoned");
            if let Some(worker) = guard.worker.as_mut() {
                worker.stop_flag.store(true, Ordering::SeqCst);
                worker.join.take()
            } else {
                None
            }
        };
        if let Some(join) = handle {
            let _ = join.join();
        }
        let mut guard = self.inner.lock().expect("audio recorder mutex poisoned");
        guard.worker = None;
    }

    fn clear_ready_take_locked(guard: &mut RecorderInner) {
        if let Some(take) = guard.ready_take.take() {
            remove_file_quiet(&take.info.path);
        }
    }

    /// Starts live microphone input monitoring (explicit user opt-in, no file written).
    pub fn start_monitor(
        &self,
        app: &AppHandle,
        device_id: Option<String>,
    ) -> Result<AudioRecorderSnapshot, AppError> {
        if self.has_active_recording() {
            return Err(AppError::new(
                "RECORDER_BUSY",
                "Cannot change monitoring while a recording is active.",
            ));
        }
        self.stop_active_worker();

        let (init_tx, init_rx) =
            std::sync::mpsc::channel::<Result<(String, String, u32, u16), AppError>>();
        let stop_flag = Arc::new(AtomicBool::new(false));
        let paused_flag = Arc::new(AtomicBool::new(false));
        let stop_worker = Arc::clone(&stop_flag);
        let inner_arc = Arc::clone(&self.inner);
        let app_clone = app.clone();

        let join = thread::Builder::new()
            .name("winkit-a02-monitor".to_string())
            .spawn(move || {
                let stream = match WasapiCaptureStream::open(
                    device_id.as_deref(),
                    WasapiCaptureMode::Microphone,
                ) {
                    Ok(s) => s,
                    Err(err) => {
                        let _ = init_tx.send(Err(err));
                        return;
                    }
                };
                let dev_id = stream.device_id.clone();
                let dev_name = stream.device_name.clone();
                let sr = stream.format.sample_rate;
                let ch = stream.format.output_channels;
                let _ = init_tx.send(Ok((dev_id.clone(), dev_name.clone(), sr, ch)));

                let mut samples = Vec::with_capacity(8192);
                let mut last_emit = Instant::now() - Duration::from_secs(1);

                while !stop_worker.load(Ordering::SeqCst) {
                    stream.wait_for_data(40);
                    if stop_worker.load(Ordering::SeqCst) {
                        break;
                    }
                    let mut got_samples = false;
                    let mut latest_metrics = None;
                    let mut disconnected = false;
                    let mut read_err: Option<AppError> = None;

                    loop {
                        match stream.read_next_packet(&mut samples) {
                            Ok(WasapiPacketStatus::Data { frames, .. }) if frames > 0 => {
                                got_samples = true;
                                latest_metrics = Some(compute_audio_levels(&samples));
                            }
                            Ok(WasapiPacketStatus::Data { .. }) | Ok(WasapiPacketStatus::Empty) => {
                                break;
                            }
                            Ok(WasapiPacketStatus::DeviceDisconnected) => {
                                disconnected = true;
                                break;
                            }
                            Err(err) => {
                                read_err = Some(err);
                                break;
                            }
                        }
                    }

                    if disconnected || read_err.is_some() {
                        let (err_code, err_msg) = if let Some(err) = read_err {
                            (Some(err.code.to_string()), Some(err.message))
                        } else {
                            (
                                Some("AUDIO_DEVICE_DISCONNECTED".to_string()),
                                Some(
                                    "The selected microphone was disconnected while monitoring."
                                        .to_string(),
                                ),
                            )
                        };
                        let snap = {
                            let mut guard =
                                inner_arc.lock().expect("audio recorder mutex poisoned");
                            if let Some(take) = guard.ready_take.as_ref() {
                                guard.snapshot = AudioRecorderSnapshot {
                                    phase: RecorderPhase::StoppedReady,
                                    device_id: Some(take.device_id.clone()),
                                    device_name: Some(take.device_name.clone()),
                                    sample_rate: Some(take.info.sample_rate),
                                    channels: Some(take.info.channels),
                                    elapsed_sec: take.info.duration_sec,
                                    preview_url: Some(take.preview_url.clone()),
                                    temp_wav_path: Some(
                                        take.info.path.to_string_lossy().to_string(),
                                    ),
                                    byte_size: Some(take.info.byte_size),
                                    interrupted_reason: take.interrupted_reason.clone(),
                                    error_code: err_code,
                                    error_message: err_msg,
                                    ..AudioRecorderSnapshot::default()
                                };
                            } else {
                                guard.snapshot = AudioRecorderSnapshot {
                                    phase: RecorderPhase::Idle,
                                    error_code: err_code,
                                    error_message: err_msg,
                                    ..AudioRecorderSnapshot::default()
                                };
                            }
                            guard.snapshot.clone()
                        };
                        let _ = app_clone.emit(AUDIO_RECORDER_STATE_EVENT, snap);
                        break;
                    }

                    if last_emit.elapsed() >= Duration::from_millis(50) {
                        last_emit = Instant::now();
                        let metrics = latest_metrics.unwrap_or_default();
                        let snap = {
                            let mut guard =
                                inner_arc.lock().expect("audio recorder mutex poisoned");
                            if guard.snapshot.phase == RecorderPhase::Monitoring {
                                if got_samples {
                                    guard.snapshot.level_rms = metrics.rms;
                                    guard.snapshot.level_peak = metrics.peak;
                                    guard.snapshot.db_fs = metrics.db_fs;
                                    guard.snapshot.clipping = metrics.clipping;
                                } else {
                                    guard.snapshot.level_rms *= 0.65;
                                    guard.snapshot.level_peak *= 0.65;
                                    if guard.snapshot.level_rms < 1e-4 {
                                        guard.snapshot.level_rms = 0.0;
                                        guard.snapshot.level_peak = 0.0;
                                        guard.snapshot.db_fs = -96.0;
                                        guard.snapshot.clipping = false;
                                    }
                                }
                                Some(guard.snapshot.clone())
                            } else {
                                None
                            }
                        };
                        if let Some(s) = snap {
                            let _ = app_clone.emit(AUDIO_RECORDER_STATE_EVENT, s);
                        }
                    }
                }
                // `stream` drops here -> IAudioClient::Stop() + COM cleanup!
            })
            .map_err(|e| {
                AppError::new(
                    "AUDIO_THREAD_FAILED",
                    format!("Failed to start audio monitoring thread: {e}"),
                )
            })?;

        match init_rx.recv() {
            Ok(Ok((dev_id, dev_name, sr, ch))) => {
                let snap = {
                    let mut guard = self.inner.lock().expect("audio recorder mutex poisoned");
                    guard.worker = Some(ActiveWorker {
                        is_recording: false,
                        stop_flag,
                        paused_flag,
                        join: Some(join),
                    });
                    guard.snapshot = AudioRecorderSnapshot {
                        phase: RecorderPhase::Monitoring,
                        device_id: Some(dev_id),
                        device_name: Some(dev_name),
                        sample_rate: Some(sr),
                        channels: Some(ch),
                        ..AudioRecorderSnapshot::default()
                    };
                    guard.snapshot.clone()
                };
                let _ = app.emit(AUDIO_RECORDER_STATE_EVENT, snap.clone());
                Ok(snap)
            }
            Ok(Err(err)) => {
                let _ = join.join();
                Err(err)
            }
            Err(_) => {
                let _ = join.join();
                Err(AppError::new(
                    "AUDIO_OPEN_FAILED",
                    "Audio monitoring thread terminated unexpectedly during initialization.",
                ))
            }
        }
    }

    pub fn stop_monitor(&self, app: &AppHandle) -> AudioRecorderSnapshot {
        let is_monitoring = {
            let guard = self.inner.lock().expect("audio recorder mutex poisoned");
            guard
                .worker
                .as_ref()
                .map(|w| !w.is_recording)
                .unwrap_or(false)
        };
        if is_monitoring {
            self.stop_active_worker();
        }
        let snap = {
            let mut guard = self.inner.lock().expect("audio recorder mutex poisoned");
            if guard.snapshot.phase == RecorderPhase::Monitoring {
                if let Some(take) = guard.ready_take.as_ref() {
                    guard.snapshot = AudioRecorderSnapshot {
                        phase: RecorderPhase::StoppedReady,
                        device_id: Some(take.device_id.clone()),
                        device_name: Some(take.device_name.clone()),
                        sample_rate: Some(take.info.sample_rate),
                        channels: Some(take.info.channels),
                        elapsed_sec: take.info.duration_sec,
                        preview_url: Some(take.preview_url.clone()),
                        temp_wav_path: Some(take.info.path.to_string_lossy().to_string()),
                        byte_size: Some(take.info.byte_size),
                        interrupted_reason: take.interrupted_reason.clone(),
                        ..AudioRecorderSnapshot::default()
                    };
                } else {
                    guard.snapshot = AudioRecorderSnapshot::default();
                }
            }
            guard.snapshot.clone()
        };
        let _ = app.emit(AUDIO_RECORDER_STATE_EVENT, snap.clone());
        snap
    }

    /// Starts streaming microphone recording to a bounded-memory temporary WAV file.
    pub fn start_recording(
        &self,
        app: &AppHandle,
        tasks: &TaskRegistry,
        previews: &MediaPreviewRegistry,
        device_id: Option<String>,
    ) -> Result<AudioRecorderSnapshot, AppError> {
        if self.has_active_recording() {
            return Err(AppError::new(
                "RECORDER_ALREADY_RUNNING",
                "An audio recording is already in progress.",
            ));
        }

        // Stop any active monitor and release mic before starting a fresh recording.
        self.stop_active_worker();

        let task_id = format!("a02-rec-{}", Uuid::new_v4());
        let task_guard = tasks.register_checked(&task_id, "A02", true)?;
        let task_cancel = task_guard.cancel_flag();

        // Remove any previous unsaved take temp WAV before starting fresh.
        {
            let mut guard = self.inner.lock().expect("audio recorder mutex poisoned");
            Self::clear_ready_take_locked(&mut guard);
        }

        let temp_wav = new_temp_wav_path();
        let temp_wav_worker = temp_wav.clone();
        let (init_tx, init_rx) =
            std::sync::mpsc::channel::<Result<(String, String, u32, u16), AppError>>();
        let stop_flag = Arc::new(AtomicBool::new(false));
        let paused_flag = Arc::new(AtomicBool::new(false));
        let stop_worker = Arc::clone(&stop_flag);
        let paused_worker = Arc::clone(&paused_flag);
        let inner_arc = Arc::clone(&self.inner);
        let app_clone = app.clone();
        let previews_clone = previews.clone();
        let task_id_worker = task_id.clone();

        let join = thread::Builder::new()
            .name("winkit-a02-recorder".to_string())
            .spawn(move || {
                let _task_guard = task_guard; // Drops automatically when thread exits!
                let stream = match WasapiCaptureStream::open(
                    device_id.as_deref(),
                    WasapiCaptureMode::Microphone,
                ) {
                    Ok(s) => s,
                    Err(err) => {
                        let _ = init_tx.send(Err(err));
                        return;
                    }
                };

                let dev_id = stream.device_id.clone();
                let dev_name = stream.device_name.clone();
                let sr = stream.format.sample_rate;
                let ch = stream.format.output_channels;

                let mut writer = match StreamingWavWriter::create(&temp_wav_worker, sr, ch) {
                    Ok(w) => w,
                    Err(err) => {
                        let _ = init_tx.send(Err(err));
                        return;
                    }
                };

                let _ = init_tx.send(Ok((dev_id.clone(), dev_name.clone(), sr, ch)));
                let _ = app_clone.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::running(&task_id_worker, "A02", None),
                );

                let mut samples = Vec::with_capacity(8192);
                let mut last_emit = Instant::now() - Duration::from_secs(1);
                let mut last_header_flush = Instant::now();
                let mut was_paused = false;
                let mut interrupted_reason: Option<String> = None;
                let mut fatal_err: Option<AppError> = None;

                while !stop_worker.load(Ordering::SeqCst) && !task_cancel.load(Ordering::SeqCst) {
                    stream.wait_for_data(40);
                    if stop_worker.load(Ordering::SeqCst) || task_cancel.load(Ordering::SeqCst) {
                        break;
                    }

                    let is_paused = paused_worker.load(Ordering::SeqCst);
                    if is_paused && !was_paused {
                        let _ = writer.flush_header();
                    }
                    was_paused = is_paused;

                    let mut got_samples = false;
                    let mut latest_metrics = None;
                    let mut should_break = false;

                    loop {
                        match stream.read_next_packet(&mut samples) {
                            Ok(WasapiPacketStatus::Data { frames, .. }) if frames > 0 => {
                                got_samples = true;
                                latest_metrics = Some(compute_audio_levels(&samples));
                                if !paused_worker.load(Ordering::SeqCst) {
                                    match writer.write_interleaved_f32(&samples) {
                                        Ok(true) => {}
                                        Ok(false) => {
                                            interrupted_reason = Some("max_wav_limit".to_string());
                                            should_break = true;
                                            break;
                                        }
                                        Err(err) => {
                                            interrupted_reason = Some("write_error".to_string());
                                            fatal_err = Some(err);
                                            should_break = true;
                                            break;
                                        }
                                    }
                                }
                            }
                            Ok(WasapiPacketStatus::Data { .. }) | Ok(WasapiPacketStatus::Empty) => {
                                break;
                            }
                            Ok(WasapiPacketStatus::DeviceDisconnected) => {
                                interrupted_reason = Some("device_disconnected".to_string());
                                should_break = true;
                                break;
                            }
                            Err(err) => {
                                interrupted_reason = Some("device_error".to_string());
                                fatal_err = Some(err);
                                should_break = true;
                                break;
                            }
                        }
                    }

                    if should_break {
                        break;
                    }

                    if !is_paused && last_header_flush.elapsed() >= Duration::from_secs(1) {
                        let _ = writer.flush_header();
                        last_header_flush = Instant::now();
                    }

                    if last_emit.elapsed() >= Duration::from_millis(50) {
                        last_emit = Instant::now();
                        let metrics = latest_metrics.unwrap_or_default();
                        let elapsed = writer.duration_sec();
                        let current_phase = if paused_worker.load(Ordering::SeqCst) {
                            RecorderPhase::Paused
                        } else {
                            RecorderPhase::Recording
                        };
                        let snap = {
                            let mut guard = inner_arc.lock().expect("audio recorder mutex poisoned");
                            guard.snapshot.phase = current_phase;
                            guard.snapshot.elapsed_sec = elapsed;
                            if got_samples {
                                guard.snapshot.level_rms = metrics.rms;
                                guard.snapshot.level_peak = metrics.peak;
                                guard.snapshot.db_fs = metrics.db_fs;
                                guard.snapshot.clipping = metrics.clipping;
                            } else {
                                guard.snapshot.level_rms *= 0.65;
                                guard.snapshot.level_peak *= 0.65;
                                if guard.snapshot.level_rms < 1e-4 {
                                    guard.snapshot.level_rms = 0.0;
                                    guard.snapshot.level_peak = 0.0;
                                    guard.snapshot.db_fs = -96.0;
                                    guard.snapshot.clipping = false;
                                }
                            }
                            guard.snapshot.clone()
                        };
                        let _ = app_clone.emit(AUDIO_RECORDER_STATE_EVENT, snap);
                    }
                }

                // Release WASAPI stream immediately before finalizing file & updating UI state.
                drop(stream);

                let finalized = writer.finalize();
                match finalized {
                    Ok(info) if info.total_frames > 0 => {
                        let preview_url = previews_clone
                            .register_path(&info.path.to_string_lossy())
                            .map(|r| r.url)
                            .unwrap_or_default();
                        let snap = {
                            let mut guard = inner_arc.lock().expect("audio recorder mutex poisoned");
                            let (err_code, err_msg) = match (&interrupted_reason, &fatal_err) {
                                (Some(reason), _) if reason == "device_disconnected" => (
                                    Some("AUDIO_DEVICE_DISCONNECTED".to_string()),
                                    Some(
                                        "Microphone disconnected during recording. Your recorded audio so far has been preserved and can be previewed or saved."
                                            .to_string(),
                                    ),
                                ),
                                (_, Some(err)) => {
                                    (Some(err.code.to_string()), Some(err.message.clone()))
                                }
                                _ => (None, None),
                            };
                            guard.snapshot = AudioRecorderSnapshot {
                                phase: RecorderPhase::StoppedReady,
                                device_id: Some(dev_id.clone()),
                                device_name: Some(dev_name.clone()),
                                sample_rate: Some(info.sample_rate),
                                channels: Some(info.channels),
                                elapsed_sec: info.duration_sec,
                                level_rms: 0.0,
                                level_peak: 0.0,
                                db_fs: -96.0,
                                clipping: false,
                                preview_url: Some(preview_url.clone()),
                                temp_wav_path: Some(info.path.to_string_lossy().to_string()),
                                byte_size: Some(info.byte_size),
                                interrupted_reason: interrupted_reason.clone(),
                                error_code: err_code,
                                error_message: err_msg,
                            };
                            guard.ready_take = Some(ReadyTake {
                                info: info.clone(),
                                preview_url,
                                device_id: dev_id,
                                device_name: dev_name,
                                interrupted_reason,
                            });
                            guard.snapshot.clone()
                        };
                        let _ = app_clone.emit(
                            TASK_PROGRESS_EVENT,
                            TaskProgressPayload::completed(
                                &task_id_worker,
                                "A02",
                                info.byte_size,
                                Some(info.byte_size),
                            ),
                        );
                        let _ = app_clone.emit(AUDIO_RECORDER_STATE_EVENT, snap);
                    }
                    Ok(info) => {
                        remove_file_quiet(&info.path);
                        let err = fatal_err.unwrap_or_else(|| {
                            AppError::new(
                                "EMPTY_RECORDING",
                                "No audio frames were captured before stopping.",
                            )
                        });
                        let snap = {
                            let mut guard = inner_arc.lock().expect("audio recorder mutex poisoned");
                            guard.snapshot = AudioRecorderSnapshot {
                                phase: RecorderPhase::Idle,
                                error_code: Some(err.code.to_string()),
                                error_message: Some(err.message.clone()),
                                ..AudioRecorderSnapshot::default()
                            };
                            guard.snapshot.clone()
                        };
                        let _ = app_clone.emit(
                            TASK_PROGRESS_EVENT,
                            TaskProgressPayload::failed_or_cancelled(
                                &task_id_worker,
                                "A02",
                                0,
                                None,
                                &err,
                            ),
                        );
                        let _ = app_clone.emit(AUDIO_RECORDER_STATE_EVENT, snap);
                    }
                    Err(err) => {
                        remove_file_quiet(&temp_wav_worker);
                        let snap = {
                            let mut guard = inner_arc.lock().expect("audio recorder mutex poisoned");
                            guard.snapshot = AudioRecorderSnapshot {
                                phase: RecorderPhase::Idle,
                                error_code: Some(err.code.to_string()),
                                error_message: Some(err.message.clone()),
                                ..AudioRecorderSnapshot::default()
                            };
                            guard.snapshot.clone()
                        };
                        let _ = app_clone.emit(
                            TASK_PROGRESS_EVENT,
                            TaskProgressPayload::failed_or_cancelled(
                                &task_id_worker,
                                "A02",
                                0,
                                None,
                                &err,
                            ),
                        );
                        let _ = app_clone.emit(AUDIO_RECORDER_STATE_EVENT, snap);
                    }
                }
            })
            .map_err(|e| {
                AppError::new(
                    "AUDIO_THREAD_FAILED",
                    format!("Failed to launch audio recording thread: {e}"),
                )
            })?;

        match init_rx.recv() {
            Ok(Ok((dev_id, dev_name, sr, ch))) => {
                let snap = {
                    let mut guard = self.inner.lock().expect("audio recorder mutex poisoned");
                    guard.worker = Some(ActiveWorker {
                        is_recording: true,
                        stop_flag,
                        paused_flag,
                        join: Some(join),
                    });
                    guard.snapshot = AudioRecorderSnapshot {
                        phase: RecorderPhase::Recording,
                        device_id: Some(dev_id),
                        device_name: Some(dev_name),
                        sample_rate: Some(sr),
                        channels: Some(ch),
                        elapsed_sec: 0.0,
                        ..AudioRecorderSnapshot::default()
                    };
                    guard.snapshot.clone()
                };
                let _ = app.emit(AUDIO_RECORDER_STATE_EVENT, snap.clone());
                Ok(snap)
            }
            Ok(Err(err)) => {
                let _ = join.join();
                remove_file_quiet(&temp_wav);
                Err(err)
            }
            Err(_) => {
                let _ = join.join();
                remove_file_quiet(&temp_wav);
                Err(AppError::new(
                    "AUDIO_OPEN_FAILED",
                    "Audio recording thread exited unexpectedly during initialization.",
                ))
            }
        }
    }

    pub fn pause_recording(&self, app: &AppHandle) -> Result<AudioRecorderSnapshot, AppError> {
        let snap = {
            let mut guard = self.inner.lock().expect("audio recorder mutex poisoned");
            if guard.snapshot.phase != RecorderPhase::Recording {
                return Err(AppError::new(
                    "RECORDER_NOT_RECORDING",
                    "No active recording to pause.",
                ));
            }
            if let Some(worker) = guard.worker.as_ref() {
                worker.paused_flag.store(true, Ordering::SeqCst);
            }
            guard.snapshot.phase = RecorderPhase::Paused;
            guard.snapshot.clone()
        };
        let _ = app.emit(AUDIO_RECORDER_STATE_EVENT, snap.clone());
        Ok(snap)
    }

    pub fn resume_recording(&self, app: &AppHandle) -> Result<AudioRecorderSnapshot, AppError> {
        let snap = {
            let mut guard = self.inner.lock().expect("audio recorder mutex poisoned");
            if guard.snapshot.phase != RecorderPhase::Paused {
                return Err(AppError::new(
                    "RECORDER_NOT_PAUSED",
                    "Recording is not currently paused.",
                ));
            }
            if let Some(worker) = guard.worker.as_ref() {
                worker.paused_flag.store(false, Ordering::SeqCst);
            }
            guard.snapshot.phase = RecorderPhase::Recording;
            guard.snapshot.clone()
        };
        let _ = app.emit(AUDIO_RECORDER_STATE_EVENT, snap.clone());
        Ok(snap)
    }

    /// Stops recording, waits for WASAPI release, and returns the finalized snapshot ready for audition/saving.
    pub fn stop_recording(&self, app: &AppHandle) -> Result<AudioRecorderSnapshot, AppError> {
        self.stop_active_worker();
        let snap = self.snapshot();
        let _ = app.emit(AUDIO_RECORDER_STATE_EVENT, snap.clone());
        Ok(snap)
    }

    /// Stops any recording or monitoring, releases WASAPI, and removes unsaved temporary audio.
    pub fn discard(&self, app: &AppHandle) -> AudioRecorderSnapshot {
        self.stop_active_worker();
        let snap = {
            let mut guard = self.inner.lock().expect("audio recorder mutex poisoned");
            Self::clear_ready_take_locked(&mut guard);
            guard.snapshot = AudioRecorderSnapshot::default();
            guard.snapshot.clone()
        };
        let _ = app.emit(AUDIO_RECORDER_STATE_EVENT, snap.clone());
        snap
    }

    /// Releases any idle monitor stream and removes unsaved temp WAV when the app is exiting.
    pub fn cleanup_on_exit(&self) {
        self.stop_active_worker();
        let mut guard = self.inner.lock().expect("audio recorder mutex poisoned");
        Self::clear_ready_take_locked(&mut guard);
        guard.snapshot = AudioRecorderSnapshot::default();
    }

    /// Saves the currently finalized take as lossless WAV (no FFmpeg needed) or M4A/AAC (via FFmpeg).
    pub fn save_recording(
        &self,
        app: &AppHandle,
        tasks: &TaskRegistry,
        media_root: &Path,
        req: &SaveAudioRecordingRequest,
    ) -> Result<SaveAudioRecordingResult, AppError> {
        if self.has_active_recording() {
            return Err(AppError::new(
                "RECORDER_STILL_RUNNING",
                "Stop the recording before saving it to disk.",
            ));
        }

        let take = {
            let guard = self.inner.lock().expect("audio recorder mutex poisoned");
            guard.ready_take.as_ref().map(|t| t.info.clone())
        }
        .ok_or_else(|| {
            AppError::new(
                "NO_RECORDING_READY",
                "There is no completed recording ready to save.",
            )
        })?;

        if !take.path.is_file() {
            return Err(AppError::new(
                "RECORDING_MISSING",
                "Temporary recording file is no longer available.",
            ));
        }

        let target = validate_user_path(&req.output_path, "output path")?;
        if target.exists() && !req.allow_overwrite {
            return Err(AppError::new(
                "TARGET_ALREADY_EXISTS",
                format!(
                    "Target file already exists and will not be overwritten: {}",
                    target.display()
                ),
            ));
        }

        let task_id = if req.task_id.trim().is_empty() {
            format!("a02-save-{}", Uuid::new_v4())
        } else {
            req.task_id.trim().to_string()
        };
        let guard = tasks.register_checked(&task_id, "A02", true)?;
        let cancel_flag = guard.cancel_flag();
        let _ = app.emit(
            TASK_PROGRESS_EVENT,
            TaskProgressPayload::running(&task_id, "A02", Some(take.byte_size)),
        );

        let save_res = save_wav_take_to_target(
            &take,
            &target,
            req.format,
            req.bitrate_kbps.unwrap_or(192),
            req.allow_overwrite,
            media_root,
            &cancel_flag,
        );

        match save_res {
            Ok(result) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::completed(
                        &task_id,
                        "A02",
                        result.byte_size,
                        Some(result.byte_size),
                    ),
                );
                Ok(result)
            }
            Err(err) => {
                let _ = app.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::failed_or_cancelled(&task_id, "A02", 0, None, &err),
                );
                Err(err)
            }
        }
    }
}

pub fn list_audio_capture_devices_impl() -> Result<Vec<AudioDeviceInfo>, AppError> {
    list_audio_devices_impl(AudioEndpointFlow::Capture)
}

pub fn save_wav_take_to_target(
    take: &FinalizedWavInfo,
    target: &Path,
    format: AudioRecordOutputFormat,
    bitrate_kbps: u32,
    allow_overwrite: bool,
    media_root: &Path,
    cancel_flag: &Arc<AtomicBool>,
) -> Result<SaveAudioRecordingResult, AppError> {
    match format {
        AudioRecordOutputFormat::Wav => {
            if cancel_flag.load(Ordering::SeqCst) {
                return Err(AppError::new("TASK_CANCELLED", "Save cancelled."));
            }
            let atomic =
                AtomicMediaOutput::prepare(target.to_path_buf(), &take.path, allow_overwrite)?;
            fs::copy(&take.path, atomic.temp_path())
                .map_err(|e| AppError::from_io(e, "Failed saving WAV recording file"))?;
            if cancel_flag.load(Ordering::SeqCst) {
                return Err(AppError::new("TASK_CANCELLED", "Save cancelled."));
            }
            let (_, byte_size) = atomic.commit(allow_overwrite)?;
            Ok(SaveAudioRecordingResult {
                output_path: target.to_string_lossy().to_string(),
                format,
                duration_sec: take.duration_sec,
                sample_rate: take.sample_rate,
                channels: take.channels,
                byte_size,
            })
        }
        AudioRecordOutputFormat::M4a => {
            let tools = require_media_tools(media_root)?;
            let atomic =
                AtomicMediaOutput::prepare(target.to_path_buf(), &take.path, allow_overwrite)?;
            let bitrate = bitrate_kbps.clamp(64, 320);
            let args = vec![
                "-y".to_string(),
                "-hide_banner".to_string(),
                "-loglevel".to_string(),
                "error".to_string(),
                "-i".to_string(),
                take.path.to_string_lossy().to_string(),
                "-vn".to_string(),
                "-c:a".to_string(),
                "aac".to_string(),
                "-b:a".to_string(),
                format!("{bitrate}k"),
                "-ar".to_string(),
                take.sample_rate.to_string(),
                "-ac".to_string(),
                take.channels.to_string(),
                "-movflags".to_string(),
                "+faststart".to_string(),
                "-f".to_string(),
                "ipod".to_string(),
                atomic.temp_path().to_string_lossy().to_string(),
            ];
            run_ffmpeg_cancellable(
                &tools.ffmpeg,
                &args,
                Some(take.duration_sec),
                cancel_flag,
                |_, _| {},
            )?;
            let (_, byte_size) = atomic.commit(allow_overwrite)?;
            Ok(SaveAudioRecordingResult {
                output_path: target.to_string_lossy().to_string(),
                format,
                duration_sec: take.duration_sec,
                sample_rate: take.sample_rate,
                channels: take.channels,
                byte_size,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media_core::require_media_tools;
    use std::f32::consts::PI;

    #[test]
    fn save_wav_and_m4a_preserve_pause_free_duration_and_non_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let src_wav = dir.path().join("temp_take.wav");
        let sr = 48_000u32;
        let ch = 2u16;
        let mut writer = StreamingWavWriter::create(&src_wav, sr, ch).unwrap();

        // Simulate 3s active + 2s paused (0 written) + 3s active = 6.0s
        let make_tone = |freq: f32, secs: usize| -> Vec<f32> {
            let frames = sr as usize * secs;
            let mut out = Vec::with_capacity(frames * 2);
            for i in 0..frames {
                let s = 0.3 * (2.0 * PI * freq * (i as f32 / sr as f32)).sin();
                out.push(s);
                out.push(s);
            }
            out
        };
        assert!(writer.write_interleaved_f32(&make_tone(440.0, 3)).unwrap());
        writer.flush_header().unwrap();
        // Pause writes zero frames
        assert!(writer.write_interleaved_f32(&make_tone(660.0, 3)).unwrap());
        let take = writer.finalize().unwrap();
        assert!((take.duration_sec - 6.0).abs() < 1e-6);

        let cancel = Arc::new(AtomicBool::new(false));
        let out_wav = dir.path().join("saved_recording.wav");
        let saved_wav = save_wav_take_to_target(
            &take,
            &out_wav,
            AudioRecordOutputFormat::Wav,
            192,
            false,
            dir.path(),
            &cancel,
        )
        .unwrap();
        assert!(out_wav.is_file());
        assert_eq!(saved_wav.sample_rate, sr);
        assert_eq!(saved_wav.channels, ch);
        assert!((saved_wav.duration_sec - 6.0).abs() < 1e-6);

        // Non-overwrite protection
        let dup_err = save_wav_take_to_target(
            &take,
            &out_wav,
            AudioRecordOutputFormat::Wav,
            192,
            false,
            dir.path(),
            &cancel,
        );
        assert!(dup_err.is_err());

        // Also test M4A encoding when local FFmpeg is installed on this host
        if require_media_tools(dir.path()).is_ok() {
            let out_m4a = dir.path().join("saved_recording.m4a");
            let saved_m4a = save_wav_take_to_target(
                &take,
                &out_m4a,
                AudioRecordOutputFormat::M4a,
                192,
                false,
                dir.path(),
                &cancel,
            )
            .unwrap();
            assert!(out_m4a.is_file());
            assert!(saved_m4a.byte_size > 10_000);
            assert_eq!(saved_m4a.sample_rate, sr);
            assert_eq!(saved_m4a.channels, ch);
        }
    }
}
