import {
  ArrowLeftRight,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  FolderOpen,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore } from "../../lib/sessionStore";
import {
  bindDisposableListener,
  formatLocalizedError,
  parseBackendError,
  pickSaveFilePath,
  pickSingleFile,
  readDiffTextFile,
  saveLocalTextFile,
  subscribeFileDrop,
  suggestSafeSiblingPath,
} from "../../lib/tauriBridge";
import { CancellableDiffController } from "./diffController";
import {
  analyzeAndSplitLines,
  type DiffComputationResult,
  type DiffDisplayLine,
  type IntraLineSpan,
  type SideBySideRow,
  type TextEncodingMeta,
} from "./diffEngine";

const ROW_RENDER_BATCH = 600;

function renderCodeSpans(text: string, spans: IntraLineSpan[] | undefined, kind: "del" | "ins") {
  if (!spans || spans.length === 0) {
    return text;
  }
  const cls = kind === "del" ? "diff-span-del" : "diff-span-ins";
  return spans.map((span, idx) =>
    span.changed ? (
      <mark key={idx} className={cls}>
        {span.text}
      </mark>
    ) : (
      <span key={idx}>{span.text}</span>
    ),
  );
}

export function DiffCheckerWorkspace() {
  const { t } = useI18n();
  const { session, updateDiffSession } = useSessionStore();
  const {
    leftText,
    rightText,
    leftFilePath,
    leftFileName,
    rightFilePath,
    rightFileName,
    viewMode,
    ignoreWhitespace,
    ignoreCase,
    dropTargetSide,
    inputsCollapsed,
  } = session.diff;

  const controllerRef = useRef<CancellableDiffController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new CancellableDiffController();
  }

  const [computing, setComputing] = useState(false);
  const [diffResult, setDiffResult] = useState<DiffComputationResult | null>(null);
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [activeHunkIndex, setActiveHunkIndex] = useState<number>(0);
  const [rowLimit, setRowLimit] = useState<number>(ROW_RENDER_BATCH);
  const [recompareTick, setRecompareTick] = useState(0);

  const [dropHover, setDropHover] = useState(false);
  const [copiedPatch, setCopiedPatch] = useState(false);
  const [ioMessage, setIoMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [pendingOverwritePath, setPendingOverwritePath] = useState<string | null>(null);

  const dropTargetSideRef = useRef(dropTargetSide);
  dropTargetSideRef.current = dropTargetSide;

  const copyTimerRef = useRef<number | null>(null);
  const hunkRowRefs = useRef<Map<number, HTMLTableRowElement>>(new Map());

  // Clean up Worker and timers on unmount
  useEffect(() => {
    const ctrl = controllerRef.current;
    return () => {
      ctrl?.dispose();
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  // Run cancellable diff whenever inputs, options, or explicit recompare trigger changes
  useEffect(() => {
    const ctrl = controllerRef.current!;
    setComputing(true);
    setDiffResult(null);
    setExpandedIds({});
    setActiveHunkIndex(0);
    setRowLimit(ROW_RENDER_BATCH);

    let active = true;
    void ctrl
      .runDiff({
        leftText,
        rightText,
        options: { ignoreWhitespace, ignoreCase },
        leftLabel: leftFileName ?? "left.txt",
        rightLabel: rightFileName ?? "right.txt",
      })
      .then((outcome) => {
        if (!active) return;
        if (outcome.kind === "completed") {
          setDiffResult(outcome.result);
          setComputing(false);
        } else if (outcome.kind === "worker_error") {
          setIoMessage({ kind: "err", text: outcome.message });
          setComputing(false);
        }
      });

    return () => {
      active = false;
      ctrl.cancelCurrent();
    };
  }, [
    leftText,
    rightText,
    ignoreWhitespace,
    ignoreCase,
    leftFileName,
    rightFileName,
    recompareTick,
  ]);

  const leftQuickMeta = useMemo((): TextEncodingMeta => {
    if (diffResult?.status === "ok") return diffResult.leftMeta;
    return analyzeAndSplitLines(leftText).meta;
  }, [diffResult, leftText]);

  const rightQuickMeta = useMemo((): TextEncodingMeta => {
    if (diffResult?.status === "ok") return diffResult.rightMeta;
    return analyzeAndSplitLines(rightText).meta;
  }, [diffResult, rightText]);

  const loadSideFromFile = useCallback(
    async (side: "left" | "right", path: string) => {
      const payload = await readDiffTextFile(path, "D07");
      if (side === "left") {
        updateDiffSession({
          leftText: payload.content,
          leftFilePath: payload.path,
          leftFileName: payload.fileName,
        });
      } else {
        updateDiffSession({
          rightText: payload.content,
          rightFilePath: payload.path,
          rightFileName: payload.fileName,
        });
      }
      return payload.fileName;
    },
    [updateDiffSession],
  );

  // Native file drag-and-drop: 1 file -> active target side; >=2 files -> deterministic Left=0, Right=1
  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: (hovering) => setDropHover(hovering),
          onDropPaths: (paths) => {
            if (paths.length === 0) return;
            setIoMessage(null);
            if (paths.length === 1) {
              const target = dropTargetSideRef.current;
              void loadSideFromFile(target, paths[0]!).catch((err) => {
                setIoMessage({ kind: "err", text: formatLocalizedError(err, t) });
              });
              return;
            }
            const [firstPath, secondPath] = paths;
            if (!firstPath || !secondPath) return;
            void (async () => {
              try {
                const leftLoaded = await readDiffTextFile(firstPath, "D07");
                const rightLoaded = await readDiffTextFile(secondPath, "D07");
                updateDiffSession({
                  leftText: leftLoaded.content,
                  leftFilePath: leftLoaded.path,
                  leftFileName: leftLoaded.fileName,
                  rightText: rightLoaded.content,
                  rightFilePath: rightLoaded.path,
                  rightFileName: rightLoaded.fileName,
                });
                setIoMessage({
                  kind: "ok",
                  text: t.diffTool.droppedTwoFilesInfo(
                    leftLoaded.fileName,
                    rightLoaded.fileName,
                    paths.length > 2,
                  ),
                });
              } catch (err) {
                setIoMessage({ kind: "err", text: formatLocalizedError(err, t) });
              }
            })();
          },
        }),
      "diff-file-drop",
    );
  }, [loadSideFromFile, t, updateDiffSession]);

  const handleOpenFile = async (side: "left" | "right") => {
    setIoMessage(null);
    const chosen = await pickSingleFile({
      title: side === "left" ? t.diffTool.openLeftBtn : t.diffTool.openRightBtn,
      filters: [
        {
          name: "Text & Code",
          extensions: [
            "txt",
            "md",
            "json",
            "yaml",
            "yml",
            "toml",
            "xml",
            "html",
            "css",
            "ts",
            "tsx",
            "js",
            "rs",
            "py",
            "csv",
            "log",
          ],
        },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (!chosen) return;
    try {
      await loadSideFromFile(side, chosen);
    } catch (err) {
      setIoMessage({ kind: "err", text: formatLocalizedError(err, t) });
    }
  };

  const handleSwap = () => {
    setIoMessage(null);
    updateDiffSession({
      leftText: rightText,
      rightText: leftText,
      leftFilePath: rightFilePath,
      leftFileName: rightFileName,
      rightFilePath: leftFilePath,
      rightFileName: leftFileName,
    });
  };

  const handleClear = () => {
    setIoMessage(null);
    setCopiedPatch(false);
    updateDiffSession({
      leftText: "",
      rightText: "",
      leftFilePath: null,
      leftFileName: null,
      rightFilePath: null,
      rightFileName: null,
    });
  };

  const handleCopyPatch = async () => {
    if (diffResult?.status !== "ok" || !diffResult.exactUnifiedPatch) return;
    setIoMessage(null);
    try {
      await navigator.clipboard.writeText(diffResult.exactUnifiedPatch);
      setCopiedPatch(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => setCopiedPatch(false), 1600);
    } catch (err) {
      setIoMessage({ kind: "err", text: formatLocalizedError(err, t) });
    }
  };

  const executeSavePatch = async (targetPath: string, overwrite: boolean) => {
    if (diffResult?.status !== "ok" || !diffResult.exactUnifiedPatch) return;
    setIoMessage(null);
    try {
      const saved = await saveLocalTextFile({
        outputPath: targetPath,
        sourcePath: leftFilePath,
        secondarySourcePath: rightFilePath,
        content: diffResult.exactUnifiedPatch,
        overwrite,
        toolId: "D07",
      });
      setIoMessage({
        kind: "ok",
        text: t.diffTool.savedPatchSuccess(saved.path),
      });
    } catch (err) {
      const parsed = parseBackendError(err);
      if (parsed.code === "TARGET_ALREADY_EXISTS" && !overwrite) {
        setPendingOverwritePath(targetPath);
        return;
      }
      setIoMessage({
        kind: "err",
        text: formatLocalizedError(err, t),
      });
    }
  };

  const handleSavePatchAs = async () => {
    if (diffResult?.status !== "ok" || !diffResult.exactUnifiedPatch) return;
    const baseSource = rightFilePath ?? leftFilePath;
    const defaultPath = baseSource
      ? ((await suggestSafeSiblingPath(baseSource, ".changes", "patch")) ?? undefined)
      : "changes.patch";
    const chosen = await pickSaveFilePath({
      title: t.diffTool.savePatchBtn,
      defaultPath,
      filters: [
        { name: "Unified Diff Patch", extensions: ["patch", "diff"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (chosen) {
      await executeSavePatch(chosen, false);
    }
  };

  // Flatten blocks into renderable items so we can bound DOM node count cleanly while supporting hunk jump
  const flattenedInlineItems = useMemo(() => {
    if (diffResult?.status !== "ok") return [];
    const items: Array<
      | {
          itemType: "line";
          key: string;
          isFirstInHunk: boolean;
          line: DiffDisplayLine;
        }
      | { itemType: "collapsed"; collapseId: string; hiddenCount: number }
    > = [];

    for (let b = 0; b < diffResult.inlineBlocks.length; b++) {
      const block = diffResult.inlineBlocks[b]!;
      if (block.blockType === "collapsed" && !expandedIds[block.collapseId]) {
        items.push({
          itemType: "collapsed",
          collapseId: block.collapseId,
          hiddenCount: block.hiddenCount,
        });
      } else {
        for (let i = 0; i < block.lines.length; i++) {
          items.push({
            itemType: "line",
            key: `in-${b}-${i}`,
            isFirstInHunk: block.blockType === "lines" && block.hunkIndex !== null && i === 0,
            line: block.lines[i]!,
          });
        }
      }
    }
    return items;
  }, [diffResult, expandedIds]);

  const flattenedSbsItems = useMemo(() => {
    if (diffResult?.status !== "ok") return [];
    const items: Array<
      | {
          itemType: "row";
          key: string;
          isFirstInHunk: boolean;
          row: SideBySideRow;
        }
      | { itemType: "collapsed"; collapseId: string; hiddenCount: number }
    > = [];

    for (let b = 0; b < diffResult.sideBySideBlocks.length; b++) {
      const block = diffResult.sideBySideBlocks[b]!;
      if (block.blockType === "collapsed" && !expandedIds[block.collapseId]) {
        items.push({
          itemType: "collapsed",
          collapseId: block.collapseId,
          hiddenCount: block.hiddenCount,
        });
      } else {
        for (let i = 0; i < block.rows.length; i++) {
          items.push({
            itemType: "row",
            key: `sbs-${b}-${i}`,
            isFirstInHunk: block.blockType === "rows" && block.hunkIndex !== null && i === 0,
            row: block.rows[i]!,
          });
        }
      }
    }
    return items;
  }, [diffResult, expandedIds]);

  const jumpToHunk = (targetHunk: number) => {
    if (diffResult?.status !== "ok" || diffResult.summary.hunkCount === 0) return;
    const clamped =
      ((targetHunk % diffResult.summary.hunkCount) + diffResult.summary.hunkCount) %
      diffResult.summary.hunkCount;
    setActiveHunkIndex(clamped);

    // Ensure rowLimit covers the target hunk
    if (viewMode === "inline") {
      const idx = flattenedInlineItems.findIndex(
        (it) => it.itemType === "line" && it.isFirstInHunk && it.line.hunkIndex === clamped,
      );
      if (idx >= rowLimit) {
        setRowLimit(idx + ROW_RENDER_BATCH);
      }
    } else {
      const idx = flattenedSbsItems.findIndex(
        (it) => it.itemType === "row" && it.isFirstInHunk && it.row.hunkIndex === clamped,
      );
      if (idx >= rowLimit) {
        setRowLimit(idx + ROW_RENDER_BATCH);
      }
    }

    window.requestAnimationFrame(() => {
      const el = hunkRowRefs.current.get(clamped);
      el?.scrollIntoView?.({ block: "center", behavior: "instant" as ScrollBehavior });
    });
  };

  const renderMetaBadges = (meta: TextEncodingMeta) => (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <span className="badge">{meta.lineCount} lines</span>
      {meta.lineEnding !== "none" && <span className="badge">{meta.lineEnding.toUpperCase()}</span>}
      {meta.hasBom && <span className="badge badge-partial">{t.diffTool.bomBadge}</span>}
      {meta.lineCount > 0 && !meta.hasTrailingNewline && (
        <span className="badge">{t.diffTool.noEofNewlineBadge}</span>
      )}
    </div>
  );

  const renderEolTag = (eol: "\r\n" | "\n" | "", hasBom: boolean) => (
    <>
      {hasBom && (
        <span className="badge badge-partial" style={{ marginRight: 6 }}>
          BOM
        </span>
      )}
      {eol === "\r\n" && (
        <span className="badge" style={{ marginLeft: 6 }}>
          CRLF
        </span>
      )}
      {eol === "" && (
        <span className="badge" style={{ marginLeft: 6 }}>
          {t.diffTool.noEofNewlineBadge}
        </span>
      )}
    </>
  );

  const hunkCount = diffResult?.status === "ok" ? diffResult.summary.hunkCount : 0;
  const hasPatch = diffResult?.status === "ok" && diffResult.exactUnifiedPatch.length > 0;

  return (
    <div className="tool-workspace">
      <div className="status-banner">
        <span>{t.diffTool.scopeNote}</span>
        <div className="tool-toolbar-group">
          <button
            type="button"
            className="btn"
            onClick={() => updateDiffSession({ inputsCollapsed: !inputsCollapsed })}
          >
            {inputsCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            {inputsCollapsed ? t.diffTool.toggleInputsShow : t.diffTool.toggleInputsHide}
          </button>
          <button type="button" className="btn" onClick={handleSwap}>
            <ArrowLeftRight size={14} aria-hidden="true" />
            {t.diffTool.swapBtn}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setRecompareTick((prev) => prev + 1)}
          >
            <RefreshCw size={14} aria-hidden="true" />
            {t.diffTool.recompareBtn}
          </button>
          <button
            type="button"
            className="btn"
            onClick={handleClear}
            disabled={!leftText && !rightText && !leftFilePath && !rightFilePath}
          >
            <RotateCcw size={14} aria-hidden="true" />
            {t.diffTool.clearBtn}
          </button>
        </div>
      </div>

      {ioMessage && (
        <div
          className={`status-banner ${ioMessage.kind === "ok" ? "is-ok" : "is-err"}`}
          role={ioMessage.kind === "err" ? "alert" : "status"}
        >
          <span>{ioMessage.text}</span>
        </div>
      )}

      {/* Input Editors (Collapsible so Diff Result always owns the main workspace) */}
      {!inputsCollapsed && (
        <div className="split-panes" style={{ flex: "0 0 auto", minHeight: 168 }}>
          <div className={`pane ${dropHover && dropTargetSide === "left" ? "is-drop-hover" : ""}`}>
            <div className="pane-header">
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span className="pane-title">
                  {t.diffTool.leftTitle}
                  {leftFileName ? ` · ${leftFileName}` : ""}
                </span>
                {renderMetaBadges(leftQuickMeta)}
              </div>
              <button type="button" className="btn" onClick={() => void handleOpenFile("left")}>
                <FolderOpen size={14} aria-hidden="true" />
                {t.diffTool.openLeftBtn}
              </button>
            </div>
            <textarea
              aria-label={t.diffTool.leftTitle}
              className="code-editor"
              style={{ minHeight: 118, maxHeight: 148 }}
              value={leftText}
              onFocus={() => updateDiffSession({ dropTargetSide: "left" })}
              onChange={(e) => updateDiffSession({ leftText: e.target.value })}
              placeholder={t.diffTool.leftPlaceholder}
              spellCheck={false}
            />
          </div>

          <div className={`pane ${dropHover && dropTargetSide === "right" ? "is-drop-hover" : ""}`}>
            <div className="pane-header">
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span className="pane-title">
                  {t.diffTool.rightTitle}
                  {rightFileName ? ` · ${rightFileName}` : ""}
                </span>
                {renderMetaBadges(rightQuickMeta)}
              </div>
              <button type="button" className="btn" onClick={() => void handleOpenFile("right")}>
                <FolderOpen size={14} aria-hidden="true" />
                {t.diffTool.openRightBtn}
              </button>
            </div>
            <textarea
              aria-label={t.diffTool.rightTitle}
              className="code-editor"
              style={{ minHeight: 118, maxHeight: 148 }}
              value={rightText}
              onFocus={() => updateDiffSession({ dropTargetSide: "right" })}
              onChange={(e) => updateDiffSession({ rightText: e.target.value })}
              placeholder={t.diffTool.rightPlaceholder}
              spellCheck={false}
            />
          </div>
        </div>
      )}

      {/* Comparison Options, Hunk Navigation & Patch Export Toolbar */}
      <div className="tool-toolbar" style={{ paddingBottom: 8 }}>
        <div className="tool-toolbar-group">
          <div className="segmented" role="group" aria-label="Diff view mode">
            <button
              type="button"
              className="segmented-btn"
              aria-pressed={viewMode === "side_by_side"}
              onClick={() => updateDiffSession({ viewMode: "side_by_side" })}
            >
              {t.diffTool.viewSideBySide}
            </button>
            <button
              type="button"
              className="segmented-btn"
              aria-pressed={viewMode === "inline"}
              onClick={() => updateDiffSession({ viewMode: "inline" })}
            >
              {t.diffTool.viewInline}
            </button>
          </div>

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={ignoreWhitespace}
              onChange={(e) => updateDiffSession({ ignoreWhitespace: e.target.checked })}
            />
            {t.diffTool.ignoreWhitespaceLabel}
          </label>

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={ignoreCase}
              onChange={(e) => updateDiffSession({ ignoreCase: e.target.checked })}
            />
            {t.diffTool.ignoreCaseLabel}
          </label>

          <div className="segmented" role="group" aria-label={t.diffTool.dropSideLabel}>
            <button
              type="button"
              className="segmented-btn"
              aria-pressed={dropTargetSide === "left"}
              onClick={() => updateDiffSession({ dropTargetSide: "left" })}
            >
              {t.diffTool.dropSideLeft}
            </button>
            <button
              type="button"
              className="segmented-btn"
              aria-pressed={dropTargetSide === "right"}
              onClick={() => updateDiffSession({ dropTargetSide: "right" })}
            >
              {t.diffTool.dropSideRight}
            </button>
          </div>
        </div>

        <div className="tool-toolbar-group">
          {hunkCount > 0 && (
            <>
              <span className="badge">
                {t.diffTool.hunkIndicator(activeHunkIndex + 1, hunkCount)}
              </span>
              <button type="button" className="btn" onClick={() => jumpToHunk(activeHunkIndex - 1)}>
                {t.diffTool.prevHunkBtn}
              </button>
              <button type="button" className="btn" onClick={() => jumpToHunk(activeHunkIndex + 1)}>
                {t.diffTool.nextHunkBtn}
              </button>
            </>
          )}

          <button
            type="button"
            className="btn"
            disabled={!hasPatch}
            onClick={() => void handleCopyPatch()}
          >
            <Copy size={14} aria-hidden="true" />
            {copiedPatch ? t.diffTool.copiedBadge : t.diffTool.copyPatchBtn}
          </button>

          <button
            type="button"
            className="btn btn-primary"
            disabled={!hasPatch}
            onClick={() => void handleSavePatchAs()}
          >
            <Download size={14} aria-hidden="true" />
            {t.diffTool.savePatchBtn}
          </button>
        </div>
      </div>

      {/* Filter vs Exact Patch Clarity Notice */}
      {(ignoreWhitespace || ignoreCase) && (
        <div className="status-banner is-warn" role="status">
          <span>{t.diffTool.filterPatchNotice}</span>
        </div>
      )}

      {diffResult?.status === "ok" && diffResult.summary.usedFallbackLargeEdit && (
        <div className="status-banner is-warn" role="status">
          <span>{t.diffTool.fallbackLargeEditNotice}</span>
        </div>
      )}

      {/* Main Diff Result Workspace */}
      {computing ? (
        <div className="status-banner">{t.diffTool.statusComputing}</div>
      ) : diffResult?.status === "error" ? (
        <div className="status-banner is-err" role="alert">
          <span>{diffResult.detail}</span>
        </div>
      ) : diffResult?.status === "ok" ? (
        <div className="pane" style={{ flex: 1, minHeight: 280 }}>
          <div className="pane-header">
            <span className="pane-title" data-testid="diff-summary-banner">
              {diffResult.summary.exactIdentical
                ? t.diffTool.statusExactIdentical(diffResult.leftMeta.lineCount)
                : diffResult.summary.displayIdentical
                  ? t.diffTool.statusFilteredIdenticalRawDiffers
                  : t.diffTool.statusDiffSummary(
                      diffResult.summary.hunkCount,
                      diffResult.summary.addedLines,
                      diffResult.summary.deletedLines,
                    )}
            </span>
          </div>

          {diffResult.leftMeta.lineCount === 0 && diffResult.rightMeta.lineCount === 0 ? (
            <div className="empty-state" style={{ margin: 16 }}>
              {t.diffTool.emptyDiffHint}
            </div>
          ) : viewMode === "inline" ? (
            <div className="diff-viewport" data-testid="diff-inline-view">
              <table className="diff-table">
                <tbody>
                  {flattenedInlineItems.slice(0, rowLimit).map((item) => {
                    if (item.itemType === "collapsed") {
                      return (
                        <tr key={item.collapseId} className="diff-collapse-row">
                          <td colSpan={4}>
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={() =>
                                setExpandedIds((prev) => ({
                                  ...prev,
                                  [item.collapseId]: true,
                                }))
                              }
                            >
                              {t.diffTool.expandContextBtn(item.hiddenCount)}
                            </button>
                          </td>
                        </tr>
                      );
                    }
                    const { line } = item;
                    const rowCls =
                      line.kind === "delete"
                        ? "diff-line-del"
                        : line.kind === "insert"
                          ? "diff-line-ins"
                          : "";
                    const sym = line.kind === "delete" ? "-" : line.kind === "insert" ? "+" : " ";
                    const isActiveHunk = item.isFirstInHunk && line.hunkIndex === activeHunkIndex;

                    return (
                      <tr
                        key={item.key}
                        ref={(el) => {
                          if (item.isFirstInHunk && line.hunkIndex !== null) {
                            if (el) hunkRowRefs.current.set(line.hunkIndex, el);
                            else hunkRowRefs.current.delete(line.hunkIndex);
                          }
                        }}
                        className={`${rowCls} ${isActiveHunk ? "diff-hunk-active" : ""}`.trim()}
                      >
                        <td className="diff-gutter-num">{line.leftLineNumber ?? ""}</td>
                        <td className="diff-gutter-num">{line.rightLineNumber ?? ""}</td>
                        <td className="diff-gutter-sym">{sym}</td>
                        <td className="diff-cell-code">
                          {line.kind === "equal"
                            ? line.text
                            : renderCodeSpans(
                                line.text,
                                line.spans,
                                line.kind === "delete" ? "del" : "ins",
                              )}
                          {line.kind !== "equal" && renderEolTag(line.eol, line.hasLeadingBom)}
                        </td>
                      </tr>
                    );
                  })}
                  {flattenedInlineItems.length > rowLimit && (
                    <tr className="diff-collapse-row">
                      <td colSpan={4}>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setRowLimit((prev) => prev + ROW_RENDER_BATCH)}
                        >
                          {t.diffTool.showMoreRowsBtn(rowLimit, flattenedInlineItems.length)}
                        </button>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="diff-viewport" data-testid="diff-sbs-view">
              <table className="diff-table" style={{ minWidth: 720 }}>
                <tbody>
                  {flattenedSbsItems.slice(0, rowLimit).map((item) => {
                    if (item.itemType === "collapsed") {
                      return (
                        <tr key={item.collapseId} className="diff-collapse-row">
                          <td colSpan={6}>
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={() =>
                                setExpandedIds((prev) => ({
                                  ...prev,
                                  [item.collapseId]: true,
                                }))
                              }
                            >
                              {t.diffTool.expandContextBtn(item.hiddenCount)}
                            </button>
                          </td>
                        </tr>
                      );
                    }

                    const { row } = item;
                    const leftCls = !row.left
                      ? "diff-line-empty"
                      : row.left.kind === "delete"
                        ? "diff-line-del"
                        : "";
                    const rightCls = !row.right
                      ? "diff-line-empty"
                      : row.right.kind === "insert"
                        ? "diff-line-ins"
                        : "";
                    const isActiveHunk = item.isFirstInHunk && row.hunkIndex === activeHunkIndex;

                    return (
                      <tr
                        key={item.key}
                        ref={(el) => {
                          if (item.isFirstInHunk && row.hunkIndex !== null) {
                            if (el) hunkRowRefs.current.set(row.hunkIndex, el);
                            else hunkRowRefs.current.delete(row.hunkIndex);
                          }
                        }}
                        className={isActiveHunk ? "diff-hunk-active" : undefined}
                      >
                        <td className={`diff-gutter-num ${leftCls}`}>
                          {row.left?.lineNumber ?? ""}
                        </td>
                        <td className={`diff-gutter-sym ${leftCls}`}>
                          {!row.left ? "" : row.left.kind === "delete" ? "-" : " "}
                        </td>
                        <td
                          className={`diff-cell-code ${leftCls}`}
                          style={{ borderRight: "1px solid var(--border-subtle)" }}
                        >
                          {row.left
                            ? row.left.kind === "delete"
                              ? renderCodeSpans(row.left.text, row.left.spans, "del")
                              : row.left.text
                            : ""}
                          {row.left?.kind === "delete" &&
                            renderEolTag(row.left.eol, row.left.hasLeadingBom)}
                        </td>

                        <td className={`diff-gutter-num ${rightCls}`}>
                          {row.right?.lineNumber ?? ""}
                        </td>
                        <td className={`diff-gutter-sym ${rightCls}`}>
                          {!row.right ? "" : row.right.kind === "insert" ? "+" : " "}
                        </td>
                        <td className={`diff-cell-code ${rightCls}`}>
                          {row.right
                            ? row.right.kind === "insert"
                              ? renderCodeSpans(row.right.text, row.right.spans, "ins")
                              : row.right.text
                            : ""}
                          {row.right?.kind === "insert" &&
                            renderEolTag(row.right.eol, row.right.hasLeadingBom)}
                        </td>
                      </tr>
                    );
                  })}
                  {flattenedSbsItems.length > rowLimit && (
                    <tr className="diff-collapse-row">
                      <td colSpan={6}>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setRowLimit((prev) => prev + ROW_RENDER_BATCH)}
                        >
                          {t.diffTool.showMoreRowsBtn(rowLimit, flattenedSbsItems.length)}
                        </button>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      <ConfirmDialog
        open={pendingOverwritePath !== null}
        title={t.diffTool.overwriteConfirmTitle}
        body={t.diffTool.overwriteConfirmBody(pendingOverwritePath ?? "")}
        confirmLabel={t.diffTool.overwriteConfirmAccept}
        cancelLabel={t.diffTool.cancel}
        onCancel={() => setPendingOverwritePath(null)}
        onConfirm={() => {
          const path = pendingOverwritePath;
          setPendingOverwritePath(null);
          if (path) {
            void executeSavePatch(path, true);
          }
        }}
      />
    </div>
  );
}
