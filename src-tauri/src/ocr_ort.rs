//! Zero-dependency dynamic loader for Microsoft ONNX Runtime (`onnxruntime.dll`) via its
//! append-only C ABI (`OrtGetApiBase()->GetApi(17)`).
//!
//! Why direct dynamic loading instead of pre-release `ort` / `ort-sys`:
//! - Uses only stable crates (no pre-release `rc` dependencies, no C++ build scripts).
//! - Loads the exact SHA-256 verified, Microsoft-signed `onnxruntime.dll` (`1.23.2`, MIT)
//!   bundled alongside WinKit, sharing the same provenance and process-isolation pattern as
//!   `pdfium.dll` and `qpdf30.dll`.
//! - Every native handle (`OrtEnv`, `OrtSessionOptions`, `OrtSession`, `OrtMemoryInfo`,
//!   `OrtValue`, `OrtTensorTypeAndShapeInfo`, `OrtModelMetadata`, `OrtStatus`) is wrapped in
//!   RAII guards for deterministic release.

#![allow(non_snake_case)]

use crate::error::AppError;
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::ptr;

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use windows::core::PCWSTR;
#[cfg(windows)]
use windows::Win32::Foundation::{FreeLibrary, HMODULE};
#[cfg(windows)]
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW, SetDllDirectoryW};

pub const ORT_DLL_NAME: &str = "onnxruntime.dll";
pub const OCR_DET_MODEL_NAME: &str = "ch_PP-OCRv4_det_mobile.onnx";
pub const OCR_CLS_MODEL_NAME: &str = "ch_ppocr_mobile_v2.0_cls_mobile.onnx";
pub const OCR_REC_MODEL_NAME: &str = "ch_PP-OCRv4_rec_mobile.onnx";
pub const OCR_ENGINE_DISPLAY_NAME: &str = "RapidOCR PP-OCRv4 mobile (ONNX Runtime 1.23.2 CPU)";

const ORT_API_VERSION: u32 = 17;
const ORT_LOGGING_LEVEL_ERROR: c_int = 3;
const GRAPH_OPTIMIZATION_ENABLE_ALL: c_int = 99;
const ORT_ARENA_ALLOCATOR: c_int = 1;
const ORT_MEM_TYPE_DEFAULT: c_int = 0;
const ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT: c_int = 1;
const ONNX_TENSOR_ELEMENT_DATA_TYPE_INT32: c_int = 6;
const ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64: c_int = 7;

/// Typed CPU tensor input for multi-input ONNX Runtime inference (`Silero VAD v5`, `SenseVoiceSmall`).
pub enum OrtInput<'a> {
    F32(&'a [i64], &'a [f32]),
    I32(&'a [i64], &'a [i32]),
    I64(&'a [i64], &'a [i64]),
}

// Verified append-only OrtApi vtable indices (stable since ONNX Runtime 1.1..1.23+).
const IDX_GET_ERROR_MESSAGE: usize = 2;
const IDX_CREATE_ENV: usize = 3;
const IDX_CREATE_SESSION: usize = 7;
const IDX_RUN: usize = 9;
const IDX_CREATE_SESSION_OPTIONS: usize = 10;
const IDX_DISABLE_MEM_PATTERN: usize = 17;
const IDX_DISABLE_CPU_MEM_ARENA: usize = 19;
const IDX_SET_GRAPH_OPT_LEVEL: usize = 23;
const IDX_SET_INTRA_OP_THREADS: usize = 24;
const IDX_SET_INTER_OP_THREADS: usize = 25;
const IDX_SESSION_GET_INPUT_NAME: usize = 36;
const IDX_SESSION_GET_OUTPUT_NAME: usize = 37;
const IDX_CREATE_TENSOR_WITH_DATA: usize = 49;
const IDX_GET_TENSOR_MUTABLE_DATA: usize = 51;
const IDX_GET_DIMENSIONS_COUNT: usize = 61;
const IDX_GET_DIMENSIONS: usize = 62;
const IDX_GET_TENSOR_TYPE_AND_SHAPE: usize = 65;
const IDX_CREATE_CPU_MEMORY_INFO: usize = 69;
const IDX_ALLOCATOR_FREE: usize = 76;
const IDX_GET_ALLOCATOR_DEFAULT: usize = 78;
const IDX_RELEASE_ENV: usize = 92;
const IDX_RELEASE_STATUS: usize = 93;
const IDX_RELEASE_MEMORY_INFO: usize = 94;
const IDX_RELEASE_SESSION: usize = 95;
const IDX_RELEASE_VALUE: usize = 96;
const IDX_RELEASE_TENSOR_SHAPE_INFO: usize = 99;
const IDX_RELEASE_SESSION_OPTIONS: usize = 100;
const IDX_SESSION_GET_MODEL_METADATA: usize = 111;
const IDX_MODEL_METADATA_LOOKUP_CUSTOM: usize = 116;
const IDX_RELEASE_MODEL_METADATA: usize = 118;

#[repr(C)]
struct OrtApiBase {
    get_api: unsafe extern "system" fn(version: u32) -> *const *const c_void,
    get_version_string: unsafe extern "system" fn() -> *const c_char,
}

type OrtGetApiBaseFn = unsafe extern "system" fn() -> *const OrtApiBase;

