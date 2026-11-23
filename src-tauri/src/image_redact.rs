//! Phase 3B Batch 2 backend: I11 Destructive Image Redaction (Blur, Pixelate, Solid Cover).
//!
//! Bakes all redaction regions irreversibly into the target RGBA pixel buffer so that:
//! - Solid cover regions replace 100% of original RGBA pixels with opaque `[r, g, b, 255]`
//!   (zero alpha blending, zero original pixel remnants).
//! - Pixelate regions replace each block with its uniform block average.
//! - Blur regions apply a 3-pass separable box blur strictly within the selected region.
//! - Exported PNG/JPEG files contain flat pixels only — zero embedded thumbnails, zero
//!   removable mask layers, and optional container-level privacy metadata stripping via I09.

use crate::beautifier::parse_hex_rgb;
use crate::error::AppError;
use crate::fs_guard::write_output_bytes_cancellable;
use crate::image_assets::{
    encode_rgba_to_png_fast, ImageAssetPayload, ImageAssetStore, SaveAssetFormat,
};
use crate::image_core::{composite_rgba_over_rgb, encode_jpeg_bytes, ImageFileFormat};
use crate::image_metadata::strip_encoded_bytes_privacy_verified;
use image::{Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RedactionKind {
    Blur,
    Pixelate,
    Solid,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactionRegion {
    pub kind: RedactionKind,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub strength: u32,
    pub color_hex: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyRedactionsAssetRequest {
    pub asset_id: String,
    pub regions: Vec<RedactionRegion>,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRedactedImageRequest {
    pub asset_id: String,
    pub source_path: Option<String>,
    pub regions: Vec<RedactionRegion>,
    pub output_path: String,
    pub format: SaveAssetFormat,
    pub jpeg_quality: Option<u8>,
    pub strip_metadata: bool,
    pub overwrite: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRedactedImageResult {
    pub output_path: String,
    pub width: u32,
    pub height: u32,
    pub byte_length: u64,
    pub metadata_stripped: bool,
}

fn clamp_region(img_w: u32, img_h: u32, r: &RedactionRegion) -> Option<(u32, u32, u32, u32)> {
    if r.width == 0 || r.height == 0 || img_w == 0 || img_h == 0 {
        return None;
    }
    let x0 = r.x.max(0) as u64;
    let y0 = r.y.max(0) as u64;
    let x1 = (i64::from(r.x) + i64::from(r.width)).clamp(0, i64::from(img_w)) as u64;
    let y1 = (i64::from(r.y) + i64::from(r.height)).clamp(0, i64::from(img_h)) as u64;
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    Some((x0 as u32, y0 as u32, (x1 - x0) as u32, (y1 - y0) as u32))
}

fn box_blur_channel(src: &[f32], dst: &mut [f32], w: usize, h: usize, radius: usize) {
    if radius == 0 || w == 0 || h == 0 {
        dst.copy_from_slice(src);
        return;
    }
    let inv = 1.0 / (2 * radius + 1) as f32;
    let mut tmp = vec![0.0f32; w * h];

    for y in 0..h {
        let row = y * w;
        let mut acc = src[row] * (radius + 1) as f32;
        for x in 1..=radius {
            acc += src[row + x.min(w - 1)];
        }
        for x in 0..w {
            tmp[row + x] = acc * inv;
            let rem = x.saturating_sub(radius);
            let add = (x + radius + 1).min(w - 1);
            acc += src[row + add] - src[row + rem];
        }
    }

    for x in 0..w {
        let mut acc = tmp[x] * (radius + 1) as f32;
        for y in 1..=radius {
            acc += tmp[y.min(h - 1) * w + x];
        }
        for y in 0..h {
            dst[y * w + x] = acc * inv;
            let rem = y.saturating_sub(radius);
            let add = (y + radius + 1).min(h - 1);
            acc += tmp[add * w + x] - tmp[rem * w + x];
        }
    }
}

fn blur_roi_in_place(img: &mut RgbaImage, rx: u32, ry: u32, rw: u32, rh: u32, radius: usize) {
    let w = rw as usize;
    let h = rh as usize;
    let n = w * h;
    if n == 0 || radius == 0 {
        return;
    }

    // 3-pass separable box blur closely approximates Gaussian blur while running in O(W * H).
    let mut ch_a = vec![0.0f32; n];
    let mut ch_b = vec![0.0f32; n];
    let mut channels = [
        vec![0.0f32; n],
        vec![0.0f32; n],
        vec![0.0f32; n],
        vec![0.0f32; n],
    ];

    for y in 0..h {
        for x in 0..w {
            let px = img.get_pixel(rx + x as u32, ry + y as u32).0;
            let idx = y * w + x;
            channels[0][idx] = f32::from(px[0]);
            channels[1][idx] = f32::from(px[1]);
            channels[2][idx] = f32::from(px[2]);
            channels[3][idx] = f32::from(px[3]);
        }
    }

    for ch in &mut channels {
        box_blur_channel(ch, &mut ch_a, w, h, radius);
        box_blur_channel(&ch_a, &mut ch_b, w, h, radius);
        box_blur_channel(&ch_b, ch, w, h, radius);
    }

    for y in 0..h {
        for x in 0..w {
            let idx = y * w + x;
            img.put_pixel(
                rx + x as u32,
                ry + y as u32,
                Rgba([
                    channels[0][idx].round().clamp(0.0, 255.0) as u8,
                    channels[1][idx].round().clamp(0.0, 255.0) as u8,
                    channels[2][idx].round().clamp(0.0, 255.0) as u8,
                    channels[3][idx].round().clamp(0.0, 255.0) as u8,
                ]),
            );
        }
    }
}

fn pixelate_roi_in_place(img: &mut RgbaImage, rx: u32, ry: u32, rw: u32, rh: u32, block: u32) {
    let step = block.clamp(4, 64);
    let mut by = 0u32;
    while by < rh {
        let bh = step.min(rh - by);
        let mut bx = 0u32;
        while bx < rw {
            let bw = step.min(rw - bx);
            let mut sum_r = 0u64;
            let mut sum_g = 0u64;
            let mut sum_b = 0u64;
            let mut sum_a = 0u64;
            let count = u64::from(bw) * u64::from(bh);

            for dy in 0..bh {
                for dx in 0..bw {
                    let p = img.get_pixel(rx + bx + dx, ry + by + dy).0;
                    sum_r += u64::from(p[0]);
                    sum_g += u64::from(p[1]);
                    sum_b += u64::from(p[2]);
                    sum_a += u64::from(p[3]);
                }
            }

            let avg = Rgba([
                ((sum_r + count / 2) / count) as u8,
                ((sum_g + count / 2) / count) as u8,
                ((sum_b + count / 2) / count) as u8,
                ((sum_a + count / 2) / count) as u8,
            ]);

            for dy in 0..bh {
                for dx in 0..bw {
                    img.put_pixel(rx + bx + dx, ry + by + dy, avg);
                }
            }

            bx += step;
        }
        by += step;
    }
}

/// Applies all redaction regions destructively in order onto a cloned RGBA buffer.
pub fn apply_redactions_rgba(
    src: &RgbaImage,
    regions: &[RedactionRegion],
) -> Result<RgbaImage, AppError> {
    if regions.len() > 256 {
        return Err(AppError::invalid_param(
            "Too many redaction regions (maximum 256 per image).",
        ));
    }

    let mut out = src.clone();
    let (img_w, img_h) = out.dimensions();

    for region in regions {
        let Some((rx, ry, rw, rh)) = clamp_region(img_w, img_h, region) else {
            continue;
        };
        match region.kind {
            RedactionKind::Solid => {
                let rgb = parse_hex_rgb(region.color_hex.as_deref().unwrap_or("#111827"))?;
                let solid = Rgba([rgb[0], rgb[1], rgb[2], 255]);
                for py in ry..ry + rh {
                    for px in rx..rx + rw {
                        out.put_pixel(px, py, solid);
                    }
                }
            }
            RedactionKind::Pixelate => {
                let block = region.strength.clamp(4, 64);
                pixelate_roi_in_place(&mut out, rx, ry, rw, rh, block);
            }
            RedactionKind::Blur => {
                let radius = region.strength.clamp(2, 60) as usize;
                blur_roi_in_place(&mut out, rx, ry, rw, rh, radius);
            }
        }
    }

    Ok(out)
}

pub fn apply_image_redactions_to_asset_impl(
    store: &ImageAssetStore,
    req: &ApplyRedactionsAssetRequest,
) -> Result<ImageAssetPayload, AppError> {
    let (src, orig_label) = store.get_rgba(&req.asset_id)?;
    let redacted = apply_redactions_rgba(&src, &req.regions)?;
    let label = req
        .label
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&orig_label)
        .to_string();
    store.insert_rgba(&redacted, label)
}

pub fn export_redacted_image_file_impl(
    store: &ImageAssetStore,
    req: &ExportRedactedImageRequest,
    cancel_flag: &AtomicBool,
) -> Result<ExportRedactedImageResult, AppError> {
    let (src, _) = store.get_rgba(&req.asset_id)?;
    let redacted = apply_redactions_rgba(&src, &req.regions)?;
    let (width, height) = redacted.dimensions();

    let (raw_bytes, img_format) = match req.format {
        SaveAssetFormat::Png => (encode_rgba_to_png_fast(&redacted)?, ImageFileFormat::Png),
        SaveAssetFormat::Jpeg => {
            let rgb = composite_rgba_over_rgb(&redacted, [255, 255, 255]);
            let quality = req.jpeg_quality.unwrap_or(92).clamp(60, 100);
            (
                encode_jpeg_bytes(&rgb, quality, true, None)?,
                ImageFileFormat::Jpeg,
            )
        }
    };

    let final_bytes = if req.strip_metadata {
        strip_encoded_bytes_privacy_verified(&raw_bytes, img_format)?
    } else {
        raw_bytes
    };

    let source_path_buf = req
        .source_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let saved = write_output_bytes_cancellable(
        &req.output_path,
        source_path_buf.as_deref(),
        &final_bytes,
        req.overwrite,
        Some(cancel_flag),
    )?;
    Ok(ExportRedactedImageResult {
        output_path: saved.path,
        width,
        height,
        byte_length: saved.byte_length,
        metadata_stripped: req.strip_metadata,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image_core::inspect_metadata_flags;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn solid_cover_completely_replaces_every_pixel_while_preserving_outside_pixels() {
        // High-contrast patterned image simulating readable text over varied colors
        let mut src = RgbaImage::new(120, 80);
        for y in 0..80 {
            for x in 0..120 {
                let v = if (x + y) % 2 == 0 { 245 } else { 15 };
                src.put_pixel(x, y, Rgba([v, (x * 2) as u8, (y * 3) as u8, 255]));
            }
        }

        let regions = vec![
            RedactionRegion {
                kind: RedactionKind::Solid,
                x: 20,
                y: 15,
                width: 50,
                height: 25,
                strength: 0,
                color_hex: Some("#111827".into()),
            },
            RedactionRegion {
                kind: RedactionKind::Pixelate,
                x: 80,
                y: 10,
                width: 30,
                height: 30,
                strength: 10,
                color_hex: None,
            },
            RedactionRegion {
                kind: RedactionKind::Blur,
                x: 10,
                y: 50,
                width: 40,
                height: 20,
                strength: 8,
                color_hex: None,
            },
        ];

        let out = apply_redactions_rgba(&src, &regions).expect("redact");

        // 1. Every single pixel inside solid region MUST equal [0x11, 0x18, 0x27, 0xFF]
        for y in 15..40 {
            for x in 20..70 {
                assert_eq!(
                    out.get_pixel(x, y).0,
                    [0x11, 0x18, 0x27, 0xFF],
                    "pixel ({x},{y}) inside solid redaction must have zero original data"
                );
            }
        }

        // 2. Pixels outside all regions must remain bit-for-bit identical
        assert_eq!(out.get_pixel(0, 0).0, src.get_pixel(0, 0).0);
        assert_eq!(out.get_pixel(119, 79).0, src.get_pixel(119, 79).0);
        assert_eq!(out.get_pixel(19, 15).0, src.get_pixel(19, 15).0);
        assert_eq!(out.get_pixel(70, 39).0, src.get_pixel(70, 39).0);

        // 3. Pixelate block [80..90, 10..20] must be completely uniform
        let block_ref = out.get_pixel(80, 10).0;
        for y in 10..20 {
            for x in 80..90 {
                assert_eq!(out.get_pixel(x, y).0, block_ref);
            }
        }

        // 4. Blur region must smooth the alternating 15/245 checkerboard dramatically
        let blurred_mid = out.get_pixel(30, 60).0[0];
        assert!(
            (90..=170).contains(&blurred_mid),
            "blurred midpoint should converge near ~130, got {blurred_mid}"
        );
    }

    #[test]
    fn exported_redacted_png_and_jpeg_have_zero_metadata_and_zero_thumbnails() {
        let dir = tempdir().expect("tempdir");
        let store = ImageAssetStore::default();
        let src = RgbaImage::from_pixel(160, 100, Rgba([220, 40, 40, 255]));
        let asset = store
            .insert_rgba(&src, "secret.png".into())
            .expect("insert");

        let regions = vec![RedactionRegion {
            kind: RedactionKind::Solid,
            x: 10,
            y: 10,
            width: 80,
            height: 30,
            strength: 0,
            color_hex: Some("#000000".into()),
        }];

        let cancel = AtomicBool::new(false);

        let png_path = dir.path().join("clean_redacted.png");
        let png_res = export_redacted_image_file_impl(
            &store,
            &ExportRedactedImageRequest {
                asset_id: asset.asset_id.clone(),
                source_path: None,
                regions: regions.clone(),
                output_path: png_path.to_string_lossy().into_owned(),
                format: SaveAssetFormat::Png,
                jpeg_quality: None,
                strip_metadata: true,
                overwrite: false,
            },
            &cancel,
        )
        .expect("export png");
        assert!(png_res.metadata_stripped);

        let png_bytes = fs::read(&png_path).expect("read png");
        let png_flags = inspect_metadata_flags(&png_bytes, ImageFileFormat::Png);
        assert!(!png_flags.has_exif && !png_flags.has_gps && !png_flags.has_xmp);
        let decoded_png = image::load_from_memory(&png_bytes)
            .expect("decode png")
            .to_rgba8();
        assert_eq!(decoded_png.get_pixel(40, 20).0, [0, 0, 0, 255]);
        assert_eq!(decoded_png.get_pixel(150, 90).0, [220, 40, 40, 255]);

        let jpg_path = dir.path().join("clean_redacted.jpg");
        let jpg_res = export_redacted_image_file_impl(
            &store,
            &ExportRedactedImageRequest {
                asset_id: asset.asset_id,
                source_path: None,
                regions,
                output_path: jpg_path.to_string_lossy().into_owned(),
                format: SaveAssetFormat::Jpeg,
                jpeg_quality: Some(95),
                strip_metadata: true,
                overwrite: false,
            },
            &cancel,
        )
        .expect("export jpg");
        assert!(jpg_res.metadata_stripped);

        let jpg_bytes = fs::read(&jpg_path).expect("read jpg");
        let jpg_flags = inspect_metadata_flags(&jpg_bytes, ImageFileFormat::Jpeg);
        assert!(
            !jpg_flags.has_exif && !jpg_flags.has_gps && !jpg_flags.has_xmp && !jpg_flags.has_iptc
        );
        // Ensure zero APP1 (EXIF/XMP) or APP13 (IPTC) or COM markers exist in the JPEG
        assert!(
            !jpg_bytes
                .windows(2)
                .any(|w| w == [0xFF, 0xE1] || w == [0xFF, 0xED] || w == [0xFF, 0xFE]),
            "redacted JPEG must contain zero EXIF/XMP/IPTC/comment segments or embedded thumbnails"
        );
    }
}
