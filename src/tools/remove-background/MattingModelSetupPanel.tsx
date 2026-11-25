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
  getMattingModelStatus,
  installManagedMattingModel,
  openLocalDirectory,
  pickSingleDirectory,
  removeManagedMattingModel,
  setMattingModelCustomDir,
  subscribeMattingSetupProgress,
  type MattingModelStatus,
  type MattingSetupProgressPayload,
} from "../../lib/tauriBridge";
import { formatMediaBytes } from "../media-shared/mediaFormat";

interface MattingModelSetupPanelProps {
  onStatusChange?: (status: MattingModelStatus) => void;
}

export function MattingModelSetupPanel({ onStatusChange }: MattingModelSetupPanelProps) {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";

  const [status, setStatus] = useState<MattingModelStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installTaskId, setInstallTaskId] = useState<string | null>(null);
  const [progress, setProgress] = useState<MattingSetupProgressPayload | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    try {
      const next = await getMattingModelStatus();
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
        subscribeMattingSetupProgress((payload) => {
          setProgress(payload);
        }),
      "winkit://matting-setup-progress",
    );
  }, []);

  const handleInstallManaged = async () => {
    if (installing) return;
    const taskId = `matting-setup-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setInstalling(true);
    setInstallTaskId(taskId);
    setActionError(null);
    setActionMessage(null);
    setProgress({
      taskId,
      phase: "downloading",
      downloadedBytes: 0,
      totalBytes: status?.spec.modelBytes ?? 98_484_532,
      percent: 0,
      message: isZh
        ? "正在连接固定版本源并准备下载离线抠图模型…"
        : "Connecting to pinned release to download offline cutout model...",
    });

    try {
      const next = await installManagedMattingModel(taskId);
      setStatus(next);
      onStatusChangeRef.current?.(next);
      setActionMessage(
        isZh
          ? "离线抠图模型（BiRefNet_lite 512 FP16，MIT）已通过 SHA-256 校验，后续可完全断网使用。"
          : "Offline cutout model (BiRefNet_lite 512 FP16, MIT) passed SHA-256 verification and is ready for offline use.",
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
          ? "选择包含 birefnet-lite-512-fp16.onnx 或 model_fp16.onnx 的目录"
          : "Select folder containing birefnet-lite-512-fp16.onnx or model_fp16.onnx",
      });
      if (!dir) return;
      const next = await setMattingModelCustomDir(dir);
      setStatus(next);
      onStatusChangeRef.current?.(next);
      setActionMessage(
        isZh
          ? "已通过 SHA-256 校验并启用自定义本地抠图模型目录。"
          : "SHA-256 verified and enabled custom local cutout model folder.",
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
      const next = await setMattingModelCustomDir(null);
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
      const next = await removeManagedMattingModel();
      setStatus(next);
      onStatusChangeRef.current?.(next);
      setActionMessage(
        isZh
          ? "已移除本地托管抠图模型文件，磁盘空间已释放。"
          : "Removed managed local cutout model files and freed disk space.",
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
            ? "正在检查离线抠图模型（BiRefNet_lite 512 FP16）…"
            : "Checking offline background-removal model (BiRefNet_lite 512 FP16)..."}
        </span>
      </div>
    );
  }

  if (!status) {
    return null;
  }

  const sourceBadge = !status.ready
    ? isZh
      ? "尚未安装离线抠图模型"
      : "Offline cutout model not installed"
    : status.source === "custom"
      ? isZh
        ? "已就绪 · 自定义本地抠图模型（断网可用）"
        : "Ready · Custom local cutout model (offline)"
      : isZh
        ? "已就绪 · BiRefNet_lite 512 FP16（断网可用）"
        : "Ready · BiRefNet_lite 512 FP16 (offline)";

  if (status.ready && !expanded && !installing) {
    return (
      <div className="media-setup-compact" data-testid="matting-model-compact-bar">
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
            data-testid="matting-model-manage-btn"
          >
            <Settings2 size={14} aria-hidden="true" />
            <span>{isZh ? "管理抠图模型" : "Cutout Model"}</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <section
      className={`media-setup-card ${!status.ready ? "is-missing" : ""}`}
      aria-label={isZh ? "离线抠图模型配置" : "Offline Background-Removal Model Setup"}
      data-testid="matting-model-setup-card"
    >
      <div className="media-setup-header">
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <div className="media-setup-title-row">
            <Cpu size={15} aria-hidden="true" />
            <h3 className="media-setup-title">
              {isZh
                ? "离线抠图模型（BiRefNet_lite 512 FP16）"
                : "Offline Cutout Model (BiRefNet_lite 512 FP16)"}
            </h3>
            <span className={`media-status-pill ${status.ready ? "is-ok" : "is-warn"}`}>
              {sourceBadge}
            </span>
          </div>
          <p className="field-hint" style={{ margin: 0 }}>
            {isZh
              ? "复用 WinKit 内置 ONNX Runtime 1.23.2（CPU 离线推理，不增加安装包体积）。启动时绝不自动联网；仅在您主动点击下载时一次性拉取并核对 SHA-256，完成后所有图片抠图 100% 本地断网运行。"
              : "Reuses WinKit's bundled ONNX Runtime 1.23.2 (offline CPU inference, +0 B installer size). Never downloads automatically on startup; downloads once only when you click below with SHA-256 verification, then runs 100% offline."}
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

      <div className="matting-model-spec-grid">
        <div>
          <span className="matting-spec-label">{isZh ? "固定版本" : "Pinned Version"}</span>
          <span className="matting-spec-value mono">{status.spec.version}</span>
        </div>
        <div>
          <span className="matting-spec-label">{isZh ? "模型体积" : "Model Size"}</span>
          <span className="matting-spec-value mono">
            {formatMediaBytes(status.spec.modelBytes, locale)}
          </span>
        </div>
        <div>
          <span className="matting-spec-label">{isZh ? "来源" : "Source"}</span>
          <span className="matting-spec-value">{status.spec.sourceName}</span>
        </div>
        <div>
          <span className="matting-spec-label">{isZh ? "安装位置" : "Install Location"}</span>
          <span className="matting-spec-value mono matting-spec-path">
            {status.activeModelDir ?? status.installDir}
          </span>
        </div>
        <div className="matting-spec-full">
          <span className="matting-spec-label">
            {isZh ? "代码与权重许可" : "Code & Weights License"}
          </span>
          <span className="matting-spec-value">{status.spec.licenseSummary}</span>
        </div>
        <div className="matting-spec-full">
          <span className="matting-spec-label">SHA-256</span>
          <span className="matting-spec-value mono matting-spec-sha">
            {status.spec.modelSha256}
          </span>
        </div>
      </div>

      {installing && progress && (
        <div className="matting-setup-progress" role="status" aria-live="polite">
          <div className="matting-progress-header">
            <span>{progress.message}</span>
            <span className="mono">
              {progress.percent != null ? `${Math.round(progress.percent)}%` : ""}
            </span>
          </div>
          <div className="matting-progress-track">
            <div
              className="matting-progress-fill"
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
            data-testid="matting-download-model-btn"
          >
            <Download size={14} aria-hidden="true" />
            <span>
              {status.source === "managed"
                ? isZh
                  ? "重新下载并校验模型"
                  : "Re-download & Verify Model"
                : isZh
                  ? `下载离线抠图模型 (${formatMediaBytes(status.spec.modelBytes, locale)})`
                  : `Download Offline Cutout Model (${formatMediaBytes(status.spec.modelBytes, locale)})`}
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
          data-testid="matting-pick-custom-dir-btn"
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
            data-testid="matting-remove-model-btn"
          >
            <Trash2 size={14} aria-hidden="true" />
            <span>{isZh ? "移除本地模型" : "Remove Model"}</span>
          </button>
        )}
      </div>

      <ConfirmDialog
        open={confirmRemove}
        title={isZh ? "移除本地离线抠图模型" : "Remove Local Cutout Model"}
        body={
          isZh
            ? `确定删除托管目录中的 BiRefNet_lite 512 FP16 权重文件（约 ${formatMediaBytes(status.installedBytes ?? status.spec.modelBytes, locale)}）？删除后需重新下载才能离线抠图。`
            : `Delete the managed BiRefNet_lite 512 FP16 model weights (~${formatMediaBytes(status.installedBytes ?? status.spec.modelBytes, locale)})? You will need to re-download them to remove backgrounds offline.`
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