type GetErrorMessageFn = unsafe extern "system" fn(status: *const c_void) -> *const c_char;
type CreateEnvFn = unsafe extern "system" fn(
    log_level: c_int,
    logid: *const c_char,
    out: *mut *mut c_void,
) -> *mut c_void;
#[cfg(windows)]
type CreateSessionFn = unsafe extern "system" fn(
    env: *const c_void,
    model_path: *const u16,
    options: *const c_void,
    out: *mut *mut c_void,
) -> *mut c_void;
#[cfg(not(windows))]
type CreateSessionFn = unsafe extern "system" fn(
    env: *const c_void,
    model_path: *const c_char,
    options: *const c_void,
    out: *mut *mut c_void,
) -> *mut c_void;
type RunFn = unsafe extern "system" fn(
    session: *mut c_void,
    run_options: *const c_void,
    input_names: *const *const c_char,
    inputs: *const *const c_void,
    input_len: usize,
    output_names: *const *const c_char,
    output_names_len: usize,
    outputs: *mut *mut c_void,
) -> *mut c_void;
type CreateSessionOptionsFn = unsafe extern "system" fn(out: *mut *mut c_void) -> *mut c_void;
type ToggleSessionOptionFn = unsafe extern "system" fn(options: *mut c_void) -> *mut c_void;
type SetGraphOptLevelFn =
    unsafe extern "system" fn(options: *mut c_void, level: c_int) -> *mut c_void;
type SetThreadsFn = unsafe extern "system" fn(options: *mut c_void, threads: c_int) -> *mut c_void;
type SessionGetNameFn = unsafe extern "system" fn(
    session: *const c_void,
    index: usize,
    allocator: *mut c_void,
    value: *mut *mut c_char,
) -> *mut c_void;
type CreateTensorWithDataFn = unsafe extern "system" fn(
    info: *const c_void,
    p_data: *mut c_void,
    p_data_len: usize,
    shape: *const i64,
    shape_len: usize,
    elem_type: c_int,
    out: *mut *mut c_void,
) -> *mut c_void;
type GetTensorMutableDataFn =
    unsafe extern "system" fn(value: *mut c_void, out: *mut *mut c_void) -> *mut c_void;
type GetDimensionsCountFn =
    unsafe extern "system" fn(info: *const c_void, out: *mut usize) -> *mut c_void;
type GetDimensionsFn = unsafe extern "system" fn(
    info: *const c_void,
    dim_values: *mut i64,
    dim_values_len: usize,
) -> *mut c_void;
type GetTensorTypeAndShapeFn =
    unsafe extern "system" fn(value: *const c_void, out: *mut *mut c_void) -> *mut c_void;
type CreateCpuMemoryInfoFn = unsafe extern "system" fn(
    alloc_type: c_int,
    mem_type: c_int,
    out: *mut *mut c_void,
) -> *mut c_void;
type AllocatorFreeFn =
    unsafe extern "system" fn(allocator: *mut c_void, p: *mut c_void) -> *mut c_void;
type GetAllocatorDefaultFn = unsafe extern "system" fn(out: *mut *mut c_void) -> *mut c_void;
type ReleasePtrFn = unsafe extern "system" fn(ptr: *mut c_void);
type SessionGetModelMetadataFn =
    unsafe extern "system" fn(session: *const c_void, out: *mut *mut c_void) -> *mut c_void;
type ModelMetadataLookupCustomFn = unsafe extern "system" fn(
    meta: *const c_void,
    allocator: *mut c_void,
    key: *const c_char,
    value: *mut *mut c_char,
) -> *mut c_void;

#[derive(Debug, Clone)]
pub struct ResolvedOcrAssets {
    pub ocr_dir: PathBuf,
    pub dll_path: PathBuf,
    pub det_model_path: PathBuf,
    pub cls_model_path: PathBuf,
    pub rec_model_path: PathBuf,
    pub qpdf_crt_dir: Option<PathBuf>,
}

/// Resolves the bundled `onnxruntime.dll` (and optional app-local MSVC CRT directory) for reuse
/// across both OCR (`T03`/`T04`/`P04`) and offline ASR (`T01`).
pub fn resolve_ort_dll_path(
    resource_dir: Option<&Path>,
) -> Result<(PathBuf, Option<PathBuf>), AppError> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = resource_dir {
        candidates.push(dir.join("ocr"));
        candidates.push(dir.join("resources").join("ocr"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("ocr"));
            candidates.push(parent.join("resources").join("ocr"));
            if let Some(grand) = parent.parent() {
                candidates.push(grand.join("resources").join("ocr"));
                if let Some(great) = grand.parent() {
                    candidates.push(great.join("resources").join("ocr"));
                }
            }
        }
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("ocr"),
    );

    for ocr_dir in candidates {
        let dll = ocr_dir.join(ORT_DLL_NAME);
        if dll.is_file() {
            let qpdf_crt_dir = ocr_dir
                .parent()
                .map(|p| p.join("qpdf"))
                .filter(|p| p.join("msvcp140.dll").is_file());
            return Ok((dll, qpdf_crt_dir));
        }
    }

    Err(AppError::new(
        "ORT_RUNTIME_MISSING",
        "Bundled ONNX Runtime (onnxruntime.dll) was not found. Run `npm run ensure-ocr-runtime` or reinstall WinKit.",
    ))
}

