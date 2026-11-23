//! Windows Imaging Component (WIC) bridge for HEIC/HEIF capability detection,
//! decoding, and optional encoding on Windows 11.
//!
//! Capabilities for decoding and encoding are probed separately at runtime on a
//! dedicated STA thread and cached for the process lifetime so missing Store
//! extensions (HEIF Image Extensions / HEVC Video Extensions) are reported
//! accurately without failing other images in a batch.

use crate::error::AppError;
use image::RgbaImage;
use serde::Serialize;
use std::path::Path;
use std::sync::OnceLock;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeicCapabilities {
    pub decode_available: bool,
    pub encode_available: bool,
    pub decode_note: String,
    pub encode_note: String,
}

#[derive(Debug)]
pub struct WicDecodedImage {
    pub rgba: RgbaImage,
    pub exif_orientation: u16,
    pub icc_profile: Option<Vec<u8>>,
}

static HEIC_CAPS_CACHE: OnceLock<HeicCapabilities> = OnceLock::new();

pub fn get_heic_capabilities() -> HeicCapabilities {
    HEIC_CAPS_CACHE
        .get_or_init(probe_heic_capabilities_uncached)
        .clone()
}

#[cfg(not(windows))]
fn probe_heic_capabilities_uncached() -> HeicCapabilities {
    HeicCapabilities {
        decode_available: false,
        encode_available: false,
        decode_note: "Windows Imaging Component (WIC) is only available on Windows.".into(),
        encode_note: "Windows Imaging Component (WIC) is only available on Windows.".into(),
    }
}

#[cfg(not(windows))]
pub fn decode_heic_file_via_wic(_path: &Path) -> Result<WicDecodedImage, AppError> {
    Err(AppError::decode_failed(
        "HEIC decoding requires Windows Imaging Component (WIC) on Windows.",
    ))
}

#[cfg(not(windows))]
pub fn encode_heic_bytes_via_wic(
    _rgba: &RgbaImage,
    _quality: u8,
    _icc: Option<&[u8]>,
) -> Result<Vec<u8>, AppError> {
    Err(AppError::decode_failed(
        "HEIC encoding requires Windows Imaging Component (WIC) on Windows.",
    ))
}

#[cfg(windows)]
mod win_impl {
    use super::*;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{Interface, GUID, HSTRING, PCWSTR};
    use windows::Win32::Foundation::GENERIC_READ;
    use windows::Win32::Graphics::Imaging::{
        CLSID_WICImagingFactory, GUID_ContainerFormatHeif, GUID_WICPixelFormat32bppRGBA,
        IWICBitmapCodecInfo, IWICBitmapDecoder, IWICBitmapFrameDecode, IWICColorContext,
        IWICImagingFactory, WICBitmapDitherTypeNone, WICBitmapEncoderNoCache,
        WICBitmapPaletteTypeCustom, WICColorContextProfile, WICComponentEnumerateDefault,
        WICDecodeMetadataCacheOnLoad, WICDecoder,
    };
    use windows::Win32::System::Com::StructuredStorage::{
        CreateStreamOnHGlobal, GetHGlobalFromStream, PROPBAG2, PROPVARIANT,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IEnumUnknown, IStream,
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STREAM_SEEK_SET,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    use windows::Win32::System::Variant::VARIANT;

    struct ComStaGuard {
        should_uninit: bool,
    }

    impl ComStaGuard {
        fn enter() -> Result<Self, String> {
            let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            if hr.is_ok() {
                Ok(Self {
                    should_uninit: true,
                })
            } else if hr.0 == 0x8001_0106u32 as i32 {
                // RPC_E_CHANGED_MODE: thread already initialized as MTA; WIC factory still works
                Ok(Self {
                    should_uninit: false,
                })
            } else {
                Err(format!("COM initialization failed (0x{:08X})", hr.0 as u32))
            }
        }
    }

    impl Drop for ComStaGuard {
        fn drop(&mut self) {
            if self.should_uninit {
                unsafe { CoUninitialize() };
            }
        }
    }

    fn run_on_sta<T, F>(f: F) -> T
    where
        T: Send + 'static,
        F: FnOnce() -> T + Send + 'static,
    {
        std::thread::spawn(f)
            .join()
            .expect("WIC STA helper thread panicked")
    }

    fn create_wic_factory() -> Result<IWICImagingFactory, String> {
        unsafe {
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("Failed creating WIC factory: {e}"))
        }
    }

