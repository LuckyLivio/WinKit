use crate::error::AppError;
use crate::fs_guard::{validate_existing_input_file, write_output_bytes_safely};
use crate::tasks::TaskRegistry;
use arboard::Clipboard;
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, ImageDecoder};
use std::io::{Cursor, Read};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{ipc::Response, State, Url};

const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_SIDE: u32 = 8192;
const MAX_PIXELS: u64 = 16_000_000;

fn size_error() -> AppError {
    AppError::size_limit("Image exceeds the permitted dimensions or byte limit.")
}

fn image_error() -> AppError {
    AppError::decode_failed("Unsupported or invalid image.")
}

fn clipboard_error() -> AppError {
    AppError::new(
        "CLIPBOARD_UNAVAILABLE",
        "Unable to access the system clipboard.",
    )
}

fn check_dimensions(width: u32, height: u32) -> Result<(), AppError> {
    if width == 0
        || height == 0
        || width > MAX_SIDE
        || height > MAX_SIDE
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err(size_error());
    }
    Ok(())
}

fn decode_payload(data: &str) -> Result<Vec<u8>, AppError> {
    if data.is_empty() || data.len() > MAX_BYTES.div_ceil(3) * 4 {
        return Err(size_error());
    }
    let bytes = STANDARD.decode(data).map_err(|_| image_error())?;
    if bytes.len() > MAX_BYTES {
        return Err(size_error());
    }
    Ok(bytes)
}

fn read_image_file(path: &str, cancelled: &AtomicBool) -> Result<Vec<u8>, AppError> {
    let deadline = Instant::now() + Duration::from_secs(10);
    let (path, len) = validate_existing_input_file(path)?;
    if len > MAX_BYTES as u64 {
        return Err(size_error());
    }
    let mut file =
        std::fs::File::open(path).map_err(|e| AppError::from_io(e, "Unable to open image"))?;
    let mut bytes = Vec::with_capacity(len as usize);
    let mut chunk = [0u8; 64 * 1024];
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err(AppError::cancelled());
        }
        if Instant::now() >= deadline {
            return Err(AppError::new("TIMEOUT", "Image read timed out."));
        }
        let count = file
            .read(&mut chunk)
            .map_err(|e| AppError::from_io(e, "Unable to read image"))?;
        if count == 0 {
            break;
        }
        if bytes.len() + count > MAX_BYTES {
            return Err(size_error());
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    match image::guess_format(&bytes) {
        Ok(image::ImageFormat::Png | image::ImageFormat::Jpeg | image::ImageFormat::WebP) => {
            Ok(bytes)
        }
        _ => Err(image_error()),
    }
}

async fn background<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|_| AppError::new("INTERNAL_JOIN_ERROR", "Image operation failed."))?
}

#[tauri::command]
pub(crate) async fn qr_read_image_file(
    registry: State<'_, TaskRegistry>,
    path: String,
    task_id: String,
) -> Result<Response, AppError> {
    let guard = registry.register_checked(&task_id, "F01", true)?;
    background(move || read_image_file(&path, &guard.cancel_flag()).map(Response::new)).await
}

#[cfg(any(windows, test))]
fn check_dib_header(header: &[u8]) -> Result<(), AppError> {
    if header.len() < 12 {
        return Err(image_error());
    }
    let size = u32::from_le_bytes(header[..4].try_into().unwrap());
    if !matches!(size, 40 | 52 | 56 | 108 | 124) {
        return Err(image_error());
    }
    let width = i32::from_le_bytes(header[4..8].try_into().unwrap());
    let height = i32::from_le_bytes(header[8..12].try_into().unwrap());
    if width <= 0 {
        return Err(image_error());
    }
    check_dimensions(width as u32, height.unsigned_abs())
}

#[cfg(any(windows, test))]
fn dib_to_png(bytes: &[u8]) -> Result<Vec<u8>, AppError> {
    use image::codecs::{
        bmp::BmpDecoder,
        png::{CompressionType, FilterType, PngEncoder},
    };
    check_dib_header(bytes)?;
    let decoder =
        BmpDecoder::new_without_file_header(Cursor::new(bytes)).map_err(|_| image_error())?;
    let (width, height) = decoder.dimensions();
    check_dimensions(width, height)?;
    let image = DynamicImage::from_decoder(decoder).map_err(|_| image_error())?;
    let mut png = Vec::new();
    image
        .write_with_encoder(PngEncoder::new_with_quality(
            &mut png,
            CompressionType::Fast,
            FilterType::Sub,
        ))
        .map_err(|_| image_error())?;
    if png.len() > MAX_BYTES {
        return Err(size_error());
    }
    Ok(png)
}

