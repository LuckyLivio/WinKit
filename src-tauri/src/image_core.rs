//! Shared Phase 3A batch image inspection, orientation/ICC handling, safe non-overwriting
//! export, and I05 (Convert) / I06 (Compress) backends.

use crate::error::AppError;
use crate::fs_guard::validate_user_path;
use crate::wic_heic::{
    decode_heic_file_via_wic, encode_heic_bytes_via_wic, get_heic_capabilities, HeicCapabilities,
};
use base64::Engine as _;
use exif::{In, Reader as ExifReader, Tag};
use exoquant::optimizer::Optimizer;
use flate2::read::ZlibDecoder;
use image::imageops::FilterType;
use image::{ColorType, DynamicImage, GenericImageView, ImageFormat, RgbaImage};
use jpeg_encoder::{ColorType as JpegColorType, Encoder as JpegEncoder, SamplingFactor};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufReader, Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

pub const IMAGE_BATCH_PROGRESS_EVENT: &str = "winkit://image-batch-progress";
pub const MAX_IMAGE_FILE_BYTES: u64 = 128 * 1024 * 1024; // 128 MiB
pub const MAX_IMAGE_PIXELS: u64 = 100_000_000; // 100 MP
pub const MAX_BATCH_IMAGES: usize = 500;
const THUMB_MAX_EDGE: u32 = 220;
const PREVIEW_MAX_EDGE: u32 = 1600;

static IMAGE_TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

const SUPPORTED_IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "jpe", "png", "webp", "tif", "tiff", "bmp", "heic", "heif", "gif",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageFileFormat {
    Jpeg,
    Png,
    Webp,
    Tiff,
    Bmp,
    Heic,
    Gif,
    Unknown,
}

