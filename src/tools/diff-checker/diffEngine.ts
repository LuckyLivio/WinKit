export const MAX_DIFF_BYTES_PER_SIDE = 4 * 1024 * 1024; // 4 MiB per side
export const MAX_DIFF_LINES_PER_SIDE = 50_000;
const MAX_MYERS_EDIT_DISTANCE = 6_000;
const MAX_INTRALINE_LINE_CHARS = 2_000;
const MAX_INTRALINE_TOKENS = 400;
export const DEFAULT_CONTEXT_LINES = 3;

export type LineEndingKind = "none" | "lf" | "crlf" | "mixed";

export interface TextEncodingMeta {
  byteLength: number;
  lineCount: number;
  hasBom: boolean;
  lineEnding: LineEndingKind;
  hasTrailingNewline: boolean;
}

export interface DiffOptions {
  ignoreWhitespace: boolean;
  ignoreCase: boolean;
  contextLines?: number;
}

export interface IntraLineSpan {
  text: string;
  changed: boolean;
}

export interface DiffDisplayLine {
  kind: "equal" | "delete" | "insert";
  leftLineNumber: number | null;
  rightLineNumber: number | null;
  text: string;
  eol: "\r\n" | "\n" | "";
  hasLeadingBom: boolean;
  spans?: IntraLineSpan[];
  hunkIndex: number | null;
}

export interface SideBySideRow {
  rowType: "pair";
  hunkIndex: number | null;
  left: {
    lineNumber: number;
    kind: "equal" | "delete";
    text: string;
    eol: "\r\n" | "\n" | "";
    hasLeadingBom: boolean;
    spans?: IntraLineSpan[];
  } | null;
  right: {
    lineNumber: number;
    kind: "equal" | "insert";
    text: string;
    eol: "\r\n" | "\n" | "";
    hasLeadingBom: boolean;
    spans?: IntraLineSpan[];
  } | null;
}

export type InlineRenderBlock =
  | {
      blockType: "lines";
      hunkIndex: number | null;
      lines: DiffDisplayLine[];
    }
  | {
      blockType: "collapsed";
      collapseId: string;
      hiddenCount: number;
      leftStartLine: number;
      rightStartLine: number;
      lines: DiffDisplayLine[];
    };

export type SideBySideRenderBlock =
  | {
      blockType: "rows";
      hunkIndex: number | null;
      rows: SideBySideRow[];
    }
  | {
      blockType: "collapsed";
      collapseId: string;
      hiddenCount: number;
      leftStartLine: number;
      rightStartLine: number;
      rows: SideBySideRow[];
    };

export interface DiffComputationSummary {
  exactIdentical: boolean;
  displayIdentical: boolean;
  addedLines: number;
  deletedLines: number;
  hunkCount: number;
  usedFallbackLargeEdit: boolean;
}

export type DiffComputationResult =
  | {
      status: "error";
      code: "BYTE_LIMIT_EXCEEDED" | "LINE_LIMIT_EXCEEDED";
      detail: string;
    }
  | {
      status: "ok";
      leftMeta: TextEncodingMeta;
      rightMeta: TextEncodingMeta;
      options: Required<DiffOptions>;
      summary: DiffComputationSummary;
      inlineBlocks: InlineRenderBlock[];
      sideBySideBlocks: SideBySideRenderBlock[];
      /** Always generated from exact un-ignored raw A and raw B so applying patch to A yields exact B */
      exactUnifiedPatch: string;
    };

interface ParsedRawLine {
  lineNumber: number;
  /** Visible content without trailing \r/\n and without leading UTF-8 BOM */
  displayText: string;
  /** Content without trailing \r/\n, keeping leading UTF-8 BOM if present on line 1 */
  contentWithBom: string;
  eol: "\r\n" | "\n" | "";
  hasLeadingBom: boolean;
  /** Exact original slice: contentWithBom + eol */
  rawSlice: string;
}

type RawEditOp =
  | { kind: "equal"; leftIdx: number; rightIdx: number }
  | { kind: "delete"; leftIdx: number }
  | { kind: "insert"; rightIdx: number };

