import { Check, Copy, Eraser, FolderOpen, Play, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore } from "../../lib/sessionStore";
import {
  bindDisposableListener,
  codecGetFullText,
  codecSaveOutput,
  codecTransformFile,
  codecTransformText,
  formatLocalizedError,
  parseBackendError,
  pickSaveFilePath,
  pickSingleFile,
  subscribeFileDrop,
  suggestSafeSiblingPath,
} from "../../lib/tauriBridge";
import {
  PREVIEW_CHAR_LIMIT,
  type Base64WrapWidth,
  type CodecFormat,
  type CodecOperation,
  type CodecOptions,
} from "./codecEngine";

export function CodecWorkspace() {
  const { t } = useI18n();
  const { session, updateCodecSession } = useSessionStore();
  const {
    inputMode,
    textInput,
    filePath,
    fileName,
    format,
    operation,
    padding,
    wrap,
    ignoreWhitespace,
    uppercaseHex,
    groupBits,
    result,
    errorMessage,
    savedMessage,
  } = session.codec;

  const reqSeqRef = useRef(0);
  const [copied, setCopied] = useState(false);
  const [dropHover, setDropHover] = useState(false);
  const [pendingOverwritePath, setPendingOverwritePath] = useState<string | null>(null);

  const currentOptions: CodecOptions = useMemo(
    () => ({
      format,
      operation,
      padding,
      wrap,
      ignoreWhitespace,
      uppercaseHex,
      groupBits,
    }),
    [format, groupBits, ignoreWhitespace, operation, padding, uppercaseHex, wrap],
  );

  const runTextTransform = useCallback(
    async (value: string, opts: CodecOptions) => {
      const seq = ++reqSeqRef.current;
      if (value.length === 0) {
        updateCodecSession({ result: null, errorMessage: null, savedMessage: null });
        return;
      }
      try {
        const res = await codecTransformText(value, opts);
        if (seq !== reqSeqRef.current) return;
        updateCodecSession({ result: res, errorMessage: null, savedMessage: null });
      } catch (err) {
        if (seq !== reqSeqRef.current) return;
        updateCodecSession({
          result: null,
          errorMessage: formatLocalizedError(err, t),
          savedMessage: null,
        });
      }
    },
    [t, updateCodecSession],
  );

  const runFileTransform = useCallback(
    async (targetPath: string, opts: CodecOptions) => {
      const seq = ++reqSeqRef.current;
      const baseName = targetPath.split(/[\\/]/).pop() ?? targetPath;
      updateCodecSession({
        inputMode: "file",
        filePath: targetPath,
        fileName: baseName,
        result: null,
        errorMessage: null,
        savedMessage: null,
      });
      try {
        const res = await codecTransformFile(targetPath, opts);
        if (seq !== reqSeqRef.current) return;
        updateCodecSession({
          fileName: res.fileName ?? baseName,
          result: res,
          errorMessage: null,
        });
      } catch (err) {
        if (seq !== reqSeqRef.current) return;
        updateCodecSession({
          result: null,
          errorMessage: formatLocalizedError(err, t),
        });
      }
    },
    [t, updateCodecSession],
  );

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: (hovering) => setDropHover(hovering),
          onDropPaths: (paths) => {
            const first = paths[0];
            if (first) {
              void runFileTransform(first, currentOptions);
            }
          },
        }),
      "d02-codec-drop",
    );
  }, [currentOptions, runFileTransform]);

  const applyOptionsPatch = (patch: Partial<CodecOptions>) => {
    const nextOpts: CodecOptions = { ...currentOptions, ...patch };
    updateCodecSession({ ...patch, result: null, errorMessage: null, savedMessage: null });
    if (inputMode === "text") {
      void runTextTransform(textInput, nextOpts);
    } else if (filePath) {
      void runFileTransform(filePath, nextOpts);
    }
  };

  const handleSwitchInputMode = (nextMode: "text" | "file") => {
    if (nextMode === inputMode) return;
    ++reqSeqRef.current;
    updateCodecSession({
      inputMode: nextMode,
      result: null,
      errorMessage: null,
      savedMessage: null,
    });
    if (nextMode === "text" && textInput.length > 0) {
      void runTextTransform(textInput, currentOptions);
    } else if (nextMode === "file" && filePath) {
      void runFileTransform(filePath, currentOptions);
    }
  };

  const handleSelectFormat = (nextFormat: CodecFormat) => {
    const defaultPad =
      nextFormat === "base64_standard" ? true : nextFormat === "base64_url" ? false : padding;
    applyOptionsPatch({ format: nextFormat, padding: defaultPad });
  };

  const handleSelectOperation = (nextOp: CodecOperation) => {
    applyOptionsPatch({ operation: nextOp });
  };

  const handleChooseFile = async () => {
    const picked = await pickSingleFile({ title: t.codecTool.selectFileBtn });
    if (picked) {
      await runFileTransform(picked, currentOptions);
    }
  };

  const handleCopyFull = async () => {
    if (!result || !result.isValidUtf8) return;
    try {
      const fullText = result.truncated
        ? await codecGetFullText({
            textInput: inputMode === "text" ? textInput : null,
            filePath: inputMode === "file" ? filePath : null,
            options: currentOptions,
          })
        : result.previewText;
      await navigator.clipboard.writeText(fullText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (err) {
      updateCodecSession({ errorMessage: formatLocalizedError(err, t) });
    }
  };

  const executeSaveToPath = async (targetPath: string, overwrite: boolean) => {
    try {
      const saved = await codecSaveOutput({
        textInput: inputMode === "text" ? textInput : null,
        sourceFilePath: inputMode === "file" ? filePath : null,
        outputPath: targetPath,
        overwrite,
        options: currentOptions,
      });
      setPendingOverwritePath(null);
      updateCodecSession({
        savedMessage: t.codecTool.savedSuccess(saved.path, saved.byteLength),
        errorMessage: null,
      });
    } catch (err) {
      const parsed = parseBackendError(err);
      if (parsed.code === "TARGET_ALREADY_EXISTS" && !overwrite) {
        setPendingOverwritePath(targetPath);
        return;
      }
      setPendingOverwritePath(null);
      updateCodecSession({ errorMessage: formatLocalizedError(err, t) });
    }
  };

  const handleSaveAs = async () => {
    if (!result) return;
    const defaultExt =
      operation === "encode"
        ? format === "hex"
          ? "hex.txt"
          : format === "binary"
            ? "bits.txt"
            : "b64.txt"
        : result.isValidUtf8
          ? "txt"
          : "bin";

    const defaultPath =
      inputMode === "file" && filePath
        ? ((await suggestSafeSiblingPath(
            filePath,
            operation === "encode" ? "_encoded" : "_decoded",
            defaultExt,
          )) ?? undefined)
        : `winkit_${operation}.${defaultExt}`;

    const target = await pickSaveFilePath({
      title: t.codecTool.saveOutputBtn,
      defaultPath,
    });
    if (target) {
      await executeSaveToPath(target, false);
    }
  };

  const handleClear = () => {
    ++reqSeqRef.current;
    setCopied(false);
    updateCodecSession({
      textInput: "",
      filePath: null,
      fileName: null,
      result: null,
      errorMessage: null,
      savedMessage: null,
    });
  };

  const isBase64 = format === "base64_standard" || format === "base64_url";

  return (
    <div className="tool-workspace">
      <div className="tool-toolbar">
        <div className="tool-toolbar-group">
          <div className="segmented" role="group" aria-label="Input mode">
            <button
              type="button"
              className={`segmented-btn ${inputMode === "text" ? "is-selected" : ""}`}
              aria-pressed={inputMode === "text"}
              onClick={() => handleSwitchInputMode("text")}
            >
              {t.codecTool.modeText}
            </button>
            <button
              type="button"
              className={`segmented-btn ${inputMode === "file" ? "is-selected" : ""}`}
              aria-pressed={inputMode === "file"}
              onClick={() => handleSwitchInputMode("file")}
            >
              {t.codecTool.modeFile}
            </button>
          </div>

          <div className="segmented" role="group" aria-label="Operation">
            <button
              type="button"
              className={`segmented-btn ${operation === "encode" ? "is-selected" : ""}`}
              aria-pressed={operation === "encode"}
              onClick={() => handleSelectOperation("encode")}
            >
              {t.codecTool.opEncode}
            </button>
            <button
              type="button"
              className={`segmented-btn ${operation === "decode" ? "is-selected" : ""}`}
              aria-pressed={operation === "decode"}
              onClick={() => handleSelectOperation("decode")}
            >
              {t.codecTool.opDecode}
            </button>
          </div>

          <div className="segmented" role="group" aria-label="Format">
            {(
              [
                ["base64_standard", t.codecTool.formatStdB64],
                ["base64_url", t.codecTool.formatUrlB64],
                ["hex", t.codecTool.formatHex],
                ["binary", t.codecTool.formatBinary],
              ] as const
            ).map(([fmtId, label]) => (
              <button
                key={fmtId}
                type="button"
                className={`segmented-btn ${format === fmtId ? "is-selected" : ""}`}
                aria-pressed={format === fmtId}
                onClick={() => handleSelectFormat(fmtId)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="tool-toolbar-group">
          {inputMode === "file" && (
            <>
              <button type="button" className="btn" onClick={() => void handleChooseFile()}>
                <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{t.codecTool.selectFileBtn}</span>
              </button>
              {filePath && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => void runFileTransform(filePath, currentOptions)}
                >
                  <Play size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{t.codecTool.runFileBtn}</span>
                </button>
              )}
            </>
          )}

          <button
            type="button"
            className="btn btn-primary"
            disabled={!result || !result.isValidUtf8}
            onClick={() => void handleCopyFull()}
          >
            {copied ? (
              <Check size={14} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
            )}
            <span>{copied ? t.codecTool.copiedBadge : t.codecTool.copyFullBtn}</span>
          </button>

          <button
            type="button"
            className="btn"
            disabled={!result}
            onClick={() => void handleSaveAs()}
          >
            <Save size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{t.codecTool.saveOutputBtn}</span>
          </button>

          <button type="button" className="btn" onClick={handleClear}>
            <Eraser size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{t.codecTool.clearBtn}</span>
          </button>
        </div>
      </div>

      {/* Format-specific options bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
          flexWrap: "wrap",
        }}
      >
        <div className="tool-toolbar-group">
          {isBase64 && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={padding}
                onChange={(e) => applyOptionsPatch({ padding: e.target.checked })}
              />
              <span>
                {operation === "encode"
                  ? t.codecTool.paddingLabel
                  : t.codecTool.strictPaddingDecodeLabel}
              </span>
            </label>
          )}

          {isBase64 && operation === "encode" && (
            <div className="segmented" role="group" aria-label={t.codecTool.wrapLabel}>
              {(
                [
                  ["none", t.codecTool.wrapNone],
                  ["cols64", t.codecTool.wrap64],
                  ["cols76", t.codecTool.wrap76],
                ] as Array<[Base64WrapWidth, string]>
              ).map(([wId, wLabel]) => (
                <button
                  key={wId}
                  type="button"
                  className={`segmented-btn ${wrap === wId ? "is-selected" : ""}`}
                  aria-pressed={wrap === wId}
                  onClick={() => applyOptionsPatch({ wrap: wId })}
                >
                  {wLabel}
                </button>
              ))}
            </div>
          )}

          {operation === "decode" && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={ignoreWhitespace}
                onChange={(e) => applyOptionsPatch({ ignoreWhitespace: e.target.checked })}
              />
              <span>{t.codecTool.ignoreWsLabel}</span>
            </label>
          )}

          {format === "hex" && operation === "encode" && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={uppercaseHex}
                onChange={(e) => applyOptionsPatch({ uppercaseHex: e.target.checked })}
              />
              <span>{t.codecTool.upperHexLabel}</span>
            </label>
          )}

          {format === "binary" && operation === "encode" && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={groupBits}
                onChange={(e) => applyOptionsPatch({ groupBits: e.target.checked })}
              />
              <span>{t.codecTool.groupBitsLabel}</span>
            </label>
          )}
        </div>

        <p className="field-hint" style={{ margin: 0 }}>
          {t.codecTool.scopeNote}
        </p>
      </div>

      {savedMessage && (
        <div className="status-banner is-ok" role="status">
          <span>{savedMessage}</span>
        </div>
      )}

      {errorMessage && (
        <div className="status-banner is-err" role="alert">
          <span>{errorMessage}</span>
        </div>
      )}

      <div className="split-panes">
        {/* Left Pane: Input */}
        <div className={`pane ${dropHover ? "is-drop-hover" : ""}`}>
          <div className="pane-header">
            <label htmlFor="codec-text-input" className="pane-title">
              {t.codecTool.inputLabel}
            </label>
            {result && (
              <span className="mono" style={{ fontSize: "11.5px", color: "var(--text-muted)" }}>
                {t.codecTool.statsSummary(result.inputByteLength, result.outputByteLength)}
              </span>
            )}
          </div>

          {inputMode === "text" ? (
            <textarea
              id="codec-text-input"
              className="code-editor"
              spellCheck={false}
              placeholder={
                operation === "encode"
                  ? t.codecTool.textPlaceholderEncode
                  : t.codecTool.textPlaceholderDecode
              }
              value={textInput}
              onChange={(e) => {
                const val = e.target.value;
                updateCodecSession({ textInput: val });
                void runTextTransform(val, currentOptions);
              }}
            />
          ) : (
            <div
              style={{
                padding: "20px",
                display: "flex",
                flexDirection: "column",
                gap: "12px",
                flex: 1,
                justifyContent: "center",
              }}
            >
              {filePath ? (
                <div className="field-stack">
                  <div
                    className="mono"
                    style={{
                      padding: "10px 12px",
                      borderRadius: "6px",
                      background: "var(--bg-subtle)",
                      border: "1px solid var(--border-subtle)",
                      wordBreak: "break-all",
                      fontSize: "12px",
                    }}
                  >
                    <strong>{fileName}</strong>
                    <div style={{ color: "var(--text-muted)", marginTop: "4px" }}>{filePath}</div>
                  </div>
                </div>
              ) : (
                <div className="empty-state" style={{ borderStyle: "dashed" }}>
                  <p style={{ margin: "0 0 12px" }}>{t.codecTool.dropFileHint}</p>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void handleChooseFile()}
                  >
                    <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
                    <span>{t.codecTool.selectFileBtn}</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Pane: Output */}
        <div className="pane">
          <div className="pane-header">
            <label htmlFor="codec-output-view" className="pane-title">
              {t.codecTool.outputLabel}
            </label>
            {result && (
              <span className={`badge ${result.isValidUtf8 ? "badge-ok" : "badge-partial"}`}>
                {result.isValidUtf8 ? "UTF-8" : "RAW BYTES"}
              </span>
            )}
          </div>

          {!result ? (
            <div
              style={{
                padding: "24px",
                color: "var(--text-muted)",
                fontSize: "12.5px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flex: 1,
              }}
            >
              {t.codecTool.emptyOutput}
            </div>
          ) : !result.isValidUtf8 ? (
            <div
              style={{
                padding: "14px",
                display: "flex",
                flexDirection: "column",
                gap: "10px",
                flex: 1,
              }}
            >
              <div className="status-banner is-warn" role="status">
                <span>{t.codecTool.binaryNonUtf8Banner(result.outputByteLength)}</span>
              </div>
              <span className="field-label">{t.codecTool.hexPreviewHeading}</span>
              <textarea
                id="codec-output-view"
                className="code-editor"
                style={{
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "6px",
                  background: "var(--bg-subtle)",
                }}
                readOnly
                value={result.hexPreview ?? ""}
              />
            </div>
          ) : (
            <>
              {result.truncated && (
                <div style={{ padding: "8px 12px 0" }}>
                  <div className="status-banner is-warn" role="status">
                    <span>
                      {t.codecTool.truncationBanner(
                        PREVIEW_CHAR_LIMIT,
                        result.totalChars,
                        result.outputByteLength,
                      )}
                    </span>
                  </div>
                </div>
              )}
              <textarea
                id="codec-output-view"
                className="code-editor"
                readOnly
                value={result.previewText}
              />
            </>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={pendingOverwritePath !== null}
        title={t.codecTool.overwriteConfirmTitle}
        body={t.codecTool.overwriteConfirmBody(pendingOverwritePath ?? "")}
        confirmLabel={t.codecTool.overwriteConfirmAccept}
        cancelLabel={t.codecTool.cancel}
        onCancel={() => setPendingOverwritePath(null)}
        onConfirm={() => {
          if (pendingOverwritePath) {
            void executeSaveToPath(pendingOverwritePath, true);
          }
        }}
      />
    </div>
  );
}
