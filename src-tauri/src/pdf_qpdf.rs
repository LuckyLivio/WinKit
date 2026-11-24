//! Bundled Windows x64 QPDF (`qpdf30.dll` v12.4.2, Apache-2.0) FFI and process-isolated worker.
//!
//! Security & reliability invariants:
//! - Strictly resolves `qpdf30.dll` from WinKit's bundled resource/install directory (never `PATH`).
//! - Verifies exact byte length (`7,448,064` B) and SHA-256 digest before calling `LoadLibraryExW`
//!   with `LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS` so app-local
//!   MSVC runtime DLLs load cleanly without altering `PATH`.
//! - Passes all job parameters—including PDF passwords—exclusively through QPDF's in-memory JSON
//!   C API (`qpdfjob_initialize_from_json`) over an anonymous stdin pipe to a one-shot isolated
//!   child process (`winkit.exe --qpdf-worker`). Passwords NEVER appear in command-line arguments,
//!   temporary files, logs, or error messages.
//! - Attaches the one-shot worker to a Windows Job Object (`KILL_ON_JOB_CLOSE`, 1 GiB memory cap,
//!   active process limit = 1) with cancellation and watchdog timeout support.

use crate::error::AppError;
use crate::pdf_worker::should_use_subprocess_worker;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::{c_char, c_int, c_void, CString};
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const QPDF_WORKER_FLAG: &str = "--qpdf-worker";
pub const QPDF_DLL_FILENAME: &str = "qpdf30.dll";
pub const QPDF_VERSION_LABEL: &str = "qpdf 12.4.2";
pub const QPDF_EXPECTED_BYTES: usize = 7_448_064;
pub const QPDF_EXPECTED_SHA256: &str =
    "8812952678de93e0750308a113aa650e9161af466f9770679ea9673adeb61041";

const MAX_JOB_JSON_BYTES: usize = 4 * 1024 * 1024; // 4 MiB ceiling for QPDFJob JSON payloads
pub const DEFAULT_QPDF_TIMEOUT: Duration = Duration::from_secs(120);

pub const QPDF_EXIT_SUCCESS: i32 = 0;
pub const QPDF_EXIT_ERROR: i32 = 2;
pub const QPDF_EXIT_WARNING: i32 = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QpdfJobOutput {
    pub exit_code: i32,
    pub info: String,
    pub warn: String,
    pub error: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum QpdfWorkerLine {
    Progress { percent: u8 },
    Done { output: QpdfJobOutput },
    Fatal { code: String, message: String },
}

fn zeroize_bytes(buf: &mut [u8]) {
    for b in buf.iter_mut() {
        unsafe {
            std::ptr::write_volatile(b, 0);
        }
    }
    std::sync::atomic::compiler_fence(Ordering::SeqCst);
}

/// Resolve bundled `qpdf30.dll` strictly from WinKit's own directories (never `PATH`).
pub fn resolve_qpdf_dll_path(resource_dir: Option<&Path>) -> Result<PathBuf, AppError> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(res) = resource_dir {
        candidates.push(res.join("qpdf").join(QPDF_DLL_FILENAME));
        candidates.push(res.join(QPDF_DLL_FILENAME));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join("qpdf").join(QPDF_DLL_FILENAME));
            candidates.push(
                exe_dir
                    .join("resources")
                    .join("qpdf")
                    .join(QPDF_DLL_FILENAME),
            );
        }
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("qpdf")
            .join(QPDF_DLL_FILENAME),
    );

    for path in &candidates {
        if path.is_file() {
            return Ok(path.clone());
        }
    }

    Err(AppError::new(
        "PDF_QPDF_UNAVAILABLE",
        format!(
            "Bundled {QPDF_DLL_FILENAME} ({QPDF_VERSION_LABEL}) was not found in the application directory."
        ),
    ))
}

