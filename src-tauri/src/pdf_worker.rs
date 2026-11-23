//! Process-isolated PDFium worker (`winkit.exe --pdf-worker`) with Windows Job Object lifecycle.
//!
//! Why process isolation:
//! - Untrusted or malformed PDFs are parsed and rasterized by native C++ PDFium inside a dedicated
//!   child process rather than the main WinKit GUI process.
//! - The child process is immediately attached to a Windows Job Object configured with
//!   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. If the worker hangs, times out, crashes, or WinKit exits,
//!   closing/terminating the Job Object kills the worker immediately and releases all open PDF file handles.
//! - During unit tests (`cargo test`), when `current_exe()` is the test runner rather than `winkit.exe`,
//!   requests transparently execute via the exact same `dispatch_worker_request` handler in-process.

use crate::error::AppError;
use crate::pdf_pdfium::{
    extract_page_text_with_pdfium, inspect_with_pdfium, render_page_png_with_pdfium,
    render_page_rgba_with_pdfium, search_document_with_pdfium, PdfPageTextPayload, PdfRenderMeta,
    PdfSearchResult, PdfiumInspectResult,
};
use serde::{Deserialize, Serialize};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;

pub const PDF_WORKER_FLAG: &str = "--pdf-worker";
const MAX_FRAME_BYTES: usize = 128 * 1024 * 1024; // 128 MiB cap (supports 8K RGBA/PNG frame)

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum PdfWorkerRequest {
    Ping,
    Inspect {
        path: String,
    },
    RenderPng {
        path: String,
        page_number: usize,
        target_width_px: Option<u32>,
        target_dpi: Option<f32>,
        extra_rotation_cw: u16,
        max_side_cap: u32,
    },
    RenderRgba {
        path: String,
        page_number: usize,
        target_width_px: Option<u32>,
        target_dpi: Option<f32>,
        extra_rotation_cw: u16,
        max_side_cap: u32,
    },
    ExtractText {
        path: String,
        page_number: usize,
    },
    Search {
        path: String,
        query: String,
        case_sensitive: bool,
    },
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PdfWorkerResponse {
    Pong,
    Inspect(PdfiumInspectResult),
    Render(PdfRenderMeta),
    ExtractText(PdfPageTextPayload),
    Search(PdfSearchResult),
    Error { code: String, message: String },
    Bye,
}

fn write_framed_message<W: Write>(
    writer: &mut W,
    header_json: &[u8],
    payload: &[u8],
) -> io::Result<()> {
    let header_len = u32::try_from(header_json.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Header frame too large"))?;
    let payload_len = u32::try_from(payload.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Payload frame too large"))?;
    writer.write_all(&header_len.to_le_bytes())?;
    writer.write_all(&payload_len.to_le_bytes())?;
    writer.write_all(header_json)?;
    if !payload.is_empty() {
        writer.write_all(payload)?;
    }
    writer.flush()
}

fn read_framed_message<R: Read>(reader: &mut R) -> io::Result<Option<(Vec<u8>, Vec<u8>)>> {
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
            "Invalid PDF worker IPC frame size",
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

fn error_response(err: AppError) -> (PdfWorkerResponse, Vec<u8>) {
    (
        PdfWorkerResponse::Error {
            code: err.code.to_string(),
            message: err.message,
        },
        Vec::new(),
    )
}

pub fn dispatch_worker_request(
    resource_dir: Option<&Path>,
    req: PdfWorkerRequest,
) -> (PdfWorkerResponse, Vec<u8>) {
    match req {
        PdfWorkerRequest::Ping => (PdfWorkerResponse::Pong, Vec::new()),
        PdfWorkerRequest::Shutdown => (PdfWorkerResponse::Bye, Vec::new()),
        PdfWorkerRequest::Inspect { path } => {
            match inspect_with_pdfium(resource_dir, Path::new(&path)) {
                Ok(info) => (PdfWorkerResponse::Inspect(info), Vec::new()),
                Err(err) => error_response(err),
            }
        }
        PdfWorkerRequest::RenderPng {
            path,
            page_number,
            target_width_px,
            target_dpi,
            extra_rotation_cw,
            max_side_cap,
        } => match render_page_png_with_pdfium(
            resource_dir,
            Path::new(&path),
            page_number,
            target_width_px,
            target_dpi,
            extra_rotation_cw,
            max_side_cap,
        ) {
            Ok((meta, png)) => (PdfWorkerResponse::Render(meta), png),
            Err(err) => error_response(err),
        },
        PdfWorkerRequest::RenderRgba {
            path,
            page_number,
            target_width_px,
            target_dpi,
            extra_rotation_cw,
            max_side_cap,
        } => match render_page_rgba_with_pdfium(
            resource_dir,
            Path::new(&path),
            page_number,
            target_width_px,
            target_dpi,
            extra_rotation_cw,
            max_side_cap,
        ) {
            Ok((meta, rgba)) => (PdfWorkerResponse::Render(meta), rgba),
            Err(err) => error_response(err),
        },
        PdfWorkerRequest::ExtractText { path, page_number } => {
            match extract_page_text_with_pdfium(resource_dir, Path::new(&path), page_number) {
                Ok(text) => (PdfWorkerResponse::ExtractText(text), Vec::new()),
                Err(err) => error_response(err),
            }
        }
        PdfWorkerRequest::Search {
            path,
            query,
            case_sensitive,
        } => match search_document_with_pdfium(
            resource_dir,
            Path::new(&path),
            &query,
            case_sensitive,
        ) {
            Ok(res) => (PdfWorkerResponse::Search(res), Vec::new()),
            Err(err) => error_response(err),
        },
    }
}

/// Entrypoint executed when `winkit.exe` is started with `--pdf-worker`.
pub fn run_pdf_worker_stdio_loop(resource_dir: Option<&Path>) -> i32 {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());

    loop {
        let frame = match read_framed_message(&mut reader) {
            Ok(Some(pair)) => pair,
            Ok(None) => return 0,
            Err(_) => return 1,
        };
        let req: PdfWorkerRequest = match serde_json::from_slice(&frame.0) {
            Ok(r) => r,
            Err(e) => {
                let (resp, payload) = error_response(AppError::invalid_param(format!(
                    "Malformed PDF worker request: {e}"
                )));
                if let Ok(json) = serde_json::to_vec(&resp) {
                    let _ = write_framed_message(&mut writer, &json, &payload);
                }
                continue;
            }
        };
        let is_shutdown = matches!(req, PdfWorkerRequest::Shutdown);
        let (resp, payload) = dispatch_worker_request(resource_dir, req);
        let Ok(json) = serde_json::to_vec(&resp) else {
            return 2;
        };
        if write_framed_message(&mut writer, &json, &payload).is_err() {
            return 0;
        }
        if is_shutdown {
            return 0;
        }
    }
}

#[cfg(windows)]
mod job_guard {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct WindowsJobGuard {
        handle: HANDLE,
    }

    unsafe impl Send for WindowsJobGuard {}

    impl WindowsJobGuard {
        pub fn attach(child: &Child) -> Option<Self> {
            unsafe {
                let job = CreateJobObjectW(None, None).ok()?;
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION) as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
                .is_err()
                {
                    let _ = CloseHandle(job);
                    return None;
                }
                let proc_handle = HANDLE(child.as_raw_handle());
                if AssignProcessToJobObject(job, proc_handle).is_err() {
                    let _ = CloseHandle(job);
                    return None;
                }
                Some(Self { handle: job })
            }
        }

        pub fn terminate(&mut self) {
            if !self.handle.is_invalid() {
                unsafe {
                    let _ = TerminateJobObject(self.handle, 1);
                    let _ = CloseHandle(self.handle);
                }
                self.handle = HANDLE::default();
            }
        }
    }

    impl Drop for WindowsJobGuard {
        fn drop(&mut self) {
            self.terminate();
        }
    }
}

struct LiveWorkerProc {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    #[cfg(windows)]
    job: Option<job_guard::WindowsJobGuard>,
}

impl LiveWorkerProc {
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

pub struct PdfWorkerClient {
    resource_dir: Mutex<Option<PathBuf>>,
    proc_state: Mutex<Option<LiveWorkerProc>>,
}

impl Default for PdfWorkerClient {
    fn default() -> Self {
        Self {
            resource_dir: Mutex::new(None),
            proc_state: Mutex::new(None),
        }
    }
}

impl Drop for PdfWorkerClient {
    fn drop(&mut self) {
        self.shutdown_worker();
    }
}

fn should_use_subprocess_worker() -> bool {
    if cfg!(test) {
        return false;
    }
    if std::env::var_os("WINKIT_PDF_INPROCESS").is_some() {
        return false;
    }
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let name = exe
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    name == "winkit.exe" || name == "winkit"
}

fn map_worker_error(code: String, message: String) -> AppError {
    let static_code: &'static str = match code.as_str() {
        "PDF_PASSWORD_REQUIRED" => "PDF_PASSWORD_REQUIRED",
        "PDF_UNSUPPORTED_SECURITY" => "PDF_UNSUPPORTED_SECURITY",
        "PDF_CORRUPT_OR_INVALID" => "PDF_CORRUPT_OR_INVALID",
        "PDF_PAGE_ERROR" => "PDF_PAGE_ERROR",
        "PDF_RENDER_FAILED" => "PDF_RENDER_FAILED",
        "PDF_ENGINE_MISSING" => "PDF_ENGINE_MISSING",
        "PDF_ENGINE_INVALID" => "PDF_ENGINE_INVALID",
        "PDF_ENGINE_LOAD_FAILED" => "PDF_ENGINE_LOAD_FAILED",
        "FILE_NOT_FOUND" => "FILE_NOT_FOUND",
        "IS_DIRECTORY" => "IS_DIRECTORY",
        "PERMISSION_DENIED" => "PERMISSION_DENIED",
        "FILE_LOCKED" => "FILE_LOCKED",
        "SIZE_LIMIT_EXCEEDED" => "SIZE_LIMIT_EXCEEDED",
        "INVALID_PARAMETER" => "INVALID_PARAMETER",
        "TASK_CANCELLED" => "TASK_CANCELLED",
        _ => "PDF_WORKER_ERROR",
    };
    AppError::new(static_code, message)
}

impl PdfWorkerClient {
    pub fn set_resource_dir(&self, dir: PathBuf) {
        if let Ok(mut guard) = self.resource_dir.lock() {
            *guard = Some(dir);
        }
    }

    pub fn resource_dir(&self) -> Option<PathBuf> {
        self.resource_dir.lock().ok().and_then(|g| g.clone())
    }

    fn spawn_worker(&self) -> Result<LiveWorkerProc, AppError> {
        let exe = std::env::current_exe().map_err(|e| {
            AppError::new(
                "PDF_WORKER_ERROR",
                format!("Unable to resolve current executable for PDF worker: {e}"),
            )
        })?;
        let mut cmd = Command::new(exe);
        cmd.arg(PDF_WORKER_FLAG);
        if let Some(dir) = self.resource_dir() {
            cmd.arg("--pdf-resource-dir").arg(dir);
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
                "PDF_WORKER_ERROR",
                format!("Failed to start isolated PDF worker process: {e}"),
            )
        })?;

        #[cfg(windows)]
        let job = job_guard::WindowsJobGuard::attach(&child);

        let stdin = child.stdin.take().ok_or_else(|| {
            let _ = child.kill();
            let _ = child.wait();
            AppError::new("PDF_WORKER_ERROR", "PDF worker stdin pipe unavailable.")
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            let _ = child.kill();
            let _ = child.wait();
            AppError::new("PDF_WORKER_ERROR", "PDF worker stdout pipe unavailable.")
        })?;

        Ok(LiveWorkerProc {
            child,
            stdin: BufWriter::new(stdin),
            stdout: BufReader::new(stdout),
            #[cfg(windows)]
            job,
        })
    }

    pub fn send(&self, req: PdfWorkerRequest) -> Result<(PdfWorkerResponse, Vec<u8>), AppError> {
        if !should_use_subprocess_worker() {
            let res_dir = self.resource_dir();
            let (resp, payload) = dispatch_worker_request(res_dir.as_deref(), req);
            return match resp {
                PdfWorkerResponse::Error { code, message } => Err(map_worker_error(code, message)),
                other => Ok((other, payload)),
            };
        }

        let req_json = serde_json::to_vec(&req).map_err(|e| {
            AppError::new(
                "PDF_WORKER_ERROR",
                format!("Failed to serialize PDF worker request: {e}"),
            )
        })?;

        let mut guard = self
            .proc_state
            .lock()
            .map_err(|_| AppError::new("PDF_WORKER_ERROR", "PDF worker client lock poisoned."))?;

        // Attempt once, and if the existing idle worker died unexpectedly, respawn once cleanly.
        for attempt in 0..2 {
            if guard.is_none() {
                *guard = Some(self.spawn_worker()?);
            }
            let proc = guard.as_mut().expect("worker spawned");
            let write_res = write_framed_message(&mut proc.stdin, &req_json, &[]);
            let read_res = match write_res {
                Ok(()) => read_framed_message(&mut proc.stdout),
                Err(err) => Err(err),
            };

            match read_res {
                Ok(Some((hdr, payload))) => {
                    let resp: PdfWorkerResponse = serde_json::from_slice(&hdr).map_err(|e| {
                        AppError::new(
                            "PDF_WORKER_ERROR",
                            format!("Invalid response from isolated PDF worker: {e}"),
                        )
                    })?;
                    return match resp {
                        PdfWorkerResponse::Error { code, message } => {
                            Err(map_worker_error(code, message))
                        }
                        other => Ok((other, payload)),
                    };
                }
                Ok(None) | Err(_) => {
                    if let Some(dead) = guard.take() {
                        dead.kill_and_reap();
                    }
                    if attempt == 1 {
                        return Err(AppError::new(
                            "PDF_WORKER_CRASHED",
                            "The isolated PDF worker stopped unexpectedly while processing this file. The file may be corrupted or malformed.",
                        ));
                    }
                }
            }
        }

        Err(AppError::new(
            "PDF_WORKER_ERROR",
            "PDF worker request did not complete.",
        ))
    }

    pub fn shutdown_worker(&self) {
        if let Ok(mut guard) = self.proc_state.lock() {
            if let Some(mut proc) = guard.take() {
                if let Ok(json) = serde_json::to_vec(&PdfWorkerRequest::Shutdown) {
                    let _ = write_framed_message(&mut proc.stdin, &json, &[]);
                    let _ = read_framed_message(&mut proc.stdout);
                }
                proc.kill_and_reap();
            }
        }
    }
}
