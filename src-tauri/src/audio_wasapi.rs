//! Shared Windows WASAPI audio endpoint enumeration, shared-mode capture & loopback
//! stream reading, PCM format normalization, real-time RMS/peak level metering,
//! and bounded-memory streaming WAV writing.
//!
//! Designed for reuse across A02 (Audio Recorder) and V05 (Screen Recorder).

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// Maximum RIFF/WAVE data chunk payload that fits inside standard 32-bit RIFF headers (~4 GiB).
pub const MAX_WAV_DATA_BYTES: u64 = (u32::MAX as u64) - 44;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioEndpointFlow {
    Capture,
    Render,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceInfo {
    pub id: String,
    pub name: String,
    pub flow: AudioEndpointFlow,
    pub is_default: bool,
    pub sample_rate: Option<u32>,
    pub channels: Option<u16>,
    pub bits_per_sample: Option<u16>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AudioLevelMetrics {
    pub rms: f32,
    pub peak: f32,
    pub db_fs: f32,
    pub clipping: bool,
}

impl Default for AudioLevelMetrics {
    fn default() -> Self {
        Self {
            rms: 0.0,
            peak: 0.0,
            db_fs: -96.0,
            clipping: false,
        }
    }
}

/// Computes normalized RMS, peak amplitude, dBFS (-96..0), and clipping flag from interleaved f32 samples.
pub fn compute_audio_levels(samples: &[f32]) -> AudioLevelMetrics {
    if samples.is_empty() {
        return AudioLevelMetrics::default();
    }
    let mut sum_sq = 0.0f64;
    let mut peak = 0.0f32;
    for &s in samples {
        let a = s.abs().min(1.0);
        if a > peak {
            peak = a;
        }
        sum_sq += f64::from(a) * f64::from(a);
    }
    let rms = (sum_sq / (samples.len() as f64)).sqrt() as f32;
    let db_fs = if rms <= 1e-5 {
        -96.0
    } else {
        (20.0 * rms.log10()).clamp(-96.0, 0.0)
    };
    AudioLevelMetrics {
        rms: rms.clamp(0.0, 1.0),
        peak: peak.clamp(0.0, 1.0),
        db_fs,
        clipping: peak >= 0.985,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SampleEncoding {
    Float32,
    Pcm16,
    Pcm24,
    Pcm32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamAudioFormat {
    pub sample_rate: u32,
    pub source_channels: u16,
    pub output_channels: u16,
    pub bits_per_sample: u16,
    pub block_align: u16,
    pub encoding: SampleEncoding,
}

/// Decodes raw WASAPI packet bytes into interleaved f32 samples normalized to `[-1.0, 1.0]`,
/// downmixing >2 channels cleanly to stereo (`output_channels = 2`).
pub fn decode_packet_to_interleaved_f32(
    raw: &[u8],
    frames: usize,
    fmt: StreamAudioFormat,
    is_silent: bool,
    out: &mut Vec<f32>,
) {
    out.clear();
    let out_ch = fmt.output_channels as usize;
    let src_ch = fmt.source_channels.max(1) as usize;
    let total_out = frames * out_ch;
    out.reserve(total_out);

    if is_silent || frames == 0 {
        out.resize(total_out, 0.0);
        return;
    }

    let stride = fmt.block_align as usize;
    let bytes_per_sample = (fmt.bits_per_sample / 8).max(1) as usize;
    let available_frames = raw
        .len()
        .checked_div(stride)
        .map(|n| n.min(frames))
        .unwrap_or(0);

    for f in 0..available_frames {
        let frame_base = f * stride;
        let read_sample = |ch: usize| -> f32 {
            let off = frame_base + ch * bytes_per_sample;
            match fmt.encoding {
                SampleEncoding::Float32 => {
                    if off + 4 <= raw.len() {
                        let v = f32::from_le_bytes([
                            raw[off],
                            raw[off + 1],
                            raw[off + 2],
                            raw[off + 3],
                        ]);
                        if v.is_finite() {
                            v.clamp(-1.0, 1.0)
                        } else {
                            0.0
                        }
                    } else {
                        0.0
                    }
                }
                SampleEncoding::Pcm16 => {
                    if off + 2 <= raw.len() {
                        let v = i16::from_le_bytes([raw[off], raw[off + 1]]);
                        (f32::from(v) / 32768.0).clamp(-1.0, 1.0)
                    } else {
                        0.0
                    }
                }
                SampleEncoding::Pcm24 => {
                    if off + 3 <= raw.len() {
                        let b0 = raw[off] as i32;
                        let b1 = (raw[off + 1] as i32) << 8;
                        let b2 = (raw[off + 2] as i8 as i32) << 16;
                        let v = b0 | b1 | b2;
                        (v as f32 / 8_388_608.0).clamp(-1.0, 1.0)
                    } else {
                        0.0
                    }
                }
                SampleEncoding::Pcm32 => {
                    if off + 4 <= raw.len() {
                        let v = i32::from_le_bytes([
                            raw[off],
                            raw[off + 1],
                            raw[off + 2],
                            raw[off + 3],
                        ]);
                        (v as f32 / 2_147_483_648.0).clamp(-1.0, 1.0)
                    } else {
                        0.0
                    }
                }
            }
        };

        if out_ch == 1 {
            out.push(read_sample(0));
        } else if src_ch == 1 {
            let s = read_sample(0);
            out.push(s);
            out.push(s);
        } else if src_ch == 2 {
            out.push(read_sample(0));
            out.push(read_sample(1));
        } else {
            // Downmix multi-channel (>2) cleanly into stereo (even channels -> L, odd channels -> R)
            let mut left = 0.0f32;
            let mut right = 0.0f32;
            let mut lc = 0usize;
            let mut rc = 0usize;
            for ch in 0..src_ch {
                let v = read_sample(ch);
                if ch % 2 == 0 {
                    left += v;
                    lc += 1;
                } else {
                    right += v;
                    rc += 1;
                }
            }
            out.push(if lc > 0 {
                (left / lc as f32).clamp(-1.0, 1.0)
            } else {
                0.0
            });
            out.push(if rc > 0 {
                (right / rc as f32).clamp(-1.0, 1.0)
            } else {
                0.0
            });
        }
    }

    if available_frames < frames {
        out.resize(total_out, 0.0);
    }
}

/// Bounded-memory streaming 16-bit PCM WAV writer with periodic header patching.
pub struct StreamingWavWriter {
    path: PathBuf,
    writer: BufWriter<File>,
    sample_rate: u32,
    channels: u16,
    total_frames: u64,
    data_bytes: u64,
    pcm_scratch: Vec<u8>,
}

impl StreamingWavWriter {
    pub fn create(path: &Path, sample_rate: u32, channels: u16) -> Result<Self, AppError> {
        if sample_rate == 0 || channels == 0 {
            return Err(AppError::new(
                "INVALID_INPUT",
                "Invalid audio format parameters for WAV writer.",
            ));
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::from_io(e, "Unable to create temporary recording folder"))?;
        }
        let file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(path)
            .map_err(|e| AppError::from_io(e, "Unable to create temporary WAV recording file"))?;
        let mut writer = BufWriter::with_capacity(64 * 1024, file);
        let header = build_wav_header(sample_rate, channels, 0);
        writer
            .write_all(&header)
            .map_err(|e| AppError::from_io(e, "Unable to write WAV header"))?;
        Ok(Self {
            path: path.to_path_buf(),
            writer,
            sample_rate,
            channels,
            total_frames: 0,
            data_bytes: 0,
            pcm_scratch: Vec::with_capacity(16 * 1024),
        })
    }

    /// Writes interleaved f32 samples as 16-bit signed PCM.
    /// Returns `Ok(false)` if the 4 GiB RIFF WAV limit was reached.
    pub fn write_interleaved_f32(&mut self, samples: &[f32]) -> Result<bool, AppError> {
        if samples.is_empty() {
            return Ok(true);
        }
        let ch = self.channels as usize;
        let frames = samples.len() / ch;
        let aligned_samples = frames * ch;
        let incoming_bytes = (aligned_samples * 2) as u64;
        if self.data_bytes.saturating_add(incoming_bytes) > MAX_WAV_DATA_BYTES {
            return Ok(false);
        }

        self.pcm_scratch.clear();
        self.pcm_scratch.reserve(aligned_samples * 2);
        for &s in &samples[..aligned_samples] {
            let clamped = s.clamp(-1.0, 1.0);
            let q = if clamped >= 1.0 {
                i16::MAX
            } else if clamped <= -1.0 {
                i16::MIN
            } else {
                (clamped * 32767.0).round() as i16
            };
            self.pcm_scratch.extend_from_slice(&q.to_le_bytes());
        }
        self.writer
            .write_all(&self.pcm_scratch)
            .map_err(|e| AppError::from_io(e, "Failed writing audio recording samples"))?;
        self.total_frames += frames as u64;
        self.data_bytes += incoming_bytes;
        Ok(true)
    }

    pub fn flush_header(&mut self) -> Result<(), AppError> {
        self.writer
            .flush()
            .map_err(|e| AppError::from_io(e, "Failed flushing audio recording buffer"))?;
        let file = self.writer.get_mut();
        let data_u32 = self.data_bytes.min(MAX_WAV_DATA_BYTES) as u32;
        let riff_size = 36u32.saturating_add(data_u32);
        file.seek(SeekFrom::Start(4))
            .map_err(|e| AppError::from_io(e, "Failed seeking WAV RIFF size"))?;
        file.write_all(&riff_size.to_le_bytes())
            .map_err(|e| AppError::from_io(e, "Failed patching WAV RIFF size"))?;
        file.seek(SeekFrom::Start(40))
            .map_err(|e| AppError::from_io(e, "Failed seeking WAV data size"))?;
        file.write_all(&data_u32.to_le_bytes())
            .map_err(|e| AppError::from_io(e, "Failed patching WAV data size"))?;
        file.seek(SeekFrom::End(0))
            .map_err(|e| AppError::from_io(e, "Failed restoring WAV write position"))?;
        Ok(())
    }

    pub fn finalize(mut self) -> Result<FinalizedWavInfo, AppError> {
        self.flush_header()?;
        let file = self
            .writer
            .into_inner()
            .map_err(|e| AppError::from_io(e.into_error(), "Failed finalizing WAV recording"))?;
        file.sync_data()
            .map_err(|e| AppError::from_io(e, "Failed syncing WAV recording file"))?;
        let byte_size = 44 + self.data_bytes;
        let duration_sec = self.total_frames as f64 / f64::from(self.sample_rate);
        Ok(FinalizedWavInfo {
            path: self.path,
            sample_rate: self.sample_rate,
            channels: self.channels,
            total_frames: self.total_frames,
            duration_sec,
            byte_size,
        })
    }

    pub fn total_frames(&self) -> u64 {
        self.total_frames
    }

    pub fn duration_sec(&self) -> f64 {
        self.total_frames as f64 / f64::from(self.sample_rate)
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn channels(&self) -> u16 {
        self.channels
    }
}

#[derive(Debug, Clone)]
pub struct FinalizedWavInfo {
    pub path: PathBuf,
    pub sample_rate: u32,
    pub channels: u16,
    pub total_frames: u64,
    pub duration_sec: f64,
    pub byte_size: u64,
}

pub fn build_wav_header(sample_rate: u32, channels: u16, data_bytes: u32) -> [u8; 44] {
    let block_align = channels.saturating_mul(2);
    let byte_rate = sample_rate.saturating_mul(u32::from(block_align));
    let riff_size = 36u32.saturating_add(data_bytes);
    let mut hdr = [0u8; 44];
    hdr[0..4].copy_from_slice(b"RIFF");
    hdr[4..8].copy_from_slice(&riff_size.to_le_bytes());
    hdr[8..12].copy_from_slice(b"WAVE");
    hdr[12..16].copy_from_slice(b"fmt ");
    hdr[16..20].copy_from_slice(&16u32.to_le_bytes()); // PCM fmt chunk size
    hdr[20..22].copy_from_slice(&1u16.to_le_bytes()); // WAVE_FORMAT_PCM
    hdr[22..24].copy_from_slice(&channels.to_le_bytes());
    hdr[24..28].copy_from_slice(&sample_rate.to_le_bytes());
    hdr[28..32].copy_from_slice(&byte_rate.to_le_bytes());
    hdr[32..34].copy_from_slice(&block_align.to_le_bytes());
    hdr[34..36].copy_from_slice(&16u16.to_le_bytes());
    hdr[36..40].copy_from_slice(b"data");
    hdr[40..44].copy_from_slice(&data_bytes.to_le_bytes());
    hdr
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WasapiCaptureMode {
    Microphone,
    SystemLoopback,
}

#[derive(Debug)]
pub enum WasapiPacketStatus {
    Data { frames: usize, is_silent: bool },
    Empty,
    DeviceDisconnected,
}

// ---------------------------------------------------------------------------
// Windows WASAPI Implementation
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod win_impl {
    use super::*;
    use std::ptr;
    use windows::core::{GUID, HSTRING, PWSTR};
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Foundation::{
        CloseHandle, E_ACCESSDENIED, HANDLE, PROPERTYKEY, WAIT_OBJECT_0,
    };
    use windows::Win32::Media::Audio::{
        eCapture, eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDevice,
        IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT,
        AUDCLNT_E_DEVICE_INVALIDATED, AUDCLNT_E_DEVICE_IN_USE, AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK, DEVICE_STATE_ACTIVE,
        WAVEFORMATEX, WAVEFORMATEXTENSIBLE, WAVE_FORMAT_PCM,
    };
    use windows::Win32::Media::KernelStreaming::{
        KSDATAFORMAT_SUBTYPE_PCM, WAVE_FORMAT_EXTENSIBLE,
    };
    use windows::Win32::Media::Multimedia::{
        KSDATAFORMAT_SUBTYPE_IEEE_FLOAT, WAVE_FORMAT_IEEE_FLOAT,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
        COINIT_MULTITHREADED, STGM_READ,
    };
    use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

    /// PKEY_AudioEngine_DeviceFormat = {f19f064d-082c-4e27-bc73-6882a1bb8e4c}, 0
    /// Reading this from IPropertyStore gives sample rate & channels WITHOUT activating IAudioClient.
    const PKEY_AUDIOENGINE_DEVICEFORMAT: PROPERTYKEY = PROPERTYKEY {
        fmtid: GUID::from_u128(0xf19f064d_082c_4e27_bc73_6882a1bb8e4c),
        pid: 0,
    };

    const ERROR_NOT_FOUND_HR: i32 = 0x8007_0490u32 as i32;

    pub struct ComGuard {
        should_uninit: bool,
    }

    impl ComGuard {
        pub fn init_mta() -> Result<Self, AppError> {
            // SAFETY: Standard per-thread COM initialization.
            let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            if hr.is_ok() {
                Ok(Self {
                    should_uninit: true,
                })
            } else if hr.0 == 0x8001_0106u32 as i32 {
                // RPC_E_CHANGED_MODE: thread already initialized with STA, usable without uninit.
                Ok(Self {
                    should_uninit: false,
                })
            } else {
                Err(AppError::new(
                    "AUDIO_INIT_FAILED",
                    format!(
                        "Failed to initialize Windows audio COM subsystem (0x{:08X}).",
                        hr.0 as u32
                    ),
                ))
            }
        }
    }

    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.should_uninit {
                // SAFETY: Matches successful CoInitializeEx on this thread.
                unsafe { CoUninitialize() };
            }
        }
    }

    fn read_pwstr_and_free(p: PWSTR) -> String {
        if p.is_null() {
            return String::new();
        }
        // SAFETY: Pointer returned by COM allocator (`GetId` / `PropVariantToStringAlloc`).
        let text = unsafe { p.to_string().unwrap_or_default() };
        unsafe { CoTaskMemFree(Some(p.0 as *const _)) };
        text
    }

    fn read_device_metadata(
        device: &IMMDevice,
        flow: AudioEndpointFlow,
        default_id: Option<&str>,
    ) -> Option<AudioDeviceInfo> {
        // SAFETY: Valid IMMDevice handle.
        let id = unsafe { device.GetId().ok().map(read_pwstr_and_free)? };
        if id.is_empty() {
            return None;
        }
        let mut name = String::new();
        let mut sample_rate = None;
        let mut channels = None;
        let mut bits_per_sample = None;

        if let Ok(store) = unsafe { device.OpenPropertyStore(STGM_READ) } {
            if let Ok(pv) = unsafe { store.GetValue(&PKEY_Device_FriendlyName) } {
                let s = pv.to_string();
                if !s.trim().is_empty() {
                    name = s;
                }
            }
            if let Ok(fmt_pv) = unsafe { store.GetValue(&PKEY_AUDIOENGINE_DEVICEFORMAT) } {
                // VT_BLOB = 65 -> blob pointer holds WAVEFORMATEX bytes (at least 18 bytes)
                unsafe {
                    let inner = &fmt_pv.Anonymous.Anonymous;
                    if inner.vt.0 == 65 {
                        let blob = inner.Anonymous.blob;
                        if blob.cbSize as usize >= std::mem::size_of::<WAVEFORMATEX>()
                            && !blob.pBlobData.is_null()
                        {
                            let wfx = ptr::read_unaligned(blob.pBlobData as *const WAVEFORMATEX);
                            if wfx.nSamplesPerSec > 0 && wfx.nChannels > 0 {
                                sample_rate = Some(wfx.nSamplesPerSec);
                                channels = Some(wfx.nChannels);
                                bits_per_sample = Some(wfx.wBitsPerSample);
                            }
                        }
                    }
                }
            }
        }

        if name.trim().is_empty() {
            name = id.clone();
        }
        let is_default = default_id.map(|d| d == id).unwrap_or(false);
        Some(AudioDeviceInfo {
            id,
            name,
            flow,
            is_default,
            sample_rate,
            channels,
            bits_per_sample,
        })
    }

    pub fn list_audio_devices_impl(
        flow: AudioEndpointFlow,
    ) -> Result<Vec<AudioDeviceInfo>, AppError> {
        let _com = ComGuard::init_mta()?;
        // SAFETY: Standard MMDeviceEnumerator creation.
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.map_err(|e| {
                AppError::new(
                    "AUDIO_ENUM_FAILED",
                    format!("Unable to query Windows audio devices: {}", e.message()),
                )
            })?;

        let data_flow = match flow {
            AudioEndpointFlow::Capture => eCapture,
            AudioEndpointFlow::Render => eRender,
        };

        let default_id = unsafe { enumerator.GetDefaultAudioEndpoint(data_flow, eConsole) }
            .ok()
            .and_then(|dev| unsafe { dev.GetId().ok().map(read_pwstr_and_free) });

        let collection = unsafe { enumerator.EnumAudioEndpoints(data_flow, DEVICE_STATE_ACTIVE) }
            .map_err(|e| {
            AppError::new(
                "AUDIO_ENUM_FAILED",
                format!(
                    "Unable to enumerate active audio endpoints: {}",
                    e.message()
                ),
            )
        })?;

        let count = unsafe { collection.GetCount() }.unwrap_or(0);
        let mut devices = Vec::with_capacity(count as usize);
        for idx in 0..count {
            if let Ok(dev) = unsafe { collection.Item(idx) } {
                if let Some(info) = read_device_metadata(&dev, flow, default_id.as_deref()) {
                    devices.push(info);
                }
            }
        }
        // Sort default device first, then alphabetical by display name
        devices.sort_by(|a, b| {
            b.is_default
                .cmp(&a.is_default)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(devices)
    }

    fn parse_wave_format(wfx_ptr: *const WAVEFORMATEX) -> Result<StreamAudioFormat, AppError> {
        if wfx_ptr.is_null() {
            return Err(AppError::new(
                "AUDIO_FORMAT_UNSUPPORTED",
                "Audio device returned an empty mix format.",
            ));
        }
        // SAFETY: Pointer returned by IAudioClient::GetMixFormat.
        let wfx = unsafe { ptr::read_unaligned(wfx_ptr) };
        let sample_rate = wfx.nSamplesPerSec;
        let source_channels = wfx.nChannels;
        let bits = wfx.wBitsPerSample;
        let block_align = wfx.nBlockAlign;

        if sample_rate == 0 || source_channels == 0 || block_align == 0 {
            return Err(AppError::new(
                "AUDIO_FORMAT_UNSUPPORTED",
                "Audio device reported an invalid sample rate or channel count.",
            ));
        }

        let tag = u32::from(wfx.wFormatTag);
        let encoding = if tag == WAVE_FORMAT_IEEE_FLOAT && bits == 32 {
            SampleEncoding::Float32
        } else if tag == WAVE_FORMAT_PCM {
            match bits {
                16 => SampleEncoding::Pcm16,
                24 => SampleEncoding::Pcm24,
                32 => SampleEncoding::Pcm32,
                _ => {
                    return Err(AppError::new(
                        "AUDIO_FORMAT_UNSUPPORTED",
                        format!("Unsupported PCM bit depth: {bits}-bit."),
                    ));
                }
            }
        } else if tag == WAVE_FORMAT_EXTENSIBLE {
            // SAFETY: WAVE_FORMAT_EXTENSIBLE extends WAVEFORMATEX when cbSize >= 22.
            let ext = unsafe { ptr::read_unaligned(wfx_ptr as *const WAVEFORMATEXTENSIBLE) };
            let sub = ext.SubFormat;
            if sub == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT && bits == 32 {
                SampleEncoding::Float32
            } else if sub == KSDATAFORMAT_SUBTYPE_PCM {
                match bits {
                    16 => SampleEncoding::Pcm16,
                    24 => SampleEncoding::Pcm24,
                    32 => SampleEncoding::Pcm32,
                    _ => {
                        return Err(AppError::new(
                            "AUDIO_FORMAT_UNSUPPORTED",
                            format!("Unsupported extensible PCM bit depth: {bits}-bit."),
                        ));
                    }
                }
            } else {
                return Err(AppError::new(
                    "AUDIO_FORMAT_UNSUPPORTED",
                    format!(
                        "Unsupported extensible audio subformat ({bits}-bit, {} Hz).",
                        sample_rate
                    ),
                ));
            }
        } else {
            let raw_tag = wfx.wFormatTag;
            return Err(AppError::new(
                "AUDIO_FORMAT_UNSUPPORTED",
                format!("Unsupported audio format tag 0x{:04X}.", raw_tag),
            ));
        };

        let output_channels = if source_channels == 1 { 1 } else { 2 };
        Ok(StreamAudioFormat {
            sample_rate,
            source_channels,
            output_channels,
            bits_per_sample: bits,
            block_align,
            encoding,
        })
    }

    fn map_wasapi_open_error(err: &windows::core::Error, mode: WasapiCaptureMode) -> AppError {
        let code = err.code().0;
        if code == E_ACCESSDENIED.0 {
            return match mode {
                WasapiCaptureMode::Microphone => AppError::new(
                    "MIC_PERMISSION_DENIED",
                    "Windows blocked microphone access. Enable microphone permission for desktop apps in Windows Settings → Privacy & security → Microphone, then try again.",
                ),
                WasapiCaptureMode::SystemLoopback => AppError::new(
                    "AUDIO_PERMISSION_DENIED",
                    "Windows blocked audio loopback capture on the selected playback device.",
                ),
            };
        }
        if code == ERROR_NOT_FOUND_HR {
            return match mode {
                WasapiCaptureMode::Microphone => AppError::new(
                    "NO_MICROPHONE_AVAILABLE",
                    "No active microphone was found. Connect or enable an input device and refresh the list.",
                ),
                WasapiCaptureMode::SystemLoopback => AppError::new(
                    "NO_PLAYBACK_DEVICE",
                    "No active playback device was found for system audio capture.",
                ),
            };
        }
        if code == AUDCLNT_E_DEVICE_IN_USE.0 {
            return AppError::new(
                "AUDIO_DEVICE_IN_USE",
                "The selected audio device is currently locked in exclusive mode by another app.",
            );
        }
        if code == AUDCLNT_E_DEVICE_INVALIDATED.0 {
            return AppError::new(
                "AUDIO_DEVICE_DISCONNECTED",
                "The selected audio device was disconnected or disabled.",
            );
        }
        AppError::new(
            "AUDIO_OPEN_FAILED",
            format!(
                "Failed to open Windows audio device (0x{:08X}): {}",
                code as u32,
                err.message()
            ),
        )
    }

    pub struct WasapiCaptureStream {
        _com: ComGuard,
        audio_client: IAudioClient,
        capture_client: IAudioCaptureClient,
        event_handle: Option<HANDLE>,
        pub device_id: String,
        pub device_name: String,
        pub format: StreamAudioFormat,
        mode: WasapiCaptureMode,
        started: bool,
    }

    impl WasapiCaptureStream {
        pub fn open(device_id: Option<&str>, mode: WasapiCaptureMode) -> Result<Self, AppError> {
            let com = ComGuard::init_mta()?;
            let enumerator: IMMDeviceEnumerator =
                unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
                    .map_err(|e| map_wasapi_open_error(&e, mode))?;

            let data_flow = match mode {
                WasapiCaptureMode::Microphone => eCapture,
                WasapiCaptureMode::SystemLoopback => eRender,
            };

            let device: IMMDevice = match device_id.map(str::trim).filter(|s| !s.is_empty()) {
                Some(id) => {
                    let wide = HSTRING::from(id);
                    unsafe { enumerator.GetDevice(&wide) }.map_err(|e| {
                        let mapped = map_wasapi_open_error(&e, mode);
                        if mapped.code == "AUDIO_OPEN_FAILED" {
                            AppError::new(
                                "AUDIO_DEVICE_NOT_FOUND",
                                "The selected audio device is no longer available. Refresh the device list and choose an active device.",
                            )
                        } else {
                            mapped
                        }
                    })?
                }
                None => unsafe { enumerator.GetDefaultAudioEndpoint(data_flow, eConsole) }
                    .map_err(|e| map_wasapi_open_error(&e, mode))?,
            };

            let meta = read_device_metadata(
                &device,
                match mode {
                    WasapiCaptureMode::Microphone => AudioEndpointFlow::Capture,
                    WasapiCaptureMode::SystemLoopback => AudioEndpointFlow::Render,
                },
                None,
            );
            let resolved_id = meta
                .as_ref()
                .map(|m| m.id.clone())
                .unwrap_or_else(|| device_id.unwrap_or_default().to_string());
            let resolved_name = meta
                .as_ref()
                .map(|m| m.name.clone())
                .unwrap_or_else(|| "Windows Audio Device".to_string());

            let audio_client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None) }
                .map_err(|e| map_wasapi_open_error(&e, mode))?;

            let mix_ptr = unsafe { audio_client.GetMixFormat() }
                .map_err(|e| map_wasapi_open_error(&e, mode))?;
            let parsed_format = parse_wave_format(mix_ptr);
            let format = match parsed_format {
                Ok(f) => f,
                Err(err) => {
                    unsafe { CoTaskMemFree(Some(mix_ptr as *const _)) };
                    return Err(err);
                }
            };

            // 100 ms shared-mode buffer (in 100-nanosecond units)
            let buffer_duration_hns: i64 = 1_000_000;
            let (stream_flags, event_handle) = match mode {
                WasapiCaptureMode::Microphone => {
                    let ev = unsafe { CreateEventW(None, false, false, None) }.map_err(|e| {
                        unsafe { CoTaskMemFree(Some(mix_ptr as *const _)) };
                        AppError::new(
                            "AUDIO_OPEN_FAILED",
                            format!("Failed creating audio capture wait event: {}", e.message()),
                        )
                    })?;
                    (AUDCLNT_STREAMFLAGS_EVENTCALLBACK, Some(ev))
                }
                WasapiCaptureMode::SystemLoopback => (AUDCLNT_STREAMFLAGS_LOOPBACK, None),
            };

            let init_res = unsafe {
                audio_client.Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    stream_flags,
                    buffer_duration_hns,
                    0,
                    mix_ptr,
                    None,
                )
            };
            unsafe { CoTaskMemFree(Some(mix_ptr as *const _)) };
            if let Err(e) = init_res {
                if let Some(ev) = event_handle {
                    let _ = unsafe { CloseHandle(ev) };
                }
                return Err(map_wasapi_open_error(&e, mode));
            }

            if let Some(ev) = event_handle {
                if let Err(e) = unsafe { audio_client.SetEventHandle(ev) } {
                    let _ = unsafe { CloseHandle(ev) };
                    return Err(map_wasapi_open_error(&e, mode));
                }
            }

            let capture_client: IAudioCaptureClient = match unsafe { audio_client.GetService() } {
                Ok(c) => c,
                Err(e) => {
                    if let Some(ev) = event_handle {
                        let _ = unsafe { CloseHandle(ev) };
                    }
                    return Err(map_wasapi_open_error(&e, mode));
                }
            };

            if let Err(e) = unsafe { audio_client.Start() } {
                if let Some(ev) = event_handle {
                    let _ = unsafe { CloseHandle(ev) };
                }
                return Err(map_wasapi_open_error(&e, mode));
            }

            Ok(Self {
                _com: com,
                audio_client,
                capture_client,
                event_handle,
                device_id: resolved_id,
                device_name: resolved_name,
                format,
                mode,
                started: true,
            })
        }

        /// Waits briefly for the next audio packet (or sleeps ~10 ms in loopback mode).
        pub fn wait_for_data(&self, timeout_ms: u32) {
            if let Some(ev) = self.event_handle {
                let _ = unsafe { WaitForSingleObject(ev, timeout_ms) } == WAIT_OBJECT_0;
            } else {
                std::thread::sleep(std::time::Duration::from_millis(u64::from(
                    timeout_ms.min(12),
                )));
            }
        }

        /// Reads the next available WASAPI packet into `out` (interleaved f32 normalized to `[-1, 1]`).
        pub fn read_next_packet(&self, out: &mut Vec<f32>) -> Result<WasapiPacketStatus, AppError> {
            out.clear();
            let packet_frames = match unsafe { self.capture_client.GetNextPacketSize() } {
                Ok(n) => n,
                Err(e) => {
                    if e.code().0 == AUDCLNT_E_DEVICE_INVALIDATED.0 {
                        return Ok(WasapiPacketStatus::DeviceDisconnected);
                    }
                    return Err(map_wasapi_open_error(&e, self.mode));
                }
            };
            if packet_frames == 0 {
                return Ok(WasapiPacketStatus::Empty);
            }

            let mut data_ptr: *mut u8 = ptr::null_mut();
            let mut frames_available: u32 = 0;
            let mut flags: u32 = 0;
            if let Err(e) = unsafe {
                self.capture_client.GetBuffer(
                    &mut data_ptr,
                    &mut frames_available,
                    &mut flags,
                    None,
                    None,
                )
            } {
                if e.code().0 == AUDCLNT_E_DEVICE_INVALIDATED.0 {
                    return Ok(WasapiPacketStatus::DeviceDisconnected);
                }
                return Err(map_wasapi_open_error(&e, self.mode));
            }

            let is_silent =
                (flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)) != 0 || data_ptr.is_null();
            let byte_len = (frames_available as usize) * (self.format.block_align as usize);
            let raw_slice = if is_silent || byte_len == 0 {
                &[][..]
            } else {
                // SAFETY: Valid WASAPI capture buffer until ReleaseBuffer.
                unsafe { std::slice::from_raw_parts(data_ptr, byte_len) }
            };

            decode_packet_to_interleaved_f32(
                raw_slice,
                frames_available as usize,
                self.format,
                is_silent,
                out,
            );

            let rel_res = unsafe { self.capture_client.ReleaseBuffer(frames_available) };
            if let Err(e) = rel_res {
                if e.code().0 == AUDCLNT_E_DEVICE_INVALIDATED.0 {
                    return Ok(WasapiPacketStatus::DeviceDisconnected);
                }
                return Err(map_wasapi_open_error(&e, self.mode));
            }

            Ok(WasapiPacketStatus::Data {
                frames: frames_available as usize,
                is_silent,
            })
        }
    }

    impl Drop for WasapiCaptureStream {
        fn drop(&mut self) {
            if self.started {
                let _ = unsafe { self.audio_client.Stop() };
                self.started = false;
            }
            if let Some(ev) = self.event_handle.take() {
                let _ = unsafe { CloseHandle(ev) };
            }
        }
    }
}

#[cfg(windows)]
pub use win_impl::{list_audio_devices_impl, WasapiCaptureStream};

#[cfg(not(windows))]
pub fn list_audio_devices_impl(_flow: AudioEndpointFlow) -> Result<Vec<AudioDeviceInfo>, AppError> {
    Ok(Vec::new())
}

#[cfg(not(windows))]
pub struct WasapiCaptureStream {
    pub device_id: String,
    pub device_name: String,
    pub format: StreamAudioFormat,
}

#[cfg(not(windows))]
impl WasapiCaptureStream {
    pub fn open(_device_id: Option<&str>, _mode: WasapiCaptureMode) -> Result<Self, AppError> {
        Err(AppError::new(
            "UNSUPPORTED_PLATFORM",
            "Windows WASAPI audio capture is only available on Windows.",
        ))
    }

    pub fn wait_for_data(&self, _timeout_ms: u32) {}

    pub fn read_next_packet(&self, _out: &mut Vec<f32>) -> Result<WasapiPacketStatus, AppError> {
        Ok(WasapiPacketStatus::Empty)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    #[test]
    fn levels_distinguish_silence_and_sine_wave() {
        let silent = compute_audio_levels(&[0.0; 256]);
        assert_eq!(silent.rms, 0.0);
        assert_eq!(silent.db_fs, -96.0);
        assert!(!silent.clipping);

        let sine: Vec<f32> = (0..480)
            .map(|i| 0.5 * (2.0 * PI * 440.0 * (i as f32 / 48000.0)).sin())
            .collect();
        let m = compute_audio_levels(&sine);
        assert!((m.rms - 0.3535).abs() < 0.02, "rms={}", m.rms);
        assert!((m.peak - 0.5).abs() < 0.02, "peak={}", m.peak);
        assert!(m.db_fs > -11.0 && m.db_fs < -8.0, "db={}", m.db_fs);
        assert!(!m.clipping);

        let clipped = compute_audio_levels(&[0.99, -0.99]);
        assert!(clipped.clipping);
    }

    #[test]
    fn decode_float32_pcm16_pcm24_and_multichannel_downmix() {
        // Float32 stereo
        let fmt_f32 = StreamAudioFormat {
            sample_rate: 48000,
            source_channels: 2,
            output_channels: 2,
            bits_per_sample: 32,
            block_align: 8,
            encoding: SampleEncoding::Float32,
        };
        let mut raw = Vec::new();
        raw.extend_from_slice(&0.25f32.to_le_bytes());
        raw.extend_from_slice(&(-0.5f32).to_le_bytes());
        let mut out = Vec::new();
        decode_packet_to_interleaved_f32(&raw, 1, fmt_f32, false, &mut out);
        assert_eq!(out.len(), 2);
        assert!((out[0] - 0.25).abs() < 1e-6);
        assert!((out[1] + 0.5).abs() < 1e-6);

        // Silent flag overrides raw data with zeros
        decode_packet_to_interleaved_f32(&raw, 2, fmt_f32, true, &mut out);
        assert_eq!(out, vec![0.0, 0.0, 0.0, 0.0]);

        // 4-channel downmix to stereo
        let fmt_4ch = StreamAudioFormat {
            sample_rate: 48000,
            source_channels: 4,
            output_channels: 2,
            bits_per_sample: 16,
            block_align: 8,
            encoding: SampleEncoding::Pcm16,
        };
        let mut raw4 = Vec::new();
        for s in [16384i16, -16384i16, 16384i16, -16384i16] {
            raw4.extend_from_slice(&s.to_le_bytes());
        }
        decode_packet_to_interleaved_f32(&raw4, 1, fmt_4ch, false, &mut out);
        assert_eq!(out.len(), 2);
        assert!((out[0] - 0.5).abs() < 1e-3);
        assert!((out[1] + 0.5).abs() < 1e-3);
    }

    #[test]
    fn streaming_wav_writer_patches_valid_header_and_skips_paused_segments() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("record_pause_resume.wav");
        let sr = 48_000u32;
        let ch = 2u16;
        let mut writer = StreamingWavWriter::create(&path, sr, ch).unwrap();

        // Segment 1: 3 seconds of 440 Hz tone
        let seg_frames = sr as usize * 3;
        let mut buf = Vec::with_capacity(seg_frames * 2);
        for i in 0..seg_frames {
            let v = 0.35 * (2.0 * PI * 440.0 * (i as f32 / sr as f32)).sin();
            buf.push(v);
            buf.push(v);
        }
        assert!(writer.write_interleaved_f32(&buf).unwrap());
        writer.flush_header().unwrap();

        // Simulated 2-second pause: ZERO writes!
        let paused_frames = writer.total_frames();
        assert_eq!(paused_frames, sr as u64 * 3);

        // Segment 2 (resumed): 3 seconds of 880 Hz tone
        buf.clear();
        for i in 0..seg_frames {
            let v = 0.35 * (2.0 * PI * 880.0 * (i as f32 / sr as f32)).sin();
            buf.push(v);
            buf.push(v);
        }
        assert!(writer.write_interleaved_f32(&buf).unwrap());

        let info = writer.finalize().unwrap();
        assert!((info.duration_sec - 6.0).abs() < 1e-6);
        assert_eq!(info.total_frames, sr as u64 * 6);
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(bytes.len() as u64, info.byte_size);
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        let data_sz = u32::from_le_bytes([bytes[40], bytes[41], bytes[42], bytes[43]]);
        assert_eq!(data_sz, sr * 6 * 2 * 2);
    }
}
