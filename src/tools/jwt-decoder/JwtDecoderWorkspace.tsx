import { Copy, Eye, EyeOff, RotateCcw } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore } from "../../lib/sessionStore";
import { formatLocalizedError, verifyJwtHmac } from "../../lib/tauriBridge";
import {
  SUPPORTED_JWT_HMAC_ALGORITHMS,
  decodeJwtToken,
  evaluateJwtTimeClaims,
  formatRelativeDurationSeconds,
  isSupportedJwtHmacAlg,
  type JwtExpectedAlgChoice,
  type JwtHmacVerifyResponse,
  type JwtSecretEncoding,
  type JwtTimeClaimFieldState,
} from "./jwtEngine";

const SYNTHETIC_DEMO_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImRlbW8ta2V5LTEifQ.eyJpc3MiOiJodHRwczovL2F1dGguZXhhbXBsZS5pbnZhbGlkIiwic3ViIjoiZGVtby11c2VyIiwiYXVkIjoid2lua2l0LWxvY2FsIiwianRpIjoiZGVtby0wMDAxIiwiYWNjb3VudF9pZCI6OTAwNzE5OTI1NDc0MDk5MywiaWF0IjoxNzAwMDAwMDAwLCJuYmYiOjE3MDAwMDAwMDAsImV4cCI6MTk5OTk5OTk5OX0.lEzHCEQACwqO-jxjXBrQB__92Prd7S2SAlLTouT-iQU";
const SYNTHETIC_DEMO_SECRET = "winkit-demo-hs256-secret-01";

