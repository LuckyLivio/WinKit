import { Check, Copy, Eraser, Play, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore } from "../../lib/sessionStore";
import { formatLocalizedError, generateUuidBatch, inspectUuidString } from "../../lib/tauriBridge";
import {
  MAX_UUID_BATCH,
  formatUuidDisplay,
  type UuidGenVersion,
  type UuidInspectResult,
} from "./uuidEngine";

export function UuidGeneratorWorkspace() {
  const { t } = useI18n();
  const { session, updateUuidSession } = useSessionStore();
  const { version, count, uppercase, hyphens, generatedList, inspectInput } = session.uuid;

  const [countRaw, setCountRaw] = useState(() => String(count));
  const [genError, setGenError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [inspectResult, setInspectResult] = useState<UuidInspectResult | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);

  useEffect(() => {
    setCountRaw(String(count));
  }, [count]);

  // Run UUID inspection whenever `inspectInput` changes
  useEffect(() => {
    let active = true;
    const trimmed = inspectInput.trim();
    if (!trimmed) {
      setInspectResult(null);
      setInspectError(null);
      return () => {
        active = false;
      };
    }
    inspectUuidString(trimmed)
      .then((res) => {
        if (!active) return;
        setInspectResult(res);
        setInspectError(null);
      })
      .catch((err) => {
        if (!active) return;
        setInspectResult(null);
        setInspectError(formatLocalizedError(err, t));
      });
    return () => {
      active = false;
    };
  }, [inspectInput, t]);

  const formattedList = useMemo(
    () => generatedList.map((raw) => formatUuidDisplay(raw, { uppercase, hyphens })),
    [generatedList, hyphens, uppercase],
  );

  const copyWithFeedback = async (key: string, text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 1600);
    } catch {
      // Ignore clipboard permission errors silently
    }
  };

  const handleSelectVersion = (nextVersion: UuidGenVersion) => {
    if (nextVersion === version) return;
    setGenError(null);
    // Invalidate previous batch so v4 UUIDs are never shown under a v7 selector or vice versa
    updateUuidSession({ version: nextVersion, generatedList: [] });
  };

  const handleGenerate = async () => {
    const parsedCount = Number(countRaw.trim());
    if (!Number.isInteger(parsedCount) || parsedCount < 1 || parsedCount > MAX_UUID_BATCH) {
      setGenError(`${t.errors.INVALID_PARAMETER} (1–${MAX_UUID_BATCH})`);
      return;
    }
    try {
      const batch = await generateUuidBatch(version, parsedCount);
      setGenError(null);
      updateUuidSession({ count: parsedCount, generatedList: batch });
    } catch (err) {
      setGenError(formatLocalizedError(err, t));
    }
  };

  const handleClear = () => {
    setGenError(null);
    setInspectResult(null);
    setInspectError(null);
    setCopiedKey(null);
    updateUuidSession({ generatedList: [], inspectInput: "" });
  };

  const inspectNotes = (() => {
    if (!inspectResult) return null;
    if (inspectResult.isNil) return t.uuidTool.nilNote;
    if (inspectResult.isMax) return t.uuidTool.maxNote;
    if (inspectResult.version === 4) return t.uuidTool.v4NoTimestampNote;
    if (inspectResult.version === 1 || inspectResult.version === 6) {
      return t.uuidTool.unsupportedTimeVersionNote(inspectResult.version);
    }
    if (inspectResult.version !== null && inspectResult.version !== 7) {
      return `UUID v${inspectResult.version}`;
    }
    return null;
  })();

  return (
    <div className="tool-workspace">
      <div className="tool-toolbar">
        <div className="tool-toolbar-group">
          <div className="segmented" role="group" aria-label="UUID version">
            <button
              type="button"
              className={`segmented-btn ${version === "v4" ? "is-selected" : ""}`}
              aria-pressed={version === "v4"}
              onClick={() => handleSelectVersion("v4")}
            >
              {t.uuidTool.versionV4}
            </button>
            <button
              type="button"
              className={`segmented-btn ${version === "v7" ? "is-selected" : ""}`}
              aria-pressed={version === "v7"}
              onClick={() => handleSelectVersion("v7")}
            >
              {t.uuidTool.versionV7}
            </button>
          </div>

          <label
            className="field-label"
            style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
          >
            <span>{t.uuidTool.countLabel}</span>
            <input
              type="number"
              min={1}
              max={MAX_UUID_BATCH}
              className="text-input mono"
              style={{ width: "84px", height: "30px" }}
              value={countRaw}
              onChange={(e) => setCountRaw(e.target.value)}
            />
          </label>

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={uppercase}
              onChange={(e) => updateUuidSession({ uppercase: e.target.checked })}
            />
            <span>{t.uuidTool.uppercaseLabel}</span>
          </label>

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={hyphens}
              onChange={(e) => updateUuidSession({ hyphens: e.target.checked })}
            />
            <span>{t.uuidTool.hyphensLabel}</span>
          </label>
        </div>

        <div className="tool-toolbar-group">
          <button type="button" className="btn btn-primary" onClick={() => void handleGenerate()}>
            <Play size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{t.uuidTool.generateBtn}</span>
          </button>

          <button
            type="button"
            className="btn"
            disabled={formattedList.length === 0}
            onClick={() => void copyWithFeedback("all", formattedList.join("\n"))}
          >
            {copiedKey === "all" ? (
              <Check size={14} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
            )}
            <span>{copiedKey === "all" ? t.uuidTool.copiedBadge : t.uuidTool.copyAllBtn}</span>
          </button>

          <button type="button" className="btn" onClick={handleClear}>
            <Eraser size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{t.uuidTool.clearBtn}</span>
          </button>
        </div>
      </div>

      <p className="field-hint">{t.uuidTool.scopeNote}</p>

      {genError && (
        <div className="status-banner is-err" role="alert">
          <span>{genError}</span>
        </div>
      )}

      <div className="split-panes">
        {/* Left Pane: Generated UUID List */}
        <div className="pane">
          <div className="pane-header">
            <span className="pane-title">{t.uuidTool.generatePaneTitle}</span>
            <span className="badge mono">
              {version.toUpperCase()} · {formattedList.length}
            </span>
          </div>

          <div
            style={{
              padding: "12px",
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              flex: 1,
              overflowY: "auto",
            }}
          >
            {formattedList.length === 0 ? (
              <div
                style={{
                  padding: "24px 12px",
                  color: "var(--text-muted)",
                  fontSize: "12.5px",
                  textAlign: "center",
                  margin: "auto 0",
                }}
              >
                {t.uuidTool.emptyGenerated}
              </div>
            ) : (
              formattedList.map((item, idx) => {
                const rowKey = `row-${idx}`;
                return (
                  <div
                    key={`${idx}-${item}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "8px",
                      padding: "6px 10px",
                      borderRadius: "6px",
                      border: "1px solid var(--border-subtle)",
                      background: "var(--bg-subtle)",
                    }}
                  >
                    <span
                      className="mono"
                      data-testid={`uuid-row-${idx}`}
                      style={{
                        fontSize: "12.5px",
                        overflowX: "auto",
                        wordBreak: "break-all",
                        userSelect: "all",
                      }}
                    >
                      {item}
                    </span>
                    <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        style={{ height: "24px", padding: "0 6px", fontSize: "11.5px" }}
                        title={t.uuidTool.inspectPaneTitle}
                        onClick={() => updateUuidSession({ inspectInput: item })}
                      >
                        <Search size={12} strokeWidth={1.75} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="btn"
                        style={{ height: "24px", padding: "0 8px", fontSize: "11.5px" }}
                        onClick={() => void copyWithFeedback(rowKey, item)}
                      >
                        {copiedKey === rowKey ? (
                          <Check size={12} strokeWidth={1.75} aria-hidden="true" />
                        ) : (
                          <Copy size={12} strokeWidth={1.75} aria-hidden="true" />
                        )}
                        <span>
                          {copiedKey === rowKey ? t.uuidTool.copiedBadge : t.uuidTool.copySingleBtn}
                        </span>
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Pane: UUID Inspector */}
        <div className="pane">
          <div className="pane-header">
            <label htmlFor="uuid-inspect-input" className="pane-title">
              {t.uuidTool.inspectPaneTitle}
            </label>
            {inspectResult && <span className="badge badge-ok">{t.uuidTool.inspectValid}</span>}
            {inspectError && <span className="badge badge-err">{t.uuidTool.inspectInvalid}</span>}
          </div>

          <div
            style={{
              padding: "16px",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
              flex: 1,
            }}
          >
            <input
              id="uuid-inspect-input"
              type="text"
              className="text-input mono"
              spellCheck={false}
              placeholder={t.uuidTool.inspectPlaceholder}
              value={inspectInput}
              onChange={(e) => updateUuidSession({ inspectInput: e.target.value })}
            />

            {inspectError && (
              <div className="status-banner is-err" role="alert">
                <span>{inspectError}</span>
              </div>
            )}

            {inspectResult && (
              <div className="field-stack" style={{ gap: "10px" }}>
                <div
                  style={{
                    padding: "10px 12px",
                    borderRadius: "6px",
                    border: "1px solid var(--border-subtle)",
                    background: "var(--bg-subtle)",
                    display: "grid",
                    gridTemplateColumns: "110px minmax(0, 1fr)",
                    gap: "8px 12px",
                    fontSize: "12.5px",
                  }}
                >
                  <span style={{ color: "var(--text-secondary)" }}>
                    {t.uuidTool.fieldCanonical}
                  </span>
                  <span className="mono" style={{ wordBreak: "break-all" }}>
                    {inspectResult.canonical}
                  </span>

                  <span style={{ color: "var(--text-secondary)" }}>{t.uuidTool.fieldVersion}</span>
                  <span className="mono">
                    {inspectResult.isNil
                      ? "Nil (0)"
                      : inspectResult.isMax
                        ? "Max (15)"
                        : inspectResult.version !== null
                          ? `v${inspectResult.version}`
                          : "N/A (Non-RFC variant)"}
                  </span>

                  <span style={{ color: "var(--text-secondary)" }}>{t.uuidTool.fieldVariant}</span>
                  <span className="mono">{inspectResult.variant}</span>

                  {inspectResult.unixTimestampMs !== null && (
                    <>
                      <span style={{ color: "var(--text-secondary)" }}>
                        {t.uuidTool.fieldTimestamp}
                      </span>
                      <span className="mono" data-testid="uuid-inspected-ts">
                        {new Date(inspectResult.unixTimestampMs).toISOString()} (
                        {inspectResult.unixTimestampMs} ms)
                      </span>
                    </>
                  )}

                  {inspectNotes && (
                    <>
                      <span style={{ color: "var(--text-secondary)" }}>
                        {t.uuidTool.fieldNotes}
                      </span>
                      <span style={{ color: "var(--text-secondary)" }}>{inspectNotes}</span>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
