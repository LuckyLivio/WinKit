import { Check, Copy, Download, Eraser, FolderOpen, Sparkles, Square } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore } from "../../lib/sessionStore";
import { isFrontendShuttingDown } from "../../lib/shutdownGate";
import {
  bindDisposableListener,
  formatLocalizedError,
  parseBackendError,
  pickSaveFilePath,
  pickSingleFile,
  readTabularTextFile,
  saveLocalTextFile,
  subscribeFileDrop,
  suggestSafeSiblingPath,
  writeSystemClipboardText,
} from "../../lib/tauriBridge";
import {
  MAX_NESTED_DEPTH,
  MAX_PREVIEW_CHARS,
  type ConcreteDelimiter,
  type ConversionDirection,
  type CsvDelimiter,
  type CsvJsonOptions,
  type CsvLineEnding,
  type HeaderIssuePolicy,
  type JsonArrayCellMode,
  type PathConflictPolicy,
  type RaggedRowPolicy,
  type TabularConversionResult,
} from "./csvJsonEngine";
import { CancellableTabularController, type TabularWorkerLike } from "./tabularController";

const SAMPLE_CSV_FIDELITY = [
  "order_id,postal_code,amount,active,customer_note",
  '9007199254740993,00123,19.90,true," fragile, handle with ""care""\nsecond line"',
  '9007199254740994,07001,-42.50,false,"normal note"',
].join("\n");

const SAMPLE_JSON_NESTED = JSON.stringify(
  [
    {
      account_id: 9007199254740991,
      zip_code: "00123",
      address: { city: "Shanghai", district: "Xuhui" },
      tags: ["vip", "local"],
      audit: [{ step: 1, ok: true }],
    },
    {
      account_id: 9007199254740992,
      zip_code: "02139",
      address: { city: "Boston", zip: "02139" },
      tags: ["standard"],
      audit: [],
    },
  ],
  null,
  2,
).replace("9007199254740991", "9007199254740993");

