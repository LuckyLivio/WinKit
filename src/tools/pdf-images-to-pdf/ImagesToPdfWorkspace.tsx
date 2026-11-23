import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Eye,
  FileImage,
  FilePlus2,
  FolderOpen,
  GripVertical,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nContext";
import { PDF_MESSAGES } from "../../i18n/pdfMessages";
import { usePdfSession, type PdfImageQueueEntry } from "../../lib/pdfSessionStore";
import {
  bindDisposableListener,
  cancelBackendTask,
  formatLocalizedError,
  imagesToPdf,
  inspectBatchImages,
  openLocalDirectory,
  parseBackendError,
  pickMultipleFiles,
  pickSaveFilePath,
  subscribeFileDrop,
  subscribePdfTaskProgress,
  suggestSafeSiblingPath,
  type PdfPageOrientation,
  type PdfPageSizePreset,
} from "../../lib/tauriBridge";
import "../pdf-shared/pdfToolCommon.css";

const SUPPORTED_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "bmp",
  "tif",
  "tiff",
  "heic",
  "heif",
]);

function parentDirFromPath(p: string): string {
  const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return idx > 0 ? p.slice(0, idx) : p;
}

function isSupportedImage(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return SUPPORTED_EXTS.has(path.slice(dot + 1).toLowerCase());
}

