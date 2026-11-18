import { Copy, FolderOpen, RotateCcw, Square } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore } from "../../lib/sessionStore";
import {
  bindDisposableListener,
  formatLocalizedError,
  pickSingleFile,
  readDiffTextFile,
  subscribeFileDrop,
} from "../../lib/tauriBridge";
import {
  PreemptiveRegexController,
  type RegexControllerOutcome,
  type RegexWorkerLike,
} from "./regexController";
import {
  MAX_HIGHLIGHT_MATCHES,
  MAX_REGEX_MATCHES,
  MAX_REPLACEMENT_PREVIEW_CHARS,
  SUPPORTED_JS_REGEX_FLAGS,
  type JsRegexFlag,
  type RegexMatchRecord,
} from "./regexCore";

const MATCH_TABLE_BATCH = 200;

interface RegexTesterWorkspaceProps {
  workerFactory?: () => RegexWorkerLike;
  timeoutMs?: number;
}

function buildHighlightedNodes(text: string, matches: RegexMatchRecord[]) {
  if (text.length === 0) return null;
  const bounded = matches.slice(0, MAX_HIGHLIGHT_MATCHES);
  if (bounded.length === 0) {
    return text;
  }

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < bounded.length; i++) {
    const m = bounded[i]!;
    if (m.utf16Start < cursor) {
      continue;
    }
    if (m.utf16Start > cursor) {
      nodes.push(<span key={`plain-${i}`}>{text.slice(cursor, m.utf16Start)}</span>);
    }
    if (m.isZeroLength) {
      nodes.push(
        <span
          key={`zero-${i}`}
          className="regex-zero-mark"
          title={`#${m.matchNumber} [${m.utf16Start}, ${m.utf16End})`}
        />,
      );
      cursor = m.utf16End;
    } else {
      nodes.push(
        <mark key={`hit-${i}`} className="regex-highlight-mark">
          {text.slice(m.utf16Start, m.utf16End)}
        </mark>,
      );
      cursor = m.utf16End;
    }
  }

  if (cursor < text.length) {
    nodes.push(<span key="tail">{text.slice(cursor)}</span>);
  }
  return nodes;
}

