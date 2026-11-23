//! Phase 3B2 backend: I02 Offline CPU Face Detection & Batch Face Redaction.
//!
//! Uses a bundled, SHA-256-verified YuNet ONNX face detector (`face_detection_yunet_2023mar.onnx`,
//! MIT License, 232,589 bytes, opencv/opencv_zoo commit f12e12798e8314f7c074a6656816c048dcc95b7a)
//! executed strictly offline on CPU via pure-Rust `tract-onnx` (`MIT OR Apache-2.0`).
//!
//! Privacy & scope guarantees:
//! - Zero network calls at runtime; model weights are bundled in the desktop installer.
//! - Landmark heads (`kps_*`) are pruned from the ONNX graph at load time; strictly outputs
//!   2D face bounding boxes and detection confidences (zero identity embeddings or biometrics).
//! - Applies EXIF orientation before detection so rotated portraits detect in visual display coords.
//! - Batch export always writes new non-overwriting copies via `write_unique_output_file`,
//!   separates redacted count from untouched-copy / skipped / failed counts, and cleans `.tmp`
//!   immediately on cancellation.

use crate::error::AppError;
use crate::fs_guard::validate_existing_input_file;
use crate::image_assets::{encode_rgba_to_png_fast, ImageAssetStore, SaveAssetFormat};
use crate::image_core::{
    composite_rgba_over_rgb, decode_image_to_display, encode_jpeg_bytes, validate_output_directory,
    write_unique_output_file, BatchImageItemOutcome, BatchImageJobResponse,
    BatchImageOutcomeStatus, ImageBatchProgressPayload, ImageFileFormat, MAX_BATCH_IMAGES,
};
use crate::image_metadata::strip_encoded_bytes_privacy_verified;
use crate::image_redact::{apply_redactions_rgba, RedactionKind, RedactionRegion};
use image::imageops::FilterType;
use image::RgbaImage;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tract_onnx::prelude::*;

pub const YUNET_MODEL_FILENAME: &str = "face_detection_yunet_2023mar.onnx";
pub const YUNET_MODEL_DISPLAY_NAME: &str = "YuNet 2023mar (MIT, CPU)";
pub const YUNET_EXPECTED_BYTES: usize = 232_589;
pub const YUNET_EXPECTED_SHA256: &str =
    "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4";

const YUNET_INPUT_SIDE: usize = 640;
const YUNET_STRIDES: [usize; 3] = [8, 16, 32];
pub const DEFAULT_FACE_SCORE_THRESHOLD: f32 = 0.60;
const DEFAULT_NMS_IOU_THRESHOLD: f32 = 0.30;
const MAX_DETECTED_FACES: usize = 200;
const BOX_EXPAND_X_RATIO: f32 = 0.08;
const BOX_EXPAND_Y_RATIO: f32 = 0.10;

type FaceModelPlan = Arc<TypedRunnableModel>;