fn verify_qpdf_dll(path: &Path) -> Result<(), AppError> {
    let mut file = File::open(path).map_err(|e| {
        AppError::new(
            "PDF_QPDF_UNAVAILABLE",
            format!("Unable to open bundled {QPDF_DLL_FILENAME}: {e}"),
        )
    })?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    let mut total: usize = 0;
    loop {
        let n = file.read(&mut buf).map_err(|e| {
            AppError::new(
                "PDF_QPDF_UNAVAILABLE",
                format!("Failed reading bundled {QPDF_DLL_FILENAME}: {e}"),
            )
        })?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total = total.saturating_add(n);
    }
    let digest = format!("{:x}", hasher.finalize());
    if total != QPDF_EXPECTED_BYTES || digest != QPDF_EXPECTED_SHA256 {
        return Err(AppError::new(
            "PDF_QPDF_INVALID",
            format!(
                "Bundled {QPDF_DLL_FILENAME} failed integrity verification (expected {QPDF_EXPECTED_BYTES} B, got {total} B)."
            ),
        ));
    }
    Ok(())
}

#[cfg(windows)]
mod qpdf_ffi {
    use super::*;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{PCSTR, PCWSTR};
    use windows::Win32::Foundation::HMODULE;
    use windows::Win32::System::LibraryLoader::{
        GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
    };

    const QPDF_LOG_DEST_CUSTOM: c_int = 4;

    type QpdfJobHandle = *mut c_void;
    type QpdfLoggerHandle = *mut c_void;
    type QpdfLogFn = unsafe extern "C" fn(*const c_char, usize, *mut c_void) -> c_int;
    type QpdfProgressFn = unsafe extern "C" fn(c_int, *mut c_void);

    struct QpdfApi {
        _module: HMODULE,
        qpdfjob_init: unsafe extern "C" fn() -> QpdfJobHandle,
        qpdfjob_cleanup: unsafe extern "C" fn(*mut QpdfJobHandle),
        qpdfjob_set_logger: unsafe extern "C" fn(QpdfJobHandle, QpdfLoggerHandle),
        qpdfjob_initialize_from_json: unsafe extern "C" fn(QpdfJobHandle, *const c_char) -> c_int,
        qpdfjob_run: unsafe extern "C" fn(QpdfJobHandle) -> c_int,
        qpdfjob_register_progress_reporter:
            unsafe extern "C" fn(QpdfJobHandle, QpdfProgressFn, *mut c_void),
        qpdflogger_create: unsafe extern "C" fn() -> QpdfLoggerHandle,
        qpdflogger_cleanup: unsafe extern "C" fn(*mut QpdfLoggerHandle),
        qpdflogger_set_info:
            unsafe extern "C" fn(QpdfLoggerHandle, c_int, Option<QpdfLogFn>, *mut c_void),
        qpdflogger_set_warn:
            unsafe extern "C" fn(QpdfLoggerHandle, c_int, Option<QpdfLogFn>, *mut c_void),
        qpdflogger_set_error:
            unsafe extern "C" fn(QpdfLoggerHandle, c_int, Option<QpdfLogFn>, *mut c_void),
    }

    unsafe impl Send for QpdfApi {}

    static QPDF_RUNTIME: OnceLock<Mutex<Option<QpdfApi>>> = OnceLock::new();

    unsafe fn load_sym<T>(module: HMODULE, name: &[u8]) -> Result<T, AppError> {
        let proc = GetProcAddress(module, PCSTR::from_raw(name.as_ptr())).ok_or_else(|| {
            let label = String::from_utf8_lossy(&name[..name.len().saturating_sub(1)]);
            AppError::new(
                "PDF_QPDF_INVALID",
                format!("Required QPDF symbol '{label}' was not found."),
            )
        })?;
        Ok(std::mem::transmute_copy(&proc))
    }

    impl QpdfApi {
        fn load(dll_path: &Path) -> Result<Self, AppError> {
            verify_qpdf_dll(dll_path)?;
            let wide: Vec<u16> = OsStr::new(dll_path)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let flags = LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS;
            let module = unsafe { LoadLibraryExW(PCWSTR::from_raw(wide.as_ptr()), None, flags) }
                .map_err(|e| {
                    AppError::new(
                        "PDF_QPDF_UNAVAILABLE",
                        format!("Failed to load bundled {QPDF_DLL_FILENAME}: {e}"),
                    )
                })?;

            unsafe {
                Ok(Self {
                    _module: module,
                    qpdfjob_init: load_sym(module, b"qpdfjob_init\0")?,
                    qpdfjob_cleanup: load_sym(module, b"qpdfjob_cleanup\0")?,
                    qpdfjob_set_logger: load_sym(module, b"qpdfjob_set_logger\0")?,
                    qpdfjob_initialize_from_json: load_sym(
                        module,
                        b"qpdfjob_initialize_from_json\0",
                    )?,
                    qpdfjob_run: load_sym(module, b"qpdfjob_run\0")?,
                    qpdfjob_register_progress_reporter: load_sym(
                        module,
                        b"qpdfjob_register_progress_reporter\0",
                    )?,
                    qpdflogger_create: load_sym(module, b"qpdflogger_create\0")?,
                    qpdflogger_cleanup: load_sym(module, b"qpdflogger_cleanup\0")?,
                    qpdflogger_set_info: load_sym(module, b"qpdflogger_set_info\0")?,
                    qpdflogger_set_warn: load_sym(module, b"qpdflogger_set_warn\0")?,
                    qpdflogger_set_error: load_sym(module, b"qpdflogger_set_error\0")?,
                })
            }
        }
    }

