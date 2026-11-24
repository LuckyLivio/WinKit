//! User-initiated, pinned-version, SHA-256 verified offline ASR model management for `T01`.
//!
//! Design principles:
//! - Zero network access at startup or during transcription: models are downloaded ONLY when the
//!   user explicitly clicks "Download Offline Speech Model" (or points to an existing local folder).
//! - Both `SenseVoiceSmall INT8` (`2024-07-17`) and `Silero VAD v5` are pinned to exact upstream
//!   GitHub Release URLs, exact byte lengths, and exact SHA-256 digests.
//! - Reuses WinKit's already-bundled Microsoft-signed `onnxruntime.dll 1.23.2` (MIT) so WinKit's
//!   installer adds 0 bytes of extra inference DLLs.
//! - Preserves verbatim license notices (`LICENSE-sensevoice.txt` & `LICENSE-silero-vad.txt`)
//!   alongside the installed weights and respects `WEBVIEW2_USER_DATA_FOLDER` for isolated profiles.

use crate::error::AppError;
use crate::fs_guard::validate_user_path;
use crate::media_core::download_https_with_sha256;
use crate::ocr_ort::resolve_ort_dll_path;
use bzip2_rs::DecoderReader as Bz2DecoderReader;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tar::Archive;
use uuid::Uuid;

pub const ASR_SETUP_PROGRESS_EVENT: &str = "winkit://asr-setup-progress";

pub const ASR_MODEL_ID: &str = "sensevoice-small-int8-v20240717";
pub const ASR_MODEL_DISPLAY_NAME: &str = "SenseVoiceSmall INT8 + Silero VAD v5 (Offline CPU)";
pub const ASR_MODEL_VERSION: &str = "2024-07-17 + Silero VAD v5";
pub const ASR_MODEL_SOURCE_NAME: &str =
    "FunAudioLLM/SenseVoiceSmall (k2-fsa/sherpa-onnx asr-models) + snakers4/silero-vad v5";
pub const ASR_MODEL_RELEASE_URL: &str =
    "https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models";

pub const SENSEVOICE_ARCHIVE_URL: &str =
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2";
pub const SENSEVOICE_ARCHIVE_BYTES: u64 = 163_002_883;
pub const SENSEVOICE_ARCHIVE_SHA256: &str =
    "7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e";

pub const SENSEVOICE_MODEL_FILENAME: &str = "model.int8.onnx";
pub const SENSEVOICE_MODEL_BYTES: u64 = 239_233_841;
pub const SENSEVOICE_MODEL_SHA256: &str =
    "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51";

pub const SENSEVOICE_TOKENS_FILENAME: &str = "tokens.txt";
pub const SENSEVOICE_TOKENS_BYTES: u64 = 315_894;
pub const SENSEVOICE_TOKENS_SHA256: &str =
    "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc";

pub const SILERO_VAD_URL: &str =
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad_v5.onnx";
pub const SILERO_VAD_FILENAME: &str = "silero_vad_v5.onnx";
pub const SILERO_VAD_BYTES: u64 = 2_313_101;
pub const SILERO_VAD_SHA256: &str =
    "6b99cbfd39246b6706f98ec13c7c50c6b299181f2474fa05cbc8046acc274396";

pub const ASR_TOTAL_DOWNLOAD_BYTES: u64 = SENSEVOICE_ARCHIVE_BYTES + SILERO_VAD_BYTES;
pub const ASR_TOTAL_INSTALLED_BYTES: u64 =
    SENSEVOICE_MODEL_BYTES + SENSEVOICE_TOKENS_BYTES + SILERO_VAD_BYTES;
pub const ASR_LICENSE_SUMMARY: &str =
    "SenseVoiceSmall: FunASR Model Open Source License v1.1 (attribution required); Silero VAD v5: MIT; ONNX Runtime: MIT";

const SENSEVOICE_LICENSE_TEXT: &str = r#"SenseVoiceSmall INT8 ONNX Model Notice
Model: iic/SenseVoiceSmall (FunAudioLLM / Alibaba Group)
ONNX Conversion & Packaging: k2-fsa/sherpa-onnx (Apache-2.0, Xiaomi Corp.)
Pinned Archive: sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2
Archive SHA-256: 7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e
Extracted model.int8.onnx SHA-256: c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51
Extracted tokens.txt SHA-256: f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc
Archive LICENSE entry (71 bytes): Ref to https://github.com/modelscope/FunASR?tab=readme-ov-file#license
Upstream Model License Source: https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE

========================================================================
FunASR Model Open Source License Agreement

Version: 1.1

Copyright (C) [2023-2028] [Alibaba Group]. All rights reserved.

Thank you for choosing the FunASR open-source model. The FunASR open-source model includes a range of free and open industrial models for you to use, modify, share, and learn from.

To ensure better community collaboration, we have established the following agreement, and we hope you will read and comply with its terms.
Definitions

