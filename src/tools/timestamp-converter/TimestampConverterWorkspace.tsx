import { Check, Clock, Copy, Eraser } from "lucide-react";
import { useMemo, useState } from "react";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore, type TimestampUnit } from "../../lib/sessionStore";
import {
  convertDateToTimestamp,
  convertTimestampToDate,
  getCommonTimeZones,
  type EpochBreakdown,
  type ZonedDisplayCard,
} from "./timestampEngine";

const UNIT_LABELS: Record<TimestampUnit, string> = {
  s: "s",
  ms: "ms",
  us: "µs",
  ns: "ns",
};

export function TimestampConverterWorkspace() {
  const { t } = useI18n();
  const { session, updateTimestampSession } = useSessionStore();
  const { mode, timestampInput, unit, dateInput, inputTimezone, displayTimezone } =
    session.timestamp;

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const commonZones = useMemo(() => getCommonTimeZones(), []);

  const computation = useMemo((): {
    breakdown: EpochBreakdown | null;
    usedUnit: TimestampUnit | null;
    suggestedUnit: TimestampUnit | null;
    error: string | null;
  } => {
    if (mode === "to_date") {
      if (!timestampInput.trim()) {
        return { breakdown: null, usedUnit: null, suggestedUnit: null, error: null };
      }
      try {
        const res = convertTimestampToDate(timestampInput, unit, displayTimezone);
        return {
          breakdown: res.breakdown,
          usedUnit: res.usedUnit,
          suggestedUnit: res.suggestedUnit,
          error: null,
        };
      } catch (err) {
        return {
          breakdown: null,
          usedUnit: unit,
          suggestedUnit: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    if (!dateInput.trim()) {
      return { breakdown: null, usedUnit: null, suggestedUnit: null, error: null };
    }
    try {
      const breakdown = convertDateToTimestamp(dateInput, inputTimezone, displayTimezone);
      return { breakdown, usedUnit: null, suggestedUnit: null, error: null };
    } catch (err) {
      return {
        breakdown: null,
        usedUnit: null,
        suggestedUnit: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }, [dateInput, displayTimezone, inputTimezone, mode, timestampInput, unit]);

  const copyWithFeedback = async (key: string, value: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 1600);
    } catch {
      // Ignore clipboard failure silently
    }
  };

  const handleUseNow = () => {
    const nowMs = BigInt(Date.now());
    if (mode === "to_date") {
      const val =
        unit === "s"
          ? nowMs / 1000n
          : unit === "ms"
            ? nowMs
            : unit === "us"
              ? nowMs * 1000n
              : nowMs * 1_000_000n;
      updateTimestampSession({ timestampInput: val.toString() });
    } else {
      updateTimestampSession({ dateInput: new Date(Number(nowMs)).toISOString() });
    }
  };

  const handleClear = () => {
    setCopiedKey(null);
    updateTimestampSession({ timestampInput: "", dateInput: "" });
  };

  const renderZoneCard = (title: string, card: ZonedDisplayCard, keyPrefix: string) => (
    <div
      key={keyPrefix}
      style={{
        padding: "10px 12px",
        borderRadius: "6px",
        border: "1px solid var(--border-subtle)",
        background: "var(--bg-subtle)",
        display: "flex",
        flexDirection: "column",
        gap: "6px",
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
        <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-primary)" }}>
          {title}
        </span>
        <span className="badge mono">{card.utcOffset}</span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
        }}
      >
        <div className="mono" style={{ fontSize: "12px", wordBreak: "break-all" }}>
          <div>
            <span style={{ color: "var(--text-muted)" }}>{t.timestampTool.isoLabel}: </span>
            <strong data-testid={`${keyPrefix}-iso`}>{card.iso8601}</strong>
          </div>
          <div style={{ color: "var(--text-secondary)", marginTop: "2px" }}>
            <span style={{ color: "var(--text-muted)" }}>{t.timestampTool.localCivilLabel}: </span>
            <span>{card.civilDateTime}</span>
          </div>
        </div>
        <button
          type="button"
          className="btn"
          style={{ height: "26px", padding: "0 8px", fontSize: "11.5px", flexShrink: 0 }}
          aria-label={`${t.timestampTool.copyBtn} ${keyPrefix}`}
          onClick={() => void copyWithFeedback(`${keyPrefix}-iso`, card.iso8601)}
        >
          {copiedKey === `${keyPrefix}-iso` ? (
            <Check size={12} strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <Copy size={12} strokeWidth={1.75} aria-hidden="true" />
          )}
          <span>
            {copiedKey === `${keyPrefix}-iso`
              ? t.timestampTool.copiedBadge
              : t.timestampTool.copyBtn}
          </span>
        </button>
      </div>
    </div>
  );

  const bd = computation.breakdown;
  const subMsText = useMemo(() => {
    if (!bd || bd.subMsRemainderNs === 0n) return null;
    const usPart = bd.subMsRemainderNs / 1000n;
    const nsPart = bd.subMsRemainderNs % 1000n;
    return `+${usPart.toString()} µs ${nsPart.toString()} ns`;
  }, [bd]);

  return (
    <div className="tool-workspace">
      <div className="tool-toolbar">
        <div className="tool-toolbar-group">
          <div className="segmented" role="group" aria-label="Timestamp conversion direction">
            <button
              type="button"
              className={`segmented-btn ${mode === "to_date" ? "is-selected" : ""}`}
              aria-pressed={mode === "to_date"}
              onClick={() => updateTimestampSession({ mode: "to_date" })}
            >
              {t.timestampTool.modeToDate}
            </button>
            <button
              type="button"
              className={`segmented-btn ${mode === "to_timestamp" ? "is-selected" : ""}`}
              aria-pressed={mode === "to_timestamp"}
              onClick={() => updateTimestampSession({ mode: "to_timestamp" })}
            >
              {t.timestampTool.modeToTs}
            </button>
          </div>

          {mode === "to_date" && (
            <div className="segmented" role="group" aria-label={t.timestampTool.unitLabel}>
              {(
                [
                  ["s", t.timestampTool.unitSec],
                  ["ms", t.timestampTool.unitMs],
                  ["us", t.timestampTool.unitUs],
                  ["ns", t.timestampTool.unitNs],
                ] as Array<[TimestampUnit, string]>
              ).map(([uId, uLabel]) => (
                <button
                  key={uId}
                  type="button"
                  className={`segmented-btn ${unit === uId ? "is-selected" : ""}`}
                  aria-pressed={unit === uId}
                  onClick={() => updateTimestampSession({ unit: uId })}
                >
                  {uLabel}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="tool-toolbar-group">
          <button type="button" className="btn btn-primary" onClick={handleUseNow}>
            <Clock size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{t.timestampTool.nowBtn}</span>
          </button>

          <button type="button" className="btn" onClick={handleClear}>
            <Eraser size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{t.timestampTool.clearBtn}</span>
          </button>
        </div>
      </div>

      <p className="field-hint">{t.timestampTool.scopeNote}</p>

      {computation.error && (
        <div className="status-banner is-err" role="alert">
          <span>{computation.error}</span>
        </div>
      )}

      {computation.suggestedUnit && (
        <div
          className="status-banner is-warn"
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
          }}
        >
          <span>
            {
              t.timestampTool.suggestedUnitHint(
                UNIT_LABELS[computation.suggestedUnit],
                UNIT_LABELS[computation.suggestedUnit],
              ).text
            }
          </span>
          <button
            type="button"
            className="btn"
            style={{ height: "26px", padding: "0 10px", fontSize: "12px", flexShrink: 0 }}
            onClick={() => updateTimestampSession({ unit: computation.suggestedUnit! })}
          >
            {UNIT_LABELS[computation.suggestedUnit]}
          </button>
        </div>
      )}

      <div className="split-panes">
        {/* Left Pane: Input & Epoch Integer Table */}
        <div className="pane">
          <div className="pane-header">
            <span className="pane-title">
              {mode === "to_date" ? t.timestampTool.tsInputLabel : t.timestampTool.dateInputLabel}
            </span>
            {computation.usedUnit && (
              <span className="badge mono">
                {t.timestampTool.usedUnitBadge(UNIT_LABELS[computation.usedUnit])}
              </span>
            )}
          </div>

          <div
            style={{
              padding: "16px",
              display: "flex",
              flexDirection: "column",
              gap: "14px",
              flex: 1,
              overflowY: "auto",
            }}
          >
            {mode === "to_date" ? (
              <div className="field-stack">
                <label htmlFor="ts-integer-input" className="field-label">
                  {t.timestampTool.tsInputLabel}
                </label>
                <input
                  id="ts-integer-input"
                  type="text"
                  className="text-input mono"
                  spellCheck={false}
                  placeholder={t.timestampTool.tsPlaceholder}
                  value={timestampInput}
                  onChange={(e) => updateTimestampSession({ timestampInput: e.target.value })}
                />
              </div>
            ) : (
              <>
                <div className="field-stack">
                  <label htmlFor="ts-date-input" className="field-label">
                    {t.timestampTool.dateInputLabel}
                  </label>
                  <input
                    id="ts-date-input"
                    type="text"
                    className="text-input mono"
                    spellCheck={false}
                    placeholder={t.timestampTool.datePlaceholder}
                    value={dateInput}
                    onChange={(e) => updateTimestampSession({ dateInput: e.target.value })}
                  />
                </div>

                <div className="field-stack">
                  <label htmlFor="ts-interpret-tz" className="field-label">
                    {t.timestampTool.interpretTzLabel}
                  </label>
                  <input
                    id="ts-interpret-tz"
                    type="text"
                    list="winkit-iana-zones"
                    className="text-input mono"
                    spellCheck={false}
                    placeholder={t.timestampTool.tzPlaceholder}
                    value={inputTimezone}
                    onChange={(e) => updateTimestampSession({ inputTimezone: e.target.value })}
                  />
                </div>
              </>
            )}

            <div className="field-stack">
              <label htmlFor="ts-display-tz" className="field-label">
                {t.timestampTool.displayTzLabel}
              </label>
              <input
                id="ts-display-tz"
                type="text"
                list="winkit-iana-zones"
                className="text-input mono"
                spellCheck={false}
                placeholder={t.timestampTool.tzPlaceholder}
                value={displayTimezone}
                onChange={(e) => updateTimestampSession({ displayTimezone: e.target.value })}
              />
              <datalist id="winkit-iana-zones">
                {commonZones.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </div>

            {bd && (
              <div className="field-stack" style={{ marginTop: "4px" }}>
                {(
                  [
                    ["sec", t.timestampTool.epochSecLabel, bd.seconds],
                    ["ms", t.timestampTool.epochMsLabel, bd.milliseconds],
                    ["us", t.timestampTool.epochUsLabel, bd.microseconds],
                    ["ns", t.timestampTool.epochNsLabel, bd.nanoseconds],
                  ] as const
                ).map(([uKey, label, val]) => (
                  <div
                    key={uKey}
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
                    <div style={{ minWidth: 0 }}>
                      <span style={{ fontSize: "11.5px", color: "var(--text-secondary)" }}>
                        {label}
                      </span>
                      <div
                        className="mono"
                        data-testid={`epoch-${uKey}`}
                        style={{ fontSize: "12.5px", wordBreak: "break-all" }}
                      >
                        {val}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn"
                      style={{
                        height: "26px",
                        padding: "0 8px",
                        fontSize: "11.5px",
                        flexShrink: 0,
                      }}
                      onClick={() => void copyWithFeedback(`ep-${uKey}`, val)}
                    >
                      {copiedKey === `ep-${uKey}` ? (
                        <Check size={12} strokeWidth={1.75} aria-hidden="true" />
                      ) : (
                        <Copy size={12} strokeWidth={1.75} aria-hidden="true" />
                      )}
                      <span>
                        {copiedKey === `ep-${uKey}`
                          ? t.timestampTool.copiedBadge
                          : t.timestampTool.copyBtn}
                      </span>
                    </button>
                  </div>
                ))}
                {bd.hasCoarserTruncation && (
                  <p className="field-hint">{t.timestampTool.precisionTruncatedNote}</p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right Pane: Zoned ISO & Civil Outputs */}
        <div className="pane">
          <div className="pane-header">
            <span className="pane-title">ISO 8601 / IANA Timezones</span>
          </div>

          <div
            style={{
              padding: "16px",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
              flex: 1,
              overflowY: "auto",
            }}
          >
            {!bd ? (
              <div
                style={{
                  padding: "24px 12px",
                  color: "var(--text-muted)",
                  fontSize: "12.5px",
                  textAlign: "center",
                  margin: "auto 0",
                }}
              >
                {t.timestampTool.emptyPrompt}
              </div>
            ) : (
              <>
                {subMsText && (
                  <div className="status-banner is-ok" role="status">
                    <span>{t.timestampTool.subMsPrecisionNote(subMsText)}</span>
                  </div>
                )}

                {bd.customTzError && (
                  <div className="status-banner is-err" role="alert">
                    <span>{bd.customTzError}</span>
                  </div>
                )}

                {renderZoneCard(t.timestampTool.cardUtc, bd.utc, "utc")}
                {renderZoneCard(t.timestampTool.cardLocal(bd.local.timeZone), bd.local, "local")}
                {bd.custom &&
                  renderZoneCard(
                    t.timestampTool.cardCustom(bd.custom.timeZone),
                    bd.custom,
                    "custom",
                  )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