pub fn resolve_ocr_assets(resource_dir: Option<&Path>) -> Result<ResolvedOcrAssets, AppError> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = resource_dir {
        candidates.push(dir.join("ocr"));
        candidates.push(dir.join("resources").join("ocr"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("ocr"));
            candidates.push(parent.join("resources").join("ocr"));
            if let Some(grand) = parent.parent() {
                candidates.push(grand.join("resources").join("ocr"));
                if let Some(great) = grand.parent() {
                    candidates.push(great.join("resources").join("ocr"));
                }
            }
        }
    }
    let manifest_ocr = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("ocr");
    candidates.push(manifest_ocr);

    for ocr_dir in candidates {
        let dll = ocr_dir.join(ORT_DLL_NAME);
        let det = ocr_dir.join(OCR_DET_MODEL_NAME);
        let cls = ocr_dir.join(OCR_CLS_MODEL_NAME);
        let rec = ocr_dir.join(OCR_REC_MODEL_NAME);
        if dll.is_file() && det.is_file() && cls.is_file() && rec.is_file() {
            let qpdf_crt_dir = ocr_dir
                .parent()
                .map(|p| p.join("qpdf"))
                .filter(|p| p.join("msvcp140.dll").is_file());
            return Ok(ResolvedOcrAssets {
                ocr_dir,
                dll_path: dll,
                det_model_path: det,
                cls_model_path: cls,
                rec_model_path: rec,
                qpdf_crt_dir,
            });
        }
    }

    Err(AppError::new(
        "OCR_ENGINE_MISSING",
        "Bundled offline OCR runtime or RapidOCR PP-OCRv4 models are missing. Run `npm run ensure-ocr-runtime` or reinstall WinKit.",
    ))
}

#[derive(Clone, Copy)]
struct OrtVtable {
    get_error_message: GetErrorMessageFn,
    create_env: CreateEnvFn,
    create_session: CreateSessionFn,
    run: RunFn,
    create_session_options: CreateSessionOptionsFn,
    disable_mem_pattern: ToggleSessionOptionFn,
    disable_cpu_mem_arena: ToggleSessionOptionFn,
    set_graph_opt_level: SetGraphOptLevelFn,
    set_intra_op_threads: SetThreadsFn,
    set_inter_op_threads: SetThreadsFn,
    session_get_input_name: SessionGetNameFn,
    session_get_output_name: SessionGetNameFn,
    create_tensor_with_data: CreateTensorWithDataFn,
    get_tensor_mutable_data: GetTensorMutableDataFn,
    get_dimensions_count: GetDimensionsCountFn,
    get_dimensions: GetDimensionsFn,
    get_tensor_type_and_shape: GetTensorTypeAndShapeFn,
    create_cpu_memory_info: CreateCpuMemoryInfoFn,
    allocator_free: AllocatorFreeFn,
    get_allocator_default: GetAllocatorDefaultFn,
    release_env: ReleasePtrFn,
    release_status: ReleasePtrFn,
    release_memory_info: ReleasePtrFn,
    release_session: ReleasePtrFn,
    release_value: ReleasePtrFn,
    release_tensor_shape_info: ReleasePtrFn,
    release_session_options: ReleasePtrFn,
    session_get_model_metadata: SessionGetModelMetadataFn,
    model_metadata_lookup_custom: ModelMetadataLookupCustomFn,
    release_model_metadata: ReleasePtrFn,
}

unsafe fn fn_at<F: Copy>(table: *const *const c_void, idx: usize) -> Result<F, AppError> {
    let raw = *table.add(idx);
    if raw.is_null() {
        return Err(AppError::new(
            "OCR_ENGINE_LOAD_FAILED",
            format!("ONNX Runtime C API function slot {idx} is null."),
        ));
    }
    Ok(std::mem::transmute_copy(&raw))
}

