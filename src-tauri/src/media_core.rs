//! Shared local FFmpeg / ffprobe discovery, user-initiated verified installation,
//! scoped child-process execution with cancellation/progress, safe non-destructive
//! output path allocation, and an allow-listed HTTP Range media preview protocol.

use crate::error::AppError;
use crate::fs_guard::{
    paths_refer_to_same_location, validate_existing_input_file, validate_user_path,
};
use serde::{Deserialize, Serialize};
use sevenz_rust2::{ArchiveReader as SevenZReader, Password as SevenZPassword};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub const MEDIA_SETUP_PROGRESS_EVENT: &str = "winkit://media-setup-progress";
pub const MEDIA_TASK_PROGRESS_EVENT: &str = "winkit://media-progress";

pub const MANAGED_FFMPEG_DIR_NAME: &str = "ffmpeg-9.1-essentials";
pub const MANAGED_FFMPEG_VERSION: &str = "9.1-essentials_build-www.gyan.dev";
pub const MANAGED_FFMPEG_SOURCE_NAME: &str = "GyanD/codexffmpeg (Release 9.1 · Windows x64 Static)";
pub const MANAGED_FFMPEG_RELEASE_URL: &str =
    "https://github.com/GyanD/codexffmpeg/releases/tag/9.1";
pub const MANAGED_FFMPEG_SOURCE_COMMIT_URL: &str =
    "https://github.com/FFmpeg/FFmpeg/commit/74e4393595";
pub const MANAGED_FFMPEG_DOWNLOAD_URL: &str =
    "https://github.com/GyanD/codexffmpeg/releases/download/9.1/ffmpeg-9.1-essentials_build.7z";
pub const MANAGED_FFMPEG_DOWNLOAD_BYTES: u64 = 36_671_021;
pub const MANAGED_FFMPEG_SHA256: &str =
    "835b9a733445ba7a56a37a26cf7bde84e2f3ce7da2a8ec984276bb2abb1b922c";
pub const MANAGED_FFMPEG_INSTALLED_BYTES: u64 = 221_044_037;
pub const MANAGED_FFMPEG_LICENSE_NAME: &str = "GNU GPL v3";

const MAX_PREVIEW_REGISTRY_ENTRIES: usize = 64;
const STREAM_CHUNK_BYTES: u64 = 2 * 1024 * 1024;
const PROBE_TIMEOUT_MS: u64 = 8_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedFfmpegSpec {
    pub version: String,
    pub source_name: String,
    pub release_url: String,
    pub source_commit_url: String,
    pub download_url: String,
    pub download_bytes: u64,
    pub sha256: String,
    pub estimated_installed_bytes: u64,
    pub license_name: String,
}

