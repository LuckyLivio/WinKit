import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  FileSearch,
  FolderOpen,
  Info,
  Lock,
  Save,
  ScanText,
  Square,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useI18n } from "../../i18n/I18nContext";
import { usePdfSession } from "../../lib/pdfSessionStore";
import {
  bindDisposableListener,
  cancelBackendTask,
  formatLocalizedError,
  getOcrEngineStatus,
  inspectSearchablePdfPages,
  makePdfSearchable,
  openLocalDirectory,
  parseBackendError,
  pickSaveFilePath,
  pickSingleFile,
  renderPdfPage,
  subscribeFileDrop,
  subscribePdfTaskProgress,
  suggestSafeSiblingPath,
  type SearchablePdfPageOutcome,
} from "../../lib/tauriBridge";
import { parseClientPageRanges } from "../pdf-shared/pageRangeUtils";
import "../../components/PdfReaderView.css";
import "../extract-text/extractText.css";
import "./pdfSearchable.css";

function getParentDir(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx > 0 ? path.slice(0, idx) : path;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function PdfSearchableWorkspace() {
  const { locale, t } = useI18n();
  const zh = locale === "zh-CN";
  const {
    pdfSession,
    updateSearchablePdfSession,
    openInPdfReader,
    sendPdfToTool,
    pendingToolIntake,
    clearPendingToolIntake,
  } = usePdfSession();
  const st = pdfSession.searchablePdf;

  const [thumbDataUrl, setThumbDataUrl] = useState<string | null>(null);
  const [overwritePending, setOverwritePending] = useState<string | null>(null);
  const stateRef = useRef(st);
  stateRef.current = st;
  const seqRef = useRef(1);

  // Load OCR runtime readiness once
  useEffect(() => {
    let active = true;
    getOcrEngineStatus()
      .then((status) => {
        if (!active) return;
        updateSearchablePdfSession((prev) => ({ ...prev, engineStatus: status }));
      })
      .catch((err) => {
        if (!active) return;
        updateSearchablePdfSession((prev) => ({
          ...prev,
          engineStatus: {
            ready: false,
            engineName: "RapidOCR PP-OCRv4 mobile",
            runtimeVersion: null,
            ocrDir: null,
            error: formatLocalizedError(err, t),
          },
        }));
      });
    return () => {
      active = false;
    };
  }, [t, updateSearchablePdfSession]);

  const openPdfPath = useCallback(
    async (path: string) => {
      updateSearchablePdfSession((prev) => ({
        ...prev,
        sourcePath: path,
        inspectLoading: true,
        encryptedError: false,
        lastResult: null,
        notice: null,
        errorMessage: null,
      }));
      setThumbDataUrl(null);

      try {
        const res = await inspectSearchablePdfPages(path);
        const suggested = await suggestSafeSiblingPath(path, "_searchable", "pdf").catch(() => "");
        updateSearchablePdfSession((prev) => ({
          ...prev,
          sourcePath: res.inspection.path,
          inspectResult: res,
          inspectLoading: false,
          encryptedError: res.inspection.isEncrypted,
          outputPath: suggested || prev.outputPath,
          scope: "all",
          pageRange: "",
          lastResult: null,
          errorMessage: null,
        }));
      } catch (err) {
        const parsed = parseBackendError(err);
        updateSearchablePdfSession((prev) => ({
          ...prev,
          inspectResult: null,
          inspectLoading: false,
          encryptedError: parsed.code === "PDF_PASSWORD_REQUIRED",
          errorMessage: formatLocalizedError(err, t),
        }));
      }
    },
    [t, updateSearchablePdfSession],
  );

  // Consume handoff from C08 "转为可搜索 PDF (P04)"
  useEffect(() => {
    if (pendingToolIntake?.toolId === "P04") {
      const target = pendingToolIntake.path;
      clearPendingToolIntake();
      void openPdfPath(target);
    }
  }, [clearPendingToolIntake, openPdfPath, pendingToolIntake]);

  // Render page 1 thumbnail for visual orientation
  useEffect(() => {
    const path = st.inspectResult?.inspection.path;
    if (!path) {
      setThumbDataUrl(null);
      return;
    }
    let active = true;
    renderPdfPage({ path, pageNumber: 1, targetWidthPx: 220, extraRotationCw: 0 })
      .then((rendered) => {
        if (active) setThumbDataUrl(rendered.dataUrl);
      })
      .catch(() => {
        if (active) setThumbDataUrl(null);
      });
    return () => {
      active = false;
    };
  }, [st.inspectResult?.inspection.path]);

  // Support dragging a PDF directly into P04
  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onDropPaths: (paths) => {
            if (stateRef.current.taskStatus === "running") return;
            const pdf = paths.find((p) => p.toLowerCase().endsWith(".pdf"));
            if (pdf) {
              void openPdfPath(pdf);
            }
          },
        }),
      "p04-file-drop",
    );
  }, [openPdfPath]);

  // Subscribe to P04 backend task progress
  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribePdfTaskProgress((ev) => {
          if (ev.toolId !== "P04") return;
          updateSearchablePdfSession((prev) =>
            prev.activeTaskId === ev.taskId ? { ...prev, progress: ev } : prev,
          );
        }),
      "p04-progress",
    );
  }, [updateSearchablePdfSession]);

  const handlePickPdf = useCallback(async () => {
    const chosen = await pickSingleFile({
      title: zh ? "选择扫描版或混合 PDF" : "Select Scanned or Mixed PDF",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (chosen) {
      await openPdfPath(chosen);
    }
  }, [openPdfPath, zh]);

  const handlePickOutput = useCallback(async () => {
    const cur = stateRef.current;
    const defaultPath =
      cur.outputPath ||
      (cur.inspectResult
        ? cur.inspectResult.inspection.path.replace(/\.pdf$/i, "_searchable.pdf")
        : "searchable_output.pdf");
    const chosen = await pickSaveFilePath({
      title: zh ? "另存为可搜索 PDF" : "Save Searchable PDF As",
      defaultPath,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (chosen) {
      updateSearchablePdfSession((prev) => ({
        ...prev,
        outputPath: chosen,
        errorMessage: null,
      }));
    }
  }, [updateSearchablePdfSession, zh]);

  const totalPages = st.inspectResult?.inspection.pageCount ?? 0;

  const rangeCheck = useMemo(() => {
    if (!st.inspectResult || st.scope === "all") {
      return {
        valid: true,
        pages: st.inspectResult?.pages.map((p) => p.pageNumber) ?? [],
        error: null,
      };
    }
    return parseClientPageRanges(st.pageRange, totalPages);
  }, [st.inspectResult, st.pageRange, st.scope, totalPages]);

  const planSummary = useMemo(() => {
    if (!st.inspectResult || !rangeCheck.valid) {
      return { selected: 0, willOcr: 0, willSkipExisting: 0 };
    }
    const selectedSet = new Set(rangeCheck.pages);
    let willOcr = 0;
    let willSkipExisting = 0;
    for (const p of st.inspectResult.pages) {
      if (!selectedSet.has(p.pageNumber)) continue;
      if (st.skipExistingTextPages && p.hasTextLayer) {
        willSkipExisting += 1;
      } else {
        willOcr += 1;
      }
    }
    return { selected: selectedSet.size, willOcr, willSkipExisting };
  }, [rangeCheck.pages, rangeCheck.valid, st.inspectResult, st.skipExistingTextPages]);

  const runConversion = useCallback(
    async (overwrite: boolean) => {
      const cur = stateRef.current;
      if (
        cur.taskStatus === "running" ||
        !cur.inspectResult ||
        !cur.outputPath.trim() ||
        cur.engineStatus?.ready === false
      ) {
        return;
      }
      const taskId = `p04-${Date.now()}-${seqRef.current++}`;
      updateSearchablePdfSession((prev) => ({
        ...prev,
        taskStatus: "running",
        activeTaskId: taskId,
        progress: {
          taskId,
          toolId: "P04",
          current: 0,
          total: planSummary.selected || prev.inspectResult?.inspection.pageCount || 1,
          percent: 2,
          detail: zh ? "正在检查页面文字层…" : "Inspecting page text layers...",
        },
        lastResult: null,
        notice: null,
        errorMessage: null,
      }));

      try {
        const res = await makePdfSearchable(taskId, {
          inputPath: cur.inspectResult.inspection.path,
          outputPath: cur.outputPath.trim(),
          pageRange: cur.scope === "range" ? cur.pageRange.trim() : null,
          skipExistingTextPages: cur.skipExistingTextPages,
          ocrDpi: cur.ocrDpi,
          maxSideLen: cur.maxSideLen,
          overwrite,
        });

        updateSearchablePdfSession((prev) => ({
          ...prev,
          taskStatus: "idle",
          activeTaskId: null,
          progress: null,
          lastResult: res,
          notice:
            res.ocrAppliedPages === 0 && res.skippedExistingTextPages > 0
              ? zh
                ? `所选 ${res.skippedExistingTextPages} 页均已包含可搜索文字层，已跳过重复识别并输出副本。`
                : `All ${res.skippedExistingTextPages} selected page(s) already had searchable text; skipped duplicate OCR.`
              : null,
        }));
      } catch (err) {
        const parsed = parseBackendError(err);
        if (parsed.code === "TARGET_ALREADY_EXISTS" && !overwrite) {
          updateSearchablePdfSession((prev) => ({
            ...prev,
            taskStatus: "idle",
            activeTaskId: null,
            progress: null,
          }));
          setOverwritePending(cur.outputPath.trim());
          return;
        }
        if (parsed.code === "TASK_CANCELLED") {
          updateSearchablePdfSession((prev) => ({
            ...prev,
            taskStatus: "idle",
            activeTaskId: null,
            progress: null,
            notice: zh
              ? "已取消转换，临时文件已清理，原 PDF 未受影响。"
              : "Conversion cancelled; temporary files cleaned and original PDF untouched.",
          }));
        } else {
          updateSearchablePdfSession((prev) => ({
            ...prev,
            taskStatus: "idle",
            activeTaskId: null,
            progress: null,
            errorMessage: formatLocalizedError(err, t),
          }));
        }
      }
    },
    [planSummary.selected, t, updateSearchablePdfSession, zh],
  );

  const handleCancel = useCallback(async () => {
    const tid = stateRef.current.activeTaskId;
    if (!tid) return;
    await cancelBackendTask(tid).catch(() => {});
  }, []);

  const handleClear = useCallback(() => {
    if (stateRef.current.taskStatus === "running") return;
    setThumbDataUrl(null);
    updateSearchablePdfSession((prev) => ({
      ...prev,
      sourcePath: null,
      inspectResult: null,
      encryptedError: false,
      scope: "all",
      pageRange: "",
      outputPath: "",
      lastResult: null,
      notice: null,
      errorMessage: null,
    }));
  }, [updateSearchablePdfSession]);

  const outcomeByPage = useMemo(() => {
    const map = new Map<number, SearchablePdfPageOutcome>();
    if (st.lastResult) {
      for (const p of st.lastResult.pages) {
        map.set(p.pageNumber, p);
      }
    }
    return map;
  }, [st.lastResult]);

  const isRunning = st.taskStatus === "running";
  const info = st.inspectResult?.inspection ?? null;
  const canStart =
    !isRunning &&
    !st.inspectLoading &&
    Boolean(info) &&
    !info?.isEncrypted &&
    st.engineStatus?.ready !== false &&
    Boolean(st.outputPath.trim()) &&
    rangeCheck.valid;

  return (
    <div className="p04-workspace">
      {/* Top Toolbar */}
      <div className="p04-toolbar">
        <button
          type="button"
          className="btn btn-primary"
          disabled={isRunning || st.inspectLoading}
          onClick={() => void handlePickPdf()}
        >
          <FolderOpen size={15} strokeWidth={1.75} aria-hidden="true" />
          <span>{zh ? "选择 PDF…" : "Open PDF..."}</span>
        </button>

        {info && !isRunning && (
          <button type="button" className="btn" onClick={() => openInPdfReader(info.path)}>
            <Eye size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{zh ? "先在 C08 预览原文件" : "Preview Original in C08"}</span>
          </button>
        )}

        {(info || st.sourcePath) && !isRunning && (
          <button type="button" className="btn" onClick={handleClear}>
            <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{zh ? "清空" : "Clear"}</span>
          </button>
        )}

        <div className="p04-toolbar-spacer" />

        <span
          className={`ocr-engine-pill ${
            st.engineStatus?.ready === false ? "error" : st.engineStatus?.ready ? "ready" : ""
          }`}
          title={st.engineStatus?.engineName ?? ""}
        >
          <ScanText size={13} strokeWidth={1.75} aria-hidden="true" />
          <span>
            {st.engineStatus?.ready === false
              ? zh
                ? "离线 OCR 引擎缺失"
                : "Offline OCR Missing"
              : zh
                ? "RapidOCR PP-OCRv4 · 离线"
                : "RapidOCR PP-OCRv4 · Offline"}
          </span>
        </span>
      </div>

      {/* Encryption / Signature / Error / Notice Banners */}
      {(st.encryptedError || info?.isEncrypted) && (
        <div className="pdf-banner pdf-banner-warn" role="alert">
          <Lock size={16} strokeWidth={1.75} aria-hidden="true" />
          <span style={{ flex: 1 }}>
            {zh
              ? "此 PDF 受密码或加密保护，请先使用「PDF 解除密码 (P16)」生成无密码副本后再执行 OCR 转可搜索。"
              : "This PDF is password-protected or encrypted. Unlock it first with Remove Password (P16)."}
          </span>
          {st.sourcePath && (
            <button
              type="button"
              className="btn"
              onClick={() => sendPdfToTool(st.sourcePath!, "P16")}
            >
              {zh ? "前往 P16 解锁" : "Unlock in P16"}
            </button>
          )}
        </div>
      )}

      {info?.hasSignatures && (
        <div className="pdf-banner pdf-banner-warn" role="status">
          <AlertTriangle size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>
            {zh
              ? `此 PDF 含 ${info.signatureCount || 1} 个数字签名字段：添加不可见文字层另存新副本会使新副本的原有密码学数字签名失效（原文件不会被修改）。`
              : `This PDF contains ${info.signatureCount || 1} digital signature(s): adding an invisible text layer to a new copy invalidates original cryptographic signatures (original file remains untouched).`}
          </span>
        </div>
      )}

      {st.errorMessage && !st.encryptedError && (
        <div className="ocr-error-banner" role="alert">
          <AlertTriangle size={15} strokeWidth={1.75} aria-hidden="true" />
          <span>{st.errorMessage}</span>
        </div>
      )}

      {st.notice && (
        <div className="pdf-banner pdf-banner-info" role="status">
          <Info size={15} strokeWidth={1.75} aria-hidden="true" />
          <span>{st.notice}</span>
        </div>
      )}

      {/* Empty State vs Active Workbench */}
      {!info ? (
        <div className="p04-empty-card">
          <FileSearch size={36} strokeWidth={1.5} aria-hidden="true" />
          <h3>
            {zh ? "将扫描版 PDF 转为可搜索、可复制副本" : "Make Scanned PDFs Searchable Offline"}
          </h3>
          <p>
            {zh
              ? "导入或拖入本地 PDF，离线逐页检测已有文字层并仅对扫描页写入不可见 Unicode 文字层（保留原画面、页序、书签、链接与原有文字），支持旋转页、偏置裁剪框与 4096 px 大页精确映射。"
              : "Open or drop a local PDF to inspect existing text layers page by page and embed an invisible Unicode OCR text layer onto scanned pages while preserving appearance, page order, bookmarks, and links."}
          </p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={st.inspectLoading}
            onClick={() => void handlePickPdf()}
          >
            <FolderOpen size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>
              {st.inspectLoading
                ? zh
                  ? "正在逐页检测文字层…"
                  : "Inspecting pages..."
                : zh
                  ? "选择本地 PDF"
                  : "Choose Local PDF"}
            </span>
          </button>
        </div>
      ) : (
        <div className="p04-grid">
          {/* Left Column: Document Summary & Per-Page Text-Layer Status */}
          <section
            className="p04-card"
            aria-label={zh ? "文档与逐页状态" : "Document & Page Status"}
          >
            <div className="p04-doc-summary">
              <div className="p04-thumb-frame">
                {thumbDataUrl ? (
                  <img src={thumbDataUrl} alt={info.fileName} />
                ) : (
                  <FileSearch size={24} strokeWidth={1.5} aria-hidden="true" />
                )}
              </div>
              <div className="p04-doc-meta">
                <div className="p04-doc-name" title={info.fileName}>
                  {info.fileName}
                </div>
                <div className="p04-doc-path">{info.path}</div>
                <div className="p04-badges">
                  <span className="p04-badge">
                    {zh ? `共 ${info.pageCount} 页` : `${info.pageCount} page(s)`}
                  </span>
                  <span className="p04-badge">{formatBytes(info.byteLength)}</span>
                  <span className="p04-badge is-accent">
                    {zh
                      ? `扫描页 ${st.inspectResult!.scannedPageCount}`
                      : `Scanned: ${st.inspectResult!.scannedPageCount}`}
                  </span>
                  <span className="p04-badge is-ok">
                    {zh
                      ? `已有文字 ${st.inspectResult!.searchablePageCount}`
                      : `Searchable: ${st.inspectResult!.searchablePageCount}`}
                  </span>
                  {info.hasOutlines && (
                    <span className="p04-badge">
                      {zh ? "含书签（保留）" : "Bookmarks preserved"}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="p04-card-header">
              <h4 className="p04-card-title">
                {zh ? "逐页文字层检测与处理结果" : "Per-Page Text Layer & OCR Status"}
              </h4>
            </div>

            <div className="p04-page-list">
              {st.inspectResult!.pages.map((p) => {
                const outcome = outcomeByPage.get(p.pageNumber);
                return (
                  <div key={p.pageNumber} className="p04-page-row">
                    <div className="p04-page-left">
                      <span className="p04-page-num">
                        {zh ? `第 ${p.pageNumber} 页` : `Page ${p.pageNumber}`}
                      </span>
                      <span className="p04-page-dims">
                        {Math.round(p.widthPt)}×{Math.round(p.heightPt)} pt
                        {p.rotation !== 0 ? ` · ${p.rotation}°` : ""}
                      </span>
                    </div>
                    <div className="p04-badges">
                      {outcome ? (
                        <>
                          {outcome.status === "ocr_applied" && (
                            <span className="p04-badge is-ok">
                              {zh
                                ? `已写入文字层 · ${outcome.addedLineCount} 行 / ${outcome.addedCharCount} 字`
                                : `OCR added · ${outcome.addedLineCount} lines`}
                            </span>
                          )}
                          {outcome.status === "skipped_existing_text" && (
                            <span className="p04-badge">
                              {zh
                                ? `已跳过（原有 ${outcome.existingCharCount} 字）`
                                : `Skipped (${outcome.existingCharCount} existing chars)`}
                            </span>
                          )}
                          {outcome.status === "ocr_empty" && (
                            <span className="p04-badge is-warn">
                              {zh ? "未检出文字（原样保留）" : "No text detected"}
                            </span>
                          )}
                          {outcome.status === "skipped_out_of_range" && (
                            <span className="p04-badge">
                              {zh ? "范围外（原样保留）" : "Outside range"}
                            </span>
                          )}
                          {outcome.renderCapped && (
                            <span className="p04-badge is-accent">
                              {zh ? "大页 4096 px 精确映射" : "4096 px capped map"}
                            </span>
                          )}
                        </>
                      ) : p.hasTextLayer ? (
                        <span className="p04-badge is-ok">
                          {zh
                            ? `已有文字层（${p.meaningfulCharCount} 字 · 默认跳过）`
                            : `Has text (${p.meaningfulCharCount} chars · skip)`}
                        </span>
                      ) : (
                        <span className="p04-badge is-accent">
                          {zh ? "无文字层（待识别）" : "Scanned (needs OCR)"}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Right Column: Scope, Options, Output & Execution */}
          <section className="p04-card" aria-label={zh ? "识别设置与导出" : "OCR Options & Save"}>
            {/* 1. Page Scope */}
            <div className="p04-section">
              <div className="p04-section-label">{zh ? "1. 选择处理页范围" : "1. Page Range"}</div>
              <div className="p04-radio-row">
                <label>
                  <input
                    type="radio"
                    name="p04-scope"
                    checked={st.scope === "all"}
                    disabled={isRunning}
                    onChange={() =>
                      updateSearchablePdfSession((prev) => ({ ...prev, scope: "all" }))
                    }
                  />
                  <span>{zh ? `全部页面 (1–${totalPages})` : `All pages (1-${totalPages})`}</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="p04-scope"
                    checked={st.scope === "range"}
                    disabled={isRunning}
                    onChange={() =>
                      updateSearchablePdfSession((prev) => ({ ...prev, scope: "range" }))
                    }
                  />
                  <span>{zh ? "指定页码范围" : "Custom page range"}</span>
                </label>
              </div>
              {st.scope === "range" && (
                <>
                  <input
                    type="text"
                    className="p04-input"
                    value={st.pageRange}
                    disabled={isRunning}
                    placeholder={zh ? "例如 1-3, 5" : "e.g. 1-3, 5"}
                    aria-label={zh ? "指定页码范围" : "Custom page range"}
                    onChange={(e) =>
                      updateSearchablePdfSession((prev) => ({ ...prev, pageRange: e.target.value }))
                    }
                  />
                  {!rangeCheck.valid && st.pageRange.trim() !== "" && (
                    <p className="p04-error-inline">{rangeCheck.error}</p>
                  )}
                </>
              )}
              {rangeCheck.valid && (
                <p className="p04-hint">
                  {zh
                    ? `本次选中 ${planSummary.selected} 页：计划离线识别 ${planSummary.willOcr} 页，跳过已有文字层 ${planSummary.willSkipExisting} 页。`
                    : `Selected ${planSummary.selected} page(s): ${planSummary.willOcr} to OCR, ${planSummary.willSkipExisting} skipped with existing text.`}
                </p>
              )}
            </div>

            {/* 2. OCR & Protection Options */}
            <div className="p04-section">
              <div className="p04-section-label">
                {zh ? "2. 离线识别与保护选项" : "2. Offline OCR & Protection"}
              </div>
              <label className="p04-checkbox-row">
                <input
                  type="checkbox"
                  checked={st.skipExistingTextPages}
                  disabled={isRunning}
                  onChange={(e) =>
                    updateSearchablePdfSession((prev) => ({
                      ...prev,
                      skipExistingTextPages: e.target.checked,
                    }))
                  }
                />
                <span>
                  {zh
                    ? "默认跳过已有可搜索文字层的页面（避免重复叠加）"
                    : "Skip pages that already contain searchable text (avoid duplicates)"}
                </span>
              </label>
              {!st.skipExistingTextPages && (
                <p className="p04-hint">
                  {zh
                    ? "注意：取消勾选后，已有文字的页面也会额外写入一层不可见 OCR 文字。"
                    : "Note: unchecking this overlays an additional invisible OCR layer on pages that already have text."}
                </p>
              )}

              <div className="p04-inline-grid">
                <label className="p04-field">
                  <span>{zh ? "页面渲染清晰度" : "Render DPI"}</span>
                  <select
                    className="p04-select"
                    value={st.ocrDpi}
                    disabled={isRunning}
                    onChange={(e) =>
                      updateSearchablePdfSession((prev) => ({
                        ...prev,
                        ocrDpi: Number(e.target.value) as 150 | 200 | 300,
                      }))
                    }
                  >
                    <option value={150}>{zh ? "150 DPI（快速）" : "150 DPI (Fast)"}</option>
                    <option value={200}>{zh ? "200 DPI（推荐）" : "200 DPI (Recommended)"}</option>
                    <option value={300}>
                      {zh ? "300 DPI（精细小字）" : "300 DPI (Fine print)"}
                    </option>
                  </select>
                </label>

                <label className="p04-field">
                  <span>{zh ? "文字检测上限" : "Det Max Side"}</span>
                  <select
                    className="p04-select"
                    value={st.maxSideLen}
                    disabled={isRunning}
                    onChange={(e) =>
                      updateSearchablePdfSession((prev) => ({
                        ...prev,
                        maxSideLen: Number(e.target.value) as 1280 | 1600,
                      }))
                    }
                  >
                    <option value={1280}>{zh ? "1280 px（均衡）" : "1280 px (Balanced)"}</option>
                    <option value={1600}>
                      {zh ? "1600 px（小字增强）" : "1600 px (Small text)"}
                    </option>
                  </select>
                </label>
              </div>
              <p className="p04-hint">
                {zh
                  ? "单页渲染自动受 4096 px 安全上限约束，并通过 PDFium 设备→页面坐标变换按真实像素对齐文字选区。"
                  : "Large pages are capped safely at 4096 px and aligned using PDFium's exact device-to-page transform."}
              </p>
            </div>

            {/* 3. Output Path & Action */}
            <div className="p04-section">
              <div className="p04-section-label">
                {zh ? "3. 另存可搜索 PDF（新文件）" : "3. Save Searchable PDF (New Copy)"}
              </div>
              <div className="p04-path-row">
                <input
                  type="text"
                  className="p04-input"
                  value={st.outputPath}
                  disabled={isRunning}
                  aria-label={zh ? "输出可搜索 PDF 路径" : "Searchable PDF output path"}
                  onChange={(e) =>
                    updateSearchablePdfSession((prev) => ({
                      ...prev,
                      outputPath: e.target.value,
                      errorMessage: null,
                    }))
                  }
                />
                <button
                  type="button"
                  className="btn"
                  disabled={isRunning}
                  onClick={() => void handlePickOutput()}
                >
                  {zh ? "另存为…" : "Save As..."}
                </button>
              </div>
              <p className="p04-hint">
                {zh
                  ? "采用同目录原子写入保护：绝不覆盖源 PDF，取消时自动清理临时文件。"
                  : "Atomic non-destructive save: never overwrites source PDF and cleans temporary files on cancel."}
              </p>

              {isRunning && st.progress && (
                <div className="p04-progress-box" role="status" aria-live="polite">
                  <div className="p04-progress-meta">
                    <span>{st.progress.detail}</span>
                    <span>{Math.round(st.progress.percent)}%</span>
                  </div>
                  <div className="p04-progress-track">
                    <div
                      className="p04-progress-fill"
                      style={{ width: `${Math.min(100, Math.max(2, st.progress.percent))}%` }}
                    />
                  </div>
                </div>
              )}

              <div className="p04-actions-row">
                {!isRunning ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!canStart}
                    onClick={() => void runConversion(false)}
                  >
                    <Save size={15} strokeWidth={1.75} aria-hidden="true" />
                    <span>{zh ? "开始离线识别并另存 PDF" : "Make Searchable PDF"}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => void handleCancel()}
                  >
                    <Square size={14} strokeWidth={1.75} aria-hidden="true" />
                    <span>{zh ? "取消转换" : "Cancel"}</span>
                  </button>
                )}
              </div>
            </div>

            {/* Completed Result Card */}
            {st.lastResult && (
              <div className="p04-result-box" role="status">
                <div className="p04-result-head">
                  <CheckCircle2 size={17} strokeWidth={1.8} aria-hidden="true" />
                  <span>
                    {zh
                      ? `可搜索 PDF 已生成（识别 ${st.lastResult.ocrAppliedPages} 页，跳过 ${st.lastResult.skippedExistingTextPages} 页，共写入 ${st.lastResult.totalLinesAdded} 行 / ${st.lastResult.totalCharsAdded} 字）`
                      : `Searchable PDF saved (${st.lastResult.ocrAppliedPages} OCR'd, ${st.lastResult.skippedExistingTextPages} skipped, ${st.lastResult.totalLinesAdded} lines)`}
                  </span>
                </div>
                <div className="p04-doc-path">
                  {st.lastResult.outputPath} · {formatBytes(st.lastResult.outputBytes)} ·{" "}
                  {(st.lastResult.elapsedMs / 1000).toFixed(2)} s
                </div>
                {st.lastResult.warnings.map((w, idx) => (
                  <p key={idx} className="p04-hint">
                    {w}
                  </p>
                ))}
                <div className="p04-actions-row">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => openInPdfReader(st.lastResult!.outputPath)}
                  >
                    <Eye size={14} strokeWidth={1.75} aria-hidden="true" />
                    <span>{zh ? "用 C08 打开结果" : "Open Result in C08"}</span>
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void openLocalDirectory(getParentDir(st.lastResult!.outputPath))}
                  >
                    <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
                    <span>{zh ? "打开所在目录" : "Open Folder"}</span>
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {overwritePending && (
        <ConfirmDialog
          open={Boolean(overwritePending)}
          title={zh ? "覆盖已有文件？" : "Overwrite Existing File?"}
          body={
            zh
              ? `目标文件已存在：${overwritePending}\n确认覆盖吗？`
              : `Output file already exists:\n${overwritePending}\nOverwrite it?`
          }
          confirmLabel={zh ? "确认覆盖" : "Overwrite"}
          cancelLabel={zh ? "取消" : "Cancel"}
          onCancel={() => setOverwritePending(null)}
          onConfirm={() => {
            setOverwritePending(null);
            void runConversion(true);
          }}
        />
      )}
    </div>
  );
}