export function analyzeAndSplitLines(text: string): {
  meta: TextEncodingMeta;
  lines: ParsedRawLine[];
} {
  const byteLength = new TextEncoder().encode(text).byteLength;
  const hasBom = text.startsWith("\uFEFF");
  if (text.length === 0) {
    return {
      meta: {
        byteLength: 0,
        lineCount: 0,
        hasBom: false,
        lineEnding: "none",
        hasTrailingNewline: false,
      },
      lines: [],
    };
  }

  const lines: ParsedRawLine[] = [];
  let crlfCount = 0;
  let lfOnlyCount = 0;
  let start = 0;
  let lineNum = 1;

  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0a) {
      const hasCr = i > start && text.charCodeAt(i - 1) === 0x0d;
      if (hasCr) {
        crlfCount++;
      } else {
        lfOnlyCount++;
      }
      const contentEnd = hasCr ? i - 1 : i;
      const contentWithBom = text.slice(start, contentEnd);
      const eol: "\r\n" | "\n" = hasCr ? "\r\n" : "\n";
      const lineHasBom = lineNum === 1 && contentWithBom.startsWith("\uFEFF");
      const displayText = lineHasBom ? contentWithBom.slice(1) : contentWithBom;

      lines.push({
        lineNumber: lineNum++,
        displayText,
        contentWithBom,
        eol,
        hasLeadingBom: lineHasBom,
        rawSlice: text.slice(start, i + 1),
      });
      start = i + 1;
    }
  }

  const hasTrailingNewline = start === text.length;
  if (!hasTrailingNewline) {
    const contentWithBom = text.slice(start);
    const lineHasBom = lineNum === 1 && contentWithBom.startsWith("\uFEFF");
    const displayText = lineHasBom ? contentWithBom.slice(1) : contentWithBom;
    lines.push({
      lineNumber: lineNum,
      displayText,
      contentWithBom,
      eol: "",
      hasLeadingBom: lineHasBom,
      rawSlice: contentWithBom,
    });
  }

  const lineEnding: LineEndingKind =
    crlfCount > 0 && lfOnlyCount > 0
      ? "mixed"
      : crlfCount > 0
        ? "crlf"
        : lfOnlyCount > 0
          ? "lf"
          : "none";

  return {
    meta: {
      byteLength,
      lineCount: lines.length,
      hasBom,
      lineEnding,
      hasTrailingNewline,
    },
    lines,
  };
}

function buildComparisonKey(line: ParsedRawLine, options: Required<DiffOptions>): string {
  if (!options.ignoreWhitespace && !options.ignoreCase) {
    return line.rawSlice;
  }
  let s = line.displayText;
  if (options.ignoreWhitespace) {
    s = s.replace(/[ \t]+/g, " ").trim();
  } else {
    // Keep exact BOM / EOL distinction unless ignoreWhitespace is enabled
    s = `${line.hasLeadingBom ? "\uFEFF" : ""}${s}${line.eol}`;
  }
  if (options.ignoreCase) {
    s = s.toLowerCase();
  }
  return s;
}

/**
 * Myers O((N+M)D) shortest edit script over integer IDs with prefix/suffix trimming and
 * bounded D fallback so pathological unrelated large inputs never exhaust memory or hang.
 */