impl ManagedFfmpegSpec {
    pub fn pinned() -> Self {
        Self {
            version: MANAGED_FFMPEG_VERSION.to_string(),
            source_name: MANAGED_FFMPEG_SOURCE_NAME.to_string(),
            release_url: MANAGED_FFMPEG_RELEASE_URL.to_string(),
            source_commit_url: MANAGED_FFMPEG_SOURCE_COMMIT_URL.to_string(),
            download_url: MANAGED_FFMPEG_DOWNLOAD_URL.to_string(),
            download_bytes: MANAGED_FFMPEG_DOWNLOAD_BYTES,
            sha256: MANAGED_FFMPEG_SHA256.to_string(),
            estimated_installed_bytes: MANAGED_FFMPEG_INSTALLED_BYTES,
            license_name: MANAGED_FFMPEG_LICENSE_NAME.to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaToolsMode {
    Auto,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaToolsSource {
    Managed,
    SystemPath,
    Custom,
    Missing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaToolsConfigFile {
    mode: MediaToolsMode,
    custom_dir: Option<String>,
}

impl Default for MediaToolsConfigFile {
    fn default() -> Self {
        Self {
            mode: MediaToolsMode::Auto,
            custom_dir: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaToolsStatus {
    pub ready: bool,
    pub source: MediaToolsSource,
    pub mode: MediaToolsMode,
    pub custom_dir: Option<String>,
    pub ffmpeg_path: Option<String>,
    pub ffprobe_path: Option<String>,
    pub ffmpeg_version: Option<String>,
    pub ffprobe_version: Option<String>,
    pub install_dir: String,
    pub managed_installed_bytes: Option<u64>,
    pub license_path: Option<String>,
    pub error: Option<String>,
    pub spec: ManagedFfmpegSpec,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSetupProgressPayload {
    pub task_id: String,
    pub phase: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percent: Option<f64>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaTaskProgressPayload {
    pub task_id: String,
    pub tool_id: String,
    pub phase: String,
    pub current_item: usize,
    pub total_items: usize,
    pub item_name: Option<String>,
    pub percent: Option<f64>,
    pub out_time_sec: Option<f64>,
    pub total_duration_sec: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct ResolvedMediaTools {
    pub source: MediaToolsSource,
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    pub ffmpeg_version: String,
    pub ffprobe_version: String,
}

/// Resolves WinKit's local data root for media tools.
/// When `WEBVIEW2_USER_DATA_FOLDER` is set (isolated test profile), keeps managed tools and
/// config completely inside that isolated directory so the user's daily profile is never touched.
pub fn resolve_media_data_root(app_local_data_dir: Option<&Path>) -> PathBuf {
    if let Ok(isolated) = std::env::var("WEBVIEW2_USER_DATA_FOLDER") {
        let trimmed = isolated.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed).join("media-tools");
        }
    }
    if let Some(dir) = app_local_data_dir {
        return dir.join("media-tools");
    }
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        return PathBuf::from(local_app_data)
            .join("com.luckylivio.winkit")
            .join("media-tools");
    }
    std::env::temp_dir().join("winkit-media-tools")
}

pub fn managed_ffmpeg_install_dir(media_root: &Path) -> PathBuf {
    media_root.join(MANAGED_FFMPEG_DIR_NAME)
}

fn config_file_path(media_root: &Path) -> PathBuf {
    media_root.join("config.json")
}

fn load_config(media_root: &Path) -> MediaToolsConfigFile {
    let path = config_file_path(media_root);
    let Ok(text) = fs::read_to_string(path) else {
        return MediaToolsConfigFile::default();
    };
    serde_json::from_str::<MediaToolsConfigFile>(&text).unwrap_or_default()
}

fn save_config(media_root: &Path, cfg: &MediaToolsConfigFile) -> Result<(), AppError> {
    fs::create_dir_all(media_root)
        .map_err(|e| AppError::from_io(e, "Unable to create media tools config directory"))?;
    let path = config_file_path(media_root);
    let tmp = media_root.join(format!("config-{}.tmp", Uuid::new_v4()));
    let json = serde_json::to_string_pretty(cfg)
        .map_err(|e| AppError::new("INTERNAL_ERROR", format!("Failed to serialize config: {e}")))?;
    fs::write(&tmp, json.as_bytes())
        .map_err(|e| AppError::from_io(e, "Unable to write media tools config"))?;
    if path.exists() {
        let _ = fs::remove_file(&path);
    }
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        AppError::from_io(e, "Unable to save media tools config")
    })?;
    Ok(())
}

pub fn configure_hidden_command(cmd: &mut Command) {
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

fn probe_binary_version(exe: &Path, expected_prefix: &str) -> Result<String, String> {
    if !exe.is_file() {
        return Err(format!("Executable not found: {}", exe.display()));
    }
    let mut cmd = Command::new(exe);
    cmd.arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_hidden_command(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start {}: {e}", exe.display()))?;

    let deadline = Instant::now() + Duration::from_millis(PROBE_TIMEOUT_MS);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = String::new();
                if let Some(mut out) = child.stdout.take() {
                    let _ = out.read_to_string(&mut stdout);
                }
                if !status.success() {
                    return Err(format!(
                        "{} exited with status {:?}",
                        exe.display(),
                        status.code()
                    ));
                }
                let first_line = stdout.lines().next().unwrap_or("").trim().to_string();
                if first_line.is_empty()
                    || !first_line
                        .to_ascii_lowercase()
                        .starts_with(&expected_prefix.to_ascii_lowercase())
                {
                    return Err(format!(
                        "Unexpected version output from {}: {first_line}",
                        exe.display()
                    ));
                }
                return Ok(first_line);
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("Timed out verifying {}", exe.display()));
                }
                thread::sleep(Duration::from_millis(25));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Error waiting for {}: {e}", exe.display()));
            }
        }
    }
}

fn find_pair_in_dir(dir: &Path) -> Option<(PathBuf, PathBuf)> {
    let exe_ext = if cfg!(windows) { ".exe" } else { "" };
    let ff_name = format!("ffmpeg{exe_ext}");
    let fp_name = format!("ffprobe{exe_ext}");

    let direct_ff = dir.join(&ff_name);
    let direct_fp = dir.join(&fp_name);
    if direct_ff.is_file() && direct_fp.is_file() {
        return Some((direct_ff, direct_fp));
    }

    let bin_ff = dir.join("bin").join(&ff_name);
    let bin_fp = dir.join("bin").join(&fp_name);
    if bin_ff.is_file() && bin_fp.is_file() {
        return Some((bin_ff, bin_fp));
    }

    None
}

fn verify_tool_pair(
    ffmpeg: &Path,
    ffprobe: &Path,
    source: MediaToolsSource,
) -> Result<ResolvedMediaTools, String> {
    let ff_ver = probe_binary_version(ffmpeg, "ffmpeg version")?;
    let fp_ver = probe_binary_version(ffprobe, "ffprobe version")?;
    Ok(ResolvedMediaTools {
        source,
        ffmpeg: ffmpeg.to_path_buf(),
        ffprobe: ffprobe.to_path_buf(),
        ffmpeg_version: ff_ver,
        ffprobe_version: fp_ver,
    })
}

fn find_pair_in_system_path() -> Option<(PathBuf, PathBuf)> {
    let path_var = std::env::var_os("PATH")?;
    let exe_ext = if cfg!(windows) { ".exe" } else { "" };
    let ff_name = format!("ffmpeg{exe_ext}");
    let fp_name = format!("ffprobe{exe_ext}");

    let mut first_ff: Option<PathBuf> = None;
    let mut first_fp: Option<PathBuf> = None;

    for dir in std::env::split_paths(&path_var) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let ff = dir.join(&ff_name);
        let fp = dir.join(&fp_name);
        if ff.is_file() && fp.is_file() {
            return Some((ff, fp));
        }
        if first_ff.is_none() && ff.is_file() {
            first_ff = Some(ff);
        }
        if first_fp.is_none() && fp.is_file() {
            first_fp = Some(fp);
        }
    }

    match (first_ff, first_fp) {
        (Some(ff), Some(fp)) => Some((ff, fp)),
        _ => None,
    }
}

fn compute_dir_size_bytes(dir: &Path) -> Option<u64> {
    if !dir.is_dir() {
        return None;
    }
    let mut total: u64 = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(cur) = stack.pop() {
        let Ok(entries) = fs::read_dir(&cur) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if let Ok(meta) = entry.metadata() {
                total = total.saturating_add(meta.len());
            }
        }
    }
    Some(total)
}

pub fn get_media_tools_status_impl(media_root: &Path) -> MediaToolsStatus {
    let cfg = load_config(media_root);
    let install_dir = managed_ffmpeg_install_dir(media_root);
    let install_dir_str = install_dir.to_string_lossy().to_string();
    let managed_bytes = compute_dir_size_bytes(&install_dir);
    let license_file = install_dir.join("LICENSE");
    let license_path = if license_file.is_file() {
        Some(license_file.to_string_lossy().to_string())
    } else {
        None
    };

    let spec = ManagedFfmpegSpec::pinned();

    if cfg.mode == MediaToolsMode::Custom {
        if let Some(ref custom) = cfg.custom_dir {
            let dir = PathBuf::from(custom);
            if let Some((ff, fp)) = find_pair_in_dir(&dir) {
                match verify_tool_pair(&ff, &fp, MediaToolsSource::Custom) {
                    Ok(resolved) => {
                        return MediaToolsStatus {
                            ready: true,
                            source: resolved.source,
                            mode: MediaToolsMode::Custom,
                            custom_dir: cfg.custom_dir,
                            ffmpeg_path: Some(resolved.ffmpeg.to_string_lossy().to_string()),
                            ffprobe_path: Some(resolved.ffprobe.to_string_lossy().to_string()),
                            ffmpeg_version: Some(resolved.ffmpeg_version),
                            ffprobe_version: Some(resolved.ffprobe_version),
                            install_dir: install_dir_str,
                            managed_installed_bytes: managed_bytes,
                            license_path,
                            error: None,
                            spec,
                        };
                    }
                    Err(err) => {
                        return MediaToolsStatus {
                            ready: false,
                            source: MediaToolsSource::Missing,
                            mode: MediaToolsMode::Custom,
                            custom_dir: cfg.custom_dir,
                            ffmpeg_path: None,
                            ffprobe_path: None,
                            ffmpeg_version: None,
                            ffprobe_version: None,
                            install_dir: install_dir_str,
                            managed_installed_bytes: managed_bytes,
                            license_path,
                            error: Some(err),
                            spec,
                        };
                    }
                }
            }
            return MediaToolsStatus {
                ready: false,
                source: MediaToolsSource::Missing,
                mode: MediaToolsMode::Custom,
                custom_dir: cfg.custom_dir,
                ffmpeg_path: None,
                ffprobe_path: None,
                ffmpeg_version: None,
                ffprobe_version: None,
                install_dir: install_dir_str,
                managed_installed_bytes: managed_bytes,
                license_path,
                error: Some(
                    "Selected directory does not contain both ffmpeg.exe and ffprobe.exe.".into(),
                ),
                spec,
            };
        }
    }

    // Auto discovery: 1) WinKit managed install, 2) system PATH
    if let Some((ff, fp)) = find_pair_in_dir(&install_dir) {
        if let Ok(resolved) = verify_tool_pair(&ff, &fp, MediaToolsSource::Managed) {
            return MediaToolsStatus {
                ready: true,
                source: MediaToolsSource::Managed,
                mode: MediaToolsMode::Auto,
                custom_dir: cfg.custom_dir,
                ffmpeg_path: Some(resolved.ffmpeg.to_string_lossy().to_string()),
                ffprobe_path: Some(resolved.ffprobe.to_string_lossy().to_string()),
                ffmpeg_version: Some(resolved.ffmpeg_version),
                ffprobe_version: Some(resolved.ffprobe_version),
                install_dir: install_dir_str,
                managed_installed_bytes: managed_bytes,
                license_path,
                error: None,
                spec,
            };
        }
    }

    if let Some((ff, fp)) = find_pair_in_system_path() {
        if let Ok(resolved) = verify_tool_pair(&ff, &fp, MediaToolsSource::SystemPath) {
            return MediaToolsStatus {
                ready: true,
                source: MediaToolsSource::SystemPath,
                mode: MediaToolsMode::Auto,
                custom_dir: cfg.custom_dir,
                ffmpeg_path: Some(resolved.ffmpeg.to_string_lossy().to_string()),
                ffprobe_path: Some(resolved.ffprobe.to_string_lossy().to_string()),
                ffmpeg_version: Some(resolved.ffmpeg_version),
                ffprobe_version: Some(resolved.ffprobe_version),
                install_dir: install_dir_str,
                managed_installed_bytes: managed_bytes,
                license_path,
                error: None,
                spec,
            };
        }
    }

    MediaToolsStatus {
        ready: false,
        source: MediaToolsSource::Missing,
        mode: MediaToolsMode::Auto,
        custom_dir: cfg.custom_dir,
        ffmpeg_path: None,
        ffprobe_path: None,
        ffmpeg_version: None,
        ffprobe_version: None,
        install_dir: install_dir_str,
        managed_installed_bytes: managed_bytes,
        license_path,
        error: None,
        spec,
    }
}

pub fn require_media_tools(media_root: &Path) -> Result<ResolvedMediaTools, AppError> {
    let status = get_media_tools_status_impl(media_root);
    if !status.ready {
        return Err(AppError::new(
            "MEDIA_TOOLS_MISSING",
            status.error.unwrap_or_else(|| {
                "Local FFmpeg / ffprobe components are not configured yet. Configure them in the media setup panel first."
                    .to_string()
            }),
        ));
    }
    Ok(ResolvedMediaTools {
        source: status.source,
        ffmpeg: PathBuf::from(status.ffmpeg_path.unwrap_or_default()),
        ffprobe: PathBuf::from(status.ffprobe_path.unwrap_or_default()),
        ffmpeg_version: status.ffmpeg_version.unwrap_or_default(),
        ffprobe_version: status.ffprobe_version.unwrap_or_default(),
    })
}

pub fn set_media_tools_custom_dir_impl(
    media_root: &Path,
    dir: Option<String>,
) -> Result<MediaToolsStatus, AppError> {
    match dir {
        None => {
            save_config(
                media_root,
                &MediaToolsConfigFile {
                    mode: MediaToolsMode::Auto,
                    custom_dir: None,
                },
            )?;
            Ok(get_media_tools_status_impl(media_root))
        }
        Some(raw) => {
            let path = validate_user_path(&raw, "Media tools directory")?;
            if !path.is_dir() {
                return Err(AppError::invalid_param(
                    "Selected path is not an existing directory.",
                ));
            }
            let Some((ff, fp)) = find_pair_in_dir(&path) else {
                return Err(AppError::new(
                    "MEDIA_TOOLS_INVALID",
                    "Selected directory must contain both ffmpeg.exe and ffprobe.exe (directly or inside a bin subfolder).",
                ));
            };
            verify_tool_pair(&ff, &fp, MediaToolsSource::Custom).map_err(|e| {
                AppError::new(
                    "MEDIA_TOOLS_INVALID",
                    format!("FFmpeg / ffprobe verification failed in selected directory: {e}"),
                )
            })?;
            save_config(
                media_root,
                &MediaToolsConfigFile {
                    mode: MediaToolsMode::Custom,
                    custom_dir: Some(path.to_string_lossy().to_string()),
                },
            )?;
            Ok(get_media_tools_status_impl(media_root))
        }
    }
}

/// Extracts only `bin/ffmpeg.exe`, `bin/ffprobe.exe`, `LICENSE`, and `README.txt` from a
/// verified GyanD/codexffmpeg `.7z` archive into `dest_dir`, checking cancellation throughout.
pub fn extract_verified_ffmpeg_7z(
    archive_path: &Path,
    dest_dir: &Path,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(&str),
) -> Result<(), AppError> {
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }
    let bin_dir = dest_dir.join("bin");
    fs::create_dir_all(&bin_dir)
        .map_err(|e| AppError::from_io(e, "Unable to create media staging directory"))?;

