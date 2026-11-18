import {
  CLEAN_LINKS_RULES_VERSION,
  findMatchingRedirectWrapper,
  matchTrackingParameter,
  PRESIGNED_SIGNATURE_PARAM_NAMES,
  type TrackingCategory,
} from "./linkRules";

export const MAX_CLEAN_LINKS_INPUT_BYTES = 1 * 1024 * 1024; // 1 MiB
export const MAX_CLEAN_LINKS_LINES = 5_000;
export const MAX_SINGLE_URL_CHARS = 16_384; // UTF-16 code units
export const MAX_REDIRECT_UNWRAP_DEPTH = 5;

export interface RemovedParamDetail {
  rawKey: string;
  decodedKey: string;
  scope: "universal" | "site";
  providerLabel: string;
  category: TrackingCategory;
}

export interface UnwrapStepDetail {
  depth: number;
  wrapperId: string;
  providerLabel: string;
  wrapperHost: string;
  targetParam: string;
}

export type UnwrapStopReason =
  | { kind: "missing_target_param"; providerLabel: string }
  | { kind: "ambiguous_target_param"; providerLabel: string }
  | { kind: "malformed_target_encoding"; providerLabel: string }
  | { kind: "non_http_or_invalid_target"; providerLabel: string }
  | { kind: "target_too_long"; providerLabel: string }
  | { kind: "cycle_detected"; providerLabel: string }
  | { kind: "max_depth_reached"; maxDepth: number };

export type InvalidLineReason =
  "not_http_url" | "contains_whitespace_or_control" | "url_too_long" | "malformed_url";

export type CleanLinkLineResult =
  | {
      status: "blank";
      lineNumber: number;
      rawLine: string;
    }
  | {
      status: "invalid";
      lineNumber: number;
      rawLine: string;
      reason: InvalidLineReason;
    }
  | {
      status: "ok";
      lineNumber: number;
      rawLine: string;
      originalUrl: string;
      cleanedUrl: string;
      changed: boolean;
      removedParams: RemovedParamDetail[];
      unwrapSteps: UnwrapStepDetail[];
      unwrapStoppedReason: UnwrapStopReason | null;
      presignedSkippedKey: string | null;
      preservedMalformedKeyCount: number;
    };

export type CleanLinksBatchResult =
  | {
      status: "empty";
      ruleVersion: string;
    }
  | {
      status: "limit_exceeded";
      ruleVersion: string;
      reason: "bytes" | "lines";
      actual: number;
      limit: number;
    }
  | {
      status: "ok";
      ruleVersion: string;
      lines: CleanLinkLineResult[];
      validCount: number;
      changedCount: number;
      invalidCount: number;
      presignedSkippedCount: number;
      totalRemovedParams: number;
      totalUnwrappedLinks: number;
      allValidCleanedText: string;
    };

interface LexicalUrlSlices {
  baseBeforeQuery: string;
  queryKind: "absent" | "empty_question_mark" | "present";
  rawQuery: string;
  rawFragment: string;
}

function splitRawUrlLexically(rawUrl: string): LexicalUrlSlices {
  const hashIdx = rawUrl.indexOf("#");
  const beforeHash = hashIdx === -1 ? rawUrl : rawUrl.slice(0, hashIdx);
  const rawFragment = hashIdx === -1 ? "" : rawUrl.slice(hashIdx);

  const qIdx = beforeHash.indexOf("?");
  if (qIdx === -1) {
    return {
      baseBeforeQuery: beforeHash,
      queryKind: "absent",
      rawQuery: "",
      rawFragment,
    };
  }

  const baseBeforeQuery = beforeHash.slice(0, qIdx);
  const rawQuery = beforeHash.slice(qIdx + 1);
  if (rawQuery.length === 0) {
    return {
      baseBeforeQuery,
      queryKind: "empty_question_mark",
      rawQuery: "",
      rawFragment,
    };
  }

  return {
    baseBeforeQuery,
    queryKind: "present",
    rawQuery,
    rawFragment,
  };
}