function myersDiffIds(
  aIds: Int32Array,
  bIds: Int32Array,
  maxEditDistance: number,
): { ops: RawEditOp[]; usedFallback: boolean } {
  const nTotal = aIds.length;
  const mTotal = bIds.length;

  let prefix = 0;
  while (prefix < nTotal && prefix < mTotal && aIds[prefix] === bIds[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < nTotal - prefix &&
    suffix < mTotal - prefix &&
    aIds[nTotal - 1 - suffix] === bIds[mTotal - 1 - suffix]
  ) {
    suffix++;
  }

  const ops: RawEditOp[] = [];
  for (let i = 0; i < prefix; i++) {
    ops.push({ kind: "equal", leftIdx: i, rightIdx: i });
  }

  const n = nTotal - prefix - suffix;
  const m = mTotal - prefix - suffix;

  let usedFallback = false;
  if (n === 0 && m > 0) {
    for (let j = 0; j < m; j++) {
      ops.push({ kind: "insert", rightIdx: prefix + j });
    }
  } else if (m === 0 && n > 0) {
    for (let i = 0; i < n; i++) {
      ops.push({ kind: "delete", leftIdx: prefix + i });
    }
  } else if (n > 0 && m > 0) {
    const maxD = Math.min(n + m, maxEditDistance);
    const offset = maxD + 1;
    const size = 2 * offset + 2;
    const v = new Int32Array(size);
    v.fill(-1);
    v[offset + 1] = 0;

    const trace: Int32Array[] = [];
    let foundD = -1;

    for (let d = 0; d <= maxD; d++) {
      // Save snapshot of active k range [-d, d]
      const snap = new Int32Array(2 * d + 1);
      for (let k = -d; k <= d; k += 2) {
        let x: number;
        if (k === -d || (k !== d && (v[offset + k - 1] ?? -1) < (v[offset + k + 1] ?? -1))) {
          x = v[offset + k + 1] ?? 0;
        } else {
          x = (v[offset + k - 1] ?? 0) + 1;
        }
        let y = x - k;
        while (x < n && y < m && aIds[prefix + x] === bIds[prefix + y]) {
          x++;
          y++;
        }
        v[offset + k] = x;
        snap[k + d] = x;
        if (x >= n && y >= m) {
          foundD = d;
          break;
        }
      }
      trace.push(snap);
      if (foundD !== -1) {
        break;
      }
    }

    if (foundD === -1) {
      usedFallback = true;
      for (let i = 0; i < n; i++) {
        ops.push({ kind: "delete", leftIdx: prefix + i });
      }
      for (let j = 0; j < m; j++) {
        ops.push({ kind: "insert", rightIdx: prefix + j });
      }
    } else {
      // Backtrack from (n, m) down to (0, 0)
      const midOps: RawEditOp[] = [];
      let x = n;
      let y = m;
      for (let d = foundD; d > 0; d--) {
        const prevSnap = trace[d - 1]!;
        const prevD = d - 1;
        const k = x - y;

        const getPrevV = (prevK: number): number => {
          if (prevK < -prevD || prevK > prevD) return -1;
          return prevSnap[prevK + prevD] ?? -1;
        };

        let prevK: number;
        if (k === -d || (k !== d && getPrevV(k - 1) < getPrevV(k + 1))) {
          prevK = k + 1;
        } else {
          prevK = k - 1;
        }

        const prevX = getPrevV(prevK);
        const prevY = prevX - prevK;

        while (x > prevX && y > prevY) {
          x--;
          y--;
          midOps.push({ kind: "equal", leftIdx: prefix + x, rightIdx: prefix + y });
        }

        if (x === prevX) {
          y--;
          midOps.push({ kind: "insert", rightIdx: prefix + y });
        } else {
          x--;
          midOps.push({ kind: "delete", leftIdx: prefix + x });
        }
      }

      while (x > 0 && y > 0) {
        x--;
        y--;
        midOps.push({ kind: "equal", leftIdx: prefix + x, rightIdx: prefix + y });
      }

      midOps.reverse();
      for (const op of midOps) {
        ops.push(op);
      }
    }
  }

  for (let i = 0; i < suffix; i++) {
    ops.push({
      kind: "equal",
      leftIdx: nTotal - suffix + i,
      rightIdx: mTotal - suffix + i,
    });
  }

  return { ops, usedFallback };
}

function internStrings(aKeys: string[], bKeys: string[]): { aIds: Int32Array; bIds: Int32Array } {
  const dict = new Map<string, number>();
  let nextId = 1;
  const aIds = new Int32Array(aKeys.length);
  const bIds = new Int32Array(bKeys.length);

  for (let i = 0; i < aKeys.length; i++) {
    const k = aKeys[i]!;
    let id = dict.get(k);
    if (id === undefined) {
      id = nextId++;
      dict.set(k, id);
    }
    aIds[i] = id;
  }

  for (let j = 0; j < bKeys.length; j++) {
    const k = bKeys[j]!;
    let id = dict.get(k);
    if (id === undefined) {
      id = nextId++;
      dict.set(k, id);
    }
    bIds[j] = id;
  }

  return { aIds, bIds };
}

function tokenizeIntraLine(text: string): string[] {
  const tokens: string[] = [];
  const re = /[A-Za-z0-9_]+|[ \t]+|[^A-Za-z0-9_ \t]/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    tokens.push(m[0]);
  }
  return tokens;
}