    fn check_heif_decoder_registered(factory: &IWICImagingFactory) -> bool {
        unsafe {
            let enumerator: IEnumUnknown = match factory.CreateComponentEnumerator(
                WICDecoder.0 as u32,
                WICComponentEnumerateDefault.0 as u32,
            ) {
                Ok(e) => e,
                Err(_) => return false,
            };
            loop {
                let mut batch = [None];
                let mut fetched = 0u32;
                let hr = enumerator.Next(&mut batch, Some(&mut fetched));
                if fetched == 0 || hr.is_err() {
                    break;
                }
                if let Some(unk) = &batch[0] {
                    if let Ok(codec) = unk.cast::<IWICBitmapCodecInfo>() {
                        if let Ok(container) = codec.GetContainerFormat() {
                            if container == GUID_ContainerFormatHeif {
                                return true;
                            }
                        }
                        let mut needed = 0u32;
                        if codec.GetFileExtensions(&mut [], &mut needed).is_ok() && needed > 0 {
                            let mut buf = vec![0u16; needed as usize];
                            if codec.GetFileExtensions(&mut buf, &mut needed).is_ok() {
                                let exts = String::from_utf16_lossy(&buf).to_ascii_lowercase();
                                if exts.contains(".heic") || exts.contains(".heif") {
                                    return true;
                                }
                            }
                        }
                    }
                }
            }
            false
        }
    }

    fn extract_frame_icc(
        factory: &IWICImagingFactory,
        frame: &IWICBitmapFrameDecode,
    ) -> Option<Vec<u8>> {
        unsafe {
            let mut count = 0u32;
            frame.GetColorContexts(&mut [], &mut count).ok()?;
            if count == 0 {
                return None;
            }
            let cap = (count as usize).min(4);
            let mut contexts: Vec<Option<IWICColorContext>> = Vec::with_capacity(cap);
            for _ in 0..cap {
                if let Ok(cc) = factory.CreateColorContext() {
                    contexts.push(Some(cc));
                }
            }
            if contexts.is_empty() {
                return None;
            }
            let mut actual = 0u32;
            frame.GetColorContexts(&mut contexts, &mut actual).ok()?;
            for cc_opt in contexts.into_iter().take(actual as usize) {
                let Some(cc) = cc_opt else { continue };
                if cc.GetType().ok() == Some(WICColorContextProfile) {
                    let mut len = 0u32;
                    if cc.GetProfileBytes(&mut [], &mut len).is_ok()
                        && len > 0
                        && len <= 4 * 1024 * 1024
                    {
                        let mut buf = vec![0u8; len as usize];
                        if cc.GetProfileBytes(&mut buf, &mut len).is_ok() {
                            buf.truncate(len as usize);
                            return Some(buf);
                        }
                    }
                }
            }
            None
        }
    }

    fn read_frame_orientation(frame: &IWICBitmapFrameDecode) -> u16 {
        unsafe {
            let Ok(reader) = frame.GetMetadataQueryReader() else {
                return 1;
            };
            for query in [
                "/app1/ifd/{ushort=274}",
                "/ifd/{ushort=274}",
                "System.Photo.Orientation",
            ] {
                let q_wide: Vec<u16> = OsStr::new(query).encode_wide().chain(Some(0)).collect();
                let mut val = PROPVARIANT::default();
                if reader
                    .GetMetadataByName(PCWSTR(q_wide.as_ptr()), &mut val)
                    .is_ok()
                {
                    if let Ok(o) = u16::try_from(&val) {
                        if (1..=8).contains(&o) {
                            return o;
                        }
                    }
                    if let Ok(o32) = u32::try_from(&val) {
                        if (1..=8).contains(&o32) {
                            return o32 as u16;
                        }
                    }
                }
            }
            1
        }
    }

