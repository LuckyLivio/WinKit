//! Process-isolated offline Windows Text-to-Speech worker (`winkit.exe --tts-worker`),
//! session audition WAV management, cancellation/temp cleanup, and WAV/MP3 export for `T06`.
//!
//! Architecture & safety guarantees:
//! - Windows WinRT `SpeechSynthesizer` and COM SAPI 5 synthesis run inside an isolated
//!   `winkit.exe --tts-worker` child process attached to a Windows Job Object configured with
//!   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, `JOB_OBJECT_LIMIT_PROCESS_MEMORY` (1 GiB), and
//!   `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` (limit = 1).
//! - Cancelling a task or closing the window immediately terminates the worker Job Object,
//!   removes any partial temporary WAV file, preserves any previously completed audition audio,
//!   and releases all resources cleanly.
//! - WAV export is 100% pure offline (zero FFmpeg dependency). MP3 export reuses `media_core`
//!   FFmpeg with `AtomicMediaOutput` and source-file protection.

use crate::error::AppError;
use crate::fs_guard::{paths_refer_to_same_location, validate_user_path};
use crate::media_core::{
    require_media_tools, run_ffmpeg_cancellable, run_ffprobe_args, AtomicMediaOutput,
    MediaPreviewRegistry,
};
use crate::pdf_worker::should_use_subprocess_worker;
use crate::tts_core::{
    finalize_pcm16_wav_header, list_all_installed_voices, resolve_mp3_bitrate_kbps,
    silence_pcm16_bytes, split_tts_segments, supported_mp3_bitrates_kbps, synthesize_chunk,
    validate_tts_rate, write_pcm16_wav_header, ExportTtsAudioRequest, ExportTtsAudioResult,
    SynthesizeTtsRequest, SynthesizeTtsResult, TtsExportFormat, TtsProgressPayload, TtsVoiceEngine,
    TtsVoicesResponse, DEFAULT_TTS_CHUNK_MAX_CHARS, MAX_TTS_CHUNK_WAV_BYTES, PARAGRAPH_PAUSE_MS,
    SUBCHUNK_PAUSE_MS,
};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use uuid::Uuid;

#[cfg(windows)]
use crate::pdf_worker::job_guard;

pub const TTS_WORKER_FLAG: &str = "--tts-worker";
const MAX_FRAME_BYTES: usize = MAX_TTS_CHUNK_WAV_BYTES + 1024 * 1024;
const TTS_WORKER_MEMORY_LIMIT_BYTES: usize = 1024 * 1024 * 1024; // 1 GiB commit cap
const DEFAULT_TTS_CHUNK_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_STORED_TTS_RESULTS: usize = 4;

static TTS_RESULT_SEQ: AtomicU64 = AtomicU64::new(1);

fn next_tts_result_id() -> String {
    let n = TTS_RESULT_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("tts-{n}")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum TtsWorkerRequest {
    ListVoices,
    SynthesizeChunk {
        voice_id: String,
        text: String,
        rate: f64,
    },
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum TtsWorkerResponse {
    Voices {
        response: TtsVoicesResponse,
    },
    Chunk {
        sample_rate: u32,
        channels: u16,
        bits_per_sample: u16,
    },
    Error {
        code: String,
        message: String,
    },
    Bye,
}

fn write_framed<W: Write>(writer: &mut W, header_json: &[u8], payload: &[u8]) -> io::Result<()> {
    let header_len = u32::try_from(header_json.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "TTS IPC header too large"))?;
    let payload_len = u32::try_from(payload.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "TTS IPC payload too large"))?;
    writer.write_all(&header_len.to_le_bytes())?;
    writer.write_all(&payload_len.to_le_bytes())?;
    writer.write_all(header_json)?;
    if !payload.is_empty() {
        writer.write_all(payload)?;
    }
    writer.flush()
}

fn read_framed<R: Read>(reader: &mut R) -> io::Result<Option<(Vec<u8>, Vec<u8>)>> {
    let mut prefix = [0u8; 8];
    match reader.read_exact(&mut prefix) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let header_len = u32::from_le_bytes([prefix[0], prefix[1], prefix[2], prefix[3]]) as usize;
    let payload_len = u32::from_le_bytes([prefix[4], prefix[5], prefix[6], prefix[7]]) as usize;
    if header_len == 0 || header_len > MAX_FRAME_BYTES || payload_len > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid TTS worker IPC frame size",
        ));
    }
    let mut header = vec![0u8; header_len];
    reader.read_exact(&mut header)?;
    let mut payload = vec![0u8; payload_len];
    if payload_len > 0 {
        reader.read_exact(&mut payload)?;
    }
    Ok(Some((header, payload)))
}

fn err_resp(err: AppError) -> (TtsWorkerResponse, Vec<u8>) {
    (
        TtsWorkerResponse::Error {
            code: err.code.to_string(),
            message: err.message,
        },
        Vec::new(),
    )
}

pub fn dispatch_tts_request(req: TtsWorkerRequest) -> (TtsWorkerResponse, Vec<u8>) {
    match req {
        TtsWorkerRequest::Shutdown => (TtsWorkerResponse::Bye, Vec::new()),
        TtsWorkerRequest::ListVoices => (
            TtsWorkerResponse::Voices {
                response: list_all_installed_voices(),
            },
            Vec::new(),
        ),
        TtsWorkerRequest::SynthesizeChunk {
            voice_id,
            text,
            rate,
        } => match synthesize_chunk(&voice_id, &text, rate) {
            Ok(chunk) => (
                TtsWorkerResponse::Chunk {
                    sample_rate: chunk.sample_rate,
                    channels: chunk.channels,
                    bits_per_sample: chunk.bits_per_sample,
                },
                chunk.pcm_data,
            ),
            Err(err) => err_resp(err),
        },
    }
}

/// Entrypoint executed when `winkit.exe` is spawned with `--tts-worker`.
pub fn run_tts_worker_stdio_loop() -> i32 {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());

    loop {
        let frame = match read_framed(&mut reader) {
            Ok(Some(pair)) => pair,
            Ok(None) => return 0,
            Err(_) => return 1,
        };
        let req: TtsWorkerRequest = match serde_json::from_slice(&frame.0) {
            Ok(r) => r,
            Err(e) => {
                let (resp, _) = err_resp(AppError::invalid_param(format!(
                    "Malformed TTS worker request: {e}"
                )));
                if let Ok(json) = serde_json::to_vec(&resp) {
                    let _ = write_framed(&mut writer, &json, &[]);
                }
                continue;
            }
        };
        let is_shutdown = matches!(req, TtsWorkerRequest::Shutdown);
        let (resp, out_payload) = dispatch_tts_request(req);
        let Ok(json) = serde_json::to_vec(&resp) else {
            return 2;
        };
        if write_framed(&mut writer, &json, &out_payload).is_err() {
            return 0;
        }
        if is_shutdown {
            return 0;
        }
    }
}

