//! Local `yt-dlp` discovery, user-initiated SHA-256 verified Windows x64 installation,
//! rollback-safe update preservation, license preservation, and JS runtime detection.

use crate::error::AppError;
use crate::fs_guard::validate_user_path;
use crate::media_core::{configure_hidden_command, download_https_with_sha256};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

pub const YTDLP_SETUP_PROGRESS_EVENT: &str = "winkit://ytdlp-setup-progress";

pub const MANAGED_YTDLP_VERSION: &str = "2026.10.26";
pub const MANAGED_YTDLP_SOURCE_NAME: &str = "yt-dlp/yt-dlp (Release 2026.10.26 · Windows x64)";
pub const MANAGED_YTDLP_RELEASE_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26";
pub const MANAGED_YTDLP_DOWNLOAD_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp.exe";
pub const MANAGED_YTDLP_DOWNLOAD_BYTES: u64 = 23_575_744;
pub const MANAGED_YTDLP_SHA256: &str =
    "f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d";
pub const MANAGED_YTDLP_LICENSE_NAME: &str = "The Unlicense";

pub const MANAGED_YTDLP_LICENSE_TEXT: &str = r#"yt-dlp (Official Windows x64 Standalone Release 2026.10.26)
Upstream Repository: https://github.com/yt-dlp/yt-dlp
Release Page: https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26
SHA-256 (yt-dlp.exe): f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d

========================================================================
THE UNLICENSE (yt-dlp upstream license)
========================================================================

This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <http://unlicense.org/>

========================================================================
BUNDLED RUNTIME NOTICE
========================================================================

The standalone yt-dlp.exe binary distributed by the yt-dlp project is
packaged with PyInstaller and bundles the CPython runtime and Python
dependencies (such as certifi, mutagen, pycryptodomex, requests, urllib3,
websockets, and brotli) under their respective open-source licenses.
WinKit downloads this official binary only upon explicit user action,
verifies its SHA-256 digest before activation, and executes it strictly
as an external child process.
"#;

const YTDLP_PROBE_TIMEOUT_MS: u64 = 12_000;
const JS_RUNTIME_PROBE_TIMEOUT_MS: u64 = 3_500;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedYtdlpSpec {
    pub version: String,
    pub source_name: String,
    pub release_url: String,
    pub download_url: String,
    pub download_bytes: u64,
    pub sha256: String,
    pub license_name: String,
}