impl OrtVtable {
    unsafe fn load_from_table(table: *const *const c_void) -> Result<Self, AppError> {
        Ok(Self {
            get_error_message: fn_at(table, IDX_GET_ERROR_MESSAGE)?,
            create_env: fn_at(table, IDX_CREATE_ENV)?,
            create_session: fn_at(table, IDX_CREATE_SESSION)?,
            run: fn_at(table, IDX_RUN)?,
            create_session_options: fn_at(table, IDX_CREATE_SESSION_OPTIONS)?,
            disable_mem_pattern: fn_at(table, IDX_DISABLE_MEM_PATTERN)?,
            disable_cpu_mem_arena: fn_at(table, IDX_DISABLE_CPU_MEM_ARENA)?,
            set_graph_opt_level: fn_at(table, IDX_SET_GRAPH_OPT_LEVEL)?,
            set_intra_op_threads: fn_at(table, IDX_SET_INTRA_OP_THREADS)?,
            set_inter_op_threads: fn_at(table, IDX_SET_INTER_OP_THREADS)?,
            session_get_input_name: fn_at(table, IDX_SESSION_GET_INPUT_NAME)?,
            session_get_output_name: fn_at(table, IDX_SESSION_GET_OUTPUT_NAME)?,
            create_tensor_with_data: fn_at(table, IDX_CREATE_TENSOR_WITH_DATA)?,
            get_tensor_mutable_data: fn_at(table, IDX_GET_TENSOR_MUTABLE_DATA)?,
            get_dimensions_count: fn_at(table, IDX_GET_DIMENSIONS_COUNT)?,
            get_dimensions: fn_at(table, IDX_GET_DIMENSIONS)?,
            get_tensor_type_and_shape: fn_at(table, IDX_GET_TENSOR_TYPE_AND_SHAPE)?,
            create_cpu_memory_info: fn_at(table, IDX_CREATE_CPU_MEMORY_INFO)?,
            allocator_free: fn_at(table, IDX_ALLOCATOR_FREE)?,
            get_allocator_default: fn_at(table, IDX_GET_ALLOCATOR_DEFAULT)?,
            release_env: fn_at(table, IDX_RELEASE_ENV)?,
            release_status: fn_at(table, IDX_RELEASE_STATUS)?,
            release_memory_info: fn_at(table, IDX_RELEASE_MEMORY_INFO)?,
            release_session: fn_at(table, IDX_RELEASE_SESSION)?,
            release_value: fn_at(table, IDX_RELEASE_VALUE)?,
            release_tensor_shape_info: fn_at(table, IDX_RELEASE_TENSOR_SHAPE_INFO)?,
            release_session_options: fn_at(table, IDX_RELEASE_SESSION_OPTIONS)?,
            session_get_model_metadata: fn_at(table, IDX_SESSION_GET_MODEL_METADATA)?,
            model_metadata_lookup_custom: fn_at(table, IDX_MODEL_METADATA_LOOKUP_CUSTOM)?,
            release_model_metadata: fn_at(table, IDX_RELEASE_MODEL_METADATA)?,
        })
    }

    unsafe fn check_status(&self, status: *mut c_void, context: &str) -> Result<(), AppError> {
        if status.is_null() {
            return Ok(());
        }
        let msg_ptr = (self.get_error_message)(status);
        let msg = if msg_ptr.is_null() {
            "Unknown ONNX Runtime error".to_string()
        } else {
            CStr::from_ptr(msg_ptr).to_string_lossy().into_owned()
        };
        (self.release_status)(status);
        Err(AppError::new(
            "OCR_INFERENCE_FAILED",
            format!("{context}: {msg}"),
        ))
    }
}