    let mut reader = SevenZReader::open(archive_path, SevenZPassword::empty())
        .map_err(|e| AppError::decode_failed(format!("Cannot open FFmpeg 7z archive: {e}")))?;

    let mut got_ffmpeg = false;
    let mut got_ffprobe = false;
    let mut got_license = false;
    let mut captured_err: Option<AppError> = None;

    let iter_res = reader.for_each_entries(|entry, data_reader| {
        if cancel_flag.load(Ordering::Relaxed) {
            captured_err = Some(AppError::cancelled());
            return Ok(false);
        }
        if entry.is_directory() {
            return Ok(true);
        }
        let norm = entry.name().replace('\\', "/");
        let lower = norm.to_ascii_lowercase();

        let target: Option<PathBuf> =
            if lower.ends_with("/bin/ffmpeg.exe") || lower == "bin/ffmpeg.exe" {
                got_ffmpeg = true;
                on_progress("Extracting ffmpeg.exe...");
                Some(bin_dir.join("ffmpeg.exe"))
            } else if lower.ends_with("/bin/ffprobe.exe") || lower == "bin/ffprobe.exe" {
                got_ffprobe = true;
                on_progress("Extracting ffprobe.exe...");
                Some(bin_dir.join("ffprobe.exe"))
            } else if lower.ends_with("/license") || lower == "license" {
                got_license = true;
                Some(dest_dir.join("LICENSE"))
            } else if lower.ends_with("/readme.txt") || lower == "readme.txt" {
                Some(dest_dir.join("README.txt"))
            } else {
                None
            };

        let mut buf = [0u8; 64 * 1024];
        match target {
            Some(dest_file) => {
                let mut out = match File::create(&dest_file) {
                    Ok(f) => f,
                    Err(e) => {
                        captured_err =
                            Some(AppError::from_io(e, "Failed to create extracted file"));
                        return Ok(false);
                    }
                };
                loop {
                    if cancel_flag.load(Ordering::Relaxed) {
                        captured_err = Some(AppError::cancelled());
                        return Ok(false);
                    }
                    match data_reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            if let Err(e) = out.write_all(&buf[..n]) {
                                captured_err =
                                    Some(AppError::from_io(e, "Failed to write extracted file"));
                                return Ok(false);
                            }
                        }
                        Err(e) => {
                            captured_err = Some(AppError::decode_failed(format!(
                                "Failed reading FFmpeg archive entry: {e}"
                            )));
                            return Ok(false);
                        }
                    }
                }
                if let Err(e) = out.flush() {
                    captured_err = Some(AppError::from_io(e, "Failed to flush extracted file"));
                    return Ok(false);
                }
            }
            None => {
                // Drain skipped entry while staying responsive to cancellation
                loop {
                    if cancel_flag.load(Ordering::Relaxed) {
                        captured_err = Some(AppError::cancelled());
                        return Ok(false);
                    }
                    match data_reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(_) => {}
                        Err(e) => {
                            captured_err = Some(AppError::decode_failed(format!(
                                "Failed advancing FFmpeg archive stream: {e}"
                            )));
                            return Ok(false);
                        }
                    }
                }
            }
        }
        Ok(true)
    });

    if let Some(err) = captured_err {
        return Err(err);
    }
    if let Err(e) = iter_res {
        return Err(AppError::decode_failed(format!(
            "Failed extracting FFmpeg 7z archive: {e}"
        )));
    }
    if !got_ffmpeg || !got_ffprobe || !got_license {
        return Err(AppError::new(
            "MEDIA_TOOLS_INVALID",
            "Downloaded archive is missing required ffmpeg.exe, ffprobe.exe, or LICENSE files.",
        ));
    }
    Ok(())
}