impl ImageFileFormat {
    pub fn default_extension(self) -> &'static str {
        match self {
            Self::Jpeg => "jpg",
            Self::Png => "png",
            Self::Webp => "webp",
            Self::Tiff => "tiff",
            Self::Bmp => "bmp",
            Self::Heic => "heic",
            Self::Gif => "gif",
            Self::Unknown => "bin",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageConvertTargetFormat {
    Jpeg,
    Png,
    Webp,
    Tiff,
    Bmp,
    Heic,
}

impl ImageConvertTargetFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Jpeg => "jpg",
            Self::Png => "png",
            Self::Webp => "webp",
            Self::Tiff => "tiff",
            Self::Bmp => "bmp",
            Self::Heic => "heic",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompressQualityPreset {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PngCompressMode {
    Lossless,
    LossyPalette,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageMetadataFlags {
    pub has_exif: bool,
    pub has_gps: bool,
    pub has_xmp: bool,
    pub has_iptc: bool,
    pub has_icc: bool,
    pub has_comments: bool,
    pub has_camera_info: bool,
    pub has_datetime: bool,
    pub duplicate_segment_count: usize,
    pub tag_highlights: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedImageItem {
    pub path: String,
    pub file_name: String,
    pub byte_length: u64,
    pub format: ImageFileFormat,
    pub raw_width: u32,
    pub raw_height: u32,
    pub exif_orientation: u16,
    pub display_width: u32,
    pub display_height: u32,
    pub has_alpha: bool,
    pub is_animated: bool,
    pub page_count: u32,
    pub has_icc_profile: bool,
    pub metadata_flags: ImageMetadataFlags,
    pub thumbnail_data_url: Option<String>,
    pub warnings: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedImageInput {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectBatchImagesResponse {
    pub items: Vec<InspectedImageItem>,
    pub skipped: Vec<SkippedImageInput>,
    pub heic_capabilities: HeicCapabilities,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageBatchProgressPayload {
    pub task_id: String,
    pub tool_id: String,
    pub current_index: usize,
    pub total_items: usize,
    pub current_file_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BatchImageOutcomeStatus {
    Ok,
    KeptOriginal,
    Skipped,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchImageItemOutcome {
    pub source_path: String,
    pub file_name: String,
    pub output_path: Option<String>,
    pub status: BatchImageOutcomeStatus,
    pub original_bytes: u64,
    pub output_bytes: u64,
    pub saved_percent: f64,
    pub output_width: Option<u32>,
    pub output_height: Option<u32>,
    pub codec_note: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchImageJobResponse {
    pub task_id: String,
    pub tool_id: String,
    pub output_dir: String,
    pub cancelled: bool,
    pub succeeded_count: usize,
    pub kept_original_count: usize,
    pub skipped_count: usize,
    pub failed_count: usize,
    pub total_original_bytes: u64,
    pub total_output_bytes: u64,
    pub items: Vec<BatchImageItemOutcome>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertImagesBatchRequest {
    pub source_paths: Vec<String>,
    pub output_dir: String,
    pub target_format: ImageConvertTargetFormat,
    pub quality: u8,
    pub webp_lossless: bool,
    pub background_hex: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewConvertImageRequest {
    pub path: String,
    pub target_format: ImageConvertTargetFormat,
    pub background_hex: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewConvertImageResponse {
    pub preview_data_url: String,
    pub display_width: u32,
    pub display_height: u32,
    pub has_alpha: bool,
    pub flattened_alpha: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressImagesBatchRequest {
    pub source_paths: Vec<String>,
    pub output_dir: String,
    pub quality_preset: CompressQualityPreset,
    pub png_mode: PngCompressMode,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCompressImageRequest {
    pub path: String,
    pub quality_preset: CompressQualityPreset,
    pub png_mode: PngCompressMode,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCompressImageResponse {
    pub original_preview_data_url: String,
    pub compressed_preview_data_url: String,
    pub original_bytes: u64,
    pub compressed_bytes: u64,
    pub saved_percent: f64,
    pub kept_original: bool,
    pub width: u32,
    pub height: u32,
    pub format: ImageFileFormat,
    pub codec_label: String,
}

#[derive(Debug)]
pub struct DecodedDisplayImage {
    pub image: DynamicImage,
    pub format: ImageFileFormat,
    pub raw_width: u32,
    pub raw_height: u32,
    pub exif_orientation: u16,
    pub has_alpha: bool,
    pub icc_profile: Option<Vec<u8>>,
    pub is_animated: bool,
    pub page_count: u32,
}

#[cfg(windows)]
pub(crate) fn is_reparse_point_meta(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    meta.file_type().is_symlink() || (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0
}

#[cfg(not(windows))]
pub(crate) fn is_reparse_point_meta(meta: &fs::Metadata) -> bool {
    meta.file_type().is_symlink()
}

pub fn detect_format_from_bytes_and_ext(bytes: &[u8], path: &Path) -> ImageFileFormat {
    if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return ImageFileFormat::Jpeg;
    }
    if bytes.len() >= 8 && &bytes[0..8] == b"\x89PNG\r\n\x1a\n" {
        return ImageFileFormat::Png;
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return ImageFileFormat::Webp;
    }
    if bytes.len() >= 4
        && ((bytes[0] == b'I' && bytes[1] == b'I' && (bytes[2] == 42 || bytes[2] == 43))
            || (bytes[0] == b'M' && bytes[1] == b'M' && (bytes[3] == 42 || bytes[3] == 43)))
    {
        return ImageFileFormat::Tiff;
    }
    if bytes.len() >= 2 && &bytes[0..2] == b"BM" {
        return ImageFileFormat::Bmp;
    }
    if bytes.len() >= 6 && (&bytes[0..6] == b"GIF87a" || &bytes[0..6] == b"GIF89a") {
        return ImageFileFormat::Gif;
    }
    // ISO Base Media File Format (HEIC / HEIF ftyp box)
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        let brand = &bytes[8..12];
        if matches!(
            brand,
            b"heic" | b"heix" | b"hevc" | b"hevx" | b"mif1" | b"msf1" | b"heim" | b"heis"
        ) {
            return ImageFileFormat::Heic;
        }
    }
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg" | "jpeg" | "jpe") => ImageFileFormat::Jpeg,
        Some("png") => ImageFileFormat::Png,
        Some("webp") => ImageFileFormat::Webp,
        Some("tif" | "tiff") => ImageFileFormat::Tiff,
        Some("bmp") => ImageFileFormat::Bmp,
        Some("heic" | "heif") => ImageFileFormat::Heic,
        Some("gif") => ImageFileFormat::Gif,
        _ => ImageFileFormat::Unknown,
    }
}

pub fn read_exif_orientation_from_bytes(bytes: &[u8]) -> u16 {
    let mut cursor = Cursor::new(bytes);
    if let Ok(exif) = ExifReader::new().read_from_container(&mut cursor) {
        if let Some(field) = exif.get_field(Tag::Orientation, In::PRIMARY) {
            if let Some(v) = field.value.get_uint(0) {
                if (1..=8).contains(&v) {
                    return v as u16;
                }
            }
        }
    }
    1
}

pub fn apply_exif_orientation(img: DynamicImage, orientation: u16) -> DynamicImage {
    match orientation {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}

pub fn display_dimensions_for_orientation(w: u32, h: u32, orientation: u16) -> (u32, u32) {
    if matches!(orientation, 5..=8) {
        (h, w)
    } else {
        (w, h)
    }
}

pub fn parse_hex_rgb(hex: &str) -> [u8; 3] {
    let cleaned = hex.trim().trim_start_matches('#');
    if cleaned.len() == 6 {
        if let (Ok(r), Ok(g), Ok(b)) = (
            u8::from_str_radix(&cleaned[0..2], 16),
            u8::from_str_radix(&cleaned[2..4], 16),
            u8::from_str_radix(&cleaned[4..6], 16),
        ) {
            return [r, g, b];
        }
    }
    [255, 255, 255]
}

pub fn composite_rgba_over_rgb(rgba: &RgbaImage, bg: [u8; 3]) -> image::RgbImage {
    let (w, h) = rgba.dimensions();
    let mut out = image::RgbImage::new(w, h);
    let br = bg[0] as u32;
    let bg_g = bg[1] as u32;
    let bb = bg[2] as u32;

    for (dst, src) in out.pixels_mut().zip(rgba.pixels()) {
        let a = src[3] as u32;
        if a == 255 {
            *dst = image::Rgb([src[0], src[1], src[2]]);
        } else if a == 0 {
            *dst = image::Rgb(bg);
        } else {
            let inv = 255 - a;
            let r = (src[0] as u32 * a + br * inv + 127) / 255;
            let g = (src[1] as u32 * a + bg_g * inv + 127) / 255;
            let b = (src[2] as u32 * a + bb * inv + 127) / 255;
            *dst = image::Rgb([r as u8, g as u8, b as u8]);
        }
    }
    out
}

pub fn image_has_meaningful_alpha(img: &DynamicImage) -> bool {
    let ct = img.color();
    if !matches!(
        ct,
        ColorType::La8
            | ColorType::Rgba8
            | ColorType::La16
            | ColorType::Rgba16
            | ColorType::Rgba32F
    ) {
        return false;
    }
    let rgba = img.to_rgba8();
    rgba.pixels().any(|p| p[3] < 255)
}

pub fn extract_icc_profile(bytes: &[u8], format: ImageFileFormat) -> Option<Vec<u8>> {
    match format {
        ImageFileFormat::Jpeg => extract_jpeg_icc(bytes),
        ImageFileFormat::Png => extract_png_icc(bytes),
        ImageFileFormat::Webp => extract_webp_icc(bytes),
        ImageFileFormat::Tiff => extract_tiff_icc(bytes),
        _ => None,
    }
}

fn extract_jpeg_icc(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return None;
    }
    let mut chunks: Vec<(u8, Vec<u8>)> = Vec::new();
    let mut expected_total: Option<u8> = None;
    let mut i = 2usize;
    while i + 4 <= bytes.len() {
        if bytes[i] != 0xFF {
            break;
        }
        while i < bytes.len() && bytes[i] == 0xFF {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        let marker = bytes[i];
        i += 1;
        if marker == 0xDA || marker == 0xD9 {
            break;
        }
        if matches!(marker, 0xD0..=0xD7 | 0x01) {
            continue;
        }
        if i + 2 > bytes.len() {
            break;
        }
        let seg_len = u16::from_be_bytes([bytes[i], bytes[i + 1]]) as usize;
        if seg_len < 2 || i + seg_len > bytes.len() {
            break;
        }
        let payload = &bytes[i + 2..i + seg_len];
        if marker == 0xE2 && payload.len() > 14 && &payload[0..12] == b"ICC_PROFILE\0" {
            let seq = payload[12];
            let total = payload[13];
            if seq >= 1 && total >= 1 {
                expected_total = Some(total);
                chunks.push((seq, payload[14..].to_vec()));
            }
        }
        i += seg_len;
    }
    let total = expected_total?;
    if chunks.is_empty() {
        return None;
    }
    chunks.sort_by_key(|(seq, _)| *seq);
    let mut out = Vec::new();
    for seq in 1..=total {
        let part = chunks.iter().find(|(s, _)| *s == seq)?;
        out.extend_from_slice(&part.1);
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn extract_png_icc(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.len() < 8 || &bytes[0..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let mut i = 8usize;
    while i + 12 <= bytes.len() {
        let len = u32::from_be_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]) as usize;
        let kind = &bytes[i + 4..i + 8];
        if i + 12 + len > bytes.len() {
            break;
        }
        let data = &bytes[i + 8..i + 8 + len];
        if kind == b"iCCP" {
            if let Some(nul) = data.iter().position(|&b| b == 0) {
                if nul + 2 <= data.len() && data[nul + 1] == 0 {
                    let dec = ZlibDecoder::new(&data[nul + 2..]);
                    let mut out = Vec::new();
                    if dec.take(4 * 1024 * 1024).read_to_end(&mut out).is_ok() && !out.is_empty() {
                        return Some(out);
                    }
                }
            }
        }
        if kind == b"IEND" {
            break;
        }
        i += 12 + len;
    }
    None
}

fn extract_webp_icc(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return None;
    }
    let mut i = 12usize;
    while i + 8 <= bytes.len() {
        let fourcc = &bytes[i..i + 4];
        let len =
            u32::from_le_bytes([bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]]) as usize;
        if i + 8 + len > bytes.len() {
            break;
        }
        if fourcc == b"ICCP" && len > 0 {
            return Some(bytes[i + 8..i + 8 + len].to_vec());
        }
        i += 8 + len + (len & 1);
    }
    None
}

fn extract_tiff_icc(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut decoder = tiff::decoder::Decoder::new(Cursor::new(bytes)).ok()?;
    let val = decoder.get_tag(tiff::tags::Tag::Unknown(34675)).ok()?;
    match val {
        tiff::decoder::ifd::Value::List(list) => {
            let mut out = Vec::with_capacity(list.len());
            for item in list {
                if let tiff::decoder::ifd::Value::Byte(b) = item {
                    out.push(b);
                } else if let tiff::decoder::ifd::Value::Unsigned(u) = item {
                    out.push(u as u8);
                }
            }
            if out.is_empty() {
                None
            } else {
                Some(out)
            }
        }
        _ => None,
    }
}

fn detect_animation_and_pages(bytes: &[u8], format: ImageFileFormat) -> (bool, u32) {
    match format {
        ImageFileFormat::Png => {
            if bytes.len() < 8 || &bytes[0..8] != b"\x89PNG\r\n\x1a\n" {
                return (false, 1);
            }
            let mut i = 8usize;
            while i + 12 <= bytes.len() {
                let len = u32::from_be_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]])
                    as usize;
                let kind = &bytes[i + 4..i + 8];
                if kind == b"acTL" {
                    return (true, 1);
                }
                if kind == b"IDAT" || kind == b"IEND" || i + 12 + len > bytes.len() {
                    break;
                }
                i += 12 + len;
            }
            (false, 1)
        }
        ImageFileFormat::Webp => {
            if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
                return (false, 1);
            }
            let mut i = 12usize;
            while i + 8 <= bytes.len() {
                let fourcc = &bytes[i..i + 4];
                let len =
                    u32::from_le_bytes([bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]])
                        as usize;
                if i + 8 + len > bytes.len() {
                    break;
                }
                if fourcc == b"VP8X" && len >= 10 && (bytes[i + 8] & 0x02) != 0 {
                    return (true, 1);
                }
                if fourcc == b"ANIM" {
                    return (true, 1);
                }
                i += 8 + len + (len & 1);
            }
            (false, 1)
        }
        ImageFileFormat::Gif => {
            let mut count = 0usize;
            if let Ok(dec) = gif::DecodeOptions::new().read_info(Cursor::new(bytes)) {
                let mut reader = dec;
                while let Ok(Some(_)) = reader.read_next_frame() {
                    count += 1;
                    if count > 1 {
                        return (true, count as u32);
                    }
                }
            }
            (false, 1)
        }
        ImageFileFormat::Tiff => {
            let mut pages = 1u32;
            if let Ok(mut dec) = tiff::decoder::Decoder::new(Cursor::new(bytes)) {
                while dec.more_images() && pages < 500 {
                    if dec.next_image().is_err() {
                        break;
                    }
                    pages += 1;
                }
            }
            (false, pages)
        }
        _ => (false, 1),
    }
}

fn scan_raw_exif_bytes(raw_tiff: &[u8], flags: &mut ImageMetadataFlags) {
    let trimmed = raw_tiff.strip_prefix(b"Exif\0\0").unwrap_or(raw_tiff);
    match ExifReader::new().read_raw(trimmed.to_vec()) {
        Ok(exif) => {
            let mut non_orientation_count = 0usize;
            for f in exif.fields() {
                if f.tag == Tag::Orientation {
                    continue;
                }
                non_orientation_count += 1;
                match f.tag {
                    Tag::GPSLatitude
                    | Tag::GPSLongitude
                    | Tag::GPSAltitude
                    | Tag::GPSLatitudeRef
                    | Tag::GPSLongitudeRef => {
                        flags.has_gps = true;
                    }
                    Tag::Make | Tag::Model | Tag::LensModel | Tag::Software => {
                        flags.has_camera_info = true;
                    }
                    Tag::DateTime | Tag::DateTimeOriginal | Tag::DateTimeDigitized => {
                        flags.has_datetime = true;
                    }
                    _ => {}
                }
            }
            if non_orientation_count > 0 {
                flags.has_exif = true;
            }
        }
        Err(_) => {
            // Unparseable EXIF payload must not be misreported as clean
            flags.has_exif = true;
        }
    }
}

fn scan_classic_tiff_metadata(bytes: &[u8], flags: &mut ImageMetadataFlags) {
    if bytes.len() < 8 {
        return;
    }
    let little = match &bytes[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return,
    };
    let r16 = |b: &[u8]| {
        if little {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            u16::from_be_bytes([b[0], b[1]])
        }
    };
    let r32 = |b: &[u8]| {
        if little {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        }
    };
    if r16(&bytes[2..4]) != 42 {
        return;
    }

    let mut visited = std::collections::HashSet::new();
    let mut ifd_off = r32(&bytes[4..8]) as usize;
    while ifd_off != 0 && visited.insert(ifd_off) && visited.len() <= 128 {
        if ifd_off + 2 > bytes.len() {
            break;
        }
        let n = r16(&bytes[ifd_off..ifd_off + 2]) as usize;
        let entries_start = ifd_off + 2;
        let entries_end = entries_start.saturating_add(n.saturating_mul(12));
        if entries_end + 4 > bytes.len() {
            break;
        }
        for idx in 0..n {
            let off = entries_start + idx * 12;
            let tag = r16(&bytes[off..off + 2]);
            match tag {
                // Core display / pixel-layout / orientation / ICC tags are NOT personal metadata
                254
                | 255
                | 256
                | 257
                | 258
                | 259
                | 262
                | 266
                | 273
                | 274
                | 277
                | 278
                | 279
                | 280
                | 281
                | 282
                | 283
                | 284
                | 296
                | 317
                | 320
                | 322
                | 323
                | 324
                | 325
                | 338
                | 339
                | 347
                | 512..=532
                | 34675 => {}
                700 => flags.has_xmp = true,
                33723 | 34377 => flags.has_iptc = true,
                34853 => {
                    flags.has_gps = true;
                    flags.has_exif = true;
                }
                34665 => flags.has_exif = true,
                271 | 272 | 305 => {
                    flags.has_camera_info = true;
                    flags.has_exif = true;
                }
                306 => {
                    flags.has_datetime = true;
                    flags.has_exif = true;
                }
                269 | 270 | 285 | 315 | 316 | 33432 => {
                    flags.has_comments = true;
                    flags.has_exif = true;
                }
                _ => {
                    flags.has_exif = true;
                }
            }
        }
        ifd_off = r32(&bytes[entries_end..entries_end + 4]) as usize;
    }
}

pub fn inspect_metadata_flags(bytes: &[u8], format: ImageFileFormat) -> ImageMetadataFlags {
    let mut flags = ImageMetadataFlags {
        has_exif: false,
        has_gps: false,
        has_xmp: false,
        has_iptc: false,
        has_icc: extract_icc_profile(bytes, format).is_some(),
        has_comments: false,
        has_camera_info: false,
        has_datetime: false,
        duplicate_segment_count: 0,
        tag_highlights: Vec::new(),
    };

    match format {
        ImageFileFormat::Jpeg => {
            let mut exif_count = 0usize;
            let mut xmp_count = 0usize;
            let mut iptc_count = 0usize;
            let mut i = 2usize;
            while i + 4 <= bytes.len() && bytes[0] == 0xFF && bytes[1] == 0xD8 {
                if bytes[i] != 0xFF {
                    break;
                }
                while i < bytes.len() && bytes[i] == 0xFF {
                    i += 1;
                }
                if i >= bytes.len() {
                    break;
                }
                let marker = bytes[i];
                i += 1;
                if marker == 0xDA || marker == 0xD9 {
                    break;
                }
                if matches!(marker, 0xD0..=0xD7 | 0x01) {
                    continue;
                }
                if i + 2 > bytes.len() {
                    break;
                }
                let seg_len = u16::from_be_bytes([bytes[i], bytes[i + 1]]) as usize;
                if seg_len < 2 || i + seg_len > bytes.len() {
                    break;
                }
                let payload = &bytes[i + 2..i + seg_len];
                if marker == 0xE1 {
                    if payload.starts_with(b"Exif\0\0") {
                        exif_count += 1;
                        scan_raw_exif_bytes(&payload[6..], &mut flags);
                    } else if payload.starts_with(b"http://ns.adobe.com/xap/1.0/\0")
                        || payload.starts_with(b"http://ns.adobe.com/xmp/extension/\0")
                    {
                        flags.has_xmp = true;
                        xmp_count += 1;
                    }
                } else if marker == 0xED {
                    flags.has_iptc = true;
                    iptc_count += 1;
                } else if marker == 0xFE {
                    flags.has_comments = true;
                }
                i += seg_len;
            }
            if exif_count > 1 {
                flags.duplicate_segment_count += exif_count - 1;
            }
            if xmp_count > 1 {
                flags.duplicate_segment_count += xmp_count - 1;
            }
            if iptc_count > 1 {
                flags.duplicate_segment_count += iptc_count - 1;
            }
        }
        ImageFileFormat::Png => {
            if bytes.len() >= 8 && &bytes[0..8] == b"\x89PNG\r\n\x1a\n" {
                let mut i = 8usize;
                let mut text_count = 0usize;
                let mut exif_count = 0usize;
                while i + 12 <= bytes.len() {
                    let len =
                        u32::from_be_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]])
                            as usize;
                    let kind = &bytes[i + 4..i + 8];
                    if i + 12 + len > bytes.len() {
                        break;
                    }
                    let data = &bytes[i + 8..i + 8 + len];
                    match kind {
                        b"eXIf" => {
                            exif_count += 1;
                            scan_raw_exif_bytes(data, &mut flags);
                        }
                        b"tIME" => {
                            flags.has_datetime = true;
                        }
                        b"tEXt" | b"zTXt" | b"iTXt" => {
                            text_count += 1;
                            if data.starts_with(b"XML:com.adobe.xmp\0") {
                                flags.has_xmp = true;
                            } else if data.starts_with(b"Raw profile type iptc\0") {
                                flags.has_iptc = true;
                            } else if data.starts_with(b"Raw profile type exif\0") {
                                flags.has_exif = true;
                            } else {
                                flags.has_comments = true;
                            }
                        }
                        b"IEND" => break,
                        _ => {}
                    }
                    i += 12 + len;
                }
                if exif_count > 1 {
                    flags.duplicate_segment_count += exif_count - 1;
                }
                if text_count > 1 {
                    flags.duplicate_segment_count += text_count - 1;
                }
            }
        }
        ImageFileFormat::Webp => {
            if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
                let mut i = 12usize;
                let mut exif_count = 0usize;
                let mut xmp_count = 0usize;
                while i + 8 <= bytes.len() {
                    let fourcc = &bytes[i..i + 4];
                    let len = u32::from_le_bytes([
                        bytes[i + 4],
                        bytes[i + 5],
                        bytes[i + 6],
                        bytes[i + 7],
                    ]) as usize;
                    if i + 8 + len > bytes.len() {
                        break;
                    }
                    let payload = &bytes[i + 8..i + 8 + len];
                    if fourcc == b"EXIF" {
                        exif_count += 1;
                        scan_raw_exif_bytes(payload, &mut flags);
                    } else if fourcc == b"XMP " {
                        flags.has_xmp = true;
                        xmp_count += 1;
                    }
                    i += 8 + len + (len & 1);
                }
                if exif_count > 1 {
                    flags.duplicate_segment_count += exif_count - 1;
                }
                if xmp_count > 1 {
                    flags.duplicate_segment_count += xmp_count - 1;
                }
            }
        }
        ImageFileFormat::Tiff => {
            scan_classic_tiff_metadata(bytes, &mut flags);
        }
        _ => {
            if let Ok(exif) = ExifReader::new().read_from_container(&mut Cursor::new(bytes)) {
                let mut non_orientation_count = 0usize;
                for f in exif.fields() {
                    if f.tag == Tag::Orientation {
                        continue;
                    }
                    non_orientation_count += 1;
                    match f.tag {
                        Tag::GPSLatitude
                        | Tag::GPSLongitude
                        | Tag::GPSAltitude
                        | Tag::GPSLatitudeRef
                        | Tag::GPSLongitudeRef => {
                            flags.has_gps = true;
                        }
                        Tag::Make | Tag::Model | Tag::LensModel | Tag::Software => {
                            flags.has_camera_info = true;
                        }
                        Tag::DateTime | Tag::DateTimeOriginal | Tag::DateTimeDigitized => {
                            flags.has_datetime = true;
                        }
                        _ => {}
                    }
                }
                if non_orientation_count > 0 {
                    flags.has_exif = true;
                }
            }
        }
    }

    if flags.has_gps {
        flags.tag_highlights.push("GPS".into());
    }
    if flags.has_camera_info {
        flags.tag_highlights.push("Camera".into());
    }
    if flags.has_datetime {
        flags.tag_highlights.push("DateTime".into());
    }
    if flags.has_exif {
        flags.tag_highlights.push("EXIF".into());
    }
    if flags.has_xmp {
        flags.tag_highlights.push("XMP".into());
    }
    if flags.has_iptc {
        flags.tag_highlights.push("IPTC".into());
    }
    if flags.has_comments {
        flags.tag_highlights.push("Comments".into());
    }

    flags
}

/// Decodes any supported image into display-oriented pixels (`Orientation = 1` baked!).
pub fn decode_image_to_display(path: &Path) -> Result<DecodedDisplayImage, AppError> {
    let meta = fs::symlink_metadata(path)
        .map_err(|e| AppError::from_io(e, "Cannot inspect image file"))?;
    if !meta.is_file() || is_reparse_point_meta(&meta) {
        return Err(AppError::invalid_param("Path is not a regular image file."));
    }
    if meta.len() > MAX_IMAGE_FILE_BYTES {
        return Err(AppError::size_limit(format!(
            "Image exceeds {} MiB safety limit.",
            MAX_IMAGE_FILE_BYTES / (1024 * 1024)
        )));
    }
    let bytes = fs::read(path).map_err(|e| AppError::from_io(e, "Cannot read image file bytes"))?;
    let format = detect_format_from_bytes_and_ext(&bytes, path);
    let (is_animated, page_count) = detect_animation_and_pages(&bytes, format);

    if format == ImageFileFormat::Heic {
        let wic = decode_heic_file_via_wic(path)?;
        let raw_w = wic.rgba.width();
        let raw_h = wic.rgba.height();
        let dyn_raw = DynamicImage::ImageRgba8(wic.rgba);
        let oriented = apply_exif_orientation(dyn_raw, wic.exif_orientation);
        let has_alpha = image_has_meaningful_alpha(&oriented);
        return Ok(DecodedDisplayImage {
            image: oriented,
            format,
            raw_width: raw_w,
            raw_height: raw_h,
            exif_orientation: wic.exif_orientation,
            has_alpha,
            icc_profile: wic.icc_profile,
            is_animated: false,
            page_count: 1,
        });
    }

    let exif_orientation = read_exif_orientation_from_bytes(&bytes);
    let icc_profile = extract_icc_profile(&bytes, format);

    let img_fmt = match format {
        ImageFileFormat::Jpeg => Some(ImageFormat::Jpeg),
        ImageFileFormat::Png => Some(ImageFormat::Png),
        ImageFileFormat::Webp => Some(ImageFormat::WebP),
        ImageFileFormat::Tiff => Some(ImageFormat::Tiff),
        ImageFileFormat::Bmp => Some(ImageFormat::Bmp),
        ImageFileFormat::Gif => Some(ImageFormat::Gif),
        _ => None,
    };

    let reader = if let Some(fmt) = img_fmt {
        image::ImageReader::with_format(Cursor::new(&bytes), fmt)
    } else {
        image::ImageReader::new(Cursor::new(&bytes))
            .with_guessed_format()
            .map_err(|e| AppError::decode_failed(format!("Cannot detect image format: {e}")))?
    };

    let (raw_w, raw_h) = reader.into_dimensions().map_err(|e| {
        AppError::decode_failed(format!("Corrupted or unreadable image header: {e}"))
    })?;
    if raw_w == 0 || raw_h == 0 {
        return Err(AppError::decode_failed("Image has zero width or height."));
    }
    if (raw_w as u64) * (raw_h as u64) > MAX_IMAGE_PIXELS {
        return Err(AppError::size_limit(format!(
            "Image dimensions ({raw_w}×{raw_h}) exceed 100 MP safety limit."
        )));
    }

    let reader2 = if let Some(fmt) = img_fmt {
        image::ImageReader::with_format(Cursor::new(&bytes), fmt)
    } else {
        image::ImageReader::new(Cursor::new(&bytes))
            .with_guessed_format()
            .map_err(|e| AppError::decode_failed(format!("Cannot detect image format: {e}")))?
    };

    let decoded = reader2
        .decode()
        .map_err(|e| AppError::decode_failed(format!("Failed decoding image: {e}")))?;
    let oriented = apply_exif_orientation(decoded, exif_orientation);
    let has_alpha = image_has_meaningful_alpha(&oriented);

    Ok(DecodedDisplayImage {
        image: oriented,
        format,
        raw_width: raw_w,
        raw_height: raw_h,
        exif_orientation,
        has_alpha,
        icc_profile,
        is_animated,
        page_count,
    })
}

pub fn encode_preview_data_url(
    img: &DynamicImage,
    max_edge: u32,
    prefer_png: bool,
) -> Option<String> {
    let (w, h) = img.dimensions();
    let resized = if w > max_edge || h > max_edge {
        img.resize(max_edge, max_edge, FilterType::Triangle)
    } else {
        img.clone()
    };
    let mut buf = Vec::new();
    if prefer_png {
        resized
            .write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)
            .ok()?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
        Some(format!("data:image/png;base64,{b64}"))
    } else {
        let rgb = resized.to_rgb8();
        let enc = JpegEncoder::new(&mut buf, 86);
        enc.encode(
            rgb.as_raw(),
            rgb.width() as u16,
            rgb.height() as u16,
            JpegColorType::Rgb,
        )
        .ok()?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
        Some(format!("data:image/jpeg;base64,{b64}"))
    }
}

pub fn encode_bytes_to_data_url(mime: &str, bytes: &[u8]) -> String {
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("data:{mime};base64,{b64}")
}

pub fn encode_jpeg_bytes(
    rgb: &image::RgbImage,
    quality: u8,
    subsampling_444: bool,
    icc: Option<&[u8]>,
) -> Result<Vec<u8>, AppError> {
    let w = u16::try_from(rgb.width())
        .map_err(|_| AppError::invalid_param("JPEG width exceeds 65,535 px limit."))?;
    let h = u16::try_from(rgb.height())
        .map_err(|_| AppError::invalid_param("JPEG height exceeds 65,535 px limit."))?;
    let mut out = Vec::new();
    let mut enc = JpegEncoder::new(&mut out, quality.clamp(1, 100));
    enc.set_sampling_factor(if subsampling_444 {
        SamplingFactor::F_1_1
    } else {
        SamplingFactor::F_2_2
    });
    if let Some(profile) = icc {
        let _ = enc.add_icc_profile(profile);
    }
    enc.encode(rgb.as_raw(), w, h, JpegColorType::Rgb)
        .map_err(|e| AppError::decode_failed(format!("JPEG encoding failed: {e}")))?;
    Ok(out)
}

fn inject_png_iccp_chunk(png_bytes: &[u8], icc: &[u8]) -> Vec<u8> {
    if png_bytes.len() < 33 || &png_bytes[0..8] != b"\x89PNG\r\n\x1a\n" {
        return png_bytes.to_vec();
    }
    // Compress ICC bytes with zlib for iCCP chunk: profile_name + \0 + method(0) + zlib(icc)
    let mut zenc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    if zenc.write_all(icc).is_err() {
        return png_bytes.to_vec();
    }
    let Ok(compressed) = zenc.finish() else {
        return png_bytes.to_vec();
    };
    let mut chunk_data = Vec::with_capacity(14 + compressed.len());
    chunk_data.extend_from_slice(b"ICC Profile\0");
    chunk_data.push(0); // compression method = deflate
    chunk_data.extend_from_slice(&compressed);

    let mut crc_input = Vec::with_capacity(4 + chunk_data.len());
    crc_input.extend_from_slice(b"iCCP");
    crc_input.extend_from_slice(&chunk_data);
    let crc = crc32_ieee(&crc_input);

    // Insert right after IHDR chunk (first chunk starting at offset 8)
    let ihdr_len =
        u32::from_be_bytes([png_bytes[8], png_bytes[9], png_bytes[10], png_bytes[11]]) as usize;
    let insert_at = 8 + 12 + ihdr_len;
    if insert_at > png_bytes.len() {
        return png_bytes.to_vec();
    }
    let mut out = Vec::with_capacity(png_bytes.len() + 12 + chunk_data.len());
    out.extend_from_slice(&png_bytes[..insert_at]);
    out.extend_from_slice(&(chunk_data.len() as u32).to_be_bytes());
    out.extend_from_slice(b"iCCP");
    out.extend_from_slice(&chunk_data);
    out.extend_from_slice(&crc.to_be_bytes());
    out.extend_from_slice(&png_bytes[insert_at..]);
    out
}

pub(crate) fn crc32_ieee(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            if (crc & 1) != 0 {
                crc = (crc >> 1) ^ 0xEDB8_8320;
            } else {
                crc >>= 1;
            }
        }
    }
    !crc
}

pub fn encode_png_lossless_bytes(
    img: &DynamicImage,
    opt_level: u8,
    icc: Option<&[u8]>,
) -> Result<Vec<u8>, AppError> {
    let mut raw_png = Vec::new();
    img.write_to(&mut Cursor::new(&mut raw_png), ImageFormat::Png)
        .map_err(|e| AppError::decode_failed(format!("PNG encoding failed: {e}")))?;
    let with_icc = if let Some(profile) = icc {
        inject_png_iccp_chunk(&raw_png, profile)
    } else {
        raw_png
    };
    let mut opts = oxipng::Options::from_preset(opt_level.min(4));
    opts.strip = oxipng::StripChunks::None; // Keep iCCP / sRGB / gAMA / cHRM color fidelity
    oxipng::optimize_from_memory(&with_icc, &opts)
        .map_err(|e| AppError::decode_failed(format!("PNG lossless optimization failed: {e}")))
}

pub fn encode_png_lossy_indexed_bytes(
    rgba: &RgbaImage,
    max_colors: usize,
    icc: Option<&[u8]>,
) -> Result<Vec<u8>, AppError> {
    let (w, h) = rgba.dimensions();
    let pixels: Vec<exoquant::Color> = rgba
        .pixels()
        .map(|p| exoquant::Color::new(p[0], p[1], p[2], p[3]))
        .collect();
    let colorspace = exoquant::SimpleColorSpace::default();
    let histogram: exoquant::Histogram = pixels.iter().copied().collect();
    let mut quantizer = exoquant::Quantizer::new(&histogram, &colorspace);
    let target_colors = max_colors.clamp(16, 256);
    while quantizer.num_colors() < target_colors {
        let prev = quantizer.num_colors();
        quantizer.step();
        if quantizer.num_colors() == prev {
            break;
        }
    }
    let mut palette = quantizer.colors(&colorspace);
    if palette.is_empty() {
        palette.push(exoquant::Color::new(0, 0, 0, 255));
    }
    let optimizer = exoquant::optimizer::KMeans;
    let palette = optimizer.optimize_palette(&colorspace, &palette, &histogram, 4);

    let ditherer = exoquant::ditherer::FloydSteinberg::new();
    let remapper = exoquant::Remapper::new(&palette, &colorspace, &ditherer);
    let indexed: Vec<u8> = remapper.remap(&pixels, w as usize);

    let mut plte = Vec::with_capacity(palette.len() * 3);
    let mut trns = Vec::with_capacity(palette.len());
    let mut any_trans = false;
    for c in &palette {
        plte.push(c.r);
        plte.push(c.g);
        plte.push(c.b);
        trns.push(c.a);
        if c.a < 255 {
            any_trans = true;
        }
    }

    let mut raw_png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut raw_png, w, h);
        encoder.set_color(png::ColorType::Indexed);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_palette(plte);
        if any_trans {
            encoder.set_trns(trns);
        }
        let mut writer = encoder
            .write_header()
            .map_err(|e| AppError::decode_failed(format!("Indexed PNG header failed: {e}")))?;
        writer
            .write_image_data(&indexed)
            .map_err(|e| AppError::decode_failed(format!("Indexed PNG data failed: {e}")))?;
    }

    let with_icc = if let Some(profile) = icc {
        inject_png_iccp_chunk(&raw_png, profile)
    } else {
        raw_png
    };
    let mut opts = oxipng::Options::from_preset(2);
    opts.strip = oxipng::StripChunks::None;
    oxipng::optimize_from_memory(&with_icc, &opts)
        .map_err(|e| AppError::decode_failed(format!("Lossy PNG post-optimization failed: {e}")))
}

fn splice_webp_iccp_chunk(
    webp_bytes: &[u8],
    width: u32,
    height: u32,
    has_alpha: bool,
    icc: &[u8],
) -> Vec<u8> {
    if webp_bytes.len() < 12 || &webp_bytes[0..4] != b"RIFF" || &webp_bytes[8..12] != b"WEBP" {
        return webp_bytes.to_vec();
    }
    let first_fourcc = &webp_bytes[12..16];
    let mut body = Vec::with_capacity(webp_bytes.len() + icc.len() + 32);

    if first_fourcc == b"VP8X" && webp_bytes.len() >= 30 {
        // Clone existing chunks, set ICCP bit in VP8X flags, insert ICCP right after VP8X
        let mut vp8x_chunk = webp_bytes[12..30].to_vec();
        vp8x_chunk[8] |= 0x20; // ICCP flag
        body.extend_from_slice(&vp8x_chunk);
        body.extend_from_slice(b"ICCP");
        body.extend_from_slice(&(icc.len() as u32).to_le_bytes());
        body.extend_from_slice(icc);
        if icc.len() % 2 == 1 {
            body.push(0);
        }
        body.extend_from_slice(&webp_bytes[30..]);
    } else {
        // Wrap simple VP8/VP8L in VP8X + ICCP + original chunk(s)
        let mut flags: u8 = 0x20; // ICCP
        if has_alpha {
            flags |= 0x10; // Alpha
        }
        let w_m1 = width.saturating_sub(1);
        let h_m1 = height.saturating_sub(1);
        body.extend_from_slice(b"VP8X");
        body.extend_from_slice(&10u32.to_le_bytes());
        body.push(flags);
        body.extend_from_slice(&[0u8; 3]);
        body.extend_from_slice(&[
            (w_m1 & 0xFF) as u8,
            ((w_m1 >> 8) & 0xFF) as u8,
            ((w_m1 >> 16) & 0xFF) as u8,
        ]);
        body.extend_from_slice(&[
            (h_m1 & 0xFF) as u8,
            ((h_m1 >> 8) & 0xFF) as u8,
            ((h_m1 >> 16) & 0xFF) as u8,
        ]);

        body.extend_from_slice(b"ICCP");
        body.extend_from_slice(&(icc.len() as u32).to_le_bytes());
        body.extend_from_slice(icc);
        if icc.len() % 2 == 1 {
            body.push(0);
        }
        body.extend_from_slice(&webp_bytes[12..]);
    }

    let riff_size = (4 + body.len()) as u32;
    let mut out = Vec::with_capacity(12 + body.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&riff_size.to_le_bytes());
    out.extend_from_slice(b"WEBP");
    out.extend_from_slice(&body);
    out
}

pub fn encode_webp_bytes(
    img: &DynamicImage,
    quality: u8,
    lossless: bool,
    icc: Option<&[u8]>,
) -> Result<Vec<u8>, AppError> {
    let (w, h) = img.dimensions();
    let has_alpha = image_has_meaningful_alpha(img);
    let webp_mem = if has_alpha {
        let rgba = img.to_rgba8();
        let encoder = webp::Encoder::from_rgba(rgba.as_raw(), w, h);
        if lossless {
            encoder.encode_lossless()
        } else {
            encoder.encode(quality.clamp(1, 100) as f32)
        }
    } else {
        let rgb = img.to_rgb8();
        let encoder = webp::Encoder::from_rgb(rgb.as_raw(), w, h);
        if lossless {
            encoder.encode_lossless()
        } else {
            encoder.encode(quality.clamp(1, 100) as f32)
        }
    };
    let raw = webp_mem.to_vec();
    if let Some(profile) = icc {
        Ok(splice_webp_iccp_chunk(&raw, w, h, has_alpha, profile))
    } else {
        Ok(raw)
    }
}

pub fn encode_tiff_bytes(img: &DynamicImage) -> Result<Vec<u8>, AppError> {
    let mut out = Vec::new();
    img.write_to(&mut Cursor::new(&mut out), ImageFormat::Tiff)
        .map_err(|e| AppError::decode_failed(format!("TIFF encoding failed: {e}")))?;
    Ok(out)
}

pub fn encode_bmp_bytes(img: &DynamicImage, bg: [u8; 3]) -> Result<Vec<u8>, AppError> {
    let rgb = if image_has_meaningful_alpha(img) {
        composite_rgba_over_rgb(&img.to_rgba8(), bg)
    } else {
        img.to_rgb8()
    };
    let mut out = Vec::new();
    DynamicImage::ImageRgb8(rgb)
        .write_to(&mut Cursor::new(&mut out), ImageFormat::Bmp)
        .map_err(|e| AppError::decode_failed(format!("BMP encoding failed: {e}")))?;
    Ok(out)
}

fn move_file_no_overwrite(from: &Path, to: &Path) -> Result<(), AppError> {
    crate::fs_guard::commit_temp_file(from, to, false, "Failed committing output image")
}

/// Atomically writes bytes to a brand-new non-colliding file in `output_dir`.
/// Never overwrites any existing file or source image.
pub fn write_unique_output_file(
    output_dir: &Path,
    preferred_stem: &str,
    ext: &str,
    bytes: &[u8],
) -> Result<PathBuf, AppError> {
    let clean_stem = if preferred_stem.trim().is_empty() {
        "image"
    } else {
        preferred_stem.trim()
    };
    let clean_ext = ext.trim_start_matches('.');
    let pid = std::process::id();
    let seq = IMAGE_TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let temp_path = output_dir.join(format!(".winkit-img-{pid}-{seq:x}.tmp"));

    {
        let mut f = File::create(&temp_path)
            .map_err(|e| AppError::from_io(e, "Cannot create temporary output image"))?;
        if let Err(err) = f.write_all(bytes).and_then(|_| f.sync_all()) {
            let _ = fs::remove_file(&temp_path);
            return Err(AppError::from_io(err, "Failed writing output image bytes"));
        }
    }

    for attempt in 1u32..=10_000 {
        let candidate_name = if attempt == 1 {
            format!("{clean_stem}.{clean_ext}")
        } else {
            format!("{clean_stem} ({attempt}).{clean_ext}")
        };
        let candidate = output_dir.join(&candidate_name);
        if fs::symlink_metadata(&candidate).is_ok() {
            continue;
        }
        match move_file_no_overwrite(&temp_path, &candidate) {
            Ok(()) => return Ok(candidate),
            Err(err) if err.code == "TARGET_ALREADY_EXISTS" => continue,
            Err(err) => {
                let _ = fs::remove_file(&temp_path);
                return Err(err);
            }
        }
    }

    let _ = fs::remove_file(&temp_path);
    Err(AppError::target_exists())
}

pub fn validate_output_directory(raw_dir: &str) -> Result<PathBuf, AppError> {
    let dir = validate_user_path(raw_dir, "Output folder")?;
    let meta = fs::symlink_metadata(&dir)
        .map_err(|e| AppError::from_io(e, "Cannot access output folder"))?;
    if !meta.is_dir() || is_reparse_point_meta(&meta) {
        return Err(AppError::invalid_param(
            "Output path must be an existing regular folder.",
        ));
    }
    Ok(dir)
}

fn expand_input_paths(raw_paths: &[String]) -> (Vec<PathBuf>, Vec<SkippedImageInput>) {
    let mut seen: HashSet<String> = HashSet::new();
    let mut files = Vec::new();
    let mut skipped = Vec::new();

    for raw in raw_paths {
        let validated = match validate_user_path(raw, "Input image") {
            Ok(p) => p,
            Err(e) => {
                skipped.push(SkippedImageInput {
                    path: raw.clone(),
                    reason: e.message,
                });
                continue;
            }
        };
        let meta = match fs::symlink_metadata(&validated) {
            Ok(m) => m,
            Err(e) => {
                skipped.push(SkippedImageInput {
                    path: raw.clone(),
                    reason: e.to_string(),
                });
                continue;
            }
        };
        if is_reparse_point_meta(&meta) {
            skipped.push(SkippedImageInput {
                path: raw.clone(),
                reason: "Symlink / junction skipped for safety".into(),
            });
            continue;
        }
        if meta.is_dir() {
            let Ok(rd) = fs::read_dir(&validated) else {
                skipped.push(SkippedImageInput {
                    path: raw.clone(),
                    reason: "Cannot read directory".into(),
                });
                continue;
            };
            let mut dir_entries: Vec<PathBuf> = rd
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    fs::symlink_metadata(p)
                        .map(|m| m.is_file() && !is_reparse_point_meta(&m))
                        .unwrap_or(false)
                })
                .filter(|p| {
                    p.extension()
                        .and_then(|e| e.to_str())
                        .map(|ext| {
                            SUPPORTED_IMAGE_EXTS.contains(&ext.to_ascii_lowercase().as_str())
                        })
                        .unwrap_or(false)
                })
                .collect();
            dir_entries.sort_by_key(|p| p.to_string_lossy().to_ascii_lowercase());
            for child in dir_entries {
                if files.len() >= MAX_BATCH_IMAGES {
                    skipped.push(SkippedImageInput {
                        path: child.to_string_lossy().into_owned(),
                        reason: format!("Batch limit ({MAX_BATCH_IMAGES} images) reached"),
                    });
                    continue;
                }
                let key = child.to_string_lossy().to_ascii_lowercase();
                if seen.insert(key) {
                    files.push(child);
                }
            }
        } else if meta.is_file() {
            if files.len() >= MAX_BATCH_IMAGES {
                skipped.push(SkippedImageInput {
                    path: raw.clone(),
                    reason: format!("Batch limit ({MAX_BATCH_IMAGES} images) reached"),
                });
                continue;
            }
            let key = validated.to_string_lossy().to_ascii_lowercase();
            if seen.insert(key) {
                files.push(validated);
            }
        }
    }

    (files, skipped)
}

