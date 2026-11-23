//! Phase 3A Batch 3 backend: I09 Container-Level Image Metadata Stripping.
//!
//! Strips EXIF, GPS, IPTC, XMP, comments, and duplicate metadata segments across
//! JPEG, PNG, WebP, and classic TIFF at the container level without lossy pixel
//! re-encoding. Preserves display orientation (Orientation tag 2..=8) and ICC
//! color profiles by default, runs a post-strip verification pass, and honestly
//! reports unsupported formats or TIFF variants (e.g. BigTIFF / SubIFD RAW)
//! without ever counting them as cleaned.

use crate::error::AppError;
use crate::image_core::{
    crc32_ieee, detect_format_from_bytes_and_ext, inspect_metadata_flags,
    read_exif_orientation_from_bytes, validate_output_directory, write_unique_output_file,
    BatchImageItemOutcome, BatchImageJobResponse, BatchImageOutcomeStatus,
    ImageBatchProgressPayload, ImageFileFormat, MAX_IMAGE_FILE_BYTES,
};
use image::GenericImageView;
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StripMetadataBatchRequest {
    pub source_paths: Vec<String>,
    pub output_dir: String,
    pub keep_orientation: bool,
    pub keep_color_profile: bool,
}

#[derive(Debug)]
struct StripContainerResult {
    bytes: Vec<u8>,
    removed_summary: Vec<String>,
    preserved_summary: Vec<String>,
}

/// Builds a minimal valid little-endian TIFF/EXIF payload containing STRICTLY
/// one tag: `Orientation (0x0112) = orientation` (zero GPS/camera/date/XMP/IPTC).
fn build_minimal_orientation_tiff(orientation: u16) -> Vec<u8> {
    let mut tiff = Vec::with_capacity(26);
    tiff.extend_from_slice(b"II");
    tiff.extend_from_slice(&42u16.to_le_bytes());
    tiff.extend_from_slice(&8u32.to_le_bytes());
    tiff.extend_from_slice(&1u16.to_le_bytes()); // 1 IFD entry
    tiff.extend_from_slice(&0x0112u16.to_le_bytes()); // Tag: Orientation
    tiff.extend_from_slice(&3u16.to_le_bytes()); // Type: SHORT
    tiff.extend_from_slice(&1u32.to_le_bytes()); // Count: 1
    tiff.extend_from_slice(&orientation.to_le_bytes());
    tiff.extend_from_slice(&0u16.to_le_bytes()); // padding
    tiff.extend_from_slice(&0u32.to_le_bytes()); // Next IFD = 0
    tiff
}

/// Finds the end offset (exclusive) of JPEG entropy scan data through EOI (`0xFFD9`),
/// properly skipping byte-stuffed `0xFF00` and restart markers `0xFFD0..=0xFFD7`.
fn find_jpeg_eoi_end(bytes: &[u8], scan_start: usize) -> Option<usize> {
    let mut i = scan_start;
    while i + 1 < bytes.len() {
        if bytes[i] == 0xFF {
            // Skip fill 0xFF bytes
            let mut j = i + 1;
            while j < bytes.len() && bytes[j] == 0xFF {
                j += 1;
            }
            if j >= bytes.len() {
                break;
            }
            let marker = bytes[j];
            if marker == 0x00 || matches!(marker, 0xD0..=0xD7) {
                i = j + 1;
                continue;
            }
            if marker == 0xD9 {
                return Some(j + 1);
            }
            // Progressive JPEGs can have multiple scans (DHT / SOS / etc.) before EOI
            if matches!(marker, 0xC0..=0xCF | 0xDA | 0xDB | 0xDC | 0xDD) && j + 2 < bytes.len() {
                let seg_len = u16::from_be_bytes([bytes[j + 1], bytes[j + 2]]) as usize;
                if seg_len >= 2 && j + 1 + seg_len <= bytes.len() {
                    i = j + 1 + seg_len;
                    continue;
                }
            }
            i = j + 1;
        } else {
            i += 1;
        }
    }
    None
}

fn strip_jpeg_container(
    bytes: &[u8],
    keep_orientation: bool,
    keep_color_profile: bool,
) -> Result<StripContainerResult, AppError> {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return Err(AppError::decode_failed("Invalid JPEG SOI header."));
    }

    let orig_orientation = read_exif_orientation_from_bytes(bytes);
    let mut out = Vec::with_capacity(bytes.len());
    out.extend_from_slice(&[0xFF, 0xD8]);

    let mut removed_exif = 0usize;
    let mut removed_xmp = 0usize;
    let mut removed_iptc = 0usize;
    let mut removed_com = 0usize;
    let mut removed_other_app = 0usize;
    let mut kept_icc = false;
    let mut kept_orientation_tag = false;

    let mut i = 2usize;
    while i < bytes.len() {
        if bytes[i] != 0xFF {
            return Err(AppError::decode_failed(
                "Malformed JPEG segment structure; cannot strip metadata reliably.",
            ));
        }
        while i < bytes.len() && bytes[i] == 0xFF {
            i += 1;
        }
        if i >= bytes.len() {
            return Err(AppError::decode_failed("Truncated JPEG marker."));
        }
        let marker = bytes[i];
        i += 1;

        if marker == 0xD9 {
            out.extend_from_slice(&[0xFF, 0xD9]);
            break;
        }
        if matches!(marker, 0xD0..=0xD7 | 0x01) {
            out.extend_from_slice(&[0xFF, marker]);
            continue;
        }
        if i + 2 > bytes.len() {
            return Err(AppError::decode_failed("Truncated JPEG segment length."));
        }
        let seg_len = u16::from_be_bytes([bytes[i], bytes[i + 1]]) as usize;
        if seg_len < 2 || i + seg_len > bytes.len() {
            return Err(AppError::decode_failed("Corrupted JPEG segment length."));
        }
        let payload = &bytes[i + 2..i + seg_len];

        if marker == 0xDA {
            // Inject minimal Orientation-only EXIF before SOS if needed
            if keep_orientation && (2..=8).contains(&orig_orientation) && !kept_orientation_tag {
                let mut exif_payload = Vec::with_capacity(32);
                exif_payload.extend_from_slice(b"Exif\0\0");
                exif_payload.extend_from_slice(&build_minimal_orientation_tiff(orig_orientation));
                let len = (exif_payload.len() + 2) as u16;
                out.extend_from_slice(&[0xFF, 0xE1]);
                out.extend_from_slice(&len.to_be_bytes());
                out.extend_from_slice(&exif_payload);
                kept_orientation_tag = true;
            }
            let scan_end = find_jpeg_eoi_end(bytes, i + seg_len).ok_or_else(|| {
                AppError::decode_failed("JPEG missing EOI marker; cannot strip safely.")
            })?;
            out.extend_from_slice(&[0xFF, 0xDA]);
            out.extend_from_slice(&bytes[i..scan_end]);
            break;
        }

        let keep_segment = match marker {
            0xE0 => true, // APP0 JFIF
            0xE1 => {
                if payload.starts_with(b"Exif\0\0") {
                    removed_exif += 1;
                } else if payload.starts_with(b"http://ns.adobe.com/xap/1.0/\0")
                    || payload.starts_with(b"http://ns.adobe.com/xmp/extension/\0")
                {
                    removed_xmp += 1;
                } else {
                    removed_other_app += 1;
                }
                false
            }
            0xE2 => {
                if keep_color_profile && payload.len() > 14 && payload.starts_with(b"ICC_PROFILE\0")
                {
                    kept_icc = true;
                    true
                } else {
                    removed_other_app += 1;
                    false
                }
            }
            0xED => {
                removed_iptc += 1;
                false
            }
            0xEE => true, // APP14 Adobe color transform (required for CMYK/YCCK display)
            0xFE => {
                removed_com += 1;
                false
            }
            0xE3..=0xEC | 0xEF => {
                removed_other_app += 1;
                false
            }
            _ => true, // SOF, DQT, DHT, DRI, etc.
        };

        if keep_segment {
            out.extend_from_slice(&[0xFF, marker]);
            out.extend_from_slice(&bytes[i..i + seg_len]);
        }
        i += seg_len;
    }

    let mut removed = Vec::new();
    if removed_exif > 0 {
        removed.push(format!("EXIF ({removed_exif})"));
    }
    if removed_xmp > 0 {
        removed.push(format!("XMP ({removed_xmp})"));
    }
    if removed_iptc > 0 {
        removed.push(format!("IPTC ({removed_iptc})"));
    }
    if removed_com > 0 {
        removed.push(format!("COM ({removed_com})"));
    }
    if removed_other_app > 0 {
        removed.push(format!("APP ({removed_other_app})"));
    }

    let mut preserved = Vec::new();
    if kept_orientation_tag {
        preserved.push(format!("Orientation={orig_orientation}"));
    }
    if kept_icc {
        preserved.push("ICC Profile".into());
    }
    preserved.push("Lossless JPEG DCT (no re-encode)".into());

    Ok(StripContainerResult {
        bytes: out,
        removed_summary: removed,
        preserved_summary: preserved,
    })
}