/// User-initiated one-click download, SHA-256 verification, 7z extraction, binary validation,
/// and atomic installation of the pinned FFmpeg 9.1 Essentials build.
pub fn install_managed_media_tools_impl(
    task_id: &str,
    media_root: &Path,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(MediaSetupProgressPayload),
) -> Result<MediaToolsStatus, AppError> {
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }
    fs::create_dir_all(media_root)
        .map_err(|e| AppError::from_io(e, "Unable to create media tools directory"))?;

    let staging_dir = media_root.join(format!(".staging-{}", Uuid::new_v4()));
    fs::create_dir_all(&staging_dir)
        .map_err(|e| AppError::from_io(e, "Unable to create media tools staging folder"))?;

    let cleanup = |dir: &Path| {
        let _ = fs::remove_dir_all(dir);
    };

    let archive_tmp = staging_dir.join("ffmpeg-9.1-essentials_build.7z.tmp");
    let extract_dir = staging_dir.join("extracted");

    on_progress(MediaSetupProgressPayload {
        task_id: task_id.to_string(),
        phase: "downloading".into(),
        downloaded_bytes: 0,
        total_bytes: MANAGED_FFMPEG_DOWNLOAD_BYTES,
        percent: Some(0.0),
        message: "Connecting to GitHub Release (GyanD/codexffmpeg 9.1)...".into(),
    });

    let dl_result = download_https_with_sha256(
        MANAGED_FFMPEG_DOWNLOAD_URL,
        &archive_tmp,
        MANAGED_FFMPEG_DOWNLOAD_BYTES,
        cancel_flag,
        |downloaded, total| {
            let denom = if total > 0 {
                total
            } else {
                MANAGED_FFMPEG_DOWNLOAD_BYTES
            };
            let pct = ((downloaded as f64 / denom as f64) * 75.0).clamp(0.0, 75.0);
            on_progress(MediaSetupProgressPayload {
                task_id: task_id.to_string(),
                phase: "downloading".into(),
                downloaded_bytes: downloaded,
                total_bytes: denom,
                percent: Some(pct),
                message: format!(
                    "Downloading FFmpeg 9.1 ({:.1} / {:.1} MiB)...",
                    downloaded as f64 / (1024.0 * 1024.0),
                    denom as f64 / (1024.0 * 1024.0)
                ),
            });
        },
    );

    let (actual_bytes, actual_sha256) = match dl_result {
        Ok(v) => v,
        Err(e) => {
            cleanup(&staging_dir);
            return Err(e);
        }
    };

    on_progress(MediaSetupProgressPayload {
        task_id: task_id.to_string(),
        phase: "verifying".into(),
        downloaded_bytes: actual_bytes,
        total_bytes: MANAGED_FFMPEG_DOWNLOAD_BYTES,
        percent: Some(78.0),
        message: "Verifying SHA-256 digest...".into(),
    });

    if actual_bytes != MANAGED_FFMPEG_DOWNLOAD_BYTES
        || !actual_sha256.eq_ignore_ascii_case(MANAGED_FFMPEG_SHA256)
    {
        cleanup(&staging_dir);
        return Err(AppError::new(
            "CHECKSUM_MISMATCH",
            format!(
                "Downloaded FFmpeg package failed integrity verification (expected {} bytes / {}, got {} bytes / {}).",
                MANAGED_FFMPEG_DOWNLOAD_BYTES, MANAGED_FFMPEG_SHA256, actual_bytes, actual_sha256
            ),
        ));
    }

    on_progress(MediaSetupProgressPayload {
        task_id: task_id.to_string(),
        phase: "extracting".into(),
        downloaded_bytes: actual_bytes,
        total_bytes: MANAGED_FFMPEG_DOWNLOAD_BYTES,
        percent: Some(82.0),
        message: "Extracting ffmpeg.exe, ffprobe.exe, and LICENSE...".into(),
    });

    if let Err(e) = extract_verified_ffmpeg_7z(&archive_tmp, &extract_dir, cancel_flag, |msg| {
        on_progress(MediaSetupProgressPayload {
            task_id: task_id.to_string(),
            phase: "extracting".into(),
            downloaded_bytes: actual_bytes,
            total_bytes: MANAGED_FFMPEG_DOWNLOAD_BYTES,
            percent: Some(88.0),
            message: msg.to_string(),
        });
    }) {
        cleanup(&staging_dir);
        return Err(e);
    }

    // Archive no longer needed once extracted
    let _ = fs::remove_file(&archive_tmp);

    on_progress(MediaSetupProgressPayload {
        task_id: task_id.to_string(),
        phase: "testing".into(),
        downloaded_bytes: actual_bytes,
        total_bytes: MANAGED_FFMPEG_DOWNLOAD_BYTES,
        percent: Some(94.0),
        message: "Verifying ffmpeg.exe and ffprobe.exe...".into(),
    });

    let staged_ff = extract_dir.join("bin").join("ffmpeg.exe");
    let staged_fp = extract_dir.join("bin").join("ffprobe.exe");
    if let Err(e) = verify_tool_pair(&staged_ff, &staged_fp, MediaToolsSource::Managed) {
        cleanup(&staging_dir);
        return Err(AppError::new(
            "MEDIA_TOOLS_INVALID",
            format!("Extracted FFmpeg/ffprobe failed self-check: {e}"),
        ));
    }

    if cancel_flag.load(Ordering::Relaxed) {
        cleanup(&staging_dir);
        return Err(AppError::cancelled());
    }

    let final_dir = managed_ffmpeg_install_dir(media_root);
    let backup_dir = media_root.join(format!(".backup-{}", Uuid::new_v4()));
    let had_existing = final_dir.exists();
    if had_existing {
        if let Err(e) = fs::rename(&final_dir, &backup_dir) {
            cleanup(&staging_dir);
            return Err(AppError::from_io(
                e,
                "Unable to replace existing FFmpeg installation directory",
            ));
        }
    }

    if let Err(e) = fs::rename(&extract_dir, &final_dir) {
        if had_existing {
            let _ = fs::rename(&backup_dir, &final_dir);
        }
        cleanup(&staging_dir);
        return Err(AppError::from_io(
            e,
            "Unable to finalize FFmpeg installation directory",
        ));
    }

    if had_existing {
        let _ = fs::remove_dir_all(&backup_dir);
    }
    cleanup(&staging_dir);

    // Ensure Auto mode is active so the newly installed managed build is enabled immediately
    save_config(
        media_root,
        &MediaToolsConfigFile {
            mode: MediaToolsMode::Auto,
            custom_dir: None,
        },
    )?;

    let status = get_media_tools_status_impl(media_root);
    on_progress(MediaSetupProgressPayload {
        task_id: task_id.to_string(),
        phase: "completed".into(),
        downloaded_bytes: actual_bytes,
        total_bytes: MANAGED_FFMPEG_DOWNLOAD_BYTES,
        percent: Some(100.0),
        message: "FFmpeg 9.1 and ffprobe 9.1 verified and ready.".into(),
    });
    Ok(status)
}

