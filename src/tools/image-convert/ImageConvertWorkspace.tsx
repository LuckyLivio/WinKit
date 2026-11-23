import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore } from "../../lib/sessionStore";
import {
  formatLocalizedError,
  getImageHeicCapabilities,
  inspectBatchImages,
  previewConvertImage,
} from "../../lib/tauriBridge";
import { ImageBatchShell } from "../image-batch/ImageBatchShell";
import {
  BACKGROUND_COLOR_PRESETS,
  formatImageBytes,
  formatImageFormatLabel,
  mergeInspectedItems,
  targetFormatFlattensAlpha,
  targetFormatSupportsQuality,
  type ImageConvertTargetFormat,
  type InspectedImageItem,
  type PreviewConvertImageResponse,
} from "../image-batch/imageBatchModel";

const FORMAT_OPTIONS: readonly { id: ImageConvertTargetFormat; label: string }[] = [
  { id: "jpeg", label: "JPEG" },
  { id: "png", label: "PNG" },
  { id: "webp", label: "WebP" },
  { id: "tiff", label: "TIFF" },
  { id: "bmp", label: "BMP" },
  { id: "heic", label: "HEIC" },
];

const copy = {
  "zh-CN": {
    emptyTitle: "选择或拖入图片开始批量格式转换",
    emptyBody:
      "支持 JPEG、PNG、WebP、TIFF、BMP、GIF 及 Windows WIC HEIC（含文件夹拖入）。透明图转 JPEG/BMP 时可自定义背景填充色并实时预览。",
    targetFormatTitle: "目标输出格式",
    qualityTitle: (q: number) => `输出质量：${q}`,
    webpLosslessLabel: "WebP 无损编码（忽略质量滑块）",
    bgColorTitle: "透明区域填充背景色（JPEG / BMP）",
    bgCustomAria: "自定义背景色",
    alphaFlattenHint: "当前目标格式不支持透明通道，透明像素将按所选背景色实时合成并导出。",
    heicCapsTitle: "Windows HEIC 编解码检测",
    heicDecOk: "HEIC 解码：可用（支持手机 HEIC 转 JPG 等）",
    heicDecNo: "HEIC 解码：当前机器缺少 Windows HEIF/HEVC 扩展（同批其他图片仍会正常处理）",
    heicEncOk: "HEIC 编码：可用",
    heicEncNo: "HEIC 编码：当前机器不可用（导出请选择 JPEG / PNG / WebP / TIFF / BMP）",
    executeBtn: (n: number, fmt: string) =>
      n > 0 ? `批量转换为 ${fmt.toUpperCase()} (${n} 张)` : "开始转换",
    previewLoading: "正在生成预览…",
    alphaTag: "含透明通道",
    flattenedTag: (hex: string) => `透明背景已合成 ${hex}`,
    heicBlockedWarn: "当前机器缺少 Windows HEIF/HEVC 编码器，无法导出 HEIC 格式。",
  },
  "en-US": {
    emptyTitle: "Select or drop images to convert formats in bulk",
    emptyBody:
      "Supports JPEG, PNG, WebP, TIFF, BMP, GIF, and Windows WIC HEIC (including folders). Preview transparent-to-JPEG/BMP background fills live before exporting.",
    targetFormatTitle: "Target format",
    qualityTitle: (q: number) => `Output quality: ${q}`,
    webpLosslessLabel: "Lossless WebP (ignores quality slider)",
    bgColorTitle: "Background fill for transparency (JPEG / BMP)",
    bgCustomAria: "Custom background color",
    alphaFlattenHint:
      "Target format has no alpha channel; transparent pixels are composited onto the chosen background color in both preview and export.",
    heicCapsTitle: "Windows HEIC Codec Status",
    heicDecOk: "HEIC decode: Available (supports phone HEIC → JPG)",
    heicDecNo:
      "HEIC decode: Windows HEIF/HEVC extension not detected (other images in the batch still process normally)",
    heicEncOk: "HEIC encode: Available",
    heicEncNo:
      "HEIC encode: Unavailable on this PC (choose JPEG / PNG / WebP / TIFF / BMP to export)",
    executeBtn: (n: number, fmt: string) =>
      n > 0 ? `Convert ${n} to ${fmt.toUpperCase()}` : "Convert",
    previewLoading: "Rendering preview…",
    alphaTag: "Has Alpha",
    flattenedTag: (hex: string) => `Alpha filled with ${hex}`,
    heicBlockedWarn: "Windows HEIF/HEVC encoder is unavailable on this machine for HEIC output.",
  },
};