    fn decode_from_wic_decoder(
        factory: &IWICImagingFactory,
        decoder: &IWICBitmapDecoder,
    ) -> Result<WicDecodedImage, String> {
        unsafe {
            let frame = decoder
                .GetFrame(0)
                .map_err(|e| format!("Failed reading HEIC frame 0: {e}"))?;
            let mut width = 0u32;
            let mut height = 0u32;
            frame
                .GetSize(&mut width, &mut height)
                .map_err(|e| format!("Failed reading HEIC dimensions: {e}"))?;
            if width == 0 || height == 0 {
                return Err("Decoded HEIC has zero dimensions.".into());
            }
            if (width as u64) * (height as u64) > 100_000_000 {
                return Err(format!(
                    "HEIC image dimensions ({width}×{height}) exceed 100 MP safety limit."
                ));
            }
            let orientation = read_frame_orientation(&frame);
            let icc_profile = extract_frame_icc(factory, &frame);

            let converter = factory
                .CreateFormatConverter()
                .map_err(|e| format!("Failed creating WIC format converter: {e}"))?;
            converter
                .Initialize(
                    &frame,
                    &GUID_WICPixelFormat32bppRGBA,
                    WICBitmapDitherTypeNone,
                    None,
                    0.0,
                    WICBitmapPaletteTypeCustom,
                )
                .map_err(|e| format!("Failed converting HEIC pixel format to RGBA: {e}"))?;

            let stride = width
                .checked_mul(4)
                .ok_or_else(|| "HEIC stride overflow.".to_string())?;
            let total_bytes = (stride as usize)
                .checked_mul(height as usize)
                .ok_or_else(|| "HEIC buffer size overflow.".to_string())?;
            let mut pixels = vec![0u8; total_bytes];
            converter
                .CopyPixels(std::ptr::null(), stride, &mut pixels)
                .map_err(|e| format!("Failed copying HEIC pixels: {e}"))?;

            let rgba = RgbaImage::from_raw(width, height, pixels)
                .ok_or_else(|| "Decoded HEIC buffer length mismatch.".to_string())?;
            Ok(WicDecodedImage {
                rgba,
                exif_orientation: orientation,
                icc_profile,
            })
        }
    }

    fn encode_heif_in_memory(
        factory: &IWICImagingFactory,
        rgba: &RgbaImage,
        quality: u8,
        icc: Option<&[u8]>,
    ) -> Result<Vec<u8>, String> {
        unsafe {
            let stream: IStream = CreateStreamOnHGlobal(Default::default(), true)
                .map_err(|e| format!("Failed creating memory stream for HEIC encode: {e}"))?;
            let encoder = factory
                .CreateEncoder(&GUID_ContainerFormatHeif, std::ptr::null::<GUID>())
                .map_err(|e| {
                    format!(
                        "Windows HEIF/HEVC encoder is unavailable (install HEIF Image Extensions & HEVC Video Extensions): {e}"
                    )
                })?;
            encoder
                .Initialize(&stream, WICBitmapEncoderNoCache)
                .map_err(|e| format!("Failed initializing HEIF encoder: {e}"))?;

            let mut frame = None;
            let mut prop_bag = None;
            encoder
                .CreateNewFrame(&mut frame, &mut prop_bag)
                .map_err(|e| format!("Failed creating HEIF encoder frame: {e}"))?;
            let frame =
                frame.ok_or_else(|| "WIC returned empty HEIF encoder frame.".to_string())?;

            if let Some(ref bag) = prop_bag {
                let mut prop_name: Vec<u16> = OsStr::new("ImageQuality")
                    .encode_wide()
                    .chain(Some(0))
                    .collect();
                let opt = PROPBAG2 {
                    pstrName: windows::core::PWSTR(prop_name.as_mut_ptr()),
                    ..Default::default()
                };
                let q_val: f32 = (quality.clamp(1, 100) as f32) / 100.0;
                let var = VARIANT::from(q_val);
                let _ = bag.Write(1, &opt, &var);
            }

            frame
                .Initialize(prop_bag.as_ref())
                .map_err(|e| format!("Failed initializing HEIF frame: {e}"))?;
            frame
                .SetSize(rgba.width(), rgba.height())
                .map_err(|e| format!("Failed setting HEIF frame size: {e}"))?;

            let mut pix_fmt = GUID_WICPixelFormat32bppRGBA;
            frame
                .SetPixelFormat(&mut pix_fmt)
                .map_err(|e| format!("Failed setting HEIF pixel format: {e}"))?;

            if let Some(icc_bytes) = icc {
                if let Ok(cc) = factory.CreateColorContext() {
                    if cc.InitializeFromMemory(icc_bytes).is_ok() {
                        let _ = frame.SetColorContexts(&[Some(cc)]);
                    }
                }
            }

            let stride = rgba.width() * 4;
            let raw = rgba.as_raw();
            frame
                .WritePixels(rgba.height(), stride, raw)
                .map_err(|e| format!("Failed writing HEIF pixels: {e}"))?;
            frame.Commit().map_err(|e| {
                format!("Failed committing HEIF frame (HEVC encoder may be missing): {e}")
            })?;
            encoder
                .Commit()
                .map_err(|e| format!("Failed finalizing HEIF container: {e}"))?;

            let _ = stream.Seek(0, STREAM_SEEK_SET, None);
            let hglobal = GetHGlobalFromStream(&stream)
                .map_err(|e| format!("Failed retrieving HEIF stream memory: {e}"))?;
            let size = GlobalSize(hglobal);
            if size == 0 {
                return Err("HEIF encoder produced empty output.".into());
            }
            let ptr = GlobalLock(hglobal);
            if ptr.is_null() {
                return Err("Failed locking HEIF stream memory.".into());
            }
            let slice = std::slice::from_raw_parts(ptr as *const u8, size);
            let out = slice.to_vec();
            let _ = GlobalUnlock(hglobal);
            Ok(out)
        }
    }