impl ManagedYtdlpSpec {
    pub fn pinned() -> Self {
        Self {
            version: MANAGED_YTDLP_VERSION.to_string(),
            source_name: MANAGED_YTDLP_SOURCE_NAME.to_string(),
            release_url: MANAGED_YTDLP_RELEASE_URL.to_string(),
            download_url: MANAGED_YTDLP_DOWNLOAD_URL.to_string(),
            download_bytes: MANAGED_YTDLP_DOWNLOAD_BYTES,
            sha256: MANAGED_YTDLP_SHA256.to_string(),
            license_name: MANAGED_YTDLP_LICENSE_NAME.to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum YtdlpMode {
    Auto,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum YtdlpSource {
    Managed,
    SystemPath,
    Custom,
    Missing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct YtdlpConfigFile {
    mode: YtdlpMode,
    custom_path: Option<String>,
}

impl Default for YtdlpConfigFile {
    fn default() -> Self {
        Self {
            mode: YtdlpMode::Auto,
            custom_path: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsRuntimeInfo {
    pub name: String,
    pub path: String,
    pub version: String,
    pub recommended: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YtdlpToolsStatus {
    pub ready: bool,
    pub source: YtdlpSource,
    pub mode: YtdlpMode,
    pub custom_path: Option<String>,
    pub ytdlp_path: Option<String>,
    pub ytdlp_version: Option<String>,
    pub install_dir: String,
    pub managed_installed_bytes: Option<u64>,
    pub license_path: Option<String>,
    pub js_runtimes: Vec<JsRuntimeInfo>,
    pub has_js_runtime: bool,
    pub error: Option<String>,
    pub spec: ManagedYtdlpSpec,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YtdlpSetupProgressPayload {
    pub task_id: String,
    pub phase: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percent: Option<f64>,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct ResolvedYtdlp {
    pub source: YtdlpSource,
    pub binary: PathBuf,
    pub version: String,
    pub js_runtimes: Vec<JsRuntimeInfo>,
}

pub fn ytdlp_root_dir(media_root: &Path) -> PathBuf {
    media_root.join("yt-dlp")
}

pub fn managed_ytdlp_active_dir(media_root: &Path) -> PathBuf {
    ytdlp_root_dir(media_root).join("active")
}

pub fn managed_ytdlp_exe_path(media_root: &Path) -> PathBuf {
    managed_ytdlp_active_dir(media_root).join("yt-dlp.exe")
}

fn config_file_path(media_root: &Path) -> PathBuf {
    ytdlp_root_dir(media_root).join("config.json")
}

fn load_config(media_root: &Path) -> YtdlpConfigFile {
    let path = config_file_path(media_root);
    let Ok(text) = fs::read_to_string(path) else {
        return YtdlpConfigFile::default();
    };
    serde_json::from_str::<YtdlpConfigFile>(&text).unwrap_or_default()
}

fn save_config(media_root: &Path, cfg: &YtdlpConfigFile) -> Result<(), AppError> {
    let root = ytdlp_root_dir(media_root);
    fs::create_dir_all(&root)
        .map_err(|e| AppError::from_io(e, "Unable to create yt-dlp config directory"))?;
    let path = config_file_path(media_root);
    let tmp = root.join(format!("config-{}.tmp", Uuid::new_v4()));
    let json = serde_json::to_string_pretty(cfg)
        .map_err(|e| AppError::new("INTERNAL_ERROR", format!("Failed to serialize config: {e}")))?;
    fs::write(&tmp, json.as_bytes())
        .map_err(|e| AppError::from_io(e, "Unable to write yt-dlp config"))?;
    if path.exists() {
        let _ = fs::remove_file(&path);
    }
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        AppError::from_io(e, "Unable to save yt-dlp config")
    })?;
    Ok(())
}

fn run_version_probe(exe: &Path, args: &[&str], timeout_ms: u64) -> Result<String, String> {
    if !exe.is_file() {
        return Err(format!("Executable not found: {}", exe.display()));
    }
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_hidden_command(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start {}: {e}", exe.display()))?;

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = String::new();
                if let Some(mut out) = child.stdout.take() {
                    let _ = out.read_to_string(&mut stdout);
                }
                let mut stderr = String::new();
                if let Some(mut err) = child.stderr.take() {
                    let _ = err.read_to_string(&mut stderr);
                }
                if !status.success() {
                    let brief = stderr
                        .lines()
                        .find(|l| !l.trim().is_empty())
                        .unwrap_or("non-zero exit");
                    return Err(format!(
                        "{} exited with status {:?}: {}",
                        exe.display(),
                        status.code(),
                        brief
                    ));
                }
                let first = stdout
                    .lines()
                    .find(|l| !l.trim().is_empty())
                    .or_else(|| stderr.lines().find(|l| !l.trim().is_empty()))
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if first.is_empty() {
                    return Err(format!("{} returned empty version output.", exe.display()));
                }
                return Ok(first);
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "Timed out waiting for {} --version.",
                        exe.display()
                    ));
                }
                thread::sleep(Duration::from_millis(25));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Failed polling {}: {e}", exe.display()));
            }
        }
    }
}

pub fn verify_ytdlp_binary(exe: &Path) -> Result<String, String> {
    let ver = run_version_probe(exe, &["--version"], YTDLP_PROBE_TIMEOUT_MS)?;
    // yt-dlp version format is typically YYYY.MM.DD (or similar dotted version string).
    // Reject obvious non-yt-dlp binaries that emit multi-word usage text without digits.
    if ver.len() > 64 || !ver.chars().any(|c| c.is_ascii_digit()) {
        return Err(format!("Unexpected yt-dlp version output: {ver}"));
    }
    Ok(ver)
}

fn find_ytdlp_in_path_or_dir(path: &Path) -> Option<PathBuf> {
    if path.is_file() {
        return Some(path.to_path_buf());
    }
    if path.is_dir() {
        let candidates = [
            path.join("yt-dlp.exe"),
            path.join("yt-dlp"),
            path.join("bin").join("yt-dlp.exe"),
            path.join("bin").join("yt-dlp"),
        ];
        for cand in candidates {
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

fn find_binary_on_system_path(names: &[&str]) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Detects external JavaScript runtimes supported by upstream yt-dlp EJS (`deno`, `node`, `bun`, `quickjs`)
/// on the existing system `PATH` without mutating environment variables.
pub fn detect_js_runtimes() -> Vec<JsRuntimeInfo> {
    let specs: [(&str, &[&str], bool); 4] = [
        ("deno", &["deno.exe", "deno"], true),
        ("node", &["node.exe", "node"], false),
        ("bun", &["bun.exe", "bun"], false),
        (
            "quickjs",
            &["qjs.exe", "qjs", "quickjs.exe", "quickjs"],
            false,
        ),
    ];

    let mut found = Vec::new();
    for (runtime_name, exe_names, recommended) in specs {
        if let Some(bin) = find_binary_on_system_path(exe_names) {
            let version = run_version_probe(&bin, &["--version"], JS_RUNTIME_PROBE_TIMEOUT_MS)
                .unwrap_or_else(|_| "detected".to_string());
            found.push(JsRuntimeInfo {
                name: runtime_name.to_string(),
                path: bin.to_string_lossy().to_string(),
                version,
                recommended,
            });
        }
    }
    found
}

fn compute_file_sha256_and_size(path: &Path) -> Result<(u64, String), AppError> {
    let mut file =
        File::open(path).map_err(|e| AppError::from_io(e, "Unable to open binary for hashing"))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    let mut total: u64 = 0;
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| AppError::from_io(e, "Unable to read binary for hashing"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total = total.saturating_add(n as u64);
    }
    Ok((total, format!("{:x}", hasher.finalize())))
}

pub fn get_ytdlp_tools_status_impl(media_root: &Path) -> YtdlpToolsStatus {
    let cfg = load_config(media_root);
    let active_dir = managed_ytdlp_active_dir(media_root);
    let active_exe = managed_ytdlp_exe_path(media_root);
    let install_dir_str = active_dir.to_string_lossy().to_string();
    let managed_bytes = fs::metadata(&active_exe).ok().map(|m| m.len());
    let license_file = active_dir.join("LICENSE-yt-dlp.txt");
    let license_path = if license_file.is_file() {
        Some(license_file.to_string_lossy().to_string())
    } else {
        None
    };
    let js_runtimes = detect_js_runtimes();
    let has_js_runtime = !js_runtimes.is_empty();
    let spec = ManagedYtdlpSpec::pinned();

    if cfg.mode == YtdlpMode::Custom {
        if let Some(ref custom_str) = cfg.custom_path {
            let p = PathBuf::from(custom_str);
            if let Some(bin) = find_ytdlp_in_path_or_dir(&p) {
                match verify_ytdlp_binary(&bin) {
                    Ok(ver) => {
                        return YtdlpToolsStatus {
                            ready: true,
                            source: YtdlpSource::Custom,
                            mode: YtdlpMode::Custom,
                            custom_path: cfg.custom_path,
                            ytdlp_path: Some(bin.to_string_lossy().to_string()),
                            ytdlp_version: Some(ver),
                            install_dir: install_dir_str,
                            managed_installed_bytes: managed_bytes,
                            license_path,
                            js_runtimes,
                            has_js_runtime,
                            error: None,
                            spec,
                        };
                    }
                    Err(err) => {
                        return YtdlpToolsStatus {
                            ready: false,
                            source: YtdlpSource::Missing,
                            mode: YtdlpMode::Custom,
                            custom_path: cfg.custom_path,
                            ytdlp_path: None,
                            ytdlp_version: None,
                            install_dir: install_dir_str,
                            managed_installed_bytes: managed_bytes,
                            license_path,
                            js_runtimes,
                            has_js_runtime,
                            error: Some(err),
                            spec,
                        };
                    }
                }
            }
            return YtdlpToolsStatus {
                ready: false,
                source: YtdlpSource::Missing,
                mode: YtdlpMode::Custom,
                custom_path: cfg.custom_path,
                ytdlp_path: None,
                ytdlp_version: None,
                install_dir: install_dir_str,
                managed_installed_bytes: managed_bytes,
                license_path,
                js_runtimes,
                has_js_runtime,
                error: Some("Selected path does not contain a usable yt-dlp.exe.".into()),
                spec,
            };
        }
    }

    // Auto discovery: 1) WinKit managed install, 2) system PATH
    if active_exe.is_file() {
        if let Ok(ver) = verify_ytdlp_binary(&active_exe) {
            return YtdlpToolsStatus {
                ready: true,
                source: YtdlpSource::Managed,
                mode: YtdlpMode::Auto,
                custom_path: cfg.custom_path,
                ytdlp_path: Some(active_exe.to_string_lossy().to_string()),
                ytdlp_version: Some(ver),
                install_dir: install_dir_str,
                managed_installed_bytes: managed_bytes,
                license_path,
                js_runtimes,
                has_js_runtime,
                error: None,
                spec,
            };
        }
    }

    if let Some(sys_bin) = find_binary_on_system_path(&["yt-dlp.exe", "yt-dlp"]) {
        if let Ok(ver) = verify_ytdlp_binary(&sys_bin) {
            return YtdlpToolsStatus {
                ready: true,
                source: YtdlpSource::SystemPath,
                mode: YtdlpMode::Auto,
                custom_path: cfg.custom_path,
                ytdlp_path: Some(sys_bin.to_string_lossy().to_string()),
                ytdlp_version: Some(ver),
                install_dir: install_dir_str,
                managed_installed_bytes: managed_bytes,
                license_path,
                js_runtimes,
                has_js_runtime,
                error: None,
                spec,
            };
        }
    }

    YtdlpToolsStatus {
        ready: false,
        source: YtdlpSource::Missing,
        mode: YtdlpMode::Auto,
        custom_path: cfg.custom_path,
        ytdlp_path: None,
        ytdlp_version: None,
        install_dir: install_dir_str,
        managed_installed_bytes: managed_bytes,
        license_path,
        js_runtimes,
        has_js_runtime,
        error: None,
        spec,
    }
}

pub fn resolve_ytdlp_optional(media_root: &Path) -> Option<ResolvedYtdlp> {
    let status = get_ytdlp_tools_status_impl(media_root);
    if !status.ready {
        return None;
    }
    Some(ResolvedYtdlp {
        source: status.source,
        binary: PathBuf::from(status.ytdlp_path?),
        version: status.ytdlp_version.unwrap_or_default(),
        js_runtimes: status.js_runtimes,
    })
}

pub fn require_ytdlp(media_root: &Path) -> Result<ResolvedYtdlp, AppError> {
    resolve_ytdlp_optional(media_root).ok_or_else(|| {
        AppError::new(
            "YTDLP_MISSING",
            "yt-dlp is not configured yet. Install the verified Windows yt-dlp component or choose an existing local yt-dlp.exe to parse web video pages and adaptive manifests (direct media links work without yt-dlp).",
        )
    })
}

pub fn set_ytdlp_custom_path_impl(
    media_root: &Path,
    path_raw: Option<String>,
) -> Result<YtdlpToolsStatus, AppError> {
    match path_raw {
        None => {
            save_config(
                media_root,
                &YtdlpConfigFile {
                    mode: YtdlpMode::Auto,
                    custom_path: None,
                },
            )?;
            Ok(get_ytdlp_tools_status_impl(media_root))
        }
        Some(raw) => {
            let path = validate_user_path(&raw, "yt-dlp path")?;
            let Some(bin) = find_ytdlp_in_path_or_dir(&path) else {
                return Err(AppError::new(
                    "YTDLP_INVALID",
                    "Selected path does not contain yt-dlp.exe.",
                ));
            };
            verify_ytdlp_binary(&bin).map_err(|e| {
                AppError::new(
                    "YTDLP_INVALID",
                    format!("Selected yt-dlp executable failed --version self-check: {e}"),
                )
            })?;
            save_config(
                media_root,
                &YtdlpConfigFile {
                    mode: YtdlpMode::Custom,
                    custom_path: Some(bin.to_string_lossy().to_string()),
                },
            )?;
            Ok(get_ytdlp_tools_status_impl(media_root))
        }
    }
}

/// Verifies a staged `yt-dlp.exe` binary (exact size, SHA-256, and `--version` self-check),
/// writes the verbatim Unlicense + bundled runtime notice, and atomically swaps it into
/// `media_root/yt-dlp/active`. If ANY verification step fails, the staging directory is cleaned
/// up and any existing working installation in `active/` is preserved completely untouched.
pub fn activate_staged_ytdlp_binary(
    media_root: &Path,
    staged_exe: &Path,
    expected_bytes: u64,
    expected_sha256: &str,
    skip_version_check_for_test: Option<&str>,
    cancel_flag: &AtomicBool,
) -> Result<YtdlpToolsStatus, AppError> {
    let root = ytdlp_root_dir(media_root);
    fs::create_dir_all(&root)
        .map_err(|e| AppError::from_io(e, "Unable to create yt-dlp directory"))?;

    let staging_dir = root.join(format!(".activate-{}", Uuid::new_v4()));
    fs::create_dir_all(&staging_dir)
        .map_err(|e| AppError::from_io(e, "Unable to create yt-dlp activation staging folder"))?;
    let cleanup = |dir: &Path| {
        let _ = fs::remove_dir_all(dir);
    };

    if cancel_flag.load(Ordering::Relaxed) {
        cleanup(&staging_dir);
        return Err(AppError::cancelled());
    }

    let (actual_bytes, actual_sha256) = match compute_file_sha256_and_size(staged_exe) {
        Ok(v) => v,
        Err(e) => {
            cleanup(&staging_dir);
            return Err(e);
        }
    };

    if actual_bytes != expected_bytes || !actual_sha256.eq_ignore_ascii_case(expected_sha256) {
        cleanup(&staging_dir);
        return Err(AppError::new(
            "CHECKSUM_MISMATCH",
            format!(
                "Downloaded yt-dlp binary failed SHA-256 verification (expected {} bytes / {}, got {} bytes / {}). Any previously installed version was kept intact.",
                expected_bytes, expected_sha256, actual_bytes, actual_sha256
            ),
        ));
    }

    let dest_exe = staging_dir.join("yt-dlp.exe");
    if let Err(e) = fs::copy(staged_exe, &dest_exe) {
        cleanup(&staging_dir);
        return Err(AppError::from_io(e, "Unable to stage verified yt-dlp.exe"));
    }

    let license_dest = staging_dir.join("LICENSE-yt-dlp.txt");
    if let Err(e) = fs::write(&license_dest, MANAGED_YTDLP_LICENSE_TEXT.as_bytes()) {
        cleanup(&staging_dir);
        return Err(AppError::from_io(
            e,
            "Unable to write yt-dlp license notice file",
        ));
    }

    if let Some(forced_err) = skip_version_check_for_test {
        if !forced_err.is_empty() {
            cleanup(&staging_dir);
            return Err(AppError::new(
                "YTDLP_INVALID",
                format!(
                    "New yt-dlp binary failed self-check ({forced_err}). Any previously installed version was kept intact."
                ),
            ));
        }
    } else if let Err(e) = verify_ytdlp_binary(&dest_exe) {
        cleanup(&staging_dir);
        return Err(AppError::new(
            "YTDLP_INVALID",
            format!(
                "Verified yt-dlp binary failed --version self-check ({e}). Any previously installed version was kept intact."
            ),
        ));
    }

    if cancel_flag.load(Ordering::Relaxed) {
        cleanup(&staging_dir);
        return Err(AppError::cancelled());
    }

    let final_dir = managed_ytdlp_active_dir(media_root);
    let backup_dir = root.join(format!(".backup-{}", Uuid::new_v4()));
    let had_existing = final_dir.exists();
    if had_existing {
        if let Err(e) = fs::rename(&final_dir, &backup_dir) {
            cleanup(&staging_dir);
            return Err(AppError::from_io(
                e,
                "Unable to back up existing yt-dlp installation (existing binary left intact)",
            ));
        }
    }

    if let Err(e) = fs::rename(&staging_dir, &final_dir) {
        if had_existing {
            let _ = fs::rename(&backup_dir, &final_dir);
        }
        cleanup(&staging_dir);
        return Err(AppError::from_io(
            e,
            "Unable to activate new yt-dlp installation (previous version restored)",
        ));
    }

    if had_existing {
        let _ = fs::remove_dir_all(&backup_dir);
    }

    save_config(
        media_root,
        &YtdlpConfigFile {
            mode: YtdlpMode::Auto,
            custom_path: None,
        },
    )?;

    Ok(get_ytdlp_tools_status_impl(media_root))
}

/// User-initiated one-click download, SHA-256 verification, license preservation, `--version`
/// self-check, and rollback-safe atomic activation of pinned official `yt-dlp.exe`.
pub fn install_managed_ytdlp_impl(
    task_id: &str,
    media_root: &Path,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(YtdlpSetupProgressPayload),
) -> Result<YtdlpToolsStatus, AppError> {
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }
    let root = ytdlp_root_dir(media_root);
    fs::create_dir_all(&root)
        .map_err(|e| AppError::from_io(e, "Unable to create yt-dlp directory"))?;

    let download_staging = root.join(format!(".dl-staging-{}", Uuid::new_v4()));
    fs::create_dir_all(&download_staging)
        .map_err(|e| AppError::from_io(e, "Unable to create yt-dlp download staging folder"))?;
    let cleanup = |dir: &Path| {
        let _ = fs::remove_dir_all(dir);
    };

    let tmp_exe = download_staging.join("yt-dlp.exe.tmp");

    on_progress(YtdlpSetupProgressPayload {
        task_id: task_id.to_string(),
        phase: "downloading".into(),
        downloaded_bytes: 0,
        total_bytes: MANAGED_YTDLP_DOWNLOAD_BYTES,
        percent: Some(0.0),
        message: format!(
            "Connecting to official GitHub Release (yt-dlp {})...",
            MANAGED_YTDLP_VERSION
        ),
    });

    let dl_res = download_https_with_sha256(
        MANAGED_YTDLP_DOWNLOAD_URL,
        &tmp_exe,
        MANAGED_YTDLP_DOWNLOAD_BYTES,
        cancel_flag,
        |downloaded, total| {
            let denom = if total > 0 {
                total
            } else {
                MANAGED_YTDLP_DOWNLOAD_BYTES
            };
            let pct = ((downloaded as f64 / denom as f64) * 82.0).clamp(0.0, 82.0);
            on_progress(YtdlpSetupProgressPayload {
                task_id: task_id.to_string(),
                phase: "downloading".into(),
                downloaded_bytes: downloaded,
                total_bytes: denom,
                percent: Some(pct),
                message: format!(
                    "Downloading yt-dlp {} ({:.1} / {:.1} MiB)...",
                    MANAGED_YTDLP_VERSION,
                    downloaded as f64 / (1024.0 * 1024.0),
                    denom as f64 / (1024.0 * 1024.0)
                ),
            });
        },
    );

    let (actual_bytes, actual_sha256) = match dl_res {
        Ok(v) => v,
        Err(e) => {
            cleanup(&download_staging);
            return Err(e);
        }
    };

    on_progress(YtdlpSetupProgressPayload {
        task_id: task_id.to_string(),
        phase: "verifying".into(),
        downloaded_bytes: actual_bytes,
        total_bytes: MANAGED_YTDLP_DOWNLOAD_BYTES,
        percent: Some(88.0),
        message: "Verifying SHA-256 digest and license...".into(),
    });

    if actual_bytes != MANAGED_YTDLP_DOWNLOAD_BYTES
        || !actual_sha256.eq_ignore_ascii_case(MANAGED_YTDLP_SHA256)
    {
        cleanup(&download_staging);
        return Err(AppError::new(
            "CHECKSUM_MISMATCH",
            format!(
                "Downloaded yt-dlp.exe failed SHA-256 verification (expected {} bytes / {}, got {} bytes / {}). Any previously installed version was kept intact.",
                MANAGED_YTDLP_DOWNLOAD_BYTES, MANAGED_YTDLP_SHA256, actual_bytes, actual_sha256
            ),
        ));
    }

    on_progress(YtdlpSetupProgressPayload {
        task_id: task_id.to_string(),
        phase: "testing".into(),
        downloaded_bytes: actual_bytes,
        total_bytes: MANAGED_YTDLP_DOWNLOAD_BYTES,
        percent: Some(94.0),
        message: "Running yt-dlp --version self-check...".into(),
    });

    let activated = activate_staged_ytdlp_binary(
        media_root,
        &tmp_exe,
        MANAGED_YTDLP_DOWNLOAD_BYTES,
        MANAGED_YTDLP_SHA256,
        None,
        cancel_flag,
    );
    cleanup(&download_staging);

    let status = activated?;
    on_progress(YtdlpSetupProgressPayload {
        task_id: task_id.to_string(),
        phase: "completed".into(),
        downloaded_bytes: actual_bytes,
        total_bytes: MANAGED_YTDLP_DOWNLOAD_BYTES,
        percent: Some(100.0),
        message: format!("yt-dlp {} verified and ready.", MANAGED_YTDLP_VERSION),
    });
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn failed_update_preserves_existing_working_managed_ytdlp_and_license() {
        let dir = tempdir().expect("tempdir");
        let media_root = dir.path();
        let cancel = AtomicBool::new(false);

        // 1. Seed a known-good initial payload and activate it (skipping --version execution for fake bytes)
        let good_src = dir.path().join("good_v1.bin");
        let good_bytes = b"KNOWN_GOOD_YTDLP_BINARY_V1";
        fs::write(&good_src, good_bytes).expect("write v1");
        let (good_len, good_sha) = compute_file_sha256_and_size(&good_src).expect("hash v1");

        let _ = activate_staged_ytdlp_binary(
            media_root,
            &good_src,
            good_len,
            &good_sha,
            Some(""),
            &cancel,
        )
        .expect("initial install succeeds");

        let active_exe = managed_ytdlp_exe_path(media_root);
        let active_license = managed_ytdlp_active_dir(media_root).join("LICENSE-yt-dlp.txt");
        assert_eq!(fs::read(&active_exe).unwrap(), good_bytes);
        let lic_text = fs::read_to_string(&active_license).unwrap();
        assert!(lic_text.contains("THE UNLICENSE"));
        assert!(lic_text.contains(MANAGED_YTDLP_SHA256));

        // 2. Attempt update with corrupted bytes (SHA-256 mismatch) -> must fail AND preserve v1
        let bad_src = dir.path().join("corrupted_v2.bin");
        fs::write(&bad_src, b"CORRUPTED_PAYLOAD_DO_NOT_ACTIVATE").expect("write bad");
        let err = activate_staged_ytdlp_binary(
            media_root,
            &bad_src,
            good_len,
            &good_sha,
            Some(""),
            &cancel,
        )
        .expect_err("checksum mismatch must fail");
        assert_eq!(err.code, "CHECKSUM_MISMATCH");
        assert_eq!(
            fs::read(&active_exe).unwrap(),
            good_bytes,
            "previous working binary must remain untouched after checksum failure"
        );

        // 3. Attempt update with matching SHA-256 that fails --version self-check -> must fail AND preserve v1
        let broken_src = dir.path().join("broken_v2.bin");
        fs::write(&broken_src, b"BROKEN_SELF_CHECK_V2").expect("write broken");
        let (b_len, b_sha) = compute_file_sha256_and_size(&broken_src).expect("hash broken");
        let err2 = activate_staged_ytdlp_binary(
            media_root,
            &broken_src,
            b_len,
            &b_sha,
            Some("exit code 1"),
            &cancel,
        )
        .expect_err("self-check failure must fail");
        assert_eq!(err2.code, "YTDLP_INVALID");
        assert_eq!(
            fs::read(&active_exe).unwrap(),
            good_bytes,
            "previous working binary must remain untouched after self-check failure"
        );

        // 4. Verify zero staging/backup directories leaked inside yt-dlp root
        let leftover: Vec<_> = fs::read_dir(ytdlp_root_dir(media_root))
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with('.'))
            .collect();
        assert!(
            leftover.is_empty(),
            "no staging/backup dirs may remain: {:?}",
            leftover
        );
    }
}