pub fn inspect_single_image_item(path: &Path, heic_caps: &HeicCapabilities) -> InspectedImageItem {
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let path_str = path.to_string_lossy().into_owned();

    let empty_flags = ImageMetadataFlags {
        has_exif: false,
        has_gps: false,
        has_xmp: false,
        has_iptc: false,
        has_icc: false,
        has_comments: false,
        has_camera_info: false,
        has_datetime: false,
        duplicate_segment_count: 0,
        tag_highlights: Vec::new(),
    };

    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) => {
            return InspectedImageItem {
                path: path_str,
                file_name,
                byte_length: 0,
                format: ImageFileFormat::Unknown,
                raw_width: 0,
                raw_height: 0,
                exif_orientation: 1,
                display_width: 0,
                display_height: 0,
                has_alpha: false,
                is_animated: false,
                page_count: 1,
                has_icc_profile: false,
                metadata_flags: empty_flags,
                thumbnail_data_url: None,
                warnings: Vec::new(),
                error: Some(format!("Cannot inspect file: {e}")),
            };
        }
    };

    let byte_length = meta.len();
    if byte_length > MAX_IMAGE_FILE_BYTES {
        return InspectedImageItem {
            path: path_str,
            file_name,
            byte_length,
            format: ImageFileFormat::Unknown,
            raw_width: 0,
            raw_height: 0,
            exif_orientation: 1,
            display_width: 0,
            display_height: 0,
            has_alpha: false,
            is_animated: false,
            page_count: 1,
            has_icc_profile: false,
            metadata_flags: empty_flags,
            thumbnail_data_url: None,
            warnings: vec!["oversized_file".into()],
            error: Some(format!(
                "File exceeds {} MiB limit.",
                MAX_IMAGE_FILE_BYTES / (1024 * 1024)
            )),
        };
    }

    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            return InspectedImageItem {
                path: path_str,
                file_name,
                byte_length,
                format: ImageFileFormat::Unknown,
                raw_width: 0,
                raw_height: 0,
                exif_orientation: 1,
                display_width: 0,
                display_height: 0,
                has_alpha: false,
                is_animated: false,
                page_count: 1,
                has_icc_profile: false,
                metadata_flags: empty_flags,
                thumbnail_data_url: None,
                warnings: Vec::new(),
                error: Some(format!("Cannot read file: {e}")),
            };
        }
    };

    let format = detect_format_from_bytes_and_ext(&bytes, path);
    let metadata_flags = inspect_metadata_flags(&bytes, format);
    let (is_animated, page_count) = detect_animation_and_pages(&bytes, format);
    let mut warnings = Vec::new();
    if is_animated {
        warnings.push("animated_first_frame_only".into());
    }
    if page_count > 1 {
        warnings.push("multipage_tiff_first_page_only".into());
    }

    if format == ImageFileFormat::Heic && !heic_caps.decode_available {
        warnings.push("heic_decode_unavailable".into());
        return InspectedImageItem {
            path: path_str,
            file_name,
            byte_length,
            format,
            raw_width: 0,
            raw_height: 0,
            exif_orientation: 1,
            display_width: 0,
            display_height: 0,
            has_alpha: false,
            is_animated: false,
            page_count: 1,
            has_icc_profile: metadata_flags.has_icc,
            metadata_flags,
            thumbnail_data_url: None,
            warnings,
            error: Some(format!(
                "HEIC decoder unavailable on this PC ({})",
                heic_caps.decode_note
            )),
        };
    }

    match decode_image_to_display(path) {
        Ok(decoded) => {
            let (dw, dh) = decoded.image.dimensions();
            let thumb = encode_preview_data_url(&decoded.image, THUMB_MAX_EDGE, decoded.has_alpha);
            InspectedImageItem {
                path: path_str,
                file_name,
                byte_length,
                format: decoded.format,
                raw_width: decoded.raw_width,
                raw_height: decoded.raw_height,
                exif_orientation: decoded.exif_orientation,
                display_width: dw,
                display_height: dh,
                has_alpha: decoded.has_alpha,
                is_animated: decoded.is_animated,
                page_count: decoded.page_count,
                has_icc_profile: decoded.icc_profile.is_some() || metadata_flags.has_icc,
                metadata_flags,
                thumbnail_data_url: thumb,
                warnings,
                error: None,
            }
        }
        Err(err) => InspectedImageItem {
            path: path_str,
            file_name,
            byte_length,
            format,
            raw_width: 0,
            raw_height: 0,
            exif_orientation: 1,
            display_width: 0,
            display_height: 0,
            has_alpha: false,
            is_animated,
            page_count,
            has_icc_profile: metadata_flags.has_icc,
            metadata_flags,
            thumbnail_data_url: None,
            warnings,
            error: Some(err.message),
        },
    }
}

