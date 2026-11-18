import { Check, Copy, Download, Eraser, Play } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore } from "../../lib/sessionStore";
import { writeSystemClipboardText } from "../../lib/tauriBridge";
import {
  convert,
  type ConversionDirection,
  type ConversionResult,
  type CsvDelimiter,
} from "./csvJsonEngine";

export function CsvJsonWorkspace() {
  const { t } = useI18n();
  const { session, updateCsvJsonSession } = useSessionStore();
  const {
    inputText,
    direction,
    delimiter,
    firstRowHeaders,
    detectTypes,
    formulaProtection,
    outputText,
  } = session.csvJson;

  const inputId = useId();
  const outputId = useId();
  const [copied, setCopied] = useState(false);

  const result: ConversionResult | null = useMemo(() => {
    if (inputText.trim().length === 0) return null;
    return convert(inputText, {
      direction,
      delimiter,
      firstRowHeaders,
      detectTypes,
      formulaProtection,
    });
  }, [inputText, direction, delimiter, firstRowHeaders, detectTypes, formulaProtection]);

  // Sync output text to session when result changes
  const displayOutput = result?.status === "ok" ? result.output : outputText;
  if (result?.status === "ok" && result.output !== outputText) {
    // Update in next microtask to avoid setState-during-render
    queueMicrotask(() => updateCsvJsonSession({ outputText: result.output }));
  }

  const handleConvert = () => {
    if (!inputText.trim()) return;
    const r = convert(inputText, {
      direction,
      delimiter,
      firstRowHeaders,
      detectTypes,
      formulaProtection,
    });
    if (r.status === "ok") {
      updateCsvJsonSession({ outputText: r.output });
    }
  };

  const handleCopy = async () => {
    if (!displayOutput) return;
    await writeSystemClipboardText(displayOutput);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const handleDownload = () => {
    if (!displayOutput) return;
    const ext =
      direction === "csv_to_json" ? ".json" : direction === "json_to_csv" ? ".csv" : ".md";
    const mimeType =
      direction === "csv_to_json"
        ? "application/json"
        : direction === "json_to_csv"
          ? "text/csv"
          : "text/markdown";
    const blob = new Blob([displayOutput], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `converted${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClear = () => {
    updateCsvJsonSession({ inputText: "", outputText: "" });
    setCopied(false);
  };

  const directionChoices: [ConversionDirection, string][] = [
    ["csv_to_json", t.csvJsonTool.dirCsvToJson],
    ["json_to_csv", t.csvJsonTool.dirJsonToCsv],
    ["csv_to_md", t.csvJsonTool.dirCsvToMd],
    ["json_to_md", t.csvJsonTool.dirJsonToMd],
  ];

  const delimiterChoices: [CsvDelimiter, string][] = [
    ["auto", t.csvJsonTool.delimAuto],
    [",", t.csvJsonTool.delimComma],
    [";", t.csvJsonTool.delimSemicolon],
    ["\t", t.csvJsonTool.delimTab],
  ];

  const isJsonInput = direction === "json_to_csv" || direction === "json_to_md";

  return (
    <div className="tool-workspace">
      <p className="field-hint">{t.csvJsonTool.scopeNote}</p>

      <div className="tool-toolbar">
        <div className="tool-toolbar-group">
          <div className="segmented" role="group" aria-label={t.csvJsonTool.directionLabel}>
            {directionChoices.map(([d, label]) => (
              <button
                key={d}
                type="button"
                className={`segmented-btn ${direction === d ? "is-selected" : ""}`}
                aria-pressed={direction === d}
                onClick={() => {
                  setCopied(false);
                  updateCsvJsonSession({ direction: d, outputText: "" });
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {!isJsonInput && (
            <div className="segmented" role="group" aria-label={t.csvJsonTool.delimiterLabel}>
              {delimiterChoices.map(([d, label]) => (
                <button
                  key={d}
                  type="button"
                  className={`segmented-btn ${delimiter === d ? "is-selected" : ""}`}
                  aria-pressed={delimiter === d}
                  onClick={() => {
                    setCopied(false);
                    updateCsvJsonSession({ delimiter: d, outputText: "" });
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={firstRowHeaders}
              onChange={(e) => {
                setCopied(false);
                updateCsvJsonSession({ firstRowHeaders: e.target.checked, outputText: "" });
              }}
            />
            <span>{t.csvJsonTool.firstRowHeaders}</span>
          </label>

          {!isJsonInput && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={detectTypes}
                onChange={(e) => {
                  setCopied(false);
                  updateCsvJsonSession({ detectTypes: e.target.checked, outputText: "" });
                }}
              />
              <span>{t.csvJsonTool.detectTypes}</span>
            </label>
          )}

          {(direction === "json_to_csv" || direction === "csv_to_json") && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={formulaProtection}
                onChange={(e) => {
                  setCopied(false);
                  updateCsvJsonSession({ formulaProtection: e.target.checked, outputText: "" });
                }}
              />
              <span>{t.csvJsonTool.formulaProtection}</span>
            </label>
          )}
        </div>

        <div className="tool-toolbar-group">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!inputText.trim()}
            onClick={handleConvert}
          >
            <Play size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{t.csvJsonTool.convertBtn}</span>
          </button>

          <button
            type="button"
            className="btn"
            disabled={!displayOutput}
            onClick={() => void handleCopy()}
          >
            {copied ? (
              <Check size={14} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
            )}
            <span>{copied ? t.csvJsonTool.copiedBadge : t.csvJsonTool.copyBtn}</span>
          </button>

          <button type="button" className="btn" disabled={!displayOutput} onClick={handleDownload}>
            <Download size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{t.csvJsonTool.downloadBtn}</span>
          </button>

          <button
            type="button"
            className="btn"
            disabled={!inputText && !outputText}
            onClick={handleClear}
          >
            <Eraser size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{t.csvJsonTool.clearBtn}</span>
          </button>
        </div>
      </div>

      {result && (
        <div
          className={`status-banner ${result.status === "error" ? "is-err" : "is-ok"}`}
          data-testid="csvjson-status-banner"
        >
          <span>
            {result.status === "ok" && t.csvJsonTool.statusOk(result.rowCount, result.columnCount)}
            {result.status === "error" &&
              (result.line
                ? t.csvJsonTool.statusErrorAt(result.message, result.line, result.column ?? 0)
                : result.message)}
          </span>
        </div>
      )}

      <div style={{ display: "flex", flex: 1, gap: "8px", minHeight: "320px" }}>
        <div className="pane" style={{ flex: 1 }}>
          <div className="pane-header">
            <label className="pane-title" htmlFor={inputId}>
              {t.csvJsonTool.inputPaneTitle}
            </label>
          </div>
          <textarea
            id={inputId}
            className="code-editor"
            spellCheck={false}
            placeholder={isJsonInput ? t.csvJsonTool.jsonPlaceholder : t.csvJsonTool.csvPlaceholder}
            value={inputText}
            onChange={(e) => {
              setCopied(false);
              updateCsvJsonSession({ inputText: e.target.value });
            }}
            data-testid="csvjson-input-editor"
          />
        </div>

        <div className="pane" style={{ flex: 1 }}>
          <div className="pane-header">
            <label className="pane-title" htmlFor={outputId}>
              {t.csvJsonTool.outputPaneTitle}
            </label>
          </div>
          <textarea
            id={outputId}
            className="code-editor"
            readOnly
            spellCheck={false}
            value={displayOutput}
            data-testid="csvjson-output-editor"
          />
        </div>
      </div>
    </div>
  );
}