struct LiveTtsWorker {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    #[cfg(windows)]
    job: Option<job_guard::WindowsJobGuard>,
}

impl LiveTtsWorker {
    fn kill_and_reap(mut self) {
        drop(self.stdin);
        drop(self.stdout);
        #[cfg(windows)]
        if let Some(mut job) = self.job.take() {
            job.terminate();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn map_tts_worker_error(code: String, message: String) -> AppError {
    let static_code: &'static str = match code.as_str() {
        "TTS_VOICE_NOT_FOUND" => "TTS_VOICE_NOT_FOUND",
        "TTS_VOICE_LIST_FAILED" => "TTS_VOICE_LIST_FAILED",
        "TTS_ENGINE_ERROR" => "TTS_ENGINE_ERROR",
        "TTS_SYNTHESIS_FAILED" => "TTS_SYNTHESIS_FAILED",
        "TTS_WORKER_TIMEOUT" => "TTS_WORKER_TIMEOUT",
        "TTS_WORKER_CRASHED" => "TTS_WORKER_CRASHED",
        "TTS_UNSUPPORTED_PLATFORM" => "TTS_UNSUPPORTED_PLATFORM",
        "INVALID_PARAMETER" => "INVALID_PARAMETER",
        "SIZE_LIMIT_EXCEEDED" => "SIZE_LIMIT_EXCEEDED",
        "DECODE_FAILED" => "DECODE_FAILED",
        "TASK_CANCELLED" => "TASK_CANCELLED",
        _ => "TTS_WORKER_ERROR",
    };
    AppError::new(static_code, message)
}

#[derive(Default)]
pub struct TtsWorkerClient {
    proc_state: Mutex<Option<LiveTtsWorker>>,
}

impl Drop for TtsWorkerClient {
    fn drop(&mut self) {
        self.shutdown_worker();
    }
}

impl TtsWorkerClient {
    fn spawn_worker(&self) -> Result<LiveTtsWorker, AppError> {
        let exe = std::env::current_exe().map_err(|e| {
            AppError::new(
                "TTS_WORKER_ERROR",
                format!("Unable to resolve executable for TTS worker: {e}"),
            )
        })?;
        let mut cmd = Command::new(exe);
        cmd.arg(TTS_WORKER_FLAG);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn().map_err(|e| {
            AppError::new(
                "TTS_WORKER_ERROR",
                format!("Failed to start isolated TTS worker process: {e}"),
            )
        })?;

        #[cfg(windows)]
        let job = job_guard::WindowsJobGuard::attach_with_memory_limit(
            &child,
            TTS_WORKER_MEMORY_LIMIT_BYTES,
        );

        let stdin = child.stdin.take().ok_or_else(|| {
            let _ = child.kill();
            let _ = child.wait();
            AppError::new("TTS_WORKER_ERROR", "TTS worker stdin pipe unavailable.")
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            let _ = child.kill();
            let _ = child.wait();
            AppError::new("TTS_WORKER_ERROR", "TTS worker stdout pipe unavailable.")
        })?;

        Ok(LiveTtsWorker {
            child,
            stdin: BufWriter::new(stdin),
            stdout: BufReader::new(stdout),
            #[cfg(windows)]
            job,
        })
    }

    pub fn send(
        &self,
        req: TtsWorkerRequest,
        cancel_flag: Option<&Arc<AtomicBool>>,
    ) -> Result<(TtsWorkerResponse, Vec<u8>), AppError> {
        if let Some(flag) = cancel_flag {
            if flag.load(Ordering::Relaxed) {
                return Err(AppError::cancelled());
            }
        }

        if !should_use_subprocess_worker() || std::env::var_os("WINKIT_TTS_INPROCESS").is_some() {
            let (resp, out_payload) = dispatch_tts_request(req);
            return match resp {
                TtsWorkerResponse::Error { code, message } => {
                    Err(map_tts_worker_error(code, message))
                }
                other => Ok((other, out_payload)),
            };
        }

        let req_json = serde_json::to_vec(&req).map_err(|e| {
            AppError::new(
                "TTS_WORKER_ERROR",
                format!("Failed to serialize TTS worker request: {e}"),
            )
        })?;

        let mut guard = self
            .proc_state
            .lock()
            .map_err(|_| AppError::new("TTS_WORKER_ERROR", "TTS worker client lock poisoned."))?;

        for attempt in 0..2 {
            if let Some(flag) = cancel_flag {
                if flag.load(Ordering::Relaxed) {
                    return Err(AppError::cancelled());
                }
            }

            if guard.is_none() {
                *guard = Some(self.spawn_worker()?);
            }
            let proc = guard.as_mut().expect("TTS worker spawned");

            let done_signal = Arc::new((Mutex::new(false), Condvar::new()));
            let timed_out = Arc::new(AtomicBool::new(false));
            let cancelled_mid = Arc::new(AtomicBool::new(false));
            #[cfg(windows)]
            let killer_opt = proc.job.as_ref().map(|j| j.killer());
            let wd_done = Arc::clone(&done_signal);
            let wd_timed_out = Arc::clone(&timed_out);
            let wd_cancelled = Arc::clone(&cancelled_mid);
            let wd_cancel_flag = cancel_flag.cloned();

            let watchdog = std::thread::spawn(move || {
                let deadline = Instant::now() + DEFAULT_TTS_CHUNK_TIMEOUT;
                let (lock, cvar) = &*wd_done;
                let Ok(mut done) = lock.lock() else {
                    return;
                };
                while !*done {
                    if let Some(ref cf) = wd_cancel_flag {
                        if cf.load(Ordering::Relaxed) {
                            wd_cancelled.store(true, Ordering::SeqCst);
                            #[cfg(windows)]
                            if let Some(ref killer) = killer_opt {
                                killer.terminate_now();
                            }
                            return;
                        }
                    }
                    let now = Instant::now();
                    if now >= deadline {
                        wd_timed_out.store(true, Ordering::SeqCst);
                        #[cfg(windows)]
                        if let Some(ref killer) = killer_opt {
                            killer.terminate_now();
                        }
                        return;
                    }
                    let slice = (deadline - now).min(Duration::from_millis(25));
                    match cvar.wait_timeout(done, slice) {
                        Ok((d, _)) => done = d,
                        Err(_) => return,
                    }
                }
            });

            let write_res = write_framed(&mut proc.stdin, &req_json, &[]);
            let read_res = match write_res {
                Ok(()) => read_framed(&mut proc.stdout),
                Err(err) => Err(err),
            };

            {
                let (lock, cvar) = &*done_signal;
                if let Ok(mut done) = lock.lock() {
                    *done = true;
                    cvar.notify_all();
                }
            }
            let _ = watchdog.join();

            if cancelled_mid.load(Ordering::SeqCst)
                || cancel_flag.is_some_and(|f| f.load(Ordering::Relaxed))
            {
                if let Some(dead) = guard.take() {
                    dead.kill_and_reap();
                }
                return Err(AppError::cancelled());
            }

            if timed_out.load(Ordering::SeqCst) {
                if let Some(dead) = guard.take() {
                    dead.kill_and_reap();
                }
                return Err(AppError::new(
                    "TTS_WORKER_TIMEOUT",
                    "Offline speech synthesis timed out and the isolated worker was recycled.",
                ));
            }

            match read_res {
                Ok(Some((hdr_bytes, out_payload))) => {
                    let resp: TtsWorkerResponse =
                        serde_json::from_slice(&hdr_bytes).map_err(|e| {
                            AppError::new(
                                "TTS_WORKER_ERROR",
                                format!("Invalid TTS worker response: {e}"),
                            )
                        })?;
                    return match resp {
                        TtsWorkerResponse::Error { code, message } => {
                            Err(map_tts_worker_error(code, message))
                        }
                        other => Ok((other, out_payload)),
                    };
                }
                Ok(None) | Err(_) => {
                    if let Some(dead) = guard.take() {
                        dead.kill_and_reap();
                    }
                    if attempt == 0 {
                        continue;
                    }
                    return Err(AppError::new(
                        "TTS_WORKER_CRASHED",
                        "Isolated offline speech worker exited unexpectedly.",
                    ));
                }
            }
        }

        Err(AppError::new(
            "TTS_WORKER_CRASHED",
            "Isolated offline speech worker could not be restarted.",
        ))
    }

    pub fn shutdown_worker(&self) {
        let dead = {
            let Ok(mut guard) = self.proc_state.lock() else {
                return;
            };
            guard.take()
        };
        if let Some(mut worker) = dead {
            if let Ok(json) = serde_json::to_vec(&TtsWorkerRequest::Shutdown) {
                let _ = write_framed(&mut worker.stdin, &json, &[]);
                let _ = read_framed(&mut worker.stdout);
            }
            worker.kill_and_reap();
        }
    }
}

#[derive(Clone)]
pub struct StoredTtsAudio {
    pub id: String,
    pub wav_path: PathBuf,
    pub source_path: Option<PathBuf>,
    pub preview_url: String,
    pub voice_id: String,
    pub voice_name: String,
    pub voice_language: String,
    pub engine: TtsVoiceEngine,
    pub rate: f64,
    pub sample_rate: u32,
    pub channels: u16,
    pub bits_per_sample: u16,
    pub duration_sec: f64,
    pub wav_byte_length: u64,
}

#[derive(Clone)]
pub struct TtsSessionManager {
    worker: Arc<TtsWorkerClient>,
    results: Arc<Mutex<VecDeque<StoredTtsAudio>>>,
    temp_dir: PathBuf,
}

impl Default for TtsSessionManager {
    fn default() -> Self {
        Self::new_in_dir(std::env::temp_dir().join("winkit-tts"))
    }
}

impl TtsSessionManager {
    pub fn new_in_dir(temp_dir: PathBuf) -> Self {
        Self {
            worker: Arc::new(TtsWorkerClient::default()),
            results: Arc::new(Mutex::new(VecDeque::new())),
            temp_dir,
        }
    }

    pub fn worker(&self) -> &TtsWorkerClient {
        &self.worker
    }

    pub fn temp_dir(&self) -> &Path {
        &self.temp_dir
    }

    pub fn list_voices(&self) -> Result<TtsVoicesResponse, AppError> {
        let (resp, _) = self.worker.send(TtsWorkerRequest::ListVoices, None)?;
        match resp {
            TtsWorkerResponse::Voices { response } => Ok(response),
            _ => Err(AppError::new(
                "TTS_VOICE_LIST_FAILED",
                "TTS worker returned an unexpected voice list payload.",
            )),
        }
    }

    pub fn insert_result(&self, item: StoredTtsAudio) -> Result<(), AppError> {
        let mut evicted_paths = Vec::new();
        {
            let mut guard = self
                .results
                .lock()
                .map_err(|_| AppError::new("INTERNAL_LOCK_ERROR", "TTS result store poisoned."))?;
            guard.push_back(item);
            while guard.len() > MAX_STORED_TTS_RESULTS {
                if let Some(old) = guard.pop_front() {
                    evicted_paths.push(old.wav_path);
                }
            }
        }
        for p in evicted_paths {
            let _ = fs::remove_file(p);
        }
        Ok(())
    }

    pub fn get_result(&self, result_id: &str) -> Result<StoredTtsAudio, AppError> {
        let guard = self
            .results
            .lock()
            .map_err(|_| AppError::new("INTERNAL_LOCK_ERROR", "TTS result store poisoned."))?;
        guard
            .iter()
            .find(|r| r.id == result_id)
            .cloned()
            .ok_or_else(|| {
                AppError::new(
                    "TTS_RESULT_EXPIRED",
                    "Synthesized audio session expired or was cleared; please synthesize again.",
                )
            })
    }

    pub fn clear_results(&self) {
        let removed: Vec<PathBuf> = {
            let Ok(mut guard) = self.results.lock() else {
                return;
            };
            guard.drain(..).map(|item| item.wav_path).collect()
        };
        for p in removed {
            let _ = fs::remove_file(p);
        }
    }

    #[cfg(test)]
    pub fn result_count(&self) -> usize {
        self.results.lock().map(|g| g.len()).unwrap_or(0)
    }

    pub fn cleanup_on_exit(&self) {
        self.worker.shutdown_worker();
        self.clear_results();
    }
}

struct TempWavCleanupGuard {
    path: PathBuf,
    armed: bool,
}

impl TempWavCleanupGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for TempWavCleanupGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Orchestrates sequential paragraph/sentence offline synthesis into a single verified PCM WAV
/// registered for built-in audition playback, with instant cancellation and automatic cleanup.
pub fn synthesize_tts_impl<F>(
    task_id: &str,
    tts: &TtsSessionManager,
    preview_registry: &MediaPreviewRegistry,
    req: &SynthesizeTtsRequest,
    cancel_flag: &Arc<AtomicBool>,
    mut emit_progress: F,
) -> Result<SynthesizeTtsResult, AppError>
where
    F: FnMut(TtsProgressPayload),
{
    let started = Instant::now();
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let rate = validate_tts_rate(req.rate)?;
    let recorded_source_path = match req
        .source_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(raw) => Some(validate_user_path(raw, "Source")?),
        None => None,
    };
    let (segments, paragraph_count) = split_tts_segments(&req.text, DEFAULT_TTS_CHUNK_MAX_CHARS)?;
    let total_segments = segments.len();
    let total_chars: usize = segments.iter().map(|s| s.char_count).sum();

    let voices_resp = tts.list_voices()?;
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let requested_id = req.voice_id.trim();
    let selected_voice = if requested_id.is_empty() {
        voices_resp
            .default_voice_id
            .as_deref()
            .and_then(|id| voices_resp.voices.iter().find(|v| v.id == id))
            .or_else(|| voices_resp.voices.first())
    } else {
        voices_resp.voices.iter().find(|v| v.id == requested_id)
    }
    .cloned()
    .ok_or_else(|| {
        if voices_resp.voices.is_empty() {
            AppError::new(
                "TTS_NO_VOICES_INSTALLED",
                "No Windows offline speech voices are installed on this system.",
            )
        } else {
            AppError::new(
                "TTS_VOICE_NOT_FOUND",
                "Selected speech voice is not available; please refresh the voice list.",
            )
        }
    })?;

    fs::create_dir_all(tts.temp_dir())
        .map_err(|e| AppError::from_io(e, "Failed to create temporary TTS workspace"))?;
    let wav_path = tts.temp_dir().join(format!("tts_{}.wav", Uuid::new_v4()));
    let mut temp_guard = TempWavCleanupGuard::new(wav_path.clone());

    let file = File::create(&wav_path)
        .map_err(|e| AppError::from_io(e, "Failed to create temporary synthesized WAV file"))?;
    let mut writer = BufWriter::new(file);

    let mut format_spec: Option<(u32, u16, u16)> = None;
    let mut total_pcm_bytes: u64 = 0;

    for (idx, seg) in segments.iter().enumerate() {
        if cancel_flag.load(Ordering::Relaxed) {
            drop(writer);
            return Err(AppError::cancelled());
        }

        let pct = ((idx as f64) / (total_segments as f64) * 92.0).clamp(2.0, 92.0);
        emit_progress(TtsProgressPayload {
            task_id: task_id.to_string(),
            phase: "synthesizing".to_string(),
            current_segment: seg.index,
            total_segments,
            percent: pct,
            detail: seg.preview.clone(),
        });

        if cancel_flag.load(Ordering::Relaxed) {
            drop(writer);
            return Err(AppError::cancelled());
        }

        let (resp, pcm_data) = tts.worker().send(
            TtsWorkerRequest::SynthesizeChunk {
                voice_id: selected_voice.id.clone(),
                text: seg.text.clone(),
                rate,
            },
            Some(cancel_flag),
        )?;

        if cancel_flag.load(Ordering::Relaxed) {
            drop(writer);
            return Err(AppError::cancelled());
        }

        let (sr, ch, bps) = match resp {
            TtsWorkerResponse::Chunk {
                sample_rate,
                channels,
                bits_per_sample,
            } => (sample_rate, channels, bits_per_sample),
            _ => {
                drop(writer);
                return Err(AppError::new(
                    "TTS_SYNTHESIS_FAILED",
                    "TTS worker returned an unexpected synthesis chunk payload.",
                ));
            }
        };

        match format_spec {
            None => {
                write_pcm16_wav_header(&mut writer, sr, ch, bps, 0)?;
                format_spec = Some((sr, ch, bps));
            }
            Some((exp_sr, exp_ch, exp_bps)) => {
                if sr != exp_sr || ch != exp_ch || bps != exp_bps {
                    drop(writer);
                    return Err(AppError::new(
                        "TTS_SYNTHESIS_FAILED",
                        "Voice changed audio format unexpectedly between segments.",
                    ));
                }
            }
        }

        if !pcm_data.is_empty() {
            writer
                .write_all(&pcm_data)
                .map_err(|e| AppError::from_io(e, "Failed writing synthesized audio samples"))?;
            total_pcm_bytes = total_pcm_bytes.saturating_add(pcm_data.len() as u64);
        }

        // Insert natural pause between segments while keeping strict paragraph order.
        if let Some(next_seg) = segments.get(idx + 1) {
            let pause_ms = if next_seg.paragraph_index != seg.paragraph_index {
                PARAGRAPH_PAUSE_MS
            } else {
                SUBCHUNK_PAUSE_MS
            };
            let silence = silence_pcm16_bytes(sr, ch, pause_ms);
            writer
                .write_all(&silence)
                .map_err(|e| AppError::from_io(e, "Failed writing segment pause samples"))?;
            total_pcm_bytes = total_pcm_bytes.saturating_add(silence.len() as u64);
        }
    }

    if cancel_flag.load(Ordering::Relaxed) {
        drop(writer);
        return Err(AppError::cancelled());
    }

    let (sample_rate, channels, bits_per_sample) = format_spec.ok_or_else(|| {
        AppError::new(
            "TTS_SYNTHESIS_FAILED",
            "Speech engine did not produce any audio samples.",
        )
    })?;
    if total_pcm_bytes == 0 {
        drop(writer);
        return Err(AppError::new(
            "TTS_SYNTHESIS_FAILED",
            "Speech engine returned empty audio.",
        ));
    }

    emit_progress(TtsProgressPayload {
        task_id: task_id.to_string(),
        phase: "finalizing".to_string(),
        current_segment: total_segments,
        total_segments,
        percent: 96.0,
        detail: "Finalizing WAV header and preparing audition playback...".to_string(),
    });

    finalize_pcm16_wav_header(
        &mut writer,
        sample_rate,
        channels,
        bits_per_sample,
        total_pcm_bytes,
    )?;
    drop(writer);

    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let wav_byte_length = fs::metadata(&wav_path)
        .map_err(|e| AppError::from_io(e, "Failed to stat finalized synthesized WAV"))?
        .len();
    let bytes_per_sec =
        f64::from(sample_rate) * f64::from(channels) * f64::from(bits_per_sample / 8);
    let duration_sec = if bytes_per_sec > 0.0 {
        total_pcm_bytes as f64 / bytes_per_sec
    } else {
        0.0
    };

    let preview_reg = preview_registry.register_path(&wav_path.to_string_lossy())?;
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let result_id = next_tts_result_id();
    let stored = StoredTtsAudio {
        id: result_id.clone(),
        wav_path: wav_path.clone(),
        source_path: recorded_source_path.clone(),
        preview_url: preview_reg.url.clone(),
        voice_id: selected_voice.id.clone(),
        voice_name: selected_voice.name.clone(),
        voice_language: selected_voice.language.clone(),
        engine: selected_voice.engine,
        rate,
        sample_rate,
        channels,
        bits_per_sample,
        duration_sec,
        wav_byte_length,
    };

    tts.insert_result(stored)?;
    temp_guard.disarm();

    emit_progress(TtsProgressPayload {
        task_id: task_id.to_string(),
        phase: "completed".to_string(),
        current_segment: total_segments,
        total_segments,
        percent: 100.0,
        detail: "Offline speech synthesis complete.".to_string(),
    });

    Ok(SynthesizeTtsResult {
        result_id,
        voice_id: selected_voice.id,
        voice_name: selected_voice.name,
        voice_language: selected_voice.language,
        engine: selected_voice.engine,
        rate,
        segment_count: total_segments,
        paragraph_count,
        char_count: total_chars,
        sample_rate,
        channels,
        bits_per_sample,
        duration_sec,
        wav_byte_length,
        preview_url: preview_reg.url,
        elapsed_ms: started.elapsed().as_millis() as u64,
        source_path: recorded_source_path.map(|p| p.to_string_lossy().into_owned()),
        supported_mp3_bitrates_kbps: supported_mp3_bitrates_kbps(sample_rate).to_vec(),
    })
}

fn copy_file_cancellable(
    src: &Path,
    dst: &Path,
    cancel_flag: &AtomicBool,
) -> Result<u64, AppError> {
    let mut reader = File::open(src)
        .map_err(|e| AppError::from_io(e, "Failed to open synthesized audio source"))?;
    let mut writer = File::create(dst)
        .map_err(|e| AppError::from_io(e, "Failed to create temporary WAV output"))?;
    let mut buf = [0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(AppError::cancelled());
        }
        let n = reader
            .read(&mut buf)
            .map_err(|e| AppError::from_io(e, "Failed reading synthesized audio"))?;
        if n == 0 {
            break;
        }
        writer
            .write_all(&buf[..n])
            .map_err(|e| AppError::from_io(e, "Failed writing output WAV"))?;
        total = total.saturating_add(n as u64);
    }
    writer
        .flush()
        .map_err(|e| AppError::from_io(e, "Failed flushing output WAV"))?;
    Ok(total)
}