fn strip_png_container(
    bytes: &[u8],
    keep_orientation: bool,
    keep_color_profile: bool,
) -> Result<StripContainerResult, AppError> {
    if bytes.len() < 8 || &bytes[0..8] != b"\x89PNG\r\n\x1a\n" {
        return Err(AppError::decode_failed("Invalid PNG signature."));
    }

    let orig_orientation = read_exif_orientation_from_bytes(bytes);
    let mut out = Vec::with_capacity(bytes.len());
    out.extend_from_slice(&bytes[0..8]);

    let mut removed_exif = 0usize;
    let mut removed_text = 0usize;
    let mut removed_time = 0usize;
    let mut removed_other = 0usize;
    let mut kept_color = Vec::new();
    let mut kept_orient = false;
    let mut saw_iend = false;

    let mut i = 8usize;
    while i + 12 <= bytes.len() {
        let len = u32::from_be_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]) as usize;
        let kind = &bytes[i + 4..i + 8];
        let total = 12usize
            .checked_add(len)
            .ok_or_else(|| AppError::decode_failed("PNG chunk length overflow."))?;
        if i + total > bytes.len() {
            return Err(AppError::decode_failed("Truncated PNG chunk."));
        }

        let keep = match kind {
            b"IHDR" | b"PLTE" | b"IDAT" | b"IEND" | b"tRNS" | b"sBIT" | b"bKGD" | b"pHYs"
            | b"acTL" | b"fcTL" | b"fdAT" => true,
            b"iCCP" | b"sRGB" | b"gAMA" | b"cHRM" | b"cICP" | b"mDCV" | b"cLLI" => {
                if keep_color_profile {
                    let label = String::from_utf8_lossy(kind).into_owned();
                    if !kept_color.contains(&label) {
                        kept_color.push(label);
                    }
                    true
                } else {
                    false
                }
            }
            b"eXIf" => {
                removed_exif += 1;
                false
            }
            b"tEXt" | b"zTXt" | b"iTXt" => {
                removed_text += 1;
                false
            }
            b"tIME" => {
                removed_time += 1;
                false
            }
            _ => {
                // Unknown critical chunk (uppercase first letter) must be kept for decoding;
                // unknown ancillary chunk (lowercase first letter) is stripped safely.
                if (kind[0] & 0x20) == 0 {
                    true
                } else {
                    removed_other += 1;
                    false
                }
            }
        };

        if keep {
            out.extend_from_slice(&bytes[i..i + total]);
            // Inject minimal Orientation-only eXIf chunk right after IHDR if needed
            if kind == b"IHDR" && keep_orientation && (2..=8).contains(&orig_orientation) {
                let tiff = build_minimal_orientation_tiff(orig_orientation);
                let mut crc_in = Vec::with_capacity(4 + tiff.len());
                crc_in.extend_from_slice(b"eXIf");
                crc_in.extend_from_slice(&tiff);
                let crc = crc32_ieee(&crc_in);
                out.extend_from_slice(&(tiff.len() as u32).to_be_bytes());
                out.extend_from_slice(b"eXIf");
                out.extend_from_slice(&tiff);
                out.extend_from_slice(&crc.to_be_bytes());
                kept_orient = true;
            }
        }

        i += total;
        if kind == b"IEND" {
            saw_iend = true;
            break;
        }
    }

    if !saw_iend {
        return Err(AppError::decode_failed("PNG missing IEND chunk."));
    }

    let mut removed = Vec::new();
    if removed_exif > 0 {
        removed.push(format!("eXIf ({removed_exif})"));
    }
    if removed_text > 0 {
        removed.push(format!("Text/XMP/IPTC ({removed_text})"));
    }
    if removed_time > 0 {
        removed.push(format!("tIME ({removed_time})"));
    }
    if removed_other > 0 {
        removed.push(format!("Ancillary ({removed_other})"));
    }

    let mut preserved = Vec::new();
    if kept_orient {
        preserved.push(format!("Orientation={orig_orientation}"));
    }
    if !kept_color.is_empty() {
        preserved.push(format!("Color ({})", kept_color.join("/")));
    }
    preserved.push("Lossless PNG chunks (no re-encode)".into());

    Ok(StripContainerResult {
        bytes: out,
        removed_summary: removed,
        preserved_summary: preserved,
    })
}