function hasValidPercentSequences(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0x25 /* '%' */) {
      if (i + 2 >= s.length) return false;
      const c1 = s.charCodeAt(i + 1);
      const c2 = s.charCodeAt(i + 2);
      const isHex1 =
        (c1 >= 0x30 && c1 <= 0x39) || (c1 >= 0x41 && c1 <= 0x46) || (c1 >= 0x61 && c1 <= 0x66);
      const isHex2 =
        (c2 >= 0x30 && c2 <= 0x39) || (c2 >= 0x41 && c2 <= 0x46) || (c2 >= 0x61 && c2 <= 0x66);
      if (!isHex1 || !isHex2) return false;
      i += 2;
    }
  }
  return true;
}

/**
 * Decodes a query parameter NAME for rule matching only (`+` -> space, `%XX` -> UTF-8).
 * Returns `null` if percent-encoding is malformed so the raw segment is conservatively kept.
 */
function decodeQueryKeyForMatching(rawKey: string): string | null {
  const plusAsSpace = rawKey.replace(/\+/g, " ");
  if (!hasValidPercentSequences(plusAsSpace)) {
    return null;
  }
  try {
    return decodeURIComponent(plusAsSpace);
  } catch {
    return null;
  }
}

/**
 * Validates that `candidate` is an explicit HTTP or HTTPS URL with no whitespace/control chars.
 */
function parseExplicitHttpUrl(
  candidate: string,
): { ok: true; url: URL } | { ok: false; reason: InvalidLineReason } {
  if (candidate.length > MAX_SINGLE_URL_CHARS) {
    return { ok: false, reason: "url_too_long" };
  }
  // Reject internal whitespace or C0/DEL control characters
  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate.charCodeAt(i);
    if (ch <= 0x20 || ch === 0x7f) {
      return { ok: false, reason: "contains_whitespace_or_control" };
    }
  }
  if (!/^https?:\/\//i.test(candidate)) {
    return { ok: false, reason: "not_http_url" };
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: "malformed_url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "not_http_url" };
  }
  if (!parsed.hostname) {
    return { ok: false, reason: "malformed_url" };
  }
  return { ok: true, url: parsed };
}

/**
 * Decodes a wrapper's target query parameter value by AT MOST ONE wrapper encoding layer.
 * - Never converts `+` into a space (inside a URL, `+` is a literal `+`).
 * - Never loops decoding repeatedly until something looks like a URL.
 * - If the raw value already starts with literal `http://` or `https://` (unencoded query target),
 *   returns it as-is without corrupting internal `%20`/`%2B`/`%252F` sequences.
 */
function decodeWrapperTargetOnce(rawValue: string): { ok: true; target: string } | { ok: false } {
  if (!rawValue) {
    return { ok: false };
  }
  if (/^https?:\/\//i.test(rawValue)) {
    return { ok: true, target: rawValue };
  }
  if (!hasValidPercentSequences(rawValue)) {
    return { ok: false };
  }
  try {
    const decodedOnce = decodeURIComponent(rawValue);
    return { ok: true, target: decodedOnce };
  } catch {
    return { ok: false };
  }
}