export function RegexTesterWorkspace({ workerFactory, timeoutMs }: RegexTesterWorkspaceProps = {}) {
  const { t } = useI18n();
  const { session, updateRegexSession } = useSessionStore();
  const { pattern, flags, testText, sourceFileName, enableReplace, replacementTemplate } =
    session.regex;

  const patternId = useId();
  const flagsId = useId();
  const testTextId = useId();
  const replaceId = useId();

  const controllerRef = useRef<PreemptiveRegexController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new PreemptiveRegexController({
      timeoutMs,
      workerFactory,
    });
  }

  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<RegexControllerOutcome | null>(null);
  const [matchLimit, setMatchLimit] = useState(MATCH_TABLE_BATCH);
  const [copiedTarget, setCopiedTarget] = useState<"matches" | "replace" | null>(null);
  const [ioError, setIoError] = useState<string | null>(null);
  const [dropHover, setDropHover] = useState(false);

  const copyTimerRef = useRef<number | null>(null);
  const manualCancelRef = useRef(false);

  // Terminate Worker and timers cleanly on unmount
  useEffect(() => {
    const ctrl = controllerRef.current;
    return () => {
      ctrl?.dispose();
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  // Run dedicated Worker evaluation whenever pattern, flags, text, or replacement options change
  useEffect(() => {
    const ctrl = controllerRef.current!;
    manualCancelRef.current = false;
    setMatchLimit(MATCH_TABLE_BATCH);

    if (pattern.length === 0) {
      ctrl.cancelCurrent();
      setRunning(false);
      setOutcome({ kind: "completed", result: { status: "empty_pattern" } });
      return;
    }

    setRunning(true);
    setOutcome(null);

    let active = true;
    void ctrl
      .evaluate({
        pattern,
        flags,
        testText,
        enableReplace,
        replacementTemplate,
      })
      .then((res) => {
        if (!active) return;
        if (res.kind === "cancelled" && !manualCancelRef.current) {
          return;
        }
        setOutcome(res);
        setRunning(false);
      });

    return () => {
      active = false;
    };
  }, [pattern, flags, testText, enableReplace, replacementTemplate]);

  const handleStopWorker = () => {
    manualCancelRef.current = true;
    controllerRef.current?.cancelCurrent();
    setRunning(false);
    setOutcome({ kind: "cancelled" });
  };

  const toggleFlagPill = (flag: JsRegexFlag) => {
    if (flags.includes(flag)) {
      const next = Array.from(flags)
        .filter((ch) => ch !== flag)
        .join("");
      updateRegexSession({ flags: next });
    } else {
      updateRegexSession({ flags: `${flags}${flag}` });
    }
  };

  const loadTestTextFile = useCallback(
    async (path: string) => {
      setIoError(null);
      try {
        const loaded = await readDiffTextFile(path, "D08");
        updateRegexSession({
          testText: loaded.content,
          sourceFileName: loaded.fileName,
        });
      } catch (err) {
        setIoError(formatLocalizedError(err, t));
      }
    },
    [t, updateRegexSession],
  );

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: (hovering) => setDropHover(hovering),
          onDropPaths: (paths) => {
            const first = paths[0];
            if (first) {
              void loadTestTextFile(first);
            }
          },
        }),
      "regex-file-drop",
    );
  }, [loadTestTextFile]);

  const handleOpenFile = async () => {
    setIoError(null);
    const chosen = await pickSingleFile({
      title: t.regexTool.openTextFileBtn,
      filters: [
        { name: "Text & Logs", extensions: ["txt", "log", "md", "json", "csv", "ts", "js", "rs"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (chosen) {
      await loadTestTextFile(chosen);
    }
  };

  const handleClear = () => {
    manualCancelRef.current = false;
    controllerRef.current?.cancelCurrent();
    setIoError(null);
    setCopiedTarget(null);
    updateRegexSession({
      pattern: "",
      testText: "",
      sourceFileName: null,
      replacementTemplate: "",
    });
  };

  const okResult =
    outcome?.kind === "completed" && outcome.result.status === "ok" ? outcome.result : null;

  const highlightedPreview = useMemo(() => {
    if (!okResult) return testText;
    return buildHighlightedNodes(testText, okResult.matches);
  }, [okResult, testText]);

  const handleCopyMatches = async () => {
    if (!okResult || okResult.matches.length === 0) return;
    setIoError(null);
    const payload = okResult.matches.map((m) => m.value).join("\n");
    try {
      await navigator.clipboard.writeText(payload);
      setCopiedTarget("matches");
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedTarget(null), 1600);
    } catch (err) {
      setIoError(formatLocalizedError(err, t));
    }
  };

  const handleCopyReplacement = async () => {
    if (!okResult || okResult.replacementFull === null) return;
    setIoError(null);
    try {
      await navigator.clipboard.writeText(okResult.replacementFull);
      setCopiedTarget("replace");
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedTarget(null), 1600);
    } catch (err) {
      setIoError(formatLocalizedError(err, t));
    }
  };

  const statusBanner = (() => {
    if (running) {
      return { tone: "is-warn", role: "status" as const, text: t.regexTool.statusRunning };
    }
    if (!outcome) {
      return { tone: "", role: "status" as const, text: t.regexTool.statusEmptyPattern };
    }
    if (outcome.kind === "timeout") {
      return {
        tone: "is-err",
        role: "alert" as const,
        text: t.regexTool.statusTimeout(outcome.timeoutMs),
      };
    }
    if (outcome.kind === "cancelled") {
      return { tone: "is-warn", role: "status" as const, text: t.regexTool.statusCancelled };
    }
    if (outcome.kind === "worker_error") {
      return {
        tone: "is-err",
        role: "alert" as const,
        text: t.regexTool.statusWorkerError(outcome.message),
      };
    }
    const res = outcome.result;
    switch (res.status) {
      case "empty_pattern":
        return { tone: "", role: "status" as const, text: t.regexTool.statusEmptyPattern };
      case "invalid_regex":
        return {
          tone: "is-err",
          role: "alert" as const,
          text: t.regexTool.statusInvalidRegex(res.errorMessage),
        };
      case "input_too_large":
      case "replacement_too_large":
        return { tone: "is-err", role: "alert" as const, text: res.detail };
      case "ok":
        return res.totalMatchesCollected === 0
          ? { tone: "", role: "status" as const, text: t.regexTool.statusNoMatch(res.elapsedMs) }
          : {
              tone: "is-ok",
              role: "status" as const,
              text: t.regexTool.statusMatched(
                res.totalMatchesCollected,
                res.elapsedMs,
                res.matchesTruncated,
              ),
            };
    }
  })();

  return (
    <div className="tool-workspace">
      <div className="status-banner">
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <strong style={{ fontSize: 12.5 }}>{t.regexTool.engineBadge}</strong>
          <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>
            {t.regexTool.scopeNote}
          </span>
        </div>
        <div className="tool-toolbar-group">
          {running && (
            <button type="button" className="btn btn-danger" onClick={handleStopWorker}>
              <Square size={13} aria-hidden="true" />
              {t.regexTool.stopWorkerBtn}
            </button>
          )}
          <button
            type="button"
            className="btn"
            onClick={handleClear}
            disabled={!pattern && !testText && !replacementTemplate}
          >
            <RotateCcw size={14} aria-hidden="true" />
            {t.regexTool.clearBtn}
          </button>
        </div>
      </div>

      {ioError && (
        <div className="status-banner is-err" role="alert">
          <span>{ioError}</span>
        </div>
      )}

      {/* Pattern, Visible JS Flags & Optional Replacement Controls */}
      <div className="pane" style={{ flexShrink: 0 }}>
        <div
          style={{
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) auto",
              gap: 12,
              alignItems: "end",
            }}
          >
            <div className="field-stack">
              <label htmlFor={patternId} className="field-label">
                {t.regexTool.patternLabel}
              </label>
              <input
                id={patternId}
                type="text"
                className="text-input mono-inline"
                value={pattern}
                onChange={(e) => updateRegexSession({ pattern: e.target.value })}
                placeholder={t.regexTool.patternPlaceholder}
                spellCheck={false}
                autoComplete="off"
              />
            </div>

            <div className="field-stack">
              <label htmlFor={flagsId} className="field-label">
                {t.regexTool.flagsLabel}
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div className="flag-pill-group" role="group" aria-label={t.regexTool.flagsLabel}>
                  {SUPPORTED_JS_REGEX_FLAGS.map((f) => (
                    <button
                      key={f}
                      type="button"
                      className="flag-pill"
                      aria-pressed={flags.includes(f)}
                      onClick={() => toggleFlagPill(f)}
                      title={`Flag '${f}'`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
                <input
                  id={flagsId}
                  aria-label={t.regexTool.flagsInputAria}
                  type="text"
                  className="text-input mono-inline"
                  style={{ width: 82 }}
                  value={flags}
                  onChange={(e) => updateRegexSession({ flags: e.target.value })}
                  spellCheck={false}
                />
              </div>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={enableReplace}
                onChange={(e) => updateRegexSession({ enableReplace: e.target.checked })}
              />
              {t.regexTool.enableReplaceLabel}
            </label>
            <span className="field-hint">{t.regexTool.offsetUnitNote}</span>
          </div>

          {enableReplace && (
            <div className="field-stack">
              <label htmlFor={replaceId} className="field-label">
                {t.regexTool.replacementLabel}
              </label>
              <input
                id={replaceId}
                type="text"
                className="text-input mono-inline"
                value={replacementTemplate}
                onChange={(e) => updateRegexSession({ replacementTemplate: e.target.value })}
                placeholder={t.regexTool.replacementPlaceholder}
                spellCheck={false}
              />
              <p className="field-hint">{t.regexTool.replacementSyntaxHint}</p>
            </div>
          )}
        </div>
      </div>

      {/* Execution Status Banner */}
      <div
        className={`status-banner ${statusBanner.tone}`.trim()}
        role={statusBanner.role}
        data-testid="regex-status-banner"
      >
        <span>{statusBanner.text}</span>
        {okResult && (
          <div className="tool-toolbar-group">
            <button
              type="button"
              className="btn"
              disabled={okResult.matches.length === 0}
              onClick={() => void handleCopyMatches()}
            >
              <Copy size={14} aria-hidden="true" />
              {copiedTarget === "matches" ? t.regexTool.copiedBadge : t.regexTool.copyMatchesBtn}
            </button>
            {enableReplace && okResult.replacementFull !== null && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void handleCopyReplacement()}
              >
                <Copy size={14} aria-hidden="true" />
                {copiedTarget === "replace"
                  ? t.regexTool.copiedBadge
                  : t.regexTool.copyReplacementBtn}
              </button>
            )}
          </div>
        )}
      </div>

      {okResult?.matchesTruncated && (
        <div className="status-banner is-warn" role="status">
          <span>{t.regexTool.matchesTruncatedWarn(MAX_REGEX_MATCHES)}</span>
        </div>
      )}
      {okResult?.highlightTruncated && (
        <div className="status-banner is-warn" role="status">
          <span>{t.regexTool.highlightTruncatedWarn(MAX_HIGHLIGHT_MATCHES)}</span>
        </div>
      )}

      {/* Main Split Workspace: Left = Test Text + Highlight Preview; Right = Match Table & Replacement Preview */}
      <div className="split-panes" style={{ minHeight: 320 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <div className={`pane ${dropHover ? "is-drop-hover" : ""}`} style={{ flex: 1 }}>
            <div className="pane-header">
              <label htmlFor={testTextId} className="pane-title">
                {t.regexTool.testTextLabel}
                {sourceFileName ? ` · ${sourceFileName}` : ""}
              </label>
              <button type="button" className="btn" onClick={() => void handleOpenFile()}>
                <FolderOpen size={14} aria-hidden="true" />
                {t.regexTool.openTextFileBtn}
              </button>
            </div>
            <textarea
              id={testTextId}
              className="code-editor"
              style={{ minHeight: 140 }}
              value={testText}
              onChange={(e) => updateRegexSession({ testText: e.target.value })}
              placeholder={t.regexTool.testTextPlaceholder}
              spellCheck={false}
            />
          </div>

          <div className="pane" style={{ flex: 1 }}>
            <div className="pane-header">
              <span className="pane-title">{t.regexTool.highlightPaneTitle}</span>
            </div>
            <pre
              className="mono-block"
              style={{ flex: 1, minHeight: 110 }}
              data-testid="regex-highlight-preview"
            >
              {highlightedPreview}
            </pre>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <div className="pane" style={{ flex: 1, minHeight: 160 }}>
            <div className="pane-header">
              <span className="pane-title">{t.regexTool.matchesPaneTitle}</span>
            </div>
            <div style={{ flex: 1, overflow: "auto" }}>
              <table className="kv-table" data-testid="regex-matches-table">
                <thead>
                  <tr>
                    <th style={{ width: 44 }}>{t.regexTool.colMatchNum}</th>
                    <th>{t.regexTool.colMatchText}</th>
                    <th style={{ width: 112 }}>{t.regexTool.colUtf16Range}</th>
                    <th style={{ width: 84 }}>{t.regexTool.colLineCol}</th>
                    <th>{t.regexTool.colCaptures}</th>
                  </tr>
                </thead>
                <tbody>
                  {(okResult?.matches ?? []).slice(0, matchLimit).map((m) => (
                    <tr key={m.matchNumber}>
                      <td className="mono-inline">{m.matchNumber}</td>
                      <td className="mono-inline">
                        {m.isZeroLength ? (
                          <span className="badge">{t.regexTool.zeroLengthBadge}</span>
                        ) : (
                          m.value
                        )}
                      </td>
                      <td className="mono-inline">
                        [{m.utf16Start}, {m.utf16End})
                      </td>
                      <td className="mono-inline">
                        {m.line}:{m.utf16Column}
                      </td>
                      <td>
                        {m.captures.length === 0 ? (
                          <span style={{ color: "var(--text-muted)" }}>—</span>
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                            {m.captures.map((cap) => (
                              <div key={cap.index} className="mono-inline">
                                <span className="badge" style={{ marginRight: 6 }}>
                                  ${cap.index}
                                  {cap.name ? ` ($<${cap.name}>)` : ""}
                                </span>
                                {cap.matched ? (
                                  cap.value
                                ) : (
                                  <span style={{ color: "var(--text-muted)" }}>
                                    ({t.regexTool.unmatchedGroupBadge})
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {okResult && okResult.matches.length > matchLimit && (
                <div style={{ padding: 8, textAlign: "center" }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setMatchLimit((prev) => prev + MATCH_TABLE_BATCH)}
                  >
                    {matchLimit} / {okResult.matches.length}
                  </button>
                </div>
              )}
            </div>
          </div>

          {enableReplace && (
            <div className="pane" style={{ flex: 1, minHeight: 130 }}>
              <div className="pane-header">
                <span className="pane-title">{t.regexTool.replacementPaneTitle}</span>
              </div>
              {okResult?.replacementPreviewTruncated && okResult.replacementFull && (
                <div className="status-banner is-warn" style={{ borderRadius: 0 }}>
                  <span>
                    {t.regexTool.replacePreviewTruncatedWarn(
                      MAX_REPLACEMENT_PREVIEW_CHARS,
                      okResult.replacementFull.length,
                    )}
                  </span>
                </div>
              )}
              <pre
                className="mono-block"
                style={{ flex: 1 }}
                data-testid="regex-replacement-preview"
              >
                {okResult?.replacementPreview ?? ""}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