function mergeAdjacentSpans(spans: IntraLineSpan[]): IntraLineSpan[] {
  if (spans.length <= 1) return spans;
  const merged: IntraLineSpan[] = [];
  for (const s of spans) {
    if (s.text.length === 0) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.changed === s.changed) {
      prev.text += s.text;
    } else {
      merged.push({ text: s.text, changed: s.changed });
    }
  }
  return merged;
}

function computeIntraLinePair(
  delText: string,
  insText: string,
): { delSpans: IntraLineSpan[]; insSpans: IntraLineSpan[] } | null {
  if (
    delText.length > MAX_INTRALINE_LINE_CHARS ||
    insText.length > MAX_INTRALINE_LINE_CHARS ||
    (delText.length === 0 && insText.length === 0)
  ) {
    return null;
  }

  const aTokens = tokenizeIntraLine(delText);
  const bTokens = tokenizeIntraLine(insText);
  if (aTokens.length > MAX_INTRALINE_TOKENS || bTokens.length > MAX_INTRALINE_TOKENS) {
    return null;
  }

  const { aIds, bIds } = internStrings(aTokens, bTokens);
  const { ops } = myersDiffIds(aIds, bIds, MAX_INTRALINE_TOKENS * 2);

  const delRaw: IntraLineSpan[] = [];
  const insRaw: IntraLineSpan[] = [];
  for (const op of ops) {
    if (op.kind === "equal") {
      delRaw.push({ text: aTokens[op.leftIdx]!, changed: false });
      insRaw.push({ text: bTokens[op.rightIdx]!, changed: false });
    } else if (op.kind === "delete") {
      delRaw.push({ text: aTokens[op.leftIdx]!, changed: true });
    } else {
      insRaw.push({ text: bTokens[op.rightIdx]!, changed: true });
    }
  }

  return {
    delSpans: mergeAdjacentSpans(delRaw),
    insSpans: mergeAdjacentSpans(insRaw),
  };
}

function formatHunkHeaderRange(start1Based: number, count: number): string {
  if (count === 0) {
    return `${Math.max(0, start1Based - 1)},0`;
  }
  if (count === 1) {
    return `${start1Based}`;
  }
  return `${start1Based},${count}`;
}

/**
 * Generates a standard POSIX / `git apply`-compatible Unified Diff patch from the exact,
 * un-ignored original lines of A and B (preserving BOM, CRLF/LF, and `\ No newline at end of file`).
 */
