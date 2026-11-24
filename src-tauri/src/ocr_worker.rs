//! Process-isolated offline OCR worker (`winkit.exe --ocr-worker`) with Windows Job Object
//! resource limits, instant cancellation, and batch/PDF orchestration shared by T03, T04, and P04.
//!
//! Scope & honesty note:
//! - ONNX Runtime (`onnxruntime.dll`) and RapidOCR PP-OCRv4 models run inside a dedicated child
//!   process (`winkit.exe --ocr-worker`) attached to a Windows Job Object configured with
//!   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, `JOB_OBJECT_LIMIT_PROCESS_MEMORY` (2 GiB commit cap),
//!   and `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` (limit = 1).
//! - Windows Job Objects provide crash isolation, memory caps, and deterministic termination on
//!   cancellation or window close — NOT a full OS security sandbox.
//! - During `cargo test` (when `current_exe()` is the test binary rather than `winkit.exe`),
//!   requests run through the exact same `dispatch_ocr_request` handler in-process.

use crate::error::AppError;
use crate::fs_guard::validate_existing_input_file;
use crate::image_assets::ImageAssetStore;
use crate::image_core::{composite_rgba_over_rgb, inspect_single_image_item, MAX_IMAGE_FILE_BYTES};
use crate::ocr_core::{
    check_ocr_engine_status, is_pdf_path, OcrBatchItemResult, OcrBatchResult, OcrEngineStatus,
    OcrInspectSourceItem, OcrPageResult, OcrProgressPayload, OcrRecognizeOptions, RapidOcrEngine,
    DEFAULT_PDF_OCR_DPI, MAX_OCR_BATCH_ITEMS,
};
use crate::ocr_ort::OCR_ENGINE_DISPLAY_NAME;
use crate::pdf_core::{parse_page_range_spec, PdfRenderRequest, PdfSessionManager};
use crate::pdf_worker::{should_use_subprocess_worker, PdfWorkerRequest, PdfWorkerResponse};
use crate::wic_heic::get_heic_capabilities;
use image::{RgbImage, RgbaImage};
use serde::{Deserialize, Serialize};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

#[cfg(windows)]
use crate::pdf_worker::job_guard;