#[cfg(windows)]
fn to_wide_null(path: &Path) -> Vec<u16> {
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

pub struct OrtRuntime {
    #[cfg(windows)]
    module: HMODULE,
    api: OrtVtable,
    env: *mut c_void,
    cpu_mem_info: *mut c_void,
    allocator: *mut c_void,
    version_string: String,
}

// SAFETY: `OrtEnv`, `OrtMemoryInfo`, and default `OrtAllocator` are thread-safe immutable
// process-level ONNX Runtime handles once initialized, and only released in Drop.
unsafe impl Send for OrtRuntime {}
unsafe impl Sync for OrtRuntime {}

impl Drop for OrtRuntime {
    fn drop(&mut self) {
        unsafe {
            if !self.cpu_mem_info.is_null() {
                (self.api.release_memory_info)(self.cpu_mem_info);
                self.cpu_mem_info = ptr::null_mut();
            }
            if !self.env.is_null() {
                (self.api.release_env)(self.env);
                self.env = ptr::null_mut();
            }
            #[cfg(windows)]
            if !self.module.is_invalid() {
                let _ = FreeLibrary(self.module);
            }
        }
    }
}

impl OrtRuntime {
    #[cfg(windows)]
    pub fn load(dll_path: &Path, crt_dir: Option<&Path>) -> Result<Self, AppError> {
        if !dll_path.is_file() {
            return Err(AppError::new(
                "OCR_ENGINE_MISSING",
                format!("ONNX Runtime DLL not found at {}", dll_path.display()),
            ));
        }

        // If app-local MSVC runtime DLLs sit alongside qpdf, temporarily add them to DLL search
        // path so `onnxruntime.dll` resolves CRT dependencies even on stripped systems.
        let wide_crt = crt_dir.map(to_wide_null);
        unsafe {
            if let Some(ref w) = wide_crt {
                let _ = SetDllDirectoryW(PCWSTR(w.as_ptr()));
            }
        }

        let wide_dll = to_wide_null(dll_path);
        let load_res = unsafe { LoadLibraryW(PCWSTR(wide_dll.as_ptr())) };

        unsafe {
            if wide_crt.is_some() {
                let _ = SetDllDirectoryW(PCWSTR::null());
            }
        }

        let module = load_res.map_err(|e| {
            AppError::new(
                "OCR_ENGINE_LOAD_FAILED",
                format!("Failed to load {}: {e}", dll_path.display()),
            )
        })?;

        let proc_sym = unsafe { GetProcAddress(module, windows::core::s!("OrtGetApiBase")) };
        let Some(sym) = proc_sym else {
            unsafe {
                let _ = FreeLibrary(module);
            }
            return Err(AppError::new(
                "OCR_ENGINE_LOAD_FAILED",
                "Export OrtGetApiBase not found in onnxruntime.dll.",
            ));
        };

        let get_api_base: OrtGetApiBaseFn = unsafe { std::mem::transmute(sym) };
        let base_ptr = unsafe { get_api_base() };
        if base_ptr.is_null() {
            unsafe {
                let _ = FreeLibrary(module);
            }
            return Err(AppError::new(
                "OCR_ENGINE_LOAD_FAILED",
                "OrtGetApiBase returned null.",
            ));
        }

        let version_string = unsafe {
            let v_ptr = ((*base_ptr).get_version_string)();
            if v_ptr.is_null() {
                "unknown".to_string()
            } else {
                CStr::from_ptr(v_ptr).to_string_lossy().into_owned()
            }
        };

        let table_ptr = unsafe { ((*base_ptr).get_api)(ORT_API_VERSION) };
        if table_ptr.is_null() {
            unsafe {
                let _ = FreeLibrary(module);
            }
            return Err(AppError::new(
                "OCR_ENGINE_LOAD_FAILED",
                format!(
                    "ONNX Runtime {version_string} does not support OrtApi version {ORT_API_VERSION}."
                ),
            ));
        }

        let api = match unsafe { OrtVtable::load_from_table(table_ptr) } {
            Ok(v) => v,
            Err(err) => {
                unsafe {
                    let _ = FreeLibrary(module);
                }
                return Err(err);
            }
        };

        let log_id = CString::new("WinKitOCR").expect("valid cstr");
        let mut env: *mut c_void = ptr::null_mut();
        let st = unsafe { (api.create_env)(ORT_LOGGING_LEVEL_ERROR, log_id.as_ptr(), &mut env) };
        if let Err(err) = unsafe { api.check_status(st, "OrtCreateEnv failed") } {
            unsafe {
                let _ = FreeLibrary(module);
            }
            return Err(err);
        }

        let mut cpu_mem_info: *mut c_void = ptr::null_mut();
        let st_mem = unsafe {
            (api.create_cpu_memory_info)(
                ORT_ARENA_ALLOCATOR,
                ORT_MEM_TYPE_DEFAULT,
                &mut cpu_mem_info,
            )
        };
        if let Err(err) = unsafe { api.check_status(st_mem, "OrtCreateCpuMemoryInfo failed") } {
            unsafe {
                (api.release_env)(env);
                let _ = FreeLibrary(module);
            }
            return Err(err);
        }

        let mut allocator: *mut c_void = ptr::null_mut();
        let st_alloc = unsafe { (api.get_allocator_default)(&mut allocator) };
        if let Err(err) =
            unsafe { api.check_status(st_alloc, "OrtGetAllocatorWithDefaultOptions failed") }
        {
            unsafe {
                (api.release_memory_info)(cpu_mem_info);
                (api.release_env)(env);
                let _ = FreeLibrary(module);
            }
            return Err(err);
        }

        Ok(Self {
            module,
            api,
            env,
            cpu_mem_info,
            allocator,
            version_string,
        })
    }

    #[cfg(not(windows))]
    pub fn load(_dll_path: &Path, _crt_dir: Option<&Path>) -> Result<Self, AppError> {
        Err(AppError::new(
            "OCR_UNSUPPORTED_PLATFORM",
            "Bundled Windows x64 ONNX Runtime is only supported on Windows.",
        ))
    }

    pub fn version_string(&self) -> &str {
        &self.version_string
    }

    pub fn create_session(
        &self,
        model_path: &Path,
        intra_op_threads: i32,
    ) -> Result<OrtSession<'_>, AppError> {
        self.create_session_with_options(model_path, intra_op_threads, false, false)
    }

    pub fn create_session_with_options(
        &self,
        model_path: &Path,
        intra_op_threads: i32,
        disable_cpu_mem_arena: bool,
        disable_mem_pattern: bool,
    ) -> Result<OrtSession<'_>, AppError> {
        if !model_path.is_file() {
            return Err(AppError::new(
                "OCR_ENGINE_MISSING",
                format!("ONNX model file not found: {}", model_path.display()),
            ));
        }

        let mut opts: *mut c_void = ptr::null_mut();
        unsafe {
            let st = (self.api.create_session_options)(&mut opts);
            self.api
                .check_status(st, "OrtCreateSessionOptions failed")?;
        }
        struct OptsGuard {
            ptr: *mut c_void,
            release: ReleasePtrFn,
        }
        impl Drop for OptsGuard {
            fn drop(&mut self) {
                if !self.ptr.is_null() {
                    unsafe { (self.release)(self.ptr) };
                }
            }
        }
        let _opts_guard = OptsGuard {
            ptr: opts,
            release: self.api.release_session_options,
        };

        unsafe {
            let st_opt = (self.api.set_graph_opt_level)(opts, GRAPH_OPTIMIZATION_ENABLE_ALL);
            self.api
                .check_status(st_opt, "SetSessionGraphOptimizationLevel failed")?;
            let st_intra = (self.api.set_intra_op_threads)(opts, intra_op_threads.max(1));
            self.api
                .check_status(st_intra, "SetIntraOpNumThreads failed")?;
            let st_inter = (self.api.set_inter_op_threads)(opts, 1);
            self.api
                .check_status(st_inter, "SetInterOpNumThreads failed")?;
            if disable_mem_pattern {
                let st_pat = (self.api.disable_mem_pattern)(opts);
                self.api.check_status(st_pat, "DisableMemPattern failed")?;
            }
            if disable_cpu_mem_arena {
                let st_arena = (self.api.disable_cpu_mem_arena)(opts);
                self.api
                    .check_status(st_arena, "DisableCpuMemArena failed")?;
            }
        }

        let mut session: *mut c_void = ptr::null_mut();
        #[cfg(windows)]
        unsafe {
            let wide_model = to_wide_null(model_path);
            let st = (self.api.create_session)(self.env, wide_model.as_ptr(), opts, &mut session);
            self.api.check_status(
                st,
                &format!("Failed to create ONNX session for {}", model_path.display()),
            )?;
        }
        #[cfg(not(windows))]
        {
            let _ = &mut session;
            return Err(AppError::new(
                "OCR_UNSUPPORTED_PLATFORM",
                "Non-Windows ONNX Runtime session creation is not enabled.",
            ));
        }

        let input_name = unsafe { self.read_io_name(session, true, 0)? };
        let output_name = unsafe { self.read_io_name(session, false, 0)? };

        Ok(OrtSession {
            runtime: self,
            session,
            input_name,
            output_name,
        })
    }

    unsafe fn read_io_name(
        &self,
        session: *mut c_void,
        is_input: bool,
        index: usize,
    ) -> Result<CString, AppError> {
        let mut raw: *mut c_char = ptr::null_mut();
        let st = if is_input {
            (self.api.session_get_input_name)(session, index, self.allocator, &mut raw)
        } else {
            (self.api.session_get_output_name)(session, index, self.allocator, &mut raw)
        };
        self.api.check_status(st, "SessionGetIoName failed")?;
        if raw.is_null() {
            return Err(AppError::new(
                "OCR_INFERENCE_FAILED",
                "ONNX session returned null I/O tensor name.",
            ));
        }
        let s = CStr::from_ptr(raw).to_owned();
        let _ = (self.api.allocator_free)(self.allocator, raw.cast());
        Ok(s)
    }
}