pub fn inspect_batch_images_impl(raw_paths: &[String]) -> InspectBatchImagesResponse {
    let heic_capabilities = get_heic_capabilities();
    let (files, skipped) = expand_input_paths(raw_paths);
    let items: Vec<InspectedImageItem> = files
        .iter()
        .map(|p| inspect_single_image_item(p, &heic_capabilities))
        .collect();
    InspectBatchImagesResponse {
        items,
        skipped,
        heic_capabilities,
    }
}

pub fn preview_convert_image_impl(
    req: &PreviewConvertImageRequest,
) -> Result<PreviewConvertImageResponse, AppError> {
    let path = validate_user_path(&req.path, "Preview image")?;
    let decoded = decode_image_to_display(&path)?;
    let (w, h) = decoded.image.dimensions();
    let flattens = decoded.has_alpha
        && matches!(
            req.target_format,
            ImageConvertTargetFormat::Jpeg | ImageConvertTargetFormat::Bmp
        );

    let preview_img = if flattens {
        let bg = parse_hex_rgb(&req.background_hex);
        DynamicImage::ImageRgb8(composite_rgba_over_rgb(&decoded.image.to_rgba8(), bg))
    } else {
        decoded.image
    };

    let url = encode_preview_data_url(
        &preview_img,
        PREVIEW_MAX_EDGE,
        !flattens && decoded.has_alpha,
    )
    .ok_or_else(|| AppError::decode_failed("Failed encoding convert preview."))?;

    Ok(PreviewConvertImageResponse {
        preview_data_url: url,
        display_width: w,
        display_height: h,
        has_alpha: decoded.has_alpha,
        flattened_alpha: flattens,
    })
}

