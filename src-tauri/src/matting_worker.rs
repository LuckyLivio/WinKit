//! Process-isolated offline background-removal worker (`winkit.exe --matting-worker`) with
//! Windows Job Object resource limits, instant cancellation, warm model caching, and full-res
//! cutout session orchestration for `I04`.
//!
//! Scope & honesty note:
//! - ONNX Runtime (`onnxruntime.dll`) and `BiRefNet_lite 512 FP16` run inside a dedicated child
//!   process (`winkit.exe --matting-worker`) attached to a Windows Job Object configured with
//!   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, `JOB_OBJECT_LIMIT_PROCESS_MEMORY` (4 GiB commit cap),
//!   and `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` (limit = 1).
//! - Only the resized 512×512 RGB input (768 KiB) and 512×512 grayscale alpha matte (256 KiB)
//!   cross the framed stdin/stdout IPC pipe — zero user image files are ever written to temp disk,
//!   and worker memory stays bounded regardless of whether the source photo is 500 px or 100 MP.
//! - During `cargo test` (when `current_exe()` is the test binary rather than `winkit.exe`),
//!   requests execute through the same `dispatch_matting_request` handler in-process.

use crate::error::AppError;
use crate::image_assets::{ImageAssetStore, MAX_ASSET_BYTES, MAX_ASSET_PIXELS, MAX_ASSET_SIDE};
use crate::matting_core::{
    apply_predicted_matte_to_rgba_cancellable, build_matting_preview_urls, encode_rgba_png_bytes,
    load_matting_source, next_matting_result_id, prepare_rgb512_for_model, BiRefNetMattingEngine,
    LoadedMattingSource, MattingProgressPayload, MattingResultStore, RemoveBackgroundRequest,
    RemoveBackgroundResult, StoredMattingCutout, MATTING_MASK512_BYTES, MATTING_RGB512_BYTES,
};
use crate::matting_models::{
    find_model_file_in_dir, require_matting_assets, ResolvedMattingAssets,
};
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

