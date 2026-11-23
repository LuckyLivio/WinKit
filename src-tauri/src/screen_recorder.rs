//! Phase 4B2 Batch 2 backend: V05 Screen Recorder.
//!
//! Captures a display, a single window (occluded-safe), or a DPI-accurate physical
//! region via Windows.Graphics.Capture (WGC) + Direct3D 11, optionally captures
//! system audio (WASAPI playback-device loopback) and/or microphone audio with
//! wall-clock-aligned silence filling to guarantee bounded memory and tight A/V sync
//! over long recordings (>= 60 s), optionally renders cursor & click highlight rings,
//! displays a topmost WDA_EXCLUDEFROMCAPTURE recording HUD with Stop button, and
//! streams directly to local FFmpeg for H.264 MP4 / MOV output.

use crate::audio_wasapi::{
    compute_audio_levels, list_audio_devices_impl, AudioDeviceInfo, AudioEndpointFlow,
    StreamingWavWriter, WasapiCaptureMode, WasapiCaptureStream, WasapiPacketStatus,
};
use crate::error::AppError;
use crate::fs_guard::validate_user_path;
use crate::media_core::{
    configure_hidden_command, require_media_tools, run_ffmpeg_cancellable, AtomicMediaOutput,
    MediaPreviewRegistry,
};
use crate::screen_capture::{list_capture_monitors_impl, CaptureRect};
use crate::tasks::{TaskProgressPayload, TaskRegistry, TASK_PROGRESS_EVENT};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

