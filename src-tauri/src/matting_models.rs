//! User-initiated, pinned-version, SHA-256 verified offline background-removal model management
//! for `I04` ("Remove Background" / 「图片抠图去背景」).
//!
//! Design principles:
//! - Zero network access at startup or during matting inference: the ONNX weights are downloaded
//!   ONLY when the user explicitly clicks "Download Offline Cutout Model" (or points to an
//!   existing local folder containing the verified weights).
//! - Uses `BiRefNet_lite` (512×512 FP16 ONNX, `studioludens/birefnet-lite-512` pinned to commit
//!   `962e67969ec6acec9c19fab76acee4f5e22e990c`), where BOTH upstream model code + weights
//!   (`ZhengPeng7/BiRefNet_lite`) and the FP16 ONNX conversion (`Studio Ludens V.O.F.`) are
//!   explicitly licensed under the **MIT License**.
//! - Reuses WinKit's already-bundled Microsoft-signed `onnxruntime.dll 1.23.2` (MIT) so WinKit's
//!   installer adds 0 bytes of extra inference DLLs.
//! - Preserves the verbatim MIT notice (`LICENSE-birefnet-lite.txt`) alongside the installed
//!   weights and honors `WEBVIEW2_USER_DATA_FOLDER` so isolated verification profiles never touch
//!   the user's daily profile.

use crate::error::AppError;
use crate::fs_guard::validate_user_path;
use crate::media_core::download_https_with_sha256;
use crate::ocr_ort::resolve_ort_dll_path;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use uuid::Uuid;

pub const MATTING_SETUP_PROGRESS_EVENT: &str = "winkit://matting-setup-progress";

pub const MATTING_MODEL_ID: &str = "birefnet-lite-512-fp16-v1";
pub const MATTING_MODEL_DISPLAY_NAME: &str = "BiRefNet_lite 512 FP16 (Offline CPU)";
pub const MATTING_MODEL_VERSION: &str = "BiRefNet_lite 512 FP16 (962e679)";
pub const MATTING_MODEL_SOURCE_NAME: &str =
    "ZhengPeng7/BiRefNet_lite -> studioludens/birefnet-lite-512 (ONNX FP16)";
pub const MATTING_MODEL_RELEASE_URL: &str =
    "https://huggingface.co/studioludens/birefnet-lite-512/tree/962e67969ec6acec9c19fab76acee4f5e22e990c";

pub const MATTING_MODEL_URL: &str =
    "https://huggingface.co/studioludens/birefnet-lite-512/resolve/962e67969ec6acec9c19fab76acee4f5e22e990c/onnx/model_fp16.onnx";
pub const MATTING_MODEL_FILENAME: &str = "birefnet-lite-512-fp16.onnx";
pub const MATTING_MODEL_UPSTREAM_FILENAME: &str = "model_fp16.onnx";
pub const MATTING_MODEL_BYTES: u64 = 98_484_532;
pub const MATTING_MODEL_SHA256: &str =
    "eff9216bb2f9d3f023d9c2b7196845a7485739ab1f231593633e4d2344ffc516";
pub const MATTING_LICENSE_FILENAME: &str = "LICENSE-birefnet-lite.txt";

pub const MATTING_LICENSE_SUMMARY: &str =
    "BiRefNet_lite (Code & Weights): MIT; FP16 ONNX Conversion (Studio Ludens): MIT; ONNX Runtime: MIT";

const BIREFNET_LITE_LICENSE_TEXT: &str = r#"BiRefNet_lite 512 FP16 ONNX Model Notice
Upstream Model Code & Weights: https://github.com/ZhengPeng7/BiRefNet / https://huggingface.co/ZhengPeng7/BiRefNet_lite
ONNX FP16 Conversion: https://huggingface.co/studioludens/birefnet-lite-512
Pinned Revision: 962e67969ec6acec9c19fab76acee4f5e22e990c
Pinned Download URL: https://huggingface.co/studioludens/birefnet-lite-512/resolve/962e67969ec6acec9c19fab76acee4f5e22e990c/onnx/model_fp16.onnx
File Size: 98484532 bytes
File SHA-256: eff9216bb2f9d3f023d9c2b7196845a7485739ab1f231593633e4d2344ffc516