fn strip_webp_container(
    bytes: &[u8],
    keep_orientation: bool,
    keep_color_profile: bool,
) -> Result<StripContainerResult, AppError> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return Err(AppError::decode_failed("Invalid WebP RIFF container."));
    }

    let orig_orientation = read_exif_orientation_from_bytes(bytes);
    let mut kept_chunks: Vec<([u8; 4], Vec<u8>)> = Vec::new();
    let mut removed_exif = 0usize;
    let mut removed_xmp = 0usize;
    let mut removed_other = 0usize;
    let mut kept_icc = false;
    let mut has_vp8x = false;

    let mut i = 12usize;
    while i + 8 <= bytes.len() {
        let fourcc: [u8; 4] = [bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]];
        let len =
            u32::from_le_bytes([bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]]) as usize;
        if i + 8 + len > bytes.len() {
            return Err(AppError::decode_failed("Truncated WebP RIFF chunk."));
        }
        let payload = &bytes[i + 8..i + 8 + len];
        let step = 8 + len + (len & 1);

        match &fourcc {
            b"VP8X" => {
                if payload.len() < 10 {
                    return Err(AppError::decode_failed("Malformed WebP VP8X chunk."));
                }
                has_vp8x = true;
                kept_chunks.push((fourcc, payload.to_vec()));
            }
            b"ICCP" => {
                if keep_color_profile {
                    kept_icc = true;
                    kept_chunks.push((fourcc, payload.to_vec()));
                } else {
                    removed_other += 1;
                }
            }
            b"ANIM" | b"ANMF" | b"ALPH" | b"VP8 " | b"VP8L" => {
                kept_chunks.push((fourcc, payload.to_vec()));
            }
            b"EXIF" => {
                removed_exif += 1;
            }
            b"XMP " => {
                removed_xmp += 1;
            }
            _ => {
                removed_other += 1;
            }
        }
        i += step;
    }

    if kept_chunks.is_empty() {
        return Err(AppError::decode_failed(
            "WebP contains no image bitstream chunks.",
        ));
    }

    let inject_orient = has_vp8x && keep_orientation && (2..=8).contains(&orig_orientation);
    if let Some((_, vp8x_data)) = kept_chunks.iter_mut().find(|(tag, _)| tag == b"VP8X") {
        // Clear XMP (0x04) and EXIF (0x08); set EXIF only if injecting minimal orientation; clear ICCP (0x20) if not kept
        vp8x_data[0] &= !0x04;
        if inject_orient {
            vp8x_data[0] |= 0x08;
        } else {
            vp8x_data[0] &= !0x08;
        }
        if !kept_icc {
            vp8x_data[0] &= !0x20;
        }
    }
    if inject_orient {
        kept_chunks.push((*b"EXIF", build_minimal_orientation_tiff(orig_orientation)));
    }

    let mut body = Vec::with_capacity(bytes.len());
    for (fourcc, payload) in kept_chunks {
        body.extend_from_slice(&fourcc);
        body.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        body.extend_from_slice(&payload);
        if payload.len() % 2 == 1 {
            body.push(0);
        }
    }

    let riff_size = u32::try_from(4 + body.len())
        .map_err(|_| AppError::size_limit("WebP RIFF size exceeds 4 GiB."))?;
    let mut out = Vec::with_capacity(12 + body.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&riff_size.to_le_bytes());
    out.extend_from_slice(b"WEBP");
    out.extend_from_slice(&body);

    let mut removed = Vec::new();
    if removed_exif > 0 {
        removed.push(format!("EXIF ({removed_exif})"));
    }
    if removed_xmp > 0 {
        removed.push(format!("XMP ({removed_xmp})"));
    }
    if removed_other > 0 {
        removed.push(format!("Other ({removed_other})"));
    }

    let mut preserved = Vec::new();
    if inject_orient {
        preserved.push(format!("Orientation={orig_orientation}"));
    }
    if kept_icc {
        preserved.push("ICC Profile".into());
    }
    preserved.push("Lossless WebP RIFF (no re-encode)".into());

    Ok(StripContainerResult {
        bytes: out,
        removed_summary: removed,
        preserved_summary: preserved,
    })
}

#[derive(Clone, Copy)]
enum TiffEndian {
    Little,
    Big,
}

impl TiffEndian {
    fn r16(self, b: &[u8]) -> u16 {
        match self {
            Self::Little => u16::from_le_bytes([b[0], b[1]]),
            Self::Big => u16::from_be_bytes([b[0], b[1]]),
        }
    }
    fn r32(self, b: &[u8]) -> u32 {
        match self {
            Self::Little => u32::from_le_bytes([b[0], b[1], b[2], b[3]]),
            Self::Big => u32::from_be_bytes([b[0], b[1], b[2], b[3]]),
        }
    }
    fn w16(self, out: &mut Vec<u8>, v: u16) {
        match self {
            Self::Little => out.extend_from_slice(&v.to_le_bytes()),
            Self::Big => out.extend_from_slice(&v.to_be_bytes()),
        }
    }
    fn w32(self, out: &mut Vec<u8>, v: u32) {
        match self {
            Self::Little => out.extend_from_slice(&v.to_le_bytes()),
            Self::Big => out.extend_from_slice(&v.to_be_bytes()),
        }
    }
}

fn tiff_type_byte_size(ty: u16) -> Option<usize> {
    match ty {
        1 | 2 | 6 | 7 => Some(1), // BYTE, ASCII, SBYTE, UNDEFINED
        3 | 8 => Some(2),         // SHORT, SSHORT
        4 | 9 | 11 => Some(4),    // LONG, SLONG, FLOAT
        5 | 10 | 12 => Some(8),   // RATIONAL, SRATIONAL, DOUBLE
        _ => None,
    }
}

fn is_allowed_display_tiff_tag(tag: u16, keep_orientation: bool, keep_color_profile: bool) -> bool {
    match tag {
        254
        | 255
        | 256
        | 257
        | 258
        | 259
        | 262
        | 266
        | 273
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
        | 512..=532 => true,
        274 => keep_orientation,
        34675 => keep_color_profile,
        _ => false,
    }
}

