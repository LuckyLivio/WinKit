import {
  CheckCircle2,
  Cpu,
  Download,
  FolderOpen,
  RefreshCw,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useI18n } from "../../i18n/I18nContext";
import {
  bindDisposableListener,
  cancelBackendTask,
  formatLocalizedError,
  getAsrModelStatus,
  installManagedAsrModel,
  openLocalDirectory,
  pickSingleDirectory,
  removeManagedAsrModel,
  setAsrModelCustomDir,
  subscribeAsrSetupProgress,
  type AsrModelStatus,
  type AsrSetupProgressPayload,
} from "../../lib/tauriBridge";
import { formatMediaBytes } from "../media-shared/mediaFormat";

interface AsrModelSetupPanelProps {
  onStatusChange?: (status: AsrModelStatus) => void;
}

export function AsrModelSetupPanel({ onStatusChange }: AsrModelSetupPanelProps) {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";

  const [status, setStatus] = useState<AsrModelStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installTaskId, setInstallTaskId] = useState<string | null>(null);
  const [progress, setProgress] = useState<AsrSetupProgressPayload | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    try {
      const next = await getAsrModelStatus();
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
        subscribeAsrSetupProgress((payload) => {
          setProgress(payload);
        }),
      "winkit://asr-setup-progress",
    );
  }, []);

  const handleInstallManaged = async () => {
    if (installing) return;
    const taskId = `asr-setup-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setInstalling(true);
    setInstallTaskId(taskId);
    setActionError(null);
    setActionMessage(null);
    setProgress({
      taskId,
      phase: "downloading",
      downloadedBytes: 0,
      totalBytes: status?.spec.totalDownloadBytes ?? 165_315_984,
      percent: 0,
      message: isZh
        ? "正在连接固定发布源并准备下载离线语音模型…"
        : "Connecting to pinned release to download offline speech model...",
    });

    try {
      const next = await installManagedAsrModel(taskId);
      setStatus(next);
      onStatusChangeRef.current?.(next);
      setActionMessage(
        isZh
          ? "离线语音识别模型（SenseVoiceSmall INT8 + Silero VAD v5）已通过 SHA-256 校验，后续可完全断网使用。"
          : "Offline speech model (SenseVoiceSmall INT8 + Silero VAD v5) passed SHA-256 verification and is ready for offline use.",
      );
      setExpanded(false);
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
          ? "选择包含 model.int8.onnx、tokens.txt 与 silero_vad_v5.onnx 的目录"
          : "Select folder containing model.int8.onnx, tokens.txt & silero_vad_v5.onnx",
      });
      if (!dir) return;
      const next = await setAsrModelCustomDir(dir);
      setStatus(next);
      onStatusChangeRef.current?.(next);
      setActionMessage(
        isZh
          ? "已通过 SHA-256 校验并启用自定义本地语音模型目录。"
          : "SHA-256 verified and enabled custom local speech model folder.",
      );
      setExpanded(false);
    } catch (err) {
      setActionError(formatLocalizedError(err, t));
    }
  };

  const handleResetManaged = async () => {
    setActionError(null);
    setActionMessage(null);
    try {
      const next = await setAsrModelCustomDir(null);
      setStatus(next);
      onStatusChangeRef.current?.(next);
    } catch (err) {
      setActionError(formatLocalizedError(err, t));
    }
  };

  const handleRemoveManaged = async () => {
    setConfirmRemove(false);
    setActionError(null);
    setActionMessage(null);
    try {
      const next = await removeManagedAsrModel();
      setStatus(next);
      onStatusChangeRef.current?.(next);
      setActionMessage(
        isZh
          ? "已移除本地托管语音模型文件，磁盘空间已释放。"
          : "Removed managed local speech model files and freed disk space.",
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
            ? "正在检查离线语音识别模型（SenseVoiceSmall INT8 + Silero VAD v5）…"
            : "Checking offline speech model (SenseVoiceSmall INT8 + Silero VAD v5)..."}
        </span>
      </div>
    );
  }

  if (!status) {
    return null;
  }

  const sourceBadge = !status.ready
    ? isZh
      ? "尚未安装离线语音模型"
      : "Offline speech model not installed"
    : status.source === "custom"
      ? isZh
        ? "已就绪 · 自定义本地语音模型（断网可用）"
        : "Ready · Custom local speech model (offline)"
      : isZh
        ? "已就绪 · SenseVoiceSmall INT8 + Silero VAD v5（断网可用）"
        : "Ready · SenseVoiceSmall INT8 + Silero VAD v5 (offline)";

  if (status.ready && !expanded && !installing) {
    return (
      <div className="media-setup-compact" data-testid="asr-model-compact-bar">
        <div className="media-setup-title-row">
          <span className="media-status-pill is-ok">
            <CheckCircle2 size={13} aria-hidden="true" />
            <span>{sourceBadge}</span>
          </span>
          {status.installedBytes != null && (
            <span className="field-hint mono" style={{ margin: 0 }}>
              {formatMediaBytes(status.installedBytes, locale)}
            </span>
          )}
        </div>
        <div className="media-actions-row">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setExpanded(true)}
            data-testid="asr-model-manage-btn"
          >
            <Settings2 size={14} aria-hidden="true" />
            <span>{isZh ? "管理语音模型" : "Speech Model"}</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <section
      className={`media-setup-card ${!status.ready ? "is-missing" : ""}`}
      aria-label={isZh ? "离线语音识别模型配置" : "Offline Speech Model Setup"}
      data-testid="asr-model-setup-card"
    >
      <div className="media-setup-header">
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <div className="media-setup-title-row">
            <Cpu size={15} aria-hidden="true" />
            <h3 className="media-setup-title">
              {isZh
                ? "离线语音识别模型（SenseVoiceSmall INT8 + Silero VAD v5）"
                : "Offline Speech Model (SenseVoiceSmall INT8 + Silero VAD v5)"}
            </h3>
            <span className={`media-status-pill ${status.ready ? "is-ok" : "is-warn"}`}>
              {sourceBadge}
            </span>
          </div>
          <p className="field-hint" style={{ margin: 0 }}>
            {isZh
              ? "复用 WinKit 内置 ONNX Runtime（CPU 离线推理，不增加安装包体积）。仅在您主动点击下载时一次性联网拉取并核对 SHA-256，完成后所有音视频转写 100% 本地断网运行。"
              : "Reuses WinKit's bundled ONNX Runtime (offline CPU inference, +0 B installer bloat). Downloads once only when you click below with strict SHA-256 verification; all transcription runs 100% offline afterward."}
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
          {status.ready && !installing && (
            <button type="button" className="btn btn-ghost" onClick={() => setExpanded(false)}>
              <X size={14} aria-hidden="true" />
              <span>{isZh ? "收起" : "Hide"}</span>
            </button>
          )}
        </div>
      </div>

      <div className="asr-model-spec-grid">
        <div>
          <span className="asr-spec-label">{isZh ? "固定版本" : "Pinned Version"}</span>
          <span className="asr-spec-value mono">{status.spec.version}</span>
        </div>
        <div>
          <span className="asr-spec-label">
            {isZh ? "下载 / 解压体积" : "Download / Disk Size"}
          </span>
          <span className="asr-spec-value mono">
            {formatMediaBytes(status.spec.totalDownloadBytes, locale)} /{" "}
            {formatMediaBytes(status.spec.estimatedInstalledBytes, locale)}
          </span>
        </div>
        <div>
          <span className="asr-spec-label">{isZh ? "来源" : "Source"}</span>
          <span className="asr-spec-value">{status.spec.sourceName}</span>
        </div>
        <div>
          <span className="asr-spec-label">{isZh ? "安装位置" : "Install Location"}</span>
          <span className="asr-spec-value mono asr-spec-path">
            {status.activeModelDir ?? status.installDir}
          </span>
        </div>
        <div className="asr-spec-full">
          <span className="asr-spec-label">{isZh ? "许可协议" : "Licenses"}</span>
          <span className="asr-spec-value">{status.spec.licenseSummary}</span>
        </div>
        <div className="asr-spec-full">
          <span className="asr-spec-label">SHA-256</span>
          <span className="asr-spec-value mono asr-spec-sha">
            SenseVoice: {status.spec.sensevoiceArchiveSha256.slice(0, 20)}… · Silero VAD:{" "}
            {status.spec.sileroVadSha256.slice(0, 20)}…
          </span>
        </div>
      </div>

      {installing && progress && (
        <div className="asr-setup-progress" role="status" aria-live="polite">
          <div className="asr-progress-header">
            <span>{progress.message}</span>
            <span className="mono">
              {progress.percent != null ? `${Math.round(progress.percent)}%` : ""}
            </span>
          </div>
          <div className="asr-progress-track">
            <div
              className="asr-progress-fill"
              style={{ width: `${Math.min(100, Math.max(0, progress.percent ?? 0))}%` }}
            />
          </div>
        </div>
      )}

      {status.error && (
        <div className="status-banner is-error" role="alert">
          {status.error}
        </div>
      )}
      {actionError && (
        <div className="status-banner is-error" role="alert">
          {actionError}
        </div>
      )}
      {actionMessage && (
        <div className="status-banner is-ok" role="status">
          {actionMessage}
        </div>
      )}

      <div className="media-actions-row" style={{ flexWrap: "wrap" }}>
        {!installing ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!status.runtimeReady}
            onClick={() => void handleInstallManaged()}
            data-testid="asr-download-model-btn"
          >
            <Download size={14} aria-hidden="true" />
            <span>
              {status.source === "managed"
                ? isZh
                  ? "重新下载并校验模型"
                  : "Re-download & Verify Model"
                : isZh
                  ? `下载离线语音模型 (${formatMediaBytes(status.spec.totalDownloadBytes, locale)})`
                  : `Download Offline Speech Model (${formatMediaBytes(status.spec.totalDownloadBytes, locale)})`}
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
          className="btn btn-secondary"
          disabled={installing}
          onClick={() => void handlePickLocalDir()}
          data-testid="asr-pick-custom-dir-btn"
        >
          <FolderOpen size={14} aria-hidden="true" />
          <span>{isZh ? "选择本地模型目录" : "Select Local Model Folder"}</span>
        </button>

        {status.mode === "custom" && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={installing}
            onClick={() => void handleResetManaged()}
          >
            <span>{isZh ? "切回托管目录" : "Use Managed Folder"}</span>
          </button>
        )}

        {status.activeModelDir && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={installing}
            onClick={() => void openLocalDirectory(status.activeModelDir!)}
          >
            <FolderOpen size={14} aria-hidden="true" />
            <span>{isZh ? "打开模型目录" : "Open Folder"}</span>
          </button>
        )}

        {status.source === "managed" && !installing && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setConfirmRemove(true)}
            data-testid="asr-remove-model-btn"
          >
            <Trash2 size={14} aria-hidden="true" />
            <span>{isZh ? "移除本地模型" : "Remove Model"}</span>
          </button>
        )}
      </div>

      <ConfirmDialog
        open={confirmRemove}
        title={isZh ? "移除本地离线语音模型" : "Remove Local Speech Model"}
        body={
          isZh
            ? `确定删除托管目录中的 SenseVoiceSmall INT8 与 Silero VAD v5 权重文件（约 ${formatMediaBytes(status.installedBytes ?? status.spec.estimatedInstalledBytes, locale)}）？删除后需重新下载才能离线转写。`
            : `Delete the managed SenseVoiceSmall INT8 and Silero VAD v5 weights (~${formatMediaBytes(status.installedBytes ?? status.spec.estimatedInstalledBytes, locale)})? You will need to re-download them to transcribe offline.`
        }
        confirmLabel={isZh ? "确认删除" : "Remove"}
        cancelLabel={isZh ? "取消" : "Cancel"}
        danger
        onConfirm={() => void handleRemoveManaged()}
        onCancel={() => setConfirmRemove(false)}
      />
    </section>
  );
}
