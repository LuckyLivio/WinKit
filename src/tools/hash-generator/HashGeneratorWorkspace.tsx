import { AlertTriangle, Check, Copy, Eraser, FolderOpen, Play, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore } from "../../lib/sessionStore";
import {
  bindDisposableListener,
  cancelBackendTask,
  computeFileHashes,
  computeTextHashes,
  formatLocalizedError,
  parseBackendError,
  pickSingleFile,
  subscribeFileDrop,
  subscribeTaskProgress,
} from "../../lib/tauriBridge";
import {
  ALL_HASH_ALGORITHMS,
  compareMultiDigests,
  formatByteSize,
  isLegacyCompatAlgorithm,
  utf8ByteLength,
  type HashAlgorithm,
} from "./hashUtils";

let hashTaskSeq = 0;

export function HashGeneratorWorkspace() {
  const { t } = useI18n();
  const { session, updateHashSession } = useSessionStore();
  const {
    mode,
    selectedAlgorithms,
    textInput,
    filePath,
    fileName,
    fileSize,
    digests,
    needsRecompute,
    uppercase,
    expectedHash,
    status,
    progressPercent,
    errorMessage,
  } = session.hash;

  const activeTaskIdRef = useRef<string | null>(null);
  const textReqSeqRef = useRef(0);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [dropHover, setDropHover] = useState(false);

  const liveTextBytes = useMemo(() => utf8ByteLength(textInput), [textInput]);

  const visibleDigests = useMemo(() => {
    if (!digests || status !== "completed" || needsRecompute) {
      return [];
    }
    return digests
      .filter((d) => selectedAlgorithms.includes(d.algorithm))
      .map((d) => ({
        ...d,
        formatted: uppercase ? d.digestHex.toUpperCase() : d.digestHex.toLowerCase(),
      }));
  }, [digests, needsRecompute, selectedAlgorithms, status, uppercase]);

  const compareResult = useMemo(
    () =>
      compareMultiDigests(
        status === "completed" && !needsRecompute ? digests : null,
        selectedAlgorithms,
        expectedHash,
      ),
    [digests, expectedHash, needsRecompute, selectedAlgorithms, status],
  );

  // Listen to backend task progress events for the active file hash task
  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeTaskProgress((payload) => {
          if (payload.taskId !== activeTaskIdRef.current) {
            return;
          }
          if (payload.state === "running") {
            updateHashSession({
              status: "running",
              progressPercent: payload.percent,
              fileSize: payload.totalBytes ?? fileSize,
            });
          }
        }),
      "hash-task-progress",
    );
  }, [fileSize, updateHashSession]);

  const runTextHash = useCallback(
    async (value: string, algs: readonly HashAlgorithm[]) => {
      const seq = ++textReqSeqRef.current;
      try {
        const res = await computeTextHashes(value, algs);
        if (seq !== textReqSeqRef.current) return;
        updateHashSession({
          digests: res.digests,
          needsRecompute: false,
          status: "completed",
          progressPercent: 100,
          errorMessage: null,
        });
      } catch (err) {
        if (seq !== textReqSeqRef.current) return;
        updateHashSession({
          digests: null,
          needsRecompute: false,
          status: "error",
          progressPercent: null,
          errorMessage: formatLocalizedError(err, t),
        });
      }
    },
    [t, updateHashSession],
  );

  const runFileHash = useCallback(
    async (targetPath: string, algs: readonly HashAlgorithm[]) => {
      if (activeTaskIdRef.current) {
        void cancelBackendTask(activeTaskIdRef.current);
      }

      const taskId = `d03-${Date.now()}-${++hashTaskSeq}`;
      activeTaskIdRef.current = taskId;
      const baseName = targetPath.split(/[\\/]/).pop() ?? targetPath;

      updateHashSession({
        mode: "file",
        filePath: targetPath,
        fileName: baseName,
        fileSize: null,
        digests: null,
        needsRecompute: false,
        status: "running",
        progressPercent: 0,
        errorMessage: null,
      });

      try {
        const result = await computeFileHashes(taskId, targetPath, algs);
        if (activeTaskIdRef.current !== taskId) {
          return;
        }
        activeTaskIdRef.current = null;
        updateHashSession({
          filePath: result.path,
          fileName: result.fileName,
          fileSize: result.byteLength,
          digests: result.digests,
          needsRecompute: false,
          status: "completed",
          progressPercent: 100,
          errorMessage: null,
        });
      } catch (err) {
        if (activeTaskIdRef.current !== taskId) {
          return;
        }
        activeTaskIdRef.current = null;
        const parsed = parseBackendError(err);
        if (parsed.code === "TASK_CANCELLED") {
          updateHashSession({
            digests: null,
            needsRecompute: false,
            status: "cancelled",
            progressPercent: null,
            errorMessage: null,
          });
        } else {
          updateHashSession({
            digests: null,
            needsRecompute: false,
            status: "error",
            progressPercent: null,
            errorMessage: formatLocalizedError(err, t),
          });
        }
      }
    },
    [t, updateHashSession],
  );

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: (hovering) => setDropHover(hovering),
          onDropPaths: (paths) => {
            const first = paths[0];
            if (first) {
              void runFileHash(first, selectedAlgorithms);
            }
          },
        }),
      "hash-file-drop",
    );
  }, [runFileHash, selectedAlgorithms]);

  const handleToggleAlgorithm = (alg: HashAlgorithm) => {
    const exists = selectedAlgorithms.includes(alg);
    if (exists && selectedAlgorithms.length === 1) {
      return; // Keep at least one algorithm selected
    }
    const nextAlgs = ALL_HASH_ALGORITHMS.filter((item) =>
      item === alg ? !exists : selectedAlgorithms.includes(item),
    );

    if (mode === "text") {
      updateHashSession({ selectedAlgorithms: nextAlgs });
      if (status === "completed" || textInput.length > 0) {
        void runTextHash(textInput, nextAlgs);
      }
      return;
    }

    // File mode: invalidate / flag needsRecompute if newly selected algorithm hasn't been computed
    const missingAny =
      status === "completed" &&
      (!digests || nextAlgs.some((reqAlg) => !digests.some((d) => d.algorithm === reqAlg)));

    updateHashSession({
      selectedAlgorithms: nextAlgs,
      needsRecompute: missingAny,
    });
  };

  const handleSelectFile = async () => {
    const chosen = await pickSingleFile({
      title: t.hashTool.selectFileBtn,
    });
    if (chosen) {
      await runFileHash(chosen, selectedAlgorithms);
    }
  };

  const handleCancel = async () => {
    const taskId = activeTaskIdRef.current;
    if (!taskId) return;
    await cancelBackendTask(taskId);
  };

  const handleSwitchMode = (nextMode: "text" | "file") => {
    if (nextMode === mode) return;
    if (activeTaskIdRef.current) {
      void cancelBackendTask(activeTaskIdRef.current);
      activeTaskIdRef.current = null;
    }
    updateHashSession({
      mode: nextMode,
      digests: null,
      needsRecompute: false,
      status: "idle",
      progressPercent: null,
      errorMessage: null,
    });
    if (nextMode === "text" && textInput.length > 0) {
      void runTextHash(textInput, selectedAlgorithms);
    }
  };

  const copyWithFeedback = async (key: string, text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 1600);
    } catch {
      // Ignore clipboard failure silently
    }
  };

  const handleCopyAll = async () => {
    if (visibleDigests.length === 0) return;
    const payload =
      visibleDigests.length === 1
        ? visibleDigests[0]!.formatted
        : visibleDigests.map((d) => `${d.algorithm}: ${d.formatted}`).join("\n");
    await copyWithFeedback("all", payload);
  };

  const handleClear = () => {
    if (activeTaskIdRef.current) {
      void cancelBackendTask(activeTaskIdRef.current);
      activeTaskIdRef.current = null;
    }
    setCopiedKey(null);
    updateHashSession({
      textInput: "",
      filePath: null,
      fileName: null,
      fileSize: null,
      digests: null,
      needsRecompute: false,
      expectedHash: "",
      status: "idle",
      progressPercent: null,
      errorMessage: null,
    });
  };

  const hasLegacySelected = selectedAlgorithms.some(isLegacyCompatAlgorithm);

  return (
    <div className="tool-workspace">
      <div className="tool-toolbar">
        <div className="tool-toolbar-group">
          <div className="segmented" role="group" aria-label={t.hashTool.algorithmsLabel}>
            <button
              type="button"
              className={`segmented-btn ${mode === "text" ? "is-selected" : ""}`}
              aria-pressed={mode === "text"}
              onClick={() => handleSwitchMode("text")}
            >
              {t.hashTool.modeText}
            </button>
            <button
              type="button"
              className={`segmented-btn ${mode === "file" ? "is-selected" : ""}`}
              aria-pressed={mode === "file"}
              onClick={() => handleSwitchMode("file")}
            >
              {t.hashTool.modeFile}
            </button>
          </div>

          <div
            className="segmented"
            role="group"
            aria-label={t.hashTool.algorithmsLabel}
            style={{ flexWrap: "wrap" }}
          >
            {ALL_HASH_ALGORITHMS.map((alg) => {
              const checked = selectedAlgorithms.includes(alg);
              return (
                <button
                  key={alg}
                  type="button"
                  className={`segmented-btn mono ${checked ? "is-selected" : ""}`}
                  aria-pressed={checked}
                  disabled={status === "running"}
                  onClick={() => handleToggleAlgorithm(alg)}
                >
                  {alg}
                </button>
              );
            })}
          </div>

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={uppercase}
              onChange={(e) => updateHashSession({ uppercase: e.target.checked })}
            />
            <span>{t.hashTool.uppercaseLabel}</span>
          </label>
        </div>

        <div className="tool-toolbar-group">
          {mode === "text" ? (
            <button
              type="button"
              className="btn"
              onClick={() => void runTextHash(textInput, selectedAlgorithms)}
            >
              <Play size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{t.hashTool.computeBtn}</span>
            </button>
          ) : status === "running" ? (
            <button type="button" className="btn btn-danger" onClick={handleCancel}>
              <Square size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{t.hashTool.cancelBtn}</span>
            </button>
          ) : (
            <>
              <button type="button" className="btn" onClick={handleSelectFile}>
                <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{t.hashTool.selectFileBtn}</span>
              </button>
              {filePath && (
                <button
                  type="button"
                  className={needsRecompute ? "btn btn-primary" : "btn"}
                  onClick={() => void runFileHash(filePath, selectedAlgorithms)}
                >
                  <Play size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{t.hashTool.computeBtn}</span>
                </button>
              )}
            </>
          )}

          <button
            type="button"
            className="btn btn-primary"
            disabled={visibleDigests.length === 0}
            onClick={() => void handleCopyAll()}
          >
            {copiedKey === "all" ? (
              <Check size={14} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
            )}
            <span>
              {copiedKey === "all"
                ? t.hashTool.copiedBadge
                : visibleDigests.length > 1
                  ? t.hashTool.copyAllBtn
                  : t.hashTool.copyBtn}
            </span>
          </button>

          <button type="button" className="btn" onClick={handleClear}>
            <Eraser size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{t.hashTool.clearBtn}</span>
          </button>
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px", alignItems: "center" }}>
        <p className="field-hint" style={{ margin: 0 }}>
          {t.hashTool.scopeNote}
        </p>
        {hasLegacySelected && (
          <span
            className="field-hint"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              color: "var(--status-warn)",
            }}
          >
            <AlertTriangle size={13} strokeWidth={1.75} aria-hidden="true" />
            <span>MD5 / SHA-1：{t.hashTool.compatNote}</span>
          </span>
        )}
      </div>

      <div className="split-panes">
        {/* Left Pane: Text or File Input */}
        <div className={`pane ${dropHover ? "is-drop-hover" : ""}`}>
          <div className="pane-header">
            {mode === "text" ? (
              <>
                <label htmlFor="hash-text-input" className="pane-title">
                  {t.hashTool.textInputLabel}
                </label>
                <span className="mono" style={{ fontSize: "11.5px", color: "var(--text-muted)" }}>
                  {t.hashTool.byteCount(liveTextBytes)}
                </span>
              </>
            ) : (
              <span className="pane-title">{t.hashTool.modeFile}</span>
            )}
          </div>

          {mode === "text" ? (
            <>
              <textarea
                id="hash-text-input"
                className="code-editor"
                placeholder={t.hashTool.textPlaceholder}
                spellCheck={false}
                value={textInput}
                onChange={(e) => {
                  const val = e.target.value;
                  updateHashSession({ textInput: val });
                  void runTextHash(val, selectedAlgorithms);
                }}
              />
              <div
                style={{
                  padding: "8px 12px",
                  borderTop: "1px solid var(--border-subtle)",
                  background: "var(--bg-subtle)",
                }}
              >
                <p className="field-hint">{t.hashTool.exactBytesNote}</p>
              </div>
            </>
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
                  <span className="field-hint">{t.hashTool.selectedFileLabel}</span>
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
                  {fileSize !== null && (
                    <span className="field-hint mono">
                      {t.hashTool.fileSizeLabel}: {formatByteSize(fileSize)} (
                      {fileSize.toLocaleString()} B)
                    </span>
                  )}
                </div>
              ) : (
                <div className="empty-state" style={{ borderStyle: "dashed" }}>
                  <p style={{ margin: "0 0 12px" }}>{t.hashTool.dropFileHint}</p>
                  <button type="button" className="btn btn-primary" onClick={handleSelectFile}>
                    <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
                    <span>{t.hashTool.selectFileBtn}</span>
                  </button>
                </div>
              )}

              {status === "running" && (
                <div className="field-stack" role="status" aria-live="polite">
                  <div className="field-row">
                    <span className="field-label">
                      {t.hashTool.statusRunning(
                        progressPercent !== null ? `${progressPercent.toFixed(0)}%` : "…",
                      )}
                    </span>
                  </div>
                  <div className="progress-track">
                    <div
                      className="progress-fill"
                      style={{
                        width:
                          progressPercent !== null
                            ? `${Math.max(2, Math.min(100, progressPercent))}%`
                            : "10%",
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Pane: Multi-Digest List & Expected Checksum Verification */}
        <div className="pane">
          <div className="pane-header">
            <span className="pane-title">{t.hashTool.digestLabel}</span>
            <span
              className={`badge ${
                needsRecompute
                  ? "badge-partial"
                  : status === "completed"
                    ? "badge-ok"
                    : status === "error"
                      ? "badge-err"
                      : status === "cancelled"
                        ? "badge-partial"
                        : ""
              }`}
            >
              {needsRecompute
                ? t.hashTool.statusStale
                : status === "completed"
                  ? t.hashTool.statusCompleted(visibleDigests.length)
                  : status === "running"
                    ? t.hashTool.statusRunning(
                        progressPercent !== null ? `${progressPercent.toFixed(0)}%` : "…",
                      )
                    : status === "cancelled"
                      ? t.hashTool.statusCancelled
                      : status === "error"
                        ? t.hashTool.statusError
                        : t.hashTool.statusIdle}
            </span>
          </div>

          <div
            style={{
              padding: "14px 16px",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
              flex: 1,
              overflowY: "auto",
            }}
          >
            {needsRecompute && (
              <div className="status-banner is-warn" role="status">
                <span>{t.hashTool.staleNotice}</span>
              </div>
            )}

            {status === "error" && errorMessage && (
              <div className="status-banner is-err" role="alert">
                <span>{errorMessage}</span>
              </div>
            )}

            {status === "cancelled" && (
              <div className="status-banner is-warn" role="status">
                <span>{t.hashTool.statusCancelled}</span>
              </div>
            )}

            {visibleDigests.length === 0 ? (
              <div
                style={{
                  padding: "18px 12px",
                  borderRadius: "6px",
                  border: "1px dashed var(--border-subtle)",
                  background: "var(--bg-subtle)",
                  color: "var(--text-muted)",
                  fontSize: "12.5px",
                  textAlign: "center",
                }}
              >
                {t.hashTool.emptyDigestsHint}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {visibleDigests.map((item) => {
                  const rowKey = `alg-${item.algorithm}`;
                  const isLegacy = isLegacyCompatAlgorithm(item.algorithm);
                  return (
                    <div
                      key={item.algorithm}
                      style={{
                        padding: "8px 10px",
                        borderRadius: "6px",
                        border: "1px solid var(--border-subtle)",
                        background: "var(--bg-subtle)",
                        display: "flex",
                        flexDirection: "column",
                        gap: "5px",
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
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          <span className="badge mono">{item.algorithm}</span>
                          <span className="field-hint mono">{item.hexLength} hex</span>
                          {isLegacy && (
                            <span className="badge badge-partial" title={t.hashTool.compatNote}>
                              Compat
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          className="btn"
                          style={{ height: "26px", padding: "0 8px", fontSize: "12px" }}
                          aria-label={`${t.hashTool.copyBtn} ${item.algorithm}`}
                          onClick={() => void copyWithFeedback(rowKey, item.formatted)}
                        >
                          {copiedKey === rowKey ? (
                            <Check size={12} strokeWidth={1.75} aria-hidden="true" />
                          ) : (
                            <Copy size={12} strokeWidth={1.75} aria-hidden="true" />
                          )}
                          <span>
                            {copiedKey === rowKey ? t.hashTool.copiedBadge : t.hashTool.copyBtn}
                          </span>
                        </button>
                      </div>
                      <div
                        className="mono"
                        data-testid={`digest-${item.algorithm}`}
                        style={{
                          fontSize: "12px",
                          lineHeight: "18px",
                          wordBreak: "break-all",
                          overflowX: "auto",
                          userSelect: "all",
                          color: "var(--text-primary)",
                        }}
                      >
                        {item.formatted}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="field-stack" style={{ marginTop: "auto" }}>
              <label htmlFor="hash-compare-input" className="field-label">
                {t.hashTool.compareLabel}
              </label>
              <input
                id="hash-compare-input"
                type="text"
                className="text-input mono"
                spellCheck={false}
                value={expectedHash}
                placeholder={t.hashTool.comparePlaceholder}
                onChange={(e) => updateHashSession({ expectedHash: e.target.value })}
              />

              {compareResult.kind === "idle" && (
                <p className="field-hint">{t.hashTool.compareIdle}</p>
              )}
              {compareResult.kind === "invalid_format" && (
                <div className="status-banner is-warn" role="alert">
                  <span>{t.hashTool.compareInvalidFormat}</span>
                </div>
              )}
              {compareResult.kind === "candidate_uncomputed" && (
                <div className="status-banner is-warn" role="status">
                  <span>
                    {t.hashTool.compareUncomputedCandidate(
                      compareResult.candidateAlgorithm,
                      compareResult.hexLength,
                    )}
                  </span>
                </div>
              )}
              {compareResult.kind === "match" && (
                <div className="status-banner is-ok" role="status" aria-live="polite">
                  <span>
                    {t.hashTool.compareMatch(
                      compareResult.matchedAlgorithm,
                      compareResult.hexLength,
                    )}
                  </span>
                </div>
              )}
              {compareResult.kind === "mismatch" && (
                <div className="status-banner is-err" role="alert">
                  <span>
                    {t.hashTool.compareMismatch(
                      compareResult.candidateAlgorithm,
                      compareResult.hexLength,
                    )}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