#[cfg(windows)]
fn clipboard_image() -> Result<Vec<u8>, AppError> {
    use clipboard_win::{formats, is_format_avail, raw, register_format};
    let lock = clipboard_win::Clipboard::new_attempts(10).map_err(|_| clipboard_error())?;
    let png = register_format("PNG")
        .map(|id| id.get())
        .filter(|&id| is_format_avail(id));
    let format = png
        .or_else(|| {
            [formats::CF_DIBV5, formats::CF_DIB]
                .into_iter()
                .find(|&id| is_format_avail(id))
        })
        .ok_or_else(image_error)?;
    let len = raw::size(format).ok_or_else(image_error)?.get();
    if png.is_some() {
        if len > MAX_BYTES {
            return Err(size_error());
        }
    } else {
        if len as u64 > MAX_PIXELS * 4 + 4096 {
            return Err(size_error());
        }
        let mut header = [0u8; 12];
        let n = raw::get(format, &mut header).map_err(|_| clipboard_error())?;
        check_dib_header(&header[..n])?;
    }
    let mut bytes = vec![0u8; len];
    let count = raw::get(format, &mut bytes).map_err(|_| clipboard_error())?;
    drop(lock);
    bytes.truncate(count);
    if png.is_some() {
        // The Worker checks PNG dimensions before creating an image bitmap.
        return Ok(bytes);
    }
    dib_to_png(&bytes)
}

#[tauri::command]
pub(crate) async fn qr_read_clipboard_image(
    registry: State<'_, TaskRegistry>,
) -> Result<Response, AppError> {
    registry.ensure_not_shutting_down()?;
    #[cfg(windows)]
    {
        background(|| clipboard_image().map(Response::new)).await
    }
    #[cfg(not(windows))]
    {
        Err(clipboard_error())
    }
}

fn copy_image(bytes: &[u8]) -> Result<(), AppError> {
    let decoder =
        image::codecs::png::PngDecoder::new(Cursor::new(bytes)).map_err(|_| image_error())?;
    let (width, height) = decoder.dimensions();
    check_dimensions(width, height)?;
    let image = DynamicImage::from_decoder(decoder).map_err(|_| image_error())?;
    #[cfg(windows)]
    {
        use clipboard_win::{formats, raw, register_format};
        // Paint consumes CF_DIB, while web and office applications also accept PNG.
        // Generated QR pixels are opaque, so a 24-bit DIB preserves every module.
        let mut bmp = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(image.into_rgb8())
            .write_to(&mut bmp, image::ImageFormat::Bmp)
            .map_err(|_| image_error())?;
        let exclude = register_format("ExcludeClipboardContentFromMonitorProcessing")
            .ok_or_else(clipboard_error)?;
        let png = register_format("PNG").ok_or_else(clipboard_error)?;
        let _lock = clipboard_win::Clipboard::new_attempts(10).map_err(|_| clipboard_error())?;
        raw::empty().map_err(|_| clipboard_error())?;
        raw::set_without_clear(exclude.get(), &0u32.to_ne_bytes())
            .map_err(|_| clipboard_error())?;
        raw::set_without_clear(png.get(), bytes).map_err(|_| clipboard_error())?;
        // CF_DIB begins with BITMAPINFO, omitting the 14-byte BITMAPFILEHEADER.
        raw::set_without_clear(formats::CF_DIB, &bmp.get_ref()[14..]).map_err(|_| clipboard_error())
    }
    #[cfg(not(windows))]
    {
        Clipboard::new()
            .map_err(|_| clipboard_error())?
            .set_image(arboard::ImageData {
                width: width as usize,
                height: height as usize,
                bytes: image.into_rgba8().into_raw().into(),
            })
            .map_err(|_| clipboard_error())
    }
}

#[tauri::command]
pub(crate) async fn qr_copy_image(
    registry: State<'_, TaskRegistry>,
    data: String,
) -> Result<(), AppError> {
    let guard =
        registry.register_checked(&crate::next_internal_task_id("qr-copy"), "F01", false)?;
    background(move || {
        let _guard = guard;
        copy_image(&decode_payload(&data)?)
    })
    .await
}

#[tauri::command]
pub(crate) fn qr_copy_text(
    registry: State<'_, TaskRegistry>,
    text: String,
) -> Result<(), AppError> {
    registry.ensure_not_shutting_down()?;
    let mut clipboard = Clipboard::new().map_err(|_| clipboard_error())?;
    let setter = clipboard.set();
    #[cfg(windows)]
    let setter = arboard::SetExtWindows::exclude_from_monitoring(setter);
    setter.text(text).map_err(|_| clipboard_error())
}

#[tauri::command]
pub(crate) async fn qr_save_image(
    registry: State<'_, TaskRegistry>,
    path: String,
    format: String,
    data: String,
    overwrite: bool,
) -> Result<(), AppError> {
    let guard =
        registry.register_checked(&crate::next_internal_task_id("qr-save"), "F01", false)?;
    background(move || {
        let _guard = guard;
        if !matches!(format.as_str(), "png" | "svg")
            || !Path::new(&path)
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case(&format))
        {
            return Err(AppError::invalid_param(
                "Select a filename with the matching PNG or SVG extension.",
            ));
        }
        let bytes = decode_payload(&data)?;
        write_output_bytes_safely(&path, None, &bytes, overwrite).map(|_| ())
    })
    .await
}

