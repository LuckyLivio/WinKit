import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  FolderOpen,
  LayoutGrid,
  Redo2,
  RotateCcw,
  RotateCw,
  Trash2,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nContext";
import { PDF_MESSAGES } from "../../i18n/pdfMessages";
import { usePdfSession } from "../../lib/pdfSessionStore";
import {
  bindDisposableListener,
  cancelBackendTask,
  formatLocalizedError,
  inspectPdfDocument,
  openLocalDirectory,
  organizePdf,
  parseBackendError,
  pickSaveFilePath,
  pickSingleFile,
  subscribeFileDrop,
  subscribePdfTaskProgress,
  suggestSafeSiblingPath,
} from "../../lib/tauriBridge";
import { PdfPageGrid, type PdfPageGridItem } from "../pdf-shared/PdfPageGrid";
import "../pdf-shared/pdfToolCommon.css";

function parentDirFromPath(p: string): string {
  const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return idx > 0 ? p.slice(0, idx) : p;
}

function buildInitialItems(
  pages: { pageNumber: number; widthPt: number; heightPt: number; rotation: number }[],
): PdfPageGridItem[] {
  return pages.map((p) => ({
    uid: `page-${p.pageNumber}`,
    sourcePage: p.pageNumber,
    widthPt: p.widthPt,
    heightPt: p.heightPt,
    inherentRotation: p.rotation,
    extraRotationCw: 0,
  }));
}

