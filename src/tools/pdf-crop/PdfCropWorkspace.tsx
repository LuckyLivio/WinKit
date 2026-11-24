import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Crop,
  Eye,
  FolderOpen,
  Info,
  RotateCcw,
  Save,
  Sparkles,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useI18n } from "../../i18n/I18nContext";
import { usePdfSession } from "../../lib/pdfSessionStore";
import {
  bindDisposableListener,
  cancelBackendTask,
  cropPdf,
  detectPdfWhiteMargins,
  formatLocalizedError,
  inspectPdfDocument,
  openLocalDirectory,
  parseBackendError,
  pickSaveFilePath,
  pickSingleFile,
  renderPdfPage,
  subscribeFileDrop,
  subscribePdfTaskProgress,
  suggestSafeSiblingPath,
  type PdfCropScope,
} from "../../lib/tauriBridge";
import "../../components/PdfReaderView.css";
import "../pdf-sign/pdfSign.css";
import "./pdfCrop.css";

const PT_PER_MM = 72 / 25.4;

type HandleId = "move" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const CROP_PRESETS = [
  { id: "a4", zh: "A4 (210×297 mm)", en: "A4", wPt: 595.28, hPt: 841.89 },
  { id: "letter", zh: "Letter", en: "Letter", wPt: 612, hPt: 792 },
  { id: "label_4x6", zh: "快递面单 100×150", en: "Shipping 4×6 in", wPt: 283.46, hPt: 425.2 },
  { id: "label_100x180", zh: "快递面单 100×180", en: "Label 100×180 mm", wPt: 283.46, hPt: 510.24 },
] as const;

