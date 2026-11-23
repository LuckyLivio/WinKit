import { AlertTriangle, CheckCircle2, Eye, FolderOpen, Scissors } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../i18n/I18nContext";
import { PDF_MESSAGES } from "../../i18n/pdfMessages";
import { usePdfSession } from "../../lib/pdfSessionStore";
import {
  bindDisposableListener,
  cancelBackendTask,
  formatLocalizedError,
  inspectPdfDocument,
  openLocalDirectory,
  pickSingleDirectory,
  pickSingleFile,
  previewSplitPdfPlan,
  splitPdf,
  subscribeFileDrop,
  subscribePdfTaskProgress,
  type PdfSplitMode,
} from "../../lib/tauriBridge";
import "../pdf-shared/pdfToolCommon.css";

function parentDirFromPath(p: string): string {
  const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return idx > 0 ? p.slice(0, idx) : p;
}

export function PdfSplitWorkspace() {
  const { locale, t } = useI18n();
  const pm = PDF_MESSAGES[locale];
  const {
    pdfSession,
    updateSplitSession,
    openInPdfReader,
    pendingToolIntake,
    clearPendingToolIntake,
  } = usePdfSession();
  const state = pdfSession.split;

  const [dropHover, setDropHover] = useState(false);

  const loadSourcePdf = useCallback(
    async (path: string) => {
      updateSplitSession((prev) => ({
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
        updateSplitSession((prev) => ({
          ...prev,
          sourcePath: info.path,
          inspection: info,
          inspectLoading: false,
          customRanges:
            prev.customRanges ||
            (info.pageCount >= 2
              ? `1-${Math.ceil(info.pageCount / 2)}; ${Math.ceil(info.pageCount / 2) + 1}-${info.pageCount}`
              : "1"),
        }));
      } catch (err) {
        updateSplitSession((prev) => ({
          ...prev,
          inspection: null,
          inspectLoading: false,
          errorMessage: formatLocalizedError(err, t),
        }));
      }
    },
    [t, updateSplitSession],
  );

  // Consume cross-tool handoff from C08
  useEffect(() => {
    if (pendingToolIntake?.toolId === "P08") {
      const p = pendingToolIntake.path;
      clearPendingToolIntake();
      void loadSourcePdf(p);
    }
  }, [pendingToolIntake, clearPendingToolIntake, loadSourcePdf]);

  // Native file drag-and-drop
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
      "p08-file-drop",
    );
  }, [loadSourcePdf]);

  // Live upfront split plan validation & preview
  useEffect(() => {
    if (!state.inspection) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void previewSplitPdfPlan({
        path: state.inspection!.path,
        mode: state.mode,
        chunkSize: state.chunkSize,
        customRanges: state.customRanges,
        outputDir: state.outputDir || undefined,
      })
        .then((plan) => {
          if (!active) return;
          updateSplitSession((prev) => ({ ...prev, planPreview: plan }));
        })
        .catch((err) => {
          if (!active) return;
          updateSplitSession((prev) => ({
            ...prev,
            planPreview: null,
            errorMessage: formatLocalizedError(err, t),
          }));
        });
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [
    state.inspection,
    state.mode,
    state.chunkSize,
    state.customRanges,
    state.outputDir,
    t,
    updateSplitSession,
  ]);

  // Progress listener
  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribePdfTaskProgress((ev) => {
          if (ev.toolId !== "P08") return;
          updateSplitSession((prev) =>
            prev.activeTaskId === ev.taskId ? { ...prev, progress: ev } : prev,
          );
        }),
      "p08-progress",
    );
  }, [updateSplitSession]);

  const handleSelectSource = async () => {
    const picked = await pickSingleFile({
      title: pm.split.selectSourceBtn,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (picked) {
      await loadSourcePdf(picked);
    }
  };

  const handleSelectOutputDir = async () => {
    const dir = await pickSingleDirectory({ title: pm.common.chooseOutputFolder });
    if (dir) {
      updateSplitSession((prev) => ({ ...prev, outputDir: dir, errorMessage: null }));
    }
  };

  const handleSplit = async () => {
    if (!state.inspection || !state.planPreview?.valid) return;
    if (!state.outputDir.trim()) {
      updateSplitSession((prev) => ({ ...prev, errorMessage: pm.split.needOutputDir }));
      return;
    }

    const taskId = `p08-${Date.now()}`;
    updateSplitSession((prev) => ({
      ...prev,
      taskStatus: "running",
      activeTaskId: taskId,
      progress: {
        taskId,
        toolId: "P08",
        current: 0,
        total: state.planPreview?.outputFileCount ?? 1,
        percent: 0,
        detail: "",
      },
      errorMessage: null,
      lastResult: null,
    }));

    try {
      const res = await splitPdf({
        taskId,
        path: state.inspection.path,
        mode: state.mode,
        chunkSize: state.chunkSize,
        customRanges: state.customRanges,
        outputDir: state.outputDir.trim(),
      });
      updateSplitSession((prev) => ({
        ...prev,
        taskStatus: "idle",
        activeTaskId: null,
        progress: null,
        lastResult: res,
        errorMessage: null,
      }));
    } catch (err) {
      updateSplitSession((prev) => ({
        ...prev,
        taskStatus: "idle",
        activeTaskId: null,
        progress: null,
        errorMessage: formatLocalizedError(err, t),
      }));
    }
  };

  const handleCancel = async () => {
    if (state.activeTaskId) {
      await cancelBackendTask(state.activeTaskId).catch(() => {});
    }
  };

  const info = state.inspection;
  const plan = state.planPreview;

  return (
    <div
      className={`pdf-tool-workspace ${dropHover ? "is-drop-hover" : ""}`}
      data-testid="pdf-split-workspace"
    >
      <div className="pdf-tool-header">
        <p>{pm.split.subtitle}</p>
        <span className="pdf-muted-note">{pm.common.nonDestructiveNote}</span>
      </div>

      {/* Source Document Card */}
      <section className="pdf-card">
        <div className="pdf-card-head">
          <h2 className="pdf-card-title">{info ? info.fileName : pm.split.selectSourceBtn}</h2>
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
              <span>{state.inspectLoading ? pm.common.working : pm.split.selectSourceBtn}</span>
            </button>
          </div>
        </div>

        {!info ? (
          <div className="pdf-drop-empty">
            <Scissors size={28} strokeWidth={1.5} aria-hidden="true" />
            <span>{pm.split.emptySource}</span>
            <span className="pdf-muted-note">{pm.common.dropHint}</span>
          </div>
        ) : (
          <div className="pdf-badge-row">
            <span className="badge mono">{pm.common.pagesUnit(info.pageCount)}</span>
            <span className="badge mono">{pm.common.bytesLabel(info.byteLength)}</span>
            <span className="badge">
              {info.hasTextLayer ? pm.common.textLayerBadge : pm.common.scannedBadge}
            </span>
            {info.hasSignatures && (
              <span className="badge badge-partial">{pm.common.signedBadge}</span>
            )}
            {info.hasAcroform && <span className="badge">{pm.common.acroFormBadge}</span>}
          </div>
        )}
      </section>

      {/* Split Rules & Upfront Preview */}
      {info && (
        <section className="pdf-card">
          <div className="pdf-card-head">
            <h2 className="pdf-card-title">{pm.split.modeLabel}</h2>
            <div className="segmented" role="group" aria-label={pm.split.modeLabel}>
              {(
                [
                  { id: "every_page", label: pm.split.modeEveryPage },
                  { id: "every_n_pages", label: pm.split.modeEveryN },
                  { id: "custom_ranges", label: pm.split.modeCustom },
                ] as { id: PdfSplitMode; label: string }[]
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`segmented-btn ${state.mode === opt.id ? "is-selected" : ""}`}
                  aria-pressed={state.mode === opt.id}
                  disabled={state.taskStatus === "running"}
                  onClick={() => updateSplitSession((prev) => ({ ...prev, mode: opt.id }))}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {state.mode === "every_n_pages" && (
            <div className="pdf-path-row">
              <label className="field-label" htmlFor="p08-chunk-size" style={{ margin: 0 }}>
                {pm.split.chunkSizeLabel}
              </label>
              <input
                id="p08-chunk-size"
                type="number"
                min={1}
                max={info.pageCount}
                className="pdf-number-input mono"
                value={state.chunkSize}
                disabled={state.taskStatus === "running"}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10);
                  updateSplitSession((prev) => ({
                    ...prev,
                    chunkSize: Number.isFinite(n) ? n : 1,
                  }));
                }}
              />
            </div>
          )}

          {state.mode === "custom_ranges" && (
            <div>
              <label className="field-label" htmlFor="p08-custom-ranges">
                {pm.split.customRangesLabel}
              </label>
              <textarea
                id="p08-custom-ranges"
                className="pdf-textarea mono"
                value={state.customRanges}
                placeholder={pm.split.customRangesPlaceholder}
                disabled={state.taskStatus === "running"}
                onChange={(e) =>
                  updateSplitSession((prev) => ({ ...prev, customRanges: e.target.value }))
                }
              />
              <span className="pdf-checkbox-hint">{pm.split.customRangesHint}</span>
            </div>
          )}

          <div>
            <label className="field-label" htmlFor="p08-output-dir">
              {pm.split.outputDirLabel}
            </label>
            <div className="pdf-path-row">
              <input
                id="p08-output-dir"
                type="text"
                className="pdf-path-input mono"
                value={state.outputDir}
                placeholder={pm.split.outputDirPlaceholder}
                disabled={state.taskStatus === "running"}
                onChange={(e) =>
                  updateSplitSession((prev) => ({ ...prev, outputDir: e.target.value }))
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

          {/* Upfront Errors & Warnings */}
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

          {/* Live Output File Preview Table */}
          {plan && plan.items.length > 0 && (
            <div>
              <h3 className="pdf-card-title" style={{ marginBottom: "8px" }}>
                {pm.split.planPreviewTitle(plan.outputFileCount, plan.totalOutputPages)}
              </h3>
              <div className="pdf-plan-table-wrap">
                <table className="pdf-plan-table">
                  <thead>
                    <tr>
                      <th>{pm.split.colPart}</th>
                      <th>{pm.split.colFileName}</th>
                      <th>{pm.split.colPages}</th>
                      <th>{pm.split.colCount}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.items.map((item) => (
                      <tr key={item.partIndex}>
                        <td className="mono">{item.partIndex}</td>
                        <td className="mono">
                          {item.fileName}{" "}
                          {item.collisionAdjusted && (
                            <span className="badge badge-partial">{pm.split.collisionTag}</span>
                          )}
                        </td>
                        <td className="mono">{item.rangeLabel}</td>
                        <td className="mono">{item.pageCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
                <button type="button" className="btn" onClick={() => void handleCancel()}>
                  {pm.common.cancel}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!plan?.valid || !state.outputDir.trim()}
                  onClick={() => void handleSplit()}
                >
                  <Scissors size={15} strokeWidth={1.75} aria-hidden="true" />
                  <span>{pm.split.startSplitBtn}</span>
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Results List with One-Click Built-in Preview */}
      {state.lastResult && (
        <section className="pdf-card" data-testid="pdf-split-result">
          <div className={`pdf-note-box ${state.lastResult.cancelled ? "is-warn" : "is-success"}`}>
            <div className="pdf-action-bar">
              <div>
                <strong>
                  <CheckCircle2 size={14} strokeWidth={1.75} aria-hidden="true" />{" "}
                  {pm.split.resultTitle(
                    state.lastResult.files.length,
                    state.lastResult.totalOutputPages,
                    pm.common.bytesLabel(state.lastResult.totalOutputBytes),
                  )}
                </strong>
                {state.lastResult.cancelled && (
                  <div style={{ marginTop: "4px" }}>{pm.split.cancelledNotice}</div>
                )}
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

          <div className="pdf-note-box">
            <strong>{pm.common.structuralSummaryTitle}:</strong>{" "}
            {pm.common.linksSummary(
              state.lastResult.summary.preservedExternalLinks,
              state.lastResult.summary.remappedInternalLinks,
              state.lastResult.summary.droppedDanglingLinks,
            )}
            {" · "}
            {pm.common.bookmarksSummary(
              state.lastResult.summary.remappedBookmarks,
              state.lastResult.summary.droppedDanglingBookmarks,
            )}
          </div>

          <div className="pdf-result-list">
            {state.lastResult.files.map((file) => (
              <div key={file.path} className="pdf-result-row">
                <div className="pdf-result-row-info">
                  <span className="badge mono">#{file.partIndex}</span>
                  <span className="pdf-result-row-name mono" title={file.path}>
                    {file.fileName}
                  </span>
                  <span className="badge mono">{file.rangeLabel}</span>
                  <span className="badge mono">{pm.common.bytesLabel(file.byteLength)}</span>
                </div>
                <button type="button" className="btn" onClick={() => openInPdfReader(file.path)}>
                  <Eye size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{pm.common.openInPreview}</span>
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
