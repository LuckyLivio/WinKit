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
  computeRotatedDimensions,
  formatImageBytes,
  formatImageFormatLabel,
  mergeInspectedItems,
  type InspectedImageItem,
  type PreviewRotateImageResponse,
  type TransformStep,
} from "../image-batch/imageBatchModel";

const copy = {
  "zh-CN": {
    emptyTitle: "选择或拖入图片开始批量旋转与翻转",
    emptyBody:
      "支持左转 90°、右转 90°、旋转 180°、水平翻转与垂直翻转，可按点击顺序自由组合并重置。预览与导出均先按 EXIF 方向矫正再烘焙为正立像素，Windows 照片应用不会二次旋转。",
    actionsTitle: "旋转与翻转操作（按顺序组合）",
    rotateLeft: "左转 90°",
    rotateRight: "右转 90°",
    rotate180: "旋转 180°",
    flipH: "水平翻转",
    flipV: "垂直翻转",
    undoStep: "撤销上一步",
    resetSteps: "重置全部",
    sequenceTitle: "当前组合序列",
    sequenceEmpty: "尚未添加操作（若导出带 EXIF 方向的手机照片，仍会按当前正立显示方向烘焙导出）",
    stepLabels: {
      rotate_left: "左转 90°",
      rotate_right: "右转 90°",
      rotate_180: "旋转 180°",
      flip_horizontal: "水平翻转",
      flip_vertical: "垂直翻转",
    } as Record<TransformStep, string>,
    exifNote:
      "导出严格按照上方步骤顺序执行，并清除残留的 EXIF 方向标记，确保预览、导出与 Windows 照片应用方向完全一致。",
    executeBtn: (n: number) => (n > 0 ? `批量导出 (${n} 张)` : "批量导出"),
    previewLoading: "正在渲染旋转预览…",
    dimsPill: (dw: number, dh: number, ow: number, oh: number) =>
      dw === ow && dh === oh ? `${ow}×${oh}` : `${dw}×${dh} → ${ow}×${oh}`,
  },
  "en-US": {
    emptyTitle: "Select or drop images to rotate and flip in bulk",
    emptyBody:
      "Combine 90° left/right, 180° rotation, and horizontal/vertical flips in exact click order. EXIF orientation is baked upright so preview, export, and Windows Photos never double-rotate.",
    actionsTitle: "Transform controls (applied in order)",
    rotateLeft: "Rotate Left 90°",
    rotateRight: "Rotate Right 90°",
    rotate180: "Rotate 180°",
    flipH: "Flip Horizontal",
    flipV: "Flip Vertical",
    undoStep: "Undo Step",
    resetSteps: "Reset All",
    sequenceTitle: "Active transform sequence",
    sequenceEmpty:
      "No steps yet (exporting an EXIF-oriented photo will still bake it cleanly upright)",
    stepLabels: {
      rotate_left: "Left 90°",
      rotate_right: "Right 90°",
      rotate_180: "180°",
      flip_horizontal: "Flip H",
      flip_vertical: "Flip V",
    } as Record<TransformStep, string>,
    exifNote:
      "Steps execute in exact sequence and export upright pixels with Orientation = 1 so Windows Photos never rotates a second time.",
    executeBtn: (n: number) => (n > 0 ? `Export ${n} Image(s)` : "Export"),
    previewLoading: "Rendering transformed preview…",
    dimsPill: (dw: number, dh: number, ow: number, oh: number) =>
      dw === ow && dh === oh ? `${ow}×${oh}` : `${dw}×${dh} → ${ow}×${oh}`,
  },
};

