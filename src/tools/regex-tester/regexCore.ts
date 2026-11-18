export const MAX_REGEX_INPUT_BYTES = 2 * 1024 * 1024; // 2 MiB
export const MAX_REGEX_PATTERN_CHARS = 16_384;
export const MAX_REGEX_MATCHES = 2_000;
export const MAX_HIGHLIGHT_MATCHES = 500;
export const MAX_REPLACEMENT_OUTPUT_CHARS = 2 * 1024 * 1024;
export const MAX_REPLACEMENT_PREVIEW_CHARS = 32_768;
export const DEFAULT_REGEX_TIMEOUT_MS = 2_000;

export const SUPPORTED_JS_REGEX_FLAGS = ["g", "i", "m", "s", "u", "v", "d", "y"] as const;
export type JsRegexFlag = (typeof SUPPORTED_JS_REGEX_FLAGS)[number];

export interface RegexCaptureGroupItem {
  index: number;
  name: string | null;
  matched: boolean;
  value: string;
  utf16Range: [number, number] | null;
}

export interface RegexMatchRecord {
  matchNumber: number;
  value: string;
  utf16Start: number;
  utf16End: number;
  /** 1-based line number */
  line: number;
  /** 1-based UTF-16 code-unit column within line */
  utf16Column: number;
  isZeroLength: boolean;
  captures: RegexCaptureGroupItem[];
}

export interface RegexExecutionRequest {
  pattern: string;
  flags: string;
  testText: string;
  enableReplace: boolean;
  replacementTemplate: string;
}

export type RegexExecutionResult =
  | {
      status: "empty_pattern";
    }
  | {
      status: "invalid_regex";
      errorMessage: string;
    }
  | {
      status: "input_too_large";
      detail: string;
    }
  | {
      status: "replacement_too_large";
      detail: string;
    }
  | {
      status: "ok";
      flagsUsed: string;
      hasIndicesFlag: boolean;
      totalMatchesCollected: number;
      matchesTruncated: boolean;
      highlightTruncated: boolean;
      matches: RegexMatchRecord[];
      replacementPreview: string | null;
      replacementFull: string | null;
      replacementPreviewTruncated: boolean;
      elapsedMs: number;
    };

/**
 * Precomputes 0-based UTF-16 start offsets for each line (handling LF and CRLF)
 * so any UTF-16 offset maps to 1-based (line, utf16Column) in O(log Lines).
 */
function buildLineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0d) {
      if (i + 1 < text.length && text.charCodeAt(i + 1) === 0x0a) {
        i++;
      }
      starts.push(i + 1);
    } else if (code === 0x0a) {
      starts.push(i + 1);
    }
  }
  return starts;
}

function locateLineAndUtf16Column(
  lineStarts: number[],
  utf16Offset: number,
): { line: number; utf16Column: number } {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if ((lineStarts[mid] ?? 0) <= utf16Offset) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const lineIdx = Math.max(0, hi);
  const lineStart = lineStarts[lineIdx] ?? 0;
  return {
    line: lineIdx + 1,
    utf16Column: utf16Offset - lineStart + 1,
  };
}

/**
 * ECMAScript AdvanceStringIndex(S, index, unicode):
 * Advances by 2 UTF-16 code units across a valid surrogate pair when `u` or `v` is active,
 * otherwise advances by 1 UTF-16 code unit. Prevents infinite loops on zero-length matches.
 */
export function advanceZeroLengthIndex(text: string, index: number, unicodeMode: boolean): number {
  if (!unicodeMode || index + 1 >= text.length) {
    return index + 1;
  }
  const first = text.charCodeAt(index);
  if (first >= 0xd800 && first <= 0xdbff) {
    const second = text.charCodeAt(index + 1);
    if (second >= 0xdc00 && second <= 0xdfff) {
      return index + 2;
    }
  }
  return index + 1;
}

type RegExpExecWithIndices = RegExpExecArray & {
  indices?: Array<[number, number] | undefined> & {
    groups?: Record<string, [number, number] | undefined>;
  };
};

