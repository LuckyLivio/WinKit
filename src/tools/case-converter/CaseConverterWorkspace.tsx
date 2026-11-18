import { Check, Copy, Eraser } from "lucide-react";
import { useMemo, useState } from "react";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore, type CaseStyleId } from "../../lib/sessionStore";
import { ALL_CASE_STYLES, convertCaseText } from "./caseConverterEngine";

export function CaseConverterWorkspace() {
  const { t } = useI18n();
  const { session, updateCaseConverterSession } = useSessionStore();
  const { textInput, selectedStyle } = session.caseConverter;

  const [copied, setCopied] = useState(false);

  const convertedOutput = useMemo(
    () => convertCaseText(textInput, selectedStyle),
    [selectedStyle, textInput],
  );

  // Live first-line preview across all 12 styles
  const previewLineSource = useMemo(() => {
    const firstNonEmpty = textInput.split(/\r?\n/).find((l) => l.trim().length > 0);
    return firstNonEmpty ?? "";
  }, [textInput]);

  const stylePreviews = useMemo(() => {
    const map: Record<CaseStyleId, string> = {} as Record<CaseStyleId, string>;
    for (const st of ALL_CASE_STYLES) {
      map[st] = previewLineSource ? convertCaseText(previewLineSource, st) : "";
    }
    return map;
  }, [previewLineSource]);

  const handleCopy = async () => {
    if (!convertedOutput) return;
    try {
      await navigator.clipboard.writeText(convertedOutput);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Ignore clipboard failure silently
    }
  };

  const handleClear = () => {
    setCopied(false);
    updateCaseConverterSession({ textInput: "" });
  };

  return (
    <div className="tool-workspace">
      <div className="tool-toolbar">
        <div className="tool-toolbar-group">
          <p className="field-hint" style={{ margin: 0 }}>
            {t.caseConverterTool.scopeNote}
          </p>
        </div>

        <div className="tool-toolbar-group">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!convertedOutput}
            onClick={() => void handleCopy()}
          >
            {copied ? (
              <Check size={14} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
            )}
            <span>{copied ? t.caseConverterTool.copiedBadge : t.caseConverterTool.copyBtn}</span>
          </button>

          <button type="button" className="btn" onClick={handleClear}>
            <Eraser size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{t.caseConverterTool.clearBtn}</span>
          </button>
        </div>
      </div>

      {/* 12-style selector grid with live first-line preview */}
      <div
        role="group"
        aria-label={t.caseConverterTool.stylesLabel}
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: "6px",
        }}
      >
        {ALL_CASE_STYLES.map((styleId) => {
          const active = selectedStyle === styleId;
          const preview = stylePreviews[styleId];
          return (
            <button
              key={styleId}
              type="button"
              aria-pressed={active}
              onClick={() => updateCaseConverterSession({ selectedStyle: styleId })}
              style={{
                textAlign: "left",
                padding: "7px 10px",
                borderRadius: "6px",
                border: `1px solid ${active ? "var(--accent)" : "var(--border-subtle)"}`,
                background: active ? "var(--accent-soft)" : "var(--bg-surface)",
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                gap: "2px",
                minWidth: 0,
              }}
            >
              <span
                style={{
                  fontSize: "12px",
                  fontWeight: active ? 600 : 500,
                  color: "var(--text-primary)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {t.caseConverterTool.styleNames[styleId]}
              </span>
              <span
                className="mono"
                style={{
                  fontSize: "11px",
                  color: "var(--text-muted)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {preview || t.caseConverterTool.emptyPreview}
              </span>
            </button>
          );
        })}
      </div>

      <div className="split-panes">
        {/* Left Pane: Non-destructive Source Input */}
        <div className="pane">
          <div className="pane-header">
            <label htmlFor="case-converter-input" className="pane-title">
              {t.caseConverterTool.inputLabel}
            </label>
          </div>
          <textarea
            id="case-converter-input"
            className="code-editor"
            spellCheck={false}
            placeholder={t.caseConverterTool.placeholder}
            value={textInput}
            onChange={(e) => updateCaseConverterSession({ textInput: e.target.value })}
          />
          <div
            style={{
              padding: "8px 12px",
              borderTop: "1px solid var(--border-subtle)",
              background: "var(--bg-subtle)",
            }}
          >
            <p className="field-hint">{t.caseConverterTool.lineRuleNote}</p>
          </div>
        </div>

        {/* Right Pane: Selected Style Result */}
        <div className="pane">
          <div className="pane-header">
            <label htmlFor="case-converter-output" className="pane-title">
              {t.caseConverterTool.outputLabel}
            </label>
            <span className="badge mono">{t.caseConverterTool.styleNames[selectedStyle]}</span>
          </div>
          <textarea
            id="case-converter-output"
            className="code-editor"
            readOnly
            placeholder={t.caseConverterTool.emptyPreview}
            value={convertedOutput}
          />
        </div>
      </div>
    </div>
  );
}
