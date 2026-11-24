import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  FolderOpen,
  Info,
  Lock,
  Save,
  ShieldCheck,
  Unlock,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useI18n } from "../../i18n/I18nContext";
import { usePdfSession } from "../../lib/pdfSessionStore";
import {
  bindDisposableListener,
  cancelBackendTask,
  encryptPdf,
  formatLocalizedError,
  inspectPdfSecurity,
  openLocalDirectory,
  parseBackendError,
  pickSaveFilePath,
  pickSingleFile,
  subscribeFileDrop,
  subscribePdfTaskProgress,
  suggestSafeSiblingPath,
  type PdfModifyPermission,
  type PdfPrintPermission,
} from "../../lib/tauriBridge";
import "./pdfCrypto.css";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function parentDirectoryOf(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
  return idx > 0 ? filePath.slice(0, idx) : filePath;
}

export function PdfEncryptWorkspace() {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const {
    pdfSession,
    updateEncryptSession,
    sendPdfToTool,
    pendingToolIntake,
    clearPendingToolIntake,
  } = usePdfSession();
  const state = pdfSession.encrypt;

  // Passwords live strictly in ephemeral component state — never persisted in session/localStorage.
  const [userPassword, setUserPassword] = useState("");
  const [confirmUserPassword, setConfirmUserPassword] = useState("");
  const [showUserPassword, setShowUserPassword] = useState(false);

  const [useCustomOwnerPassword, setUseCustomOwnerPassword] = useState(false);
  const [ownerPassword, setOwnerPassword] = useState("");
  const [confirmOwnerPassword, setConfirmOwnerPassword] = useState("");
  const [showOwnerPassword, setShowOwnerPassword] = useState(false);

  const [dropHover, setDropHover] = useState(false);
  const [overwriteDialogOpen, setOverwriteDialogOpen] = useState(false);
  const pendingOverwritePathRef = useRef<string | null>(null);
  const inspectGenRef = useRef(0);

  // Clear local passwords on unmount
  useEffect(() => {
    return () => {
      setUserPassword("");
      setConfirmUserPassword("");
      setOwnerPassword("");
      setConfirmOwnerPassword("");
    };
  }, []);

  const loadSourcePdf = useCallback(
    async (path: string) => {
      const gen = ++inspectGenRef.current;
      setUserPassword("");
      setConfirmUserPassword("");
      setOwnerPassword("");
      setConfirmOwnerPassword("");

      updateEncryptSession((prev) => ({
        ...prev,
        sourcePath: path,
        securityStatus: null,
        inspectLoading: true,
        lastResult: null,
        errorMessage: null,
      }));

      try {
        const status = await inspectPdfSecurity(path);
        if (inspectGenRef.current !== gen) return;
        const suggested =
          (await suggestSafeSiblingPath(status.path, "_encrypted", "pdf").catch(() => null)) ??
          status.path.replace(/\.pdf$/i, "_encrypted.pdf");
        if (inspectGenRef.current !== gen) return;
        updateEncryptSession((prev) => ({
          ...prev,
          sourcePath: status.path,
          securityStatus: status,
          inspectLoading: false,
          outputPath: suggested,
          errorMessage: null,
        }));
      } catch (err) {
        if (inspectGenRef.current !== gen) return;
        updateEncryptSession((prev) => ({
          ...prev,
          inspectLoading: false,
          errorMessage: formatLocalizedError(err, t),
        }));
      }
    },
    [t, updateEncryptSession],
  );

  // Consume cross-tool PDF handoff
  useEffect(() => {
    if (pendingToolIntake?.toolId !== "P15") return;
    const target = pendingToolIntake.path;
    clearPendingToolIntake();
    void loadSourcePdf(target);
  }, [pendingToolIntake, clearPendingToolIntake, loadSourcePdf]);

  // Native file drag-and-drop
  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: setDropHover,
          onDropPaths: (paths) => {
            const pdf = paths.find((p) => p.toLowerCase().endsWith(".pdf")) ?? paths[0];
            if (pdf) void loadSourcePdf(pdf);
          },
        }),
      "p15-drop",
    );
  }, [loadSourcePdf]);

  // Progress listener
  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribePdfTaskProgress((ev) => {
          if (ev.toolId !== "P15") return;
          updateEncryptSession((prev) =>
            prev.activeTaskId && ev.taskId === prev.activeTaskId ? { ...prev, progress: ev } : prev,
          );
        }),
      "p15-progress",
    );
  }, [updateEncryptSession]);

  const handleBrowseInput = async () => {
    const picked = await pickSingleFile({
      title: isZh ? "选择需要加密的 PDF 文件" : "Select PDF to Encrypt",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (picked) {
      await loadSourcePdf(picked);
    }
  };

  const handleBrowseOutput = async () => {
    const picked = await pickSaveFilePath({
      title: isZh ? "选择加密 PDF 输出位置" : "Save Encrypted PDF As",
      defaultPath: state.outputPath || undefined,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (picked) {
      updateEncryptSession((prev) => ({ ...prev, outputPath: picked }));
    }
  };

  const sec = state.securityStatus;
  const canEncryptDoc = sec?.status === "unencrypted";

  const userMismatch = userPassword !== confirmUserPassword;
  const ownerMismatch = useCustomOwnerPassword && ownerPassword !== confirmOwnerPassword;
  const sameUserAndOwner =
    useCustomOwnerPassword &&
    userPassword.length > 0 &&
    ownerPassword.length > 0 &&
    userPassword === ownerPassword;
  const missingAnyPassword =
    userPassword.length === 0 && (!useCustomOwnerPassword || ownerPassword.length === 0);

  const validationError = !canEncryptDoc
    ? null
    : missingAnyPassword
      ? isZh
        ? "请设置打开密码，或启用并设置独立权限密码。"
        : "Set an open password, or enable and set an explicit owner password."
      : userMismatch
        ? isZh
          ? "两次输入的打开密码不一致。"
          : "Open passwords do not match."
        : ownerMismatch
          ? isZh
            ? "两次输入的权限密码不一致。"
            : "Owner passwords do not match."
          : sameUserAndOwner
            ? isZh
              ? "打开密码与权限密码不能相同；如不需要独立管理密码，保持默认自动生成随机权限密码即可。"
              : "Open password and owner password must differ; keep the auto-generated owner password if you only need an open password."
            : null;

  const executeEncrypt = async (targetPath: string, overwrite: boolean) => {
    if (!state.sourcePath) return;
    const taskId = `p15-${Date.now()}`;
    updateEncryptSession((prev) => ({
      ...prev,
      taskStatus: "running",
      activeTaskId: taskId,
      progress: {
        taskId,
        toolId: "P15",
        current: 0,
        total: 100,
        percent: 0,
        detail: isZh ? "准备加密..." : "Preparing encryption...",
      },
      lastResult: null,
      errorMessage: null,
    }));

    try {
      const result = await encryptPdf(taskId, {
        inputPath: state.sourcePath,
        outputPath: targetPath,
        overwrite,
        userPassword,
        ownerPassword: useCustomOwnerPassword ? ownerPassword : null,
        printPermission: state.printPermission,
        allowCopy: state.allowCopy,
        allowModify: state.allowModify,
        encryptMetadata: state.encryptMetadata,
      });
      updateEncryptSession((prev) => ({
        ...prev,
        outputPath: result.outputPath,
        taskStatus: "idle",
        activeTaskId: null,
        progress: null,
        lastResult: result,
        errorMessage: null,
      }));
      // Wipe passwords from inputs right after successful export
      setUserPassword("");
      setConfirmUserPassword("");
      setOwnerPassword("");
      setConfirmOwnerPassword("");
    } catch (err) {
      const parsed = parseBackendError(err);
      if (parsed.code === "TARGET_ALREADY_EXISTS" && !overwrite) {
        pendingOverwritePathRef.current = targetPath;
        setOverwriteDialogOpen(true);
        updateEncryptSession((prev) => ({
          ...prev,
          taskStatus: "idle",
          activeTaskId: null,
          progress: null,
        }));
        return;
      }
      updateEncryptSession((prev) => ({
        ...prev,
        taskStatus: "idle",
        activeTaskId: null,
        progress: null,
        errorMessage: formatLocalizedError(err, t),
      }));
    }
  };

  const handleRunEncrypt = async () => {
    if (!state.sourcePath || !canEncryptDoc || validationError) return;
    let target = state.outputPath.trim();
    if (!target) {
      const picked = await pickSaveFilePath({
        title: isZh ? "选择加密 PDF 输出位置" : "Save Encrypted PDF As",
        defaultPath: state.sourcePath.replace(/\.pdf$/i, "_encrypted.pdf"),
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!picked) return;
      target = picked;
      updateEncryptSession((prev) => ({ ...prev, outputPath: picked }));
    }
    await executeEncrypt(target, false);
  };

  const handleCancel = async () => {
    if (state.activeTaskId) {
      await cancelBackendTask(state.activeTaskId);
    }
  };

  return (
    <div className="pdf-crypto-shell">
      <div className="pdf-crypto-disclosure" role="note">
        <Info size={15} strokeWidth={1.75} style={{ flexShrink: 0, marginTop: 2 }} />
        <span>
          {isZh
            ? "默认使用行业标准 AES-256（PDF 2.0 / ISO 32000-2 R6）本地离线加密。打开密码保护文档读取访问；打印/复制/修改权限位依赖目标阅读器是否遵守标准，并非防截屏或硬 DRM。密码仅驻留在当前表单内存中，不会写入任何本地配置、历史或日志。"
            : "Encrypts locally offline using AES-256 (PDF 2.0 / ISO 32000-2 R6). An open password protects file access; print/copy/modify permission flags depend on viewer compliance. Passwords remain strictly in ephemeral component memory and are never persisted or logged."}
        </span>
      </div>

      <div className="pdf-crypto-grid">
        {/* Left Column: Source PDF & Detected Status */}
        <section className="pdf-crypto-card">
          <h3>
            <FolderOpen size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>{isZh ? "1. 选择源 PDF" : "1. Source PDF"}</span>
          </h3>

          <div className={`pdf-crypto-drop ${dropHover ? "is-hover" : ""}`}>
            <Lock size={24} strokeWidth={1.6} aria-hidden="true" />
            <p className="pdf-crypto-hint">
              {isZh ? "拖入本地 PDF 文件，或点击选择" : "Drop a local PDF here, or choose a file"}
            </p>
            <button
              type="button"
              className="btn btn-primary"
              disabled={state.taskStatus === "running" || state.inspectLoading}
              onClick={() => void handleBrowseInput()}
            >
              <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>
                {state.inspectLoading
                  ? isZh
                    ? "正在检查..."
                    : "Inspecting..."
                  : isZh
                    ? "选择 PDF 文件…"
                    : "Choose PDF…"}
              </span>
            </button>
          </div>

          {sec && (
            <div className="pdf-crypto-file-meta">
              <div className="pdf-crypto-file-name" title={sec.path}>
                {sec.fileName}
              </div>
              <div className="pdf-crypto-meta-row">
                <span className="mono">{formatBytes(sec.byteLength)}</span>
                {sec.pageCount !== null && (
                  <span>{isZh ? `${sec.pageCount} 页` : `${sec.pageCount} pages`}</span>
                )}
                {sec.status === "unencrypted" && (
                  <span className="pdf-crypto-pill is-ok">
                    {isZh ? "未加密 · 可加密" : "Unencrypted · Ready"}
                  </span>
                )}
                {(sec.status === "encrypted_password_required" ||
                  sec.status === "encrypted_owner_only") && (
                  <span className="pdf-crypto-pill is-warn">
                    {isZh
                      ? `已加密 (${sec.encryptionLabel ?? "Standard"})`
                      : `Already Encrypted (${sec.encryptionLabel ?? "Standard"})`}
                  </span>
                )}
                {sec.status === "unsupported_security" && (
                  <span className="pdf-crypto-pill is-error">
                    {isZh ? "不支持的安全策略" : "Unsupported Security"}
                  </span>
                )}
                {sec.status === "corrupt_or_invalid" && (
                  <span className="pdf-crypto-pill is-error">
                    {isZh ? "无效或损坏 PDF" : "Invalid / Corrupt PDF"}
                  </span>
                )}
              </div>

              {(sec.status === "encrypted_password_required" ||
                sec.status === "encrypted_owner_only") && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                  <p className="pdf-crypto-hint">
                    {isZh
                      ? "该文档已加密。请先使用「PDF 解除密码 (P16)」导出无密码副本，再重新设置新密码。"
                      : "This document is already encrypted. Unlock a copy with PDF Decrypt (P16) before applying new encryption."}
                  </p>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => sendPdfToTool(sec.path, "P16")}
                  >
                    <Unlock size={14} strokeWidth={1.75} aria-hidden="true" />
                    <span>{isZh ? "前往 P16 解除密码" : "Open in PDF Decrypt (P16)"}</span>
                  </button>
                </div>
              )}

              {sec.hasSignatures && (
                <p className="pdf-crypto-hint" style={{ color: "var(--status-warn-fg, #b45309)" }}>
                  {isZh
                    ? `检测到 ${Math.max(1, sec.signatureCount)} 处原有数字签名；加密导出新副本将使原有加密签名失效（原文件保持不变）。`
                    : `Detected ${Math.max(1, sec.signatureCount)} digital signature(s). Encrypting creates a new copy whose original signatures will be invalidated (source remains untouched).`}
                </p>
              )}
            </div>
          )}
        </section>

        {/* Right Column: Password, Permissions, Output */}
        <section className="pdf-crypto-card">
          <h3>
            <ShieldCheck size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>
              {isZh ? "2. 密码与权限设置（AES-256 R6）" : "2. Password & Permissions (AES-256 R6)"}
            </span>
          </h3>

          <div className="pdf-crypto-field">
            <label htmlFor="p15-user-pw">
              {isZh ? "打开密码（User Password）" : "Open Password (User Password)"}
            </label>
            <div className="pdf-crypto-pw-row">
              <input
                id="p15-user-pw"
                type={showUserPassword ? "text" : "password"}
                className="input"
                autoComplete="new-password"
                placeholder={
                  isZh
                    ? "支持中英文、符号与空格；打开 PDF 时需要输入"
                    : "Supports Unicode & symbols; required to open the PDF"
                }
                value={userPassword}
                onChange={(e) => setUserPassword(e.target.value)}
                disabled={state.taskStatus === "running"}
              />
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label={
                  showUserPassword
                    ? isZh
                      ? "隐藏打开密码"
                      : "Hide open password"
                    : isZh
                      ? "显示打开密码"
                      : "Show open password"
                }
                onClick={() => setShowUserPassword((v) => !v)}
              >
                {showUserPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          <div className="pdf-crypto-field">
            <label htmlFor="p15-user-pw-confirm">
              {isZh ? "确认打开密码" : "Confirm Open Password"}
            </label>
            <input
              id="p15-user-pw-confirm"
              type={showUserPassword ? "text" : "password"}
              className="input"
              autoComplete="new-password"
              placeholder={isZh ? "再次输入打开密码" : "Re-enter open password"}
              value={confirmUserPassword}
              onChange={(e) => setConfirmUserPassword(e.target.value)}
              disabled={state.taskStatus === "running"}
            />
            {userMismatch && confirmUserPassword.length > 0 && (
              <p className="pdf-crypto-hint is-error">
                {isZh ? "两次输入的打开密码不一致。" : "Open passwords do not match."}
              </p>
            )}
          </div>

          <label className="pdf-crypto-checkbox">
            <input
              type="checkbox"
              checked={useCustomOwnerPassword}
              onChange={(e) => {
                setUseCustomOwnerPassword(e.target.checked);
                if (!e.target.checked) {
                  setOwnerPassword("");
                  setConfirmOwnerPassword("");
                }
              }}
              disabled={state.taskStatus === "running"}
            />
            <span>
              {isZh
                ? "自定义独立权限密码（Owner Password；不勾选时自动生成强随机权限密码，避免不安全的空权限密码）"
                : "Set custom owner password (when unchecked, a strong random owner password is generated automatically)"}
            </span>
          </label>

          {useCustomOwnerPassword && (
            <div className="pdf-crypto-perm-grid">
              <div className="pdf-crypto-field">
                <label htmlFor="p15-owner-pw">{isZh ? "权限密码" : "Owner Password"}</label>
                <div className="pdf-crypto-pw-row">
                  <input
                    id="p15-owner-pw"
                    type={showOwnerPassword ? "text" : "password"}
                    className="input"
                    autoComplete="new-password"
                    placeholder={isZh ? "需与打开密码不同" : "Must differ from open password"}
                    value={ownerPassword}
                    onChange={(e) => setOwnerPassword(e.target.value)}
                    disabled={state.taskStatus === "running"}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    aria-label={
                      showOwnerPassword
                        ? isZh
                          ? "隐藏权限密码"
                          : "Hide owner password"
                        : isZh
                          ? "显示权限密码"
                          : "Show owner password"
                    }
                    onClick={() => setShowOwnerPassword((v) => !v)}
                  >
                    {showOwnerPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>
              <div className="pdf-crypto-field">
                <label htmlFor="p15-owner-pw-confirm">
                  {isZh ? "确认权限密码" : "Confirm Owner Password"}
                </label>
                <input
                  id="p15-owner-pw-confirm"
                  type={showOwnerPassword ? "text" : "password"}
                  className="input"
                  autoComplete="new-password"
                  placeholder={isZh ? "再次输入权限密码" : "Re-enter owner password"}
                  value={confirmOwnerPassword}
                  onChange={(e) => setConfirmOwnerPassword(e.target.value)}
                  disabled={state.taskStatus === "running"}
                />
              </div>
            </div>
          )}

          <div className="pdf-crypto-perm-grid">
            <div className="pdf-crypto-field">
              <label htmlFor="p15-print-perm">{isZh ? "打印权限" : "Printing"}</label>
              <select
                id="p15-print-perm"
                className="select"
                value={state.printPermission}
                onChange={(e) =>
                  updateEncryptSession((prev) => ({
                    ...prev,
                    printPermission: e.target.value as PdfPrintPermission,
                  }))
                }
                disabled={state.taskStatus === "running"}
              >
                <option value="full">{isZh ? "允许高清打印" : "High-resolution printing"}</option>
                <option value="low">{isZh ? "仅允许低分辨率打印" : "Low-resolution only"}</option>
                <option value="none">{isZh ? "禁止打印" : "Disallow printing"}</option>
              </select>
            </div>

            <div className="pdf-crypto-field">
              <label htmlFor="p15-modify-perm">{isZh ? "修改权限" : "Document Changes"}</label>
              <select
                id="p15-modify-perm"
                className="select"
                value={state.allowModify}
                onChange={(e) =>
                  updateEncryptSession((prev) => ({
                    ...prev,
                    allowModify: e.target.value as PdfModifyPermission,
                  }))
                }
                disabled={state.taskStatus === "running"}
              >
                <option value="none">{isZh ? "禁止修改" : "Disallow changes"}</option>
                <option value="annotate">
                  {isZh ? "仅允许批注与填表" : "Comments & form filling only"}
                </option>
                <option value="all">{isZh ? "允许全部修改" : "Allow all changes"}</option>
              </select>
            </div>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 20px" }}>
            <label className="pdf-crypto-checkbox">
              <input
                type="checkbox"
                checked={state.allowCopy}
                onChange={(e) =>
                  updateEncryptSession((prev) => ({ ...prev, allowCopy: e.target.checked }))
                }
                disabled={state.taskStatus === "running"}
              />
              <span>{isZh ? "允许复制文本与图像" : "Allow copying text & graphics"}</span>
            </label>
            <label className="pdf-crypto-checkbox">
              <input
                type="checkbox"
                checked={state.encryptMetadata}
                onChange={(e) =>
                  updateEncryptSession((prev) => ({ ...prev, encryptMetadata: e.target.checked }))
                }
                disabled={state.taskStatus === "running"}
              />
              <span>{isZh ? "加密文档元数据" : "Encrypt document metadata"}</span>
            </label>
          </div>

          <div className="pdf-crypto-field">
            <label htmlFor="p15-output-path">
              {isZh ? "输出加密副本路径（绝不覆盖源文件）" : "Encrypted Output Path"}
            </label>
            <div className="pdf-crypto-output-row">
              <input
                id="p15-output-path"
                type="text"
                className="input mono"
                value={state.outputPath}
                onChange={(e) =>
                  updateEncryptSession((prev) => ({ ...prev, outputPath: e.target.value }))
                }
                placeholder={isZh ? "选择加密 PDF 保存位置" : "Choose output .pdf path"}
                disabled={state.taskStatus === "running"}
              />
              <button
                type="button"
                className="btn"
                onClick={() => void handleBrowseOutput()}
                disabled={state.taskStatus === "running"}
              >
                <Save size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{isZh ? "另存为…" : "Save As…"}</span>
              </button>
            </div>
          </div>

          {validationError && canEncryptDoc && (
            <p className="pdf-crypto-hint is-error" role="status">
              {validationError}
            </p>
          )}

          {state.errorMessage && (
            <div className="pdf-banner pdf-banner-error" role="alert">
              <AlertTriangle size={15} strokeWidth={1.75} aria-hidden="true" />
              <span>{state.errorMessage}</span>
            </div>
          )}

          {state.taskStatus === "running" && state.progress && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                <span>{state.progress.detail}</span>
                <span className="mono">{Math.round(state.progress.percent)}%</span>
              </div>
              <progress value={state.progress.percent} max={100} style={{ width: "100%" }} />
            </div>
          )}

          <div className="pdf-crypto-actions">
            {state.taskStatus === "running" ? (
              <button type="button" className="btn" onClick={() => void handleCancel()}>
                <XCircle size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{isZh ? "取消任务" : "Cancel"}</span>
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canEncryptDoc || Boolean(validationError)}
                onClick={() => void handleRunEncrypt()}
              >
                <Lock size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{isZh ? "加密并导出 PDF" : "Encrypt & Save PDF"}</span>
              </button>
            )}
          </div>
        </section>
      </div>

      {state.lastResult && (
        <section className="pdf-crypto-result" role="status">
          <div className="pdf-crypto-result-header">
            <CheckCircle2 size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>
              {isZh
                ? `加密完成并已通过独立校验：${state.lastResult.algorithm} · ${state.lastResult.pageCount} 页 · ${formatBytes(state.lastResult.byteLength)}`
                : `Encrypted & verified: ${state.lastResult.algorithm} · ${state.lastResult.pageCount} pages · ${formatBytes(state.lastResult.byteLength)}`}
            </span>
          </div>
          <div className="mono" style={{ fontSize: 11.5, wordBreak: "break-all" }}>
            {state.lastResult.outputPath}
          </div>
          {state.lastResult.usedGeneratedOwnerPassword && (
            <p className="pdf-crypto-hint">
              {isZh
                ? "已自动生成高强度随机权限密码（Owner Password），避免产生不安全的空权限密码文件。"
                : "A strong random owner password was generated automatically to avoid an insecure empty owner password."}
            </p>
          )}
          <div className="pdf-crypto-result-actions">
            <button
              type="button"
              className="btn"
              onClick={() =>
                void openLocalDirectory(parentDirectoryOf(state.lastResult!.outputPath))
              }
            >
              <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{isZh ? "打开所在文件夹" : "Open Folder"}</span>
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => sendPdfToTool(state.lastResult!.outputPath, "P16")}
            >
              <Unlock size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{isZh ? "送至 P16 验证解锁" : "Verify in PDF Decrypt (P16)"}</span>
            </button>
          </div>
        </section>
      )}

      <ConfirmDialog
        open={overwriteDialogOpen}
        title={isZh ? "目标文件已存在" : "Target File Already Exists"}
        body={
          isZh
            ? `目标路径已存在文件：\n${pendingOverwritePathRef.current ?? ""}\n是否确认覆盖？源 PDF 绝不会被覆盖。`
            : `A file already exists at:\n${pendingOverwritePathRef.current ?? ""}\nOverwrite it? Your source PDF is never overwritten.`
        }
        confirmLabel={isZh ? "确认覆盖" : "Overwrite"}
        cancelLabel={isZh ? "取消" : "Cancel"}
        onCancel={() => {
          setOverwriteDialogOpen(false);
          pendingOverwritePathRef.current = null;
        }}
        onConfirm={() => {
          const target = pendingOverwritePathRef.current;
          setOverwriteDialogOpen(false);
          pendingOverwritePathRef.current = null;
          if (target) {
            void executeEncrypt(target, true);
          }
        }}
      />
    </div>
  );
}
