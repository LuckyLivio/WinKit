import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore } from "../../lib/sessionStore";
import {
  formatLocalizedError,
  inspectBatchImages,
  previewCompressImage,
} from "../../lib/tauriBridge";
import { ImageBatchShell } from "../image-batch/ImageBatchShell";
import {
  formatImageBytes,
  formatImageFormatLabel,
  mergeInspectedItems,
  type CompressQualityPreset,
  type InspectedImageItem,
  type PngCompressMode,
  type PreviewCompressImageResponse,
} from "../image-batch/imageBatchModel";

const copy = {
  "zh-CN": {
    emptyTitle: "选择或拖入 JPEG / PNG / WebP 开始图片压缩",
    emptyBody:
      "提供低 / 中 / 高三档压缩与实时前后细节对比；明确区分 PNG 无损优化与有损调色板编码；同格式压缩后未变小时保留原件字节并标明“未节省空间”。",
    presetTitle: "压缩质量档位",
    presetLow: "低（体积优先）",
    presetMedium: "中（均衡推荐）",
    presetHigh: "高（画质优先）",
    pngModeTitle: "PNG 压缩方式",
    pngLossless: "无损优化（像素完全不变 · oxipng）",
    pngLossy: "有损编码（8 位索引调色板 · 体积更小）",
    pngModeNote:
      "无损优化逐像素保持原图不变；有损模式通过 64/128/256 色调色板与抖动显著缩小体积，同时保留透明通道。",
    noBloatNote:
      "防膨胀保护：同格式压缩后若不小于原文件，将保留原件数据写入输出目录并标记为“未节省空间”。",
    executeBtn: (n: number) => (n > 0 ? `开始批量压缩 (${n} 张)` : "开始压缩"),
    compareBefore: "压缩前（原图）",
    compareAfter: "压缩后",
    sliderLabel: "拖动对比分割线",
    zoomFit: "适配窗口",
    zoom100: "1:1 细节",
    savedPill: (pct: number) => `节省 ${pct.toFixed(1)}%`,
    keptPill: "未节省空间（保留原件）",
    previewLoading: "正在计算实时压缩对比…",
    unsupportedFmtMsg:
      "该图片格式不支持直接同格式压缩（仅支持 JPEG / PNG / WebP，可先用 I05 转换）。",
  },
  "en-US": {
    emptyTitle: "Select or drop JPEG / PNG / WebP images to compress",
    emptyBody:
      "Compare before/after details live across Low, Medium, and High presets. Separates lossless PNG optimization from lossy indexed PNG encoding and preserves originals when output is not smaller.",
    presetTitle: "Compression preset",
    presetLow: "Low (Smaller)",
    presetMedium: "Medium (Balanced)",
    presetHigh: "High (Quality)",
    pngModeTitle: "PNG compression mode",
    pngLossless: "Lossless optimize (pixel-identical · oxipng)",
    pngLossy: "Lossy palette (8-bit indexed · smaller files)",
    pngModeNote:
      "Lossless mode keeps every pixel identical; lossy mode quantizes to 64/128/256 colors with dithering and alpha support.",
    noBloatNote:
      "No-bloat safeguard: if compressed output is not smaller than the original, WinKit preserves original bytes and marks it “No Savings”.",
    executeBtn: (n: number) => (n > 0 ? `Compress ${n} Image(s)` : "Compress"),
    compareBefore: "Original",
    compareAfter: "Compressed",
    sliderLabel: "Drag split divider",
    zoomFit: "Fit",
    zoom100: "1:1 Detail",
    savedPill: (pct: number) => `Saved ${pct.toFixed(1)}%`,
    keptPill: "No savings (original kept)",
    previewLoading: "Computing live compression comparison…",
    unsupportedFmtMsg:
      "Same-format compression supports JPEG, PNG, and WebP only. Convert first in I05.",
  },
};

