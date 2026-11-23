import {
  CheckCircle2,
  Download,
  FolderOpen,
  Info,
  RefreshCw,
  Settings2,
  Terminal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/I18nContext";
import {
  bindDisposableListener,
  cancelBackendTask,
  formatLocalizedError,
  getYtdlpToolsStatus,
  installManagedYtdlp,
  openLocalDirectory,
  pickSingleFile,
  setYtdlpCustomPath,
  subscribeYtdlpSetupProgress,
  type YtdlpSetupProgressPayload,
  type YtdlpToolsStatus,
} from "../lib/tauriBridge";
import { formatMediaBytes } from "../tools/media-shared/mediaFormat";
import "../tools/media-shared/mediaWorkspace.css";

interface YtdlpSetupPanelProps {
  mode?: "tool" | "settings";
  onStatusChange?: (status: YtdlpToolsStatus) => void;
}

export function YtdlpSetupPanel({ mode = "tool", onStatusChange }: YtdlpSetupPanelProps) {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";

  const [status, setStatus] = useState<YtdlpToolsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(mode === "settings");
  const [installing, setInstalling] = useState(false);
  const [installTaskId, setInstallTaskId] = useState<string | null>(null);
  const [progress, setProgress] = useState<YtdlpSetupProgressPayload | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    try {
      const next = await getYtdlpToolsStatus();
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
        subscribeYtdlpSetupProgress((payload) => {
          setProgress(payload);
        }),
      "winkit://ytdlp-setup-progress",
    );
  }, []);

  const handleInstallManaged = async () => {
    if (installing) return;
    const taskId = `ytdlp-setup-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setInstalling(true);
    setInstallTaskId(taskId);
    setActionError(null);
    setActionMessage(null);
    setProgress({
      taskId,
      phase: "downloading",
      downloadedBytes: 0,
      totalBytes: status?.spec.downloadBytes ?? 23_575_744,
      percent: 0,
      message: isZh
        ? "正在连接官方 GitHub Release 并校验摘要…"
        : "Connecting to official GitHub Release...",
    });

    try {
      const next = await installManagedYtdlp(taskId);
      setStatus(next);
      onStatusChangeRef.current?.(next);
      setActionMessage(
        isZh
          ? "官方固定版本 yt-dlp 已通过 SHA-256 校验与自检并启用（含 The Unlicense 许可说明）。"
          : "Official pinned yt-dlp passed SHA-256 verification and self-check (with The Unlicense notice).",
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

  const handlePickLocalExe = async () => {
    setActionError(null);
    setActionMessage(null);
    try {
      const file = await pickSingleFile({
        title: isZh ? "选择本机已有的 yt-dlp.exe" : "Select existing local yt-dlp.exe",
        filters: [{ name: "yt-dlp Executable", extensions: ["exe"] }],
      });
      if (!file) return;
      const next = await setYtdlpCustomPath(file);
      setStatus(next);
      onStatusChangeRef.current?.(next);
      setActionMessage(
        isZh
          ? "已验证并启用选定的本地 yt-dlp 程序。"
          : "Verified and enabled the selected local yt-dlp binary.",
      );
    } catch (err) {
      setActionError(formatLocalizedError(err, t));
    }
  };

  const handleResetAuto = async () => {
    setActionError(null);
    setActionMessage(null);
    try {
      const next = await setYtdlpCustomPath(null);
      setStatus(next);
      onStatusChangeRef.current?.(next);
      setActionMessage(
        isZh
          ? "已切换回自动发现模式（优先 WinKit 本地受管 yt-dlp，其次系统 PATH）。"
          : "Switched back to auto discovery (WinKit managed yt-dlp, then system PATH).",
      );
    } catch (err) {
      setActionError(formatLocalizedError(err, t));
    }
  };

  if (loading && !status) {
    return (
      <div className="media-setup-compact" role="status">
        <span>
          {isZh ? "正在检测本地 yt-dlp 与 JS 运行时…" : "Checking local yt-dlp & JS runtime..."}
        </span>
      </div>
    );
  }

  if (!status) {
    return null;
  }

  const sourceBadgeText = (() => {
    if (!status.ready) {
      return isZh ? "未配置 yt-dlp（直链仍可用）" : "yt-dlp not set up (direct links still work)";
    }
    if (status.source === "managed") {
      return isZh ? "yt-dlp 就绪 · WinKit 受管组件" : "yt-dlp Ready · WinKit Managed";
    }
    if (status.source === "system_path") {
      return isZh ? "yt-dlp 就绪 · 系统 PATH" : "yt-dlp Ready · System PATH";
    }
    return isZh ? "yt-dlp 就绪 · 自定义本地程序" : "yt-dlp Ready · Custom Local Binary";
  })();

  const jsRuntimeSummary = status.hasJsRuntime
    ? status.jsRuntimes.map((r) => `${r.name} ${r.version}`).join(" · ")
    : isZh
      ? "未检测到 Deno / Node.js（部分站点解析可能需要）"
      : "No Deno / Node.js detected (required by some sites)";

  if (mode === "tool" && status.ready && !expanded && !installing) {
    return (
      <div className="media-setup-compact">
        <div className="media-setup-title-row">
          <span className="media-status-pill is-ok">
            <CheckCircle2 size={13} aria-hidden="true" />
            <span>{sourceBadgeText}</span>
          </span>
          {status.ytdlpVersion && (
            <span className="field-hint mono" style={{ margin: 0 }}>
              v{status.ytdlpVersion}
            </span>
          )}
          <span
            className={`media-status-pill ${status.hasJsRuntime ? "is-ok" : "is-warn"}`}
            title={jsRuntimeSummary}
          >
            <Terminal size={12} aria-hidden="true" />
            <span>
              {status.hasJsRuntime
                ? `JS: ${status.jsRuntimes[0]?.name} ${status.jsRuntimes[0]?.version}`
                : isZh
                  ? "未检测到 JS 运行时"
                  : "No JS runtime"}
            </span>
          </span>
        </div>
        <div className="media-actions-row">
          <button type="button" className="btn btn-ghost" onClick={() => setExpanded(true)}>
            <Settings2 size={14} aria-hidden="true" />
            <span>{isZh ? "配置 yt-dlp" : "Configure yt-dlp"}</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <section
      className={`media-setup-card ${!status.ready ? "is-missing" : ""}`}
      aria-label={isZh ? "配置 yt-dlp 下载组件" : "Configure yt-dlp Component"}
    >
      <div className="media-setup-header">
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <div className="media-setup-title-row">
            <Download size={15} aria-hidden="true" />
            <h3 className="media-setup-title">
              {isZh ? "网页视频解析组件（yt-dlp）" : "Web Video Parser Component (yt-dlp)"}
            </h3>
            <span className={`media-status-pill ${status.ready ? "is-ok" : "is-warn"}`}>
              {sourceBadgeText}
            </span>
          </div>
          <p className="field-hint" style={{ margin: 0 }}>
            {isZh
              ? "普通媒体直链（如 MP4/M4A）无需 yt-dlp 即可直接下载；网页视频和多清晰度 HLS/DASH 清单需使用本地 yt-dlp。点击安装固定版本将核对 SHA-256 摘要并保存许可文件，若更新或校验失败会自动保留原有可用版本，绝不修改系统 PATH。"
              : "Direct media links (e.g. MP4/M4A) work independently without yt-dlp; web video pages and adaptive HLS/DASH manifests use local yt-dlp. Managed install verifies SHA-256 and license before activation and preserves any working prior version if verification fails."}
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
            {isZh ? "固定版本与官方来源" : "Pinned Official Source"}
          </span>
          <span className="media-setup-meta-value mono">{status.spec.sourceName}</span>
        </div>
        <div className="media-setup-meta-item">
          <span className="media-setup-meta-label">
            {isZh ? "下载大小 / 许可" : "Download Size / License"}
          </span>
          <span className="media-setup-meta-value mono">
            {formatMediaBytes(status.spec.downloadBytes, locale)} · {status.spec.licenseName}
          </span>
        </div>
        <div className="media-setup-meta-item">
          <span className="media-setup-meta-label">SHA-256</span>
          <span className="media-setup-meta-value mono">{status.spec.sha256}</span>
        </div>
        <div className="media-setup-meta-item">
          <span className="media-setup-meta-label">
            {isZh ? "JavaScript 运行时（上游 EJS）" : "JavaScript Runtime (Upstream EJS)"}
          </span>
          <span className="media-setup-meta-value mono">{jsRuntimeSummary}</span>
        </div>
        <div className="media-setup-meta-item">
          <span className="media-setup-meta-label">
            {isZh ? "受管目录（不改系统 PATH）" : "Managed Folder (PATH untouched)"}
          </span>
          <span className="media-setup-meta-value mono">{status.installDir}</span>
        </div>
        {status.ready && status.ytdlpPath && (
          <div className="media-setup-meta-item">
            <span className="media-setup-meta-label">
              {isZh ? "当前启用程序与版本" : "Active Binary & Version"}
            </span>
            <span className="media-setup-meta-value mono">
              {status.ytdlpPath} ({status.ytdlpVersion ?? "unknown"})
            </span>
          </div>
        )}
      </div>

      {!status.hasJsRuntime && (
        <div className="status-banner is-warn" role="status">
          <Info size={14} aria-hidden="true" />
          <span>
            {isZh
              ? "按 yt-dlp 上游说明，部分网站（如 YouTube）解析需要额外 JavaScript 运行时（推荐 Deno，也支持 Node.js / Bun / QuickJS）；普通媒体直链与多数公开站点可独立使用。"
              : "Per upstream yt-dlp documentation, some sites (such as YouTube) require an external JavaScript runtime (Deno recommended, or Node.js / Bun / QuickJS). Direct media links and most standard sites work without one."}
          </span>
        </div>
      )}

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
                  ? `重新验证并更新至 yt-dlp ${status.spec.version}`
                  : `Re-verify / Update yt-dlp ${status.spec.version}`
                : isZh
                  ? `下载并校验官方 yt-dlp ${status.spec.version}（${formatMediaBytes(status.spec.downloadBytes, locale)}）`
                  : `Install Verified yt-dlp ${status.spec.version} (${formatMediaBytes(status.spec.downloadBytes, locale)})`}
            </span>
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => void handleCancelInstall()}
          >
            <X size={14} aria-hidden="true" />
            <span>{isZh ? "取消下载" : "Cancel Download"}</span>
          </button>
        )}

        <button
          type="button"
          className="btn"
          disabled={installing}
          onClick={() => void handlePickLocalExe()}
        >
          <FolderOpen size={14} aria-hidden="true" />
          <span>{isZh ? "选择本地 yt-dlp.exe…" : "Choose Local yt-dlp.exe..."}</span>
        </button>

        {status.mode === "custom" && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={installing}
            onClick={() => void handleResetAuto()}
          >
            <span>{isZh ? "恢复自动发现" : "Reset to Auto"}</span>
          </button>
        )}

        {status.managedInstalledBytes != null && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={installing}
            onClick={() => void openLocalDirectory(status.installDir)}
          >
            <FolderOpen size={14} aria-hidden="true" />
            <span>{isZh ? "打开组件与许可目录" : "Open Component Folder"}</span>
          </button>
        )}
      </div>
    </section>
  );
}
