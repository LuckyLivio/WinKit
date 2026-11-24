import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Eye,
  EyeOff,
  FolderOpen,
  Info,
  Lock,
  Save,
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
  decryptPdf,
  formatLocalizedError,
  inspectPdfSecurity,
  openLocalDirectory,
  parseBackendError,
  pickSaveFilePath,
  pickSingleFile,
  subscribeFileDrop,
  subscribePdfTaskProgress,
  suggestSafeSiblingPath,
} from "../../lib/tauriBridge";
import "../pdf-encrypt/pdfCrypto.css";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function parentDirectoryOf(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
  return idx > 0 ? filePath.slice(0, idx) : filePath;
}

export function PdfDecryptWorkspace() {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const {
    pdfSession,
    updateDecryptSession,
    openInPdfReader,
    sendPdfToTool,
    pendingToolIntake,
    clearPendingToolIntake,
  } = usePdfSession();
  const state = pdfSession.decrypt;

  // Password lives strictly in ephemeral component state — never stored in session or localStorage.
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [dropHover, setDropHover] = useState(false);
  const [overwriteDialogOpen, setOverwriteDialogOpen] = useState(false);
  const pendingOverwritePathRef = useRef<string | null>(null);
  const passwordInputRef = useRef<HTMLInputElement | null>(null);
  const inspectGenRef = useRef(0);

  useEffect(() => {
    return () => {
      setPassword("");
    };
  }, []);

  const loadSourcePdf = useCallback(
    async (path: string) => {
      const gen = ++inspectGenRef.current;
      setPassword("");

      updateDecryptSession((prev) => ({
        ...prev,
        sourcePath: path,
        securityStatus: null,
        inspectLoading: true,
        lastResult: null,
        errorCode: null,
        errorMessage: null,
      }));

      try {
        const status = await inspectPdfSecurity(path);
        if (inspectGenRef.current !== gen) return;
        const suggested =
          (await suggestSafeSiblingPath(status.path, "_decrypted", "pdf").catch(() => null)) ??
          status.path.replace(/\.pdf$/i, "_decrypted.pdf");
        if (inspectGenRef.current !== gen) return;
        updateDecryptSession((prev) => ({
          ...prev,
          sourcePath: status.path,
          securityStatus: status,
          inspectLoading: false,
          outputPath: suggested,
          errorCode: null,
          errorMessage: null,
        }));
        if (status.isEncrypted) {
          setTimeout(() => passwordInputRef.current?.focus(), 0);
        }
      } catch (err) {
        if (inspectGenRef.current !== gen) return;
        const parsed = parseBackendError(err);
        updateDecryptSession((prev) => ({
          ...prev,
          inspectLoading: false,
          errorCode: parsed.code,
          errorMessage: formatLocalizedError(err, t),
        }));
      }
    },
    [t, updateDecryptSession],
  );

  // Consume cross-tool PDF handoff (e.g. from C08 locked PDF banner or P15 verify link)
  useEffect(() => {
    if (pendingToolIntake?.toolId !== "P16") return;
    const target = pendingToolIntake.path;
    clearPendingToolIntake();
    void loadSourcePdf(target);
  }, [pendingToolIntake, clearPendingToolIntake, loadSourcePdf]);

  // Native drag-and-drop
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
      "p16-drop",
    );
  }, [loadSourcePdf]);

  // Progress listener
  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribePdfTaskProgress((ev) => {
          if (ev.toolId !== "P16") return;
          updateDecryptSession((prev) =>
            prev.activeTaskId && ev.taskId === prev.activeTaskId ? { ...prev, progress: ev } : prev,
          );
        }),
      "p16-progress",
    );
  }, [updateDecryptSession]);

  const handleBrowseInput = async () => {
    const picked = await pickSingleFile({
      title: isZh ? "选择需要解除密码的加密 PDF" : "Select Encrypted PDF",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (picked) {
      await loadSourcePdf(picked);
    }
  };

  const handleBrowseOutput = async () => {
    const picked = await pickSaveFilePath({
      title: isZh ? "选择无密码 PDF 副本保存位置" : "Save Unlocked PDF Copy As",
      defaultPath: state.outputPath || undefined,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (picked) {
      updateDecryptSession((prev) => ({ ...prev, outputPath: picked }));
    }
  };

  const sec = state.securityStatus;
  const canDecryptDoc =
    sec?.status === "encrypted_password_required" || sec?.status === "encrypted_owner_only";
  const needsNonEmptyPassword = sec?.status === "encrypted_password_required";

  const executeDecrypt = async (targetPath: string, overwrite: boolean) => {
    if (!state.sourcePath) return;
    const taskId = `p16-${Date.now()}`;
    updateDecryptSession((prev) => ({
      ...prev,
      taskStatus: "running",
      activeTaskId: taskId,
      progress: {
        taskId,
        toolId: "P16",
        current: 0,
        total: 100,
        percent: 0,
        detail: isZh ? "正在验证密码并解密..." : "Verifying password and decrypting...",
      },
      lastResult: null,
      errorCode: null,
      errorMessage: null,
    }));

    try {
      const result = await decryptPdf(taskId, {
        inputPath: state.sourcePath,
        outputPath: targetPath,
        overwrite,
        password,
      });
      updateDecryptSession((prev) => ({
        ...prev,
        outputPath: result.outputPath,
        taskStatus: "idle",
        activeTaskId: null,
        progress: null,
        lastResult: result,
        errorCode: null,
        errorMessage: null,
      }));
      // Wipe password from memory right after successful unlock
      setPassword("");
    } catch (err) {
      const parsed = parseBackendError(err);
      if (parsed.code === "TARGET_ALREADY_EXISTS" && !overwrite) {
        pendingOverwritePathRef.current = targetPath;
        setOverwriteDialogOpen(true);
        updateDecryptSession((prev) => ({
          ...prev,
          taskStatus: "idle",
          activeTaskId: null,
          progress: null,
        }));
        return;
      }
      updateDecryptSession((prev) => ({
        ...prev,
        taskStatus: "idle",
        activeTaskId: null,
        progress: null,
        errorCode: parsed.code,
        errorMessage: formatLocalizedError(err, t),
      }));
      if (parsed.code === "PDF_WRONG_PASSWORD") {
        setTimeout(() => {
          passwordInputRef.current?.focus();
          passwordInputRef.current?.select();
        }, 0);
      }
    }
  };

  const handleRunDecrypt = async () => {
    if (!state.sourcePath || !canDecryptDoc) return;
    if (needsNonEmptyPassword && password.length === 0) {
      updateDecryptSession((prev) => ({
        ...prev,
        errorCode: "PDF_PASSWORD_REQUIRED",
        errorMessage: isZh
          ? "请输入该 PDF 的已知打开密码或权限密码。"
          : "Enter the known open or owner password for this PDF.",
      }));
      passwordInputRef.current?.focus();
      return;
    }
    let target = state.outputPath.trim();
    if (!target) {
      const picked = await pickSaveFilePath({
        title: isZh ? "选择无密码 PDF 副本保存位置" : "Save Unlocked PDF Copy As",
        defaultPath: state.sourcePath.replace(/\.pdf$/i, "_decrypted.pdf"),
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!picked) return;
      target = picked;
      updateDecryptSession((prev) => ({ ...prev, outputPath: picked }));
    }
    await executeDecrypt(target, false);
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
            ? "仅在您提供已知合法密码的前提下于本地离线导出无密码副本，绝不进行暴力破解或密码猜测。导出前会自动通过 QPDF 与内置 PDFium 双重验证输出文件无需密码即可打开；源加密文件保持不变。"
            : "Creates an unlocked copy offline strictly using a known password you provide—no brute-force or password guessing. Every output is independently verified to open without a password before saving, while leaving your original file untouched."}
        </span>
      </div>

      <div className="pdf-crypto-grid">
        {/* Left Column: Source PDF & Status Classification */}
        <section className="pdf-crypto-card">
          <h3>
            <FolderOpen size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>{isZh ? "1. 选择加密 PDF" : "1. Encrypted PDF"}</span>
          </h3>

          <div className={`pdf-crypto-drop ${dropHover ? "is-hover" : ""}`}>
            <Unlock size={24} strokeWidth={1.6} aria-hidden="true" />
            <p className="pdf-crypto-hint">
              {isZh
                ? "拖入受密码保护的 PDF，或点击选择"
                : "Drop a protected PDF here, or choose a file"}
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
                    ? "正在检测加密状态..."
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
                {sec.encryptionLabel && (
                  <span className="pdf-crypto-pill is-warn">{sec.encryptionLabel}</span>
                )}
                {sec.status === "encrypted_password_required" && (
                  <span className="pdf-crypto-pill is-warn">
                    {isZh ? "需要打开密码" : "Open Password Required"}
                  </span>
                )}
                {sec.status === "encrypted_owner_only" && (
                  <span className="pdf-crypto-pill is-warn">
                    {isZh ? "仅权限限制（空打开密码）" : "Owner Restrictions Only"}
                  </span>
                )}
                {sec.status === "unencrypted" && (
                  <span className="pdf-crypto-pill is-ok">{isZh ? "未加密" : "Not Encrypted"}</span>
                )}
                {sec.status === "unsupported_security" && (
                  <span className="pdf-crypto-pill is-error">
                    {isZh ? "非标准安全策略" : "Unsupported Security"}
                  </span>
                )}
                {sec.status === "corrupt_or_invalid" && (
                  <span className="pdf-crypto-pill is-error">
                    {isZh ? "无效或损坏 PDF" : "Invalid / Corrupt PDF"}
                  </span>
                )}
              </div>

              {sec.status === "unencrypted" && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
                  <p className="pdf-crypto-hint" style={{ width: "100%" }}>
                    {isZh
                      ? "该 PDF 未加密，可以直接预览或前往 P15 添加密码。"
                      : "This PDF is not encrypted. Open it in the previewer or encrypt it with P15."}
                  </p>
                  <button type="button" className="btn" onClick={() => openInPdfReader(sec.path)}>
                    <BookOpen size={14} strokeWidth={1.75} aria-hidden="true" />
                    <span>{isZh ? "内置预览 (C08)" : "Preview (C08)"}</span>
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => sendPdfToTool(sec.path, "P15")}
                  >
                    <Lock size={14} strokeWidth={1.75} aria-hidden="true" />
                    <span>{isZh ? "前往 P15 加密" : "Encrypt (P15)"}</span>
                  </button>
                </div>
              )}

              {sec.status === "unsupported_security" && (
                <p className="pdf-crypto-hint is-error">
                  {isZh
                    ? "该文件使用非标准安全处理器（例如数字证书或 DRM），无法通过密码解除。"
                    : "This document uses a non-standard security handler (such as certificate or DRM protection) and cannot be unlocked by password."}
                </p>
              )}

              {sec.status === "corrupt_or_invalid" && (
                <p className="pdf-crypto-hint is-error">
                  {isZh
                    ? "所选文件不是有效的 PDF 文档，或内部结构已损坏。"
                    : "This file is not a valid PDF document or its structure is corrupted."}
                </p>
              )}
            </div>
          )}
        </section>

        {/* Right Column: Password Entry & Export */}
        <section className="pdf-crypto-card">
          <h3>
            <Unlock size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>
              {isZh ? "2. 输入已知密码并导出无密码副本" : "2. Enter Known Password & Export"}
            </span>
          </h3>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleRunDecrypt();
            }}
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
            <div className="pdf-crypto-field">
              <label htmlFor="p16-password">
                {sec?.status === "encrypted_owner_only"
                  ? isZh
                    ? "权限密码（可选，留空可移除默认限制或输入已知权限密码）"
                    : "Owner Password (optional for owner-restriction-only PDFs)"
                  : isZh
                    ? "已知打开密码或权限密码"
                    : "Known Open or Owner Password"}
              </label>
              <div className="pdf-crypto-pw-row">
                <input
                  ref={passwordInputRef}
                  id="p16-password"
                  type={showPassword ? "text" : "password"}
                  className="input"
                  autoComplete="current-password"
                  placeholder={
                    isZh
                      ? "输入已知密码（支持中文、符号、大小写敏感）"
                      : "Enter known password (case-sensitive, Unicode supported)"
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={!canDecryptDoc || state.taskStatus === "running"}
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  aria-label={
                    showPassword
                      ? isZh
                        ? "隐藏密码"
                        : "Hide password"
                      : isZh
                        ? "显示密码"
                        : "Show password"
                  }
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              <p className="pdf-crypto-hint">
                {isZh
                  ? "支持常见 RC4-40 / RC4-128 / AES-128 / AES-256（R5/R6）标准密码加密 PDF。密码仅在内存中通过安全管道传递，不会写入命令行参数或磁盘。"
                  : "Supports Standard RC4-40, RC4-128, AES-128, and AES-256 (R5/R6) PDFs. Passwords travel strictly in memory—never via command-line arguments or temp files."}
              </p>
            </div>

            <div className="pdf-crypto-field">
              <label htmlFor="p16-output-path">
                {isZh ? "无密码副本保存路径（绝不覆盖源文件）" : "Unlocked Output Path"}
              </label>
              <div className="pdf-crypto-output-row">
                <input
                  id="p16-output-path"
                  type="text"
                  className="input mono"
                  value={state.outputPath}
                  onChange={(e) =>
                    updateDecryptSession((prev) => ({ ...prev, outputPath: e.target.value }))
                  }
                  placeholder={isZh ? "选择解密后 PDF 的保存路径" : "Choose unlocked .pdf path"}
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
                  type="submit"
                  className="btn btn-primary"
                  disabled={!canDecryptDoc || (needsNonEmptyPassword && password.length === 0)}
                >
                  <Unlock size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{isZh ? "解除密码并导出副本" : "Remove Password & Save Copy"}</span>
                </button>
              )}
            </div>
          </form>
        </section>
      </div>

      {state.lastResult && (
        <section className="pdf-crypto-result" role="status">
          <div className="pdf-crypto-result-header">
            <CheckCircle2 size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>
              {isZh
                ? `解密完成并已独立验证可无密码打开：${state.lastResult.pageCount} 页 · ${formatBytes(state.lastResult.byteLength)}`
                : `Unlocked & verified openable without password: ${state.lastResult.pageCount} pages · ${formatBytes(state.lastResult.byteLength)}`}
            </span>
          </div>
          <div className="mono" style={{ fontSize: 11.5, wordBreak: "break-all" }}>
            {state.lastResult.outputPath}
          </div>
          <div className="pdf-crypto-meta-row">
            {state.lastResult.originalEncryption && (
              <span className="pdf-crypto-pill">
                {isZh
                  ? `原加密：${state.lastResult.originalEncryption}`
                  : `Original: ${state.lastResult.originalEncryption}`}
              </span>
            )}
            <span className="pdf-crypto-pill is-ok">
              {state.lastResult.hasTextLayer
                ? isZh
                  ? "可选中文本层已保留"
                  : "Selectable text preserved"
                : isZh
                  ? "无文本层（扫描/图片型）"
                  : "No text layer (scanned/image)"}
            </span>
          </div>
          <div className="pdf-crypto-result-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => openInPdfReader(state.lastResult!.outputPath)}
            >
              <BookOpen size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{isZh ? "在内置预览 (C08) 中打开" : "Open in PDF Preview (C08)"}</span>
            </button>
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
          </div>
        </section>
      )}

      <ConfirmDialog
        open={overwriteDialogOpen}
        title={isZh ? "目标文件已存在" : "Target File Already Exists"}
        body={
          isZh
            ? `目标路径已存在文件：\n${pendingOverwritePathRef.current ?? ""}\n是否确认覆盖？源加密 PDF 绝不会被覆盖。`
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
            void executeDecrypt(target, true);
          }
        }}
      />
    </div>
  );
}