function tryUnwrapSingleLayer(
  currentRawUrl: string,
  parsedUrl: URL,
  depth: number,
):
  | { kind: "not_wrapper" }
  | { kind: "unwrapped"; targetRawUrl: string; targetParsed: URL; step: UnwrapStepDetail }
  | { kind: "stopped"; reason: UnwrapStopReason } {
  const wrapper = findMatchingRedirectWrapper(parsedUrl.hostname, parsedUrl.pathname);
  if (!wrapper) {
    return { kind: "not_wrapper" };
  }

  const slices = splitRawUrlLexically(currentRawUrl);
  if (slices.queryKind !== "present") {
    return {
      kind: "stopped",
      reason: { kind: "missing_target_param", providerLabel: wrapper.providerLabel },
    };
  }

  const segments = slices.rawQuery.split("&");
  const matchedTargets: Array<{ paramName: string; rawValue: string }> = [];

  for (const seg of segments) {
    if (!seg) continue;
    const eqIdx = seg.indexOf("=");
    if (eqIdx === -1) continue;
    const rawKey = seg.slice(0, eqIdx);
    const rawValue = seg.slice(eqIdx + 1);
    const decodedKey = decodeQueryKeyForMatching(rawKey);
    if (!decodedKey) continue;
    const keyLower = decodedKey.toLowerCase();
    const matchedParam = wrapper.targetParams.find((p) => p.toLowerCase() === keyLower);
    if (matchedParam && rawValue.length > 0) {
      matchedTargets.push({ paramName: matchedParam, rawValue });
    }
  }

  if (matchedTargets.length === 0) {
    return {
      kind: "stopped",
      reason: { kind: "missing_target_param", providerLabel: wrapper.providerLabel },
    };
  }

  // If multiple target params are present (e.g. both `url` and `q` or duplicate `u`) and differ, refuse ambiguity
  const decodedCandidates: Array<{ paramName: string; target: string }> = [];
  for (const item of matchedTargets) {
    const dec = decodeWrapperTargetOnce(item.rawValue);
    if (!dec.ok) {
      return {
        kind: "stopped",
        reason: { kind: "malformed_target_encoding", providerLabel: wrapper.providerLabel },
      };
    }
    decodedCandidates.push({ paramName: item.paramName, target: dec.target });
  }

  const firstCandidate = decodedCandidates[0]!;
  for (let i = 1; i < decodedCandidates.length; i++) {
    if (decodedCandidates[i]!.target !== firstCandidate.target) {
      return {
        kind: "stopped",
        reason: { kind: "ambiguous_target_param", providerLabel: wrapper.providerLabel },
      };
    }
  }

  if (firstCandidate.target.length > MAX_SINGLE_URL_CHARS) {
    return {
      kind: "stopped",
      reason: { kind: "target_too_long", providerLabel: wrapper.providerLabel },
    };
  }

  const validated = parseExplicitHttpUrl(firstCandidate.target);
  if (!validated.ok) {
    return {
      kind: "stopped",
      reason: { kind: "non_http_or_invalid_target", providerLabel: wrapper.providerLabel },
    };
  }

  return {
    kind: "unwrapped",
    targetRawUrl: firstCandidate.target,
    targetParsed: validated.url,
    step: {
      depth,
      wrapperId: wrapper.id,
      providerLabel: wrapper.providerLabel,
      wrapperHost: parsedUrl.hostname.toLowerCase(),
      targetParam: firstCandidate.paramName,
    },
  };
}

/**
 * Checks whether `rawUrl` contains a known presigned/cryptographic signature query parameter name.
 * Reused both BEFORE redirect unwrapping at each layer and before parameter stripping.
 */
export function findPresignedSignatureParamKey(rawUrl: string): string | null {
  const slices = splitRawUrlLexically(rawUrl);
  if (slices.queryKind !== "present") {
    return null;
  }
  const rawSegments = slices.rawQuery.split("&");
  for (const seg of rawSegments) {
    if (!seg) continue;
    const eqIdx = seg.indexOf("=");
    const rawKey = eqIdx === -1 ? seg : seg.slice(0, eqIdx);
    const decodedKey = decodeQueryKeyForMatching(rawKey);
    if (decodedKey && PRESIGNED_SIGNATURE_PARAM_NAMES.has(decodedKey.toLowerCase())) {
      return decodedKey;
    }
  }
  return null;
}

/**
 * Strips known tracking query parameters from a single validated HTTP/HTTPS URL while preserving
 * exact raw path, surviving query parameter bytes (`+`, `%20`, `%2B`, `%252F`, `~`, duplicate keys,
 * empty values, keyless flags), and exact `#fragment`.
 */