pub fn convert_images_batch_impl<F>(
    task_id: &str,
    req: &ConvertImagesBatchRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: F,
) -> Result<BatchImageJobResponse, AppError>
where
    F: FnMut(&ImageBatchProgressPayload),
{
    let output_dir = validate_output_directory(&req.output_dir)?;
    let bg_rgb = parse_hex_rgb(&req.background_hex);
    let heic_caps = get_heic_capabilities();
    let total = req.source_paths.len();

    let mut items = Vec::with_capacity(total);
    let mut succeeded = 0usize;
    let mut failed = 0usize;
    let mut skipped = 0usize;
    let mut total_orig = 0u64;
    let mut total_out = 0u64;
    let mut cancelled = false;

    for (idx, raw) in req.source_paths.iter().enumerate() {
        if cancel_flag.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
        let path = PathBuf::from(raw);
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| raw.clone());
        let stem = path
            .file_stem()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "image".into());

        on_progress(&ImageBatchProgressPayload {
            task_id: task_id.to_string(),
            tool_id: "I05".into(),
            current_index: idx + 1,
            total_items: total,
            current_file_name: file_name.clone(),
        });

        let orig_bytes = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        total_orig = total_orig.saturating_add(orig_bytes);

        if req.target_format == ImageConvertTargetFormat::Heic && !heic_caps.encode_available {
            failed += 1;
            items.push(BatchImageItemOutcome {
                source_path: raw.clone(),
                file_name,
                output_path: None,
                status: BatchImageOutcomeStatus::Error,
                original_bytes: orig_bytes,
                output_bytes: 0,
                saved_percent: 0.0,
                output_width: None,
                output_height: None,
                codec_note: Some("WIC HEIC Encoder unavailable".into()),
                message: Some(format!(
                    "Current Windows machine cannot encode HEIC ({})",
                    heic_caps.encode_note
                )),
            });
            continue;
        }

        let decoded = match decode_image_to_display(&path) {
            Ok(d) => d,
            Err(err) => {
                failed += 1;
                items.push(BatchImageItemOutcome {
                    source_path: raw.clone(),
                    file_name,
                    output_path: None,
                    status: BatchImageOutcomeStatus::Error,
                    original_bytes: orig_bytes,
                    output_bytes: 0,
                    saved_percent: 0.0,
                    output_width: None,
                    output_height: None,
                    codec_note: None,
                    message: Some(err.message),
                });
                continue;
            }
        };

        if cancel_flag.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }

        let (dw, dh) = decoded.image.dimensions();
        let encoded_res: Result<(Vec<u8>, String), AppError> = match req.target_format {
            ImageConvertTargetFormat::Jpeg => {
                let rgb = if decoded.has_alpha {
                    composite_rgba_over_rgb(&decoded.image.to_rgba8(), bg_rgb)
                } else {
                    decoded.image.to_rgb8()
                };
                encode_jpeg_bytes(
                    &rgb,
                    req.quality,
                    req.quality >= 90,
                    decoded.icc_profile.as_deref(),
                )
                .map(|b| (b, format!("JPEG Q{}", req.quality.clamp(1, 100))))
            }
            ImageConvertTargetFormat::Png => {
                encode_png_lossless_bytes(&decoded.image, 1, decoded.icc_profile.as_deref())
                    .map(|b| (b, "PNG (Lossless)".into()))
            }
            ImageConvertTargetFormat::Webp => encode_webp_bytes(
                &decoded.image,
                req.quality,
                req.webp_lossless,
                decoded.icc_profile.as_deref(),
            )
            .map(|b| {
                (
                    b,
                    if req.webp_lossless {
                        "WebP (Lossless)".into()
                    } else {
                        format!("WebP Q{}", req.quality.clamp(1, 100))
                    },
                )
            }),
            ImageConvertTargetFormat::Tiff => {
                encode_tiff_bytes(&decoded.image).map(|b| (b, "TIFF".into()))
            }
            ImageConvertTargetFormat::Bmp => {
                encode_bmp_bytes(&decoded.image, bg_rgb).map(|b| (b, "BMP (24-bit)".into()))
            }
            ImageConvertTargetFormat::Heic => encode_heic_bytes_via_wic(
                &decoded.image.to_rgba8(),
                req.quality,
                decoded.icc_profile.as_deref(),
            )
            .map(|b| (b, format!("HEIC Q{} (WIC)", req.quality.clamp(1, 100)))),
        };

        match encoded_res {
            Ok((out_bytes, codec_note)) => {
                if cancel_flag.load(Ordering::Relaxed) {
                    cancelled = true;
                    break;
                }
                match write_unique_output_file(
                    &output_dir,
                    &stem,
                    req.target_format.extension(),
                    &out_bytes,
                ) {
                    Ok(out_path) => {
                        let out_len = out_bytes.len() as u64;
                        total_out = total_out.saturating_add(out_len);
                        succeeded += 1;
                        let saved = compute_saved_percent(orig_bytes, out_len);
                        items.push(BatchImageItemOutcome {
                            source_path: raw.clone(),
                            file_name,
                            output_path: Some(out_path.to_string_lossy().into_owned()),
                            status: BatchImageOutcomeStatus::Ok,
                            original_bytes: orig_bytes,
                            output_bytes: out_len,
                            saved_percent: saved,
                            output_width: Some(dw),
                            output_height: Some(dh),
                            codec_note: Some(codec_note),
                            message: None,
                        });
                    }
                    Err(err) => {
                        failed += 1;
                        items.push(BatchImageItemOutcome {
                            source_path: raw.clone(),
                            file_name,
                            output_path: None,
                            status: BatchImageOutcomeStatus::Error,
                            original_bytes: orig_bytes,
                            output_bytes: 0,
                            saved_percent: 0.0,
                            output_width: None,
                            output_height: None,
                            codec_note: None,
                            message: Some(err.message),
                        });
                    }
                }
            }
            Err(err) => {
                failed += 1;
                items.push(BatchImageItemOutcome {
                    source_path: raw.clone(),
                    file_name,
                    output_path: None,
                    status: BatchImageOutcomeStatus::Error,
                    original_bytes: orig_bytes,
                    output_bytes: 0,
                    saved_percent: 0.0,
                    output_width: None,
                    output_height: None,
                    codec_note: None,
                    message: Some(err.message),
                });
            }
        }
    }

    if cancelled {
        for raw in req.source_paths.iter().skip(items.len()) {
            let file_name = Path::new(raw)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| raw.clone());
            skipped += 1;
            items.push(BatchImageItemOutcome {
                source_path: raw.clone(),
                file_name,
                output_path: None,
                status: BatchImageOutcomeStatus::Skipped,
                original_bytes: 0,
                output_bytes: 0,
                saved_percent: 0.0,
                output_width: None,
                output_height: None,
                codec_note: None,
                message: Some("Cancelled before processing".into()),
            });
        }
    }

    Ok(BatchImageJobResponse {
        task_id: task_id.to_string(),
        tool_id: "I05".into(),
        output_dir: output_dir.to_string_lossy().into_owned(),
        cancelled,
        succeeded_count: succeeded,
        kept_original_count: 0,
        skipped_count: skipped,
        failed_count: failed,
        total_original_bytes: total_orig,
        total_output_bytes: total_out,
        items,
    })
}