const copy = {
  "zh-CN": {
    subtitle:
      "可视化框选或输入四边边距非破坏性裁剪 PDF 页面（支持 A4、Letter、快递面单与自动白边预览）。",
    openPdf: "选择 PDF…",
    emptyHint: "选择或拖入本地 PDF，在页面预览中拖动裁剪框或使用自动检测白边预览。",
    privacyNotice:
      "非破坏性边界裁剪：仅修改 PDF 页面可见边界（CropBox），保留可选文字与矢量清晰度；裁剪区域以外的原始内容可能仍保存在 PDF 中，不能代替隐私永久涂黑删除。",
    sigWarn: (n: number) =>
      `此 PDF 包含 ${n} 个数字签名字段：裁剪导出新副本会使原有密码学签名失效。`,
    presetsTitle: "1. 预设与自动白边",
    resetBtn: "重置整页",
    autoWhiteBtn: "自动检测白边（先预览）",
    autoWhiteRunning: "检测中…",
    autoWhiteBlank: "当前页为空白页，未调整裁剪框。",
    autoWhiteApplied: (t: number, r: number, b: number, l: number) =>
      `已按检测结果预览白边（上 ${t} / 右 ${r} / 下 ${b} / 左 ${l} pt），可继续微调后再导出。`,
    marginsTitle: "2. 四边裁剪数值",
    top: "上边裁去",
    right: "右边裁去",
    bottom: "下边裁去",
    left: "左边裁去",
    resultDims: (wPt: number, hPt: number, wMm: number, hMm: number) =>
      `裁剪后尺寸：${wPt.toFixed(1)} × ${hPt.toFixed(1)} pt（${wMm.toFixed(1)} × ${hMm.toFixed(1)} mm）`,
    scopeTitle: "3. 作用范围",
    scopeCurrent: "仅当前页",
    scopeAll: "全部页面",
    scopeRange: "指定页码范围",
    rangePlaceholder: "例如 1-3, 5",
    modeMargins: "按四边固定边距 (pt) 裁切",
    modeRatio: "按当前选框比例适配不同尺寸页",
    outputTitle: "4. 导出裁剪后 PDF（新文件）",
    saveAs: "另存为…",
    exportBtn: "导出裁剪 PDF",
    exporting: "正在裁剪…",
    cancel: "取消",
    openInReader: "在内置预览中打开",
    openOutDir: "打开所在目录",
    doneSummary: (n: number, bytes: number) =>
      `裁剪完成（共处理 ${n} 页，${(bytes / 1024).toFixed(1)} KiB）`,
    overwriteTitle: "覆盖已有文件？",
    overwriteBody: (p: string) => `目标文件已存在：${p}\n确认覆盖吗？`,
    overwriteConfirm: "确认覆盖",
  },
  "en-US": {
    subtitle:
      "Drag a crop rectangle or enter exact margins to non-destructively crop PDF pages (A4, Letter, shipping labels, and auto white-margin preview).",
    openPdf: "Open PDF...",
    emptyHint:
      "Open or drop a local PDF to drag the crop box or preview auto-detected white margins.",
    privacyNotice:
      "Non-destructive CropBox crop: keeps selectable text and vectors intact. Content outside the cropped area may remain inside the PDF file and does NOT permanently redact sensitive data.",
    sigWarn: (n: number) =>
      `This PDF contains ${n} digital signature field(s). Exporting a cropped copy invalidates original cryptographic signatures.`,
    presetsTitle: "1. Presets & Auto White Margin",
    resetBtn: "Reset Full Page",
    autoWhiteBtn: "Auto-Detect White Margins (Preview)",
    autoWhiteRunning: "Detecting...",
    autoWhiteBlank: "Current page appears blank; crop box left unchanged.",
    autoWhiteApplied: (t: number, r: number, b: number, l: number) =>
      `Previewing detected margins (T ${t} / R ${r} / B ${b} / L ${l} pt). Adjust if needed before exporting.`,
    marginsTitle: "2. Four-Side Margins",
    top: "Top trim",
    right: "Right trim",
    bottom: "Bottom trim",
    left: "Left trim",
    resultDims: (wPt: number, hPt: number, wMm: number, hMm: number) =>
      `Result size: ${wPt.toFixed(1)} × ${hPt.toFixed(1)} pt (${wMm.toFixed(1)} × ${hMm.toFixed(1)} mm)`,
    scopeTitle: "3. Page Scope",
    scopeCurrent: "Current page only",
    scopeAll: "All pages",
    scopeRange: "Custom page range",
    rangePlaceholder: "e.g. 1-3, 5",
    modeMargins: "Apply exact margins (pt)",
    modeRatio: "Apply relative box (%) across mixed page sizes",
    outputTitle: "4. Export Cropped PDF (New Copy)",
    saveAs: "Save As...",
    exportBtn: "Export Cropped PDF",
    exporting: "Cropping PDF...",
    cancel: "Cancel",
    openInReader: "Open in Preview",
    openOutDir: "Open Folder",
    doneSummary: (n: number, bytes: number) =>
      `Cropped ${n} page(s) (${(bytes / 1024).toFixed(1)} KiB)`,
    overwriteTitle: "Overwrite Existing File?",
    overwriteBody: (p: string) => `File already exists: ${p}\nOverwrite it?`,
    overwriteConfirm: "Overwrite",
  },
} as const;

function getParentDir(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx > 0 ? path.slice(0, idx) : path;
}

