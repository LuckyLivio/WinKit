import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nContext";
import type { Locale, Messages } from "../../i18n/messages";
import { useSessionStore } from "../../lib/sessionStore";
import {
  bindDisposableListener,
  executeBatchRename,
  formatLocalizedError,
  getBatchRenameUndoStatus,
  inspectBatchRenameSources,
  parseBackendError,
  pickMultipleDirectories,
  pickMultipleFiles,
  subscribeFileDrop,
  undoLastBatchRename,
  type BatchRenameUndoStatus,
} from "../../lib/tauriBridge";
import {
  computeBatchRenamePreview,
  MAX_BATCH_RENAME_FILES,
  RENAME_PREVIEW_PAGE_SIZE,
  type BatchRenameRowStatus,
} from "./batchRenameEngine";
import { RenameRules } from "./RenameRules";
import "./batchRenameWorkspace.css";

const workspaceCopy = {
  "zh-CN": {
    addFilesBtn: "选择文件",
    addFolderBtn: "选择文件夹",
    refreshBtn: "刷新目录状态",
    clearBtn: "清空列表",
    undoBtn: (count: number) => (count > 0 ? `撤销上一批 (${count})` : "撤销上一批"),
    executeBtn: (count: number) => (count > 0 ? `执行重命名 (${count})` : "执行重命名"),
    pickFilesTitle: "选择要批量重命名的文件",
    pickFolderTitle: "选择要载入直属文件的文件夹",
    emptyTitle: "选择或拖入要重命名的文件与文件夹",
    emptyHint: `支持从资源管理器一次拖入多个文件或文件夹（载入目录内直属普通文件，单批上限 ${MAX_BATCH_RENAME_FILES} 项），实时全量预览新名称与冲突，并在执行后支持一键撤销最近批次。`,
    totalBadge: (n: number) => `共 ${n} 项`,
    actionableBadge: (n: number) => `待改名 ${n}`,
    caseOnlyBadge: (n: number) => `仅大小写 ${n}`,
    unchangedBadge: (n: number) => `未变化 ${n}`,
    issueBadge: (n: number) => `冲突/无效 ${n}`,
    filterAll: (n: number) => `全部 (${n})`,
    filterChanged: (n: number) => `待改名 (${n})`,
    filterIssues: (n: number) => `冲突与无效 (${n})`,
    colIndex: "#",
    colOriginal: "原文件名与目录",
    colPreview: "预览新文件名",
    colSize: "大小",
    colStatus: "检查结果",
    colActions: "操作",
    removeRowAria: (name: string) => `从批次移除 ${name}`,
    removeRowLabel: "移除",
    statusLabels: {
      ready: "待重命名",
      case_only: "仅改大小写",
      unchanged: "未变化",
      invalid_name: "文件名无效",
      conflict_in_batch: "批内重名冲突",
      conflict_existing: "目标已存在",
    } satisfies Record<BatchRenameRowStatus, string>,
    noFilteredRows: "当前筛选条件下没有匹配的文件。",
    pageSummary: (start: number, end: number, total: number) =>
      `显示第 ${start}–${end} 项，共 ${total} 项`,
    prevPage: "上一页",
    nextPage: "下一页",
    skippedSummary: (n: number) => `已跳过 ${n} 个符号链接、重解析点或不可读项`,
    renamedDone: (n: number) => `已完成 ${n} 个文件的重命名。可随时点击“撤销上一批”恢复原名。`,
    undoDone: (n: number) => `已撤销上一批操作，${n} 个文件已恢复原名。`,
    loadedEmptyWarn: "所选路径中没有可载入的直属普通文件。",
  },
  "en-US": {
    addFilesBtn: "Add Files",
    addFolderBtn: "Add Folder",
    refreshBtn: "Refresh Disk State",
    clearBtn: "Clear List",
    undoBtn: (count: number) => (count > 0 ? `Undo Last Batch (${count})` : "Undo Last Batch"),
    executeBtn: (count: number) => (count > 0 ? `Rename ${count} Files` : "Rename Files"),
    pickFilesTitle: "Select files for Batch Rename",
    pickFolderTitle: "Select folders to load direct files",
    emptyTitle: "Select or drop files and folders to rename",
    emptyHint: `Drop multiple files or folders from File Explorer (loads direct regular files up to ${MAX_BATCH_RENAME_FILES} items), inspect full live preview & conflicts, and undo the most recent batch in one click.`,
    totalBadge: (n: number) => `${n} items`,
    actionableBadge: (n: number) => `${n} to rename`,
    caseOnlyBadge: (n: number) => `${n} case-only`,
    unchangedBadge: (n: number) => `${n} unchanged`,
    issueBadge: (n: number) => `${n} conflicts / invalid`,
    filterAll: (n: number) => `All (${n})`,
    filterChanged: (n: number) => `To Rename (${n})`,
    filterIssues: (n: number) => `Issues (${n})`,
    colIndex: "#",
    colOriginal: "Original File & Folder",
    colPreview: "New Filename Preview",
    colSize: "Size",
    colStatus: "Validation",
    colActions: "Action",
    removeRowAria: (name: string) => `Remove ${name} from batch`,
    removeRowLabel: "Remove",
    statusLabels: {
      ready: "Ready",
      case_only: "Case only",
      unchanged: "Unchanged",
      invalid_name: "Invalid name",
      conflict_in_batch: "Batch conflict",
      conflict_existing: "Target exists",
    } satisfies Record<BatchRenameRowStatus, string>,
    noFilteredRows: "No files match the active filter.",
    pageSummary: (start: number, end: number, total: number) =>
      `Showing ${start}–${end} of ${total}`,
    prevPage: "Previous",
    nextPage: "Next",
    skippedSummary: (n: number) =>
      `Skipped ${n} symbolic link(s), reparse point(s), or unreadable item(s)`,
    renamedDone: (n: number) =>
      `Renamed ${n} file(s). Use "Undo Last Batch" to restore original filenames.`,
    undoDone: (n: number) => `Undid last batch and restored ${n} file(s) to their original names.`,
    loadedEmptyWarn: "No direct regular files were found in the selected paths.",
  },
};

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function formatRenameBackendError(err: unknown, locale: Locale, messages: Messages): string {
  const parsed = parseBackendError(err);
  const zh = locale === "zh-CN";
  const rolledBack = parsed.message.toLowerCase().includes("rolled back");

  if (parsed.code === "TARGET_ALREADY_EXISTS") {
    if (rolledBack) {
      return zh
        ? `目标文件名在执行过程中被外部文件占用，已保护外部已有文件并将本批所有文件安全回滚至原名。（${parsed.message}）`
        : parsed.message;
    }
    return zh
      ? `检测到同目录下已存在同名文件（含预览后新建的文件），已保护已有文件并取消本批重命名。（${parsed.message}）`
      : parsed.message;
  }
  if (parsed.code === "BATCH_TARGET_CONFLICT") {
    return zh
      ? `批内存在多个文件指向同一目标名称，未改动任何文件。（${parsed.message}）`
      : parsed.message;
  }
  if (parsed.code === "UNDO_TARGET_OCCUPIED") {
    return zh
      ? `无法撤销：原文件名已被其他新文件占用，现有文件均已完整保留未覆盖。（${parsed.message}）`
      : parsed.message;
  }
  if (parsed.code === "UNDO_SOURCE_MISSING" || parsed.code === "UNDO_SOURCE_INVALID") {
    return zh
      ? `无法撤销：上一批重命名后的部分文件已被移走或更改，其余文件未作改动。（${parsed.message}）`
      : parsed.message;
  }
  if (parsed.code === "FILE_LOCKED" && rolledBack) {
    return zh
      ? `执行中途遇到被其他程序占用的文件，已将本批已暂存文件全部安全回滚至原名。（${parsed.message}）`
      : parsed.message;
  }
  const base = formatLocalizedError(err, messages);
  if (rolledBack && zh) {
    return `${base}（本批已执行项已全部回滚至原名）`;
  }
  return base;
}