========================================================================
MIT License

Copyright (c) 2024 ZhengPeng
Copyright (c) 2026 Studio Ludens V.O.F.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
========================================================================
"#;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedMattingModelSpec {
    pub model_id: String,
    pub display_name: String,
    pub version: String,
    pub source_name: String,
    pub release_url: String,
    pub model_url: String,
    pub model_file_name: String,
    pub model_bytes: u64,
    pub model_sha256: String,
    pub license_summary: String,
}

impl ManagedMattingModelSpec {
    pub fn pinned() -> Self {
        Self {
            model_id: MATTING_MODEL_ID.to_string(),
            display_name: MATTING_MODEL_DISPLAY_NAME.to_string(),
            version: MATTING_MODEL_VERSION.to_string(),
            source_name: MATTING_MODEL_SOURCE_NAME.to_string(),
            release_url: MATTING_MODEL_RELEASE_URL.to_string(),
            model_url: MATTING_MODEL_URL.to_string(),
            model_file_name: MATTING_MODEL_FILENAME.to_string(),
            model_bytes: MATTING_MODEL_BYTES,
            model_sha256: MATTING_MODEL_SHA256.to_string(),
            license_summary: MATTING_LICENSE_SUMMARY.to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MattingModelMode {
    Managed,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MattingModelSource {
    Managed,
    Custom,
    Missing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MattingModelConfigFile {
    mode: MattingModelMode,
    custom_dir: Option<String>,
}

impl Default for MattingModelConfigFile {
    fn default() -> Self {
        Self {
            mode: MattingModelMode::Managed,
            custom_dir: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MattingModelStatus {
    pub ready: bool,
    pub runtime_ready: bool,
    pub source: MattingModelSource,
    pub mode: MattingModelMode,
    pub custom_dir: Option<String>,
    pub install_dir: String,
    pub active_model_dir: Option<String>,
    pub installed_bytes: Option<u64>,
    pub license_path: Option<String>,
    pub error: Option<String>,
    pub spec: ManagedMattingModelSpec,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MattingSetupProgressPayload {
    pub task_id: String,
    pub phase: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percent: Option<f64>,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct ResolvedMattingAssets {
    pub model_dir: PathBuf,
    pub model_onnx_path: PathBuf,
}

/// Resolves WinKit's local data root for user-downloaded offline matting models.
/// Honors `WEBVIEW2_USER_DATA_FOLDER` so isolated test profiles never touch the user's daily profile.
pub fn resolve_matting_data_root(app_local_data_dir: Option<&Path>) -> PathBuf {
    if let Ok(isolated) = std::env::var("WEBVIEW2_USER_DATA_FOLDER") {
        let trimmed = isolated.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed).join("matting-models");
        }
    }
    if let Some(dir) = app_local_data_dir {
        return dir.join("matting-models");
    }
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        return PathBuf::from(local_app_data)
            .join("com.luckylivio.winkit")
            .join("matting-models");
    }
    std::env::temp_dir().join("winkit-matting-models")
}

pub fn managed_matting_install_dir(matting_root: &Path) -> PathBuf {
    matting_root.join(MATTING_MODEL_ID)
}

fn config_file_path(matting_root: &Path) -> PathBuf {
    matting_root.join("config.json")
}

fn load_config(matting_root: &Path) -> MattingModelConfigFile {
    let path = config_file_path(matting_root);
    let Ok(text) = fs::read_to_string(path) else {
        return MattingModelConfigFile::default();
    };
    serde_json::from_str::<MattingModelConfigFile>(&text).unwrap_or_default()
}

fn save_config(matting_root: &Path, cfg: &MattingModelConfigFile) -> Result<(), AppError> {
    fs::create_dir_all(matting_root)
        .map_err(|e| AppError::from_io(e, "Unable to create matting model config directory"))?;
    let json = serde_json::to_string_pretty(cfg).map_err(|e| {
        AppError::new(
            "CONFIG_ERROR",
            format!("Serialize matting config failed: {e}"),
        )
    })?;
    fs::write(config_file_path(matting_root), json)
        .map_err(|e| AppError::from_io(e, "Unable to save matting model config"))
}

/// Locates either WinKit's canonical filename (`birefnet-lite-512-fp16.onnx`) or the upstream
/// Hugging Face filename (`model_fp16.onnx`) inside `dir` (so users who pre-download the file
/// manually can point straight to its folder, still gated by exact byte length & SHA-256).
pub fn find_model_file_in_dir(dir: &Path) -> Option<PathBuf> {
    let primary = dir.join(MATTING_MODEL_FILENAME);
    if primary.is_file() {
        return Some(primary);
    }
    let upstream = dir.join(MATTING_MODEL_UPSTREAM_FILENAME);
    if upstream.is_file() {
        return Some(upstream);
    }
    None
}

fn check_model_dir_fast(dir: &Path) -> Option<(ResolvedMattingAssets, u64)> {
    let model = find_model_file_in_dir(dir)?;
    let meta = fs::metadata(&model).ok()?;
    if !meta.is_file() || meta.len() != MATTING_MODEL_BYTES {
        return None;
    }
    Some((
        ResolvedMattingAssets {
            model_dir: dir.to_path_buf(),
            model_onnx_path: model,
        },
        meta.len(),
    ))
}

fn sha256_file_stream(path: &Path) -> Result<(u64, String), AppError> {
    let mut file =
        File::open(path).map_err(|e| AppError::from_io(e, "Unable to open matting model file"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut total = 0u64;
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| AppError::from_io(e, "Unable to read matting model file for SHA-256"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok((total, format!("{:x}", hasher.finalize())))
}

pub fn verify_matting_model_dir_strict(dir: &Path) -> Result<ResolvedMattingAssets, AppError> {
    let Some(model_path) = find_model_file_in_dir(dir) else {
        return Err(AppError::new(
            "MATTING_MODEL_MISSING",
            format!(
                "Required offline cutout model ('{MATTING_MODEL_FILENAME}' or '{MATTING_MODEL_UPSTREAM_FILENAME}') is missing in {}.",
                dir.display()
            ),
        ));
    };
    let (actual_bytes, actual_sha) = sha256_file_stream(&model_path)?;
    if actual_bytes != MATTING_MODEL_BYTES || !actual_sha.eq_ignore_ascii_case(MATTING_MODEL_SHA256)
    {
        return Err(AppError::new(
            "CHECKSUM_MISMATCH",
            format!(
                "Matting model file failed SHA-256 integrity check (expected {MATTING_MODEL_BYTES} B / {MATTING_MODEL_SHA256}, got {actual_bytes} B / {actual_sha})."
            ),
        ));
    }

    Ok(ResolvedMattingAssets {
        model_dir: dir.to_path_buf(),
        model_onnx_path: model_path,
    })
}

pub fn get_matting_model_status_impl(
    matting_root: &Path,
    resource_dir: Option<&Path>,
) -> MattingModelStatus {
    let cfg = load_config(matting_root);
    let install_dir = managed_matting_install_dir(matting_root);
    let runtime_ready = resolve_ort_dll_path(resource_dir).is_ok();
    let spec = ManagedMattingModelSpec::pinned();

    if cfg.mode == MattingModelMode::Custom {
        if let Some(ref custom) = cfg.custom_dir {
            let p = PathBuf::from(custom);
            if let Some((assets, bytes)) = check_model_dir_fast(&p) {
                let lic = assets.model_dir.join(MATTING_LICENSE_FILENAME);
                return MattingModelStatus {
                    ready: runtime_ready,
                    runtime_ready,
                    source: MattingModelSource::Custom,
                    mode: MattingModelMode::Custom,
                    custom_dir: Some(custom.clone()),
                    install_dir: install_dir.to_string_lossy().into_owned(),
                    active_model_dir: Some(assets.model_dir.to_string_lossy().into_owned()),
                    installed_bytes: Some(bytes),
                    license_path: lic.is_file().then(|| lic.to_string_lossy().into_owned()),
                    error: if runtime_ready {
                        None
                    } else {
                        Some("Bundled ONNX Runtime (onnxruntime.dll) is missing.".to_string())
                    },
                    spec,
                };
            }
            return MattingModelStatus {
                ready: false,
                runtime_ready,
                source: MattingModelSource::Missing,
                mode: MattingModelMode::Custom,
                custom_dir: Some(custom.clone()),
                install_dir: install_dir.to_string_lossy().into_owned(),
                active_model_dir: None,
                installed_bytes: None,
                license_path: None,
                error: Some(format!(
                    "Custom cutout model directory '{}' does not contain the verified BiRefNet_lite 512 FP16 ONNX model.",
                    custom
                )),
                spec,
            };
        }
    }

    if let Some((assets, bytes)) = check_model_dir_fast(&install_dir) {
        let lic = assets.model_dir.join(MATTING_LICENSE_FILENAME);
        return MattingModelStatus {
            ready: runtime_ready,
            runtime_ready,
            source: MattingModelSource::Managed,
            mode: MattingModelMode::Managed,
            custom_dir: cfg.custom_dir,
            install_dir: install_dir.to_string_lossy().into_owned(),
            active_model_dir: Some(assets.model_dir.to_string_lossy().into_owned()),
            installed_bytes: Some(bytes),
            license_path: lic.is_file().then(|| lic.to_string_lossy().into_owned()),
            error: if runtime_ready {
                None
            } else {
                Some("Bundled ONNX Runtime (onnxruntime.dll) is missing.".to_string())
            },
            spec,
        };
    }

    MattingModelStatus {
        ready: false,
        runtime_ready,
        source: MattingModelSource::Missing,
        mode: MattingModelMode::Managed,
        custom_dir: cfg.custom_dir,
        install_dir: install_dir.to_string_lossy().into_owned(),
        active_model_dir: None,
        installed_bytes: None,
        license_path: None,
        error: None,
        spec,
    }
}

pub fn require_matting_assets(
    matting_root: &Path,
    resource_dir: Option<&Path>,
) -> Result<ResolvedMattingAssets, AppError> {
    let status = get_matting_model_status_impl(matting_root, resource_dir);
    if !status.runtime_ready {
        return Err(AppError::new(
            "ORT_RUNTIME_MISSING",
            "Bundled ONNX Runtime (onnxruntime.dll) is missing.",
        ));
    }
    let Some(active_dir) = status.active_model_dir else {
        return Err(AppError::new(
            "MATTING_MODEL_MISSING",
            "Offline background-removal model (BiRefNet_lite 512 FP16) is not installed yet. Click 'Download Offline Cutout Model' first.",
        ));
    };
    let dir = PathBuf::from(active_dir);
    let Some((assets, _)) = check_model_dir_fast(&dir) else {
        return Err(AppError::new(
            "MATTING_MODEL_MISSING",
            "Offline cutout model file is incomplete or modified; please re-download or re-select the model folder.",
        ));
    };
    Ok(assets)
}

pub fn set_matting_model_custom_dir_impl(
    matting_root: &Path,
    resource_dir: Option<&Path>,
    dir: Option<String>,
) -> Result<MattingModelStatus, AppError> {
    match dir {
        None => {
            save_config(
                matting_root,
                &MattingModelConfigFile {
                    mode: MattingModelMode::Managed,
                    custom_dir: None,
                },
            )?;
            Ok(get_matting_model_status_impl(matting_root, resource_dir))
        }
        Some(raw) => {
            let path = validate_user_path(&raw, "Matting model directory")?;
            if !path.is_dir() {
                return Err(AppError::invalid_param(
                    "Selected matting model path is not an existing directory.",
                ));
            }
            verify_matting_model_dir_strict(&path)?;
            save_config(
                matting_root,
                &MattingModelConfigFile {
                    mode: MattingModelMode::Custom,
                    custom_dir: Some(path.to_string_lossy().into_owned()),
                },
            )?;
            Ok(get_matting_model_status_impl(matting_root, resource_dir))
        }
    }
}

pub fn remove_managed_matting_model_impl(
    matting_root: &Path,
    resource_dir: Option<&Path>,
) -> Result<MattingModelStatus, AppError> {
    let dir = managed_matting_install_dir(matting_root);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| {
            AppError::from_io(e, "Unable to remove managed matting model directory")
        })?;
    }
    Ok(get_matting_model_status_impl(matting_root, resource_dir))
}

/// User-initiated one-time download, SHA-256 verification, verbatim MIT license write, and
/// rollback-safe atomic activation of `BiRefNet_lite 512 FP16 ONNX`.
pub fn install_managed_matting_model_impl<F>(
    task_id: &str,
    matting_root: &Path,
    resource_dir: Option<&Path>,
    cancel_flag: &AtomicBool,
    mut on_progress: F,
) -> Result<MattingModelStatus, AppError>
where
    F: FnMut(MattingSetupProgressPayload),
{
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }
    fs::create_dir_all(matting_root)
        .map_err(|e| AppError::from_io(e, "Unable to create matting model root directory"))?;

    let staging_dir = matting_root.join(format!(".staging-{}", Uuid::new_v4()));
    let ready_dir = staging_dir.join("ready");
    fs::create_dir_all(&ready_dir)
        .map_err(|e| AppError::from_io(e, "Unable to create matting staging directory"))?;

    let cleanup = |dir: &Path| {
        let _ = fs::remove_dir_all(dir);
    };

    let model_tmp = ready_dir.join(MATTING_MODEL_FILENAME);
    on_progress(MattingSetupProgressPayload {
        task_id: task_id.to_string(),
        phase: "downloading".into(),
        downloaded_bytes: 0,
        total_bytes: MATTING_MODEL_BYTES,
        percent: Some(0.0),
        message: "Downloading BiRefNet_lite 512 FP16 (93.9 MiB)...".into(),
    });

    let dl_res = download_https_with_sha256(
        MATTING_MODEL_URL,
        &model_tmp,
        MATTING_MODEL_BYTES,
        cancel_flag,
        |dl, _| {
            let pct = ((dl as f64 / MATTING_MODEL_BYTES as f64) * 90.0).clamp(0.0, 90.0);
            on_progress(MattingSetupProgressPayload {
                task_id: task_id.to_string(),
                phase: "downloading".into(),
                downloaded_bytes: dl,
                total_bytes: MATTING_MODEL_BYTES,
                percent: Some(pct),
                message: format!(
                    "Downloading BiRefNet_lite 512 FP16 ({:.1} / {:.1} MiB)...",
                    dl as f64 / (1024.0 * 1024.0),
                    MATTING_MODEL_BYTES as f64 / (1024.0 * 1024.0)
                ),
            });
        },
    );
    let (actual_bytes, actual_sha) = match dl_res {
        Ok(v) => v,
        Err(e) => {
            cleanup(&staging_dir);
            return Err(e);
        }
    };

    on_progress(MattingSetupProgressPayload {
        task_id: task_id.to_string(),
        phase: "verifying".into(),
        downloaded_bytes: MATTING_MODEL_BYTES,
        total_bytes: MATTING_MODEL_BYTES,
        percent: Some(95.0),
        message: "Verifying ONNX model SHA-256 digest and saving MIT license notice...".into(),
    });

    if actual_bytes != MATTING_MODEL_BYTES || !actual_sha.eq_ignore_ascii_case(MATTING_MODEL_SHA256)
    {
        cleanup(&staging_dir);
        return Err(AppError::new(
            "CHECKSUM_MISMATCH",
            format!(
                "BiRefNet_lite model checksum mismatch (expected {MATTING_MODEL_BYTES} B / {MATTING_MODEL_SHA256}, got {actual_bytes} B / {actual_sha})."
            ),
        ));
    }

    if let Err(e) = fs::write(
        ready_dir.join(MATTING_LICENSE_FILENAME),
        BIREFNET_LITE_LICENSE_TEXT,
    ) {
        cleanup(&staging_dir);
        return Err(AppError::from_io(
            e,
            "Unable to write matting model MIT license notice",
        ));
    }

    if cancel_flag.load(Ordering::Relaxed) {
        cleanup(&staging_dir);
        return Err(AppError::cancelled());
    }

    // Rollback-safe directory swap into managed target
    let target_dir = managed_matting_install_dir(matting_root);
    let backup_dir = matting_root.join(format!(".backup-{}", Uuid::new_v4()));
    let had_existing = target_dir.exists();
    if had_existing {
        if let Err(e) = fs::rename(&target_dir, &backup_dir) {
            cleanup(&staging_dir);
            return Err(AppError::from_io(
                e,
                "Unable to prepare target matting model directory",
            ));
        }
    }

    if let Err(e) = fs::rename(&ready_dir, &target_dir) {
        if had_existing {
            let _ = fs::rename(&backup_dir, &target_dir);
        }
        cleanup(&staging_dir);
        return Err(AppError::from_io(
            e,
            "Unable to activate installed matting model directory",
        ));
    }

    if had_existing {
        let _ = fs::remove_dir_all(&backup_dir);
    }
    cleanup(&staging_dir);

    let _ = save_config(
        matting_root,
        &MattingModelConfigFile {
            mode: MattingModelMode::Managed,
            custom_dir: None,
        },
    );

    on_progress(MattingSetupProgressPayload {
        task_id: task_id.to_string(),
        phase: "completed".into(),
        downloaded_bytes: MATTING_MODEL_BYTES,
        total_bytes: MATTING_MODEL_BYTES,
        percent: Some(100.0),
        message: "Offline background-removal model verified and ready.".into(),
    });

    Ok(get_matting_model_status_impl(matting_root, resource_dir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn missing_model_reports_not_ready_without_auto_download() {
        let dir = tempdir().expect("tempdir");
        let status = get_matting_model_status_impl(dir.path(), None);
        assert!(!status.ready);
        assert_eq!(status.source, MattingModelSource::Missing);
        assert_eq!(status.spec.model_bytes, MATTING_MODEL_BYTES);
        assert_eq!(status.spec.model_sha256, MATTING_MODEL_SHA256);
        assert!(status
            .spec
            .model_url
            .contains("962e67969ec6acec9c19fab76acee4f5e22e990c"));
        assert!(status.spec.license_summary.contains("MIT"));
    }

    #[test]
    fn custom_dir_rejects_missing_or_tampered_model() {
        let root = tempdir().expect("root");
        let custom = tempdir().expect("custom");

        // Empty dir rejected
        let err_empty = set_matting_model_custom_dir_impl(
            root.path(),
            None,
            Some(custom.path().to_string_lossy().into_owned()),
        )
        .unwrap_err();
        assert_eq!(err_empty.code, "MATTING_MODEL_MISSING");

        // Wrong bytes / tampered model rejected with CHECKSUM_MISMATCH
        fs::write(
            custom.path().join(MATTING_MODEL_FILENAME),
            b"tampered-bytes",
        )
        .expect("write dummy");
        let err_bad = set_matting_model_custom_dir_impl(
            root.path(),
            None,
            Some(custom.path().to_string_lossy().into_owned()),
        )
        .unwrap_err();
        assert_eq!(err_bad.code, "CHECKSUM_MISMATCH");
    }

    #[test]
    fn license_notice_retains_both_upstream_mit_copyrights() {
        assert!(BIREFNET_LITE_LICENSE_TEXT.contains("Copyright (c) 2024 ZhengPeng"));
        assert!(BIREFNET_LITE_LICENSE_TEXT.contains("Copyright (c) 2026 Studio Ludens V.O.F."));
        assert!(BIREFNET_LITE_LICENSE_TEXT.contains(MATTING_MODEL_SHA256));
    }
}
