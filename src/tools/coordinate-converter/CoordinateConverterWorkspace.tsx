import {
  ArrowLeftRight,
  Check,
  Copy,
  Download,
  Eraser,
  FolderOpen,
  Sparkles,
  Square,
} from "lucide-react";
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
  readCoordBatchTextFile,
  saveLocalTextFile,
  subscribeFileDrop,
  suggestSafeSiblingPath,
  writeSystemClipboardText,
} from "../../lib/tauriBridge";
import {
  CancellableCoordinateBatchController,
  type CoordinateWorkerLike,
} from "./coordinateController";
import {
  calculateWgs84EllipsoidDistance,
  formatAllCoordinateOutputs,
  formatCleanDecimal,
  MAX_DD_DECIMALS,
  MAX_DM_DECIMALS,
  MAX_DMS_DECIMALS,
  MIN_DD_DECIMALS,
  MIN_DM_DECIMALS,
  MIN_DMS_DECIMALS,
  parseCoordinateInput,
  parseSeparateLatLonFields,
  serializeUnroundedPointForTransfer,
  type BatchCoordinateConversionResult,
  type BatchCoordinateOptions,
  type CoordinateOutputFormatId,
  type CoordinatePrecisionOptions,
  type PlainTextAxisOrder,
} from "./coordinateEngine";

const OUTPUT_FORMAT_ORDER: readonly CoordinateOutputFormatId[] = [
  "dd",
  "dms",
  "dm",
  "geojson",
  "wkt",
  "geo_uri",
  "apple_maps",
  "google_maps",
];

const SAMPLE_SINGLE_COORD = "37.8197, -122.4786";
const SAMPLE_BATCH_MIXED = [
  "37.8197, -122.4786",
  "35°41′22.2″N 139°41′30.12″E",
  '{"type":"Point","coordinates":[-0.1276,51.5072]}',
  "invalid address: 1600 Amphitheatre Parkway",
  "geo:-33.8688,151.2093",
].join("\n");

function parseStrictDigitRange(raw: string, min: number, max: number): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const val = Number(trimmed);
  if (!Number.isInteger(val) || val < min || val > max) return null;
  return val;
}