fn parse_json_u64(val: Option<&serde_json::Value>) -> Option<u64> {
    let v = val?;
    if let Some(n) = v.as_u64() {
        return Some(n);
    }
    if let Some(s) = v.as_str() {
        return s.trim().parse::<u64>().ok();
    }
    None
}

fn parse_json_f64(val: Option<&serde_json::Value>) -> Option<f64> {
    let v = val?;
    if let Some(n) = v.as_f64() {
        return n.is_finite().then_some(n);
    }
    if let Some(s) = v.as_str() {
        return s.trim().parse::<f64>().ok().filter(|n| n.is_finite());
    }
    None
}

fn probe_exported_mp3(
    ffprobe: &Path,
    mp3_path: &Path,
    fallback_duration_sec: f64,
) -> Result<(u32, u16, f64, Option<u32>), AppError> {
    let args = vec![
        "-v".to_string(),
        "error".to_string(),
        "-select_streams".to_string(),
        "a:0".to_string(),
        "-show_entries".to_string(),
        "stream=sample_rate,channels,bit_rate,duration:format=duration,bit_rate".to_string(),
        "-of".to_string(),
        "json".to_string(),
        mp3_path.to_string_lossy().into_owned(),
    ];
    let raw = run_ffprobe_args(ffprobe, &args)?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).map_err(|e| {
        AppError::new(
            "FFPROBE_PARSE_ERROR",
            format!("Failed to parse ffprobe output for exported MP3: {e}"),
        )
    })?;
    let stream = parsed
        .get("streams")
        .and_then(|s| s.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| {
            AppError::new(
                "EXPORT_VERIFY_FAILED",
                "Exported MP3 file contains no readable audio stream.",
            )
        })?;
    let format = parsed.get("format");

    let sample_rate = parse_json_u64(stream.get("sample_rate"))
        .and_then(|v| u32::try_from(v).ok())
        .filter(|&v| v > 0)
        .ok_or_else(|| {
            AppError::new(
                "EXPORT_VERIFY_FAILED",
                "Unable to verify sample rate of exported MP3 file.",
            )
        })?;
    let channels = parse_json_u64(stream.get("channels"))
        .and_then(|v| u16::try_from(v).ok())
        .filter(|&v| v > 0)
        .ok_or_else(|| {
            AppError::new(
                "EXPORT_VERIFY_FAILED",
                "Unable to verify channel count of exported MP3 file.",
            )
        })?;
    let duration_sec = parse_json_f64(stream.get("duration"))
        .or_else(|| format.and_then(|f| parse_json_f64(f.get("duration"))))
        .filter(|&d| d > 0.0)
        .unwrap_or(fallback_duration_sec);
    let bitrate_bps = parse_json_u64(stream.get("bit_rate"))
        .or_else(|| format.and_then(|f| parse_json_u64(f.get("bit_rate"))))
        .filter(|&b| b > 0);
    let bitrate_kbps = bitrate_bps.map(|bps| ((bps + 500) / 1000) as u32);
    Ok((sample_rate, channels, duration_sec, bitrate_kbps))
}