In this agreement, [FunASR Software] refers to FunASR open-source model weights and their derivatives, including finetuned models; [You] refers to individuals or organizations using, modifying, sharing, and learning from [FunASR Software].

2 License and Restrictions

2.1 License

You are free to use, copy, modify, and share [FunASR Software] under the terms of this agreement.

2.2 Restrictions

When using, copying, modifying, and sharing [FunASR Software], you must attribute the source and author information and retain relevant model names in [FunASR Software].

3 Responsibility and Risk

[FunASR Software] is provided for reference and learning purposes only, and Alibaba Group assumes no responsibility for any direct or indirect losses resulting from your use or modification of [FunASR Software]. You should assume all risks associated with using and modifying [FunASR Software].

4 Community Conduct Guidelines

4.1 Encouraged Behavior

The community welcomes developers and users to engage in discussions about [FunASR Software]. Participants are encouraged to interact in a friendly, polite, and respectful manner to foster constructive discussion and collaboration.

4.2 Prohibited Behavior

Individual or organizational users shall not engage in unjustified denigration, malicious smearing, or baseless insults against [FunASR Software]. Such behavior is considered a violation of the spirit of community cooperation. If a user is found to be engaging in the prohibited behavior mentioned above, it will be considered an automatic forfeiture of all licenses under this agreement.

5 Termination

If you violate any terms of this agreement, your license will automatically terminate, and you must cease using, copying, modifying, and sharing [FunASR Software].

6 Revisions

This agreement may be updated and revised occasionally. The revised agreement will be published in the official repository of [FunASR Software] and will take effect automatically. Continuing to use, copy, modify, and share [FunASR Software] indicates your acceptance of the revised agreement.

7 Miscellaneous

This agreement is governed by the laws of [Country/Region]. If any provision is deemed illegal, invalid, or unenforceable, that provision shall be considered severed from this agreement, and the remaining provisions shall continue to be valid and binding.

If you have any questions or comments regarding this agreement, please contact us.

Copyright © [2023-2028] [Alibaba Group]. All rights reserved.


FunASR 模型开源协议

版本号：1.1

版权所有 (C) [2023-2028] [阿里巴巴集团]。保留所有权利。

感谢您选择 FunASR 开源模型。FunASR 开源模型包含一系列免费且开源的工业模型，让大家可以使用、修改、分享和学习该模型。

为了保证更好的社区合作，我们制定了以下协议，希望您仔细阅读并遵守本协议。

1 定义

本协议中，[FunASR 软件]指 FunASR 开源模型权重及其衍生品，包括 Finetune 后的模型；[您]指使用、修改、分享和学习[FunASR 软件]的个人或组织。

2 许可和限制

2.1 许可

您可以在遵守本协议的前提下，自由地使用、复制、修改和分享[FunASR 软件]。

2.2 限制

您在使用、复制、修改和分享[FunASR 软件]时，必须注明出处以及作者信息，并保留[FunASR 软件]中相关模型名称。

3 责任和风险承担

[FunASR 软件]仅作为参考和学习使用，不对您使用或修改[FunASR 软件]造成的任何直接或间接损失承担任何责任。您对[FunASR 软件]的使用和修改应该自行承担风险。

4 社区行为准则

4.1 欢迎交流

社区欢迎开发者与用户对[FunASR 软件]进行交流讨论。交流中请注意保持友好、礼貌和文明，以促进建设性的讨论和合作。

4.2 禁止行为

个人或组织用户不得对[FunASR 软件]进行无端诋毁、恶意抹黑或凭空谩骂。此类行为被视为违反社区合作精神。如被认定从事上述禁止行为，将视为自动放弃本协议下的所有许可。

5 终止

如果您违反本协议的任何条款，您的许可将自动终止，您必须停止使用、复制、修改和分享[FunASR 软件]。

6 修订

本协议可能会不时更新和修订。修订后的协议将在[FunASR 软件]官方仓库发布，并自动生效。如果您继续使用、复制、修改和分享[FunASR 软件]，即表示您同意修订后的协议。

7 其他规定

本协议受到[国家/地区] 的法律管辖。如果任何条款被裁定为不合法、无效或无法执行，则该条款应被视为从本协议中删除，而其余条款应继续有效并具有约束力。

如果您对本协议有任何问题或意见，请联系我们。

版权所有© [2023-2028] [阿里巴巴集团]。保留所有权利。
========================================================================
"#;

const SILERO_VAD_LICENSE_TEXT: &str = r#"Silero VAD v5 ONNX Model Notice
Upstream Repository: https://github.com/snakers4/silero-vad
Upstream License Source: https://github.com/snakers4/silero-vad/blob/master/LICENSE
Distribution Source: https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad_v5.onnx
File SHA-256: 6b99cbfd39246b6706f98ec13c7c50c6b299181f2474fa05cbc8046acc274396

MIT License