export function JwtDecoderWorkspace() {
  const { locale, t } = useI18n();
  const { session, updateJwtSession } = useSessionStore();
  const { tokenInput, secretInput, secretEncoding, expectedAlgorithm } = session.jwt;

  const tokenFieldId = useId();
  const secretFieldId = useId();
  const expectedAlgId = useId();

  // Always start masked on mount; never auto-copy or persist secret/token
  const [secretVisible, setSecretVisible] = useState(false);
  const [verifyState, setVerifyState] = useState<{
    loading: boolean;
    response: JwtHmacVerifyResponse | null;
    error: string | null;
  }>({
    loading: false,
    response: null,
    error: null,
  });
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const verifySeqRef = useRef(0);
  const copyTimerRef = useRef<number | null>(null);

  const decoded = useMemo(() => decodeJwtToken(tokenInput), [tokenInput]);

  // Periodically refresh time claim evaluation while a decoded JWS is displayed; clean up on unmount/clear
  useEffect(() => {
    if (decoded.kind !== "jws") {
      return;
    }
    setNowMs(Date.now());
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [decoded]);

  // Clean up copy badge timer on unmount
  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  // Re-evaluate HMAC signature whenever token, secret, encoding, or expected algorithm changes
  useEffect(() => {
    const seq = ++verifySeqRef.current;

    if (decoded.kind !== "jws") {
      setVerifyState({ loading: false, response: null, error: null });
      return;
    }

    setVerifyState({ loading: true, response: null, error: null });

    verifyJwtHmac({
      rawToken: tokenInput,
      expectedAlgorithm: expectedAlgorithm === "auto" ? null : expectedAlgorithm,
      secret: secretInput,
      secretEncoding,
    })
      .then((res) => {
        if (seq !== verifySeqRef.current) return;
        setVerifyState({ loading: false, response: res, error: null });
      })
      .catch((err) => {
        if (seq !== verifySeqRef.current) return;
        setVerifyState({
          loading: false,
          response: null,
          error: formatLocalizedError(err, t),
        });
      });
  }, [decoded, tokenInput, secretInput, secretEncoding, expectedAlgorithm, t]);

  const timeEval = useMemo(() => {
    if (decoded.kind !== "jws") return null;
    return evaluateJwtTimeClaims(decoded.payloadAst, nowMs);
  }, [decoded, nowMs]);

  const handleCopy = async (key: string, text: string) => {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopiedKey(null);
      }, 1600);
    } catch (err) {
      setCopyError(formatLocalizedError(err, t));
    }
  };

  const handleClear = () => {
    verifySeqRef.current += 1;
    setSecretVisible(false);
    setVerifyState({ loading: false, response: null, error: null });
    setCopiedKey(null);
    setCopyError(null);
    updateJwtSession({
      tokenInput: "",
      secretInput: "",
    });
  };

  const handleLoadSample = () => {
    setSecretVisible(false);
    setCopyError(null);
    updateJwtSession({
      tokenInput: SYNTHETIC_DEMO_TOKEN,
      secretInput: SYNTHETIC_DEMO_SECRET,
      secretEncoding: "utf8",
      expectedAlgorithm: "auto",
    });
  };

  // Compute the 3 independent status dimension cells
  const structureBadge = (() => {
    if (decoded.kind === "empty") {
      return { tone: "", text: t.jwtTool.structEmpty };
    }
    if (decoded.kind === "error") {
      return { tone: "is-err", text: `${t.jwtTool.structInvalid}: ${decoded.error.detail}` };
    }
    if (decoded.kind === "jwe_encrypted") {
      return { tone: "is-warn", text: t.jwtTool.structJweEncrypted };
    }
    return { tone: "is-ok", text: t.jwtTool.structValidJws(decoded.headerAlg) };
  })();

  const signatureBadge = (() => {
    if (decoded.kind !== "jws") {
      return { tone: "", text: "—" };
    }
    if (verifyState.error) {
      return { tone: "is-err", text: verifyState.error };
    }
    if (verifyState.loading || !verifyState.response) {
      return { tone: "", text: t.jwtTool.sigVerifying };
    }
    const res = verifyState.response;
    switch (res.outcome) {
      case "valid":
        return {
          tone: "is-ok",
          text: t.jwtTool.sigValid(res.resolvedAlgorithm ?? decoded.headerAlg, res.keyByteLength),
        };
      case "invalid_signature":
        return { tone: "is-err", text: t.jwtTool.sigInvalid };
      case "algorithm_mismatch":
        return {
          tone: "is-err",
          text: t.jwtTool.sigAlgMismatch(
            res.headerAlg ?? decoded.headerAlg,
            res.resolvedAlgorithm ?? String(expectedAlgorithm),
          ),
        };
      case "unsigned_alg_none":
        return { tone: "is-warn", text: t.jwtTool.sigUnsignedNone };
      case "unsupported_algorithm":
        return {
          tone: "is-warn",
          text: t.jwtTool.sigUnsupportedAlg(res.headerAlg ?? decoded.headerAlg),
        };
      case "unsupported_crit_header":
        return {
          tone: "is-err",
          text: t.jwtTool.sigUnsupportedCrit(decoded.critHeaderDisplay ?? "crit"),
        };
      case "invalid_secret_base64":
        return { tone: "is-err", text: t.jwtTool.sigInvalidBase64Key };
      case "empty_secret":
        return { tone: "", text: t.jwtTool.sigUnverified };
    }
  })();

  const timeBadge = (() => {
    if (!timeEval) {
      return { tone: "", text: "—" };
    }
    switch (timeEval.windowStatus) {
      case "active":
        return { tone: "is-ok", text: t.jwtTool.timeActive };
      case "expired":
        return { tone: "is-err", text: t.jwtTool.timeExpired };
      case "not_yet_valid":
        return { tone: "is-warn", text: t.jwtTool.timeNotYetValid };
      case "no_window":
        return { tone: "", text: t.jwtTool.timeNoWindow };
      case "invalid_claim":
        return { tone: "is-err", text: t.jwtTool.timeInvalidClaim };
    }
  })();

  const renderTimeClaimCell = (claim: JwtTimeClaimFieldState) => {
    if (claim.status === "missing") {
      return <span style={{ color: "var(--text-muted)" }}>{t.jwtTool.claimMissing}</span>;
    }
    if (claim.status === "invalid_type") {
      return (
        <span style={{ color: "var(--status-err)", fontWeight: 500 }}>
          {t.jwtTool.claimInvalidType(claim.rawDisplay)}
        </span>
      );
    }
    if (claim.status === "out_of_range") {
      return (
        <span style={{ color: "var(--status-err)", fontWeight: 500 }}>
          {t.jwtTool.claimOutOfRange(claim.rawLiteral)}
        </span>
      );
    }
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <code className="mono-inline">{claim.rawLiteral}</code>
          <span className="badge">{formatRelativeDurationSeconds(claim.deltaSeconds, locale)}</span>
          {claim.isZeroEpoch && (
            <span className="badge badge-partial">{t.jwtTool.claimZeroEpochBadge}</span>
          )}
        </div>
        <div className="mono-inline" style={{ color: "var(--text-secondary)" }}>
          UTC: {claim.utcIso} · Local: {claim.localFormatted}
        </div>
      </div>
    );
  };

  const canVerifyHmac =
    decoded.kind === "jws" &&
    !decoded.hasCritHeader &&
    decoded.headerAlg.toLowerCase() !== "none" &&
    isSupportedJwtHmacAlg(decoded.headerAlg);

  return (
    <div className="tool-workspace">
      <div className="status-banner">
        <span>{t.jwtTool.scopeNote}</span>
        <div className="tool-toolbar-group">
          <button type="button" className="btn" onClick={handleLoadSample}>
            {t.jwtTool.sampleHs256Btn}
          </button>
          <button
            type="button"
            className="btn"
            onClick={handleClear}
            disabled={!tokenInput && !secretInput}
          >
            <RotateCcw size={14} aria-hidden="true" />
            {t.jwtTool.clearBtn}
          </button>
        </div>
      </div>

      {copyError && (
        <div className="status-banner is-err" role="alert">
          <span>{copyError}</span>
        </div>
      )}

      {/* Token Input */}
      <div className="pane" style={{ flexShrink: 0 }}>
        <div className="pane-header">
          <label htmlFor={tokenFieldId} className="pane-title">
            {t.jwtTool.tokenInputLabel}
          </label>
          {(decoded.kind === "jws" || decoded.kind === "jwe_encrypted") &&
            (decoded.envelope.strippedBearer || decoded.envelope.strippedQuotes) && (
              <span className="badge">
                {t.jwtTool.envelopeStrippedNote(
                  decoded.envelope.strippedBearer,
                  decoded.envelope.strippedQuotes,
                )}
              </span>
            )}
        </div>
        <textarea
          id={tokenFieldId}
          className="code-editor"
          style={{ minHeight: 92, maxHeight: 132 }}
          value={tokenInput}
          onChange={(e) => updateJwtSession({ tokenInput: e.target.value })}
          placeholder={t.jwtTool.tokenPlaceholder}
          spellCheck={false}
          autoComplete="off"
        />
      </div>

      {/* Three Independent Inspection Dimensions */}
      <section aria-label={t.jwtTool.statusSectionLabel} className="status-strip-3col">
        <div className={`status-cell ${structureBadge.tone}`} data-testid="jwt-status-structure">
          <span className="status-cell-label">{t.jwtTool.dimStructureLabel}</span>
          <span className="status-cell-value">{structureBadge.text}</span>
        </div>
        <div className={`status-cell ${signatureBadge.tone}`} data-testid="jwt-status-signature">
          <span className="status-cell-label">{t.jwtTool.dimSignatureLabel}</span>
          <span className="status-cell-value">{signatureBadge.text}</span>
        </div>
        <div className={`status-cell ${timeBadge.tone}`} data-testid="jwt-status-time">
          <span className="status-cell-label">{t.jwtTool.dimTimeLabel}</span>
          <span className="status-cell-value">{timeBadge.text}</span>
        </div>
      </section>

      {/* Non-authorization & security notices */}
      {decoded.kind === "jws" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {verifyState.response?.outcome === "valid" && (
            <div className="status-banner">{t.jwtTool.nonAuthDisclaimer}</div>
          )}
          {decoded.hasRemoteKeyHintHeaders && (
            <div className="status-banner is-warn" role="status">
              {t.jwtTool.remoteKeyHintWarning}
            </div>
          )}
          {decoded.malformedUnsecuredSignature && (
            <div className="status-banner is-warn" role="alert">
              {t.jwtTool.unsecuredNonEmptySigWarning}
            </div>
          )}
          {decoded.hasPrecisionSensitiveNumbers && (
            <div className="status-banner is-warn" role="status">
              {t.jwtTool.precisionNote}
            </div>
          )}
        </div>
      )}

      {/* 5-part Encrypted JWE View */}
      {decoded.kind === "jwe_encrypted" && (
        <div className="pane">
          <div className="pane-header">
            <span className="pane-title">{t.jwtTool.headerSectionTitle}</span>
            {decoded.protectedHeaderFormatted && (
              <button
                type="button"
                className="btn"
                onClick={() => void handleCopy("jwe-hdr", decoded.protectedHeaderFormatted!)}
              >
                <Copy size={14} aria-hidden="true" />
                {copiedKey === "jwe-hdr" ? t.jwtTool.copiedBadge : t.jwtTool.copyHeaderJsonBtn}
              </button>
            )}
          </div>
          <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="status-banner is-warn">{t.jwtTool.jweUnsupportedBody}</div>
            {decoded.headerDecodeError ? (
              <div className="status-banner is-err" role="alert">
                {decoded.headerDecodeError}
              </div>
            ) : (
              <pre className="mono-block">{decoded.protectedHeaderFormatted}</pre>
            )}
          </div>
        </div>
      )}

      {/* 3-part JWS Detailed Inspector & Verifier */}
      {decoded.kind === "jws" && (
        <>
          {/* HMAC Verifier Controls */}
          <div className="pane" style={{ flexShrink: 0 }}>
            <div className="pane-header">
              <span className="pane-title">{t.jwtTool.verifierSectionTitle}</span>
            </div>
            <div
              style={{
                padding: 12,
                display: "grid",
                gridTemplateColumns: "minmax(200px, 240px) auto minmax(220px, 1fr)",
                gap: 12,
                alignItems: "end",
              }}
            >
              <div className="field-stack">
                <label htmlFor={expectedAlgId} className="field-label">
                  {t.jwtTool.expectedAlgLabel}
                </label>
                <select
                  id={expectedAlgId}
                  className="select-input"
                  value={expectedAlgorithm}
                  onChange={(e) =>
                    updateJwtSession({
                      expectedAlgorithm: e.target.value as JwtExpectedAlgChoice,
                    })
                  }
                >
                  <option value="auto">{t.jwtTool.expectedAlgAuto}</option>
                  {SUPPORTED_JWT_HMAC_ALGORITHMS.map((alg) => (
                    <option key={alg} value={alg}>
                      {alg}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field-stack">
                <span className="field-label">{t.jwtTool.secretModeLabel}</span>
                <div className="segmented" role="group" aria-label={t.jwtTool.secretModeLabel}>
                  {(["utf8", "base64"] as const).map((mode: JwtSecretEncoding) => (
                    <button
                      key={mode}
                      type="button"
                      className="segmented-btn"
                      aria-pressed={secretEncoding === mode}
                      onClick={() => updateJwtSession({ secretEncoding: mode })}
                    >
                      {mode === "utf8" ? t.jwtTool.secretModeUtf8 : t.jwtTool.secretModeBase64}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field-stack">
                <label htmlFor={secretFieldId} className="field-label">
                  {t.jwtTool.secretInputLabel}
                </label>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    id={secretFieldId}
                    type={secretVisible ? "text" : "password"}
                    className="text-input mono-inline"
                    style={{ flex: 1, minWidth: 0 }}
                    value={secretInput}
                    disabled={!canVerifyHmac}
                    onChange={(e) => updateJwtSession({ secretInput: e.target.value })}
                    placeholder={
                      secretEncoding === "utf8"
                        ? t.jwtTool.secretPlaceholderUtf8
                        : t.jwtTool.secretPlaceholderBase64
                    }
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="btn btn-icon"
                    onClick={() => setSecretVisible((prev) => !prev)}
                    disabled={!canVerifyHmac}
                    aria-label={secretVisible ? t.jwtTool.hideSecretBtn : t.jwtTool.showSecretBtn}
                    title={secretVisible ? t.jwtTool.hideSecretBtn : t.jwtTool.showSecretBtn}
                  >
                    {secretVisible ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Decoded Header & Payload JSON Side-by-Side */}
          <div className="split-panes" style={{ minHeight: 220 }}>
            <div className="pane">
              <div className="pane-header">
                <span className="pane-title">{t.jwtTool.headerSectionTitle}</span>
                <div className="tool-toolbar-group">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void handleCopy("raw-hdr", decoded.rawHeaderSegment)}
                  >
                    {copiedKey === "raw-hdr" ? t.jwtTool.copiedBadge : t.jwtTool.copyRawHeaderBtn}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void handleCopy("hdr-json", decoded.headerFormatted)}
                  >
                    <Copy size={14} aria-hidden="true" />
                    {copiedKey === "hdr-json" ? t.jwtTool.copiedBadge : t.jwtTool.copyHeaderJsonBtn}
                  </button>
                </div>
              </div>
              <pre className="mono-block" data-testid="jwt-header-json">
                {decoded.headerFormatted}
              </pre>
            </div>

            <div className="pane">
              <div className="pane-header">
                <span className="pane-title">{t.jwtTool.payloadSectionTitle}</span>
                <div className="tool-toolbar-group">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void handleCopy("raw-pay", decoded.rawPayloadSegment)}
                  >
                    {copiedKey === "raw-pay" ? t.jwtTool.copiedBadge : t.jwtTool.copyRawPayloadBtn}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void handleCopy("pay-json", decoded.payloadFormatted)}
                  >
                    <Copy size={14} aria-hidden="true" />
                    {copiedKey === "pay-json"
                      ? t.jwtTool.copiedBadge
                      : t.jwtTool.copyPayloadJsonBtn}
                  </button>
                </div>
              </div>
              <pre className="mono-block" data-testid="jwt-payload-json">
                {decoded.payloadFormatted}
              </pre>
            </div>
          </div>

          {/* Registered Claims & NumericDate Evaluation Table */}
          {timeEval && (
            <div className="pane" style={{ flexShrink: 0 }}>
              <div className="pane-header">
                <span className="pane-title">{t.jwtTool.registeredClaimsTitle}</span>
                <span className="mono-inline" style={{ color: "var(--text-muted)" }}>
                  {t.jwtTool.evaluatedAtLabel}: {timeEval.evaluatedAtUtc} ·{" "}
                  {timeEval.evaluatedAtLocal}
                </span>
              </div>
              <table className="kv-table">
                <tbody>
                  <tr>
                    <th scope="row">{t.jwtTool.claimNames.exp}</th>
                    <td>{renderTimeClaimCell(timeEval.exp)}</td>
                  </tr>
                  <tr>
                    <th scope="row">{t.jwtTool.claimNames.nbf}</th>
                    <td>{renderTimeClaimCell(timeEval.nbf)}</td>
                  </tr>
                  <tr>
                    <th scope="row">{t.jwtTool.claimNames.iat}</th>
                    <td>{renderTimeClaimCell(timeEval.iat)}</td>
                  </tr>
                  {decoded.stringClaims.map((claim) => (
                    <tr key={claim.name}>
                      <th scope="row">{t.jwtTool.claimNames[claim.name]}</th>
                      <td>
                        {!claim.present ? (
                          <span style={{ color: "var(--text-muted)" }}>
                            {t.jwtTool.claimMissing}
                          </span>
                        ) : (
                          <span className="mono-inline">{claim.displayValue}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Raw Signature Segment */}
          <div className="pane" style={{ flexShrink: 0 }}>
            <div className="pane-header">
              <span className="pane-title">{t.jwtTool.rawSegmentsSectionTitle}</span>
              <button
                type="button"
                className="btn"
                disabled={!decoded.rawSignatureSegment}
                onClick={() => void handleCopy("raw-sig", decoded.rawSignatureSegment)}
              >
                <Copy size={14} aria-hidden="true" />
                {copiedKey === "raw-sig" ? t.jwtTool.copiedBadge : t.jwtTool.copyRawSigBtn}
              </button>
            </div>
            <pre className="mono-block">{decoded.rawSignatureSegment || "(empty)"}</pre>
          </div>
        </>
      )}
    </div>
  );
}