export function CoordinateConverterWorkspace({
  workerFactory,
}: {
  workerFactory?: () => CoordinateWorkerLike;
} = {}) {
  const { t } = useI18n();
  const { session, updateCoordinateSession } = useSessionStore();
  const state = session.coordinate;

  const singleInputId = useId();
  const sepLatId = useId();
  const sepLonId = useId();
  const ddDecId = useId();
  const dmDecId = useId();
  const dmsDecId = useId();
  const pointAId = useId();
  const pointBId = useId();
  const batchEditorId = useId();
  const batchFmtId = useId();
  const batchScopeId = useId();

  const controllerRef = useRef<CancellableCoordinateBatchController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new CancellableCoordinateBatchController(workerFactory);
  }

  const batchGenRef = useRef(0);
  const mountedRef = useRef(true);
  const batchSourcePathRef = useRef<string | null>(state.batchSourceFilePath);
  batchSourcePathRef.current = state.batchSourceFilePath;

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [ioBanner, setIoBanner] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [dropHovering, setDropHovering] = useState(false);

  const [batchPhase, setBatchPhase] = useState<"idle" | "running" | "cancelled" | "done">("idle");
  const [boundBatch, setBoundBatch] = useState<{
    gen: number;
    sourceFilePath: string | null;
    result: BatchCoordinateConversionResult;
  } | null>(null);
  const [pendingOverwriteSnapshot, setPendingOverwriteSnapshot] = useState<{
    gen: number;
    targetPath: string;
    csvContent: string;
    sourceFilePath: string | null;
  } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      batchGenRef.current += 1;
      controllerRef.current?.dispose();
    };
  }, []);

  const precisionValidation = useMemo(():
    { ok: true; precision: CoordinatePrecisionOptions } | { ok: false; message: string } => {
    const dd = parseStrictDigitRange(state.ddDecimals, MIN_DD_DECIMALS, MAX_DD_DECIMALS);
    if (dd === null) {
      return {
        ok: false,
        message: `${t.coordinateTool.ddDecLabel}: ${MIN_DD_DECIMALS}–${MAX_DD_DECIMALS}`,
      };
    }
    const dm = parseStrictDigitRange(state.dmDecimals, MIN_DM_DECIMALS, MAX_DM_DECIMALS);
    if (dm === null) {
      return {
        ok: false,
        message: `${t.coordinateTool.dmDecLabel}: ${MIN_DM_DECIMALS}–${MAX_DM_DECIMALS}`,
      };
    }
    const dms = parseStrictDigitRange(state.dmsDecimals, MIN_DMS_DECIMALS, MAX_DMS_DECIMALS);
    if (dms === null) {
      return {
        ok: false,
        message: `${t.coordinateTool.dmsDecLabel}: ${MIN_DMS_DECIMALS}–${MAX_DMS_DECIMALS}`,
      };
    }
    return {
      ok: true,
      precision: { ddDecimals: dd, dmDecimals: dm, dmsDecimals: dms },
    };
  }, [state.ddDecimals, state.dmDecimals, state.dmsDecimals, t]);

  // 1. Single-point parsing & 8-format evaluation (pure, synchronous, unrounded internal point)
  const singleParsed = useMemo(() => {
    if (state.singleInputMode === "separate") {
      return parseSeparateLatLonFields(state.separateLatInput, state.separateLonInput);
    }
    return parseCoordinateInput(state.singleRawInput, {
      plainAxisOrder: state.plainAxisOrder,
    });
  }, [
    state.singleInputMode,
    state.singleRawInput,
    state.separateLatInput,
    state.separateLonInput,
    state.plainAxisOrder,
  ]);

  const singleOutputs = useMemo(() => {
    if (!singleParsed.ok || !precisionValidation.ok) return null;
    return formatAllCoordinateOutputs(singleParsed.point, precisionValidation.precision);
  }, [singleParsed, precisionValidation]);

  // 2. Two-point geodesic distance evaluation (always uses unrounded parsed points, never truncated display strings)
  const distanceEvaluation = useMemo(() => {
    const aTrim = state.pointAInput.trim();
    const bTrim = state.pointBInput.trim();
    if (aTrim.length === 0 && bTrim.length === 0) {
      return { kind: "empty" as const };
    }
    const parsedA =
      aTrim.length > 0
        ? parseCoordinateInput(state.pointAInput, { plainAxisOrder: state.distanceAxisOrder })
        : null;
    const parsedB =
      bTrim.length > 0
        ? parseCoordinateInput(state.pointBInput, { plainAxisOrder: state.distanceAxisOrder })
        : null;

    if (parsedA && !parsedA.ok) {
      return {
        kind: "error" as const,
        message: t.coordinateTool.pointAErrorPrefix(parsedA.message),
      };
    }
    if (parsedB && !parsedB.ok) {
      return {
        kind: "error" as const,
        message: t.coordinateTool.pointBErrorPrefix(parsedB.message),
      };
    }
    if (!parsedA || !parsedB || !parsedA.ok || !parsedB.ok) {
      return { kind: "incomplete" as const };
    }

    const dist = calculateWgs84EllipsoidDistance(parsedA.point, parsedB.point);
    if (!dist.ok) {
      const msg =
        dist.pointRole === "A"
          ? t.coordinateTool.pointAErrorPrefix(dist.message)
          : dist.pointRole === "B"
            ? t.coordinateTool.pointBErrorPrefix(dist.message)
            : dist.message;
      return { kind: "error" as const, message: msg };
    }

    return {
      kind: "ok" as const,
      pointA: parsedA.point,
      pointB: parsedB.point,
      distance: dist,
    };
  }, [state.pointAInput, state.pointBInput, state.distanceAxisOrder, t]);

  // 3. Bounded batch evaluation in dedicated Web Worker with generation-bound ownership
  const batchOptionsObj = useMemo((): BatchCoordinateOptions | null => {
    if (!precisionValidation.ok) return null;
    return {
      plainAxisOrder: state.plainAxisOrder,
      outputFormat: state.batchOutputFormat,
      precision: precisionValidation.precision,
      csvExportScope: state.batchCsvScope,
      formulaProtection: state.batchFormulaProtection,
    };
  }, [
    precisionValidation,
    state.plainAxisOrder,
    state.batchOutputFormat,
    state.batchCsvScope,
    state.batchFormulaProtection,
  ]);

  useEffect(() => {
    controllerRef.current?.cancelCurrent();
    const myGen = ++batchGenRef.current;
    setPendingOverwriteSnapshot(null);

    const stripped =
      state.batchInputText.charCodeAt(0) === 0xfeff
        ? state.batchInputText.slice(1)
        : state.batchInputText;
    if (stripped.trim().length === 0 || !batchOptionsObj) {
      setBatchPhase("idle");
      setBoundBatch(null);
      return;
    }

    const inputSnap = state.batchInputText;
    const optsSnap = batchOptionsObj;
    const sourceSnap = batchSourcePathRef.current;

    setBatchPhase("running");
    setBoundBatch(null);
    const delayMs = inputSnap.length > 16_384 ? 120 : 0;

    const timer = window.setTimeout(() => {
      if (!mountedRef.current || isFrontendShuttingDown() || myGen !== batchGenRef.current) {
        return;
      }
      void controllerRef.current?.runBatch(inputSnap, optsSnap).then((outcome) => {
        if (!mountedRef.current || isFrontendShuttingDown() || myGen !== batchGenRef.current) {
          return;
        }
        if (outcome.kind === "cancelled") {
          return;
        }
        if (outcome.kind === "worker_error") {
          setBatchPhase("done");
          setBoundBatch({
            gen: myGen,
            sourceFilePath: sourceSnap,
            result: {
              status: "error",
              code: "BATCH_OUTPUT_LIMIT_EXCEEDED",
              message: outcome.message,
            },
          });
          return;
        }
        setBatchPhase("done");
        setBoundBatch({
          gen: myGen,
          sourceFilePath: sourceSnap,
          result: outcome.result,
        });
      });
    }, delayMs);

    return () => {
      window.clearTimeout(timer);
      controllerRef.current?.cancelCurrent();
    };
  }, [state.batchInputText, batchOptionsObj]);

  const loadBatchFileByPath = async (filePath: string) => {
    setIoBanner(null);
    setCopiedKey(null);
    try {
      const payload = await readCoordBatchTextFile(filePath);
      if (!mountedRef.current || isFrontendShuttingDown()) return;
      updateCoordinateSession({
        activeTab: "batch",
        batchInputText: payload.content,
        batchSourceFilePath: payload.path,
        batchSourceFileName: payload.fileName,
      });
    } catch (err) {
      if (!mountedRef.current || isFrontendShuttingDown()) return;
      setIoBanner({
        kind: "err",
        text: formatLocalizedError(err, t),
      });
    }
  };

  useEffect(() => {
    if (state.activeTab !== "batch") {
      setDropHovering(false);
      return;
    }
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: (hovering) => setDropHovering(hovering),
          onDropPaths: (paths) => {
            const first = paths[0];
            if (first) {
              void loadBatchFileByPath(first);
            }
          },
        }),
      "d10-batch-file-drop",
    );
  }, [state.activeTab]);

  const handleCopyText = async (text: string, key: string) => {
    try {
      await writeSystemClipboardText(text);
      if (!mountedRef.current || isFrontendShuttingDown()) return;
      setCopiedKey(key);
      window.setTimeout(() => {
        if (!mountedRef.current) return;
        setCopiedKey((prev) => (prev === key ? null : prev));
      }, 1500);
    } catch (err) {
      if (!mountedRef.current || isFrontendShuttingDown()) return;
      setIoBanner({ kind: "err", text: formatLocalizedError(err, t) });
    }
  };

  const handleOpenBatchFile = async () => {
    const selected = await pickSingleFile({
      title: t.coordinateTool.openBatchFileBtn,
      filters: [{ name: "UTF-8 Text / Coordinates", extensions: ["txt", "csv", "wkt", "log"] }],
    });
    if (selected) {
      await loadBatchFileByPath(selected);
    }
  };

  const handleCancelBatch = () => {
    batchGenRef.current += 1;
    controllerRef.current?.cancelCurrent();
    setPendingOverwriteSnapshot(null);
    setBatchPhase("cancelled");
    setBoundBatch(null);
  };

  const activeBatchMatches = boundBatch !== null && boundBatch.gen === batchGenRef.current;
  const batchResult = activeBatchMatches ? boundBatch.result : null;
  const canExportBatchCsv =
    batchPhase === "done" &&
    batchResult !== null &&
    batchResult.status === "ok" &&
    (state.batchCsvScope === "all_with_errors"
      ? batchResult.totalNonBlankCount > 0
      : batchResult.validCount > 0);
  const canCopyBatchValid =
    batchPhase === "done" &&
    batchResult !== null &&
    batchResult.status === "ok" &&
    batchResult.validCount > 0;

  const executeSaveBatchCsv = async (
    targetPath: string,
    overwrite: boolean,
    snapshot: { gen: number; csvContent: string; sourceFilePath: string | null },
  ) => {
    if (!mountedRef.current || isFrontendShuttingDown()) return;
    if (batchGenRef.current !== snapshot.gen) {
      setIoBanner({ kind: "err", text: t.coordinateTool.saveAbortedChanged });
      return;
    }
    setIoBanner(null);
    try {
      const saved = await saveLocalTextFile({
        outputPath: targetPath,
        sourcePath: snapshot.sourceFilePath,
        content: snapshot.csvContent,
        overwrite,
        toolId: "D10",
      });
      if (!mountedRef.current || isFrontendShuttingDown()) return;
      setIoBanner({
        kind: "ok",
        text: t.coordinateTool.savedCsvSuccess(saved.path, saved.byteLength),
      });
    } catch (err) {
      if (!mountedRef.current || isFrontendShuttingDown()) return;
      const parsed = parseBackendError(err);
      if (parsed.code === "TARGET_ALREADY_EXISTS" && !overwrite) {
        if (batchGenRef.current !== snapshot.gen) {
          setIoBanner({ kind: "err", text: t.coordinateTool.saveAbortedChanged });
          return;
        }
        setPendingOverwriteSnapshot({
          gen: snapshot.gen,
          targetPath,
          csvContent: snapshot.csvContent,
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

  const handleSaveBatchCsv = async () => {
    if (!canExportBatchCsv || !boundBatch || boundBatch.result.status !== "ok") return;
    const snapshot = {
      gen: boundBatch.gen,
      csvContent: boundBatch.result.csvOutputText,
      sourceFilePath: boundBatch.sourceFilePath,
    };

    const defaultPath = snapshot.sourceFilePath
      ? ((await suggestSafeSiblingPath(snapshot.sourceFilePath, "_coordinates", "csv")) ??
        "coordinates.csv")
      : "coordinates.csv";

    if (!mountedRef.current || isFrontendShuttingDown()) return;
    if (batchGenRef.current !== snapshot.gen) {
      setIoBanner({ kind: "err", text: t.coordinateTool.saveAbortedChanged });
      return;
    }

    const chosen = await pickSaveFilePath({
      title: t.coordinateTool.exportCsvBtn,
      defaultPath,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!chosen || !mountedRef.current || isFrontendShuttingDown()) return;
    if (batchGenRef.current !== snapshot.gen) {
      setIoBanner({ kind: "err", text: t.coordinateTool.saveAbortedChanged });
      return;
    }
    await executeSaveBatchCsv(chosen, false, snapshot);
  };

  return (
    <div className="tool-workspace">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
          flexWrap: "wrap",
        }}
      >
        <p className="field-hint" style={{ margin: 0, flex: 1 }}>
          {t.coordinateTool.scopeNote}
        </p>
        <span className="badge badge-ok">{t.coordinateTool.offlineBadge}</span>
      </div>

      <div className="tool-toolbar">
        <div className="tool-toolbar-group">
          <div className="segmented" role="tablist" aria-label="Coordinate tool mode">
            {(
              [
                ["single", t.coordinateTool.tabSingle],
                ["distance", t.coordinateTool.tabDistance],
                ["batch", t.coordinateTool.tabBatch],
              ] as const
            ).map(([tabKey, label]) => (
              <button
                key={tabKey}
                type="button"
                role="tab"
                aria-selected={state.activeTab === tabKey}
                className={`segmented-btn ${state.activeTab === tabKey ? "is-selected" : ""}`}
                onClick={() => {
                  setIoBanner(null);
                  updateCoordinateSession({ activeTab: tabKey });
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {(state.activeTab === "single" || state.activeTab === "batch") && (
          <div className="tool-toolbar-group">
            <label className="field-row" htmlFor={ddDecId} style={{ gap: "6px" }}>
              <span className="field-hint">{t.coordinateTool.ddDecLabel}</span>
              <input
                id={ddDecId}
                type="text"
                inputMode="numeric"
                className="text-input"
                style={{ width: "56px" }}
                value={state.ddDecimals}
                onChange={(e) => updateCoordinateSession({ ddDecimals: e.target.value })}
              />
            </label>
            <label className="field-row" htmlFor={dmDecId} style={{ gap: "6px" }}>
              <span className="field-hint">{t.coordinateTool.dmDecLabel}</span>
              <input
                id={dmDecId}
                type="text"
                inputMode="numeric"
                className="text-input"
                style={{ width: "56px" }}
                value={state.dmDecimals}
                onChange={(e) => updateCoordinateSession({ dmDecimals: e.target.value })}
              />
            </label>
            <label className="field-row" htmlFor={dmsDecId} style={{ gap: "6px" }}>
              <span className="field-hint">{t.coordinateTool.dmsDecLabel}</span>
              <input
                id={dmsDecId}
                type="text"
                inputMode="numeric"
                className="text-input"
                style={{ width: "56px" }}
                value={state.dmsDecimals}
                onChange={(e) => updateCoordinateSession({ dmsDecimals: e.target.value })}
              />
            </label>
          </div>
        )}
      </div>

      {!precisionValidation.ok && (
        <div className="status-banner is-err" role="alert" data-testid="coord-precision-error">
          <span>{precisionValidation.message}</span>
        </div>
      )}

      {ioBanner && (
        <div
          className={`status-banner ${ioBanner.kind === "ok" ? "is-ok" : "is-err"}`}
          role="status"
          data-testid="coord-io-banner"
        >
          <span>{ioBanner.text}</span>
        </div>
      )}

      {state.activeTab === "single" && (
        <>
          <div className="tool-toolbar">
            <div className="tool-toolbar-group">
              <div className="segmented" role="group" aria-label="Input mode">
                <button
                  type="button"
                  className={`segmented-btn ${state.singleInputMode === "paste" ? "is-selected" : ""}`}
                  aria-pressed={state.singleInputMode === "paste"}
                  onClick={() => updateCoordinateSession({ singleInputMode: "paste" })}
                >
                  {t.coordinateTool.modePaste}
                </button>
                <button
                  type="button"
                  className={`segmented-btn ${state.singleInputMode === "separate" ? "is-selected" : ""}`}
                  aria-pressed={state.singleInputMode === "separate"}
                  onClick={() => updateCoordinateSession({ singleInputMode: "separate" })}
                >
                  {t.coordinateTool.modeSeparate}
                </button>
              </div>

              {state.singleInputMode === "paste" && (
                <div className="field-row" style={{ gap: "6px" }}>
                  <span className="field-hint">{t.coordinateTool.plainOrderLabel}</span>
                  <div
                    className="segmented"
                    role="group"
                    aria-label={t.coordinateTool.plainOrderLabel}
                  >
                    {(
                      [
                        ["lat_lon", t.coordinateTool.orderLatLon],
                        ["lon_lat", t.coordinateTool.orderLonLat],
                      ] as const
                    ).map(([ord, lbl]) => (
                      <button
                        key={ord}
                        type="button"
                        className={`segmented-btn ${state.plainAxisOrder === ord ? "is-selected" : ""}`}
                        aria-pressed={state.plainAxisOrder === ord}
                        onClick={() => updateCoordinateSession({ plainAxisOrder: ord })}
                      >
                        {lbl}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="tool-toolbar-group">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  if (state.singleInputMode === "separate") {
                    updateCoordinateSession({
                      separateLatInput: "37.8197",
                      separateLonInput: "-122.4786",
                    });
                  } else {
                    updateCoordinateSession({ singleRawInput: SAMPLE_SINGLE_COORD });
                  }
                }}
              >
                <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{t.coordinateTool.sampleBtn}</span>
              </button>

              <button
                type="button"
                className="btn"
                disabled={!singleParsed.ok}
                onClick={() => {
                  if (!singleParsed.ok) return;
                  updateCoordinateSession({
                    pointAInput: serializeUnroundedPointForTransfer(singleParsed.point),
                    activeTab: "distance",
                  });
                }}
              >
                <span>{t.coordinateTool.sendToABtn}</span>
              </button>

              <button
                type="button"
                className="btn"
                disabled={!singleParsed.ok}
                onClick={() => {
                  if (!singleParsed.ok) return;
                  updateCoordinateSession({
                    pointBInput: serializeUnroundedPointForTransfer(singleParsed.point),
                    activeTab: "distance",
                  });
                }}
              >
                <span>{t.coordinateTool.sendToBBtn}</span>
              </button>

              <button
                type="button"
                className="btn"
                disabled={
                  state.singleInputMode === "paste"
                    ? state.singleRawInput.length === 0
                    : state.separateLatInput.length === 0 && state.separateLonInput.length === 0
                }
                onClick={() => {
                  setCopiedKey(null);
                  if (state.singleInputMode === "paste") {
                    updateCoordinateSession({ singleRawInput: "" });
                  } else {
                    updateCoordinateSession({ separateLatInput: "", separateLonInput: "" });
                  }
                }}
              >
                <Eraser size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{t.coordinateTool.clearBtn}</span>
              </button>
            </div>
          </div>

          <div className="pane">
            <div className="pane-header">
              <label
                className="pane-title"
                htmlFor={state.singleInputMode === "paste" ? singleInputId : sepLatId}
              >
                {t.coordinateTool.singleInputLabel}
              </label>
              {singleParsed.ok && (
                <span className="badge badge-ok" data-testid="coord-detected-badge">
                  {t.coordinateTool.detectedBadge(
                    t.coordinateTool.detectedFormatNames[singleParsed.detectedFormat],
                    t.coordinateTool.axisOrderNames[singleParsed.axisOrderUsed],
                  )}
                </span>
              )}
            </div>
            <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "10px" }}>
              {state.singleInputMode === "paste" ? (
                <input
                  id={singleInputId}
                  type="text"
                  className="text-input mono-inline"
                  style={{ width: "100%", height: "36px" }}
                  spellCheck={false}
                  placeholder={t.coordinateTool.singlePlaceholder}
                  value={state.singleRawInput}
                  onChange={(e) => {
                    setCopiedKey(null);
                    updateCoordinateSession({ singleRawInput: e.target.value });
                  }}
                  data-testid="coord-single-input"
                />
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    <label className="field-label" htmlFor={sepLatId}>
                      {t.coordinateTool.latFieldLabel}
                    </label>
                    <input
                      id={sepLatId}
                      type="text"
                      className="text-input mono-inline"
                      spellCheck={false}
                      placeholder={t.coordinateTool.latPlaceholder}
                      value={state.separateLatInput}
                      onChange={(e) => {
                        setCopiedKey(null);
                        updateCoordinateSession({ separateLatInput: e.target.value });
                      }}
                      data-testid="coord-sep-lat-input"
                    />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    <label className="field-label" htmlFor={sepLonId}>
                      {t.coordinateTool.lonFieldLabel}
                    </label>
                    <input
                      id={sepLonId}
                      type="text"
                      className="text-input mono-inline"
                      spellCheck={false}
                      placeholder={t.coordinateTool.lonPlaceholder}
                      value={state.separateLonInput}
                      onChange={(e) => {
                        setCopiedKey(null);
                        updateCoordinateSession({ separateLonInput: e.target.value });
                      }}
                      data-testid="coord-sep-lon-input"
                    />
                  </div>
                </div>
              )}

              <p className="field-hint" style={{ margin: 0 }}>
                {t.coordinateTool.precisionHint}
              </p>
            </div>
          </div>

          {!singleParsed.ok && singleParsed.code !== "EMPTY_INPUT" && (
            <div className="status-banner is-err" role="alert" data-testid="coord-single-error">
              <span>
                [{singleParsed.code}] {singleParsed.message}
              </span>
            </div>
          )}

          <div className="pane">
            <div className="pane-header">
              <span className="pane-title">{t.coordinateTool.outputsPaneTitle}</span>
            </div>
            {!singleOutputs ? (
              <div className="empty-state" style={{ margin: "20px" }}>
                {t.coordinateTool.emptySinglePrompt}
              </div>
            ) : (
              <div
                style={{
                  padding: "10px 12px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                }}
                data-testid="coord-outputs-list"
              >
                {OUTPUT_FORMAT_ORDER.map((fmtId) => {
                  const val = singleOutputs[fmtId];
                  const copyId = `single-${fmtId}`;
                  return (
                    <div
                      key={fmtId}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "minmax(170px, 210px) 1fr auto",
                        alignItems: "center",
                        gap: "10px",
                        padding: "7px 10px",
                        borderRadius: "8px",
                        border: "1px solid var(--border-subtle)",
                        background: "var(--bg-subtle)",
                      }}
                    >
                      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                        <span style={{ fontSize: "12.5px", fontWeight: 600 }}>
                          {t.coordinateTool.formatLabels[fmtId]}
                        </span>
                        <span className="field-hint" style={{ fontSize: "11px" }}>
                          {t.coordinateTool.formatMeta[fmtId]}
                        </span>
                      </div>

                      <code
                        className="mono-inline"
                        style={{
                          wordBreak: "break-all",
                          padding: "5px 8px",
                          borderRadius: "6px",
                          background: "var(--bg-surface)",
                          border: "1px solid var(--border-subtle)",
                        }}
                        data-testid={`coord-output-${fmtId}`}
                      >
                        {val}
                      </code>

                      <button
                        type="button"
                        className="btn"
                        style={{ height: "28px", padding: "0 10px" }}
                        onClick={() => void handleCopyText(val, copyId)}
                        data-testid={`coord-copy-${fmtId}`}
                      >
                        {copiedKey === copyId ? (
                          <Check size={13} strokeWidth={1.75} aria-hidden="true" />
                        ) : (
                          <Copy size={13} strokeWidth={1.75} aria-hidden="true" />
                        )}
                        <span>
                          {copiedKey === copyId
                            ? t.coordinateTool.copiedBadge
                            : t.coordinateTool.copyBtn}
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {state.activeTab === "distance" && (
        <>
          <div className="tool-toolbar">
            <div className="tool-toolbar-group">
              <span className="field-hint">{t.coordinateTool.plainOrderLabel}</span>
              <div className="segmented" role="group" aria-label={t.coordinateTool.plainOrderLabel}>
                {(
                  [
                    ["lat_lon", t.coordinateTool.orderLatLon],
                    ["lon_lat", t.coordinateTool.orderLonLat],
                  ] as const
                ).map(([ord, lbl]) => (
                  <button
                    key={ord}
                    type="button"
                    className={`segmented-btn ${state.distanceAxisOrder === ord ? "is-selected" : ""}`}
                    aria-pressed={state.distanceAxisOrder === ord}
                    onClick={() =>
                      updateCoordinateSession({ distanceAxisOrder: ord as PlainTextAxisOrder })
                    }
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            </div>

            <div className="tool-toolbar-group">
              <button
                type="button"
                className="btn"
                onClick={() =>
                  updateCoordinateSession({
                    pointAInput: "-41.32, 174.81",
                    pointBInput: "40.96, -5.50",
                    distanceAxisOrder: "lat_lon",
                  })
                }
              >
                <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{t.coordinateTool.sampleAntipodalBtn}</span>
              </button>

              <button
                type="button"
                className="btn"
                onClick={() =>
                  updateCoordinateSession({
                    pointAInput: "0, 179.9",
                    pointBInput: "0, -179.9",
                    distanceAxisOrder: "lat_lon",
                  })
                }
              >
                <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{t.coordinateTool.sampleDatelineBtn}</span>
              </button>

              <button
                type="button"
                className="btn"
                disabled={state.pointAInput.length === 0 && state.pointBInput.length === 0}
                onClick={() =>
                  updateCoordinateSession({
                    pointAInput: state.pointBInput,
                    pointBInput: state.pointAInput,
                  })
                }
              >
                <ArrowLeftRight size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{t.coordinateTool.swapPointsBtn}</span>
              </button>

              <button
                type="button"
                className="btn"
                disabled={state.pointAInput.length === 0 && state.pointBInput.length === 0}
                onClick={() => {
                  setCopiedKey(null);
                  updateCoordinateSession({ pointAInput: "", pointBInput: "" });
                }}
              >
                <Eraser size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{t.coordinateTool.clearBtn}</span>
              </button>
            </div>
          </div>

          <div className="split-panes">
            <div className="pane">
              <div className="pane-header">
                <label className="pane-title" htmlFor={pointAId}>
                  {t.coordinateTool.pointATitle}
                </label>
                <button
                  type="button"
                  className="btn"
                  style={{ height: "26px", padding: "0 8px", fontSize: "12px" }}
                  disabled={!singleParsed.ok}
                  onClick={() => {
                    if (!singleParsed.ok) return;
                    updateCoordinateSession({
                      pointAInput: serializeUnroundedPointForTransfer(singleParsed.point),
                    });
                  }}
                >
                  <span>{t.coordinateTool.fillFromCurrentBtn}</span>
                </button>
              </div>
              <div style={{ padding: "12px" }}>
                <input
                  id={pointAId}
                  type="text"
                  className="text-input mono-inline"
                  style={{ width: "100%", height: "36px" }}
                  spellCheck={false}
                  placeholder={t.coordinateTool.pointPlaceholder}
                  value={state.pointAInput}
                  onChange={(e) => updateCoordinateSession({ pointAInput: e.target.value })}
                  data-testid="coord-point-a-input"
                />
              </div>
            </div>

            <div className="pane">
              <div className="pane-header">
                <label className="pane-title" htmlFor={pointBId}>
                  {t.coordinateTool.pointBTitle}
                </label>
                <button
                  type="button"
                  className="btn"
                  style={{ height: "26px", padding: "0 8px", fontSize: "12px" }}
                  disabled={!singleParsed.ok}
                  onClick={() => {
                    if (!singleParsed.ok) return;
                    updateCoordinateSession({
                      pointBInput: serializeUnroundedPointForTransfer(singleParsed.point),
                    });
                  }}
                >
                  <span>{t.coordinateTool.fillFromCurrentBtn}</span>
                </button>
              </div>
              <div style={{ padding: "12px" }}>
                <input
                  id={pointBId}
                  type="text"
                  className="text-input mono-inline"
                  style={{ width: "100%", height: "36px" }}
                  spellCheck={false}
                  placeholder={t.coordinateTool.pointPlaceholder}
                  value={state.pointBInput}
                  onChange={(e) => updateCoordinateSession({ pointBInput: e.target.value })}
                  data-testid="coord-point-b-input"
                />
              </div>
            </div>
          </div>

          {distanceEvaluation.kind === "error" && (
            <div className="status-banner is-err" role="alert" data-testid="coord-distance-error">
              <span>{distanceEvaluation.message}</span>
            </div>
          )}

          <div className="pane">
            <div className="pane-header">
              <span className="pane-title">{t.coordinateTool.distanceResultTitle}</span>
            </div>
            {distanceEvaluation.kind !== "ok" ? (
              <div className="empty-state" style={{ margin: "24px" }}>
                {t.coordinateTool.distanceEmptyPrompt}
              </div>
            ) : (
              <div
                style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "14px" }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
                    gap: "12px",
                  }}
                >
                  {(
                    [
                      [
                        "km",
                        t.coordinateTool.unitKilometers,
                        `${formatCleanDecimal(distanceEvaluation.distance.kilometers, 6)} km`,
                        "coord-distance-km",
                      ],
                      [
                        "m",
                        t.coordinateTool.unitMeters,
                        `${formatCleanDecimal(distanceEvaluation.distance.meters, 3)} m`,
                        "coord-distance-m",
                      ],
                      [
                        "mi",
                        t.coordinateTool.unitMiles,
                        `${formatCleanDecimal(distanceEvaluation.distance.miles, 6)} mi`,
                        "coord-distance-mi",
                      ],
                    ] as const
                  ).map(([unitKey, unitTitle, formattedVal, testId]) => {
                    const copyId = `dist-${unitKey}`;
                    return (
                      <div
                        key={unitKey}
                        style={{
                          padding: "12px 14px",
                          borderRadius: "8px",
                          border: "1px solid var(--border-subtle)",
                          background: "var(--bg-subtle)",
                          display: "flex",
                          flexDirection: "column",
                          gap: "8px",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: "8px",
                          }}
                        >
                          <span className="field-hint" style={{ fontWeight: 600 }}>
                            {unitTitle}
                          </span>
                          <button
                            type="button"
                            className="btn"
                            style={{ height: "26px", padding: "0 8px", fontSize: "12px" }}
                            onClick={() => void handleCopyText(formattedVal, copyId)}
                          >
                            {copiedKey === copyId ? (
                              <Check size={12} strokeWidth={1.75} aria-hidden="true" />
                            ) : (
                              <Copy size={12} strokeWidth={1.75} aria-hidden="true" />
                            )}
                            <span>
                              {copiedKey === copyId
                                ? t.coordinateTool.copiedBadge
                                : t.coordinateTool.copyBtn}
                            </span>
                          </button>
                        </div>
                        <div
                          className="mono-inline"
                          style={{ fontSize: "18px", fontWeight: 600 }}
                          data-testid={testId}
                        >
                          {formattedVal}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <p className="field-hint" style={{ margin: 0 }}>
                  {t.coordinateTool.distanceModelNote}
                </p>
              </div>
            )}
          </div>
        </>
      )}

      {state.activeTab === "batch" && (
        <>
          <div className="tool-toolbar">
            <div className="tool-toolbar-group">
              <label className="field-row" htmlFor={batchFmtId} style={{ gap: "6px" }}>
                <span className="field-hint">{t.coordinateTool.batchOutputFormatLabel}</span>
                <select
                  id={batchFmtId}
                  className="select-input"
                  value={state.batchOutputFormat}
                  onChange={(e) =>
                    updateCoordinateSession({
                      batchOutputFormat: e.target.value as CoordinateOutputFormatId,
                    })
                  }
                >
                  {OUTPUT_FORMAT_ORDER.map((fmtId) => (
                    <option key={fmtId} value={fmtId}>
                      {t.coordinateTool.formatLabels[fmtId]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field-row" htmlFor={batchScopeId} style={{ gap: "6px" }}>
                <span className="field-hint">{t.coordinateTool.batchCsvScopeLabel}</span>
                <select
                  id={batchScopeId}
                  className="select-input"
                  value={state.batchCsvScope}
                  onChange={(e) =>
                    updateCoordinateSession({
                      batchCsvScope: e.target.value as "all_with_errors" | "valid_only",
                    })
                  }
                >
                  <option value="all_with_errors">{t.coordinateTool.batchCsvScopeAll}</option>
                  <option value="valid_only">{t.coordinateTool.batchCsvScopeValid}</option>
                </select>
              </label>

              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={state.batchFormulaProtection}
                  onChange={(e) =>
                    updateCoordinateSession({ batchFormulaProtection: e.target.checked })
                  }
                />
                <span>{t.coordinateTool.batchFormulaProtection}</span>
              </label>
            </div>

            <div className="tool-toolbar-group">
              <button type="button" className="btn" onClick={() => void handleOpenBatchFile()}>
                <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{t.coordinateTool.openBatchFileBtn}</span>
              </button>

              <button
                type="button"
                className="btn"
                onClick={() => {
                  setIoBanner(null);
                  setCopiedKey(null);
                  updateCoordinateSession({
                    batchInputText: SAMPLE_BATCH_MIXED,
                    batchSourceFilePath: null,
                    batchSourceFileName: null,
                  });
                }}
              >
                <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{t.coordinateTool.sampleBtn}</span>
              </button>

              {batchPhase === "running" && (
                <button type="button" className="btn btn-danger" onClick={handleCancelBatch}>
                  <Square size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{t.coordinateTool.cancelBatchBtn}</span>
                </button>
              )}

              <button
                type="button"
                className="btn"
                disabled={!canCopyBatchValid}
                onClick={() => {
                  if (canCopyBatchValid && batchResult?.status === "ok") {
                    void handleCopyText(batchResult.validFormattedText, "batch-valid");
                  }
                }}
              >
                {copiedKey === "batch-valid" ? (
                  <Check size={14} strokeWidth={1.75} aria-hidden="true" />
                ) : (
                  <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
                )}
                <span>
                  {copiedKey === "batch-valid"
                    ? t.coordinateTool.copiedBadge
                    : t.coordinateTool.copyValidBtn(
                        batchResult?.status === "ok" ? batchResult.validCount : 0,
                      )}
                </span>
              </button>

              <button
                type="button"
                className="btn btn-primary"
                disabled={!canExportBatchCsv}
                onClick={() => void handleSaveBatchCsv()}
              >
                <Download size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{t.coordinateTool.exportCsvBtn}</span>
              </button>

              <button
                type="button"
                className="btn"
                disabled={state.batchInputText.length === 0 && batchPhase !== "running"}
                onClick={() => {
                  setIoBanner(null);
                  setCopiedKey(null);
                  updateCoordinateSession({
                    batchInputText: "",
                    batchSourceFilePath: null,
                    batchSourceFileName: null,
                  });
                }}
              >
                <Eraser size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{t.coordinateTool.clearBtn}</span>
              </button>
            </div>
          </div>

          <div
            className={`status-banner ${
              batchPhase === "running"
                ? ""
                : batchPhase === "cancelled"
                  ? "is-warn"
                  : batchResult?.status === "error"
                    ? "is-err"
                    : batchResult?.status === "ok" && batchResult.errorCount > 0
                      ? "is-warn"
                      : batchResult?.status === "ok"
                        ? "is-ok"
                        : ""
            }`}
            data-testid="coord-batch-status"
          >
            <span>
              {(batchPhase === "idle" || batchResult?.status === "empty") &&
                t.coordinateTool.batchStatusEmpty}
              {batchPhase === "running" && t.coordinateTool.batchStatusRunning}
              {batchPhase === "cancelled" && t.coordinateTool.batchStatusCancelled}
              {batchPhase === "done" && batchResult?.status === "error" && batchResult.message}
              {batchPhase === "done" &&
                batchResult?.status === "ok" &&
                t.coordinateTool.batchStatusSummary(
                  batchResult.validCount,
                  batchResult.errorCount,
                  batchResult.skippedBlankCount,
                )}
            </span>
          </div>

          <div className="split-panes" style={{ minHeight: "340px" }}>
            <div className={`pane ${dropHovering ? "is-drop-hover" : ""}`}>
              <div className="pane-header">
                <label className="pane-title" htmlFor={batchEditorId}>
                  {t.coordinateTool.batchInputTitle(state.batchSourceFileName)}
                </label>
              </div>
              <textarea
                id={batchEditorId}
                className="code-editor"
                spellCheck={false}
                placeholder={t.coordinateTool.batchPlaceholder}
                value={state.batchInputText}
                onChange={(e) => {
                  setIoBanner(null);
                  setCopiedKey(null);
                  updateCoordinateSession({ batchInputText: e.target.value });
                }}
                data-testid="coord-batch-editor"
              />
              <div
                className="field-hint"
                style={{ padding: "8px 12px", borderTop: "1px solid var(--border-subtle)" }}
              >
                {t.coordinateTool.batchScopeRuleNote}
              </div>
            </div>

            <div className="pane">
              <div className="pane-header">
                <span className="pane-title">
                  {t.coordinateTool.formatLabels[state.batchOutputFormat]}
                </span>
              </div>
              {batchPhase === "done" &&
              batchResult?.status === "ok" &&
              batchResult.previewRows.length > 0 ? (
                <>
                  {batchResult.previewTruncated && (
                    <div
                      className="field-hint"
                      style={{
                        padding: "6px 12px",
                        borderBottom: "1px solid var(--border-subtle)",
                      }}
                    >
                      {t.coordinateTool.batchPreviewTruncated(
                        batchResult.previewRows.length,
                        batchResult.totalNonBlankCount,
                      )}
                    </div>
                  )}
                  <div style={{ flex: 1, overflow: "auto" }} data-testid="coord-batch-table">
                    <table className="kv-table">
                      <thead>
                        <tr>
                          <th style={{ width: "64px" }}>{t.coordinateTool.colLine}</th>
                          <th style={{ width: "76px" }}>{t.coordinateTool.colStatus}</th>
                          <th>{t.coordinateTool.colRaw}</th>
                          <th>{t.coordinateTool.colResultOrError}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {batchResult.previewRows.map((r) => (
                          <tr key={r.lineNumber}>
                            <td className="mono-inline">#{r.lineNumber}</td>
                            <td>
                              {r.status === "ok" ? (
                                <span className="badge badge-ok">{t.coordinateTool.badgeOk}</span>
                              ) : (
                                <span className="badge badge-err">{t.coordinateTool.badgeErr}</span>
                              )}
                            </td>
                            <td className="mono-inline" style={{ wordBreak: "break-all" }}>
                              {r.rawInput}
                            </td>
                            <td
                              className="mono-inline"
                              style={{
                                wordBreak: "break-all",
                                color: r.status === "error" ? "var(--status-err)" : undefined,
                              }}
                            >
                              {r.status === "ok"
                                ? r.formattedOutput
                                : `[${r.errorCode}] ${r.errorMessage}`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className="empty-state" style={{ margin: "24px" }}>
                  {batchPhase === "running"
                    ? t.coordinateTool.batchStatusRunning
                    : t.coordinateTool.batchStatusEmpty}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={pendingOverwriteSnapshot !== null}
        title={t.coordinateTool.overwriteConfirmTitle}
        body={t.coordinateTool.overwriteConfirmBody(pendingOverwriteSnapshot?.targetPath ?? "")}
        confirmLabel={t.coordinateTool.overwriteConfirmAccept}
        cancelLabel={t.coordinateTool.cancel}
        onCancel={() => setPendingOverwriteSnapshot(null)}
        onConfirm={async () => {
          const snap = pendingOverwriteSnapshot;
          setPendingOverwriteSnapshot(null);
          if (snap) {
            await executeSaveBatchCsv(snap.targetPath, true, snap);
          }
        }}
      />
    </div>
  );
}