export function PdfOrganizeWorkspace() {
  const { locale, t } = useI18n();
  const pm = PDF_MESSAGES[locale];
  const {
    pdfSession,
    updateOrganizeSession,
    openInPdfReader,
    pendingToolIntake,
    clearPendingToolIntake,
  } = usePdfSession();
  const state = pdfSession.organize;

  const [dropHover, setDropHover] = useState(false);
  const [selectedUids, setSelectedUids] = useState<Set<string>>(() => new Set());
  const [overwritePrompt, setOverwritePrompt] = useState(false);
  const lastClickedUidRef = useRef<string | null>(null);

  const loadPdf = useCallback(
    async (path: string) => {
      setSelectedUids(new Set());
      lastClickedUidRef.current = null;
      updateOrganizeSession((prev) => ({
        ...prev,
        sourcePath: path,
        inspectLoading: true,
        errorMessage: null,
        lastResult: null,
      }));
      try {
        const info = await inspectPdfDocument(path);
        const suggested = await suggestSafeSiblingPath(info.path, "_organized", "pdf");
        updateOrganizeSession((prev) => ({
          ...prev,
          sourcePath: info.path,
          inspection: info,
          inspectLoading: false,
          items: buildInitialItems(info.pages),
          undoStack: [],
          redoStack: [],
          outputPath: suggested ?? prev.outputPath,
          errorMessage: null,
        }));
      } catch (err) {
        updateOrganizeSession((prev) => ({
          ...prev,
          inspection: null,
          items: [],
          inspectLoading: false,
          errorMessage: formatLocalizedError(err, t),
        }));
      }
    },
    [t, updateOrganizeSession],
  );

  useEffect(() => {
    if (pendingToolIntake?.toolId === "P09") {
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
      "p09-file-drop",
    );
  }, [loadPdf]);

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribePdfTaskProgress((ev) => {
          if (ev.toolId !== "P09") return;
          updateOrganizeSession((prev) =>
            prev.activeTaskId === ev.taskId ? { ...prev, progress: ev } : prev,
          );
        }),
      "p09-progress",
    );
  }, [updateOrganizeSession]);

  const commitItems = useCallback(
    (mutator: (curr: PdfPageGridItem[]) => PdfPageGridItem[]) => {
      updateOrganizeSession((prev) => {
        const nextItems = mutator(prev.items);
        return {
          ...prev,
          undoStack: [...prev.undoStack.slice(-29), prev.items],
          redoStack: [],
          items: nextItems,
          lastResult: null,
          errorMessage: null,
        };
      });
    },
    [updateOrganizeSession],
  );

  const handleToggleSelect = (uid: string, shiftKey: boolean) => {
    setSelectedUids((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastClickedUidRef.current) {
        const a = state.items.findIndex((i) => i.uid === lastClickedUidRef.current);
        const b = state.items.findIndex((i) => i.uid === uid);
        if (a >= 0 && b >= 0) {
          const [start, end] = a <= b ? [a, b] : [b, a];
          for (let i = start; i <= end; i += 1) {
            next.add(state.items[i]!.uid);
          }
          return next;
        }
      }
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      lastClickedUidRef.current = uid;
      return next;
    });
  };

  const handleReorder = (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0 || toIdx >= state.items.length) return;
    commitItems((curr) => {
      const next = [...curr];
      const [moved] = next.splice(fromIdx, 1);
      if (moved) next.splice(toIdx, 0, moved);
      return next;
    });
  };

  const handleRotatePage = (uid: string, deltaCw: number) => {
    commitItems((curr) =>
      curr.map((it) =>
        it.uid === uid ? { ...it, extraRotationCw: (it.extraRotationCw + deltaCw) % 360 } : it,
      ),
    );
  };

  const handleRotateSelected = (deltaCw: number) => {
    if (selectedUids.size === 0) return;
    commitItems((curr) =>
      curr.map((it) =>
        selectedUids.has(it.uid)
          ? { ...it, extraRotationCw: (it.extraRotationCw + deltaCw) % 360 }
          : it,
      ),
    );
  };

  const handleDeletePage = (uid: string) => {
    if (state.items.length <= 1) {
      updateOrganizeSession((prev) => ({ ...prev, errorMessage: pm.organize.cannotDeleteAll }));
      return;
    }
    setSelectedUids((prev) => {
      const next = new Set(prev);
      next.delete(uid);
      return next;
    });
    commitItems((curr) => curr.filter((it) => it.uid !== uid));
  };

  const handleDeleteSelected = () => {
    if (selectedUids.size === 0) return;
    const remaining = state.items.filter((it) => !selectedUids.has(it.uid));
    if (remaining.length === 0) {
      updateOrganizeSession((prev) => ({ ...prev, errorMessage: pm.organize.cannotDeleteAll }));
      return;
    }
    setSelectedUids(new Set());
    commitItems(() => remaining);
  };

  const handleUndo = () => {
    updateOrganizeSession((prev) => {
      if (prev.undoStack.length === 0) return prev;
      const previous = prev.undoStack[prev.undoStack.length - 1]!;
      return {
        ...prev,
        items: previous,
        undoStack: prev.undoStack.slice(0, -1),
        redoStack: [...prev.redoStack, prev.items],
        errorMessage: null,
      };
    });
  };

  const handleRedo = () => {
    updateOrganizeSession((prev) => {
      if (prev.redoStack.length === 0) return prev;
      const next = prev.redoStack[prev.redoStack.length - 1]!;
      return {
        ...prev,
        items: next,
        undoStack: [...prev.undoStack, prev.items],
        redoStack: prev.redoStack.slice(0, -1),
        errorMessage: null,
      };
    });
  };

  const handleReset = () => {
    if (!state.inspection) return;
    setSelectedUids(new Set());
    commitItems(() => buildInitialItems(state.inspection!.pages));
  };

  const handleSelectSource = async () => {
    const picked = await pickSingleFile({
      title: pm.organize.selectSourceBtn,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (picked) await loadPdf(picked);
  };

  const handleChooseOutput = async () => {
    const picked = await pickSaveFilePath({
      title: pm.common.chooseOutputFile,
      defaultPath: state.outputPath || "organized.pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (picked) {
      const withExt = picked.toLowerCase().endsWith(".pdf") ? picked : `${picked}.pdf`;
      updateOrganizeSession((prev) => ({ ...prev, outputPath: withExt, errorMessage: null }));
    }
  };

  const executeExport = async (overwrite: boolean) => {
    setOverwritePrompt(false);
    if (!state.inspection || state.items.length === 0 || !state.outputPath.trim()) return;
    const taskId = `p09-${Date.now()}`;
    updateOrganizeSession((prev) => ({
      ...prev,
      taskStatus: "running",
      activeTaskId: taskId,
      progress: {
        taskId,
        toolId: "P09",
        current: 0,
        total: state.items.length,
        percent: 0,
        detail: "",
      },
      errorMessage: null,
      lastResult: null,
    }));

    try {
      const res = await organizePdf({
        taskId,
        path: state.inspection.path,
        pages: state.items.map((it) => ({
          sourcePage: it.sourcePage,
          extraRotationCw: it.extraRotationCw,
        })),
        outputPath: state.outputPath.trim(),
        overwrite,
      });
      updateOrganizeSession((prev) => ({
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
        updateOrganizeSession((prev) => ({
          ...prev,
          taskStatus: "idle",
          activeTaskId: null,
          progress: null,
        }));
        setOverwritePrompt(true);
        return;
      }
      updateOrganizeSession((prev) => ({
        ...prev,
        taskStatus: "idle",
        activeTaskId: null,
        progress: null,
        errorMessage: formatLocalizedError(err, t),
      }));
    }
  };

  const info = state.inspection;
  const stats = useMemo(() => {
    const total = info?.pageCount ?? 0;
    const kept = state.items.length;
    const deleted = Math.max(0, total - kept);
    const rotated = state.items.filter((it) => it.extraRotationCw !== 0).length;
    return { total, kept, deleted, rotated };
  }, [info, state.items]);

  return (
    <div
      className={`pdf-tool-workspace ${dropHover ? "is-drop-hover" : ""}`}
      data-testid="pdf-organize-workspace"
    >
      <div className="pdf-tool-header">
        <p>{pm.organize.subtitle}</p>
        <span className="pdf-muted-note">{pm.common.nonDestructiveNote}</span>
      </div>

      {/* Source Header Card */}
      <section className="pdf-card">
        <div className="pdf-card-head">
          <h2 className="pdf-card-title">{info ? info.fileName : pm.organize.selectSourceBtn}</h2>
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
              <span>{state.inspectLoading ? pm.common.working : pm.organize.selectSourceBtn}</span>
            </button>
          </div>
        </div>

        {!info ? (
          <div className="pdf-drop-empty">
            <LayoutGrid size={28} strokeWidth={1.5} aria-hidden="true" />
            <span>{pm.organize.emptySource}</span>
            <span className="pdf-muted-note">{pm.common.dropHint}</span>
          </div>
        ) : (
          <div className="pdf-badge-row">
            <span className="badge mono">
              {pm.organize.summaryLine(stats.total, stats.kept, stats.deleted, stats.rotated)}
            </span>
            {info.hasSignatures && (
              <span className="badge badge-partial">{pm.common.signedBadge}</span>
            )}
            {info.hasAcroform && <span className="badge">{pm.common.acroFormBadge}</span>}
          </div>
        )}
      </section>

      {/* Page Grid & Editing Toolbar */}
      {info && (
        <section className="pdf-card">
          <div className="pdf-card-head">
            <div className="pdf-queue-actions" style={{ flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn"
                disabled={state.taskStatus === "running"}
                onClick={() => setSelectedUids(new Set(state.items.map((i) => i.uid)))}
              >
                {pm.grid.selectAll}
              </button>
              <button
                type="button"
                className="btn"
                disabled={state.taskStatus === "running" || selectedUids.size === 0}
                onClick={() => setSelectedUids(new Set())}
              >
                {pm.grid.clearSelection}
              </button>
              <button
                type="button"
                className="btn"
                disabled={state.taskStatus === "running"}
                onClick={() =>
                  setSelectedUids(
                    new Set(state.items.filter((i) => !selectedUids.has(i.uid)).map((i) => i.uid)),
                  )
                }
              >
                {pm.grid.invertSelection}
              </button>

              <button
                type="button"
                className="btn"
                disabled={state.taskStatus === "running" || selectedUids.size === 0}
                onClick={() => handleRotateSelected(90)}
              >
                <RotateCw size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{pm.organize.rotateSelected90}</span>
              </button>
              <button
                type="button"
                className="btn"
                disabled={state.taskStatus === "running" || selectedUids.size === 0}
                onClick={() => handleRotateSelected(180)}
              >
                <span>{pm.organize.rotateSelected180}</span>
              </button>
              <button
                type="button"
                className="btn"
                disabled={state.taskStatus === "running" || selectedUids.size === 0}
                onClick={() => handleRotateSelected(270)}
              >
                <RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{pm.organize.rotateSelected270}</span>
              </button>
              <button
                type="button"
                className="btn"
                disabled={state.taskStatus === "running" || selectedUids.size === 0}
                onClick={handleDeleteSelected}
              >
                <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{pm.organize.deleteSelected}</span>
              </button>
            </div>

            <div className="pdf-queue-actions">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={state.undoStack.length === 0 || state.taskStatus === "running"}
                onClick={handleUndo}
              >
                <Undo2 size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{pm.grid.undo}</span>
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={state.redoStack.length === 0 || state.taskStatus === "running"}
                onClick={handleRedo}
              >
                <Redo2 size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{pm.grid.redo}</span>
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={state.taskStatus === "running"}
                onClick={handleReset}
              >
                {pm.grid.reset}
              </button>
            </div>
          </div>

          <PdfPageGrid
            pdfPath={info.path}
            items={state.items}
            selectedUids={selectedUids}
            highlightMode="select"
            draggable
            showBeforeAfterOrder
            showPageControls
            disabled={state.taskStatus === "running"}
            labels={pm.grid}
            onToggleSelect={handleToggleSelect}
            onReorder={handleReorder}
            onRotatePage={handleRotatePage}
            onDeletePage={handleDeletePage}
          />
        </section>
      )}

      {/* Export Controls */}
      {info && (
        <section className="pdf-card">
          <div>
            <label className="field-label" htmlFor="p09-output-path">
              {pm.organize.outputPathLabel}
            </label>
            <div className="pdf-path-row">
              <input
                id="p09-output-path"
                type="text"
                className="pdf-path-input mono"
                value={state.outputPath}
                placeholder={pm.organize.outputPathPlaceholder}
                disabled={state.taskStatus === "running"}
                onChange={(e) =>
                  updateOrganizeSession((prev) => ({ ...prev, outputPath: e.target.value }))
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
                  onClick={() => void executeExport(true)}
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
              {selectedUids.size > 0
                ? pm.grid.selectedCount(selectedUids.size)
                : pm.common.nonDestructiveNote}
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
                  disabled={state.items.length === 0 || !state.outputPath.trim()}
                  onClick={() => void executeExport(false)}
                >
                  <span>{pm.organize.exportBtn}</span>
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Result Card */}
      {state.lastResult && (
        <section className="pdf-card" data-testid="pdf-organize-result">
          <div className="pdf-note-box is-success">
            <div className="pdf-action-bar">
              <div>
                <strong>
                  <CheckCircle2 size={14} strokeWidth={1.75} aria-hidden="true" />{" "}
                  {pm.organize.resultSummary(
                    state.lastResult.outputPageCount,
                    pm.common.bytesLabel(state.lastResult.byteLength),
                    state.lastResult.rotatedPages,
                    state.lastResult.deletedPages,
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
        </section>
      )}
    </div>
  );
}
