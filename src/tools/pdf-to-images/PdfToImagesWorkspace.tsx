import { AlertTriangle, CheckCircle2, Eye, FolderOpen, Images } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../i18n/I18nContext";
import { PDF_MESSAGES } from "../../i18n/pdfMessages";
import { usePdfSession } from "../../lib/pdfSessionStore";
import {
  bindDisposableListener,
  cancelBackendTask,
  formatLocalizedError,
  getImageHeicCapabilities,
  inspectPdfDocument,
  openLocalDirectory,
  pdfToImages,
  pickSingleDirectory,
  pickSingleFile,
  previewPdfToImagesPlan,
  subscribeFileDrop,
  subscribePdfTaskProgress,
  type PdfExportImageFormat,
  type PdfExportPageScope,
} from "../../lib/tauriBridge";
import "../pdf-shared/pdfToolCommon.css";

function parentDirFromPath(p: string): string {
  const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return idx > 0 ? p.slice(0, idx) : p;
}

export function PdfToImagesWorkspace() {
  const { locale, t } = useI18n();
  const pm = PDF_MESSAGES[locale];
  const {
    pdfSession,
    updatePdfToImagesSession,
    openInPdfReader,
    pendingToolIntake,
    clearPendingToolIntake,
  } = usePdfSession();
  const state = pdfSession.pdfToImages;

  const [dropHover, setDropHover] = useState(false);
  const [heicEncodeAvailable, setHeicEncodeAvailable] = useState(false);

  // Probe real system WIC HEIC encode availability once
  useEffect(() => {
    void getImageHeicCapabilities()
      .then((caps) => {
        setHeicEncodeAvailable(Boolean(caps.encodeAvailable));
      })
      .catch(() => setHeicEncodeAvailable(false));
  }, []);

  const loadSourcePdf = useCallback(
    async (path: string) => {
      updatePdfToImagesSession((prev) => ({
        ...prev,
        sourcePath: path,
        inspectLoading: true,
        errorMessage: null,
        lastResult: null,
        planPreview: null,
        outputDir: prev.outputDir || parentDirFromPath(path),
      }));
      try {
        const info = await inspectPdfDocument(path);
        updatePdfToImagesSession((prev) => ({
          ...prev,
          sourcePath: info.path,
          inspection: info,
          inspectLoading: false,
          singlePage: 1,
          customRange:
            prev.customRange || (info.pageCount >= 2 ? `1-${Math.min(info.pageCount, 3)}` : "1"),
        }));
      } catch (err) {
        updatePdfToImagesSession((prev) => ({
          ...prev,
          inspection: null,
          inspectLoading: false,
          errorMessage: formatLocalizedError(err, t),
        }));
      }
    },
    [t, updatePdfToImagesSession],
  );

  useEffect(() => {
    if (pendingToolIntake?.toolId === "P17") {
      const p = pendingToolIntake.path;
      clearPendingToolIntake();
      void loadSourcePdf(p);
    }
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
      "p17-file-drop",
    );
  }, [loadSourcePdf]);

  // Live upfront pixel size & count estimation
  useEffect(() => {
    if (!state.inspection) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void previewPdfToImagesPlan({
        path: state.inspection!.path,
        scope: state.scope,
        singlePage: state.singlePage,
        customRange: state.customRange,
        dpi: state.dpi,
        format: state.format,
      })
        .then((plan) => {
          if (!active) return;
          setHeicEncodeAvailable(plan.heicEncodeAvailable);
          updatePdfToImagesSession((prev) => ({ ...prev, planPreview: plan }));
        })
        .catch(() => {});
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [
    state.inspection,
    state.scope,
    state.singlePage,
    state.customRange,
    state.dpi,
    state.format,
    updatePdfToImagesSession,
  ]);

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribePdfTaskProgress((ev) => {
          if (ev.toolId !== "P17") return;
          updatePdfToImagesSession((prev) =>
            prev.activeTaskId === ev.taskId ? { ...prev, progress: ev } : prev,
          );
        }),
      "p17-progress",
    );
  }, [updatePdfToImagesSession]);

  const handleSelectSource = async () => {
    const picked = await pickSingleFile({
      title: pm.pdfToImages.selectSourceBtn,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (picked) await loadSourcePdf(picked);
  };

  const handleSelectOutputDir = async () => {
    const dir = await pickSingleDirectory({ title: pm.common.chooseOutputFolder });
    if (dir) {
      updatePdfToImagesSession((prev) => ({ ...prev, outputDir: dir, errorMessage: null }));
    }
  };

  const handleExport = async () => {
    if (!state.inspection || !state.planPreview?.valid || !state.outputDir.trim()) return;
    const taskId = `p17-${Date.now()}`;
    updatePdfToImagesSession((prev) => ({
      ...prev,
      taskStatus: "running",
      activeTaskId: taskId,
      progress: {
        taskId,
        toolId: "P17",
        current: 0,
        total: state.planPreview?.targetPageCount ?? 1,
        percent: 0,
        detail: "",
      },
      errorMessage: null,
      lastResult: null,
    }));

    try {
      const res = await pdfToImages({
        taskId,
        path: state.inspection.path,
        scope: state.scope,
        singlePage: state.singlePage,
        customRange: state.customRange,
        dpi: state.dpi,
        format: state.format,
        quality: state.quality,
        webpLossless: state.webpLossless,
        outputDir: state.outputDir.trim(),
        createSubfolder: state.createSubfolder,
      });
      updatePdfToImagesSession((prev) => ({
        ...prev,
        taskStatus: "idle",
        activeTaskId: null,
        progress: null,
        lastResult: res,
        errorMessage: null,
      }));
    } catch (err) {
      updatePdfToImagesSession((prev) => ({
        ...prev,
        taskStatus: "idle",
        activeTaskId: null,
        progress: null,
        errorMessage: formatLocalizedError(err, t),
      }));
    }
  };

  const info = state.inspection;
  const plan = state.planPreview;
  const formatOptions: { id: PdfExportImageFormat; label: string }[] = [
    { id: "png", label: "PNG" },
    { id: "jpeg", label: "JPEG" },
    { id: "webp", label: "WebP" },
    ...(heicEncodeAvailable ? [{ id: "heic" as const, label: "HEIC" }] : []),
  ];

  return (
    <div
      className={`pdf-tool-workspace ${dropHover ? "is-drop-hover" : ""}`}
      data-testid="pdf-to-images-workspace"
    >
      <div className="pdf-tool-header">
        <p>{pm.pdfToImages.subtitle}</p>
        <span className="pdf-muted-note">{pm.common.nonDestructiveNote}</span>
      </div>

      {/* Source PDF Card */}
      <section className="pdf-card">
        <div className="pdf-card-head">
          <h2 className="pdf-card-title">
            {info ? info.fileName : pm.pdfToImages.selectSourceBtn}
          </h2>
          <div className="pdf-queue-actions">
            {info && (
              <button type="button" className="btn" onClick={() => openInPdfReader(info.path)}>
                <Eye size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{pm.common.openInPreview}</span>
              </button>
            )}
            <button
              type="button"
              className="btn btn-primary"
              disabled={state.taskStatus === "running" || state.inspectLoading}
              onClick={() => void handleSelectSource()}
            >
              <FolderOpen size={15} strokeWidth={1.75} aria-hidden="true" />
              <span>
                {state.inspectLoading ? pm.common.working : pm.pdfToImages.selectSourceBtn}
              </span>
            </button>
          </div>
        </div>

        {!info ? (
          <div className="pdf-drop-empty">
            <Images size={28} strokeWidth={1.5} aria-hidden="true" />
            <span>{pm.pdfToImages.emptySource}</span>
            <span className="pdf-muted-note">{pm.common.dropHint}</span>
          </div>
        ) : (
          <div className="pdf-badge-row">
            <span className="badge mono">{pm.common.pagesUnit(info.pageCount)}</span>
            <span className="badge mono">{pm.common.bytesLabel(info.byteLength)}</span>
          </div>
        )}
      </section>

      {/* Export Settings & Upfront Estimate */}
      {info && (
        <section className="pdf-card">
          <div className="pdf-action-bar">
            <div>
              <span className="field-label">{pm.pdfToImages.scopeLabel}</span>
              <div className="segmented" role="group" aria-label={pm.pdfToImages.scopeLabel}>
                {(
                  [
                    { id: "all", label: pm.pdfToImages.scopeAll },
                    { id: "single_page", label: pm.pdfToImages.scopeSingle },
                    { id: "custom_range", label: pm.pdfToImages.scopeRange },
                  ] as { id: PdfExportPageScope; label: string }[]
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className={`segmented-btn ${state.scope === opt.id ? "is-selected" : ""}`}
                    aria-pressed={state.scope === opt.id}
                    disabled={state.taskStatus === "running"}
                    onClick={() => updatePdfToImagesSession((prev) => ({ ...prev, scope: opt.id }))}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className="field-label">{pm.pdfToImages.formatLabel}</span>
              <div className="segmented" role="group" aria-label={pm.pdfToImages.formatLabel}>
                {formatOptions.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className={`segmented-btn ${state.format === opt.id ? "is-selected" : ""}`}
                    aria-pressed={state.format === opt.id}
                    disabled={state.taskStatus === "running"}
                    onClick={() =>
                      updatePdfToImagesSession((prev) => ({ ...prev, format: opt.id }))
                    }
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {!heicEncodeAvailable && (
            <span className="pdf-muted-note">{pm.pdfToImages.heicUnavailableNote}</span>
          )}

          {state.scope === "single_page" && (
            <div className="pdf-path-row">
              <label className="field-label" htmlFor="p17-single-page" style={{ margin: 0 }}>
                {pm.pdfToImages.singlePageLabel}
              </label>
              <input
                id="p17-single-page"
                type="number"
                min={1}
                max={info.pageCount}
                className="pdf-number-input mono"
                value={state.singlePage}
                disabled={state.taskStatus === "running"}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10);
                  updatePdfToImagesSession((prev) => ({
                    ...prev,
                    singlePage: Number.isFinite(n) ? n : 1,
                  }));
                }}
              />
            </div>
          )}

          {state.scope === "custom_range" && (
            <div>
              <label className="field-label" htmlFor="p17-custom-range">
                {pm.pdfToImages.customRangeLabel}
              </label>
              <input
                id="p17-custom-range"
                type="text"
                className="pdf-path-input mono"
                value={state.customRange}
                placeholder={pm.pdfToImages.customRangePlaceholder}
                disabled={state.taskStatus === "running"}
                onChange={(e) =>
                  updatePdfToImagesSession((prev) => ({ ...prev, customRange: e.target.value }))
                }
              />
            </div>
          )}

          <div className="pdf-path-row">
            <span className="field-label" style={{ margin: 0 }}>
              {pm.pdfToImages.dpiLabel}
            </span>
            {[72, 150, 300].map((preset) => (
              <button
                key={preset}
                type="button"
                className={`btn mono ${state.dpi === preset ? "btn-primary" : ""}`}
                disabled={state.taskStatus === "running"}
                onClick={() => updatePdfToImagesSession((prev) => ({ ...prev, dpi: preset }))}
              >
                {preset} DPI
              </button>
            ))}
            <input
              type="number"
              min={36}
              max={600}
              className="pdf-number-input mono"
              aria-label={pm.pdfToImages.dpiCustomLabel}
              value={state.dpi}
              disabled={state.taskStatus === "running"}
              onChange={(e) => {
                const v = Number.parseInt(e.target.value, 10);
                updatePdfToImagesSession((prev) => ({
                  ...prev,
                  dpi: Number.isFinite(v) ? v : 150,
                }));
              }}
            />

            {state.format !== "png" && (
              <>
                <label
                  className="field-label"
                  htmlFor="p17-quality"
                  style={{ margin: "0 0 0 8px" }}
                >
                  {pm.pdfToImages.qualityLabel}: {state.quality}%
                </label>
                <input
                  id="p17-quality"
                  type="range"
                  min={40}
                  max={100}
                  value={state.quality}
                  disabled={
                    state.taskStatus === "running" ||
                    (state.format === "webp" && state.webpLossless)
                  }
                  onChange={(e) =>
                    updatePdfToImagesSession((prev) => ({
                      ...prev,
                      quality: Number.parseInt(e.target.value, 10),
                    }))
                  }
                />
              </>
            )}

            {state.format === "webp" && (
              <label className="pdf-checkbox-row" style={{ marginLeft: 8 }}>
                <input
                  type="checkbox"
                  checked={state.webpLossless}
                  disabled={state.taskStatus === "running"}
                  onChange={(e) =>
                    updatePdfToImagesSession((prev) => ({
                      ...prev,
                      webpLossless: e.target.checked,
                    }))
                  }
                />
                <span>{pm.pdfToImages.webpLosslessLabel}</span>
              </label>
            )}
          </div>

          <label className="pdf-checkbox-row">
            <input
              type="checkbox"
              checked={state.createSubfolder}
              disabled={state.taskStatus === "running"}
              onChange={(e) =>
                updatePdfToImagesSession((prev) => ({
                  ...prev,
                  createSubfolder: e.target.checked,
                }))
              }
            />
            <span>{pm.pdfToImages.createSubfolderLabel}</span>
          </label>

          <div>
            <label className="field-label" htmlFor="p17-output-dir">
              {pm.pdfToImages.outputDirLabel}
            </label>
            <div className="pdf-path-row">
              <input
                id="p17-output-dir"
                type="text"
                className="pdf-path-input mono"
                value={state.outputDir}
                disabled={state.taskStatus === "running"}
                onChange={(e) =>
                  updatePdfToImagesSession((prev) => ({ ...prev, outputDir: e.target.value }))
                }
              />
              <button
                type="button"
                className="btn"
                disabled={state.taskStatus === "running"}
                onClick={() => void handleSelectOutputDir()}
              >
                <FolderOpen size={15} strokeWidth={1.75} aria-hidden="true" />
                <span>{pm.common.chooseOutputFolder}</span>
              </button>
            </div>
          </div>

          {/* Upfront Size Estimate & Validation */}
          {plan?.errors.map((err, idx) => (
            <div key={`err-${idx}`} className="pdf-note-box is-error" role="alert">
              <AlertTriangle size={14} strokeWidth={1.75} aria-hidden="true" /> {err}
            </div>
          ))}
          {plan?.warnings.map((w, idx) => (
            <div key={`warn-${idx}`} className="pdf-note-box is-warn" role="status">
              <AlertTriangle size={14} strokeWidth={1.75} aria-hidden="true" /> {w}
            </div>
          ))}
          {plan && plan.valid && (
            <div className="pdf-note-box mono" style={{ fontSize: "12.5px" }}>
              {pm.pdfToImages.estimateLine(
                plan.targetPageCount,
                plan.maxWidthPx,
                plan.maxHeightPx,
                plan.cappedCount,
              )}
            </div>
          )}

          {state.taskStatus === "running" && state.progress && (
            <div>
              <div className="pdf-action-bar" style={{ marginBottom: "6px" }}>
                <span className="pdf-muted-note">{state.progress.detail || pm.common.working}</span>
                <span className="mono" style={{ fontSize: "12px" }}>
                  {Math.round(state.progress.percent)}%
                </span>
              </div>
              <div className="pdf-progress-track">
                <div
                  className="pdf-progress-fill"
                  style={{ width: `${Math.min(100, Math.max(2, state.progress.percent))}%` }}
                />
              </div>
            </div>
          )}

          {state.errorMessage && (
            <div className="pdf-note-box is-error" role="alert">
              {state.errorMessage}
            </div>
          )}

          <div className="pdf-action-bar">
            <span className="pdf-muted-note">{pm.common.nonDestructiveNote}</span>
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
                  disabled={!plan?.valid || !state.outputDir.trim()}
                  onClick={() => void handleExport()}
                >
                  <Images size={15} strokeWidth={1.75} aria-hidden="true" />
                  <span>{pm.pdfToImages.exportBtn}</span>
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Results Table */}
      {state.lastResult && (
        <section className="pdf-card" data-testid="pdf-to-images-result">
          <div className={`pdf-note-box ${state.lastResult.cancelled ? "is-warn" : "is-success"}`}>
            <div className="pdf-action-bar">
              <div>
                <strong>
                  <CheckCircle2 size={14} strokeWidth={1.75} aria-hidden="true" />{" "}
                  {pm.pdfToImages.resultSummary(
                    state.lastResult.succeededCount,
                    state.lastResult.failedCount,
                    pm.common.bytesLabel(state.lastResult.totalOutputBytes),
                  )}
                </strong>
                <div className="mono" style={{ fontSize: "12px", marginTop: "4px" }}>
                  {state.lastResult.outputDir}
                </div>
              </div>
              <button
                type="button"
                className="btn"
                onClick={() => void openLocalDirectory(state.lastResult!.outputDir)}
              >
                <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{pm.common.openFolder}</span>
              </button>
            </div>
          </div>

          <div className="pdf-plan-table-wrap">
            <table className="pdf-plan-table">
              <thead>
                <tr>
                  <th>{pm.pdfToImages.colPage}</th>
                  <th>{pm.pdfToImages.colStatus}</th>
                  <th>{pm.pdfToImages.colDimensions}</th>
                  <th>{pm.pdfToImages.colFile}</th>
                </tr>
              </thead>
              <tbody>
                {state.lastResult.items.map((item) => (
                  <tr key={item.pageNumber}>
                    <td className="mono">{item.pageNumber}</td>
                    <td>
                      <span
                        className={`badge ${item.status === "ok" ? "badge-ok" : "badge-partial"}`}
                      >
                        {item.status === "ok"
                          ? pm.pdfToImages.statusOk
                          : pm.pdfToImages.statusError}
                      </span>
                    </td>
                    <td className="mono">
                      {item.widthPx && item.heightPx ? `${item.widthPx}×${item.heightPx}` : "—"}
                    </td>
                    <td className="mono">{item.fileName ?? item.errorMessage ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