    pub fn probe_heic_capabilities_uncached() -> HeicCapabilities {
        run_on_sta(|| {
            let Ok(_guard) = ComStaGuard::enter() else {
                return HeicCapabilities {
                    decode_available: false,
                    encode_available: false,
                    decode_note: "COM STA initialization failed for WIC probe.".into(),
                    encode_note: "COM STA initialization failed for WIC probe.".into(),
                };
            };
            let factory = match create_wic_factory() {
                Ok(f) => f,
                Err(e) => {
                    return HeicCapabilities {
                        decode_available: false,
                        encode_available: false,
                        decode_note: e.clone(),
                        encode_note: e,
                    };
                }
            };

            let decoder_registered = check_heif_decoder_registered(&factory);

            // Real end-to-end 16x16 HEIC encode probe
            let probe_img = RgbaImage::from_fn(16, 16, |x, y| {
                image::Rgba([(x * 15) as u8, (y * 15) as u8, 128, 255])
            });
            let encoded_probe = encode_heif_in_memory(&factory, &probe_img, 85, None);

            let (encode_available, encode_note) = match &encoded_probe {
                Ok(bytes) if bytes.len() > 32 => (
                    true,
                    format!(
                        "Windows WIC HEIF/HEVC encoder verified ({} B test frame).",
                        bytes.len()
                    ),
                ),
                Ok(_) => (
                    false,
                    "Windows HEIF encoder produced invalid probe output.".into(),
                ),
                Err(err) => (false, err.clone()),
            };

            // If we encoded a real probe HEIC, verify end-to-end WIC decode on it!
            let (decode_available, decode_note) = if let Ok(ref heic_bytes) = encoded_probe {
                unsafe {
                    match CreateStreamOnHGlobal(Default::default(), true) {
                        Ok(stream) => {
                            let mut written = 0u32;
                            let hr_write = stream.Write(
                                heic_bytes.as_ptr() as *const _,
                                heic_bytes.len() as u32,
                                Some(&mut written),
                            );
                            let _ = stream.Seek(0, STREAM_SEEK_SET, None);
                            if hr_write.is_ok() {
                                match factory.CreateDecoderFromStream(
                                    &stream,
                                    std::ptr::null(),
                                    WICDecodeMetadataCacheOnLoad,
                                ) {
                                    Ok(dec) => match decode_from_wic_decoder(&factory, &dec) {
                                        Ok(img)
                                            if img.rgba.width() == 16 && img.rgba.height() == 16 =>
                                        {
                                            (
                                                true,
                                                "Windows WIC HEIF/HEVC decoder verified end-to-end."
                                                    .into(),
                                            )
                                        }
                                        Ok(_) => (
                                            false,
                                            "Windows WIC HEIF decoder returned unexpected probe size."
                                                .into(),
                                        ),
                                        Err(e) => (false, e),
                                    },
                                    Err(e) => (
                                        false,
                                        format!("Windows WIC HEIF decoder unavailable: {e}"),
                                    ),
                                }
                            } else {
                                (
                                    decoder_registered,
                                    if decoder_registered {
                                        "Windows HEIF decoder registered (stream probe skipped)."
                                            .into()
                                    } else {
                                        "Windows HEIF Image Extensions not installed.".into()
                                    },
                                )
                            }
                        }
                        Err(_) => (
                            decoder_registered,
                            if decoder_registered {
                                "Windows HEIF decoder registered.".into()
                            } else {
                                "Windows HEIF Image Extensions not installed.".into()
                            },
                        ),
                    }
                }
            } else if decoder_registered {
                (
                    true,
                    "Windows HEIF decoder registered (HEVC decoding still requires Microsoft HEVC Video Extensions)."
                        .into(),
                )
            } else {
                (
                    false,
                    "Windows HEIF Image Extensions not detected on this machine.".into(),
                )
            };

            HeicCapabilities {
                decode_available,
                encode_available,
                decode_note,
                encode_note,
            }
        })
    }

