//! Reusable offline OCR engine (RapidOCR PP-OCRv4 mobile on bundled ONNX Runtime CPU)
//! and structured text + geometry result contract shared across Phase 6 OCR workflows:
//! - `T03` Extract Text (images, clipboard screenshots, and multi-page scanned PDFs)
//! - `T04` Capture Text (screen region OCR reusing the same engine and line/span boxes)
//! - `P04` Make PDF Searchable (embedding invisible text layers aligned to `quad_norm`,
//!   `bbox_norm`, `angle_deg`, `spans`, `render_dpi`, and `source_width_pt`/`source_height_pt`).

use crate::error::AppError;
use crate::image_core::{
    composite_rgba_over_rgb, decode_image_to_display, encode_preview_data_url,
};
use crate::ocr_ort::{resolve_ocr_assets, OrtRuntime, OrtSession, OCR_ENGINE_DISPLAY_NAME};
use image::{DynamicImage, RgbImage};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::Path;
use std::time::Instant;

pub const OCR_PROGRESS_EVENT: &str = "winkit://ocr-progress";
pub const DEFAULT_DET_LIMIT_SIDE: u32 = 1280;
pub const MIN_DET_LIMIT_SIDE: u32 = 640;
pub const MAX_DET_LIMIT_SIDE: u32 = 2048;
pub const DEFAULT_PDF_OCR_DPI: f32 = 200.0;
pub const MAX_OCR_IMAGE_EDGE: u32 = 8192;
pub const MAX_OCR_BATCH_ITEMS: usize = 100;
const DET_THRESH: f32 = 0.30;
const DET_BOX_THRESH: f32 = 0.50;
const DET_UNCLIP_RATIO: f32 = 1.60;
const CLS_HEIGHT: usize = 48;
const CLS_MAX_WIDTH: usize = 192;
const CLS_THRESH: f32 = 0.90;
const REC_HEIGHT: usize = 48;
const REC_MIN_WIDTH: usize = 320;
const REC_MAX_WIDTH: usize = 2048;
const REC_BATCH_SIZE: usize = 6;
const MIN_LINE_CONFIDENCE: f32 = 0.40;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrPoint {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrNormPoint {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrBoundingBox {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// Token/word-level span aligned to CTC peak timesteps inside a recognized line.
/// Designed for `T04` fine selection and `P04` searchable-PDF invisible text layer alignment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrSpan {
    pub text: String,
    pub bbox_px: OcrBoundingBox,
    pub bbox_norm: OcrBoundingBox,
    /// Four corners ordered clockwise `[TL, TR, BR, BL]` in image pixel coordinates.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quad_px: Option<[OcrPoint; 4]>,
    pub char_start: usize,
    pub char_end: usize,
}

/// Single recognized text line with both pixel and normalized `[0, 1]` quad/bbox coordinates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrTextLine {
    pub index: usize,
    pub row_index: usize,
    pub text: String,
    pub confidence: f32,
    /// Four corners ordered clockwise `[TL, TR, BR, BL]` in image pixel coordinates.
    pub quad_px: [OcrPoint; 4],
    /// Four corners ordered clockwise `[TL, TR, BR, BL]` normalized to `[0.0, 1.0]`.
    pub quad_norm: [OcrNormPoint; 4],
    pub bbox_px: OcrBoundingBox,
    pub bbox_norm: OcrBoundingBox,
    /// Baseline tilt angle in degrees (positive = clockwise downward from horizontal).
    pub angle_deg: f32,
    pub rotated_180: bool,
    pub spans: Vec<OcrSpan>,
}

/// Complete OCR output for a single image or rendered PDF page.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrPageResult {
    pub page_number: usize,
    pub image_width_px: u32,
    pub image_height_px: u32,
    pub render_dpi: Option<f32>,
    pub source_width_pt: Option<f32>,
    pub source_height_pt: Option<f32>,
    pub text: String,
    pub lines: Vec<OcrTextLine>,
    pub line_count: usize,
    pub char_count: usize,
    pub average_confidence: f32,
    pub elapsed_ms: u64,
    pub preview_data_url: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrEngineStatus {
    pub ready: bool,
    pub engine_name: String,
    pub runtime_version: Option<String>,
    pub ocr_dir: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrRecognizeOptions {
    #[serde(default = "default_limit_side")]
    pub max_side_len: u32,
    #[serde(default = "default_true")]
    pub include_preview: bool,
}

fn default_limit_side() -> u32 {
    DEFAULT_DET_LIMIT_SIDE
}

fn default_true() -> bool {
    true
}

impl Default for OcrRecognizeOptions {
    fn default() -> Self {
        Self {
            max_side_len: DEFAULT_DET_LIMIT_SIDE,
            include_preview: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrProgressPayload {
    pub task_id: String,
    pub current_item: usize,
    pub total_items: usize,
    pub current_page: usize,
    pub total_pages: usize,
    pub label: String,
    pub percent: f64,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrInspectSourceItem {
    pub path: String,
    pub file_name: String,
    pub kind: String, // "image" | "pdf"
    pub byte_length: u64,
    pub width_px: Option<u32>,
    pub height_px: Option<u32>,
    pub page_count: usize,
    pub is_likely_scanned: bool,
    pub preview_data_url: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrBatchItemResult {
    pub source_id: String,
    pub source_path: Option<String>,
    pub source_name: String,
    pub kind: String,   // "image" | "pdf" | "clipboard"
    pub status: String, // "completed" | "failed" | "cancelled"
    pub pages: Vec<OcrPageResult>,
    pub combined_text: String,
    pub total_lines: usize,
    pub total_chars: usize,
    pub average_confidence: f32,
    pub elapsed_ms: u64,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrBatchResult {
    pub engine_name: String,
    pub items: Vec<OcrBatchItemResult>,
    pub completed_count: usize,
    pub failed_count: usize,
    pub cancelled: bool,
    pub total_pages: usize,
    pub total_lines: usize,
    pub total_chars: usize,
    pub total_elapsed_ms: u64,
}

/// Persistent warm RapidOCR PP-OCRv4 engine backed by dynamically loaded `onnxruntime.dll`.
/// Kept alive inside the isolated `--ocr-worker` subprocess across pages/images.
pub struct RapidOcrEngine {
    // SAFETY: `det`, `cls`, and `rec` borrow `runtime` which is owned inside a `Box` at a stable
    // heap address and dropped strictly AFTER the three sessions via field declaration order.
    det: OrtSession<'static>,
    cls: OrtSession<'static>,
    rec: OrtSession<'static>,
    _runtime: Box<OrtRuntime>,
    dictionary: Vec<String>,
    runtime_version: String,
}

impl RapidOcrEngine {
    pub fn load(resource_dir: Option<&Path>) -> Result<Self, AppError> {
        let assets = resolve_ocr_assets(resource_dir)?;
        let runtime = Box::new(OrtRuntime::load(
            &assets.dll_path,
            assets.qpdf_crt_dir.as_deref(),
        )?);
        let runtime_version = runtime.version_string().to_string();

        let threads = std::thread::available_parallelism()
            .map(|n| n.get().clamp(2, 4) as i32)
            .unwrap_or(4);

        // SAFETY: `runtime` is heap-pinned inside `Box<OrtRuntime>` and stored as a struct field
        // declared AFTER `det`, `cls`, and `rec`, so Rust's guaranteed field drop order drops all
        // three sessions strictly before freeing `_runtime`.
        let rt_ref: &'static OrtRuntime = unsafe { &*(&*runtime as *const OrtRuntime) };
        let det = rt_ref.create_session(&assets.det_model_path, threads)?;
        let cls = rt_ref.create_session(&assets.cls_model_path, threads)?;
        let rec = rt_ref.create_session(&assets.rec_model_path, threads)?;

        let char_meta = rec.lookup_custom_metadata("character")?.ok_or_else(|| {
            AppError::new(
                "OCR_ENGINE_LOAD_FAILED",
                "RapidOCR PP-OCRv4 rec model is missing embedded `character` dictionary metadata.",
            )
        })?;
        let mut dictionary: Vec<String> = Vec::with_capacity(6700);
        dictionary.push(String::new()); // index 0 = CTC blank
        for line in char_meta.lines() {
            dictionary.push(line.to_string());
        }
        dictionary.push(" ".to_string()); // trailing space class (index N+1)

        Ok(Self {
            det,
            cls,
            rec,
            _runtime: runtime,
            dictionary,
            runtime_version,
        })
    }

    pub fn runtime_version(&self) -> &str {
        &self.runtime_version
    }

    /// Runs full RapidOCR PP-OCRv4 (`det -> warp -> cls -> rec -> reading-order`) on an RGB image.
    pub fn recognize_rgb(
        &self,
        rgb: &RgbImage,
        page_number: usize,
        render_dpi: Option<f32>,
        source_width_pt: Option<f32>,
        source_height_pt: Option<f32>,
        options: &OcrRecognizeOptions,
    ) -> Result<OcrPageResult, AppError> {
        let t0 = Instant::now();
        let orig_w = rgb.width();
        let orig_h = rgb.height();
        if orig_w == 0 || orig_h == 0 {
            return Err(AppError::invalid_param(
                "OCR input image has zero dimensions.",
            ));
        }

        let mut warnings = Vec::new();
        let owned_scaled;
        let work_rgb: &RgbImage = if orig_w > MAX_OCR_IMAGE_EDGE || orig_h > MAX_OCR_IMAGE_EDGE {
            let scale = (MAX_OCR_IMAGE_EDGE as f32) / (orig_w.max(orig_h) as f32);
            let nw = ((orig_w as f32) * scale).round().max(1.0) as u32;
            let nh = ((orig_h as f32) * scale).round().max(1.0) as u32;
            warnings.push(format!(
                "Image ({orig_w}x{orig_h}) exceeded {MAX_OCR_IMAGE_EDGE} px safety cap and was downscaled to {nw}x{nh} for OCR."
            ));
            owned_scaled = DynamicImage::ImageRgb8(rgb.clone())
                .resize_exact(nw, nh, image::imageops::FilterType::Triangle)
                .to_rgb8();
            &owned_scaled
        } else {
            rgb
        };

        let limit_side = options
            .max_side_len
            .clamp(MIN_DET_LIMIT_SIDE, MAX_DET_LIMIT_SIDE);
        let raw_boxes = self.detect_text_boxes(work_rgb, limit_side)?;

        let mut crops: Vec<(RgbImage, bool)> = raw_boxes
            .iter()
            .map(|quad| crop_rotated_quad(work_rgb, quad))
            .collect();

        let rotated_flags = self.classify_and_fix_orientations(&mut crops)?;
        let decoded = self.recognize_crops(&crops)?;

        let scale_back_x = (orig_w as f32) / (work_rgb.width() as f32);
        let scale_back_y = (orig_h as f32) / (work_rgb.height() as f32);

        let mut candidates: Vec<RawLineCandidate> = Vec::new();
        for (i, quad_work) in raw_boxes.iter().enumerate() {
            let (ref text, conf, ref char_steps, total_steps) = decoded[i];
            if text.trim().is_empty() || conf < MIN_LINE_CONFIDENCE {
                continue;
            }
            let quad_px = [
                OcrPoint {
                    x: (quad_work[0].x * scale_back_x).clamp(0.0, orig_w as f32),
                    y: (quad_work[0].y * scale_back_y).clamp(0.0, orig_h as f32),
                },
                OcrPoint {
                    x: (quad_work[1].x * scale_back_x).clamp(0.0, orig_w as f32),
                    y: (quad_work[1].y * scale_back_y).clamp(0.0, orig_h as f32),
                },
                OcrPoint {
                    x: (quad_work[2].x * scale_back_x).clamp(0.0, orig_w as f32),
                    y: (quad_work[2].y * scale_back_y).clamp(0.0, orig_h as f32),
                },
                OcrPoint {
                    x: (quad_work[3].x * scale_back_x).clamp(0.0, orig_w as f32),
                    y: (quad_work[3].y * scale_back_y).clamp(0.0, orig_h as f32),
                },
            ];
            let rotated_180 = rotated_flags.get(i).copied().unwrap_or(false);
            let vertical_rot = crops[i].1;
            let spans = build_token_spans(
                text,
                char_steps,
                total_steps,
                &quad_px,
                orig_w,
                orig_h,
                rotated_180,
                vertical_rot,
            );
            candidates.push(RawLineCandidate {
                text: text.clone(),
                confidence: conf,
                quad_px,
                rotated_180,
                spans,
            });
        }

        let (lines, full_text) = assemble_reading_order(candidates, orig_w, orig_h);
        let line_count = lines.len();
        let char_count = full_text.chars().filter(|c| !c.is_whitespace()).count();
        let average_confidence = if line_count > 0 {
            let sum: f32 = lines.iter().map(|l| l.confidence).sum();
            ((sum / line_count as f32) * 10000.0).round() / 10000.0
        } else {
            0.0
        };

        let preview_data_url = if options.include_preview {
            let dyn_img = DynamicImage::ImageRgb8(work_rgb.clone());
            encode_preview_data_url(&dyn_img, 1400, false)
        } else {
            None
        };

        Ok(OcrPageResult {
            page_number,
            image_width_px: orig_w,
            image_height_px: orig_h,
            render_dpi,
            source_width_pt,
            source_height_pt,
            text: full_text,
            lines,
            line_count,
            char_count,
            average_confidence,
            elapsed_ms: t0.elapsed().as_millis() as u64,
            preview_data_url,
            warnings,
        })
    }

    pub fn recognize_image_file(
        &self,
        path: &Path,
        options: &OcrRecognizeOptions,
    ) -> Result<OcrPageResult, AppError> {
        let decoded = decode_image_to_display(path)?;
        let rgb = dynamic_to_white_rgb(&decoded.image);
        self.recognize_rgb(&rgb, 1, None, None, None, options)
    }

    pub fn recognize_image_bytes(
        &self,
        bytes: &[u8],
        options: &OcrRecognizeOptions,
    ) -> Result<OcrPageResult, AppError> {
        let img = image::load_from_memory(bytes).map_err(|e| {
            AppError::new(
                "IMAGE_DECODE_FAILED",
                format!("Unable to decode image bytes for OCR: {e}"),
            )
        })?;
        let rgb = dynamic_to_white_rgb(&img);
        self.recognize_rgb(&rgb, 1, None, None, None, options)
    }

    fn detect_text_boxes(
        &self,
        rgb: &RgbImage,
        limit_side_len: u32,
    ) -> Result<Vec<[OcrPoint; 4]>, AppError> {
        let w = rgb.width() as usize;
        let h = rgb.height() as usize;
        let max_side = w.max(h) as f32;
        let ratio = if max_side > limit_side_len as f32 {
            (limit_side_len as f32) / max_side
        } else {
            1.0
        };
        let nw = (((w as f32) * ratio / 32.0).round() as usize * 32).max(32);
        let nh = (((h as f32) * ratio / 32.0).round() as usize * 32).max(32);

        // Resize & normalize directly to BGR CHW f32 matching RapidOCR PP-OCRv4 det preprocessing.
        let plane = nw * nh;
        let mut inp = vec![0.0f32; 3 * plane];
        let mean = [0.485f32, 0.456f32, 0.406f32];
        let inv_std = [1.0 / 0.229f32, 1.0 / 0.224f32, 1.0 / 0.225f32];
        let raw = rgb.as_raw();

        for y in 0..nh {
            let src_y =
                ((y as f32 + 0.5) * (h as f32) / (nh as f32) - 0.5).clamp(0.0, (h - 1) as f32);
            let y0 = src_y.floor() as usize;
            let y1 = (y0 + 1).min(h - 1);
            let wy = src_y - y0 as f32;
            let wy0 = 1.0 - wy;

            for x in 0..nw {
                let src_x =
                    ((x as f32 + 0.5) * (w as f32) / (nw as f32) - 0.5).clamp(0.0, (w - 1) as f32);
                let x0 = src_x.floor() as usize;
                let x1 = (x0 + 1).min(w - 1);
                let wx = src_x - x0 as f32;
                let wx0 = 1.0 - wx;

                let i00 = (y0 * w + x0) * 3;
                let i10 = (y0 * w + x1) * 3;
                let i01 = (y1 * w + x0) * 3;
                let i11 = (y1 * w + x1) * 3;

                let r = wy0 * (wx0 * raw[i00] as f32 + wx * raw[i10] as f32)
                    + wy * (wx0 * raw[i01] as f32 + wx * raw[i11] as f32);
                let g = wy0 * (wx0 * raw[i00 + 1] as f32 + wx * raw[i10 + 1] as f32)
                    + wy * (wx0 * raw[i01 + 1] as f32 + wx * raw[i11 + 1] as f32);
                let b = wy0 * (wx0 * raw[i00 + 2] as f32 + wx * raw[i10 + 2] as f32)
                    + wy * (wx0 * raw[i01 + 2] as f32 + wx * raw[i11 + 2] as f32);

                let idx = y * nw + x;
                inp[idx] = (b / 255.0 - mean[0]) * inv_std[0];
                inp[plane + idx] = (g / 255.0 - mean[1]) * inv_std[1];
                inp[2 * plane + idx] = (r / 255.0 - mean[2]) * inv_std[2];
            }
        }

        let (dims, prob_map) = self.det.run_f32(&[1, 3, nh as i64, nw as i64], &inp)?;
        if dims.len() < 4 || prob_map.len() < plane {
            return Err(AppError::new(
                "OCR_INFERENCE_FAILED",
                format!("Unexpected detection output tensor shape: {dims:?}"),
            ));
        }

        let map_h = dims[2] as usize;
        let map_w = dims[3] as usize;
        let boxes = extract_dbnet_boxes(&prob_map, map_w, map_h, w as f32, h as f32);
        Ok(boxes)
    }

    fn classify_and_fix_orientations(
        &self,
        crops: &mut [(RgbImage, bool)],
    ) -> Result<Vec<bool>, AppError> {
        let mut rotated = vec![false; crops.len()];
        if crops.is_empty() {
            return Ok(rotated);
        }

        const CLS_BATCH: usize = 16;
        let plane = CLS_HEIGHT * CLS_MAX_WIDTH;
        for chunk_start in (0..crops.len()).step_by(CLS_BATCH) {
            let chunk_end = (chunk_start + CLS_BATCH).min(crops.len());
            let batch_len = chunk_end - chunk_start;
            let mut inp = vec![0.0f32; batch_len * 3 * plane];

            for (bi, (crop, _)) in crops[chunk_start..chunk_end].iter().enumerate() {
                let cw = crop.width().max(1) as f32;
                let ch = crop.height().max(1) as f32;
                let rw = ((CLS_HEIGHT as f32) * cw / ch)
                    .ceil()
                    .clamp(1.0, CLS_MAX_WIDTH as f32) as usize;
                fill_normalized_bgr_crop(
                    crop,
                    rw,
                    CLS_HEIGHT,
                    CLS_MAX_WIDTH,
                    &mut inp[bi * 3 * plane..(bi + 1) * 3 * plane],
                );
            }

            let (_dims, probs) = self.cls.run_f32(
                &[batch_len as i64, 3, CLS_HEIGHT as i64, CLS_MAX_WIDTH as i64],
                &inp,
            )?;

            for bi in 0..batch_len {
                let p180 = probs.get(bi * 2 + 1).copied().unwrap_or(0.0);
                if p180 > CLS_THRESH {
                    let idx = chunk_start + bi;
                    crops[idx].0 = image::imageops::rotate180(&crops[idx].0);
                    rotated[idx] = true;
                }
            }
        }

        Ok(rotated)
    }

    fn recognize_crops(
        &self,
        crops: &[(RgbImage, bool)],
    ) -> Result<Vec<DecodedCropLine>, AppError> {
        if crops.is_empty() {
            return Ok(Vec::new());
        }

        let mut order: Vec<usize> = (0..crops.len()).collect();
        order.sort_by(|&a, &b| {
            let ra = crops[a].0.width() as f32 / crops[a].0.height().max(1) as f32;
            let rb = crops[b].0.width() as f32 / crops[b].0.height().max(1) as f32;
            ra.total_cmp(&rb)
        });

        let mut results: Vec<DecodedCropLine> =
            vec![(String::new(), 0.0, Vec::new(), 1); crops.len()];

        for chunk in order.chunks(REC_BATCH_SIZE) {
            let max_wh = chunk
                .iter()
                .map(|&i| crops[i].0.width() as f32 / crops[i].0.height().max(1) as f32)
                .fold(0.0f32, f32::max);
            let target_w = ((REC_HEIGHT as f32) * max_wh)
                .ceil()
                .clamp(REC_MIN_WIDTH as f32, REC_MAX_WIDTH as f32)
                as usize;
            let plane = REC_HEIGHT * target_w;
            let batch_len = chunk.len();
            let mut inp = vec![0.0f32; batch_len * 3 * plane];

            let mut resized_widths = Vec::with_capacity(batch_len);
            for (bi, &idx) in chunk.iter().enumerate() {
                let crop = &crops[idx].0;
                let cw = crop.width().max(1) as f32;
                let ch = crop.height().max(1) as f32;
                let rw = ((REC_HEIGHT as f32) * cw / ch)
                    .ceil()
                    .clamp(1.0, target_w as f32) as usize;
                resized_widths.push(rw);
                fill_normalized_bgr_crop(
                    crop,
                    rw,
                    REC_HEIGHT,
                    target_w,
                    &mut inp[bi * 3 * plane..(bi + 1) * 3 * plane],
                );
            }

            let (dims, logits) = self.rec.run_f32(
                &[batch_len as i64, 3, REC_HEIGHT as i64, target_w as i64],
                &inp,
            )?;
            if dims.len() != 3 {
                return Err(AppError::new(
                    "OCR_INFERENCE_FAILED",
                    format!("Unexpected rec output tensor shape: {dims:?}"),
                ));
            }
            let timesteps = dims[1] as usize;
            let vocab = dims[2] as usize;
            if timesteps == 0 || vocab == 0 {
                continue;
            }

            for (bi, &idx) in chunk.iter().enumerate() {
                let base = bi * timesteps * vocab;
                // Effective valid timesteps correspond to the unpadded width ratio `rw / target_w`.
                let valid_ratio = (resized_widths[bi] as f32 / target_w as f32).clamp(0.05, 1.0);
                let eff_steps = ((timesteps as f32) * valid_ratio).ceil().max(1.0) as usize;
                let mut text = String::new();
                let mut steps: Vec<DecodedCharStep> = Vec::new();
                let mut score_sum = 0.0f32;
                let mut score_cnt = 0usize;
                let mut prev_cls = 0usize;

                for t in 0..timesteps {
                    let row = &logits[base + t * vocab..base + (t + 1) * vocab];
                    let mut best_idx = 0usize;
                    let mut best_val = f32::NEG_INFINITY;
                    for (ci, &v) in row.iter().enumerate() {
                        if v > best_val {
                            best_val = v;
                            best_idx = ci;
                        }
                    }
                    if best_idx != 0 && best_idx != prev_cls {
                        if let Some(ch_str) = self.dictionary.get(best_idx) {
                            if !ch_str.is_empty() {
                                let char_start = text.chars().count();
                                text.push_str(ch_str);
                                let char_end = text.chars().count();
                                steps.push(DecodedCharStep {
                                    t_start: t.min(eff_steps.saturating_sub(1)),
                                    t_end: t.min(eff_steps.saturating_sub(1)),
                                    char_start,
                                    char_end,
                                });
                                score_sum += best_val.clamp(0.0, 1.0);
                                score_cnt += 1;
                            }
                        }
                    } else if best_idx != 0 && best_idx == prev_cls {
                        if let Some(last) = steps.last_mut() {
                            last.t_end = t.min(eff_steps.saturating_sub(1));
                        }
                    }
                    prev_cls = best_idx;
                }

                let avg_conf = if score_cnt > 0 {
                    score_sum / score_cnt as f32
                } else {
                    0.0
                };
                results[idx] = (text, avg_conf, steps, eff_steps);
            }
        }

        Ok(results)
    }
}

#[derive(Debug, Clone)]
struct DecodedCharStep {
    t_start: usize,
    t_end: usize,
    char_start: usize,
    char_end: usize,
}

type DecodedCropLine = (String, f32, Vec<DecodedCharStep>, usize);
type MinAreaRectResult = ([(f32, f32); 4], f32, f32);

#[derive(Debug, Clone)]
struct RawLineCandidate {
    text: String,
    confidence: f32,
    quad_px: [OcrPoint; 4],
    rotated_180: bool,
    spans: Vec<OcrSpan>,
}

pub fn dynamic_to_white_rgb(img: &DynamicImage) -> RgbImage {
    match img {
        DynamicImage::ImageRgb8(rgb) => rgb.clone(),
        other => composite_rgba_over_rgb(&other.to_rgba8(), [255, 255, 255]),
    }
}

fn fill_normalized_bgr_crop(
    crop: &RgbImage,
    rw: usize,
    rh: usize,
    target_w: usize,
    dst: &mut [f32],
) {
    let cw = crop.width() as usize;
    let ch = crop.height() as usize;
    let raw = crop.as_raw();
    let plane = rh * target_w;

    for y in 0..rh {
        let sy = ((y as f32 + 0.5) * (ch as f32) / (rh as f32) - 0.5).clamp(0.0, (ch - 1) as f32);
        let y0 = sy.floor() as usize;
        let y1 = (y0 + 1).min(ch - 1);
        let wy = sy - y0 as f32;
        let wy0 = 1.0 - wy;

        for x in 0..rw {
            let sx =
                ((x as f32 + 0.5) * (cw as f32) / (rw as f32) - 0.5).clamp(0.0, (cw - 1) as f32);
            let x0 = sx.floor() as usize;
            let x1 = (x0 + 1).min(cw - 1);
            let wx = sx - x0 as f32;
            let wx0 = 1.0 - wx;

            let i00 = (y0 * cw + x0) * 3;
            let i10 = (y0 * cw + x1) * 3;
            let i01 = (y1 * cw + x0) * 3;
            let i11 = (y1 * cw + x1) * 3;

            let r = wy0 * (wx0 * raw[i00] as f32 + wx * raw[i10] as f32)
                + wy * (wx0 * raw[i01] as f32 + wx * raw[i11] as f32);
            let g = wy0 * (wx0 * raw[i00 + 1] as f32 + wx * raw[i10 + 1] as f32)
                + wy * (wx0 * raw[i01 + 1] as f32 + wx * raw[i11 + 1] as f32);
            let b = wy0 * (wx0 * raw[i00 + 2] as f32 + wx * raw[i10 + 2] as f32)
                + wy * (wx0 * raw[i01 + 2] as f32 + wx * raw[i11 + 2] as f32);

            let idx = y * target_w + x;
            dst[idx] = (b / 255.0 - 0.5) * 2.0;
            dst[plane + idx] = (g / 255.0 - 0.5) * 2.0;
            dst[2 * plane + idx] = (r / 255.0 - 0.5) * 2.0;
        }
    }
}

/// Pure-Rust DBNet probability map post-processor (8-connected components -> convex hull ->
/// minimum-area rotated bounding rectangle -> mean probability filter -> unclip expansion).
fn extract_dbnet_boxes(
    prob_map: &[f32],
    mw: usize,
    mh: usize,
    orig_w: f32,
    orig_h: f32,
) -> Vec<[OcrPoint; 4]> {
    let mut visited = vec![false; mw * mh];
    let mut queue: VecDeque<(usize, usize)> = VecDeque::new();
    let mut boxes: Vec<[OcrPoint; 4]> = Vec::new();
    let sx = orig_w / (mw.max(1) as f32);
    let sy = orig_h / (mh.max(1) as f32);

    for y in 0..mh {
        for x in 0..mw {
            let start_idx = y * mw + x;
            if visited[start_idx] || prob_map[start_idx] <= DET_THRESH {
                continue;
            }
            visited[start_idx] = true;
            queue.push_back((x, y));

            let mut pixel_count = 0usize;
            let mut boundary: Vec<(f32, f32)> = Vec::new();

            while let Some((cx, cy)) = queue.pop_front() {
                pixel_count += 1;
                let mut is_boundary = cx == 0 || cy == 0 || cx + 1 == mw || cy + 1 == mh;

                for dy in -1isize..=1 {
                    let ny = cy as isize + dy;
                    if ny < 0 || ny >= mh as isize {
                        continue;
                    }
                    for dx in -1isize..=1 {
                        if dx == 0 && dy == 0 {
                            continue;
                        }
                        let nx = cx as isize + dx;
                        if nx < 0 || nx >= mw as isize {
                            continue;
                        }
                        let nidx = (ny as usize) * mw + (nx as usize);
                        if prob_map[nidx] <= DET_THRESH {
                            if dx == 0 || dy == 0 {
                                is_boundary = true;
                            }
                        } else if !visited[nidx] {
                            visited[nidx] = true;
                            queue.push_back((nx as usize, ny as usize));
                        }
                    }
                }
                if is_boundary {
                    boundary.push((cx as f32, cy as f32));
                }
            }

            if pixel_count < 9 || boundary.len() < 4 {
                continue;
            }
            let hull = convex_hull(&boundary);
            let Some((rect_pts, rect_w, rect_h)) = min_area_rect(&hull) else {
                continue;
            };
            if rect_w.min(rect_h) < 3.0 {
                continue;
            }
            let score = mean_prob_in_rect(prob_map, mw, mh, &rect_pts);
            if score < DET_BOX_THRESH {
                continue;
            }

            let expanded = expand_oriented_rect(&rect_pts, DET_UNCLIP_RATIO);
            let scaled = [
                OcrPoint {
                    x: (expanded[0].0 * sx).clamp(0.0, orig_w),
                    y: (expanded[0].1 * sy).clamp(0.0, orig_h),
                },
                OcrPoint {
                    x: (expanded[1].0 * sx).clamp(0.0, orig_w),
                    y: (expanded[1].1 * sy).clamp(0.0, orig_h),
                },
                OcrPoint {
                    x: (expanded[2].0 * sx).clamp(0.0, orig_w),
                    y: (expanded[2].1 * sy).clamp(0.0, orig_h),
                },
                OcrPoint {
                    x: (expanded[3].0 * sx).clamp(0.0, orig_w),
                    y: (expanded[3].1 * sy).clamp(0.0, orig_h),
                },
            ];
            boxes.push(order_quad_clockwise(scaled));
        }
    }

    boxes
}

/// Andrew's monotone chain 2D convex hull.
fn convex_hull(points: &[(f32, f32)]) -> Vec<(f32, f32)> {
    let mut pts = points.to_vec();
    pts.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.total_cmp(&b.1)));
    pts.dedup_by(|a, b| (a.0 - b.0).abs() < 1e-4 && (a.1 - b.1).abs() < 1e-4);
    if pts.len() <= 2 {
        return pts;
    }

    let cross = |o: (f32, f32), a: (f32, f32), b: (f32, f32)| -> f32 {
        (a.0 - o.0) * (b.1 - o.1) - (a.1 - o.1) * (b.0 - o.0)
    };

    let mut lower: Vec<(f32, f32)> = Vec::new();
    for &p in &pts {
        while lower.len() >= 2 && cross(lower[lower.len() - 2], lower[lower.len() - 1], p) <= 0.0 {
            lower.pop();
        }
        lower.push(p);
    }

    let mut upper: Vec<(f32, f32)> = Vec::new();
    for &p in pts.iter().rev() {
        while upper.len() >= 2 && cross(upper[upper.len() - 2], upper[upper.len() - 1], p) <= 0.0 {
            upper.pop();
        }
        upper.push(p);
    }

    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

/// Minimum-area enclosing oriented rectangle of a convex polygon.
fn min_area_rect(hull: &[(f32, f32)]) -> Option<MinAreaRectResult> {
    let n = hull.len();
    if n < 3 {
        return None;
    }

    let mut best_area = f32::INFINITY;
    let mut best_rect = [(0.0f32, 0.0f32); 4];
    let mut best_w = 0.0f32;
    let mut best_h = 0.0f32;

    for i in 0..n {
        let p0 = hull[i];
        let p1 = hull[(i + 1) % n];
        let ex = p1.0 - p0.0;
        let ey = p1.1 - p0.1;
        let len = (ex * ex + ey * ey).sqrt();
        if len < 1e-5 {
            continue;
        }
        let ux = ex / len;
        let uy = ey / len;
        let vx = -uy;
        let vy = ux;

        let mut min_u = f32::INFINITY;
        let mut max_u = f32::NEG_INFINITY;
        let mut min_v = f32::INFINITY;
        let mut max_v = f32::NEG_INFINITY;

        for &(px, py) in hull {
            let u = px * ux + py * uy;
            let v = px * vx + py * vy;
            min_u = min_u.min(u);
            max_u = max_u.max(u);
            min_v = min_v.min(v);
            max_v = max_v.max(v);
        }

        let rw = max_u - min_u;
        let rh = max_v - min_v;
        let area = rw * rh;
        if area < best_area {
            best_area = area;
            best_w = rw;
            best_h = rh;
            best_rect = [
                (min_u * ux + min_v * vx, min_u * uy + min_v * vy),
                (max_u * ux + min_v * vx, max_u * uy + min_v * vy),
                (max_u * ux + max_v * vx, max_u * uy + max_v * vy),
                (min_u * ux + max_v * vx, min_u * uy + max_v * vy),
            ];
        }
    }

    if best_area.is_finite() {
        Some((best_rect, best_w, best_h))
    } else {
        None
    }
}

fn mean_prob_in_rect(prob_map: &[f32], mw: usize, mh: usize, rect: &[(f32, f32); 4]) -> f32 {
    let mut xmin = f32::INFINITY;
    let mut xmax = f32::NEG_INFINITY;
    let mut ymin = f32::INFINITY;
    let mut ymax = f32::NEG_INFINITY;
    for &(x, y) in rect {
        xmin = xmin.min(x);
        xmax = xmax.max(x);
        ymin = ymin.min(y);
        ymax = ymax.max(y);
    }
    let ix0 = (xmin.floor() as isize).clamp(0, (mw - 1) as isize) as usize;
    let ix1 = (xmax.ceil() as isize).clamp(0, (mw - 1) as isize) as usize;
    let iy0 = (ymin.floor() as isize).clamp(0, (mh - 1) as isize) as usize;
    let iy1 = (ymax.ceil() as isize).clamp(0, (mh - 1) as isize) as usize;

    let p0 = rect[0];
    let e0 = (rect[1].0 - p0.0, rect[1].1 - p0.1);
    let e1 = (rect[3].0 - p0.0, rect[3].1 - p0.1);
    let d00 = e0.0 * e0.0 + e0.1 * e0.1;
    let d11 = e1.0 * e1.0 + e1.1 * e1.1;
    if d00 < 1e-5 || d11 < 1e-5 {
        return 0.0;
    }

    let mut sum = 0.0f32;
    let mut count = 0usize;
    for y in iy0..=iy1 {
        let py = y as f32 - p0.1;
        for x in ix0..=ix1 {
            let px = x as f32 - p0.0;
            let u = px * e0.0 + py * e0.1;
            let v = px * e1.0 + py * e1.1;
            if u >= -1e-3 && u <= d00 + 1e-3 && v >= -1e-3 && v <= d11 + 1e-3 {
                sum += prob_map[y * mw + x];
                count += 1;
            }
        }
    }
    if count == 0 {
        0.0
    } else {
        sum / count as f32
    }
}

fn expand_oriented_rect(rect: &[(f32, f32); 4], unclip_ratio: f32) -> [(f32, f32); 4] {
    let v0 = (rect[1].0 - rect[0].0, rect[1].1 - rect[0].1);
    let v1 = (rect[2].0 - rect[1].0, rect[2].1 - rect[1].1);
    let l0 = (v0.0 * v0.0 + v0.1 * v0.1).sqrt();
    let l1 = (v1.0 * v1.0 + v1.1 * v1.1).sqrt();
    let area = l0 * l1;
    let peri = 2.0 * (l0 + l1);
    if peri < 1e-3 || area < 1e-3 {
        return *rect;
    }
    let dist = area * unclip_ratio / peri;
    let u0 = (v0.0 / (l0 + 1e-6), v0.1 / (l0 + 1e-6));
    let u1 = (v1.0 / (l1 + 1e-6), v1.1 / (l1 + 1e-6));
    let cx = 0.25 * (rect[0].0 + rect[1].0 + rect[2].0 + rect[3].0);
    let cy = 0.25 * (rect[0].1 + rect[1].1 + rect[2].1 + rect[3].1);

    let mut out = [(0.0f32, 0.0f32); 4];
    for (i, &(px, py)) in rect.iter().enumerate() {
        let rx = px - cx;
        let ry = py - cy;
        let s0 = if rx * u0.0 + ry * u0.1 >= 0.0 {
            1.0
        } else {
            -1.0
        };
        let s1 = if rx * u1.0 + ry * u1.1 >= 0.0 {
            1.0
        } else {
            -1.0
        };
        out[i] = (
            px + s0 * dist * u0.0 + s1 * dist * u1.0,
            py + s0 * dist * u0.1 + s1 * dist * u1.1,
        );
    }
    out
}

pub fn order_quad_clockwise(pts: [OcrPoint; 4]) -> [OcrPoint; 4] {
    // Classic TL/TR/BR/BL ordering by sum (x+y) and diff (y-x).
    let mut tl = pts[0];
    let mut br = pts[0];
    let mut tr = pts[0];
    let mut bl = pts[0];
    let mut min_sum = f32::INFINITY;
    let mut max_sum = f32::NEG_INFINITY;
    let mut min_diff = f32::INFINITY;
    let mut max_diff = f32::NEG_INFINITY;

    for p in pts {
        let s = p.x + p.y;
        let d = p.y - p.x;
        if s < min_sum {
            min_sum = s;
            tl = p;
        }
        if s > max_sum {
            max_sum = s;
            br = p;
        }
        if d < min_diff {
            min_diff = d;
            tr = p;
        }
        if d > max_diff {
            max_diff = d;
            bl = p;
        }
    }
    [tl, tr, br, bl]
}

fn dist_pt(a: OcrPoint, b: OcrPoint) -> f32 {
    let dx = a.x - b.x;
    let dy = a.y - b.y;
    (dx * dx + dy * dy).sqrt()
}

/// Bilinear warp extraction of an oriented text quad; returns `(crop_rgb, rotated_90_ccw)`.
fn crop_rotated_quad(src: &RgbImage, quad: &[OcrPoint; 4]) -> (RgbImage, bool) {
    let w = dist_pt(quad[0], quad[1])
        .max(dist_pt(quad[2], quad[3]))
        .round()
        .max(4.0) as u32;
    let h = dist_pt(quad[0], quad[3])
        .max(dist_pt(quad[1], quad[2]))
        .round()
        .max(4.0) as u32;

    let sw = src.width() as usize;
    let sh = src.height() as usize;
    let raw = src.as_raw();
    let mut out = vec![0u8; (w as usize) * (h as usize) * 3];

    let [p0, p1, p2, p3] = *quad;
    for y in 0..h {
        let v = (y as f32 + 0.5) / (h as f32);
        let v0 = 1.0 - v;
        for x in 0..w {
            let u = (x as f32 + 0.5) / (w as f32);
            let u0 = 1.0 - u;

            let sx = (u0 * v0 * p0.x + u * v0 * p1.x + u * v * p2.x + u0 * v * p3.x)
                .clamp(0.0, (sw - 1) as f32);
            let sy = (u0 * v0 * p0.y + u * v0 * p1.y + u * v * p2.y + u0 * v * p3.y)
                .clamp(0.0, (sh - 1) as f32);

            let x0 = sx.floor() as usize;
            let y0 = sy.floor() as usize;
            let x1 = (x0 + 1).min(sw - 1);
            let y1 = (y0 + 1).min(sh - 1);
            let wx = sx - x0 as f32;
            let wy = sy - y0 as f32;
            let wx0 = 1.0 - wx;
            let wy0 = 1.0 - wy;

            let i00 = (y0 * sw + x0) * 3;
            let i10 = (y0 * sw + x1) * 3;
            let i01 = (y1 * sw + x0) * 3;
            let i11 = (y1 * sw + x1) * 3;

            let oidx = ((y as usize) * (w as usize) + (x as usize)) * 3;
            for c in 0..3 {
                let val = wy0 * (wx0 * raw[i00 + c] as f32 + wx * raw[i10 + c] as f32)
                    + wy * (wx0 * raw[i01 + c] as f32 + wx * raw[i11 + c] as f32);
                out[oidx + c] = val.round().clamp(0.0, 255.0) as u8;
            }
        }
    }

    let img = RgbImage::from_raw(w, h, out).expect("exact rgb buffer");
    if (h as f32) / (w.max(1) as f32) >= 1.5 {
        (image::imageops::rotate270(&img), true)
    } else {
        (img, false)
    }
}

fn quad_to_bbox(quad: &[OcrPoint; 4]) -> OcrBoundingBox {
    let mut xmin = f32::INFINITY;
    let mut xmax = f32::NEG_INFINITY;
    let mut ymin = f32::INFINITY;
    let mut ymax = f32::NEG_INFINITY;
    for p in quad {
        xmin = xmin.min(p.x);
        xmax = xmax.max(p.x);
        ymin = ymin.min(p.y);
        ymax = ymax.max(p.y);
    }
    OcrBoundingBox {
        x: xmin,
        y: ymin,
        width: (xmax - xmin).max(0.0),
        height: (ymax - ymin).max(0.0),
    }
}

fn norm_bbox(b: OcrBoundingBox, img_w: u32, img_h: u32) -> OcrBoundingBox {
    let iw = img_w.max(1) as f32;
    let ih = img_h.max(1) as f32;
    OcrBoundingBox {
        x: (b.x / iw).clamp(0.0, 1.0),
        y: (b.y / ih).clamp(0.0, 1.0),
        width: (b.width / iw).clamp(0.0, 1.0),
        height: (b.height / ih).clamp(0.0, 1.0),
    }
}

fn lerp_pt(a: OcrPoint, b: OcrPoint, t: f32) -> OcrPoint {
    OcrPoint {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
    }
}

#[allow(clippy::too_many_arguments)]
fn build_token_spans(
    text: &str,
    char_steps: &[DecodedCharStep],
    total_steps: usize,
    quad: &[OcrPoint; 4],
    img_w: u32,
    img_h: u32,
    rotated_180: bool,
    vertical_rot: bool,
) -> Vec<OcrSpan> {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() || char_steps.is_empty() {
        return Vec::new();
    }

    // Group non-whitespace runs into spans, splitting between CJK/non-ASCII and ASCII tokens so
    // P04 invisible text layers and T04 selection align cleanly on mixed Chinese+English lines.
    let mut spans = Vec::new();
    let denom = total_steps.max(1) as f32;
    let mut i = 0usize;

    while i < chars.len() {
        if chars[i].is_whitespace() {
            i += 1;
            continue;
        }
        let start = i;
        let is_ascii_word = chars[i].is_ascii_graphic();
        i += 1;
        while i < chars.len() && !chars[i].is_whitespace() {
            let next_ascii = chars[i].is_ascii_graphic();
            if next_ascii != is_ascii_word {
                break;
            }
            i += 1;
        }
        let end = i;

        let mut t_min = usize::MAX;
        let mut t_max = 0usize;
        for st in char_steps {
            if st.char_end > start && st.char_start < end {
                t_min = t_min.min(st.t_start);
                t_max = t_max.max(st.t_end);
            }
        }
        if t_min == usize::MAX {
            continue;
        }

        let raw_u0 = (t_min as f32 / denom).clamp(0.0, 1.0);
        let raw_u1 = (((t_max + 1) as f32) / denom).clamp(raw_u0, 1.0);
        // Ensure a minimal non-degenerate span width without ever violating clamp's min <= max
        // invariant (e.g. when the final CTC timestep puts `raw_u0` near `1.0`).
        let min_step = (1.0 / denom).min(0.005);
        let (mut u0, mut u1) = if raw_u1 - raw_u0 < min_step {
            let expanded_u1 = (raw_u0 + min_step).min(1.0);
            let adjusted_u0 = (expanded_u1 - min_step).max(0.0);
            (adjusted_u0, expanded_u1)
        } else {
            (raw_u0, raw_u1)
        };
        if rotated_180 {
            let n0 = (1.0 - u1).clamp(0.0, 1.0);
            let n1 = (1.0 - u0).clamp(n0, 1.0);
            u0 = n0;
            u1 = n1;
        }

        let sub_quad = if vertical_rot {
            // `imageops::rotate270` maps source `(x, y)` -> destination `(dx = y, dy = w - 1 - x)`,
            // so the recognition horizontal axis `u ∈ [0, 1]` runs top-to-bottom along `P0 -> P3`
            // (and `P1 -> P2`). When `rotated_180` was applied after `rotate270`, `u0..u1` has
            // already been reversed via `(1 - u1)..(1 - u0)`, placing earlier tokens near `P3..P2`
            // and later tokens near `P0..P1`.
            [
                lerp_pt(quad[0], quad[3], u0),
                lerp_pt(quad[1], quad[2], u0),
                lerp_pt(quad[1], quad[2], u1),
                lerp_pt(quad[0], quad[3], u1),
            ]
        } else {
            [
                lerp_pt(quad[0], quad[1], u0),
                lerp_pt(quad[0], quad[1], u1),
                lerp_pt(quad[3], quad[2], u1),
                lerp_pt(quad[3], quad[2], u0),
            ]
        };
        let bbox_px = quad_to_bbox(&sub_quad);
        let bbox_norm = norm_bbox(bbox_px, img_w, img_h);
        let span_text: String = chars[start..end].iter().collect();
        spans.push(OcrSpan {
            text: span_text,
            bbox_px,
            bbox_norm,
            quad_px: Some(sub_quad),
            char_start: start,
            char_end: end,
        });
    }

    spans
}

/// Clusters recognized boxes into reading-order visual rows (robust to tilted paper scans up to
/// ±5°) and returns both structured `OcrTextLine` entries and joined full text.
fn assemble_reading_order(
    candidates: Vec<RawLineCandidate>,
    img_w: u32,
    img_h: u32,
) -> (Vec<OcrTextLine>, String) {
    struct Entry {
        cand: RawLineCandidate,
        bbox: OcrBoundingBox,
        yc: f32,
    }

    let mut entries: Vec<Entry> = candidates
        .into_iter()
        .map(|cand| {
            let bbox = quad_to_bbox(&cand.quad_px);
            let yc = bbox.y + 0.5 * bbox.height;
            Entry { cand, bbox, yc }
        })
        .collect();

    entries.sort_by(|a, b| a.yc.total_cmp(&b.yc));

    let mut rows: Vec<Vec<Entry>> = Vec::new();
    for entry in entries {
        let target_row = rows.iter().position(|row| {
            if let Some(ref_item) = row.last() {
                let y_top = entry.bbox.y.max(ref_item.bbox.y);
                let y_bot =
                    (entry.bbox.y + entry.bbox.height).min(ref_item.bbox.y + ref_item.bbox.height);
                let overlap = y_bot - y_top;
                let min_h = entry.bbox.height.min(ref_item.bbox.height).max(1.0);
                overlap >= 0.35 * min_h || (entry.yc - ref_item.yc).abs() <= 0.65 * min_h
            } else {
                false
            }
        });
        if let Some(ridx) = target_row {
            rows[ridx].push(entry);
        } else {
            rows.push(vec![entry]);
        }
    }

    for row in &mut rows {
        row.sort_by(|a, b| a.bbox.x.total_cmp(&b.bbox.x));
    }
    rows.sort_by(|a, b| {
        let ma = a.iter().map(|e| e.yc).sum::<f32>() / a.len().max(1) as f32;
        let mb = b.iter().map(|e| e.yc).sum::<f32>() / b.len().max(1) as f32;
        ma.total_cmp(&mb)
    });

    let iw = img_w.max(1) as f32;
    let ih = img_h.max(1) as f32;
    let mut lines: Vec<OcrTextLine> = Vec::new();
    let mut row_texts: Vec<String> = Vec::with_capacity(rows.len());

    for (row_index, row) in rows.into_iter().enumerate() {
        let mut row_str = String::new();
        for (col_idx, entry) in row.into_iter().enumerate() {
            if col_idx > 0 {
                row_str.push(' ');
            }
            row_str.push_str(entry.cand.text.trim());

            let q = entry.cand.quad_px;
            let quad_norm = [
                OcrNormPoint {
                    x: (q[0].x / iw).clamp(0.0, 1.0),
                    y: (q[0].y / ih).clamp(0.0, 1.0),
                },
                OcrNormPoint {
                    x: (q[1].x / iw).clamp(0.0, 1.0),
                    y: (q[1].y / ih).clamp(0.0, 1.0),
                },
                OcrNormPoint {
                    x: (q[2].x / iw).clamp(0.0, 1.0),
                    y: (q[2].y / ih).clamp(0.0, 1.0),
                },
                OcrNormPoint {
                    x: (q[3].x / iw).clamp(0.0, 1.0),
                    y: (q[3].y / ih).clamp(0.0, 1.0),
                },
            ];
            let angle_deg = (q[1].y - q[0].y).atan2(q[1].x - q[0].x).to_degrees();
            let bbox_norm = norm_bbox(entry.bbox, img_w, img_h);

            lines.push(OcrTextLine {
                index: lines.len(),
                row_index,
                text: entry.cand.text,
                confidence: (entry.cand.confidence * 10000.0).round() / 10000.0,
                quad_px: q,
                quad_norm,
                bbox_px: entry.bbox,
                bbox_norm,
                angle_deg: (angle_deg * 100.0).round() / 100.0,
                rotated_180: entry.cand.rotated_180,
                spans: entry.cand.spans,
            });
        }
        if !row_str.trim().is_empty() {
            row_texts.push(row_str);
        }
    }

    (lines, row_texts.join("\n"))
}

pub fn check_ocr_engine_status(resource_dir: Option<&Path>) -> OcrEngineStatus {
    match resolve_ocr_assets(resource_dir) {
        Ok(assets) => OcrEngineStatus {
            ready: true,
            engine_name: OCR_ENGINE_DISPLAY_NAME.to_string(),
            runtime_version: Some("1.23.2".to_string()),
            ocr_dir: Some(assets.ocr_dir.to_string_lossy().into_owned()),
            error: None,
        },
        Err(err) => OcrEngineStatus {
            ready: false,
            engine_name: OCR_ENGINE_DISPLAY_NAME.to_string(),
            runtime_version: None,
            ocr_dir: None,
            error: Some(err.message),
        },
    }
}

pub fn is_pdf_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn convex_hull_and_min_area_rect_recover_tilted_box() {
        // Generate points on a 40x12 rectangle rotated by 15 degrees
        let angle = 15.0f32.to_radians();
        let (s, c) = angle.sin_cos();
        let mut pts = Vec::new();
        for x in 0..=40 {
            for y in [0, 12] {
                let fx = x as f32;
                let fy = y as f32;
                pts.push((50.0 + fx * c - fy * s, 50.0 + fx * s + fy * c));
            }
        }
        let hull = convex_hull(&pts);
        let (_, w, h) = min_area_rect(&hull).expect("rect");
        let long_side = w.max(h);
        let short_side = w.min(h);
        assert!((long_side - 40.0).abs() < 0.5, "got {long_side}");
        assert!((short_side - 12.0).abs() < 0.5, "got {short_side}");
    }

    #[test]
    fn reading_order_clusters_tilted_same_line_fragments_left_to_right() {
        let make_cand = |text: &str, x: f32, y: f32| RawLineCandidate {
            text: text.to_string(),
            confidence: 0.99,
            quad_px: [
                OcrPoint { x, y },
                OcrPoint { x: x + 200.0, y },
                OcrPoint {
                    x: x + 200.0,
                    y: y + 30.0,
                },
                OcrPoint { x, y: y + 30.0 },
            ],
            rotated_180: false,
            spans: Vec::new(),
        };
        // Simulate +2.3° tilt: right half of line 1 is 15 px higher than left half, still overlaps!
        let cands = vec![
            make_cand("标准依据：ISO/IEC", 600.0, 100.0),
            make_cand("文档编号：WK-001", 100.0, 114.0),
            make_cand("第二行正文", 100.0, 180.0),
        ];
        let (lines, full) = assemble_reading_order(cands, 1000, 1000);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].text, "文档编号：WK-001");
        assert_eq!(lines[0].row_index, 0);
        assert_eq!(lines[1].text, "标准依据：ISO/IEC");
        assert_eq!(lines[1].row_index, 0);
        assert_eq!(lines[2].row_index, 1);
        assert_eq!(full, "文档编号：WK-001 标准依据：ISO/IEC\n第二行正文");
    }

    #[test]
    fn token_spans_last_timestep_never_panics_and_preserves_bounds_and_rotation() {
        let horiz_quad = [
            OcrPoint { x: 100.0, y: 50.0 },
            OcrPoint { x: 900.0, y: 50.0 },
            OcrPoint { x: 900.0, y: 90.0 },
            OcrPoint { x: 100.0, y: 90.0 },
        ];
        // Test total_steps where the last CTC timestep puts raw_u0 > 0.995 (e.g. 249/250 = 0.996
        // and 999/1000 = 0.999) plus a degenerate t_min == total_steps case.
        for &(total_steps, t_min, t_max) in &[
            (250usize, 249usize, 249usize),
            (1000, 999, 999),
            (1000, 1000, 1000),
            (1, 0, 0),
        ] {
            let char_steps = vec![
                DecodedCharStep {
                    char_start: 0,
                    char_end: 2,
                    t_start: 0,
                    t_end: 0,
                },
                DecodedCharStep {
                    char_start: 2,
                    char_end: 3,
                    t_start: t_min,
                    t_end: t_max,
                },
            ];
            let spans = build_token_spans(
                "AB末",
                &char_steps,
                total_steps,
                &horiz_quad,
                1000,
                200,
                false,
                false,
            );
            assert_eq!(spans.len(), 2);
            let tail = &spans[1];
            assert_eq!(tail.text, "末");
            assert!(
                tail.bbox_norm.x >= 0.0 && tail.bbox_norm.x <= 1.0,
                "tail.x out of range: {:?}",
                tail.bbox_norm
            );
            assert!(
                tail.bbox_norm.width > 0.0 && tail.bbox_norm.x + tail.bbox_norm.width <= 1.0001,
                "tail width invalid: {:?}",
                tail.bbox_norm
            );
            assert!(
                tail.bbox_norm.height > 0.0 && tail.bbox_norm.y + tail.bbox_norm.height <= 1.0001
            );

            // Verify rotated_180 mirrors the tail span cleanly to the left end of the quad
            let spans_rot = build_token_spans(
                "AB末",
                &char_steps,
                total_steps,
                &horiz_quad,
                1000,
                200,
                true,
                false,
            );
            assert_eq!(spans_rot.len(), 2);
            let rot_tail = &spans_rot[1];
            assert!(rot_tail.bbox_norm.x >= 0.0 && rot_tail.bbox_norm.width > 0.0);
            assert!(rot_tail.bbox_norm.x + rot_tail.bbox_norm.width <= 1.0001);
            if total_steps >= 10 {
                assert!(
                    rot_tail.bbox_px.x < tail.bbox_px.x,
                    "180-deg rotation should mirror tail span from right ({}) to left ({})",
                    tail.bbox_px.x,
                    rot_tail.bbox_px.x
                );
            }
        }

        // Verify vertical rotated strip at last timestep
        let vert_quad = [
            OcrPoint { x: 40.0, y: 20.0 },
            OcrPoint { x: 80.0, y: 20.0 },
            OcrPoint { x: 80.0, y: 420.0 },
            OcrPoint { x: 40.0, y: 420.0 },
        ];
        let v_steps = vec![DecodedCharStep {
            char_start: 0,
            char_end: 1,
            t_start: 999,
            t_end: 999,
        }];
        let v_spans = build_token_spans("竖", &v_steps, 1000, &vert_quad, 200, 500, false, true);
        assert_eq!(v_spans.len(), 1);
        assert!(v_spans[0].bbox_norm.height > 0.0);
        assert!(
            v_spans[0].bbox_norm.y >= 0.0
                && v_spans[0].bbox_norm.y + v_spans[0].bbox_norm.height <= 1.0001
        );
    }

    #[test]
    fn vertical_strip_two_token_spans_map_exact_positions_with_and_without_180_flip() {
        // First verify `image::imageops::rotate270` empirically on a 40x400 vertical strip:
        // a marker near the TOP of the strip (y = 60) must move to the LEFT (dx = 60) after rotate270,
        // and to the RIGHT (dx = 339) after rotate180(rotate270).
        let mut strip = RgbImage::from_pixel(40, 400, image::Rgb([255, 255, 255]));
        strip.put_pixel(20, 60, image::Rgb([10, 20, 30]));
        strip.put_pixel(20, 340, image::Rgb([200, 10, 10]));

        let rot270 = image::imageops::rotate270(&strip);
        assert_eq!(rot270.dimensions(), (400, 40));
        assert_eq!(*rot270.get_pixel(60, 19), image::Rgb([10, 20, 30]));
        assert_eq!(*rot270.get_pixel(340, 19), image::Rgb([200, 10, 10]));

        let rot270_180 = image::imageops::rotate180(&rot270);
        assert_eq!(*rot270_180.get_pixel(339, 20), image::Rgb([10, 20, 30]));
        assert_eq!(*rot270_180.get_pixel(59, 20), image::Rgb([200, 10, 10]));

        // Now verify `build_token_spans` for two separated tokens on the same vertical strip
        // [P0=(100, 20), P1=(140, 20), P2=(140, 420), P3=(100, 420)] (height = 400).
        // Token 1 ("TOP") occupies timesteps 1..=2 out of 10 (u in [0.1, 0.3]);
        // Token 2 ("BOT") occupies timesteps 7..=8 out of 10 (u in [0.7, 0.9]).
        let vert_quad = [
            OcrPoint { x: 100.0, y: 20.0 },
            OcrPoint { x: 140.0, y: 20.0 },
            OcrPoint { x: 140.0, y: 420.0 },
            OcrPoint { x: 100.0, y: 420.0 },
        ];
        let steps = vec![
            DecodedCharStep {
                char_start: 0,
                char_end: 3,
                t_start: 1,
                t_end: 2,
            },
            DecodedCharStep {
                char_start: 4,
                char_end: 7,
                t_start: 7,
                t_end: 8,
            },
        ];

        // Case 1: without 180-deg orientation correction -> earlier token near TOP (P0..P1), later near BOTTOM (P3..P2).
        let spans_normal =
            build_token_spans("TOP BOT", &steps, 10, &vert_quad, 300, 500, false, true);
        assert_eq!(spans_normal.len(), 2);
        let s_top = &spans_normal[0];
        let s_bot = &spans_normal[1];
        assert_eq!(s_top.text, "TOP");
        assert_eq!(s_bot.text, "BOT");
        assert!(
            (s_top.bbox_px.y - 60.0).abs() < 0.1 && (s_top.bbox_px.height - 80.0).abs() < 0.1,
            "Expected TOP near y=60..140, got {:?}",
            s_top.bbox_px
        );
        assert!(
            (s_bot.bbox_px.y - 300.0).abs() < 0.1 && (s_bot.bbox_px.height - 80.0).abs() < 0.1,
            "Expected BOT near y=300..380, got {:?}",
            s_bot.bbox_px
        );
        assert!(s_top.bbox_px.y + s_top.bbox_px.height < s_bot.bbox_px.y);

        // Case 2: with 180-deg orientation correction -> earlier rec token came from BOTTOM (u_orig in [0.7, 0.9]),
        // later rec token came from TOP (u_orig in [0.1, 0.3]).
        let spans_flipped =
            build_token_spans("TOP BOT", &steps, 10, &vert_quad, 300, 500, true, true);
        assert_eq!(spans_flipped.len(), 2);
        let f_first = &spans_flipped[0];
        let f_second = &spans_flipped[1];
        assert_eq!(f_first.text, "TOP");
        assert_eq!(f_second.text, "BOT");
        assert!(
            (f_first.bbox_px.y - 300.0).abs() < 0.1 && (f_first.bbox_px.height - 80.0).abs() < 0.1,
            "Expected first token after 180-flip near bottom y=300..380, got {:?}",
            f_first.bbox_px
        );
        assert!(
            (f_second.bbox_px.y - 60.0).abs() < 0.1 && (f_second.bbox_px.height - 80.0).abs() < 0.1,
            "Expected second token after 180-flip near top y=60..140, got {:?}",
            f_second.bbox_px
        );
        assert!(f_second.bbox_px.y + f_second.bbox_px.height < f_first.bbox_px.y);
    }

    #[test]
    fn real_rapidocr_end_to_end_recognizes_bilingual_fixture_with_spans() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("ocr_bilingual_sample.png");
        assert!(
            fixture.is_file(),
            "Required bilingual OCR fixture missing at {}",
            fixture.display()
        );

        let engine = RapidOcrEngine::load(None).expect(
            "Required RapidOCR runtime/models missing; run `npm run ensure-ocr-runtime` before cargo test",
        );
        assert!(engine.runtime_version().starts_with("1."));

        let res = engine
            .recognize_image_file(&fixture, &OcrRecognizeOptions::default())
            .expect("ocr bilingual fixture");
        assert!(
            res.line_count >= 3,
            "expected >=3 recognized lines, got {} (text={:?})",
            res.line_count,
            res.text
        );
        for kw in ["WinKit", "离线文字识别", "SHA-256", "2026-11-24", "PDF"] {
            assert!(
                res.text.contains(kw),
                "expected bilingual OCR output to contain {kw:?}, got:\n{}",
                res.text
            );
        }
        assert!(res.lines.iter().all(|l| !l.spans.is_empty()));
        for line in &res.lines {
            assert!(line.bbox_norm.width > 0.0 && line.bbox_norm.height > 0.0);
            assert!(line.bbox_norm.x >= 0.0 && line.bbox_norm.x + line.bbox_norm.width <= 1.0001);
            assert!(line.bbox_norm.y >= 0.0 && line.bbox_norm.y + line.bbox_norm.height <= 1.0001);
            for pt in &line.quad_norm {
                assert!((0.0..=1.0).contains(&pt.x) && (0.0..=1.0).contains(&pt.y));
            }
            for sp in &line.spans {
                assert!(sp.char_start < sp.char_end);
                assert!(sp.bbox_norm.width > 0.0 && sp.bbox_norm.height > 0.0);
                assert!(sp.bbox_norm.x >= 0.0 && sp.bbox_norm.x + sp.bbox_norm.width <= 1.0001);
                assert!(sp.bbox_norm.y >= 0.0 && sp.bbox_norm.y + sp.bbox_norm.height <= 1.0001);
            }
        }
    }

    #[test]
    fn blank_white_image_returns_empty_result_without_error() {
        let engine = RapidOcrEngine::load(None).expect(
            "Required RapidOCR runtime/models missing; run `npm run ensure-ocr-runtime` before cargo test",
        );
        let blank = RgbImage::from_pixel(320, 120, image::Rgb([255, 255, 255]));
        let res = engine
            .recognize_rgb(&blank, 1, None, None, None, &OcrRecognizeOptions::default())
            .expect("ocr blank");
        assert_eq!(res.line_count, 0);
        assert!(res.lines.is_empty());
        assert_eq!(res.text, "");
    }
}