function stripTrackingParamsPreservingRawSegments(
  rawUrl: string,
  parsedUrl: URL,
): {
  cleanedUrl: string;
  removedParams: RemovedParamDetail[];
  presignedSkippedKey: string | null;
  preservedMalformedKeyCount: number;
} {
  const slices = splitRawUrlLexically(rawUrl);

  // Case 1 & 2: No query or originally empty bare `?` (`https://example.com/path?`)
  if (slices.queryKind === "absent" || slices.queryKind === "empty_question_mark") {
    return {
      cleanedUrl: rawUrl,
      removedParams: [],
      presignedSkippedKey: null,
      preservedMalformedKeyCount: 0,
    };
  }

  // Conservative presigned check across all parameters first
  const presignedKey = findPresignedSignatureParamKey(rawUrl);
  if (presignedKey !== null) {
    return {
      cleanedUrl: rawUrl,
      removedParams: [],
      presignedSkippedKey: presignedKey,
      preservedMalformedKeyCount: 0,
    };
  }

  const rawSegments = slices.rawQuery.split("&");

  const keptSegments: string[] = [];
  const removedParams: RemovedParamDetail[] = [];
  let preservedMalformedKeyCount = 0;

  for (const seg of rawSegments) {
    if (seg === "") {
      keptSegments.push("");
      continue;
    }

    const eqIdx = seg.indexOf("=");
    const rawKey = eqIdx === -1 ? seg : seg.slice(0, eqIdx);
    const decodedKey = decodeQueryKeyForMatching(rawKey);
    if (decodedKey === null) {
      preservedMalformedKeyCount += 1;
      keptSegments.push(seg);
      continue;
    }

    const matched = matchTrackingParameter(decodedKey, parsedUrl.hostname, parsedUrl.pathname);
    if (matched) {
      removedParams.push({
        rawKey,
        decodedKey,
        scope: matched.scope,
        providerLabel: matched.providerLabel,
        category: matched.category,
      });
    } else {
      keptSegments.push(seg);
    }
  }

  // Zero removals -> return exact original rawUrl untouched (preserves `a=1&&b=2`, trailing `&`, etc.)
  if (removedParams.length === 0) {
    return {
      cleanedUrl: rawUrl,
      removedParams: [],
      presignedSkippedKey: null,
      preservedMalformedKeyCount,
    };
  }

  // Trim leading/trailing empty segments created adjacent to removed parameters,
  // while preserving interior empty segments between surviving parameters (e.g. `a=1&&b=2`).
  let start = 0;
  let end = keptSegments.length;
  while (start < end && keptSegments[start] === "") {
    start += 1;
  }
  while (end > start && keptSegments[end - 1] === "") {
    end -= 1;
  }

  const finalSegments = keptSegments.slice(start, end);
  if (finalSegments.length === 0) {
    // Query became empty after removing tracking parameters -> omit `?`
    return {
      cleanedUrl: `${slices.baseBeforeQuery}${slices.rawFragment}`,
      removedParams,
      presignedSkippedKey: null,
      preservedMalformedKeyCount,
    };
  }

  return {
    cleanedUrl: `${slices.baseBeforeQuery}?${finalSegments.join("&")}${slices.rawFragment}`,
    removedParams,
    presignedSkippedKey: null,
    preservedMalformedKeyCount,
  };
}

export function cleanSingleLine(rawLine: string, lineNumber: number): CleanLinkLineResult {
  const trimmed = rawLine.trim();
  if (trimmed.length === 0) {
    return {
      status: "blank",
      lineNumber,
      rawLine,
    };
  }

  const initialParsed = parseExplicitHttpUrl(trimmed);
  if (!initialParsed.ok) {
    return {
      status: "invalid",
      lineNumber,
      rawLine,
      reason: initialParsed.reason,
    };
  }

  let currentRaw = trimmed;
  let currentParsed = initialParsed.url;
  const unwrapSteps: UnwrapStepDetail[] = [];
  let unwrapStoppedReason: UnwrapStopReason | null = null;
  const visited = new Set<string>([currentRaw]);

  for (let depth = 1; depth <= MAX_REDIRECT_UNWRAP_DEPTH + 1; depth++) {
    // Check presigned signature protection BEFORE attempting to unwrap the current URL layer
    if (findPresignedSignatureParamKey(currentRaw) !== null) {
      break;
    }

    const checkWrapper = findMatchingRedirectWrapper(
      currentParsed.hostname,
      currentParsed.pathname,
    );
    if (!checkWrapper) {
      break;
    }

    if (depth > MAX_REDIRECT_UNWRAP_DEPTH) {
      unwrapStoppedReason = {
        kind: "max_depth_reached",
        maxDepth: MAX_REDIRECT_UNWRAP_DEPTH,
      };
      break;
    }

    const attempt = tryUnwrapSingleLayer(currentRaw, currentParsed, depth);
    if (attempt.kind === "not_wrapper") {
      break;
    }
    if (attempt.kind === "stopped") {
      unwrapStoppedReason = attempt.reason;
      break;
    }

    if (visited.has(attempt.targetRawUrl)) {
      unwrapStoppedReason = {
        kind: "cycle_detected",
        providerLabel: attempt.step.providerLabel,
      };
      break;
    }

    visited.add(attempt.targetRawUrl);
    unwrapSteps.push(attempt.step);
    currentRaw = attempt.targetRawUrl;
    currentParsed = attempt.targetParsed;
  }

  const stripped = stripTrackingParamsPreservingRawSegments(currentRaw, currentParsed);
  const cleanedUrl = stripped.cleanedUrl;

  return {
    status: "ok",
    lineNumber,
    rawLine,
    originalUrl: trimmed,
    cleanedUrl,
    changed: cleanedUrl !== trimmed,
    removedParams: stripped.removedParams,
    unwrapSteps,
    unwrapStoppedReason,
    presignedSkippedKey: stripped.presignedSkippedKey,
    preservedMalformedKeyCount: stripped.preservedMalformedKeyCount,
  };
}