static FACE_MODEL_CACHE: OnceLock<Mutex<Option<FaceModelPlan>>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FaceDetectionStatus {
    Detected,
    NoFaces,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedFaceBox {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceDetectionResult {
    pub status: FaceDetectionStatus,
    pub faces: Vec<DetectedFaceBox>,
    pub image_width: u32,
    pub image_height: u32,
    pub elapsed_ms: u64,
    pub model_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectFacesAssetRequest {
    pub asset_id: String,
    pub score_threshold: Option<f32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectFacesFileRequest {
    pub path: String,
    pub score_threshold: Option<f32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlurFacesBatchItemInput {
    pub source_path: String,
    /// When provided (`Some`), uses the user's edited/verified regions directly instead of
    /// re-running detection on this item. When `None`, runs local offline face detection.
    pub override_regions: Option<Vec<RedactionRegion>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlurFacesBatchRequest {
    pub items: Vec<BlurFacesBatchItemInput>,
    pub output_dir: String,
    pub default_kind: RedactionKind,
    pub default_strength: u32,
    pub default_color_hex: Option<String>,
    pub score_threshold: Option<f32>,
    pub format: SaveAssetFormat,
    pub jpeg_quality: Option<u8>,
    pub strip_metadata: bool,
    /// If true, images with 0 faces/regions are exported as untouched non-overwriting copies
    /// and counted separately under `keptOriginalCount` (never mixed into `succeededCount`).
    /// If false, 0-face images are skipped (`skippedCount`).
    pub export_untouched_copies: bool,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

/// Resolves the bundled offline YuNet ONNX file without ever accessing the network.
pub fn resolve_face_model_path(resource_dir: Option<&Path>) -> Result<PathBuf, AppError> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(res) = resource_dir {
        candidates.push(res.join("models").join(YUNET_MODEL_FILENAME));
        candidates.push(res.join(YUNET_MODEL_FILENAME));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join("models").join(YUNET_MODEL_FILENAME));
            candidates.push(
                exe_dir
                    .join("resources")
                    .join("models")
                    .join(YUNET_MODEL_FILENAME),
            );
        }
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("models")
            .join(YUNET_MODEL_FILENAME),
    );

    for path in &candidates {
        if path.is_file() {
            return Ok(path.clone());
        }
    }

    Err(AppError::new(
        "MODEL_MISSING",
        format!(
            "Bundled offline face detection model ({YUNET_MODEL_FILENAME}) was not found in the installation directory."
        ),
    ))
}

fn build_yunet_plan_from_bytes(model_bytes: &[u8]) -> Result<FaceModelPlan, AppError> {
    if model_bytes.len() != YUNET_EXPECTED_BYTES {
        return Err(AppError::new(
            "MODEL_INVALID",
            format!(
                "Face detection model size mismatch (expected {YUNET_EXPECTED_BYTES} bytes, got {}).",
                model_bytes.len()
            ),
        ));
    }
    let actual_sha = sha256_hex(model_bytes);
    if actual_sha != YUNET_EXPECTED_SHA256 {
        return Err(AppError::new(
            "MODEL_INVALID",
            "Face detection model integrity checksum mismatch.",
        ));
    }

    let mut cursor = Cursor::new(model_bytes);
    let mut model = tract_onnx::onnx()
        .model_for_read(&mut cursor)
        .map_err(|e| {
            AppError::new(
                "MODEL_LOAD_FAILED",
                format!("Failed to parse offline face detection model: {e}"),
            )
        })?
        .with_input_fact(
            0,
            InferenceFact::dt_shape(
                f32::datum_type(),
                tvec!(1, 3, YUNET_INPUT_SIDE, YUNET_INPUT_SIDE),
            ),
        )
        .map_err(|e| {
            AppError::new(
                "MODEL_LOAD_FAILED",
                format!("Failed to bind face detector input shape: {e}"),
            )
        })?;
    // Strictly select only classification, objectness, and bounding-box heads.
    // Landmark heads (`kps_8`, `kps_16`, `kps_32`) are pruned during graph optimization.
    let wanted_outputs = [
        "cls_8", "cls_16", "cls_32", "obj_8", "obj_16", "obj_32", "bbox_8", "bbox_16", "bbox_32",
    ];
    let all_outputs = model
        .output_outlets()
        .map_err(|e| {
            AppError::new(
                "MODEL_LOAD_FAILED",
                format!("Failed to inspect face detector outputs: {e}"),
            )
        })?
        .to_vec();
    let mut selected_outlets = Vec::with_capacity(wanted_outputs.len());
    for name in wanted_outputs {
        let outlet = all_outputs
            .iter()
            .copied()
            .find(|o| model.outlet_label(*o) == Some(name) || model.node(o.node).name == name)
            .ok_or_else(|| {
                AppError::new(
                    "MODEL_LOAD_FAILED",
                    format!("Face detector output tensor `{name}` missing."),
                )
            })?;
        selected_outlets.push(outlet);
    }
    model
        .select_output_outlets(&selected_outlets)
        .map_err(|e| {
            AppError::new(
                "MODEL_LOAD_FAILED",
                format!("Failed to bind face detector bounding-box outputs: {e}"),
            )
        })?;
    let runnable = model
        .into_optimized()
        .map_err(|e| {
            AppError::new(
                "MODEL_LOAD_FAILED",
                format!("Failed to optimize face detection graph: {e}"),
            )
        })?
        .into_runnable()
        .map_err(|e| {
            AppError::new(
                "MODEL_LOAD_FAILED",
                format!("Failed to build runnable face detector: {e}"),
            )
        })?;

    Ok(runnable)
}

fn get_or_load_face_model(resource_dir: Option<&Path>) -> Result<FaceModelPlan, AppError> {
    let lock = FACE_MODEL_CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = lock
        .lock()
        .map_err(|_| AppError::new("INTERNAL_LOCK_ERROR", "Face detector cache lock poisoned."))?;
    if let Some(plan) = guard.as_ref() {
        return Ok(Arc::clone(plan));
    }

    let model_path = resolve_face_model_path(resource_dir)?;
    let bytes = fs::read(&model_path).map_err(|e| {
        AppError::new(
            "MODEL_LOAD_FAILED",
            format!("Failed to read bundled face model: {e}"),
        )
    })?;
    let plan = build_yunet_plan_from_bytes(&bytes)?;
    *guard = Some(Arc::clone(&plan));
    Ok(plan)
}

/// Resizes `rgba` preserving aspect ratio to fit within `target_max_side` (never exceeding `YUNET_INPUT_SIDE`)
/// and writes a zero-padded BGR float32 NCHW tensor `[1, 3, 640, 640]` matching OpenCV YuNet input conventions.
fn prepare_yunet_tensor(rgba: &RgbaImage, target_max_side: u32) -> Result<(Tensor, f32), AppError> {
    let (orig_w, orig_h) = rgba.dimensions();
    if orig_w == 0 || orig_h == 0 {
        return Err(AppError::decode_failed("Image has zero dimensions."));
    }

    let capped_side = target_max_side.clamp(64, YUNET_INPUT_SIDE as u32);
    let max_dim = orig_w.max(orig_h);
    let scale = if max_dim > capped_side {
        capped_side as f32 / max_dim as f32
    } else {
        1.0
    };

    let scaled_w = ((orig_w as f32 * scale).round() as u32).clamp(1, YUNET_INPUT_SIDE as u32);
    let scaled_h = ((orig_h as f32 * scale).round() as u32).clamp(1, YUNET_INPUT_SIDE as u32);

    let resized_owned;
    let src: &RgbaImage = if scaled_w != orig_w || scaled_h != orig_h {
        resized_owned = image::imageops::resize(rgba, scaled_w, scaled_h, FilterType::Triangle);
        &resized_owned
    } else {
        rgba
    };

    let plane = YUNET_INPUT_SIDE * YUNET_INPUT_SIDE;
    let mut data = vec![0.0f32; 3 * plane];
    let raw = src.as_raw();
    let sw = scaled_w as usize;
    let sh = scaled_h as usize;

    for y in 0..sh {
        let dst_row = y * YUNET_INPUT_SIDE;
        let src_row = y * sw * 4;
        for x in 0..sw {
            let p = src_row + x * 4;
            let a = raw[p + 3];
            let (r, g, b) = if a == 255 {
                (
                    f32::from(raw[p]),
                    f32::from(raw[p + 1]),
                    f32::from(raw[p + 2]),
                )
            } else {
                let af = f32::from(a) / 255.0;
                (
                    f32::from(raw[p]) * af,
                    f32::from(raw[p + 1]) * af,
                    f32::from(raw[p + 2]) * af,
                )
            };
            let idx = dst_row + x;
            // YuNet expects BGR channel order in 0..255 float32
            data[idx] = b;
            data[plane + idx] = g;
            data[2 * plane + idx] = r;
        }
    }

    let tensor =
        Tensor::from_shape(&[1, 3, YUNET_INPUT_SIDE, YUNET_INPUT_SIDE], &data).map_err(|e| {
            AppError::new(
                "INFERENCE_FAILED",
                format!("Failed to build input tensor: {e}"),
            )
        })?;
    Ok((tensor, scale))
}

#[derive(Debug, Clone, Copy)]
struct RawCandidateBox {
    x1: f32,
    y1: f32,
    x2: f32,
    y2: f32,
    score: f32,
}

fn box_iou(a: &RawCandidateBox, b: &RawCandidateBox) -> f32 {
    let ix1 = a.x1.max(b.x1);
    let iy1 = a.y1.max(b.y1);
    let ix2 = a.x2.min(b.x2);
    let iy2 = a.y2.min(b.y2);
    let iw = (ix2 - ix1).max(0.0);
    let ih = (iy2 - iy1).max(0.0);
    let inter = iw * ih;
    if inter <= 0.0 {
        return 0.0;
    }
    let area_a = (a.x2 - a.x1).max(0.0) * (a.y2 - a.y1).max(0.0);
    let area_b = (b.x2 - b.x1).max(0.0) * (b.y2 - b.y1).max(0.0);
    let union = area_a + area_b - inter;
    if union <= 0.0 {
        0.0
    } else {
        inter / union
    }
}

fn apply_nms(mut candidates: Vec<RawCandidateBox>, iou_threshold: f32) -> Vec<RawCandidateBox> {
    candidates.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut kept: Vec<RawCandidateBox> = Vec::new();
    for cand in candidates {
        if kept.len() >= MAX_DETECTED_FACES {
            break;
        }
        let suppressed = kept.iter().any(|k| box_iou(k, &cand) > iou_threshold);
        if !suppressed {
            kept.push(cand);
        }
    }
    kept
}

fn run_single_pass(
    plan: &FaceModelPlan,
    rgba: &RgbaImage,
    target_max_side: u32,
    score_threshold: f32,
) -> Result<Vec<RawCandidateBox>, AppError> {
    let (orig_w, orig_h) = rgba.dimensions();
    let (input_tensor, scale) = prepare_yunet_tensor(rgba, target_max_side)?;

    let outputs = plan.run(tvec!(input_tensor.into())).map_err(|e| {
        AppError::new(
            "INFERENCE_FAILED",
            format!("Face detector execution failed: {e}"),
        )
    })?;

    if outputs.len() < 9 {
        return Err(AppError::new(
            "INFERENCE_FAILED",
            "Unexpected output tensor count from YuNet model.",
        ));
    }

    let orig_w_f = orig_w as f32;
    let orig_h_f = orig_h as f32;
    let mut candidates: Vec<RawCandidateBox> = Vec::new();

    for (s_idx, &stride) in YUNET_STRIDES.iter().enumerate() {
        let cls_view = outputs[s_idx].to_plain_array_view::<f32>().map_err(|e| {
            AppError::new(
                "INFERENCE_FAILED",
                format!("cls_{stride} tensor error: {e}"),
            )
        })?;
        let obj_view = outputs[3 + s_idx]
            .to_plain_array_view::<f32>()
            .map_err(|e| {
                AppError::new(
                    "INFERENCE_FAILED",
                    format!("obj_{stride} tensor error: {e}"),
                )
            })?;
        let bbox_view = outputs[6 + s_idx]
            .to_plain_array_view::<f32>()
            .map_err(|e| {
                AppError::new(
                    "INFERENCE_FAILED",
                    format!("bbox_{stride} tensor error: {e}"),
                )
            })?;

        let cls_slice = cls_view.as_slice().ok_or_else(|| {
            AppError::new(
                "INFERENCE_FAILED",
                format!("cls_{stride} tensor non-contiguous"),
            )
        })?;
        let obj_slice = obj_view.as_slice().ok_or_else(|| {
            AppError::new(
                "INFERENCE_FAILED",
                format!("obj_{stride} tensor non-contiguous"),
            )
        })?;
        let bbox_slice = bbox_view.as_slice().ok_or_else(|| {
            AppError::new(
                "INFERENCE_FAILED",
                format!("bbox_{stride} tensor non-contiguous"),
            )
        })?;

        let cols = YUNET_INPUT_SIDE / stride;
        let rows = YUNET_INPUT_SIDE / stride;
        let stride_f = stride as f32;

        for r in 0..rows {
            for c in 0..cols {
                let idx = r * cols + c;
                let cls_s = cls_slice[idx].clamp(0.0, 1.0);
                let obj_s = obj_slice[idx].clamp(0.0, 1.0);
                let score = (cls_s * obj_s).sqrt();
                if score < score_threshold {
                    continue;
                }

                let b = idx * 4;
                let cx = (c as f32 + bbox_slice[b]) * stride_f / scale;
                let cy = (r as f32 + bbox_slice[b + 1]) * stride_f / scale;
                let bw = bbox_slice[b + 2].exp() * stride_f / scale;
                let bh = bbox_slice[b + 3].exp() * stride_f / scale;

                // Ignore spurious activations inside the zero-padded border
                if cx < 0.0 || cy < 0.0 || cx > orig_w_f || cy > orig_h_f {
                    continue;
                }

                // Slightly expand tight facial box to comfortably cover forehead/chin/cheeks
                let pad_x = bw * BOX_EXPAND_X_RATIO;
                let pad_y = bh * BOX_EXPAND_Y_RATIO;
                let x1 = (cx - bw * 0.5 - pad_x).clamp(0.0, orig_w_f);
                let y1 = (cy - bh * 0.5 - pad_y).clamp(0.0, orig_h_f);
                let x2 = (cx + bw * 0.5 + pad_x).clamp(0.0, orig_w_f);
                let y2 = (cy + bh * 0.5 + pad_y).clamp(0.0, orig_h_f);

                if (x2 - x1) >= 4.0 && (y2 - y1) >= 4.0 {
                    candidates.push(RawCandidateBox {
                        x1,
                        y1,
                        x2,
                        y2,
                        score,
                    });
                }
            }
        }
    }

    Ok(candidates)
}

/// Runs local CPU face bounding-box detection on an already-oriented display RGBA image.
pub fn detect_faces_rgba(
    resource_dir: Option<&Path>,
    rgba: &RgbaImage,
    score_threshold: Option<f32>,
) -> Result<FaceDetectionResult, AppError> {
    let start = Instant::now();
    let (orig_w, orig_h) = rgba.dimensions();
    let threshold = score_threshold
        .unwrap_or(DEFAULT_FACE_SCORE_THRESHOLD)
        .clamp(0.25, 0.95);

    let plan = get_or_load_face_model(resource_dir)?;
    let mut candidates = run_single_pass(&plan, rgba, YUNET_INPUT_SIDE as u32, threshold)?;

    // YuNet is trained for ~10px..300px faces in network input coordinates.
    // For extreme close-up portraits where a single face fills >60% of 640px,
    // fall back to a 320px pass only when the primary pass found zero faces.
    if candidates.is_empty() && orig_w.max(orig_h) >= 480 {
        candidates = run_single_pass(&plan, rgba, 320, threshold)?;
    }

    let kept = apply_nms(candidates, DEFAULT_NMS_IOU_THRESHOLD);

    let mut faces: Vec<DetectedFaceBox> = kept
        .into_iter()
        .map(|b| {
            let x = b.x1.floor().max(0.0) as i32;
            let y = b.y1.floor().max(0.0) as i32;
            let x2 = (b.x2.ceil() as u32).min(orig_w);
            let y2 = (b.y2.ceil() as u32).min(orig_h);
            let width = x2.saturating_sub(x as u32).max(1);
            let height = y2.saturating_sub(y as u32).max(1);
            DetectedFaceBox {
                x,
                y,
                width,
                height,
                confidence: (b.score * 1000.0).round() / 1000.0,
            }
        })
        .collect();

    // Stable left-to-right, top-to-bottom ordering for readable box indices in UI
    faces.sort_by(|a, b| {
        let row_band_a = a.y / 48;
        let row_band_b = b.y / 48;
        row_band_a
            .cmp(&row_band_b)
            .then_with(|| a.x.cmp(&b.x))
            .then_with(|| b.confidence.total_cmp(&a.confidence))
    });

    let status = if faces.is_empty() {
        FaceDetectionStatus::NoFaces
    } else {
        FaceDetectionStatus::Detected
    };

    Ok(FaceDetectionResult {
        status,
        faces,
        image_width: orig_w,
        image_height: orig_h,
        elapsed_ms: start.elapsed().as_millis() as u64,
        model_name: YUNET_MODEL_DISPLAY_NAME.to_string(),
    })
}

pub fn detect_faces_in_asset_impl(
    store: &ImageAssetStore,
    resource_dir: Option<&Path>,
    req: &DetectFacesAssetRequest,
) -> Result<FaceDetectionResult, AppError> {
    let (rgba, _) = store.get_rgba(&req.asset_id)?;
    detect_faces_rgba(resource_dir, &rgba, req.score_threshold)
}

pub fn detect_faces_in_file_impl(
    resource_dir: Option<&Path>,
    req: &DetectFacesFileRequest,
) -> Result<FaceDetectionResult, AppError> {
    let (path, _) = validate_existing_input_file(&req.path)?;
    let decoded = decode_image_to_display(&path)?;
    let rgba = decoded.image.to_rgba8();
    detect_faces_rgba(resource_dir, &rgba, req.score_threshold)
}

fn faces_to_redaction_regions(
    faces: &[DetectedFaceBox],
    kind: RedactionKind,
    strength: u32,
    color_hex: Option<&str>,
) -> Vec<RedactionRegion> {
    faces
        .iter()
        .map(|f| RedactionRegion {
            kind,
            x: f.x,
            y: f.y,
            width: f.width,
            height: f.height,
            strength,
            color_hex: color_hex.map(ToString::to_string),
        })
        .collect()
}

pub fn blur_faces_batch_impl<F>(
    task_id: &str,
    resource_dir: Option<&Path>,
    req: &BlurFacesBatchRequest,
    cancel_flag: &AtomicBool,
    mut on_progress: F,
) -> Result<BatchImageJobResponse, AppError>
where
    F: FnMut(&ImageBatchProgressPayload),
{
    if req.items.is_empty() {
        return Err(AppError::invalid_param(
            "Please add at least one image to process.",
        ));
    }
    if req.items.len() > MAX_BATCH_IMAGES {
        return Err(AppError::size_limit(format!(
            "Batch limit is {MAX_BATCH_IMAGES} images per job."
        )));
    }

    let out_dir = validate_output_directory(&req.output_dir)?;
    let total_items = req.items.len();
    let jpeg_quality = req.jpeg_quality.unwrap_or(92).clamp(60, 100);
    let out_ext = match req.format {
        SaveAssetFormat::Png => "png",
        SaveAssetFormat::Jpeg => "jpg",
    };

    let mut outcomes: Vec<BatchImageItemOutcome> = Vec::with_capacity(total_items);
    let mut succeeded_count = 0usize; // Strictly genuinely redacted images
    let mut kept_original_count = 0usize; // Untouched copies when export_untouched_copies == true
    let mut skipped_count = 0usize; // 0-face images skipped when export_untouched_copies == false
    let mut failed_count = 0usize;
    let mut total_original_bytes = 0u64;
    let mut total_output_bytes = 0u64;
    let mut cancelled = false;

    for (idx, item) in req.items.iter().enumerate() {
        if cancel_flag.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }

        let source_path_ref = Path::new(&item.source_path);
        let file_name = source_path_ref
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| item.source_path.clone());

        on_progress(&ImageBatchProgressPayload {
            task_id: task_id.to_string(),
            tool_id: "I02".to_string(),
            current_index: idx + 1,
            total_items,
            current_file_name: file_name.clone(),
        });

        let process_res: Result<BatchImageItemOutcome, AppError> = (|| {
            let (valid_src, orig_bytes) = validate_existing_input_file(&item.source_path)?;
            let decoded = decode_image_to_display(&valid_src)?;
            let rgba = decoded.image.to_rgba8();
            let (width, height) = rgba.dimensions();

            if cancel_flag.load(Ordering::Relaxed) {
                return Err(AppError::cancelled());
            }

            let regions: Vec<RedactionRegion> = match &item.override_regions {
                Some(custom) => custom.clone(),
                None => {
                    let det = detect_faces_rgba(resource_dir, &rgba, req.score_threshold)?;
                    faces_to_redaction_regions(
                        &det.faces,
                        req.default_kind,
                        req.default_strength,
                        req.default_color_hex.as_deref(),
                    )
                }
            };

            if cancel_flag.load(Ordering::Relaxed) {
                return Err(AppError::cancelled());
            }

            let stem = valid_src
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "image".to_string());

            if regions.is_empty() {
                if !req.export_untouched_copies {
                    return Ok(BatchImageItemOutcome {
                        source_path: item.source_path.clone(),
                        file_name: file_name.clone(),
                        output_path: None,
                        status: BatchImageOutcomeStatus::Skipped,
                        original_bytes: orig_bytes,
                        output_bytes: 0,
                        saved_percent: 0.0,
                        output_width: Some(width),
                        output_height: Some(height),
                        codec_note: Some("no_faces".to_string()),
                        message: Some("No faces detected; skipped.".to_string()),
                    });
                }

                // Export untouched non-overwriting copy, counted separately as KeptOriginal
                let (raw_bytes, img_fmt) = match req.format {
                    SaveAssetFormat::Png => (encode_rgba_to_png_fast(&rgba)?, ImageFileFormat::Png),
                    SaveAssetFormat::Jpeg => {
                        let rgb = composite_rgba_over_rgb(&rgba, [255, 255, 255]);
                        (
                            encode_jpeg_bytes(&rgb, jpeg_quality, true, None)?,
                            ImageFileFormat::Jpeg,
                        )
                    }
                };
                let final_bytes = if req.strip_metadata {
                    strip_encoded_bytes_privacy_verified(&raw_bytes, img_fmt)?
                } else {
                    raw_bytes
                };
                let output_bytes = final_bytes.len() as u64;
                let saved_path = write_unique_output_file(
                    &out_dir,
                    &format!("{stem}_copy"),
                    out_ext,
                    &final_bytes,
                )?;

                return Ok(BatchImageItemOutcome {
                    source_path: item.source_path.clone(),
                    file_name: file_name.clone(),
                    output_path: Some(saved_path.to_string_lossy().into_owned()),
                    status: BatchImageOutcomeStatus::KeptOriginal,
                    original_bytes: orig_bytes,
                    output_bytes,
                    saved_percent: 0.0,
                    output_width: Some(width),
                    output_height: Some(height),
                    codec_note: Some("untouched_copy".to_string()),
                    message: Some("No faces detected; exported untouched copy.".to_string()),
                });
            }

            let redacted = apply_redactions_rgba(&rgba, &regions)?;
            let (raw_bytes, img_fmt) = match req.format {
                SaveAssetFormat::Png => (encode_rgba_to_png_fast(&redacted)?, ImageFileFormat::Png),
                SaveAssetFormat::Jpeg => {
                    let rgb = composite_rgba_over_rgb(&redacted, [255, 255, 255]);
                    (
                        encode_jpeg_bytes(&rgb, jpeg_quality, true, None)?,
                        ImageFileFormat::Jpeg,
                    )
                }
            };
            let final_bytes = if req.strip_metadata {
                strip_encoded_bytes_privacy_verified(&raw_bytes, img_fmt)?
            } else {
                raw_bytes
            };

            let output_bytes = final_bytes.len() as u64;
            let saved_path = write_unique_output_file(
                &out_dir,
                &format!("{stem}_faces_redacted"),
                out_ext,
                &final_bytes,
            )?;

            Ok(BatchImageItemOutcome {
                source_path: item.source_path.clone(),
                file_name: file_name.clone(),
                output_path: Some(saved_path.to_string_lossy().into_owned()),
                status: BatchImageOutcomeStatus::Ok,
                original_bytes: orig_bytes,
                output_bytes,
                saved_percent: 0.0,
                output_width: Some(width),
                output_height: Some(height),
                codec_note: Some(format!("redacted:{}", regions.len())),
                message: None,
            })
        })();

        match process_res {
            Ok(outcome) => {
                total_original_bytes = total_original_bytes.saturating_add(outcome.original_bytes);
                total_output_bytes = total_output_bytes.saturating_add(outcome.output_bytes);
                match outcome.status {
                    BatchImageOutcomeStatus::Ok => succeeded_count += 1,
                    BatchImageOutcomeStatus::KeptOriginal => kept_original_count += 1,
                    BatchImageOutcomeStatus::Skipped => skipped_count += 1,
                    BatchImageOutcomeStatus::Error => failed_count += 1,
                }
                outcomes.push(outcome);
            }
            Err(err) if err.code == "CANCELLED" => {
                cancelled = true;
                break;
            }
            Err(err) => {
                failed_count += 1;
                outcomes.push(BatchImageItemOutcome {
                    source_path: item.source_path.clone(),
                    file_name,
                    output_path: None,
                    status: BatchImageOutcomeStatus::Error,
                    original_bytes: 0,
                    output_bytes: 0,
                    saved_percent: 0.0,
                    output_width: None,
                    output_height: None,
                    codec_note: Some(err.code.to_string()),
                    message: Some(err.message),
                });
            }
        }
    }

    Ok(BatchImageJobResponse {
        task_id: task_id.to_string(),
        tool_id: "I02".to_string(),
        output_dir: out_dir.to_string_lossy().into_owned(),
        cancelled,
        succeeded_count,
        kept_original_count,
        skipped_count,
        failed_count,
        total_original_bytes,
        total_output_bytes,
        items: outcomes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;
    use tempfile::tempdir;

    #[test]
    fn nms_suppresses_overlapping_lower_score_boxes() {
        let kept = apply_nms(
            vec![
                RawCandidateBox {
                    x1: 10.0,
                    y1: 10.0,
                    x2: 110.0,
                    y2: 110.0,
                    score: 0.92,
                },
                RawCandidateBox {
                    x1: 14.0,
                    y1: 12.0,
                    x2: 112.0,
                    y2: 112.0,
                    score: 0.85,
                },
                RawCandidateBox {
                    x1: 220.0,
                    y1: 40.0,
                    x2: 300.0,
                    y2: 120.0,
                    score: 0.88,
                },
            ],
            0.30,
        );
        assert_eq!(kept.len(), 2);
        assert!((kept[0].score - 0.92).abs() < 1e-5);
        assert!((kept[1].score - 0.88).abs() < 1e-5);
    }

    #[test]
    fn offline_yunet_model_loads_and_reports_no_faces_on_blank_image() {
        let blank = RgbaImage::from_pixel(640, 480, Rgba([210, 215, 220, 255]));
        let res = detect_faces_rgba(None, &blank, None).expect("yunet offline inference");
        assert_eq!(res.status, FaceDetectionStatus::NoFaces);
        assert!(res.faces.is_empty());
        assert_eq!(res.image_width, 640);
        assert_eq!(res.image_height, 480);
    }

    #[test]
    fn batch_separates_redacted_untouched_and_failed_counts_and_respects_cancel() {
        let dir = tempdir().expect("tempdir");
        let in_dir = dir.path().join("in");
        let out_dir = dir.path().join("out");
        fs::create_dir_all(&in_dir).expect("mkdir in");
        fs::create_dir_all(&out_dir).expect("mkdir out");

        let img1_path = in_dir.join("manual_box.png");
        let img2_path = in_dir.join("no_face.png");
        let bad_path = in_dir.join("corrupted.jpg");
        RgbaImage::from_pixel(200, 160, Rgba([180, 90, 60, 255]))
            .save(&img1_path)
            .expect("save img1");
        RgbaImage::from_pixel(200, 160, Rgba([50, 120, 190, 255]))
            .save(&img2_path)
            .expect("save img2");
        fs::write(&bad_path, b"not-a-valid-jpeg-file").expect("write bad");

        let orig1_bytes = fs::read(&img1_path).expect("read orig1");

        let cancel = AtomicBool::new(false);
        let resp = blur_faces_batch_impl(
            "task-i02-test",
            None,
            &BlurFacesBatchRequest {
                items: vec![
                    BlurFacesBatchItemInput {
                        source_path: img1_path.to_string_lossy().into_owned(),
                        override_regions: Some(vec![RedactionRegion {
                            kind: RedactionKind::Solid,
                            x: 30,
                            y: 20,
                            width: 60,
                            height: 60,
                            strength: 0,
                            color_hex: Some("#000000".into()),
                        }]),
                    },
                    BlurFacesBatchItemInput {
                        source_path: img2_path.to_string_lossy().into_owned(),
                        override_regions: None,
                    },
                    BlurFacesBatchItemInput {
                        source_path: bad_path.to_string_lossy().into_owned(),
                        override_regions: None,
                    },
                ],
                output_dir: out_dir.to_string_lossy().into_owned(),
                default_kind: RedactionKind::Blur,
                default_strength: 18,
                default_color_hex: Some("#111827".into()),
                score_threshold: None,
                format: SaveAssetFormat::Png,
                jpeg_quality: None,
                strip_metadata: true,
                export_untouched_copies: true,
            },
            &cancel,
            |_| {},
        )
        .expect("batch run");

        assert!(!resp.cancelled);
        assert_eq!(resp.succeeded_count, 1);
        assert_eq!(resp.kept_original_count, 1);
        assert_eq!(resp.skipped_count, 0);
        assert_eq!(resp.failed_count, 1);
        // Source file remains byte-identical
        assert_eq!(fs::read(&img1_path).expect("re-read"), orig1_bytes);

        // Verify exported solid redaction baked pixels cleanly
        let redacted_out = resp.items[0].output_path.as_ref().expect("out1");
        let decoded = image::open(redacted_out).expect("open out1").to_rgba8();
        assert_eq!(decoded.get_pixel(50, 40).0, [0, 0, 0, 255]);
        assert_eq!(decoded.get_pixel(5, 5).0, [180, 90, 60, 255]);

        // Verify zero leftover .tmp files
        let has_tmp = fs::read_dir(&out_dir)
            .expect("readdir")
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().contains(".tmp"));
        assert!(!has_tmp);
    }

    #[test]
    fn mid_batch_cancel_stops_promptly_and_leaves_zero_tmp_files() {
        let dir = tempdir().expect("tempdir");
        let in_dir = dir.path().join("in");
        let out_dir = dir.path().join("out");
        fs::create_dir_all(&in_dir).expect("mkdir in");
        fs::create_dir_all(&out_dir).expect("mkdir out");

        let mut items = Vec::new();
        for i in 0..5 {
            let p = in_dir.join(format!("img_{i}.png"));
            RgbaImage::from_pixel(160, 120, Rgba([100, 150, 200, 255]))
                .save(&p)
                .expect("save");
            items.push(BlurFacesBatchItemInput {
                source_path: p.to_string_lossy().into_owned(),
                override_regions: Some(vec![RedactionRegion {
                    kind: RedactionKind::Blur,
                    x: 20,
                    y: 20,
                    width: 40,
                    height: 40,
                    strength: 10,
                    color_hex: None,
                }]),
            });
        }

        let cancel = AtomicBool::new(false);
        let resp = blur_faces_batch_impl(
            "task-cancel",
            None,
            &BlurFacesBatchRequest {
                items,
                output_dir: out_dir.to_string_lossy().into_owned(),
                default_kind: RedactionKind::Blur,
                default_strength: 12,
                default_color_hex: None,
                score_threshold: None,
                format: SaveAssetFormat::Png,
                jpeg_quality: None,
                strip_metadata: true,
                export_untouched_copies: false,
            },
            &cancel,
            |ev| {
                if ev.current_index >= 2 {
                    cancel.store(true, Ordering::Relaxed);
                }
            },
        )
        .expect("batch cancel run");

        assert!(resp.cancelled);
        assert!(resp.succeeded_count < 5);
        let has_tmp = fs::read_dir(&out_dir)
            .expect("readdir")
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().contains(".tmp"));
        assert!(!has_tmp);
    }
}