pub const SCREEN_RECORDER_STATE_EVENT: &str = "winkit://screen-recorder-state";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScreenRecordTargetKind {
    Monitor,
    Window,
    Region,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScreenRecordResolution {
    Original,
    P1440,
    P1080,
    P720,
}

impl ScreenRecordResolution {
    pub fn max_height(self) -> Option<u32> {
        match self {
            Self::Original => None,
            Self::P1440 => Some(1440),
            Self::P1080 => Some(1080),
            Self::P720 => Some(720),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScreenRecordFormat {
    Mp4,
    Mov,
}

impl ScreenRecordFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Mp4 => "mp4",
            Self::Mov => "mov",
        }
    }

    pub fn ffmpeg_muxer(self) -> &'static str {
        match self {
            Self::Mp4 => "mp4",
            Self::Mov => "mov",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScreenRecordPhase {
    Idle,
    Recording,
    Finalizing,
    Completed,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenRecorderCapabilities {
    pub wgc_supported: bool,
    pub cursor_toggle_supported: bool,
    pub click_highlight_supported: bool,
    pub formats: Vec<ScreenRecordFormat>,
    pub fps_options: Vec<u32>,
    pub resolution_options: Vec<ScreenRecordResolution>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartScreenRecordingRequest {
    pub target_kind: ScreenRecordTargetKind,
    pub monitor_id: Option<String>,
    pub window_hwnd: Option<u64>,
    pub region_rect: Option<CaptureRect>,
    pub resolution: ScreenRecordResolution,
    pub fps: u32,
    pub format: ScreenRecordFormat,
    pub include_cursor: bool,
    pub highlight_clicks: bool,
    pub record_system_audio: bool,
    pub system_audio_device_id: Option<String>,
    pub record_microphone: bool,
    pub microphone_device_id: Option<String>,
    pub output_path: String,
    pub allow_overwrite: bool,
    pub show_floating_hud: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenRecorderSnapshot {
    pub phase: ScreenRecordPhase,
    pub target_kind: Option<ScreenRecordTargetKind>,
    pub target_summary: Option<String>,
    pub capture_engine: Option<String>,
    pub audio_scope_summary: Option<String>,
    pub elapsed_sec: f64,
    pub frames_written: u64,
    pub output_width: Option<u32>,
    pub output_height: Option<u32>,
    pub fps: Option<u32>,
    pub format: Option<ScreenRecordFormat>,
    pub record_system_audio: bool,
    pub record_microphone: bool,
    pub system_level_db: f32,
    pub mic_level_db: f32,
    pub output_path: Option<String>,
    pub preview_url: Option<String>,
    pub byte_size: Option<u64>,
    pub duration_sec: Option<f64>,
    pub interrupted_reason: Option<String>,
    pub warnings: Vec<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

impl Default for ScreenRecorderSnapshot {
    fn default() -> Self {
        Self {
            phase: ScreenRecordPhase::Idle,
            target_kind: None,
            target_summary: None,
            capture_engine: None,
            audio_scope_summary: None,
            elapsed_sec: 0.0,
            frames_written: 0,
            output_width: None,
            output_height: None,
            fps: None,
            format: None,
            record_system_audio: false,
            record_microphone: false,
            system_level_db: -96.0,
            mic_level_db: -96.0,
            output_path: None,
            preview_url: None,
            byte_size: None,
            duration_sec: None,
            interrupted_reason: None,
            warnings: Vec::new(),
            error_code: None,
            error_message: None,
        }
    }
}

/// Computes even H.264-safe output dimensions obeying an optional max-height cap without upscaling.
pub fn compute_capped_even_dimensions(
    src_w: u32,
    src_h: u32,
    cap: ScreenRecordResolution,
) -> (u32, u32) {
    let w0 = (src_w & !1).max(2);
    let h0 = (src_h & !1).max(2);
    let Some(max_h) = cap.max_height() else {
        return (w0, h0);
    };
    if h0 <= max_h {
        return (w0, h0);
    }
    let scale = f64::from(max_h) / f64::from(h0);
    let out_h = (max_h & !1).max(2);
    let out_w = (((f64::from(w0) * scale).round() as u32) & !1).max(2);
    (out_w, out_h)
}

/// Computes how many silent frames should be inserted before a newly arrived WASAPI packet
/// to keep audio timestamps tightly locked to master wall-clock time without introducing
/// micro-clicks on normal jitter.
pub fn compute_audio_gap_fill_frames(
    written_frames: u64,
    packet_frames: u64,
    expected_frames: u64,
    sample_rate: u32,
) -> u64 {
    let tolerance = u64::from(sample_rate / 25).max(1); // 40 ms jitter window
    let packet_start = expected_frames.saturating_sub(packet_frames);
    if packet_start > written_frames.saturating_add(tolerance) {
        packet_start - written_frames
    } else {
        0
    }
}

/// Computes idle-stretch silent fill frames when WASAPI loopback delivers no packets
/// (e.g., playback device is silent), leaving 25 ms headroom for an in-flight packet.
pub fn compute_audio_idle_fill_frames(
    written_frames: u64,
    expected_frames: u64,
    sample_rate: u32,
) -> u64 {
    let trigger = u64::from(sample_rate / 15).max(1); // ~66 ms behind wall clock
    let headroom = u64::from(sample_rate / 40).max(1); // 25 ms headroom
    if expected_frames > written_frames.saturating_add(trigger) {
        expected_frames
            .saturating_sub(headroom)
            .saturating_sub(written_frames)
    } else {
        0
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ClickRipple {
    pub x: i32,
    pub y: i32,
    pub progress: f32, // 0.0 -> 1.0 over ripple lifetime
    pub is_right: bool,
}

/// Alpha-blends crisp expanding click highlight rings onto an interleaved BGRA frame buffer.
pub fn blend_click_ripples_bgra(
    frame: &mut [u8],
    width: u32,
    height: u32,
    ripples: &[ClickRipple],
) {
    if ripples.is_empty() || width == 0 || height == 0 {
        return;
    }
    let w = width as i32;
    let h = height as i32;
    for r in ripples {
        if r.progress < 0.0 || r.progress > 1.0 {
            continue;
        }
        let radius = 8.0 + r.progress * 20.0;
        let thickness = 3.2f32;
        let alpha = (1.0 - r.progress) * 0.78;
        if alpha <= 0.02 {
            continue;
        }
        // BGR colors: warm amber for left click, sky blue for right click
        let (cb, cg, cr) = if r.is_right {
            (246.0f32, 130.0f32, 59.0f32)
        } else {
            (22.0f32, 196.0f32, 245.0f32)
        };
        let bound = (radius + thickness + 2.0).ceil() as i32;
        let x0 = (r.x - bound).max(0);
        let x1 = (r.x + bound).min(w - 1);
        let y0 = (r.y - bound).max(0);
        let y1 = (r.y + bound).min(h - 1);
        for py in y0..=y1 {
            let dy = (py - r.y) as f32;
            let row_off = (py as usize) * (width as usize) * 4;
            for px in x0..=x1 {
                let dx = (px - r.x) as f32;
                let dist = (dx * dx + dy * dy).sqrt();
                let ring_d = (dist - radius).abs();
                if ring_d <= thickness {
                    let edge = (1.0 - ring_d / thickness).clamp(0.0, 1.0);
                    let a = alpha * edge;
                    let inv = 1.0 - a;
                    let idx = row_off + (px as usize) * 4;
                    if idx + 3 < frame.len() {
                        frame[idx] = (f32::from(frame[idx]) * inv + cb * a).round() as u8;
                        frame[idx + 1] = (f32::from(frame[idx + 1]) * inv + cg * a).round() as u8;
                        frame[idx + 2] = (f32::from(frame[idx + 2]) * inv + cr * a).round() as u8;
                    }
                }
            }
        }
    }
}

/// Shared latest BGRA frame buffer (`O(1)` memory — reused across the entire recording).
struct LatestFrameSlot {
    bgra: Vec<u8>,
    seq: u64,
}

impl LatestFrameSlot {
    fn new(width: u32, height: u32) -> Self {
        Self {
            bgra: vec![0u8; (width as usize) * (height as usize) * 4],
            seq: 0,
        }
    }
}

fn recorder_temp_dir() -> PathBuf {
    std::env::temp_dir().join("winkit-screen-recordings")
}

fn remove_file_quiet(path: &Path) {
    let _ = fs::remove_file(path);
}

// ---------------------------------------------------------------------------
// Windows.Graphics.Capture (WGC) + Direct3D11 + Topmost Excluded HUD
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod win_wgc {
    use super::*;
    use std::ptr;
    use windows::core::{Interface, PCWSTR};
    use windows::Foundation::TypedEventHandler;
    use windows::Graphics::Capture::{
        Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
    };
    use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
    use windows::Graphics::DirectX::DirectXPixelFormat;
    use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows::Win32::Graphics::Direct3D::{
        D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP, D3D_FEATURE_LEVEL_11_0,
    };
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
        D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE,
        D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
    };
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
    use windows::Win32::Graphics::Dxgi::IDXGIDevice;
    use windows::Win32::Graphics::Gdi::{
        BeginPaint, CreateCompatibleDC, CreateDIBSection, CreateFontW, CreateSolidBrush, DeleteDC,
        DeleteObject, DrawTextW, EndPaint, EnumDisplayMonitors, FillRect, FrameRect, GetDC,
        GetMonitorInfoW, InvalidateRect, MonitorFromRect, ReleaseDC, SelectObject, SetBkMode,
        SetTextColor, UpdateWindow, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CLEARTYPE_QUALITY,
        CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DEFAULT_PITCH, DIB_RGB_COLORS, DT_CENTER,
        DT_SINGLELINE, DT_VCENTER, FF_SWISS, HDC, HGDIOBJ, HMONITOR, MONITORINFOEXW,
        MONITOR_DEFAULTTONEAREST, OUT_DEFAULT_PRECIS, PAINTSTRUCT, TRANSPARENT,
    };
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::StationsAndDesktops::{
        GetThreadDesktop, GetUserObjectInformationW, UOI_NAME,
    };
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::System::WinRT::Direct3D11::{
        CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
    };
    use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
    use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClientRect,
        GetCursorPos, GetWindowDisplayAffinity, GetWindowLongPtrW, GetWindowRect, IsIconic,
        IsWindow, LoadCursorW, PeekMessageW, RegisterClassExW, SetWindowDisplayAffinity,
        SetWindowLongPtrW, ShowWindow, TranslateMessage, CS_HREDRAW, CS_VREDRAW, GWLP_USERDATA,
        IDC_ARROW, MSG, PM_REMOVE, SW_SHOWNA, WDA_EXCLUDEFROMCAPTURE, WDA_MONITOR, WM_ERASEBKGND,
        WM_LBUTTONDOWN, WM_PAINT, WNDCLASSEXW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
        WS_POPUP,
    };

    pub struct WinRtGuard {
        should_uninit: bool,
    }

    impl WinRtGuard {
        pub fn init_mta() -> Result<Self, AppError> {
            match unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
                Ok(()) => Ok(Self {
                    should_uninit: true,
                }),
                Err(e) if e.code().0 == 0x8001_0106u32 as i32 => Ok(Self {
                    should_uninit: false,
                }),
                Err(e) => Err(AppError::new(
                    "WGC_INIT_FAILED",
                    format!(
                        "Failed to initialize Windows Runtime (0x{:08X}): {}",
                        e.code().0 as u32,
                        e.message()
                    ),
                )),
            }
        }
    }

    impl Drop for WinRtGuard {
        fn drop(&mut self) {
            if self.should_uninit {
                unsafe { RoUninitialize() };
            }
        }
    }

    pub fn is_wgc_supported() -> bool {
        let _rt = WinRtGuard::init_mta();
        GraphicsCaptureSession::IsSupported().unwrap_or(false)
    }

    fn wide_z(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn is_hwnd_valid(hwnd_raw: u64) -> bool {
        if hwnd_raw == 0 {
            return false;
        }
        unsafe { IsWindow(Some(HWND(hwnd_raw as *mut _))).as_bool() }
    }

    pub fn current_cursor_and_buttons() -> (i32, i32, bool, bool) {
        unsafe {
            let mut pt = POINT::default();
            let _ = GetCursorPos(&mut pt);
            let left = (GetAsyncKeyState(i32::from(VK_LBUTTON.0)) as u16 & 0x8000) != 0;
            let right = (GetAsyncKeyState(i32::from(VK_RBUTTON.0)) as u16 & 0x8000) != 0;
            (pt.x, pt.y, left, right)
        }
    }

    pub fn window_origin_physical(hwnd_raw: u64) -> Option<(i32, i32)> {
        let hwnd = HWND(hwnd_raw as *mut _);
        unsafe {
            let mut rc = RECT::default();
            if DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut rc as *mut RECT as *mut _,
                std::mem::size_of::<RECT>() as u32,
            )
            .is_ok()
            {
                return Some((rc.left, rc.top));
            }
            if GetWindowRect(hwnd, &mut rc).is_ok() {
                return Some((rc.left, rc.top));
            }
        }
        None
    }

    fn find_hmonitor_by_id(
        monitor_id: Option<&str>,
    ) -> Result<(HMONITOR, CaptureRect, String), AppError> {
        struct SearchCtx {
            wanted_id: Option<String>,
            found: Option<(HMONITOR, CaptureRect, String)>,
            fallback: Option<(HMONITOR, CaptureRect, String)>,
        }

        unsafe extern "system" fn enum_cb(
            hmon: HMONITOR,
            _hdc: HDC,
            _rc: *mut RECT,
            lparam: LPARAM,
        ) -> windows::core::BOOL {
            let ctx = &mut *(lparam.0 as *mut SearchCtx);
            let mut mi: MONITORINFOEXW = std::mem::zeroed();
            mi.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
            if GetMonitorInfoW(hmon, &mut mi.monitorInfo as *mut _).as_bool() {
                let nul = mi
                    .szDevice
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(mi.szDevice.len());
                let name = String::from_utf16_lossy(&mi.szDevice[..nul]);
                let r = mi.monitorInfo.rcMonitor;
                let rect = CaptureRect {
                    x: r.left,
                    y: r.top,
                    width: (r.right - r.left).max(0) as u32,
                    height: (r.bottom - r.top).max(0) as u32,
                };
                let is_primary = (mi.monitorInfo.dwFlags & 1) != 0;
                if let Some(ref wanted) = ctx.wanted_id {
                    if wanted == &name {
                        ctx.found = Some((hmon, rect, name));
                        return windows::core::BOOL(0);
                    }
                }
                if is_primary || ctx.fallback.is_none() {
                    ctx.fallback = Some((hmon, rect, name));
                }
            }
            windows::core::BOOL(1)
        }

        let mut ctx = SearchCtx {
            wanted_id: monitor_id
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            found: None,
            fallback: None,
        };
        unsafe {
            let _ = EnumDisplayMonitors(
                None,
                None,
                Some(enum_cb),
                LPARAM(&mut ctx as *mut SearchCtx as isize),
            );
        }
        ctx.found.or(ctx.fallback).ok_or_else(|| {
            AppError::new(
                "CAPTURE_TARGET_NOT_FOUND",
                "No active display monitor was found for screen recording.",
            )
        })
    }

    fn find_hmonitor_for_rect(
        rect: CaptureRect,
    ) -> Result<(HMONITOR, CaptureRect, String), AppError> {
        let rc = RECT {
            left: rect.x,
            top: rect.y,
            right: rect.x + rect.width as i32,
            bottom: rect.y + rect.height as i32,
        };
        let hmon = unsafe { MonitorFromRect(&rc, MONITOR_DEFAULTTONEAREST) };
        if hmon.0.is_null() {
            return find_hmonitor_by_id(None);
        }
        let mut mi: MONITORINFOEXW = unsafe { std::mem::zeroed() };
        mi.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if !unsafe { GetMonitorInfoW(hmon, &mut mi.monitorInfo as *mut _).as_bool() } {
            return find_hmonitor_by_id(None);
        }
        let nul = mi
            .szDevice
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(mi.szDevice.len());
        let name = String::from_utf16_lossy(&mi.szDevice[..nul]);
        let r = mi.monitorInfo.rcMonitor;
        let mon_rect = CaptureRect {
            x: r.left,
            y: r.top,
            width: (r.right - r.left).max(0) as u32,
            height: (r.bottom - r.top).max(0) as u32,
        };
        Ok((hmon, mon_rect, name))
    }

    fn create_d3d11_device(
    ) -> Result<(ID3D11Device, ID3D11DeviceContext, IDirect3DDevice), AppError> {
        let feature_levels = [D3D_FEATURE_LEVEL_11_0];
        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;

        let try_driver = |driver,
                          dev: &mut Option<ID3D11Device>,
                          ctx: &mut Option<ID3D11DeviceContext>| unsafe {
            D3D11CreateDevice(
                None,
                driver,
                windows::Win32::Foundation::HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&feature_levels),
                D3D11_SDK_VERSION,
                Some(dev),
                None,
                Some(ctx),
            )
        };

        if try_driver(D3D_DRIVER_TYPE_HARDWARE, &mut device, &mut context).is_err() {
            try_driver(D3D_DRIVER_TYPE_WARP, &mut device, &mut context).map_err(|e| {
                AppError::new(
                    "WGC_D3D_FAILED",
                    format!(
                        "Failed to initialize Direct3D 11 for screen recording: {}",
                        e.message()
                    ),
                )
            })?;
        }

        let device = device.ok_or_else(|| {
            AppError::new(
                "WGC_D3D_FAILED",
                "Direct3D 11 device creation returned null.",
            )
        })?;
        let context = context.ok_or_else(|| {
            AppError::new(
                "WGC_D3D_FAILED",
                "Direct3D 11 immediate context returned null.",
            )
        })?;

        let dxgi_device: IDXGIDevice = device.cast().map_err(|e| {
            AppError::new(
                "WGC_D3D_FAILED",
                format!("DXGI cast failed: {}", e.message()),
            )
        })?;
        let inspectable =
            unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device) }.map_err(|e| {
                AppError::new(
                    "WGC_D3D_FAILED",
                    format!("WinRT Direct3D device bridge failed: {}", e.message()),
                )
            })?;
        let winrt_device: IDirect3DDevice = inspectable.cast().map_err(|e| {
            AppError::new(
                "WGC_D3D_FAILED",
                format!("WinRT IDirect3DDevice cast failed: {}", e.message()),
            )
        })?;
        Ok((device, context, winrt_device))
    }

    struct WgcCallbackState {
        device: ID3D11Device,
        context: ID3D11DeviceContext,
        winrt_device: IDirect3DDevice,
        staging: Option<ID3D11Texture2D>,
        staging_w: u32,
        staging_h: u32,
        last_size: windows::Graphics::SizeInt32,
    }

    // SAFETY: All D3D11/WinRT objects are created in MTA and accessed exclusively
    // under the single `Mutex<WgcCallbackState>` lock on WGC's free-threaded callback.
    unsafe impl Send for WgcCallbackState {}

    enum CaptureBackend {
        Wgc {
            _rt: WinRtGuard,
            session: GraphicsCaptureSession,
            frame_pool: Direct3D11CaptureFramePool,
            _item: GraphicsCaptureItem,
        },
        Polling {
            stop: Arc<AtomicBool>,
            join: Option<JoinHandle<()>>,
        },
    }

    pub struct WgcSessionHandle {
        backend: CaptureBackend,
        pub pipe_width: u32,
        pub pipe_height: u32,
        pub origin_x: i32,
        pub origin_y: i32,
        pub target_summary: String,
        pub capture_engine: String,
    }

    impl Drop for WgcSessionHandle {
        fn drop(&mut self) {
            match &mut self.backend {
                CaptureBackend::Wgc {
                    session,
                    frame_pool,
                    ..
                } => {
                    let _ = session.Close();
                    let _ = frame_pool.Close();
                }
                CaptureBackend::Polling { stop, join } => {
                    stop.store(true, Ordering::SeqCst);
                    if let Some(h) = join.take() {
                        let _ = h.join();
                    }
                }
            }
        }
    }

    /// Checks whether the current thread runs on the primary interactive `Default` desktop
    /// (where DWM composites windows for WGC). Pure self-inspection; never switches desktops.
    fn is_current_thread_default_desktop() -> bool {
        unsafe {
            let Ok(hdesk) = GetThreadDesktop(GetCurrentThreadId()) else {
                return true;
            };
            let mut buf = [0u16; 128];
            let mut needed = 0u32;
            if GetUserObjectInformationW(
                windows::Win32::Foundation::HANDLE(hdesk.0),
                UOI_NAME,
                Some(buf.as_mut_ptr() as *mut _),
                (buf.len() * 2) as u32,
                Some(&mut needed),
            )
            .is_ok()
            {
                let nul = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
                let name = String::from_utf16_lossy(&buf[..nul]);
                return name.eq_ignore_ascii_case("Default");
            }
            true
        }
    }

    /// Occluded-safe PrintWindow(PW_RENDERFULLCONTENT) fallback used ONLY when WGC cannot open
    /// a non-DWM-composited window (e.g., secondary desktop or legacy non-composited surface).
    fn start_print_window_fallback(
        hwnd_raw: u64,
        bounds: CaptureRect,
        fps: u32,
        target_summary: String,
        latest_slot: &mut Option<Arc<Mutex<LatestFrameSlot>>>,
        target_closed: Arc<AtomicBool>,
    ) -> Result<WgcSessionHandle, AppError> {
        let pw = bounds.width;
        let ph = bounds.height;
        let origin_x = bounds.x;
        let origin_y = bounds.y;
        let slot = Arc::new(Mutex::new(LatestFrameSlot::new(pw, ph)));
        *latest_slot = Some(Arc::clone(&slot));
        let stop = Arc::new(AtomicBool::new(false));
        let stop_cb = Arc::clone(&stop);
        let slot_cb = Arc::clone(&slot);
        let closed_cb = Arc::clone(&target_closed);
        let interval = Duration::from_secs_f64(1.0 / f64::from(fps.max(15)));

        let join = thread::Builder::new()
            .name("winkit-v05-pw-fallback".to_string())
            .spawn(move || unsafe {
                let hwnd = HWND(hwnd_raw as *mut _);
                let screen_dc = GetDC(None);
                let mem_dc = CreateCompatibleDC(Some(screen_dc));
                let bmi = BITMAPINFO {
                    bmiHeader: BITMAPINFOHEADER {
                        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: pw as i32,
                        biHeight: -(ph as i32), // top-down BGRA
                        biPlanes: 1,
                        biBitCount: 32,
                        biCompression: BI_RGB.0,
                        ..std::mem::zeroed()
                    },
                    ..std::mem::zeroed()
                };
                let mut bits: *mut std::ffi::c_void = ptr::null_mut();
                let dib = CreateDIBSection(Some(mem_dc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0);
                if let Ok(hbmp) = dib {
                    if !bits.is_null() {
                        let old = SelectObject(mem_dc, HGDIOBJ(hbmp.0));
                        let total_bytes = (pw as usize) * (ph as usize) * 4;
                        while !stop_cb.load(Ordering::SeqCst) {
                            let tick = Instant::now();
                            if !IsWindow(Some(hwnd)).as_bool() {
                                closed_cb.store(true, Ordering::SeqCst);
                                break;
                            }
                            let ok = PrintWindow(hwnd, mem_dc, PRINT_WINDOW_FLAGS(2)).as_bool()
                                || PrintWindow(hwnd, mem_dc, PRINT_WINDOW_FLAGS(0)).as_bool();
                            if ok {
                                let src =
                                    std::slice::from_raw_parts(bits as *const u8, total_bytes);
                                if let Ok(mut dest) = slot_cb.lock() {
                                    if dest.bgra.len() == total_bytes {
                                        dest.bgra.copy_from_slice(src);
                                        // Force alpha = 255 for opaque BGRA frame
                                        for px in dest.bgra.as_chunks_mut::<4>().0 {
                                            px[3] = 255;
                                        }
                                        dest.seq = dest.seq.wrapping_add(1);
                                    }
                                }
                            }
                            let spent = tick.elapsed();
                            if spent < interval {
                                thread::sleep(interval - spent);
                            }
                        }
                        let _ = SelectObject(mem_dc, old);
                    }
                    let _ = DeleteObject(HGDIOBJ(hbmp.0));
                }
                let _ = DeleteDC(mem_dc);
                let _ = ReleaseDC(None, screen_dc);
            })
            .map_err(|e| {
                AppError::new(
                    "CAPTURE_THREAD_FAILED",
                    format!("Failed launching fallback window capture thread: {e}"),
                )
            })?;

        let wait0 = Instant::now();
        while wait0.elapsed() < Duration::from_millis(600) {
            if let Ok(s) = slot.lock() {
                if s.seq > 0 {
                    break;
                }
            }
            thread::sleep(Duration::from_millis(10));
        }

        Ok(WgcSessionHandle {
            backend: CaptureBackend::Polling {
                stop,
                join: Some(join),
            },
            pipe_width: pw,
            pipe_height: ph,
            origin_x,
            origin_y,
            target_summary,
            capture_engine: "print_window_fallback".to_string(),
        })
    }

    /// Physical-pixel composited region fallback used ONLY on non-Default secondary desktops
    /// where WGC monitor output reflects the primary Default desktop instead of the current secondary desktop.
    fn start_gdi_region_fallback(
        rect: CaptureRect,
        pw: u32,
        ph: u32,
        fps: u32,
        include_cursor: bool,
        target_summary: String,
        latest_slot: &mut Option<Arc<Mutex<LatestFrameSlot>>>,
    ) -> Result<WgcSessionHandle, AppError> {
        let slot = Arc::new(Mutex::new(LatestFrameSlot::new(pw, ph)));
        *latest_slot = Some(Arc::clone(&slot));
        let stop = Arc::new(AtomicBool::new(false));
        let stop_cb = Arc::clone(&stop);
        let slot_cb = Arc::clone(&slot);
        let interval = Duration::from_secs_f64(1.0 / f64::from(fps.max(15)));
        let cap_rect = CaptureRect {
            x: rect.x,
            y: rect.y,
            width: pw,
            height: ph,
        };

        let join = thread::Builder::new()
            .name("winkit-v05-region-fallback".to_string())
            .spawn(move || {
                let mut local = vec![0u8; (pw as usize) * (ph as usize) * 4];
                while !stop_cb.load(Ordering::SeqCst) {
                    let tick = Instant::now();
                    if crate::screen_capture::capture_region_bgra_composited_impl(
                        cap_rect,
                        include_cursor,
                        &mut local,
                    ) {
                        if let Ok(mut dest) = slot_cb.lock() {
                            if dest.bgra.len() == local.len() {
                                dest.bgra.copy_from_slice(&local);
                                dest.seq = dest.seq.wrapping_add(1);
                            }
                        }
                    }
                    let spent = tick.elapsed();
                    if spent < interval {
                        thread::sleep(interval - spent);
                    }
                }
            })
            .map_err(|e| {
                AppError::new(
                    "CAPTURE_THREAD_FAILED",
                    format!("Failed launching secondary-desktop region capture thread: {e}"),
                )
            })?;

        let wait0 = Instant::now();
        while wait0.elapsed() < Duration::from_millis(800) {
            if let Ok(s) = slot.lock() {
                if s.seq > 0 {
                    break;
                }
            }
            thread::sleep(Duration::from_millis(10));
        }

        Ok(WgcSessionHandle {
            backend: CaptureBackend::Polling {
                stop,
                join: Some(join),
            },
            pipe_width: pw,
            pipe_height: ph,
            origin_x: rect.x,
            origin_y: rect.y,
            target_summary,
            capture_engine: "composited_region_fallback".to_string(),
        })
    }

    pub fn start_wgc_capture(
        req: &StartScreenRecordingRequest,
        latest_slot: &mut Option<Arc<Mutex<LatestFrameSlot>>>,
        target_closed: Arc<AtomicBool>,
    ) -> Result<WgcSessionHandle, AppError> {
        let rt = WinRtGuard::init_mta()?;
        if !GraphicsCaptureSession::IsSupported().unwrap_or(false) {
            return Err(AppError::new(
                "WGC_UNSUPPORTED",
                "Windows Graphics Capture is not supported on this version of Windows.",
            ));
        }

        let (d3d_device, d3d_context, winrt_device) = create_d3d11_device()?;
        let interop: IGraphicsCaptureItemInterop =
            windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().map_err(
                |e| {
                    AppError::new(
                        "WGC_INIT_FAILED",
                        format!(
                            "Failed acquiring GraphicsCaptureItem interop: {}",
                            e.message()
                        ),
                    )
                },
            )?;

        let (item, crop_x, crop_y, pipe_w, pipe_h, origin_x, origin_y, target_summary): (
            GraphicsCaptureItem,
            u32,
            u32,
            u32,
            u32,
            i32,
            i32,
            String,
        ) = match req.target_kind {
            ScreenRecordTargetKind::Monitor => {
                let (hmon, mon_rect, mon_name) = find_hmonitor_by_id(req.monitor_id.as_deref())?;
                let item: GraphicsCaptureItem =
                    unsafe { interop.CreateForMonitor(hmon) }.map_err(|e| {
                        AppError::new(
                            "WGC_OPEN_FAILED",
                            format!("Unable to open display capture: {}", e.message()),
                        )
                    })?;
                let sz = item.Size().map_err(|e| {
                    AppError::new(
                        "WGC_OPEN_FAILED",
                        format!("Unable to query display size: {}", e.message()),
                    )
                })?;
                let pw = ((sz.Width.max(2) as u32) & !1).max(2);
                let ph = ((sz.Height.max(2) as u32) & !1).max(2);
                (
                    item,
                    0,
                    0,
                    pw,
                    ph,
                    mon_rect.x,
                    mon_rect.y,
                    format!("{mon_name} ({pw}×{ph})"),
                )
            }
            ScreenRecordTargetKind::Region => {
                let rect = req.region_rect.ok_or_else(|| {
                    AppError::invalid_param("Please select a recording region first.")
                })?;
                if rect.width < 4 || rect.height < 4 {
                    return Err(AppError::invalid_param(
                        "Selected recording region is too small (minimum 4x4 pixels).",
                    ));
                }
                let (hmon, mon_rect, mon_name) = find_hmonitor_for_rect(rect)?;
                let item: GraphicsCaptureItem =
                    unsafe { interop.CreateForMonitor(hmon) }.map_err(|e| {
                        AppError::new(
                            "WGC_OPEN_FAILED",
                            format!("Unable to open monitor capture for region: {}", e.message()),
                        )
                    })?;
                let cx = (rect.x - mon_rect.x).max(0) as u32;
                let cy = (rect.y - mon_rect.y).max(0) as u32;
                let max_w = mon_rect.width.saturating_sub(cx);
                let max_h = mon_rect.height.saturating_sub(cy);
                let pw = (rect.width.min(max_w) & !1).max(2);
                let ph = (rect.height.min(max_h) & !1).max(2);
                let summary = format!(
                    "Region {pw}×{ph} @ ({},{}) [{mon_name}]",
                    mon_rect.x + cx as i32,
                    mon_rect.y + cy as i32
                );
                if !is_current_thread_default_desktop() {
                    return start_gdi_region_fallback(
                        CaptureRect {
                            x: mon_rect.x + cx as i32,
                            y: mon_rect.y + cy as i32,
                            width: pw,
                            height: ph,
                        },
                        pw,
                        ph,
                        req.fps,
                        req.include_cursor,
                        summary,
                        latest_slot,
                    );
                }
                (
                    item,
                    cx,
                    cy,
                    pw,
                    ph,
                    mon_rect.x + cx as i32,
                    mon_rect.y + cy as i32,
                    summary,
                )
            }
            ScreenRecordTargetKind::Window => {
                let hwnd_raw = req.window_hwnd.ok_or_else(|| {
                    AppError::invalid_param("Please select a target window first.")
                })?;
                if !is_hwnd_valid(hwnd_raw) {
                    return Err(AppError::new(
                        "CAPTURE_TARGET_NOT_FOUND",
                        "The selected window is no longer open. Refresh the window list and try again.",
                    ));
                }
                let hwnd = HWND(hwnd_raw as *mut _);
                if unsafe { IsIconic(hwnd).as_bool() } {
                    return Err(AppError::new(
                        "WINDOW_MINIMIZED",
                        "The selected window is minimized. Restore it on screen before starting recording.",
                    ));
                }
                let mut affinity: u32 = 0;
                if unsafe { GetWindowDisplayAffinity(hwnd, &mut affinity).is_ok() }
                    && (affinity == WDA_MONITOR.0 || affinity == WDA_EXCLUDEFROMCAPTURE.0)
                {
                    return Err(AppError::new(
                        "WINDOW_PROTECTED",
                        "This window is marked as protected content by Windows and cannot be captured.",
                    ));
                }
                let fallback_rect = unsafe {
                    let mut rc = RECT::default();
                    if DwmGetWindowAttribute(
                        hwnd,
                        DWMWA_EXTENDED_FRAME_BOUNDS,
                        &mut rc as *mut RECT as *mut _,
                        std::mem::size_of::<RECT>() as u32,
                    )
                    .is_ok()
                        || GetWindowRect(hwnd, &mut rc).is_ok()
                    {
                        Some((
                            rc.left,
                            rc.top,
                            (rc.right - rc.left).max(0),
                            (rc.bottom - rc.top).max(0),
                        ))
                    } else {
                        None
                    }
                };
                let item_res: windows::core::Result<GraphicsCaptureItem> =
                    unsafe { interop.CreateForWindow(hwnd) };
                let item_sz = item_res
                    .as_ref()
                    .ok()
                    .and_then(|i| i.Size().ok())
                    .unwrap_or(windows::Graphics::SizeInt32 {
                        Width: 0,
                        Height: 0,
                    });

                // When DWM does not composite this window (e.g., secondary desktop or legacy surface),
                // WGC returns Size=(0,0) and CreateCaptureSession fails with ERROR_INVALID_STATE.
                // Seamlessly fall back to occluded-safe PrintWindow(PW_RENDERFULLCONTENT).
                if item_res.is_err() || item_sz.Width < 2 || item_sz.Height < 2 {
                    let Some((ox, oy, fw, fh)) = fallback_rect else {
                        return Err(AppError::new(
                            "WINDOW_MINIMIZED",
                            "The target window has zero visible capture dimensions.",
                        ));
                    };
                    if fw < 2 || fh < 2 {
                        return Err(AppError::new(
                            "WINDOW_MINIMIZED",
                            "The target window has zero visible capture dimensions.",
                        ));
                    }
                    let pw = ((fw as u32) & !1).max(2);
                    let ph = ((fh as u32) & !1).max(2);
                    let mut title_buf = [0u16; 256];
                    let tlen = unsafe {
                        windows::Win32::UI::WindowsAndMessaging::GetWindowTextW(
                            hwnd,
                            &mut title_buf,
                        )
                    };
                    let title = if tlen > 0 {
                        String::from_utf16_lossy(&title_buf[..tlen as usize])
                    } else {
                        format!("Window 0x{hwnd_raw:X}")
                    };
                    return start_print_window_fallback(
                        hwnd_raw,
                        CaptureRect {
                            x: ox,
                            y: oy,
                            width: pw,
                            height: ph,
                        },
                        req.fps,
                        format!("{title} ({pw}×{ph})"),
                        latest_slot,
                        target_closed,
                    );
                }

                let item = item_res.expect("checked item_res is Ok");
                let pw = ((item_sz.Width as u32) & !1).max(2);
                let ph = ((item_sz.Height as u32) & !1).max(2);
                let (ox, oy) = fallback_rect.map(|(x, y, _, _)| (x, y)).unwrap_or((0, 0));
                let title = item
                    .DisplayName()
                    .ok()
                    .map(|h| h.to_string())
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| format!("Window 0x{hwnd_raw:X}"));
                (item, 0, 0, pw, ph, ox, oy, format!("{title} ({pw}×{ph})"))
            }
        };

        let slot = Arc::new(Mutex::new(LatestFrameSlot::new(pipe_w, pipe_h)));
        *latest_slot = Some(Arc::clone(&slot));

        let raw_item_sz = item.Size().unwrap_or(windows::Graphics::SizeInt32 {
            Width: pipe_w as i32,
            Height: pipe_h as i32,
        });
        let init_size = windows::Graphics::SizeInt32 {
            Width: if raw_item_sz.Width >= 2 {
                raw_item_sz.Width
            } else {
                pipe_w as i32
            },
            Height: if raw_item_sz.Height >= 2 {
                raw_item_sz.Height
            } else {
                pipe_h as i32
            },
        };
        let frame_pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &winrt_device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2,
            init_size,
        )
        .map_err(|e| {
            AppError::new(
                "WGC_OPEN_FAILED",
                format!("Failed creating WGC frame pool: {}", e.message()),
            )
        })?;

        let closed_flag = Arc::clone(&target_closed);
        let _ = item.Closed(&TypedEventHandler::<
            GraphicsCaptureItem,
            windows::core::IInspectable,
        >::new(move |_, _| {
            closed_flag.store(true, Ordering::SeqCst);
            Ok(())
        }));

        let cb_state = Arc::new(Mutex::new(WgcCallbackState {
            device: d3d_device,
            context: d3d_context,
            winrt_device,
            staging: None,
            staging_w: 0,
            staging_h: 0,
            last_size: init_size,
        }));
        let slot_cb = Arc::clone(&slot);

        frame_pool
            .FrameArrived(&TypedEventHandler::<
                Direct3D11CaptureFramePool,
                windows::core::IInspectable,
            >::new(move |pool_opt, _| {
                let Some(pool) = pool_opt.as_ref() else {
                    return Ok(());
                };
                let Ok(frame) = pool.TryGetNextFrame() else {
                    return Ok(());
                };
                let Ok(content_sz) = frame.ContentSize() else {
                    let _ = frame.Close();
                    return Ok(());
                };
                if content_sz.Width <= 0 || content_sz.Height <= 0 {
                    let _ = frame.Close();
                    return Ok(());
                }

                if let Ok(mut st) = cb_state.lock() {
                    // Recreate pool if target window resized
                    if st.last_size.Width != content_sz.Width
                        || st.last_size.Height != content_sz.Height
                    {
                        st.last_size = content_sz;
                        let _ = pool.Recreate(
                            &st.winrt_device,
                            DirectXPixelFormat::B8G8R8A8UIntNormalized,
                            2,
                            content_sz,
                        );
                    }

                    if let Ok(surface) = frame.Surface() {
                        if let Ok(access) = surface.cast::<IDirect3DDxgiInterfaceAccess>() {
                            if let Ok(src_tex) = unsafe { access.GetInterface::<ID3D11Texture2D>() }
                            {
                                let mut desc = D3D11_TEXTURE2D_DESC::default();
                                unsafe { src_tex.GetDesc(&mut desc) };
                                let tex_w = desc.Width;
                                let tex_h = desc.Height;

                                if st.staging.is_none()
                                    || st.staging_w != tex_w
                                    || st.staging_h != tex_h
                                {
                                    let st_desc = D3D11_TEXTURE2D_DESC {
                                        Width: tex_w,
                                        Height: tex_h,
                                        MipLevels: 1,
                                        ArraySize: 1,
                                        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                                        SampleDesc: DXGI_SAMPLE_DESC {
                                            Count: 1,
                                            Quality: 0,
                                        },
                                        Usage: D3D11_USAGE_STAGING,
                                        BindFlags: 0,
                                        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                                        MiscFlags: 0,
                                    };
                                    let mut new_staging: Option<ID3D11Texture2D> = None;
                                    if unsafe {
                                        st.device.CreateTexture2D(
                                            &st_desc,
                                            None,
                                            Some(&mut new_staging),
                                        )
                                    }
                                    .is_ok()
                                    {
                                        st.staging = new_staging;
                                        st.staging_w = tex_w;
                                        st.staging_h = tex_h;
                                    }
                                }

                                if let Some(ref staging) = st.staging {
                                    unsafe {
                                        st.context.CopyResource(staging, &src_tex);
                                    }
                                    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                                    if unsafe {
                                        st.context.Map(
                                            staging,
                                            0,
                                            D3D11_MAP_READ,
                                            0,
                                            Some(&mut mapped),
                                        )
                                    }
                                    .is_ok()
                                    {
                                        if let Ok(mut dest) = slot_cb.lock() {
                                            let copy_x = crop_x.min(tex_w);
                                            let copy_y = crop_y.min(tex_h);
                                            let avail_w = tex_w.saturating_sub(copy_x);
                                            let avail_h = tex_h.saturating_sub(copy_y);
                                            let cw = pipe_w.min(avail_w) as usize;
                                            let ch = pipe_h.min(avail_h) as usize;
                                            let dst_stride = (pipe_w as usize) * 4;
                                            let src_pitch = mapped.RowPitch as usize;
                                            let src_base = mapped.pData as *const u8;

                                            if cw < pipe_w as usize || ch < pipe_h as usize {
                                                dest.bgra.fill(0);
                                            }
                                            for row in 0..ch {
                                                let s_off = (copy_y as usize + row) * src_pitch
                                                    + (copy_x as usize) * 4;
                                                let d_off = row * dst_stride;
                                                unsafe {
                                                    ptr::copy_nonoverlapping(
                                                        src_base.add(s_off),
                                                        dest.bgra.as_mut_ptr().add(d_off),
                                                        cw * 4,
                                                    );
                                                }
                                            }
                                            dest.seq = dest.seq.wrapping_add(1);
                                        }
                                        unsafe { st.context.Unmap(staging, 0) };
                                    }
                                }
                            }
                        }
                    }
                }
                let _ = frame.Close();
                Ok(())
            }))
            .map_err(|e| {
                AppError::new(
                    "WGC_OPEN_FAILED",
                    format!("Failed binding WGC FrameArrived handler: {}", e.message()),
                )
            })?;

        let session = frame_pool.CreateCaptureSession(&item).map_err(|e| {
            AppError::new(
                "WGC_OPEN_FAILED",
                format!("Failed creating WGC capture session: {}", e.message()),
            )
        })?;
        // Fail-soft optional Windows 10 2004+ / Windows 11 properties
        let _ = session.SetIsCursorCaptureEnabled(req.include_cursor);
        let _ = session.SetIsBorderRequired(false);

        session.StartCapture().map_err(|e| {
            AppError::new(
                "WGC_START_FAILED",
                format!("Failed starting Windows Graphics Capture: {}", e.message()),
            )
        })?;

        // Wait briefly for the very first frame so Frame 0 is real content, never blank black
        let wait_start = Instant::now();
        while wait_start.elapsed() < Duration::from_millis(1200) {
            if target_closed.load(Ordering::SeqCst) {
                return Err(AppError::new(
                    "CAPTURE_TARGET_CLOSED",
                    "The target window closed before capture could begin.",
                ));
            }
            if let Ok(s) = slot.lock() {
                if s.seq > 0 {
                    break;
                }
            }
            thread::sleep(Duration::from_millis(10));
        }

        Ok(WgcSessionHandle {
            backend: CaptureBackend::Wgc {
                _rt: rt,
                session,
                frame_pool,
                _item: item,
            },
            pipe_width: pipe_w,
            pipe_height: pipe_h,
            origin_x,
            origin_y,
            target_summary,
            capture_engine: "wgc".to_string(),
        })
    }

    // --- Always-visible topmost recording HUD (strictly excluded from WGC via WDA_EXCLUDEFROMCAPTURE) ---

    struct RecHudState {
        text: String,
        stop_clicked: Arc<AtomicBool>,
    }

    unsafe extern "system" fn rec_hud_wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut RecHudState;
        match msg {
            WM_ERASEBKGND => LRESULT(1),
            WM_LBUTTONDOWN => {
                if !ptr.is_null() {
                    (*ptr).stop_clicked.store(true, Ordering::SeqCst);
                }
                LRESULT(0)
            }
            WM_PAINT => {
                let mut ps: PAINTSTRUCT = std::mem::zeroed();
                let hdc = BeginPaint(hwnd, &mut ps);
                let mut rc: RECT = std::mem::zeroed();
                let _ = GetClientRect(hwnd, &mut rc);
                let bg = CreateSolidBrush(COLORREF(0x001E_1A1A));
                let border = CreateSolidBrush(COLORREF(0x003B_3BD9)); // red-accent BGR
                FillRect(hdc, &rc, bg);
                let _ = FrameRect(hdc, &rc, border);
                let _ = DeleteObject(HGDIOBJ(bg.0));
                let _ = DeleteObject(HGDIOBJ(border.0));

                if !ptr.is_null() {
                    let st = &*ptr;
                    let font = CreateFontW(
                        -15,
                        0,
                        0,
                        0,
                        600,
                        0,
                        0,
                        0,
                        DEFAULT_CHARSET,
                        OUT_DEFAULT_PRECIS,
                        CLIP_DEFAULT_PRECIS,
                        CLEARTYPE_QUALITY,
                        (DEFAULT_PITCH.0 | FF_SWISS.0) as u32,
                        PCWSTR(wide_z("Microsoft YaHei UI").as_ptr()),
                    );
                    let old = SelectObject(hdc, HGDIOBJ(font.0));
                    SetBkMode(hdc, TRANSPARENT);
                    SetTextColor(hdc, COLORREF(0x00FF_FFFF));
                    let mut text_w = wide_z(&st.text);
                    let len = text_w.len() - 1;
                    DrawTextW(
                        hdc,
                        &mut text_w[..len],
                        &mut rc,
                        DT_CENTER | DT_VCENTER | DT_SINGLELINE,
                    );
                    let _ = SelectObject(hdc, old);
                    let _ = DeleteObject(HGDIOBJ(font.0));
                }
                let _ = EndPaint(hwnd, &ps);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    pub fn spawn_recording_hud(
        stop_clicked: Arc<AtomicBool>,
        hud_shutdown: Arc<AtomicBool>,
        elapsed_ms: Arc<AtomicU64>,
    ) -> JoinHandle<()> {
        thread::Builder::new()
            .name("winkit-v05-hud".to_string())
            .spawn(move || unsafe {
                let Ok(hinst) = GetModuleHandleW(None) else {
                    return;
                };
                let cls_name = wide_z("WinKitV05RecHudClass");
                let wc = WNDCLASSEXW {
                    cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                    style: CS_HREDRAW | CS_VREDRAW,
                    lpfnWndProc: Some(rec_hud_wnd_proc),
                    hInstance: hinst.into(),
                    hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
                    lpszClassName: PCWSTR(cls_name.as_ptr()),
                    ..std::mem::zeroed()
                };
                let _ = RegisterClassExW(&wc);

                let hud_w = 276;
                let hud_h = 36;
                let primary_w = list_capture_monitors_impl()
                    .into_iter()
                    .find(|m| m.is_primary)
                    .map(|m| m.width as i32)
                    .unwrap_or(1920);
                let hud_x = ((primary_w - hud_w) / 2).max(16);
                let hud_y = 14;

                let Ok(hwnd) = CreateWindowExW(
                    WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                    PCWSTR(cls_name.as_ptr()),
                    PCWSTR(wide_z("WinKit Recording").as_ptr()),
                    WS_POPUP,
                    hud_x,
                    hud_y,
                    hud_w,
                    hud_h,
                    None,
                    None,
                    Some(hinst.into()),
                    None,
                ) else {
                    return;
                };
                // Strictly invisible in WGC recordings!
                let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);

                let mut state = Box::new(RecHudState {
                    text: "● REC 00:00 · 点击停止并保存".to_string(),
                    stop_clicked,
                });
                SetWindowLongPtrW(
                    hwnd,
                    GWLP_USERDATA,
                    &mut *state as *mut RecHudState as isize,
                );
                let _ = ShowWindow(hwnd, SW_SHOWNA);
                let _ = UpdateWindow(hwnd);

                let mut last_sec = u64::MAX;
                while !hud_shutdown.load(Ordering::SeqCst) {
                    let mut msg: MSG = std::mem::zeroed();
                    while PeekMessageW(&mut msg, Some(hwnd), 0, 0, PM_REMOVE).as_bool() {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                    let cur_sec = elapsed_ms.load(Ordering::Relaxed) / 1000;
                    if cur_sec != last_sec {
                        last_sec = cur_sec;
                        let mm = cur_sec / 60;
                        let ss = cur_sec % 60;
                        state.text = format!("● REC {mm:02}:{ss:02} · 点击停止并保存");
                        let _ = InvalidateRect(Some(hwnd), None, false);
                    }
                    thread::sleep(Duration::from_millis(40));
                }

                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                let _ = DestroyWindow(hwnd);
            })
            .expect("spawn hud thread")
    }
}

#[cfg(not(windows))]
mod win_wgc {
    use super::*;
    pub struct WgcSessionHandle {
        pub pipe_width: u32,
        pub pipe_height: u32,
        pub origin_x: i32,
        pub origin_y: i32,
        pub target_summary: String,
        pub capture_engine: String,
    }
    pub fn is_wgc_supported() -> bool {
        false
    }
    pub fn is_hwnd_valid(_hwnd: u64) -> bool {
        false
    }
    pub fn current_cursor_and_buttons() -> (i32, i32, bool, bool) {
        (0, 0, false, false)
    }
    pub fn window_origin_physical(_hwnd: u64) -> Option<(i32, i32)> {
        None
    }
    pub fn start_wgc_capture(
        _req: &StartScreenRecordingRequest,
        _latest_slot: &mut Option<Arc<Mutex<LatestFrameSlot>>>,
        _target_closed: Arc<AtomicBool>,
    ) -> Result<WgcSessionHandle, AppError> {
        Err(AppError::new(
            "WGC_UNSUPPORTED",
            "Windows Graphics Capture is only supported on Windows 11.",
        ))
    }
    pub fn spawn_recording_hud(
        _stop_clicked: Arc<AtomicBool>,
        _hud_shutdown: Arc<AtomicBool>,
        _elapsed_ms: Arc<AtomicU64>,
    ) -> JoinHandle<()> {
        thread::spawn(|| {})
    }
}

// ---------------------------------------------------------------------------
// Wall-Clock Synchronized Audio Capture Worker (System Loopback & Mic)
// ---------------------------------------------------------------------------

struct AudioCaptureOutcome {
    wav_path: Option<PathBuf>,
    warning: Option<String>,
}

fn spawn_synced_audio_worker(
    mode: WasapiCaptureMode,
    device_id: Option<String>,
    temp_wav: PathBuf,
    start_go: Arc<AtomicBool>,
    start_instant: Arc<Mutex<Option<Instant>>>,
    stop_flag: Arc<AtomicBool>,
    level_db_out: Arc<Mutex<f32>>,
) -> Result<(String, JoinHandle<AudioCaptureOutcome>), AppError> {
    let (init_tx, init_rx) = std::sync::mpsc::channel::<Result<String, AppError>>();
    let name = match mode {
        WasapiCaptureMode::SystemLoopback => "winkit-v05-sys-audio",
        WasapiCaptureMode::Microphone => "winkit-v05-mic-audio",
    };

    let temp_wav_worker = temp_wav.clone();
    let join = thread::Builder::new()
        .name(name.to_string())
        .spawn(move || {
            let stream = match WasapiCaptureStream::open(device_id.as_deref(), mode) {
                Ok(s) => s,
                Err(err) => {
                    let _ = init_tx.send(Err(err));
                    return AudioCaptureOutcome {
                        wav_path: None,
                        warning: None,
                    };
                }
            };
            let dev_name = stream.device_name.clone();
            let sr = stream.format.sample_rate;
            let ch = stream.format.output_channels;
            let mut writer = match StreamingWavWriter::create(&temp_wav_worker, sr, ch) {
                Ok(w) => w,
                Err(err) => {
                    let _ = init_tx.send(Err(err));
                    return AudioCaptureOutcome {
                        wav_path: None,
                        warning: None,
                    };
                }
            };
            let _ = init_tx.send(Ok(dev_name.clone()));

            // Drain any pre-start buffered packets while waiting for the master video clock
            let mut samples = Vec::with_capacity(8192);
            while !start_go.load(Ordering::SeqCst) && !stop_flag.load(Ordering::SeqCst) {
                stream.wait_for_data(10);
                while let Ok(WasapiPacketStatus::Data { frames, .. }) =
                    stream.read_next_packet(&mut samples)
                {
                    if frames == 0 {
                        break;
                    }
                }
            }
            if stop_flag.load(Ordering::SeqCst) {
                drop(stream);
                drop(writer);
                remove_file_quiet(&temp_wav_worker);
                return AudioCaptureOutcome {
                    wav_path: None,
                    warning: None,
                };
            }

            let t0 = start_instant
                .lock()
                .ok()
                .and_then(|g| *g)
                .unwrap_or_else(Instant::now);

            let silence_chunk = vec![0.0f32; (sr as usize / 50).max(64) * (ch as usize)];
            let write_silence = |w: &mut StreamingWavWriter, mut frames_needed: u64| -> bool {
                let chunk_frames = (silence_chunk.len() / (ch as usize)) as u64;
                while frames_needed > 0 {
                    let take = frames_needed.min(chunk_frames) as usize;
                    if !w
                        .write_interleaved_f32(&silence_chunk[..take * (ch as usize)])
                        .unwrap_or(false)
                    {
                        return false;
                    }
                    frames_needed -= take as u64;
                }
                true
            };

            let mut warning: Option<String> = None;
            let mut disconnected = false;
            let mut last_flush = Instant::now();

            while !stop_flag.load(Ordering::SeqCst) {
                if !disconnected {
                    stream.wait_for_data(12);
                    if stop_flag.load(Ordering::SeqCst) {
                        break;
                    }
                    let mut got_packet = false;
                    loop {
                        match stream.read_next_packet(&mut samples) {
                            Ok(WasapiPacketStatus::Data { frames, .. }) if frames > 0 => {
                                got_packet = true;
                                let metrics = compute_audio_levels(&samples);
                                if let Ok(mut db) = level_db_out.lock() {
                                    *db = metrics.db_fs;
                                }
                                let expected = (t0.elapsed().as_secs_f64() * f64::from(sr))
                                    .round() as u64;
                                let gap = compute_audio_gap_fill_frames(
                                    writer.total_frames(),
                                    frames as u64,
                                    expected,
                                    sr,
                                );
                                if gap > 0 {
                                    let _ = write_silence(&mut writer, gap);
                                }
                                let _ = writer.write_interleaved_f32(&samples);
                            }
                            Ok(WasapiPacketStatus::Data { .. })
                            | Ok(WasapiPacketStatus::Empty) => {
                                break;
                            }
                            Ok(WasapiPacketStatus::DeviceDisconnected) => {
                                disconnected = true;
                                warning = Some(match mode {
                                    WasapiCaptureMode::SystemLoopback => format!(
                                        "System audio playback device disconnected during recording ({dev_name}); remainder filled with silence."
                                    ),
                                    WasapiCaptureMode::Microphone => format!(
                                        "Microphone disconnected during recording ({dev_name}); remainder filled with silence."
                                    ),
                                });
                                break;
                            }
                            Err(err) => {
                                disconnected = true;
                                warning = Some(format!(
                                    "Audio device stopped during recording ({dev_name}): {}; remainder filled with silence.",
                                    err.message
                                ));
                                break;
                            }
                        }
                    }

                    if !got_packet {
                        if let Ok(mut db) = level_db_out.lock() {
                            *db = -96.0;
                        }
                        let expected =
                            (t0.elapsed().as_secs_f64() * f64::from(sr)).round() as u64;
                        let fill =
                            compute_audio_idle_fill_frames(writer.total_frames(), expected, sr);
                        if fill > 0 {
                            let _ = write_silence(&mut writer, fill);
                        }
                    }
                } else {
                    thread::sleep(Duration::from_millis(25));
                    let expected = (t0.elapsed().as_secs_f64() * f64::from(sr)).round() as u64;
                    let fill = compute_audio_idle_fill_frames(writer.total_frames(), expected, sr);
                    if fill > 0 {
                        let _ = write_silence(&mut writer, fill);
                    }
                }

                if last_flush.elapsed() >= Duration::from_secs(2) {
                    let _ = writer.flush_header();
                    last_flush = Instant::now();
                }
            }

            // Release WASAPI device immediately
            drop(stream);

            // Pad final tail to exact stop timestamp so audio duration matches video duration
            let final_expected = (t0.elapsed().as_secs_f64() * f64::from(sr)).round() as u64;
            if final_expected > writer.total_frames() {
                let tail = final_expected - writer.total_frames();
                let _ = write_silence(&mut writer, tail);
            }

            match writer.finalize() {
                Ok(info) if info.total_frames > 0 => AudioCaptureOutcome {
                    wav_path: Some(info.path),
                    warning,
                },
                _ => {
                    remove_file_quiet(&temp_wav_worker);
                    AudioCaptureOutcome {
                        wav_path: None,
                        warning,
                    }
                }
            }
        })
        .map_err(|e| {
            AppError::new(
                "AUDIO_THREAD_FAILED",
                format!("Failed starting screen recorder audio thread: {e}"),
            )
        })?;

    match init_rx.recv() {
        Ok(Ok(dev_name)) => Ok((dev_name, join)),
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
                "Audio capture worker exited during initialization.",
            ))
        }
    }
}

// ---------------------------------------------------------------------------
// ScreenRecorderManager (Managed Tauri State)
// ---------------------------------------------------------------------------

struct ActiveScreenWorker {
    stop_flag: Arc<AtomicBool>,
    discard_flag: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

#[derive(Default)]
struct ScreenRecorderInner {
    snapshot: ScreenRecorderSnapshot,
    worker: Option<ActiveScreenWorker>,
}

#[derive(Clone, Default)]
pub struct ScreenRecorderManager {
    inner: Arc<Mutex<ScreenRecorderInner>>,
}

impl ScreenRecorderManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn snapshot(&self) -> ScreenRecorderSnapshot {
        self.inner
            .lock()
            .expect("screen recorder mutex poisoned")
            .snapshot
            .clone()
    }

    pub fn is_active(&self) -> bool {
        let guard = self.inner.lock().expect("screen recorder mutex poisoned");
        matches!(
            guard.snapshot.phase,
            ScreenRecordPhase::Recording | ScreenRecordPhase::Finalizing
        )
    }

    fn join_worker(&self) {
        let handle = {
            let mut guard = self.inner.lock().expect("screen recorder mutex poisoned");
            guard.worker.as_mut().and_then(|w| w.join.take())
        };
        if let Some(join) = handle {
            let _ = join.join();
        }
        let mut guard = self.inner.lock().expect("screen recorder mutex poisoned");
        guard.worker = None;
    }

    pub fn start_recording(
        &self,
        app: &AppHandle,
        tasks: &TaskRegistry,
        previews: &MediaPreviewRegistry,
        media_root: &Path,
        req: StartScreenRecordingRequest,
    ) -> Result<ScreenRecorderSnapshot, AppError> {
        if self.is_active() {
            return Err(AppError::new(
                "SCREEN_RECORDER_BUSY",
                "A screen recording is already in progress.",
            ));
        }
        self.join_worker();

        let tools = require_media_tools(media_root)?;
        let target_path = validate_user_path(&req.output_path, "output path")?;
        if target_path.exists() && !req.allow_overwrite {
            return Err(AppError::new(
                "TARGET_ALREADY_EXISTS",
                format!(
                    "Target output file already exists and will not be overwritten: {}",
                    target_path.display()
                ),
            ));
        }
        let fps = if req.fps >= 50 { 60 } else { 30 };

        let task_id = format!("v05-rec-{}", Uuid::new_v4());
        let task_guard = tasks.register_checked(&task_id, "V05", true)?;
        let task_cancel = task_guard.cancel_flag();

        let stop_flag = Arc::new(AtomicBool::new(false));
        let discard_flag = Arc::new(AtomicBool::new(false));
        let stop_worker = Arc::clone(&stop_flag);
        let discard_worker = Arc::clone(&discard_flag);

        let (init_tx, init_rx) =
            std::sync::mpsc::channel::<Result<ScreenRecorderSnapshot, AppError>>();
        let inner_arc = Arc::clone(&self.inner);
        let app_clone = app.clone();
        let previews_clone = previews.clone();
        let ffmpeg_path = tools.ffmpeg.clone();
        let task_id_worker = task_id.clone();

        let join = thread::Builder::new()
            .name("winkit-v05-recorder".to_string())
            .spawn(move || {
                let _task_guard = task_guard;
                let tmp_dir = recorder_temp_dir();
                let _ = fs::create_dir_all(&tmp_dir);
                let run_id = Uuid::new_v4();
                let temp_video = tmp_dir.join(format!("v05_vid_{run_id}.{}", req.format.extension()));
                let temp_sys_wav = tmp_dir.join(format!("v05_sys_{run_id}.wav"));
                let temp_mic_wav = tmp_dir.join(format!("v05_mic_{run_id}.wav"));

                // 1. Start Windows Graphics Capture session
                let mut latest_slot: Option<Arc<Mutex<LatestFrameSlot>>> = None;
                let target_closed = Arc::new(AtomicBool::new(false));
                let wgc = match win_wgc::start_wgc_capture(
                    &req,
                    &mut latest_slot,
                    Arc::clone(&target_closed),
                ) {
                    Ok(h) => h,
                    Err(err) => {
                        let _ = init_tx.send(Err(err));
                        return;
                    }
                };
                let slot = latest_slot.expect("WGC initialized latest frame slot");
                let (out_w, out_h) = compute_capped_even_dimensions(
                    wgc.pipe_width,
                    wgc.pipe_height,
                    req.resolution,
                );

                // 2. Open enabled WASAPI audio stream(s) before starting master clock
                let start_go = Arc::new(AtomicBool::new(false));
                let start_instant: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
                let sys_db = Arc::new(Mutex::new(-96.0f32));
                let mic_db = Arc::new(Mutex::new(-96.0f32));
                let audio_stop = Arc::new(AtomicBool::new(false));

                let sys_worker = if req.record_system_audio {
                    match spawn_synced_audio_worker(
                        WasapiCaptureMode::SystemLoopback,
                        req.system_audio_device_id.clone(),
                        temp_sys_wav.clone(),
                        Arc::clone(&start_go),
                        Arc::clone(&start_instant),
                        Arc::clone(&audio_stop),
                        Arc::clone(&sys_db),
                    ) {
                        Ok(pair) => Some(pair),
                        Err(err) => {
                            drop(wgc);
                            let _ = init_tx.send(Err(err));
                            return;
                        }
                    }
                } else {
                    None
                };

                let mic_worker = if req.record_microphone {
                    match spawn_synced_audio_worker(
                        WasapiCaptureMode::Microphone,
                        req.microphone_device_id.clone(),
                        temp_mic_wav.clone(),
                        Arc::clone(&start_go),
                        Arc::clone(&start_instant),
                        Arc::clone(&audio_stop),
                        Arc::clone(&mic_db),
                    ) {
                        Ok(pair) => Some(pair),
                        Err(err) => {
                            audio_stop.store(true, Ordering::SeqCst);
                            if let Some((_, j)) = sys_worker {
                                let _ = j.join();
                            }
                            remove_file_quiet(&temp_sys_wav);
                            drop(wgc);
                            let _ = init_tx.send(Err(err));
                            return;
                        }
                    }
                } else {
                    None
                };

                let audio_scope_summary = match (&sys_worker, &mic_worker) {
                    (Some((s_name, _)), Some((m_name, _))) => {
                        format!("System Loopback ({s_name}) + Mic ({m_name})")
                    }
                    (Some((s_name, _)), None) => format!("System Loopback ({s_name})"),
                    (None, Some((m_name, _))) => format!("Microphone ({m_name})"),
                    (None, None) => "Muted (Video only)".to_string(),
                };

                // 3. Spawn streaming FFmpeg video encoder (bounded memory: reads raw BGRA frames via stdin)
                let mut ff_args = vec![
                    "-y".to_string(),
                    "-hide_banner".to_string(),
                    "-loglevel".to_string(),
                    "error".to_string(),
                    "-f".to_string(),
                    "rawvideo".to_string(),
                    "-pixel_format".to_string(),
                    "bgra".to_string(),
                    "-video_size".to_string(),
                    format!("{}x{}", wgc.pipe_width, wgc.pipe_height),
                    "-framerate".to_string(),
                    fps.to_string(),
                    "-i".to_string(),
                    "pipe:0".to_string(),
                ];
                if out_w != wgc.pipe_width || out_h != wgc.pipe_height {
                    ff_args.push("-vf".to_string());
                    ff_args.push(format!("scale={out_w}:{out_h}:flags=lanczos"));
                }
                ff_args.extend([
                    "-c:v".to_string(),
                    "libx264".to_string(),
                    "-preset".to_string(),
                    "ultrafast".to_string(),
                    "-crf".to_string(),
                    "21".to_string(),
                    "-pix_fmt".to_string(),
                    "yuv420p".to_string(),
                    "-g".to_string(),
                    (fps * 2).to_string(),
                    "-movflags".to_string(),
                    "+faststart".to_string(),
                    "-f".to_string(),
                    req.format.ffmpeg_muxer().to_string(),
                    temp_video.to_string_lossy().to_string(),
                ]);

                let mut cmd = Command::new(&ffmpeg_path);
                configure_hidden_command(&mut cmd);
                cmd.args(&ff_args)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::null())
                    .stderr(Stdio::piped());

                let mut ff_child = match cmd.spawn() {
                    Ok(c) => c,
                    Err(err) => {
                        audio_stop.store(true, Ordering::SeqCst);
                        if let Some((_, j)) = sys_worker {
                            let _ = j.join();
                        }
                        if let Some((_, j)) = mic_worker {
                            let _ = j.join();
                        }
                        remove_file_quiet(&temp_sys_wav);
                        remove_file_quiet(&temp_mic_wav);
                        drop(wgc);
                        let _ = init_tx.send(Err(AppError::from_io(
                            err,
                            "Failed spawning FFmpeg for screen recording",
                        )));
                        return;
                    }
                };

                // Drain FFmpeg stderr on a tiny thread so the pipe can never block
                let stderr_pipe = ff_child.stderr.take();
                let stderr_thread = thread::spawn(move || {
                    let mut buf = String::new();
                    if let Some(mut s) = stderr_pipe {
                        let _ = s.read_to_string(&mut buf);
                    }
                    buf
                });
                let Some(ff_stdin) = ff_child.stdin.take() else {
                    let _ = ff_child.kill();
                    let _ = ff_child.wait();
                    let _ = stderr_thread.join();
                    audio_stop.store(true, Ordering::SeqCst);
                    if let Some((_, j)) = sys_worker {
                        let _ = j.join();
                    }
                    if let Some((_, j)) = mic_worker {
                        let _ = j.join();
                    }
                    drop(wgc);
                    let _ = init_tx.send(Err(AppError::new(
                        "MEDIA_PROCESS_FAILED",
                        "FFmpeg stdin pipe unavailable.",
                    )));
                    return;
                };
                let mut pipe_writer = BufWriter::with_capacity(
                    (wgc.pipe_width as usize * wgc.pipe_height as usize * 4).min(8 * 1024 * 1024),
                    ff_stdin,
                );

                // 4. Latch master wall-clock & launch HUD + recording state
                let recording_start = Instant::now();
                if let Ok(mut guard) = start_instant.lock() {
                    *guard = Some(recording_start);
                }
                start_go.store(true, Ordering::SeqCst);

                let hud_shutdown = Arc::new(AtomicBool::new(false));
                let elapsed_ms_atomic = Arc::new(AtomicU64::new(0));
                let hud_thread = if req.show_floating_hud.unwrap_or(true) {
                    Some(win_wgc::spawn_recording_hud(
                        Arc::clone(&stop_worker),
                        Arc::clone(&hud_shutdown),
                        Arc::clone(&elapsed_ms_atomic),
                    ))
                } else {
                    None
                };

                let init_snap = ScreenRecorderSnapshot {
                    phase: ScreenRecordPhase::Recording,
                    target_kind: Some(req.target_kind),
                    target_summary: Some(wgc.target_summary.clone()),
                    capture_engine: Some(wgc.capture_engine.clone()),
                    audio_scope_summary: Some(audio_scope_summary.clone()),
                    elapsed_sec: 0.0,
                    frames_written: 0,
                    output_width: Some(out_w),
                    output_height: Some(out_h),
                    fps: Some(fps),
                    format: Some(req.format),
                    record_system_audio: req.record_system_audio,
                    record_microphone: req.record_microphone,
                    output_path: Some(target_path.to_string_lossy().to_string()),
                    ..ScreenRecorderSnapshot::default()
                };
                {
                    let mut g = inner_arc.lock().expect("screen recorder mutex poisoned");
                    g.snapshot = init_snap.clone();
                }
                let _ = init_tx.send(Ok(init_snap.clone()));
                let _ = app_clone.emit(
                    TASK_PROGRESS_EVENT,
                    TaskProgressPayload::running(&task_id_worker, "V05", None),
                );
                let _ = app_clone.emit(SCREEN_RECORDER_STATE_EVENT, init_snap);

                // 5. Constant-FPS Wall-Clock Pacer Loop (O(1) memory, zero cumulative A/V drift)
                let frame_bytes = (wgc.pipe_width as usize) * (wgc.pipe_height as usize) * 4;
                let mut work_buf = vec![0u8; frame_bytes];
                let mut frames_written: u64 = 0;
                let mut last_emit = Instant::now();
                let mut interrupted_reason: Option<String> = None;
                let mut prev_lbtn = false;
                let mut prev_rbtn = false;
                let mut active_ripples: Vec<(i32, i32, Instant, bool)> = Vec::new();
                let mut pipe_broken = false;

                while !stop_worker.load(Ordering::SeqCst)
                    && !discard_worker.load(Ordering::SeqCst)
                    && !task_cancel.load(Ordering::SeqCst)
                {
                    if target_closed.load(Ordering::SeqCst)
                        || (req.target_kind == ScreenRecordTargetKind::Window
                            && req.window_hwnd.map(|h| !win_wgc::is_hwnd_valid(h)).unwrap_or(false))
                    {
                        interrupted_reason = Some("target_window_closed".to_string());
                        break;
                    }

                    // Wake precisely on next frame deadline (never accumulates drift)
                    let deadline = recording_start
                        + Duration::from_secs_f64(frames_written as f64 / f64::from(fps));
                    loop {
                        if stop_worker.load(Ordering::SeqCst)
                            || discard_worker.load(Ordering::SeqCst)
                            || task_cancel.load(Ordering::SeqCst)
                            || target_closed.load(Ordering::SeqCst)
                        {
                            break;
                        }
                        let now = Instant::now();
                        if now >= deadline {
                            break;
                        }
                        let rem = deadline - now;
                        if rem > Duration::from_millis(3) {
                            thread::sleep(rem.min(Duration::from_millis(12)) - Duration::from_millis(1));
                        } else {
                            thread::yield_now();
                        }
                    }

                    if stop_worker.load(Ordering::SeqCst)
                        || discard_worker.load(Ordering::SeqCst)
                        || task_cancel.load(Ordering::SeqCst)
                        || target_closed.load(Ordering::SeqCst)
                    {
                        if target_closed.load(Ordering::SeqCst) && interrupted_reason.is_none() {
                            interrupted_reason = Some("target_window_closed".to_string());
                        }
                        break;
                    }

                    // Copy latest WGC frame into single reusable work buffer
                    if let Ok(src) = slot.lock() {
                        if src.bgra.len() == work_buf.len() {
                            work_buf.copy_from_slice(&src.bgra);
                        }
                    }

                    // Optional click highlight ripples
                    if req.highlight_clicks {
                        let (cx, cy, lbtn, rbtn) = win_wgc::current_cursor_and_buttons();
                        let (ox, oy) = if req.target_kind == ScreenRecordTargetKind::Window {
                            req.window_hwnd
                                .and_then(win_wgc::window_origin_physical)
                                .unwrap_or((wgc.origin_x, wgc.origin_y))
                        } else {
                            (wgc.origin_x, wgc.origin_y)
                        };
                        let now = Instant::now();
                        if lbtn && !prev_lbtn {
                            active_ripples.push((cx - ox, cy - oy, now, false));
                        }
                        if rbtn && !prev_rbtn {
                            active_ripples.push((cx - ox, cy - oy, now, true));
                        }
                        prev_lbtn = lbtn;
                        prev_rbtn = rbtn;
                        active_ripples.retain(|(_, _, t, _)| t.elapsed() < Duration::from_millis(320));
                        if active_ripples.len() > 8 {
                            let excess = active_ripples.len() - 8;
                            active_ripples.drain(0..excess);
                        }
                        if !active_ripples.is_empty() {
                            let ripples: Vec<ClickRipple> = active_ripples
                                .iter()
                                .map(|&(x, y, t, is_right)| ClickRipple {
                                    x,
                                    y,
                                    progress: (t.elapsed().as_secs_f32() / 0.32).clamp(0.0, 1.0),
                                    is_right,
                                })
                                .collect();
                            blend_click_ripples_bgra(
                                &mut work_buf,
                                wgc.pipe_width,
                                wgc.pipe_height,
                                &ripples,
                            );
                        }
                    }

                    // Write frame (and catch up missed slots if encoder briefly stalled, keeping A/V locked)
                    let elapsed_sec = recording_start.elapsed().as_secs_f64();
                    let expected_frames = (elapsed_sec * f64::from(fps)).floor() as u64 + 1;
                    let copies = expected_frames
                        .saturating_sub(frames_written)
                        .clamp(1, 4);
                    for _ in 0..copies {
                        if pipe_writer.write_all(&work_buf).is_err() {
                            pipe_broken = true;
                            break;
                        }
                        frames_written += 1;
                    }
                    if pipe_broken {
                        interrupted_reason = Some("encoder_pipe_closed".to_string());
                        break;
                    }

                    elapsed_ms_atomic.store((elapsed_sec * 1000.0) as u64, Ordering::Relaxed);
                    if last_emit.elapsed() >= Duration::from_millis(100) {
                        last_emit = Instant::now();
                        let s_db = sys_db.lock().map(|g| *g).unwrap_or(-96.0);
                        let m_db = mic_db.lock().map(|g| *g).unwrap_or(-96.0);
                        let snap = {
                            let mut g = inner_arc.lock().expect("screen recorder mutex poisoned");
                            g.snapshot.elapsed_sec = elapsed_sec;
                            g.snapshot.frames_written = frames_written;
                            g.snapshot.system_level_db = s_db;
                            g.snapshot.mic_level_db = m_db;
                            g.snapshot.clone()
                        };
                        let _ = app_clone.emit(SCREEN_RECORDER_STATE_EVENT, snap);
                    }
                }

                // 6. Stop HUD, WGC capture, and WASAPI audio threads immediately (release ALL devices!)
                hud_shutdown.store(true, Ordering::SeqCst);
                audio_stop.store(true, Ordering::SeqCst);
                drop(wgc);

                let sys_out = sys_worker.map(|(_, j)| j.join().unwrap_or(AudioCaptureOutcome { wav_path: None, warning: None }));
                let mic_out = mic_worker.map(|(_, j)| j.join().unwrap_or(AudioCaptureOutcome { wav_path: None, warning: None }));
                if let Some(h) = hud_thread {
                    let _ = h.join();
                }

                let mut warnings = Vec::new();
                if let Some(ref s) = sys_out {
                    if let Some(ref w) = s.warning {
                        warnings.push(w.clone());
                    }
                }
                if let Some(ref m) = mic_out {
                    if let Some(ref w) = m.warning {
                        warnings.push(w.clone());
                    }
                }

                let is_discard = discard_worker.load(Ordering::SeqCst)
                    || (task_cancel.load(Ordering::SeqCst) && !stop_worker.load(Ordering::SeqCst));

                if is_discard || frames_written == 0 {
                    drop(pipe_writer);
                    let _ = ff_child.kill();
                    let _ = ff_child.wait();
                    let _ = stderr_thread.join();
                    remove_file_quiet(&temp_video);
                    remove_file_quiet(&temp_sys_wav);
                    remove_file_quiet(&temp_mic_wav);

                    let snap = ScreenRecorderSnapshot::default();
                    {
                        let mut g = inner_arc.lock().expect("screen recorder mutex poisoned");
                        g.snapshot = snap.clone();
                    }
                    let cancel_err = AppError::new("TASK_CANCELLED", "Screen recording discarded.");
                    let _ = app_clone.emit(
                        TASK_PROGRESS_EVENT,
                        TaskProgressPayload::failed_or_cancelled(
                            &task_id_worker,
                            "V05",
                            0,
                            None,
                            &cancel_err,
                        ),
                    );
                    let _ = app_clone.emit(SCREEN_RECORDER_STATE_EVENT, snap);
                    return;
                }

                // 7. Finalize: close FFmpeg stdin cleanly so moov atom is flushed, then mux audio if present
                let recorded_duration = frames_written as f64 / f64::from(fps);
                {
                    let mut g = inner_arc.lock().expect("screen recorder mutex poisoned");
                    g.snapshot.phase = ScreenRecordPhase::Finalizing;
                    g.snapshot.elapsed_sec = recorded_duration;
                    g.snapshot.frames_written = frames_written;
                    g.snapshot.warnings = warnings.clone();
                    let _ = app_clone.emit(SCREEN_RECORDER_STATE_EVENT, g.snapshot.clone());
                }

                let _ = pipe_writer.flush();
                drop(pipe_writer);
                let ff_status = ff_child.wait();
                let ff_stderr = stderr_thread.join().unwrap_or_default();

                let finalize_res: Result<(PathBuf, u64), AppError> = (|| {
                    let status = ff_status.map_err(|e| {
                        AppError::from_io(e, "Failed waiting for screen recording FFmpeg process")
                    })?;
                    if !status.success() {
                        return Err(AppError::new(
                            "MEDIA_PROCESS_FAILED",
                            format!(
                                "Video encoding failed during screen recording finalization: {}",
                                ff_stderr.trim()
                            ),
                        ));
                    }

                    let sys_wav = sys_out.and_then(|o| o.wav_path);
                    let mic_wav = mic_out.and_then(|o| o.wav_path);
                    let mux_cancel = Arc::new(AtomicBool::new(false));
                    let atomic = AtomicMediaOutput::prepare(
                        target_path.clone(),
                        &temp_video,
                        req.allow_overwrite,
                    )?;

                    match (sys_wav, mic_wav) {
                        (None, None) => {
                            fs::copy(&temp_video, atomic.temp_path()).map_err(|e| {
                                AppError::from_io(e, "Failed moving recorded video to target path")
                            })?;
                            atomic.commit(req.allow_overwrite)
                        }
                        (Some(wav), None) | (None, Some(wav)) => {
                            let args = vec![
                                "-y".to_string(),
                                "-hide_banner".to_string(),
                                "-loglevel".to_string(),
                                "error".to_string(),
                                "-i".to_string(),
                                temp_video.to_string_lossy().to_string(),
                                "-i".to_string(),
                                wav.to_string_lossy().to_string(),
                                "-map".to_string(),
                                "0:v:0".to_string(),
                                "-map".to_string(),
                                "1:a:0".to_string(),
                                "-c:v".to_string(),
                                "copy".to_string(),
                                "-c:a".to_string(),
                                "aac".to_string(),
                                "-b:a".to_string(),
                                "192k".to_string(),
                                "-shortest".to_string(),
                                "-movflags".to_string(),
                                "+faststart".to_string(),
                                "-f".to_string(),
                                req.format.ffmpeg_muxer().to_string(),
                                atomic.temp_path().to_string_lossy().to_string(),
                            ];
                            run_ffmpeg_cancellable(
                                &ffmpeg_path,
                                &args,
                                Some(recorded_duration),
                                &mux_cancel,
                                |_, _| {},
                            )?;
                            atomic.commit(req.allow_overwrite)
                        }
                        (Some(sys_w), Some(mic_w)) => {
                            let args = vec![
                                "-y".to_string(),
                                "-hide_banner".to_string(),
                                "-loglevel".to_string(),
                                "error".to_string(),
                                "-i".to_string(),
                                temp_video.to_string_lossy().to_string(),
                                "-i".to_string(),
                                sys_w.to_string_lossy().to_string(),
                                "-i".to_string(),
                                mic_w.to_string_lossy().to_string(),
                                "-filter_complex".to_string(),
                                "[1:a]aresample=48000,aformat=channel_layouts=stereo[s];[2:a]aresample=48000,aformat=channel_layouts=stereo[m];[s][m]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.98[aout]".to_string(),
                                "-map".to_string(),
                                "0:v:0".to_string(),
                                "-map".to_string(),
                                "[aout]".to_string(),
                                "-c:v".to_string(),
                                "copy".to_string(),
                                "-c:a".to_string(),
                                "aac".to_string(),
                                "-b:a".to_string(),
                                "192k".to_string(),
                                "-shortest".to_string(),
                                "-movflags".to_string(),
                                "+faststart".to_string(),
                                "-f".to_string(),
                                req.format.ffmpeg_muxer().to_string(),
                                atomic.temp_path().to_string_lossy().to_string(),
                            ];
                            run_ffmpeg_cancellable(
                                &ffmpeg_path,
                                &args,
                                Some(recorded_duration),
                                &mux_cancel,
                                |_, _| {},
                            )?;
                            atomic.commit(req.allow_overwrite)
                        }
                    }
                })();

                remove_file_quiet(&temp_video);
                remove_file_quiet(&temp_sys_wav);
                remove_file_quiet(&temp_mic_wav);

                match finalize_res {
                    Ok((final_path, byte_size)) => {
                        let preview_url = previews_clone
                            .register_path(&final_path.to_string_lossy())
                            .map(|r| r.url)
                            .ok();
                        let snap = {
                            let mut g = inner_arc.lock().expect("screen recorder mutex poisoned");
                            g.snapshot.phase = ScreenRecordPhase::Completed;
                            g.snapshot.elapsed_sec = recorded_duration;
                            g.snapshot.duration_sec = Some(recorded_duration);
                            g.snapshot.frames_written = frames_written;
                            g.snapshot.byte_size = Some(byte_size);
                            g.snapshot.output_path = Some(final_path.to_string_lossy().to_string());
                            g.snapshot.preview_url = preview_url;
                            g.snapshot.interrupted_reason = interrupted_reason.clone();
                            g.snapshot.warnings = warnings;
                            g.snapshot.system_level_db = -96.0;
                            g.snapshot.mic_level_db = -96.0;
                            g.snapshot.clone()
                        };
                        let _ = app_clone.emit(
                            TASK_PROGRESS_EVENT,
                            TaskProgressPayload::completed(
                                &task_id_worker,
                                "V05",
                                byte_size,
                                Some(byte_size),
                            ),
                        );
                        let _ = app_clone.emit(SCREEN_RECORDER_STATE_EVENT, snap);
                    }
                    Err(err) => {
                        let snap = {
                            let mut g = inner_arc.lock().expect("screen recorder mutex poisoned");
                            g.snapshot.phase = ScreenRecordPhase::Error;
                            g.snapshot.error_code = Some(err.code.to_string());
                            g.snapshot.error_message = Some(err.message.clone());
                            g.snapshot.warnings = warnings;
                            g.snapshot.clone()
                        };
                        let _ = app_clone.emit(
                            TASK_PROGRESS_EVENT,
                            TaskProgressPayload::failed_or_cancelled(
                                &task_id_worker,
                                "V05",
                                0,
                                None,
                                &err,
                            ),
                        );
                        let _ = app_clone.emit(SCREEN_RECORDER_STATE_EVENT, snap);
                    }
                }
            })
            .map_err(|e| {
                AppError::new(
                    "CAPTURE_THREAD_FAILED",
                    format!("Failed launching screen recording thread: {e}"),
                )
            })?;

        match init_rx.recv() {
            Ok(Ok(snap)) => {
                let mut guard = self.inner.lock().expect("screen recorder mutex poisoned");
                guard.worker = Some(ActiveScreenWorker {
                    stop_flag,
                    discard_flag,
                    join: Some(join),
                });
                Ok(snap)
            }
            Ok(Err(err)) => {
                let _ = join.join();
                Err(err)
            }
            Err(_) => {
                let _ = join.join();
                Err(AppError::new(
                    "WGC_START_FAILED",
                    "Screen recorder worker exited unexpectedly during initialization.",
                ))
            }
        }
    }

    /// Stops active screen recording, waits for FFmpeg finalization & device release, and returns final snapshot.
    pub fn stop_and_save(&self, app: &AppHandle) -> ScreenRecorderSnapshot {
        {
            let guard = self.inner.lock().expect("screen recorder mutex poisoned");
            if let Some(worker) = guard.worker.as_ref() {
                worker.stop_flag.store(true, Ordering::SeqCst);
            }
        }
        self.join_worker();
        let snap = self.snapshot();
        let _ = app.emit(SCREEN_RECORDER_STATE_EVENT, snap.clone());
        snap
    }

    /// Aborts active screen recording, discards all temp files (writes zero final file), and releases all devices.
    pub fn discard(&self, app: &AppHandle) -> ScreenRecorderSnapshot {
        {
            let guard = self.inner.lock().expect("screen recorder mutex poisoned");
            if let Some(worker) = guard.worker.as_ref() {
                worker.discard_flag.store(true, Ordering::SeqCst);
                worker.stop_flag.store(true, Ordering::SeqCst);
            }
        }
        self.join_worker();
        let snap = {
            let mut guard = self.inner.lock().expect("screen recorder mutex poisoned");
            guard.snapshot = ScreenRecorderSnapshot::default();
            guard.snapshot.clone()
        };
        let _ = app.emit(SCREEN_RECORDER_STATE_EVENT, snap.clone());
        snap
    }

    pub fn cleanup_on_exit(&self) {
        {
            let guard = self.inner.lock().expect("screen recorder mutex poisoned");
            if let Some(worker) = guard.worker.as_ref() {
                worker.discard_flag.store(true, Ordering::SeqCst);
                worker.stop_flag.store(true, Ordering::SeqCst);
            }
        }
        self.join_worker();
    }
}

