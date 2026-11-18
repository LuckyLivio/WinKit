import { parseLosslessJsonAst, type JsonAstNode } from "../json-formatter/jsonEngine";

export const MAX_JWT_INPUT_BYTES = 256 * 1024;
export const SUPPORTED_JWT_HMAC_ALGORITHMS = ["HS256", "HS384", "HS512"] as const;
export type JwtHmacAlgorithm = (typeof SUPPORTED_JWT_HMAC_ALGORITHMS)[number];
export type JwtExpectedAlgChoice = "auto" | JwtHmacAlgorithm;
export type JwtSecretEncoding = "utf8" | "base64";

export type JwtSignatureVerifyOutcome =
  | "valid"
  | "invalid_signature"
  | "algorithm_mismatch"
  | "unsigned_alg_none"
  | "unsupported_algorithm"
  | "unsupported_crit_header"
  | "invalid_secret_base64"
  | "empty_secret";

export interface JwtHmacVerifyRequest {
  rawToken: string;
  expectedAlgorithm: JwtHmacAlgorithm | null;
  secret: string;
  secretEncoding: JwtSecretEncoding;
}

export interface JwtHmacVerifyResponse {
  outcome: JwtSignatureVerifyOutcome;
  headerAlg: string | null;
  resolvedAlgorithm: JwtHmacAlgorithm | null;
  keyByteLength: number;
  detail: string;
}

export interface JwtNormalizedEnvelope {
  normalizedToken: string;
  strippedBearer: boolean;
  strippedQuotes: boolean;
}

export type JwtDecodeErrorCode =
  | "SIZE_LIMIT_EXCEEDED"
  | "WRONG_SEGMENT_COUNT"
  | "EMPTY_SEGMENT"
  | "MALFORMED_BASE64URL"
  | "INVALID_UTF8"
  | "INVALID_JSON"
  | "NON_OBJECT_JSON"
  | "MISSING_ALG";

export interface JwtDecodeError {
  code: JwtDecodeErrorCode;
  segment?: "header" | "payload" | "signature";
  segmentCount?: number;
  detail: string;
}

export interface JwtRegisteredStringClaim {
  name: "iss" | "sub" | "aud" | "jti";
  present: boolean;
  displayValue: string;
  isMalformedType: boolean;
}

export type JwtTimeClaimFieldState =
  | { status: "missing" }
  | { status: "invalid_type"; rawDisplay: string }
  | { status: "out_of_range"; rawLiteral: string }
  | {
      status: "valid";
      rawLiteral: string;
      epochMillis: number;
      isZeroEpoch: boolean;
      utcIso: string;
      localFormatted: string;
      deltaSeconds: number;
    };

export type JwtTimeWindowStatus =
  "active" | "expired" | "not_yet_valid" | "no_window" | "invalid_claim";

export interface JwtTimeEvaluation {
  evaluatedAtMillis: number;
  evaluatedAtUtc: string;
  evaluatedAtLocal: string;
  windowStatus: JwtTimeWindowStatus;
  exp: JwtTimeClaimFieldState;
  nbf: JwtTimeClaimFieldState;
  iat: JwtTimeClaimFieldState;
}

export interface DecodedJwsToken {
  kind: "jws";
  envelope: JwtNormalizedEnvelope;
  rawHeaderSegment: string;
  rawPayloadSegment: string;
  rawSignatureSegment: string;
  signatureByteLength: number;
  headerFormatted: string;
  payloadFormatted: string;
  hasPrecisionSensitiveNumbers: boolean;
  headerAlg: string;
  headerTyp: string | null;
  headerKid: string | null;
  hasCritHeader: boolean;
  critHeaderDisplay: string | null;
  hasRemoteKeyHintHeaders: boolean;
  malformedUnsecuredSignature: boolean;
  missingSignedSignature: boolean;
  stringClaims: JwtRegisteredStringClaim[];
  payloadAst: JsonAstNode;
}

export interface DecodedJweToken {
  kind: "jwe_encrypted";
  envelope: JwtNormalizedEnvelope;
  rawSegments: [string, string, string, string, string];
  protectedHeaderFormatted: string | null;
  headerAlg: string | null;
  headerEnc: string | null;
  headerDecodeError: string | null;
}

