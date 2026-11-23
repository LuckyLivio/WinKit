//! In-memory ephemeral image pipeline store and native Windows image clipboard helpers.
//!
//! Enables original-resolution handoff across I01 (Capture), I11 (Redact), I12 (Annotate),
//! I03 (Beautify), and I13 (Watermark) strictly in RAM without writing intermediate files
//! to disk. Bounded by item count and total byte ceiling (LRU eviction).

use crate::error::AppError;
use crate::fs_guard::write_output_bytes_cancellable;
use crate::image_core::{composite_rgba_over_rgb, decode_image_to_display, encode_jpeg_bytes};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::codecs::png::{CompressionType, FilterType as PngFilterType, PngEncoder};
use image::{ColorType, DynamicImage, GenericImageView, ImageDecoder, ImageEncoder, RgbaImage};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::Cursor;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub const MAX_ASSET_BYTES: usize = 64 * 1024 * 1024; // 64 MiB single PNG ceiling
pub const MAX_ASSET_SIDE: u32 = 16_384; // Supports ultra-tall long screenshots
pub const MAX_ASSET_PIXELS: u64 = 48_000_000; // 48 MP (~192 MB RGBA)
const MAX_STORE_ITEMS: usize = 24;
const MAX_STORE_TOTAL_BYTES: usize = 192 * 1024 * 1024; // 192 MiB total RAM cap

static ASSET_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAssetPayload {
    pub asset_id: String,
    pub label: String,
    pub width: u32,
    pub height: u32,
    pub has_alpha: bool,
    pub byte_length: usize,
    pub data_url: String,
}

#[derive(Debug, Clone)]
struct StoredAsset {
    id: String,
    label: String,
    width: u32,
    height: u32,
    has_alpha: bool,
    png_bytes: Vec<u8>,
}

#[derive(Clone, Default)]
pub struct ImageAssetStore {
    inner: Arc<Mutex<VecDeque<StoredAsset>>>,
}

pub fn check_asset_dimensions(width: u32, height: u32) -> Result<(), AppError> {
    if width == 0
        || height == 0
        || width > MAX_ASSET_SIDE
        || height > MAX_ASSET_SIDE
        || u64::from(width) * u64::from(height) > MAX_ASSET_PIXELS
    {
        return Err(AppError::size_limit(format!(
            "Image dimensions ({width}x{height}) exceed safety limit ({MAX_ASSET_SIDE}px / 48 MP)."
        )));
    }
    Ok(())
}

pub fn encode_rgba_to_png_fast(rgba: &RgbaImage) -> Result<Vec<u8>, AppError> {
    let (w, h) = rgba.dimensions();
    check_asset_dimensions(w, h)?;
    let mut out = Vec::new();
    let enc = PngEncoder::new_with_quality(&mut out, CompressionType::Fast, PngFilterType::Sub);
    enc.write_image(rgba.as_raw(), w, h, ColorType::Rgba8.into())
        .map_err(|_| AppError::decode_failed("Failed to encode lossless PNG image."))?;
    if out.len() > MAX_ASSET_BYTES {
        return Err(AppError::size_limit(
            "Encoded PNG image exceeds 64 MiB memory ceiling.",
        ));
    }
    Ok(out)
}

impl ImageAssetStore {
    pub fn insert_rgba(
        &self,
        rgba: &RgbaImage,
        label: String,
    ) -> Result<ImageAssetPayload, AppError> {
        let (width, height) = rgba.dimensions();
        check_asset_dimensions(width, height)?;
        let has_alpha = rgba.pixels().any(|p| p.0[3] < 255);
        let png_bytes = encode_rgba_to_png_fast(rgba)?;
        self.insert_validated(png_bytes, label, width, height, has_alpha)
    }

    pub fn insert_png_bytes(
        &self,
        png_bytes: Vec<u8>,
        label: String,
    ) -> Result<ImageAssetPayload, AppError> {
        if png_bytes.is_empty() || png_bytes.len() > MAX_ASSET_BYTES {
            return Err(AppError::size_limit(
                "PNG payload is empty or exceeds 64 MiB memory ceiling.",
            ));
        }
        let decoder = image::codecs::png::PngDecoder::new(Cursor::new(&png_bytes))
            .map_err(|_| AppError::decode_failed("Invalid PNG payload."))?;
        let (width, height) = decoder.dimensions();
        check_asset_dimensions(width, height)?;
        let has_alpha = matches!(
            decoder.color_type(),
            ColorType::La8 | ColorType::Rgba8 | ColorType::La16 | ColorType::Rgba16
        );
        self.insert_validated(png_bytes, label, width, height, has_alpha)
    }

