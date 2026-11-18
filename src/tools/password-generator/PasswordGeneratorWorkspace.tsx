import { Check, Copy, Eraser, Eye, EyeOff, RefreshCw } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore } from "../../lib/sessionStore";
import {
  formatLocalizedError,
  generateSecretsBatch,
  writeSystemClipboardText,
} from "../../lib/tauriBridge";
import {
  MAX_PASSPHRASE_WORDS,
  MAX_PASSWORD_LENGTH,
  MAX_SECRET_BATCH_COUNT,
  MIN_PASSPHRASE_WORDS,
  MIN_PASSWORD_LENGTH,
  MIN_SECRET_BATCH_COUNT,
  previewSecretConfigStrength,
  type PassphraseSeparator,
  type SecretGenRequest,
} from "./passwordEngine";

function maskSecretForDisplay(secret: string): string {
  const len = Array.from(secret).length;
  return "•".repeat(Math.min(Math.max(len, 8), 36));
}

export function PasswordGeneratorWorkspace() {
  const { t } = useI18n();
  const { session, updatePasswordGeneratorSession } = useSessionStore();
  const state = session.passwordGenerator;

  const lengthInputId = useId();
  const wordCountInputId = useId();
  const batchInputId = useId();
  const sepSelectId = useId();

  // Kept strictly component-local so switching away and returning automatically re-masks items!
  const [revealed, setRevealed] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  const parsedValidation = useMemo(():
    | {
        ok: true;
        request: SecretGenRequest;
        preview: Extract<ReturnType<typeof previewSecretConfigStrength>, { ok: true }>;
      }
    | { ok: false; errorText: string } => {
    const batchTrim = state.rawBatchCount.trim();
    if (!/^\d+$/.test(batchTrim)) {
      return {
        ok: false,
        errorText: t.passwordTool.errInvalidBatchCount(
          MIN_SECRET_BATCH_COUNT,
          MAX_SECRET_BATCH_COUNT,
        ),
      };
    }
    const count = Number(batchTrim);
    if (count < MIN_SECRET_BATCH_COUNT || count > MAX_SECRET_BATCH_COUNT) {
      return {
        ok: false,
        errorText: t.passwordTool.errInvalidBatchCount(
          MIN_SECRET_BATCH_COUNT,
          MAX_SECRET_BATCH_COUNT,
        ),
      };
    }

    if (state.mode === "password") {
      const lenTrim = state.rawLength.trim();
      if (!/^\d+$/.test(lenTrim)) {
        return {
          ok: false,
          errorText: t.passwordTool.errInvalidLength(MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH),
        };
      }
      const length = Number(lenTrim);
      if (length < MIN_PASSWORD_LENGTH || length > MAX_PASSWORD_LENGTH) {
        return {
          ok: false,
          errorText: t.passwordTool.errInvalidLength(MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH),
        };
      }

      const request: SecretGenRequest = {
        mode: "password",
        length,
        count,
        uppercase: state.uppercase,
        lowercase: state.lowercase,
        digits: state.digits,
        symbols: state.symbols,
        excludeLookAlikes: state.excludeLookAlikes,
        requireEachSelectedClass: state.requireEachSelectedClass,
      };
      const preview = previewSecretConfigStrength(request);
      if (!preview.ok) {
        if (preview.code === "NO_CHARSET_SELECTED") {
          return { ok: false, errorText: t.passwordTool.errNoCharset };
        }
        if (preview.code === "IMPOSSIBLE_CONSTRAINTS") {
          return { ok: false, errorText: t.passwordTool.errImpossibleConstraints };
        }
        return { ok: false, errorText: preview.message };
      }
      return { ok: true, request, preview };
    }

    const wcTrim = state.rawWordCount.trim();
    if (!/^\d+$/.test(wcTrim)) {
      return {
        ok: false,
        errorText: t.passwordTool.errInvalidWordCount(MIN_PASSPHRASE_WORDS, MAX_PASSPHRASE_WORDS),
      };
    }
    const wordCount = Number(wcTrim);
    if (wordCount < MIN_PASSPHRASE_WORDS || wordCount > MAX_PASSPHRASE_WORDS) {
      return {
        ok: false,
        errorText: t.passwordTool.errInvalidWordCount(MIN_PASSPHRASE_WORDS, MAX_PASSPHRASE_WORDS),
      };
    }

    const request: SecretGenRequest = {
      mode: "passphrase",
      wordCount,
      count,
      separator: state.separator,
      capitalizeWords: state.capitalizeWords,
      includeNumber: state.includeNumber,
    };
    const preview = previewSecretConfigStrength(request);
    if (!preview.ok) {
      return { ok: false, errorText: preview.message };
    }
    return { ok: true, request, preview };
  }, [state, t]);

  const markConfigEdited = (patch: Parameters<typeof updatePasswordGeneratorSession>[0]) => {
    setCopiedKey(null);
    setRuntimeError(null);
    updatePasswordGeneratorSession({
      ...patch,
      isStale: state.generatedItems.length > 0 ? true : state.isStale,
    });
  };

  const handleGenerate = async () => {
    if (!parsedValidation.ok || isGenerating) return;
    setIsGenerating(true);
    setRuntimeError(null);
    setCopiedKey(null);
    try {
      const resp = await generateSecretsBatch(parsedValidation.request);
      updatePasswordGeneratorSession({
        generatedItems: resp.items,
        generatedStrength: resp.strength,
        isStale: false,
      });
    } catch (err) {
      setRuntimeError(formatLocalizedError(err, t));
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopy = async (text: string, key: string) => {
    if (state.isStale || !parsedValidation.ok) return;
    try {
      await writeSystemClipboardText(text);
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((prev) => (prev === key ? null : prev));
      }, 1500);
    } catch (err) {
      setRuntimeError(formatLocalizedError(err, t));
    }
  };

  const activeStrength = parsedValidation.ok ? parsedValidation.preview.strength : null;
  const canCopyCurrent =
    parsedValidation.ok && !state.isStale && state.generatedItems.length > 0 && !isGenerating;

  return (
    <div className="tool-workspace">
      <p className="field-hint">{t.passwordTool.scopeNote}</p>

      <div className="tool-toolbar">
        <div className="tool-toolbar-group">
          <div className="segmented" role="group" aria-label="Mode">
            <button
              type="button"
              className={`segmented-btn ${state.mode === "password" ? "is-selected" : ""}`}
              aria-pressed={state.mode === "password"}
              onClick={() => markConfigEdited({ mode: "password" })}
            >
              {t.passwordTool.modePassword}
            </button>
            <button
              type="button"
              className={`segmented-btn ${state.mode === "passphrase" ? "is-selected" : ""}`}
              aria-pressed={state.mode === "passphrase"}
              onClick={() => markConfigEdited({ mode: "passphrase" })}
            >
              {t.passwordTool.modePassphrase}
            </button>
          </div>

          {state.mode === "password" ? (
            <label className="field-row" htmlFor={lengthInputId} style={{ gap: "6px" }}>
              <span className="field-hint">{t.passwordTool.passwordLengthLabel}</span>
              <input
                id={lengthInputId}
                type="text"
                inputMode="numeric"
                className="text-input"
                style={{ width: "74px" }}
                value={state.rawLength}
                onChange={(e) => markConfigEdited({ rawLength: e.target.value })}
              />
            </label>
          ) : (
            <label className="field-row" htmlFor={wordCountInputId} style={{ gap: "6px" }}>
              <span className="field-hint">{t.passwordTool.wordCountLabel}</span>
              <input
                id={wordCountInputId}
                type="text"
                inputMode="numeric"
                className="text-input"
                style={{ width: "74px" }}
                value={state.rawWordCount}
                onChange={(e) => markConfigEdited({ rawWordCount: e.target.value })}
              />
            </label>
          )}

          <label className="field-row" htmlFor={batchInputId} style={{ gap: "6px" }}>
            <span className="field-hint">{t.passwordTool.batchCountLabel}</span>
            <input
              id={batchInputId}
              type="text"
              inputMode="numeric"
              className="text-input"
              style={{ width: "74px" }}
              value={state.rawBatchCount}
              onChange={(e) => markConfigEdited({ rawBatchCount: e.target.value })}
            />
          </label>
        </div>

        <div className="tool-toolbar-group">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!parsedValidation.ok || isGenerating}
            onClick={() => void handleGenerate()}
          >
            <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>
              {state.generatedItems.length > 0
                ? t.passwordTool.regenerateBtn
                : t.passwordTool.generateBtn}
            </span>
          </button>

          <button
            type="button"
            className="btn"
            disabled={state.generatedItems.length === 0}
            onClick={() => setRevealed((prev) => !prev)}
          >
            {revealed ? (
              <EyeOff size={14} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Eye size={14} strokeWidth={1.75} aria-hidden="true" />
            )}
            <span>{revealed ? t.passwordTool.hideBtn : t.passwordTool.revealBtn}</span>
          </button>

          <button
            type="button"
            className="btn"
            disabled={!canCopyCurrent}
            onClick={() => void handleCopy(state.generatedItems.join("\n"), "batch")}
          >
            {copiedKey === "batch" ? (
              <Check size={14} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
            )}
            <span>
              {copiedKey === "batch"
                ? t.passwordTool.copiedBadge
                : t.passwordTool.copyBatchBtn(state.generatedItems.length)}
            </span>
          </button>

          <button
            type="button"
            className="btn"
            disabled={state.generatedItems.length === 0}
            onClick={() => {
              setCopiedKey(null);
              setRuntimeError(null);
              setRevealed(false);
              updatePasswordGeneratorSession({
                generatedItems: [],
                generatedStrength: null,
                isStale: false,
              });
            }}
          >
            <Eraser size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{t.passwordTool.clearBtn}</span>
          </button>
        </div>
      </div>

      {!parsedValidation.ok && (
        <div className="status-banner is-err" role="alert" data-testid="password-error-banner">
          <span>{parsedValidation.errorText}</span>
        </div>
      )}

      {runtimeError && (
        <div className="status-banner is-err" role="alert">
          <span>{runtimeError}</span>
        </div>
      )}

      {parsedValidation.ok && state.isStale && state.generatedItems.length > 0 && (
        <div className="status-banner is-warn" data-testid="password-stale-banner">
          <span>{t.passwordTool.staleBanner}</span>
        </div>
      )}

      <div className="split-panes" style={{ minHeight: "340px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", minWidth: 0 }}>
          <div className="pane">
            <div className="pane-header">
              <span className="pane-title">
                {state.mode === "password"
                  ? t.passwordTool.charClassesTitle
                  : t.passwordTool.passphraseOptionsTitle}
              </span>
            </div>
            <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "10px" }}>
              {state.mode === "password" ? (
                <>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={state.uppercase}
                      onChange={(e) => markConfigEdited({ uppercase: e.target.checked })}
                    />
                    <span>{t.passwordTool.optUppercase}</span>
                  </label>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={state.lowercase}
                      onChange={(e) => markConfigEdited({ lowercase: e.target.checked })}
                    />
                    <span>{t.passwordTool.optLowercase}</span>
                  </label>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={state.digits}
                      onChange={(e) => markConfigEdited({ digits: e.target.checked })}
                    />
                    <span>{t.passwordTool.optDigits}</span>
                  </label>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={state.symbols}
                      onChange={(e) => markConfigEdited({ symbols: e.target.checked })}
                    />
                    <span>{t.passwordTool.optSymbols}</span>
                  </label>
                  <hr
                    style={{
                      border: "none",
                      borderTop: "1px solid var(--border-subtle)",
                      margin: "2px 0",
                    }}
                  />
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={state.excludeLookAlikes}
                      onChange={(e) => markConfigEdited({ excludeLookAlikes: e.target.checked })}
                    />
                    <span>{t.passwordTool.optExcludeLookAlikes}</span>
                  </label>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={state.requireEachSelectedClass}
                      onChange={(e) =>
                        markConfigEdited({ requireEachSelectedClass: e.target.checked })
                      }
                    />
                    <span>{t.passwordTool.optRequireEachClass}</span>
                  </label>
                </>
              ) : (
                <>
                  <label className="field-row" htmlFor={sepSelectId}>
                    <span className="field-label">{t.passwordTool.separatorLabel}</span>
                    <select
                      id={sepSelectId}
                      className="select-input"
                      value={state.separator}
                      onChange={(e) =>
                        markConfigEdited({ separator: e.target.value as PassphraseSeparator })
                      }
                    >
                      <option value="-">{t.passwordTool.sepHyphen}</option>
                      <option value=" ">{t.passwordTool.sepSpace}</option>
                      <option value=".">{t.passwordTool.sepDot}</option>
                      <option value="_">{t.passwordTool.sepUnderscore}</option>
                      <option value="">{t.passwordTool.sepNone}</option>
                    </select>
                  </label>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={state.capitalizeWords}
                      onChange={(e) => markConfigEdited({ capitalizeWords: e.target.checked })}
                    />
                    <span>{t.passwordTool.optCapitalize}</span>
                  </label>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={state.includeNumber}
                      onChange={(e) => markConfigEdited({ includeNumber: e.target.checked })}
                    />
                    <span>{t.passwordTool.optIncludeNumber}</span>
                  </label>
                </>
              )}
            </div>
          </div>

          {activeStrength && (
            <div className="pane" data-testid="password-strength-card">
              <div className="pane-header">
                <span className="pane-title">{t.passwordTool.strengthTitle}</span>
                <span
                  className={`badge ${
                    activeStrength.tier === "strong" || activeStrength.tier === "very_strong"
                      ? "badge-ok"
                      : activeStrength.tier === "fair"
                        ? "badge-partial"
                        : "badge-err"
                  }`}
                >
                  {t.passwordTool.tierLabels[activeStrength.tier]}
                </span>
              </div>
              <div
                style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "8px" }}
              >
                <div style={{ fontSize: "13.5px", fontWeight: 600 }}>
                  {activeStrength.isUpperBound
                    ? t.passwordTool.bitsUpperBoundLabel(activeStrength.estimatedBits)
                    : t.passwordTool.bitsExactLabel(activeStrength.estimatedBits)}
                </div>
                <div className="progress-track">
                  <div
                    className="progress-fill"
                    style={{
                      width: `${Math.min(100, Math.max(8, Math.round((activeStrength.estimatedBits / 128) * 100)))}%`,
                    }}
                  />
                </div>
                <p className="field-hint" style={{ lineHeight: "18px" }}>
                  {activeStrength.modelKind === "independent_uniform_chars" &&
                    t.passwordTool.modelAssumptions.independent_uniform_chars(
                      activeStrength.poolSize,
                    )}
                  {activeStrength.modelKind === "constrained_all_selected_classes" &&
                    t.passwordTool.modelAssumptions.constrained_all_selected_classes(
                      activeStrength.poolSize,
                      activeStrength.unconstrainedUpperBoundBits,
                    )}
                  {activeStrength.modelKind === "independent_words_with_replacement" &&
                    t.passwordTool.modelAssumptions.independent_words_with_replacement(
                      activeStrength.poolSize,
                      activeStrength.isUpperBound,
                    )}
                </p>
                <p className="field-hint" style={{ lineHeight: "17px" }}>
                  {t.passwordTool.memoryPrivacyNote}
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="pane" style={{ minHeight: "300px" }}>
          <div className="pane-header">
            <span className="pane-title">
              {t.passwordTool.resultsPaneTitle(state.generatedItems.length, !revealed)}
            </span>
          </div>
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "12px",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
            }}
            data-testid="password-results-list"
          >
            {state.generatedItems.length === 0 ? (
              <div className="empty-state">{t.passwordTool.emptyPrompt}</div>
            ) : (
              state.generatedItems.map((secret, idx) => {
                const rowKey = `item-${idx}`;
                return (
                  <div
                    key={rowKey}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "10px",
                      padding: "8px 10px",
                      borderRadius: "8px",
                      border: "1px solid var(--border-subtle)",
                      background: "var(--bg-subtle)",
                      opacity: state.isStale ? 0.58 : 1,
                    }}
                  >
                    <code
                      className="mono-inline"
                      style={{ wordBreak: "break-all", flex: 1 }}
                      data-testid={`secret-item-${idx}`}
                    >
                      {revealed ? secret : maskSecretForDisplay(secret)}
                    </code>

                    <button
                      type="button"
                      className="btn"
                      style={{ height: "26px", padding: "0 8px", fontSize: "12px" }}
                      disabled={!canCopyCurrent}
                      onClick={() => void handleCopy(secret, rowKey)}
                    >
                      {copiedKey === rowKey ? (
                        <Check size={12} strokeWidth={1.75} aria-hidden="true" />
                      ) : (
                        <Copy size={12} strokeWidth={1.75} aria-hidden="true" />
                      )}
                      <span>
                        {copiedKey === rowKey
                          ? t.passwordTool.copiedBadge
                          : t.passwordTool.copySingleBtn}
                      </span>
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