#[cfg(windows)]
fn download_https_with_sha256(
    url: &str,
    dest_path: &Path,
    expected_bytes: u64,
    cancel_flag: &AtomicBool,
    mut on_chunk: impl FnMut(u64, u64),
) -> Result<(u64, String), AppError> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Networking::WinHttp::{
        WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest,
        WinHttpQueryDataAvailable, WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse,
        WinHttpSendRequest, WinHttpSetOption, WinHttpSetTimeouts,
        WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_FLAG_SECURE, WINHTTP_OPTION_REDIRECT_POLICY,
        WINHTTP_OPTION_REDIRECT_POLICY_DISALLOW_HTTPS_TO_HTTP, WINHTTP_QUERY_CONTENT_LENGTH,
        WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE,
    };

    struct WinHttpHandle(*mut core::ffi::c_void);
    impl Drop for WinHttpHandle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    let _ = WinHttpCloseHandle(self.0);
                }
            }
        }
    }

    fn to_wide(s: &str) -> Vec<u16> {
        OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let rest = url
        .strip_prefix("https://")
        .ok_or_else(|| AppError::invalid_param("Only HTTPS download URLs are supported."))?;
    let (host, path) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, "/"),
    };

    let ua = to_wide("WinKit/0.13.0");
    let host_w = to_wide(host);
    let path_w = to_wide(path);
    let method_w = to_wide("GET");

    let session = unsafe {
        WinHttpOpen(
            PCWSTR(ua.as_ptr()),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            PCWSTR::null(),
            PCWSTR::null(),
            0,
        )
    };
    if session.is_null() {
        return Err(AppError::new(
            "DOWNLOAD_FAILED",
            "Unable to initialize Windows HTTP client.",
        ));
    }
    let _session_guard = WinHttpHandle(session);

    unsafe {
        let _ = WinHttpSetTimeouts(session, 15_000, 15_000, 30_000, 60_000);
    }

    let connect = unsafe { WinHttpConnect(session, PCWSTR(host_w.as_ptr()), 443, 0) };
    if connect.is_null() {
        return Err(AppError::new(
            "DOWNLOAD_FAILED",
            format!("Unable to connect to {host}. Check your network connection."),
        ));
    }
    let _connect_guard = WinHttpHandle(connect);

    let request = unsafe {
        WinHttpOpenRequest(
            connect,
            PCWSTR(method_w.as_ptr()),
            PCWSTR(path_w.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            std::ptr::null(),
            WINHTTP_FLAG_SECURE,
        )
    };
    if request.is_null() {
        return Err(AppError::new(
            "DOWNLOAD_FAILED",
            "Unable to open HTTPS download request.",
        ));
    }
    let _request_guard = WinHttpHandle(request);

    let redirect_policy: u32 = WINHTTP_OPTION_REDIRECT_POLICY_DISALLOW_HTTPS_TO_HTTP;
    let redirect_bytes = redirect_policy.to_ne_bytes();
    unsafe {
        let _ = WinHttpSetOption(
            Some(request),
            WINHTTP_OPTION_REDIRECT_POLICY,
            Some(&redirect_bytes),
        );
    }

    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    unsafe {
        WinHttpSendRequest(request, None, None, 0, 0, 0).map_err(|e| {
            AppError::new(
                "DOWNLOAD_FAILED",
                format!("Network request failed (offline or blocked): {e}"),
            )
        })?;
        WinHttpReceiveResponse(request, std::ptr::null_mut()).map_err(|e| {
            AppError::new(
                "DOWNLOAD_FAILED",
                format!("Failed waiting for server response: {e}"),
            )
        })?;
    }

    let mut status_code: u32 = 0;
    let mut status_len = std::mem::size_of::<u32>() as u32;
    unsafe {
        WinHttpQueryHeaders(
            request,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            PCWSTR::null(),
            Some(&mut status_code as *mut u32 as *mut core::ffi::c_void),
            &mut status_len,
            std::ptr::null_mut(),
        )
        .map_err(|e| {
            AppError::new(
                "DOWNLOAD_FAILED",
                format!("Unable to inspect HTTP response status: {e}"),
            )
        })?;
    }
    if status_code != 200 {
        return Err(AppError::new(
            "DOWNLOAD_FAILED",
            format!("Server returned HTTP {status_code} while downloading FFmpeg."),
        ));
    }

    let mut content_len_u32: u32 = 0;
    let mut cl_len = std::mem::size_of::<u32>() as u32;
    let total_bytes = unsafe {
        if WinHttpQueryHeaders(
            request,
            WINHTTP_QUERY_CONTENT_LENGTH | WINHTTP_QUERY_FLAG_NUMBER,
            PCWSTR::null(),
            Some(&mut content_len_u32 as *mut u32 as *mut core::ffi::c_void),
            &mut cl_len,
            std::ptr::null_mut(),
        )
        .is_ok()
            && content_len_u32 > 0
        {
            u64::from(content_len_u32)
        } else {
            expected_bytes
        }
    };

    let mut out_file = File::create(dest_path)
        .map_err(|e| AppError::from_io(e, "Unable to create temporary download file"))?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut buf = vec![0u8; 64 * 1024];

    loop {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(AppError::cancelled());
        }
        let mut avail: u32 = 0;
        unsafe {
            WinHttpQueryDataAvailable(request, &mut avail).map_err(|e| {
                AppError::new(
                    "DOWNLOAD_FAILED",
                    format!("Connection interrupted during download: {e}"),
                )
            })?;
        }
        if avail == 0 {
            break;
        }
        let to_read = (avail as usize).min(buf.len()) as u32;
        let mut read_bytes: u32 = 0;
        unsafe {
            WinHttpReadData(
                request,
                buf.as_mut_ptr() as *mut core::ffi::c_void,
                to_read,
                &mut read_bytes,
            )
            .map_err(|e| {
                AppError::new(
                    "DOWNLOAD_FAILED",
                    format!("Failed reading download stream: {e}"),
                )
            })?;
        }
        if read_bytes == 0 {
            break;
        }
        let slice = &buf[..read_bytes as usize];
        out_file
            .write_all(slice)
            .map_err(|e| AppError::from_io(e, "Failed writing downloaded FFmpeg archive"))?;
        hasher.update(slice);
        downloaded = downloaded.saturating_add(u64::from(read_bytes));
        if downloaded > expected_bytes.saturating_add(16 * 1024 * 1024) {
            return Err(AppError::new(
                "CHECKSUM_MISMATCH",
                "Downloaded payload exceeded expected FFmpeg package size.",
            ));
        }
        if last_emit.elapsed() >= Duration::from_millis(120) {
            last_emit = Instant::now();
            on_chunk(downloaded, total_bytes);
        }
    }

    out_file
        .flush()
        .map_err(|e| AppError::from_io(e, "Failed flushing downloaded FFmpeg archive"))?;
    on_chunk(downloaded, total_bytes);

    let digest = format!("{:x}", hasher.finalize());
    Ok((downloaded, digest))
}