export function BatchRenameWorkspace() {
  const { locale, t: messages } = useI18n();
  const t = workspaceCopy[locale];
  const { session, updateBatchRenameSession } = useSessionStore();
  const state = session.batchRename;

  const [busy, setBusy] = useState(false);
  const [dropHover, setDropHover] = useState(false);
  const [page, setPage] = useState(0);
  const [undoStatus, setUndoStatus] = useState<BatchRenameUndoStatus>({
    available: false,
    itemCount: 0,
    completedAtMs: null,
  });

  const entriesRef = useRef(state.entries);
  entriesRef.current = state.entries;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    let active = true;
    getBatchRenameUndoStatus()
      .then((status) => {
        if (active) setUndoStatus(status);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const mergeAndInspectPaths = useCallback(
    async (incomingPaths: string[], replaceExisting = false) => {
      if (busyRef.current) return;
      const basePaths = replaceExisting ? [] : entriesRef.current.map((e) => e.path);
      const combined = [...basePaths, ...incomingPaths];
      if (combined.length === 0) {
        updateBatchRenameSession({
          entries: [],
          existingDirSiblings: {},
          skipped: [],
          lastBanner: null,
        });
        return;
      }

      setBusy(true);
      try {
        const res = await inspectBatchRenameSources(combined);
        updateBatchRenameSession({
          entries: res.entries,
          existingDirSiblings: res.existingDirSiblings,
          skipped: res.skipped,
          lastBanner:
            res.entries.length === 0
              ? { tone: "warn", text: workspaceCopy[locale].loadedEmptyWarn }
              : null,
        });
        setPage(0);
      } catch (err) {
        updateBatchRenameSession({
          lastBanner: {
            tone: "err",
            text: formatRenameBackendError(err, locale, messages),
          },
        });
      } finally {
        setBusy(false);
      }
    },
    [locale, messages, updateBatchRenameSession],
  );

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: (hovering) => setDropHover(hovering),
          onDropPaths: (paths) => {
            void mergeAndInspectPaths(paths, false);
          },
        }),
      "f02-file-drop",
    );
  }, [mergeAndInspectPaths]);

  const preview = useMemo(
    () =>
      computeBatchRenamePreview(state.entries, state.rule, state.sort, {
        locale,
        existingDirSiblings: state.existingDirSiblings,
      }),
    [state.entries, state.rule, state.sort, locale, state.existingDirSiblings],
  );

  const actionableCount = preview.readyCount + preview.caseOnlyCount;
  const totalIssuesCount = preview.invalidCount + preview.conflictCount;

  const filteredRows = useMemo(() => {
    if (state.filterMode === "changed") {
      return preview.rows.filter((r) => r.status === "ready" || r.status === "case_only");
    }
    if (state.filterMode === "issues") {
      return preview.rows.filter(
        (r) =>
          r.status === "invalid_name" ||
          r.status === "conflict_in_batch" ||
          r.status === "conflict_existing",
      );
    }
    return preview.rows;
  }, [preview.rows, state.filterMode]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / RENAME_PREVIEW_PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages - 1);
  const pageStartIdx = clampedPage * RENAME_PREVIEW_PAGE_SIZE;
  const visibleRows = filteredRows.slice(pageStartIdx, pageStartIdx + RENAME_PREVIEW_PAGE_SIZE);

  const handleAddFiles = async () => {
    const picked = await pickMultipleFiles({ title: t.pickFilesTitle });
    if (picked.length > 0) {
      await mergeAndInspectPaths(picked, false);
    }
  };

  const handleAddFolder = async () => {
    const picked = await pickMultipleDirectories({ title: t.pickFolderTitle });
    if (picked.length > 0) {
      await mergeAndInspectPaths(picked, false);
    }
  };

  const handleRefresh = async () => {
    if (state.entries.length === 0) return;
    await mergeAndInspectPaths(
      state.entries.map((e) => e.path),
      true,
    );
  };

  const handleRemoveEntry = (pathToRemove: string) => {
    updateBatchRenameSession((prev) => ({
      ...prev,
      entries: prev.entries.filter((e) => e.path !== pathToRemove),
      lastBanner: null,
    }));
  };

  const handleClear = () => {
    updateBatchRenameSession({
      entries: [],
      existingDirSiblings: {},
      skipped: [],
      lastBanner: null,
    });
    setPage(0);
  };

  const handleExecuteRename = async () => {
    if (!preview.canExecute || busy) return;
    // Pass ALL batch rows (including unchanged items so the Rust backend also guards unchanged slots!)
    const operations = preview.rows.map((row) => ({
      sourcePath: row.path,
      newName: row.newName,
    }));
    const currentPaths = state.entries.map((e) => e.path);

    setBusy(true);
    try {
      const res = await executeBatchRename(operations, currentPaths);
      setUndoStatus(res.undoStatus);
      updateBatchRenameSession({
        entries: res.updatedInspection.entries,
        existingDirSiblings: res.updatedInspection.existingDirSiblings,
        skipped: res.updatedInspection.skipped,
        lastBanner: {
          tone: "ok",
          text: t.renamedDone(res.renamedCount),
        },
      });
    } catch (err) {
      const latestUndo = await getBatchRenameUndoStatus().catch(() => null);
      if (latestUndo) setUndoStatus(latestUndo);
      // Re-inspect current files so if an external sibling appeared after preview, preview immediately highlights it!
      const refreshed = await inspectBatchRenameSources(currentPaths).catch(() => null);
      updateBatchRenameSession((prev) => ({
        ...prev,
        entries: refreshed ? refreshed.entries : prev.entries,
        existingDirSiblings: refreshed ? refreshed.existingDirSiblings : prev.existingDirSiblings,
        lastBanner: {
          tone: "err",
          text: formatRenameBackendError(err, locale, messages),
        },
      }));
    } finally {
      setBusy(false);
    }
  };

  const handleUndo = async () => {
    if (!undoStatus.available || busy) return;
    const currentPaths = state.entries.map((e) => e.path);
    setBusy(true);
    try {
      const res = await undoLastBatchRename(currentPaths);
      setUndoStatus(res.undoStatus);
      updateBatchRenameSession({
        entries: res.updatedInspection.entries,
        existingDirSiblings: res.updatedInspection.existingDirSiblings,
        skipped: res.updatedInspection.skipped,
        lastBanner: {
          tone: "ok",
          text: t.undoDone(res.renamedCount),
        },
      });
    } catch (err) {
      const latestUndo = await getBatchRenameUndoStatus().catch(() => null);
      if (latestUndo) setUndoStatus(latestUndo);
      updateBatchRenameSession({
        lastBanner: {
          tone: "err",
          text: formatRenameBackendError(err, locale, messages),
        },
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tool-workspace batch-rename-workspace">
      <div className="tool-toolbar">
        <div className="tool-toolbar-group">
          <button type="button" className="btn" disabled={busy} onClick={handleAddFiles}>
            {t.addFilesBtn}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={handleAddFolder}>
            {t.addFolderBtn}
          </button>
          {state.entries.length > 0 && (
            <>
              <button type="button" className="btn" disabled={busy} onClick={handleRefresh}>
                {t.refreshBtn}
              </button>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={handleClear}>
                {t.clearBtn}
              </button>
            </>
          )}
        </div>

        <div className="tool-toolbar-group">
          <button
            type="button"
            className="btn"
            disabled={!undoStatus.available || busy}
            onClick={handleUndo}
          >
            {t.undoBtn(undoStatus.itemCount)}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!preview.canExecute || busy}
            onClick={handleExecuteRename}
          >
            {t.executeBtn(actionableCount)}
          </button>
        </div>
      </div>

      <RenameRules
        rule={state.rule}
        sort={state.sort}
        onRuleChange={(rule) => updateBatchRenameSession({ rule, lastBanner: null })}
        onSortChange={(sort) => updateBatchRenameSession({ sort })}
        disabled={busy}
        regexError={preview.regexError}
      />

      {state.lastBanner && (
        <div
          className={`status-banner ${
            state.lastBanner.tone === "ok"
              ? "is-ok"
              : state.lastBanner.tone === "warn"
                ? "is-warn"
                : "is-err"
          }`}
          role="status"
        >
          <span>{state.lastBanner.text}</span>
        </div>
      )}

      {state.skipped.length > 0 && (
        <details className="batch-rename-skipped">
          <summary>{t.skippedSummary(state.skipped.length)}</summary>
          <ul>
            {state.skipped.slice(0, 25).map((item) => (
              <li key={`${item.path}-${item.reason}`}>
                <span className="batch-rename-mono">{item.path}</span> — {item.reason}
              </li>
            ))}
          </ul>
        </details>
      )}

      {state.entries.length > 0 && (
        <div className="batch-rename-summary-bar">
          <div className="batch-rename-stats">
            <span className="badge">{t.totalBadge(preview.rows.length)}</span>
            <span className="badge badge-ok">{t.actionableBadge(actionableCount)}</span>
            {preview.caseOnlyCount > 0 && (
              <span className="badge">{t.caseOnlyBadge(preview.caseOnlyCount)}</span>
            )}
            <span className="badge">{t.unchangedBadge(preview.unchangedCount)}</span>
            {totalIssuesCount > 0 && (
              <span className="badge badge-err">{t.issueBadge(totalIssuesCount)}</span>
            )}
          </div>

          <div className="segmented" role="group">
            <button
              type="button"
              className="segmented-btn"
              aria-pressed={state.filterMode === "all"}
              onClick={() => {
                updateBatchRenameSession({ filterMode: "all" });
                setPage(0);
              }}
            >
              {t.filterAll(preview.rows.length)}
            </button>
            <button
              type="button"
              className="segmented-btn"
              aria-pressed={state.filterMode === "changed"}
              onClick={() => {
                updateBatchRenameSession({ filterMode: "changed" });
                setPage(0);
              }}
            >
              {t.filterChanged(actionableCount)}
            </button>
            <button
              type="button"
              className="segmented-btn"
              aria-pressed={state.filterMode === "issues"}
              onClick={() => {
                updateBatchRenameSession({ filterMode: "issues" });
                setPage(0);
              }}
            >
              {t.filterIssues(totalIssuesCount)}
            </button>
          </div>
        </div>
      )}

      <div className={`batch-rename-drop-surface ${dropHover ? "is-drop-hover" : ""}`}>
        {state.entries.length === 0 ? (
          <div className="batch-rename-empty">
            <strong>{t.emptyTitle}</strong>
            <p className="field-hint">{t.emptyHint}</p>
            <div className="batch-rename-empty-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={handleAddFiles}
              >
                {t.addFilesBtn}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={handleAddFolder}>
                {t.addFolderBtn}
              </button>
            </div>
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="batch-rename-empty">
            <span>{t.noFilteredRows}</span>
          </div>
        ) : (
          <>
            <div className="batch-rename-table-wrap">
              <table className="batch-rename-table">
                <thead>
                  <tr>
                    <th>{t.colIndex}</th>
                    <th>{t.colOriginal}</th>
                    <th aria-hidden="true" />
                    <th>{t.colPreview}</th>
                    <th>{t.colSize}</th>
                    <th>{t.colStatus}</th>
                    <th>{t.colActions}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => {
                    const isIssue =
                      row.status === "invalid_name" ||
                      row.status === "conflict_in_batch" ||
                      row.status === "conflict_existing";
                    const isChanged = row.status === "ready" || row.status === "case_only";
                    const badgeClass = isIssue
                      ? "badge badge-err"
                      : isChanged
                        ? "badge badge-ok"
                        : "badge";
                    return (
                      <tr
                        key={row.path}
                        className={`batch-rename-row ${isIssue ? "has-issue" : ""}`}
                      >
                        <td>{row.index}</td>
                        <td>
                          <div className="batch-rename-mono">{row.oldName}</div>
                          <div className="batch-rename-parent">{row.parentDir}</div>
                        </td>
                        <td className="batch-rename-arrow" aria-hidden="true">
                          →
                        </td>
                        <td>
                          <div
                            className={`batch-rename-mono batch-rename-new ${
                              isIssue ? "is-error" : isChanged ? "is-changed" : ""
                            }`}
                          >
                            {row.newName}
                          </div>
                          {row.reason && <div className="batch-rename-reason">{row.reason}</div>}
                        </td>
                        <td>{formatByteSize(row.byteLength)}</td>
                        <td>
                          <span className={badgeClass}>{t.statusLabels[row.status]}</span>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-ghost"
                            disabled={busy}
                            aria-label={t.removeRowAria(row.oldName)}
                            onClick={() => handleRemoveEntry(row.path)}
                          >
                            {t.removeRowLabel}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {filteredRows.length > RENAME_PREVIEW_PAGE_SIZE && (
              <div className="batch-rename-footer">
                <span>
                  {t.pageSummary(
                    pageStartIdx + 1,
                    Math.min(filteredRows.length, pageStartIdx + visibleRows.length),
                    filteredRows.length,
                  )}
                </span>
                <div className="tool-toolbar-group">
                  <button
                    type="button"
                    className="btn"
                    disabled={clampedPage === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                  >
                    {t.prevPage}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={clampedPage + 1 >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  >
                    {t.nextPage}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
