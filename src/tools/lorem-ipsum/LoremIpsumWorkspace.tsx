import { Check, Copy, Eraser, RefreshCw } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore } from "../../lib/sessionStore";
import { writeSystemClipboardText } from "../../lib/tauriBridge";
import {
  generateLoremIpsum,
  LOREM_UNIT_LIMITS,
  nextRandomLoremSeed,
  type LoremFormat,
  type LoremUnit,
} from "./loremEngine";

export function LoremIpsumWorkspace() {
  const { t } = useI18n();
  const { session, updateLoremIpsumSession } = useSessionStore();
  const { unit, rawCount, format, startWithClassic, seed } = session.loremIpsum;

  const countInputId = useId();
  const outputId = useId();

  const [isCleared, setIsCleared] = useState(false);
  const [copied, setCopied] = useState(false);

  const bounds = LOREM_UNIT_LIMITS[unit];

  const generated = useMemo(() => {
    if (isCleared) return null;
    return generateLoremIpsum({
      unit,
      rawCount,
      format,
      startWithClassic,
      seed,
    });
  }, [isCleared, unit, rawCount, format, startWithClassic, seed]);

  const handleUnitChange = (nextUnit: LoremUnit) => {
    setIsCleared(false);
    setCopied(false);
    const nextBounds = LOREM_UNIT_LIMITS[nextUnit];
    const parsed = Number(rawCount.trim());
    const nextCount =
      /^\d+$/.test(rawCount.trim()) && parsed >= nextBounds.min && parsed <= nextBounds.max
        ? rawCount
        : String(nextBounds.defaultCount);
    updateLoremIpsumSession({
      unit: nextUnit,
      rawCount: nextCount,
    });
  };

  const handleCopy = async () => {
    if (!generated || generated.status !== "ok") return;
    await writeSystemClipboardText(generated.output);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="tool-workspace">
      <p className="field-hint">{t.loremTool.scopeNote}</p>

      <div className="tool-toolbar">
        <div className="tool-toolbar-group">
          <div className="segmented" role="group" aria-label={t.loremTool.unitLabel}>
            {(
              [
                ["words", t.loremTool.unitWords],
                ["sentences", t.loremTool.unitSentences],
                ["paragraphs", t.loremTool.unitParagraphs],
              ] as const
            ).map(([u, label]) => (
              <button
                key={u}
                type="button"
                className={`segmented-btn ${unit === u ? "is-selected" : ""}`}
                aria-pressed={unit === u}
                onClick={() => handleUnitChange(u)}
              >
                {label}
              </button>
            ))}
          </div>

          <label className="field-row" htmlFor={countInputId} style={{ gap: "6px" }}>
            <span className="field-hint">{t.loremTool.countLabel(bounds.min, bounds.max)}</span>
            <input
              id={countInputId}
              type="text"
              inputMode="numeric"
              className="text-input"
              style={{ width: "86px" }}
              value={rawCount}
              onChange={(e) => {
                setIsCleared(false);
                setCopied(false);
                updateLoremIpsumSession({ rawCount: e.target.value });
              }}
            />
          </label>

          <div className="segmented" role="group" aria-label={t.loremTool.formatLabel}>
            {(
              [
                ["plain", t.loremTool.formatPlain],
                ["html", t.loremTool.formatHtml],
                ["markdown", t.loremTool.formatMarkdown],
              ] as const
            ).map(([f, label]) => (
              <button
                key={f}
                type="button"
                className={`segmented-btn ${format === f ? "is-selected" : ""}`}
                aria-pressed={format === f}
                onClick={() => {
                  setIsCleared(false);
                  setCopied(false);
                  updateLoremIpsumSession({ format: f as LoremFormat });
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={startWithClassic}
              onChange={(e) => {
                setIsCleared(false);
                setCopied(false);
                updateLoremIpsumSession({ startWithClassic: e.target.checked });
              }}
            />
            <span>{t.loremTool.classicStartLabel}</span>
          </label>
        </div>

        <div className="tool-toolbar-group">
          <button
            type="button"
            className="btn"
            onClick={() => {
              setIsCleared(false);
              setCopied(false);
              updateLoremIpsumSession({ seed: nextRandomLoremSeed() });
            }}
          >
            <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{t.loremTool.regenerateBtn}</span>
          </button>

          <button
            type="button"
            className="btn btn-primary"
            disabled={!generated || generated.status !== "ok"}
            onClick={() => void handleCopy()}
          >
            {copied ? (
              <Check size={14} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
            )}
            <span>{copied ? t.loremTool.copiedBadge : t.loremTool.copyBtn}</span>
          </button>

          <button
            type="button"
            className="btn"
            disabled={isCleared}
            onClick={() => {
              setIsCleared(true);
              setCopied(false);
            }}
          >
            <Eraser size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{t.loremTool.clearBtn}</span>
          </button>
        </div>
      </div>

      <div
        className={`status-banner ${
          !generated ? "" : generated.status === "invalid" ? "is-err" : "is-ok"
        }`}
        data-testid="lorem-status-banner"
      >
        <span>
          {!generated && t.loremTool.statusCleared}
          {generated?.status === "ok" &&
            t.loremTool.statusStats(
              generated.wordCount,
              generated.sentenceCount,
              generated.paragraphCount,
              generated.charCount,
            )}
          {generated?.status === "invalid" &&
            (generated.error.kind === "empty_or_non_integer"
              ? t.loremTool.errNonInteger
              : generated.error.kind === "out_of_range"
                ? t.loremTool.errOutOfRange(generated.error.min, generated.error.max)
                : t.loremTool.errBudgetExceeded(generated.error.maxChars))}
        </span>
      </div>

      <div className="pane" style={{ flex: 1, minHeight: "320px" }}>
        <div className="pane-header">
          <label className="pane-title" htmlFor={outputId}>
            {t.loremTool.outputPaneTitle}
          </label>
        </div>
        {generated?.status === "ok" ? (
          <textarea
            id={outputId}
            className="code-editor"
            readOnly
            spellCheck={false}
            value={generated.output}
            data-testid="lorem-output-editor"
            style={{ fontFamily: format === "html" ? undefined : "inherit", lineHeight: "22px" }}
          />
        ) : (
          <div className="empty-state" style={{ margin: "24px" }}>
            {!generated
              ? t.loremTool.statusCleared
              : generated.error.kind === "empty_or_non_integer"
                ? t.loremTool.errNonInteger
                : generated.error.kind === "out_of_range"
                  ? t.loremTool.errOutOfRange(generated.error.min, generated.error.max)
                  : t.loremTool.errBudgetExceeded(generated.error.maxChars)}
          </div>
        )}
      </div>
    </div>
  );
}
