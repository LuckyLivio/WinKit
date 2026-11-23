import {
  ClipboardPaste,
  Copy,
  Download,
  Eraser,
  FolderOpen,
  ImagePlus,
  Images,
  Stamp,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore, type BeautifierAspect } from "../../lib/sessionStore";
import {
  bindDisposableListener,
  copyImageAssetToClipboard,
  exportBeautifiedImage,
  formatLocalizedError,
  inspectBatchImages,
  inspectBeautifierSourceImage,
  openLocalDirectory,
  parseBackendError,
  pickMultipleDirectories,
  pickMultipleFiles,
  pickSaveFilePath,
  pickSingleDirectory,
  pickSingleFile,
  readClipboardImageAsAsset,
  renderBeautifiedAsset,
  subscribeFileDrop,
  suggestSafeSiblingPath,
  type BeautifyBackgroundKind,
  type BeautifyStyleConfig,
} from "../../lib/tauriBridge";
import { findRegisteredTool } from "../../registry/tools";
import {
  IMAGE_FILE_DIALOG_EXTENSIONS,
  formatImageBytes,
  mergeInspectedItems,
} from "../image-batch/imageBatchModel";
import {
  PRESET_GRADIENT_BACKGROUNDS,
  PRESET_SOLID_BACKGROUNDS,
  computeFrameLayout,
  normalizeHexColor,
} from "./layout";
import "../image-batch/imageBatchShell.css";

const extraCopy = {
  "zh-CN": {
    singleMode: "单图美化",
    batchMode: "批量套用",
    pasteClipboard: "粘贴剪贴板图片",
    copyResult: "复制美化结果",
    copiedOk: "已复制美化后的高清图片到剪贴板",
    sendWatermark: "送往图片水印 (I13)",
    bgKindLabel: "背景类型",
    bgSolid: "纯色",
    bgGradient: "渐变",
    bgImage: "背景图",
    gradPresets: "渐变预设",
    gradStart: "起始色",
    gradEnd: "结束色",
    gradAngle: "渐变角度",
    chooseBgImage: "选择本地背景图…",
    clearBgImage: "移除背景图",
    bgImageHint: "背景图按居中裁切（Cover）铺满画布，预览与导出构图完全一致。",
    aspect45: "4 : 5",
    aspect916: "9 : 16",
    memoryBadge: "内存直传原图",
    fitAll: "完整构图",
    scrollTall: "长图滚动预览",
    batchAddFiles: "添加多张图片",
    batchAddFolder: "添加文件夹",
    batchClear: "清空队列",
    batchOutLabel: "输出目录（批处理自动防覆盖）",
    batchChooseOut: "选择输出目录…",
    batchRun: (n: number) => (n > 0 ? `批量套用并导出 (${n} 张)` : "批量套用并导出"),
    batchCancel: "取消任务",
    batchOpenOut: "打开输出目录",
    batchSummary: (ok: number, skip: number, fail: number, cancelled: boolean) =>
      `${cancelled ? "已取消 · " : ""}成功 ${ok}${skip > 0 ? ` · 跳过 ${skip}` : ""}${fail > 0 ? ` · 失败 ${fail}` : ""}`,
    batchEmpty: "添加多张图片或文件夹，点击队列中任意图片可即时预览当前背景与比例效果。",
    bgMissingWarn: "请先选择一张本地背景图后再导出。",
  },
  "en-US": {
    singleMode: "Single",
    batchMode: "Batch Apply",
    pasteClipboard: "Paste Clipboard",
    copyResult: "Copy Image",
    copiedOk: "Copied full-resolution beautified image to clipboard",
    sendWatermark: "Send to Watermark (I13)",
    bgKindLabel: "Background Type",
    bgSolid: "Solid",
    bgGradient: "Gradient",
    bgImage: "Image",
    gradPresets: "Gradient Presets",
    gradStart: "Start",
    gradEnd: "End",
    gradAngle: "Angle",
    chooseBgImage: "Choose Background Image…",
    clearBgImage: "Remove Image",
    bgImageHint:
      "Background image fills the canvas with centered Cover framing matching export 1:1.",
    aspect45: "4 : 5",
    aspect916: "9 : 16",
    memoryBadge: "In-Memory Handoff",
    fitAll: "Fit Full Frame",
    scrollTall: "Scroll Tall Preview",
    batchAddFiles: "Add Images",
    batchAddFolder: "Add Folder",
    batchClear: "Clear Queue",
    batchOutLabel: "Output Directory (non-overwrite)",
    batchChooseOut: "Choose Folder…",
    batchRun: (n: number) => (n > 0 ? `Apply & Export (${n})` : "Apply & Export"),
    batchCancel: "Cancel",
    batchOpenOut: "Open Output Folder",
    batchSummary: (ok: number, skip: number, fail: number, cancelled: boolean) =>
      `${cancelled ? "Cancelled · " : ""}Done ${ok}${skip > 0 ? ` · Skipped ${skip}` : ""}${fail > 0 ? ` · Failed ${fail}` : ""}`,
    batchEmpty:
      "Add images or folders to apply this exact frame style in bulk. Click any queued item to preview.",
    bgMissingWarn: "Select a background image file before exporting.",
  },
};

