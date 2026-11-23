import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore } from "../../lib/sessionStore";
import {
  formatLocalizedError,
  inspectBatchImages,
  previewRotateImage,
} from "../../lib/tauriBridge";
import { ImageBatchShell } from "../image-batch/ImageBatchShell";
import {
  computeResizeTargetDimensions,
  formatImageBytes,
  formatImageFormatLabel,
  mergeInspectedItems,
  type InspectedImageItem,
  type ResizeMode,
} from "../image-batch/imageBatchModel";

const copy = {
  "zh-CN": {
    emptyTitle: "选择或拖入图片开始批量缩放",
    emptyBody:
      "支持按百分比、最长边或指定宽高缩放；默认保持比例并禁止放大，横图、竖图及带 EXIF 方向标记的手机照片均按实际显示方向计算尺寸。",
    modeTitle: "缩放方式",
    modePercentage: "百分比",
    modeLongest: "最长边",
    modeExact: "指定宽高",
    percentageLabel: "缩放比例（1% – 400%）",
    longestEdgeLabel: "目标最长边（像素）",
    widthLabel: "目标宽度（px）",
    heightLabel: "目标高度（px）",
    keepAspectLabel: "保持原始纵横比（不拉伸变形）",
    preventUpscaleLabel: "禁止放大（小于目标尺寸的图片保持原尺寸）",
    stretchWarn: "已关闭纵横比约束，目标尺寸将按输入宽高精确拉伸。",
    exifNote:
      "带 EXIF 方向标记的照片按实际显示方向计算最终宽高，导出时已烘焙为正立像素，不再二次旋转。",
    executeBtn: (n: number) => (n > 0 ? `开始批量缩放 (${n} 张)` : "开始缩放"),
    unchangedBadge: "保持原尺寸",
    targetBadge: (w: number, h: number) => `→ ${w}×${h}`,
    stageDims: (dw: number, dh: number, tw: number, th: number, unchanged: boolean) =>
      unchanged ? `${dw}×${dh} → ${tw}×${th}（保持原尺寸）` : `${dw}×${dh} → ${tw}×${th}`,
    previewLoading: "正在加载高清预览…",
  },
  "en-US": {
    emptyTitle: "Select or drop images to resize in bulk",
    emptyBody:
      "Scale by percentage, longest edge, or exact dimensions. Keeps aspect ratio and prevents upscaling by default, calculating sizes from actual display orientation including EXIF-tagged phone photos.",
    modeTitle: "Resize mode",
    modePercentage: "Percentage",
    modeLongest: "Longest Edge",
    modeExact: "Exact W × H",
    percentageLabel: "Scale percentage (1% – 400%)",
    longestEdgeLabel: "Target longest edge (px)",
    widthLabel: "Target width (px)",
    heightLabel: "Target height (px)",
    keepAspectLabel: "Keep aspect ratio (no stretching)",
    preventUpscaleLabel: "Do not upscale (keep images smaller than target as-is)",
    stretchWarn: "Aspect ratio lock is off; images will be stretched to exact W × H.",
    exifNote:
      "EXIF-oriented photos are sized in display orientation and exported upright without residual rotation tags.",
    executeBtn: (n: number) => (n > 0 ? `Resize ${n} Image(s)` : "Resize"),
    unchangedBadge: "Kept size",
    targetBadge: (w: number, h: number) => `→ ${w}×${h}`,
    stageDims: (dw: number, dh: number, tw: number, th: number, unchanged: boolean) =>
      unchanged ? `${dw}×${dh} → ${tw}×${th} (unchanged)` : `${dw}×${dh} → ${tw}×${th}`,
    previewLoading: "Loading preview…",
  },
};

