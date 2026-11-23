import { AlertTriangle, CheckCircle2, Eye, FileMinus2, FolderOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nContext";
import { PDF_MESSAGES } from "../../i18n/pdfMessages";
import { usePdfSession } from "../../lib/pdfSessionStore";
import {
  bindDisposableListener,
  cancelBackendTask,
  deletePdfPages,
  formatLocalizedError,
  inspectPdfDocument,
  openLocalDirectory,
  parseBackendError,
  pickSaveFilePath,
  pickSingleFile,
  subscribeFileDrop,
  subscribePdfTaskProgress,
  suggestSafeSiblingPath,
} from "../../lib/tauriBridge";
import { PdfPageGrid, type PdfPageGridItem } from "../pdf-shared/PdfPageGrid";
import { formatCompactPages, parseClientPageRanges } from "../pdf-shared/pageRangeUtils";
import "../pdf-shared/pdfToolCommon.css";

function parentDirFromPath(p: string): string {
  const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return idx > 0 ? p.slice(0, idx) : p;
}

export function PdfDeleteWorkspace() {
  const { locale, t } = useI18n();
  const pm = PDF_MESSAGES[locale];
  const {
    pdfSession,
    updateDeleteSession,
    openInPdfReader,
    pendingToolIntake,
    clearPendingToolIntake,
  } = usePdfSession();
  const state = pdfSession.deletePages;

  const [dropHover, setDropHover] = useState(false);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [overwritePrompt, setOverwritePrompt] = useState(false);
  const lastClickedPageRef = useRef<number | null>(null);

  const loadPdf = useCallback(
    async (path: string) => {
      lastClickedPageRef.current = null;
      setRangeError(null);
      updateDeleteSession((prev) => ({
        ...prev,
        sourcePath: path,
        inspectLoading: true,
        errorMessage: null,
        lastResult: null,
      }));
      try {
        const info = await inspectPdfDocument(path);
        const suggested = await suggestSafeSiblingPath(info.path, "_trimmed", "pdf");
        updateDeleteSession((prev) => ({
          ...prev,
          sourcePath: info.path,
          inspection: info,
          inspectLoading: false,
          deletedPages: [],
          rangeInput: "",
          outputPath: suggested ?? prev.outputPath,
          errorMessage: null,
        }));
      } catch (err) {
        updateDeleteSession((prev) => ({
          ...prev,
          inspection: null,
          inspectLoading: false,
          errorMessage: formatLocalizedError(err, t),
        }));
      }
    },
    [t, updateDeleteSession],
  );

  useEffect(() => {
    if (pendingToolIntake?.toolId === "P10") {
      const p = pendingToolIntake.path;
      clearPendingToolIntake();
      void loadPdf(p);
    }
  }, [pendingToolIntake, clearPendingToolIntake, loadPdf]);

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: setDropHover,
          onDropPaths: (paths) => {
            const pdf = paths.find((p) => p.toLowerCase().endsWith(".pdf")) ?? paths[0];
            if (pdf) void loadPdf(pdf);
          },
        }),
      "p10-file-drop",
    );
  }, [loadPdf]);

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribePdfTaskProgress((ev) => {
          if (ev.toolId !== "P10") return;
          updateDeleteSession((prev) =>
            prev.activeTaskId === ev.taskId ? { ...prev, progress: ev } : prev,
          );
        }),
      "p10-progress",
    );
  }, [updateDeleteSession]);

  const info = state.inspection;

  const gridItems = useMemo<PdfPageGridItem[]>(() => {
    if (!info) return [];
    return info.pages.map((p) => ({
      uid: `p-${p.pageNumber}`,
      sourcePage: p.pageNumber,
      widthPt: p.widthPt,
      heightPt: p.heightPt,
      inherentRotation: p.rotation,
      extraRotationCw: 0,
    }));
  }, [info]);

  const deletedSet = useMemo(() => new Set(state.deletedPages), [state.deletedPages]);
  const selectedUids = useMemo(
    () => new Set(state.deletedPages.map((p) => `p-${p}`)),
    [state.deletedPages],
  );

  const keptPages = useMemo(() => {
    if (!info) return [];
    return info.pages.map((p) => p.pageNumber).filter((p) => !deletedSet.has(p));
  }, [info, deletedSet]);

  const deletingAll = Boolean(info && state.deletedPages.length >= info.pageCount);

  const handleToggleSelect = (uid: string, shiftKey: boolean) => {
    const pageNum = Number.parseInt(uid.replace("p-", ""), 10);
    if (!Number.isFinite(pageNum)) return;

    updateDeleteSession((prev) => {
      const next = new Set(prev.deletedPages);
      if (shiftKey && lastClickedPageRef.current !== null) {
        const [a, b] =
          lastClickedPageRef.current <= pageNum
            ? [lastClickedPageRef.current, pageNum]
            : [pageNum, lastClickedPageRef.current];
        for (let p = a; p <= b; p += 1) {
          next.add(p);
        }
      } else if (next.has(pageNum)) {
        next.delete(pageNum);
      } else {
        next.add(pageNum);
      }
      lastClickedPageRef.current = pageNum;
      return {
        ...prev,
        deletedPages: Array.from(next).sort((x, y) => x - y),
        lastResult: null,
        errorMessage: null,
      };
    });
  };

  const handleApplyRange = () => {
    if (!info) return;
    const parsed = parseClientPageRanges(state.rangeInput, info.pageCount);
    if (!parsed.valid) {
      setRangeError(parsed.error);
      return;
    }
    setRangeError(null);
    updateDeleteSession((prev) => ({
      ...prev,
      deletedPages: parsed.uniqueSorted,
      lastResult: null,
      errorMessage: null,
    }));
  };

  const handleInvert = () => {
    if (!info) return;
    updateDeleteSession((prev) => {
      const curr = new Set(prev.deletedPages);
      const next = info.pages.map((p) => p.pageNumber).filter((p) => !curr.has(p));
      return { ...prev, deletedPages: next, lastResult: null, errorMessage: null };
    });
  };

  const handleSelectSource = async () => {
    const picked = await pickSingleFile({
      title: pm.deletePages.selectSourceBtn,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (picked) await loadPdf(picked);
  };

  const handleChooseOutput = async () => {
    const picked = await pickSaveFilePath({
      title: pm.common.chooseOutputFile,
      defaultPath: state.outputPath || "trimmed.pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (picked) {
      const withExt = picked.toLowerCase().endsWith(".pdf") ? picked : `${picked}.pdf`;
      updateDeleteSession((prev) => ({ ...prev, outputPath: withExt, errorMessage: null }));
    }
  };

  const executeDelete = async (overwrite: boolean) => {
    setOverwritePrompt(false);
    if (!info || deletingAll || state.deletedPages.length === 0 || !state.outputPath.trim()) return;
    const taskId = `p10-${Date.now()}`;
    updateDeleteSession((prev) => ({
      ...prev,
      taskStatus: "running",
      activeTaskId: taskId,
      progress: {
        taskId,
        toolId: "P10",
        current: 0,
        total: keptPages.length,
        percent: 0,
        detail: "",
      },
      errorMessage: null,
      lastResult: null,
    }));

    try {
      const res = await deletePdfPages({
        taskId,
        path: info.path,
        deletePages: state.deletedPages,
        outputPath: state.outputPath.trim(),
        overwrite,
      });
      updateDeleteSession((prev) => ({
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
        updateDeleteSession((prev) => ({
          ...prev,
          taskStatus: "idle",
          activeTaskId: null,
          progress: null,
        }));
        setOverwritePrompt(true);
        return;
      }
      updateDeleteSession((prev) => ({
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
      data-testid="pdf-delete-workspace"
    >
      <div className="pdf-tool-header">
        <p>{pm.deletePages.subtitle}</p>
        <span className="pdf-muted-note">{pm.common.nonDestructiveNote}</span>
      </div>

      {/* Source Card */}
      <section className="pdf-card">
        <div className="pdf-card-head">
          <h2 className="pdf-card-title">
            {info ? info.fileName : pm.deletePages.selectSourceBtn}
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
                {state.inspectLoading ? pm.common.working : pm.deletePages.selectSourceBtn}
              </span>
            </button>
          </div>
        </div>

        {!info ? (
          <div className="pdf-drop-empty">
            <FileMinus2 size={28} strokeWidth={1.5} aria-hidden="true" />
            <span>{pm.deletePages.emptySource}</span>
            <span className="pdf-muted-note">{pm.common.dropHint}</span>
          </div>
        ) : (
          <div className="pdf-badge-row">
            <span className="badge mono">{pm.common.pagesUnit(info.pageCount)}</span>
            <span className="badge mono">{pm.common.bytesLabel(info.byteLength)}</span>
            <span className="badge">
              {pm.deletePages.previewSummary(keptPages.length, state.deletedPages.length)}
            </span>
          </div>
        )}
      </section>

      {/* Range Selector + Thumbnail Grid */}
      {info && (
        <section className="pdf-card">
          <div className="pdf-path-row">
            <input
              type="text"
              className="pdf-path-input mono"
              aria-label={pm.deletePages.rangeInputLabel}
              placeholder={pm.deletePages.rangePlaceholder}
              value={state.rangeInput}
              disabled={state.taskStatus === "running"}
              onChange={(e) => {
                setRangeError(null);
                updateDeleteSession((prev) => ({ ...prev, rangeInput: e.target.value }));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleApplyRange();
                }
              }}
            />
            <button
              type="button"
              className="btn"
              disabled={state.taskStatus === "running" || !state.rangeInput.trim()}
              onClick={handleApplyRange}
            >
              {pm.deletePages.applyRangeBtn}
            </button>
            <button
              type="button"
              className="btn"
              disabled={state.taskStatus === "running"}
              onClick={handleInvert}
            >
              {pm.grid.invertSelection}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={state.taskStatus === "running" || state.deletedPages.length === 0}
              onClick={() => updateDeleteSession((prev) => ({ ...prev, deletedPages: [] }))}
            >
              {pm.grid.clearSelection}
            </button>
          </div>

          {rangeError && (
            <div className="pdf-note-box is-error" role="alert">
              {rangeError}
            </div>
          )}

          {deletingAll && (
            <div className="pdf-note-box is-error" role="alert">
              <AlertTriangle size={14} strokeWidth={1.75} aria-hidden="true" />{" "}
              {pm.deletePages.cannotDeleteAllWarning}
            </div>
          )}

          <div className="pdf-note-box">
            <strong>
              {pm.deletePages.previewSummary(keptPages.length, state.deletedPages.length)}
            </strong>
            {state.deletedPages.length > 0 && (
              <div className="mono" style={{ fontSize: "12px", marginTop: "4px" }}>
                {pm.deletePages.deletedPreviewLabel(formatCompactPages(state.deletedPages))}
              </div>
            )}
            {keptPages.length > 0 && (
              <div className="mono" style={{ fontSize: "12px", marginTop: "2px" }}>
                {pm.deletePages.keptPreviewLabel(formatCompactPages(keptPages))}
              </div>
            )}
          </div>

          <PdfPageGrid
            pdfPath={info.path}
            items={gridItems}
            selectedUids={selectedUids}
            highlightMode="delete"
            disabled={state.taskStatus === "running"}
            labels={pm.grid}
            onToggleSelect={handleToggleSelect}
          />
        </section>
      )}

      {/* Output & Action Card */}
      {info && (
        <section className="pdf-card">
          <div>
            <label className="field-label" htmlFor="p10-output-path">
              {pm.deletePages.outputPathLabel}
            </label>
            <div className="pdf-path-row">
              <input
                id="p10-output-path"
                type="text"
                className="pdf-path-input mono"
                value={state.outputPath}
                disabled={state.taskStatus === "running"}
                onChange={(e) =>
                  updateDeleteSession((prev) => ({ ...prev, outputPath: e.target.value }))
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

          {info.hasSignatures && (
            <div className="pdf-note-box is-warn" role="status">
              <AlertTriangle size={14} strokeWidth={1.75} aria-hidden="true" />{" "}
              {pm.common.signatureNotice}
            </div>
          )}

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
                  onClick={() => void executeDelete(true)}
                >
                  {pm.merge.overwriteConfirm}
                </button>
                <button type="button" className="btn" onClick={() => setOverwritePrompt(false)}>
                  {pm.common.cancel}
                </button>
              </div>
            </div>
          )}

          {state.errorMessage && (
            <div className="pdf-note-box is-error" role="alert">
              {state.errorMessage}
            </div>
          )}

          <div className="pdf-action-bar">
            <span className="pdf-muted-note">
              {state.deletedPages.length === 0
                ? pm.deletePages.selectAtLeastOne
                : pm.deletePages.previewSummary(keptPages.length, state.deletedPages.length)}
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
                  disabled={
                    state.deletedPages.length === 0 || deletingAll || !state.outputPath.trim()
                  }
                  onClick={() => void executeDelete(false)}
                >
                  <FileMinus2 size={15} strokeWidth={1.75} aria-hidden="true" />
                  <span>{pm.deletePages.exportBtn}</span>
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Result Card */}
      {state.lastResult && (
        <section className="pdf-card" data-testid="pdf-delete-result">
          <div className="pdf-note-box is-success">
            <div className="pdf-action-bar">
              <div>
                <strong>
                  <CheckCircle2 size={14} strokeWidth={1.75} aria-hidden="true" />{" "}
                  {pm.deletePages.resultSummary(
                    state.lastResult.deletedPages.length,
                    state.lastResult.keptPages.length,
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