#[cfg(not(windows))]
fn download_https_with_sha256(
    _url: &str,
    _dest_path: &Path,
    _expected_bytes: u64,
    _cancel_flag: &AtomicBool,
    _on_chunk: impl FnMut(u64, u64),
) -> Result<(u64, String), AppError> {
    Err(AppError::new(
        "DOWNLOAD_FAILED",
        "One-click FFmpeg download is implemented for Windows x64.",
    ))
}

/// Runs `ffprobe` and captures UTF-8 stdout cleanly without spawning a console window.
pub fn run_ffprobe_args(ffprobe: &Path, args: &[String]) -> Result<String, AppError> {
    let mut cmd = Command::new(ffprobe);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_hidden_command(&mut cmd);

    let output = cmd.output().map_err(|e| {
        AppError::new(
            "MEDIA_PROCESS_FAILED",
            format!("Failed to execute ffprobe: {e}"),
        )
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let brief = stderr
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("Unable to read media container or streams.")
            .to_string();
        return Err(AppError::decode_failed(brief));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Runs a single scoped `ffmpeg` child process with `-progress pipe:1 -nostats`.
/// On cancellation, terminates ONLY this exact child process and waits for handle release
/// so callers can immediately remove their `.tmp` output file without Windows lock errors.
pub fn run_ffmpeg_cancellable(
    ffmpeg: &Path,
    args: &[String],
    total_duration_sec: Option<f64>,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(Option<f64>, Option<f64>),
) -> Result<(), AppError> {
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-hide_banner")
        .arg("-y")
        .arg("-loglevel")
        .arg("error")
        .arg("-nostats")
        .arg("-progress")
        .arg("pipe:1")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_hidden_command(&mut cmd);

    let mut child: Child = cmd.spawn().map_err(|e| {
        AppError::new(
            "MEDIA_PROCESS_FAILED",
            format!("Failed to start ffmpeg: {e}"),
        )
    })?;

    let progress_state: Arc<Mutex<(Option<f64>, bool)>> = Arc::new(Mutex::new((None, false)));
    let stdout_handle = child.stdout.take().map(|out| {
        let st = Arc::clone(&progress_state);
        thread::spawn(move || {
            let reader = BufReader::new(out);
            for line in reader.lines().map_while(Result::ok) {
                if let Some(val) = line.strip_prefix("out_time_us=") {
                    if let Ok(us) = val.trim().parse::<i64>() {
                        if us >= 0 {
                            if let Ok(mut g) = st.lock() {
                                g.0 = Some(us as f64 / 1_000_000.0);
                            }
                        }
                    }
                } else if let Some(val) = line.strip_prefix("out_time_ms=") {
                    // FFmpeg reports microseconds even in out_time_ms in many builds
                    if let Ok(us) = val.trim().parse::<i64>() {
                        if us >= 0 {
                            if let Ok(mut g) = st.lock() {
                                g.0 = Some(us as f64 / 1_000_000.0);
                            }
                        }
                    }
                } else if line.trim() == "progress=end" {
                    if let Ok(mut g) = st.lock() {
                        g.1 = true;
                    }
                }
            }
        })
    });

    let stderr_handle = child.stderr.take().map(|err| {
        thread::spawn(move || {
            let mut s = String::new();
            let mut r = err;
            let _ = r.read_to_string(&mut s);
            s
        })
    });

    let mut last_emit = Instant::now() - Duration::from_secs(1);

    let exit_status = loop {
        if cancel_flag.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            if let Some(h) = stdout_handle {
                let _ = h.join();
            }
            if let Some(h) = stderr_handle {
                let _ = h.join();
            }
            return Err(AppError::cancelled());
        }

        if last_emit.elapsed() >= Duration::from_millis(120) {
            last_emit = Instant::now();
            if let Ok(g) = progress_state.lock() {
                if let Some(out_sec) = g.0 {
                    let pct = total_duration_sec.and_then(|dur| {
                        if dur > 0.0 {
                            Some(((out_sec / dur) * 100.0).clamp(0.0, 99.0))
                        } else {
                            None
                        }
                    });
                    on_progress(Some(out_sec), pct);
                }
            }
        }

        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                if let Some(h) = stdout_handle {
                    let _ = h.join();
                }
                if let Some(h) = stderr_handle {
                    let _ = h.join();
                }
                return Err(AppError::new(
                    "MEDIA_PROCESS_FAILED",
                    format!("Error monitoring ffmpeg process: {e}"),
                ));
            }
        }
    };

    if let Some(h) = stdout_handle {
        let _ = h.join();
    }
    let stderr_text = stderr_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();

    if cancel_flag.load(Ordering::Relaxed) {
        return Err(AppError::cancelled());
    }

    if !exit_status.success() {
        let detail = stderr_text
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("FFmpeg returned an error while processing media.")
            .to_string();
        return Err(AppError::decode_failed(detail));
    }

    on_progress(total_duration_sec, Some(100.0));
    Ok(())
}

/// Generates a non-colliding output path inside `output_dir` that never overwrites
/// existing files or `source_path`.
pub fn allocate_non_colliding_output_path(
    output_dir: &Path,
    stem: &str,
    suffix: &str,
    ext_no_dot: &str,
    source_path: &Path,
) -> Result<PathBuf, AppError> {
    if !output_dir.is_dir() {
        fs::create_dir_all(output_dir)
            .map_err(|e| AppError::from_io(e, "Unable to create output directory"))?;
    }
    let clean_stem = sanitize_filename_component(stem);
    let clean_ext = ext_no_dot.trim_start_matches('.').to_ascii_lowercase();
    let base_name = if suffix.is_empty() {
        clean_stem.clone()
    } else {
        format!("{clean_stem}{suffix}")
    };

    for idx in 1..=9_999u32 {
        let filename = if idx == 1 {
            format!("{base_name}.{clean_ext}")
        } else {
            format!("{base_name} ({idx}).{clean_ext}")
        };
        let candidate = output_dir.join(filename);
        if !candidate.exists() && !paths_refer_to_same_location(source_path, &candidate) {
            return Ok(candidate);
        }
    }
    Err(AppError::new(
        "TARGET_ALREADY_EXISTS",
        "Too many conflicting output filenames in the target directory.",
    ))
}