fn read_tiff_u32_array(
    bytes: &[u8],
    endian: TiffEndian,
    ty: u16,
    count: u32,
    val_off: &[u8; 4],
) -> Result<Vec<u32>, AppError> {
    let elem_sz = match ty {
        3 => 2usize,
        4 => 4usize,
        _ => {
            return Err(AppError::decode_failed(
                "Unsupported TIFF offset/count tag type.",
            ))
        }
    };
    let total = (count as usize)
        .checked_mul(elem_sz)
        .ok_or_else(|| AppError::decode_failed("TIFF array size overflow."))?;
    let raw_slice: &[u8] = if total <= 4 {
        &val_off[..total]
    } else {
        let off = endian.r32(val_off) as usize;
        if off + total > bytes.len() {
            return Err(AppError::decode_failed("TIFF array offset out of bounds."));
        }
        &bytes[off..off + total]
    };

    let mut out = Vec::with_capacity(count as usize);
    for idx in 0..(count as usize) {
        let start = idx * elem_sz;
        let val = if elem_sz == 2 {
            endian.r16(&raw_slice[start..start + 2]) as u32
        } else {
            endian.r32(&raw_slice[start..start + 4])
        };
        out.push(val);
    }
    Ok(out)
}

/// Lossless container-level Classic TIFF IFD stripper (single-page & multi-page).
/// Explicitly refuses BigTIFF (version 43) and SubIFD/DNG RAW variants instead of
/// misreporting them as cleaned.
fn strip_tiff_container(
    bytes: &[u8],
    keep_orientation: bool,
    keep_color_profile: bool,
) -> Result<StripContainerResult, AppError> {
    if bytes.len() < 8 {
        return Err(AppError::decode_failed("Truncated TIFF header."));
    }
    let endian = match &bytes[0..2] {
        b"II" => TiffEndian::Little,
        b"MM" => TiffEndian::Big,
        _ => {
            return Err(AppError::decode_failed(
                "Invalid TIFF byte-order signature.",
            ))
        }
    };
    let version = endian.r16(&bytes[2..4]);
    if version == 43 {
        return Err(AppError::decode_failed(
            "BigTIFF (64-bit offsets) cannot be reliably container-stripped; not counted as cleaned.",
        ));
    }
    if version != 42 {
        return Err(AppError::decode_failed(format!(
            "Unsupported TIFF version {version}; not counted as cleaned."
        )));
    }

    struct ParsedEntry {
        tag: u16,
        ty: u16,
        count: u32,
        data: Vec<u8>,
    }

    struct ParsedPage {
        entries: Vec<ParsedEntry>,
        strip_data: Vec<Vec<u8>>,
        uses_tiles: bool,
    }

    let mut pages: Vec<ParsedPage> = Vec::new();
    let mut removed_tags = 0usize;
    let mut kept_icc = false;
    let mut kept_orient: Option<u16> = None;
    let mut visited_ifds = std::collections::HashSet::new();
    let mut ifd_offset = endian.r32(&bytes[4..8]) as usize;

    while ifd_offset != 0 {
        if !visited_ifds.insert(ifd_offset) || pages.len() >= 128 {
            return Err(AppError::decode_failed(
                "Cyclic or oversized TIFF IFD chain.",
            ));
        }
        if ifd_offset + 2 > bytes.len() {
            return Err(AppError::decode_failed("TIFF IFD offset out of bounds."));
        }
        let num_entries = endian.r16(&bytes[ifd_offset..ifd_offset + 2]) as usize;
        let entries_start = ifd_offset + 2;
        let entries_end = entries_start + num_entries * 12;
        if entries_end + 4 > bytes.len() {
            return Err(AppError::decode_failed("Truncated TIFF IFD directory."));
        }

        let mut kept_entries: Vec<ParsedEntry> = Vec::new();
        let mut strip_offsets: Option<Vec<u32>> = None;
        let mut strip_counts: Option<Vec<u32>> = None;
        let mut tile_offsets: Option<Vec<u32>> = None;
        let mut tile_counts: Option<Vec<u32>> = None;

        for e_idx in 0..num_entries {
            let off = entries_start + e_idx * 12;
            let tag = endian.r16(&bytes[off..off + 2]);
            let ty = endian.r16(&bytes[off + 2..off + 4]);
            let count = endian.r32(&bytes[off + 4..off + 8]);
            let val_off: [u8; 4] = [
                bytes[off + 8],
                bytes[off + 9],
                bytes[off + 10],
                bytes[off + 11],
            ];

            // Reject SubIFDs (330) or DNG RAW (50706) cleanly
            if tag == 330 || tag == 50706 {
                return Err(AppError::decode_failed(
                    "TIFF contains SubIFD / RAW DNG structures that cannot be safely container-stripped; not counted as cleaned.",
                ));
            }

            if !is_allowed_display_tiff_tag(tag, keep_orientation, keep_color_profile) {
                removed_tags += 1;
                continue;
            }

            let elem_sz = tiff_type_byte_size(ty).ok_or_else(|| {
                AppError::decode_failed(format!("Unsupported TIFF tag type {ty} on tag {tag}."))
            })?;
            let byte_len = (count as usize)
                .checked_mul(elem_sz)
                .ok_or_else(|| AppError::decode_failed("TIFF tag size overflow."))?;

            let data = if byte_len <= 4 {
                val_off[..byte_len].to_vec()
            } else {
                let data_off = endian.r32(&val_off) as usize;
                if data_off + byte_len > bytes.len() {
                    return Err(AppError::decode_failed("TIFF tag payload out of bounds."));
                }
                bytes[data_off..data_off + byte_len].to_vec()
            };

            if tag == 273 {
                strip_offsets = Some(read_tiff_u32_array(bytes, endian, ty, count, &val_off)?);
            } else if tag == 279 {
                strip_counts = Some(read_tiff_u32_array(bytes, endian, ty, count, &val_off)?);
            } else if tag == 324 {
                tile_offsets = Some(read_tiff_u32_array(bytes, endian, ty, count, &val_off)?);
            } else if tag == 325 {
                tile_counts = Some(read_tiff_u32_array(bytes, endian, ty, count, &val_off)?);
            } else {
                if tag == 34675 {
                    kept_icc = true;
                }
                if tag == 274 && data.len() >= 2 {
                    let o = endian.r16(&data[0..2]);
                    if (2..=8).contains(&o) {
                        kept_orient = Some(o);
                    }
                }
                kept_entries.push(ParsedEntry {
                    tag,
                    ty,
                    count,
                    data,
                });
            }
        }

        let (offsets, counts, uses_tiles) =
            match (strip_offsets, strip_counts, tile_offsets, tile_counts) {
                (Some(so), Some(sc), None, None) if so.len() == sc.len() && !so.is_empty() => {
                    (so, sc, false)
                }
                (None, None, Some(to), Some(tc)) if to.len() == tc.len() && !to.is_empty() => {
                    (to, tc, true)
                }
                _ => {
                    return Err(AppError::decode_failed(
                    "TIFF page lacks standard strip/tile offset tables; not counted as cleaned.",
                ));
                }
            };

        let mut strip_data = Vec::with_capacity(offsets.len());
        for (&o, &c) in offsets.iter().zip(counts.iter()) {
            let start = o as usize;
            let len = c as usize;
            if start
                .checked_add(len)
                .map(|e| e > bytes.len())
                .unwrap_or(true)
            {
                return Err(AppError::decode_failed("TIFF pixel strip out of bounds."));
            }
            strip_data.push(bytes[start..start + len].to_vec());
        }

        pages.push(ParsedPage {
            entries: kept_entries,
            strip_data,
            uses_tiles,
        });

        ifd_offset = endian.r32(&bytes[entries_end..entries_end + 4]) as usize;
    }

    if pages.is_empty() {
        return Err(AppError::decode_failed("TIFF contains no image IFDs."));
    }

    // Serialize clean classic TIFF keeping exact byte order & raw pixel strips/tiles
    let mut out = Vec::with_capacity(bytes.len());
    match endian {
        TiffEndian::Little => out.extend_from_slice(b"II"),
        TiffEndian::Big => out.extend_from_slice(b"MM"),
    }
    endian.w16(&mut out, 42);
    let first_ifd_ptr_pos = out.len();
    endian.w32(&mut out, 0); // patched after first page data

    let mut prev_next_ifd_pos = first_ifd_ptr_pos;

    for mut page in pages {
        // Write all raw pixel strips/tiles first and collect their new offsets & byte counts
        let mut new_offsets: Vec<u32> = Vec::with_capacity(page.strip_data.len());
        let mut new_counts: Vec<u32> = Vec::with_capacity(page.strip_data.len());
        for chunk in &page.strip_data {
            if out.len() % 2 == 1 {
                out.push(0);
            }
            let off = u32::try_from(out.len())
                .map_err(|_| AppError::size_limit("TIFF output exceeds 4 GiB classic limit."))?;
            new_offsets.push(off);
            new_counts.push(chunk.len() as u32);
            out.extend_from_slice(chunk);
        }

        let (off_tag, cnt_tag) = if page.uses_tiles {
            (324, 325)
        } else {
            (273, 279)
        };
        let mut off_bytes = Vec::with_capacity(new_offsets.len() * 4);
        for v in &new_offsets {
            endian.w32(&mut off_bytes, *v);
        }
        let mut cnt_bytes = Vec::with_capacity(new_counts.len() * 4);
        for v in &new_counts {
            endian.w32(&mut cnt_bytes, *v);
        }
        page.entries.push(ParsedEntry {
            tag: off_tag,
            ty: 4,
            count: new_offsets.len() as u32,
            data: off_bytes,
        });
        page.entries.push(ParsedEntry {
            tag: cnt_tag,
            ty: 4,
            count: new_counts.len() as u32,
            data: cnt_bytes,
        });
        // TIFF spec requires IFD entries sorted in ascending tag order
        page.entries.sort_by_key(|e| e.tag);

        // Write out-of-line entry payloads (> 4 bytes) and record their offsets
        let mut entry_value_fields: Vec<[u8; 4]> = Vec::with_capacity(page.entries.len());
        for entry in &page.entries {
            if entry.data.len() <= 4 {
                let mut field = [0u8; 4];
                field[..entry.data.len()].copy_from_slice(&entry.data);
                entry_value_fields.push(field);
            } else {
                if out.len() % 2 == 1 {
                    out.push(0);
                }
                let data_off = u32::try_from(out.len()).map_err(|_| {
                    AppError::size_limit("TIFF output exceeds 4 GiB classic limit.")
                })?;
                out.extend_from_slice(&entry.data);
                let mut field_vec = Vec::with_capacity(4);
                endian.w32(&mut field_vec, data_off);
                entry_value_fields.push([field_vec[0], field_vec[1], field_vec[2], field_vec[3]]);
            }
        }

        if out.len() % 2 == 1 {
            out.push(0);
        }
        let this_ifd_off = u32::try_from(out.len())
            .map_err(|_| AppError::size_limit("TIFF output exceeds 4 GiB classic limit."))?;

        // Patch previous IFD pointer to this IFD
        let mut ptr_bytes = Vec::with_capacity(4);
        endian.w32(&mut ptr_bytes, this_ifd_off);
        out[prev_next_ifd_pos..prev_next_ifd_pos + 4].copy_from_slice(&ptr_bytes);

        // Emit IFD directory
        endian.w16(&mut out, page.entries.len() as u16);
        for (entry, field) in page.entries.iter().zip(entry_value_fields.iter()) {
            endian.w16(&mut out, entry.tag);
            endian.w16(&mut out, entry.ty);
            endian.w32(&mut out, entry.count);
            out.extend_from_slice(field);
        }
        prev_next_ifd_pos = out.len();
        endian.w32(&mut out, 0);
    }

    let mut removed = Vec::new();
    if removed_tags > 0 {
        removed.push(format!("TIFF metadata tags ({removed_tags})"));
    }
    let mut preserved = Vec::new();
    if let Some(o) = kept_orient {
        preserved.push(format!("Orientation={o}"));
    }
    if kept_icc {
        preserved.push("ICC Profile".into());
    }
    preserved.push("Lossless TIFF strips/tiles (no re-encode)".into());

    Ok(StripContainerResult {
        bytes: out,
        removed_summary: removed,
        preserved_summary: preserved,
    })
}