export function generateExactUnifiedPatch(
  leftLines: ParsedRawLine[],
  rightLines: ParsedRawLine[],
  leftLabel = "left.txt",
  rightLabel = "right.txt",
  contextLines = DEFAULT_CONTEXT_LINES,
): { patch: string; exactIdentical: boolean } {
  const { aIds, bIds } = internStrings(
    leftLines.map((l) => l.rawSlice),
    rightLines.map((l) => l.rawSlice),
  );
  const { ops } = myersDiffIds(aIds, bIds, MAX_MYERS_EDIT_DISTANCE);

  const changeIndices: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.kind !== "equal") {
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) {
    return { patch: "", exactIdentical: true };
  }

  // Group op indices into Unified Diff hunks with `contextLines` surrounding equal lines
  const hunkRanges: Array<{ startOp: number; endOp: number }> = [];
  for (const idx of changeIndices) {
    const startOp = Math.max(0, idx - contextLines);
    const endOp = Math.min(ops.length - 1, idx + contextLines);
    const prev = hunkRanges[hunkRanges.length - 1];
    if (prev && startOp <= prev.endOp + 1) {
      prev.endOp = Math.max(prev.endOp, endOp);
    } else {
      hunkRanges.push({ startOp, endOp });
    }
  }

  const cleanLeft = leftLabel.replace(/[\r\n\t]/g, "_");
  const cleanRight = rightLabel.replace(/[\r\n\t]/g, "_");
  const out: string[] = [`--- a/${cleanLeft}\n`, `+++ b/${cleanRight}\n`];

  for (const range of hunkRanges) {
    let oldCount = 0;
    let newCount = 0;
    let firstLeftLine: number | null = null;
    let firstRightLine: number | null = null;

    // Determine exact 1-based starting line numbers even when oldCount == 0 or newCount == 0
    for (let i = range.startOp; i <= range.endOp; i++) {
      const op = ops[i]!;
      if (op.kind === "equal") {
        if (firstLeftLine === null) firstLeftLine = leftLines[op.leftIdx]!.lineNumber;
        if (firstRightLine === null) firstRightLine = rightLines[op.rightIdx]!.lineNumber;
        oldCount++;
        newCount++;
      } else if (op.kind === "delete") {
        if (firstLeftLine === null) firstLeftLine = leftLines[op.leftIdx]!.lineNumber;
        oldCount++;
      } else {
        if (firstRightLine === null) firstRightLine = rightLines[op.rightIdx]!.lineNumber;
        newCount++;
      }
    }

    // If pure insertion into empty A (oldCount == 0), start1Based is 1 so formatHunkHeaderRange -> 0,0
    // If pure deletion into empty B (newCount == 0), start1Based is 1 so formatHunkHeaderRange -> 0,0
    if (firstLeftLine === null) {
      // Find preceding op's left line number if any
      let anchor = 1;
      for (let i = range.startOp - 1; i >= 0; i--) {
        const prev = ops[i]!;
        if (prev.kind === "equal" || prev.kind === "delete") {
          anchor = leftLines[prev.leftIdx]!.lineNumber + 1;
          break;
        }
      }
      firstLeftLine = anchor;
    }
    if (firstRightLine === null) {
      let anchor = 1;
      for (let i = range.startOp - 1; i >= 0; i--) {
        const prev = ops[i]!;
        if (prev.kind === "equal" || prev.kind === "insert") {
          anchor = rightLines[prev.rightIdx]!.lineNumber + 1;
          break;
        }
      }
      firstRightLine = anchor;
    }

    out.push(
      `@@ -${formatHunkHeaderRange(firstLeftLine, oldCount)} +${formatHunkHeaderRange(firstRightLine, newCount)} @@\n`,
    );

    for (let i = range.startOp; i <= range.endOp; i++) {
      const op = ops[i]!;
      if (op.kind === "equal") {
        const line = leftLines[op.leftIdx]!;
        emitUnifiedLine(out, " ", line);
      } else if (op.kind === "delete") {
        const line = leftLines[op.leftIdx]!;
        emitUnifiedLine(out, "-", line);
      } else {
        const line = rightLines[op.rightIdx]!;
        emitUnifiedLine(out, "+", line);
      }
    }
  }

  return { patch: out.join(""), exactIdentical: false };
}

function emitUnifiedLine(out: string[], prefix: " " | "-" | "+", line: ParsedRawLine): void {
  if (line.eol === "\r\n") {
    out.push(`${prefix}${line.contentWithBom}\r\n`);
  } else if (line.eol === "\n") {
    out.push(`${prefix}${line.contentWithBom}\n`);
  } else {
    out.push(`${prefix}${line.contentWithBom}\n\\ No newline at end of file\n`);
  }
}