    unsafe extern "C" fn append_log_cb(
        data: *const c_char,
        len: usize,
        udata: *mut c_void,
    ) -> c_int {
        if data.is_null() || udata.is_null() || len == 0 {
            return 0;
        }
        let target = &mut *(udata as *mut Vec<u8>);
        let slice = std::slice::from_raw_parts(data as *const u8, len);
        // Cap captured log buffers at 1 MiB to guard against noisy malformed PDFs
        let remaining = (1024 * 1024usize).saturating_sub(target.len());
        if remaining > 0 {
            let take = remaining.min(slice.len());
            target.extend_from_slice(&slice[..take]);
        }
        0
    }

    struct ProgressBridge<'a> {
        cb: &'a dyn Fn(u8),
        last_sent: u8,
    }

    unsafe extern "C" fn progress_trampoline(percent: c_int, udata: *mut c_void) {
        if udata.is_null() {
            return;
        }
        let bridge = &mut *(udata as *mut ProgressBridge<'_>);
        let clamped = percent.clamp(0, 100) as u8;
        if clamped != bridge.last_sent {
            bridge.last_sent = clamped;
            (bridge.cb)(clamped);
        }
    }

    pub fn execute_qpdf_job_in_process(
        resource_dir: Option<&Path>,
        job_json: &str,
        on_progress: Option<&dyn Fn(u8)>,
    ) -> Result<QpdfJobOutput, AppError> {
        let mutex = QPDF_RUNTIME.get_or_init(|| Mutex::new(None));
        let mut guard = mutex
            .lock()
            .map_err(|_| AppError::new("PDF_QPDF_UNAVAILABLE", "QPDF runtime lock poisoned."))?;
        if guard.is_none() {
            let dll_path = resolve_qpdf_dll_path(resource_dir)?;
            *guard = Some(QpdfApi::load(&dll_path)?);
        }
        let api = guard.as_ref().expect("initialized QpdfApi");

        let c_json = CString::new(job_json.as_bytes()).map_err(|_| {
            AppError::invalid_param("PDF security parameter contains an invalid NUL character.")
        })?;

        let mut info_buf: Vec<u8> = Vec::new();
        let mut warn_buf: Vec<u8> = Vec::new();
        let mut err_buf: Vec<u8> = Vec::new();
        let mut progress_bridge = on_progress.map(|cb| ProgressBridge { cb, last_sent: 255 });

        let exit_code = unsafe {
            let mut logger = (api.qpdflogger_create)();
            let mut job = (api.qpdfjob_init)();
            if logger.is_null() || job.is_null() {
                if !job.is_null() {
                    (api.qpdfjob_cleanup)(&mut job);
                }
                if !logger.is_null() {
                    (api.qpdflogger_cleanup)(&mut logger);
                }
                return Err(AppError::new(
                    "PDF_QPDF_UNAVAILABLE",
                    "Unable to initialize QPDF job handle.",
                ));
            }

            (api.qpdflogger_set_info)(
                logger,
                QPDF_LOG_DEST_CUSTOM,
                Some(append_log_cb),
                (&mut info_buf as *mut Vec<u8>) as *mut c_void,
            );
            (api.qpdflogger_set_warn)(
                logger,
                QPDF_LOG_DEST_CUSTOM,
                Some(append_log_cb),
                (&mut warn_buf as *mut Vec<u8>) as *mut c_void,
            );
            (api.qpdflogger_set_error)(
                logger,
                QPDF_LOG_DEST_CUSTOM,
                Some(append_log_cb),
                (&mut err_buf as *mut Vec<u8>) as *mut c_void,
            );
            (api.qpdfjob_set_logger)(job, logger);

            if let Some(ref mut bridge) = progress_bridge {
                (api.qpdfjob_register_progress_reporter)(
                    job,
                    progress_trampoline,
                    (bridge as *mut ProgressBridge<'_>) as *mut c_void,
                );
            }

            let mut rc = (api.qpdfjob_initialize_from_json)(job, c_json.as_ptr());
            if rc == QPDF_EXIT_SUCCESS {
                rc = (api.qpdfjob_run)(job);
            }

            (api.qpdfjob_cleanup)(&mut job);
            (api.qpdflogger_cleanup)(&mut logger);
            rc
        };

        // Wipe the serialized JSON (which may contain user/owner passwords) from memory.
        let mut c_bytes = c_json.into_bytes_with_nul();
        zeroize_bytes(&mut c_bytes);

        Ok(QpdfJobOutput {
            exit_code,
            info: String::from_utf8_lossy(&info_buf).into_owned(),
            warn: String::from_utf8_lossy(&warn_buf).into_owned(),
            error: String::from_utf8_lossy(&err_buf).into_owned(),
        })
    }
}

#[cfg(not(windows))]
mod qpdf_ffi {
    use super::*;

    pub fn execute_qpdf_job_in_process(
        _resource_dir: Option<&Path>,
        _job_json: &str,
        _on_progress: Option<&dyn Fn(u8)>,
    ) -> Result<QpdfJobOutput, AppError> {
        Err(AppError::new(
            "PDF_QPDF_UNAVAILABLE",
            "Bundled QPDF runtime is supported on Windows x64 only.",
        ))
    }
}

pub use qpdf_ffi::execute_qpdf_job_in_process;

fn execute_qpdf_job_with_retry(
    resource_dir: Option<&Path>,
    job_json: &str,
    on_progress: Option<&dyn Fn(u8)>,
) -> Result<QpdfJobOutput, AppError> {
    let mut attempt = 0u32;
    loop {
        let res = execute_qpdf_job_in_process(resource_dir, job_json, on_progress);
        let transient_lock = match &res {
            Ok(out) if out.exit_code == QPDF_EXIT_ERROR => {
                let lower = out.error.to_ascii_lowercase();
                lower.contains("permission denied")
                    || lower.contains("access is denied")
                    || lower.contains("sharing violation")
            }
            _ => false,
        };
        if transient_lock && attempt < 5 {
            attempt += 1;
            std::thread::sleep(Duration::from_millis(50 * attempt as u64));
            continue;
        }
        return res;
    }
}

/// Entrypoint executed when `winkit.exe` is started with `--qpdf-worker`.
///
/// Reads a single length-prefixed UTF-8 QPDFJob JSON payload from stdin, runs `qpdf30.dll` via
/// its in-memory JSON C API, emits progress/result JSON lines on stdout, zeroes the input buffer,
/// and exits.
pub fn run_qpdf_worker_stdio(resource_dir: Option<&Path>) -> i32 {
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let mut len_buf = [0u8; 4];
    if reader.read_exact(&mut len_buf).is_err() {
        return 1;
    }
    let payload_len = u32::from_le_bytes(len_buf) as usize;
    if payload_len == 0 || payload_len > MAX_JOB_JSON_BYTES {
        let _ = write_worker_line(&QpdfWorkerLine::Fatal {
            code: "INVALID_PARAMETER".to_string(),
            message: "Invalid QPDF worker payload size.".to_string(),
        });
        return 1;
    }
    let mut payload = vec![0u8; payload_len];
    if reader.read_exact(&mut payload).is_err() {
        zeroize_bytes(&mut payload);
        return 1;
    }

    let result = match std::str::from_utf8(&payload) {
        Ok(json_str) => {
            let progress_emitter = |pct: u8| {
                let _ = write_worker_line(&QpdfWorkerLine::Progress { percent: pct });
            };
            execute_qpdf_job_with_retry(resource_dir, json_str, Some(&progress_emitter))
        }
        Err(_) => Err(AppError::invalid_param(
            "QPDF worker payload was not valid UTF-8.",
        )),
    };

    zeroize_bytes(&mut payload);

    match result {
        Ok(output) => {
            let _ = write_worker_line(&QpdfWorkerLine::Done { output });
            0
        }
        Err(err) => {
            let _ = write_worker_line(&QpdfWorkerLine::Fatal {
                code: err.code.to_string(),
                message: err.message,
            });
            0
        }
    }
}

fn write_worker_line(line: &QpdfWorkerLine) -> io::Result<()> {
    let stdout = io::stdout();
    let mut guard = stdout.lock();
    let text = serde_json::to_string(line)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
    guard.write_all(text.as_bytes())?;
    guard.write_all(b"\n")?;
    guard.flush()
}

fn map_qpdf_fatal_code(code: &str, message: String) -> AppError {
    let static_code: &'static str = match code {
        "PDF_QPDF_UNAVAILABLE" => "PDF_QPDF_UNAVAILABLE",
        "PDF_QPDF_INVALID" => "PDF_QPDF_INVALID",
        "INVALID_PARAMETER" => "INVALID_PARAMETER",
        "FILE_NOT_FOUND" => "FILE_NOT_FOUND",
        "PERMISSION_DENIED" => "PERMISSION_DENIED",
        "DISK_FULL" => "DISK_FULL",
        "TASK_CANCELLED" => "TASK_CANCELLED",
        _ => "PDF_WORKER_ERROR",
    };
    AppError::new(static_code, message)
}

