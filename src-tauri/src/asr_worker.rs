//! Process-isolated offline ASR worker (`winkit.exe --asr-worker`) with Windows Job Object
//! resource limits, streaming per-segment progress, instant cancellation, and clean worker
//! reclamation on window close for `T01` (and reusable by future `A02` / `V02` integrations).
//!
//! Scope & honesty note:
//! - ONNX Runtime (`onnxruntime.dll`), `SenseVoiceSmall INT8`, and `Silero VAD v5` run inside a
//!   dedicated child process (`winkit.exe --asr-worker`) attached to a Windows Job Object with
//!   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, `JOB_OBJECT_LIMIT_PROCESS_MEMORY` (2 GiB commit cap),
//!   and `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` (limit = 1).
//! - During `cargo test` (when `current_exe()` is the test binary rather than `winkit.exe`),
//!   requests run through the exact same `dispatch_asr_request` handler in-process.

use crate::asr_core::{
    decode_wav_streaming_to_mono_16k, prepare_media_wav_for_asr, AsrLanguage, AsrProgressPayload,
    SenseVoiceAsrEngine, TranscribeMediaRequest, TranscribeMediaResult,
};
use crate::asr_models::{
    require_asr_assets, ResolvedAsrAssets, SENSEVOICE_MODEL_FILENAME, SENSEVOICE_TOKENS_FILENAME,
    SILERO_VAD_FILENAME,
};
use crate::error::AppError;
use crate::pdf_worker::should_use_subprocess_worker;
use serde::{Deserialize, Serialize};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

#[cfg(windows)]
use crate::pdf_worker::job_guard;

pub const ASR_WORKER_FLAG: &str = "--asr-worker";
const MAX_FRAME_BYTES: usize = 32 * 1024 * 1024; // JSON-only IPC (WAV audio passed by local path)
const ASR_WORKER_MEMORY_LIMIT_BYTES: usize = 2 * 1024 * 1024 * 1024; // 2 GiB commit cap
const ASR_WORKER_STALL_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum AsrWorkerRequest {
    Ping {
        model_dir: String,
    },
    TranscribeWav {
        model_dir: String,
        wav_path: String,
        original_input_path: String,
        file_name: String,
        timeline_offset_sec: f64,
        expected_duration_sec: Option<f64>,
        decoded_with_ffmpeg: bool,
        language: AsrLanguage,
        use_itn: bool,
    },
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AsrWorkerResponse {
    Pong {
        runtime_version: String,
    },
    Progress {
        phase: String,
        current_segment: usize,
        total_segments: usize,
        percent: f64,
        detail: String,
    },
    Done(TranscribeMediaResult),
    Error {
        code: String,
        message: String,
    },
    Bye,
}

fn write_frame<W: Write>(writer: &mut W, header_json: &[u8]) -> io::Result<()> {
    let header_len = u32::try_from(header_json.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "ASR IPC frame too large"))?;
    writer.write_all(&header_len.to_le_bytes())?;
    writer.write_all(header_json)?;
    writer.flush()
}

fn read_frame<R: Read>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut prefix = [0u8; 4];
    match reader.read_exact(&mut prefix) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let header_len = u32::from_le_bytes(prefix) as usize;
    if header_len == 0 || header_len > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid ASR worker IPC frame size",
        ));
    }
    let mut header = vec![0u8; header_len];
    reader.read_exact(&mut header)?;
    Ok(Some(header))
}

fn err_resp(err: AppError) -> AsrWorkerResponse {
    AsrWorkerResponse::Error {
        code: err.code.to_string(),
        message: err.message,
    }
}

fn resolve_assets_from_dir(model_dir: &Path) -> Result<ResolvedAsrAssets, AppError> {
    let model_onnx_path = model_dir.join(SENSEVOICE_MODEL_FILENAME);
    let tokens_path = model_dir.join(SENSEVOICE_TOKENS_FILENAME);
    let vad_onnx_path = model_dir.join(SILERO_VAD_FILENAME);
    if !model_onnx_path.is_file() || !tokens_path.is_file() || !vad_onnx_path.is_file() {
        return Err(AppError::new(
            "ASR_MODEL_MISSING",
            format!(
                "Offline speech model files are missing in '{}'.",
                model_dir.display()
            ),
        ));
    }
    Ok(ResolvedAsrAssets {
        model_dir: model_dir.to_path_buf(),
        model_onnx_path,
        tokens_path,
        vad_onnx_path,
    })
}

