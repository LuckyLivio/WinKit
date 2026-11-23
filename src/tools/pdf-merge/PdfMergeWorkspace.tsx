import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Combine,
  Eye,
  FilePlus2,
  FolderOpen,
  GripVertical,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nContext";
import { PDF_MESSAGES } from "../../i18n/pdfMessages";
import { usePdfSession, type PdfMergeQueueItem } from "../../lib/pdfSessionStore";
import {
  bindDisposableListener,
  cancelBackendTask,
  formatLocalizedError,
  inspectPdfDocument,
  mergePdfs,
  openLocalDirectory,
  parseBackendError,
  pickMultipleFiles,
  pickSaveFilePath,
  subscribeFileDrop,
  subscribePdfTaskProgress,
  suggestSafeSiblingPath,
} from "../../lib/tauriBridge";
import "../pdf-shared/pdfToolCommon.css";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "heic", "heif"]);

function basenameFromPath(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function parentDirFromPath(p: string): string {
  const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return idx > 0 ? p.slice(0, idx) : p;
}

function detectInputKind(path: string): "pdf" | "image" | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = path.slice(dot + 1).toLowerCase();
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXTS.has(ext)) return "image";
  return null;
}

export function PdfMergeWorkspace() {
  const { locale, t } = useI18n();
  const pm = PDF_MESSAGES[locale];
  const {
    pdfSession,
    updateMergeSession,
    openInPdfReader,
    pendingToolIntake,
    clearPendingToolIntake,
  } = usePdfSession();
  const state = pdfSession.merge;

  const [dropHover, setDropHover] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overwritePrompt, setOverwritePrompt] = useState(false);
  const seqRef = useRef(1);

  const enqueuePaths = useCallback(
    async (paths: string[]) => {
      const supported = paths
        .map((path) => ({ path, kind: detectInputKind(path) }))
        .filter((x): x is { path: string; kind: "pdf" | "image" } => x.kind !== null);
      if (supported.length === 0) return;

      const added: PdfMergeQueueItem[] = supported.map(({ path, kind }) => ({
        id: `merge-item-${Date.now()}-${seqRef.current++}`,
        path,
        fileName: basenameFromPath(path),
        kind,
        status: kind === "pdf" ? "loading" : "ready",
        pageCount: kind === "image" ? 1 : 0,
        byteLength: 0,
        hasSignatures: false,
        hasAcroform: false,
        isLikelyScanned: false,
        warnings: [],
        errorMessage: null,
      }));

      updateMergeSession((prev) => ({
        ...prev,
        items: [...prev.items, ...added],
        errorMessage: null,
        lastResult: null,
      }));

      // Auto-suggest non-overwriting output path based on first source
      if (!state.outputPath && added[0]) {
        try {
          const suggested = await suggestSafeSiblingPath(added[0].path, "_merged", "pdf");
          if (suggested) {
            updateMergeSession((prev) =>
              prev.outputPath ? prev : { ...prev, outputPath: suggested },
            );
          }
        } catch {
          // ignore suggestion errors
        }
      }

      for (const item of added) {
        if (item.kind !== "pdf") continue;
        try {
          const info = await inspectPdfDocument(item.path);
          updateMergeSession((prev) => ({
            ...prev,
            items: prev.items.map((it) =>
              it.id === item.id
                ? {
                    ...it,
                    status: "ready",
                    pageCount: info.pageCount,
                    byteLength: info.byteLength,
                    hasSignatures: info.hasSignatures,
                    hasAcroform: info.hasAcroform,
                    isLikelyScanned: info.isLikelyScanned,
                    warnings: info.warnings,
                    errorMessage: null,
                  }
                : it,
            ),
          }));
        } catch (err) {
          const msg = formatLocalizedError(err, t);
          updateMergeSession((prev) => ({
            ...prev,
            items: prev.items.map((it) =>
              it.id === item.id ? { ...it, status: "error", errorMessage: msg } : it,
            ),
          }));
        }
      }
    },
    [state.outputPath, t, updateMergeSession],
  );

  // Consume cross-tool handoff from C08
  useEffect(() => {
    if (pendingToolIntake?.toolId === "P07") {
      const p = pendingToolIntake.path;
      clearPendingToolIntake();
      void enqueuePaths([p]);
    }
  }, [pendingToolIntake, clearPendingToolIntake, enqueuePaths]);

  // Native drag-and-drop
  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: setDropHover,
          onDropPaths: (paths) => {
            void enqueuePaths(paths);
          },
        }),
      "p07-file-drop",
    );
  }, [enqueuePaths]);

  // Task progress listener
  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribePdfTaskProgress((ev) => {
          if (ev.toolId !== "P07") return;
          updateMergeSession((prev) =>
            prev.activeTaskId === ev.taskId ? { ...prev, progress: ev } : prev,
          );
        }),
      "p07-progress",
    );
  }, [updateMergeSession]);

  const handlePickFiles = async () => {
    const picked = await pickMultipleFiles({
      title: pm.merge.addFilesBtn,
      filters: [
        {
          name: "PDF & Images",
          extensions: ["pdf", "png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "heic", "heif"],
        },
      ],
    });
    if (picked.length > 0) {
      await enqueuePaths(picked);
    }
  };

  const handleChooseOutput = async () => {
    const picked = await pickSaveFilePath({
      title: pm.common.chooseOutputFile,
      defaultPath: state.outputPath || "merged.pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (picked) {
      const withExt = picked.toLowerCase().endsWith(".pdf") ? picked : `${picked}.pdf`;
      updateMergeSession((prev) => ({ ...prev, outputPath: withExt, errorMessage: null }));
    }
  };

  const moveItem = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= state.items.length) return;
    updateMergeSession((prev) => {
      const next = [...prev.items];
      const [moved] = next.splice(index, 1);
      if (moved) next.splice(target, 0, moved);
      return { ...prev, items: next };
    });
  };

  const reorderDrop = (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return;
    updateMergeSession((prev) => {
      const next = [...prev.items];
      const [moved] = next.splice(fromIdx, 1);
      if (moved) next.splice(toIdx, 0, moved);
      return { ...prev, items: next };
    });
  };

  const removeItem = (id: string) => {
    updateMergeSession((prev) => ({
      ...prev,
      items: prev.items.filter((it) => it.id !== id),
    }));
  };

  const readyItems = useMemo(
    () => state.items.filter((it) => it.status === "ready"),
    [state.items],
  );
  const totalPages = useMemo(
    () => readyItems.reduce((sum, it) => sum + it.pageCount, 0),
    [readyItems],
  );
  const hasAnySignatures = useMemo(() => readyItems.some((it) => it.hasSignatures), [readyItems]);
  const hasErrors = useMemo(() => state.items.some((it) => it.status === "error"), [state.items]);
  const hasLoading = useMemo(
    () => state.items.some((it) => it.status === "loading"),
    [state.items],
  );

  const executeMerge = async (overwrite: boolean) => {
    setOverwritePrompt(false);
    if (readyItems.length < 2) {
      updateMergeSession((prev) => ({ ...prev, errorMessage: pm.merge.needTwoFiles }));
      return;
    }
    if (!state.outputPath.trim()) {
      updateMergeSession((prev) => ({ ...prev, errorMessage: pm.merge.needOutputPath }));
      return;
    }

    const taskId = `p07-${Date.now()}`;
    updateMergeSession((prev) => ({
      ...prev,
      taskStatus: "running",
      activeTaskId: taskId,
      progress: {
        taskId,
        toolId: "P07",
        current: 0,
        total: readyItems.length,
        percent: 0,
        detail: "",
      },
      errorMessage: null,
      lastResult: null,
    }));

    try {
      const result = await mergePdfs({
        taskId,
        inputs: readyItems.map((it) => ({ path: it.path, kind: it.kind })),
        outputPath: state.outputPath.trim(),
        addFilenameBookmarks: state.addFilenameBookmarks,
        overwrite,
      });
      updateMergeSession((prev) => ({
        ...prev,
        taskStatus: "idle",
        activeTaskId: null,
        progress: null,
        lastResult: result,
        errorMessage: null,
      }));
    } catch (err) {
      const parsed = parseBackendError(err);
      if (parsed.code === "TARGET_ALREADY_EXISTS" && !overwrite) {
        updateMergeSession((prev) => ({
          ...prev,
          taskStatus: "idle",
          activeTaskId: null,
          progress: null,
        }));
        setOverwritePrompt(true);
        return;
      }
      updateMergeSession((prev) => ({
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

  return (
    <div
      className={`pdf-tool-workspace ${dropHover ? "is-drop-hover" : ""}`}
      data-testid="pdf-merge-workspace"
    >
      <div className="pdf-tool-header">
        <p>{pm.merge.subtitle}</p>
        <span className="pdf-muted-note">{pm.common.nonDestructiveNote}</span>
      </div>

      {/* Input Queue Card */}
      <section className="pdf-card">
        <div className="pdf-card-head">
          <h2 className="pdf-card-title">
            {state.items.length > 0
              ? pm.merge.queueHeader(state.items.length, totalPages)
              : pm.merge.addPdfOrImagesHint}
          </h2>
          <div className="pdf-queue-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={state.taskStatus === "running"}
              onClick={() => void handlePickFiles()}
            >
              <FilePlus2 size={15} strokeWidth={1.75} aria-hidden="true" />
              <span>{pm.merge.addFilesBtn}</span>
            </button>
            {state.items.length > 0 && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={state.taskStatus === "running"}
                onClick={() =>
                  updateMergeSession((prev) => ({
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
            <Combine size={28} strokeWidth={1.5} aria-hidden="true" />
            <span>{pm.merge.emptyQueue}</span>
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
                  if (dragIndex !== null) {
                    reorderDrop(dragIndex, idx);
                  }
                  setDragIndex(null);
                }}
                onDragEnd={() => setDragIndex(null)}
                className={`pdf-queue-row ${dragIndex === idx ? "is-dragging" : ""}`}
              >
                <div className="pdf-queue-row-main">
                  <GripVertical size={15} strokeWidth={1.75} aria-hidden="true" />
                  <span className="pdf-queue-index mono">{idx + 1}</span>
                  <div className="pdf-queue-meta">
                    <span className="pdf-queue-name" title={item.path}>
                      {item.fileName}
                    </span>
                    <div className="pdf-badge-row">
                      <span className="badge mono">
                        {item.kind === "pdf" ? pm.common.pdfBadge : pm.common.imageBadge}
                      </span>
                      {item.status === "ready" && (
                        <span className="badge mono">{pm.common.pagesUnit(item.pageCount)}</span>
                      )}
                      {item.byteLength > 0 && (
                        <span className="badge mono">{pm.common.bytesLabel(item.byteLength)}</span>
                      )}
                      {item.hasSignatures && (
                        <span className="badge badge-partial">{pm.common.signedBadge}</span>
                      )}
                      {item.hasAcroform && <span className="badge">{pm.common.acroFormBadge}</span>}
                      {item.isLikelyScanned && (
                        <span className="badge">{pm.common.scannedBadge}</span>
                      )}
                      {item.status === "loading" && (
                        <span className="badge">{pm.common.working}</span>
                      )}
                      {item.errorMessage && (
                        <span className="badge badge-partial">{item.errorMessage}</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="pdf-queue-actions">
                  {item.kind === "pdf" && item.status === "ready" && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      title={pm.common.openInPreview}
                      aria-label={pm.common.openInPreview}
                      onClick={() => openInPdfReader(item.path)}
                    >
                      <Eye size={15} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  )}
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
                    onClick={() => removeItem(item.id)}
                  >
                    <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Merge Options & Output Card */}
      <section className="pdf-card">
        <h2 className="pdf-card-title">{pm.merge.optionsTitle}</h2>

        <label className="pdf-checkbox-row">
          <input
            type="checkbox"
            checked={state.addFilenameBookmarks}
            disabled={state.taskStatus === "running"}
            onChange={(e) =>
              updateMergeSession((prev) => ({
                ...prev,
                addFilenameBookmarks: e.target.checked,
              }))
            }
          />
          <span>
            {pm.merge.addFilenameBookmarks}
            <span className="pdf-checkbox-hint">{pm.merge.addFilenameBookmarksHint}</span>
          </span>
        </label>

        <div>
          <label className="field-label" htmlFor="p07-output-path">
            {pm.merge.outputPathLabel}
          </label>
          <div className="pdf-path-row">
            <input
              id="p07-output-path"
              type="text"
              className="pdf-path-input mono"
              value={state.outputPath}
              placeholder={pm.merge.outputPathPlaceholder}
              disabled={state.taskStatus === "running"}
              onChange={(e) =>
                updateMergeSession((prev) => ({ ...prev, outputPath: e.target.value }))
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

        <div className="pdf-note-box">{pm.merge.policyNote}</div>

        {hasAnySignatures && (
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
                onClick={() => void executeMerge(true)}
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
          <div className="pdf-muted-note">
            {readyItems.length > 0 && pm.merge.queueHeader(readyItems.length, totalPages)}
          </div>
          <div className="pdf-queue-actions">
            {state.taskStatus === "running" ? (
              <button type="button" className="btn" onClick={() => void handleCancel()}>
                {pm.common.cancel}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  readyItems.length < 2 || hasLoading || hasErrors || !state.outputPath.trim()
                }
                onClick={() => void executeMerge(false)}
              >
                <Combine size={15} strokeWidth={1.75} aria-hidden="true" />
                <span>{pm.merge.startMergeBtn}</span>
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Result Card */}
      {state.lastResult && (
        <section className="pdf-card" data-testid="pdf-merge-result">
          <div className="pdf-note-box is-success">
            <div className="pdf-action-bar">
              <div>
                <strong>
                  <CheckCircle2 size={14} strokeWidth={1.75} aria-hidden="true" />{" "}
                  {pm.merge.resultTitle}:{" "}
                </strong>
                <span>
                  {pm.merge.resultSummary(
                    state.lastResult.sourceCount,
                    state.lastResult.totalPages,
                    pm.common.bytesLabel(state.lastResult.byteLength),
                  )}
                </span>
                {state.lastResult.imageSourceCount > 0 && (
                  <div className="pdf-muted-note" style={{ marginTop: "4px" }}>
                    {pm.merge.mixedBreakdown(
                      state.lastResult.pdfSourceCount,
                      state.lastResult.imageSourceCount,
                    )}
                  </div>
                )}
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

          {state.lastResult.warnings.map((w, idx) => (
            <div key={idx} className="pdf-note-box is-warn">
              {w}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