/// Independent post-strip verification pass guaranteeing zero residual
/// EXIF/GPS/IPTC/XMP/camera/datetime/comment metadata and structural readability.
fn verify_stripped_output(
    out_bytes: &[u8],
    format: ImageFileFormat,
    orig_path: &Path,
) -> Result<(u32, u32), AppError> {
    let after_flags = inspect_metadata_flags(out_bytes, format);
    if after_flags.has_gps
        || after_flags.has_camera_info
        || after_flags.has_datetime
        || after_flags.has_xmp
        || after_flags.has_iptc
        || after_flags.has_comments
        || after_flags.has_exif
    {
        return Err(AppError::decode_failed(format!(
            "Verification failed: residual metadata detected ({:?}); refusing to mark as cleaned.",
            after_flags.tag_highlights
        )));
    }

    // Verify container is still cleanly decodable
    let decoded = image::load_from_memory(out_bytes).map_err(|e| {
        AppError::decode_failed(format!(
            "Verification failed: cleaned {:?} image could not be decoded ({e}).",
            orig_path.file_name().unwrap_or_default()
        ))
    })?;
    Ok(decoded.dimensions())
}

/// Reuses I09's container-level metadata stripper and independent post-strip verifier on
/// encoded PNG or JPEG bytes so exported redacted copies contain zero EXIF, GPS, XMP, IPTC,
/// comments, or embedded thumbnails.
pub fn strip_encoded_bytes_privacy_verified(
    bytes: &[u8],
    format: ImageFileFormat,
) -> Result<Vec<u8>, AppError> {
    let stripped = match format {
        ImageFileFormat::Png => strip_png_container(bytes, false, false)?,
        ImageFileFormat::Jpeg => strip_jpeg_container(bytes, false, false)?,
        _ => {
            return Err(AppError::invalid_param(
                "Privacy metadata strip helper expects PNG or JPEG bytes.",
            ))
        }
    };
    let label = match format {
        ImageFileFormat::Png => Path::new("redacted.png"),
        ImageFileFormat::Jpeg => Path::new("redacted.jpg"),
        _ => Path::new("redacted.bin"),
    };
    verify_stripped_output(&stripped.bytes, format, label)?;
    Ok(stripped.bytes)
}

