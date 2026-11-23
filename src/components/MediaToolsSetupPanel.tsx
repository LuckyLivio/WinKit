import { CheckCircle2, Download, FolderOpen, RefreshCw, Settings2, Wrench, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/I18nContext";
import {
  bindDisposableListener,
  cancelBackendTask,
  formatLocalizedError,
  getMediaToolsStatus,
  installManagedMediaTools,
  openLocalDirectory,
  pickSingleDirectory,
  setMediaToolsCustomDir,
  subscribeMediaSetupProgress,
  type MediaSetupProgressPayload,
  type MediaToolsStatus,
} from "../lib/tauriBridge";
import { formatMediaBytes } from "../tools/media-shared/mediaFormat";
import "../tools/media-shared/mediaWorkspace.css";

interface MediaToolsSetupPanelProps {
  mode?: "tool" | "settings";
  onStatusChange?: (status: MediaToolsStatus) => void;
}

export function MediaToolsSetupPanel({ mode = "tool", onStatusChange }: MediaToolsSetupPanelProps) {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";

  const [status, setStatus] = useState<MediaToolsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(mode === "settings");
  const [installing, setInstalling] = useState(false);
  const [installTaskId, setInstallTaskId] = useState<string | null>(null);
  const [progress, setProgress] = useState<MediaSetupProgressPayload | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    try {
      const next = await getMediaToolsStatus();
      setStatus(next);
      onStatusChangeRef.current?.(next);
    } catch (err) {
      setActionError(formatLocalizedError(err, t));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeMediaSetupProgress((payload) => {
          setProgress(payload);
        }),
      "winkit://media-setup-progress",
    );
  }, []);

  const handleInstallManaged = async () => {
    if (installing) return;
    const taskId = `media-setup-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setInstalling(true);
    setInstallTaskId(taskId);
    setActionError(null);
    setActionMessage(null);
    setProgress({
      taskId,
      phase: "downloading",
      downloadedBytes: 0,
      totalBytes: status?.spec.downloadBytes ?? 36_671_021,
      percent: 0,
      message: isZh ? "正在连接固定发布源并准备下载…" : "Connecting to pinned release...",
    });

    try {
      const next = await installManagedMediaTools(taskId);
      setStatus(next);
      onStatusChangeRef.current?.(next);
      setActionMessage(
        isZh
          ? "本地 FFmpeg 与 ffprobe 已校验通过并启用，后续可完全断网使用。"
          : "Local FFmpeg & ffprobe verified and enabled for offline use.",
      );
      if (mode === "tool") {
        setExpanded(false);
      }
    } catch (err) {
      setActionError(formatLocalizedError(err, t));
    } finally {
      setInstalling(false);
      setInstallTaskId(null);
    }
  };

  const handleCancelInstall = async () => {
    if (!installTaskId) return;
    await cancelBackendTask(installTaskId);
  };

  const handlePickLocalDir = async () => {
    setActionError(null);
    setActionMessage(null);
    try {
      const dir = await pickSingleDirectory({
        title: isZh
          ? "选择包含 ffmpeg.exe 与 ffprobe.exe 的目录"
          : "Select folder containing ffmpeg.exe & ffprobe.exe",
      });
      if (!dir) return;
      const next = await setMediaToolsCustomDir(dir);
      setStatus(next);
      onStatusChangeRef.current?.(next);
      setActionMessage(
        isZh
          ? "已验证并启用选定目录中的 FFmpeg / ffprobe。"
          : "Verified and enabled FFmpeg / ffprobe from selected folder.",
      );
    } catch (err) {
      setActionError(formatLocalizedError(err, t));
    }
  };

  const handleResetAuto = async () => {
    setActionError(null);
    setActionMessage(null);
    try {
      const next = await setMediaToolsCustomDir(null);
      setStatus(next);
      onStatusChangeRef.current?.(next);
      setActionMessage(
        isZh
          ? "已切换回自动发现模式（优先 WinKit 本地组件，其次系统 PATH）。"
          : "Switched back to automatic discovery (managed build, then system PATH).",
      );
    } catch (err) {
      setActionError(formatLocalizedError(err, t));
    }
  };

  if (loading && !status) {
    return (
      <div className="media-setup-compact" role="status">
        <span>
          {isZh
            ? "正在检查本地媒体组件（FFmpeg / ffprobe）…"
            : "Checking local media components (FFmpeg / ffprobe)..."}
        </span>
      </div>
    );
  }

  if (!status) {
    return null;
  }

  const sourceBadgeText = (() => {
    if (!status.ready) {
      return isZh ? "未配置媒体组件" : "Media components missing";
    }
    if (status.source === "managed") {
      return isZh
        ? "已就绪 · WinKit 本地组件（离线可用）"
        : "Ready · WinKit managed build (offline)";
    }
    if (status.source === "system_path") {
      return isZh ? "已就绪 · 已自动发现本机 PATH 组件" : "Ready · Detected on system PATH";
    }
    return isZh ? "已就绪 · 自定义本地目录" : "Ready · Custom local folder";
  })();

  if (mode === "tool" && status.ready && !expanded && !installing) {
    return (
      <div className="media-setup-compact">
        <div className="media-setup-title-row">
          <span className="media-status-pill is-ok">
            <CheckCircle2 size={13} aria-hidden="true" />
            <span>{sourceBadgeText}</span>
          </span>
          {status.ffmpegVersion && (
            <span className="field-hint mono" style={{ margin: 0 }}>
              {status.ffmpegVersion.split(" Copyright")[0]}
            </span>
          )}
        </div>
        <div className="media-actions-row">
          <button type="button" className="btn btn-ghost" onClick={() => setExpanded(true)}>
            <Settings2 size={14} aria-hidden="true" />
            <span>{isZh ? "配置媒体组件" : "Media Setup"}</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <section
      className={`media-setup-card ${!status.ready ? "is-missing" : ""}`}
      aria-label={isZh ? "配置媒体组件" : "Configure Media Components"}
    >
      <div className="media-setup-header">
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <div className="media-setup-title-row">
            <Wrench size={15} aria-hidden="true" />
            <h3 className="media-setup-title">
              {status.ready
                ? isZh
                  ? "本地媒体组件（FFmpeg / ffprobe）"
                  : "Local Media Components (FFmpeg / ffprobe)"
                : isZh
                  ? "配置媒体组件（FFmpeg / ffprobe）"
                  : "Configure Media Components (FFmpeg / ffprobe)"}
            </h3>
            <span className={`media-status-pill ${status.ready ? "is-ok" : "is-warn"}`}>
              {sourceBadgeText}
            </span>
          </div>
          <p className="field-hint" style={{ margin: 0 }}>
            {status.ready
              ? isZh
                ? "六项音视频工具共用本机 FFmpeg / ffprobe，处理全过程在本地离线完成，不修改系统 PATH。"
                : "All six media tools share local FFmpeg / ffprobe offline without modifying system PATH."
              : isZh
                ? "本机尚未检测到可用的 FFmpeg 与 ffprobe。您可以主动点击下方按钮一次性下载经 SHA-256 校验的固定构建，或直接指定本机已有目录；配置完成后即可完全断网使用。"
                : "FFmpeg and ffprobe were not found automatically. Click below for a one-time SHA-256 verified install, or select an existing local directory. Works completely offline once configured."}
          </p>
        </div>

        <div className="media-actions-row">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={installing}
            onClick={() => void refreshStatus()}
          >
            <RefreshCw size={14} aria-hidden="true" />
            <span>{isZh ? "重新检测" : "Re-check"}</span>
          </button>
          {mode === "tool" && status.ready && !installing && (
            <button type="button" className="btn btn-ghost" onClick={() => setExpanded(false)}>
              <X size={14} aria-hidden="true" />
              <span>{isZh ? "收起" : "Hide"}</span>
            </button>
          )}
        </div>
      </div>

      <div className="media-setup-meta-grid">
        <div className="media-setup-meta-item">
          <span className="media-setup-meta-label">
            {isZh ? "固定构建来源与版本" : "Pinned Source & Version"}
          </span>
          <span className="media-setup-meta-value mono">
            {status.spec.sourceName} · {status.spec.version}
          </span>
        </div>
        <div className="media-setup-meta-item">
          <span className="media-setup-meta-label">
            {isZh ? "下载大小 / 安装占用" : "Download / Installed Size"}
          </span>
          <span className="media-setup-meta-value mono">
            {formatMediaBytes(status.spec.downloadBytes, locale)} /{" "}
            {formatMediaBytes(status.spec.estimatedInstalledBytes, locale)}
          </span>
        </div>
        <div className="media-setup-meta-item">
          <span className="media-setup-meta-label">
            {isZh ? "许可与源码归属" : "License & Source"}
          </span>
          <span className="media-setup-meta-value mono">
            {status.spec.licenseName} (LICENSE + README.txt)
          </span>
        </div>
        <div className="media-setup-meta-item">
          <span className="media-setup-meta-label">
            {isZh
              ? "安装位置（仅当前用户，不改 PATH）"
              : "Install Folder (Per-user, PATH untouched)"}
          </span>
          <span className="media-setup-meta-value mono">{status.installDir}</span>
        </div>
        <div className="media-setup-meta-item">
          <span className="media-setup-meta-label">SHA-256</span>
          <span className="media-setup-meta-value mono">{status.spec.sha256}</span>
        </div>
        {status.ready && status.ffmpegPath && (
          <div className="media-setup-meta-item">
            <span className="media-setup-meta-label">
              {isZh ? "当前启用路径" : "Active Binary"}
            </span>
            <span className="media-setup-meta-value mono">{status.ffmpegPath}</span>
          </div>
        )}
      </div>

      {installing && progress && (
        <div
          style={{ display: "flex", flexDirection: "column", gap: "6px" }}
          role="status"
          aria-live="polite"
        >
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px" }}>
            <span>{progress.message}</span>
            <span className="mono">{Math.round(progress.percent ?? 0)}%</span>
          </div>
          <div className="media-progress-bar">
            <div
              className="media-progress-fill"
              style={{ width: `${Math.min(100, Math.max(0, progress.percent ?? 0))}%` }}
            />
          </div>
        </div>
      )}

      {actionError && (
        <div className="status-banner is-err" role="alert">
          <span>{actionError}</span>
        </div>
      )}

      {!actionError && status.error && !status.ready && (
        <div className="status-banner is-warn" role="status">
          <span>{status.error}</span>
        </div>
      )}

      {actionMessage && (
        <div className="status-banner is-ok" role="status" aria-live="polite">
          <span>{actionMessage}</span>
        </div>
      )}

      <div className="media-actions-row">
        {!installing ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleInstallManaged()}
          >
            <Download size={14} aria-hidden="true" />
            <span>
              {status.source === "managed"
                ? isZh
                  ? "重新下载并校验 WinKit 媒体组件"
                  : "Re-download & Verify Managed Build"
                : actionError
                  ? isZh
                    ? "重试一键下载配置媒体组件"
                    : "Retry One-Click Media Setup"
                  : isZh
                    ? "一键下载配置媒体组件"
                    : "One-Click Install Media Components"}
            </span>
          </button>
        ) : (
          <button type="button" className="btn" onClick={() => void handleCancelInstall()}>
            <X size={14} aria-hidden="true" />
            <span>{isZh ? "取消下载安装" : "Cancel Setup"}</span>
          </button>
        )}

        <button
          type="button"
          className="btn"
          disabled={installing}
          onClick={() => void handlePickLocalDir()}
        >
          <FolderOpen size={14} aria-hidden="true" />
          <span>{isZh ? "选择本地 FFmpeg 目录…" : "Choose Local FFmpeg Folder..."}</span>
        </button>

        {status.mode === "custom" && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={installing}
            onClick={() => void handleResetAuto()}
          >
            {isZh ? "恢复自动发现" : "Reset to Auto-detect"}
          </button>
        )}

        {status.source === "managed" && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={installing}
            onClick={() => void openLocalDirectory(status.installDir)}
          >
            {isZh ? "打开组件目录" : "Open Folder"}
          </button>
        )}
      </div>
    </section>
  );
}