export function ImageResizeWorkspace() {
  const { locale, t: messages } = useI18n();
  const t = copy[locale];
  const { session, updateImageResizeSession, startImageResizeBatch, cancelImageResizeBatch } =
    useSessionStore();
  const state = session.imageResize;

  const [inspecting, setInspecting] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewSeqRef = useRef(0);

  const busy = state.status === "running";
  const selectedItem =
    state.items.find((i) => i.path === state.selectedPath) ?? state.items[0] ?? null;

  useEffect(() => {
    if (!selectedItem || selectedItem.error) {
      setPreviewUrl(null);
      return;
    }
    const reqId = ++previewSeqRef.current;
    previewRotateImage({ path: selectedItem.path, steps: [] })
      .then((res) => {
        if (previewSeqRef.current === reqId) setPreviewUrl(res.previewDataUrl);
      })
      .catch(() => {
        if (previewSeqRef.current === reqId) setPreviewUrl(selectedItem.thumbnailDataUrl);
      });
  }, [selectedItem]);

  const handleAddPaths = useCallback(
    async (paths: string[]) => {
      setInspecting(true);
      try {
        const inspected = await inspectBatchImages(paths);
        updateImageResizeSession((prev) => {
          const merged = mergeInspectedItems(prev.items, inspected.items);
          return {
            ...prev,
            items: merged,
            selectedPath: prev.selectedPath ?? merged[0]?.path ?? null,
            errorMessage: null,
          };
        });
      } catch (err) {
        updateImageResizeSession({ errorMessage: formatLocalizedError(err, messages) });
      } finally {
        setInspecting(false);
      }
    },
    [messages, updateImageResizeSession],
  );

  const computeFor = (item: InspectedImageItem) =>
    computeResizeTargetDimensions(item.displayWidth, item.displayHeight, {
      mode: state.mode,
      percentage: state.percentage,
      longestEdge: state.longestEdge,
      targetWidth: state.targetWidth,
      targetHeight: state.targetHeight,
      keepAspectRatio: state.keepAspectRatio,
      preventUpscale: state.preventUpscale,
    });

  const handleExecute = () => {
    if (busy || state.items.length === 0 || !state.outputDir) return;
    void startImageResizeBatch(
      {
        sourcePaths: state.items.map((i) => i.path),
        outputDir: state.outputDir,
        mode: state.mode,
        percentage: state.percentage,
        longestEdge: state.longestEdge,
        targetWidth: state.targetWidth,
        targetHeight: state.targetHeight,
        keepAspectRatio: state.keepAspectRatio,
        preventUpscale: state.preventUpscale,
      },
      (err) => formatLocalizedError(err, messages),
    );
  };

  const renderPreview = (item: InspectedImageItem | null) => {
    if (!item) return null;
    const target = item.error ? null : computeFor(item);
    return (
      <>
        <div className="img-batch-stage-header">
          <div className="img-batch-group">
            <strong style={{ fontSize: 13 }}>{item.fileName}</strong>
            <span className="status-pill">{formatImageFormatLabel(item.format)}</span>
            {target && (
              <span className={`status-pill ${target.unchanged ? "is-warn" : "is-ok"}`}>
                {t.stageDims(
                  item.displayWidth,
                  item.displayHeight,
                  target.width,
                  target.height,
                  target.unchanged,
                )}
              </span>
            )}
            <span className="status-pill">{formatImageBytes(item.byteLength)}</span>
          </div>
        </div>

        <div className="img-batch-stage-canvas">
          {item.error ? (
            <div className="img-batch-empty">
              <strong style={{ color: "var(--status-err)" }}>{item.error}</strong>
            </div>
          ) : previewUrl || item.thumbnailDataUrl ? (
            <img
              src={previewUrl ?? item.thumbnailDataUrl ?? ""}
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
        <span className="img-batch-section-title">{t.modeTitle}</span>
        <div className="img-batch-chip-grid" role="group" aria-label={t.modeTitle}>
          {(
            [
              ["percentage", t.modePercentage],
              ["longest_edge", t.modeLongest],
              ["exact", t.modeExact],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              disabled={busy}
              className={`img-batch-choice-btn ${state.mode === m ? "is-active" : ""}`}
              onClick={() => updateImageResizeSession({ mode: m as ResizeMode })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {state.mode === "percentage" && (
        <div className="img-batch-section">
          <label className="img-batch-section-title" htmlFor="i07-pct-input">
            {t.percentageLabel}
          </label>
          <input
            id="i07-pct-input"
            type="number"
            min={1}
            max={400}
            className="text-input"
            disabled={busy}
            value={state.percentage}
            onChange={(e) =>
              updateImageResizeSession({ percentage: Math.max(1, Number(e.target.value) || 1) })
            }
          />
        </div>
      )}

      {state.mode === "longest_edge" && (
        <div className="img-batch-section">
          <label className="img-batch-section-title" htmlFor="i07-edge-input">
            {t.longestEdgeLabel}
          </label>
          <input
            id="i07-edge-input"
            type="number"
            min={1}
            max={32768}
            className="text-input"
            disabled={busy}
            value={state.longestEdge}
            onChange={(e) =>
              updateImageResizeSession({
                longestEdge: Math.max(1, Math.round(Number(e.target.value) || 1)),
              })
            }
          />
        </div>
      )}

      {state.mode === "exact" && (
        <div className="img-batch-section">
          <label className="img-batch-section-title" htmlFor="i07-w-input">
            {t.widthLabel}
          </label>
          <input
            id="i07-w-input"
            type="number"
            min={1}
            max={32768}
            className="text-input"
            disabled={busy}
            value={state.targetWidth}
            onChange={(e) =>
              updateImageResizeSession({
                targetWidth: Math.max(1, Math.round(Number(e.target.value) || 1)),
              })
            }
          />
          <label className="img-batch-section-title" htmlFor="i07-h-input">
            {t.heightLabel}
          </label>
          <input
            id="i07-h-input"
            type="number"
            min={1}
            max={32768}
            className="text-input"
            disabled={busy}
            value={state.targetHeight}
            onChange={(e) =>
              updateImageResizeSession({
                targetHeight: Math.max(1, Math.round(Number(e.target.value) || 1)),
              })
            }
          />
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={state.keepAspectRatio}
              disabled={busy}
              onChange={(e) => updateImageResizeSession({ keepAspectRatio: e.target.checked })}
            />
            <span>{t.keepAspectLabel}</span>
          </label>
          {!state.keepAspectRatio && <div className="inline-banner is-warn">{t.stretchWarn}</div>}
        </div>
      )}

      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={state.preventUpscale}
          disabled={busy}
          onChange={(e) => updateImageResizeSession({ preventUpscale: e.target.checked })}
        />
        <span>{t.preventUpscaleLabel}</span>
      </label>

      <p className="img-batch-hint">{t.exifNote}</p>
    </>
  );

  return (
    <ImageBatchShell
      toolId="I07"
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
      onSelectPath={(path) => updateImageResizeSession({ selectedPath: path })}
      onRemovePath={(path) =>
        updateImageResizeSession((prev) => {
          const next = prev.items.filter((i) => i.path !== path);
          return {
            ...prev,
            items: next,
            selectedPath: prev.selectedPath === path ? (next[0]?.path ?? null) : prev.selectedPath,
          };
        })
      }
      onClear={() =>
        updateImageResizeSession({
          items: [],
          selectedPath: null,
          lastReport: null,
          errorMessage: null,
        })
      }
      onChooseOutputDir={(dir) => updateImageResizeSession({ outputDir: dir })}
      onExecute={handleExecute}
      onCancel={() => void cancelImageResizeBatch()}
      renderPreview={renderPreview}
      renderControls={renderControls}
      renderItemBadge={(item) => {
        if (item.error) return null;
        const target = computeFor(item);
        return (
          <span className={`status-pill ${target.unchanged ? "is-warn" : "is-ok"}`}>
            {target.unchanged ? t.unchangedBadge : t.targetBadge(target.width, target.height)}
          </span>
        );
      }}
    />
  );
}
