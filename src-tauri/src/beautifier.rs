use crate::error::AppError;
use crate::fs_guard::{validate_existing_input_file, write_output_bytes_safely};
use base64::Engine;
use image::codecs::png::PngEncoder;
use image::imageops::FilterType;
use image::{
    ColorType, DynamicImage, GenericImageView, ImageEncoder, ImageFormat, ImageReader, Rgba,
    RgbaImage,
};
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::path::Path;

pub const MAX_INPUT_FILE_BYTES: u64 = 50 * 1024 * 1024; // 50 MiB
pub const MAX_SOURCE_DIMENSION: u32 = 8192;
pub const MAX_SOURCE_PIXELS: u64 = 33_554_432; // 33.5 MP
pub const MAX_OUTPUT_DIMENSION: u32 = 10_000;
pub const MAX_OUTPUT_PIXELS: u64 = 48_000_000; // 48 MP (~192 MB RGBA ceiling)
const MAX_PREVIEW_SIDE: u32 = 1280;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AspectPreset {
    #[serde(rename = "original")]
    Original,
    #[serde(rename = "1:1")]
    Square,
    #[serde(rename = "16:9")]
    Wide16x9,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceImageInspection {
    pub path: String,
    pub file_name: String,
    pub width: u32,
    pub height: u32,
    pub has_alpha: bool,
    pub preview_data_url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeautifyExportParams {
    pub input_path: String,
    pub output_path: String,
    pub background_hex: String,
    pub padding: u32,
    pub corner_radius: u32,
    pub shadow_strength: u32,
    pub aspect_ratio: AspectPreset,
    pub overwrite: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeautifyExportResult {
    pub output_path: String,
    pub output_width: u32,
    pub output_height: u32,
    pub byte_length: u64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FrameLayout {
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub image_x: u32,
    pub image_y: u32,
    pub image_width: u32,
    pub image_height: u32,
    pub effective_radius: u32,
    pub shadow_blur: u32,
    pub shadow_offset_y: u32,
    pub shadow_opacity: f32,
}

pub fn parse_hex_rgb(hex: &str) -> Result<[u8; 3], AppError> {
    let trimmed = hex.trim();
    let digits = trimmed.strip_prefix('#').unwrap_or(trimmed);
    if digits.len() != 6 || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppError::invalid_param(
            "Background color must be a 6-digit hexadecimal #RRGGBB color.",
        ));
    }
    let r = u8::from_str_radix(&digits[0..2], 16).unwrap_or(255);
    let g = u8::from_str_radix(&digits[2..4], 16).unwrap_or(255);
    let b = u8::from_str_radix(&digits[4..6], 16).unwrap_or(255);
    Ok([r, g, b])
}

pub fn compute_frame_layout(
    src_w: u32,
    src_h: u32,
    padding: u32,
    corner_radius: u32,
    shadow_strength: u32,
    aspect: AspectPreset,
) -> Result<FrameLayout, AppError> {
    if src_w == 0 || src_h == 0 {
        return Err(AppError::invalid_param(
            "Source image dimensions must be positive.",
        ));
    }
    if src_w > MAX_SOURCE_DIMENSION
        || src_h > MAX_SOURCE_DIMENSION
        || u64::from(src_w) * u64::from(src_h) > MAX_SOURCE_PIXELS
    {
        return Err(AppError::size_limit(format!(
            "Source image ({src_w}x{src_h}) exceeds maximum supported dimensions ({MAX_SOURCE_DIMENSION}px / 33.5 MP)."
        )));
    }

    let pad = padding.min(240);
    let raw_radius = corner_radius.min(160);
    let strength = shadow_strength.min(100);

    let base_w = src_w.saturating_add(pad.saturating_mul(2));
    let base_h = src_h.saturating_add(pad.saturating_mul(2));

    let (canvas_width, canvas_height) = match aspect {
        AspectPreset::Original => (base_w, base_h),
        AspectPreset::Square => {
            let side = base_w.max(base_h);
            (side, side)
        }
        AspectPreset::Wide16x9 => {
            if u64::from(base_w) * 9 >= u64::from(base_h) * 16 {
                let target_h = ((f64::from(base_w) * 9.0) / 16.0).round() as u32;
                (base_w, base_h.max(target_h))
            } else {
                let target_w = ((f64::from(base_h) * 16.0) / 9.0).round() as u32;
                (base_w.max(target_w), base_h)
            }
        }
    };

    if canvas_width > MAX_OUTPUT_DIMENSION
        || canvas_height > MAX_OUTPUT_DIMENSION
        || u64::from(canvas_width) * u64::from(canvas_height) > MAX_OUTPUT_PIXELS
    {
        return Err(AppError::size_limit(format!(
            "Output canvas ({canvas_width}x{canvas_height}) exceeds safety limit ({MAX_OUTPUT_DIMENSION}px / 48 MP)."
        )));
    }

    let image_x = (canvas_width - src_w) / 2;
    let image_y = (canvas_height - src_h) / 2;
    let effective_radius = raw_radius.min(src_w.min(src_h) / 2);

    let shadow_blur = if strength > 0 {
        ((strength as f32) * 0.45).round() as u32
    } else {
        0
    };
    let shadow_offset_y = if strength > 0 {
        ((strength as f32) * 0.18).round() as u32
    } else {
        0
    };
    let shadow_opacity = if strength > 0 {
        ((strength as f32 / 100.0) * 0.48).min(0.55)
    } else {
        0.0
    };

    Ok(FrameLayout {
        canvas_width,
        canvas_height,
        image_x,
        image_y,
        image_width: src_w,
        image_height: src_h,
        effective_radius,
        shadow_blur,
        shadow_offset_y,
        shadow_opacity,
    })
}

fn open_validated_png_or_jpeg(path: &Path, byte_len: u64) -> Result<DynamicImage, AppError> {
    if byte_len > MAX_INPUT_FILE_BYTES {
        return Err(AppError::size_limit(format!(
            "Input image exceeds 50 MB safety limit ({:.2} MB).",
            byte_len as f64 / (1024.0 * 1024.0)
        )));
    }

    // First inspect format and header dimensions BEFORE allocating full RGBA decode buffer
    let header_reader = ImageReader::open(path)
        .map_err(|e| AppError::from_io(e, "Unable to open image file"))?
        .with_guessed_format()
        .map_err(|e| AppError::from_io(e, "Unable to inspect image header"))?;

    match header_reader.format() {
        Some(ImageFormat::Png) | Some(ImageFormat::Jpeg) => {}
        _ => {
            return Err(AppError::decode_failed(
                "Unsupported image format: only PNG and JPEG files are supported in Phase 1.",
            ));
        }
    }

    let (w, h) = header_reader
        .into_dimensions()
        .map_err(|_| AppError::decode_failed("Image header is corrupted or unreadable."))?;

    if w == 0
        || h == 0
        || w > MAX_SOURCE_DIMENSION
        || h > MAX_SOURCE_DIMENSION
        || u64::from(w) * u64::from(h) > MAX_SOURCE_PIXELS
    {
        return Err(AppError::size_limit(format!(
            "Image dimensions ({w}x{h}) exceed safety bounds ({MAX_SOURCE_DIMENSION}px / 33.5 MP)."
        )));
    }

    let reader = ImageReader::open(path)
        .map_err(|e| AppError::from_io(e, "Unable to reopen image file"))?
        .with_guessed_format()
        .map_err(|e| AppError::from_io(e, "Unable to read image stream"))?;

    reader
        .decode()
        .map_err(|_| AppError::decode_failed("Failed to decode PNG/JPEG pixel data."))
}

pub fn inspect_source_image(raw_path: &str) -> Result<SourceImageInspection, AppError> {
    let (path, byte_len) = validate_existing_input_file(raw_path)?;
    let decoded = open_validated_png_or_jpeg(&path, byte_len)?;
    let (width, height) = decoded.dimensions();

    let rgba = decoded.to_rgba8();
    let has_alpha = rgba.pixels().any(|p| p.0[3] < 255);

    // Downscale ONLY the in-UI preview thumbnail if the source is very large; export always reads 1:1 original!
    let preview_img = if width > MAX_PREVIEW_SIDE || height > MAX_PREVIEW_SIDE {
        decoded.resize(MAX_PREVIEW_SIDE, MAX_PREVIEW_SIDE, FilterType::Triangle)
    } else {
        decoded
    };

    let preview_rgba = preview_img.to_rgba8();
    let (pw, ph) = preview_rgba.dimensions();
    let mut png_bytes = Vec::new();
    PngEncoder::new(&mut png_bytes)
        .write_image(preview_rgba.as_raw(), pw, ph, ColorType::Rgba8.into())
        .map_err(|_| AppError::decode_failed("Failed to encode preview buffer."))?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();

    Ok(SourceImageInspection {
        path: path.to_string_lossy().into_owned(),
        file_name,
        width,
        height,
        has_alpha,
        preview_data_url: format!("data:image/png;base64,{b64}"),
    })
}

/// Anti-aliased SDF coverage [0.0, 1.0] for pixel `(px, py)` inside a `w x h` rounded rectangle.
#[inline]
fn rounded_rect_coverage(px: u32, py: u32, w: u32, h: u32, radius: f32) -> f32 {
    if radius <= 0.0 {
        return 1.0;
    }
    let x = px as f32 + 0.5;
    let y = py as f32 + 0.5;
    let wf = w as f32;
    let hf = h as f32;

    let dx = if x < radius {
        radius - x
    } else if x > wf - radius {
        x - (wf - radius)
    } else {
        0.0
    };

    let dy = if y < radius {
        radius - y
    } else if y > hf - radius {
        y - (hf - radius)
    } else {
        0.0
    };

    if dx <= 0.0 && dy <= 0.0 {
        return 1.0;
    }
    let dist = (dx * dx + dy * dy).sqrt() - radius;
    (0.5 - dist).clamp(0.0, 1.0)
}

/// O(W * H) separable horizontal + vertical sliding-window box blur on a single-channel alpha field.
fn box_blur_pass(src: &[f32], dst: &mut [f32], w: usize, h: usize, radius: usize) {
    if radius == 0 || w == 0 || h == 0 {
        dst.copy_from_slice(src);
        return;
    }
    let inv = 1.0 / (2 * radius + 1) as f32;
    let mut temp = vec![0.0f32; w * h];

    // Horizontal pass
    for y in 0..h {
        let row = y * w;
        let mut acc = src[row] * (radius + 1) as f32;
        for x in 1..=radius {
            acc += src[row + x.min(w - 1)];
        }
        for x in 0..w {
            temp[row + x] = acc * inv;
            let remove_idx = x.saturating_sub(radius);
            let add_idx = (x + radius + 1).min(w - 1);
            acc += src[row + add_idx] - src[row + remove_idx];
        }
    }

    // Vertical pass
    for x in 0..w {
        let mut acc = temp[x] * (radius + 1) as f32;
        for y in 1..=radius {
            acc += temp[y.min(h - 1) * w + x];
        }
        for y in 0..h {
            dst[y * w + x] = acc * inv;
            let remove_y = y.saturating_sub(radius);
            let add_y = (y + radius + 1).min(h - 1);
            acc += temp[add_y * w + x] - temp[remove_y * w + x];
        }
    }
}

pub fn render_beautified_rgba(
    src_rgba: &RgbaImage,
    bg_rgb: [u8; 3],
    layout: &FrameLayout,
) -> RgbaImage {
    let cw = layout.canvas_width as usize;
    let ch = layout.canvas_height as usize;
    let sw = layout.image_width;
    let sh = layout.image_height;
    let radius = layout.effective_radius as f32;

    // Precompute rounded-corner * source-alpha coverage for foreground image
    let mut fg_cov = vec![0.0f32; (sw as usize) * (sh as usize)];
    for py in 0..sh {
        let row_off = (py as usize) * (sw as usize);
        for px in 0..sw {
            let src_a = f32::from(src_rgba.get_pixel(px, py).0[3]) / 255.0;
            if src_a > 0.0 {
                let mask = rounded_rect_coverage(px, py, sw, sh, radius);
                fg_cov[row_off + px as usize] = src_a * mask;
            }
        }
    }

    // Start with opaque solid background canvas
    let mut canvas = RgbaImage::from_pixel(
        layout.canvas_width,
        layout.canvas_height,
        Rgba([bg_rgb[0], bg_rgb[1], bg_rgb[2], 255]),
    );

    // Render soft Gaussian-approximated drop shadow (3 separable box-blur passes) if enabled
    if layout.shadow_opacity > 0.0 && layout.shadow_blur > 0 {
        let mut shadow_a = vec![0.0f32; cw * ch];
        let mut shadow_b = vec![0.0f32; cw * ch];

        let ox = layout.image_x as usize;
        let oy = (layout.image_y + layout.shadow_offset_y) as usize;
        for py in 0..(sh as usize) {
            let dst_y = oy + py;
            if dst_y >= ch {
                break;
            }
            let src_row = py * (sw as usize);
            let dst_row = dst_y * cw;
            for px in 0..(sw as usize) {
                let dst_x = ox + px;
                if dst_x < cw {
                    shadow_a[dst_row + dst_x] = fg_cov[src_row + px] * layout.shadow_opacity;
                }
            }
        }

        let box_r = ((layout.shadow_blur as f32 * 0.6).round() as usize).max(1);
        box_blur_pass(&shadow_a, &mut shadow_b, cw, ch, box_r);
        box_blur_pass(&shadow_b, &mut shadow_a, cw, ch, box_r);
        box_blur_pass(&shadow_a, &mut shadow_b, cw, ch, box_r);

        let bg_rf = f32::from(bg_rgb[0]);
        let bg_gf = f32::from(bg_rgb[1]);
        let bg_bf = f32::from(bg_rgb[2]);

        for y in 0..ch {
            let row = y * cw;
            for x in 0..cw {
                let sa = shadow_b[row + x].clamp(0.0, 1.0);
                if sa > 0.001 {
                    let inv = 1.0 - sa;
                    canvas.put_pixel(
                        x as u32,
                        y as u32,
                        Rgba([
                            (bg_rf * inv).round() as u8,
                            (bg_gf * inv).round() as u8,
                            (bg_bf * inv).round() as u8,
                            255,
                        ]),
                    );
                }
            }
        }
    }

    // Composite 1:1 unscaled source pixels onto canvas
    for py in 0..sh {
        let row_off = (py as usize) * (sw as usize);
        let dst_y = layout.image_y + py;
        for px in 0..sw {
            let a = fg_cov[row_off + px as usize];
            if a <= 0.0 {
                continue;
            }
            let dst_x = layout.image_x + px;
            let src_px = src_rgba.get_pixel(px, py).0;
            if a >= 0.999 {
                canvas.put_pixel(dst_x, dst_y, Rgba([src_px[0], src_px[1], src_px[2], 255]));
            } else {
                let dst_px = canvas.get_pixel(dst_x, dst_y).0;
                let inv = 1.0 - a;
                let r = (f32::from(src_px[0]) * a + f32::from(dst_px[0]) * inv).round() as u8;
                let g = (f32::from(src_px[1]) * a + f32::from(dst_px[1]) * inv).round() as u8;
                let b = (f32::from(src_px[2]) * a + f32::from(dst_px[2]) * inv).round() as u8;
                canvas.put_pixel(dst_x, dst_y, Rgba([r, g, b, 255]));
            }
        }
    }

    canvas
}

pub fn export_beautified_png_sync(
    params: &BeautifyExportParams,
) -> Result<BeautifyExportResult, AppError> {
    let (input_path, byte_len) = validate_existing_input_file(&params.input_path)?;
    let bg_rgb = parse_hex_rgb(&params.background_hex)?;
    let decoded = open_validated_png_or_jpeg(&input_path, byte_len)?;
    let src_rgba = decoded.to_rgba8();
    let (src_w, src_h) = src_rgba.dimensions();

    let layout = compute_frame_layout(
        src_w,
        src_h,
        params.padding,
        params.corner_radius,
        params.shadow_strength,
        params.aspect_ratio,
    )?;

    let rendered = render_beautified_rgba(&src_rgba, bg_rgb, &layout);

    let mut png_bytes = Vec::new();
    PngEncoder::new(Cursor::new(&mut png_bytes))
        .write_image(
            rendered.as_raw(),
            layout.canvas_width,
            layout.canvas_height,
            ColorType::Rgba8.into(),
        )
        .map_err(|_| AppError::decode_failed("Failed to encode output PNG image."))?;

    let saved = write_output_bytes_safely(
        &params.output_path,
        Some(&input_path),
        &png_bytes,
        params.overwrite,
    )?;

    Ok(BeautifyExportResult {
        output_path: saved.path,
        output_width: layout.canvas_width,
        output_height: layout.canvas_height,
        byte_length: saved.byte_length,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::RgbImage;
    use tempfile::tempdir;

    #[test]
    fn exports_redecodable_png_for_landscape_portrait_and_transparent_inputs_without_overwriting_source(
    ) {
        let dir = tempdir().expect("tempdir");
        let sub = dir.path().join("截图 美化 测试");
        std::fs::create_dir_all(&sub).expect("mkdir");

        // 1. Landscape transparent PNG (120x60) with transparent center hole and red opaque border
        let mut trans_src = RgbaImage::from_pixel(120, 60, Rgba([220, 40, 40, 255]));
        for y in 20..40 {
            for x in 40..80 {
                trans_src.put_pixel(x, y, Rgba([0, 0, 0, 0]));
            }
        }
        let src_png_path = sub.join("透明 横图 样例.png");
        trans_src.save(&src_png_path).expect("save src png");

        // Verify inspection detects alpha
        let info = inspect_source_image(&src_png_path.to_string_lossy()).expect("inspect");
        assert_eq!((info.width, info.height), (120, 60));
        assert!(info.has_alpha);
        assert!(info.preview_data_url.starts_with("data:image/png;base64,"));

        // Must refuse overwriting source image
        let same_err = export_beautified_png_sync(&BeautifyExportParams {
            input_path: src_png_path.to_string_lossy().into_owned(),
            output_path: src_png_path.to_string_lossy().into_owned(),
            background_hex: "#E8ECF2".to_string(),
            padding: 20,
            corner_radius: 8,
            shadow_strength: 24,
            aspect_ratio: AspectPreset::Original,
            overwrite: true,
        })
        .unwrap_err();
        assert_eq!(same_err.code, "SAME_INPUT_AND_OUTPUT");

        // Export Original aspect (120+40 x 60+40 = 160x100) and re-decode from disk
        let out_orig = sub.join("导出 原始比例.png");
        let exported = export_beautified_png_sync(&BeautifyExportParams {
            input_path: src_png_path.to_string_lossy().into_owned(),
            output_path: out_orig.to_string_lossy().into_owned(),
            background_hex: "#102030".to_string(),
            padding: 20,
            corner_radius: 10,
            shadow_strength: 0,
            aspect_ratio: AspectPreset::Original,
            overwrite: false,
        })
        .expect("export original");
        assert_eq!((exported.output_width, exported.output_height), (160, 100));

        let decoded_orig = image::open(&out_orig)
            .expect("redecode exported PNG")
            .to_rgba8();
        assert_eq!(decoded_orig.dimensions(), (160, 100));
        // Top-left padding pixel must equal #102030 (16, 32, 48, 255)
        assert_eq!(decoded_orig.get_pixel(2, 2).0, [16, 32, 48, 255]);
        // Center hole (80, 50) had alpha=0 in source, so background #102030 must show through!
        assert_eq!(decoded_orig.get_pixel(80, 50).0, [16, 32, 48, 255]);
        // Opaque red border pixel at (25, 30) in canvas (image starts at 20,20) must equal [220, 40, 40, 255]
        assert_eq!(decoded_orig.get_pixel(25, 30).0, [220, 40, 40, 255]);

        // 2. Portrait JPEG (80x140) exported to 16:9 canvas with shadow
        let portrait_jpg_path = sub.join("竖图 样例.jpg");
        let jpg_img = RgbImage::from_pixel(80, 140, image::Rgb([30, 120, 200]));
        jpg_img.save(&portrait_jpg_path).expect("save portrait jpg");

        let out_wide = sub.join("导出 宽屏 16x9.png");
        let wide_res = export_beautified_png_sync(&BeautifyExportParams {
            input_path: portrait_jpg_path.to_string_lossy().into_owned(),
            output_path: out_wide.to_string_lossy().into_owned(),
            background_hex: "#E8ECF2".to_string(),
            padding: 20,
            corner_radius: 12,
            shadow_strength: 30,
            aspect_ratio: AspectPreset::Wide16x9,
            overwrite: false,
        })
        .expect("export portrait 16:9");

        // base = 120 x 180 -> 16:9 width = round(180 * 16 / 9) = 320 -> 320 x 180
        assert_eq!((wide_res.output_width, wide_res.output_height), (320, 180));
        let decoded_wide = image::open(&out_wide).expect("redecode wide PNG");
        assert_eq!(decoded_wide.dimensions(), (320, 180));
    }

    #[test]
    fn rejects_oversized_dimensions_cleanly() {
        let err = compute_frame_layout(9000, 9000, 40, 12, 20, AspectPreset::Original).unwrap_err();
        assert_eq!(err.code, "SIZE_LIMIT_EXCEEDED");
    }
}