pub const OCR_WORKER_FLAG: &str = "--ocr-worker";
const MAX_FRAME_BYTES: usize = 160 * 1024 * 1024; // 160 MiB cap for high-DPI RGBA page frames
const OCR_WORKER_MEMORY_LIMIT_BYTES: usize = 2 * 1024 * 1024 * 1024; // 2 GiB commit cap for ONNX arenas
const DEFAULT_OCR_REQUEST_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum OcrWorkerRequest {
    Ping,
    RecognizeImageFile {
        path: String,
        options: OcrRecognizeOptions,
    },
    RecognizePngBytes {
        page_number: usize,
        render_dpi: Option<f32>,
        source_width_pt: Option<f32>,
        source_height_pt: Option<f32>,
        options: OcrRecognizeOptions,
    },
    RecognizeRgbaBuffer {
        width: u32,
        height: u32,
        page_number: usize,
        render_dpi: Option<f32>,
        source_width_pt: Option<f32>,
        source_height_pt: Option<f32>,
        options: OcrRecognizeOptions,
    },
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum OcrWorkerResponse {
    Pong { runtime_version: String },
    Page(OcrPageResult),
    Error { code: String, message: String },
    Bye,
}

fn write_framed<W: Write>(writer: &mut W, header_json: &[u8], payload: &[u8]) -> io::Result<()> {
    let header_len = u32::try_from(header_json.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Header too large"))?;
    let payload_len = u32::try_from(payload.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Payload too large"))?;
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
            "Invalid OCR worker IPC frame size",
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

fn err_resp(err: AppError) -> OcrWorkerResponse {
    OcrWorkerResponse::Error {
        code: err.code.to_string(),
        message: err.message,
    }
}

pub fn dispatch_ocr_request(
    engine: &mut Option<RapidOcrEngine>,
    resource_dir: Option<&Path>,
    req: OcrWorkerRequest,
    payload: &[u8],
) -> OcrWorkerResponse {
    if matches!(req, OcrWorkerRequest::Shutdown) {
        return OcrWorkerResponse::Bye;
    }

    if engine.is_none() {
        match RapidOcrEngine::load(resource_dir) {
            Ok(loaded) => *engine = Some(loaded),
            Err(err) => return err_resp(err),
        }
    }
    let Some(ocr) = engine.as_ref() else {
        return err_resp(AppError::new(
            "OCR_ENGINE_LOAD_FAILED",
            "OCR engine failed to initialize.",
        ));
    };

    match req {
        OcrWorkerRequest::Ping => OcrWorkerResponse::Pong {
            runtime_version: ocr.runtime_version().to_string(),
        },
        OcrWorkerRequest::Shutdown => OcrWorkerResponse::Bye,
        OcrWorkerRequest::RecognizeImageFile { path, options } => {
            let (canonical, file_len) = match validate_existing_input_file(&path) {
                Ok(v) => v,
                Err(err) => return err_resp(err),
            };
            if file_len == 0 {
                return err_resp(AppError::new(
                    "IMAGE_DECODE_FAILED",
                    "Image file is empty (0 bytes).",
                ));
            }
            if file_len > MAX_IMAGE_FILE_BYTES {
                return err_resp(AppError::size_limit(format!(
                    "Image file exceeds the {} MiB safety limit.",
                    MAX_IMAGE_FILE_BYTES / (1024 * 1024)
                )));
            }
            match ocr.recognize_image_file(&canonical, &options) {
                Ok(page) => OcrWorkerResponse::Page(page),
                Err(err) => err_resp(err),
            }
        }
        OcrWorkerRequest::RecognizePngBytes {
            page_number,
            render_dpi,
            source_width_pt,
            source_height_pt,
            options,
        } => match ocr.recognize_image_bytes(payload, &options) {
            Ok(mut page) => {
                page.page_number = page_number;
                page.render_dpi = render_dpi;
                page.source_width_pt = source_width_pt;
                page.source_height_pt = source_height_pt;
                OcrWorkerResponse::Page(page)
            }
            Err(err) => err_resp(err),
        },
        OcrWorkerRequest::RecognizeRgbaBuffer {
            width,
            height,
            page_number,
            render_dpi,
            source_width_pt,
            source_height_pt,
            options,
        } => {
            let expected = (width as usize)
                .checked_mul(height as usize)
                .and_then(|v| v.checked_mul(4));
            if expected != Some(payload.len()) {
                return err_resp(AppError::invalid_param(
                    "RGBA payload buffer size does not match declared dimensions.",
                ));
            }
            let Some(rgba) = RgbaImage::from_raw(width, height, payload.to_vec()) else {
                return err_resp(AppError::invalid_param("Invalid RGBA image buffer."));
            };
            let rgb: RgbImage = composite_rgba_over_rgb(&rgba, [255, 255, 255]);
            match ocr.recognize_rgb(
                &rgb,
                page_number,
                render_dpi,
                source_width_pt,
                source_height_pt,
                &options,
            ) {
                Ok(page) => OcrWorkerResponse::Page(page),
                Err(err) => err_resp(err),
            }
        }
    }
}

/// Entrypoint executed when `winkit.exe` is spawned with `--ocr-worker`.
pub fn run_ocr_worker_stdio_loop(resource_dir: Option<&Path>) -> i32 {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());
    let mut engine: Option<RapidOcrEngine> = None;

    loop {
        let frame = match read_framed(&mut reader) {
            Ok(Some(pair)) => pair,
            Ok(None) => return 0,
            Err(_) => return 1,
        };
        let req: OcrWorkerRequest = match serde_json::from_slice(&frame.0) {
            Ok(r) => r,
            Err(e) => {
                let resp = err_resp(AppError::invalid_param(format!(
                    "Malformed OCR worker request: {e}"
                )));
                if let Ok(json) = serde_json::to_vec(&resp) {
                    let _ = write_framed(&mut writer, &json, &[]);
                }
                continue;
            }
        };
        let is_shutdown = matches!(req, OcrWorkerRequest::Shutdown);
        let resp = dispatch_ocr_request(&mut engine, resource_dir, req, &frame.1);
        let Ok(json) = serde_json::to_vec(&resp) else {
            return 2;
        };
        if write_framed(&mut writer, &json, &[]).is_err() {
            return 0;
        }
        if is_shutdown {
            return 0;
        }
    }
}

struct LiveOcrWorker {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    #[cfg(windows)]
    job: Option<job_guard::WindowsJobGuard>,
}

impl LiveOcrWorker {
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

fn map_ocr_worker_error(code: String, message: String) -> AppError {
    let static_code: &'static str = match code.as_str() {
        "OCR_ENGINE_MISSING" => "OCR_ENGINE_MISSING",
        "OCR_ENGINE_LOAD_FAILED" => "OCR_ENGINE_LOAD_FAILED",
        "OCR_INFERENCE_FAILED" => "OCR_INFERENCE_FAILED",
        "OCR_WORKER_TIMEOUT" => "OCR_WORKER_TIMEOUT",
        "OCR_WORKER_CRASHED" => "OCR_WORKER_CRASHED",
        "IMAGE_DECODE_FAILED" => "IMAGE_DECODE_FAILED",
        "FILE_NOT_FOUND" => "FILE_NOT_FOUND",
        "IS_DIRECTORY" => "IS_DIRECTORY",
        "PERMISSION_DENIED" => "PERMISSION_DENIED",
        "FILE_LOCKED" => "FILE_LOCKED",
        "SIZE_LIMIT_EXCEEDED" => "SIZE_LIMIT_EXCEEDED",
        "INVALID_PARAMETER" => "INVALID_PARAMETER",
        "TASK_CANCELLED" => "TASK_CANCELLED",
        _ => "OCR_WORKER_ERROR",
    };
    AppError::new(static_code, message)
}

fn inprocess_engine_singleton() -> &'static Mutex<Option<RapidOcrEngine>> {
    static ENGINE: OnceLock<Mutex<Option<RapidOcrEngine>>> = OnceLock::new();
    ENGINE.get_or_init(|| Mutex::new(None))
}

#[derive(Default)]
pub struct OcrWorkerClient {
    resource_dir: Mutex<Option<PathBuf>>,
    proc_state: Mutex<Option<LiveOcrWorker>>,
}

impl Drop for OcrWorkerClient {
    fn drop(&mut self) {
        self.shutdown_worker();
    }
}

impl OcrWorkerClient {
    pub fn set_resource_dir(&self, dir: PathBuf) {
        if let Ok(mut guard) = self.resource_dir.lock() {
            *guard = Some(dir);
        }
    }

    pub fn resource_dir(&self) -> Option<PathBuf> {
        self.resource_dir.lock().ok().and_then(|g| g.clone())
    }

    fn spawn_worker(&self) -> Result<LiveOcrWorker, AppError> {
        let exe = std::env::current_exe().map_err(|e| {
            AppError::new(
                "OCR_WORKER_ERROR",
                format!("Unable to resolve executable for OCR worker: {e}"),
            )
        })?;
        let mut cmd = Command::new(exe);
        cmd.arg(OCR_WORKER_FLAG);
        if let Some(dir) = self.resource_dir() {
            cmd.arg("--ocr-resource-dir").arg(dir);
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
                "OCR_WORKER_ERROR",
                format!("Failed to start isolated OCR worker process: {e}"),
            )
        })?;

        #[cfg(windows)]
        let job = job_guard::WindowsJobGuard::attach_with_memory_limit(
            &child,
            OCR_WORKER_MEMORY_LIMIT_BYTES,
        );

        let stdin = child.stdin.take().ok_or_else(|| {
            let _ = child.kill();
            let _ = child.wait();
            AppError::new("OCR_WORKER_ERROR", "OCR worker stdin pipe unavailable.")
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            let _ = child.kill();
            let _ = child.wait();
            AppError::new("OCR_WORKER_ERROR", "OCR worker stdout pipe unavailable.")
        })?;

        Ok(LiveOcrWorker {
            child,
            stdin: BufWriter::new(stdin),
            stdout: BufReader::new(stdout),
            #[cfg(windows)]
            job,
        })
    }

    pub fn send(
        &self,
        req: OcrWorkerRequest,
        payload: &[u8],
        cancel_flag: Option<&Arc<AtomicBool>>,
    ) -> Result<OcrWorkerResponse, AppError> {
        if let Some(flag) = cancel_flag {
            if flag.load(Ordering::Relaxed) {
                return Err(AppError::cancelled());
            }
        }

        if !should_use_subprocess_worker() || std::env::var_os("WINKIT_OCR_INPROCESS").is_some() {
            let res_dir = self.resource_dir();
            let mut eng = inprocess_engine_singleton()
                .lock()
                .map_err(|_| AppError::new("OCR_WORKER_ERROR", "In-process OCR lock poisoned."))?;
            let resp = dispatch_ocr_request(&mut eng, res_dir.as_deref(), req, payload);
            return match resp {
                OcrWorkerResponse::Error { code, message } => {
                    Err(map_ocr_worker_error(code, message))
                }
                other => Ok(other),
            };
        }

        let req_json = serde_json::to_vec(&req).map_err(|e| {
            AppError::new(
                "OCR_WORKER_ERROR",
                format!("Failed to serialize OCR worker request: {e}"),
            )
        })?;

        let mut guard = self
            .proc_state
            .lock()
            .map_err(|_| AppError::new("OCR_WORKER_ERROR", "OCR worker client lock poisoned."))?;

        for attempt in 0..2 {
            if let Some(flag) = cancel_flag {
                if flag.load(Ordering::Relaxed) {
                    return Err(AppError::cancelled());
                }
            }

            if guard.is_none() {
                *guard = Some(self.spawn_worker()?);
            }
            let proc = guard.as_mut().expect("ocr worker spawned");

            // Combined cancellation + watchdog thread: checks `cancel_flag` every 50 ms and
            // enforces `DEFAULT_OCR_REQUEST_TIMEOUT`, terminating the Job Object immediately to
            // unblock pipe reads on cancellation or hang.
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
                let deadline = Instant::now() + DEFAULT_OCR_REQUEST_TIMEOUT;
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
                    let slice = (deadline - now).min(Duration::from_millis(50));
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
                    "OCR_WORKER_TIMEOUT",
                    format!(
                        "OCR inference exceeded the {}s timeout and was terminated cleanly.",
                        DEFAULT_OCR_REQUEST_TIMEOUT.as_secs()
                    ),
                ));
            }

            match read_res {
                Ok(Some((hdr, _))) => {
                    let resp: OcrWorkerResponse = serde_json::from_slice(&hdr).map_err(|e| {
                        AppError::new(
                            "OCR_WORKER_ERROR",
                            format!("Invalid response from isolated OCR worker: {e}"),
                        )
                    })?;
                    return match resp {
                        OcrWorkerResponse::Error { code, message } => {
                            Err(map_ocr_worker_error(code, message))
                        }
                        other => Ok(other),
                    };
                }
                Ok(None) | Err(_) => {
                    if let Some(dead) = guard.take() {
                        dead.kill_and_reap();
                    }
                    if attempt == 1 {
                        return Err(AppError::new(
                            "OCR_WORKER_CRASHED",
                            "The isolated OCR worker stopped unexpectedly while processing this page.",
                        ));
                    }
                }
            }
        }

        Err(AppError::new(
            "OCR_WORKER_ERROR",
            "OCR worker request did not complete.",
        ))
    }

    pub fn shutdown_worker(&self) {
        if let Ok(mut guard) = self.proc_state.lock() {
            if let Some(mut proc) = guard.take() {
                if let Ok(json) = serde_json::to_vec(&OcrWorkerRequest::Shutdown) {
                    let _ = write_framed(&mut proc.stdin, &json, &[]);
                    let _ = read_framed(&mut proc.stdout);
                }
                proc.kill_and_reap();
            }
        }
    }
}

