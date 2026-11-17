import { Check, Copy, Download, Eraser, FolderOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore, type JsonIndentOption } from "../../lib/sessionStore";
import {
  formatLocalizedError,
  parseBackendError,
  pickSaveFilePath,
  pickSingleFile,
  readLocalTextFile,
  saveLocalTextFile,
  subscribeFileDrop,
  suggestSafeSiblingPath,
} from "../../lib/tauriBridge";
import { processJsonText } from "./jsonEngine";

export function JsonFormatterWorkspace() {
  const { t } = useI18n();
  const { session, updateJsonSession } = useSessionStore();
  const { inputText, indent, sortKeys, mode, sourceFilePath } = session.json;

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [copied, setCopied] = useState(false);
  const [dropHover, setDropHover] = useState(false);
  const [ioMessage, setIoMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [pendingOverwritePath, setPendingOverwritePath] = useState<string | null>(null);

  const result = useMemo(
    () => processJsonText(inputText, { indent, sortKeys }),
    [inputText, indent, sortKeys],
  );

  const outputText = useMemo(() => {
    if (result.status !== "valid") {
      return "";
    }
    if (mode === "minify") {
      return result.minified;
    }
    return result.formatted;
  }, [result, mode]);

  const loadFromFilePath = useCallback(
    async (filePath: string) => {
      setIoMessage(null);
      try {
        const payload = await readLocalTextFile(filePath);
        updateJsonSession({
          inputText: payload.content,
          sourceFilePath: payload.path,
        });
      } catch (err) {
        setIoMessage({
          kind: "err",
          text: formatLocalizedError(err, t),
        });
      }
    },
    [t, updateJsonSession],
  );

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    subscribeFileDrop({
      onHover: (hovering) => setDropHover(hovering),
      onDropPaths: (paths) => {
        const first = paths[0];
        if (first) {
          void loadFromFilePath(first);
        }
      },
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, [loadFromFilePath]);

  const handleOpenFile = async () => {
    setIoMessage(null);
    const chosen = await pickSingleFile({
      title: t.jsonTool.openFileBtn,
      filters: [
        { name: "JSON", extensions: ["json", "geojson", "har"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (chosen) {
      await loadFromFilePath(chosen);
    }
  };

  const executeSave = async (targetPath: string, overwrite: boolean) => {
    if (!outputText) return;
    setIoMessage(null);
    try {
      const saved = await saveLocalTextFile({
        outputPath: targetPath,
        sourcePath: sourceFilePath,
        content: outputText,
        overwrite,
      });
      setIoMessage({
        kind: "ok",
        text: t.jsonTool.savedSuccess(saved.path),
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

  const handleSaveAs = async () => {
    if (result.status !== "valid") return;
    const defaultPath = sourceFilePath
      ? ((await suggestSafeSiblingPath(
          sourceFilePath,
          mode === "minify" ? ".min" : ".formatted",
          "json",
        )) ?? undefined)
      : "formatted.json";

    const chosen = await pickSaveFilePath({
      title: t.jsonTool.saveFileBtn,
      defaultPath,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (chosen) {
      await executeSave(chosen, false);
    }
  };

  const handleCopy = async () => {
    if (!outputText) return;
    try {
      await navigator.clipboard.writeText(outputText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setIoMessage({ kind: "err", text: t.errors.FALLBACK });
    }
  };

  const handleClear = () => {
    setIoMessage(null);
    setCopied(false);
    updateJsonSession({
      inputText: "",
      sourceFilePath: null,
    });
    inputRef.current?.focus();
  };

  const handleJumpToError = () => {
    if (result.status !== "invalid" || !inputRef.current) return;
    const pos = Math.min(result.error.offset, inputText.length);
    inputRef.current.focus();
    inputRef.current.setSelectionRange(pos, Math.min(pos + 1, inputText.length));
  };

  return (
    <div className="tool-workspace">
      <div className="tool-toolbar">
        <div className="tool-toolbar-group">
          <div className="segmented" role="group" aria-label={t.jsonTool.formatBtn}>
            {(
              [
                ["format", t.jsonTool.formatBtn],
                ["minify", t.jsonTool.minifyBtn],
                ["validate", t.jsonTool.validateBtn],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                className={`segmented-btn ${mode === m ? "is-selected" : ""}`}
                aria-pressed={mode === m}
                onClick={() => updateJsonSession({ mode: m })}
              >
                {label}
              </button>
            ))}
          </div>

          <label className="field-row" style={{ gap: "6px" }}>
            <span className="field-hint">{t.jsonTool.indentLabel}</span>
            <select
              className="select-input"
              aria-label={t.jsonTool.indentLabel}
              value={indent}
              disabled={mode === "minify"}
              onChange={(e) => updateJsonSession({ indent: e.target.value as JsonIndentOption })}
            >
              <option value="2">{t.jsonTool.indent2}</option>
              <option value="4">{t.jsonTool.indent4}</option>
              <option value="tab">{t.jsonTool.indentTab}</option>
            </select>
          </label>

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={sortKeys}
              onChange={(e) => updateJsonSession({ sortKeys: e.target.checked })}
            />
            <span>{t.jsonTool.sortKeysLabel}</span>
          </label>
        </div>

        <div className="tool-toolbar-group">
          <button type="button" className="btn" onClick={handleOpenFile}>
            <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{t.jsonTool.openFileBtn}</span>
          </button>

          <button
            type="button"
            className="btn"
            disabled={result.status !== "valid" || mode === "validate"}
            onClick={handleSaveAs}
          >
            <Download size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{t.jsonTool.saveFileBtn}</span>
          </button>

          <button
            type="button"
            className="btn btn-primary"
            disabled={result.status !== "valid" || mode === "validate"}
            onClick={handleCopy}
          >
            {copied ? (
              <Check size={14} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
            )}
            <span>{copied ? t.jsonTool.copiedBadge : t.jsonTool.copyBtn}</span>
          </button>

          <button
            type="button"
            className="btn"
            disabled={inputText.length === 0}
            onClick={handleClear}
          >
            <Eraser size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{t.jsonTool.clearBtn}</span>
          </button>
        </div>
      </div>

      {/* Diagnostic & Validation Status */}
      {result.status === "empty" && (
        <div className="status-banner" role="status">
          <span style={{ color: "var(--text-secondary)" }}>{t.jsonTool.statusEmpty}</span>
          {dropHover && <span className="badge">{t.jsonTool.dropHint}</span>}
        </div>
      )}

      {result.status === "valid" && (
        <div className="status-banner is-ok" role="status" aria-live="polite">
          <span>{t.jsonTool.statusValid(result.rootKind)}</span>
          <span className="mono" style={{ fontSize: "12px" }}>
            {outputText.length.toLocaleString()} chars
          </span>
        </div>
      )}

      {result.status === "invalid" && (
        <div className="status-banner is-err" role="alert">
          <div>
            <strong>{t.jsonTool.statusInvalid}</strong>
            {" · "}
            <span className="mono">
              {t.jsonTool.lineColLabel(result.error.line, result.error.column)}
            </span>
            {" — "}
            <span>{result.error.message}</span>
          </div>
          <button type="button" className="btn" onClick={handleJumpToError}>
            {t.jsonTool.locateErrorBtn}
          </button>
        </div>
      )}

      {result.status === "valid" && result.hasPrecisionSensitiveNumbers && (
        <div className="status-banner is-warn" role="status">
          <span>{t.jsonTool.precisionNotice}</span>
        </div>
      )}

      {result.status === "valid" && result.duplicateKeyCount > 0 && (
        <div className="status-banner is-warn" role="status">
          <span>{t.jsonTool.duplicateKeyNotice(result.duplicateKeyCount)}</span>
        </div>
      )}

      {ioMessage && (
        <div
          className={`status-banner ${ioMessage.kind === "ok" ? "is-ok" : "is-err"}`}
          role={ioMessage.kind === "err" ? "alert" : "status"}
        >
          <span>{ioMessage.text}</span>
        </div>
      )}

      {/* Split Input + Output Panes */}
      <div className="split-panes">
        <div className={`pane ${dropHover ? "is-drop-hover" : ""}`}>
          <div className="pane-header">
            <label htmlFor="json-input-editor" className="pane-title">
              {t.jsonTool.inputLabel}
            </label>
            {sourceFilePath && (
              <span
                className="mono"
                style={{
                  fontSize: "11.5px",
                  color: "var(--text-muted)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: "60%",
                }}
                title={sourceFilePath}
              >
                {sourceFilePath}
              </span>
            )}
          </div>
          <textarea
            id="json-input-editor"
            ref={inputRef}
            className="code-editor"
            placeholder={t.jsonTool.placeholder}
            spellCheck={false}
            value={inputText}
            onChange={(e) => {
              setIoMessage(null);
              updateJsonSession({ inputText: e.target.value });
            }}
          />
        </div>

        <div className="pane">
          <div className="pane-header">
            <label htmlFor="json-output-editor" className="pane-title">
              {t.jsonTool.outputLabel}
            </label>
          </div>
          <textarea
            id="json-output-editor"
            className="code-editor"
            readOnly
            spellCheck={false}
            value={mode === "validate" ? "" : outputText}
            placeholder={mode === "validate" ? t.jsonTool.validateBtn : ""}
          />
        </div>
      </div>

      <ConfirmDialog
        open={pendingOverwritePath !== null}
        title={t.jsonTool.overwriteConfirmTitle}
        body={t.jsonTool.overwriteConfirmBody(pendingOverwritePath ?? "")}
        confirmLabel={t.jsonTool.overwriteConfirmAccept}
        cancelLabel={t.jsonTool.cancel}
        onCancel={() => setPendingOverwritePath(null)}
        onConfirm={async () => {
          const path = pendingOverwritePath;
          setPendingOverwritePath(null);
          if (path) {
            await executeSave(path, true);
          }
        }}
      />
    </div>
  );
}