pub struct CachedAsrEngine {
    model_dir: PathBuf,
    engine: SenseVoiceAsrEngine,
}

fn ensure_engine_loaded<'a>(
    cache: &'a mut Option<CachedAsrEngine>,
    model_dir: &Path,
    resource_dir: Option<&Path>,
) -> Result<&'a SenseVoiceAsrEngine, AppError> {
    let needs_reload = cache
        .as_ref()
        .map(|c| c.model_dir != model_dir)
        .unwrap_or(true);
    if needs_reload {
        // Drop previous ONNX sessions before loading a new model directory to keep RAM bounded.
        *cache = None;
        let assets = resolve_assets_from_dir(model_dir)?;
        let engine = SenseVoiceAsrEngine::load(&assets, resource_dir)?;
        *cache = Some(CachedAsrEngine {
            model_dir: model_dir.to_path_buf(),
            engine,
        });
    }
    cache
        .as_ref()
        .map(|c| &c.engine)
        .ok_or_else(|| AppError::new("ASR_ENGINE_LOAD_FAILED", "ASR engine failed to initialize."))
}

pub fn dispatch_asr_request<F>(
    cache: &mut Option<CachedAsrEngine>,
    resource_dir: Option<&Path>,
    req: AsrWorkerRequest,
    cancel_flag: &AtomicBool,
    mut emit_progress: F,
) -> AsrWorkerResponse
where
    F: FnMut(AsrWorkerResponse),
{
    match req {
        AsrWorkerRequest::Shutdown => AsrWorkerResponse::Bye,
        AsrWorkerRequest::Ping { model_dir } => {
            match ensure_engine_loaded(cache, Path::new(&model_dir), resource_dir) {
                Ok(engine) => AsrWorkerResponse::Pong {
                    runtime_version: engine.runtime_version().to_string(),
                },
                Err(err) => err_resp(err),
            }
        }
        AsrWorkerRequest::TranscribeWav {
            model_dir,
            wav_path,
            original_input_path,
            file_name,
            timeline_offset_sec,
            expected_duration_sec,
            decoded_with_ffmpeg,
            language,
            use_itn,
        } => {
            emit_progress(AsrWorkerResponse::Progress {
                phase: "loading_model".into(),
                current_segment: 0,
                total_segments: 0,
                percent: 10.0,
                detail: "Loading offline SenseVoiceSmall INT8 + Silero VAD v5...".into(),
            });
            let engine = match ensure_engine_loaded(cache, Path::new(&model_dir), resource_dir) {
                Ok(eng) => eng,
                Err(err) => return err_resp(err),
            };
            let mut decoded = match decode_wav_streaming_to_mono_16k(
                Path::new(&wav_path),
                !decoded_with_ffmpeg,
            ) {
                Ok(Some(d)) => d,
                Ok(None) => {
                    return err_resp(AppError::decode_failed(
                        "Unable to parse prepared 16 kHz PCM WAV stream.",
                    ));
                }
                Err(err) => return err_resp(err),
            };
            decoded.timeline_offset_sec = timeline_offset_sec.max(0.0);
            decoded.decoded_with_ffmpeg = decoded_with_ffmpeg;
            if let Some(exp) = expected_duration_sec.filter(|d| d.is_finite() && *d > 0.0) {
                decoded.duration_sec = decoded.duration_sec.max(exp);
            }

            match engine.transcribe_samples(
                &decoded,
                &original_input_path,
                &file_name,
                language,
                use_itn,
                cancel_flag,
                |phase, cur, total, pct, detail| {
                    emit_progress(AsrWorkerResponse::Progress {
                        phase: phase.to_string(),
                        current_segment: cur,
                        total_segments: total,
                        percent: pct,
                        detail: detail.to_string(),
                    });
                },
            ) {
                Ok(done) => AsrWorkerResponse::Done(done),
                Err(err) => err_resp(err),
            }
        }
    }
}

