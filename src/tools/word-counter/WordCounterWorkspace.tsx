import { Check, Copy, Eraser } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore } from "../../lib/sessionStore";
import { analyzeTextMetrics } from "./wordCounterEngine";

const IMMEDIATE_ANALYZE_CHAR_THRESHOLD = 24_000;

export function WordCounterWorkspace() {
  const { t } = useI18n();
  const { session, updateWordCounterSession } = useSessionStore();
  const { textInput } = session.wordCounter;

  const [debouncedText, setDebouncedText] = useState(textInput);
  const [copied, setCopied] = useState(false);

  // Instant analysis for normal inputs; 120ms debounce for large pastes so UI/shutdown never stalls
  useEffect(() => {
    if (textInput.length <= IMMEDIATE_ANALYZE_CHAR_THRESHOLD) {
      setDebouncedText(textInput);
      return;
    }
    const timer = window.setTimeout(() => {
      setDebouncedText(textInput);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [textInput]);

  const effectiveSource =
    textInput.length <= IMMEDIATE_ANALYZE_CHAR_THRESHOLD ? textInput : debouncedText;

  const analysis = useMemo(() => analyzeTextMetrics(effectiveSource), [effectiveSource]);
  const stats = analysis.stats;

  const handleCopySummary = async () => {
    if (!stats) return;
    const summaryLines = [
      `${t.wordCounterTool.statWords}: ${stats.words}`,
      `${t.wordCounterTool.statCharsWithSpaces}: ${stats.charsWithSpaces}`,
      `${t.wordCounterTool.statCharsNoWhitespace}: ${stats.charsNoWhitespace}`,
      `${t.wordCounterTool.statSentences}: ${stats.sentences}`,
      `${t.wordCounterTool.statParagraphs}: ${stats.paragraphs}`,
      `${t.wordCounterTool.statLines}: ${stats.lines}`,
      `${t.wordCounterTool.statUtf8Bytes}: ${stats.utf8Bytes}`,
      `${t.wordCounterTool.statReadingTime}: ${t.wordCounterTool.formatDuration(stats.readingSeconds)}`,
      `${t.wordCounterTool.statSpeakingTime}: ${t.wordCounterTool.formatDuration(stats.speakingSeconds)}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(summaryLines);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Ignore clipboard failure silently
    }
  };

  const handleClear = () => {
    setCopied(false);
    updateWordCounterSession({ textInput: "" });
  };

  return (
    <div className="tool-workspace">
      <div className="tool-toolbar">
        <div className="tool-toolbar-group">
          <p className="field-hint" style={{ margin: 0 }}>
            {t.wordCounterTool.scopeNote}
          </p>
        </div>

        <div className="tool-toolbar-group">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!stats}
            onClick={() => void handleCopySummary()}
          >
            {copied ? (
              <Check size={14} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
            )}
            <span>{copied ? t.wordCounterTool.copiedBadge : t.wordCounterTool.copySummaryBtn}</span>
          </button>

          <button type="button" className="btn" onClick={handleClear}>
            <Eraser size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{t.wordCounterTool.clearBtn}</span>
          </button>
        </div>
      </div>

      {analysis.exceededLimit && (
        <div className="status-banner is-err" role="alert">
          <span>{t.wordCounterTool.limitExceeded(2)}</span>
        </div>
      )}

      <div className="split-panes">
        {/* Left Pane: Text Input */}
        <div className="pane">
          <div className="pane-header">
            <label htmlFor="word-counter-input" className="pane-title">
              {t.wordCounterTool.inputLabel}
            </label>
            <span className="mono" style={{ fontSize: "11.5px", color: "var(--text-muted)" }}>
              {analysis.utf8Bytes.toLocaleString()} B
            </span>
          </div>
          <textarea
            id="word-counter-input"
            className="code-editor"
            placeholder={t.wordCounterTool.placeholder}
            value={textInput}
            onChange={(e) => updateWordCounterSession({ textInput: e.target.value })}
          />
          <div
            style={{
              padding: "8px 12px",
              borderTop: "1px solid var(--border-subtle)",
              background: "var(--bg-subtle)",
            }}
          >
            <p className="field-hint">{t.wordCounterTool.rulesNote}</p>
          </div>
        </div>

        {/* Right Pane: Metrics Grid & Top Frequent Words */}
        <div className="pane">
          <div className="pane-header">
            <span className="pane-title">{t.wordCounterTool.statWords} / Unicode Metrics</span>
          </div>

          {stats && (
            <div
              style={{
                padding: "14px 16px",
                display: "flex",
                flexDirection: "column",
                gap: "14px",
                flex: 1,
                overflowY: "auto",
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                  gap: "8px",
                }}
              >
                {(
                  [
                    ["words", t.wordCounterTool.statWords, stats.words.toLocaleString()],
                    [
                      "chars-spaces",
                      t.wordCounterTool.statCharsWithSpaces,
                      stats.charsWithSpaces.toLocaleString(),
                    ],
                    [
                      "chars-nows",
                      t.wordCounterTool.statCharsNoWhitespace,
                      stats.charsNoWhitespace.toLocaleString(),
                    ],
                    [
                      "sentences",
                      t.wordCounterTool.statSentences,
                      stats.sentences.toLocaleString(),
                    ],
                    [
                      "paragraphs",
                      t.wordCounterTool.statParagraphs,
                      stats.paragraphs.toLocaleString(),
                    ],
                    ["lines", t.wordCounterTool.statLines, stats.lines.toLocaleString()],
                    ["bytes", t.wordCounterTool.statUtf8Bytes, stats.utf8Bytes.toLocaleString()],
                    [
                      "reading",
                      t.wordCounterTool.statReadingTime,
                      t.wordCounterTool.formatDuration(stats.readingSeconds),
                    ],
                    [
                      "speaking",
                      t.wordCounterTool.statSpeakingTime,
                      t.wordCounterTool.formatDuration(stats.speakingSeconds),
                    ],
                  ] as const
                ).map(([key, label, value]) => (
                  <div
                    key={key}
                    style={{
                      padding: "10px 12px",
                      borderRadius: "6px",
                      border: "1px solid var(--border-subtle)",
                      background: "var(--bg-subtle)",
                    }}
                  >
                    <div style={{ fontSize: "11.5px", color: "var(--text-secondary)" }}>
                      {label}
                    </div>
                    <div
                      className="mono"
                      data-testid={`wc-${key}`}
                      style={{
                        fontSize: "16px",
                        fontWeight: 600,
                        marginTop: "4px",
                        color: "var(--text-primary)",
                      }}
                    >
                      {value}
                    </div>
                  </div>
                ))}
              </div>

              <p className="field-hint" style={{ margin: 0 }}>
                {t.wordCounterTool.estimateAssumptions}
              </p>

              <div className="field-stack">
                <span className="field-label">{t.wordCounterTool.topWordsTitle}</span>
                {stats.topWords.length === 0 ? (
                  <p className="field-hint">{t.wordCounterTool.topWordsEmpty}</p>
                ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                    {stats.topWords.map((item) => (
                      <span
                        key={item.word}
                        className="badge mono"
                        style={{ padding: "4px 8px", fontSize: "12px" }}
                      >
                        {item.word} × {item.count}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
