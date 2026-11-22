import { useCallback, useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore, type DuplicateMinSizeUnit } from "../../lib/sessionStore";
import {
  bindDisposableListener,
  formatLocalizedError,
  pickMultipleDirectories,
  recycleDuplicateGroups,
  subscribeFileDrop,
} from "../../lib/tauriBridge";
import {
  computeDuplicateSelectionByPreset,
  computeSelectionSummary,
  isLastUnselectedInGroup,
  toggleDuplicateItemSelection,
  type DuplicateGroup,
  type DuplicateSelectionPreset,
} from "./findDuplicatesEngine";
import "./findDuplicatesWorkspace.css";

const GROUPS_PER_PAGE = 50;

const copy = {
  "zh-CN": {
    addFoldersBtn: "选择文件夹",
    clearFoldersBtn: "清空目录",
    startScanBtn: "开始扫描",
    rescanBtn: "重新扫描",
    cancelScanBtn: "取消扫描",
    pickFoldersTitle: "选择要递归查找重复文件的文件夹",
    pickKeepFolderTitle: "选择要优先保留副本的文件夹",
    dropFoldersHint:
      "选择一个或多个文件夹（支持从资源管理器直接拖入多个目录）。自动合并重复路径与父子嵌套目录，默认跳过目录联接与符号链接。",
    removeFolderAria: (p: string) => `移除扫描目录 ${p}`,
    minSizeLabel: "最低文件大小",
    includeHiddenLabel: "包含隐藏文件与目录",
    phaseLabels: {
      walking: "第 1 级：递归扫描目录并按字节大小分组…",
      edge_hashing: "第 2 级：比对同大小候选文件的首尾 64 KiB…",
      full_hashing: "第 3 级：流式计算候选文件整文件 SHA-256…",
      completed: "扫描已完成",
      cancelled: "扫描已取消",
      error: "扫描出错",
    },
    scannedCountText: (n: number) => `已扫描 ${n} 个普通文件`,
    cancelledNotice: "已取消本次重复文件扫描，可调整目录或筛选条件后重新扫描。",
    emptyRootsTitle: "尚未添加扫描文件夹",
    emptyRootsBody:
      "点击“选择文件夹”或从资源管理器拖入文件夹后开始本地内容比对。扫描过程绝不修改任何文件。",
    noDuplicatesFound: (scanned: number) =>
      `扫描完成（共检查 ${scanned} 个文件），未发现内容完全一致的重复文件。`,
    groupsBadge: (n: number) => `${n} 组重复`,
    filesBadge: (n: number) => `涉及 ${n} 个文件`,
    reclaimBadge: (size: string) => `预计可释放空间 ${size}`,
    selectedBadge: (n: number, size: string) => `待移入回收站：${n} 项（${size}）`,
    presetKeepNewest: "保留最新",
    presetKeepOldest: "保留最旧",
    presetKeepShortest: "保留最短路径",
    presetKeepFolder: "按指定目录保留",
    chooseKeepFolderBtn: "浏览目录…",
    clearSelectionBtn: "清空勾选",
    moveToRecycleBtn: (n: number, size: string) =>
      n > 0 ? `移入回收站 (${n} 项 · ${size})` : "移入回收站",
    groupTitle: (idx: number, count: number, eachSize: string, reclaim: string) =>
      `第 ${idx} 组 · ${count} 份副本 · 单文件 ${eachSize} · 预计可释放 ${reclaim}`,
    keptBadge: "保留副本",
    selectedRemoveBadge: "待移入回收站",
    hardlinkBadge: (n: number) => `硬链接 ×${n}`,
    checkAria: (path: string) => `勾选移入回收站 ${path}`,
    collapsedRootsSummary: (n: number) => `已自动合并 ${n} 个重复或子级目录路径`,
    hardlinksSkippedSummary: (n: number) =>
      `已排除 ${n} 个指向同一物理文件数据的硬链接（删除单个硬链接不会额外释放磁盘空间）`,
    skippedItemsSummary: (n: number) => `扫描期间跳过了 ${n} 个重解析点、无权限或变动项`,
    confirmTitle: "确认移入 Windows 回收站",
    confirmBody: (count: number, size: string, groups: number) =>
      `即将把 ${groups} 个重复组中的 ${count} 个文件（合计大小 ${size}）移入 Windows 回收站。\n\n执行前后端将逐组重新校验保留副本与待移除文件的内容哈希；仅支持移入 Windows 回收站，若目标卷或系统设置无法保证进入回收站将自动跳过，绝不退化为永久删除。`,
    confirmAccept: "确认移入回收站",
    confirmCancel: "取消",
    recycledSummaryBadge: (n: number, size: string) => `已移入回收站：${n} 个文件（${size}）`,
    recycleSkippedBadge: (n: number) => `跳过 ${n} 项`,
    recycleFailedBadge: (n: number) => `失败 ${n} 项`,
    recycleSpaceNote:
      "提示：已移入 Windows 回收站的文件在清空回收站前仍占用磁盘空间，您可随时在系统回收站中恢复原文件。",
    outcomeDetailsSummary: (n: number) => `查看逐项处理结果（共 ${n} 项）`,
    outcomeStatusLabels: {
      recycled: "已移入回收站",
      skipped: "已跳过",
      failed: "失败",
    },
    pageSummary: (start: number, end: number, total: number) =>
      `显示第 ${start}–${end} 组，共 ${total} 组`,
    prevPage: "上一页",
    nextPage: "下一页",
    invalidMinSize: "最低文件大小请输入不小于 0 的数字。",
  },
  "en-US": {
    addFoldersBtn: "Add Folders",
    clearFoldersBtn: "Clear Folders",
    startScanBtn: "Start Scan",
    rescanBtn: "Rescan",
    cancelScanBtn: "Cancel Scan",
    pickFoldersTitle: "Select folders to scan recursively for duplicate files",
    pickKeepFolderTitle: "Select folder whose copies should be kept",
    dropFoldersHint:
      "Add one or more folders (or drop folders from File Explorer). Duplicate paths and parent/child folders are merged automatically; junctions and symbolic links are skipped by default.",
    removeFolderAria: (p: string) => `Remove folder ${p}`,
    minSizeLabel: "Minimum file size",
    includeHiddenLabel: "Include hidden files & folders",
    phaseLabels: {
      walking: "Stage 1: Walking folders & grouping by byte size…",
      edge_hashing: "Stage 2: Comparing first 64 KiB & last 64 KiB…",
      full_hashing: "Stage 3: Streaming full-file SHA-256…",
      completed: "Scan completed",
      cancelled: "Scan cancelled",
      error: "Scan failed",
    },
    scannedCountText: (n: number) => `Scanned ${n} regular file(s)`,
    cancelledNotice: "Scan cancelled. You can adjust folders or filters and scan again.",
    emptyRootsTitle: "No folders selected yet",
    emptyRootsBody:
      'Click "Add Folders" or drop folders from File Explorer to scan locally. Scanning is strictly read-only and never modifies files.',
    noDuplicatesFound: (scanned: number) =>
      `Scan complete (${scanned} file(s) inspected). No identical duplicate files were found.`,
    groupsBadge: (n: number) => `${n} duplicate group(s)`,
    filesBadge: (n: number) => `${n} files`,
    reclaimBadge: (size: string) => `Est. reclaimable ${size}`,
    selectedBadge: (n: number, size: string) => `Selected for Recycle Bin: ${n} (${size})`,
    presetKeepNewest: "Keep Newest",
    presetKeepOldest: "Keep Oldest",
    presetKeepShortest: "Keep Shortest Path",
    presetKeepFolder: "Keep In Folder",
    chooseKeepFolderBtn: "Browse…",
    clearSelectionBtn: "Clear Selection",
    moveToRecycleBtn: (n: number, size: string) =>
      n > 0 ? `Move to Recycle Bin (${n} · ${size})` : "Move to Recycle Bin",
    groupTitle: (idx: number, count: number, eachSize: string, reclaim: string) =>
      `Group #${idx} · ${count} copies · ${eachSize} each · Est. reclaimable ${reclaim}`,
    keptBadge: "Kept copy",
    selectedRemoveBadge: "To Recycle Bin",
    hardlinkBadge: (n: number) => `Hardlink ×${n}`,
    checkAria: (path: string) => `Select ${path} for Recycle Bin`,
    collapsedRootsSummary: (n: number) => `Merged ${n} duplicate or nested child folder path(s)`,
    hardlinksSkippedSummary: (n: number) =>
      `Excluded ${n} NTFS hardlink alias(es) sharing the same physical file data (removing a single hardlink frees 0 extra bytes)`,
    skippedItemsSummary: (n: number) =>
      `Skipped ${n} reparse point(s), inaccessible item(s), or mid-scan changed file(s)`,
    confirmTitle: "Move Selected Duplicates to Windows Recycle Bin",
    confirmBody: (count: number, size: string, groups: number) =>
      `Move ${count} file(s) (${size} total) across ${groups} group(s) to the Windows Recycle Bin?\n\nBefore moving, WinKit re-verifies every kept copy and selected file on disk. Items are moved strictly to the Windows Recycle Bin and will be skipped rather than permanently deleted if Recycle Bin placement cannot be guaranteed.`,
    confirmAccept: "Move to Recycle Bin",
    confirmCancel: "Cancel",
    recycledSummaryBadge: (n: number, size: string) =>
      `Moved to Recycle Bin: ${n} file(s) (${size})`,
    recycleSkippedBadge: (n: number) => `${n} skipped`,
    recycleFailedBadge: (n: number) => `${n} failed`,
    recycleSpaceNote:
      "Note: Files moved to the Windows Recycle Bin still occupy disk space until the Recycle Bin is emptied, and can be restored from the Recycle Bin.",
    outcomeDetailsSummary: (n: number) => `Inspect per-file outcomes (${n} item(s))`,
    outcomeStatusLabels: {
      recycled: "Moved to Recycle Bin",
      skipped: "Skipped",
      failed: "Failed",
    },
    pageSummary: (start: number, end: number, total: number) =>
      `Showing groups ${start}–${end} of ${total}`,
    prevPage: "Previous",
    nextPage: "Next",
    invalidMinSize: "Enter a non-negative minimum file size.",
  },
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function formatDateTime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function parseMinSizeToBytes(raw: string, unit: DuplicateMinSizeUnit): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  const val = Number(trimmed);
  if (!Number.isFinite(val) || val < 0) return null;
  const mult = unit === "MiB" ? 1024 * 1024 : unit === "KiB" ? 1024 : 1;
  const bytes = Math.floor(val * mult);
  if (!Number.isSafeInteger(bytes) || bytes < 0) return null;
  return bytes;
}

