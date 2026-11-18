import { Check, ClipboardCheck, ClipboardPaste, Copy, Eraser, Sparkles } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore } from "../../lib/sessionStore";
import {
  formatLocalizedError,
  readSystemClipboardText,
  writeSystemClipboardText,
} from "../../lib/tauriBridge";
import {
  cleanLinksBatch,
  evaluateClipboardLinksOnlyReplace,
  type UnwrapStopReason,
} from "./linkCleanerEngine";
import { CLEAN_LINKS_RULES_VERSION } from "./linkRules";

const SYNTHETIC_SAMPLE_LINKS = [
  "https://shop.example.com/products/desk-lamp?id=42&q=warm+light%202700k&tag=%2B%252F~&utm_source=newsletter&utm_medium=email&fbclid=IwAR0SyntheticTest123#specs",
  "https://www.google.com/url?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ%26t%3D42s%26si%3DShareTracker99%26utm_campaign%3Dspring&sa=t&usg=AOvVaw000",
  "https://storage.example.com/report.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE&X-Amz-Signature=deadbeef0123&utm_source=keep_signed_intact",
].join("\n");

const INITIAL_RENDER_LIMIT = 200;

export function CleanLinksWorkspace() {
  const { t } = useI18n();
  const { session, updateCleanLinksSession } = useSessionStore();
  const { inputText } = session.cleanLinks;
  const inputId = useId();
  const cleanSummaryId = useId();

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [clipboardFeedback, setClipboardFeedback] = useState<{
    tone: "ok" | "warn" | "err";
    text: string;
  } | null>(null);
  const [renderLimit, setRenderLimit] = useState<number>(INITIAL_RENDER_LIMIT);

  const batchResult = useMemo(() => cleanLinksBatch(inputText), [inputText]);

  const markCopied = (key: string) => {
    setCopiedKey(key);
    window.setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 1500);
  };

  const handleCopyText = async (text: string, key: string) => {
    try {
      await writeSystemClipboardText(text);
      markCopied(key);
    } catch (err) {
      setClipboardFeedback({
        tone: "err",
        text: formatLocalizedError(err, t),
      });
    }
  };

  const handleReadClipboardPreview = async () => {
    setClipboardFeedback(null);
    try {
      const clip = await readSystemClipboardText();
      if (clip.trim().length === 0) {
        setClipboardFeedback({ tone: "warn", text: t.cleanLinksTool.clipboardReadEmpty });
        return;
      }
      setRenderLimit(INITIAL_RENDER_LIMIT);
      updateCleanLinksSession({ inputText: clip });
      setClipboardFeedback({ tone: "ok", text: t.cleanLinksTool.clipboardLoadedPreview });
    } catch (err) {
      setClipboardFeedback({ tone: "err", text: formatLocalizedError(err, t) });
    }
  };

  const handleOneClickReplaceClipboard = async () => {
    setClipboardFeedback(null);
    try {
      const clip = await readSystemClipboardText();
      const evaluated = evaluateClipboardLinksOnlyReplace(clip);
      if (!evaluated.canReplace) {
        if (evaluated.reason === "empty") {
          setClipboardFeedback({ tone: "warn", text: t.cleanLinksTool.clipboardReadEmpty });
          return;
        }
        if (evaluated.reason === "limit_exceeded") {
          setClipboardFeedback({ tone: "err", text: t.cleanLinksTool.clipboardLimitExceeded });
          return;
        }
        // Contains non-link text -> keep system clipboard untouched, load text for inspection
        setRenderLimit(INITIAL_RENDER_LIMIT);
        updateCleanLinksSession({ inputText: clip });
        setClipboardFeedback({ tone: "warn", text: t.cleanLinksTool.clipboardKeptNonLinks });
        return;
      }

      await writeSystemClipboardText(evaluated.replacementText);
      setRenderLimit(INITIAL_RENDER_LIMIT);
      updateCleanLinksSession({ inputText: clip });
      setClipboardFeedback({
        tone: "ok",
        text: t.cleanLinksTool.clipboardReplacedOk(
          evaluated.changedCount,
          evaluated.batch.validCount,
        ),
      });
    } catch (err) {
      setClipboardFeedback({ tone: "err", text: formatLocalizedError(err, t) });
    }
  };

  const formatUnwrapStopped = (reason: UnwrapStopReason): string => {
    switch (reason.kind) {
      case "missing_target_param":
        return t.cleanLinksTool.unwrapStoppedNote.missing_target_param(reason.providerLabel);
      case "ambiguous_target_param":
        return t.cleanLinksTool.unwrapStoppedNote.ambiguous_target_param(reason.providerLabel);
      case "malformed_target_encoding":
        return t.cleanLinksTool.unwrapStoppedNote.malformed_target_encoding(reason.providerLabel);
      case "non_http_or_invalid_target":
        return t.cleanLinksTool.unwrapStoppedNote.non_http_or_invalid_target(reason.providerLabel);
      case "target_too_long":
        return t.cleanLinksTool.unwrapStoppedNote.target_too_long(reason.providerLabel);
      case "cycle_detected":
        return t.cleanLinksTool.unwrapStoppedNote.cycle_detected(reason.providerLabel);
      case "max_depth_reached":
        return t.cleanLinksTool.unwrapStoppedNote.max_depth_reached(reason.maxDepth);
    }
  };

  const nonBlankLines =
    batchResult.status === "ok" ? batchResult.lines.filter((line) => line.status !== "blank") : [];
  const visibleLines = nonBlankLines.slice(0, renderLimit);
  const validCount = batchResult.status === "ok" ? batchResult.validCount : 0;

  return (
    <div className="tool-workspace">
      <p className="field-hint">{t.cleanLinksTool.scopeNote(CLEAN_LINKS_RULES_VERSION)}</p>

      <div className="tool-toolbar">
        <div className="tool-toolbar-group">
          <button type="button" className="btn" onClick={handleReadClipboardPreview}>
            <ClipboardPaste size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{t.cleanLinksTool.readClipboardBtn}</span>
          </button>

          <button type="button" className="btn" onClick={handleOneClickReplaceClipboard}>
            <ClipboardCheck size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{t.cleanLinksTool.replaceClipboardBtn}</span>
          </button>

          <button
            type="button"
            className="btn"
            onClick={() => {
              setClipboardFeedback(null);
              setRenderLimit(INITIAL_RENDER_LIMIT);
              updateCleanLinksSession({ inputText: SYNTHETIC_SAMPLE_LINKS });
            }}
          >
            <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{t.cleanLinksTool.sampleBtn}</span>
          </button>
        </div>

        <div className="tool-toolbar-group">
          <button
            type="button"
            className="btn btn-primary"
            disabled={batchResult.status !== "ok" || validCount === 0}
            onClick={() => {
              if (batchResult.status === "ok" && batchResult.validCount > 0) {
                void handleCopyText(batchResult.allValidCleanedText, "all");
              }
            }}
          >
            {copiedKey === "all" ? (
              <Check size={14} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
            )}
            <span>
              {copiedKey === "all"
                ? t.cleanLinksTool.copiedBadge
                : t.cleanLinksTool.copyAllBtn(validCount)}
            </span>
          </button>

          <button
            type="button"
            className="btn"
            disabled={inputText.length === 0}
            onClick={() => {
              setClipboardFeedback(null);
              setRenderLimit(INITIAL_RENDER_LIMIT);
              updateCleanLinksSession({ inputText: "" });
            }}
          >
            <Eraser size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{t.cleanLinksTool.clearBtn}</span>
          </button>
        </div>
      </div>

      {clipboardFeedback && (
        <div
          className={`status-banner ${
            clipboardFeedback.tone === "ok"
              ? "is-ok"
              : clipboardFeedback.tone === "warn"
                ? "is-warn"
                : "is-err"
          }`}
          role="status"
          data-testid="clean-links-clipboard-banner"
        >
          <span>{clipboardFeedback.text}</span>
        </div>
      )}

      <div
        className={`status-banner ${
          batchResult.status === "limit_exceeded"
            ? "is-err"
            : batchResult.status === "ok" && batchResult.invalidCount > 0
              ? "is-warn"
              : batchResult.status === "ok"
                ? "is-ok"
                : ""
        }`}
        data-testid="clean-links-status-banner"
      >
        <span>
          {batchResult.status === "empty" && t.cleanLinksTool.statusEmpty}
          {batchResult.status === "limit_exceeded" &&
            (batchResult.reason === "bytes"
              ? t.cleanLinksTool.statusLimitBytes(batchResult.actual, batchResult.limit)
              : t.cleanLinksTool.statusLimitLines(batchResult.actual, batchResult.limit))}
          {batchResult.status === "ok" &&
            t.cleanLinksTool.statusSummary(
              batchResult.validCount,
              batchResult.changedCount,
              batchResult.totalRemovedParams,
              batchResult.totalUnwrappedLinks,
              batchResult.invalidCount,
            )}
        </span>
      </div>

      <details
        style={{
          padding: "8px 12px",
          border: "1px solid var(--border-subtle)",
          borderRadius: "8px",
          background: "var(--bg-surface)",
          fontSize: "12px",
        }}
      >
        <summary style={{ cursor: "pointer", fontWeight: 600, color: "var(--text-secondary)" }}>
          {t.cleanLinksTool.rulesSummaryTitle}
        </summary>
        <p className="field-hint" style={{ marginTop: "6px", lineHeight: "18px" }}>
          {t.cleanLinksTool.rulesSummaryBody}
        </p>
      </details>

      <div className="split-panes" style={{ minHeight: "340px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", minWidth: 0 }}>
          <div className="pane" style={{ flex: 1 }}>
            <div className="pane-header">
              <label className="pane-title" htmlFor={inputId}>
                {t.cleanLinksTool.inputLabel}
              </label>
            </div>
            <textarea
              id={inputId}
              className="code-editor"
              spellCheck={false}
              value={inputText}
              placeholder={t.cleanLinksTool.inputPlaceholder}
              onChange={(e) => {
                setRenderLimit(INITIAL_RENDER_LIMIT);
                updateCleanLinksSession({ inputText: e.target.value });
              }}
              style={{ minHeight: "160px" }}
            />
          </div>

          {batchResult.status === "ok" && batchResult.validCount > 0 && (
            <div className="pane" style={{ flex: 1 }}>
              <div className="pane-header">
                <label className="pane-title" htmlFor={cleanSummaryId}>
                  {t.cleanLinksTool.cleanedOutputPaneTitle}
                </label>
              </div>
              <textarea
                id={cleanSummaryId}
                className="code-editor"
                readOnly
                spellCheck={false}
                value={batchResult.allValidCleanedText}
                data-testid="clean-links-valid-output"
                style={{ minHeight: "120px" }}
              />
            </div>
          )}
        </div>

        <div className="pane" style={{ minHeight: "300px" }}>
          <div className="pane-header">
            <span className="pane-title">{t.cleanLinksTool.resultsPaneTitle}</span>
          </div>

          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "12px",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
            }}
            data-testid="clean-links-breakdown-list"
          >
            {nonBlankLines.length === 0 ? (
              <div className="empty-state">{t.cleanLinksTool.statusEmpty}</div>
            ) : (
              visibleLines.map((item) => {
                if (item.status === "invalid") {
                  return (
                    <div
                      key={item.lineNumber}
                      style={{
                        padding: "10px 12px",
                        borderRadius: "8px",
                        border: "1px solid var(--border-subtle)",
                        background: "var(--status-err-bg)",
                        display: "flex",
                        flexDirection: "column",
                        gap: "6px",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span className="badge">
                          {t.cleanLinksTool.linePrefix(item.lineNumber)}
                        </span>
                        <span className="badge badge-err">{t.cleanLinksTool.badgeInvalid}</span>
                      </div>
                      <code className="mono-inline" style={{ wordBreak: "break-all" }}>
                        {item.rawLine}
                      </code>
                      <span style={{ fontSize: "12px", color: "var(--status-err)" }}>
                        {t.cleanLinksTool.invalidReasons[item.reason]}
                      </span>
                    </div>
                  );
                }

                const copyItemKey = `line-${item.lineNumber}`;
                return (
                  <div
                    key={item.lineNumber}
                    style={{
                      padding: "10px 12px",
                      borderRadius: "8px",
                      border: "1px solid var(--border-subtle)",
                      background: "var(--bg-subtle)",
                      display: "flex",
                      flexDirection: "column",
                      gap: "6px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "8px",
                        flexWrap: "wrap",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "6px",
                          flexWrap: "wrap",
                        }}
                      >
                        <span className="badge">
                          {t.cleanLinksTool.linePrefix(item.lineNumber)}
                        </span>
                        {item.presignedSkippedKey ? (
                          <span className="badge badge-partial">
                            {t.cleanLinksTool.badgePresignedSkipped(item.presignedSkippedKey)}
                          </span>
                        ) : item.changed ? (
                          <span className="badge badge-ok">{t.cleanLinksTool.badgeCleaned}</span>
                        ) : (
                          <span className="badge">{t.cleanLinksTool.badgeUnchanged}</span>
                        )}
                      </div>

                      <button
                        type="button"
                        className="btn"
                        style={{ height: "26px", padding: "0 8px", fontSize: "12px" }}
                        onClick={() => void handleCopyText(item.cleanedUrl, copyItemKey)}
                      >
                        {copiedKey === copyItemKey ? (
                          <Check size={12} strokeWidth={1.75} aria-hidden="true" />
                        ) : (
                          <Copy size={12} strokeWidth={1.75} aria-hidden="true" />
                        )}
                        <span>
                          {copiedKey === copyItemKey
                            ? t.cleanLinksTool.copiedBadge
                            : t.cleanLinksTool.copySingleBtn}
                        </span>
                      </button>
                    </div>

                    <code
                      className="mono-inline"
                      style={{
                        wordBreak: "break-all",
                        padding: "6px 8px",
                        borderRadius: "6px",
                        background: "var(--bg-surface)",
                        border: "1px solid var(--border-subtle)",
                      }}
                    >
                      {item.cleanedUrl}
                    </code>

                    {item.unwrapSteps.length > 0 && (
                      <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                        <strong>{t.cleanLinksTool.unwrappedChainLabel}</strong>{" "}
                        {item.unwrapSteps
                          .map((s) => `${s.providerLabel} (${s.wrapperHost} ?${s.targetParam}=)`)
                          .join(" → ")}
                      </div>
                    )}

                    {item.unwrapStoppedReason && (
                      <div style={{ fontSize: "12px", color: "var(--status-warn)" }}>
                        {formatUnwrapStopped(item.unwrapStoppedReason)}
                      </div>
                    )}

                    {item.removedParams.length > 0 && (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "6px",
                          flexWrap: "wrap",
                          fontSize: "12px",
                        }}
                      >
                        <span style={{ color: "var(--text-secondary)", fontWeight: 500 }}>
                          {t.cleanLinksTool.removedParamsLabel}
                        </span>
                        {item.removedParams.map((p, idx) => (
                          <span key={`${p.rawKey}-${idx}`} className="badge">
                            <span className="mono-inline">{p.decodedKey}</span>
                            <span style={{ marginLeft: "4px", color: "var(--text-muted)" }}>
                              (
                              {p.scope === "universal"
                                ? t.cleanLinksTool.scopeUniversal
                                : `${t.cleanLinksTool.scopeSite}: ${p.providerLabel}`}
                              )
                            </span>
                          </span>
                        ))}
                      </div>
                    )}

                    {item.preservedMalformedKeyCount > 0 && (
                      <div className="field-hint">
                        {t.cleanLinksTool.malformedKeyPreservedNote(
                          item.preservedMalformedKeyCount,
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}

            {nonBlankLines.length > renderLimit && (
              <button
                type="button"
                className="btn"
                onClick={() => setRenderLimit((prev) => prev + INITIAL_RENDER_LIMIT)}
              >
                +{Math.min(INITIAL_RENDER_LIMIT, nonBlankLines.length - renderLimit)} /{" "}
                {nonBlankLines.length}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