pub const MATTING_WORKER_FLAG: &str = "--matting-worker";
const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024; // 8 MiB ceiling (max payload is 768 KiB RGB512)
const MATTING_WORKER_MEMORY_LIMIT_BYTES: usize = 4 * 1024 * 1024 * 1024; // 4 GiB commit cap
const DEFAULT_MATTING_REQUEST_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum MattingWorkerRequest {
    Ping { model_dir: String },
    PredictMask512 { model_dir: String },
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum MattingWorkerResponse {
    Pong { runtime_version: String },
    Mask512 { runtime_version: String },
    Error { code: String, message: String },
    Bye,
}

fn write_framed<W: Write>(writer: &mut W, header_json: &[u8], payload: &[u8]) -> io::Result<()> {
    let header_len = u32::try_from(header_json.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Matting IPC header too large"))?;
    let payload_len = u32::try_from(payload.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Matting IPC payload too large"))?;
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
            "Invalid matting worker IPC frame size",
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

fn err_resp(err: AppError) -> (MattingWorkerResponse, Vec<u8>) {
    (
        MattingWorkerResponse::Error {
            code: err.code.to_string(),
            message: err.message,
        },
        Vec::new(),
    )
}

fn resolve_assets_from_dir(model_dir: &Path) -> Result<ResolvedMattingAssets, AppError> {
    let Some(model_onnx_path) = find_model_file_in_dir(model_dir) else {
        return Err(AppError::new(
            "MATTING_MODEL_MISSING",
            format!(
                "Offline background-removal model file is missing in '{}'.",
                model_dir.display()
            ),
        ));
    };
    Ok(ResolvedMattingAssets {
        model_dir: model_dir.to_path_buf(),
        model_onnx_path,
    })
}

pub struct CachedMattingEngine {
    model_dir: PathBuf,
    engine: BiRefNetMattingEngine,
}

fn ensure_engine_loaded<'a>(
    cache: &'a mut Option<CachedMattingEngine>,
    model_dir: &Path,
    resource_dir: Option<&Path>,
) -> Result<&'a BiRefNetMattingEngine, AppError> {
    let needs_reload = cache
        .as_ref()
        .map(|c| c.model_dir != model_dir)
        .unwrap_or(true);
    if needs_reload {
        *cache = None;
        let assets = resolve_assets_from_dir(model_dir)?;
        let engine = BiRefNetMattingEngine::load(&assets, resource_dir)?;
        *cache = Some(CachedMattingEngine {
            model_dir: model_dir.to_path_buf(),
            engine,
        });
    }
    cache.as_ref().map(|c| &c.engine).ok_or_else(|| {
        AppError::new(
            "MATTING_ENGINE_LOAD_FAILED",
            "Matting engine failed to initialize.",
        )
    })
}

pub fn dispatch_matting_request(
    cache: &mut Option<CachedMattingEngine>,
    resource_dir: Option<&Path>,
    req: MattingWorkerRequest,
    payload: &[u8],
) -> (MattingWorkerResponse, Vec<u8>) {
    match req {
        MattingWorkerRequest::Shutdown => (MattingWorkerResponse::Bye, Vec::new()),
        MattingWorkerRequest::Ping { model_dir } => {
            match ensure_engine_loaded(cache, Path::new(&model_dir), resource_dir) {
                Ok(engine) => (
                    MattingWorkerResponse::Pong {
                        runtime_version: engine.runtime_version().to_string(),
                    },
                    Vec::new(),
                ),
                Err(err) => err_resp(err),
            }
        }
        MattingWorkerRequest::PredictMask512 { model_dir } => {
            if payload.len() != MATTING_RGB512_BYTES {
                return err_resp(AppError::invalid_param(format!(
                    "Expected {MATTING_RGB512_BYTES} RGB bytes for 512x512 matting input, got {}.",
                    payload.len()
                )));
            }
            let engine = match ensure_engine_loaded(cache, Path::new(&model_dir), resource_dir) {
                Ok(eng) => eng,
                Err(err) => return err_resp(err),
            };
            match engine.predict_mask_512(payload) {
                Ok(mask) => (
                    MattingWorkerResponse::Mask512 {
                        runtime_version: engine.runtime_version().to_string(),
                    },
                    mask,
                ),
                Err(err) => err_resp(err),
            }
        }
    }
}

/// Entrypoint executed when `winkit.exe` is spawned with `--matting-worker`.
pub fn run_matting_worker_stdio_loop(resource_dir: Option<&Path>) -> i32 {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());
    let mut cache: Option<CachedMattingEngine> = None;

    loop {
        let frame = match read_framed(&mut reader) {
            Ok(Some(pair)) => pair,
            Ok(None) => return 0,
            Err(_) => return 1,
        };
        let req: MattingWorkerRequest = match serde_json::from_slice(&frame.0) {
            Ok(r) => r,
            Err(e) => {
                let (resp, _) = err_resp(AppError::invalid_param(format!(
                    "Malformed matting worker request: {e}"
                )));
                if let Ok(json) = serde_json::to_vec(&resp) {
                    let _ = write_framed(&mut writer, &json, &[]);
                }
                continue;
            }
        };
        let is_shutdown = matches!(req, MattingWorkerRequest::Shutdown);
        let (resp, out_payload) = dispatch_matting_request(&mut cache, resource_dir, req, &frame.1);
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

struct LiveMattingWorker {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    #[cfg(windows)]
    job: Option<job_guard::WindowsJobGuard>,
}

impl LiveMattingWorker {
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

fn map_matting_worker_error(code: String, message: String) -> AppError {
    let static_code: &'static str = match code.as_str() {
        "MATTING_MODEL_MISSING" => "MATTING_MODEL_MISSING",
        "MATTING_ENGINE_LOAD_FAILED" => "MATTING_ENGINE_LOAD_FAILED",
        "MATTING_INFERENCE_FAILED" => "MATTING_INFERENCE_FAILED",
        "MATTING_WORKER_TIMEOUT" => "MATTING_WORKER_TIMEOUT",
        "MATTING_WORKER_CRASHED" => "MATTING_WORKER_CRASHED",
        "ORT_RUNTIME_MISSING" => "ORT_RUNTIME_MISSING",
        "OCR_ENGINE_MISSING" => "MATTING_MODEL_MISSING",
        "OCR_ENGINE_LOAD_FAILED" => "MATTING_ENGINE_LOAD_FAILED",
        "OCR_INFERENCE_FAILED" => "MATTING_INFERENCE_FAILED",
        "INVALID_PARAMETER" => "INVALID_PARAMETER",
        "TASK_CANCELLED" => "TASK_CANCELLED",
        _ => "MATTING_WORKER_ERROR",
    };
    AppError::new(static_code, message)
}

fn inprocess_matting_singleton() -> &'static Mutex<Option<CachedMattingEngine>> {
    static ENGINE: OnceLock<Mutex<Option<CachedMattingEngine>>> = OnceLock::new();
    ENGINE.get_or_init(|| Mutex::new(None))
}

#[derive(Default)]
pub struct MattingWorkerClient {
    resource_dir: Mutex<Option<PathBuf>>,
    proc_state: Mutex<Option<LiveMattingWorker>>,
}

impl Drop for MattingWorkerClient {
    fn drop(&mut self) {
        self.shutdown_worker();
    }
}

impl MattingWorkerClient {
    pub fn set_resource_dir(&self, dir: PathBuf) {
        if let Ok(mut guard) = self.resource_dir.lock() {
            *guard = Some(dir);
        }
    }

    pub fn resource_dir(&self) -> Option<PathBuf> {
        self.resource_dir.lock().ok().and_then(|g| g.clone())
    }

    fn spawn_worker(&self) -> Result<LiveMattingWorker, AppError> {
        let exe = std::env::current_exe().map_err(|e| {
            AppError::new(
                "MATTING_WORKER_ERROR",
                format!("Unable to resolve executable for matting worker: {e}"),
            )
        })?;
        let mut cmd = Command::new(exe);
        cmd.arg(MATTING_WORKER_FLAG);
        if let Some(dir) = self.resource_dir() {
            cmd.arg("--matting-resource-dir").arg(dir);
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
                "MATTING_WORKER_ERROR",
                format!("Failed to start isolated matting worker process: {e}"),
            )
        })?;

        #[cfg(windows)]
        let job = job_guard::WindowsJobGuard::attach_with_memory_limit(
            &child,
            MATTING_WORKER_MEMORY_LIMIT_BYTES,
        );

        let stdin = child.stdin.take().ok_or_else(|| {
            let _ = child.kill();
            let _ = child.wait();
            AppError::new(
                "MATTING_WORKER_ERROR",
                "Matting worker stdin pipe unavailable.",
            )
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            let _ = child.kill();
            let _ = child.wait();
            AppError::new(
                "MATTING_WORKER_ERROR",
                "Matting worker stdout pipe unavailable.",
            )
        })?;

        Ok(LiveMattingWorker {
            child,
            stdin: BufWriter::new(stdin),
            stdout: BufReader::new(stdout),
            #[cfg(windows)]
            job,
        })
    }

    pub fn send(
        &self,
        req: MattingWorkerRequest,
        payload: &[u8],
        cancel_flag: Option<&Arc<AtomicBool>>,
    ) -> Result<(MattingWorkerResponse, Vec<u8>), AppError> {
        if let Some(flag) = cancel_flag {
            if flag.load(Ordering::Relaxed) {
                return Err(AppError::cancelled());
            }
        }

        if !should_use_subprocess_worker() || std::env::var_os("WINKIT_MATTING_INPROCESS").is_some()
        {
            let res_dir = self.resource_dir();
            let mut eng = inprocess_matting_singleton().lock().map_err(|_| {
                AppError::new(
                    "MATTING_WORKER_ERROR",
                    "In-process matting engine lock poisoned.",
                )
            })?;
            let (resp, out_payload) =
                dispatch_matting_request(&mut eng, res_dir.as_deref(), req, payload);
            return match resp {
                MattingWorkerResponse::Error { code, message } => {
                    Err(map_matting_worker_error(code, message))
                }
                other => Ok((other, out_payload)),
            };
        }

        let req_json = serde_json::to_vec(&req).map_err(|e| {
            AppError::new(
                "MATTING_WORKER_ERROR",
                format!("Failed to serialize matting worker request: {e}"),
            )
        })?;

        let mut guard = self.proc_state.lock().map_err(|_| {
            AppError::new(
                "MATTING_WORKER_ERROR",
                "Matting worker client lock poisoned.",
            )
        })?;

        for attempt in 0..2 {
            if let Some(flag) = cancel_flag {
                if flag.load(Ordering::Relaxed) {
                    return Err(AppError::cancelled());
                }
            }

            if guard.is_none() {
                *guard = Some(self.spawn_worker()?);
            }
            let proc = guard.as_mut().expect("matting worker spawned");

            // Combined cancellation + watchdog thread: polls `cancel_flag` every 25 ms and
            // enforces `DEFAULT_MATTING_REQUEST_TIMEOUT`, terminating the Windows Job Object
            // immediately to unblock pipe reads on cancel or hang.
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
                let deadline = Instant::now() + DEFAULT_MATTING_REQUEST_TIMEOUT;
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

            let write_res = write_framed(&mut proc.stdin, &req_json, payload);
            let read_res = match write_res {
                Ok(()) => read_framed(&mut proc.stdout),
                Err(err) => Err(err),
            };

            {
                let (lock, cvar) = &*done_signal;
                if let Ok(mut done) = lock.lock() {
                    *done = true;
                    cvar.notify_one();
                }
            }
            let _ = watchdog.join();

            if cancelled_mid.load(Ordering::SeqCst)
                || cancel_flag
                    .map(|f| f.load(Ordering::Relaxed))
                    .unwrap_or(false)
            {
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
                    "MATTING_WORKER_TIMEOUT",
                    format!(
                        "Background removal exceeded the {}s timeout and was terminated cleanly.",
                        DEFAULT_MATTING_REQUEST_TIMEOUT.as_secs()
                    ),
                ));
            }

            match read_res {
                Ok(Some((hdr, out_payload))) => {
                    let resp: MattingWorkerResponse =
                        serde_json::from_slice(&hdr).map_err(|e| {
                            AppError::new(
                                "MATTING_WORKER_ERROR",
                                format!("Invalid response from isolated matting worker: {e}"),
                            )
                        })?;
                    return match resp {
                        MattingWorkerResponse::Error { code, message } => {
                            Err(map_matting_worker_error(code, message))
                        }
                        other => Ok((other, out_payload)),
                    };
                }
                Ok(None) | Err(_) => {
                    if let Some(dead) = guard.take() {
                        dead.kill_and_reap();
                    }
                    if attempt == 1 {
                        return Err(AppError::new(
                            "MATTING_WORKER_CRASHED",
                            "The isolated background-removal worker stopped unexpectedly.",
                        ));
                    }
                }
            }
        }

        Err(AppError::new(
            "MATTING_WORKER_ERROR",
            "Matting worker request did not complete.",
        ))
    }

    pub fn shutdown_worker(&self) {
        if let Ok(mut guard) = self.proc_state.lock() {
            if let Some(mut proc) = guard.take() {
                if let Ok(json) = serde_json::to_vec(&MattingWorkerRequest::Shutdown) {
                    let _ = write_framed(&mut proc.stdin, &json, &[]);
                    let _ = read_framed(&mut proc.stdout);
                }
                proc.kill_and_reap();
            }
        }
        if let Ok(mut eng) = inprocess_matting_singleton().lock() {
            *eng = None;
        }
    }
}