fn parse_http_url(raw: &str) -> Result<Url, AppError> {
    let invalid = || AppError::invalid_param("Only HTTP and HTTPS links can be opened.");
    if raw.chars().any(char::is_control) {
        return Err(invalid());
    }
    let url = Url::parse(raw).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https") || !url.has_host() {
        return Err(invalid());
    }
    Ok(url)
}

#[tauri::command]
pub(crate) async fn qr_open_http_url(
    registry: State<'_, TaskRegistry>,
    url: String,
) -> Result<(), AppError> {
    registry.ensure_not_shutting_down()?;
    let url = parse_http_url(&url)?;
    background(move || {
        let failure = || AppError::new("OPEN_FAILED", "Unable to start the default browser.");
        #[cfg(windows)]
        {
            use std::ptr::{null, null_mut};
            use windows_sys::Win32::UI::{
                Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL,
            };
            let wide: Vec<u16> = url
                .as_str()
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            // ShellExecute opens the registered HTTP(S) handler. Its file argument is a
            // validated NUL-terminated URL; no command interpreter or parameter string is used.
            let status = unsafe {
                ShellExecuteW(
                    null_mut(),
                    null(),
                    wide.as_ptr(),
                    null(),
                    null(),
                    SW_SHOWNORMAL,
                )
            };
            if status as isize <= 32 {
                return Err(failure());
            }
        }
        #[cfg(not(windows))]
        {
            let status = std::process::Command::new("xdg-open")
                .arg(url.as_str())
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map_err(|_| failure())?;
            if !status.success() {
                return Err(failure());
            }
        }
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_only_http_and_https() {
        for url in ["https://example.org/?q=a&b=2", "http://127.0.0.1/"] {
            assert_eq!(parse_http_url(url).unwrap().as_str(), url);
        }
        for url in [
            "file:///C:/temp/file",
            "javascript:alert(1)",
            "shell:startup",
            "//example.org",
            "https://example.org/\n",
        ] {
            assert!(parse_http_url(url).is_err());
        }
    }

    #[test]
    fn bounded_file_reader_rejects_cancelled_and_oversized_images() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let path = file.path().to_str().unwrap();
        let cancel = AtomicBool::new(true);
        assert_eq!(
            read_image_file(path, &cancel).unwrap_err().code,
            "TASK_CANCELLED"
        );
        cancel.store(false, Ordering::Relaxed);
        file.as_file().set_len(MAX_BYTES as u64 + 1).unwrap();
        assert_eq!(
            read_image_file(path, &cancel).unwrap_err().code,
            "SIZE_LIMIT_EXCEEDED"
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "replaces the system clipboard; run on a dedicated Windows runner"]
    fn windows_clipboard_roundtrip() {
        use clipboard_win::{formats, raw, register_format};
        let original =
            image::RgbImage::from_fn(4, 3, |x, y| image::Rgb([x as u8 * 24, y as u8 * 83, 233]));
        let mut png = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(original.clone())
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        copy_image(png.get_ref()).unwrap();
        let result = image::load_from_memory(&clipboard_image().unwrap())
            .unwrap()
            .into_rgb8();
        assert_eq!(result, original);

        let _lock = clipboard_win::Clipboard::new_attempts(10).unwrap();
        let mut dib = Vec::new();
        raw::get_vec(formats::CF_DIB, &mut dib).unwrap();
        let bitmap = image::load_from_memory(&dib_to_png(&dib).unwrap())
            .unwrap()
            .into_rgb8();
        assert_eq!(bitmap, original);
        let exclusion = register_format("ExcludeClipboardContentFromMonitorProcessing").unwrap();
        assert!(clipboard_win::is_format_avail(exclusion.get()));
    }

    #[test]
    fn checks_dib_size_before_reading_pixels_and_converts_bgr() {
        let mut dib = [0u8; 44];
        dib[..4].copy_from_slice(&40u32.to_le_bytes());
        dib[4..8].copy_from_slice(&1i32.to_le_bytes());
        dib[8..12].copy_from_slice(&(-1i32).to_le_bytes());
        dib[12..14].copy_from_slice(&1u16.to_le_bytes());
        dib[14..16].copy_from_slice(&24u16.to_le_bytes());
        dib[40..43].copy_from_slice(&[42, 99, 167]);
        let png = dib_to_png(&dib).unwrap();
        let pixel = image::load_from_memory(&png).unwrap().into_rgb8();
        assert_eq!(pixel.get_pixel(0, 0).0, [167, 99, 42]);
        dib[8..12].copy_from_slice(&i32::MIN.to_le_bytes());
        assert_eq!(
            check_dib_header(&dib[..12]).unwrap_err().code,
            "SIZE_LIMIT_EXCEEDED"
        );
        assert!(check_dib_header(&dib[..11]).is_err());
        assert!(check_dimensions(8192, 8192).is_err());
    }
}