fn compute_saved_percent(original: u64, output: u64) -> f64 {
    if original == 0 {
        return 0.0;
    }
    let diff = (original as f64) - (output as f64);
    ((diff / (original as f64)) * 1000.0).round() / 10.0
}

fn compress_single_in_memory(
    path: &Path,
    preset: CompressQualityPreset,
    png_mode: PngCompressMode,
) -> Result<(Vec<u8>, bool, String, DecodedDisplayImage, u64), AppError> {
    let orig_bytes =
        fs::read(path).map_err(|e| AppError::from_io(e, "Cannot read source image"))?;
    let orig_len = orig_bytes.len() as u64;
    let decoded = decode_image_to_display(path)?;

    let (candidate_bytes, codec_label) = match decoded.format {
        ImageFileFormat::Jpeg => {
            let (q, sub444) = match preset {
                CompressQualityPreset::Low => (62u8, false),
                CompressQualityPreset::Medium => (78u8, false),
                CompressQualityPreset::High => (88u8, true),
            };
            let rgb = decoded.image.to_rgb8();
            let bytes = encode_jpeg_bytes(&rgb, q, sub444, decoded.icc_profile.as_deref())?;
            (bytes, format!("JPEG Q{q}"))
        }
        ImageFileFormat::Png => match png_mode {
            PngCompressMode::Lossless => {
                let level = match preset {
                    CompressQualityPreset::Low => 4u8,
                    CompressQualityPreset::Medium => 3u8,
                    CompressQualityPreset::High => 2u8,
                };
                // Optimize raw PNG stream directly via oxipng (pixel-identical lossless)
                let mut opts = oxipng::Options::from_preset(level);
                opts.strip = oxipng::StripChunks::None;
                let opt_bytes = oxipng::optimize_from_memory(&orig_bytes, &opts).map_err(|e| {
                    AppError::decode_failed(format!("PNG lossless optimization failed: {e}"))
                })?;
                (opt_bytes, format!("PNG 无损优化 (oxipng L{level})"))
            }
            PngCompressMode::LossyPalette => {
                let colors = match preset {
                    CompressQualityPreset::Low => 64usize,
                    CompressQualityPreset::Medium => 128usize,
                    CompressQualityPreset::High => 256usize,
                };
                let bytes = encode_png_lossy_indexed_bytes(
                    &decoded.image.to_rgba8(),
                    colors,
                    decoded.icc_profile.as_deref(),
                )?;
                (bytes, format!("PNG 有损 8 位调色板 ({colors} 色)"))
            }
        },
        ImageFileFormat::Webp => {
            let q = match preset {
                CompressQualityPreset::Low => 58u8,
                CompressQualityPreset::Medium => 76u8,
                CompressQualityPreset::High => 88u8,
            };
            let bytes =
                encode_webp_bytes(&decoded.image, q, false, decoded.icc_profile.as_deref())?;
            (bytes, format!("WebP Q{q}"))
        }
        other => {
            return Err(AppError::invalid_param(format!(
                "I06 Compress supports JPEG, PNG, and WebP (got {:?}). Use I05 to convert first.",
                other
            )));
        }
    };

    // Never bloat: if same-format compressed output >= original bytes, preserve original bytes!
    if (candidate_bytes.len() as u64) >= orig_len {
        Ok((orig_bytes, true, codec_label, decoded, orig_len))
    } else {
        Ok((candidate_bytes, false, codec_label, decoded, orig_len))
    }
}