export function ImageConvertWorkspace() {
  const { locale, t: messages } = useI18n();
  const t = copy[locale];
  const { session, updateImageConvertSession, startImageConvertBatch, cancelImageConvertBatch } =
    useSessionStore();
  const state = session.imageConvert;

  const [inspecting, setInspecting] = useState(false);
  const [preview, setPreview] = useState<PreviewConvertImageResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewSeqRef = useRef(0);

  const busy = state.status === "running";
  const selectedItem =
    state.items.find((i) => i.path === state.selectedPath) ?? state.items[0] ?? null;

  useEffect(() => {
    if (state.heicCapabilities) return;
    let cancelled = false;
    getImageHeicCapabilities()
      .then((caps) => {
        if (!cancelled) updateImageConvertSession({ heicCapabilities: caps });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [state.heicCapabilities, updateImageConvertSession]);

  useEffect(() => {
    if (!selectedItem || selectedItem.error) {
      setPreview(null);
      setPreviewLoading(false);
      return;
    }
    const reqId = ++previewSeqRef.current;
    setPreviewLoading(true);
    previewConvertImage({
      path: selectedItem.path,
      targetFormat: state.targetFormat,
      backgroundHex: state.backgroundHex,
    })
      .then((res) => {
        if (previewSeqRef.current === reqId) setPreview(res);
      })
      .catch(() => {
        if (previewSeqRef.current === reqId) setPreview(null);
      })
      .finally(() => {
        if (previewSeqRef.current === reqId) setPreviewLoading(false);
      });
  }, [selectedItem, state.backgroundHex, state.targetFormat]);

  const handleAddPaths = useCallback(
    async (paths: string[]) => {
      setInspecting(true);
      try {
        const inspected = await inspectBatchImages(paths);
        updateImageConvertSession((prev) => {
          const merged = mergeInspectedItems(prev.items, inspected.items);
          return {
            ...prev,
            items: merged,
            selectedPath: prev.selectedPath ?? merged[0]?.path ?? null,
            heicCapabilities: inspected.heicCapabilities,
            errorMessage: null,
          };
        });
      } catch (err) {
        updateImageConvertSession({ errorMessage: formatLocalizedError(err, messages) });
      } finally {
        setInspecting(false);
      }
    },
    [messages, updateImageConvertSession],
  );

  const handleRemovePath = (path: string) => {
    updateImageConvertSession((prev) => {
      const next = prev.items.filter((i) => i.path !== path);
      return {
        ...prev,
        items: next,
        selectedPath: prev.selectedPath === path ? (next[0]?.path ?? null) : prev.selectedPath,
      };
    });
  };

  const handleClear = () => {
    updateImageConvertSession({
      items: [],
      selectedPath: null,
      lastReport: null,
      errorMessage: null,
    });
  };

  const handleExecute = () => {
    if (busy || state.items.length === 0 || !state.outputDir) return;
    void startImageConvertBatch(
      {
        sourcePaths: state.items.map((i) => i.path),
        outputDir: state.outputDir,
        targetFormat: state.targetFormat,
        quality: state.quality,
        webpLossless: state.webpLossless,
        backgroundHex: state.backgroundHex,
      },
      (err) => formatLocalizedError(err, messages),
    );
  };

  const showQuality = targetFormatSupportsQuality(state.targetFormat, state.webpLossless);
  const flattensAlpha = targetFormatFlattensAlpha(state.targetFormat);
  const heicEncodeUnavailable =
    state.targetFormat === "heic" &&
    state.heicCapabilities !== null &&
    !state.heicCapabilities.encodeAvailable;

  const renderPreview = (item: InspectedImageItem | null) => {
    if (!item) return null;
    return (
      <>
        <div className="img-batch-stage-header">
          <div className="img-batch-group">
            <strong style={{ fontSize: 13 }}>{item.fileName}</strong>
            <span className="status-pill">{formatImageFormatLabel(item.format)}</span>
            {!item.error && (
              <span className="status-pill">
                {item.displayWidth}×{item.displayHeight} · {formatImageBytes(item.byteLength)}
              </span>
            )}
            {item.hasAlpha && <span className="status-pill">{t.alphaTag}</span>}
            {preview?.flattenedAlpha && (
              <span className="status-pill is-warn">{t.flattenedTag(state.backgroundHex)}</span>
            )}
          </div>
          {previewLoading && <span className="img-batch-hint">{t.previewLoading}</span>}
        </div>

        <div className="img-batch-stage-canvas">
          {item.error ? (
            <div className="img-batch-empty">
              <strong style={{ color: "var(--status-err)" }}>{item.error}</strong>
            </div>
          ) : preview?.previewDataUrl || item.thumbnailDataUrl ? (
            <img
              src={preview?.previewDataUrl ?? item.thumbnailDataUrl ?? ""}
              alt={item.fileName}
              className="img-batch-preview-img"
            />
          ) : (
            <div className="img-batch-empty">{t.previewLoading}</div>
          )}
        </div>
      </>
    );
  };

  const renderControls = () => (
    <>
      <div className="img-batch-section">
        <span className="img-batch-section-title">{t.targetFormatTitle}</span>
        <div className="img-batch-chip-grid" role="group" aria-label={t.targetFormatTitle}>
          {FORMAT_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              disabled={busy}
              className={`img-batch-choice-btn ${state.targetFormat === opt.id ? "is-active" : ""}`}
              onClick={() => updateImageConvertSession({ targetFormat: opt.id })}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {heicEncodeUnavailable && <div className="inline-banner is-warn">{t.heicBlockedWarn}</div>}
      </div>

      {state.targetFormat === "webp" && (
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={state.webpLossless}
            disabled={busy}
            onChange={(e) => updateImageConvertSession({ webpLossless: e.target.checked })}
          />
          <span>{t.webpLosslessLabel}</span>
        </label>
      )}

      {showQuality && (
        <div className="img-batch-section">
          <label className="img-batch-section-title" htmlFor="i05-quality-range">
            {t.qualityTitle(state.quality)}
          </label>
          <input
            id="i05-quality-range"
            type="range"
            min={10}
            max={100}
            step={1}
            disabled={busy}
            value={state.quality}
            onChange={(e) => updateImageConvertSession({ quality: Number(e.target.value) })}
          />
        </div>
      )}

      {flattensAlpha && (
        <div className="img-batch-section">
          <span className="img-batch-section-title">{t.bgColorTitle}</span>
          <div className="img-batch-swatch-row">
            {BACKGROUND_COLOR_PRESETS.map((preset) => (
              <button
                key={preset.hex}
                type="button"
                disabled={busy}
                className={`img-batch-swatch-btn ${
                  state.backgroundHex.toUpperCase() === preset.hex ? "is-active" : ""
                }`}
                onClick={() => updateImageConvertSession({ backgroundHex: preset.hex })}
              >
                <span className="img-batch-swatch-dot" style={{ backgroundColor: preset.hex }} />
                <span>{preset.label[locale]}</span>
              </button>
            ))}
            <input
              type="color"
              aria-label={t.bgCustomAria}
              disabled={busy}
              value={state.backgroundHex}
              onChange={(e) =>
                updateImageConvertSession({ backgroundHex: e.target.value.toUpperCase() })
              }
            />
          </div>
          <p className="img-batch-hint">{t.alphaFlattenHint}</p>
        </div>
      )}

      {state.heicCapabilities && (
        <div className="img-batch-section">
          <span className="img-batch-section-title">{t.heicCapsTitle}</span>
          <p className="img-batch-hint">
            {state.heicCapabilities.decodeAvailable ? t.heicDecOk : t.heicDecNo}
          </p>
          <p className="img-batch-hint">
            {state.heicCapabilities.encodeAvailable ? t.heicEncOk : t.heicEncNo}
          </p>
        </div>
      )}
    </>
  );

  return (
    <ImageBatchShell
      toolId="I05"
      items={state.items}
      selectedPath={state.selectedPath}
      outputDir={state.outputDir}
      busy={busy}
      inspecting={inspecting}
      liveProgress={state.liveProgress}
      lastReport={state.lastReport}
      errorMessage={state.errorMessage}
      executeLabel={t.executeBtn(state.items.length, state.targetFormat)}
      executeDisabled={heicEncodeUnavailable}
      emptyTitle={t.emptyTitle}
      emptyBody={t.emptyBody}
      onAddPaths={(paths) => void handleAddPaths(paths)}
      onSelectPath={(path) => updateImageConvertSession({ selectedPath: path })}
      onRemovePath={handleRemovePath}
      onClear={handleClear}
      onChooseOutputDir={(dir) => updateImageConvertSession({ outputDir: dir })}
      onExecute={handleExecute}
      onCancel={() => void cancelImageConvertBatch()}
      renderPreview={renderPreview}
      renderControls={renderControls}
    />
  );
}