/// Execute a QPDFJob JSON object either in a one-shot isolated `winkit.exe --qpdf-worker` child
/// process (production desktop binary) or directly in-process during `cargo test`.
pub fn run_qpdf_job(
    resource_dir: Option<&Path>,
    job: &serde_json::Value,
    cancel: Option<&AtomicBool>,
    timeout: Duration,
    on_progress: Option<&dyn Fn(u8)>,
) -> Result<QpdfJobOutput, AppError> {
    if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
        return Err(AppError::cancelled());
    }

    let mut json_bytes = serde_json::to_vec(job)
        .map_err(|e| AppError::invalid_param(format!("Failed to serialize QPDF job: {e}")))?;
    if json_bytes.len() > MAX_JOB_JSON_BYTES {
        zeroize_bytes(&mut json_bytes);
        return Err(AppError::size_limit("QPDF job payload exceeds limit."));
    }

    if !should_use_subprocess_worker() {
        let res = match std::str::from_utf8(&json_bytes) {
            Ok(s) => execute_qpdf_job_with_retry(resource_dir, s, on_progress),
            Err(_) => Err(AppError::invalid_param(
                "QPDF job JSON was not valid UTF-8.",
            )),
        };
        zeroize_bytes(&mut json_bytes);
        if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
            return Err(AppError::cancelled());
        }
        return res;
    }

    run_qpdf_in_isolated_child(resource_dir, &mut json_bytes, cancel, timeout, on_progress)
}