export function ImagesToPdfWorkspace() {
  const { locale, t } = useI18n();
  const pm = PDF_MESSAGES[locale];
  const { pdfSession, updateImagesToPdfSession, openInPdfReader } = usePdfSession();
  const state = pdfSession.imagesToPdf;

  const [dropHover, setDropHover] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overwritePrompt, setOverwritePrompt] = useState(false);
  const seqRef = useRef(1);

  const addImagePaths = useCallback(
    async (paths: string[]) => {
      const validPaths = paths.filter(isSupportedImage);
      if (validPaths.length === 0) return;

      try {
        const inspected = await inspectBatchImages(validPaths);
        const added: PdfImageQueueEntry[] = inspected.items.map((it) => ({
          id: `p12-img-${Date.now()}-${seqRef.current++}`,
          path: it.path,
          fileName: it.fileName,
          width: it.displayWidth,
          height: it.displayHeight,
          byteLength: it.byteLength,
          hasAlpha: it.hasAlpha,
          thumbnailDataUrl: it.thumbnailDataUrl,
          errorMessage: it.error,
        }));
        if (added.length === 0) return;

        updateImagesToPdfSession((prev) => ({
          ...prev,
          items: [...prev.items, ...added],
          lastResult: null,
          errorMessage: null,
        }));

        if (!state.outputPath && added[0]) {
          const suggested = await suggestSafeSiblingPath(added[0].path, "_images", "pdf");
          if (suggested) {
            updateImagesToPdfSession((prev) =>
              prev.outputPath ? prev : { ...prev, outputPath: suggested },
            );
          }
        }
      } catch (err) {
        updateImagesToPdfSession((prev) => ({
          ...prev,
          errorMessage: formatLocalizedError(err, t),
        }));
      }
    },
    [state.outputPath, t, updateImagesToPdfSession],
  );

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: setDropHover,
          onDropPaths: (paths) => {
            void addImagePaths(paths);
          },
        }),
      "p12-file-drop",
    );
  }, [addImagePaths]);

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribePdfTaskProgress((ev) => {
          if (ev.toolId !== "P12") return;
          updateImagesToPdfSession((prev) =>
            prev.activeTaskId === ev.taskId ? { ...prev, progress: ev } : prev,
          );
        }),
      "p12-progress",
    );
  }, [updateImagesToPdfSession]);

  const handlePickImages = async () => {
    const picked = await pickMultipleFiles({
      title: pm.imagesToPdf.addImagesBtn,
      filters: [
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "heic", "heif"],
        },
      ],
    });
    if (picked.length > 0) await addImagePaths(picked);
  };

  const handleChooseOutput = async () => {
    const picked = await pickSaveFilePath({
      title: pm.common.chooseOutputFile,
      defaultPath: state.outputPath || "images.pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (picked) {
      const withExt = picked.toLowerCase().endsWith(".pdf") ? picked : `${picked}.pdf`;
      updateImagesToPdfSession((prev) => ({ ...prev, outputPath: withExt, errorMessage: null }));
    }
  };

  const moveItem = (idx: number, delta: number) => {
    const target = idx + delta;
    if (target < 0 || target >= state.items.length) return;
    updateImagesToPdfSession((prev) => {
      const next = [...prev.items];
      const [moved] = next.splice(idx, 1);
      if (moved) next.splice(target, 0, moved);
      return { ...prev, items: next };
    });
  };

  const reorderDrop = (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return;
    updateImagesToPdfSession((prev) => {
      const next = [...prev.items];
      const [moved] = next.splice(fromIdx, 1);
      if (moved) next.splice(toIdx, 0, moved);
      return { ...prev, items: next };
    });
  };

  const validItems = state.items.filter((i) => !i.errorMessage);
  const hasAnyAlpha = validItems.some((i) => i.hasAlpha);

  const executeBuild = async (overwrite: boolean) => {
    setOverwritePrompt(false);
    if (validItems.length === 0 || !state.outputPath.trim()) return;
    const taskId = `p12-${Date.now()}`;
    updateImagesToPdfSession((prev) => ({
      ...prev,
      taskStatus: "running",
      activeTaskId: taskId,
      progress: {
        taskId,
        toolId: "P12",
        current: 0,
        total: validItems.length,
        percent: 0,
        detail: "",
      },
      errorMessage: null,
      lastResult: null,
    }));

    try {
      const res = await imagesToPdf({
        taskId,
        imagePaths: validItems.map((i) => i.path),
        outputPath: state.outputPath.trim(),
        overwrite,
        pageSize: state.pageSize,
        orientation: state.orientation,
        marginPt: state.marginPt,
        backgroundHex: state.backgroundHex,
        assumedDpi: state.assumedDpi,
        losslessPngImages: state.losslessPngImages,
      });
      updateImagesToPdfSession((prev) => ({
        ...prev,
        taskStatus: "idle",
        activeTaskId: null,
        progress: null,
        lastResult: res,
        errorMessage: null,
      }));
    } catch (err) {
      const parsed = parseBackendError(err);
      if (parsed.code === "TARGET_ALREADY_EXISTS" && !overwrite) {
        updateImagesToPdfSession((prev) => ({
          ...prev,
          taskStatus: "idle",
          activeTaskId: null,
          progress: null,
        }));
        setOverwritePrompt(true);
        return;
      }
      updateImagesToPdfSession((prev) => ({
        ...prev,
        taskStatus: "idle",
        activeTaskId: null,
        progress: null,
        errorMessage: formatLocalizedError(err, t),
      }));
    }
  };

  return (
    <div
      className={`pdf-tool-workspace ${dropHover ? "is-drop-hover" : ""}`}
      data-testid="pdf-images-to-pdf-workspace"
    >
      <div className="pdf-tool-header">
        <p>{pm.imagesToPdf.subtitle}</p>
        <span className="pdf-muted-note">{pm.common.nonDestructiveNote}</span>
      </div>

      {/* Image Queue Card */}
      <section className="pdf-card">
        <div className="pdf-card-head">
          <h2 className="pdf-card-title">
            {state.items.length > 0
              ? pm.imagesToPdf.queueHeader(state.items.length)
              : pm.imagesToPdf.addImagesBtn}
          </h2>
          <div className="pdf-queue-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={state.taskStatus === "running"}
              onClick={() => void handlePickImages()}
            >
              <FilePlus2 size={15} strokeWidth={1.75} aria-hidden="true" />
              <span>{pm.imagesToPdf.addImagesBtn}</span>
            </button>
            {state.items.length > 0 && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={state.taskStatus === "running"}
                onClick={() =>
                  updateImagesToPdfSession((prev) => ({
                    ...prev,
                    items: [],
                    lastResult: null,
                    errorMessage: null,
                  }))
                }
              >
                {pm.common.clear}
              </button>
            )}
          </div>
        </div>

        {state.items.length === 0 ? (
          <div className="pdf-drop-empty">
            <FileImage size={28} strokeWidth={1.5} aria-hidden="true" />
            <span>{pm.imagesToPdf.emptyQueue}</span>
            <span className="pdf-muted-note">{pm.common.dropHint}</span>
          </div>
        ) : (
          <div className="pdf-queue-list" role="list">
            {state.items.map((item, idx) => (
              <div
                key={item.id}
                role="listitem"
                draggable={state.taskStatus !== "running"}
                onDragStart={() => setDragIndex(idx)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragIndex !== null) reorderDrop(dragIndex, idx);
                  setDragIndex(null);
                }}
                onDragEnd={() => setDragIndex(null)}
                className={`pdf-queue-row ${dragIndex === idx ? "is-dragging" : ""}`}
              >
                <div className="pdf-queue-row-main">
                  <GripVertical size={15} strokeWidth={1.75} aria-hidden="true" />
                  <span className="pdf-queue-index mono">{idx + 1}</span>
                  {item.thumbnailDataUrl && (
                    <img
                      src={item.thumbnailDataUrl}
                      alt={item.fileName}
                      style={{
                        width: 40,
                        height: 40,
                        objectFit: "cover",
                        borderRadius: 5,
                        border: "1px solid var(--border-subtle)",
                        flexShrink: 0,
                      }}
                    />
                  )}
                  <div className="pdf-queue-meta">
                    <span className="pdf-queue-name" title={item.path}>
                      {item.fileName}
                    </span>
                    <div className="pdf-badge-row">
                      <span className="badge mono">
                        {item.width}×{item.height}
                      </span>
                      <span className="badge mono">{pm.common.bytesLabel(item.byteLength)}</span>
                      {item.hasAlpha && <span className="badge">Alpha</span>}
                      {item.errorMessage && (
                        <span className="badge badge-partial">{item.errorMessage}</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="pdf-queue-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    title={pm.common.moveUp}
                    aria-label={pm.common.moveUp}
                    disabled={idx === 0 || state.taskStatus === "running"}
                    onClick={() => moveItem(idx, -1)}
                  >
                    <ArrowUp size={15} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    title={pm.common.moveDown}
                    aria-label={pm.common.moveDown}
                    disabled={idx === state.items.length - 1 || state.taskStatus === "running"}
                    onClick={() => moveItem(idx, 1)}
                  >
                    <ArrowDown size={15} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    title={pm.common.remove}
                    aria-label={pm.common.remove}
                    disabled={state.taskStatus === "running"}
                    onClick={() =>
                      updateImagesToPdfSession((prev) => ({
                        ...prev,
                        items: prev.items.filter((i) => i.id !== item.id),
                      }))
                    }
                  >
                    <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Layout Options Card */}
      <section className="pdf-card">
        <h2 className="pdf-card-title">{pm.imagesToPdf.layoutTitle}</h2>

        <div className="pdf-action-bar">
          <div>
            <span className="field-label">{pm.imagesToPdf.pageSizeLabel}</span>
            <div className="segmented" role="group" aria-label={pm.imagesToPdf.pageSizeLabel}>
              {(
                [
                  { id: "a4", label: pm.imagesToPdf.sizeA4 },
                  { id: "letter", label: pm.imagesToPdf.sizeLetter },
                  { id: "original", label: pm.imagesToPdf.sizeOriginal },
                ] as { id: PdfPageSizePreset; label: string }[]
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`segmented-btn ${state.pageSize === opt.id ? "is-selected" : ""}`}
                  aria-pressed={state.pageSize === opt.id}
                  disabled={state.taskStatus === "running"}
                  onClick={() =>
                    updateImagesToPdfSession((prev) => ({ ...prev, pageSize: opt.id }))
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className="field-label">{pm.imagesToPdf.orientationLabel}</span>
            <div className="segmented" role="group" aria-label={pm.imagesToPdf.orientationLabel}>
              {(
                [
                  { id: "auto", label: pm.imagesToPdf.orientAuto },
                  { id: "portrait", label: pm.imagesToPdf.orientPortrait },
                  { id: "landscape", label: pm.imagesToPdf.orientLandscape },
                ] as { id: PdfPageOrientation; label: string }[]
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`segmented-btn ${state.orientation === opt.id ? "is-selected" : ""}`}
                  aria-pressed={state.orientation === opt.id}
                  disabled={state.taskStatus === "running"}
                  onClick={() =>
                    updateImagesToPdfSession((prev) => ({ ...prev, orientation: opt.id }))
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="pdf-path-row">
          <span className="field-label" style={{ margin: 0 }}>
            {pm.imagesToPdf.marginLabel}
          </span>
          {[
            { pt: 0, label: pm.imagesToPdf.marginNone },
            { pt: 18, label: pm.imagesToPdf.marginSmall },
            { pt: 36, label: pm.imagesToPdf.marginNormal },
          ].map((preset) => (
            <button
              key={preset.pt}
              type="button"
              className={`btn ${state.marginPt === preset.pt ? "btn-primary" : ""}`}
              disabled={state.taskStatus === "running"}
              onClick={() => updateImagesToPdfSession((prev) => ({ ...prev, marginPt: preset.pt }))}
            >
              {preset.label}
            </button>
          ))}
          <input
            type="number"
            min={0}
            max={144}
            className="pdf-number-input mono"
            aria-label={pm.imagesToPdf.marginCustom}
            value={state.marginPt}
            disabled={state.taskStatus === "running"}
            onChange={(e) => {
              const v = Number.parseFloat(e.target.value);
              updateImagesToPdfSession((prev) => ({
                ...prev,
                marginPt: Number.isFinite(v) ? Math.min(144, Math.max(0, v)) : 0,
              }));
            }}
          />

          {state.pageSize === "original" && (
            <>
              <label className="field-label" htmlFor="p12-dpi" style={{ margin: "0 0 0 8px" }}>
                {pm.imagesToPdf.dpiLabel}
              </label>
              <input
                id="p12-dpi"
                type="number"
                min={72}
                max={600}
                className="pdf-number-input mono"
                value={state.assumedDpi}
                disabled={state.taskStatus === "running"}
                onChange={(e) => {
                  const v = Number.parseFloat(e.target.value);
                  updateImagesToPdfSession((prev) => ({
                    ...prev,
                    assumedDpi: Number.isFinite(v) ? Math.min(600, Math.max(72, v)) : 150,
                  }));
                }}
              />
            </>
          )}
        </div>

        <div className="pdf-path-row">
          <label className="field-label" htmlFor="p12-bg-color" style={{ margin: 0 }}>
            {pm.imagesToPdf.backgroundLabel}
          </label>
          <input
            id="p12-bg-color"
            type="color"
            value={state.backgroundHex}
            disabled={state.taskStatus === "running"}
            onChange={(e) =>
              updateImagesToPdfSession((prev) => ({ ...prev, backgroundHex: e.target.value }))
            }
            style={{
              width: 36,
              height: 30,
              border: "1px solid var(--border-default)",
              borderRadius: 6,
            }}
          />
          <span className="mono" style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
            {state.backgroundHex}
          </span>
          <span className="pdf-muted-note">{hasAnyAlpha ? pm.imagesToPdf.backgroundHint : ""}</span>
        </div>

        <label className="pdf-checkbox-row">
          <input
            type="checkbox"
            checked={state.losslessPngImages}
            disabled={state.taskStatus === "running"}
            onChange={(e) =>
              updateImagesToPdfSession((prev) => ({
                ...prev,
                losslessPngImages: e.target.checked,
              }))
            }
          />
          <span>{pm.imagesToPdf.losslessPngLabel}</span>
        </label>

        <div>
          <label className="field-label" htmlFor="p12-output-path">
            {pm.imagesToPdf.outputPathLabel}
          </label>
          <div className="pdf-path-row">
            <input
              id="p12-output-path"
              type="text"
              className="pdf-path-input mono"
              value={state.outputPath}
              disabled={state.taskStatus === "running"}
              onChange={(e) =>
                updateImagesToPdfSession((prev) => ({ ...prev, outputPath: e.target.value }))
              }
            />
            <button
              type="button"
              className="btn"
              disabled={state.taskStatus === "running"}
              onClick={() => void handleChooseOutput()}
            >
              <FolderOpen size={15} strokeWidth={1.75} aria-hidden="true" />
              <span>{pm.common.chooseOutputFile}</span>
            </button>
          </div>
        </div>

        {overwritePrompt && (
          <div className="pdf-note-box is-warn" role="alertdialog">
            <p style={{ margin: "0 0 8px" }}>
              <strong>{pm.merge.overwriteTitle}</strong> —{" "}
              {pm.merge.overwriteBody(state.outputPath)}
            </p>
            <div className="pdf-queue-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void executeBuild(true)}
              >
                {pm.merge.overwriteConfirm}
              </button>
              <button type="button" className="btn" onClick={() => setOverwritePrompt(false)}>
                {pm.common.cancel}
              </button>
            </div>
          </div>
        )}

        {state.taskStatus === "running" && state.progress && (
          <div className="pdf-progress-track">
            <div
              className="pdf-progress-fill"
              style={{ width: `${Math.min(100, Math.max(2, state.progress.percent))}%` }}
            />
          </div>
        )}

        {state.errorMessage && (
          <div className="pdf-note-box is-error" role="alert">
            {state.errorMessage}
          </div>
        )}

        <div className="pdf-action-bar">
          <span className="pdf-muted-note">
            {validItems.length > 0 ? pm.imagesToPdf.queueHeader(validItems.length) : ""}
          </span>
          <div className="pdf-queue-actions">
            {state.taskStatus === "running" ? (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  if (state.activeTaskId) void cancelBackendTask(state.activeTaskId);
                }}
              >
                {pm.common.cancel}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={validItems.length === 0 || !state.outputPath.trim()}
                onClick={() => void executeBuild(false)}
              >
                <FileImage size={15} strokeWidth={1.75} aria-hidden="true" />
                <span>{pm.imagesToPdf.exportBtn}</span>
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Result Card */}
      {state.lastResult && (
        <section className="pdf-card" data-testid="pdf-images-to-pdf-result">
          <div className="pdf-note-box is-success">
            <div className="pdf-action-bar">
              <div>
                <strong>
                  <CheckCircle2 size={14} strokeWidth={1.75} aria-hidden="true" />{" "}
                  {pm.imagesToPdf.resultSummary(
                    state.lastResult.pageCount,
                    pm.common.bytesLabel(state.lastResult.byteLength),
                  )}
                </strong>
                <div className="mono" style={{ fontSize: "12px", marginTop: "4px" }}>
                  {state.lastResult.outputPath}
                </div>
              </div>
              <div className="pdf-queue-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => openInPdfReader(state.lastResult!.outputPath)}
                >
                  <Eye size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{pm.common.openInPreview}</span>
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    void openLocalDirectory(parentDirFromPath(state.lastResult!.outputPath))
                  }
                >
                  <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{pm.common.openFolder}</span>
                </button>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