    fn insert_validated(
        &self,
        png_bytes: Vec<u8>,
        label: String,
        width: u32,
        height: u32,
        has_alpha: bool,
    ) -> Result<ImageAssetPayload, AppError> {
        let id = format!("mem-img-{}", ASSET_SEQ.fetch_add(1, Ordering::Relaxed));
        let byte_length = png_bytes.len();
        let data_url = format!("data:image/png;base64,{}", STANDARD.encode(&png_bytes));

        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AppError::new("INTERNAL_LOCK_ERROR", "Image store lock poisoned."))?;
        guard.push_back(StoredAsset {
            id: id.clone(),
            label: label.clone(),
            width,
            height,
            has_alpha,
            png_bytes,
        });

        let mut total_bytes: usize = guard.iter().map(|a| a.png_bytes.len()).sum();
        while guard.len() > MAX_STORE_ITEMS
            || (total_bytes > MAX_STORE_TOTAL_BYTES && guard.len() > 1)
        {
            if let Some(evicted) = guard.pop_front() {
                total_bytes = total_bytes.saturating_sub(evicted.png_bytes.len());
            } else {
                break;
            }
        }

        Ok(ImageAssetPayload {
            asset_id: id,
            label,
            width,
            height,
            has_alpha,
            byte_length,
            data_url,
        })
    }

    pub fn get_png_bytes(&self, asset_id: &str) -> Result<(Vec<u8>, String), AppError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| AppError::new("INTERNAL_LOCK_ERROR", "Image store lock poisoned."))?;
        let found = guard.iter().find(|a| a.id == asset_id).ok_or_else(|| {
            AppError::new(
                "ASSET_NOT_FOUND",
                "In-memory image session expired or missing.",
            )
        })?;
        Ok((found.png_bytes.clone(), found.label.clone()))
    }

    pub fn get_rgba(&self, asset_id: &str) -> Result<(RgbaImage, String), AppError> {
        let (bytes, label) = self.get_png_bytes(asset_id)?;
        let img = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
            .map_err(|_| AppError::decode_failed("Failed to decode in-memory PNG asset."))?;
        Ok((img.to_rgba8(), label))
    }

    pub fn get_payload(&self, asset_id: &str) -> Result<ImageAssetPayload, AppError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| AppError::new("INTERNAL_LOCK_ERROR", "Image store lock poisoned."))?;
        let found = guard.iter().find(|a| a.id == asset_id).ok_or_else(|| {
            AppError::new(
                "ASSET_NOT_FOUND",
                "In-memory image session expired or missing.",
            )
        })?;
        Ok(ImageAssetPayload {
            asset_id: found.id.clone(),
            label: found.label.clone(),
            width: found.width,
            height: found.height,
            has_alpha: found.has_alpha,
            byte_length: found.png_bytes.len(),
            data_url: format!(
                "data:image/png;base64,{}",
                STANDARD.encode(&found.png_bytes)
            ),
        })
    }
}

pub fn decode_png_data_url_or_base64(input: &str) -> Result<Vec<u8>, AppError> {
    let trimmed = input.trim();
    let b64 = trimmed
        .strip_prefix("data:image/png;base64,")
        .unwrap_or(trimmed);
    if b64.is_empty() || b64.len() > MAX_ASSET_BYTES.div_ceil(3) * 4 + 16 {
        return Err(AppError::size_limit("Encoded image payload exceeds limit."));
    }
    let bytes = STANDARD
        .decode(b64)
        .map_err(|_| AppError::decode_failed("Invalid base64 PNG image data."))?;
    if bytes.len() > MAX_ASSET_BYTES {
        return Err(AppError::size_limit("PNG payload exceeds 64 MiB limit."));
    }
    Ok(bytes)
}