export function executeRegexInWorkerScope(req: RegexExecutionRequest): RegexExecutionResult {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();

  if (req.pattern.length === 0) {
    return { status: "empty_pattern" };
  }

  if (req.pattern.length > MAX_REGEX_PATTERN_CHARS) {
    return {
      status: "input_too_large",
      detail: `Pattern exceeds ${MAX_REGEX_PATTERN_CHARS.toLocaleString()} characters.`,
    };
  }

  const textBytes = new TextEncoder().encode(req.testText).byteLength;
  if (textBytes > MAX_REGEX_INPUT_BYTES) {
    return {
      status: "input_too_large",
      detail: `Test text exceeds the 2 MB limit (${textBytes.toLocaleString()} bytes).`,
    };
  }

  let compiled: RegExp;
  try {
    compiled = new RegExp(req.pattern, req.flags);
  } catch (err) {
    return {
      status: "invalid_regex",
      errorMessage: err instanceof Error ? err.message : "Invalid regular expression or flags.",
    };
  }

  const unicodeMode =
    compiled.unicode || Boolean((compiled as RegExp & { unicodeSets?: boolean }).unicodeSets);
  const hasIndicesFlag = Boolean((compiled as RegExp & { hasIndices?: boolean }).hasIndices);
  const iterative = compiled.global || compiled.sticky;

  const lineStarts = buildLineStartOffsets(req.testText);
  const matches: RegexMatchRecord[] = [];
  let matchesTruncated = false;

  compiled.lastIndex = 0;

  while (true) {
    const rawMatch = compiled.exec(req.testText) as RegExpExecWithIndices | null;
    if (!rawMatch) {
      break;
    }

    if (matches.length >= MAX_REGEX_MATCHES) {
      matchesTruncated = true;
      break;
    }

    const fullVal = rawMatch[0] ?? "";
    const utf16Start = rawMatch.index;
    const utf16End = utf16Start + fullVal.length;
    const loc = locateLineAndUtf16Column(lineStarts, utf16Start);

    // Map group index -> group name if named capture groups exist
    const groupEntries = rawMatch.groups ? Object.entries(rawMatch.groups) : [];
    const usedGroupNames = new Set<string>();
    const captures: RegexCaptureGroupItem[] = [];

    for (let g = 1; g < rawMatch.length; g++) {
      const capVal = rawMatch[g];
      const capRange = rawMatch.indices?.[g] ?? null;

      // Resolve matching named capture if present
      let resolvedName: string | null = null;
      if (groupEntries.length > 0) {
        for (const [gName, gVal] of groupEntries) {
          if (usedGroupNames.has(gName)) continue;
          const namedRange = rawMatch.indices?.groups?.[gName] ?? null;
          if (hasIndicesFlag && capRange && namedRange) {
            if (capRange[0] === namedRange[0] && capRange[1] === namedRange[1]) {
              resolvedName = gName;
              usedGroupNames.add(gName);
              break;
            }
          } else if (gVal === capVal) {
            resolvedName = gName;
            usedGroupNames.add(gName);
            break;
          }
        }
      }

      captures.push({
        index: g,
        name: resolvedName,
        matched: capVal !== undefined,
        value: capVal ?? "",
        utf16Range: capRange ? [capRange[0], capRange[1]] : null,
      });
    }

    matches.push({
      matchNumber: matches.length + 1,
      value: fullVal,
      utf16Start,
      utf16End,
      line: loc.line,
      utf16Column: loc.utf16Column,
      isZeroLength: fullVal.length === 0,
      captures,
    });

    if (!iterative) {
      break;
    }

    if (fullVal.length === 0) {
      const nextIdx = advanceZeroLengthIndex(req.testText, compiled.lastIndex, unicodeMode);
      if (nextIdx > req.testText.length) {
        break;
      }
      compiled.lastIndex = nextIdx;
    }
  }

  let replacementFull: string | null = null;
  let replacementPreview: string | null = null;
  let replacementPreviewTruncated = false;

  if (req.enableReplace) {
    const replaceRegex = new RegExp(req.pattern, req.flags);
    const estimatedExtra =
      matches.length * Math.max(0, req.replacementTemplate.length - 2) + req.testText.length;
    if (estimatedExtra > MAX_REPLACEMENT_OUTPUT_CHARS * 2) {
      return {
        status: "replacement_too_large",
        detail: `Estimated replacement output exceeds the ${MAX_REPLACEMENT_OUTPUT_CHARS.toLocaleString()}-character safety cap.`,
      };
    }

    const replaced = req.testText.replace(replaceRegex, req.replacementTemplate);
    if (replaced.length > MAX_REPLACEMENT_OUTPUT_CHARS) {
      return {
        status: "replacement_too_large",
        detail: `Replacement result (${replaced.length.toLocaleString()} UTF-16 units) exceeds the ${MAX_REPLACEMENT_OUTPUT_CHARS.toLocaleString()} limit.`,
      };
    }

    replacementFull = replaced;
    if (replaced.length > MAX_REPLACEMENT_PREVIEW_CHARS) {
      replacementPreview = replaced.slice(0, MAX_REPLACEMENT_PREVIEW_CHARS);
      replacementPreviewTruncated = true;
    } else {
      replacementPreview = replaced;
    }
  }

  const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();

  return {
    status: "ok",
    flagsUsed: compiled.flags,
    hasIndicesFlag,
    totalMatchesCollected: matches.length,
    matchesTruncated,
    highlightTruncated: matches.length > MAX_HIGHLIGHT_MATCHES,
    matches,
    replacementPreview,
    replacementFull,
    replacementPreviewTruncated,
    elapsedMs: Math.max(0, Math.round((t1 - t0) * 10) / 10),
  };
}