export function PdfCropWorkspace() {
  const { locale, t } = useI18n();
  const c = copy[locale];
  const {
    pdfSession,
    updateCropSession,
    openInPdfReader,
    pendingToolIntake,
    clearPendingToolIntake,
  } = usePdfSession();
  const st = pdfSession.crop;

  const [pageDataUrl, setPageDataUrl] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [overwritePending, setOverwritePending] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const openPdfPath = useCallback(
    async (path: string) => {
      updateCropSession((prev) => ({
        ...prev,
        inspectLoading: true,
        errorMessage: null,
        lastResult: null,
        autoDetectNotice: null,
      }));
      try {
        const info = await inspectPdfDocument(path);
        const suggested =
          (await suggestSafeSiblingPath(info.path, "_cropped", ".pdf").catch(() => null)) ??
          `${info.path.replace(/\.pdf$/i, "")}_cropped.pdf`;
        updateCropSession((prev) => ({
          ...prev,
          sourcePath: info.path,
          inspection: info,
          inspectLoading: false,
          currentPage: 1,
          leftNorm: 0.04,
          topNorm: 0.04,
          widthNorm: 0.92,
          heightNorm: 0.92,
          outputPath: suggested,
          autoDetectNotice: null,
          errorMessage: null,
        }));
      } catch (err) {
        updateCropSession((prev) => ({
          ...prev,
          inspectLoading: false,
          errorMessage: formatLocalizedError(err, t),
        }));
      }
    },
    [t, updateCropSession],
  );

  useEffect(() => {
    if (pendingToolIntake?.toolId === "P13") {
      const target = pendingToolIntake.path;
      clearPendingToolIntake();
      void openPdfPath(target);
    }
  }, [pendingToolIntake, clearPendingToolIntake, openPdfPath]);

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onDropPaths: (paths) => {
            const pdf = paths.find((p) => p.toLowerCase().endsWith(".pdf"));
            if (pdf) void openPdfPath(pdf);
          },
        }),
      "p13-drop",
    );
  }, [openPdfPath]);

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribePdfTaskProgress((ev) => {
          if (ev.toolId !== "P13") return;
          updateCropSession((prev) =>
            prev.activeTaskId === ev.taskId ? { ...prev, progress: ev } : prev,
          );
        }),
      "p13-progress",
    );
  }, [updateCropSession]);

  useEffect(() => {
    const info = st.inspection;
    if (!info) {
      setPageDataUrl(null);
      return;
    }
    let cancelled = false;
    void renderPdfPage({
      path: info.path,
      pageNumber: st.currentPage,
      targetWidthPx: 960,
    })
      .then((res) => {
        if (!cancelled) setPageDataUrl(res.dataUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [st.inspection, st.currentPage]);

  const pageGeom = useMemo(() => {
    if (!st.inspection) return null;
    return st.inspection.pages[st.currentPage - 1] ?? null;
  }, [st.inspection, st.currentPage]);

  const pageW = pageGeom?.widthPt ?? 595.28;
  const pageH = pageGeom?.heightPt ?? 841.89;

  const previewSize = useMemo(() => {
    const maxW = 560;
    const maxH = 560;
    const aspect = pageH / Math.max(pageW, 1);
    let w = maxW;
    let h = w * aspect;
    if (h > maxH) {
      h = maxH;
      w = h / aspect;
    }
    return { width: Math.round(w), height: Math.round(h) };
  }, [pageW, pageH]);

  // Derived margins in pt
  const marginsPt = useMemo(() => {
    const left = st.leftNorm * pageW;
    const top = st.topNorm * pageH;
    const right = Math.max(0, (1 - st.leftNorm - st.widthNorm) * pageW);
    const bottom = Math.max(0, (1 - st.topNorm - st.heightNorm) * pageH);
    const outW = Math.max(18, pageW - left - right);
    const outH = Math.max(18, pageH - top - bottom);
    return { left, top, right, bottom, outW, outH };
  }, [st.leftNorm, st.topNorm, st.widthNorm, st.heightNorm, pageW, pageH]);

  const factor = st.unitDisplay === "mm" ? PT_PER_MM : 1;
  const toDisplayUnit = (pt: number) => Number((pt / factor).toFixed(1));

  const setMarginFromInput = (side: "left" | "right" | "top" | "bottom", rawDisplayVal: number) => {
    if (!Number.isFinite(rawDisplayVal)) return;
    const valPt = Math.max(0, rawDisplayVal * factor);
    const cur = { ...marginsPt };
    cur[side] = valPt;
    if (pageW - cur.left - cur.right < 18) return;
    if (pageH - cur.top - cur.bottom < 18) return;
    updateCropSession((prev) => ({
      ...prev,
      leftNorm: cur.left / pageW,
      topNorm: cur.top / pageH,
      widthNorm: (pageW - cur.left - cur.right) / pageW,
      heightNorm: (pageH - cur.top - cur.bottom) / pageH,
      autoDetectNotice: null,
    }));
  };

  const applyPreset = (targetW: number, targetH: number) => {
    // Fit preset aspect ratio or exact points cleanly inside current page
    let w = Math.min(pageW, targetW);
    let h = Math.min(pageH, targetH);
    const presetAspect = targetW / targetH;
    if (w / h > presetAspect) {
      w = h * presetAspect;
    } else {
      h = w / presetAspect;
    }
    const wn = Math.max(0.05, Math.min(1, w / pageW));
    const hn = Math.max(0.05, Math.min(1, h / pageH));
    updateCropSession((prev) => ({
      ...prev,
      leftNorm: (1 - wn) / 2,
      topNorm: (1 - hn) / 2,
      widthNorm: wn,
      heightNorm: hn,
      autoDetectNotice: null,
    }));
  };

  const handleAutoDetectWhite = async () => {
    if (!st.sourcePath) return;
    setDetecting(true);
    updateCropSession((prev) => ({ ...prev, errorMessage: null, autoDetectNotice: null }));
    try {
      const detected = await detectPdfWhiteMargins({
        path: st.sourcePath,
        pageNumber: st.currentPage,
        paddingPt: 6,
      });
      if (detected.isBlank) {
        updateCropSession((prev) => ({ ...prev, autoDetectNotice: c.autoWhiteBlank }));
      } else {
        updateCropSession((prev) => ({
          ...prev,
          leftNorm: detected.leftNorm,
          topNorm: detected.topNorm,
          widthNorm: detected.widthNorm,
          heightNorm: detected.heightNorm,
          autoDetectNotice: c.autoWhiteApplied(
            Math.round(detected.topPt),
            Math.round(detected.rightPt),
            Math.round(detected.bottomPt),
            Math.round(detected.leftPt),
          ),
        }));
      }
    } catch (err) {
      updateCropSession((prev) => ({ ...prev, errorMessage: formatLocalizedError(err, t) }));
    } finally {
      setDetecting(false);
    }
  };

  // Drag / resize handles for crop box
  const dragRef = useRef<{
    handle: HandleId;
    startX: number;
    startY: number;
    orig: { l: number; t: number; r: number; b: number };
  } | null>(null);

  const onCropPointerDown = (e: ReactPointerEvent<HTMLElement>, handle: HandleId) => {
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      handle,
      startX: e.clientX,
      startY: e.clientY,
      orig: {
        l: st.leftNorm,
        t: st.topNorm,
        r: st.leftNorm + st.widthNorm,
        b: st.topNorm + st.heightNorm,
      },
    };
  };

  const onCropPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    const stage = stageRef.current;
    if (!d || !stage) return;
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const dx = (e.clientX - d.startX) / rect.width;
    const dy = (e.clientY - d.startY) / rect.height;
    const minFrac = 0.06;

    let { l, t: tp, r, b } = d.orig;
    if (d.handle === "move") {
      const w = r - l;
      const h = b - tp;
      l = Math.max(0, Math.min(1 - w, l + dx));
      tp = Math.max(0, Math.min(1 - h, tp + dy));
      r = l + w;
      b = tp + h;
    } else {
      if (d.handle.includes("w")) l = Math.max(0, Math.min(r - minFrac, l + dx));
      if (d.handle.includes("e")) r = Math.min(1, Math.max(l + minFrac, r + dx));
      if (d.handle.includes("n")) tp = Math.max(0, Math.min(b - minFrac, tp + dy));
      if (d.handle.includes("s")) b = Math.min(1, Math.max(tp + minFrac, b + dy));
    }

    updateCropSession((prev) => ({
      ...prev,
      leftNorm: l,
      topNorm: tp,
      widthNorm: Math.max(minFrac, r - l),
      heightNorm: Math.max(minFrac, b - tp),
      autoDetectNotice: null,
    }));
  };

  const onCropPointerUp = () => {
    dragRef.current = null;
  };

  const runExport = useCallback(
    async (overwrite: boolean) => {
      if (!st.sourcePath || !st.inspection || !st.outputPath.trim()) return;
      const taskId = `p13-${Date.now()}`;
      updateCropSession((prev) => ({
        ...prev,
        taskStatus: "running",
        activeTaskId: taskId,
        progress: null,
        errorMessage: null,
        lastResult: null,
      }));
      try {
        const res = await cropPdf({
          taskId,
          path: st.sourcePath,
          outputPath: st.outputPath.trim(),
          overwrite,
          scope: st.scope,
          currentPage: st.currentPage,
          pageRange: st.scope === "range" ? st.pageRange : undefined,
          mode: st.mode,
          leftPt: marginsPt.left,
          rightPt: marginsPt.right,
          topPt: marginsPt.top,
          bottomPt: marginsPt.bottom,
          leftNorm: st.leftNorm,
          topNorm: st.topNorm,
          widthNorm: st.widthNorm,
          heightNorm: st.heightNorm,
        });
        updateCropSession((prev) => ({
          ...prev,
          taskStatus: "idle",
          activeTaskId: null,
          lastResult: res,
        }));
      } catch (err) {
        const parsed = parseBackendError(err);
        if (parsed?.code === "TARGET_ALREADY_EXISTS" && !overwrite) {
          setOverwritePending(st.outputPath.trim());
          updateCropSession((prev) => ({ ...prev, taskStatus: "idle", activeTaskId: null }));
          return;
        }
        updateCropSession((prev) => ({
          ...prev,
          taskStatus: "idle",
          activeTaskId: null,
          errorMessage: formatLocalizedError(err, t),
        }));
      }
    },
    [marginsPt, st, t, updateCropSession],
  );

  const running = st.taskStatus === "running";

  return (
    <div className="tool-workspace">
      <div className="tool-intro">
        <p className="tool-intro-desc">{c.subtitle}</p>
      </div>

      <div className="pdf-banner pdf-banner-info" role="note">
        <Info size={16} strokeWidth={1.75} aria-hidden="true" />
        <span>{c.privacyNotice}</span>
      </div>

      {st.inspection?.hasSignatures && (
        <div className="pdf-banner pdf-banner-warn" role="alert">
          <AlertTriangle size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>{c.sigWarn(st.inspection.signatureCount || 1)}</span>
        </div>
      )}

      {st.autoDetectNotice && (
        <div className="pdf-banner pdf-banner-info" role="status">
          <Sparkles size={15} strokeWidth={1.75} aria-hidden="true" />
          <span>{st.autoDetectNotice}</span>
        </div>
      )}

      {st.errorMessage && (
        <div className="pdf-banner pdf-banner-error" role="alert">
          <AlertTriangle size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>{st.errorMessage}</span>
        </div>
      )}

      <div className="pdf-crop-layout">
        {/* Left: Interactive Crop Stage */}
        <div className="pdf-sign-stage-card">
          <div className="pdf-sign-stage-toolbar">
            <div className="pdf-sign-toolbar-group">
              <button
                type="button"
                className="btn btn-primary"
                disabled={running || st.inspectLoading}
                onClick={async () => {
                  const picked = await pickSingleFile({
                    title: c.openPdf,
                    filters: [{ name: "PDF", extensions: ["pdf"] }],
                  });
                  if (picked) void openPdfPath(picked);
                }}
              >
                <FolderOpen size={15} />
                <span>{c.openPdf}</span>
              </button>

              {st.inspection && (
                <>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    disabled={st.currentPage <= 1}
                    aria-label="Prev page"
                    onClick={() =>
                      updateCropSession((prev) => ({
                        ...prev,
                        currentPage: Math.max(1, prev.currentPage - 1),
                      }))
                    }
                  >
                    <ChevronLeft size={15} />
                  </button>
                  <span className="mono" style={{ fontSize: 13 }}>
                    {st.currentPage} / {st.inspection.pageCount}
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    disabled={st.currentPage >= st.inspection.pageCount}
                    aria-label="Next page"
                    onClick={() =>
                      updateCropSession((prev) => ({
                        ...prev,
                        currentPage: Math.min(
                          prev.inspection?.pageCount ?? 1,
                          prev.currentPage + 1,
                        ),
                      }))
                    }
                  >
                    <ChevronRight size={15} />
                  </button>
                </>
              )}
            </div>

            {st.inspection && (
              <span className="mono" style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                {c.resultDims(
                  marginsPt.outW,
                  marginsPt.outH,
                  marginsPt.outW / PT_PER_MM,
                  marginsPt.outH / PT_PER_MM,
                )}
              </span>
            )}
          </div>

          {!st.inspection ? (
            <div className="pdf-reader-empty" style={{ minHeight: 340 }}>
              <div className="pdf-reader-empty-card">
                <Crop size={32} strokeWidth={1.5} aria-hidden="true" />
                <p>{c.emptyHint}</p>
              </div>
            </div>
          ) : (
            <div className="pdf-sign-viewport">
              <div
                ref={stageRef}
                className="pdf-crop-stage-clip"
                style={{ width: previewSize.width, height: previewSize.height }}
              >
                <div
                  className="pdf-crop-stage"
                  style={{ width: previewSize.width, height: previewSize.height }}
                >
                  {pageDataUrl && (
                    <img
                      src={pageDataUrl}
                      alt={`Page ${st.currentPage}`}
                      className="pdf-sign-page-img"
                      draggable={false}
                    />
                  )}
                  <div
                    className="pdf-crop-mask-box"
                    style={{
                      left: `${st.leftNorm * 100}%`,
                      top: `${st.topNorm * 100}%`,
                      width: `${st.widthNorm * 100}%`,
                      height: `${st.heightNorm * 100}%`,
                    }}
                    onPointerDown={(e) => onCropPointerDown(e, "move")}
                    onPointerMove={onCropPointerMove}
                    onPointerUp={onCropPointerUp}
                  >
                    {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const).map((h) => (
                      <div
                        key={h}
                        className={`pdf-crop-handle ${h}`}
                        onPointerDown={(e) => onCropPointerDown(e, h)}
                        onPointerMove={onCropPointerMove}
                        onPointerUp={onCropPointerUp}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right: Controls */}
        <div className="pdf-sign-side">
          <div className="pdf-sign-panel">
            <h3>{c.presetsTitle}</h3>
            <div className="pdf-crop-preset-grid">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={!st.inspection}
                onClick={() =>
                  updateCropSession((prev) => ({
                    ...prev,
                    leftNorm: 0,
                    topNorm: 0,
                    widthNorm: 1,
                    heightNorm: 1,
                    autoDetectNotice: null,
                  }))
                }
              >
                <RotateCcw size={13} />
                <span>{c.resetBtn}</span>
              </button>
              {CROP_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="btn btn-ghost"
                  disabled={!st.inspection}
                  onClick={() => applyPreset(p.wPt, p.hPt)}
                >
                  {locale === "zh-CN" ? p.zh : p.en}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn"
              disabled={!st.inspection || detecting || running}
              onClick={() => void handleAutoDetectWhite()}
            >
              <Sparkles size={14} />
              <span>{detecting ? c.autoWhiteRunning : c.autoWhiteBtn}</span>
            </button>
          </div>

          <div className="pdf-sign-panel">
            <div className="pdf-sign-field-row">
              <h3>{c.marginsTitle}</h3>
              <div className="segmented">
                <button
                  type="button"
                  className={st.unitDisplay === "mm" ? "is-active" : ""}
                  onClick={() => updateCropSession((prev) => ({ ...prev, unitDisplay: "mm" }))}
                >
                  mm
                </button>
                <button
                  type="button"
                  className={st.unitDisplay === "pt" ? "is-active" : ""}
                  onClick={() => updateCropSession((prev) => ({ ...prev, unitDisplay: "pt" }))}
                >
                  pt
                </button>
              </div>
            </div>

            <div className="pdf-crop-margins-grid">
              {(
                [
                  ["top", c.top, marginsPt.top],
                  ["bottom", c.bottom, marginsPt.bottom],
                  ["left", c.left, marginsPt.left],
                  ["right", c.right, marginsPt.right],
                ] as const
              ).map(([key, label, ptVal]) => (
                <label key={key} className="pdf-crop-margin-field">
                  <span>
                    {label} ({st.unitDisplay})
                  </span>
                  <input
                    type="number"
                    className="text-input mono"
                    min={0}
                    step={0.5}
                    disabled={!st.inspection}
                    value={toDisplayUnit(ptVal)}
                    onChange={(e) => setMarginFromInput(key, Number(e.target.value))}
                  />
                </label>
              ))}
            </div>
          </div>

          <div className="pdf-sign-panel">
            <h3>{c.scopeTitle}</h3>
            <div className="segmented">
              {(
                [
                  ["current", c.scopeCurrent],
                  ["all", c.scopeAll],
                  ["range", c.scopeRange],
                ] as Array<[PdfCropScope, string]>
              ).map(([sc, lbl]) => (
                <button
                  key={sc}
                  type="button"
                  className={st.scope === sc ? "is-active" : ""}
                  onClick={() => updateCropSession((prev) => ({ ...prev, scope: sc }))}
                >
                  {lbl}
                </button>
              ))}
            </div>
            {st.scope === "range" && (
              <input
                type="text"
                className="text-input mono"
                placeholder={c.rangePlaceholder}
                value={st.pageRange}
                onChange={(e) =>
                  updateCropSession((prev) => ({ ...prev, pageRange: e.target.value }))
                }
              />
            )}
            {st.scope !== "current" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input
                    type="radio"
                    checked={st.mode === "margins_pt"}
                    onChange={() => updateCropSession((prev) => ({ ...prev, mode: "margins_pt" }))}
                  />
                  <span>{c.modeMargins}</span>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input
                    type="radio"
                    checked={st.mode === "normalized_box"}
                    onChange={() =>
                      updateCropSession((prev) => ({ ...prev, mode: "normalized_box" }))
                    }
                  />
                  <span>{c.modeRatio}</span>
                </label>
              </div>
            )}
          </div>

          <div className="pdf-sign-panel">
            <h3>{c.outputTitle}</h3>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="text"
                className="text-input mono"
                value={st.outputPath}
                onChange={(e) =>
                  updateCropSession((prev) => ({ ...prev, outputPath: e.target.value }))
                }
                disabled={running}
              />
              <button
                type="button"
                className="btn"
                disabled={running || !st.sourcePath}
                onClick={async () => {
                  const picked = await pickSaveFilePath({
                    title: c.saveAs,
                    defaultPath: st.outputPath || "cropped.pdf",
                    filters: [{ name: "PDF", extensions: ["pdf"] }],
                  });
                  if (picked) updateCropSession((prev) => ({ ...prev, outputPath: picked }));
                }}
              >
                {c.saveAs}
              </button>
            </div>

            {running ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 12.5 }}>
                  {c.exporting} {st.progress ? `${Math.round(st.progress.percent)}%` : ""}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    if (st.activeTaskId) void cancelBackendTask(st.activeTaskId);
                  }}
                >
                  {c.cancel}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!st.inspection || !st.outputPath.trim()}
                onClick={() => void runExport(false)}
              >
                <Save size={15} />
                <span>{c.exportBtn}</span>
              </button>
            )}

            {st.lastResult && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  padding: 10,
                  borderRadius: 8,
                  background: "var(--surface-subtle)",
                  border: "1px solid var(--border)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
                  <CheckCircle2 size={15} color="var(--success)" />
                  <span>
                    {c.doneSummary(st.lastResult.croppedPageCount, st.lastResult.byteLength)}
                  </span>
                </div>
                <div className="pdf-sign-toolbar-group">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => openInPdfReader(st.lastResult!.outputPath)}
                  >
                    <Eye size={14} />
                    <span>{c.openInReader}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void openLocalDirectory(getParentDir(st.lastResult!.outputPath))}
                  >
                    {c.openOutDir}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {overwritePending && (
        <ConfirmDialog
          open={true}
          title={c.overwriteTitle}
          body={c.overwriteBody(overwritePending)}
          confirmLabel={c.overwriteConfirm}
          cancelLabel={c.cancel}
          onConfirm={() => {
            setOverwritePending(null);
            void runExport(true);
          }}
          onCancel={() => setOverwritePending(null)}
        />
      )}
    </div>
  );
}