pub fn preview_compress_image_impl(
    req: &PreviewCompressImageRequest,
) -> Result<PreviewCompressImageResponse, AppError> {
    let path = validate_user_path(&req.path, "Compress preview image")?;
    let (out_bytes, kept_original, codec_label, decoded, orig_len) =
        compress_single_in_memory(&path, req.quality_preset, req.png_mode)?;
    let (w, h) = decoded.image.dimensions();

    let orig_url = encode_preview_data_url(&decoded.image, PREVIEW_MAX_EDGE, true)
        .ok_or_else(|| AppError::decode_failed("Failed encoding original preview."))?;

    let comp_url = if kept_original {
        orig_url.clone()
    } else {
        let comp_dyn = image::load_from_memory(&out_bytes).map_err(|e| {
            AppError::decode_failed(format!("Failed decoding compressed preview: {e}"))
        })?;
        encode_preview_data_url(&comp_dyn, PREVIEW_MAX_EDGE, true)
            .ok_or_else(|| AppError::decode_failed("Failed encoding compressed preview."))?
    };

    let comp_len = out_bytes.len() as u64;
    let saved_percent = if kept_original {
        0.0
    } else {
        compute_saved_percent(orig_len, comp_len)
    };

    Ok(PreviewCompressImageResponse {
        original_preview_data_url: orig_url,
        compressed_preview_data_url: comp_url,
        original_bytes: orig_len,
        compressed_bytes: comp_len,
        saved_percent,
        kept_original,
        width: w,
        height: h,
        format: decoded.format,
        codec_label,
    })
}

pub fn compress_images_batch_impl<F>(
    task_id: &str,
    req: &CompressImagesBatchRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: F,
) -> Result<BatchImageJobResponse, AppError>
where
    F: FnMut(&ImageBatchProgressPayload),
{
    let output_dir = validate_output_directory(&req.output_dir)?;
    let total = req.source_paths.len();
    let mut items = Vec::with_capacity(total);
    let mut succeeded = 0usize;
    let mut kept_orig_count = 0usize;
    let mut skipped = 0usize;
    let mut failed = 0usize;
    let mut total_orig = 0u64;
    let mut total_out = 0u64;
    let mut cancelled = false;

    for (idx, raw) in req.source_paths.iter().enumerate() {
        if cancel_flag.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
        let path = PathBuf::from(raw);
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| raw.clone());
        let stem = path
            .file_stem()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "image".into());

        on_progress(&ImageBatchProgressPayload {
            task_id: task_id.to_string(),
            tool_id: "I06".into(),
            current_index: idx + 1,
            total_items: total,
            current_file_name: file_name.clone(),
        });

        match compress_single_in_memory(&path, req.quality_preset, req.png_mode) {
            Ok((out_bytes, kept_original, codec_label, decoded, orig_len)) => {
                if cancel_flag.load(Ordering::Relaxed) {
                    cancelled = true;
                    break;
                }
                total_orig = total_orig.saturating_add(orig_len);
                let (w, h) = decoded.image.dimensions();
                let ext = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| decoded.format.default_extension());
                match write_unique_output_file(&output_dir, &stem, ext, &out_bytes) {
                    Ok(out_path) => {
                        let out_len = out_bytes.len() as u64;
                        total_out = total_out.saturating_add(out_len);
                        let (status, saved, msg) = if kept_original {
                            kept_orig_count += 1;
                            (
                                BatchImageOutcomeStatus::KeptOriginal,
                                0.0,
                                Some(
                                    "Compressed output was not smaller; preserved original bytes"
                                        .into(),
                                ),
                            )
                        } else {
                            succeeded += 1;
                            (
                                BatchImageOutcomeStatus::Ok,
                                compute_saved_percent(orig_len, out_len),
                                None,
                            )
                        };
                        items.push(BatchImageItemOutcome {
                            source_path: raw.clone(),
                            file_name,
                            output_path: Some(out_path.to_string_lossy().into_owned()),
                            status,
                            original_bytes: orig_len,
                            output_bytes: out_len,
                            saved_percent: saved,
                            output_width: Some(w),
                            output_height: Some(h),
                            codec_note: Some(codec_label),
                            message: msg,
                        });
                    }
                    Err(err) => {
                        failed += 1;
                        items.push(BatchImageItemOutcome {
                            source_path: raw.clone(),
                            file_name,
                            output_path: None,
                            status: BatchImageOutcomeStatus::Error,
                            original_bytes: orig_len,
                            output_bytes: 0,
                            saved_percent: 0.0,
                            output_width: None,
                            output_height: None,
                            codec_note: Some(codec_label),
                            message: Some(err.message),
                        });
                    }
                }
            }
            Err(err) => {
                let orig_len = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                total_orig = total_orig.saturating_add(orig_len);
                failed += 1;
                items.push(BatchImageItemOutcome {
                    source_path: raw.clone(),
                    file_name,
                    output_path: None,
                    status: BatchImageOutcomeStatus::Error,
                    original_bytes: orig_len,
                    output_bytes: 0,
                    saved_percent: 0.0,
                    output_width: None,
                    output_height: None,
                    codec_note: None,
                    message: Some(err.message),
                });
            }
        }
    }

    if cancelled {
        for raw in req.source_paths.iter().skip(items.len()) {
            let file_name = Path::new(raw)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| raw.clone());
            skipped += 1;
            items.push(BatchImageItemOutcome {
                source_path: raw.clone(),
                file_name,
                output_path: None,
                status: BatchImageOutcomeStatus::Skipped,
                original_bytes: 0,
                output_bytes: 0,
                saved_percent: 0.0,
                output_width: None,
                output_height: None,
                codec_note: None,
                message: Some("Cancelled before processing".into()),
            });
        }
    }

    Ok(BatchImageJobResponse {
        task_id: task_id.to_string(),
        tool_id: "I06".into(),
        output_dir: output_dir.to_string_lossy().into_owned(),
        cancelled,
        succeeded_count: succeeded,
        kept_original_count: kept_orig_count,
        skipped_count: skipped,
        failed_count: failed,
        total_original_bytes: total_orig,
        total_output_bytes: total_out,
        items,
    })
}

