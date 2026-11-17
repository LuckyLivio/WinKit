import { Check, Copy, Eraser, FolderOpen, Play, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore } from "../../lib/sessionStore";
import {
  cancelBackendTask,
  computeFileSha256,
  computeTextSha256,
  formatLocalizedError,
  parseBackendError,
  pickSingleFile,
  subscribeFileDrop,
  subscribeTaskProgress,
} from "../../lib/tauriBridge";
import { compareSha256Digest, formatByteSize, utf8ByteLength } from "./hashUtils";

let hashTaskSeq = 0;

export function HashGeneratorWorkspace() {
  const { t } = useI18n();
  const { session, updateHashSession } = useSessionStore();
  const {
    mode,
    textInput,
    filePath,
    fileName,
    fileSize,
    digestHex,
    uppercase,
    expectedHash,
    status,
    progressPercent,
    errorMessage,
  } = session.hash;

  const activeTaskIdRef = useRef<string | null>(null);
  const textReqSeqRef = useRef(0);
  const [copied, setCopied] = useState(false);
  const [dropHover, setDropHover] = useState(false);

  const liveTextBytes = useMemo(() => utf8ByteLength(textInput), [textInput]);

  const formattedDigest = useMemo(() => {
    if (!digestHex || status !== "completed") {
      return "";
    }
    return uppercase ? digestHex.toUpperCase() : digestHex.toLowerCase();
  }, [digestHex, status, uppercase]);

  const compareState = useMemo(
    () => compareSha256Digest(status === "completed" ? digestHex : null, expectedHash),
    [digestHex, expectedHash, status],
  );

  // Listen to backend task progress events for the active file hash task
  useEffect(() => {
    let unlisten: (() => void) | null = null;
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
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, [fileSize, updateHashSession]);

  const runTextHash = useCallback(
    async (value: string) => {
      const seq = ++textReqSeqRef.current;
      try {
        const res = await computeTextSha256(value);
        if (seq !== textReqSeqRef.current) return;
        updateHashSession({
          digestHex: res.digestHex,
          status: "completed",
          progressPercent: 100,
          errorMessage: null,
        });
      } catch (err) {
        if (seq !== textReqSeqRef.current) return;
        updateHashSession({
          digestHex: null,
          status: "error",
          progressPercent: null,
          errorMessage: formatLocalizedError(err, t),
        });
      }
    },
    [t, updateHashSession],
  );

  const runFileHash = useCallback(
    async (targetPath: string) => {
      // Cancel any previous in-flight task first
      if (activeTaskIdRef.current) {
        void cancelBackendTask(activeTaskIdRef.current);
      }

      const taskId = `d03-${Date.now()}-${++hashTaskSeq}`;
      activeTaskIdRef.current = taskId;
      const baseName = targetPath.split(/[\\/]/).pop() ?? targetPath;

      // Immediately clear previous digest so cancelled/failed runs NEVER display stale success
      updateHashSession({
        mode: "file",
        filePath: targetPath,
        fileName: baseName,
        fileSize: null,
        digestHex: null,
        status: "running",
        progressPercent: 0,
        errorMessage: null,
      });

      try {
        const result = await computeFileSha256(taskId, targetPath);
        if (activeTaskIdRef.current !== taskId) {
          return;
        }
        activeTaskIdRef.current = null;
        updateHashSession({
          filePath: result.path,
          fileName: result.fileName,
          fileSize: result.byteLength,
          digestHex: result.digestHex,
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
            digestHex: null,
            status: "cancelled",
            progressPercent: null,
            errorMessage: null,
          });
        } else {
          updateHashSession({
            digestHex: null,
            status: "error",
            progressPercent: null,
            errorMessage: formatLocalizedError(err, t),
          });
        }
      }
    },
    [t, updateHashSession],
  );

  // Native Tauri drag-and-drop file support
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    subscribeFileDrop({
      onHover: (hovering) => setDropHover(hovering),
      onDropPaths: (paths) => {
        const first = paths[0];
        if (first) {
          void runFileHash(first);
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
  }, [runFileHash]);

  const handleSelectFile = async () => {
    const chosen = await pickSingleFile({
      title: t.hashTool.selectFileBtn,
    });
    if (chosen) {
      await runFileHash(chosen);
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
      digestHex: null,
      status: "idle",
      progressPercent: null,
      errorMessage: null,
    });
    if (nextMode === "text" && textInput.length > 0) {
      void runTextHash(textInput);
    }
  };

  const handleCopy = async () => {
    if (!formattedDigest) return;
    try {
      await navigator.clipboard.writeText(formattedDigest);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Ignore clipboard permission failure silently
    }
  };

  const handleClear = () => {
    if (activeTaskIdRef.current) {
      void cancelBackendTask(activeTaskIdRef.current);
      activeTaskIdRef.current = null;
    }
    setCopied(false);
    updateHashSession({
      textInput: "",
      filePath: null,
      fileName: null,
      fileSize: null,
      digestHex: null,
      expectedHash: "",
      status: "idle",
      progressPercent: null,
      errorMessage: null,
    });
  };

  return (
    <div className="tool-workspace">
      <div className="tool-toolbar">
        <div className="tool-toolbar-group">
          <div className="segmented" role="group" aria-label={t.hashTool.algorithmBadge}>
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

          <span className="badge mono">{t.hashTool.algorithmBadge}</span>

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
            <button type="button" className="btn" onClick={() => void runTextHash(textInput)}>
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
                <button type="button" className="btn" onClick={() => void runFileHash(filePath)}>
                  <Play size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{t.hashTool.computeBtn}</span>
                </button>
              )}
            </>
          )}

          <button
            type="button"
            className="btn btn-primary"
            disabled={!formattedDigest}
            onClick={handleCopy}
          >
            {copied ? (
              <Check size={14} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
            )}
            <span>{copied ? t.hashTool.copiedBadge : t.hashTool.copyBtn}</span>
          </button>

          <button type="button" className="btn" onClick={handleClear}>
            <Eraser size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{t.hashTool.clearBtn}</span>
          </button>
        </div>
      </div>

      <p className="field-hint">{t.hashTool.scopeNote}</p>

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
                  void runTextHash(val);
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
                            : "35%",
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Pane: Digest Result & Expected Checksum Verification */}
        <div className="pane">
          <div className="pane-header">
            <label htmlFor="hash-digest-output" className="pane-title">
              {t.hashTool.digestLabel}
            </label>
            <span
              className={`badge ${
                status === "completed"
                  ? "badge-ok"
                  : status === "error"
                    ? "badge-err"
                    : status === "cancelled"
                      ? "badge-partial"
                      : ""
              }`}
            >
              {status === "completed"
                ? t.hashTool.statusCompleted
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
              padding: "16px",
              display: "flex",
              flexDirection: "column",
              gap: "16px",
              flex: 1,
            }}
          >
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

            <div className="field-stack">
              <textarea
                id="hash-digest-output"
                className="code-editor"
                style={{
                  minHeight: "76px",
                  flex: "none",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "6px",
                  background: "var(--bg-subtle)",
                }}
                readOnly
                value={formattedDigest}
                placeholder="—"
              />
            </div>

            <div className="field-stack">
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

              {compareState === "idle" && <p className="field-hint">{t.hashTool.compareIdle}</p>}
              {compareState === "invalid_format" && (
                <div className="status-banner is-warn" role="alert">
                  <span>{t.hashTool.compareInvalidFormat}</span>
                </div>
              )}
              {compareState === "match" && (
                <div className="status-banner is-ok" role="status" aria-live="polite">
                  <span>{t.hashTool.compareMatch}</span>
                </div>
              )}
              {compareState === "mismatch" && (
                <div className="status-banner is-err" role="alert">
                  <span>{t.hashTool.compareMismatch}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