#[derive(Clone, Default)]
pub struct MattingSessionManager {
    worker: Arc<MattingWorkerClient>,
    results: MattingResultStore,
}

impl MattingSessionManager {
    pub fn set_resource_dir(&self, dir: PathBuf) {
        self.worker.set_resource_dir(dir);
    }

    pub fn resource_dir(&self) -> Option<PathBuf> {
        self.worker.resource_dir()
    }

    pub fn worker(&self) -> &MattingWorkerClient {
        &self.worker
    }

    pub fn results(&self) -> &MattingResultStore {
        &self.results
    }

    pub fn shutdown_worker(&self) {
        self.worker.shutdown_worker();
    }

    pub fn cleanup_on_exit(&self) {
        self.worker.shutdown_worker();
        self.results.clear();
    }
}

/// Orchestrates end-to-end offline background removal for a single local file or in-memory asset.
#[allow(clippy::too_many_arguments)]
pub fn remove_image_background_impl<F>(
    task_id: &str,
    matting_root: &Path,
    matting: &MattingSessionManager,
    asset_store: &ImageAssetStore,
    request: &RemoveBackgroundRequest,
    cancel_flag: &Arc<AtomicBool>,
    mut emit_progress: F,
) -> Result<RemoveBackgroundResult, AppError>
where
    F: FnMut(MattingProgressPayload),
{
    let started = Instant::now();
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let res_dir = matting.resource_dir();
    let assets = require_matting_assets(matting_root, res_dir.as_deref())?;

    emit_progress(MattingProgressPayload {
        task_id: task_id.to_string(),
        phase: "decoding".into(),
        percent: 12.0,
        detail: "Decoding source image and applying upright EXIF orientation...".into(),
    });
    let loaded = load_matting_source(request, asset_store)?;
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let (width, height) = loaded.rgba.dimensions();
    emit_progress(MattingProgressPayload {
        task_id: task_id.to_string(),
        phase: "preparing".into(),
        percent: 28.0,
        detail: format!("Preparing {width}×{height} image for offline BiRefNet_lite..."),
    });
    let rgb512 = prepare_rgb512_for_model(&loaded.rgba, loaded.source_has_alpha);
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    emit_progress(MattingProgressPayload {
        task_id: task_id.to_string(),
        phase: "inferring".into(),
        percent: 45.0,
        detail: "Running local offline foreground segmentation (BiRefNet_lite 512)...".into(),
    });
    let (resp, mask512) = matting.worker().send(
        MattingWorkerRequest::PredictMask512 {
            model_dir: assets.model_dir.to_string_lossy().into_owned(),
        },
        &rgb512,
        Some(cancel_flag),
    )?;
    if !matches!(resp, MattingWorkerResponse::Mask512 { .. })
        || mask512.len() != MATTING_MASK512_BYTES
    {
        return Err(AppError::new(
            "MATTING_INFERENCE_FAILED",
            "Matting worker returned an unexpected matte payload.",
        ));
    }

    finalize_matting_from_mask(
        task_id,
        started,
        loaded,
        &mask512,
        matting,
        asset_store,
        cancel_flag,
        emit_progress,
    )
}