pub fn get_screen_recorder_capabilities_impl() -> ScreenRecorderCapabilities {
    let supported = win_wgc::is_wgc_supported();
    ScreenRecorderCapabilities {
        wgc_supported: supported,
        cursor_toggle_supported: supported,
        click_highlight_supported: supported,
        formats: vec![ScreenRecordFormat::Mp4, ScreenRecordFormat::Mov],
        fps_options: vec![30, 60],
        resolution_options: vec![
            ScreenRecordResolution::Original,
            ScreenRecordResolution::P1440,
            ScreenRecordResolution::P1080,
            ScreenRecordResolution::P720,
        ],
    }
}

pub fn list_audio_playback_devices_impl() -> Result<Vec<AudioDeviceInfo>, AppError> {
    list_audio_devices_impl(AudioEndpointFlow::Render)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolution_cap_never_upscales_and_enforces_even_dimensions() {
        assert_eq!(
            compute_capped_even_dimensions(1921, 1081, ScreenRecordResolution::Original),
            (1920, 1080)
        );
        assert_eq!(
            compute_capped_even_dimensions(3840, 2160, ScreenRecordResolution::P1080),
            (1920, 1080)
        );
        assert_eq!(
            compute_capped_even_dimensions(3840, 2160, ScreenRecordResolution::P1440),
            (2560, 1440)
        );
        assert_eq!(
            compute_capped_even_dimensions(1280, 720, ScreenRecordResolution::P1080),
            (1280, 720)
        );
        assert_eq!(
            compute_capped_even_dimensions(1920, 1080, ScreenRecordResolution::P720),
            (1280, 720)
        );
    }

    #[test]
    fn wall_clock_audio_alignment_ignores_normal_jitter_and_fills_real_silent_gaps() {
        let sr = 48_000u32;
        // Normal continuous arrival (20ms jitter) -> 0 gap fill
        assert_eq!(compute_audio_gap_fill_frames(48_000, 480, 48_960, sr), 0);

        // Silent loopback for 2.0 seconds, then 10ms packet arrives at t=2.01s -> fills ~2.0s silence
        let expected = sr as u64 * 2 + 480;
        let gap = compute_audio_gap_fill_frames(0, 480, expected, sr);
        assert_eq!(gap, sr as u64 * 2);

        // Idle fill only triggers past ~66 ms and leaves 25 ms headroom
        assert_eq!(compute_audio_idle_fill_frames(0, 1000, sr), 0);
        let idle_fill = compute_audio_idle_fill_frames(0, 4800, sr);
        assert_eq!(idle_fill, 4800 - 1200);
    }

    #[test]
    fn click_ripple_blends_ring_pixels_without_out_of_bounds() {
        let mut frame = vec![0u8; 64 * 64 * 4];
        blend_click_ripples_bgra(
            &mut frame,
            64,
            64,
            &[ClickRipple {
                x: 32,
                y: 32,
                progress: 0.2,
                is_right: false,
            }],
        );
        // Center stays untouched; ring around radius ~12 px gets colored
        let center_idx = (32 * 64 + 32) * 4;
        assert_eq!(frame[center_idx + 2], 0);
        let ring_idx = (32 * 64 + 44) * 4;
        assert!(frame[ring_idx + 2] > 100, "expected amber ring pixel");
    }
}