/// Entrypoint executed when `winkit.exe` is spawned with `--asr-worker`.
pub fn run_asr_worker_stdio_loop(resource_dir: Option<&Path>) -> i32 {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());
    let mut cache: Option<CachedAsrEngine> = None;
    let never_cancel = AtomicBool::new(false);

    loop {
        let frame = match read_frame(&mut reader) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => return 0,
            Err(_) => return 1,
        };
        let req: AsrWorkerRequest = match serde_json::from_slice(&frame) {
            Ok(r) => r,
            Err(e) => {
                let resp = err_resp(AppError::invalid_param(format!(
                    "Malformed ASR worker request: {e}"
                )));
                if let Ok(json) = serde_json::to_vec(&resp) {
                    let _ = write_frame(&mut writer, &json);
                }
                continue;
            }
        };
        let is_shutdown = matches!(req, AsrWorkerRequest::Shutdown);
        let mut pipe_broken = false;
        let resp = dispatch_asr_request(&mut cache, resource_dir, req, &never_cancel, |prog| {
            if !pipe_broken {
                if let Ok(json) = serde_json::to_vec(&prog) {
                    if write_frame(&mut writer, &json).is_err() {
                        pipe_broken = true;
                    }
                }
            }
        });
        if pipe_broken {
            return 0;
        }
        let Ok(json) = serde_json::to_vec(&resp) else {
            return 2;
        };
        if write_frame(&mut writer, &json).is_err() {
            return 0;
        }
        if is_shutdown {
            return 0;
        }
    }
}

struct LiveAsrWorker {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    #[cfg(windows)]
    job: Option<job_guard::WindowsJobGuard>,
}

impl LiveAsrWorker {
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

fn map_asr_worker_error(code: String, message: String) -> AppError {
    let static_code: &'static str = match code.as_str() {
        "ASR_MODEL_MISSING" => "ASR_MODEL_MISSING",
        "ASR_MODEL_INVALID" => "ASR_MODEL_INVALID",
        "ASR_ENGINE_LOAD_FAILED" => "ASR_ENGINE_LOAD_FAILED",
        "ASR_INFERENCE_FAILED" => "ASR_INFERENCE_FAILED",
        "ASR_WORKER_TIMEOUT" => "ASR_WORKER_TIMEOUT",
        "ASR_WORKER_CRASHED" => "ASR_WORKER_CRASHED",
        "ORT_RUNTIME_MISSING" => "ORT_RUNTIME_MISSING",
        "DECODE_FAILED" => "DECODE_FAILED",
        "FILE_NOT_FOUND" => "FILE_NOT_FOUND",
        "IS_DIRECTORY" => "IS_DIRECTORY",
        "PERMISSION_DENIED" => "PERMISSION_DENIED",
        "FILE_LOCKED" => "FILE_LOCKED",
        "SIZE_LIMIT_EXCEEDED" => "SIZE_LIMIT_EXCEEDED",
        "INVALID_PARAMETER" => "INVALID_PARAMETER",
        "TASK_CANCELLED" => "TASK_CANCELLED",
        _ => "ASR_WORKER_ERROR",
    };
    AppError::new(static_code, message)
}

fn inprocess_asr_cache() -> &'static Mutex<Option<CachedAsrEngine>> {
    static CACHE: OnceLock<Mutex<Option<CachedAsrEngine>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

#[derive(Default)]
pub struct AsrWorkerClient {
    resource_dir: Mutex<Option<PathBuf>>,
    proc_state: Mutex<Option<LiveAsrWorker>>,
}

impl Drop for AsrWorkerClient {
    fn drop(&mut self) {
        self.shutdown_worker();
    }
}

impl AsrWorkerClient {
    pub fn set_resource_dir(&self, dir: PathBuf) {
        if let Ok(mut guard) = self.resource_dir.lock() {
            *guard = Some(dir);
        }
    }

    pub fn resource_dir(&self) -> Option<PathBuf> {
        self.resource_dir.lock().ok().and_then(|g| g.clone())
    }