/// Safely exports a synthesized TTS audio session as offline WAV (zero FFmpeg) or MP3
/// (reusing local `media_core` FFmpeg), enforcing source-file protection bound to the
/// synthesis result record, preserving original sample rate, and probing exported MP3 metadata.
pub fn export_tts_audio_impl(
    tts: &TtsSessionManager,
    app_data_dir: &Path,
    req: &ExportTtsAudioRequest,
    cancel_flag: &AtomicBool,
) -> Result<ExportTtsAudioResult, AppError> {
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let stored = tts.get_result(req.result_id.trim())?;
    let target_path = validate_user_path(&req.output_path, "Output")?;

    // Always protect the original source file recorded when this synthesis result was produced,
    // even if the editor text was later replaced or `overwrite = true` was confirmed.
    if let Some(bound_src) = stored.source_path.as_deref() {
        if paths_refer_to_same_location(bound_src, &target_path) {
            return Err(AppError::same_input_output());
        }
    }
    // Also protect any current source path passed by the active workspace.
    if let Some(src) = req
        .source_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if paths_refer_to_same_location(Path::new(src), &target_path) {
            return Err(AppError::same_input_output());
        }
    }
    if paths_refer_to_same_location(&stored.wav_path, &target_path) {
        return Err(AppError::same_input_output());
    }

    match req.format {
        TtsExportFormat::Wav => {
            let atomic = AtomicMediaOutput::prepare(target_path, &stored.wav_path, req.overwrite)?;
            copy_file_cancellable(&stored.wav_path, atomic.temp_path(), cancel_flag)?;
            if cancel_flag.load(Ordering::Relaxed) {
                return Err(AppError::cancelled());
            }
            let (final_path, byte_length) = atomic.commit(req.overwrite)?;
            Ok(ExportTtsAudioResult {
                output_path: final_path.to_string_lossy().into_owned(),
                format: TtsExportFormat::Wav,
                duration_sec: stored.duration_sec,
                sample_rate: stored.sample_rate,
                channels: stored.channels,
                bitrate_kbps: None,
                byte_length,
            })
        }
        TtsExportFormat::Mp3 => {
            let target_kbps = resolve_mp3_bitrate_kbps(stored.sample_rate, req.mp3_bitrate_kbps)?;
            let tools = require_media_tools(app_data_dir)?;
            let atomic = AtomicMediaOutput::prepare(target_path, &stored.wav_path, req.overwrite)?;
            let bitrate_arg = format!("{target_kbps}k");
            let args = vec![
                "-y".to_string(),
                "-hide_banner".to_string(),
                "-loglevel".to_string(),
                "error".to_string(),
                "-i".to_string(),
                stored.wav_path.to_string_lossy().into_owned(),
                "-vn".to_string(),
                "-c:a".to_string(),
                "libmp3lame".to_string(),
                "-b:a".to_string(),
                bitrate_arg,
                "-f".to_string(),
                "mp3".to_string(),
                atomic.temp_path().to_string_lossy().into_owned(),
            ];
            run_ffmpeg_cancellable(
                &tools.ffmpeg,
                &args,
                Some(stored.duration_sec),
                cancel_flag,
                |_, _| {},
            )?;
            if cancel_flag.load(Ordering::Relaxed) {
                return Err(AppError::cancelled());
            }
            let (sample_rate, channels, duration_sec, bitrate_kbps) =
                probe_exported_mp3(&tools.ffprobe, atomic.temp_path(), stored.duration_sec)?;
            let (final_path, byte_length) = atomic.commit(req.overwrite)?;
            Ok(ExportTtsAudioResult {
                output_path: final_path.to_string_lossy().into_owned(),
                format: TtsExportFormat::Mp3,
                duration_sec,
                sample_rate,
                channels,
                bitrate_kbps,
                byte_length,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tts_core::{compute_pcm16_rms, parse_pcm_wav};
    use tempfile::tempdir;

    #[cfg(windows)]
    #[test]
    fn synthesizes_multiparagraph_wav_enforces_source_and_overwrite_guards_and_cleans_temp() {
        let dir = tempdir().expect("tempdir");
        let tts = TtsSessionManager::new_in_dir(dir.path().join("tts_temp"));
        let preview = MediaPreviewRegistry::default();

        let voices = tts.list_voices().expect("list voices");
        assert!(!voices.voices.is_empty());
        let default_id = voices
            .default_voice_id
            .clone()
            .unwrap_or_else(|| voices.voices[0].id.clone());

        let source_txt = dir.path().join("input_doc.txt");
        let text = "First paragraph for WinKit offline speech.\n\nSecond paragraph with <xml> & symbols 1 < 2.\n\nThird paragraph verifying ordering.";
        fs::write(&source_txt, text).expect("write source txt");

        let active = Arc::new(AtomicBool::new(false));
        let mut progress_segments = Vec::new();
        let res = synthesize_tts_impl(
            "t06-test-1",
            &tts,
            &preview,
            &SynthesizeTtsRequest {
                text: text.to_string(),
                voice_id: default_id,
                rate: 1.0,
                source_path: Some(source_txt.to_string_lossy().into_owned()),
            },
            &active,
            |p| {
                if p.phase == "synthesizing" {
                    progress_segments.push(p.current_segment);
                }
            },
        )
        .expect("synthesis ok");

        assert_eq!(res.paragraph_count, 3);
        assert_eq!(res.segment_count, 3);
        assert_eq!(progress_segments, vec![1, 2, 3]);
        assert!(res.duration_sec > 1.5);
        assert!(res.wav_byte_length > 44);
        assert!(res.preview_url.starts_with("http://winkitmedia.localhost/"));
        assert_eq!(
            res.source_path.as_deref(),
            Some(source_txt.to_string_lossy().as_ref())
        );
        assert_eq!(
            res.supported_mp3_bitrates_kbps,
            supported_mp3_bitrates_kbps(res.sample_rate)
        );

        // 1a. Source .txt path protection -> SAME_INPUT_AND_OUTPUT (even when overwrite=true)
        let err_same = export_tts_audio_impl(
            &tts,
            dir.path(),
            &ExportTtsAudioRequest {
                result_id: res.result_id.clone(),
                output_path: source_txt.to_string_lossy().into_owned(),
                source_path: Some(source_txt.to_string_lossy().into_owned()),
                format: TtsExportFormat::Wav,
                mp3_bitrate_kbps: None,
                overwrite: true,
            },
            &active,
        )
        .unwrap_err();
        assert_eq!(err_same.code, "SAME_INPUT_AND_OUTPUT");
        assert_eq!(fs::read_to_string(&source_txt).unwrap(), text);

        // 1b. Bound source-file protection survives even after editor text is replaced via Paste
        // (caller passes source_path = None AND overwrite = true) -> still rejected!
        let err_bound = export_tts_audio_impl(
            &tts,
            dir.path(),
            &ExportTtsAudioRequest {
                result_id: res.result_id.clone(),
                output_path: source_txt.to_string_lossy().into_owned(),
                source_path: None,
                format: TtsExportFormat::Wav,
                mp3_bitrate_kbps: None,
                overwrite: true,
            },
            &active,
        )
        .unwrap_err();
        assert_eq!(err_bound.code, "SAME_INPUT_AND_OUTPUT");
        assert_eq!(fs::read_to_string(&source_txt).unwrap(), text);

        // 2. Offline WAV export (zero FFmpeg needed) + header/RMS verification
        let out_wav = dir.path().join("speech_out.wav");
        let exported = export_tts_audio_impl(
            &tts,
            dir.path(),
            &ExportTtsAudioRequest {
                result_id: res.result_id.clone(),
                output_path: out_wav.to_string_lossy().into_owned(),
                source_path: Some(source_txt.to_string_lossy().into_owned()),
                format: TtsExportFormat::Wav,
                mp3_bitrate_kbps: None,
                overwrite: false,
            },
            &active,
        )
        .expect("wav export ok");
        assert_eq!(exported.format, TtsExportFormat::Wav);
        let parsed = parse_pcm_wav(&fs::read(&out_wav).unwrap()).expect("valid wav");
        assert_eq!(parsed.sample_rate, res.sample_rate);
        assert!(compute_pcm16_rms(&parsed.pcm_data) > 0.005);

        // 3. Existing target without overwrite -> TARGET_ALREADY_EXISTS
        let sentinel = b"KEEP_EXISTING_WAV";
        fs::write(&out_wav, sentinel).unwrap();
        let err_exists = export_tts_audio_impl(
            &tts,
            dir.path(),
            &ExportTtsAudioRequest {
                result_id: res.result_id.clone(),
                output_path: out_wav.to_string_lossy().into_owned(),
                source_path: Some(source_txt.to_string_lossy().into_owned()),
                format: TtsExportFormat::Wav,
                mp3_bitrate_kbps: None,
                overwrite: false,
            },
            &active,
        )
        .unwrap_err();
        assert_eq!(err_exists.code, "TARGET_ALREADY_EXISTS");
        assert_eq!(fs::read(&out_wav).unwrap(), sentinel);

        // 4. Confirmed overwrite succeeds
        let overwritten = export_tts_audio_impl(
            &tts,
            dir.path(),
            &ExportTtsAudioRequest {
                result_id: res.result_id.clone(),
                output_path: out_wav.to_string_lossy().into_owned(),
                source_path: Some(source_txt.to_string_lossy().into_owned()),
                format: TtsExportFormat::Wav,
                mp3_bitrate_kbps: None,
                overwrite: true,
            },
            &active,
        )
        .expect("confirmed overwrite ok");
        assert!(overwritten.byte_length > sentinel.len() as u64);

        // 5. Clear/cleanup removes all session temp WAV files cleanly
        let stored_wav = tts.get_result(&res.result_id).unwrap().wav_path;
        assert!(stored_wav.exists());
        tts.cleanup_on_exit();
        assert!(!stored_wav.exists());
        assert_eq!(tts.result_count(), 0);
    }

    #[cfg(windows)]
    #[test]
    fn cancelling_mid_synthesis_cleans_partial_temp_preserves_previous_result_and_allows_retry() {
        let dir = tempdir().expect("tempdir");
        let temp_dir = dir.path().join("tts_cancel_temp");
        let tts = TtsSessionManager::new_in_dir(temp_dir.clone());
        let preview = MediaPreviewRegistry::default();

        let voices = tts.list_voices().expect("list voices");
        let voice_id = voices
            .default_voice_id
            .clone()
            .unwrap_or_else(|| voices.voices[0].id.clone());

        // Seed existing result A
        let active = Arc::new(AtomicBool::new(false));
        let res_a = synthesize_tts_impl(
            "t06-seed-a",
            &tts,
            &preview,
            &SynthesizeTtsRequest {
                text: "Initial completed speech.".to_string(),
                voice_id: voice_id.clone(),
                rate: 1.0,
                source_path: None,
            },
            &active,
            |_| {},
        )
        .expect("seed A ok");
        let wav_a_path = tts.get_result(&res_a.result_id).unwrap().wav_path;
        assert!(wav_a_path.exists());

        // Start 4-paragraph synthesis B and cancel right when segment 2 begins
        let cancel_b = Arc::new(AtomicBool::new(false));
        let cancel_cb = Arc::clone(&cancel_b);
        let err_b = synthesize_tts_impl(
            "t06-cancel-b",
            &tts,
            &preview,
            &SynthesizeTtsRequest {
                text: "Paragraph one.\n\nParagraph two.\n\nParagraph three.\n\nParagraph four."
                    .to_string(),
                voice_id: voice_id.clone(),
                rate: 1.0,
                source_path: None,
            },
            &cancel_b,
            |p| {
                if p.phase == "synthesizing" && p.current_segment >= 2 {
                    cancel_cb.store(true, Ordering::Relaxed);
                }
            },
        )
        .unwrap_err();
        assert_eq!(err_b.code, "TASK_CANCELLED");

        // Partial temp file for B must be cleaned up, while A remains completely intact
        assert!(wav_a_path.exists());
        assert_eq!(tts.result_count(), 1);
        let files_in_temp: Vec<_> = fs::read_dir(&temp_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(files_in_temp.len(), 1, "only result A's WAV should remain");

        // Immediate retry succeeds cleanly
        let retry_active = Arc::new(AtomicBool::new(false));
        let res_b = synthesize_tts_impl(
            "t06-retry-b",
            &tts,
            &preview,
            &SynthesizeTtsRequest {
                text: "Paragraph one.\n\nParagraph two.".to_string(),
                voice_id,
                rate: 1.25,
                source_path: None,
            },
            &retry_active,
            |_| {},
        )
        .expect("retry B ok");
        assert_eq!(res_b.segment_count, 2);
        assert!(res_b.duration_sec > 0.3);

        tts.cleanup_on_exit();
        let remaining: Vec<_> = fs::read_dir(&temp_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert!(
            remaining.is_empty(),
            "all session WAVs must be removed on exit"
        );
    }

    #[cfg(windows)]
    #[test]
    fn sapi_desktop_voice_synthesizes_non_silent_pcm_without_xml_injection_when_present() {
        let voices = list_all_installed_voices();
        let Some(sapi_voice) = voices
            .voices
            .iter()
            .find(|v| v.engine == TtsVoiceEngine::SapiDesktop)
        else {
            return;
        };
        let chunk = synthesize_chunk(
            &sapi_voice.id,
            "Hello WinKit! Testing <tag> & 1 < 2 plain text safety.",
            1.2,
        )
        .expect("sapi desktop synth ok");
        assert_eq!(chunk.sample_rate, 22_050);
        assert_eq!(chunk.channels, 1);
        assert_eq!(chunk.bits_per_sample, 16);
        assert!(!chunk.pcm_data.is_empty());
        assert!(compute_pcm16_rms(&chunk.pcm_data) > 0.005);
    }

    #[cfg(windows)]
    #[test]
    fn mp3_export_rejects_unsupported_bitrate_preserves_sample_rate_and_probes_real_bitrate() {
        let dir = tempdir().expect("tempdir");
        let tts = TtsSessionManager::new_in_dir(dir.path().join("tts_mp3_temp"));
        let preview = MediaPreviewRegistry::default();
        if require_media_tools(dir.path()).is_err() {
            return;
        }

        let voices = tts.list_voices().expect("list voices");
        let voice_id = voices
            .default_voice_id
            .clone()
            .unwrap_or_else(|| voices.voices[0].id.clone());
        let active = Arc::new(AtomicBool::new(false));
        let synth = synthesize_tts_impl(
            "t06-mp3-probe",
            &tts,
            &preview,
            &SynthesizeTtsRequest {
                text: "Testing real MP3 bitrate tiers and ffprobe readback on Windows 11."
                    .to_string(),
                voice_id,
                rate: 1.0,
                source_path: None,
            },
            &active,
            |_| {},
        )
        .expect("synth ok");

        if synth.sample_rate < 32_000 {
            let bad_out = dir.path().join("should_not_exist_192.mp3");
            let err_192 = export_tts_audio_impl(
                &tts,
                dir.path(),
                &ExportTtsAudioRequest {
                    result_id: synth.result_id.clone(),
                    output_path: bad_out.to_string_lossy().into_owned(),
                    source_path: None,
                    format: TtsExportFormat::Mp3,
                    mp3_bitrate_kbps: Some(192),
                    overwrite: false,
                },
                &active,
            )
            .unwrap_err();
            assert_eq!(err_192.code, "INVALID_PARAMETER");
            assert!(!bad_out.exists());
        }

        let allowed = supported_mp3_bitrates_kbps(synth.sample_rate);
        let low_tier = allowed[0];
        let high_tier = *allowed.last().unwrap();

        for tier in [low_tier, high_tier] {
            let out_mp3 = dir.path().join(format!("speech_{tier}k.mp3"));
            let exported = export_tts_audio_impl(
                &tts,
                dir.path(),
                &ExportTtsAudioRequest {
                    result_id: synth.result_id.clone(),
                    output_path: out_mp3.to_string_lossy().into_owned(),
                    source_path: None,
                    format: TtsExportFormat::Mp3,
                    mp3_bitrate_kbps: Some(tier),
                    overwrite: false,
                },
                &active,
            )
            .expect("mp3 export ok");
            assert_eq!(exported.format, TtsExportFormat::Mp3);
            assert_eq!(exported.sample_rate, synth.sample_rate);
            assert_eq!(exported.channels, synth.channels);
            assert_eq!(exported.bitrate_kbps, Some(tier));
            assert!(exported.byte_length > 512);
        }

        tts.cleanup_on_exit();
    }

    #[test]
    fn pdf_text_normalization_cleans_whitespace_soft_hyphens_and_preserves_paragraphs() {
        use crate::pdf_pdfium::normalize_pdf_text_for_speech;

        let raw = "\u{FEFF}  第一段\u{00AD}内容   测试\r\n\r\n\r\n  Second\t\tline\u{200B} text \r\n\x07Third line  ";
        let cleaned = normalize_pdf_text_for_speech(raw);
        assert_eq!(cleaned, "第一段内容 测试\n\nSecond line text\nThird line");
    }

    #[cfg(windows)]
    #[test]
    fn pdf_pages_extraction_handles_ranges_scanned_pages_and_protects_source_pdf_on_tts_export() {
        use crate::pdf_core::PdfSessionManager;
        use lopdf::{Dictionary, Document, Object, Stream};

        let dir = tempdir().expect("tempdir");
        let pdf_path = dir.path().join("tts_source_pages.pdf");

        // Build a 3-page PDF: page 1 text, page 2 pure non-text (scanned-like), page 3 text
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let mut font_dict = Dictionary::new();
        font_dict.set("Type", Object::Name(b"Font".to_vec()));
        font_dict.set("Subtype", Object::Name(b"Type1".to_vec()));
        font_dict.set("BaseFont", Object::Name(b"Helvetica".to_vec()));
        let font_id = doc.add_object(Object::Dictionary(font_dict));
        let mut fonts = Dictionary::new();
        fonts.set("F1", Object::Reference(font_id));
        let mut resources = Dictionary::new();
        resources.set("Font", Object::Dictionary(fonts));
        let resources_id = doc.add_object(Object::Dictionary(resources));

        let contents = [
            "BT /F1 16 Tf 50 740 Td (Page one offline PDF speech sample.) Tj ET\n",
            "q 0.92 0.92 0.95 rg 40 40 500 720 re f Q\n",
            "BT /F1 16 Tf 50 740 Td (Page three final paragraph for WinKit.) Tj ET\n",
        ];
        let mut page_ids = Vec::new();
        for content in contents {
            let cid = doc.add_object(Object::Stream(Stream::new(
                Dictionary::new(),
                content.as_bytes().to_vec(),
            )));
            let mut page = Dictionary::new();
            page.set("Type", Object::Name(b"Page".to_vec()));
            page.set("Parent", Object::Reference(pages_id));
            page.set(
                "MediaBox",
                Object::Array(vec![0.into(), 0.into(), 595.into(), 842.into()]),
            );
            page.set("Resources", Object::Reference(resources_id));
            page.set("Contents", Object::Reference(cid));
            page_ids.push(Object::Reference(doc.add_object(Object::Dictionary(page))));
        }
        let mut pages_dict = Dictionary::new();
        pages_dict.set("Type", Object::Name(b"Pages".to_vec()));
        pages_dict.set("Kids", Object::Array(page_ids));
        pages_dict.set("Count", Object::Integer(3));
        doc.objects.insert(pages_id, Object::Dictionary(pages_dict));
        let mut catalog = Dictionary::new();
        catalog.set("Type", Object::Name(b"Catalog".to_vec()));
        catalog.set("Pages", Object::Reference(pages_id));
        let catalog_id = doc.add_object(Object::Dictionary(catalog));
        doc.trailer.set("Root", Object::Reference(catalog_id));
        doc.save(&pdf_path).expect("save test pdf");
        let original_pdf_bytes = fs::read(&pdf_path).expect("read original pdf");

        let pdf_mgr = PdfSessionManager::default();
        let pdf_str = pdf_path.to_string_lossy().into_owned();

        // Pure scanned page 2 -> 0 extracted pages, reported in scanned_pages
        let scanned_only = pdf_mgr
            .extract_pages_text(&pdf_str, vec![2])
            .expect("extract page 2");
        assert_eq!(scanned_only.extracted_page_count, 0);
        assert_eq!(scanned_only.scanned_pages, vec![2]);
        assert!(scanned_only.combined_text.is_empty());

        // Mixed range [1, 2, 3] -> skips page 2 cleanly and orders page 1 before page 3
        let mixed = pdf_mgr
            .extract_pages_text(&pdf_str, vec![1, 2, 3])
            .expect("extract pages 1-3");
        assert_eq!(mixed.total_pages, 3);
        assert_eq!(mixed.extracted_page_count, 2);
        assert_eq!(mixed.scanned_pages, vec![2]);
        let idx1 = mixed
            .combined_text
            .find("Page one offline PDF speech sample.")
            .expect("page 1 text");
        let idx3 = mixed
            .combined_text
            .find("Page three final paragraph for WinKit.")
            .expect("page 3 text");
        assert!(idx1 < idx3);

        // Out-of-bounds page rejected
        let err_oob = pdf_mgr.extract_pages_text(&pdf_str, vec![4]).unwrap_err();
        assert_eq!(err_oob.code, "INVALID_PARAMETER");

        // Synthesize from extracted PDF text and verify audio export can NEVER overwrite source PDF
        let tts = TtsSessionManager::new_in_dir(dir.path().join("tts_pdf_temp"));
        let preview = MediaPreviewRegistry::default();
        let voices = tts.list_voices().expect("voices");
        let voice_id = voices
            .default_voice_id
            .clone()
            .unwrap_or_else(|| voices.voices[0].id.clone());
        let active = Arc::new(AtomicBool::new(false));
        let synth = synthesize_tts_impl(
            "t06-pdf-src-guard",
            &tts,
            &preview,
            &SynthesizeTtsRequest {
                text: mixed.combined_text.clone(),
                voice_id,
                rate: 1.0,
                source_path: Some(pdf_str.clone()),
            },
            &active,
            |_| {},
        )
        .expect("pdf tts synth ok");

        let err_overwrite_pdf = export_tts_audio_impl(
            &tts,
            dir.path(),
            &ExportTtsAudioRequest {
                result_id: synth.result_id.clone(),
                output_path: pdf_str,
                source_path: None,
                format: TtsExportFormat::Wav,
                mp3_bitrate_kbps: None,
                overwrite: true,
            },
            &active,
        )
        .unwrap_err();
        assert_eq!(err_overwrite_pdf.code, "SAME_INPUT_AND_OUTPUT");
        assert_eq!(fs::read(&pdf_path).unwrap(), original_pdf_bytes);

        tts.cleanup_on_exit();
    }
}