pub type OrtTensorF32 = (Vec<i64>, Vec<f32>);

pub struct OrtSession<'a> {
    runtime: &'a OrtRuntime,
    session: *mut c_void,
    input_name: CString,
    output_name: CString,
}

// SAFETY: `OrtSession*` is owned exclusively by this struct (or synchronized behind a Mutex)
// and ONNX Runtime explicitly supports calling `OrtRun` from any thread.
unsafe impl Send for OrtSession<'_> {}

impl Drop for OrtSession<'_> {
    fn drop(&mut self) {
        if !self.session.is_null() {
            unsafe { (self.runtime.api.release_session)(self.session) };
            self.session = ptr::null_mut();
        }
    }
}

impl OrtSession<'_> {
    /// Reads a UTF-8 custom metadata value embedded in the ONNX model (e.g. `"character"`).
    pub fn lookup_custom_metadata(&self, key: &str) -> Result<Option<String>, AppError> {
        let c_key = CString::new(key)
            .map_err(|_| AppError::invalid_param("Metadata key contains interior null byte."))?;
        let mut meta: *mut c_void = ptr::null_mut();
        unsafe {
            let st = (self.runtime.api.session_get_model_metadata)(self.session, &mut meta);
            self.runtime
                .api
                .check_status(st, "SessionGetModelMetadata failed")?;
        }
        struct MetaGuard {
            ptr: *mut c_void,
            release: ReleasePtrFn,
        }
        impl Drop for MetaGuard {
            fn drop(&mut self) {
                if !self.ptr.is_null() {
                    unsafe { (self.release)(self.ptr) };
                }
            }
        }
        let _guard = MetaGuard {
            ptr: meta,
            release: self.runtime.api.release_model_metadata,
        };

        let mut val_ptr: *mut c_char = ptr::null_mut();
        unsafe {
            let st = (self.runtime.api.model_metadata_lookup_custom)(
                meta,
                self.runtime.allocator,
                c_key.as_ptr(),
                &mut val_ptr,
            );
            self.runtime
                .api
                .check_status(st, "ModelMetadataLookupCustomMetadataMap failed")?;
            if val_ptr.is_null() {
                return Ok(None);
            }
            let text = CStr::from_ptr(val_ptr).to_string_lossy().into_owned();
            let _ = (self.runtime.api.allocator_free)(self.runtime.allocator, val_ptr.cast());
            Ok(Some(text))
        }
    }

    /// Executes a single-input, single-output `f32` inference pass and returns `(shape, flat_data)`.
    pub fn run_f32(&self, shape: &[i64], input: &[f32]) -> Result<(Vec<i64>, Vec<f32>), AppError> {
        let expected_elems: usize = shape
            .iter()
            .try_fold(1usize, |acc, &d| {
                usize::try_from(d).ok().and_then(|u| acc.checked_mul(u))
            })
            .ok_or_else(|| AppError::invalid_param("Invalid ONNX input tensor shape."))?;
        if expected_elems != input.len() {
            return Err(AppError::invalid_param(format!(
                "ONNX input tensor length mismatch: shape expects {expected_elems}, got {}.",
                input.len()
            )));
        }

        let api = &self.runtime.api;
        let byte_len = std::mem::size_of_val(input);

        let mut in_val: *mut c_void = ptr::null_mut();
        unsafe {
            let st = (api.create_tensor_with_data)(
                self.runtime.cpu_mem_info,
                input.as_ptr() as *mut c_void,
                byte_len,
                shape.as_ptr(),
                shape.len(),
                ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT,
                &mut in_val,
            );
            api.check_status(st, "CreateTensorWithDataAsOrtValue failed")?;
        }
        struct ValueGuard {
            ptr: *mut c_void,
            release: ReleasePtrFn,
        }
        impl Drop for ValueGuard {
            fn drop(&mut self) {
                if !self.ptr.is_null() {
                    unsafe { (self.release)(self.ptr) };
                }
            }
        }
        let _in_guard = ValueGuard {
            ptr: in_val,
            release: api.release_value,
        };

        let in_names = [self.input_name.as_ptr()];
        let in_vals = [in_val as *const c_void];
        let out_names = [self.output_name.as_ptr()];
        let mut out_vals: [*mut c_void; 1] = [ptr::null_mut()];

        unsafe {
            let st = (api.run)(
                self.session,
                ptr::null(),
                in_names.as_ptr(),
                in_vals.as_ptr(),
                1,
                out_names.as_ptr(),
                1,
                out_vals.as_mut_ptr(),
            );
            api.check_status(st, "OrtRun failed")?;
        }

        let out_val = out_vals[0];
        if out_val.is_null() {
            return Err(AppError::new(
                "OCR_INFERENCE_FAILED",
                "ONNX Runtime returned null output tensor.",
            ));
        }
        let _out_guard = ValueGuard {
            ptr: out_val,
            release: api.release_value,
        };

        let mut shape_info: *mut c_void = ptr::null_mut();
        unsafe {
            let st = (api.get_tensor_type_and_shape)(out_val, &mut shape_info);
            api.check_status(st, "GetTensorTypeAndShape failed")?;
        }
        struct ShapeGuard {
            ptr: *mut c_void,
            release: ReleasePtrFn,
        }
        impl Drop for ShapeGuard {
            fn drop(&mut self) {
                if !self.ptr.is_null() {
                    unsafe { (self.release)(self.ptr) };
                }
            }
        }
        let _shape_guard = ShapeGuard {
            ptr: shape_info,
            release: api.release_tensor_shape_info,
        };

        let mut ndim: usize = 0;
        unsafe {
            let st = (api.get_dimensions_count)(shape_info, &mut ndim);
            api.check_status(st, "GetDimensionsCount failed")?;
        }
        let mut dims = vec![0i64; ndim];
        if ndim > 0 {
            unsafe {
                let st = (api.get_dimensions)(shape_info, dims.as_mut_ptr(), ndim);
                api.check_status(st, "GetDimensions failed")?;
            }
        }
        let out_elems: usize = dims
            .iter()
            .try_fold(1usize, |acc, &d| {
                usize::try_from(d).ok().and_then(|u| acc.checked_mul(u))
            })
            .ok_or_else(|| {
                AppError::new(
                    "OCR_INFERENCE_FAILED",
                    "Invalid negative or overflowing ONNX output tensor dimensions.",
                )
            })?;

        let mut data_ptr: *mut c_void = ptr::null_mut();
        unsafe {
            let st = (api.get_tensor_mutable_data)(out_val, &mut data_ptr);
            api.check_status(st, "GetTensorMutableData failed")?;
        }
        if data_ptr.is_null() && out_elems > 0 {
            return Err(AppError::new(
                "OCR_INFERENCE_FAILED",
                "ONNX Runtime returned null output tensor data pointer.",
            ));
        }

        let data = if out_elems == 0 {
            Vec::new()
        } else {
            unsafe { std::slice::from_raw_parts(data_ptr as *const f32, out_elems).to_vec() }
        };

        Ok((dims, data))
    }

    /// Executes a multi-input (`f32`/`i32`/`i64`), multi-output (`f32`) ONNX Runtime pass.
    pub fn run_multi_f32_outputs(
        &self,
        inputs: &[(&str, OrtInput<'_>)],
        output_names: &[&str],
    ) -> Result<Vec<OrtTensorF32>, AppError> {
        struct ValueListGuard {
            ptrs: Vec<*mut c_void>,
            release: ReleasePtrFn,
        }
        impl Drop for ValueListGuard {
            fn drop(&mut self) {
                for ptr in self.ptrs.drain(..) {
                    if !ptr.is_null() {
                        unsafe { (self.release)(ptr) };
                    }
                }
            }
        }
        struct ShapeGuard {
            ptr: *mut c_void,
            release: ReleasePtrFn,
        }
        impl Drop for ShapeGuard {
            fn drop(&mut self) {
                if !self.ptr.is_null() {
                    unsafe { (self.release)(self.ptr) };
                }
            }
        }

        let api = &self.runtime.api;
        let mut in_cnames: Vec<CString> = Vec::with_capacity(inputs.len());
        let mut in_guard = ValueListGuard {
            ptrs: Vec::with_capacity(inputs.len()),
            release: api.release_value,
        };

        for (name, tensor) in inputs {
            let cname = CString::new(*name)
                .map_err(|_| AppError::invalid_param("ONNX input name contains null byte."))?;
            in_cnames.push(cname);

            let (shape, data_ptr, byte_len, elem_type, elem_count) = match tensor {
                OrtInput::F32(s, d) => (
                    *s,
                    d.as_ptr() as *mut c_void,
                    std::mem::size_of_val(*d),
                    ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT,
                    d.len(),
                ),
                OrtInput::I32(s, d) => (
                    *s,
                    d.as_ptr() as *mut c_void,
                    std::mem::size_of_val(*d),
                    ONNX_TENSOR_ELEMENT_DATA_TYPE_INT32,
                    d.len(),
                ),
                OrtInput::I64(s, d) => (
                    *s,
                    d.as_ptr() as *mut c_void,
                    std::mem::size_of_val(*d),
                    ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64,
                    d.len(),
                ),
            };

            let expected_elems: usize = shape
                .iter()
                .try_fold(1usize, |acc, &d| {
                    usize::try_from(d).ok().and_then(|u| acc.checked_mul(u))
                })
                .ok_or_else(|| AppError::invalid_param("Invalid ONNX input tensor shape."))?;
            if expected_elems != elem_count {
                return Err(AppError::invalid_param(format!(
                    "ONNX input '{name}' length mismatch: shape expects {expected_elems}, got {elem_count}."
                )));
            }

            let mut val: *mut c_void = ptr::null_mut();
            unsafe {
                let st = (api.create_tensor_with_data)(
                    self.runtime.cpu_mem_info,
                    data_ptr,
                    byte_len,
                    shape.as_ptr(),
                    shape.len(),
                    elem_type,
                    &mut val,
                );
                api.check_status(st, &format!("CreateTensorWithData failed for '{name}'"))?;
            }
            in_guard.ptrs.push(val);
        }

        let mut out_cnames: Vec<CString> = Vec::with_capacity(output_names.len());
        for name in output_names {
            let cname = CString::new(*name)
                .map_err(|_| AppError::invalid_param("ONNX output name contains null byte."))?;
            out_cnames.push(cname);
        }

        let in_name_ptrs: Vec<*const c_char> = in_cnames.iter().map(|s| s.as_ptr()).collect();
        let in_val_ptrs: Vec<*const c_void> =
            in_guard.ptrs.iter().map(|&p| p as *const c_void).collect();
        let out_name_ptrs: Vec<*const c_char> = out_cnames.iter().map(|s| s.as_ptr()).collect();
        let mut out_guard = ValueListGuard {
            ptrs: vec![ptr::null_mut(); output_names.len()],
            release: api.release_value,
        };

        unsafe {
            let st = (api.run)(
                self.session,
                ptr::null(),
                in_name_ptrs.as_ptr(),
                in_val_ptrs.as_ptr(),
                in_name_ptrs.len(),
                out_name_ptrs.as_ptr(),
                out_name_ptrs.len(),
                out_guard.ptrs.as_mut_ptr(),
            );
            api.check_status(st, "OrtRun (multi-io) failed")?;
        }

        let mut results: Vec<(Vec<i64>, Vec<f32>)> = Vec::with_capacity(output_names.len());
        for (idx, &out_val) in out_guard.ptrs.iter().enumerate() {
            if out_val.is_null() {
                return Err(AppError::new(
                    "ASR_INFERENCE_FAILED",
                    format!(
                        "ONNX Runtime returned null output tensor for '{}'.",
                        output_names[idx]
                    ),
                ));
            }
            let mut shape_info: *mut c_void = ptr::null_mut();
            unsafe {
                let st = (api.get_tensor_type_and_shape)(out_val, &mut shape_info);
                api.check_status(st, "GetTensorTypeAndShape failed")?;
            }
            let _shape_guard = ShapeGuard {
                ptr: shape_info,
                release: api.release_tensor_shape_info,
            };

            let mut ndim: usize = 0;
            unsafe {
                let st = (api.get_dimensions_count)(shape_info, &mut ndim);
                api.check_status(st, "GetDimensionsCount failed")?;
            }
            let mut dims = vec![0i64; ndim];
            if ndim > 0 {
                unsafe {
                    let st = (api.get_dimensions)(shape_info, dims.as_mut_ptr(), ndim);
                    api.check_status(st, "GetDimensions failed")?;
                }
            }
            let out_elems: usize = dims
                .iter()
                .try_fold(1usize, |acc, &d| {
                    usize::try_from(d).ok().and_then(|u| acc.checked_mul(u))
                })
                .ok_or_else(|| {
                    AppError::new(
                        "ASR_INFERENCE_FAILED",
                        "Invalid ONNX output tensor dimensions.",
                    )
                })?;

            let mut data_ptr: *mut c_void = ptr::null_mut();
            unsafe {
                let st = (api.get_tensor_mutable_data)(out_val, &mut data_ptr);
                api.check_status(st, "GetTensorMutableData failed")?;
            }
            if data_ptr.is_null() && out_elems > 0 {
                return Err(AppError::new(
                    "ASR_INFERENCE_FAILED",
                    "ONNX Runtime returned null output tensor data pointer.",
                ));
            }
            let data = if out_elems == 0 {
                Vec::new()
            } else {
                unsafe { std::slice::from_raw_parts(data_ptr as *const f32, out_elems).to_vec() }
            };
            results.push((dims, data));
        }

        Ok(results)
    }
}
