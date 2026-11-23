import { AlertTriangle, CheckCircle2, Eye, FileOutput, FolderOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nContext";
import { PDF_MESSAGES } from "../../i18n/pdfMessages";
import { usePdfSession } from "../../lib/pdfSessionStore";
import {
  bindDisposableListener,
  cancelBackendTask,
  extractPdfPages,
  formatLocalizedError,
  inspectPdfDocument,
  openLocalDirectory,
  parseBackendError,
  pickSaveFilePath,
  pickSingleDirectory,
  pickSingleFile,
  subscribeFileDrop,
  subscribePdfTaskProgress,
  suggestSafeSiblingPath,
  type PdfExtractMode,
} from "../../lib/tauriBridge";
import { PdfPageGrid, type PdfPageGridItem } from "../pdf-shared/PdfPageGrid";
import { formatCompactPages, parseClientPageRanges } from "../pdf-shared/pageRangeUtils";
import "../pdf-shared/pdfToolCommon.css";

function parentDirFromPath(p: string): string {
  const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return idx > 0 ? p.slice(0, idx) : p;
}

export function PdfExtractWorkspace() {
  const { locale, t } = useI18n();
  const pm = PDF_MESSAGES[locale];
  const {
    pdfSession,
    updateExtractSession,
    openInPdfReader,
    pendingToolIntake,
    clearPendingToolIntake,
  } = usePdfSession();
  const state = pdfSession.extract;

  const [dropHover, setDropHover] = useState(false);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [overwritePrompt, setOverwritePrompt] = useState(false);
  const lastClickedPageRef = useRef<number | null>(null);

  const loadPdf = useCallback(
    async (path: string) => {
      lastClickedPageRef.current = null;
      setRangeError(null);
      updateExtractSession((prev) => ({
        ...prev,
        sourcePath: path,
        inspectLoading: true,
        errorMessage: null,
        lastResult: null,
      }));
      try {
        const info = await inspectPdfDocument(path);
        const suggested = await suggestSafeSiblingPath(info.path, "_extracted", "pdf");
        updateExtractSession((prev) => ({
          ...prev,
          sourcePath: info.path,
          inspection: info,
          inspectLoading: false,
          selectedPages: [],
          rangeInput: "",
          outputPath: suggested ?? prev.outputPath,
          outputDir: prev.outputDir || parentDirFromPath(info.path),
          errorMessage: null,
        }));
      } catch (err) {
        updateExtractSession((prev) => ({
          ...prev,
          inspection: null,
          inspectLoading: false,
          errorMessage: formatLocalizedError(err, t),
        }));
      }
    },
    [t, updateExtractSession],
  );

  useEffect(() => {
    if (pendingToolIntake?.toolId === "P11") {
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
      "p11-file-drop",
    );
  }, [loadPdf]);

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribePdfTaskProgress((ev) => {
          if (ev.toolId !== "P11") return;
          updateExtractSession((prev) =>
            prev.activeTaskId === ev.taskId ? { ...prev, progress: ev } : prev,
          );
        }),
      "p11-progress",
    );
  }, [updateExtractSession]);

  const info = state.inspection;

  const gridItems = useMemo<PdfPageGridItem[]>(() => {
    if (!info) return [];
    return info.pages.map((p) => ({
      uid: `e-${p.pageNumber}`,
      sourcePage: p.pageNumber,
      widthPt: p.widthPt,
      heightPt: p.heightPt,
      inherentRotation: p.rotation,
      extraRotationCw: 0,
    }));
  }, [info]);

  const selectedUids = useMemo(
    () => new Set(state.selectedPages.map((p) => `e-${p}`)),
    [state.selectedPages],
  );

  const effectivePages = useMemo(() => {
    if (!state.dedupeAndSort) return state.selectedPages;
    return Array.from(new Set(state.selectedPages)).sort((a, b) => a - b);
  }, [state.selectedPages, state.dedupeAndSort]);

  const handleToggleSelect = (uid: string, shiftKey: boolean) => {
    const pageNum = Number.parseInt(uid.replace("e-", ""), 10);
    if (!Number.isFinite(pageNum)) return;

    updateExtractSession((prev) => {
      const next = new Set(prev.selectedPages);
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
        selectedPages: Array.from(next).sort((x, y) => x - y),
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
    updateExtractSession((prev) => ({
      ...prev,
      selectedPages: prev.dedupeAndSort ? parsed.uniqueSorted : parsed.pages,
      lastResult: null,
      errorMessage: null,
    }));
  };

  const handleSelectSource = async () => {
    const picked = await pickSingleFile({
      title: pm.extract.selectSourceBtn,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (picked) await loadPdf(picked);
  };

  const handleChooseOutputFile = async () => {
    const picked = await pickSaveFilePath({
      title: pm.common.chooseOutputFile,
      defaultPath: state.outputPath || "extracted.pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (picked) {
      const withExt = picked.toLowerCase().endsWith(".pdf") ? picked : `${picked}.pdf`;
      updateExtractSession((prev) => ({ ...prev, outputPath: withExt, errorMessage: null }));
    }
  };

  const handleChooseOutputDir = async () => {
    const dir = await pickSingleDirectory({ title: pm.common.chooseOutputFolder });
    if (dir) {
      updateExtractSession((prev) => ({ ...prev, outputDir: dir, errorMessage: null }));
    }
  };

  const executeExtract = async (overwrite: boolean) => {
    setOverwritePrompt(false);
    if (!info || effectivePages.length === 0) return;
    if (state.mode === "single_pdf" && !state.outputPath.trim()) return;
    if (state.mode === "per_page_pdfs" && !state.outputDir.trim()) return;

    const taskId = `p11-${Date.now()}`;
    updateExtractSession((prev) => ({
      ...prev,
      taskStatus: "running",
      activeTaskId: taskId,
      progress: {
        taskId,
        toolId: "P11",
        current: 0,
        total: effectivePages.length,
        percent: 0,
        detail: "",
      },
      errorMessage: null,
      lastResult: null,
    }));

    try {
      const res = await extractPdfPages({
        taskId,
        path: info.path,
        pages: state.selectedPages,
        mode: state.mode,
        dedupeAndSort: state.dedupeAndSort,
        outputPath: state.mode === "single_pdf" ? state.outputPath.trim() : undefined,
        outputDir: state.mode === "per_page_pdfs" ? state.outputDir.trim() : undefined,
        overwrite,
      });
      updateExtractSession((prev) => ({
        ...prev,
        taskStatus: "idle",
        activeTaskId: null,
        progress: null,
        lastResult: res,
        errorMessage: null,
      }));
    } catch (err) {
      const parsed = parseBackendError(err);
      if (parsed.code === "TARGET_ALREADY_EXISTS" && state.mode === "single_pdf" && !overwrite) {
        updateExtractSession((prev) => ({
          ...prev,
          taskStatus: "idle",
          activeTaskId: null,
          progress: null,
        }));
        setOverwritePrompt(true);
        return;
      }
      updateExtractSession((prev) => ({
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
      data-testid="pdf-extract-workspace"
    >
      <div className="pdf-tool-header">
        <p>{pm.extract.subtitle}</p>
        <span className="pdf-muted-note">{pm.common.nonDestructiveNote}</span>
      </div>

      {/* Source Card */}
      <section className="pdf-card">
        <div className="pdf-card-head">
          <h2 className="pdf-card-title">{info ? info.fileName : pm.extract.selectSourceBtn}</h2>
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
              <span>{state.inspectLoading ? pm.common.working : pm.extract.selectSourceBtn}</span>
            </button>
          </div>
        </div>

        {!info ? (
          <div className="pdf-drop-empty">
            <FileOutput size={28} strokeWidth={1.5} aria-hidden="true" />
            <span>{pm.extract.emptySource}</span>
            <span className="pdf-muted-note">{pm.common.dropHint}</span>
          </div>
        ) : (
          <div className="pdf-badge-row">
            <span className="badge mono">{pm.common.pagesUnit(info.pageCount)}</span>
            <span className="badge mono">{pm.common.bytesLabel(info.byteLength)}</span>
            <span className="badge">{pm.grid.selectedCount(effectivePages.length)}</span>
          </div>
        )}
      </section>

      {/* Range & Selection Grid */}
      {info && (
        <section className="pdf-card">
          <div className="pdf-path-row">
            <input
              type="text"
              className="pdf-path-input mono"
              aria-label={pm.extract.rangeInputLabel}
              placeholder={pm.extract.rangePlaceholder}
              value={state.rangeInput}
              disabled={state.taskStatus === "running"}
              onChange={(e) => {
                setRangeError(null);
                updateExtractSession((prev) => ({ ...prev, rangeInput: e.target.value }));
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
              {pm.extract.applyRangeBtn}
            </button>
            <button
              type="button"
              className="btn"
              disabled={state.taskStatus === "running"}
              onClick={() =>
                updateExtractSession((prev) => ({
                  ...prev,
                  selectedPages: info.pages.map((p) => p.pageNumber).filter((p) => p % 2 === 1),
                }))
              }
            >
              {pm.extract.selectOdd}
            </button>
            <button
              type="button"
              className="btn"
              disabled={state.taskStatus === "running"}
              onClick={() =>
                updateExtractSession((prev) => ({
                  ...prev,
                  selectedPages: info.pages.map((p) => p.pageNumber).filter((p) => p % 2 === 0),
                }))
              }
            >
              {pm.extract.selectEven}
            </button>
            <button
              type="button"
              className="btn"
              disabled={state.taskStatus === "running"}
              onClick={() =>
                updateExtractSession((prev) => {
                  const curr = new Set(prev.selectedPages);
                  return {
                    ...prev,
                    selectedPages: info.pages.map((p) => p.pageNumber).filter((p) => !curr.has(p)),
                  };
                })
              }
            >
              {pm.grid.invertSelection}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={state.taskStatus === "running" || state.selectedPages.length === 0}
              onClick={() => updateExtractSession((prev) => ({ ...prev, selectedPages: [] }))}
            >
              {pm.grid.clearSelection}
            </button>
          </div>

          {rangeError && (
            <div className="pdf-note-box is-error" role="alert">
              {rangeError}
            </div>
          )}

          {effectivePages.length > 0 && (
            <div className="pdf-note-box mono" style={{ fontSize: "12.5px" }}>
              {pm.extract.selectedPreview(
                effectivePages.length,
                formatCompactPages(effectivePages),
              )}
            </div>
          )}

          <PdfPageGrid
            pdfPath={info.path}
            items={gridItems}
            selectedUids={selectedUids}
            highlightMode="select"
            disabled={state.taskStatus === "running"}
            labels={pm.grid}
            onToggleSelect={handleToggleSelect}
          />
        </section>
      )}

      {/* Export Mode & Output */}
      {info && (
        <section className="pdf-card">
          <div className="pdf-card-head">
            <h2 className="pdf-card-title">{pm.extract.modeLabel}</h2>
            <div className="segmented" role="group" aria-label={pm.extract.modeLabel}>
              {(
                [
                  { id: "single_pdf", label: pm.extract.modeSingle },
                  { id: "per_page_pdfs", label: pm.extract.modePerPage },
                ] as { id: PdfExtractMode; label: string }[]
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`segmented-btn ${state.mode === opt.id ? "is-selected" : ""}`}
                  aria-pressed={state.mode === opt.id}
                  disabled={state.taskStatus === "running"}
                  onClick={() => updateExtractSession((prev) => ({ ...prev, mode: opt.id }))}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <label className="pdf-checkbox-row">
            <input
              type="checkbox"
              checked={state.dedupeAndSort}
              disabled={state.taskStatus === "running"}
              onChange={(e) =>
                updateExtractSession((prev) => ({ ...prev, dedupeAndSort: e.target.checked }))
              }
            />
            <span>
              {pm.extract.dedupeAndSortLabel}
              <span className="pdf-checkbox-hint">{pm.extract.dedupeAndSortHint}</span>
            </span>
          </label>

          {state.mode === "single_pdf" ? (
            <div>
              <label className="field-label" htmlFor="p11-output-path">
                {pm.extract.outputPathLabel}
              </label>
              <div className="pdf-path-row">
                <input
                  id="p11-output-path"
                  type="text"
                  className="pdf-path-input mono"
                  value={state.outputPath}
                  disabled={state.taskStatus === "running"}
                  onChange={(e) =>
                    updateExtractSession((prev) => ({ ...prev, outputPath: e.target.value }))
                  }
                />
                <button
                  type="button"
                  className="btn"
                  disabled={state.taskStatus === "running"}
                  onClick={() => void handleChooseOutputFile()}
                >
                  <FolderOpen size={15} strokeWidth={1.75} aria-hidden="true" />
                  <span>{pm.common.chooseOutputFile}</span>
                </button>
              </div>
            </div>
          ) : (
            <div>
              <label className="field-label" htmlFor="p11-output-dir">
                {pm.extract.outputDirLabel}
              </label>
              <div className="pdf-path-row">
                <input
                  id="p11-output-dir"
                  type="text"
                  className="pdf-path-input mono"
                  value={state.outputDir}
                  disabled={state.taskStatus === "running"}
                  onChange={(e) =>
                    updateExtractSession((prev) => ({ ...prev, outputDir: e.target.value }))
                  }
                />
                <button
                  type="button"
                  className="btn"
                  disabled={state.taskStatus === "running"}
                  onClick={() => void handleChooseOutputDir()}
                >
                  <FolderOpen size={15} strokeWidth={1.75} aria-hidden="true" />
                  <span>{pm.common.chooseOutputFolder}</span>
                </button>
              </div>
            </div>
          )}

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
                  onClick={() => void executeExtract(true)}
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
            <span className="pdf-muted-note">{pm.grid.selectedCount(effectivePages.length)}</span>
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
                    effectivePages.length === 0 ||
                    (state.mode === "single_pdf"
                      ? !state.outputPath.trim()
                      : !state.outputDir.trim())
                  }
                  onClick={() => void executeExtract(false)}
                >
                  <FileOutput size={15} strokeWidth={1.75} aria-hidden="true" />
                  <span>{pm.extract.exportBtn}</span>
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Result Card */}
      {state.lastResult && (
        <section className="pdf-card" data-testid="pdf-extract-result">
          <div className="pdf-note-box is-success">
            <div className="pdf-action-bar">
              <div>
                <strong>
                  <CheckCircle2 size={14} strokeWidth={1.75} aria-hidden="true" />{" "}
                  {pm.extract.resultSummary(
                    state.lastResult.files.length,
                    state.lastResult.extractedPages.length,
                    pm.common.bytesLabel(state.lastResult.totalOutputBytes),
                  )}
                </strong>
                {state.lastResult.duplicatePagesRemoved > 0 && (
                  <div className="pdf-muted-note" style={{ marginTop: "4px" }}>
                    {pm.extract.duplicatesRemovedNote(state.lastResult.duplicatePagesRemoved)}
                  </div>
                )}
              </div>
              {state.lastResult.files[0] && (
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    void openLocalDirectory(parentDirFromPath(state.lastResult!.files[0]!.path))
                  }
                >
                  <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{pm.common.openFolder}</span>
                </button>
              )}
            </div>
          </div>

          <div className="pdf-result-list">
            {state.lastResult.files.map((file) => (
              <div key={file.path} className="pdf-result-row">
                <div className="pdf-result-row-info">
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