export function ImageRotateWorkspace() {
  const { locale, t: messages } = useI18n();
  const t = copy[locale];
  const { session, updateImageRotateSession, startImageRotateBatch, cancelImageRotateBatch } =
    useSessionStore();
  const state = session.imageRotate;

  const [inspecting, setInspecting] = useState(false);
  const [preview, setPreview] = useState<PreviewRotateImageResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewSeqRef = useRef(0);

  const busy = state.status === "running";
  const selectedItem =
    state.items.find((i) => i.path === state.selectedPath) ?? state.items[0] ?? null;

  useEffect(() => {
    if (!selectedItem || selectedItem.error) {
      setPreview(null);
      setPreviewLoading(false);
      return;
    }
    const reqId = ++previewSeqRef.current;
    setPreviewLoading(true);
    previewRotateImage({
      path: selectedItem.path,
      steps: state.steps,
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
  }, [selectedItem, state.steps]);

  const handleAddPaths = useCallback(
    async (paths: string[]) => {
      setInspecting(true);
      try {
        const inspected = await inspectBatchImages(paths);
        updateImageRotateSession((prev) => {
          const merged = mergeInspectedItems(prev.items, inspected.items);
          return {
            ...prev,
            items: merged,
            selectedPath: prev.selectedPath ?? merged[0]?.path ?? null,
            errorMessage: null,
          };
        });
      } catch (err) {
        updateImageRotateSession({ errorMessage: formatLocalizedError(err, messages) });
      } finally {
        setInspecting(false);
      }
    },
    [messages, updateImageRotateSession],
  );

  const pushStep = (step: TransformStep) => {
    updateImageRotateSession((prev) => ({
      ...prev,
      steps: [...prev.steps, step],
    }));
  };

  const handleExecute = () => {
    if (busy || state.items.length === 0 || !state.outputDir) return;
    void startImageRotateBatch(
      {
        sourcePaths: state.items.map((i) => i.path),
        outputDir: state.outputDir,
        steps: state.steps,
      },
      (err) => formatLocalizedError(err, messages),
    );
  };

  const renderPreview = (item: InspectedImageItem | null) => {
    if (!item) return null;
    const dims = computeRotatedDimensions(item.displayWidth, item.displayHeight, state.steps);
    return (
      <>
        <div className="img-batch-stage-header">
          <div className="img-batch-group">
            <strong style={{ fontSize: 13 }}>{item.fileName}</strong>
            <span className="status-pill">{formatImageFormatLabel(item.format)}</span>
            {!item.error && (
              <span className="status-pill is-ok">
                {t.dimsPill(
                  item.displayWidth,
                  item.displayHeight,
                  preview?.outputWidth ?? dims.width,
                  preview?.outputHeight ?? dims.height,
                )}
              </span>
            )}
            <span className="status-pill">{formatImageBytes(item.byteLength)}</span>
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
        <span className="img-batch-section-title">{t.actionsTitle}</span>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          <button
            type="button"
            disabled={busy}
            className="img-batch-choice-btn"
            onClick={() => pushStep("rotate_left")}
          >
            {t.rotateLeft}
          </button>
          <button
            type="button"
            disabled={busy}
            className="img-batch-choice-btn"
            onClick={() => pushStep("rotate_right")}
          >
            {t.rotateRight}
          </button>
          <button
            type="button"
            disabled={busy}
            className="img-batch-choice-btn"
            onClick={() => pushStep("rotate_180")}
          >
            {t.rotate180}
          </button>
          <button
            type="button"
            disabled={busy}
            className="img-batch-choice-btn"
            onClick={() => pushStep("flip_horizontal")}
          >
            {t.flipH}
          </button>
          <button
            type="button"
            disabled={busy}
            style={{ gridColumn: "1 / -1" }}
            className="img-batch-choice-btn"
            onClick={() => pushStep("flip_vertical")}
          >
            {t.flipV}
          </button>
        </div>

        <div className="img-batch-group">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || state.steps.length === 0}
            onClick={() =>
              updateImageRotateSession((prev) => ({
                ...prev,
                steps: prev.steps.slice(0, -1),
              }))
            }
          >
            {t.undoStep}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || state.steps.length === 0}
            onClick={() => updateImageRotateSession({ steps: [] })}
          >
            {t.resetSteps}
          </button>
        </div>
      </div>

      <div className="img-batch-section">
        <span className="img-batch-section-title">{t.sequenceTitle}</span>
        {state.steps.length === 0 ? (
          <p className="img-batch-hint">{t.sequenceEmpty}</p>
        ) : (
          <div className="img-batch-group" style={{ gap: 4 }}>
            {state.steps.map((s, i) => (
              <span key={`${s}-${i}`} className="status-pill is-ok">
                {i + 1}. {t.stepLabels[s]}
              </span>
            ))}
          </div>
        )}
      </div>

      <p className="img-batch-hint">{t.exifNote}</p>
    </>
  );

  return (
    <ImageBatchShell
      toolId="I08"
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
      onSelectPath={(path) => updateImageRotateSession({ selectedPath: path })}
      onRemovePath={(path) =>
        updateImageRotateSession((prev) => {
          const next = prev.items.filter((i) => i.path !== path);
          return {
            ...prev,
            items: next,
            selectedPath: prev.selectedPath === path ? (next[0]?.path ?? null) : prev.selectedPath,
          };
        })
      }
      onClear={() =>
        updateImageRotateSession({
          items: [],
          selectedPath: null,
          lastReport: null,
          errorMessage: null,
        })
      }
      onChooseOutputDir={(dir) => updateImageRotateSession({ outputDir: dir })}
      onExecute={handleExecute}
      onCancel={() => void cancelImageRotateBatch()}
      renderPreview={renderPreview}
      renderControls={renderControls}
    />
  );
}