Copyright (c) 2020-present Silero Team

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
"#;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAsrModelSpec {
    pub model_id: String,
    pub display_name: String,
    pub version: String,
    pub source_name: String,
    pub release_url: String,
    pub sensevoice_archive_url: String,
    pub sensevoice_archive_bytes: u64,
    pub sensevoice_archive_sha256: String,
    pub silero_vad_url: String,
    pub silero_vad_bytes: u64,
    pub silero_vad_sha256: String,
    pub total_download_bytes: u64,
    pub estimated_installed_bytes: u64,
    pub license_summary: String,
}

impl ManagedAsrModelSpec {
    pub fn pinned() -> Self {
        Self {
            model_id: ASR_MODEL_ID.to_string(),
            display_name: ASR_MODEL_DISPLAY_NAME.to_string(),
            version: ASR_MODEL_VERSION.to_string(),
            source_name: ASR_MODEL_SOURCE_NAME.to_string(),
            release_url: ASR_MODEL_RELEASE_URL.to_string(),
            sensevoice_archive_url: SENSEVOICE_ARCHIVE_URL.to_string(),
            sensevoice_archive_bytes: SENSEVOICE_ARCHIVE_BYTES,
            sensevoice_archive_sha256: SENSEVOICE_ARCHIVE_SHA256.to_string(),
            silero_vad_url: SILERO_VAD_URL.to_string(),
            silero_vad_bytes: SILERO_VAD_BYTES,
            silero_vad_sha256: SILERO_VAD_SHA256.to_string(),
            total_download_bytes: ASR_TOTAL_DOWNLOAD_BYTES,
            estimated_installed_bytes: ASR_TOTAL_INSTALLED_BYTES,
            license_summary: ASR_LICENSE_SUMMARY.to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AsrModelMode {
    Managed,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AsrModelSource {
    Managed,
    Custom,
    Missing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AsrModelConfigFile {
    mode: AsrModelMode,
    custom_dir: Option<String>,
}

impl Default for AsrModelConfigFile {
    fn default() -> Self {
        Self {
            mode: AsrModelMode::Managed,
            custom_dir: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrModelStatus {
    pub ready: bool,
    pub runtime_ready: bool,
    pub source: AsrModelSource,
    pub mode: AsrModelMode,
    pub custom_dir: Option<String>,
    pub install_dir: String,
    pub active_model_dir: Option<String>,
    pub installed_bytes: Option<u64>,
    pub license_path: Option<String>,
    pub error: Option<String>,
    pub spec: ManagedAsrModelSpec,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrSetupProgressPayload {
    pub task_id: String,
    pub phase: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percent: Option<f64>,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct ResolvedAsrAssets {
    pub model_dir: PathBuf,
    pub model_onnx_path: PathBuf,
    pub tokens_path: PathBuf,
    pub vad_onnx_path: PathBuf,
}

/// Resolves WinKit's local data root for user-downloaded offline ASR models.
/// Honors `WEBVIEW2_USER_DATA_FOLDER` so isolated test profiles never touch the user's daily profile.
pub fn resolve_asr_data_root(app_local_data_dir: Option<&Path>) -> PathBuf {
    if let Ok(isolated) = std::env::var("WEBVIEW2_USER_DATA_FOLDER") {
        let trimmed = isolated.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed).join("asr-models");
        }
    }
    if let Some(dir) = app_local_data_dir {
        return dir.join("asr-models");
    }
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        return PathBuf::from(local_app_data)
            .join("com.luckylivio.winkit")
            .join("asr-models");
    }
    std::env::temp_dir().join("winkit-asr-models")
}

pub fn managed_asr_install_dir(asr_root: &Path) -> PathBuf {
    asr_root.join(ASR_MODEL_ID)
}

fn config_file_path(asr_root: &Path) -> PathBuf {
    asr_root.join("config.json")
}

fn load_config(asr_root: &Path) -> AsrModelConfigFile {
    let path = config_file_path(asr_root);
    let Ok(text) = fs::read_to_string(path) else {
        return AsrModelConfigFile::default();
    };
    serde_json::from_str::<AsrModelConfigFile>(&text).unwrap_or_default()
}

fn save_config(asr_root: &Path, cfg: &AsrModelConfigFile) -> Result<(), AppError> {
    fs::create_dir_all(asr_root)
        .map_err(|e| AppError::from_io(e, "Unable to create ASR model config directory"))?;
    let json = serde_json::to_string_pretty(cfg)
        .map_err(|e| AppError::new("CONFIG_ERROR", format!("Serialize ASR config failed: {e}")))?;
    fs::write(config_file_path(asr_root), json)
        .map_err(|e| AppError::from_io(e, "Unable to save ASR model config"))
}

fn check_model_dir_fast(dir: &Path) -> Option<(ResolvedAsrAssets, u64)> {
    let model = dir.join(SENSEVOICE_MODEL_FILENAME);
    let tokens = dir.join(SENSEVOICE_TOKENS_FILENAME);
    let vad = dir.join(SILERO_VAD_FILENAME);
    let m_meta = fs::metadata(&model).ok()?;
    let t_meta = fs::metadata(&tokens).ok()?;
    let v_meta = fs::metadata(&vad).ok()?;
    if !m_meta.is_file() || !t_meta.is_file() || !v_meta.is_file() {
        return None;
    }
    if m_meta.len() != SENSEVOICE_MODEL_BYTES
        || t_meta.len() != SENSEVOICE_TOKENS_BYTES
        || v_meta.len() != SILERO_VAD_BYTES
    {
        return None;
    }
    Some((
        ResolvedAsrAssets {
            model_dir: dir.to_path_buf(),
            model_onnx_path: model,
            tokens_path: tokens,
            vad_onnx_path: vad,
        },
        m_meta.len() + t_meta.len() + v_meta.len(),
    ))
}

fn sha256_file_stream(path: &Path) -> Result<(u64, String), AppError> {
    let mut file =
        File::open(path).map_err(|e| AppError::from_io(e, "Unable to open ASR model file"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut total = 0u64;
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| AppError::from_io(e, "Unable to read ASR model file for SHA-256"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok((total, format!("{:x}", hasher.finalize())))
}

pub fn verify_asr_model_dir_strict(dir: &Path) -> Result<ResolvedAsrAssets, AppError> {
    let model = dir.join(SENSEVOICE_MODEL_FILENAME);
    let tokens = dir.join(SENSEVOICE_TOKENS_FILENAME);
    let vad = dir.join(SILERO_VAD_FILENAME);

    for (path, expected_bytes, expected_sha, label) in [
        (
            &model,
            SENSEVOICE_MODEL_BYTES,
            SENSEVOICE_MODEL_SHA256,
            SENSEVOICE_MODEL_FILENAME,
        ),
        (
            &tokens,
            SENSEVOICE_TOKENS_BYTES,
            SENSEVOICE_TOKENS_SHA256,
            SENSEVOICE_TOKENS_FILENAME,
        ),
        (
            &vad,
            SILERO_VAD_BYTES,
            SILERO_VAD_SHA256,
            SILERO_VAD_FILENAME,
        ),
    ] {
        if !path.is_file() {
            return Err(AppError::new(
                "ASR_MODEL_MISSING",
                format!(
                    "Required offline ASR file '{label}' is missing in {}.",
                    dir.display()
                ),
            ));
        }
        let (actual_bytes, actual_sha) = sha256_file_stream(path)?;
        if actual_bytes != expected_bytes || !actual_sha.eq_ignore_ascii_case(expected_sha) {
            return Err(AppError::new(
                "CHECKSUM_MISMATCH",
                format!(
                    "ASR file '{label}' failed SHA-256 integrity check (expected {expected_bytes} B / {expected_sha}, got {actual_bytes} B / {actual_sha})."
                ),
            ));
        }
    }

    Ok(ResolvedAsrAssets {
        model_dir: dir.to_path_buf(),
        model_onnx_path: model,
        tokens_path: tokens,
        vad_onnx_path: vad,
    })
}

pub fn get_asr_model_status_impl(asr_root: &Path, resource_dir: Option<&Path>) -> AsrModelStatus {
    let cfg = load_config(asr_root);
    let install_dir = managed_asr_install_dir(asr_root);
    let runtime_ready = resolve_ort_dll_path(resource_dir).is_ok();
    let spec = ManagedAsrModelSpec::pinned();

    if cfg.mode == AsrModelMode::Custom {
        if let Some(ref custom) = cfg.custom_dir {
            let p = PathBuf::from(custom);
            if let Some((assets, bytes)) = check_model_dir_fast(&p) {
                let lic = assets.model_dir.join("LICENSE-sensevoice.txt");
                return AsrModelStatus {
                    ready: runtime_ready,
                    runtime_ready,
                    source: AsrModelSource::Custom,
                    mode: AsrModelMode::Custom,
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
            return AsrModelStatus {
                ready: false,
                runtime_ready,
                source: AsrModelSource::Missing,
                mode: AsrModelMode::Custom,
                custom_dir: Some(custom.clone()),
                install_dir: install_dir.to_string_lossy().into_owned(),
                active_model_dir: None,
                installed_bytes: None,
                license_path: None,
                error: Some(format!(
                    "Custom ASR model directory '{}' does not contain verified SenseVoiceSmall INT8 + Silero VAD v5 files.",
                    custom
                )),
                spec,
            };
        }
    }

    if let Some((assets, bytes)) = check_model_dir_fast(&install_dir) {
        let lic = assets.model_dir.join("LICENSE-sensevoice.txt");
        return AsrModelStatus {
            ready: runtime_ready,
            runtime_ready,
            source: AsrModelSource::Managed,
            mode: AsrModelMode::Managed,
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

    AsrModelStatus {
        ready: false,
        runtime_ready,
        source: AsrModelSource::Missing,
        mode: AsrModelMode::Managed,
        custom_dir: cfg.custom_dir,
        install_dir: install_dir.to_string_lossy().into_owned(),
        active_model_dir: None,
        installed_bytes: None,
        license_path: None,
        error: None,
        spec,
    }
}

pub fn require_asr_assets(
    asr_root: &Path,
    resource_dir: Option<&Path>,
) -> Result<ResolvedAsrAssets, AppError> {
    let status = get_asr_model_status_impl(asr_root, resource_dir);
    if !status.runtime_ready {
        return Err(AppError::new(
            "ORT_RUNTIME_MISSING",
            "Bundled ONNX Runtime (onnxruntime.dll) is missing.",
        ));
    }
    let Some(active_dir) = status.active_model_dir else {
        return Err(AppError::new(
            "ASR_MODEL_MISSING",
            "Offline speech model (SenseVoiceSmall INT8 + Silero VAD v5) is not installed yet. Click 'Download Offline Speech Model' first.",
        ));
    };
    let dir = PathBuf::from(active_dir);
    let Some((assets, _)) = check_model_dir_fast(&dir) else {
        return Err(AppError::new(
            "ASR_MODEL_MISSING",
            "Offline speech model files are incomplete or modified; please re-download or re-select the model folder.",
        ));
    };
    Ok(assets)
}

pub fn set_asr_model_custom_dir_impl(
    asr_root: &Path,
    resource_dir: Option<&Path>,
    dir: Option<String>,
) -> Result<AsrModelStatus, AppError> {
    match dir {
        None => {
            save_config(
                asr_root,
                &AsrModelConfigFile {
                    mode: AsrModelMode::Managed,
                    custom_dir: None,
                },
            )?;
            Ok(get_asr_model_status_impl(asr_root, resource_dir))
        }
        Some(raw) => {
            let path = validate_user_path(&raw, "ASR model directory")?;
            if !path.is_dir() {
                return Err(AppError::invalid_param(
                    "Selected ASR model path is not an existing directory.",
                ));
            }
            verify_asr_model_dir_strict(&path)?;
            save_config(
                asr_root,
                &AsrModelConfigFile {
                    mode: AsrModelMode::Custom,
                    custom_dir: Some(path.to_string_lossy().into_owned()),
                },
            )?;
            Ok(get_asr_model_status_impl(asr_root, resource_dir))
        }
    }
}

pub fn remove_managed_asr_model_impl(
    asr_root: &Path,
    resource_dir: Option<&Path>,
) -> Result<AsrModelStatus, AppError> {
    let dir = managed_asr_install_dir(asr_root);
    if dir.exists() {
        fs::remove_dir_all(&dir)
            .map_err(|e| AppError::from_io(e, "Unable to remove managed ASR model directory"))?;
    }
    Ok(get_asr_model_status_impl(asr_root, resource_dir))
}

/// Extracts strictly `model.int8.onnx` and `tokens.txt` from the verified `.tar.bz2` archive
/// into `dest_dir`, checking cancellation throughout and verifying extracted SHA-256 digests.
pub fn extract_verified_sensevoice_tar_bz2(
    archive_path: &Path,
    dest_dir: &Path,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(&str),
) -> Result<(), AppError> {
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }
    fs::create_dir_all(dest_dir)
        .map_err(|e| AppError::from_io(e, "Unable to create ASR model staging directory"))?;

    let file = File::open(archive_path)
        .map_err(|e| AppError::from_io(e, "Unable to open downloaded SenseVoice archive"))?;
    let bz2 = Bz2DecoderReader::new(BufReader::with_capacity(256 * 1024, file));
    let mut tar = Archive::new(bz2);

    let mut got_model = false;
    let mut got_tokens = false;

    let entries = tar.entries().map_err(|e| {
        AppError::decode_failed(format!("Unable to read SenseVoice tar.bz2 archive: {e}"))
    })?;

    for entry_res in entries {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(AppError::cancelled());
        }
        let mut entry = entry_res.map_err(|e| {
            AppError::decode_failed(format!("Corrupt entry in SenseVoice tar.bz2 archive: {e}"))
        })?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let rel = entry
            .path()
            .map_err(|e| AppError::decode_failed(format!("Invalid archive entry path: {e}")))?;
        let file_name = rel
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();

        let target: Option<PathBuf> = if file_name == SENSEVOICE_MODEL_FILENAME {
            got_model = true;
            on_progress("Extracting model.int8.onnx (228 MiB)...");
            Some(dest_dir.join(SENSEVOICE_MODEL_FILENAME))
        } else if file_name == SENSEVOICE_TOKENS_FILENAME {
            got_tokens = true;
            on_progress("Extracting tokens.txt...");
            Some(dest_dir.join(SENSEVOICE_TOKENS_FILENAME))
        } else {
            None
        };

        if let Some(out_path) = target {
            let mut out = File::create(&out_path)
                .map_err(|e| AppError::from_io(e, "Unable to write extracted ASR file"))?;
            let mut buf = vec![0u8; 256 * 1024];
            loop {
                if cancel_flag.load(Ordering::Relaxed) {
                    return Err(AppError::cancelled());
                }
                let n = entry.read(&mut buf).map_err(|e| {
                    AppError::from_io(e, "Unable to decompress SenseVoice tar.bz2 entry")
                })?;
                if n == 0 {
                    break;
                }
                out.write_all(&buf[..n])
                    .map_err(|e| AppError::from_io(e, "Unable to write decompressed ASR bytes"))?;
            }
            out.flush()
                .map_err(|e| AppError::from_io(e, "Unable to flush extracted ASR file"))?;
        }

        if got_model && got_tokens {
            break;
        }
    }

    if !got_model || !got_tokens {
        return Err(AppError::decode_failed(
            "SenseVoice archive did not contain both model.int8.onnx and tokens.txt.",
        ));
    }

    Ok(())
}

/// User-initiated one-time download, SHA-256 verification, extraction, and atomic activation
/// of the pinned `SenseVoiceSmall INT8 + Silero VAD v5` offline speech bundle.
pub fn install_managed_asr_model_impl<F>(
    task_id: &str,
    asr_root: &Path,
    resource_dir: Option<&Path>,
    cancel_flag: &AtomicBool,
    mut on_progress: F,
) -> Result<AsrModelStatus, AppError>
where
    F: FnMut(AsrSetupProgressPayload),
{
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }
    fs::create_dir_all(asr_root)
        .map_err(|e| AppError::from_io(e, "Unable to create ASR model root directory"))?;

    let staging_dir = asr_root.join(format!(".staging-{}", Uuid::new_v4()));
    let extract_dir = staging_dir.join("extracted");
    fs::create_dir_all(&extract_dir)
        .map_err(|e| AppError::from_io(e, "Unable to create ASR staging directory"))?;

    let cleanup = |dir: &Path| {
        let _ = fs::remove_dir_all(dir);
    };

    // 1. Download Silero VAD v5 (2.21 MiB)
    let vad_tmp = extract_dir.join(SILERO_VAD_FILENAME);
    on_progress(AsrSetupProgressPayload {
        task_id: task_id.to_string(),
        phase: "downloading".into(),
        downloaded_bytes: 0,
        total_bytes: ASR_TOTAL_DOWNLOAD_BYTES,
        percent: Some(0.0),
        message: "Downloading Silero VAD v5 (2.2 MiB)...".into(),
    });

    let vad_dl = download_https_with_sha256(
        SILERO_VAD_URL,
        &vad_tmp,
        SILERO_VAD_BYTES,
        cancel_flag,
        |dl, _| {
            let pct = ((dl as f64 / ASR_TOTAL_DOWNLOAD_BYTES as f64) * 75.0).clamp(0.0, 2.0);
            on_progress(AsrSetupProgressPayload {
                task_id: task_id.to_string(),
                phase: "downloading".into(),
                downloaded_bytes: dl,
                total_bytes: ASR_TOTAL_DOWNLOAD_BYTES,
                percent: Some(pct),
                message: format!(
                    "Downloading Silero VAD v5 ({:.1} / {:.1} MiB)...",
                    dl as f64 / (1024.0 * 1024.0),
                    SILERO_VAD_BYTES as f64 / (1024.0 * 1024.0)
                ),
            });
        },
    );
    let (vad_bytes, vad_sha) = match vad_dl {
        Ok(v) => v,
        Err(e) => {
            cleanup(&staging_dir);
            return Err(e);
        }
    };
    if vad_bytes != SILERO_VAD_BYTES || !vad_sha.eq_ignore_ascii_case(SILERO_VAD_SHA256) {
        cleanup(&staging_dir);
        return Err(AppError::new(
            "CHECKSUM_MISMATCH",
            format!(
                "Silero VAD v5 checksum mismatch (expected {SILERO_VAD_BYTES} B / {SILERO_VAD_SHA256}, got {vad_bytes} B / {vad_sha})."
            ),
        ));
    }

    // 2. Download SenseVoiceSmall INT8 archive (155.45 MiB)
    let sv_archive_tmp = staging_dir.join("sensevoice-small-int8.tar.bz2.tmp");
    let sv_dl = download_https_with_sha256(
        SENSEVOICE_ARCHIVE_URL,
        &sv_archive_tmp,
        SENSEVOICE_ARCHIVE_BYTES,
        cancel_flag,
        |dl, _| {
            let total_dl = SILERO_VAD_BYTES.saturating_add(dl);
            let pct = ((total_dl as f64 / ASR_TOTAL_DOWNLOAD_BYTES as f64) * 75.0).clamp(1.0, 75.0);
            on_progress(AsrSetupProgressPayload {
                task_id: task_id.to_string(),
                phase: "downloading".into(),
                downloaded_bytes: total_dl,
                total_bytes: ASR_TOTAL_DOWNLOAD_BYTES,
                percent: Some(pct),
                message: format!(
                    "Downloading SenseVoiceSmall INT8 ({:.1} / {:.1} MiB)...",
                    total_dl as f64 / (1024.0 * 1024.0),
                    ASR_TOTAL_DOWNLOAD_BYTES as f64 / (1024.0 * 1024.0)
                ),
            });
        },
    );
    let (sv_bytes, sv_sha) = match sv_dl {
        Ok(v) => v,
        Err(e) => {
            cleanup(&staging_dir);
            return Err(e);
        }
    };

    on_progress(AsrSetupProgressPayload {
        task_id: task_id.to_string(),
        phase: "verifying".into(),
        downloaded_bytes: ASR_TOTAL_DOWNLOAD_BYTES,
        total_bytes: ASR_TOTAL_DOWNLOAD_BYTES,
        percent: Some(77.0),
        message: "Verifying archive SHA-256 digest...".into(),
    });

    if sv_bytes != SENSEVOICE_ARCHIVE_BYTES
        || !sv_sha.eq_ignore_ascii_case(SENSEVOICE_ARCHIVE_SHA256)
    {
        cleanup(&staging_dir);
        return Err(AppError::new(
            "CHECKSUM_MISMATCH",
            format!(
                "SenseVoiceSmall archive checksum mismatch (expected {SENSEVOICE_ARCHIVE_BYTES} B / {SENSEVOICE_ARCHIVE_SHA256}, got {sv_bytes} B / {sv_sha})."
            ),
        ));
    }

    // 3. Extract whitelisted files via bzip2-rs + tar
    on_progress(AsrSetupProgressPayload {
        task_id: task_id.to_string(),
        phase: "extracting".into(),
        downloaded_bytes: ASR_TOTAL_DOWNLOAD_BYTES,
        total_bytes: ASR_TOTAL_DOWNLOAD_BYTES,
        percent: Some(80.0),
        message: "Extracting SenseVoiceSmall INT8 ONNX model and vocabulary...".into(),
    });

    if let Err(e) =
        extract_verified_sensevoice_tar_bz2(&sv_archive_tmp, &extract_dir, cancel_flag, |msg| {
            on_progress(AsrSetupProgressPayload {
                task_id: task_id.to_string(),
                phase: "extracting".into(),
                downloaded_bytes: ASR_TOTAL_DOWNLOAD_BYTES,
                total_bytes: ASR_TOTAL_DOWNLOAD_BYTES,
                percent: Some(86.0),
                message: msg.to_string(),
            });
        })
    {
        cleanup(&staging_dir);
        return Err(e);
    }

    // 4. Verify extracted model & tokens SHA-256 and write verbatim license notices
    on_progress(AsrSetupProgressPayload {
        task_id: task_id.to_string(),
        phase: "verifying".into(),
        downloaded_bytes: ASR_TOTAL_DOWNLOAD_BYTES,
        total_bytes: ASR_TOTAL_DOWNLOAD_BYTES,
        percent: Some(94.0),
        message: "Verifying extracted ONNX weights and saving license notices...".into(),
    });

    if let Err(e) = verify_asr_model_dir_strict(&extract_dir) {
        cleanup(&staging_dir);
        return Err(e);
    }

    if let Err(e) = fs::write(
        extract_dir.join("LICENSE-sensevoice.txt"),
        SENSEVOICE_LICENSE_TEXT,
    )
    .and_then(|_| {
        fs::write(
            extract_dir.join("LICENSE-silero-vad.txt"),
            SILERO_VAD_LICENSE_TEXT,
        )
    }) {
        cleanup(&staging_dir);
        return Err(AppError::from_io(e, "Unable to write ASR license notices"));
    }

    if cancel_flag.load(Ordering::Relaxed) {
        cleanup(&staging_dir);
        return Err(AppError::cancelled());
    }

    // 5. Rollback-safe directory swap into managed target
    let target_dir = managed_asr_install_dir(asr_root);
    let backup_dir = asr_root.join(format!(".backup-{}", Uuid::new_v4()));
    let had_existing = target_dir.exists();
    if had_existing {
        if let Err(e) = fs::rename(&target_dir, &backup_dir) {
            cleanup(&staging_dir);
            return Err(AppError::from_io(
                e,
                "Unable to prepare target ASR model directory",
            ));
        }
    }

    if let Err(e) = fs::rename(&extract_dir, &target_dir) {
        if had_existing {
            let _ = fs::rename(&backup_dir, &target_dir);
        }
        cleanup(&staging_dir);
        return Err(AppError::from_io(
            e,
            "Unable to activate installed ASR model directory",
        ));
    }

    if had_existing {
        let _ = fs::remove_dir_all(&backup_dir);
    }
    cleanup(&staging_dir);

    let _ = save_config(
        asr_root,
        &AsrModelConfigFile {
            mode: AsrModelMode::Managed,
            custom_dir: None,
        },
    );

    on_progress(AsrSetupProgressPayload {
        task_id: task_id.to_string(),
        phase: "completed".into(),
        downloaded_bytes: ASR_TOTAL_DOWNLOAD_BYTES,
        total_bytes: ASR_TOTAL_DOWNLOAD_BYTES,
        percent: Some(100.0),
        message: "Offline speech model verified and ready.".into(),
    });

    Ok(get_asr_model_status_impl(asr_root, resource_dir))
}

#[allow(dead_code)]
pub fn write_licenses_to_dir(dir: &Path) -> io::Result<()> {
    fs::write(dir.join("LICENSE-sensevoice.txt"), SENSEVOICE_LICENSE_TEXT)?;
    fs::write(dir.join("LICENSE-silero-vad.txt"), SILERO_VAD_LICENSE_TEXT)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn missing_asr_model_reports_missing_and_pinned_spec() {
        let dir = tempdir().expect("tempdir");
        let status = get_asr_model_status_impl(dir.path(), None);
        assert!(!status.ready);
        assert_eq!(status.source, AsrModelSource::Missing);
        assert_eq!(status.mode, AsrModelMode::Managed);
        assert_eq!(status.spec.model_id, ASR_MODEL_ID);
        assert_eq!(status.spec.total_download_bytes, ASR_TOTAL_DOWNLOAD_BYTES);
        assert_eq!(
            status.spec.sensevoice_archive_sha256,
            SENSEVOICE_ARCHIVE_SHA256
        );
        assert_eq!(status.spec.silero_vad_sha256, SILERO_VAD_SHA256);
        for sha in [
            SENSEVOICE_ARCHIVE_SHA256,
            SENSEVOICE_MODEL_SHA256,
            SENSEVOICE_TOKENS_SHA256,
            SILERO_VAD_SHA256,
        ] {
            assert_eq!(
                sha.len(),
                64,
                "SHA-256 constant must be 64 hex chars: {sha}"
            );
            assert!(
                sha.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
                "SHA-256 constant must be lowercase hex: {sha}"
            );
        }
    }

    #[test]
    fn custom_asr_dir_rejects_missing_or_tampered_sha256_files() {
        let root = tempdir().expect("root");
        let bad_dir = tempdir().expect("bad_dir");

        // Empty dir -> ASR_MODEL_MISSING
        let missing_err = set_asr_model_custom_dir_impl(
            root.path(),
            None,
            Some(bad_dir.path().to_string_lossy().into_owned()),
        )
        .unwrap_err();
        assert_eq!(missing_err.code, "ASR_MODEL_MISSING");

        // All 3 files present with tampered contents -> CHECKSUM_MISMATCH
        fs::write(
            bad_dir.path().join(SENSEVOICE_MODEL_FILENAME),
            b"fake model",
        )
        .expect("m");
        fs::write(
            bad_dir.path().join(SENSEVOICE_TOKENS_FILENAME),
            b"fake tokens",
        )
        .expect("t");
        fs::write(bad_dir.path().join(SILERO_VAD_FILENAME), b"fake vad").expect("v");

        let sha_err = set_asr_model_custom_dir_impl(
            root.path(),
            None,
            Some(bad_dir.path().to_string_lossy().into_owned()),
        )
        .unwrap_err();
        assert_eq!(sha_err.code, "CHECKSUM_MISMATCH");
    }

    #[test]
    fn license_notices_and_remove_managed_model_work_cleanly() {
        let root = tempdir().expect("root");
        let managed = managed_asr_install_dir(root.path());
        fs::create_dir_all(&managed).expect("mkdir");
        write_licenses_to_dir(&managed).expect("write licenses");
        let sv_lic = fs::read_to_string(managed.join("LICENSE-sensevoice.txt")).expect("read sv");
        let vad_lic = fs::read_to_string(managed.join("LICENSE-silero-vad.txt")).expect("read vad");
        assert!(sv_lic.contains("FunASR Model Open Source License Agreement"));
        assert!(sv_lic.contains("Copyright (C) [2023-2028] [Alibaba Group]"));
        assert!(sv_lic.contains("4.2 Prohibited Behavior"));
        assert!(sv_lic.contains("5 Termination"));
        assert!(sv_lic.contains("6 Revisions"));
        assert!(sv_lic.contains("7 Miscellaneous"));
        assert!(sv_lic.contains("FunASR 模型开源协议"));
        assert!(sv_lic.contains("版权所有 (C) [2023-2028] [阿里巴巴集团]"));
        assert!(vad_lic.contains("MIT License"));
        assert!(vad_lic.contains("Copyright (c) 2020-present Silero Team"));

        let after_rm = remove_managed_asr_model_impl(root.path(), None).expect("remove");
        assert!(!managed.exists());
        assert_eq!(after_rm.source, AsrModelSource::Missing);
    }
}