export function ScreenshotBeautifierWorkspace() {
  const { locale, t } = useI18n();
  const ext = extraCopy[locale];
  const {
    session,
    updateBeautifierSession,
    startBeautifyBatch,
    cancelBeautifyBatch,
    handoffImageToTool,
  } = useSessionStore();
  const st = session.beautifier;

  const stageHostRef = useRef<HTMLDivElement | null>(null);
  const [hostBounds, setHostBounds] = useState<{ w: number; h: number }>({ w: 640, h: 420 });
  const [colorDraft, setColorDraft] = useState(st.backgroundColor);
  const [dropHover, setDropHover] = useState(false);
  const [loadingSource, setLoadingSource] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [scrollTallMode, setScrollTallMode] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [pendingOverwritePath, setPendingOverwritePath] = useState<string | null>(null);

  const hasWatermarkTool = useMemo(() => findRegisteredTool("I13") !== undefined, []);
  const batchBusy = st.batchStatus === "running";

  useEffect(() => {
    setColorDraft(st.backgroundColor);
  }, [st.backgroundColor]);

  useEffect(() => {
    const el = stageHostRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 40 && rect.height > 40) {
        setHostBounds({ w: rect.width - 32, h: rect.height - 32 });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Active preview source (single image OR selected item in batch queue)
  const selectedBatchItem =
    st.batchItems.find((i) => i.path === st.batchSelectedPath) ?? st.batchItems[0] ?? null;

  const activeWidth =
    st.mode === "single" ? st.sourceWidth : (selectedBatchItem?.displayWidth ?? null);
  const activeHeight =
    st.mode === "single" ? st.sourceHeight : (selectedBatchItem?.displayHeight ?? null);
  const activePreviewUrl =
    st.mode === "single" ? st.previewDataUrl : (selectedBatchItem?.thumbnailDataUrl ?? null);
  const activeFileName =
    st.mode === "single" ? st.sourceFileName : (selectedBatchItem?.fileName ?? null);
  const hasSingleSource = Boolean(st.sourcePath || st.assetId);

  const layout = useMemo(() => {
    if (!activeWidth || !activeHeight) return null;
    return computeFrameLayout({
      sourceWidth: activeWidth,
      sourceHeight: activeHeight,
      padding: st.padding,
      cornerRadius: st.cornerRadius,
      shadowStrength: st.shadowStrength,
      aspectRatio: st.aspectRatio,
    });
  }, [activeWidth, activeHeight, st.padding, st.cornerRadius, st.shadowStrength, st.aspectRatio]);

  // Exact proportional scale — NEVER clamps width independently of height so ultra-tall
  // screenshots and tiny images both keep 100% faithful framing ratio!
  const previewScale = useMemo(() => {
    if (!layout) return 1;
    if (scrollTallMode) {
      return Math.min(hostBounds.w / layout.canvasWidth, 1);
    }
    return Math.min(hostBounds.w / layout.canvasWidth, hostBounds.h / layout.canvasHeight, 1);
  }, [hostBounds, layout, scrollTallMode]);

  const currentStyle: BeautifyStyleConfig = useMemo(
    () => ({
      backgroundKind: st.backgroundKind,
      backgroundHex: st.backgroundColor,
      gradientStartHex: st.gradientStartHex,
      gradientEndHex: st.gradientEndHex,
      gradientAngleDeg: st.gradientAngleDeg,
      backgroundImagePath: st.backgroundImagePath,
      padding: st.padding,
      cornerRadius: st.cornerRadius,
      shadowStrength: st.shadowStrength,
      aspectRatio: st.aspectRatio,
    }),
    [
      st.aspectRatio,
      st.backgroundColor,
      st.backgroundImagePath,
      st.backgroundKind,
      st.cornerRadius,
      st.gradientAngleDeg,
      st.gradientEndHex,
      st.gradientStartHex,
      st.padding,
      st.shadowStrength,
    ],
  );

  const bgMissing = st.backgroundKind === "image" && !st.backgroundImagePath;

  const loadSingleImagePath = useCallback(
    async (filePath: string) => {
      setErrorText(null);
      setLoadingSource(true);
      try {
        const info = await inspectBeautifierSourceImage(filePath);
        updateBeautifierSession({
          mode: "single",
          sourcePath: info.path,
          assetId: null,
          sourceFileName: info.fileName,
          previewDataUrl: info.previewDataUrl,
          sourceWidth: info.width,
          sourceHeight: info.height,
          hasAlpha: info.hasAlpha,
          lastSavedMessage: null,
        });
      } catch (err) {
        setErrorText(formatLocalizedError(err, t));
      } finally {
        setLoadingSource(false);
      }
    },
    [t, updateBeautifierSession],
  );

  const addBatchPaths = useCallback(
    async (paths: string[]) => {
      setErrorText(null);
      setLoadingSource(true);
      try {
        const inspected = await inspectBatchImages(paths);
        updateBeautifierSession((prev) => {
          const merged = mergeInspectedItems(prev.batchItems, inspected.items);
          return {
            ...prev,
            mode: "batch",
            batchItems: merged,
            batchSelectedPath: prev.batchSelectedPath ?? merged[0]?.path ?? null,
            batchErrorMessage: null,
          };
        });
      } catch (err) {
        setErrorText(formatLocalizedError(err, t));
      } finally {
        setLoadingSource(false);
      }
    },
    [t, updateBeautifierSession],
  );

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: (hovering) => setDropHover(hovering),
          onDropPaths: (paths) => {
            if (paths.length > 1 || st.mode === "batch") {
              void addBatchPaths(paths);
            } else if (paths[0]) {
              void loadSingleImagePath(paths[0]);
            }
          },
        }),
      "beautifier-file-drop",
    );
  }, [addBatchPaths, loadSingleImagePath, st.mode]);

  const handleChooseImage = async () => {
    const chosen = await pickSingleFile({
      title: t.beautifierTool.selectImageBtn,
      filters: [{ name: "Images", extensions: IMAGE_FILE_DIALOG_EXTENSIONS }],
    });
    if (chosen) {
      await loadSingleImagePath(chosen);
    }
  };

  const handlePasteClipboard = async () => {
    setErrorText(null);
    setLoadingSource(true);
    try {
      const asset = await readClipboardImageAsAsset();
      updateBeautifierSession({
        mode: "single",
        sourcePath: null,
        assetId: asset.assetId,
        sourceFileName: asset.label,
        previewDataUrl: asset.dataUrl,
        sourceWidth: asset.width,
        sourceHeight: asset.height,
        hasAlpha: asset.hasAlpha,
        lastSavedMessage: null,
      });
    } catch (err) {
      setErrorText(formatLocalizedError(err, t));
    } finally {
      setLoadingSource(false);
    }
  };

  const handleChooseBackgroundImage = async () => {
    const chosen = await pickSingleFile({
      title: ext.chooseBgImage,
      filters: [{ name: "Images", extensions: IMAGE_FILE_DIALOG_EXTENSIONS }],
    });
    if (!chosen) return;
    setErrorText(null);
    try {
      const info = await inspectBeautifierSourceImage(chosen);
      updateBeautifierSession({
        backgroundKind: "image",
        backgroundImagePath: info.path,
        backgroundImagePreviewUrl: info.previewDataUrl,
        lastSavedMessage: null,
      });
    } catch (err) {
      setErrorText(formatLocalizedError(err, t));
    }
  };

  const handleClearImage = () => {
    setErrorText(null);
    updateBeautifierSession({
      sourcePath: null,
      assetId: null,
      sourceFileName: null,
      previewDataUrl: null,
      sourceWidth: null,
      sourceHeight: null,
      hasAlpha: false,
      lastSavedMessage: null,
    });
  };

  const runExport = async (outputPath: string, overwrite: boolean) => {
    if (!hasSingleSource || !layout || layout.exceedsLimits || bgMissing) return;
    setErrorText(null);
    setExporting(true);
    try {
      const exported = await exportBeautifiedImage({
        inputPath: st.sourcePath,
        assetId: st.assetId,
        outputPath,
        backgroundKind: st.backgroundKind,
        backgroundHex: st.backgroundColor,
        gradientStartHex: st.gradientStartHex,
        gradientEndHex: st.gradientEndHex,
        gradientAngleDeg: st.gradientAngleDeg,
        backgroundImagePath: st.backgroundImagePath,
        padding: st.padding,
        cornerRadius: st.cornerRadius,
        shadowStrength: st.shadowStrength,
        aspectRatio: st.aspectRatio,
        overwrite,
      });
      updateBeautifierSession({
        lastSavedMessage: t.beautifierTool.exportedSuccess(
          exported.outputPath,
          exported.outputWidth,
          exported.outputHeight,
        ),
      });
    } catch (err) {
      const parsed = parseBackendError(err);
      if (parsed.code === "TARGET_ALREADY_EXISTS" && !overwrite) {
        setPendingOverwritePath(outputPath);
        return;
      }
      setErrorText(formatLocalizedError(err, t));
    } finally {
      setExporting(false);
    }
  };

  const handleExportClick = async () => {
    if (!hasSingleSource || !layout || layout.exceedsLimits || bgMissing) return;
    const defaultPath = st.sourcePath
      ? ((await suggestSafeSiblingPath(st.sourcePath, "_framed", "png")) ?? "screenshot_framed.png")
      : "screenshot_framed.png";
    const chosen = await pickSaveFilePath({
      title: t.beautifierTool.exportPngBtn,
      defaultPath,
      filters: [{ name: "PNG Image", extensions: ["png"] }],
    });
    if (chosen) {
      await runExport(chosen, false);
    }
  };

  const handleCopyBeautified = async () => {
    if (!hasSingleSource || !layout || layout.exceedsLimits || bgMissing) return;
    setErrorText(null);
    setExporting(true);
    try {
      const rendered = await renderBeautifiedAsset({
        inputPath: st.sourcePath,
        assetId: st.assetId,
        label: st.sourceFileName ?? "beautified.png",
        style: currentStyle,
      });
      await copyImageAssetToClipboard({ assetId: rendered.assetId, dataUrl: rendered.dataUrl });
      updateBeautifierSession({ lastSavedMessage: ext.copiedOk });
    } catch (err) {
      setErrorText(formatLocalizedError(err, t));
    } finally {
      setExporting(false);
    }
  };

  const handleSendToWatermark = async () => {
    if (!hasSingleSource || !layout || layout.exceedsLimits || bgMissing) return;
    setErrorText(null);
    setExporting(true);
    try {
      const rendered = await renderBeautifiedAsset({
        inputPath: st.sourcePath,
        assetId: st.assetId,
        label: st.sourceFileName ?? "beautified.png",
        style: currentStyle,
      });
      handoffImageToTool("I13", rendered);
    } catch (err) {
      setErrorText(formatLocalizedError(err, t));
    } finally {
      setExporting(false);
    }
  };

  const handleBatchPickFiles = async () => {
    const picked = await pickMultipleFiles({
      title: ext.batchAddFiles,
      filters: [{ name: "Images", extensions: IMAGE_FILE_DIALOG_EXTENSIONS }],
    });
    if (picked.length > 0) await addBatchPaths(picked);
  };

  const handleBatchPickFolders = async () => {
    const picked = await pickMultipleDirectories({ title: ext.batchAddFolder });
    if (picked.length > 0) await addBatchPaths(picked);
  };

  const handleBatchPickOutput = async () => {
    const dir = await pickSingleDirectory({ title: ext.batchChooseOut });
    if (dir) updateBeautifierSession({ batchOutputDir: dir });
  };

  const handleBatchExecute = () => {
    if (batchBusy || st.batchItems.length === 0 || !st.batchOutputDir || bgMissing) return;
    void startBeautifyBatch(
      {
        sourcePaths: st.batchItems.map((i) => i.path),
        outputDir: st.batchOutputDir,
        style: currentStyle,
      },
      (err) => formatLocalizedError(err, t),
    );
  };

  const canvasBackgroundStyle =
    st.backgroundKind === "gradient"
      ? {
          backgroundImage: `linear-gradient(${st.gradientAngleDeg}deg, ${st.gradientStartHex}, ${st.gradientEndHex})`,
        }
      : { backgroundColor: st.backgroundColor };

  return (
    <div className="tool-workspace">
      <div className="tool-toolbar">
        <div className="tool-toolbar-group">
          <div className="segmented" role="group" aria-label="Beautifier mode">
            <button
              type="button"
              className={`segmented-btn ${st.mode === "single" ? "is-selected" : ""}`}
              aria-pressed={st.mode === "single"}
              disabled={batchBusy}
              onClick={() => updateBeautifierSession({ mode: "single" })}
            >
              <span>{ext.singleMode}</span>
            </button>
            <button
              type="button"
              className={`segmented-btn ${st.mode === "batch" ? "is-selected" : ""}`}
              aria-pressed={st.mode === "batch"}
              disabled={exporting}
              onClick={() => updateBeautifierSession({ mode: "batch" })}
            >
              <Images size={13} strokeWidth={1.75} aria-hidden="true" />
              <span>{ext.batchMode}</span>
            </button>
          </div>

          {st.mode === "single" ? (
            <>
              <button
                type="button"
                className="btn"
                disabled={loadingSource || exporting}
                onClick={handleChooseImage}
              >
                {hasSingleSource ? (
                  <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
                ) : (
                  <ImagePlus size={14} strokeWidth={1.75} aria-hidden="true" />
                )}
                <span>
                  {hasSingleSource
                    ? t.beautifierTool.replaceImageBtn
                    : t.beautifierTool.selectImageBtn}
                </span>
              </button>

              <button
                type="button"
                className="btn"
                disabled={loadingSource || exporting}
                onClick={() => void handlePasteClipboard()}
              >
                <ClipboardPaste size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{ext.pasteClipboard}</span>
              </button>

              {hasSingleSource && (
                <button
                  type="button"
                  className="btn"
                  disabled={exporting}
                  onClick={handleClearImage}
                >
                  <Eraser size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{t.beautifierTool.clearImageBtn}</span>
                </button>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn"
                disabled={loadingSource || batchBusy}
                onClick={() => void handleBatchPickFiles()}
              >
                <ImagePlus size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{ext.batchAddFiles}</span>
              </button>
              <button
                type="button"
                className="btn"
                disabled={loadingSource || batchBusy}
                onClick={() => void handleBatchPickFolders()}
              >
                <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{ext.batchAddFolder}</span>
              </button>
              {st.batchItems.length > 0 && (
                <button
                  type="button"
                  className="btn"
                  disabled={batchBusy}
                  onClick={() =>
                    updateBeautifierSession({
                      batchItems: [],
                      batchSelectedPath: null,
                      batchLastReport: null,
                    })
                  }
                >
                  <span>{ext.batchClear}</span>
                </button>
              )}
            </>
          )}
        </div>

        <div className="tool-toolbar-group">
          {st.mode === "single" && (
            <>
              <button
                type="button"
                className="btn"
                disabled={
                  !hasSingleSource || !layout || layout.exceedsLimits || exporting || bgMissing
                }
                onClick={() => void handleCopyBeautified()}
              >
                <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{ext.copyResult}</span>
              </button>

              {hasWatermarkTool && (
                <button
                  type="button"
                  className="btn"
                  disabled={
                    !hasSingleSource || !layout || layout.exceedsLimits || exporting || bgMissing
                  }
                  onClick={() => void handleSendToWatermark()}
                >
                  <Stamp size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{ext.sendWatermark}</span>
                </button>
              )}

              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  !hasSingleSource ||
                  !layout ||
                  layout.exceedsLimits ||
                  exporting ||
                  loadingSource ||
                  bgMissing
                }
                onClick={handleExportClick}
              >
                <Download size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>
                  {exporting ? t.beautifierTool.exportingBtn : t.beautifierTool.exportPngBtn}
                </span>
              </button>
            </>
          )}
        </div>
      </div>

      {bgMissing && (
        <div className="status-banner" role="status">
          <span>{ext.bgMissingWarn}</span>
        </div>
      )}

      {(errorText || st.batchErrorMessage) && (
        <div className="status-banner is-err" role="alert">
          <span>{errorText ?? st.batchErrorMessage}</span>
        </div>
      )}

      {layout?.exceedsLimits && (
        <div className="status-banner is-err" role="alert">
          <span>
            {t.errors.SIZE_LIMIT_EXCEEDED} ({layout.canvasWidth} × {layout.canvasHeight} px)
          </span>
        </div>
      )}

      {st.lastSavedMessage && !errorText && st.mode === "single" && (
        <div className="status-banner is-ok" role="status" aria-live="polite">
          <span>{st.lastSavedMessage}</span>
        </div>
      )}

      <div className="beautifier-grid">
        {/* Left: Live Preview Stage */}
        <div className={`pane ${dropHover ? "is-drop-hover" : ""}`}>
          <div className="pane-header">
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className="pane-title">{t.beautifierTool.previewLabel}</span>
              {st.mode === "single" && st.assetId && (
                <span className="badge badge-ok">{ext.memoryBadge}</span>
              )}
              {activeFileName && (
                <span
                  className="field-hint"
                  style={{
                    maxWidth: 200,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {activeFileName}
                </span>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {layout && activeWidth && activeHeight && (
                <span
                  className="mono"
                  style={{ fontSize: "11.5px", color: "var(--text-secondary)" }}
                >
                  {t.beautifierTool.sourceSizeLabel}: {activeWidth}×{activeHeight} px ·{" "}
                  {t.beautifierTool.outputSizeLabel}:{" "}
                  <strong>
                    {layout.canvasWidth}×{layout.canvasHeight} px
                  </strong>
                </span>
              )}
              {layout && layout.canvasHeight > layout.canvasWidth * 1.4 && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ padding: "2px 8px", fontSize: 11.5 }}
                  onClick={() => setScrollTallMode((v) => !v)}
                >
                  {scrollTallMode ? ext.fitAll : ext.scrollTall}
                </button>
              )}
            </div>
          </div>

          <div
            ref={stageHostRef}
            style={{
              flex: 1,
              minHeight: "340px",
              maxHeight: "500px",
              display: "flex",
              alignItems: scrollTallMode ? "flex-start" : "center",
              justifyContent: "center",
              padding: "16px",
              background: "var(--bg-subtle)",
              overflow: scrollTallMode ? "auto" : "hidden",
            }}
          >
            {!activePreviewUrl || !layout ? (
              <div className="empty-state" style={{ maxWidth: "420px" }}>
                <strong
                  style={{ display: "block", marginBottom: "6px", color: "var(--text-primary)" }}
                >
                  {t.beautifierTool.emptyTitle}
                </strong>
                <p style={{ margin: "0 0 12px", fontSize: "12.5px" }}>
                  {st.mode === "batch" ? ext.batchEmpty : t.beautifierTool.emptyDesc}
                </p>
                {st.mode === "single" ? (
                  <button type="button" className="btn btn-primary" onClick={handleChooseImage}>
                    <ImagePlus size={14} strokeWidth={1.75} aria-hidden="true" />
                    <span>{t.beautifierTool.selectImageBtn}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void handleBatchPickFiles()}
                  >
                    <ImagePlus size={14} strokeWidth={1.75} aria-hidden="true" />
                    <span>{ext.batchAddFiles}</span>
                  </button>
                )}
              </div>
            ) : (
              <div
                data-testid="beautifier-preview-canvas"
                style={{
                  position: "relative",
                  width: `${Math.max(1, layout.canvasWidth * previewScale).toFixed(1)}px`,
                  height: `${Math.max(1, layout.canvasHeight * previewScale).toFixed(1)}px`,
                  ...canvasBackgroundStyle,
                  borderRadius: "4px",
                  boxShadow: "var(--shadow-sm)",
                  overflow: "hidden",
                  flexShrink: 0,
                }}
              >
                {st.backgroundKind === "image" && st.backgroundImagePreviewUrl && (
                  <img
                    src={st.backgroundImagePreviewUrl}
                    alt="Background"
                    draggable={false}
                    style={{
                      position: "absolute",
                      inset: 0,
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                      objectPosition: "center",
                      pointerEvents: "none",
                    }}
                  />
                )}
                <img
                  src={activePreviewUrl}
                  alt={activeFileName ?? "Screenshot preview"}
                  draggable={false}
                  style={{
                    position: "absolute",
                    left: `${(layout.imageX * previewScale).toFixed(1)}px`,
                    top: `${(layout.imageY * previewScale).toFixed(1)}px`,
                    width: `${(layout.imageWidth * previewScale).toFixed(1)}px`,
                    height: `${(layout.imageHeight * previewScale).toFixed(1)}px`,
                    borderRadius: `${(layout.effectiveRadius * previewScale).toFixed(1)}px`,
                    boxShadow:
                      layout.shadowOpacity > 0
                        ? `0px ${(layout.shadowOffsetY * previewScale).toFixed(1)}px ${(layout.shadowBlur * 2 * previewScale).toFixed(1)}px rgba(0, 0, 0, ${layout.shadowOpacity.toFixed(3)})`
                        : "none",
                    display: "block",
                  }}
                />
              </div>
            )}
          </div>

          <div
            style={{
              padding: "8px 12px",
              borderTop: "1px solid var(--border-subtle)",
              background: "var(--bg-surface)",
            }}
          >
            <p className="field-hint">{t.beautifierTool.noUpscaleNote}</p>
          </div>
        </div>

        {/* Right: Parameters Panel */}
        <div className="pane" style={{ padding: "14px", gap: "14px", overflowY: "auto" }}>
          {/* Aspect Ratio (5 presets including 4:5 and 9:16) */}
          <div className="field-stack">
            <span className="field-label">{t.beautifierTool.aspectLabel}</span>
            <div
              className="segmented"
              role="group"
              aria-label={t.beautifierTool.aspectLabel}
              style={{ flexWrap: "wrap" }}
            >
              {(
                [
                  ["original", t.beautifierTool.aspectOriginal],
                  ["1:1", t.beautifierTool.aspectSquare],
                  ["16:9", t.beautifierTool.aspectWide],
                  ["4:5", ext.aspect45],
                  ["9:16", ext.aspect916],
                ] as Array<[BeautifierAspect, string]>
              ).map(([ratio, label]) => (
                <button
                  key={ratio}
                  type="button"
                  style={{ flex: "1 1 56px" }}
                  className={`segmented-btn ${st.aspectRatio === ratio ? "is-selected" : ""}`}
                  aria-pressed={st.aspectRatio === ratio}
                  onClick={() =>
                    updateBeautifierSession({ aspectRatio: ratio, lastSavedMessage: null })
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Background Type Selector */}
          <div className="field-stack">
            <span className="field-label">{ext.bgKindLabel}</span>
            <div className="segmented" role="group" aria-label={ext.bgKindLabel}>
              {(
                [
                  ["solid", ext.bgSolid],
                  ["gradient", ext.bgGradient],
                  ["image", ext.bgImage],
                ] as Array<[BeautifyBackgroundKind, string]>
              ).map(([kind, label]) => (
                <button
                  key={kind}
                  type="button"
                  style={{ flex: 1 }}
                  className={`segmented-btn ${st.backgroundKind === kind ? "is-selected" : ""}`}
                  aria-pressed={st.backgroundKind === kind}
                  onClick={() =>
                    updateBeautifierSession({ backgroundKind: kind, lastSavedMessage: null })
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Solid Background */}
          {st.backgroundKind === "solid" && (
            <div className="field-stack">
              <span className="field-label">{t.beautifierTool.bgColorLabel}</span>
              <div className="swatch-grid" role="group" aria-label={t.beautifierTool.bgColorLabel}>
                {PRESET_SOLID_BACKGROUNDS.map((preset) => (
                  <button
                    key={preset.hex}
                    type="button"
                    className="swatch-btn"
                    style={{ backgroundColor: preset.hex }}
                    aria-label={locale === "zh-CN" ? preset.labelZh : preset.labelEn}
                    aria-pressed={st.backgroundColor.toUpperCase() === preset.hex}
                    title={`${locale === "zh-CN" ? preset.labelZh : preset.labelEn} (${preset.hex})`}
                    onClick={() =>
                      updateBeautifierSession({
                        backgroundColor: preset.hex,
                        lastSavedMessage: null,
                      })
                    }
                  />
                ))}
              </div>

              <div className="field-row" style={{ marginTop: "4px" }}>
                <label htmlFor="beautifier-color-picker" className="field-hint">
                  {t.beautifierTool.customColorLabel}
                </label>
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <input
                    id="beautifier-color-picker"
                    type="color"
                    value={st.backgroundColor}
                    onChange={(e) => {
                      const hex = e.target.value.toUpperCase();
                      updateBeautifierSession({ backgroundColor: hex, lastSavedMessage: null });
                    }}
                    style={{
                      width: "28px",
                      height: "28px",
                      padding: 0,
                      border: "1px solid var(--border-strong)",
                      borderRadius: "6px",
                      background: "transparent",
                      cursor: "pointer",
                    }}
                  />
                  <input
                    type="text"
                    aria-label="HEX"
                    className="text-input mono"
                    style={{ width: "92px" }}
                    value={colorDraft}
                    onChange={(e) => {
                      const raw = e.target.value;
                      setColorDraft(raw);
                      const valid = normalizeHexColor(raw);
                      if (valid) {
                        updateBeautifierSession({
                          backgroundColor: valid,
                          lastSavedMessage: null,
                        });
                      }
                    }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Gradient Background */}
          {st.backgroundKind === "gradient" && (
            <div className="field-stack">
              <span className="field-label">{ext.gradPresets}</span>
              <div className="swatch-grid" role="group" aria-label={ext.gradPresets}>
                {PRESET_GRADIENT_BACKGROUNDS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="swatch-btn"
                    style={{
                      backgroundImage: `linear-gradient(${preset.angleDeg}deg, ${preset.startHex}, ${preset.endHex})`,
                    }}
                    aria-label={locale === "zh-CN" ? preset.labelZh : preset.labelEn}
                    title={locale === "zh-CN" ? preset.labelZh : preset.labelEn}
                    onClick={() =>
                      updateBeautifierSession({
                        gradientStartHex: preset.startHex,
                        gradientEndHex: preset.endHex,
                        gradientAngleDeg: preset.angleDeg,
                        lastSavedMessage: null,
                      })
                    }
                  />
                ))}
              </div>

              <div className="field-row" style={{ marginTop: 4 }}>
                <label
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}
                >
                  <span>{ext.gradStart}</span>
                  <input
                    type="color"
                    aria-label={ext.gradStart}
                    value={st.gradientStartHex}
                    onChange={(e) =>
                      updateBeautifierSession({
                        gradientStartHex: e.target.value.toUpperCase(),
                        lastSavedMessage: null,
                      })
                    }
                    style={{
                      width: 26,
                      height: 26,
                      border: "1px solid var(--border-strong)",
                      borderRadius: 6,
                    }}
                  />
                </label>
                <label
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}
                >
                  <span>{ext.gradEnd}</span>
                  <input
                    type="color"
                    aria-label={ext.gradEnd}
                    value={st.gradientEndHex}
                    onChange={(e) =>
                      updateBeautifierSession({
                        gradientEndHex: e.target.value.toUpperCase(),
                        lastSavedMessage: null,
                      })
                    }
                    style={{
                      width: 26,
                      height: 26,
                      border: "1px solid var(--border-strong)",
                      borderRadius: 6,
                    }}
                  />
                </label>
              </div>

              <div className="field-row">
                <label htmlFor="beautifier-grad-angle" className="field-hint">
                  {ext.gradAngle}
                </label>
                <span className="mono field-hint">{st.gradientAngleDeg}°</span>
              </div>
              <input
                id="beautifier-grad-angle"
                type="range"
                className="range-input"
                min={0}
                max={360}
                step={5}
                value={st.gradientAngleDeg}
                onChange={(e) =>
                  updateBeautifierSession({
                    gradientAngleDeg: Number(e.target.value),
                    lastSavedMessage: null,
                  })
                }
              />
            </div>
          )}

          {/* Custom Background Image */}
          {st.backgroundKind === "image" && (
            <div className="field-stack">
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void handleChooseBackgroundImage()}
                >
                  <ImagePlus size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{ext.chooseBgImage}</span>
                </button>
                {st.backgroundImagePath && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() =>
                      updateBeautifierSession({
                        backgroundImagePath: null,
                        backgroundImagePreviewUrl: null,
                      })
                    }
                  >
                    <span>{ext.clearBgImage}</span>
                  </button>
                )}
              </div>
              {st.backgroundImagePath && (
                <div className="img-batch-path-box" title={st.backgroundImagePath}>
                  {st.backgroundImagePath}
                </div>
              )}
              <p className="field-hint">{ext.bgImageHint}</p>
            </div>
          )}

          {/* Padding */}
          <div className="field-stack">
            <div className="field-row">
              <label htmlFor="beautifier-padding" className="field-label">
                {t.beautifierTool.paddingLabel}
              </label>
              <span className="mono field-hint">{st.padding} px</span>
            </div>
            <input
              id="beautifier-padding"
              type="range"
              className="range-input"
              min={0}
              max={240}
              step={4}
              value={st.padding}
              onChange={(e) =>
                updateBeautifierSession({
                  padding: Number(e.target.value),
                  lastSavedMessage: null,
                })
              }
            />
          </div>

          {/* Corner Radius */}
          <div className="field-stack">
            <div className="field-row">
              <label htmlFor="beautifier-radius" className="field-label">
                {t.beautifierTool.radiusLabel}
              </label>
              <span className="mono field-hint">
                {layout ? layout.effectiveRadius : st.cornerRadius} px
              </span>
            </div>
            <input
              id="beautifier-radius"
              type="range"
              className="range-input"
              min={0}
              max={160}
              step={2}
              value={st.cornerRadius}
              onChange={(e) =>
                updateBeautifierSession({
                  cornerRadius: Number(e.target.value),
                  lastSavedMessage: null,
                })
              }
            />
          </div>

          {/* Drop Shadow */}
          <div className="field-stack">
            <div className="field-row">
              <label htmlFor="beautifier-shadow" className="field-label">
                {t.beautifierTool.shadowLabel}
              </label>
              <span className="mono field-hint">{st.shadowStrength}%</span>
            </div>
            <input
              id="beautifier-shadow"
              type="range"
              className="range-input"
              min={0}
              max={100}
              step={2}
              value={st.shadowStrength}
              onChange={(e) =>
                updateBeautifierSession({
                  shadowStrength: Number(e.target.value),
                  lastSavedMessage: null,
                })
              }
            />
          </div>

          {/* Batch Output Directory & Run Controls */}
          {st.mode === "batch" && (
            <div
              className="field-stack"
              style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: 12 }}
            >
              <span className="field-label">{ext.batchOutLabel}</span>
              <div
                className={`img-batch-path-box ${st.batchOutputDir ? "" : "is-placeholder"}`}
                title={st.batchOutputDir || undefined}
              >
                {st.batchOutputDir || ext.batchChooseOut}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={batchBusy}
                  onClick={() => void handleBatchPickOutput()}
                >
                  {ext.batchChooseOut}
                </button>
                {batchBusy ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ flex: 1 }}
                    onClick={() => void cancelBeautifyBatch()}
                  >
                    {ext.batchCancel}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ flex: 1 }}
                    disabled={st.batchItems.length === 0 || !st.batchOutputDir || bgMissing}
                    onClick={handleBatchExecute}
                  >
                    {ext.batchRun(st.batchItems.length)}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Batch Queue & Results Strip */}
      {st.mode === "batch" && (st.batchItems.length > 0 || st.batchLastReport) && (
        <section className="img-batch-queue-card" style={{ marginTop: 8 }}>
          {st.batchLiveProgress && (
            <div style={{ fontSize: 12.5 }}>
              <strong>
                {st.batchLiveProgress.currentIndex}/{st.batchLiveProgress.totalItems} ·{" "}
                {st.batchLiveProgress.currentFileName}
              </strong>
            </div>
          )}

          {st.batchItems.length > 0 && (
            <div className="img-batch-strip">
              {st.batchItems.map((item) => (
                <div
                  key={item.path}
                  role="button"
                  tabIndex={0}
                  className={`img-batch-item-card ${selectedBatchItem?.path === item.path ? "is-selected" : ""}`}
                  onClick={() => updateBeautifierSession({ batchSelectedPath: item.path })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      updateBeautifierSession({ batchSelectedPath: item.path });
                    }
                  }}
                >
                  {item.thumbnailDataUrl ? (
                    <img src={item.thumbnailDataUrl} alt="" className="img-batch-thumb" />
                  ) : (
                    <div className="img-batch-thumb-placeholder">!</div>
                  )}
                  <div className="img-batch-item-meta">
                    <span className="img-batch-item-name" title={item.path}>
                      {item.fileName}
                    </span>
                    <span className="img-batch-item-sub">
                      {item.displayWidth}×{item.displayHeight} · {formatImageBytes(item.byteLength)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="img-batch-remove-btn"
                    disabled={batchBusy}
                    aria-label={item.fileName}
                    onClick={(e) => {
                      e.stopPropagation();
                      updateBeautifierSession((prev) => {
                        const next = prev.batchItems.filter((i) => i.path !== item.path);
                        return {
                          ...prev,
                          batchItems: next,
                          batchSelectedPath:
                            prev.batchSelectedPath === item.path
                              ? (next[0]?.path ?? null)
                              : prev.batchSelectedPath,
                        };
                      });
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {st.batchLastReport && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="img-batch-toolbar">
                <span className="badge badge-ok">
                  {ext.batchSummary(
                    st.batchLastReport.succeededCount,
                    st.batchLastReport.skippedCount,
                    st.batchLastReport.failedCount,
                    st.batchLastReport.cancelled,
                  )}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void openLocalDirectory(st.batchLastReport!.outputDir)}
                >
                  {ext.batchOpenOut}
                </button>
              </div>
              <div className="img-batch-results-table-wrap">
                <table className="img-batch-table">
                  <tbody>
                    {st.batchLastReport.items.map((row, idx) => (
                      <tr key={`${row.sourcePath}-${idx}`}>
                        <td className="img-batch-mono">{row.fileName}</td>
                        <td>
                          <span
                            className={`badge ${row.status === "ok" ? "badge-ok" : "badge-err"}`}
                          >
                            {row.status}
                          </span>
                        </td>
                        <td>
                          {row.outputWidth && row.outputHeight
                            ? `${row.outputWidth}×${row.outputHeight}`
                            : "—"}
                        </td>
                        <td className="img-batch-hint">{row.outputPath ?? row.message ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      <ConfirmDialog
        open={pendingOverwritePath !== null}
        title={t.beautifierTool.overwriteConfirmTitle}
        body={t.beautifierTool.overwriteConfirmBody(pendingOverwritePath ?? "")}
        confirmLabel={t.beautifierTool.overwriteConfirmAccept}
        cancelLabel={t.beautifierTool.cancel}
        onCancel={() => setPendingOverwritePath(null)}
        onConfirm={async () => {
          const target = pendingOverwritePath;
          setPendingOverwritePath(null);
          if (target) {
            await runExport(target, true);
          }
        }}
      />
    </div>
  );
}