#[derive(Clone, Default)]
pub struct OcrSessionManager {
    worker: Arc<OcrWorkerClient>,
}

impl OcrSessionManager {
    pub fn set_resource_dir(&self, dir: PathBuf) {
        self.worker.set_resource_dir(dir);
    }

    pub fn status(&self) -> OcrEngineStatus {
        let dir = self.worker.resource_dir();
        check_ocr_engine_status(dir.as_deref())
    }

    pub fn worker(&self) -> &OcrWorkerClient {
        &self.worker
    }

    pub fn cleanup_on_exit(&self) {
        self.worker.shutdown_worker();
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrSourceInput {
    pub id: String,
    pub path: Option<String>,
    pub asset_id: Option<String>,
    pub name: Option<String>,
    /// Optional 1-based page range string for PDFs (e.g. "1-3, 5"); empty/None = all pages.
    pub page_range: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrBatchRequest {
    pub items: Vec<OcrSourceInput>,
    #[serde(default = "default_pdf_dpi")]
    pub pdf_dpi: f32,
    #[serde(default)]
    pub options: OcrRecognizeOptions,
}

fn default_pdf_dpi() -> f32 {
    DEFAULT_PDF_OCR_DPI
}

/// Inspects candidate image and PDF files before OCR so T03 can show thumbnails, dimensions,
/// page counts, and scanned-PDF hints immediately.
pub fn inspect_ocr_sources_impl(
    pdf_mgr: &PdfSessionManager,
    raw_paths: &[String],
) -> Vec<OcrInspectSourceItem> {
    let heic_caps = get_heic_capabilities();
    let mut results = Vec::with_capacity(raw_paths.len().min(MAX_OCR_BATCH_ITEMS));

    for raw in raw_paths.iter().take(MAX_OCR_BATCH_ITEMS) {
        let p = Path::new(raw);
        let file_name = p
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| raw.clone());

        if is_pdf_path(p) {
            match pdf_mgr.inspect_document(raw) {
                Ok(info) => {
                    let preview_data_url = pdf_mgr
                        .render_page(&PdfRenderRequest {
                            path: info.path.clone(),
                            page_number: 1,
                            target_width_px: Some(360),
                            extra_rotation_cw: None,
                        })
                        .ok()
                        .map(|r| r.data_url);
                    results.push(OcrInspectSourceItem {
                        path: info.path,
                        file_name: info.file_name,
                        kind: "pdf".to_string(),
                        byte_length: info.byte_length,
                        width_px: None,
                        height_px: None,
                        page_count: info.page_count,
                        is_likely_scanned: info.is_likely_scanned,
                        preview_data_url,
                        error_code: None,
                        error_message: None,
                    });
                }
                Err(err) => {
                    results.push(OcrInspectSourceItem {
                        path: raw.clone(),
                        file_name,
                        kind: "pdf".to_string(),
                        byte_length: 0,
                        width_px: None,
                        height_px: None,
                        page_count: 0,
                        is_likely_scanned: false,
                        preview_data_url: None,
                        error_code: Some(err.code.to_string()),
                        error_message: Some(err.message),
                    });
                }
            }
        } else {
            let item = inspect_single_image_item(p, &heic_caps);
            if let Some(err_msg) = item.error {
                results.push(OcrInspectSourceItem {
                    path: raw.clone(),
                    file_name,
                    kind: "image".to_string(),
                    byte_length: item.byte_length,
                    width_px: None,
                    height_px: None,
                    page_count: 1,
                    is_likely_scanned: false,
                    preview_data_url: None,
                    error_code: Some("IMAGE_DECODE_FAILED".to_string()),
                    error_message: Some(err_msg),
                });
            } else {
                results.push(OcrInspectSourceItem {
                    path: item.path,
                    file_name: item.file_name,
                    kind: "image".to_string(),
                    byte_length: item.byte_length,
                    width_px: Some(item.display_width),
                    height_px: Some(item.display_height),
                    page_count: 1,
                    is_likely_scanned: false,
                    preview_data_url: item.thumbnail_data_url,
                    error_code: None,
                    error_message: None,
                });
            }
        }
    }

    results
}

/// Runs batch offline OCR across mixed image files, in-memory image assets (clipboard / I01 / T04),
/// and multi-page scanned PDFs, emitting granular per-page progress and honoring immediate cancel.
pub fn ocr_extract_batch_impl<F>(
    task_id: &str,
    ocr_mgr: &OcrSessionManager,
    pdf_mgr: &PdfSessionManager,
    asset_store: &ImageAssetStore,
    req: &OcrBatchRequest,
    cancel_flag: &Arc<AtomicBool>,
    mut emit_progress: F,
) -> Result<OcrBatchResult, AppError>
where
    F: FnMut(OcrProgressPayload),
{
    if req.items.is_empty() {
        return Err(AppError::invalid_param(
            "At least one image or PDF source is required for OCR.",
        ));
    }
    if req.items.len() > MAX_OCR_BATCH_ITEMS {
        return Err(AppError::invalid_param(format!(
            "OCR batch exceeds the maximum of {MAX_OCR_BATCH_ITEMS} items."
        )));
    }
    let pdf_dpi = req.pdf_dpi.clamp(100.0, 300.0);
    let t_all = Instant::now();
    let total_items = req.items.len();

    let mut out_items: Vec<OcrBatchItemResult> = Vec::with_capacity(total_items);
    let mut completed_count = 0usize;
    let mut failed_count = 0usize;
    let mut cancelled = false;
    let mut total_pages_done = 0usize;
    let mut total_lines_done = 0usize;
    let mut total_chars_done = 0usize;

    for (item_idx, src) in req.items.iter().enumerate() {
        if cancel_flag.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }

        let source_name = src.name.clone().unwrap_or_else(|| {
            src.path
                .as_deref()
                .and_then(|p| Path::new(p).file_name())
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| format!("Item {}", item_idx + 1))
        });

        let item_t0 = Instant::now();

        // Case 1: In-memory image asset (clipboard screenshot or I01/T04 handoff — zero disk writes)
        if let Some(ref asset_id) = src.asset_id {
            emit_progress(OcrProgressPayload {
                task_id: task_id.to_string(),
                current_item: item_idx + 1,
                total_items,
                current_page: 1,
                total_pages: 1,
                label: source_name.clone(),
                percent: ((item_idx as f64) / (total_items as f64)) * 100.0,
                state: "running".to_string(),
            });

            match asset_store.get_png_bytes(asset_id) {
                Ok((png_bytes, _)) => {
                    match ocr_mgr.worker().send(
                        OcrWorkerRequest::RecognizePngBytes {
                            page_number: 1,
                            render_dpi: None,
                            source_width_pt: None,
                            source_height_pt: None,
                            options: req.options.clone(),
                        },
                        &png_bytes,
                        Some(cancel_flag),
                    ) {
                        Ok(OcrWorkerResponse::Page(page)) => {
                            let combined = page.text.clone();
                            let lines = page.line_count;
                            let chars = page.char_count;
                            let avg_conf = page.average_confidence;
                            completed_count += 1;
                            total_pages_done += 1;
                            total_lines_done += lines;
                            total_chars_done += chars;
                            out_items.push(OcrBatchItemResult {
                                source_id: src.id.clone(),
                                source_path: None,
                                source_name,
                                kind: "clipboard".to_string(),
                                status: "completed".to_string(),
                                pages: vec![page],
                                combined_text: combined,
                                total_lines: lines,
                                total_chars: chars,
                                average_confidence: avg_conf,
                                elapsed_ms: item_t0.elapsed().as_millis() as u64,
                                error_code: None,
                                error_message: None,
                            });
                        }
                        Err(err) if err.code == "TASK_CANCELLED" => {
                            cancelled = true;
                            break;
                        }
                        Err(err) => {
                            failed_count += 1;
                            out_items.push(OcrBatchItemResult {
                                source_id: src.id.clone(),
                                source_path: None,
                                source_name,
                                kind: "clipboard".to_string(),
                                status: "failed".to_string(),
                                pages: Vec::new(),
                                combined_text: String::new(),
                                total_lines: 0,
                                total_chars: 0,
                                average_confidence: 0.0,
                                elapsed_ms: item_t0.elapsed().as_millis() as u64,
                                error_code: Some(err.code.to_string()),
                                error_message: Some(err.message),
                            });
                        }
                        Ok(_) => {
                            failed_count += 1;
                            out_items.push(OcrBatchItemResult {
                                source_id: src.id.clone(),
                                source_path: None,
                                source_name,
                                kind: "clipboard".to_string(),
                                status: "failed".to_string(),
                                pages: Vec::new(),
                                combined_text: String::new(),
                                total_lines: 0,
                                total_chars: 0,
                                average_confidence: 0.0,
                                elapsed_ms: item_t0.elapsed().as_millis() as u64,
                                error_code: Some("OCR_WORKER_ERROR".to_string()),
                                error_message: Some("Unexpected OCR worker response.".to_string()),
                            });
                        }
                    }
                }
                Err(err) => {
                    failed_count += 1;
                    out_items.push(OcrBatchItemResult {
                        source_id: src.id.clone(),
                        source_path: None,
                        source_name,
                        kind: "clipboard".to_string(),
                        status: "failed".to_string(),
                        pages: Vec::new(),
                        combined_text: String::new(),
                        total_lines: 0,
                        total_chars: 0,
                        average_confidence: 0.0,
                        elapsed_ms: item_t0.elapsed().as_millis() as u64,
                        error_code: Some(err.code.to_string()),
                        error_message: Some(err.message),
                    });
                }
            }
            continue;
        }

        let Some(ref raw_path) = src.path else {
            failed_count += 1;
            out_items.push(OcrBatchItemResult {
                source_id: src.id.clone(),
                source_path: None,
                source_name,
                kind: "image".to_string(),
                status: "failed".to_string(),
                pages: Vec::new(),
                combined_text: String::new(),
                total_lines: 0,
                total_chars: 0,
                average_confidence: 0.0,
                elapsed_ms: 0,
                error_code: Some("INVALID_PARAMETER".to_string()),
                error_message: Some("OCR item is missing both path and assetId.".to_string()),
            });
            continue;
        };

        // Case 2: Multi-page PDF (renders each selected page via isolated --pdf-worker -> --ocr-worker)
        if is_pdf_path(Path::new(raw_path)) {
            let inspection = match pdf_mgr.inspect_document(raw_path) {
                Ok(info) => info,
                Err(err) => {
                    failed_count += 1;
                    out_items.push(OcrBatchItemResult {
                        source_id: src.id.clone(),
                        source_path: Some(raw_path.clone()),
                        source_name,
                        kind: "pdf".to_string(),
                        status: "failed".to_string(),
                        pages: Vec::new(),
                        combined_text: String::new(),
                        total_lines: 0,
                        total_chars: 0,
                        average_confidence: 0.0,
                        elapsed_ms: item_t0.elapsed().as_millis() as u64,
                        error_code: Some(err.code.to_string()),
                        error_message: Some(err.message),
                    });
                    continue;
                }
            };

            let target_pages: Vec<usize> = match src.page_range.as_deref().map(str::trim) {
                Some(expr) if !expr.is_empty() => {
                    match parse_page_range_spec(expr, inspection.page_count) {
                        Ok(parsed) => parsed.pages,
                        Err(err) => {
                            failed_count += 1;
                            out_items.push(OcrBatchItemResult {
                                source_id: src.id.clone(),
                                source_path: Some(inspection.path),
                                source_name,
                                kind: "pdf".to_string(),
                                status: "failed".to_string(),
                                pages: Vec::new(),
                                combined_text: String::new(),
                                total_lines: 0,
                                total_chars: 0,
                                average_confidence: 0.0,
                                elapsed_ms: item_t0.elapsed().as_millis() as u64,
                                error_code: Some(err.code.to_string()),
                                error_message: Some(err.message),
                            });
                            continue;
                        }
                    }
                }
                _ => (1..=inspection.page_count).collect(),
            };

            let mut pdf_pages: Vec<OcrPageResult> = Vec::with_capacity(target_pages.len());
            let mut item_cancelled = false;
            let mut item_err: Option<AppError> = None;

            for (p_idx, &page_num) in target_pages.iter().enumerate() {
                if cancel_flag.load(Ordering::Relaxed) {
                    item_cancelled = true;
                    cancelled = true;
                    break;
                }

                let page_frac = (item_idx as f64
                    + (p_idx as f64) / (target_pages.len().max(1) as f64))
                    / (total_items as f64);
                emit_progress(OcrProgressPayload {
                    task_id: task_id.to_string(),
                    current_item: item_idx + 1,
                    total_items,
                    current_page: p_idx + 1,
                    total_pages: target_pages.len(),
                    label: format!("{} ({}/{})", source_name, page_num, inspection.page_count),
                    percent: (page_frac * 100.0).clamp(0.0, 99.5),
                    state: "running".to_string(),
                });

                let (render_meta, rgba_bytes) =
                    match pdf_mgr.worker().send(PdfWorkerRequest::RenderRgba {
                        path: inspection.path.clone(),
                        page_number: page_num,
                        target_width_px: None,
                        target_dpi: Some(pdf_dpi),
                        extra_rotation_cw: 0,
                        max_side_cap: 4096,
                    }) {
                        Ok((PdfWorkerResponse::Render(meta), bytes)) => (meta, bytes),
                        Ok(_) => {
                            item_err = Some(AppError::new(
                                "PDF_RENDER_FAILED",
                                format!("Unexpected response while rendering PDF page {page_num}."),
                            ));
                            break;
                        }
                        Err(err) => {
                            item_err = Some(err);
                            break;
                        }
                    };

                let page_info = inspection.pages.get(page_num.saturating_sub(1));
                let src_w_pt = page_info.map(|pi| pi.width_pt);
                let src_h_pt = page_info.map(|pi| pi.height_pt);

                match ocr_mgr.worker().send(
                    OcrWorkerRequest::RecognizeRgbaBuffer {
                        width: render_meta.width_px,
                        height: render_meta.height_px,
                        page_number: page_num,
                        render_dpi: Some(pdf_dpi),
                        source_width_pt: src_w_pt,
                        source_height_pt: src_h_pt,
                        options: req.options.clone(),
                    },
                    &rgba_bytes,
                    Some(cancel_flag),
                ) {
                    Ok(OcrWorkerResponse::Page(page)) => {
                        pdf_pages.push(page);
                    }
                    Err(err) if err.code == "TASK_CANCELLED" => {
                        item_cancelled = true;
                        cancelled = true;
                        break;
                    }
                    Err(err) => {
                        item_err = Some(err);
                        break;
                    }
                    Ok(_) => {
                        item_err = Some(AppError::new(
                            "OCR_WORKER_ERROR",
                            format!("Unexpected OCR worker response for PDF page {page_num}."),
                        ));
                        break;
                    }
                }
            }

            let lines_sum: usize = pdf_pages.iter().map(|p| p.line_count).sum();
            let chars_sum: usize = pdf_pages.iter().map(|p| p.char_count).sum();
            let avg_conf = if !pdf_pages.is_empty() {
                let weighted: f32 = pdf_pages
                    .iter()
                    .map(|p| p.average_confidence * (p.line_count as f32))
                    .sum();
                if lines_sum > 0 {
                    ((weighted / lines_sum as f32) * 10000.0).round() / 10000.0
                } else {
                    0.0
                }
            } else {
                0.0
            };
            let combined_text = if pdf_pages.len() <= 1 {
                pdf_pages
                    .first()
                    .map(|p| p.text.clone())
                    .unwrap_or_default()
            } else {
                pdf_pages
                    .iter()
                    .map(|p| format!("--- Page {} ---\n{}", p.page_number, p.text))
                    .collect::<Vec<_>>()
                    .join("\n\n")
            };

            total_pages_done += pdf_pages.len();
            total_lines_done += lines_sum;
            total_chars_done += chars_sum;

            let (status, err_code, err_msg) = if item_cancelled {
                (
                    "cancelled".to_string(),
                    Some("TASK_CANCELLED".to_string()),
                    None,
                )
            } else if let Some(err) = item_err {
                failed_count += 1;
                (
                    "failed".to_string(),
                    Some(err.code.to_string()),
                    Some(err.message),
                )
            } else {
                completed_count += 1;
                ("completed".to_string(), None, None)
            };

            out_items.push(OcrBatchItemResult {
                source_id: src.id.clone(),
                source_path: Some(inspection.path),
                source_name,
                kind: "pdf".to_string(),
                status,
                pages: pdf_pages,
                combined_text,
                total_lines: lines_sum,
                total_chars: chars_sum,
                average_confidence: avg_conf,
                elapsed_ms: item_t0.elapsed().as_millis() as u64,
                error_code: err_code,
                error_message: err_msg,
            });

            if item_cancelled {
                break;
            }
            continue;
        }

        // Case 3: Standalone image file
        emit_progress(OcrProgressPayload {
            task_id: task_id.to_string(),
            current_item: item_idx + 1,
            total_items,
            current_page: 1,
            total_pages: 1,
            label: source_name.clone(),
            percent: ((item_idx as f64) / (total_items as f64)) * 100.0,
            state: "running".to_string(),
        });

        match ocr_mgr.worker().send(
            OcrWorkerRequest::RecognizeImageFile {
                path: raw_path.clone(),
                options: req.options.clone(),
            },
            &[],
            Some(cancel_flag),
        ) {
            Ok(OcrWorkerResponse::Page(page)) => {
                let combined = page.text.clone();
                let lines = page.line_count;
                let chars = page.char_count;
                let avg_conf = page.average_confidence;
                completed_count += 1;
                total_pages_done += 1;
                total_lines_done += lines;
                total_chars_done += chars;
                out_items.push(OcrBatchItemResult {
                    source_id: src.id.clone(),
                    source_path: Some(raw_path.clone()),
                    source_name,
                    kind: "image".to_string(),
                    status: "completed".to_string(),
                    pages: vec![page],
                    combined_text: combined,
                    total_lines: lines,
                    total_chars: chars,
                    average_confidence: avg_conf,
                    elapsed_ms: item_t0.elapsed().as_millis() as u64,
                    error_code: None,
                    error_message: None,
                });
            }
            Err(err) if err.code == "TASK_CANCELLED" => {
                cancelled = true;
                break;
            }
            Err(err) => {
                failed_count += 1;
                out_items.push(OcrBatchItemResult {
                    source_id: src.id.clone(),
                    source_path: Some(raw_path.clone()),
                    source_name,
                    kind: "image".to_string(),
                    status: "failed".to_string(),
                    pages: Vec::new(),
                    combined_text: String::new(),
                    total_lines: 0,
                    total_chars: 0,
                    average_confidence: 0.0,
                    elapsed_ms: item_t0.elapsed().as_millis() as u64,
                    error_code: Some(err.code.to_string()),
                    error_message: Some(err.message),
                });
            }
            Ok(_) => {
                failed_count += 1;
                out_items.push(OcrBatchItemResult {
                    source_id: src.id.clone(),
                    source_path: Some(raw_path.clone()),
                    source_name,
                    kind: "image".to_string(),
                    status: "failed".to_string(),
                    pages: Vec::new(),
                    combined_text: String::new(),
                    total_lines: 0,
                    total_chars: 0,
                    average_confidence: 0.0,
                    elapsed_ms: item_t0.elapsed().as_millis() as u64,
                    error_code: Some("OCR_WORKER_ERROR".to_string()),
                    error_message: Some("Unexpected OCR worker response.".to_string()),
                });
            }
        }
    }