/// Runs full-resolution alpha compositing, PNG/preview encoding, and cache publishing with
/// explicit cancellation checks at every stage boundary and immediately before mutating either
/// `ImageAssetStore` or `MattingResultStore`.
#[allow(clippy::too_many_arguments)]
pub fn finalize_matting_from_mask<F>(
    task_id: &str,
    started: Instant,
    mut loaded: LoadedMattingSource,
    mask512: &[u8],
    matting: &MattingSessionManager,
    asset_store: &ImageAssetStore,
    cancel_flag: &AtomicBool,
    mut emit_progress: F,
) -> Result<RemoveBackgroundResult, AppError>
where
    F: FnMut(MattingProgressPayload),
{
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    emit_progress(MattingProgressPayload {
        task_id: task_id.to_string(),
        phase: "compositing".into(),
        percent: 82.0,
        detail: "Compositing full-resolution alpha channel and generating previews...".into(),
    });
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let (width, height) = loaded.rgba.dimensions();
    let (cutout_rgba, stats) =
        apply_predicted_matte_to_rgba_cancellable(&loaded.rgba, mask512, Some(cancel_flag))?;
    if stats.subject_bbox.is_none() {
        loaded.warnings.push(
            "No distinct foreground subject was detected; the resulting alpha mask is empty."
                .to_string(),
        );
    }

    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let cutout_png_bytes =
        encode_rgba_png_bytes(&cutout_rgba, true, loaded.icc_profile.as_deref())?;

    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let (original_preview_data_url, cutout_preview_data_url) =
        build_matting_preview_urls(&loaded.rgba, loaded.source_has_alpha, &cutout_rgba)?;

    // Final validity check immediately before publishing to shared image cache & result store.
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    // Also register in WinKit's shared in-memory ImageAssetStore when within asset store bounds
    // so the user can hand off the transparent PNG cutout straight into I12 / I13 / I03.
    let cutout_asset_id = if width <= MAX_ASSET_SIDE
        && height <= MAX_ASSET_SIDE
        && u64::from(width) * u64::from(height) <= MAX_ASSET_PIXELS
        && cutout_png_bytes.len() <= MAX_ASSET_BYTES
    {
        let stem = Path::new(&loaded.file_name)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "cutout".to_string());
        asset_store
            .insert_png_bytes(cutout_png_bytes.clone(), format!("{stem}_cutout.png"))
            .ok()
            .map(|p| p.asset_id)
    } else {
        None
    };

    if cancel_flag.load(Ordering::Relaxed) {
        if let Some(ref aid) = cutout_asset_id {
            asset_store.remove(aid);
        }
        return Err(AppError::cancelled());
    }

    let result_id = next_matting_result_id();
    if let Err(err) = matting.results().insert(StoredMattingCutout {
        id: result_id.clone(),
        label: loaded.file_name.clone(),
        source_path: loaded.source_path.clone(),
        width,
        height,
        icc_profile: loaded.icc_profile,
        subject_bbox: stats.subject_bbox,
        cutout_png_bytes,
        cutout_asset_id: cutout_asset_id.clone(),
    }) {
        if let Some(ref aid) = cutout_asset_id {
            asset_store.remove(aid);
        }
        return Err(err);
    }

    emit_progress(MattingProgressPayload {
        task_id: task_id.to_string(),
        phase: "completed".into(),
        percent: 100.0,
        detail: "Background removal complete.".into(),
    });

    Ok(RemoveBackgroundResult {
        result_id,
        cutout_asset_id,
        file_name: loaded.file_name,
        source_path: loaded.source_path,
        width,
        height,
        raw_width: loaded.raw_width,
        raw_height: loaded.raw_height,
        exif_orientation: loaded.exif_orientation,
        source_has_alpha: loaded.source_has_alpha,
        preserved_source_alpha: stats.preserved_source_alpha,
        subject_bbox: stats.subject_bbox,
        foreground_ratio: stats.foreground_ratio,
        soft_edge_ratio: stats.soft_edge_ratio,
        elapsed_ms: started.elapsed().as_millis() as u64,
        original_preview_data_url,
        cutout_preview_data_url,
        warnings: loaded.warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn remove_background_rejects_precancelled_and_missing_model_without_network() {
        let dir = tempdir().expect("tempdir");
        let mgr = MattingSessionManager::default();
        let store = ImageAssetStore::default();
        let req = RemoveBackgroundRequest {
            path: None,
            asset_id: None,
            label: None,
        };

        // 1. Pre-cancelled returns TASK_CANCELLED immediately
        let cancelled = Arc::new(AtomicBool::new(true));
        let err_cancel = remove_image_background_impl(
            "t-cancel",
            dir.path(),
            &mgr,
            &store,
            &req,
            &cancelled,
            |_| {},
        )
        .unwrap_err();
        assert_eq!(err_cancel.code, "TASK_CANCELLED");

        // 2. Missing model fails with MATTING_MODEL_MISSING (or ORT_RUNTIME_MISSING if DLL absent)
        let active = Arc::new(AtomicBool::new(false));
        let err_missing = remove_image_background_impl(
            "t-missing",
            dir.path(),
            &mgr,
            &store,
            &req,
            &active,
            |_| {},
        )
        .unwrap_err();
        assert!(
            err_missing.code == "MATTING_MODEL_MISSING"
                || err_missing.code == "ORT_RUNTIME_MISSING",
            "unexpected error code: {}",
            err_missing.code
        );
    }

    fn make_synthetic_loaded_source(file_name: &str, r: u8, g: u8, b: u8) -> LoadedMattingSource {
        let mut rgba = image::RgbaImage::new(32, 32);
        for pixel in rgba.pixels_mut() {
            *pixel = image::Rgba([r, g, b, 255]);
        }
        LoadedMattingSource {
            rgba,
            file_name: file_name.to_string(),
            source_path: None,
            raw_width: 32,
            raw_height: 32,
            exif_orientation: 1,
            source_has_alpha: false,
            icc_profile: None,
            warnings: Vec::new(),
        }
    }

    fn make_centered_mask512() -> Vec<u8> {
        let mut mask = vec![0u8; MATTING_MASK512_BYTES];
        for y in 128..384 {
            for x in 128..384 {
                mask[y * 512 + x] = 255;
            }
        }
        mask
    }

    #[test]
    fn compositing_stage_cancel_at_82_percent_preserves_existing_results_and_allows_retry() {
        let mgr = MattingSessionManager::default();
        let store = ImageAssetStore::default();
        let mask512 = make_centered_mask512();

        // 1. Seed an existing completed result A in both MattingResultStore and ImageAssetStore.
        let active = AtomicBool::new(false);
        let res_a = finalize_matting_from_mask(
            "task-a",
            Instant::now(),
            make_synthetic_loaded_source("first.png", 200, 40, 40),
            &mask512,
            &mgr,
            &store,
            &active,
            |_| {},
        )
        .expect("initial matting result A should succeed");
        let existing_asset_id = res_a
            .cutout_asset_id
            .clone()
            .expect("result A should register in shared ImageAssetStore");
        let existing_stored = mgr
            .results()
            .get(&res_a.result_id)
            .expect("result A should exist in MattingResultStore");
        assert_eq!(mgr.results().len(), 1);
        assert_eq!(store.len(), 1);

        // 2. Start task B and trigger cancellation right when 82% compositing progress arrives.
        let cancel_b = AtomicBool::new(false);
        let mut saw_82 = false;
        let err_b = finalize_matting_from_mask(
            "task-b-cancelled",
            Instant::now(),
            make_synthetic_loaded_source("second.png", 40, 120, 220),
            &mask512,
            &mgr,
            &store,
            &cancel_b,
            |progress| {
                if progress.phase == "compositing" && (progress.percent - 82.0).abs() < 0.01 {
                    saw_82 = true;
                    cancel_b.store(true, Ordering::Relaxed);
                }
            },
        )
        .expect_err("task B cancelled at 82% compositing must return TASK_CANCELLED");

        assert!(saw_82, "expected 82% compositing progress event");
        assert_eq!(err_b.code, "TASK_CANCELLED");

        // Existing result A and shared ImageAssetStore must remain completely intact (no leak).
        assert_eq!(mgr.results().len(), 1);
        assert_eq!(store.len(), 1);
        let preserved = mgr
            .results()
            .get(&res_a.result_id)
            .expect("existing result A must remain preserved");
        assert_eq!(preserved.cutout_png_bytes, existing_stored.cutout_png_bytes);
        assert!(store.get_png_bytes(&existing_asset_id).is_ok());

        // 3. Subsequent retry of task B with a fresh active flag succeeds cleanly.
        let retry_active = AtomicBool::new(false);
        let res_b = finalize_matting_from_mask(
            "task-b-retry",
            Instant::now(),
            make_synthetic_loaded_source("second.png", 40, 120, 220),
            &mask512,
            &mgr,
            &store,
            &retry_active,
            |_| {},
        )
        .expect("retry of task B should succeed");
        assert_eq!(res_b.file_name, "second.png");
        assert!(res_b.subject_bbox.is_some());
        assert!(res_b.cutout_asset_id.is_some());
        assert_eq!(mgr.results().len(), 2);
        assert_eq!(store.len(), 2);
        assert!(mgr.results().get(&res_a.result_id).is_ok());
    }
}