fn sanitize_filename_component(raw: &str) -> String {
    let invalid = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if invalid.contains(&c) || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.');
    if trimmed.is_empty() {
        "output".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Guards a temporary output path in the target directory (preserving `.ext` so FFmpeg picks
/// the right muxer), automatically deleting it on Drop unless `commit()` succeeds.
pub struct AtomicMediaOutput {
    tmp_path: PathBuf,
    final_path: PathBuf,
    committed: bool,
}

impl AtomicMediaOutput {
    pub fn prepare(
        final_path: PathBuf,
        source_path: &Path,
        allow_overwrite: bool,
    ) -> Result<Self, AppError> {
        if final_path.is_dir() {
            return Err(AppError::new(
                "IS_DIRECTORY",
                "Output path points to a directory.",
            ));
        }
        if paths_refer_to_same_location(source_path, &final_path) {
            return Err(AppError::same_input_output());
        }
        if !allow_overwrite && final_path.exists() {
            return Err(AppError::target_exists());
        }
        let parent = final_path
            .parent()
            .ok_or_else(|| AppError::invalid_param("Output path has no parent directory."))?;
        if !parent.is_dir() {
            fs::create_dir_all(parent)
                .map_err(|e| AppError::from_io(e, "Unable to create output directory"))?;
        }
        let ext = final_path
            .extension()
            .and_then(|e| e.to_str())
            .filter(|e| !e.is_empty())
            .unwrap_or("bin");
        let tmp_name = format!(".winkit-tmp-{}.{ext}", Uuid::new_v4());
        let tmp_path = parent.join(tmp_name);
        Ok(Self {
            tmp_path,
            final_path,
            committed: false,
        })
    }

    pub fn temp_path(&self) -> &Path {
        &self.tmp_path
    }

    pub fn final_path(&self) -> &Path {
        &self.final_path
    }

    pub fn commit(mut self, allow_overwrite: bool) -> Result<(PathBuf, u64), AppError> {
        let meta = fs::metadata(&self.tmp_path)
            .map_err(|e| AppError::from_io(e, "Expected FFmpeg output file was not created"))?;
        if meta.len() == 0 {
            return Err(AppError::decode_failed(
                "FFmpeg produced an empty output file.",
            ));
        }

        if !allow_overwrite && self.final_path.exists() {
            return Err(AppError::target_exists());
        }

        if allow_overwrite && self.final_path.exists() {
            fs::remove_file(&self.final_path)
                .map_err(|e| AppError::from_io(e, "Unable to replace existing target file"))?;
        }

        fs::rename(&self.tmp_path, &self.final_path)
            .map_err(|e| AppError::from_io(e, "Unable to finalize media output file"))?;
        self.committed = true;
        Ok((self.final_path.clone(), meta.len()))
    }
}

impl Drop for AtomicMediaOutput {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_file(&self.tmp_path);
        }
    }
}

/// Allow-listed local media preview registry powering the `winkitmedia` custom URI scheme
/// protocol with full HTTP Range streaming (`206 Partial Content`) and zero broad disk access.
#[derive(Clone, Default)]
pub struct MediaPreviewRegistry {
    inner: Arc<Mutex<PreviewRegistryInner>>,
}

#[derive(Default)]
struct PreviewRegistryInner {
    by_token: HashMap<String, PathBuf>,
    by_path: HashMap<PathBuf, String>,
    order: VecDeque<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaPreviewRegistration {
    pub token: String,
    pub url: String,
    pub mime_type: String,
    pub file_name: String,
    pub byte_length: u64,
}

impl MediaPreviewRegistry {
    pub fn register_path(&self, raw_path: &str) -> Result<MediaPreviewRegistration, AppError> {
        let (path, byte_length) = validate_existing_input_file(raw_path)?;
        let canon = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("media")
            .to_string();
        let mime_type = guess_media_mime_type(&path).to_string();

        let mut inner = self
            .inner
            .lock()
            .expect("media preview registry mutex poisoned");

        let token = if let Some(existing) = inner.by_path.get(&canon) {
            existing.clone()
        } else {
            let tok = Uuid::new_v4().to_string();
            inner.by_token.insert(tok.clone(), canon.clone());
            inner.by_path.insert(canon, tok.clone());
            inner.order.push_back(tok.clone());
            while inner.order.len() > MAX_PREVIEW_REGISTRY_ENTRIES {
                if let Some(old_tok) = inner.order.pop_front() {
                    if let Some(old_path) = inner.by_token.remove(&old_tok) {
                        inner.by_path.remove(&old_path);
                    }
                }
            }
            tok
        };

        let url = build_media_preview_url(&token);
        Ok(MediaPreviewRegistration {
            token,
            url,
            mime_type,
            file_name,
            byte_length,
        })
    }

    pub fn lookup(&self, token: &str) -> Option<PathBuf> {
        let inner = self
            .inner
            .lock()
            .expect("media preview registry mutex poisoned");
        inner.by_token.get(token).cloned()
    }
}

pub fn build_media_preview_url(token: &str) -> String {
    #[cfg(windows)]
    {
        format!("http://winkitmedia.localhost/{token}")
    }
    #[cfg(not(windows))]
    {
        format!("winkitmedia://localhost/{token}")
    }
}

pub fn guess_media_mime_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "ts" | "m2ts" => "video/mp2t",
        "m4a" | "aac" => "audio/mp4",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "aif" | "aiff" => "audio/aiff",
        "ogg" | "opus" => "audio/ogg",
        "gif" => "image/gif",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "heic" | "heif" => "image/heic",
        _ => "application/octet-stream",
    }
}

pub fn parse_byte_range(range_header: &str, file_len: u64) -> Option<(u64, u64)> {
    if file_len == 0 {
        return None;
    }
    let spec = range_header.trim().strip_prefix("bytes=")?;
    let first = spec.split(',').next()?.trim();
    let (start_s, end_s) = first.split_once('-')?;

    if start_s.is_empty() {
        let suffix: u64 = end_s.trim().parse().ok()?;
        if suffix == 0 {
            return None;
        }
        let start = file_len.saturating_sub(suffix);
        return Some((start, file_len - 1));
    }

    let start: u64 = start_s.trim().parse().ok()?;
    if start >= file_len {
        return None;
    }
    let end = if end_s.trim().is_empty() {
        (start.saturating_add(STREAM_CHUNK_BYTES - 1)).min(file_len - 1)
    } else {
        let requested_end: u64 = end_s.trim().parse().ok()?;
        if requested_end < start {
            return None;
        }
        requested_end
            .min(file_len - 1)
            .min(start.saturating_add(STREAM_CHUNK_BYTES - 1))
    };
    Some((start, end))
}

