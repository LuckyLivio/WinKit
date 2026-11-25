import {
  AlertTriangle,
  ArrowLeftRight,
  ClipboardCopy,
  ClipboardPaste,
  Crop,
  Download,
  Eraser,
  Frame,
  ImagePlus,
  Layers,
  Pencil,
  Play,
  Scissors,
  Stamp,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore, type RemoveBackgroundViewMode } from "../../lib/sessionStore";
import {
  bindDisposableListener,
  copyMattingResultToClipboard,
  exportMattingResult,
  formatLocalizedError,
  getImageAsset,
  openLocalDirectory,
  parseBackendError,
  pickSaveFilePath,
  pickSingleFile,
  subscribeFileDrop,
  suggestSafeSiblingPath,
  type MattingBackgroundMode,
  type MattingExportFormat,
  type MattingExportRequest,
  type MattingModelStatus,
  type SubjectBoundingBox,
} from "../../lib/tauriBridge";
import { IMAGE_FILE_DIALOG_EXTENSIONS, formatImageBytes } from "../image-batch/imageBatchModel";
import { MattingModelSetupPanel } from "./MattingModelSetupPanel";
import "../media-shared/mediaWorkspace.css";
import "./removeBackground.css";

const SOLID_COLOR_PRESETS = [
  { hex: "#FFFFFF", zh: "纯白", en: "White" },
  { hex: "#000000", zh: "纯黑", en: "Black" },
  { hex: "#2563EB", zh: "证件蓝", en: "ID Blue" },
  { hex: "#DC2626", zh: "证件红", en: "ID Red" },
  { hex: "#F3F4F6", zh: "浅灰", en: "Light Gray" },
];

const CROP_PADDING_PRESETS = [0, 16, 32, 64];

function computePaddedCropRect(
  imageWidth: number,
  imageHeight: number,
  bbox: SubjectBoundingBox,
  paddingPx: number,
): SubjectBoundingBox {
  const pad = Math.max(0, Math.min(512, Math.round(paddingPx)));
  const x0 = Math.max(0, bbox.x - pad);
  const y0 = Math.max(0, bbox.y - pad);
  const x1 = Math.min(imageWidth, bbox.x + bbox.width + pad);
  const y1 = Math.min(imageHeight, bbox.y + bbox.height + pad);
  return {
    x: x0,
    y: y0,
    width: Math.max(1, x1 - x0),
    height: Math.max(1, y1 - y0),
  };
}

function normalizeHexInput(raw: string, fallback: string): string {
  const cleaned = raw.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    return `#${cleaned.toUpperCase()}`;
  }
  return fallback;
}

function formatPhaseLabel(phase: string, isZh: boolean): string {
  switch (phase) {
    case "decoding":
      return isZh ? "正在解码图片并校正 EXIF 方向…" : "Decoding image & EXIF orientation...";
    case "preparing":
      return isZh ? "正在准备 512×512 模型输入…" : "Preparing 512×512 model input...";
    case "inferring":
      return isZh
        ? "正在本地 CPU 离线推理前景蒙版（BiRefNet_lite）…"
        : "Running local offline foreground segmentation (BiRefNet_lite)...";
    case "compositing":
      return isZh
        ? "正在合成全分辨率 Alpha 透明通道与预览…"
        : "Compositing full-resolution alpha channel & previews...";
    case "completed":
      return isZh ? "抠图完成" : "Cutout complete";
    default:
      return isZh ? "正在离线处理…" : "Processing offline...";
  }
}

function parentDirectoryOf(filePath: string): string | null {
  const idx = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
  if (idx <= 0) return null;
  return filePath.slice(0, idx);
}

interface PendingOverwriteExport {
  request: MattingExportRequest;
  bindingKey: string;
  seq: number;
}