export function CsvJsonWorkspace({
  workerFactory,
}: {
  workerFactory?: () => TabularWorkerLike;
} = {}) {
  const { t } = useI18n();
  const { session, updateCsvJsonSession } = useSessionStore();
  const state = session.csvJson;

  const inputId = useId();
  const outputId = useId();
  const headerPolId = useId();
  const raggedPolId = useId();
  const arrayModeId = useId();
  const pathPolId = useId();
  const eolSelectId = useId();

  const controllerRef = useRef<CancellableTabularController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new CancellableTabularController(workerFactory);
  }

  const evalGenRef = useRef(0);
  const mountedRef = useRef(true);
  const sourceFilePathRef = useRef<string | null>(state.sourceFilePath);
  sourceFilePathRef.current = state.sourceFilePath;

  const [evalPhase, setEvalPhase] = useState<"idle" | "running" | "cancelled" | "done">("idle");
  const [boundEval, setBoundEval] = useState<{
    gen: number;
    options: CsvJsonOptions;
    sourceFilePath: string | null;
    result: TabularConversionResult;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [dropHovering, setDropHovering] = useState(false);
  const [ioBanner, setIoBanner] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [pendingOverwriteSnapshot, setPendingOverwriteSnapshot] = useState<{
    gen: number;
    targetPath: string;
    fullOutput: string;
    sourceFilePath: string | null;
  } | null>(null);

  const optionsObj = useMemo(
    (): CsvJsonOptions => ({
      direction: state.direction,
      delimiter: state.delimiter,
      firstRowHeaders: state.firstRowHeaders,
      detectTypes: state.detectTypes,
      emptyCellsAsNull: state.emptyCellsAsNull,
      headerIssuePolicy: state.headerIssuePolicy,
      raggedRowPolicy: state.raggedRowPolicy,
      arrayMode: state.arrayMode,
      pathConflictPolicy: state.pathConflictPolicy,
      formulaProtection: state.formulaProtection,
      csvLineEnding: state.csvLineEnding,
      csvIncludeBom: state.csvIncludeBom,
    }),
    [
      state.direction,
      state.delimiter,
      state.firstRowHeaders,
      state.detectTypes,
      state.emptyCellsAsNull,
      state.headerIssuePolicy,
      state.raggedRowPolicy,
      state.arrayMode,
      state.pathConflictPolicy,
      state.formulaProtection,
      state.csvLineEnding,
      state.csvIncludeBom,
    ],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      evalGenRef.current += 1;
      controllerRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    // Immediately invalidate any previous Worker or pending debounce before scheduling new evaluation
    controllerRef.current?.cancelCurrent();
    const myGen = ++evalGenRef.current;
    setPendingOverwriteSnapshot(null);

    const stripped =
      state.inputText.charCodeAt(0) === 0xfeff ? state.inputText.slice(1) : state.inputText;
    if (stripped.length === 0) {
      setEvalPhase("idle");
      setBoundEval(null);
      return;
    }

    const inputSnapshot = state.inputText;
    const optionsSnapshot = optionsObj;
    const sourcePathSnapshot = sourceFilePathRef.current;

    setEvalPhase("running");
    setBoundEval(null);
    const delayMs = inputSnapshot.length > 32_768 ? 140 : 0;

    const timer = window.setTimeout(() => {
      if (!mountedRef.current || isFrontendShuttingDown() || myGen !== evalGenRef.current) {
        return;
      }
      void controllerRef.current?.runConversion(inputSnapshot, optionsSnapshot).then((outcome) => {
        if (!mountedRef.current || isFrontendShuttingDown() || myGen !== evalGenRef.current) {
          return;
        }
        if (outcome.kind === "cancelled") {
          return;
        }
        if (outcome.kind === "worker_error") {
          setEvalPhase("done");
          setBoundEval({
            gen: myGen,
            options: optionsSnapshot,
            sourceFilePath: sourcePathSnapshot,
            result: {
              status: "error",
              code: "WORKER_ERROR",
              message: outcome.message,
            },
          });
          return;
        }
        setEvalPhase("done");
        setBoundEval({
          gen: myGen,
          options: optionsSnapshot,
          sourceFilePath: sourcePathSnapshot,
          result: outcome.result,
        });
      });
    }, delayMs);

    return () => {
      window.clearTimeout(timer);
      controllerRef.current?.cancelCurrent();
    };
  }, [state.inputText, optionsObj]);

  const loadLocalFileByPath = async (filePath: string) => {
    setIoBanner(null);
    setCopied(false);
    try {
      const payload = await readTabularTextFile(filePath);
      if (!mountedRef.current || isFrontendShuttingDown()) {
        return;
      }
      const lowerName = payload.fileName.toLowerCase();
      let nextDirection = state.direction;
      if (lowerName.endsWith(".json")) {
        if (state.direction === "csv_to_json") nextDirection = "json_to_csv";
        else if (state.direction === "csv_to_md") nextDirection = "json_to_md";
      } else if (lowerName.endsWith(".csv") || lowerName.endsWith(".tsv")) {
        if (state.direction === "json_to_csv") nextDirection = "csv_to_json";
        else if (state.direction === "json_to_md") nextDirection = "csv_to_md";
      }

      updateCsvJsonSession({
        inputText: payload.content,
        sourceFilePath: payload.path,
        sourceFileName: payload.fileName,
        direction: nextDirection,
      });
    } catch (err) {
      if (!mountedRef.current || isFrontendShuttingDown()) {
        return;
      }
      setIoBanner({
        kind: "err",
        text: formatLocalizedError(err, t),
      });
    }
  };

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: (hovering) => setDropHovering(hovering),
          onDropPaths: (paths) => {
            const first = paths[0];
            if (first) {
              void loadLocalFileByPath(first);
            }
          },
        }),
      "d14-file-drop",
    );
  }, [state.direction]);

  const handleOpenFile = async () => {
    const selected = await pickSingleFile({
      title: t.csvJsonTool.openFileBtn,
      filters: [{ name: "CSV / TSV / JSON", extensions: ["csv", "tsv", "json", "txt"] }],
    });
    if (selected) {
      await loadLocalFileByPath(selected);
    }
  };

  const handleCancelRunning = () => {
    evalGenRef.current += 1;
    controllerRef.current?.cancelCurrent();
    setPendingOverwriteSnapshot(null);
    setEvalPhase("cancelled");
    setBoundEval(null);
  };

  const currentEvalMatches = boundEval !== null && boundEval.gen === evalGenRef.current;
  const result = currentEvalMatches ? boundEval.result : null;
  const canExport = evalPhase === "done" && result !== null && result.status === "ok";

  const handleCopyFull = async () => {
    if (!canExport || !boundEval || boundEval.result.status !== "ok") return;
    const outputSnapshot = boundEval.result.fullOutput;
    const genSnapshot = boundEval.gen;
    try {
      await writeSystemClipboardText(outputSnapshot);
      if (!mountedRef.current || isFrontendShuttingDown() || evalGenRef.current !== genSnapshot) {
        return;
      }
      setCopied(true);
      window.setTimeout(() => {
        if (mountedRef.current) setCopied(false);
      }, 1500);
    } catch (err) {
      if (!mountedRef.current || isFrontendShuttingDown()) return;
      setIoBanner({ kind: "err", text: formatLocalizedError(err, t) });
    }
  };

  const executeSaveOutput = async (
    targetPath: string,
    overwrite: boolean,
    snapshot: { gen: number; fullOutput: string; sourceFilePath: string | null },
  ) => {
    if (!mountedRef.current || isFrontendShuttingDown()) return;
    if (evalGenRef.current !== snapshot.gen) {
      setIoBanner({ kind: "err", text: t.csvJsonTool.saveAbortedInputChanged });
      return;
    }
    setIoBanner(null);
    try {
      const saved = await saveLocalTextFile({
        outputPath: targetPath,
        sourcePath: snapshot.sourceFilePath,
        content: snapshot.fullOutput,
        overwrite,
        toolId: "D14",
      });
      if (!mountedRef.current || isFrontendShuttingDown()) return;
      setIoBanner({
        kind: "ok",
        text: t.csvJsonTool.savedSuccess(saved.path, saved.byteLength),
      });
    } catch (err) {
      if (!mountedRef.current || isFrontendShuttingDown()) return;
      const parsed = parseBackendError(err);
      if (parsed.code === "TARGET_ALREADY_EXISTS" && !overwrite) {
        if (evalGenRef.current !== snapshot.gen) {
          setIoBanner({ kind: "err", text: t.csvJsonTool.saveAbortedInputChanged });
          return;
        }
        setPendingOverwriteSnapshot({
          gen: snapshot.gen,
          targetPath,
          fullOutput: snapshot.fullOutput,
          sourceFilePath: snapshot.sourceFilePath,
        });
        return;
      }
      setIoBanner({
        kind: "err",
        text: formatLocalizedError(err, t),
      });
    }
  };

  const handleSaveAs = async () => {
    if (!canExport || !boundEval || boundEval.result.status !== "ok") return;
    const snapshot = {
      gen: boundEval.gen,
      fullOutput: boundEval.result.fullOutput,
      sourceFilePath: boundEval.sourceFilePath,
      outExt:
        boundEval.options.direction === "csv_to_json"
          ? "json"
          : boundEval.options.direction === "json_to_csv"
            ? boundEval.options.delimiter === "\t"
              ? "tsv"
              : "csv"
            : "md",
    } as const;

    const defaultPath = snapshot.sourceFilePath
      ? ((await suggestSafeSiblingPath(snapshot.sourceFilePath, "_converted", snapshot.outExt)) ??
        `converted.${snapshot.outExt}`)
      : `converted.${snapshot.outExt}`;

    if (!mountedRef.current || isFrontendShuttingDown()) return;
    if (evalGenRef.current !== snapshot.gen) {
      setIoBanner({ kind: "err", text: t.csvJsonTool.saveAbortedInputChanged });
      return;
    }

    const chosen = await pickSaveFilePath({
      title: t.csvJsonTool.saveBtn,
      defaultPath,
      filters: [{ name: snapshot.outExt.toUpperCase(), extensions: [snapshot.outExt] }],
    });
    if (!chosen || !mountedRef.current || isFrontendShuttingDown()) return;
    if (evalGenRef.current !== snapshot.gen) {
      setIoBanner({ kind: "err", text: t.csvJsonTool.saveAbortedInputChanged });
      return;
    }
    await executeSaveOutput(chosen, false, snapshot);
  };

  const formatDelimName = (d: ConcreteDelimiter): string => {
    if (d === ",") return t.csvJsonTool.delimComma;
    if (d === ";") return t.csvJsonTool.delimSemicolon;
    return t.csvJsonTool.delimTab;
  };

  const isJsonInput = state.direction === "json_to_csv" || state.direction === "json_to_md";
  const isCsvOutput = state.direction === "json_to_csv";

  const directionChoices: Array<[ConversionDirection, string]> = [
    ["csv_to_json", t.csvJsonTool.dirCsvToJson],
    ["json_to_csv", t.csvJsonTool.dirJsonToCsv],
    ["csv_to_md", t.csvJsonTool.dirCsvToMd],
    ["json_to_md", t.csvJsonTool.dirJsonToMd],
  ];

  const delimiterChoices: Array<[CsvDelimiter, string]> = [
    ["auto", t.csvJsonTool.delimAuto],
    [",", t.csvJsonTool.delimComma],
    [";", t.csvJsonTool.delimSemicolon],
    ["\t", t.csvJsonTool.delimTab],
  ];

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
                className={`segmented-btn ${state.direction === d ? "is-selected" : ""}`}
                aria-pressed={state.direction === d}
                onClick={() => {
                  setCopied(false);
                  setIoBanner(null);
                  updateCsvJsonSession({ direction: d });
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {(state.direction === "csv_to_json" ||
            state.direction === "csv_to_md" ||
            state.direction === "json_to_csv") && (
            <div className="segmented" role="group" aria-label={t.csvJsonTool.delimiterLabel}>
              {delimiterChoices
                .filter(([d]) => !(state.direction === "json_to_csv" && d === "auto"))
                .map(([d, label]) => (
                  <button
                    key={d}
                    type="button"
                    className={`segmented-btn ${
                      (state.direction === "json_to_csv" && state.delimiter === "auto"
                        ? ","
                        : state.delimiter) === d
                        ? "is-selected"
                        : ""
                    }`}
                    aria-pressed={
                      (state.direction === "json_to_csv" && state.delimiter === "auto"
                        ? ","
                        : state.delimiter) === d
                    }
                    onClick={() => {
                      setCopied(false);
                      updateCsvJsonSession({ delimiter: d });
                    }}
                  >
                    {label}
                  </button>
                ))}
            </div>
          )}

          {state.direction !== "json_to_md" && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={state.firstRowHeaders}
                onChange={(e) => {
                  setCopied(false);
                  updateCsvJsonSession({ firstRowHeaders: e.target.checked });
                }}
              />
              <span>{t.csvJsonTool.firstRowHeaders}</span>
            </label>
          )}

          {state.direction === "csv_to_json" && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={state.detectTypes}
                onChange={(e) => {
                  setCopied(false);
                  updateCsvJsonSession({ detectTypes: e.target.checked });
                }}
              />
              <span>{t.csvJsonTool.detectTypes}</span>
            </label>
          )}

          {isCsvOutput && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={state.formulaProtection}
                onChange={(e) => {
                  setCopied(false);
                  updateCsvJsonSession({ formulaProtection: e.target.checked });
                }}
              />
              <span>{t.csvJsonTool.formulaProtection}</span>
            </label>
          )}
        </div>

        <div className="tool-toolbar-group">
          <button type="button" className="btn" onClick={() => void handleOpenFile()}>
            <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{t.csvJsonTool.openFileBtn}</span>
          </button>

          <button
            type="button"
            className="btn"
            onClick={() => {
              setCopied(false);
              setIoBanner(null);
              updateCsvJsonSession({
                inputText: isJsonInput ? SAMPLE_JSON_NESTED : SAMPLE_CSV_FIDELITY,
                sourceFilePath: null,
                sourceFileName: null,
              });
            }}
          >
            <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{t.csvJsonTool.sampleBtn}</span>
          </button>

          {evalPhase === "running" && (
            <button type="button" className="btn btn-danger" onClick={handleCancelRunning}>
              <Square size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{t.csvJsonTool.cancelWorkerBtn}</span>
            </button>
          )}

          <button
            type="button"
            className="btn btn-primary"
            disabled={!canExport}
            onClick={() => void handleCopyFull()}
          >
            {copied ? (
              <Check size={14} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
            )}
            <span>{copied ? t.csvJsonTool.copiedBadge : t.csvJsonTool.copyBtn}</span>
          </button>

          <button
            type="button"
            className="btn"
            disabled={!canExport}
            onClick={() => void handleSaveAs()}
          >
            <Download size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{t.csvJsonTool.saveBtn}</span>
          </button>

          <button
            type="button"
            className="btn"
            disabled={state.inputText.length === 0}
            onClick={() => {
              setCopied(false);
              setIoBanner(null);
              updateCsvJsonSession({
                inputText: "",
                sourceFilePath: null,
                sourceFileName: null,
              });
            }}
          >
            <Eraser size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{t.csvJsonTool.clearBtn}</span>
          </button>
        </div>
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
          {t.csvJsonTool.advancedSummaryTitle}
        </summary>
        <div
          style={{
            marginTop: "10px",
            display: "flex",
            flexWrap: "wrap",
            gap: "12px",
            alignItems: "center",
          }}
        >
          {!isJsonInput ? (
            <>
              <label className="field-row" htmlFor={headerPolId} style={{ gap: "6px" }}>
                <span className="field-hint">{t.csvJsonTool.headerPolicyLabel}</span>
                <select
                  id={headerPolId}
                  className="select-input"
                  value={state.headerIssuePolicy}
                  onChange={(e) =>
                    updateCsvJsonSession({ headerIssuePolicy: e.target.value as HeaderIssuePolicy })
                  }
                >
                  <option value="error">{t.csvJsonTool.headerPolicyError}</option>
                  <option value="rename">{t.csvJsonTool.headerPolicyRename}</option>
                </select>
              </label>

              <label className="field-row" htmlFor={raggedPolId} style={{ gap: "6px" }}>
                <span className="field-hint">{t.csvJsonTool.raggedPolicyLabel}</span>
                <select
                  id={raggedPolId}
                  className="select-input"
                  value={state.raggedRowPolicy}
                  onChange={(e) =>
                    updateCsvJsonSession({ raggedRowPolicy: e.target.value as RaggedRowPolicy })
                  }
                >
                  <option value="error">{t.csvJsonTool.raggedPolicyError}</option>
                  <option value="pad_and_extend">{t.csvJsonTool.raggedPolicyPad}</option>
                </select>
              </label>

              {state.direction === "csv_to_json" && state.detectTypes && (
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={state.emptyCellsAsNull}
                    onChange={(e) => updateCsvJsonSession({ emptyCellsAsNull: e.target.checked })}
                  />
                  <span>{t.csvJsonTool.emptyCellsAsNull}</span>
                </label>
              )}
            </>
          ) : (
            <>
              <label className="field-row" htmlFor={arrayModeId} style={{ gap: "6px" }}>
                <span className="field-hint">{t.csvJsonTool.arrayModeLabel}</span>
                <select
                  id={arrayModeId}
                  className="select-input"
                  value={state.arrayMode}
                  onChange={(e) =>
                    updateCsvJsonSession({ arrayMode: e.target.value as JsonArrayCellMode })
                  }
                >
                  <option value="semicolon">{t.csvJsonTool.arrayModeSemicolon}</option>
                  <option value="compact_json">{t.csvJsonTool.arrayModeJson}</option>
                </select>
              </label>

              <label className="field-row" htmlFor={pathPolId} style={{ gap: "6px" }}>
                <span className="field-hint">{t.csvJsonTool.pathPolicyLabel}</span>
                <select
                  id={pathPolId}
                  className="select-input"
                  value={state.pathConflictPolicy}
                  onChange={(e) =>
                    updateCsvJsonSession({
                      pathConflictPolicy: e.target.value as PathConflictPolicy,
                    })
                  }
                >
                  <option value="error">{t.csvJsonTool.pathPolicyError}</option>
                  <option value="bracket_escape">{t.csvJsonTool.pathPolicyBracket}</option>
                </select>
              </label>

              {isCsvOutput && (
                <>
                  <label className="field-row" htmlFor={eolSelectId} style={{ gap: "6px" }}>
                    <span className="field-hint">{t.csvJsonTool.csvEolLabel}</span>
                    <select
                      id={eolSelectId}
                      className="select-input"
                      value={state.csvLineEnding}
                      onChange={(e) =>
                        updateCsvJsonSession({ csvLineEnding: e.target.value as CsvLineEnding })
                      }
                    >
                      <option value="lf">LF (\n)</option>
                      <option value="crlf">CRLF (\r\n)</option>
                    </select>
                  </label>

                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={state.csvIncludeBom}
                      onChange={(e) => updateCsvJsonSession({ csvIncludeBom: e.target.checked })}
                    />
                    <span>{t.csvJsonTool.csvBomLabel}</span>
                  </label>
                </>
              )}
            </>
          )}
        </div>
        <p className="field-hint" style={{ marginTop: "8px", lineHeight: "18px" }}>
          {t.csvJsonTool.mappingRulesNote}
        </p>
      </details>

      {ioBanner && (
        <div
          className={`status-banner ${ioBanner.kind === "ok" ? "is-ok" : "is-err"}`}
          role="status"
          data-testid="csvjson-io-banner"
        >
          <span>{ioBanner.text}</span>
        </div>
      )}

      <div
        className={`status-banner ${
          evalPhase === "running"
            ? ""
            : evalPhase === "cancelled"
              ? "is-warn"
              : result?.status === "error"
                ? "is-err"
                : result?.status === "ok"
                  ? "is-ok"
                  : ""
        }`}
        data-testid="csvjson-status-banner"
      >
        <span>
          {(evalPhase === "idle" || result?.status === "empty") && t.csvJsonTool.statusEmpty}
          {evalPhase === "running" && t.csvJsonTool.statusRunning}
          {evalPhase === "cancelled" && t.csvJsonTool.statusCancelled}
          {evalPhase === "done" &&
            result?.status === "ok" &&
            t.csvJsonTool.statusOk(result.rowCount, result.columnCount)}
          {evalPhase === "done" &&
            result?.status === "error" &&
            t.csvJsonTool.statusErrorLoc(
              result.message,
              result.physicalLine,
              result.column,
              result.recordNumber,
            )}
        </span>

        {evalPhase === "done" && result?.status === "ok" && result.detectedDelimiter && (
          <span className={`badge ${result.delimiterAmbiguous ? "badge-partial" : "badge-ok"}`}>
            {t.csvJsonTool.detectedDelimiterBadge(
              formatDelimName(result.detectedDelimiter),
              result.delimiterAmbiguous,
            )}
          </span>
        )}
      </div>

      {evalPhase === "done" && result?.status === "ok" && (
        <>
          {result.renamedHeaders.length > 0 && (
            <div className="status-banner is-warn">
              <span>
                {t.csvJsonTool.renamedHeadersNotice(
                  result.renamedHeaders
                    .map((h) => `#${h.columnIndex} "${h.original}" → "${h.renamedTo}"`)
                    .join(", "),
                )}
              </span>
            </div>
          )}

          {(result.paddedRowCount > 0 || result.extendedColumnCount > 0) && (
            <div className="status-banner is-warn">
              <span>
                {t.csvJsonTool.raggedAdjustedNotice(
                  result.paddedRowCount,
                  result.extendedColumnCount,
                )}
              </span>
            </div>
          )}

          {result.ambiguousScalarArrayCount > 0 && (
            <div className="status-banner is-warn">
              <span>{t.csvJsonTool.ambiguousArrayNotice(result.ambiguousScalarArrayCount)}</span>
            </div>
          )}

          {result.depthCappedCellCount > 0 && (
            <div className="status-banner is-warn">
              <span>
                {t.csvJsonTool.depthCappedNotice(result.depthCappedCellCount, MAX_NESTED_DEPTH)}
              </span>
            </div>
          )}

          {result.singleObjectNormalized && (
            <div className="status-banner">
              <span>{t.csvJsonTool.singleObjectNotice}</span>
            </div>
          )}

          {isCsvOutput && result.formulaLikeCellCount > 0 && (
            <div
              className="status-banner is-warn"
              style={{ flexDirection: "column", alignItems: "flex-start", gap: "6px" }}
              data-testid="csvjson-formula-banner"
            >
              <span>
                {state.formulaProtection
                  ? t.csvJsonTool.formulaProtectedInfo(result.formulaProtectedCount)
                  : t.csvJsonTool.formulaDetectedWarn(result.formulaLikeCellCount)}
              </span>
              {result.formulaPreviewSamples.length > 0 && (
                <div style={{ fontSize: "12px" }}>
                  <strong>{t.csvJsonTool.formulaPreviewHeading}</strong>{" "}
                  {result.formulaPreviewSamples
                    .map(
                      (s) =>
                        `[${s.columnName}${s.rowNumber > 0 ? ` #${s.rowNumber}` : ""}] ${JSON.stringify(s.original)} → ${JSON.stringify(s.protectedValue)}`,
                    )
                    .join(" · ")}
                </div>
              )}
            </div>
          )}
        </>
      )}

      <div className="split-panes" style={{ minHeight: "340px" }}>
        <div className={`pane ${dropHovering ? "is-drop-hover" : ""}`}>
          <div className="pane-header">
            <label className="pane-title" htmlFor={inputId}>
              {t.csvJsonTool.inputPaneTitle(state.sourceFileName)}
            </label>
          </div>
          <textarea
            id={inputId}
            className="code-editor"
            spellCheck={false}
            placeholder={isJsonInput ? t.csvJsonTool.jsonPlaceholder : t.csvJsonTool.csvPlaceholder}
            value={state.inputText}
            onChange={(e) => {
              setCopied(false);
              setIoBanner(null);
              updateCsvJsonSession({ inputText: e.target.value });
            }}
            data-testid="csvjson-input-editor"
          />
        </div>

        <div className="pane">
          <div className="pane-header">
            <label className="pane-title" htmlFor={outputId}>
              {t.csvJsonTool.outputPaneTitle}
            </label>

            <div className="segmented" role="group" aria-label="Output view">
              <button
                type="button"
                className={`segmented-btn ${state.outputViewMode === "text" ? "is-selected" : ""}`}
                aria-pressed={state.outputViewMode === "text"}
                onClick={() => updateCsvJsonSession({ outputViewMode: "text" })}
              >
                {t.csvJsonTool.viewTextTab}
              </button>
              <button
                type="button"
                className={`segmented-btn ${state.outputViewMode === "table" ? "is-selected" : ""}`}
                aria-pressed={state.outputViewMode === "table"}
                onClick={() => updateCsvJsonSession({ outputViewMode: "table" })}
              >
                {t.csvJsonTool.viewTableTab}
              </button>
            </div>
          </div>

          {canExport &&
            result.status === "ok" &&
            result.previewTruncated &&
            state.outputViewMode === "text" && (
              <div
                className="field-hint"
                style={{ padding: "6px 12px", borderBottom: "1px solid var(--border-subtle)" }}
              >
                {t.csvJsonTool.previewTruncatedNote(MAX_PREVIEW_CHARS, result.fullOutput.length)}
              </div>
            )}

          {canExport &&
            result.status === "ok" &&
            result.tablePreviewTruncated &&
            state.outputViewMode === "table" && (
              <div
                className="field-hint"
                style={{ padding: "6px 12px", borderBottom: "1px solid var(--border-subtle)" }}
              >
                {t.csvJsonTool.tableTruncatedNote(
                  result.tablePreviewRows.length,
                  result.rowCount,
                  result.tablePreviewHeaders.length,
                  result.columnCount,
                )}
              </div>
            )}

          {state.outputViewMode === "text" ? (
            <textarea
              id={outputId}
              className="code-editor"
              readOnly
              spellCheck={false}
              value={canExport && result.status === "ok" ? result.previewOutput : ""}
              data-testid="csvjson-output-editor"
            />
          ) : canExport && result.status === "ok" ? (
            <div style={{ flex: 1, overflow: "auto" }} data-testid="csvjson-table-preview">
              <table className="kv-table">
                <thead>
                  <tr>
                    <th style={{ width: "48px" }}>#</th>
                    {result.tablePreviewHeaders.map((h, i) => (
                      <th key={`th-${i}`} style={{ width: "auto" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.tablePreviewRows.map((row, rIdx) => (
                    <tr key={`tr-${rIdx}`}>
                      <td className="mono-inline" style={{ color: "var(--text-muted)" }}>
                        {rIdx + 1}
                      </td>
                      {row.map((cell, cIdx) => (
                        <td key={`td-${rIdx}-${cIdx}`} className="mono-inline">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state" style={{ margin: "24px" }}>
              {evalPhase === "running" ? t.csvJsonTool.statusRunning : t.csvJsonTool.statusEmpty}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={pendingOverwriteSnapshot !== null}
        title={t.csvJsonTool.overwriteConfirmTitle}
        body={t.csvJsonTool.overwriteConfirmBody(pendingOverwriteSnapshot?.targetPath ?? "")}
        confirmLabel={t.csvJsonTool.overwriteConfirmAccept}
        cancelLabel={t.csvJsonTool.cancel}
        onCancel={() => setPendingOverwriteSnapshot(null)}
        onConfirm={async () => {
          const snap = pendingOverwriteSnapshot;
          setPendingOverwriteSnapshot(null);
          if (snap) {
            await executeSaveOutput(snap.targetPath, true, snap);
          }
        }}
      />
    </div>
  );
}