    fn spawn_worker(&self) -> Result<LiveAsrWorker, AppError> {
        let exe = std::env::current_exe().map_err(|e| {
            AppError::new(
                "ASR_WORKER_ERROR",
                format!("Unable to resolve executable for ASR worker: {e}"),
            )
        })?;
        let mut cmd = Command::new(exe);
        cmd.arg(ASR_WORKER_FLAG);
        if let Some(dir) = self.resource_dir() {
            cmd.arg("--asr-resource-dir").arg(dir);
        }
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
                "ASR_WORKER_ERROR",
                format!("Failed to start isolated ASR worker process: {e}"),
            )
        })?;

        #[cfg(windows)]
        let job = job_guard::WindowsJobGuard::attach_with_memory_limit(
            &child,
            ASR_WORKER_MEMORY_LIMIT_BYTES,
        );

        let stdin = child.stdin.take().ok_or_else(|| {
            let _ = child.kill();
            let _ = child.wait();
            AppError::new("ASR_WORKER_ERROR", "ASR worker stdin pipe unavailable.")
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            let _ = child.kill();
            let _ = child.wait();
            AppError::new("ASR_WORKER_ERROR", "ASR worker stdout pipe unavailable.")
        })?;

        Ok(LiveAsrWorker {
            child,
            stdin: BufWriter::new(stdin),
            stdout: BufReader::new(stdout),
            #[cfg(windows)]
            job,
        })
    }

    pub fn send_streaming<F>(
        &self,
        req: AsrWorkerRequest,
        cancel_flag: &Arc<AtomicBool>,
        mut on_progress: F,
    ) -> Result<AsrWorkerResponse, AppError>
    where
        F: FnMut(String, usize, usize, f64, String),
    {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(AppError::cancelled());
        }

        if !should_use_subprocess_worker() || std::env::var_os("WINKIT_ASR_INPROCESS").is_some() {
            let res_dir = self.resource_dir();
            let mut cache = inprocess_asr_cache()
                .lock()
                .map_err(|_| AppError::new("ASR_WORKER_ERROR", "In-process ASR lock poisoned."))?;
            let resp =
                dispatch_asr_request(&mut cache, res_dir.as_deref(), req, cancel_flag, |prog| {
                    if let AsrWorkerResponse::Progress {
                        phase,
                        current_segment,
                        total_segments,
                        percent,
                        detail,
                    } = prog
                    {
                        on_progress(phase, current_segment, total_segments, percent, detail);
                    }
                });
            return match resp {
                AsrWorkerResponse::Error { code, message } => {
                    Err(map_asr_worker_error(code, message))
                }
                other => Ok(other),
            };
        }

        let req_json = serde_json::to_vec(&req).map_err(|e| {
            AppError::new(
                "ASR_WORKER_ERROR",
                format!("Failed to serialize ASR worker request: {e}"),
            )
        })?;

        let mut guard = self
            .proc_state
            .lock()
            .map_err(|_| AppError::new("ASR_WORKER_ERROR", "ASR worker client lock poisoned."))?;

        for attempt in 0..2 {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err(AppError::cancelled());
            }

            if guard.is_none() {
                *guard = Some(self.spawn_worker()?);
            }
            let proc = guard.as_mut().expect("asr worker spawned");

            let done_signal = Arc::new((Mutex::new(false), Condvar::new()));
            let last_activity = Arc::new(Mutex::new(Instant::now()));
            let timed_out = Arc::new(AtomicBool::new(false));
            let cancelled_mid = Arc::new(AtomicBool::new(false));
            #[cfg(windows)]
            let killer_opt = proc.job.as_ref().map(|j| j.killer());

            let wd_done = Arc::clone(&done_signal);
            let wd_activity = Arc::clone(&last_activity);
            let wd_timed_out = Arc::clone(&timed_out);
            let wd_cancelled = Arc::clone(&cancelled_mid);
            let wd_cancel_flag = Arc::clone(cancel_flag);

            let watchdog = std::thread::spawn(move || {
                let (lock, cvar) = &*wd_done;
                let Ok(mut done) = lock.lock() else {
                    return;
                };
                while !*done {
                    if wd_cancel_flag.load(Ordering::Relaxed) {
                        wd_cancelled.store(true, Ordering::SeqCst);
                        #[cfg(windows)]
                        if let Some(ref killer) = killer_opt {
                            killer.terminate_now();
                        }
                        return;
                    }
                    let stalled = wd_activity
                        .lock()
                        .map(|t| t.elapsed() >= ASR_WORKER_STALL_TIMEOUT)
                        .unwrap_or(false);
                    if stalled {
                        wd_timed_out.store(true, Ordering::SeqCst);
                        #[cfg(windows)]
                        if let Some(ref killer) = killer_opt {
                            killer.terminate_now();
                        }
                        return;
                    }
                    match cvar.wait_timeout(done, Duration::from_millis(50)) {
                        Ok((d, _)) => done = d,
                        Err(_) => return,
                    }
                }
            });

            let mut final_result: Result<Option<AsrWorkerResponse>, io::Error> =
                match write_frame(&mut proc.stdin, &req_json) {
                    Ok(()) => Ok(None),
                    Err(e) => Err(e),
                };

            if final_result.is_ok() {
                loop {
                    match read_frame(&mut proc.stdout) {
                        Ok(Some(bytes)) => {
                            if let Ok(mut ts) = last_activity.lock() {
                                *ts = Instant::now();
                            }
                            match serde_json::from_slice::<AsrWorkerResponse>(&bytes) {
                                Ok(AsrWorkerResponse::Progress {
                                    phase,
                                    current_segment,
                                    total_segments,
                                    percent,
                                    detail,
                                }) => {
                                    on_progress(
                                        phase,
                                        current_segment,
                                        total_segments,
                                        percent,
                                        detail,
                                    );
                                }
                                Ok(terminal) => {
                                    final_result = Ok(Some(terminal));
                                    break;
                                }
                                Err(e) => {
                                    final_result = Err(io::Error::new(
                                        io::ErrorKind::InvalidData,
                                        format!("Malformed ASR worker response: {e}"),
                                    ));
                                    break;
                                }
                            }
                        }
                        Ok(None) => {
                            final_result = Ok(None);
                            break;
                        }
                        Err(e) => {
                            final_result = Err(e);
                            break;
                        }
                    }
                }
            }

            {
                let (lock, cvar) = &*done_signal;
                if let Ok(mut done) = lock.lock() {
                    *done = true;
                    cvar.notify_one();
                }
            }
            let _ = watchdog.join();

            if cancelled_mid.load(Ordering::SeqCst) || cancel_flag.load(Ordering::Relaxed) {
                if let Some(aborted) = guard.take() {
                    aborted.kill_and_reap();
                }
                return Err(AppError::cancelled());
            }

            if timed_out.load(Ordering::SeqCst) {
                if let Some(hung) = guard.take() {
                    hung.kill_and_reap();
                }
                return Err(AppError::new(
                    "ASR_WORKER_TIMEOUT",
                    format!(
                        "Offline transcription made no progress for {}s and was terminated cleanly.",
                        ASR_WORKER_STALL_TIMEOUT.as_secs()
                    ),
                ));
            }

            match final_result {
                Ok(Some(AsrWorkerResponse::Error { code, message })) => {
                    return Err(map_asr_worker_error(code, message));
                }
                Ok(Some(other)) => return Ok(other),
                Ok(None) | Err(_) => {
                    if let Some(dead) = guard.take() {
                        dead.kill_and_reap();
                    }
                    if attempt == 1 {
                        return Err(AppError::new(
                            "ASR_WORKER_CRASHED",
                            "The isolated offline speech worker stopped unexpectedly while transcribing.",
                        ));
                    }
                }
            }
        }

        Err(AppError::new(
            "ASR_WORKER_ERROR",
            "ASR worker request did not complete.",
        ))
    }

    pub fn shutdown_worker(&self) {
        if let Ok(mut guard) = self.proc_state.lock() {
            if let Some(mut proc) = guard.take() {
                if let Ok(json) = serde_json::to_vec(&AsrWorkerRequest::Shutdown) {
                    let _ = write_frame(&mut proc.stdin, &json);
                    let _ = read_frame(&mut proc.stdout);
                }
                proc.kill_and_reap();
            }
        }
        if let Ok(mut cache) = inprocess_asr_cache().lock() {
            *cache = None;
        }
    }
}