    emit_progress(OcrProgressPayload {
        task_id: task_id.to_string(),
        current_item: out_items.len(),
        total_items,
        current_page: total_pages_done,
        total_pages: total_pages_done,
        label: String::new(),
        percent: 100.0,
        state: if cancelled {
            "cancelled".to_string()
        } else {
            "completed".to_string()
        },
    });

    Ok(OcrBatchResult {
        engine_name: OCR_ENGINE_DISPLAY_NAME.to_string(),
        items: out_items,
        completed_count,
        failed_count,
        cancelled,
        total_pages: total_pages_done,
        total_lines: total_lines_done,
        total_chars: total_chars_done,
        total_elapsed_ms: t_all.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ocr_worker_rejects_missing_and_empty_image_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let empty = dir.path().join("empty.png");
        std::fs::write(&empty, b"").expect("write empty");

        let status = check_ocr_engine_status(None);
        if !status.ready {
            return;
        }
        let mut eng: Option<RapidOcrEngine> = None;

        let r_missing = dispatch_ocr_request(
            &mut eng,
            None,
            OcrWorkerRequest::RecognizeImageFile {
                path: dir
                    .path()
                    .join("missing.png")
                    .to_string_lossy()
                    .into_owned(),
                options: OcrRecognizeOptions::default(),
            },
            &[],
        );
        assert!(
            matches!(r_missing, OcrWorkerResponse::Error { code, .. } if code == "FILE_NOT_FOUND")
        );

        let r_empty = dispatch_ocr_request(
            &mut eng,
            None,
            OcrWorkerRequest::RecognizeImageFile {
                path: empty.to_string_lossy().into_owned(),
                options: OcrRecognizeOptions::default(),
            },
            &[],
        );
        assert!(
            matches!(r_empty, OcrWorkerResponse::Error { code, .. } if code == "IMAGE_DECODE_FAILED")
        );
    }

    #[test]
    fn ocr_batch_honors_pre_cancelled_flag_immediately() {
        let ocr_mgr = OcrSessionManager::default();
        let pdf_mgr = PdfSessionManager::default();
        let assets = ImageAssetStore::default();
        let cancel = Arc::new(AtomicBool::new(true));
        let req = OcrBatchRequest {
            items: vec![OcrSourceInput {
                id: "item-1".to_string(),
                path: Some("nonexistent.png".to_string()),
                asset_id: None,
                name: Some("nonexistent.png".to_string()),
                page_range: None,
            }],
            pdf_dpi: 200.0,
            options: OcrRecognizeOptions::default(),
        };
        let res = ocr_extract_batch_impl(
            "t-cancel",
            &ocr_mgr,
            &pdf_mgr,
            &assets,
            &req,
            &cancel,
            |_| {},
        )
        .expect("cancelled batch should return cleanly");
        assert!(res.cancelled);
        assert_eq!(res.items.len(), 0);
    }

    #[test]
    fn ocr_worker_preserves_pdf_dpi_point_metadata_and_preview_toggle() {
        let status = check_ocr_engine_status(None);
        if !status.ready {
            return;
        }
        let sample = Path::new(
            r"C:\Temp\WinKitDemo\phase6_t03\bench_samples\01_screenshot_bilingual_ui.png",
        );
        if !sample.exists() {
            return;
        }
        let rgba = image::open(sample).expect("open sample").to_rgba8();
        let (w, h) = rgba.dimensions();
        let mut eng: Option<RapidOcrEngine> = None;

        let resp = dispatch_ocr_request(
            &mut eng,
            None,
            OcrWorkerRequest::RecognizeRgbaBuffer {
                width: w,
                height: h,
                page_number: 2,
                render_dpi: Some(200.0),
                source_width_pt: Some(595.28),
                source_height_pt: Some(841.89),
                options: OcrRecognizeOptions {
                    max_side_len: 1280,
                    include_preview: false,
                },
            },
            rgba.as_raw(),
        );

        match resp {
            OcrWorkerResponse::Page(page) => {
                assert_eq!(page.page_number, 2);
                assert_eq!(page.image_width_px, w);
                assert_eq!(page.image_height_px, h);
                assert_eq!(page.render_dpi, Some(200.0));
                assert_eq!(page.source_width_pt, Some(595.28));
                assert_eq!(page.source_height_pt, Some(841.89));
                assert!(page.preview_data_url.is_none());
                assert!(
                    page.line_count >= 10,
                    "expected >=10 lines, got {}",
                    page.line_count
                );
                for line in &page.lines {
                    assert!(!line.spans.is_empty());
                    for pt in &line.quad_norm {
                        assert!((0.0..=1.0).contains(&pt.x) && (0.0..=1.0).contains(&pt.y));
                    }
                    for sp in &line.spans {
                        assert!(sp.bbox_norm.width >= 0.0 && sp.char_start < sp.char_end);
                    }
                }
            }
            other => panic!("expected OcrWorkerResponse::Page, got {other:?}"),
        }
    }
}