export function RemoveBackgroundWorkspace() {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const {
    session,
    updateRemoveBackgroundSession,
    loadRemoveBackgroundFile,
    pasteRemoveBackgroundClipboard,
    clearRemoveBackgroundSession,
    startRemoveBackground,
    cancelRemoveBackground,
    handoffImageToTool,
  } = useSessionStore();
  const state = session.removeBackground;

  const [modelStatus, setModelStatus] = useState<MattingModelStatus | null>(null);
  const [dragging, setDragging] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [copying, setCopying] = useState(false);
  const [hexDraft, setHexDraft] = useState(state.backgroundHex);
  const [localError, setLocalError] = useState<string | null>(null);
  const [lastSavedPath, setLastSavedPath] = useState<string | null>(null);
  const [pendingOverwrite, setPendingOverwrite] = useState<PendingOverwriteExport | null>(null);

  const mountedRef = useRef(true);
  const exportSeqRef = useRef(0);

  const exportBindingKey = useMemo(() => {
    if (!state.result) return null;
    return JSON.stringify({
      sourceGeneration: state.sourceGeneration,
      resultId: state.result.resultId,
      sourcePath: state.sourcePath,
      sourceAssetId: state.sourceAssetId,
      backgroundMode: state.backgroundMode,
      backgroundHex: state.backgroundMode === "solid_color" ? state.backgroundHex : null,
      exportFormat: state.exportFormat,
      exportQuality: state.exportFormat === "png" ? null : state.exportQuality,
      cropToSubject: state.cropToSubject,
      cropPaddingPx: state.cropToSubject ? state.cropPaddingPx : 0,
    });
  }, [
    state.sourceGeneration,
    state.result,
    state.sourcePath,
    state.sourceAssetId,
    state.backgroundMode,
    state.backgroundHex,
    state.exportFormat,
    state.exportQuality,
    state.cropToSubject,
    state.cropPaddingPx,
  ]);

  const liveExportBindingRef = useRef<string | null>(exportBindingKey);
  liveExportBindingRef.current = exportBindingKey;

  const isExportStillCurrent = useCallback(
    (bindingKey: string, seq: number) =>
      mountedRef.current &&
      liveExportBindingRef.current === bindingKey &&
      exportSeqRef.current === seq,
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      exportSeqRef.current += 1;
    };
  }, []);

  useEffect(() => {
    setHexDraft(state.backgroundHex);
  }, [state.backgroundHex]);

  // Any change to source generation, result, or export parameters invalidates in-flight exports
  // and any pending overwrite confirmation so stale responses can never re-open a prompt.
  useEffect(() => {
    exportSeqRef.current += 1;
    setPendingOverwrite(null);
    setExporting(false);
  }, [exportBindingKey]);

  const loadLocalFile = useCallback(
    async (rawPath: string) => {
      setLocalError(null);
      setLastSavedPath(null);
      setPendingOverwrite(null);
      await loadRemoveBackgroundFile(rawPath, (err) => formatLocalizedError(err, t));
    },
    [loadRemoveBackgroundFile, t],
  );

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: setDragging,
          onDropPaths: (paths) => {
            setDragging(false);
            if (paths.length > 0 && paths[0]) {
              void loadLocalFile(paths[0]);
            }
          },
        }),
      "i04-file-drop",
    );
  }, [loadLocalFile]);

  const handlePickImage = async () => {
    setLocalError(null);
    try {
      const picked = await pickSingleFile({
        title: isZh ? "选择需要抠图去背景的图片" : "Select an image to remove background",
        filters: [
          {
            name: isZh ? "支持的图片格式" : "Supported Images",
            extensions: [...IMAGE_FILE_DIALOG_EXTENSIONS],
          },
        ],
      });
      if (!picked || !mountedRef.current) return;
      await loadLocalFile(picked);
    } catch (err) {
      if (!mountedRef.current) return;
      setLocalError(formatLocalizedError(err, t));
    }
  };

  const handlePasteClipboard = async () => {
    setLocalError(null);
    setLastSavedPath(null);
    setPendingOverwrite(null);
    await pasteRemoveBackgroundClipboard(
      (err) => formatLocalizedError(err, t),
      isZh ? "剪贴板图片.png" : "clipboard.png",
    );
  };

  const handleClear = () => {
    setLocalError(null);
    setLastSavedPath(null);
    setPendingOverwrite(null);
    clearRemoveBackgroundSession();
  };

  const handleRunMatting = async () => {
    if (!modelStatus?.ready || state.status === "running" || state.loadingSource) return;
    if (!state.sourcePath && !state.sourceAssetId) return;
    setLocalError(null);
    setLastSavedPath(null);
    await startRemoveBackground(
      {
        path: state.sourcePath,
        assetId: state.sourceAssetId,
        label: state.sourceFileName,
      },
      (err) => formatLocalizedError(err, t),
    );
  };

  const handleBackgroundModeChange = (mode: MattingBackgroundMode) => {
    const nextFormat: MattingExportFormat =
      mode === "transparent" && state.exportFormat === "jpeg" ? "png" : state.exportFormat;
    updateRemoveBackgroundSession({
      backgroundMode: mode,
      exportFormat: nextFormat,
    });
  };

  const handleCommitHexDraft = () => {
    const normalized = normalizeHexInput(hexDraft, state.backgroundHex);
    setHexDraft(normalized);
    updateRemoveBackgroundSession({
      backgroundMode: "solid_color",
      backgroundHex: normalized,
    });
  };

  const executeExportRequest = async (
    req: MattingExportRequest,
    bindingKey: string,
    seq: number,
  ) => {
    if (!isExportStillCurrent(bindingKey, seq)) return;
    setExporting(true);
    setLocalError(null);
    try {
      const saved = await exportMattingResult(req);
      if (!isExportStillCurrent(bindingKey, seq)) return;
      setPendingOverwrite(null);
      setLastSavedPath(saved.outputPath);
      updateRemoveBackgroundSession({
        lastSavedMessage: isZh
          ? `已导出 ${saved.width}×${saved.height}（${formatImageBytes(saved.byteLength)}）：${saved.outputPath}`
          : `Exported ${saved.width}×${saved.height} (${formatImageBytes(saved.byteLength)}): ${saved.outputPath}`,
      });
    } catch (err) {
      if (!isExportStillCurrent(bindingKey, seq)) return;
      const parsed = parseBackendError(err);
      if (parsed.code === "TARGET_ALREADY_EXISTS" && !req.overwrite) {
        setPendingOverwrite({
          request: { ...req, overwrite: true },
          bindingKey,
          seq,
        });
      } else {
        setLocalError(formatLocalizedError(err, t));
      }
    } finally {
      if (mountedRef.current && exportSeqRef.current === seq) {
        setExporting(false);
      }
    }
  };

  const handleExportClick = async () => {
    const bindingKey = exportBindingKey;
    if (!state.result || !bindingKey || exporting) return;
    const seq = ++exportSeqRef.current;
    const resultSnapshot = state.result;
    const sourcePathSnapshot = state.sourcePath;
    const sourceFileNameSnapshot = state.sourceFileName;
    const backgroundModeSnapshot = state.backgroundMode;
    const backgroundHexSnapshot = state.backgroundHex;
    const exportFormatSnapshot = state.exportFormat;
    const exportQualitySnapshot = state.exportQuality;
    const cropToSubjectSnapshot = state.cropToSubject;
    const cropPaddingPxSnapshot = state.cropPaddingPx;

    setLocalError(null);
    const ext =
      exportFormatSnapshot === "jpeg" ? "jpg" : exportFormatSnapshot === "webp" ? "webp" : "png";
    const suffixParts = [backgroundModeSnapshot === "transparent" ? "cutout" : "solid"];
    if (cropToSubjectSnapshot && resultSnapshot.subjectBbox) {
      suffixParts.push("cropped");
    }
    const suffix = `_${suffixParts.join("_")}`;
    let defaultPath: string | undefined;
    if (sourcePathSnapshot) {
      const suggested = await suggestSafeSiblingPath(sourcePathSnapshot, suffix, ext);
      if (!isExportStillCurrent(bindingKey, seq)) return;
      if (suggested) {
        defaultPath = suggested;
      }
    }
    if (!defaultPath) {
      const stem = (sourceFileNameSnapshot ?? "image").replace(/\.[^.]+$/, "") || "image";
      defaultPath = `${stem}${suffix}.${ext}`;
    }

    const picked = await pickSaveFilePath({
      title: isZh ? "导出抠图结果" : "Export Cutout Image",
      defaultPath,
      filters: [
        {
          name: ext.toUpperCase(),
          extensions: ext === "jpg" ? ["jpg", "jpeg"] : [ext],
        },
      ],
    });
    if (!picked || !isExportStillCurrent(bindingKey, seq)) return;

    const req: MattingExportRequest = {
      resultId: resultSnapshot.resultId,
      outputPath: picked,
      sourcePath: sourcePathSnapshot,
      overwrite: false,
      backgroundMode: backgroundModeSnapshot,
      backgroundHex: backgroundModeSnapshot === "solid_color" ? backgroundHexSnapshot : null,
      format: exportFormatSnapshot,
      quality: exportFormatSnapshot === "png" ? null : exportQualitySnapshot,
      cropToSubject: cropToSubjectSnapshot,
      cropPaddingPx: cropToSubjectSnapshot ? cropPaddingPxSnapshot : 0,
    };
    await executeExportRequest(req, bindingKey, seq);
  };

  const handleCopyClipboard = async () => {
    const bindingKey = exportBindingKey;
    if (!state.result || !bindingKey || copying) return;
    setCopying(true);
    setLocalError(null);
    try {
      const copied = await copyMattingResultToClipboard({
        resultId: state.result.resultId,
        backgroundMode: state.backgroundMode,
        backgroundHex: state.backgroundMode === "solid_color" ? state.backgroundHex : null,
        cropToSubject: state.cropToSubject,
        cropPaddingPx: state.cropToSubject ? state.cropPaddingPx : 0,
      });
      if (!mountedRef.current || liveExportBindingRef.current !== bindingKey) return;
      updateRemoveBackgroundSession({
        lastSavedMessage: isZh
          ? `已复制 ${copied.width}×${copied.height} ${copied.hasAlpha ? "透明 PNG" : "纯色背景图"} 到剪贴板`
          : `Copied ${copied.width}×${copied.height} ${copied.hasAlpha ? "transparent PNG" : "solid-background image"} to clipboard`,
      });
    } catch (err) {
      if (!mountedRef.current || liveExportBindingRef.current !== bindingKey) return;
      setLocalError(formatLocalizedError(err, t));
    } finally {
      if (mountedRef.current) {
        setCopying(false);
      }
    }
  };

  const handleHandoff = async (target: "I03" | "I12" | "I13") => {
    const assetId = state.result?.cutoutAssetId;
    if (!assetId) return;
    try {
      const asset = await getImageAsset(assetId);
      handoffImageToTool(target, asset);
    } catch (err) {
      setLocalError(formatLocalizedError(err, t));
    }
  };

  const paddedCropRect = useMemo(() => {
    if (!state.result || !state.result.subjectBbox || !state.cropToSubject) {
      return null;
    }
    return computePaddedCropRect(
      state.result.width,
      state.result.height,
      state.result.subjectBbox,
      state.cropPaddingPx,
    );
  }, [state.result, state.cropToSubject, state.cropPaddingPx]);

  const hasSource = Boolean(state.sourcePath || state.sourceAssetId || state.sourcePreviewUrl);
  const hasResult = Boolean(state.result);
  const isRunning = state.status === "running";
  const canStart = Boolean(modelStatus?.ready && hasSource && !isRunning && !state.loadingSource);

  const originalPreviewUrl = state.result?.originalPreviewDataUrl ?? state.sourcePreviewUrl;
  const cutoutPreviewUrl = state.result?.cutoutPreviewDataUrl ?? null;

  const activeError = localError ?? state.errorMessage;
  const savedDir = lastSavedPath ? parentDirectoryOf(lastSavedPath) : null;

  return (
    <div className="matting-workspace" data-testid="remove-background-workspace">
      <div className="workspace-header">
        <div>
          <h2 className="workspace-title">{isZh ? "图片抠图去背景" : "Remove Background"}</h2>
          <p className="workspace-subtitle">
            {isZh
              ? "本地离线主体分割与发丝透明抠图，支持原图/抠图滑块对比、透明 PNG 或纯色背景导出及按主体紧凑裁切"
              : "Local offline foreground matting with before/after slider, transparent PNG or solid-color export, and optional tight subject cropping"}
          </p>
        </div>
        <div className="media-actions-row" style={{ flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void handlePickImage()}
            data-testid="i04-pick-image-btn"
          >
            <ImagePlus size={14} aria-hidden="true" />
            <span>{isZh ? "选择图片" : "Choose Image"}</span>
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void handlePasteClipboard()}
            data-testid="i04-paste-clipboard-btn"
          >
            <ClipboardPaste size={14} aria-hidden="true" />
            <span>{isZh ? "粘贴剪贴板" : "Paste Clipboard"}</span>
          </button>
          {hasSource && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={handleClear}
              data-testid="i04-clear-btn"
            >
              <Eraser size={14} aria-hidden="true" />
              <span>{isZh ? "清空" : "Clear"}</span>
            </button>
          )}
        </div>
      </div>

      <MattingModelSetupPanel onStatusChange={setModelStatus} />

      <div className="matting-layout">
        {/* Left: Preview & Interactive Before/After Comparison */}
        <section
          className="matting-stage-panel"
          aria-label={isZh ? "抠图预览与对比" : "Cutout Preview & Comparison"}
        >
          <div className="matting-stage-toolbar">
            <div
              className="matting-segmented"
              role="tablist"
              aria-label={isZh ? "视图模式" : "View mode"}
            >
              {(
                [
                  { id: "split", zh: "对比滑块", en: "Split" },
                  { id: "cutout", zh: "抠图结果", en: "Cutout" },
                  { id: "original", zh: "原图", en: "Original" },
                ] as { id: RemoveBackgroundViewMode; zh: string; en: string }[]
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={state.viewMode === tab.id}
                  disabled={!hasResult && tab.id !== "original"}
                  className={`matting-seg-btn ${
                    (hasResult ? state.viewMode === tab.id : tab.id === "original")
                      ? "is-active"
                      : ""
                  }`}
                  onClick={() => updateRemoveBackgroundSession({ viewMode: tab.id })}
                  data-testid={`i04-view-${tab.id}`}
                >
                  <span>{isZh ? tab.zh : tab.en}</span>
                </button>
              ))}
            </div>

            {hasResult && state.viewMode === "split" && (
              <span className="field-hint mono" style={{ margin: 0 }}>
                {isZh
                  ? `对比分割 ${Math.round(state.splitPercent)}%`
                  : `Split ${Math.round(state.splitPercent)}%`}
              </span>
            )}
          </div>

          {!hasSource ? (
            <div
              className={`matting-dropzone ${dragging ? "is-dragging" : ""}`}
              data-testid="i04-dropzone"
            >
              <div className="matting-dropzone-icon">
                <Scissors size={20} aria-hidden="true" />
              </div>
              <p className="matting-dropzone-title">
                {isZh
                  ? "拖入图片，或点击上方「选择图片」开始抠图"
                  : "Drop an image here or click Choose Image"}
              </p>
              <p className="matting-dropzone-sub">
                {isZh
                  ? "支持 PNG、JPG、WebP、BMP、TIFF、GIF 与 HEIC；自动按 EXIF 校正方向并保留原图半透明边缘，所有计算均在本地完成。"
                  : "Supports PNG, JPG, WebP, BMP, TIFF, GIF, and HEIC. Automatically corrects EXIF orientation and preserves existing transparent edges, 100% locally."}
              </p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void handlePickImage()}
              >
                <ImagePlus size={14} aria-hidden="true" />
                <span>{isZh ? "选择本地图片" : "Select Local Image"}</span>
              </button>
            </div>
          ) : (
            <div
              className={`matting-canvas-shell ${dragging ? "is-dragging" : ""}`}
              data-testid="i04-preview-stage"
            >
              {originalPreviewUrl && (
                <div
                  className={`matting-frame ${
                    hasResult &&
                    state.viewMode !== "original" &&
                    state.backgroundMode === "transparent"
                      ? "is-checkerboard"
                      : ""
                  }`}
                  style={
                    hasResult &&
                    state.viewMode !== "original" &&
                    state.backgroundMode === "solid_color"
                      ? { backgroundColor: state.backgroundHex }
                      : undefined
                  }
                >
                  {/* Base layer: determines exact rendered aspect ratio box */}
                  <img
                    src={
                      hasResult && state.viewMode !== "original" && cutoutPreviewUrl
                        ? cutoutPreviewUrl
                        : originalPreviewUrl
                    }
                    alt={
                      hasResult && state.viewMode !== "original"
                        ? isZh
                          ? "抠图结果预览"
                          : "Cutout preview"
                        : isZh
                          ? "原图预览"
                          : "Original preview"
                    }
                    className="matting-base-img"
                    draggable={false}
                  />

                  {/* Split comparison overlay: clipped original on left of divider */}
                  {hasResult && state.viewMode === "split" && (
                    <>
                      <img
                        src={originalPreviewUrl}
                        alt={isZh ? "对比原图" : "Original comparison layer"}
                        className="matting-overlay-img"
                        style={{
                          clipPath: `inset(0 ${100 - state.splitPercent}% 0 0)`,
                        }}
                        draggable={false}
                      />
                      <span className="matting-corner-tag is-left">{isZh ? "原图" : "Before"}</span>
                      <span className="matting-corner-tag is-right">
                        {isZh ? "抠图结果" : "After"}
                      </span>
                      <div
                        className="matting-split-line"
                        style={{ left: `${state.splitPercent}%` }}
                        aria-hidden="true"
                      >
                        <div className="matting-split-knob">
                          <ArrowLeftRight size={13} />
                        </div>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={state.splitPercent}
                        onChange={(e) =>
                          updateRemoveBackgroundSession({
                            splitPercent: Number(e.target.value),
                          })
                        }
                        className="matting-split-range"
                        aria-label={
                          isZh ? "原图与抠图对比滑块" : "Before and after comparison slider"
                        }
                        data-testid="i04-split-slider"
                      />
                    </>
                  )}

                  {/* Dashed tight-crop bounding box indicator */}
                  {paddedCropRect && state.result && state.viewMode !== "original" && (
                    <div
                      className="matting-crop-overlay"
                      style={{
                        left: `${(paddedCropRect.x / state.result.width) * 100}%`,
                        top: `${(paddedCropRect.y / state.result.height) * 100}%`,
                        width: `${(paddedCropRect.width / state.result.width) * 100}%`,
                        height: `${(paddedCropRect.height / state.result.height) * 100}%`,
                      }}
                      data-testid="i04-crop-overlay"
                      aria-hidden="true"
                    />
                  )}
                </div>
              )}
            </div>
          )}

          {hasSource && (
            <div className="matting-meta-strip" data-testid="i04-meta-strip">
              <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>
                {state.sourceFileName}
              </span>
              {state.sourceWidth && state.sourceHeight && (
                <span className="matting-meta-pill mono">
                  {state.sourceWidth} × {state.sourceHeight}
                </span>
              )}
              {state.result && state.result.exifOrientation > 1 && (
                <span className="matting-meta-pill">
                  {isZh
                    ? `EXIF ${state.result.exifOrientation} 已校正`
                    : `EXIF ${state.result.exifOrientation} upright`}
                </span>
              )}
              {(state.sourceHasAlpha || state.result?.preservedSourceAlpha) && (
                <span className="matting-meta-pill">
                  {isZh ? "保留原图透明通道" : "Source alpha preserved"}
                </span>
              )}
              {state.result && (
                <>
                  <span className="matting-meta-pill mono">
                    {isZh
                      ? `主体占比 ${(state.result.foregroundRatio * 100).toFixed(1)}%`
                      : `Subject ${(state.result.foregroundRatio * 100).toFixed(1)}%`}
                  </span>
                  <span className="matting-meta-pill mono">
                    {(state.result.elapsedMs / 1000).toFixed(2)}s
                  </span>
                </>
              )}
            </div>
          )}
        </section>

        {/* Right: Run Controls, Background & Crop Options, Export */}
        <aside className="matting-controls-rail">
          {/* Action Card */}
          <div className="matting-card">
            <h3 className="matting-card-title">
              <Scissors size={14} aria-hidden="true" />
              <span>{isZh ? "离线前景抠图" : "Offline Matting"}</span>
            </h3>

            {!isRunning ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canStart}
                onClick={() => void handleRunMatting()}
                data-testid="i04-start-btn"
              >
                <Play size={14} aria-hidden="true" />
                <span>
                  {hasResult
                    ? isZh
                      ? "重新执行离线抠图"
                      : "Re-run Offline Cutout"
                    : isZh
                      ? "开始离线抠图"
                      : "Remove Background"}
                </span>
              </button>
            ) : (
              <>
                <div className="matting-run-progress" role="status" aria-live="polite">
                  <div className="matting-progress-header">
                    <span>{formatPhaseLabel(state.liveProgress?.phase ?? "inferring", isZh)}</span>
                    <span className="mono">{Math.round(state.liveProgress?.percent ?? 10)}%</span>
                  </div>
                  <div className="matting-progress-track">
                    <div
                      className="matting-progress-fill"
                      style={{
                        width: `${Math.min(100, Math.max(5, state.liveProgress?.percent ?? 10))}%`,
                      }}
                    />
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => void cancelRemoveBackground()}
                  data-testid="i04-cancel-btn"
                >
                  <X size={14} aria-hidden="true" />
                  <span>{isZh ? "取消抠图" : "Cancel"}</span>
                </button>
              </>
            )}

            {!modelStatus?.ready && (
              <p className="field-hint" style={{ margin: 0 }}>
                {isZh
                  ? "请先在上方安装或指定离线抠图模型，再开始处理。"
                  : "Install or select the offline cutout model above before starting."}
              </p>
            )}

            {activeError && (
              <div className="status-banner is-error" role="alert" data-testid="i04-error-banner">
                {activeError}
              </div>
            )}

            {state.result?.warnings.map((w, idx) => (
              <div key={idx} className="status-banner is-warn" role="status">
                <AlertTriangle size={14} aria-hidden="true" style={{ flexShrink: 0 }} />
                <span>{w}</span>
              </div>
            ))}
          </div>

          {/* Background & Crop Settings */}
          <div className="matting-card">
            <h3 className="matting-card-title">
              <Layers size={14} aria-hidden="true" />
              <span>{isZh ? "背景与输出尺寸" : "Background & Dimensions"}</span>
            </h3>

            <div
              className="matting-segmented"
              role="radiogroup"
              aria-label={isZh ? "背景模式" : "Background mode"}
            >
              <button
                type="button"
                role="radio"
                aria-checked={state.backgroundMode === "transparent"}
                className={`matting-seg-btn ${state.backgroundMode === "transparent" ? "is-active" : ""}`}
                onClick={() => handleBackgroundModeChange("transparent")}
                data-testid="i04-bg-transparent"
              >
                {isZh ? "透明背景" : "Transparent"}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={state.backgroundMode === "solid_color"}
                className={`matting-seg-btn ${state.backgroundMode === "solid_color" ? "is-active" : ""}`}
                onClick={() => handleBackgroundModeChange("solid_color")}
                data-testid="i04-bg-solid"
              >
                {isZh ? "纯色背景" : "Solid Color"}
              </button>
            </div>

            {state.backgroundMode === "solid_color" && (
              <>
                <div className="matting-swatch-row">
                  {SOLID_COLOR_PRESETS.map((preset) => (
                    <button
                      key={preset.hex}
                      type="button"
                      className={`matting-swatch-btn ${
                        state.backgroundHex.toUpperCase() === preset.hex ? "is-active" : ""
                      }`}
                      style={{ backgroundColor: preset.hex }}
                      title={`${isZh ? preset.zh : preset.en} (${preset.hex})`}
                      aria-label={`${isZh ? preset.zh : preset.en} ${preset.hex}`}
                      onClick={() =>
                        updateRemoveBackgroundSession({
                          backgroundMode: "solid_color",
                          backgroundHex: preset.hex,
                        })
                      }
                      data-testid={`i04-swatch-${preset.hex.slice(1)}`}
                    />
                  ))}
                </div>
                <div className="matting-color-custom">
                  <input
                    type="color"
                    value={state.backgroundHex}
                    onChange={(e) =>
                      updateRemoveBackgroundSession({
                        backgroundMode: "solid_color",
                        backgroundHex: e.target.value.toUpperCase(),
                      })
                    }
                    className="matting-color-picker"
                    aria-label={isZh ? "自定义背景色" : "Custom background color"}
                  />
                  <input
                    type="text"
                    value={hexDraft}
                    onChange={(e) => setHexDraft(e.target.value)}
                    onBlur={handleCommitHexDraft}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCommitHexDraft();
                    }}
                    className="matting-hex-input mono"
                    aria-label={isZh ? "十六进制色值" : "Hex color code"}
                    data-testid="i04-hex-input"
                  />
                </div>
              </>
            )}

            <label className="matting-check-row">
              <input
                type="checkbox"
                checked={state.cropToSubject}
                onChange={(e) => updateRemoveBackgroundSession({ cropToSubject: e.target.checked })}
                data-testid="i04-crop-toggle"
              />
              <Crop size={14} aria-hidden="true" />
              <span>
                {isZh
                  ? "按主体边界紧凑裁切（默认保留原图尺寸）"
                  : "Tight crop to subject (original size by default)"}
              </span>
            </label>

            {state.cropToSubject && (
              <div className="matting-padding-row">
                <span className="field-hint" style={{ margin: 0 }}>
                  {isZh ? "边距" : "Padding"}
                </span>
                {CROP_PADDING_PRESETS.map((px) => (
                  <button
                    key={px}
                    type="button"
                    className={`matting-chip-btn mono ${state.cropPaddingPx === px ? "is-active" : ""}`}
                    onClick={() => updateRemoveBackgroundSession({ cropPaddingPx: px })}
                  >
                    {px}px
                  </button>
                ))}
                <input
                  type="number"
                  min={0}
                  max={512}
                  value={state.cropPaddingPx}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n)) {
                      updateRemoveBackgroundSession({
                        cropPaddingPx: Math.max(0, Math.min(512, Math.round(n))),
                      });
                    }
                  }}
                  className="matting-hex-input mono"
                  style={{ width: "68px" }}
                  aria-label={isZh ? "裁切留白像素" : "Crop padding pixels"}
                  data-testid="i04-crop-padding-input"
                />
              </div>
            )}

            {state.result && (
              <div className="matting-dim-preview mono" data-testid="i04-output-dims">
                {paddedCropRect
                  ? isZh
                    ? `输出尺寸：${paddedCropRect.width} × ${paddedCropRect.height}（原图 ${state.result.width} × ${state.result.height}）`
                    : `Output: ${paddedCropRect.width} × ${paddedCropRect.height} (orig ${state.result.width} × ${state.result.height})`
                  : isZh
                    ? `输出尺寸：${state.result.width} × ${state.result.height}（保持原图尺寸）`
                    : `Output: ${state.result.width} × ${state.result.height} (original dimensions)`}
              </div>
            )}
          </div>

          {/* Export & Handoff Card */}
          <div className="matting-card">
            <h3 className="matting-card-title">
              <Download size={14} aria-hidden="true" />
              <span>{isZh ? "导出与继续编辑" : "Export & Handoff"}</span>
            </h3>

            <div
              className="matting-segmented"
              role="radiogroup"
              aria-label={isZh ? "导出格式" : "Export format"}
            >
              <button
                type="button"
                role="radio"
                aria-checked={state.exportFormat === "png"}
                className={`matting-seg-btn ${state.exportFormat === "png" ? "is-active" : ""}`}
                onClick={() => updateRemoveBackgroundSession({ exportFormat: "png" })}
                data-testid="i04-fmt-png"
              >
                PNG
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={state.exportFormat === "jpeg"}
                disabled={state.backgroundMode === "transparent"}
                className={`matting-seg-btn ${state.exportFormat === "jpeg" ? "is-active" : ""}`}
                onClick={() => updateRemoveBackgroundSession({ exportFormat: "jpeg" })}
                data-testid="i04-fmt-jpeg"
              >
                JPEG
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={state.exportFormat === "webp"}
                className={`matting-seg-btn ${state.exportFormat === "webp" ? "is-active" : ""}`}
                onClick={() => updateRemoveBackgroundSession({ exportFormat: "webp" })}
                data-testid="i04-fmt-webp"
              >
                WebP
              </button>
            </div>

            {state.backgroundMode === "transparent" && (
              <p className="field-hint" style={{ margin: 0 }}>
                {isZh
                  ? "透明背景支持无损 PNG 与 WebP；如需 JPEG，请切换到纯色背景。"
                  : "Transparent cutouts export as PNG or WebP. Switch to Solid Color for JPEG."}
              </p>
            )}

            {state.exportFormat !== "png" && (
              <label
                style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" }}
              >
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>{isZh ? "压缩质量" : "Quality"}</span>
                  <span className="mono">{state.exportQuality}%</span>
                </div>
                <input
                  type="range"
                  min={60}
                  max={100}
                  value={state.exportQuality}
                  onChange={(e) =>
                    updateRemoveBackgroundSession({ exportQuality: Number(e.target.value) })
                  }
                />
              </label>
            )}

            <div className="media-actions-row" style={{ flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!hasResult || exporting || isRunning}
                onClick={() => void handleExportClick()}
                data-testid="i04-export-btn"
              >
                <Download size={14} aria-hidden="true" />
                <span>
                  {exporting
                    ? isZh
                      ? "正在导出…"
                      : "Exporting..."
                    : isZh
                      ? "导出图片…"
                      : "Export Image..."}
                </span>
              </button>

              <button
                type="button"
                className="btn btn-secondary"
                disabled={!hasResult || copying || isRunning}
                onClick={() => void handleCopyClipboard()}
                data-testid="i04-copy-btn"
              >
                <ClipboardCopy size={14} aria-hidden="true" />
                <span>{isZh ? "复制图片" : "Copy Image"}</span>
              </button>
            </div>

            {state.lastSavedMessage && (
              <div className="status-banner is-ok" role="status" data-testid="i04-saved-banner">
                <span>{state.lastSavedMessage}</span>
                {savedDir && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ marginLeft: "auto", padding: "2px 6px", fontSize: "11.5px" }}
                    onClick={() => void openLocalDirectory(savedDir)}
                  >
                    {isZh ? "打开目录" : "Open Folder"}
                  </button>
                )}
              </div>
            )}

            {state.result?.cutoutAssetId && (
              <div className="matting-handoff-row">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => void handleHandoff("I03")}
                >
                  <Frame size={13} aria-hidden="true" />
                  <span>{isZh ? "送往美化 (I03)" : "Beautify (I03)"}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => void handleHandoff("I12")}
                >
                  <Pencil size={13} aria-hidden="true" />
                  <span>{isZh ? "送往标注 (I12)" : "Annotate (I12)"}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => void handleHandoff("I13")}
                >
                  <Stamp size={13} aria-hidden="true" />
                  <span>{isZh ? "送往水印 (I13)" : "Watermark (I13)"}</span>
                </button>
              </div>
            )}
          </div>
        </aside>
      </div>

      <ConfirmDialog
        open={pendingOverwrite != null}
        title={isZh ? "覆盖已存在的文件？" : "Overwrite Existing File?"}
        body={
          isZh
            ? `目标路径已存在文件：${pendingOverwrite?.request.outputPath ?? ""}。是否确认覆盖该文件？（源文件始终受保护，不会被覆盖）`
            : `A file already exists at: ${pendingOverwrite?.request.outputPath ?? ""}. Overwrite it? (Your original source image is always protected.)`
        }
        confirmLabel={isZh ? "确认覆盖" : "Overwrite"}
        cancelLabel={isZh ? "取消" : "Cancel"}
        danger
        onConfirm={() => {
          if (
            pendingOverwrite &&
            isExportStillCurrent(pendingOverwrite.bindingKey, pendingOverwrite.seq)
          ) {
            const confirmed = pendingOverwrite;
            setPendingOverwrite(null);
            void executeExportRequest(confirmed.request, confirmed.bindingKey, confirmed.seq);
          } else {
            setPendingOverwrite(null);
          }
        }}
        onCancel={() => setPendingOverwrite(null)}
      />
    </div>
  );
}