#[derive(Clone, Default)]
pub struct AsrSessionManager {
    worker: Arc<AsrWorkerClient>,
}

impl AsrSessionManager {
    pub fn set_resource_dir(&self, dir: PathBuf) {
        self.worker.set_resource_dir(dir);
    }

    pub fn resource_dir(&self) -> Option<PathBuf> {
        self.worker.resource_dir()
    }

    pub fn worker(&self) -> &AsrWorkerClient {
        &self.worker
    }

    pub fn shutdown_worker(&self) {
        self.worker.shutdown_worker();
    }

    pub fn cleanup_on_exit(&self) {
        self.worker.shutdown_worker();
    }
}

/// Full offline `T01` transcription orchestrator: validates installed model assets, decodes audio
/// (native WAV or cancellable FFmpeg with original media timeline alignment), runs isolated
/// `--asr-worker`, streams progress, and guarantees temp WAV cleanup on completion or cancel.
#[allow(clippy::too_many_arguments)]
pub fn transcribe_media_impl<F>(
    task_id: &str,
    asr_root: &Path,
    media_root: &Path,
    asr_mgr: &AsrSessionManager,
    req: &TranscribeMediaRequest,
    cancel_flag: &Arc<AtomicBool>,
    mut emit_progress: F,
) -> Result<TranscribeMediaResult, AppError>
where
    F: FnMut(AsrProgressPayload),
{
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }
    let res_dir = asr_mgr.resource_dir();
    let assets = require_asr_assets(asr_root, res_dir.as_deref())?;

    emit_progress(AsrProgressPayload {
        task_id: task_id.to_string(),
        phase: "decoding".into(),
        current_segment: 0,
        total_segments: 0,
        percent: 2.0,
        detail: "Preparing 16 kHz mono audio stream...".into(),
    });

    let prepared = prepare_media_wav_for_asr(media_root, &req.input_path, cancel_flag, |pct| {
        let mapped = 2.0 + (pct.clamp(0.0, 100.0) * 0.08);
        emit_progress(AsrProgressPayload {
            task_id: task_id.to_string(),
            phase: "decoding".into(),
            current_segment: 0,
            total_segments: 0,
            percent: mapped,
            detail: format!("Extracting audio via FFmpeg ({:.0}%)...", pct),
        });
    })?;

    let worker_req = AsrWorkerRequest::TranscribeWav {
        model_dir: assets.model_dir.to_string_lossy().into_owned(),
        wav_path: prepared.wav_path.to_string_lossy().into_owned(),
        original_input_path: prepared.original_input_path.clone(),
        file_name: prepared.file_name.clone(),
        timeline_offset_sec: prepared.timeline_offset_sec,
        expected_duration_sec: prepared.expected_duration_sec,
        decoded_with_ffmpeg: prepared.decoded_with_ffmpeg,
        language: req.language,
        use_itn: req.use_itn,
    };

    let worker_res = asr_mgr.worker().send_streaming(
        worker_req,
        cancel_flag,
        |phase, cur, total, pct, detail| {
            emit_progress(AsrProgressPayload {
                task_id: task_id.to_string(),
                phase,
                current_segment: cur,
                total_segments: total,
                percent: pct,
                detail,
            });
        },
    );

    // `prepared` drops here AFTER worker process has finished or been reaped, so any FFmpeg
    // temp WAV is released on Windows and deleted cleanly even after mid-inference cancellation.
    drop(prepared);

    match worker_res? {
        AsrWorkerResponse::Done(result) => Ok(result),
        other => Err(AppError::new(
            "ASR_WORKER_ERROR",
            format!("Unexpected ASR worker response: {other:?}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::TaskRegistry;
    use tempfile::tempdir;

    #[test]
    fn transcribe_media_honors_pre_cancel_and_reports_missing_model_cleanly() {
        let asr_root = tempdir().expect("asr_root");
        let media_root = tempdir().expect("media_root");
        let mgr = AsrSessionManager::default();
        let req = TranscribeMediaRequest {
            input_path: asr_root
                .path()
                .join("missing.wav")
                .to_string_lossy()
                .into_owned(),
            language: AsrLanguage::Auto,
            use_itn: true,
        };

        // Pre-cancelled flag returns TASK_CANCELLED immediately
        let cancelled = Arc::new(AtomicBool::new(true));
        let err_cancel = transcribe_media_impl(
            "t01-pre-cancel",
            asr_root.path(),
            media_root.path(),
            &mgr,
            &req,
            &cancelled,
            |_| {},
        )
        .unwrap_err();
        assert_eq!(err_cancel.code, "TASK_CANCELLED");

        // Missing model returns ASR_MODEL_MISSING (or ORT_RUNTIME_MISSING if runtime absent)
        let active = Arc::new(AtomicBool::new(false));
        let res_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        mgr.set_resource_dir(res_dir);
        let err_missing = transcribe_media_impl(
            "t01-missing-model",
            asr_root.path(),
            media_root.path(),
            &mgr,
            &req,
            &active,
            |_| {},
        )
        .unwrap_err();
        assert_eq!(err_missing.code, "ASR_MODEL_MISSING");
    }

    #[test]
    fn t01_task_registers_as_interruptible_and_drains_on_shutdown() {
        let reg = TaskRegistry::default();
        let guard = reg.register_checked("t01-run-1", "T01", true).expect("reg");
        let snap = reg.snapshot();
        assert_eq!(snap.interruptible_count, 1);
        assert_eq!(snap.write_finishing_count, 0);

        let flag = guard.cancel_flag();
        let worker = std::thread::spawn(move || {
            while !flag.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(5));
            }
            drop(guard);
        });
        let drain = reg.begin_shutdown_and_drain(Duration::from_secs(2));
        worker.join().expect("join");
        assert!(drain.ready_to_close);
        assert!(drain.remaining_tasks.is_empty());
    }
}
