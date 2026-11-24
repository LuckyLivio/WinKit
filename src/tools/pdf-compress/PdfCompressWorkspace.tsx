import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  FolderOpen,
  Info,
  Minimize2,
  Save,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useI18n } from "../../i18n/I18nContext";
import { usePdfSession } from "../../lib/pdfSessionStore";
import {
  bindDisposableListener,
  cancelBackendTask,
  compressPdf,
  formatLocalizedError,
  inspectPdfDocument,
  openLocalDirectory,
  parseBackendError,
  pickSaveFilePath,
  pickSingleFile,
  subscribeFileDrop,
  subscribePdfTaskProgress,
  suggestSafeSiblingPath,
  type PdfCompressMode,
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

export function PdfCompressWorkspace() {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const {
    pdfSession,
    updateCompressSession,
    openInPdfReader,
    sendPdfToTool,
    pendingToolIntake,
    clearPendingToolIntake,
  } = usePdfSession();
  const state = pdfSession.compress;

  const [dropHover, setDropHover] = useState(false);
  const [overwriteDialogOpen, setOverwriteDialogOpen] = useState(false);
  const pendingOverwritePathRef = useRef<string | null>(null);
  const inspectGenRef = useRef(0);

  const loadSourcePdf = useCallback(
    async (path: string) => {
      const gen = ++inspectGenRef.current;
      updateCompressSession((prev) => ({
        ...prev,
        sourcePath: path,
        inspection: null,
        inspectLoading: true,
        lastResult: null,
        errorMessage: null,
      }));
      try {
        const info = await inspectPdfDocument(path);
        if (inspectGenRef.current !== gen) return;
        const suggested =
          (await suggestSafeSiblingPath(info.path, "_compressed", "pdf").catch(() => null)) ??
          info.path.replace(/\.pdf$/i, "_compressed.pdf");
        if (inspectGenRef.current !== gen) return;
        updateCompressSession((prev) => ({
          ...prev,
          sourcePath: info.path,
          inspection: info,
          inspectLoading: false,
          outputPath: suggested,
          errorMessage: null,
        }));
      } catch (err) {
        if (inspectGenRef.current !== gen) return;
        updateCompressSession((prev) => ({
          ...prev,
          inspectLoading: false,
          errorMessage: formatLocalizedError(err, t),
        }));
      }
    },
    [t, updateCompressSession],
  );

  useEffect(() => {
    if (pendingToolIntake?.toolId !== "P14") return;
    const target = pendingToolIntake.path;
    clearPendingToolIntake();
    void loadSourcePdf(target);
  }, [pendingToolIntake, clearPendingToolIntake, loadSourcePdf]);

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
      "p14-drop",
    );
  }, [loadSourcePdf]);

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribePdfTaskProgress((ev) => {
          if (ev.toolId !== "P14") return;
          updateCompressSession((prev) =>
            prev.activeTaskId && ev.taskId === prev.activeTaskId ? { ...prev, progress: ev } : prev,
          );
        }),
      "p14-progress",
    );
  }, [updateCompressSession]);

  const handleBrowseInput = async () => {
    const picked = await pickSingleFile({
      title: isZh ? "选择需要压缩的 PDF 文件" : "Select PDF to Compress",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (picked) {
      await loadSourcePdf(picked);
    }
  };

  const handleBrowseOutput = async () => {
    const picked = await pickSaveFilePath({
      title: isZh ? "选择压缩后 PDF 保存路径" : "Save Compressed PDF As",
      defaultPath: state.outputPath || undefined,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (picked) {
      updateCompressSession((prev) => ({ ...prev, outputPath: picked }));
    }
  };

  const executeCompress = async (targetPath: string, overwrite: boolean) => {
    if (!state.sourcePath) return;
    const taskId = `p14-${Date.now()}`;
    updateCompressSession((prev) => ({
      ...prev,
      taskStatus: "running",
      activeTaskId: taskId,
      progress: {
        taskId,
        toolId: "P14",
        current: 0,
        total: 100,
        percent: 0,
        detail: isZh ? "正在分析 PDF 对象..." : "Analyzing PDF streams...",
      },
      lastResult: null,
      errorMessage: null,
    }));

    try {
      const result = await compressPdf(taskId, {
        inputPath: state.sourcePath,
        outputPath: targetPath,
        overwrite,
        mode: state.mode,
      });
      updateCompressSession((prev) => ({
        ...prev,
        outputPath: result.outputPath,
        taskStatus: "idle",
        activeTaskId: null,
        progress: null,
        lastResult: result,
        errorMessage: null,
      }));
    } catch (err) {
      const parsed = parseBackendError(err);
      if (parsed.code === "TARGET_ALREADY_EXISTS" && !overwrite) {
        pendingOverwritePathRef.current = targetPath;
        setOverwriteDialogOpen(true);
        updateCompressSession((prev) => ({
          ...prev,
          taskStatus: "idle",
          activeTaskId: null,
          progress: null,
        }));
        return;
      }
      updateCompressSession((prev) => ({
        ...prev,
        taskStatus: "idle",
        activeTaskId: null,
        progress: null,
        errorMessage: formatLocalizedError(err, t),
      }));
    }
  };

  const handleRunCompress = async () => {
    if (!state.sourcePath || !state.inspection) return;
    let target = state.outputPath.trim();
    if (!target) {
      const picked = await pickSaveFilePath({
        title: isZh ? "选择压缩后 PDF 保存路径" : "Save Compressed PDF As",
        defaultPath: state.sourcePath.replace(/\.pdf$/i, "_compressed.pdf"),
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!picked) return;
      target = picked;
      updateCompressSession((prev) => ({ ...prev, outputPath: picked }));
    }
    await executeCompress(target, false);
  };

  const handleCancel = async () => {
    if (state.activeTaskId) {
      await cancelBackendTask(state.activeTaskId);
    }
  };

  const modeOptions: Array<{ id: PdfCompressMode; title: string; desc: string }> = [
    {
      id: "lossless",
      title: isZh ? "无损结构优化" : "Lossless Structure",
      desc: isZh
        ? "仅重压 Flate 流、生成对象流并清理未引用资源，不修改任何图像像素，适合纯文字、矢量与排版稿。"
        : "Recompresses Flate & object streams and removes unreferenced objects without altering any image pixels.",
    },
    {
      id: "balanced",
      title: isZh ? "均衡压缩（推荐）" : "Balanced (Recommended)",
      desc: isZh
        ? "保留全部文字、矢量与透明遮罩，仅对大尺寸不透明位图温和降采样与重压（约 150 DPI / 质量 78），并执行结构优化。"
        : "Keeps crisp text, vectors & masks while downsampling/recompressing oversized opaque bitmaps (~150 DPI / Q78).",
    },
    {
      id: "smallest",
      title: isZh ? "最小体积" : "Smallest Size",
      desc: isZh
        ? "对内嵌大位图采用更积极的降采样与重压（约 110 DPI / 质量 62），仍绝不将文字页整页栅格化为图片。"
        : "Aggressively optimizes large embedded photos (~110 DPI / Q62) while never rasterizing text or vector pages.",
    },
  ];

  const info = state.inspection;

  return (
    <div className="pdf-crypto-shell">
      <div className="pdf-crypto-disclosure" role="note">
        <Info size={15} strokeWidth={1.75} style={{ flexShrink: 0, marginTop: 2 }} />
        <span>
          {isZh
            ? "压缩全程在本地离线完成，绝不整页栅格化为图片，保留可选中文字、字体、矢量图形、超链接与页面方向。若原文件已高度压缩且结果未变小，自动保留原样副本，绝不产生反而增大的输出。"
            : "Runs 100% offline without rasterizing pages—preserving selectable text, vectors, links, and page orientations. If an already-compact PDF cannot be shrunk further, the original content is preserved verbatim without bloat."}
        </span>
      </div>

      <div className="pdf-crypto-grid">
        <section className="pdf-crypto-card">
          <h3>
            <FolderOpen size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>{isZh ? "1. 选择源 PDF" : "1. Source PDF"}</span>
          </h3>

          <div className={`pdf-crypto-drop ${dropHover ? "is-hover" : ""}`}>
            <Minimize2 size={24} strokeWidth={1.6} aria-hidden="true" />
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
                    ? "正在读取..."
                    : "Inspecting..."
                  : isZh
                    ? "选择 PDF 文件…"
                    : "Choose PDF…"}
              </span>
            </button>
          </div>

          {info && (
            <div className="pdf-crypto-file-meta">
              <div className="pdf-crypto-file-name" title={info.path}>
                {info.fileName}
              </div>
              <div className="pdf-crypto-meta-row">
                <span className="mono">{formatBytes(info.byteLength)}</span>
                <span>{isZh ? `${info.pageCount} 页` : `${info.pageCount} pages`}</span>
                <span className="pdf-crypto-pill is-ok">
                  {info.hasTextLayer
                    ? isZh
                      ? "含可选文字层"
                      : "Has text layer"
                    : isZh
                      ? "疑似扫描件/图片型"
                      : "Likely scanned/image"}
                </span>
              </div>
              {info.hasSignatures && (
                <p className="pdf-crypto-hint" style={{ color: "var(--status-warn-fg, #b45309)" }}>
                  {isZh
                    ? "检测到原有数字签名；压缩导出新副本会使原有加密签名失效（原文件不受影响）。"
                    : "Original digital signatures detected; compressing a new copy invalidates cryptographic signatures (source untouched)."}
                </p>
              )}
            </div>
          )}
        </section>

        <section className="pdf-crypto-card">
          <h3>
            <Minimize2 size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>{isZh ? "2. 选择压缩模式与输出" : "2. Compression Mode & Output"}</span>
          </h3>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }} role="radiogroup">
            {modeOptions.map((opt) => (
              <label
                key={opt.id}
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "flex-start",
                  padding: "10px 12px",
                  borderRadius: "var(--radius-sm)",
                  border:
                    state.mode === opt.id
                      ? "1.5px solid var(--accent)"
                      : "1px solid var(--border-subtle)",
                  background: state.mode === opt.id ? "var(--accent-soft)" : "var(--bg-subtle)",
                  cursor: "pointer",
                }}
              >
                <input
                  type="radio"
                  name="p14-mode"
                  value={opt.id}
                  checked={state.mode === opt.id}
                  onChange={() => updateCompressSession((prev) => ({ ...prev, mode: opt.id }))}
                  disabled={state.taskStatus === "running"}
                  style={{ marginTop: 3 }}
                />
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-primary)" }}>
                    {opt.title}
                  </div>
                  <div className="pdf-crypto-hint" style={{ marginTop: 2 }}>
                    {opt.desc}
                  </div>
                </div>
              </label>
            ))}
          </div>

          <div className="pdf-crypto-field">
            <label htmlFor="p14-output-path">
              {isZh ? "压缩后副本保存路径（绝不覆盖源文件）" : "Compressed Output Path"}
            </label>
            <div className="pdf-crypto-output-row">
              <input
                id="p14-output-path"
                type="text"
                className="input mono"
                value={state.outputPath}
                onChange={(e) =>
                  updateCompressSession((prev) => ({ ...prev, outputPath: e.target.value }))
                }
                placeholder={isZh ? "选择压缩后 PDF 输出路径" : "Choose compressed .pdf path"}
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
                type="button"
                className="btn btn-primary"
                disabled={!info}
                onClick={() => void handleRunCompress()}
              >
                <Minimize2 size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{isZh ? "开始压缩并导出" : "Compress & Save PDF"}</span>
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
              {state.lastResult.keptOriginal
                ? isZh
                  ? `已完成检查：原文件已高度压缩，保留原样副本（${formatBytes(state.lastResult.outputBytes)}，共 ${state.lastResult.pageCount} 页）`
                  : `Already tightly compressed: preserved original verbatim (${formatBytes(state.lastResult.outputBytes)}, ${state.lastResult.pageCount} pages)`
                : isZh
                  ? `压缩完成：${formatBytes(state.lastResult.originalBytes)} → ${formatBytes(state.lastResult.outputBytes)}（节省 ${formatBytes(state.lastResult.savedBytes)} / ${state.lastResult.savedPercent.toFixed(1)}%）`
                  : `Compressed: ${formatBytes(state.lastResult.originalBytes)} → ${formatBytes(state.lastResult.outputBytes)} (saved ${formatBytes(state.lastResult.savedBytes)} / ${state.lastResult.savedPercent.toFixed(1)}%)`}
            </span>
          </div>
          <div className="mono" style={{ fontSize: 11.5, wordBreak: "break-all" }}>
            {state.lastResult.outputPath}
          </div>
          <div className="pdf-crypto-meta-row">
            <span className="pdf-crypto-pill">
              {isZh ? `共 ${state.lastResult.pageCount} 页` : `${state.lastResult.pageCount} pages`}
            </span>
            {state.lastResult.imagesOptimized > 0 && (
              <span className="pdf-crypto-pill is-ok">
                {isZh
                  ? `已优化 ${state.lastResult.imagesOptimized} 张内嵌位图（降采样 ${state.lastResult.imagesDownsampled} 张）`
                  : `Optimized ${state.lastResult.imagesOptimized} embedded image(s) (${state.lastResult.imagesDownsampled} downsampled)`}
              </span>
            )}
            <span className="pdf-crypto-pill is-ok">
              {state.lastResult.hasTextLayer
                ? isZh
                  ? "可选中文字层已保留"
                  : "Selectable text preserved"
                : isZh
                  ? "纯图像/扫描页"
                  : "Image/scanned pages"}
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
              onClick={() => sendPdfToTool(state.lastResult!.outputPath, "P15")}
            >
              <span>{isZh ? "继续前往 P15 加密" : "Continue to Encrypt (P15)"}</span>
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
            void executeCompress(target, true);
          }
        }}
      />
    </div>
  );
}