export type JwtDecodeResult =
  { kind: "empty" } | { kind: "error"; error: JwtDecodeError } | DecodedJweToken | DecodedJwsToken;

const MAX_DATE_EPOCH_MILLIS = 8_640_000_000_000_000n;
const MIN_DATE_EPOCH_MILLIS = -8_640_000_000_000_000n;

export function isSupportedJwtHmacAlg(alg: string): alg is JwtHmacAlgorithm {
  return alg === "HS256" || alg === "HS384" || alg === "HS512";
}

export function normalizeJwtEnvelope(raw: string): JwtNormalizedEnvelope {
  let s = raw.trim();
  let strippedQuotes = false;
  let strippedBearer = false;

  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    s = s.slice(1, -1).trim();
    strippedQuotes = true;
  }

  if (s.length > 7 && s.slice(0, 6).toLowerCase() === "bearer") {
    const after = s.slice(6);
    if (/^[\t\r\n ]/.test(after)) {
      s = after.replace(/^[\t\r\n ]+/, "");
      strippedBearer = true;
    }
  }

  return {
    normalizedToken: s,
    strippedBearer,
    strippedQuotes,
  };
}

function base64UrlCharValue(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41; // A-Z
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26; // a-z
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52; // 0-9
  if (code === 0x2d) return 62; // -
  if (code === 0x5f) return 63; // _
  return -1;
}

/**
 * Strict RFC 7515 Section 2 Base64url (unpadded) decoder.
 * Rejects `+`, `/`, `=`, whitespace, invalid remainder length 1, and non-zero trailing pad bits.
 */
export function decodeStrictBase64UrlSegment(segment: string): Uint8Array | null {
  const len = segment.length;
  if (len === 0) {
    return new Uint8Array(0);
  }
  if (len % 4 === 1) {
    return null;
  }

  const fullGroups = Math.floor(len / 4);
  const rem = len % 4;
  const outLen = fullGroups * 3 + (rem === 2 ? 1 : rem === 3 ? 2 : 0);
  const out = new Uint8Array(outLen);
  let outIdx = 0;

  for (let g = 0; g < fullGroups; g++) {
    const i = g * 4;
    const v0 = base64UrlCharValue(segment.charCodeAt(i));
    const v1 = base64UrlCharValue(segment.charCodeAt(i + 1));
    const v2 = base64UrlCharValue(segment.charCodeAt(i + 2));
    const v3 = base64UrlCharValue(segment.charCodeAt(i + 3));
    if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) {
      return null;
    }
    const triple = (v0 << 18) | (v1 << 12) | (v2 << 6) | v3;
    out[outIdx++] = (triple >> 16) & 0xff;
    out[outIdx++] = (triple >> 8) & 0xff;
    out[outIdx++] = triple & 0xff;
  }

  if (rem === 2) {
    const i = fullGroups * 4;
    const v0 = base64UrlCharValue(segment.charCodeAt(i));
    const v1 = base64UrlCharValue(segment.charCodeAt(i + 1));
    if (v0 < 0 || v1 < 0 || (v1 & 0x0f) !== 0) {
      return null;
    }
    out[outIdx] = ((v0 << 2) | (v1 >> 4)) & 0xff;
  } else if (rem === 3) {
    const i = fullGroups * 4;
    const v0 = base64UrlCharValue(segment.charCodeAt(i));
    const v1 = base64UrlCharValue(segment.charCodeAt(i + 1));
    const v2 = base64UrlCharValue(segment.charCodeAt(i + 2));
    if (v0 < 0 || v1 < 0 || v2 < 0 || (v2 & 0x03) !== 0) {
      return null;
    }
    const pair = (v0 << 10) | (v1 << 4) | (v2 >> 2);
    out[outIdx] = (pair >> 8) & 0xff;
    out[outIdx + 1] = pair & 0xff;
  }

  return out;
}

/**
 * Strict Base64 / Base64url decoder for HMAC secret keys (accepts standard or URL-safe alphabet,
 * with or without `=` padding, rejecting mixed alphabets or invalid characters).
 */