export function computeDiffResult(
  leftText: string,
  rightText: string,
  rawOptions: DiffOptions,
  leftLabel = "left.txt",
  rightLabel = "right.txt",
): DiffComputationResult {
  const options: Required<DiffOptions> = {
    ignoreWhitespace: rawOptions.ignoreWhitespace,
    ignoreCase: rawOptions.ignoreCase,
    contextLines: rawOptions.contextLines ?? DEFAULT_CONTEXT_LINES,
  };

  const leftParsed = analyzeAndSplitLines(leftText);
  const rightParsed = analyzeAndSplitLines(rightText);

  if (
    leftParsed.meta.byteLength > MAX_DIFF_BYTES_PER_SIDE ||
    rightParsed.meta.byteLength > MAX_DIFF_BYTES_PER_SIDE
  ) {
    return {
      status: "error",
      code: "BYTE_LIMIT_EXCEEDED",
      detail: `Each side supports up to 4 MB (${MAX_DIFF_BYTES_PER_SIDE.toLocaleString()} bytes).`,
    };
  }

  if (
    leftParsed.meta.lineCount > MAX_DIFF_LINES_PER_SIDE ||
    rightParsed.meta.lineCount > MAX_DIFF_LINES_PER_SIDE
  ) {
    return {
      status: "error",
      code: "LINE_LIMIT_EXCEEDED",
      detail: `Each side supports up to ${MAX_DIFF_LINES_PER_SIDE.toLocaleString()} lines in Phase 2B1.`,
    };
  }

  // 1. Always build exact applicable Unified Diff from un-ignored raw A and raw B
  const exactPatchResult = generateExactUnifiedPatch(
    leftParsed.lines,
    rightParsed.lines,
    leftLabel,
    rightLabel,
    options.contextLines,
  );

  // 2. Build display diff using selected ignoreWhitespace / ignoreCase options
  const leftKeys = leftParsed.lines.map((l) => buildComparisonKey(l, options));
  const rightKeys = rightParsed.lines.map((l) => buildComparisonKey(l, options));
  const { aIds, bIds } = internStrings(leftKeys, rightKeys);
  const { ops, usedFallback } = myersDiffIds(aIds, bIds, MAX_MYERS_EDIT_DISTANCE);

  // Segment ops into equal runs and changed hunks
  type RunSegment =
    | { type: "equal"; equals: Array<{ left: ParsedRawLine; right: ParsedRawLine }> }
    | {
        type: "change";
        hunkIndex: number;
        deletes: ParsedRawLine[];
        inserts: ParsedRawLine[];
      };

  const segments: RunSegment[] = [];
  let addedLines = 0;
  let deletedLines = 0;
  let hunkCounter = 0;

  let idx = 0;
  while (idx < ops.length) {
    const op = ops[idx]!;
    if (op.kind === "equal") {
      const equals: Array<{ left: ParsedRawLine; right: ParsedRawLine }> = [];
      while (idx < ops.length && ops[idx]!.kind === "equal") {
        const eqOp = ops[idx]! as { kind: "equal"; leftIdx: number; rightIdx: number };
        equals.push({
          left: leftParsed.lines[eqOp.leftIdx]!,
          right: rightParsed.lines[eqOp.rightIdx]!,
        });
        idx++;
      }
      segments.push({ type: "equal", equals });
    } else {
      const deletes: ParsedRawLine[] = [];
      const inserts: ParsedRawLine[] = [];
      while (idx < ops.length && ops[idx]!.kind !== "equal") {
        const chOp = ops[idx]!;
        if (chOp.kind === "delete") {
          deletes.push(leftParsed.lines[chOp.leftIdx]!);
          deletedLines++;
        } else if (chOp.kind === "insert") {
          inserts.push(rightParsed.lines[chOp.rightIdx]!);
          addedLines++;
        }
        idx++;
      }
      segments.push({
        type: "change",
        hunkIndex: hunkCounter++,
        deletes,
        inserts,
      });
    }
  }

  const displayIdentical = hunkCounter === 0;
  const ctx = options.contextLines;
  const inlineBlocks: InlineRenderBlock[] = [];
  const sideBySideBlocks: SideBySideRenderBlock[] = [];

  const toEqualInlineLine = (left: ParsedRawLine, right: ParsedRawLine): DiffDisplayLine => ({
    kind: "equal",
    leftLineNumber: left.lineNumber,
    rightLineNumber: right.lineNumber,
    text: right.displayText,
    eol: right.eol,
    hasLeadingBom: right.hasLeadingBom || left.hasLeadingBom,
    hunkIndex: null,
  });

  const toEqualSbsRow = (left: ParsedRawLine, right: ParsedRawLine): SideBySideRow => ({
    rowType: "pair",
    hunkIndex: null,
    left: {
      lineNumber: left.lineNumber,
      kind: "equal",
      text: left.displayText,
      eol: left.eol,
      hasLeadingBom: left.hasLeadingBom,
    },
    right: {
      lineNumber: right.lineNumber,
      kind: "equal",
      text: right.displayText,
      eol: right.eol,
      hasLeadingBom: right.hasLeadingBom,
    },
  });

  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s]!;
    if (seg.type === "equal") {
      const totalEq = seg.equals.length;
      if (displayIdentical) {
        // When both texts match under current display options, collapse after first few lines if long
        if (totalEq <= ctx * 2 + 2) {
          inlineBlocks.push({
            blockType: "lines",
            hunkIndex: null,
            lines: seg.equals.map((p) => toEqualInlineLine(p.left, p.right)),
          });
          sideBySideBlocks.push({
            blockType: "rows",
            hunkIndex: null,
            rows: seg.equals.map((p) => toEqualSbsRow(p.left, p.right)),
          });
        } else {
          const head = seg.equals.slice(0, ctx);
          const mid = seg.equals.slice(ctx, totalEq - ctx);
          const tail = seg.equals.slice(totalEq - ctx);
          inlineBlocks.push({
            blockType: "lines",
            hunkIndex: null,
            lines: head.map((p) => toEqualInlineLine(p.left, p.right)),
          });
          inlineBlocks.push({
            blockType: "collapsed",
            collapseId: `collapse-eq-${s}`,
            hiddenCount: mid.length,
            leftStartLine: mid[0]!.left.lineNumber,
            rightStartLine: mid[0]!.right.lineNumber,
            lines: mid.map((p) => toEqualInlineLine(p.left, p.right)),
          });
          inlineBlocks.push({
            blockType: "lines",
            hunkIndex: null,
            lines: tail.map((p) => toEqualInlineLine(p.left, p.right)),
          });

          sideBySideBlocks.push({
            blockType: "rows",
            hunkIndex: null,
            rows: head.map((p) => toEqualSbsRow(p.left, p.right)),
          });
          sideBySideBlocks.push({
            blockType: "collapsed",
            collapseId: `collapse-eq-${s}`,
            hiddenCount: mid.length,
            leftStartLine: mid[0]!.left.lineNumber,
            rightStartLine: mid[0]!.right.lineNumber,
            rows: mid.map((p) => toEqualSbsRow(p.left, p.right)),
          });
          sideBySideBlocks.push({
            blockType: "rows",
            hunkIndex: null,
            rows: tail.map((p) => toEqualSbsRow(p.left, p.right)),
          });
        }
        continue;
      }

      const isLeading = s === 0;
      const isTrailing = s === segments.length - 1;
      const keepHead = isLeading ? 0 : ctx;
      const keepTail = isTrailing ? 0 : ctx;

      if (totalEq <= keepHead + keepTail + 1) {
        inlineBlocks.push({
          blockType: "lines",
          hunkIndex: null,
          lines: seg.equals.map((p) => toEqualInlineLine(p.left, p.right)),
        });
        sideBySideBlocks.push({
          blockType: "rows",
          hunkIndex: null,
          rows: seg.equals.map((p) => toEqualSbsRow(p.left, p.right)),
        });
      } else {
        const head = keepHead > 0 ? seg.equals.slice(0, keepHead) : [];
        const mid = seg.equals.slice(keepHead, totalEq - keepTail);
        const tail = keepTail > 0 ? seg.equals.slice(totalEq - keepTail) : [];

        if (head.length > 0) {
          inlineBlocks.push({
            blockType: "lines",
            hunkIndex: null,
            lines: head.map((p) => toEqualInlineLine(p.left, p.right)),
          });
          sideBySideBlocks.push({
            blockType: "rows",
            hunkIndex: null,
            rows: head.map((p) => toEqualSbsRow(p.left, p.right)),
          });
        }

        inlineBlocks.push({
          blockType: "collapsed",
          collapseId: `collapse-${s}`,
          hiddenCount: mid.length,
          leftStartLine: mid[0]!.left.lineNumber,
          rightStartLine: mid[0]!.right.lineNumber,
          lines: mid.map((p) => toEqualInlineLine(p.left, p.right)),
        });
        sideBySideBlocks.push({
          blockType: "collapsed",
          collapseId: `collapse-${s}`,
          hiddenCount: mid.length,
          leftStartLine: mid[0]!.left.lineNumber,
          rightStartLine: mid[0]!.right.lineNumber,
          rows: mid.map((p) => toEqualSbsRow(p.left, p.right)),
        });

        if (tail.length > 0) {
          inlineBlocks.push({
            blockType: "lines",
            hunkIndex: null,
            lines: tail.map((p) => toEqualInlineLine(p.left, p.right)),
          });
          sideBySideBlocks.push({
            blockType: "rows",
            hunkIndex: null,
            rows: tail.map((p) => toEqualSbsRow(p.left, p.right)),
          });
        }
      }
    } else {
      // Changed hunk: compute intra-line spans for paired delete/insert rows
      const pairCount = Math.min(seg.deletes.length, seg.inserts.length);
      const delSpansArr: Array<IntraLineSpan[] | undefined> = new Array(seg.deletes.length);
      const insSpansArr: Array<IntraLineSpan[] | undefined> = new Array(seg.inserts.length);

      for (let p = 0; p < pairCount; p++) {
        const pairSpans = computeIntraLinePair(
          seg.deletes[p]!.displayText,
          seg.inserts[p]!.displayText,
        );
        if (pairSpans) {
          delSpansArr[p] = pairSpans.delSpans;
          insSpansArr[p] = pairSpans.insSpans;
        }
      }

      const inlineLines: DiffDisplayLine[] = [];
      for (let d = 0; d < seg.deletes.length; d++) {
        const line = seg.deletes[d]!;
        inlineLines.push({
          kind: "delete",
          leftLineNumber: line.lineNumber,
          rightLineNumber: null,
          text: line.displayText,
          eol: line.eol,
          hasLeadingBom: line.hasLeadingBom,
          spans: delSpansArr[d],
          hunkIndex: seg.hunkIndex,
        });
      }
      for (let ins = 0; ins < seg.inserts.length; ins++) {
        const line = seg.inserts[ins]!;
        inlineLines.push({
          kind: "insert",
          leftLineNumber: null,
          rightLineNumber: line.lineNumber,
          text: line.displayText,
          eol: line.eol,
          hasLeadingBom: line.hasLeadingBom,
          spans: insSpansArr[ins],
          hunkIndex: seg.hunkIndex,
        });
      }
      inlineBlocks.push({
        blockType: "lines",
        hunkIndex: seg.hunkIndex,
        lines: inlineLines,
      });

      const maxRows = Math.max(seg.deletes.length, seg.inserts.length);
      const sbsRows: SideBySideRow[] = [];
      for (let r = 0; r < maxRows; r++) {
        const dLine = seg.deletes[r];
        const iLine = seg.inserts[r];
        sbsRows.push({
          rowType: "pair",
          hunkIndex: seg.hunkIndex,
          left: dLine
            ? {
                lineNumber: dLine.lineNumber,
                kind: "delete",
                text: dLine.displayText,
                eol: dLine.eol,
                hasLeadingBom: dLine.hasLeadingBom,
                spans: delSpansArr[r],
              }
            : null,
          right: iLine
            ? {
                lineNumber: iLine.lineNumber,
                kind: "insert",
                text: iLine.displayText,
                eol: iLine.eol,
                hasLeadingBom: iLine.hasLeadingBom,
                spans: insSpansArr[r],
              }
            : null,
        });
      }
      sideBySideBlocks.push({
        blockType: "rows",
        hunkIndex: seg.hunkIndex,
        rows: sbsRows,
      });
    }
  }

  return {
    status: "ok",
    leftMeta: leftParsed.meta,
    rightMeta: rightParsed.meta,
    options,
    summary: {
      exactIdentical: exactPatchResult.exactIdentical,
      displayIdentical,
      addedLines,
      deletedLines,
      hunkCount: hunkCounter,
      usedFallbackLargeEdit: usedFallback,
    },
    inlineBlocks,
    sideBySideBlocks,
    exactUnifiedPatch: exactPatchResult.patch,
  };
}