    pub fn decode_heic_file_via_wic(path: &Path) -> Result<WicDecodedImage, AppError> {
        let owned_path = path.to_path_buf();
        run_on_sta(move || {
            let _guard = ComStaGuard::enter().map_err(AppError::decode_failed)?;
            let factory = create_wic_factory().map_err(AppError::decode_failed)?;
            let hpath = HSTRING::from(owned_path.as_os_str());
            let decoder = unsafe {
                factory.CreateDecoderFromFilename(
                    PCWSTR(hpath.as_ptr()),
                    None,
                    GENERIC_READ,
                    WICDecodeMetadataCacheOnLoad,
                )
            }
            .map_err(|e| {
                AppError::decode_failed(format!(
                    "Cannot decode HEIC image via Windows WIC (install HEIF Image Extensions & HEVC Video Extensions if missing): {e}"
                ))
            })?;
            decode_from_wic_decoder(&factory, &decoder).map_err(AppError::decode_failed)
        })
    }

    pub fn encode_heic_bytes_via_wic(
        rgba: &RgbaImage,
        quality: u8,
        icc: Option<&[u8]>,
    ) -> Result<Vec<u8>, AppError> {
        let owned_rgba = rgba.clone();
        let owned_icc = icc.map(|b| b.to_vec());
        run_on_sta(move || {
            let _guard = ComStaGuard::enter().map_err(AppError::decode_failed)?;
            let factory = create_wic_factory().map_err(AppError::decode_failed)?;
            encode_heif_in_memory(&factory, &owned_rgba, quality, owned_icc.as_deref())
                .map_err(AppError::decode_failed)
        })
    }
}

#[cfg(windows)]
pub use win_impl::{
    decode_heic_file_via_wic, encode_heic_bytes_via_wic, probe_heic_capabilities_uncached,
};

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn probes_windows_wic_heic_decode_and_encode_separately() {
        let caps = get_heic_capabilities();
        println!(
            "Host WIC HEIC capabilities: decode={} ({}) | encode={} ({})",
            caps.decode_available, caps.decode_note, caps.encode_available, caps.encode_note
        );
        if caps.encode_available && caps.decode_available {
            // Verify full HEIC encode -> file -> WIC decode pixel roundtrip on this Windows 11 host!
            let src = RgbaImage::from_fn(32, 24, |x, y| {
                image::Rgba([(x * 7) as u8, (y * 9) as u8, 200, 255])
            });
            let heic_bytes = encode_heic_bytes_via_wic(&src, 90, None).expect("encode HEIC");
            assert!(heic_bytes.len() > 64);
            let dir = tempdir().expect("tempdir");
            let heic_path = dir.path().join("probe_phone.heic");
            std::fs::write(&heic_path, &heic_bytes).expect("write heic");
            let decoded = decode_heic_file_via_wic(&heic_path).expect("decode HEIC");
            assert_eq!(decoded.rgba.width(), 32);
            assert_eq!(decoded.rgba.height(), 24);
        }
    }
}
