import { Copy, Download, FolderOpen, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore } from "../../lib/sessionStore";
import {
  bindDisposableListener,
  formatLocalizedError,
  inspectUnicodeText,
  parseBackendError,
  pickSaveFilePath,
  pickSingleFile,
  readDiffTextFile,
  saveLocalTextFile,
  subscribeFileDrop,
  suggestSafeSiblingPath,
} from "../../lib/tauriBridge";
import type {
  UnicodeCodePointEntry,
  UnicodeInspectionResponse,
  UnicodeSanitizeOptions,
} from "./unicodeEngine";

const PAGE_SIZE = 150;

const DIAGNOSTIC_SAMPLE =
  "\uFEFFWinKit 中文 p\u0430ypal\u00A0test\u200B!\u202Eabc\u202C cafe\u0301 👨‍👩‍👧‍👦 می\u200Cخواهم";

export function UnicodeInspectorWorkspace() {
  const { t } = useI18n();
  const { session, updateUnicodeSession } = useSessionStore();
  const { inputText, sourcePath, sourceFileName, attentionOnly, sanitizeOptions } = session.unicode;

  const inputFieldId = useId();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const seqRef = useRef(0);
  const copyTimerRef = useRef<number | null>(null);

  const [inspection, setInspection] = useState<UnicodeInspectionResponse | null>(null);
  const [selectedCpIndex, setSelectedCpIndex] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [copiedCleaned, setCopiedCleaned] = useState(false);
  const [dropHover, setDropHover] = useState(false);
  const [ioMessage, setIoMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [pendingOverwritePath, setPendingOverwritePath] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  // Run offline Unicode inspection whenever input text or sanitizer options change
  useEffect(() => {
    const seq = ++seqRef.current;

    if (inputText.length === 0) {
      setInspection(null);
      setSelectedCpIndex(null);
      setPage(0);
      return;
    }

    inspectUnicodeText(inputText, sanitizeOptions)
      .then((res) => {
        if (seq !== seqRef.current) return;
        setInspection(res);
      })
      .catch((err) => {
        if (seq !== seqRef.current) return;
        setInspection(null);
        setIoMessage({ kind: "err", text: formatLocalizedError(err, t) });
      });
  }, [inputText, sanitizeOptions, t]);

  const filteredEntries = useMemo((): UnicodeCodePointEntry[] => {
    if (!inspection) return [];
    if (!attentionOnly) return inspection.entries;
    return inspection.entries.filter((item) => item.isAttentionItem);
  }, [inspection, attentionOnly]);

  const totalPages = Math.max(1, Math.ceil(filteredEntries.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages - 1);
  const pageStartIdx = clampedPage * PAGE_SIZE;
  const pageEntries = filteredEntries.slice(pageStartIdx, pageStartIdx + PAGE_SIZE);

  const loadFromFile = useCallback(
    async (path: string) => {
      setIoMessage(null);
      try {
        const loaded = await readDiffTextFile(path, "D11");
        setPage(0);
        setSelectedCpIndex(null);
        updateUnicodeSession({
          inputText: loaded.content,
          sourcePath: loaded.path,
          sourceFileName: loaded.fileName,
        });
      } catch (err) {
        setIoMessage({ kind: "err", text: formatLocalizedError(err, t) });
      }
    },
    [t, updateUnicodeSession],
  );

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: (hovering) => setDropHover(hovering),
          onDropPaths: (paths) => {
            const first = paths[0];
            if (first) {
              void loadFromFile(first);
            }
          },
        }),
      "unicode-file-drop",
    );
  }, [loadFromFile]);

  const handleOpenFile = async () => {
    setIoMessage(null);
    const chosen = await pickSingleFile({
      title: t.unicodeTool.openFileBtn,
      filters: [
        { name: "UTF-8 Text", extensions: ["txt", "md", "json", "csv", "ts", "js", "py", "rs"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (chosen) {
      await loadFromFile(chosen);
    }
  };

  // Click table row -> highlight & select exact UTF-16 span in source textarea
  const handleSelectRow = (entry: UnicodeCodePointEntry) => {
    setSelectedCpIndex(entry.codePointIndex);
    const el = textareaRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(entry.utf16Offset, entry.utf16Offset + entry.utf16Length);
    }
  };

  // Click or arrow-navigate inside source textarea -> locate matching code point row & page
  const handleTextareaLocate = () => {
    const el = textareaRef.current;
    if (!el || !inspection || inspection.entries.length === 0) return;
    const caret = el.selectionStart ?? 0;

    // Binary search for entry containing `caret` UTF-16 offset
    const all = inspection.entries;
    let lo = 0;
    let hi = all.length - 1;
    let found: UnicodeCodePointEntry | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const item = all[mid]!;
      if (caret < item.utf16Offset) {
        hi = mid - 1;
      } else if (caret >= item.utf16Offset + item.utf16Length) {
        lo = mid + 1;
      } else {
        found = item;
        break;
      }
    }
    if (!found && caret === inspection.summary.totalUtf16Units && all.length > 0) {
      found = all[all.length - 1]!;
    }
    if (!found) return;

    setSelectedCpIndex(found.codePointIndex);
    const idxInFiltered = filteredEntries.findIndex(
      (e) => e.codePointIndex === found!.codePointIndex,
    );
    if (idxInFiltered !== -1) {
      setPage(Math.floor(idxInFiltered / PAGE_SIZE));
    }
  };

  const patchSanitize = (patch: Partial<UnicodeSanitizeOptions>) => {
    updateUnicodeSession({
      sanitizeOptions: {
        ...sanitizeOptions,
        ...patch,
      },
    });
  };

  const handleCopyCleaned = async () => {
    if (!inspection) return;
    setIoMessage(null);
    try {
      await navigator.clipboard.writeText(inspection.sanitizedText);
      setCopiedCleaned(true);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedCleaned(false), 1600);
    } catch (err) {
      setIoMessage({ kind: "err", text: formatLocalizedError(err, t) });
    }
  };

  const executeSaveCleaned = async (targetPath: string, overwrite: boolean) => {
    if (!inspection) return;
    setIoMessage(null);
    try {
      const saved = await saveLocalTextFile({
        outputPath: targetPath,
        sourcePath,
        content: inspection.sanitizedText,
        overwrite,
        toolId: "D11",
      });
      setIoMessage({
        kind: "ok",
        text: t.unicodeTool.savedSuccess(saved.path),
      });
    } catch (err) {
      const parsed = parseBackendError(err);
      if (parsed.code === "TARGET_ALREADY_EXISTS" && !overwrite) {
        setPendingOverwritePath(targetPath);
        return;
      }
      setIoMessage({ kind: "err", text: formatLocalizedError(err, t) });
    }
  };

  const handleSaveCleanedAs = async () => {
    if (!inspection) return;
    const defaultPath = sourcePath
      ? ((await suggestSafeSiblingPath(sourcePath, ".cleaned", "txt")) ?? undefined)
      : "cleaned.txt";
    const chosen = await pickSaveFilePath({
      title: t.unicodeTool.saveCleanedBtn,
      defaultPath,
      filters: [
        { name: "UTF-8 Text", extensions: ["txt", "md", "json"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (chosen) {
      await executeSaveCleaned(chosen, false);
    }
  };

  const handleClear = () => {
    seqRef.current += 1;
    setInspection(null);
    setSelectedCpIndex(null);
    setPage(0);
    setIoMessage(null);
    setCopiedCleaned(false);
    updateUnicodeSession({
      inputText: "",
      sourcePath: null,
      sourceFileName: null,
    });
  };

  const unicodeVer = inspection?.summary.unicodeVersion ?? "16.0.0";

  return (
    <div className="tool-workspace">
      <div className="status-banner">
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span>{t.unicodeTool.scopeNote(unicodeVer)}</span>
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            {t.unicodeTool.confusableNeutralNote}
          </span>
        </div>
        <div className="tool-toolbar-group">
          <button
            type="button"
            className="btn"
            onClick={() => {
              setPage(0);
              setSelectedCpIndex(null);
              setIoMessage(null);
              updateUnicodeSession({
                inputText: DIAGNOSTIC_SAMPLE,
                sourcePath: null,
                sourceFileName: null,
              });
            }}
          >
            {t.unicodeTool.sampleBtn}
          </button>
          <button type="button" className="btn" onClick={() => void handleOpenFile()}>
            <FolderOpen size={14} aria-hidden="true" />
            {t.unicodeTool.openFileBtn}
          </button>
          <button
            type="button"
            className="btn"
            onClick={handleClear}
            disabled={!inputText && !sourcePath}
          >
            <RotateCcw size={14} aria-hidden="true" />
            {t.unicodeTool.clearBtn}
          </button>
        </div>
      </div>

      {ioMessage && (
        <div
          className={`status-banner ${ioMessage.kind === "ok" ? "is-ok" : "is-err"}`}
          role={ioMessage.kind === "err" ? "alert" : "status"}
        >
          <span>{ioMessage.text}</span>
        </div>
      )}

      {/* Source Input Textarea */}
      <div className={`pane ${dropHover ? "is-drop-hover" : ""}`} style={{ flexShrink: 0 }}>
        <div className="pane-header">
          <label htmlFor={inputFieldId} className="pane-title">
            {t.unicodeTool.inputLabel}
            {sourceFileName ? ` · ${sourceFileName}` : ""}
          </label>
          {inspection && (
            <span className="badge" data-testid="unicode-summary-badge">
              {t.unicodeTool.summaryStats(
                inspection.summary.totalCodePoints,
                inspection.summary.totalUtf16Units,
                inspection.summary.totalGraphemes,
                inspection.summary.totalUtf8Bytes,
              )}
            </span>
          )}
        </div>
        <textarea
          ref={textareaRef}
          id={inputFieldId}
          className="code-editor"
          style={{ minHeight: 86, maxHeight: 126 }}
          value={inputText}
          onChange={(e) => {
            setPage(0);
            updateUnicodeSession({ inputText: e.target.value });
          }}
          onClick={handleTextareaLocate}
          onKeyUp={handleTextareaLocate}
          placeholder={t.unicodeTool.inputPlaceholder}
          spellCheck={false}
        />
      </div>

      {!inspection ? (
        <div className="empty-state">{t.unicodeTool.emptyHint}</div>
      ) : (
        <>
          {/* Code-Point Breakdown Table */}
          <div className="pane" style={{ flex: 1, minHeight: 240 }}>
            <div className="pane-header">
              <div className="tool-toolbar-group">
                <span className="pane-title">{t.unicodeTool.tablePaneTitle}</span>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={attentionOnly}
                    onChange={(e) => {
                      setPage(0);
                      updateUnicodeSession({ attentionOnly: e.target.checked });
                    }}
                  />
                  {t.unicodeTool.attentionOnlyLabel(inspection.summary.attentionCount)}
                </label>
              </div>

              {filteredEntries.length > 0 && (
                <div className="tool-toolbar-group">
                  <span className="mono-inline" style={{ color: "var(--text-muted)" }}>
                    {t.unicodeTool.pageInfo(
                      pageStartIdx + 1,
                      Math.min(filteredEntries.length, pageStartIdx + PAGE_SIZE),
                      filteredEntries.length,
                    )}
                  </span>
                  {totalPages > 1 && (
                    <>
                      <button
                        type="button"
                        className="btn"
                        disabled={clampedPage === 0}
                        onClick={() => setPage((p) => Math.max(0, p - 1))}
                      >
                        {t.unicodeTool.prevPageBtn}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={clampedPage >= totalPages - 1}
                        onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                      >
                        {t.unicodeTool.nextPageBtn}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>

            <div style={{ flex: 1, overflow: "auto" }}>
              <table className="kv-table" data-testid="unicode-codepoints-table">
                <thead>
                  <tr>
                    <th style={{ width: 54 }}>{t.unicodeTool.colCpIdx}</th>
                    <th style={{ width: 64 }}>{t.unicodeTool.colUtf16}</th>
                    <th style={{ width: 60 }}>{t.unicodeTool.colGrapheme}</th>
                    <th style={{ width: 82 }}>{t.unicodeTool.colHex}</th>
                    <th style={{ width: 76 }}>{t.unicodeTool.colGlyph}</th>
                    <th>{t.unicodeTool.colName}</th>
                    <th style={{ width: 150 }}>{t.unicodeTool.colCategoryScript}</th>
                    <th style={{ width: 112 }}>{t.unicodeTool.colUtf8}</th>
                    <th>{t.unicodeTool.colFlags}</th>
                  </tr>
                </thead>
                <tbody>
                  {pageEntries.map((entry) => {
                    const isSelected = selectedCpIndex === entry.codePointIndex;
                    return (
                      <tr
                        key={entry.codePointIndex}
                        onClick={() => handleSelectRow(entry)}
                        style={{
                          cursor: "pointer",
                          background: isSelected
                            ? "var(--accent-soft)"
                            : entry.isAttentionItem
                              ? "var(--status-warn-bg)"
                              : undefined,
                        }}
                      >
                        <td className="mono-inline">{entry.codePointIndex}</td>
                        <td className="mono-inline">{entry.utf16Offset}</td>
                        <td className="mono-inline">{entry.graphemeIndex}</td>
                        <td className="mono-inline">{entry.codePointHex}</td>
                        <td className="mono-inline">{entry.displayGlyph}</td>
                        <td className="mono-inline">{entry.name}</td>
                        <td className="mono-inline">
                          {entry.generalCategory.split(" · ")[0]} · {entry.script}
                        </td>
                        <td className="mono-inline">{entry.utf8BytesHex}</td>
                        <td>
                          {entry.flags.length === 0 ? (
                            <span style={{ color: "var(--text-muted)" }}>—</span>
                          ) : (
                            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                              {entry.flags.map((flag) => (
                                <span key={flag} className="badge badge-partial">
                                  {t.unicodeTool.flagLabels[flag]}
                                  {flag === "potential_confusable" && entry.confusablePrototype
                                    ? ` · ${t.unicodeTool.confusableProtoPrefix}: ${entry.confusablePrototype}`
                                    : ""}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Previewable Non-Destructive Sanitizer */}
          <div className="pane" style={{ flexShrink: 0 }}>
            <div className="pane-header">
              <span className="pane-title">{t.unicodeTool.sanitizerPaneTitle}</span>
              <div className="tool-toolbar-group">
                <button type="button" className="btn" onClick={() => void handleCopyCleaned()}>
                  <Copy size={14} aria-hidden="true" />
                  {copiedCleaned ? t.unicodeTool.copiedBadge : t.unicodeTool.copyCleanedBtn}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void handleSaveCleanedAs()}
                >
                  <Download size={14} aria-hidden="true" />
                  {t.unicodeTool.saveCleanedBtn}
                </button>
              </div>
            </div>

            <div className="split-panes" style={{ minHeight: 190, padding: 12 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={sanitizeOptions.removeBom}
                    onChange={(e) => patchSanitize({ removeBom: e.target.checked })}
                  />
                  {t.unicodeTool.optRemoveBom}
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={sanitizeOptions.removeZeroWidth}
                    onChange={(e) => patchSanitize({ removeZeroWidth: e.target.checked })}
                  />
                  {t.unicodeTool.optRemoveZeroWidth}
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={sanitizeOptions.normalizeSpecialSpaces}
                    onChange={(e) => patchSanitize({ normalizeSpecialSpaces: e.target.checked })}
                  />
                  {t.unicodeTool.optNormalizeSpaces}
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={sanitizeOptions.removeC0C1Controls}
                    onChange={(e) => patchSanitize({ removeC0C1Controls: e.target.checked })}
                  />
                  {t.unicodeTool.optRemoveControls}
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={sanitizeOptions.removeBidiControls}
                    onChange={(e) => patchSanitize({ removeBidiControls: e.target.checked })}
                  />
                  {t.unicodeTool.optRemoveBidi}
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={sanitizeOptions.removeJoinersAndVs}
                    onChange={(e) => patchSanitize({ removeJoinersAndVs: e.target.checked })}
                  />
                  {t.unicodeTool.optRemoveJoiners}
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={sanitizeOptions.replaceConfusables}
                    onChange={(e) => patchSanitize({ replaceConfusables: e.target.checked })}
                  />
                  {t.unicodeTool.optReplaceConfusables}
                </label>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span className="field-label">{t.unicodeTool.previewLabel}</span>
                  <span className="badge" data-testid="unicode-changes-count">
                    {inspection.totalChangeCount === 0
                      ? t.unicodeTool.noChangesNote
                      : t.unicodeTool.changesSummary(
                          inspection.totalChangeCount,
                          inspection.changesTruncated,
                        )}
                  </span>
                </div>

                {inspection.changes.length > 0 && (
                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      flexWrap: "wrap",
                      maxHeight: 68,
                      overflowY: "auto",
                    }}
                    data-testid="unicode-change-pills"
                  >
                    {inspection.changes.slice(0, 40).map((ch, idx) => (
                      <span key={`${ch.codePointIndex}-${idx}`} className="badge">
                        #{ch.codePointIndex} {ch.codePointHex} {ch.originalLabel}{" "}
                        {ch.action === "removed" ? "→ ∅" : `→ ${ch.replacementLabel}`}
                      </span>
                    ))}
                  </div>
                )}

                <pre
                  className="mono-block"
                  style={{
                    border: "1px solid var(--border-subtle)",
                    borderRadius: 6,
                    flex: 1,
                    minHeight: 84,
                  }}
                  data-testid="unicode-sanitized-preview"
                >
                  {inspection.sanitizedText}
                </pre>
              </div>
            </div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={pendingOverwritePath !== null}
        title={t.unicodeTool.overwriteConfirmTitle}
        body={t.unicodeTool.overwriteConfirmBody(pendingOverwritePath ?? "")}
        confirmLabel={t.unicodeTool.overwriteConfirmAccept}
        cancelLabel={t.unicodeTool.cancel}
        onCancel={() => setPendingOverwritePath(null)}
        onConfirm={() => {
          const path = pendingOverwritePath;
          setPendingOverwritePath(null);
          if (path) {
            void executeSaveCleaned(path, true);
          }
        }}
      />
    </div>
  );
}