pub fn read_image_file_head(path: &Path) -> Result<BufReader<File>, AppError> {
    let f = File::open(path).map_err(|e| AppError::from_io(e, "Cannot open image"))?;
    Ok(BufReader::new(f))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use tempfile::tempdir;

    fn sha256_bytes(b: &[u8]) -> String {
        format!("{:x}", Sha256::digest(b))
    }

    fn create_sample_transparent_png(path: &Path) {
        let mut rgba = RgbaImage::new(64, 48);
        for (x, y, p) in rgba.enumerate_pixels_mut() {
            if x < 32 {
                // Transparent left half
                *p = image::Rgba([0, 0, 0, 0]);
            } else {
                // Solid blue right half
                *p = image::Rgba([20, 90, 220, 255]);
            }
            let _ = y;
        }
        DynamicImage::ImageRgba8(rgba)
            .save_with_format(path, ImageFormat::Png)
            .expect("save transparent png");
    }

    #[test]
    fn converts_transparent_png_with_background_isolates_same_names_and_survives_corrupted_item() {
        let dir = tempdir().expect("tempdir");
        let a_dir = dir.path().join("a");
        let b_dir = dir.path().join("b");
        let out_dir = dir.path().join("out");
        fs::create_dir_all(&a_dir).unwrap();
        fs::create_dir_all(&b_dir).unwrap();
        fs::create_dir_all(&out_dir).unwrap();

        let png_a = a_dir.join("logo.png");
        let png_b = b_dir.join("logo.png");
        let broken = dir.path().join("broken.png");
        create_sample_transparent_png(&png_a);
        create_sample_transparent_png(&png_b);
        fs::write(&broken, b"NOT_A_VALID_PNG_BYTES").unwrap();
        let orig_a_hash = sha256_bytes(&fs::read(&png_a).unwrap());

        let cancel = AtomicBool::new(false);
        let res = convert_images_batch_impl(
            "t-i05",
            &ConvertImagesBatchRequest {
                source_paths: vec![
                    png_a.to_string_lossy().into_owned(),
                    broken.to_string_lossy().into_owned(),
                    png_b.to_string_lossy().into_owned(),
                ],
                output_dir: out_dir.to_string_lossy().into_owned(),
                target_format: ImageConvertTargetFormat::Jpeg,
                quality: 92,
                webp_lossless: false,
                background_hex: "#00FF00".into(), // Bright green fill for transparent pixels
            },
            &cancel,
            |_| {},
        )
        .expect("convert batch");

        assert_eq!(res.succeeded_count, 2);
        assert_eq!(res.failed_count, 1);
        assert_eq!(res.items[1].status, BatchImageOutcomeStatus::Error);
        // Same-name inputs from a/ and b/ must NOT overwrite each other
        assert_ne!(res.items[0].output_path, res.items[2].output_path);

        // Verify source untouched and transparent pixel blended onto #00FF00 green!
        assert_eq!(sha256_bytes(&fs::read(&png_a).unwrap()), orig_a_hash);
        let out_img = image::open(res.items[0].output_path.as_ref().unwrap())
            .expect("open converted jpg")
            .to_rgb8();
        let tl = out_img.get_pixel(8, 8);
        assert!(
            tl[1] > 230 && tl[0] < 25 && tl[2] < 25,
            "expected green fill, got {tl:?}"
        );
    }

    #[test]
    fn compresses_jpeg_png_lossless_and_lossy_webp_and_keeps_original_when_not_smaller() {
        let dir = tempdir().expect("tempdir");
        let out_dir = dir.path().join("out");
        fs::create_dir_all(&out_dir).unwrap();

        // 1) Large noisy-ish RGB photo saved at high quality JPEG -> Medium compression saves space
        let photo_jpg = dir.path().join("photo.jpg");
        let mut rgb = image::RgbImage::new(320, 240);
        for (x, y, p) in rgb.enumerate_pixels_mut() {
            let v = ((x.wrapping_mul(17) ^ y.wrapping_mul(31)) & 0xFF) as u8;
            *p = image::Rgb([v, (x % 256) as u8, (y % 256) as u8]);
        }
        let high_jpg = encode_jpeg_bytes(&rgb, 98, true, None).expect("encode q98");
        fs::write(&photo_jpg, &high_jpg).unwrap();

        // 2) Already tiny compressed JPEG (Q20) -> High compression would bloat -> must keep original!
        let tiny_jpg = dir.path().join("already_tiny.jpg");
        let tiny_bytes = encode_jpeg_bytes(&rgb, 20, false, None).expect("encode q20");
        let tiny_hash = sha256_bytes(&tiny_bytes);
        fs::write(&tiny_jpg, &tiny_bytes).unwrap();

        // 3) Gradient PNG -> test Lossless vs Lossy Palette
        let grad_png = dir.path().join("ui_screen.png");
        let mut rgba = RgbaImage::new(200, 160);
        for (x, y, p) in rgba.enumerate_pixels_mut() {
            *p = image::Rgba([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8, 255]);
        }
        DynamicImage::ImageRgba8(rgba)
            .save_with_format(&grad_png, ImageFormat::Png)
            .unwrap();

        let cancel = AtomicBool::new(false);
        let jpg_res = compress_images_batch_impl(
            "t-i06-jpg",
            &CompressImagesBatchRequest {
                source_paths: vec![
                    photo_jpg.to_string_lossy().into_owned(),
                    tiny_jpg.to_string_lossy().into_owned(),
                ],
                output_dir: out_dir.to_string_lossy().into_owned(),
                quality_preset: CompressQualityPreset::High,
                png_mode: PngCompressMode::Lossless,
            },
            &cancel,
            |_| {},
        )
        .expect("compress jpegs");

        assert_eq!(jpg_res.items[0].status, BatchImageOutcomeStatus::Ok);
        assert!(jpg_res.items[0].output_bytes < jpg_res.items[0].original_bytes);
        assert_eq!(
            jpg_res.items[1].status,
            BatchImageOutcomeStatus::KeptOriginal
        );
        assert_eq!(jpg_res.items[1].saved_percent, 0.0);
        assert_eq!(
            sha256_bytes(&fs::read(jpg_res.items[1].output_path.as_ref().unwrap()).unwrap()),
            tiny_hash,
            "kept_original output must be byte-for-byte identical to source"
        );

        // Lossy PNG shrinks gradient PNG substantially
        let preview_lossy = preview_compress_image_impl(&PreviewCompressImageRequest {
            path: grad_png.to_string_lossy().into_owned(),
            quality_preset: CompressQualityPreset::Low,
            png_mode: PngCompressMode::LossyPalette,
        })
        .expect("preview lossy png");
        assert!(preview_lossy.compressed_bytes < preview_lossy.original_bytes);

        // Lossless WebP on photographic pseudo-random texture -> lossy WebP compression saves substantial space
        let mut photo_tex = image::RgbImage::new(320, 240);
        let mut rng: u32 = 0x1234_5678;
        for (x, y, p) in photo_tex.enumerate_pixels_mut() {
            rng ^= rng << 13;
            rng ^= rng >> 17;
            rng ^= rng << 5;
            let r = ((x * 255 / 320) as i32 + ((rng & 31) as i32 - 16)).clamp(0, 255) as u8;
            let g = ((y * 255 / 240) as i32 + (((rng >> 8) & 31) as i32 - 16)).clamp(0, 255) as u8;
            let b = ((((x + y) * 127) / 560) as i32 + (((rng >> 16) & 31) as i32 - 16))
                .clamp(0, 255) as u8;
            *p = image::Rgb([r, g, b]);
        }
        let webp_src = dir.path().join("pic.webp");
        let lossless_webp =
            encode_webp_bytes(&DynamicImage::ImageRgb8(photo_tex), 100, true, None).unwrap();
        fs::write(&webp_src, &lossless_webp).unwrap();
        let preview_webp = preview_compress_image_impl(&PreviewCompressImageRequest {
            path: webp_src.to_string_lossy().into_owned(),
            quality_preset: CompressQualityPreset::Medium,
            png_mode: PngCompressMode::Lossless,
        })
        .expect("preview webp");
        assert!(
            preview_webp.compressed_bytes < preview_webp.original_bytes,
            "expected lossy WebP ({}) < lossless WebP ({})",
            preview_webp.compressed_bytes,
            preview_webp.original_bytes
        );
    }

    #[cfg(windows)]
    #[test]
    fn converts_real_heic_to_jpg_on_windows_when_wic_heic_available() {
        let caps = get_heic_capabilities();
        if !caps.encode_available || !caps.decode_available {
            return;
        }
        let dir = tempdir().expect("tempdir");
        let out_dir = dir.path().join("out");
        fs::create_dir_all(&out_dir).unwrap();

        let src_rgba = RgbaImage::from_fn(96, 64, |x, y| {
            image::Rgba([(x * 2) as u8, (y * 3) as u8, 160, 255])
        });
        let heic_bytes = encode_heic_bytes_via_wic(&src_rgba, 90, None).expect("encode heic");
        let heic_path = dir.path().join("iphone_photo.heic");
        fs::write(&heic_path, &heic_bytes).unwrap();

        let cancel = AtomicBool::new(false);
        let res = convert_images_batch_impl(
            "t-heic-jpg",
            &ConvertImagesBatchRequest {
                source_paths: vec![heic_path.to_string_lossy().into_owned()],
                output_dir: out_dir.to_string_lossy().into_owned(),
                target_format: ImageConvertTargetFormat::Jpeg,
                quality: 88,
                webp_lossless: false,
                background_hex: "#FFFFFF".into(),
            },
            &cancel,
            |_| {},
        )
        .expect("heic to jpg");

        assert_eq!(res.succeeded_count, 1);
        let out_path = res.items[0].output_path.as_ref().unwrap();
        assert!(out_path.ends_with(".jpg"));
        let dec = image::open(out_path).expect("open converted jpg");
        assert_eq!(dec.dimensions(), (96, 64));
    }
}