pub fn load_local_image_into_store(
    store: &ImageAssetStore,
    raw_path: &str,
) -> Result<ImageAssetPayload, AppError> {
    let path = Path::new(raw_path);
    let decoded = decode_image_to_display(path)?;
    let rgba = decoded.image.to_rgba8();
    let label = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "image.png".into());
    store.insert_rgba(&rgba, label)
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SaveAssetFormat {
    Png,
    Jpeg,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedImageAssetResult {
    pub output_path: String,
    pub width: u32,
    pub height: u32,
    pub byte_length: u64,
}

pub fn save_png_bytes_to_disk(
    png_bytes: &[u8],
    output_path: &str,
    source_path: Option<&Path>,
    format: SaveAssetFormat,
    jpeg_quality: u8,
    overwrite: bool,
    cancel_flag: Option<&AtomicBool>,
) -> Result<SavedImageAssetResult, AppError> {
    let decoded = image::load_from_memory_with_format(png_bytes, image::ImageFormat::Png)
        .map_err(|_| AppError::decode_failed("Invalid PNG bytes for export."))?;
    let (width, height) = decoded.dimensions();
    check_asset_dimensions(width, height)?;

    let final_bytes = match format {
        SaveAssetFormat::Png => png_bytes.to_vec(),
        SaveAssetFormat::Jpeg => {
            let rgba = decoded.to_rgba8();
            let rgb = composite_rgba_over_rgb(&rgba, [255, 255, 255]);
            encode_jpeg_bytes(&rgb, jpeg_quality.clamp(40, 100), true, None)?
        }
    };

    let saved = write_output_bytes_cancellable(
        output_path,
        source_path,
        &final_bytes,
        overwrite,
        cancel_flag,
    )?;

    Ok(SavedImageAssetResult {
        output_path: saved.path,
        width,
        height,
        byte_length: saved.byte_length,
    })
}

fn clipboard_error() -> AppError {
    AppError::new(
        "CLIPBOARD_UNAVAILABLE",
        "Unable to access the system clipboard.",
    )
}

#[cfg(any(windows, test))]
fn check_dib_header(header: &[u8]) -> Result<(), AppError> {
    if header.len() < 12 {
        return Err(AppError::decode_failed(
            "Clipboard bitmap header truncated.",
        ));
    }
    let size = u32::from_le_bytes(header[..4].try_into().unwrap());
    if !matches!(size, 40 | 52 | 56 | 108 | 124) {
        return Err(AppError::decode_failed("Unsupported clipboard DIB format."));
    }
    let width = i32::from_le_bytes(header[4..8].try_into().unwrap());
    let height = i32::from_le_bytes(header[8..12].try_into().unwrap());
    if width <= 0 {
        return Err(AppError::decode_failed("Invalid clipboard bitmap width."));
    }
    check_asset_dimensions(width as u32, height.unsigned_abs())
}

#[cfg(any(windows, test))]
fn dib_to_png(bytes: &[u8]) -> Result<Vec<u8>, AppError> {
    use image::codecs::bmp::BmpDecoder;
    check_dib_header(bytes)?;
    let decoder = BmpDecoder::new_without_file_header(Cursor::new(bytes))
        .map_err(|_| AppError::decode_failed("Cannot decode Windows clipboard bitmap."))?;
    let (width, height) = decoder.dimensions();
    check_asset_dimensions(width, height)?;
    let img = DynamicImage::from_decoder(decoder)
        .map_err(|_| AppError::decode_failed("Failed decoding Windows clipboard bitmap."))?;
    encode_rgba_to_png_fast(&img.to_rgba8())
}

/// Copies a PNG image to the Windows clipboard as BOTH `"PNG"` (preserving alpha)
/// AND `CF_DIB` (flattened cleanly over white for Paint / Win32 apps).
pub fn copy_png_to_system_clipboard(png_bytes: &[u8]) -> Result<(), AppError> {
    let decoder = image::codecs::png::PngDecoder::new(Cursor::new(png_bytes))
        .map_err(|_| AppError::decode_failed("Invalid PNG image for clipboard."))?;
    let (width, height) = decoder.dimensions();
    check_asset_dimensions(width, height)?;
    let img = DynamicImage::from_decoder(decoder)
        .map_err(|_| AppError::decode_failed("Failed decoding PNG for clipboard."))?;

    #[cfg(windows)]
    {
        use clipboard_win::{formats, raw, register_format};
        let rgba = img.to_rgba8();
        let rgb = composite_rgba_over_rgb(&rgba, [255, 255, 255]);
        let mut bmp = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(rgb)
            .write_to(&mut bmp, image::ImageFormat::Bmp)
            .map_err(|_| AppError::decode_failed("Failed building CF_DIB bitmap."))?;

        let exclude = register_format("ExcludeClipboardContentFromMonitorProcessing")
            .ok_or_else(clipboard_error)?;
        let png_fmt = register_format("PNG").ok_or_else(clipboard_error)?;
        let _lock = clipboard_win::Clipboard::new_attempts(10).map_err(|_| clipboard_error())?;
        raw::empty().map_err(|_| clipboard_error())?;
        raw::set_without_clear(exclude.get(), &0u32.to_ne_bytes())
            .map_err(|_| clipboard_error())?;
        raw::set_without_clear(png_fmt.get(), png_bytes).map_err(|_| clipboard_error())?;
        raw::set_without_clear(formats::CF_DIB, &bmp.get_ref()[14..]).map_err(|_| clipboard_error())
    }
    #[cfg(not(windows))]
    {
        let mut cb = arboard::Clipboard::new().map_err(|_| clipboard_error())?;
        cb.set_image(arboard::ImageData {
            width: width as usize,
            height: height as usize,
            bytes: img.into_rgba8().into_raw().into(),
        })
        .map_err(|_| clipboard_error())
    }
}

/// Reads an image from the Windows clipboard (`"PNG"`, `CF_DIBV5`, or `CF_DIB`) and stores it in RAM.
pub fn read_system_clipboard_image_into_store(
    store: &ImageAssetStore,
) -> Result<ImageAssetPayload, AppError> {
    #[cfg(windows)]
    {
        use clipboard_win::{formats, is_format_avail, raw, register_format};
        let lock = clipboard_win::Clipboard::new_attempts(10).map_err(|_| clipboard_error())?;
        let png_fmt = register_format("PNG")
            .map(|id| id.get())
            .filter(|&id| is_format_avail(id));
        let format = png_fmt
            .or_else(|| {
                [formats::CF_DIBV5, formats::CF_DIB]
                    .into_iter()
                    .find(|&id| is_format_avail(id))
            })
            .ok_or_else(|| {
                AppError::decode_failed("Clipboard does not currently contain an image.")
            })?;

        let len = raw::size(format)
            .ok_or_else(|| AppError::decode_failed("Clipboard image is empty."))?
            .get();

        if png_fmt.is_some() {
            if len > MAX_ASSET_BYTES {
                return Err(AppError::size_limit("Clipboard PNG exceeds 64 MiB limit."));
            }
        } else {
            if len as u64 > MAX_ASSET_PIXELS * 4 + 4096 {
                return Err(AppError::size_limit(
                    "Clipboard bitmap exceeds 48 MP limit.",
                ));
            }
            let mut header = [0u8; 12];
            let n = raw::get(format, &mut header).map_err(|_| clipboard_error())?;
            check_dib_header(&header[..n])?;
        }

        let mut bytes = vec![0u8; len];
        let count = raw::get(format, &mut bytes).map_err(|_| clipboard_error())?;
        drop(lock);
        bytes.truncate(count);

        let png_bytes = if png_fmt.is_some() {
            // Re-validate PNG cleanly
            bytes
        } else {
            dib_to_png(&bytes)?
        };
        store.insert_png_bytes(png_bytes, "clipboard.png".into())
    }
    #[cfg(not(windows))]
    {
        let _ = store;
        Err(clipboard_error())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;
    use tempfile::tempdir;

    #[test]
    fn stores_evicts_and_exports_in_memory_image_assets_losslessly() {
        let store = ImageAssetStore::default();
        let img = RgbaImage::from_pixel(64, 48, Rgba([20, 120, 220, 180]));
        let meta = store
            .insert_rgba(&img, "capture.png".into())
            .expect("insert");
        assert_eq!((meta.width, meta.height), (64, 48));
        assert!(meta.has_alpha);
        assert!(meta.data_url.starts_with("data:image/png;base64,"));

        let (png_bytes, label) = store.get_png_bytes(&meta.asset_id).expect("get");
        assert_eq!(label, "capture.png");

        let dir = tempdir().unwrap();
        let out_png = dir.path().join("saved.png");
        let saved_png = save_png_bytes_to_disk(
            &png_bytes,
            &out_png.to_string_lossy(),
            None,
            SaveAssetFormat::Png,
            92,
            false,
            None,
        )
        .expect("save png");
        assert_eq!((saved_png.width, saved_png.height), (64, 48));
        let dec_png = image::open(&out_png).unwrap().to_rgba8();
        assert_eq!(dec_png.get_pixel(10, 10).0, [20, 120, 220, 180]);

        let out_jpg = dir.path().join("saved.jpg");
        let saved_jpg = save_png_bytes_to_disk(
            &png_bytes,
            &out_jpg.to_string_lossy(),
            None,
            SaveAssetFormat::Jpeg,
            90,
            false,
            None,
        )
        .expect("save jpg");
        assert_eq!((saved_jpg.width, saved_jpg.height), (64, 48));
        let dec_jpg = image::open(&out_jpg).unwrap().to_rgb8();
        assert_eq!(dec_jpg.dimensions(), (64, 48));
    }
}