/// Handles `winkitmedia` protocol requests with strict token lookup & RFC 7233 byte ranges.
pub fn handle_winkit_media_protocol(
    registry: &MediaPreviewRegistry,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};

    let raw_path = request.uri().path().trim_start_matches('/');
    let token = raw_path.split('/').next().unwrap_or("");
    let Some(file_path) = registry.lookup(token) else {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::CONTENT_TYPE, "text/plain")
            .body(b"Not found".to_vec())
            .unwrap();
    };

    let Ok(mut file) = File::open(&file_path) else {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::CONTENT_TYPE, "text/plain")
            .body(b"File unavailable".to_vec())
            .unwrap();
    };

    let Ok(meta) = file.metadata() else {
        return Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .body(Vec::new())
            .unwrap();
    };
    let file_len = meta.len();
    let mime = guess_media_mime_type(&file_path);

    if let Some(range_val) = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
    {
        if let Some((start, end)) = parse_byte_range(range_val, file_len) {
            let chunk_len = (end - start + 1) as usize;
            let mut buf = vec![0u8; chunk_len];
            if file.seek(SeekFrom::Start(start)).is_ok() && file.read_exact(&mut buf).is_ok() {
                return Response::builder()
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header(header::CONTENT_TYPE, mime)
                    .header(header::ACCEPT_RANGES, "bytes")
                    .header(header::CONTENT_LENGTH, chunk_len.to_string())
                    .header(
                        header::CONTENT_RANGE,
                        format!("bytes {start}-{end}/{file_len}"),
                    )
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .header(header::CACHE_CONTROL, "no-store")
                    .body(buf)
                    .unwrap();
            }
        }
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{file_len}"))
            .body(Vec::new())
            .unwrap();
    }

    // Non-range request (e.g., GIF / PNG thumbnail preview or small media file)
    let cap = file_len.min(64 * 1024 * 1024) as usize;
    let mut buf = vec![0u8; cap];
    let _ = file.read_exact(&mut buf);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, buf.len().to_string())
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "no-store")
        .body(buf)
        .unwrap()
}

/// Extracts a single JPEG preview poster frame via FFmpeg (auto-rotated upright, capped 960px wide)
/// and returns a base64 `data:image/jpeg;base64,...` URL for formats WebView2 cannot natively play.
pub fn extract_media_poster_data_url_impl(
    media_root: &Path,
    source_raw: &str,
    time_sec: Option<f64>,
) -> Result<String, AppError> {
    use base64::Engine;

    let (source_path, _) = validate_existing_input_file(source_raw)?;
    let tools = require_media_tools(media_root)?;
    let t = time_sec.unwrap_or(0.0).max(0.0);

    let mut cmd = Command::new(&tools.ffmpeg);
    cmd.arg("-hide_banner").arg("-loglevel").arg("error");
    if t > 0.0 {
        cmd.arg("-ss").arg(format!("{t:.3}"));
    }
    cmd.arg("-i")
        .arg(&source_path)
        .arg("-frames:v")
        .arg("1")
        .arg("-vf")
        .arg("scale='min(960,iw)':-2:flags=lanczos")
        .arg("-f")
        .arg("image2pipe")
        .arg("-vcodec")
        .arg("mjpeg")
        .arg("-q:v")
        .arg("5")
        .arg("pipe:1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_hidden_command(&mut cmd);

    let output = cmd.output().map_err(|e| {
        AppError::new(
            "MEDIA_PROCESS_FAILED",
            format!("Unable to extract preview frame: {e}"),
        )
    })?;
    if !output.status.success() || output.stdout.is_empty() {
        return Err(AppError::decode_failed(
            "Unable to decode a preview frame from this media file.",
        ));
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(&output.stdout);
    Ok(format!("data:image/jpeg;base64,{encoded}"))
}

/// Validates a custom output path chosen by Save dialog or generates a non-colliding path.
pub fn resolve_single_output_path(
    output_raw: &str,
    source_path: &Path,
) -> Result<PathBuf, AppError> {
    let out = validate_user_path(output_raw, "Output")?;
    if paths_refer_to_same_location(source_path, &out) {
        return Err(AppError::same_input_output());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn byte_range_parser_handles_open_closed_suffix_and_invalid_ranges() {
        assert_eq!(parse_byte_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_byte_range("bytes=0-", 1000), Some((0, 999)));
        // Open range on large file is capped to STREAM_CHUNK_BYTES
        assert_eq!(
            parse_byte_range("bytes=0-", 50 * 1024 * 1024),
            Some((0, STREAM_CHUNK_BYTES - 1))
        );
        assert_eq!(parse_byte_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_byte_range("bytes=1000-", 1000), None);
        assert_eq!(parse_byte_range("bytes=500-400", 1000), None);
        assert_eq!(parse_byte_range("items=0-10", 1000), None);
    }

    #[test]
    fn non_colliding_output_path_never_overwrites_existing_or_source() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("clip.mp4");
        fs::write(&src, b"source").unwrap();
        let existing = dir.path().join("clip_muted.mp4");
        fs::write(&existing, b"existing").unwrap();

        let p1 =
            allocate_non_colliding_output_path(dir.path(), "clip", "_muted", "mp4", &src).unwrap();
        assert_eq!(p1.file_name().unwrap(), "clip_muted (2).mp4");

        // Also prevents matching source when suffix is empty
        let p2 = allocate_non_colliding_output_path(dir.path(), "clip", "", "mp4", &src).unwrap();
        assert_eq!(p2.file_name().unwrap(), "clip (2).mp4");
    }

    #[test]
    fn atomic_media_output_deletes_temp_file_on_drop_and_blocks_source_overwrite() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("src.mp4");
        fs::write(&src, b"video").unwrap();

        assert!(AtomicMediaOutput::prepare(src.clone(), &src, true).is_err());

        let dst = dir.path().join("dst.mp4");
        let tmp_copy = {
            let guard = AtomicMediaOutput::prepare(dst.clone(), &src, false).unwrap();
            fs::write(guard.temp_path(), b"partial").unwrap();
            assert!(guard.temp_path().exists());
            guard.temp_path().to_path_buf()
        };
        assert!(!tmp_copy.exists());
        assert!(!dst.exists());
    }

    #[test]
    fn preview_registry_only_allows_explicitly_registered_tokens() {
        let dir = tempdir().unwrap();
        let f = dir.path().join("sample.mp4");
        fs::write(&f, b"0123456789").unwrap();

        let reg = MediaPreviewRegistry::default();
        assert!(reg.lookup("unknown-token").is_none());

        let info = reg.register_path(&f.to_string_lossy()).unwrap();
        assert_eq!(info.mime_type, "video/mp4");
        assert_eq!(info.byte_length, 10);
        assert!(reg.lookup(&info.token).is_some());
    }
}