function pruneRecycledItemsFromGroups(
  groups: readonly DuplicateGroup[],
  recycledPaths: ReadonlySet<string>,
): DuplicateGroup[] {
  if (recycledPaths.size === 0) return [...groups];
  const next: DuplicateGroup[] = [];
  for (const g of groups) {
    const remaining = g.files.filter((f) => !recycledPaths.has(f.path));
    if (remaining.length >= 2) {
      const links = remaining.map((f) => f.hardlinkCount).sort((a, b) => b - a);
      const removable = links.slice(1).filter((c) => c <= 1).length;
      next.push({
        ...g,
        files: remaining,
        reclaimableBytes: removable * g.byteLength,
      });
    }
  }
  return next;
}

export function FindDuplicatesWorkspace() {
  const { locale, t: messages } = useI18n();
  const t = copy[locale];
  const { session, updateFindDuplicatesSession, startDuplicateScan, cancelDuplicateScan } =
    useSessionStore();
  const state = session.findDuplicates;

  const [dropHover, setDropHover] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [page, setPage] = useState(0);

  const isScanning = state.status === "scanning";
  const isRecycling = state.status === "recycling";
  const busy = isScanning || isRecycling;

  const appendUniqueRoots = useCallback(
    (incoming: string[]) => {
      const cleaned = incoming.map((p) => p.trim()).filter((p) => p.length > 0);
      if (cleaned.length === 0) return;
      updateFindDuplicatesSession((prev) => {
        const seen = new Set(prev.rootPaths.map((r) => r.toLowerCase()));
        const nextRoots = [...prev.rootPaths];
        for (const cand of cleaned) {
          const key = cand.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            nextRoots.push(cand);
          }
        }
        return {
          ...prev,
          rootPaths: nextRoots,
          preferredKeepFolder: prev.preferredKeepFolder || (nextRoots[0] ?? ""),
          errorMessage: null,
        };
      });
    },
    [updateFindDuplicatesSession],
  );

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: (hovering) => setDropHover(hovering),
          onDropPaths: (paths) => {
            if (!busy) {
              appendUniqueRoots(paths);
            }
          },
        }),
      "f03-folder-drop",
    );
  }, [appendUniqueRoots, busy]);

  const selectedSet = useMemo(() => new Set(state.selectedPaths), [state.selectedPaths]);
  const groups = useMemo(() => state.scanResult?.groups ?? [], [state.scanResult]);

  const selectionSummary = useMemo(
    () => computeSelectionSummary(groups, selectedSet),
    [groups, selectedSet],
  );

  const totalReclaimable = useMemo(
    () => groups.reduce((sum, g) => sum + g.reclaimableBytes, 0),
    [groups],
  );

  const totalDuplicateFiles = useMemo(
    () => groups.reduce((sum, g) => sum + g.files.length, 0),
    [groups],
  );

  const totalPages = Math.max(1, Math.ceil(groups.length / GROUPS_PER_PAGE));
  const clampedPage = Math.min(page, totalPages - 1);
  const pageStart = clampedPage * GROUPS_PER_PAGE;
  const visibleGroups = groups.slice(pageStart, pageStart + GROUPS_PER_PAGE);

  const handleAddFolders = async () => {
    const picked = await pickMultipleDirectories({ title: t.pickFoldersTitle });
    if (picked.length > 0) {
      appendUniqueRoots(picked);
    }
  };

  const handleRemoveRoot = (target: string) => {
    updateFindDuplicatesSession((prev) => ({
      ...prev,
      rootPaths: prev.rootPaths.filter((r) => r !== target),
    }));
  };

  const handleStartScan = async () => {
    if (busy || state.rootPaths.length === 0) return;
    const minBytes = parseMinSizeToBytes(state.minSizeInput, state.minSizeUnit);
    if (minBytes === null) {
      updateFindDuplicatesSession({ status: "error", errorMessage: t.invalidMinSize });
      return;
    }
    setPage(0);
    await startDuplicateScan(
      {
        rootPaths: state.rootPaths,
        minSizeBytes: minBytes,
        includeHidden: state.includeHidden,
      },
      (err) => formatLocalizedError(err, messages),
    );
  };

  const handleApplyPreset = (preset: DuplicateSelectionPreset, folderOverride?: string) => {
    const next = computeDuplicateSelectionByPreset(groups, preset, {
      preferredFolder: folderOverride ?? state.preferredKeepFolder,
    });
    updateFindDuplicatesSession({ selectedPaths: [...next] });
  };

  const handleBrowseKeepFolder = async () => {
    const picked = await pickMultipleDirectories({ title: t.pickKeepFolderTitle });
    const first = picked[0];
    if (first) {
      updateFindDuplicatesSession({ preferredKeepFolder: first });
      handleApplyPreset("keep_in_folder", first);
    }
  };

  const handleToggleItem = (group: DuplicateGroup, path: string) => {
    const { nextSelected, blockedLastCopy } = toggleDuplicateItemSelection(
      group,
      selectedSet,
      path,
    );
    if (!blockedLastCopy) {
      updateFindDuplicatesSession({ selectedPaths: [...nextSelected] });
    }
  };

  const handleConfirmRecycle = async () => {
    setConfirmOpen(false);
    if (selectionSummary.plans.length === 0 || busy) return;

    updateFindDuplicatesSession({ status: "recycling", errorMessage: null });
    try {
      const report = await recycleDuplicateGroups(selectionSummary.plans);
      const recycledPathSet = new Set(
        report.outcomes.filter((o) => o.status === "recycled").map((o) => o.path),
      );
      updateFindDuplicatesSession((prev) => {
        const prevRes = prev.scanResult;
        const nextGroups = prevRes
          ? pruneRecycledItemsFromGroups(prevRes.groups, recycledPathSet)
          : [];
        const nextRemainingSelected = prev.selectedPaths.filter((p) => !recycledPathSet.has(p));
        return {
          ...prev,
          status: "completed",
          lastRecycleReport: report,
          selectedPaths: nextRemainingSelected,
          scanResult: prevRes
            ? {
                ...prevRes,
                groups: nextGroups,
                totalDuplicateFiles: nextGroups.reduce((s, g) => s + g.files.length, 0),
                totalReclaimableBytes: nextGroups.reduce((s, g) => s + g.reclaimableBytes, 0),
              }
            : null,
        };
      });
    } catch (err) {
      updateFindDuplicatesSession({
        status: "error",
        errorMessage: formatLocalizedError(err, messages),
      });
    }
  };

  const progressPercent = useMemo(() => {
    const p = state.liveProgress;
    if (!p || !p.totalCandidateBytes || p.totalCandidateBytes <= 0) return null;
    return Math.min(100, Math.round((p.processedBytes / p.totalCandidateBytes) * 100));
  }, [state.liveProgress]);

  const availableKeepFolders = useMemo(() => {
    const set = new Set<string>();
    for (const r of state.scanResult?.effectiveRoots ?? state.rootPaths) {
      if (r.trim()) set.add(r);
    }
    if (state.preferredKeepFolder.trim()) {
      set.add(state.preferredKeepFolder.trim());
    }
    return [...set];
  }, [state.scanResult, state.rootPaths, state.preferredKeepFolder]);

  return (
    <div className="tool-workspace find-dup-workspace">
      <div className={`find-dup-config-panel ${dropHover ? "is-drop-hover" : ""}`}>
        <div className="tool-toolbar" style={{ paddingBottom: 8 }}>
          <div className="tool-toolbar-group">
            <button type="button" className="btn" disabled={busy} onClick={handleAddFolders}>
              {t.addFoldersBtn}
            </button>
            {state.rootPaths.length > 0 && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() =>
                  updateFindDuplicatesSession({
                    rootPaths: [],
                    scanResult: null,
                    selectedPaths: [],
                    lastRecycleReport: null,
                    errorMessage: null,
                    status: "idle",
                  })
                }
              >
                {t.clearFoldersBtn}
              </button>
            )}
          </div>

          <div className="tool-toolbar-group">
            {isScanning ? (
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void cancelDuplicateScan()}
              >
                {t.cancelScanBtn}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || state.rootPaths.length === 0}
                onClick={() => void handleStartScan()}
              >
                {state.scanResult ? t.rescanBtn : t.startScanBtn}
              </button>
            )}
          </div>
        </div>

        <p className="field-hint">{t.dropFoldersHint}</p>

        {state.rootPaths.length > 0 && (
          <div className="find-dup-roots-list" role="list">
            {state.rootPaths.map((folder) => (
              <span key={folder} className="find-dup-root-chip" role="listitem">
                <span className="find-dup-root-path" title={folder}>
                  {folder}
                </span>
                <button
                  type="button"
                  className="find-dup-root-remove"
                  disabled={busy}
                  aria-label={t.removeFolderAria(folder)}
                  onClick={() => handleRemoveRoot(folder)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="find-dup-options-row">
          <div className="find-dup-inline-controls">
            <label className="field-stack">
              <span className="field-label">{t.minSizeLabel}</span>
              <div className="find-dup-inline-controls">
                <input
                  type="number"
                  min={0}
                  step="any"
                  className="text-input find-dup-size-input"
                  disabled={busy}
                  value={state.minSizeInput}
                  onChange={(e) => updateFindDuplicatesSession({ minSizeInput: e.target.value })}
                />
                <select
                  className="select-input"
                  aria-label={t.minSizeLabel}
                  disabled={busy}
                  value={state.minSizeUnit}
                  onChange={(e) =>
                    updateFindDuplicatesSession({
                      minSizeUnit: e.target.value as DuplicateMinSizeUnit,
                    })
                  }
                >
                  <option value="B">B</option>
                  <option value="KiB">KiB</option>
                  <option value="MiB">MiB</option>
                </select>
              </div>
            </label>

            <label className="checkbox-label" style={{ marginTop: 18 }}>
              <input
                type="checkbox"
                disabled={busy}
                checked={state.includeHidden}
                onChange={(e) => updateFindDuplicatesSession({ includeHidden: e.target.checked })}
              />
              {t.includeHiddenLabel}
            </label>
          </div>
        </div>
      </div>

      {isScanning && state.liveProgress && (
        <div className="find-dup-progress-box" role="status" aria-live="polite">
          <div className="find-dup-progress-top">
            <strong>{t.phaseLabels[state.liveProgress.phase]}</strong>
            <span>
              {t.scannedCountText(state.liveProgress.scannedFiles)}
              {progressPercent !== null ? ` · ${progressPercent}%` : ""}
            </span>
          </div>
          {progressPercent !== null && (
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
            </div>
          )}
          {state.liveProgress.currentPath && (
            <div className="find-dup-current-path">{state.liveProgress.currentPath}</div>
          )}
        </div>
      )}

      {state.status === "cancelled" && (
        <div className="status-banner is-warn" role="status">
          <span>{t.cancelledNotice}</span>
        </div>
      )}

      {state.errorMessage && (
        <div className="status-banner is-err" role="alert">
          <span>{state.errorMessage}</span>
        </div>
      )}

      {state.lastRecycleReport && (
        <div className="find-dup-report-card" role="status">
          <div className="find-dup-report-headline">
            <span className="badge badge-ok">
              {t.recycledSummaryBadge(
                state.lastRecycleReport.recycledCount,
                formatBytes(state.lastRecycleReport.recycledBytes),
              )}
            </span>
            {state.lastRecycleReport.skippedCount > 0 && (
              <span className="badge badge-partial">
                {t.recycleSkippedBadge(state.lastRecycleReport.skippedCount)}
              </span>
            )}
            {state.lastRecycleReport.failedCount > 0 && (
              <span className="badge badge-err">
                {t.recycleFailedBadge(state.lastRecycleReport.failedCount)}
              </span>
            )}
          </div>
          <p className="field-hint">{t.recycleSpaceNote}</p>
          {state.lastRecycleReport.outcomes.length > 0 && (
            <details className="find-dup-details">
              <summary>{t.outcomeDetailsSummary(state.lastRecycleReport.outcomes.length)}</summary>
              <ul>
                {state.lastRecycleReport.outcomes.map((item) => (
                  <li key={`${item.groupId}-${item.path}`}>
                    <strong>[{t.outcomeStatusLabels[item.status]}]</strong>{" "}
                    <span className="find-dup-mono">{item.path}</span> (
                    {formatBytes(item.byteLength)}){item.reason ? ` — ${item.reason}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {state.scanResult && (
        <>
          {state.scanResult.collapsedRedundantRoots.length > 0 && (
            <details className="find-dup-details">
              <summary>
                {t.collapsedRootsSummary(state.scanResult.collapsedRedundantRoots.length)}
              </summary>
              <ul>
                {state.scanResult.collapsedRedundantRoots.map((p) => (
                  <li key={p} className="find-dup-mono">
                    {p}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {state.scanResult.skippedHardlinks.length > 0 && (
            <details className="find-dup-details">
              <summary>
                {t.hardlinksSkippedSummary(state.scanResult.skippedHardlinks.length)}
              </summary>
              <ul>
                {state.scanResult.skippedHardlinks.slice(0, 30).map((hl) => (
                  <li key={hl.skippedPath}>
                    <span className="find-dup-mono">{hl.skippedPath}</span> →{" "}
                    <span className="find-dup-mono">{hl.primaryPath}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {state.scanResult.skippedItems.length > 0 && (
            <details className="find-dup-details">
              <summary>{t.skippedItemsSummary(state.scanResult.skippedItems.length)}</summary>
              <ul>
                {state.scanResult.skippedItems.slice(0, 30).map((sk, idx) => (
                  <li key={`${sk.path}-${idx}`}>
                    <span className="find-dup-mono">{sk.path}</span> — {sk.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {groups.length === 0 ? (
            <div className="empty-state">
              {t.noDuplicatesFound(state.scanResult.scannedFileCount)}
            </div>
          ) : (
            <>
              <div className="find-dup-preset-bar">
                <div className="find-dup-inline-controls">
                  <span className="badge">{t.groupsBadge(groups.length)}</span>
                  <span className="badge">{t.filesBadge(totalDuplicateFiles)}</span>
                  <span className="badge badge-ok">
                    {t.reclaimBadge(formatBytes(totalReclaimable))}
                  </span>
                  {selectionSummary.selectedCount > 0 && (
                    <span className="badge badge-partial">
                      {t.selectedBadge(
                        selectionSummary.selectedCount,
                        formatBytes(selectionSummary.selectedBytes),
                      )}
                    </span>
                  )}
                </div>

                <div className="find-dup-inline-controls">
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => handleApplyPreset("keep_newest")}
                  >
                    {t.presetKeepNewest}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => handleApplyPreset("keep_oldest")}
                  >
                    {t.presetKeepOldest}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => handleApplyPreset("keep_shortest_path")}
                  >
                    {t.presetKeepShortest}
                  </button>
                  <select
                    className="select-input find-dup-folder-select"
                    disabled={busy}
                    value={state.preferredKeepFolder}
                    onChange={(e) =>
                      updateFindDuplicatesSession({ preferredKeepFolder: e.target.value })
                    }
                  >
                    {availableKeepFolders.map((folder) => (
                      <option key={folder} value={folder}>
                        {folder}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || !state.preferredKeepFolder.trim()}
                    onClick={() => handleApplyPreset("keep_in_folder")}
                  >
                    {t.presetKeepFolder}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => void handleBrowseKeepFolder()}
                  >
                    {t.chooseKeepFolderBtn}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busy || selectionSummary.selectedCount === 0}
                    onClick={() => updateFindDuplicatesSession({ selectedPaths: [] })}
                  >
                    {t.clearSelectionBtn}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy || selectionSummary.selectedCount === 0}
                    onClick={() => setConfirmOpen(true)}
                  >
                    {t.moveToRecycleBtn(
                      selectionSummary.selectedCount,
                      formatBytes(selectionSummary.selectedBytes),
                    )}
                  </button>
                </div>
              </div>

              <div className="find-dup-groups-list">
                {visibleGroups.map((group, localIdx) => {
                  const globalIdx = pageStart + localIdx + 1;
                  return (
                    <section key={group.groupId} className="find-dup-group-card">
                      <header className="find-dup-group-header">
                        <div className="find-dup-group-meta">
                          <strong>
                            {t.groupTitle(
                              globalIdx,
                              group.files.length,
                              formatBytes(group.byteLength),
                              formatBytes(group.reclaimableBytes),
                            )}
                          </strong>
                        </div>
                        <span className="find-dup-sha" title={group.sha256}>
                          SHA-256: {group.sha256.slice(0, 16)}…
                        </span>
                      </header>

                      <div>
                        {group.files.map((file) => {
                          const isChecked = selectedSet.has(file.path);
                          const isProtectedLast = isLastUnselectedInGroup(
                            group,
                            selectedSet,
                            file.path,
                          );
                          return (
                            <div
                              key={file.path}
                              className={`find-dup-file-row ${isChecked ? "is-selected" : ""}`}
                            >
                              <input
                                type="checkbox"
                                checked={isChecked}
                                disabled={busy || isProtectedLast}
                                aria-label={t.checkAria(file.path)}
                                onChange={() => handleToggleItem(group, file.path)}
                              />
                              <div className="find-dup-file-main">
                                <div className="find-dup-file-name-line">
                                  <strong className="find-dup-mono">{file.fileName}</strong>
                                  {isChecked ? (
                                    <span className="badge badge-partial">
                                      {t.selectedRemoveBadge}
                                    </span>
                                  ) : (
                                    <span className="badge badge-ok">{t.keptBadge}</span>
                                  )}
                                  {file.hardlinkCount > 1 && (
                                    <span className="badge">
                                      {t.hardlinkBadge(file.hardlinkCount)}
                                    </span>
                                  )}
                                </div>
                                <div className="find-dup-full-path">{file.path}</div>
                              </div>
                              <div className="find-dup-mtime">
                                {formatDateTime(file.modifiedMs)}
                              </div>
                              <div className="find-dup-mono">{formatBytes(file.byteLength)}</div>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
              </div>

              {groups.length > GROUPS_PER_PAGE && (
                <div className="tool-toolbar">
                  <span className="field-hint">
                    {t.pageSummary(
                      pageStart + 1,
                      Math.min(groups.length, pageStart + visibleGroups.length),
                      groups.length,
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
        </>
      )}

      {!isScanning && !state.scanResult && state.rootPaths.length === 0 && (
        <div className="empty-state">
          <strong>{t.emptyRootsTitle}</strong>
          <p className="field-hint" style={{ marginTop: 6 }}>
            {t.emptyRootsBody}
          </p>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title={t.confirmTitle}
        body={t.confirmBody(
          selectionSummary.selectedCount,
          formatBytes(selectionSummary.selectedBytes),
          selectionSummary.affectedGroupCount,
        )}
        confirmLabel={t.confirmAccept}
        cancelLabel={t.confirmCancel}
        onConfirm={() => void handleConfirmRecycle()}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