export function cleanLinksBatch(input: string): CleanLinksBatchResult {
  if (input.trim().length === 0) {
    return {
      status: "empty",
      ruleVersion: CLEAN_LINKS_RULES_VERSION,
    };
  }

  const byteLength = new TextEncoder().encode(input).byteLength;
  if (byteLength > MAX_CLEAN_LINKS_INPUT_BYTES) {
    return {
      status: "limit_exceeded",
      ruleVersion: CLEAN_LINKS_RULES_VERSION,
      reason: "bytes",
      actual: byteLength,
      limit: MAX_CLEAN_LINKS_INPUT_BYTES,
    };
  }

  const rawLines = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (rawLines.length > MAX_CLEAN_LINKS_LINES) {
    return {
      status: "limit_exceeded",
      ruleVersion: CLEAN_LINKS_RULES_VERSION,
      reason: "lines",
      actual: rawLines.length,
      limit: MAX_CLEAN_LINKS_LINES,
    };
  }

  const lines: CleanLinkLineResult[] = [];
  const validCleanedUrls: string[] = [];
  let validCount = 0;
  let changedCount = 0;
  let invalidCount = 0;
  let presignedSkippedCount = 0;
  let totalRemovedParams = 0;
  let totalUnwrappedLinks = 0;

  for (let i = 0; i < rawLines.length; i++) {
    const res = cleanSingleLine(rawLines[i] ?? "", i + 1);
    lines.push(res);
    if (res.status === "invalid") {
      invalidCount += 1;
    } else if (res.status === "ok") {
      validCount += 1;
      validCleanedUrls.push(res.cleanedUrl);
      if (res.changed) {
        changedCount += 1;
      }
      if (res.presignedSkippedKey !== null) {
        presignedSkippedCount += 1;
      }
      totalRemovedParams += res.removedParams.length;
      if (res.unwrapSteps.length > 0) {
        totalUnwrappedLinks += 1;
      }
    }
  }

  return {
    status: "ok",
    ruleVersion: CLEAN_LINKS_RULES_VERSION,
    lines,
    validCount,
    changedCount,
    invalidCount,
    presignedSkippedCount,
    totalRemovedParams,
    totalUnwrappedLinks,
    allValidCleanedText: validCleanedUrls.join("\n"),
  };
}

/**
 * Evaluates clipboard text for the explicit one-shot "Clean & Replace Clipboard (Links Only)" action.
 * If the clipboard is empty or contains ANY non-blank line that is not a valid HTTP/HTTPS URL,
 * returns `canReplace: false` so the caller leaves the clipboard completely untouched.
 */
export function evaluateClipboardLinksOnlyReplace(clipboardText: string):
  | {
      canReplace: false;
      reason: "empty" | "contains_non_links" | "limit_exceeded";
      batch: CleanLinksBatchResult;
    }
  | {
      canReplace: true;
      replacementText: string;
      changedCount: number;
      batch: Extract<CleanLinksBatchResult, { status: "ok" }>;
    } {
  const batch = cleanLinksBatch(clipboardText);
  if (batch.status === "empty") {
    return { canReplace: false, reason: "empty", batch };
  }
  if (batch.status === "limit_exceeded") {
    return { canReplace: false, reason: "limit_exceeded", batch };
  }
  if (batch.invalidCount > 0 || batch.validCount === 0) {
    return { canReplace: false, reason: "contains_non_links", batch };
  }

  const lineEnding = clipboardText.includes("\r\n") ? "\r\n" : "\n";
  const rebuiltLines = batch.lines.map((line) =>
    line.status === "ok" ? line.cleanedUrl : line.rawLine,
  );

  return {
    canReplace: true,
    replacementText: rebuiltLines.join(lineEnding),
    changedCount: batch.changedCount,
    batch,
  };
}