fn run_qpdf_in_isolated_child(
    resource_dir: Option<&Path>,
    json_bytes: &mut [u8],
    cancel: Option<&AtomicBool>,
    timeout: Duration,
    on_progress: Option<&dyn Fn(u8)>,
) -> Result<QpdfJobOutput, AppError> {
    let exe = std::env::current_exe().map_err(|e| {
        zeroize_bytes(json_bytes);
        AppError::new(
            "PDF_WORKER_ERROR",
            format!("Unable to resolve executable path for QPDF worker: {e}"),
        )
    })?;

    let mut cmd = Command::new(exe);
    cmd.arg(QPDF_WORKER_FLAG);
    if let Some(dir) = resource_dir {
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
        zeroize_bytes(json_bytes);
        AppError::new(
            "PDF_WORKER_ERROR",
            format!("Unable to start isolated QPDF worker process: {e}"),
        )
    })?;

    #[cfg(windows)]
    let job_guard = crate::pdf_worker::job_guard::WindowsJobGuard::attach(&child);

    // Send length-prefixed JSON payload over stdin pipe, close stdin immediately, and zero memory.
    let write_result = (|| -> io::Result<()> {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("Missing QPDF worker stdin"))?;
        let len_u32 = u32::try_from(json_bytes.len())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Payload too large"))?;
        stdin.write_all(&len_u32.to_le_bytes())?;
        stdin.write_all(json_bytes)?;
        stdin.flush()?;
        drop(stdin);
        Ok(())
    })();
    zeroize_bytes(json_bytes);

    if let Err(err) = write_result {
        let _ = child.kill();
        let _ = child.wait();
        return Err(AppError::new(
            "PDF_WORKER_ERROR",
            format!("Failed sending job to isolated QPDF worker: {err}"),
        ));
    }

    let stdout = child.stdout.take().ok_or_else(|| {
        let _ = child.kill();
        let _ = child.wait();
        AppError::new("PDF_WORKER_ERROR", "Missing QPDF worker stdout pipe.")
    })?;

    let done_pair = Arc::new((Mutex::new(false), Condvar::new()));
    let timed_out = Arc::new(AtomicBool::new(false));
    let cancelled_flag = Arc::new(AtomicBool::new(false));
    let external_cancel = cancel.map(|c| {
        // Poll the caller's cancellation flag from the main loop / watchdog without requiring 'static
        c.load(Ordering::Relaxed)
    });
    let _ = external_cancel;

    // Watchdog thread terminates the Job Object on timeout.
    #[cfg(windows)]
    let watchdog = job_guard.as_ref().map(|guard| {
        let killer = guard.killer();
        let pair = Arc::clone(&done_pair);
        let timed_out_flag = Arc::clone(&timed_out);
        std::thread::spawn(move || {
            let (lock, cvar) = &*pair;
            let Ok(mut done) = lock.lock() else {
                return;
            };
            let deadline = Instant::now() + timeout;
            while !*done {
                let now = Instant::now();
                if now >= deadline {
                    timed_out_flag.store(true, Ordering::SeqCst);
                    killer.terminate_now();
                    return;
                }
                let wait = (deadline - now).min(Duration::from_millis(200));
                let Ok((next, _)) = cvar.wait_timeout(done, wait) else {
                    return;
                };
                done = next;
            }
        })
    });

    // Read stdout lines while checking caller's cancellation token cleanly.
    let mut reader = BufReader::new(stdout);
    let mut line_buf = String::new();
    let mut final_result: Option<Result<QpdfJobOutput, AppError>> = None;

    loop {
        if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
            cancelled_flag.store(true, Ordering::SeqCst);
            #[cfg(windows)]
            if let Some(ref g) = job_guard {
                g.killer().terminate_now();
            }
            let _ = child.kill();
            break;
        }
        line_buf.clear();
        match reader.read_line(&mut line_buf) {
            Ok(0) => break,
            Ok(_) => {
                let trimmed = line_buf.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(msg) = serde_json::from_str::<QpdfWorkerLine>(trimmed) {
                    match msg {
                        QpdfWorkerLine::Progress { percent } => {
                            if let Some(cb) = on_progress {
                                cb(percent);
                            }
                        }
                        QpdfWorkerLine::Done { output } => {
                            final_result = Some(Ok(output));
                            break;
                        }
                        QpdfWorkerLine::Fatal { code, message } => {
                            final_result = Some(Err(map_qpdf_fatal_code(&code, message)));
                            break;
                        }
                    }
                }
            }
            Err(_) => break,
        }
    }

    // Signal watchdog to stop
    {
        let (lock, cvar) = &*done_pair;
        if let Ok(mut done) = lock.lock() {
            *done = true;
            cvar.notify_all();
        }
    }
    #[cfg(windows)]
    if let Some(handle) = watchdog {
        let _ = handle.join();
    }

    let _ = child.wait();

    if cancelled_flag.load(Ordering::SeqCst) || cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
        return Err(AppError::cancelled());
    }
    if timed_out.load(Ordering::SeqCst) {
        return Err(AppError::new(
            "PDF_WORKER_TIMEOUT",
            "PDF encryption/decryption timed out and the isolated worker was terminated.",
        ));
    }

    final_result.unwrap_or_else(|| {
        Err(AppError::new(
            "PDF_WORKER_CRASHED",
            "The isolated QPDF worker exited unexpectedly while processing this PDF.",
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_qpdf_dll_verifies_and_loads() {
        let dll = resolve_qpdf_dll_path(None).expect("bundled qpdf30.dll should exist");
        verify_qpdf_dll(&dll).expect("bundled qpdf30.dll checksum should match");
    }
}