export function ImageCompressWorkspace() {
  const { locale, t: messages } = useI18n();
  const t = copy[locale];
  const { session, updateImageCompressSession, startImageCompressBatch, cancelImageCompressBatch } =
    useSessionStore();
  const state = session.imageCompress;

  const [inspecting, setInspecting] = useState(false);
  const [preview, setPreview] = useState<PreviewCompressImageResponse | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [splitPct, setSplitPct] = useState(50);
  const [zoom100, setZoom100] = useState(false);
  const previewSeqRef = useRef(0);

  const busy = state.status === "running";
  const selectedItem =
    state.items.find((i) => i.path === state.selectedPath) ?? state.items[0] ?? null;

  useEffect(() => {
    if (!selectedItem || selectedItem.error) {
      setPreview(null);
      setPreviewErr(null);
      setPreviewLoading(false);
      return;
    }
    if (
      selectedItem.format !== "jpeg" &&
      selectedItem.format !== "png" &&
      selectedItem.format !== "webp"
    ) {
      setPreview(null);
      setPreviewErr(t.unsupportedFmtMsg);
      setPreviewLoading(false);
      return;
    }

    const reqId = ++previewSeqRef.current;
    setPreviewLoading(true);
    setPreviewErr(null);
    previewCompressImage({
      path: selectedItem.path,
      qualityPreset: state.qualityPreset,
      pngMode: state.pngMode,
    })
      .then((res) => {
        if (previewSeqRef.current === reqId) setPreview(res);
      })
      .catch((err) => {
        if (previewSeqRef.current === reqId) {
          setPreview(null);
          setPreviewErr(formatLocalizedError(err, messages));
        }
      })
      .finally(() => {
        if (previewSeqRef.current === reqId) setPreviewLoading(false);
      });
  }, [messages, selectedItem, state.pngMode, state.qualityPreset, t.unsupportedFmtMsg]);

  const handleAddPaths = useCallback(
    async (paths: string[]) => {
      setInspecting(true);
      try {
        const inspected = await inspectBatchImages(paths);
        updateImageCompressSession((prev) => {
          const merged = mergeInspectedItems(prev.items, inspected.items);
          return {
            ...prev,
            items: merged,
            selectedPath: prev.selectedPath ?? merged[0]?.path ?? null,
            errorMessage: null,
          };
        });
      } catch (err) {
        updateImageCompressSession({ errorMessage: formatLocalizedError(err, messages) });
      } finally {
        setInspecting(false);
      }
    },
    [messages, updateImageCompressSession],
  );

  const handleRemovePath = (path: string) => {
    updateImageCompressSession((prev) => {
      const next = prev.items.filter((i) => i.path !== path);
      return {
        ...prev,
        items: next,
        selectedPath: prev.selectedPath === path ? (next[0]?.path ?? null) : prev.selectedPath,
      };
    });
  };

  const handleClear = () => {
    updateImageCompressSession({
      items: [],
      selectedPath: null,
      lastReport: null,
      errorMessage: null,
    });
  };

  const handleExecute = () => {
    if (busy || state.items.length === 0 || !state.outputDir) return;
    void startImageCompressBatch(
      {
        sourcePaths: state.items.map((i) => i.path),
        outputDir: state.outputDir,
        qualityPreset: state.qualityPreset,
        pngMode: state.pngMode,
      },
      (err) => formatLocalizedError(err, messages),
    );
  };

  const renderPreview = (item: InspectedImageItem | null) => {
    if (!item) return null;
    return (
      <>
        <div className="img-batch-stage-header">
          <div className="img-batch-group">
            <strong style={{ fontSize: 13 }}>{item.fileName}</strong>
            <span className="status-pill">{formatImageFormatLabel(item.format)}</span>
            {preview && (
              <>
                <span className="status-pill">
                  {formatImageBytes(preview.originalBytes)} →{" "}
                  <strong>{formatImageBytes(preview.compressedBytes)}</strong>
                </span>
                <span className={`status-pill ${preview.keptOriginal ? "is-warn" : "is-ok"}`}>
                  {preview.keptOriginal ? t.keptPill : t.savedPill(preview.savedPercent)}
                </span>
                <span className="status-pill">{preview.codecLabel}</span>
              </>
            )}
          </div>
          <div className="img-batch-group">
            {previewLoading && <span className="img-batch-hint">{t.previewLoading}</span>}
            {preview && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setZoom100((z) => !z)}
              >
                {zoom100 ? t.zoomFit : t.zoom100}
              </button>
            )}
          </div>
        </div>

        <div className={`img-batch-stage-canvas ${zoom100 ? "is-zoom-100" : ""}`}>
          {item.error || previewErr ? (
            <div className="img-batch-empty">
              <strong style={{ color: "var(--status-err)" }}>{item.error ?? previewErr}</strong>
            </div>
          ) : preview ? (
            <div className={`img-batch-compare-wrap ${zoom100 ? "is-zoom-100" : ""}`}>
              <img
                src={preview.compressedPreviewDataUrl}
                alt={t.compareAfter}
                className="img-batch-compare-base"
              />
              <div
                className="img-batch-compare-overlay"
                style={{ clipPath: `inset(0 ${100 - splitPct}% 0 0)` }}
              >
                <img src={preview.originalPreviewDataUrl} alt={t.compareBefore} />
              </div>
              <div className="img-batch-compare-divider" style={{ left: `${splitPct}%` }} />
              <span className="img-batch-compare-tag is-left">{t.compareBefore}</span>
              <span className="img-batch-compare-tag is-right">{t.compareAfter}</span>
            </div>
          ) : item.thumbnailDataUrl ? (
            <img
              src={item.thumbnailDataUrl}
              alt={item.fileName}
              className="img-batch-preview-img"
            />
          ) : (
            <div className="img-batch-empty">{t.previewLoading}</div>
          )}
        </div>

        {preview && (
          <div className="img-batch-compare-slider-bar">
            <span>{t.compareBefore}</span>
            <input
              type="range"
              min={0}
              max={100}
              value={splitPct}
              aria-label={t.sliderLabel}
              onChange={(e) => setSplitPct(Number(e.target.value))}
            />
            <span>{t.compareAfter}</span>
          </div>
        )}
      </>
    );
  };

  const renderControls = () => (
    <>
      <div className="img-batch-section">
        <span className="img-batch-section-title">{t.presetTitle}</span>
        <div className="img-batch-chip-grid" role="group" aria-label={t.presetTitle}>
          {(
            [
              ["low", t.presetLow],
              ["medium", t.presetMedium],
              ["high", t.presetHigh],
            ] as const
          ).map(([preset, label]) => (
            <button
              key={preset}
              type="button"
              disabled={busy}
              className={`img-batch-choice-btn ${
                state.qualityPreset === preset ? "is-active" : ""
              }`}
              onClick={() =>
                updateImageCompressSession({ qualityPreset: preset as CompressQualityPreset })
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="img-batch-section">
        <span className="img-batch-section-title">{t.pngModeTitle}</span>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {(
            [
              ["lossless", t.pngLossless],
              ["lossy_palette", t.pngLossy],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              disabled={busy}
              style={{ textAlign: "left" }}
              className={`img-batch-choice-btn ${state.pngMode === mode ? "is-active" : ""}`}
              onClick={() => updateImageCompressSession({ pngMode: mode as PngCompressMode })}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="img-batch-hint">{t.pngModeNote}</p>
      </div>

      <p className="img-batch-hint">{t.noBloatNote}</p>
    </>
  );

  return (
    <ImageBatchShell
      toolId="I06"
      items={state.items}
      selectedPath={state.selectedPath}
      outputDir={state.outputDir}
      busy={busy}
      inspecting={inspecting}
      liveProgress={state.liveProgress}
      lastReport={state.lastReport}
      errorMessage={state.errorMessage}
      executeLabel={t.executeBtn(state.items.length)}
      emptyTitle={t.emptyTitle}
      emptyBody={t.emptyBody}
      onAddPaths={(paths) => void handleAddPaths(paths)}
      onSelectPath={(path) => updateImageCompressSession({ selectedPath: path })}
      onRemovePath={handleRemovePath}
      onClear={handleClear}
      onChooseOutputDir={(dir) => updateImageCompressSession({ outputDir: dir })}
      onExecute={handleExecute}
      onCancel={() => void cancelImageCompressBatch()}
      renderPreview={renderPreview}
      renderControls={renderControls}
    />
  );
}