pub fn strip_images_metadata_batch_impl<F>(
    task_id: &str,
    req: &StripMetadataBatchRequest,
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
            tool_id: "I09".into(),
            current_index: idx + 1,
            total_items: total,
            current_file_name: file_name.clone(),
        });

        let meta = match fs::symlink_metadata(&path) {
            Ok(m) if m.is_file() && m.len() <= MAX_IMAGE_FILE_BYTES => m,
            Ok(m) if m.len() > MAX_IMAGE_FILE_BYTES => {
                failed += 1;
                items.push(BatchImageItemOutcome {
                    source_path: raw.clone(),
                    file_name,
                    output_path: None,
                    status: BatchImageOutcomeStatus::Error,
                    original_bytes: m.len(),
                    output_bytes: 0,
                    saved_percent: 0.0,
                    output_width: None,
                    output_height: None,
                    codec_note: None,
                    message: Some("File exceeds 128 MiB limit; not cleaned".into()),
                });
                continue;
            }
            Ok(_) | Err(_) => {
                failed += 1;
                items.push(BatchImageItemOutcome {
                    source_path: raw.clone(),
                    file_name,
                    output_path: None,
                    status: BatchImageOutcomeStatus::Error,
                    original_bytes: 0,
                    output_bytes: 0,
                    saved_percent: 0.0,
                    output_width: None,
                    output_height: None,
                    codec_note: None,
                    message: Some("Cannot read source image file".into()),
                });
                continue;
            }
        };

        let orig_bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(e) => {
                failed += 1;
                items.push(BatchImageItemOutcome {
                    source_path: raw.clone(),
                    file_name,
                    output_path: None,
                    status: BatchImageOutcomeStatus::Error,
                    original_bytes: meta.len(),
                    output_bytes: 0,
                    saved_percent: 0.0,
                    output_width: None,
                    output_height: None,
                    codec_note: None,
                    message: Some(e.to_string()),
                });
                continue;
            }
        };
        let orig_len = orig_bytes.len() as u64;
        total_orig = total_orig.saturating_add(orig_len);
        let format = detect_format_from_bytes_and_ext(&orig_bytes, &path);

        let stripped_res = match format {
            ImageFileFormat::Jpeg => {
                strip_jpeg_container(&orig_bytes, req.keep_orientation, req.keep_color_profile)
            }
            ImageFileFormat::Png => {
                strip_png_container(&orig_bytes, req.keep_orientation, req.keep_color_profile)
            }
            ImageFileFormat::Webp => {
                strip_webp_container(&orig_bytes, req.keep_orientation, req.keep_color_profile)
            }
            ImageFileFormat::Tiff => {
                strip_tiff_container(&orig_bytes, req.keep_orientation, req.keep_color_profile)
            }
            other => Err(AppError::invalid_param(format!(
                "Container metadata stripping supports JPEG, PNG, WebP, and classic TIFF (got {:?}); not counted as cleaned.",
                other
            ))),
        };

        match stripped_res {
            Ok(stripped) => {
                if cancel_flag.load(Ordering::Relaxed) {
                    cancelled = true;
                    break;
                }
                match verify_stripped_output(&stripped.bytes, format, &path) {
                    Ok((w, h)) => {
                        let ext = path
                            .extension()
                            .and_then(|e| e.to_str())
                            .filter(|s| !s.is_empty())
                            .unwrap_or_else(|| format.default_extension());
                        match write_unique_output_file(&output_dir, &stem, ext, &stripped.bytes) {
                            Ok(out_path) => {
                                let out_len = stripped.bytes.len() as u64;
                                total_out = total_out.saturating_add(out_len);
                                succeeded += 1;
                                let saved = if orig_len > 0 {
                                    (((orig_len as f64) - (out_len as f64)) / (orig_len as f64)
                                        * 1000.0)
                                        .round()
                                        / 10.0
                                } else {
                                    0.0
                                };
                                let removed_txt = if stripped.removed_summary.is_empty() {
                                    "Already clean (verified)".into()
                                } else {
                                    format!("Removed: {}", stripped.removed_summary.join(", "))
                                };
                                let kept_txt =
                                    format!("Kept: {}", stripped.preserved_summary.join(", "));
                                items.push(BatchImageItemOutcome {
                                    source_path: raw.clone(),
                                    file_name,
                                    output_path: Some(out_path.to_string_lossy().into_owned()),
                                    status: BatchImageOutcomeStatus::Ok,
                                    original_bytes: orig_len,
                                    output_bytes: out_len,
                                    saved_percent: saved,
                                    output_width: Some(w),
                                    output_height: Some(h),
                                    codec_note: Some(kept_txt),
                                    message: Some(removed_txt),
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
        tool_id: "I09".into(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image_core::{encode_jpeg_bytes, encode_webp_bytes, extract_icc_profile};
    use image::{DynamicImage, ImageFormat};
    use std::io::Cursor;
    use tempfile::tempdir;

    fn fake_icc_profile() -> Vec<u8> {
        // Minimal recognizable ICC-like payload bytes
        let mut p = vec![0u8; 128];
        p[0..4].copy_from_slice(&(128u32).to_be_bytes());
        p[36..40].copy_from_slice(b"acsp");
        p[64..76].copy_from_slice(b"WinKit-sRGB!");
        p
    }

    fn make_exif_with_gps_camera_and_orient6() -> Vec<u8> {
        // Little-endian TIFF with IFD0: Make(271), Orientation(274)=6, DateTime(306), GPSIFD(34853)
        let mut buf = Vec::new();
        buf.extend_from_slice(b"II");
        buf.extend_from_slice(&42u16.to_le_bytes());
        buf.extend_from_slice(&8u32.to_le_bytes());
        // IFD0 at 8: 4 entries (2 + 4*12 + 4 = 54 bytes -> ends at 62)
        buf.extend_from_slice(&4u16.to_le_bytes());
        let make_off = 62u32;
        let dt_off = 72u32;
        let gps_ifd_off = 96u32;

        // Entry 1: Make (271), ASCII(2), count=10 ("TestCam01\0")
        buf.extend_from_slice(&271u16.to_le_bytes());
        buf.extend_from_slice(&2u16.to_le_bytes());
        buf.extend_from_slice(&10u32.to_le_bytes());
        buf.extend_from_slice(&make_off.to_le_bytes());
        // Entry 2: Orientation (274), SHORT(3), count=1, value=6
        buf.extend_from_slice(&274u16.to_le_bytes());
        buf.extend_from_slice(&3u16.to_le_bytes());
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&6u16.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        // Entry 3: DateTime (306), ASCII(2), count=20 ("2026:11:23 08:00:00\0")
        buf.extend_from_slice(&306u16.to_le_bytes());
        buf.extend_from_slice(&2u16.to_le_bytes());
        buf.extend_from_slice(&20u32.to_le_bytes());
        buf.extend_from_slice(&dt_off.to_le_bytes());
        // Entry 4: GPS IFD pointer (34853), LONG(4), count=1
        buf.extend_from_slice(&34853u16.to_le_bytes());
        buf.extend_from_slice(&4u16.to_le_bytes());
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&gps_ifd_off.to_le_bytes());
        // Next IFD = 0
        buf.extend_from_slice(&0u32.to_le_bytes());

        assert_eq!(buf.len(), 62);
        buf.extend_from_slice(b"TestCam01\0"); // 62..72
        buf.extend_from_slice(b"2026:11:23 08:00:00\0"); // 72..92
        buf.extend_from_slice(&[0u8; 4]); // pad to 96
        assert_eq!(buf.len(), 96);

        // GPS IFD at 96: 1 entry GPSLatitudeRef(1) = "N\0"
        buf.extend_from_slice(&1u16.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes());
        buf.extend_from_slice(&2u16.to_le_bytes());
        buf.extend_from_slice(&2u32.to_le_bytes());
        buf.extend_from_slice(b"N\0\0\0");
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf
    }

    fn make_png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut c = Vec::with_capacity(12 + data.len());
        c.extend_from_slice(&(data.len() as u32).to_be_bytes());
        c.extend_from_slice(kind);
        c.extend_from_slice(data);
        let mut crc_in = Vec::with_capacity(4 + data.len());
        crc_in.extend_from_slice(kind);
        crc_in.extend_from_slice(data);
        c.extend_from_slice(&crc32_ieee(&crc_in).to_be_bytes());
        c
    }

    #[test]
    fn strips_duplicate_exif_gps_xmp_iptc_across_jpeg_png_webp_tiff_while_preserving_orientation_and_icc_and_rejects_bigtiff(
    ) {
        let dir = tempdir().expect("tempdir");
        let out_dir = dir.path().join("out");
        fs::create_dir_all(&out_dir).unwrap();

        let icc = fake_icc_profile();
        let exif_tiff = make_exif_with_gps_camera_and_orient6();
        let xmp_xml = b"<x:xmpmeta>SecretCameraLocation</x:xmpmeta>";

        // 1) JPEG with ICC + DUPLICATE EXIF(GPS/Camera/Orient6) + DUPLICATE XMP + IPTC + COM + trailing junk
        let base_rgb = image::RgbImage::from_fn(48, 32, |x, y| {
            image::Rgb([(x * 5) as u8, (y * 7) as u8, 180])
        });
        let base_jpg = encode_jpeg_bytes(&base_rgb, 92, true, Some(&icc)).unwrap();
        let mut dirty_jpg = Vec::new();
        dirty_jpg.extend_from_slice(&base_jpg[..2]);
        // Two duplicate EXIF APP1 segments
        for _ in 0..2 {
            let mut p = b"Exif\0\0".to_vec();
            p.extend_from_slice(&exif_tiff);
            dirty_jpg.extend_from_slice(&[0xFF, 0xE1]);
            dirty_jpg.extend_from_slice(&((p.len() + 2) as u16).to_be_bytes());
            dirty_jpg.extend_from_slice(&p);
        }
        // Two duplicate XMP APP1 segments
        for _ in 0..2 {
            let mut p = b"http://ns.adobe.com/xap/1.0/\0".to_vec();
            p.extend_from_slice(xmp_xml);
            dirty_jpg.extend_from_slice(&[0xFF, 0xE1]);
            dirty_jpg.extend_from_slice(&((p.len() + 2) as u16).to_be_bytes());
            dirty_jpg.extend_from_slice(&p);
        }
        // IPTC APP13 + COM
        let iptc = b"Photoshop 3.0\08BIM\x04\x04\0\0\0\0\0\x04TEST";
        dirty_jpg.extend_from_slice(&[0xFF, 0xED]);
        dirty_jpg.extend_from_slice(&((iptc.len() + 2) as u16).to_be_bytes());
        dirty_jpg.extend_from_slice(iptc);
        dirty_jpg.extend_from_slice(&[0xFF, 0xFE, 0x00, 0x08]);
        dirty_jpg.extend_from_slice(b"SECRET");
        dirty_jpg.extend_from_slice(&base_jpg[2..]);
        dirty_jpg.extend_from_slice(b"TRAILING_JUNK_META");
        let jpg_path = dir.path().join("dirty_photo.jpg");
        fs::write(&jpg_path, &dirty_jpg).unwrap();

        // 2) PNG with iCCP + eXIf + iTXt(XMP) + tEXt + tIME
        let mut raw_png = Vec::new();
        DynamicImage::ImageRgb8(base_rgb.clone())
            .write_to(&mut Cursor::new(&mut raw_png), ImageFormat::Png)
            .unwrap();
        let ihdr_len =
            u32::from_be_bytes([raw_png[8], raw_png[9], raw_png[10], raw_png[11]]) as usize;
        let split_at = 8 + 12 + ihdr_len;
        let mut dirty_png = Vec::new();
        dirty_png.extend_from_slice(&raw_png[..split_at]);
        {
            use flate2::write::ZlibEncoder;
            use flate2::Compression;
            use std::io::Write;
            let mut z = ZlibEncoder::new(Vec::new(), Compression::default());
            z.write_all(&icc).unwrap();
            let compressed_icc = z.finish().unwrap();
            let mut iccp_payload = b"sRGB\0\0".to_vec();
            iccp_payload.extend_from_slice(&compressed_icc);
            dirty_png.extend_from_slice(&make_png_chunk(b"iCCP", &iccp_payload));
        }
        dirty_png.extend_from_slice(&make_png_chunk(b"eXIf", &exif_tiff));
        dirty_png.extend_from_slice(&make_png_chunk(b"tEXt", b"Author\0PrivateUser"));
        let mut xmp_itxt = b"XML:com.adobe.xmp\0\0\0\0\0".to_vec();
        xmp_itxt.extend_from_slice(xmp_xml);
        dirty_png.extend_from_slice(&make_png_chunk(b"iTXt", &xmp_itxt));
        dirty_png.extend_from_slice(&make_png_chunk(b"tIME", &[0x07, 0xEA, 11, 23, 8, 0, 0]));
        dirty_png.extend_from_slice(&raw_png[split_at..]);
        let png_path = dir.path().join("dirty_png.png");
        fs::write(&png_path, &dirty_png).unwrap();

        // 3) Extended VP8X WebP with ICCP + EXIF + XMP
        let base_webp = encode_webp_bytes(
            &DynamicImage::ImageRgb8(base_rgb.clone()),
            90,
            false,
            Some(&icc),
        )
        .unwrap();
        let mut dirty_webp_body = base_webp[12..].to_vec();
        dirty_webp_body[8] |= 0x0C; // Set EXIF + XMP bits in VP8X
        dirty_webp_body.extend_from_slice(b"EXIF");
        dirty_webp_body.extend_from_slice(&(exif_tiff.len() as u32).to_le_bytes());
        dirty_webp_body.extend_from_slice(&exif_tiff);
        if exif_tiff.len() % 2 == 1 {
            dirty_webp_body.push(0);
        }
        dirty_webp_body.extend_from_slice(b"XMP ");
        dirty_webp_body.extend_from_slice(&(xmp_xml.len() as u32).to_le_bytes());
        dirty_webp_body.extend_from_slice(xmp_xml);
        if xmp_xml.len() % 2 == 1 {
            dirty_webp_body.push(0);
        }
        let mut dirty_webp = Vec::new();
        dirty_webp.extend_from_slice(b"RIFF");
        dirty_webp.extend_from_slice(&((4 + dirty_webp_body.len()) as u32).to_le_bytes());
        dirty_webp.extend_from_slice(b"WEBP");
        dirty_webp.extend_from_slice(&dirty_webp_body);
        let webp_path = dir.path().join("dirty_webp.webp");
        fs::write(&webp_path, &dirty_webp).unwrap();

        // 4) Classic TIFF with Software(305), DateTime(306), XMP(700), Orientation(274)=6, ICC(34675)
        let mut base_tiff = Vec::new();
        DynamicImage::ImageRgb8(base_rgb)
            .write_to(&mut Cursor::new(&mut base_tiff), ImageFormat::Tiff)
            .unwrap();
        // Use tiff encoder directly to inject metadata tags cleanly
        let tiff_path = dir.path().join("dirty_tiff.tif");
        {
            let mut tiff_buf = Cursor::new(Vec::new());
            let mut enc = tiff::encoder::TiffEncoder::new(&mut tiff_buf).unwrap();
            let mut img_enc = enc
                .new_image::<tiff::encoder::colortype::RGB8>(16, 12)
                .unwrap();
            img_enc
                .encoder()
                .write_tag(tiff::tags::Tag::Make, "SecretCamera")
                .unwrap();
            img_enc
                .encoder()
                .write_tag(tiff::tags::Tag::Software, "SecretTool")
                .unwrap();
            img_enc
                .encoder()
                .write_tag(tiff::tags::Tag::DateTime, "2026:11:23 08:00:00")
                .unwrap();
            img_enc
                .encoder()
                .write_tag(tiff::tags::Tag::Orientation, 6u16)
                .unwrap();
            img_enc
                .encoder()
                .write_tag(tiff::tags::Tag::Unknown(700), &xmp_xml[..])
                .unwrap();
            img_enc
                .encoder()
                .write_tag(tiff::tags::Tag::Unknown(34675), &icc[..])
                .unwrap();
            img_enc.write_data(&vec![120u8; 16 * 12 * 3]).unwrap();
            fs::write(&tiff_path, tiff_buf.into_inner()).unwrap();
        }

        // 5) BigTIFF header (magic 43) -> MUST be rejected honestly, NOT counted as cleaned!
        let bigtiff_path = dir.path().join("big_variant.tif");
        fs::write(
            &bigtiff_path,
            b"II\x2b\x00\x08\x00\x00\x00\x10\x00\x00\x00\x00\x00\x00\x00",
        )
        .unwrap();

        let cancel = AtomicBool::new(false);
        let res = strip_images_metadata_batch_impl(
            "t-i09",
            &StripMetadataBatchRequest {
                source_paths: vec![
                    jpg_path.to_string_lossy().into_owned(),
                    png_path.to_string_lossy().into_owned(),
                    webp_path.to_string_lossy().into_owned(),
                    tiff_path.to_string_lossy().into_owned(),
                    bigtiff_path.to_string_lossy().into_owned(),
                ],
                output_dir: out_dir.to_string_lossy().into_owned(),
                keep_orientation: true,
                keep_color_profile: true,
            },
            &cancel,
            |_| {},
        )
        .expect("strip batch");

        assert_eq!(res.succeeded_count, 4, "items: {:?}", res.items);
        assert_eq!(res.failed_count, 1);
        assert_eq!(res.items[4].status, BatchImageOutcomeStatus::Error);

        // Verify JPEG, PNG, WebP, TIFF cleaned outputs:
        // - Zero GPS / Camera / DateTime / XMP / IPTC / Comments
        // - Orientation = 6 preserved!
        // - ICC profile preserved across ALL FOUR formats!
        for (idx, fmt) in [
            (0, ImageFileFormat::Jpeg),
            (1, ImageFileFormat::Png),
            (2, ImageFileFormat::Webp),
            (3, ImageFileFormat::Tiff),
        ] {
            let out_p = res.items[idx].output_path.as_ref().unwrap();
            let cleaned = fs::read(out_p).unwrap();
            let flags = inspect_metadata_flags(&cleaned, fmt);
            assert!(
                !flags.has_gps
                    && !flags.has_camera_info
                    && !flags.has_datetime
                    && !flags.has_xmp
                    && !flags.has_iptc
                    && !flags.has_exif
                    && !flags.has_comments,
                "Residual metadata in {fmt:?}: {flags:?}"
            );
            assert_eq!(
                read_exif_orientation_from_bytes(&cleaned),
                6,
                "Orientation=6 not preserved for {fmt:?}"
            );
            assert_eq!(
                extract_icc_profile(&cleaned, fmt).as_deref(),
                Some(icc.as_slice()),
                "ICC profile not preserved for {fmt:?}"
            );
            assert!(!cleaned
                .windows(12)
                .any(|w| w == b"TestCam01\0\0\0" || w == b"SecretCamera"));
            assert!(!cleaned.windows(20).any(|w| w == b"SecretCameraLocation"));
        }
    }
}