export function decodeStrictSecretBase64(rawSecret: string): Uint8Array | null {
  const compact = rawSecret.replace(/[\t\r\n ]+/g, "");
  if (compact.length === 0) {
    return null;
  }
  const hasStd = compact.includes("+") || compact.includes("/");
  const hasUrl = compact.includes("-") || compact.includes("_");
  if (hasStd && hasUrl) {
    return null;
  }

  // Validate optional '=' padding at end only
  const eqIdx = compact.indexOf("=");
  let body = compact;
  if (eqIdx !== -1) {
    if (compact.length % 4 !== 0) {
      return null;
    }
    const padPart = compact.slice(eqIdx);
    if (padPart !== "=" && padPart !== "==") {
      return null;
    }
    body = compact.slice(0, eqIdx);
  }

  const normalizedUrl = body.replace(/\+/g, "-").replace(/\//g, "_");
  const decoded = decodeStrictBase64UrlSegment(normalizedUrl);
  if (!decoded || decoded.byteLength === 0) {
    return null;
  }
  return decoded;
}

function findObjectEntry(node: JsonAstNode, key: string): JsonAstNode | undefined {
  if (node.kind !== "object") return undefined;
  for (let i = node.entries.length - 1; i >= 0; i--) {
    const entry = node.entries[i];
    if (entry && entry.keyDecoded === key) {
      return entry.value;
    }
  }
  return undefined;
}

function astNodeToPlainSummary(node: JsonAstNode): string {
  switch (node.kind) {
    case "string":
      return node.decoded;
    case "number":
      return node.rawLiteral;
    case "boolean":
      return node.value ? "true" : "false";
    case "null":
      return "null";
    case "array":
      return `[${node.items.map(astNodeToPlainSummary).join(", ")}]`;
    case "object":
      return `{${node.entries.length} keys}`;
  }
}

function extractRegisteredStringClaims(payloadAst: JsonAstNode): JwtRegisteredStringClaim[] {
  const names: Array<"iss" | "sub" | "aud" | "jti"> = ["iss", "sub", "aud", "jti"];
  return names.map((name) => {
    const val = findObjectEntry(payloadAst, name);
    if (!val) {
      return { name, present: false, displayValue: "", isMalformedType: false };
    }
    if (val.kind === "string") {
      return { name, present: true, displayValue: val.decoded, isMalformedType: false };
    }
    if (name === "aud" && val.kind === "array" && val.items.every((i) => i.kind === "string")) {
      return {
        name,
        present: true,
        displayValue: val.items.map((i) => (i.kind === "string" ? i.decoded : "")).join(", "),
        isMalformedType: false,
      };
    }
    return {
      name,
      present: true,
      displayValue: astNodeToPlainSummary(val),
      isMalformedType: true,
    };
  });
}

export function decodeJwtToken(rawInput: string): JwtDecodeResult {
  if (rawInput.trim().length === 0) {
    return { kind: "empty" };
  }

  const byteLen = new TextEncoder().encode(rawInput).byteLength;
  if (byteLen > MAX_JWT_INPUT_BYTES) {
    return {
      kind: "error",
      error: {
        code: "SIZE_LIMIT_EXCEEDED",
        detail: `Input exceeds 256 KB limit (${byteLen} bytes).`,
      },
    };
  }

  const envelope = normalizeJwtEnvelope(rawInput);
  if (envelope.normalizedToken.length === 0) {
    return { kind: "empty" };
  }

  const segments = envelope.normalizedToken.split(".");
  if (segments.length === 5) {
    const [s0 = "", s1 = "", s2 = "", s3 = "", s4 = ""] = segments;
    let protectedHeaderFormatted: string | null = null;
    let headerAlg: string | null = null;
    let headerEnc: string | null = null;
    let headerDecodeError: string | null = null;

    if (s0.length === 0) {
      headerDecodeError = "Protected header segment is empty.";
    } else {
      const hdrBytes = decodeStrictBase64UrlSegment(s0);
      if (!hdrBytes) {
        headerDecodeError = "Protected header is not valid RFC 7515 Base64url.";
      } else {
        try {
          const utf8 = new TextDecoder("utf-8", { fatal: true }).decode(hdrBytes);
          const parsed = parseLosslessJsonAst(utf8);
          if (parsed.status === "valid" && parsed.ast.kind === "object") {
            protectedHeaderFormatted = parsed.formatted;
            const algNode = findObjectEntry(parsed.ast, "alg");
            if (algNode?.kind === "string") headerAlg = algNode.decoded;
            const encNode = findObjectEntry(parsed.ast, "enc");
            if (encNode?.kind === "string") headerEnc = encNode.decoded;
          } else {
            headerDecodeError = "Protected header is not a valid JSON object.";
          }
        } catch {
          headerDecodeError = "Protected header is not valid UTF-8.";
        }
      }
    }

    return {
      kind: "jwe_encrypted",
      envelope,
      rawSegments: [s0, s1, s2, s3, s4],
      protectedHeaderFormatted,
      headerAlg,
      headerEnc,
      headerDecodeError,
    };
  }

  if (segments.length !== 3) {
    return {
      kind: "error",
      error: {
        code: "WRONG_SEGMENT_COUNT",
        segmentCount: segments.length,
        detail: `Expected 3 segments (header.payload.signature) or 5 segments (JWE), found ${segments.length}.`,
      },
    };
  }

  const [rawHeaderSegment = "", rawPayloadSegment = "", rawSignatureSegment = ""] = segments;
  if (rawHeaderSegment.length === 0) {
    return {
      kind: "error",
      error: {
        code: "EMPTY_SEGMENT",
        segment: "header",
        detail: "Header segment is empty.",
      },
    };
  }
  if (rawPayloadSegment.length === 0) {
    return {
      kind: "error",
      error: {
        code: "EMPTY_SEGMENT",
        segment: "payload",
        detail: "Payload segment is empty.",
      },
    };
  }

  const headerBytes = decodeStrictBase64UrlSegment(rawHeaderSegment);
  if (!headerBytes) {
    return {
      kind: "error",
      error: {
        code: "MALFORMED_BASE64URL",
        segment: "header",
        detail: "Header segment contains invalid Base64url characters or padding.",
      },
    };
  }

  const payloadBytes = decodeStrictBase64UrlSegment(rawPayloadSegment);
  if (!payloadBytes) {
    return {
      kind: "error",
      error: {
        code: "MALFORMED_BASE64URL",
        segment: "payload",
        detail: "Payload segment contains invalid Base64url characters or padding.",
      },
    };
  }

  let headerUtf8: string;
  try {
    headerUtf8 = new TextDecoder("utf-8", { fatal: true }).decode(headerBytes);
  } catch {
    return {
      kind: "error",
      error: {
        code: "INVALID_UTF8",
        segment: "header",
        detail: "Decoded header bytes are not valid UTF-8.",
      },
    };
  }

  let payloadUtf8: string;
  try {
    payloadUtf8 = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
  } catch {
    return {
      kind: "error",
      error: {
        code: "INVALID_UTF8",
        segment: "payload",
        detail: "Decoded payload bytes are not valid UTF-8.",
      },
    };
  }

  const headerJson = parseLosslessJsonAst(headerUtf8);
  if (headerJson.status === "invalid") {
    return {
      kind: "error",
      error: {
        code: "INVALID_JSON",
        segment: "header",
        detail: `Header JSON error at line ${headerJson.error.line}, column ${headerJson.error.column}: ${headerJson.error.message}`,
      },
    };
  }
  if (headerJson.ast.kind !== "object") {
    return {
      kind: "error",
      error: {
        code: "NON_OBJECT_JSON",
        segment: "header",
        detail: "JWT header must be a JSON object.",
      },
    };
  }

  const payloadJson = parseLosslessJsonAst(payloadUtf8);
  if (payloadJson.status === "invalid") {
    return {
      kind: "error",
      error: {
        code: "INVALID_JSON",
        segment: "payload",
        detail: `Payload JSON error at line ${payloadJson.error.line}, column ${payloadJson.error.column}: ${payloadJson.error.message}`,
      },
    };
  }
  if (payloadJson.ast.kind !== "object") {
    return {
      kind: "error",
      error: {
        code: "NON_OBJECT_JSON",
        segment: "payload",
        detail: "JWT claims payload must be a JSON object.",
      },
    };
  }

  const algNode = findObjectEntry(headerJson.ast, "alg");
  if (!algNode || algNode.kind !== "string" || algNode.decoded.trim().length === 0) {
    return {
      kind: "error",
      error: {
        code: "MISSING_ALG",
        segment: "header",
        detail: "JWT header must contain a non-empty string 'alg' parameter.",
      },
    };
  }

  const headerAlg = algNode.decoded;
  const isAlgNone = headerAlg.toLowerCase() === "none";

  let signatureByteLength = 0;
  if (rawSignatureSegment.length > 0) {
    const sigBytes = decodeStrictBase64UrlSegment(rawSignatureSegment);
    if (!sigBytes) {
      return {
        kind: "error",
        error: {
          code: "MALFORMED_BASE64URL",
          segment: "signature",
          detail: "Signature segment contains invalid Base64url characters or padding.",
        },
      };
    }
    signatureByteLength = sigBytes.byteLength;
  }

  const typNode = findObjectEntry(headerJson.ast, "typ");
  const kidNode = findObjectEntry(headerJson.ast, "kid");
  const critNode = findObjectEntry(headerJson.ast, "crit");
  const hasRemoteKeyHintHeaders = Boolean(
    findObjectEntry(headerJson.ast, "jku") || findObjectEntry(headerJson.ast, "x5u"),
  );

  return {
    kind: "jws",
    envelope,
    rawHeaderSegment,
    rawPayloadSegment,
    rawSignatureSegment,
    signatureByteLength,
    headerFormatted: headerJson.formatted,
    payloadFormatted: payloadJson.formatted,
    hasPrecisionSensitiveNumbers:
      headerJson.hasPrecisionSensitiveNumbers || payloadJson.hasPrecisionSensitiveNumbers,
    headerAlg,
    headerTyp: typNode?.kind === "string" ? typNode.decoded : null,
    headerKid: kidNode?.kind === "string" ? kidNode.decoded : null,
    hasCritHeader: Boolean(critNode),
    critHeaderDisplay: critNode ? astNodeToPlainSummary(critNode) : null,
    hasRemoteKeyHintHeaders,
    malformedUnsecuredSignature: isAlgNone && rawSignatureSegment.length > 0,
    missingSignedSignature: !isAlgNone && rawSignatureSegment.length === 0,
    stringClaims: extractRegisteredStringClaims(payloadJson.ast),
    payloadAst: payloadJson.ast,
  };
}

function formatLocalDateTime(ms: number): string {
  const d = new Date(ms);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMin);
  const offH = pad2(Math.floor(absMin / 60));
  const offM = pad2(absMin % 60);
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} (UTC${sign}${offH}:${offM})`;
}

function parseNumericDateMillis(rawLiteral: string): bigint | null {
  // Accept standard JSON integer or decimal literal, convert seconds -> milliseconds accurately
  if (/^-?\d+$/.test(rawLiteral)) {
    const sec = BigInt(rawLiteral);
    const ms = sec * 1000n;
    if (ms > MAX_DATE_EPOCH_MILLIS || ms < MIN_DATE_EPOCH_MILLIS) {
      return null;
    }
    return ms;
  }

  const num = Number(rawLiteral);
  if (!Number.isFinite(num)) {
    return null;
  }
  const msFloat = Math.trunc(num * 1000);
  if (!Number.isSafeInteger(msFloat)) {
    return null;
  }
  const msBig = BigInt(msFloat);
  if (msBig > MAX_DATE_EPOCH_MILLIS || msBig < MIN_DATE_EPOCH_MILLIS) {
    return null;
  }
  return msBig;
}

function evaluateSingleTimeClaim(
  payloadAst: JsonAstNode,
  claimName: "exp" | "nbf" | "iat",
  nowMs: number,
): JwtTimeClaimFieldState {
  const node = findObjectEntry(payloadAst, claimName);
  if (!node) {
    return { status: "missing" };
  }
  if (node.kind !== "number") {
    return {
      status: "invalid_type",
      rawDisplay: astNodeToPlainSummary(node),
    };
  }

  const epochMsBig = parseNumericDateMillis(node.rawLiteral);
  if (epochMsBig === null) {
    return {
      status: "out_of_range",
      rawLiteral: node.rawLiteral,
    };
  }

  const epochMillis = Number(epochMsBig);
  const d = new Date(epochMillis);
  if (Number.isNaN(d.getTime())) {
    return {
      status: "out_of_range",
      rawLiteral: node.rawLiteral,
    };
  }

  const isZeroEpoch = epochMsBig === 0n;
  const utcIso = d.toISOString();
  const localFormatted = formatLocalDateTime(epochMillis);
  const deltaSeconds = Math.trunc((epochMillis - nowMs) / 1000);

  return {
    status: "valid",
    rawLiteral: node.rawLiteral,
    epochMillis,
    isZeroEpoch,
    utcIso,
    localFormatted,
    deltaSeconds,
  };
}

export function evaluateJwtTimeClaims(
  payloadAst: JsonAstNode,
  nowMs: number = Date.now(),
): JwtTimeEvaluation {
  const exp = evaluateSingleTimeClaim(payloadAst, "exp", nowMs);
  const nbf = evaluateSingleTimeClaim(payloadAst, "nbf", nowMs);
  const iat = evaluateSingleTimeClaim(payloadAst, "iat", nowMs);

  const hasInvalid =
    exp.status === "invalid_type" ||
    exp.status === "out_of_range" ||
    nbf.status === "invalid_type" ||
    nbf.status === "out_of_range" ||
    iat.status === "invalid_type" ||
    iat.status === "out_of_range";

  let windowStatus: JwtTimeWindowStatus;
  if (hasInvalid) {
    windowStatus = "invalid_claim";
  } else if (exp.status === "valid" && nowMs >= exp.epochMillis) {
    windowStatus = "expired";
  } else if (nbf.status === "valid" && nowMs < nbf.epochMillis) {
    windowStatus = "not_yet_valid";
  } else if (exp.status === "valid" || nbf.status === "valid") {
    windowStatus = "active";
  } else {
    windowStatus = "no_window";
  }

  return {
    evaluatedAtMillis: nowMs,
    evaluatedAtUtc: new Date(nowMs).toISOString(),
    evaluatedAtLocal: formatLocalDateTime(nowMs),
    windowStatus,
    exp,
    nbf,
    iat,
  };
}

export function formatRelativeDurationSeconds(
  deltaSeconds: number,
  locale: "zh-CN" | "en-US",
): string {
  const abs = Math.abs(deltaSeconds);
  const days = Math.floor(abs / 86400);
  const hours = Math.floor((abs % 86400) / 3600);
  const mins = Math.floor((abs % 3600) / 60);
  const secs = abs % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(locale === "zh-CN" ? `${days} 天` : `${days}d`);
  if (hours > 0) parts.push(locale === "zh-CN" ? `${hours} 小时` : `${hours}h`);
  if (mins > 0 && parts.length < 2) parts.push(locale === "zh-CN" ? `${mins} 分` : `${mins}m`);
  if (parts.length === 0) parts.push(locale === "zh-CN" ? `${secs} 秒` : `${secs}s`);

  const span = parts.join(locale === "zh-CN" ? " " : " ");
  if (deltaSeconds === 0) {
    return locale === "zh-CN" ? "刚刚（0 秒）" : "just now (0s)";
  }
  return deltaSeconds > 0
    ? locale === "zh-CN"
      ? `${span}后`
      : `in ${span}`
    : locale === "zh-CN"
      ? `${span}前`
      : `${span} ago`;
}

/**
 * WebCrypto fallback verifier for JSDOM unit tests — enforces the exact same RFC 7515 / RFC 8725
 * rules as the Rust `hmac` crate verifier (raw `<headerB64>.<payloadB64>` ASCII bytes, `crit`
 * rejection, `alg=none` unsigned classification, allowlist & expected algorithm check).
 */
export async function verifyJwtHmacClientFallback(
  req: JwtHmacVerifyRequest,
): Promise<JwtHmacVerifyResponse> {
  const decoded = decodeJwtToken(req.rawToken);
  if (decoded.kind !== "jws") {
    throw JSON.stringify({
      code: "DECODE_FAILED",
      message: "Token is not a valid 3-part JWS.",
    });
  }

  if (decoded.hasCritHeader) {
    return {
      outcome: "unsupported_crit_header",
      headerAlg: decoded.headerAlg,
      resolvedAlgorithm: null,
      keyByteLength: 0,
      detail: "JOSE 'crit' (critical extensions) header is present and not supported.",
    };
  }

  if (decoded.headerAlg.toLowerCase() === "none") {
    return {
      outcome: "unsigned_alg_none",
      headerAlg: decoded.headerAlg,
      resolvedAlgorithm: null,
      keyByteLength: 0,
      detail: "Token declares alg=none and carries no cryptographic signature.",
    };
  }

  if (!isSupportedJwtHmacAlg(decoded.headerAlg)) {
    return {
      outcome: "unsupported_algorithm",
      headerAlg: decoded.headerAlg,
      resolvedAlgorithm: null,
      keyByteLength: 0,
      detail: "Only local HMAC algorithms (HS256, HS384, HS512) are supported in this phase.",
    };
  }

  if (req.expectedAlgorithm && req.expectedAlgorithm !== decoded.headerAlg) {
    return {
      outcome: "algorithm_mismatch",
      headerAlg: decoded.headerAlg,
      resolvedAlgorithm: req.expectedAlgorithm,
      keyByteLength: 0,
      detail: `Header alg '${decoded.headerAlg}' does not match expected '${req.expectedAlgorithm}'.`,
    };
  }

  let keyBytes: Uint8Array;
  if (req.secretEncoding === "utf8") {
    if (req.secret.length === 0) {
      return {
        outcome: "empty_secret",
        headerAlg: decoded.headerAlg,
        resolvedAlgorithm: decoded.headerAlg,
        keyByteLength: 0,
        detail: "Enter an HMAC secret key to verify signature.",
      };
    }
    keyBytes = new TextEncoder().encode(req.secret);
  } else {
    if (req.secret.trim().length === 0) {
      return {
        outcome: "empty_secret",
        headerAlg: decoded.headerAlg,
        resolvedAlgorithm: decoded.headerAlg,
        keyByteLength: 0,
        detail: "Enter a Base64 / Base64url secret key to verify signature.",
      };
    }
    const parsedKey = decodeStrictSecretBase64(req.secret);
    if (!parsedKey) {
      return {
        outcome: "invalid_secret_base64",
        headerAlg: decoded.headerAlg,
        resolvedAlgorithm: decoded.headerAlg,
        keyByteLength: 0,
        detail: "Secret is not valid Base64 / Base64url data.",
      };
    }
    keyBytes = parsedKey;
  }

  if (decoded.rawSignatureSegment.length === 0) {
    return {
      outcome: "invalid_signature",
      headerAlg: decoded.headerAlg,
      resolvedAlgorithm: decoded.headerAlg,
      keyByteLength: keyBytes.byteLength,
      detail: "Signature segment is empty for a signed HMAC token.",
    };
  }

  const sigBytes = decodeStrictBase64UrlSegment(decoded.rawSignatureSegment);
  if (!sigBytes) {
    throw JSON.stringify({
      code: "DECODE_FAILED",
      message: "JWT signature segment is not valid RFC 7515 Base64url.",
    });
  }

  const subtleHash =
    decoded.headerAlg === "HS256"
      ? "SHA-256"
      : decoded.headerAlg === "HS384"
        ? "SHA-384"
        : "SHA-512";

  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    Uint8Array.from(keyBytes),
    { name: "HMAC", hash: subtleHash },
    false,
    ["verify"],
  );

  const signingInput = new TextEncoder().encode(
    `${decoded.rawHeaderSegment}.${decoded.rawPayloadSegment}`,
  );
  const ok = await globalThis.crypto.subtle.verify(
    "HMAC",
    cryptoKey,
    Uint8Array.from(sigBytes),
    signingInput,
  );

  return {
    outcome: ok ? "valid" : "invalid_signature",
    headerAlg: decoded.headerAlg,
    resolvedAlgorithm: decoded.headerAlg,
    keyByteLength: keyBytes.byteLength,
    detail: ok
      ? `${decoded.headerAlg} HMAC signature verified against raw signing input.`
      : "Computed HMAC does not match the token signature.",
  };
}
