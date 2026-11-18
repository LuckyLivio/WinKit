import { parseLosslessJsonAst, type JsonAstNode } from "../json-formatter/jsonEngine";

export const MAX_TABULAR_INPUT_BYTES = 8 * 1024 * 1024; // 8 MiB
export const MAX_TABULAR_OUTPUT_BYTES = 16 * 1024 * 1024; // 16 MiB
export const MAX_TABULAR_ROWS = 100_000;
export const MAX_TABULAR_COLUMNS = 1_000;
export const MAX_TABULAR_CELLS = 1_000_000;
export const MAX_NESTED_DEPTH = 16;
export const MAX_PREVIEW_CHARS = 65_536;
export const MAX_PREVIEW_TABLE_ROWS = 200;
export const MAX_PREVIEW_TABLE_COLS = 40;

export type CsvDelimiter = "auto" | "," | ";" | "\t";
export type ConcreteDelimiter = "," | ";" | "\t";
export type ConversionDirection = "csv_to_json" | "json_to_csv" | "csv_to_md" | "json_to_md";
export type HeaderIssuePolicy = "error" | "rename";
export type RaggedRowPolicy = "error" | "pad_and_extend";
export type JsonArrayCellMode = "semicolon" | "compact_json";
export type PathConflictPolicy = "error" | "bracket_escape";
export type CsvLineEnding = "lf" | "crlf";

export interface TabularBudgetOverrides {
  maxInputBytes?: number;
  maxOutputBytes?: number;
  maxRows?: number;
  maxColumns?: number;
  maxCells?: number;
  onRowSerialized?: (rowIndexZeroBased: number) => void;
}

interface ResolvedTabularBudgets {
  maxInputBytes: number;
  maxOutputBytes: number;
  maxRows: number;
  maxColumns: number;
  maxCells: number;
  onRowSerialized?: (rowIndexZeroBased: number) => void;
}

function resolveBudgets(overrides?: TabularBudgetOverrides): ResolvedTabularBudgets {
  return {
    maxInputBytes: overrides?.maxInputBytes ?? MAX_TABULAR_INPUT_BYTES,
    maxOutputBytes: overrides?.maxOutputBytes ?? MAX_TABULAR_OUTPUT_BYTES,
    maxRows: overrides?.maxRows ?? MAX_TABULAR_ROWS,
    maxColumns: overrides?.maxColumns ?? MAX_TABULAR_COLUMNS,
    maxCells: overrides?.maxCells ?? MAX_TABULAR_CELLS,
    onRowSerialized: overrides?.onRowSerialized,
  };
}

/**
 * Exact UTF-8 byte length of a JS UTF-16 string without allocating a `Uint8Array`.
 * Matches `new TextEncoder().encode(str).byteLength` identically (including surrogate pairs
 * and lone surrogates encoded as 3-byte U+FFFD).
 */
export function utf8ByteLength(str: string): number {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const low = str.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export class BoundedUtf8Builder {
  private readonly chunks: string[] = [];
  private totalBytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  public append(part: string): boolean {
    if (part.length === 0) return true;
    const addBytes = utf8ByteLength(part);
    if (this.totalBytes + addBytes > this.maxBytes) {
      this.totalBytes += addBytes;
      return false;
    }
    this.totalBytes += addBytes;
    this.chunks.push(part);
    return true;
  }

  public get byteLength(): number {
    return this.totalBytes;
  }

  public build(): string {
    return this.chunks.join("");
  }
}

function makeOutputLimitError(maxOutputBytes: number): TabularConversionResult {
  const limitLabel =
    maxOutputBytes >= 1024 * 1024
      ? `${(maxOutputBytes / (1024 * 1024)).toFixed(2).replace(/\.00$/, "")} MiB`
      : `${maxOutputBytes.toLocaleString()} bytes`;
  return {
    status: "error",
    code: "OUTPUT_LIMIT_EXCEEDED",
    message: `Converted output exceeds the ${limitLabel} UTF-8 safety limit.`,
  };
}

export interface CsvJsonOptions {
  direction: ConversionDirection;
  delimiter: CsvDelimiter;
  firstRowHeaders: boolean;
  detectTypes: boolean;
  emptyCellsAsNull?: boolean;
  headerIssuePolicy?: HeaderIssuePolicy;
  raggedRowPolicy?: RaggedRowPolicy;
  arrayMode?: JsonArrayCellMode;
  pathConflictPolicy?: PathConflictPolicy;
  formulaProtection: boolean;
  csvLineEnding?: CsvLineEnding;
  csvIncludeBom?: boolean;
}

export interface FormulaPreviewSample {
  rowNumber: number;
  columnName: string;
  original: string;
  protectedValue: string;
}

export interface RenamedHeaderInfo {
  columnIndex: number; // 1-based
  original: string;
  renamedTo: string;
}

export type TabularConversionResult =
  | {
      status: "empty";
    }
  | {
      status: "error";
      code: string;
      message: string;
      physicalLine?: number;
      column?: number;
      recordNumber?: number;
    }
  | {
      status: "ok";
      fullOutput: string;
      previewOutput: string;
      previewTruncated: boolean;
      rowCount: number;
      columnCount: number;
      detectedDelimiter: ConcreteDelimiter | null;
      delimiterAmbiguous: boolean;
      hadInputBom: boolean;
      formulaLikeCellCount: number;
      formulaProtectedCount: number;
      formulaPreviewSamples: FormulaPreviewSample[];
      renamedHeaders: RenamedHeaderInfo[];
      paddedRowCount: number;
      extendedColumnCount: number;
      ambiguousScalarArrayCount: number;
      depthCappedCellCount: number;
      singleObjectNormalized: boolean;
      tablePreviewHeaders: string[];
      tablePreviewRows: string[][];
      tablePreviewTruncated: boolean;
    };

export interface ParsedCsvData {
  rows: string[][];
  recordPhysicalLines: number[];
  detectedDelimiter: ConcreteDelimiter;
  delimiterAmbiguous: boolean;
  hadLeadingBom: boolean;
}

/**
 * Quote-aware delimiter auto-detector across up to 50 logical records.
 * Ignores candidate delimiters inside double-quoted cells and explicitly reports ambiguity.
 */
export function detectCsvDelimiter(bodyWithoutBom: string): {
  delimiter: ConcreteDelimiter;
  ambiguous: boolean;
} {
  const candidates: ConcreteDelimiter[] = [",", ";", "\t"];
  const perRecordCounts: Record<ConcreteDelimiter, number[]> = {
    ",": [],
    ";": [],
    "\t": [],
  };

  let curCounts: Record<ConcreteDelimiter, number> = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  let hasCharsInRecord = false;
  let recordsScanned = 0;

  for (let i = 0; i < bodyWithoutBom.length && recordsScanned < 50; i++) {
    const ch = bodyWithoutBom[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < bodyWithoutBom.length && bodyWithoutBom[i + 1] === '"') {
          i += 1;
        } else {
          inQuotes = false;
        }
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      hasCharsInRecord = true;
      continue;
    }

    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && i + 1 < bodyWithoutBom.length && bodyWithoutBom[i + 1] === "\n") {
        i += 1;
      }
      if (hasCharsInRecord) {
        for (const c of candidates) {
          perRecordCounts[c].push(curCounts[c]);
        }
        recordsScanned += 1;
      }
      curCounts = { ",": 0, ";": 0, "\t": 0 };
      hasCharsInRecord = false;
      continue;
    }

    hasCharsInRecord = true;
    if (ch === "," || ch === ";" || ch === "\t") {
      curCounts[ch] += 1;
    }
  }

  if (hasCharsInRecord && recordsScanned < 50) {
    for (const c of candidates) {
      perRecordCounts[c].push(curCounts[c]);
    }
  }

  interface CandidateScore {
    delim: ConcreteDelimiter;
    nonZeroRows: number;
    uniformPositive: boolean;
    totalCount: number;
  }

  const scores: CandidateScore[] = candidates.map((delim) => {
    const arr = perRecordCounts[delim];
    const nonZeroRows = arr.filter((n) => n > 0).length;
    const totalCount = arr.reduce((a, b) => a + b, 0);
    const first = arr[0] ?? 0;
    const uniformPositive = arr.length > 0 && first > 0 && arr.every((n) => n === first);
    return { delim, nonZeroRows, uniformPositive, totalCount };
  });

  const active = scores.filter((s) => s.totalCount > 0);
  if (active.length === 0) {
    // Single-column input or no candidate delimiters outside quotes -> comma fallback, marked ambiguous
    return { delimiter: ",", ambiguous: true };
  }

  active.sort((a, b) => {
    if (a.uniformPositive !== b.uniformPositive) {
      return a.uniformPositive ? -1 : 1;
    }
    if (a.nonZeroRows !== b.nonZeroRows) {
      return b.nonZeroRows - a.nonZeroRows;
    }
    return b.totalCount - a.totalCount;
  });

  const best = active[0]!;
  const second = active[1];
  const ambiguous =
    second !== undefined &&
    second.uniformPositive === best.uniformPositive &&
    second.nonZeroRows === best.nonZeroRows &&
    second.totalCount === best.totalCount;

  return {
    delimiter: best.delim,
    ambiguous,
  };
}

/**
 * Strict RFC 4180 state-machine CSV parser.
 * - Preserves leading/trailing spaces inside unquoted and quoted cells.
 * - Preserves embedded CR/LF/CRLF inside quoted cells verbatim.
 * - Strips leading U+FEFF UTF-8 BOM once before parsing so quoted first headers work cleanly.
 * - Tracks both 1-based `physicalLine` and 1-based logical `recordNumber`.
 */
export function parseCsvRecords(
  rawText: string,
  delimiterOption: CsvDelimiter,
  budgetOverrides?: TabularBudgetOverrides,
):
  | { ok: true; data: ParsedCsvData }
  | {
      ok: false;
      code: string;
      message: string;
      physicalLine: number;
      column: number;
      recordNumber: number;
    } {
  const budgets = resolveBudgets(budgetOverrides);
  const hadLeadingBom = rawText.charCodeAt(0) === 0xfeff;
  const text = hadLeadingBom ? rawText.slice(1) : rawText;

  const autoResult =
    delimiterOption === "auto"
      ? detectCsvDelimiter(text)
      : { delimiter: delimiterOption, ambiguous: false };
  const sep = autoResult.delimiter;

  if (text.length === 0) {
    return {
      ok: true,
      data: {
        rows: [],
        recordPhysicalLines: [],
        detectedDelimiter: sep,
        delimiterAmbiguous: autoResult.ambiguous,
        hadLeadingBom,
      },
    };
  }

  const rows: string[][] = [];
  const recordPhysicalLines: number[] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let afterClosingQuote = false;
  let fieldStarted = false;

  let physicalLine = 1;
  let col = 1;
  let recordStartPhysicalLine = 1;
  let quoteOpenLine = 1;
  let quoteOpenCol = 1;
  let quoteOpenRecord = 1;
  let totalCells = 0;

  const pushCompletedRow = ():
    | { ok: true }
    | {
        ok: false;
        code: string;
        message: string;
        physicalLine: number;
        column: number;
        recordNumber: number;
      } => {
    row.push(field);
    totalCells += row.length;
    if (row.length > budgets.maxColumns) {
      return {
        ok: false,
        code: "COLUMN_LIMIT_EXCEEDED",
        message: `Row exceeds maximum column limit (${budgets.maxColumns.toLocaleString()} columns).`,
        physicalLine: recordStartPhysicalLine,
        column: 1,
        recordNumber: rows.length + 1,
      };
    }
    if (rows.length + 1 > budgets.maxRows) {
      return {
        ok: false,
        code: "ROW_LIMIT_EXCEEDED",
        message: `Input exceeds maximum row limit (${budgets.maxRows.toLocaleString()} rows).`,
        physicalLine: recordStartPhysicalLine,
        column: 1,
        recordNumber: rows.length + 1,
      };
    }
    if (totalCells > budgets.maxCells) {
      return {
        ok: false,
        code: "CELL_BUDGET_EXCEEDED",
        message: `Input exceeds maximum cell budget (${budgets.maxCells.toLocaleString()} cells).`,
        physicalLine: recordStartPhysicalLine,
        column: 1,
        recordNumber: rows.length + 1,
      };
    }
    rows.push(row);
    recordPhysicalLines.push(recordStartPhysicalLine);
    row = [];
    field = "";
    afterClosingQuote = false;
    fieldStarted = false;
    return { ok: true };
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          field += '"';
          i += 2;
          col += 2;
          continue;
        }
        inQuotes = false;
        afterClosingQuote = true;
        i += 1;
        col += 1;
        continue;
      }

      if (ch === "\r") {
        if (i + 1 < text.length && text[i + 1] === "\n") {
          field += "\r\n";
          i += 2;
        } else {
          field += "\r";
          i += 1;
        }
        physicalLine += 1;
        col = 1;
        continue;
      }

      if (ch === "\n") {
        field += "\n";
        i += 1;
        physicalLine += 1;
        col = 1;
        continue;
      }

      field += ch;
      i += 1;
      col += 1;
      continue;
    }

    // Outside quotes
    if (afterClosingQuote) {
      if (ch === sep) {
        row.push(field);
        field = "";
        afterClosingQuote = false;
        fieldStarted = false;
        i += 1;
        col += 1;
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        const pushed = pushCompletedRow();
        if (!pushed.ok) return pushed;
        if (ch === "\r" && i + 1 < text.length && text[i + 1] === "\n") {
          i += 2;
        } else {
          i += 1;
        }
        physicalLine += 1;
        col = 1;
        recordStartPhysicalLine = physicalLine;
        continue;
      }
      return {
        ok: false,
        code: "INVALID_CHAR_AFTER_CLOSING_QUOTE",
        message: `Unexpected character '${ch}' after closing double-quote (expected delimiter or newline).`,
        physicalLine,
        column: col,
        recordNumber: rows.length + 1,
      };
    }

    if (ch === '"') {
      if (!fieldStarted && field.length === 0) {
        inQuotes = true;
        fieldStarted = true;
        quoteOpenLine = physicalLine;
        quoteOpenCol = col;
        quoteOpenRecord = rows.length + 1;
        i += 1;
        col += 1;
        continue;
      }
      return {
        ok: false,
        code: "UNEXPECTED_QUOTE_IN_UNQUOTED_FIELD",
        message: "Unexpected double-quote inside unquoted CSV field.",
        physicalLine,
        column: col,
        recordNumber: rows.length + 1,
      };
    }

    if (ch === sep) {
      row.push(field);
      field = "";
      fieldStarted = false;
      i += 1;
      col += 1;
      continue;
    }

    if (ch === "\r" || ch === "\n") {
      const pushed = pushCompletedRow();
      if (!pushed.ok) return pushed;
      if (ch === "\r" && i + 1 < text.length && text[i + 1] === "\n") {
        i += 2;
      } else {
        i += 1;
      }
      physicalLine += 1;
      col = 1;
      recordStartPhysicalLine = physicalLine;
      continue;
    }

    fieldStarted = true;
    field += ch;
    i += 1;
    col += 1;
  }

  if (inQuotes) {
    return {
      ok: false,
      code: "UNTERMINATED_QUOTED_FIELD",
      message: `Unterminated quoted field starting at line ${quoteOpenLine}, column ${quoteOpenCol}.`,
      physicalLine: quoteOpenLine,
      column: quoteOpenCol,
      recordNumber: quoteOpenRecord,
    };
  }

  if (fieldStarted || afterClosingQuote || row.length > 0) {
    const pushed = pushCompletedRow();
    if (!pushed.ok) return pushed;
  }

  return {
    ok: true,
    data: {
      rows,
      recordPhysicalLines,
      detectedDelimiter: sep,
      delimiterAmbiguous: autoResult.ambiguous,
      hadLeadingBom,
    },
  };
}

const CANONICAL_JSON_NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const PLAIN_NEGATIVE_DECIMAL_RE = /^-(?:0|[1-9]\d*)(?:\.\d+)?$/;

/**
 * Converts a CSV cell string into a raw JSON value literal WITHOUT losing precision
 * (`9007199254740993`, `19.90`, `00123`, leading/trailing whitespace).
 */
function csvCellToRawJsonLiteral(
  cell: string,
  detectTypes: boolean,
  emptyCellsAsNull: boolean,
): string {
  if (!detectTypes) {
    return JSON.stringify(cell);
  }

  if (cell.length === 0) {
    return emptyCellsAsNull ? "null" : '""';
  }

  // Significant leading/trailing spaces must never be stripped into numbers/booleans
  if (cell.trim() !== cell) {
    return JSON.stringify(cell);
  }

  if (cell === "true" || cell === "false" || cell === "null") {
    return cell;
  }

  // Canonical RFC 8259 numbers have NO leading zeros (`00123` fails `(?:0|[1-9]\d*)` and stays `"00123"`)
  if (CANONICAL_JSON_NUMBER_RE.test(cell)) {
    return cell;
  }

  return JSON.stringify(cell);
}

/**
 * Checks whether a cell string is potentially interpreted as a formula by desktop spreadsheets
 * (`=`, `+`, `@`, `\t`, `\r`, or `-` when NOT a plain negative decimal number like `-42.5`).
 */
export function isSpreadsheetFormulaRisk(value: string, isGenuineNumber: boolean): boolean {
  if (isGenuineNumber || value.length === 0) {
    return false;
  }
  const first = value.charCodeAt(0);
  if (
    first === 0x3d /* = */ ||
    first === 0x2b /* + */ ||
    first === 0x40 /* @ */ ||
    first === 0x09 /* \t */ ||
    first === 0x0d /* \r */
  ) {
    return true;
  }
  if (first === 0x2d /* - */) {
    // Plain negative decimal numbers (e.g. `-42`, `-3.14`) are genuine negative values, not formulas
    return !PLAIN_NEGATIVE_DECIMAL_RE.test(value);
  }
  return false;
}

export function escapeCsvCell(raw: string, sep: ConcreteDelimiter): string {
  if (raw.includes('"') || raw.includes(sep) || raw.includes("\n") || raw.includes("\r")) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

export interface CsvCellInput {
  text: string;
  isGenuineNumber: boolean;
}

/**
 * Reusable RFC 4180 CSV serializer with optional `'` spreadsheet formula protection
 * and incremental UTF-8 byte budget enforcement (aborts immediately upon crossing `maxOutputBytes`).
 * Shared by `D14` (`json_to_csv`) and `D10` (batch coordinate CSV export).
 */
export function serializeTableToCsvBounded(params: {
  headers: readonly string[];
  rows: readonly (readonly CsvCellInput[])[];
  includeHeaderRow: boolean;
  delimiter: ConcreteDelimiter;
  lineEnding: "\n" | "\r\n";
  includeBom: boolean;
  formulaProtection: boolean;
  maxOutputBytes: number;
  onRowSerialized?: (rowIndexZeroBased: number) => void;
}):
  | {
      ok: true;
      csvText: string;
      byteLength: number;
      formulaLikeCellCount: number;
      formulaProtectedCount: number;
      formulaPreviewSamples: FormulaPreviewSample[];
      previewRows: string[][];
    }
  | { ok: false; code: "OUTPUT_LIMIT_EXCEEDED"; message: string } {
  const {
    headers,
    rows,
    includeHeaderRow,
    delimiter,
    lineEnding,
    includeBom,
    formulaProtection,
    maxOutputBytes,
    onRowSerialized,
  } = params;

  const limitErr = (): { ok: false; code: "OUTPUT_LIMIT_EXCEEDED"; message: string } => {
    const e = makeOutputLimitError(maxOutputBytes);
    return {
      ok: false,
      code: "OUTPUT_LIMIT_EXCEEDED",
      message: e.status === "error" ? e.message : "Output limit exceeded.",
    };
  };

  let formulaLikeCellCount = 0;
  let formulaProtectedCount = 0;
  const formulaPreviewSamples: FormulaPreviewSample[] = [];
  const builder = new BoundedUtf8Builder(maxOutputBytes);

  if (includeBom && !builder.append("\uFEFF")) {
    return limitErr();
  }

  headers.forEach((h) => {
    if (isSpreadsheetFormulaRisk(h, false)) {
      formulaLikeCellCount += 1;
      if (formulaProtection && includeHeaderRow) {
        formulaProtectedCount += 1;
      }
      if (formulaPreviewSamples.length < 5) {
        formulaPreviewSamples.push({
          rowNumber: 0,
          columnName: h,
          original: h,
          protectedValue: `'${h}`,
        });
      }
    }
  });

  if (includeHeaderRow) {
    for (let c = 0; c < headers.length; c++) {
      if (c > 0 && !builder.append(delimiter)) {
        return limitErr();
      }
      const rawH = headers[c] ?? "";
      const val = formulaProtection && isSpreadsheetFormulaRisk(rawH, false) ? `'${rawH}` : rawH;
      if (!builder.append(escapeCsvCell(val, delimiter))) {
        return limitErr();
      }
    }
  }

  const previewRows: string[][] = [];
  const previewColCap = Math.min(headers.length, MAX_PREVIEW_TABLE_COLS);

  for (let rIdx = 0; rIdx < rows.length; rIdx++) {
    if ((includeHeaderRow || rIdx > 0) && !builder.append(lineEnding)) {
      return limitErr();
    }
    const row = rows[rIdx]!;
    const collectPreview = rIdx < MAX_PREVIEW_TABLE_ROWS;
    const previewRow: string[] = collectPreview ? [] : [];

    for (let cIdx = 0; cIdx < headers.length; cIdx++) {
      if (cIdx > 0 && !builder.append(delimiter)) {
        return limitErr();
      }
      const cell = row[cIdx] ?? { text: "", isGenuineNumber: false };
      const risky = isSpreadsheetFormulaRisk(cell.text, cell.isGenuineNumber);
      if (risky) {
        formulaLikeCellCount += 1;
        if (formulaProtection) {
          formulaProtectedCount += 1;
        }
        if (formulaPreviewSamples.length < 5) {
          formulaPreviewSamples.push({
            rowNumber: rIdx + 1,
            columnName: headers[cIdx] ?? `column_${cIdx + 1}`,
            original: cell.text,
            protectedValue: `'${cell.text}`,
          });
        }
      }
      const val = formulaProtection && risky ? `'${cell.text}` : cell.text;
      if (collectPreview && cIdx < previewColCap) {
        previewRow.push(val);
      }
      if (!builder.append(escapeCsvCell(val, delimiter))) {
        return limitErr();
      }
    }

    if (collectPreview) {
      previewRows.push(previewRow);
    }
    onRowSerialized?.(rIdx);
  }

  return {
    ok: true,
    csvText: builder.build(),
    byteLength: builder.byteLength,
    formulaLikeCellCount,
    formulaProtectedCount,
    formulaPreviewSamples,
    previewRows,
  };
}

function serializeAstCompactLossless(node: JsonAstNode): string {
  switch (node.kind) {
    case "null":
      return "null";
    case "boolean":
      return node.value ? "true" : "false";
    case "number":
      return node.rawLiteral;
    case "string":
      return node.rawLiteral;
    case "array":
      return `[${node.items.map(serializeAstCompactLossless).join(",")}]`;
    case "object":
      return `{${node.entries
        .map((e) => `${e.keyRaw}:${serializeAstCompactLossless(e.value)}`)
        .join(",")}}`;
  }
}

type FlattenedCell = CsvCellInput;

function formatColumnPath(segments: readonly string[], policy: PathConflictPolicy): string {
  if (policy === "error") {
    return segments.join(".");
  }
  return segments
    .map((seg, idx) => {
      if (seg.includes(".") || seg.includes("[") || seg.includes("]") || seg.length === 0) {
        return `[${JSON.stringify(seg)}]`;
      }
      return idx === 0 ? seg : `.${seg}`;
    })
    .join("");
}

function escapeMarkdownCell(raw: string): string {
  return raw
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r\n|\r|\n/g, "<br>");
}

function buildMarkdownTableBounded(
  headers: readonly string[],
  rows: readonly string[][],
  maxOutputBytes: number,
  onRowSerialized?: (rowIndexZeroBased: number) => void,
): { ok: true; mdText: string } | { ok: false } {
  const escapedHeaders = headers.map(escapeMarkdownCell);
  const widths = escapedHeaders.map((h) => Math.max(3, h.length));

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    for (let c = 0; c < headers.length; c++) {
      if (widths[c]! >= 64) continue;
      const cellLen = escapeMarkdownCell(row[c] ?? "").length;
      if (cellLen > widths[c]!) {
        widths[c] = Math.min(cellLen, 64);
      }
    }
  }

  const builder = new BoundedUtf8Builder(maxOutputBytes);

  if (!builder.append("| ")) return { ok: false };
  for (let c = 0; c < escapedHeaders.length; c++) {
    if (c > 0 && !builder.append(" | ")) return { ok: false };
    if (!builder.append(escapedHeaders[c]!.padEnd(widths[c]!))) return { ok: false };
  }
  if (!builder.append(" |\n| ")) return { ok: false };
  for (let c = 0; c < widths.length; c++) {
    if (c > 0 && !builder.append(" | ")) return { ok: false };
    if (!builder.append("-".repeat(widths[c]!))) return { ok: false };
  }
  if (!builder.append(" |")) return { ok: false };

  for (let r = 0; r < rows.length; r++) {
    if (!builder.append("\n| ")) return { ok: false };
    const row = rows[r]!;
    for (let c = 0; c < headers.length; c++) {
      if (c > 0 && !builder.append(" | ")) return { ok: false };
      const escaped = escapeMarkdownCell(row[c] ?? "");
      if (!builder.append(escaped.padEnd(widths[c]!))) return { ok: false };
    }
    if (!builder.append(" |")) return { ok: false };
    onRowSerialized?.(r);
  }

  return { ok: true, mdText: builder.build() };
}

function resolveHeadersOrError(
  rawHeaders: readonly string[],
  policy: HeaderIssuePolicy,
):
  | { ok: true; headers: string[]; renamed: RenamedHeaderInfo[] }
  | { ok: false; code: string; message: string } {
  const seen = new Map<string, number>();
  const emptyCols: number[] = [];
  const dupDetails: string[] = [];

  rawHeaders.forEach((h, idx) => {
    const colNum = idx + 1;
    if (h.trim().length === 0) {
      emptyCols.push(colNum);
    }
    const firstCol = seen.get(h);
    if (firstCol !== undefined) {
      dupDetails.push(`"${h}" (columns ${firstCol} & ${colNum})`);
    } else {
      seen.set(h, colNum);
    }
  });

  if (emptyCols.length === 0 && dupDetails.length === 0) {
    return { ok: true, headers: [...rawHeaders], renamed: [] };
  }

  if (policy === "error") {
    const parts: string[] = [];
    if (emptyCols.length > 0) {
      parts.push(`empty header at column(s) ${emptyCols.join(", ")}`);
    }
    if (dupDetails.length > 0) {
      parts.push(`duplicate header(s) ${dupDetails.join(", ")}`);
    }
    return {
      ok: false,
      code: "HEADER_CONFLICT",
      message: `Invalid CSV header row (${parts.join("; ")}). Enable header auto-rename or disable First Row Headers.`,
    };
  }

  // `policy === "rename"`
  const used = new Set<string>();
  const resolved: string[] = [];
  const renamed: RenamedHeaderInfo[] = [];

  rawHeaders.forEach((orig, idx) => {
    const colNum = idx + 1;
    const base = orig.trim().length === 0 ? `column_${colNum}` : orig;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    resolved.push(candidate);
    if (candidate !== orig) {
      renamed.push({
        columnIndex: colNum,
        original: orig,
        renamedTo: candidate,
      });
    }
  });

  return { ok: true, headers: resolved, renamed };
}

function finalizeResult(
  params: {
    fullOutput: string;
    rowCount: number;
    columnCount: number;
    detectedDelimiter: ConcreteDelimiter | null;
    delimiterAmbiguous: boolean;
    hadInputBom: boolean;
    formulaLikeCellCount: number;
    formulaProtectedCount: number;
    formulaPreviewSamples: FormulaPreviewSample[];
    renamedHeaders: RenamedHeaderInfo[];
    paddedRowCount: number;
    extendedColumnCount: number;
    ambiguousScalarArrayCount: number;
    depthCappedCellCount: number;
    singleObjectNormalized: boolean;
    tableHeaders: readonly string[];
    tableRows: readonly string[][];
    tableTotalRowCount?: number;
  },
  maxOutputBytes: number,
): TabularConversionResult {
  const outBytes = utf8ByteLength(params.fullOutput);
  if (outBytes > maxOutputBytes) {
    return makeOutputLimitError(maxOutputBytes);
  }

  const previewTruncated = params.fullOutput.length > MAX_PREVIEW_CHARS;
  const previewOutput = previewTruncated
    ? params.fullOutput.slice(0, MAX_PREVIEW_CHARS)
    : params.fullOutput;

  const actualTableRowCount = params.tableTotalRowCount ?? params.tableRows.length;
  const tablePreviewTruncated =
    actualTableRowCount > MAX_PREVIEW_TABLE_ROWS ||
    params.tableHeaders.length > MAX_PREVIEW_TABLE_COLS;
  const tablePreviewHeaders = params.tableHeaders.slice(0, MAX_PREVIEW_TABLE_COLS);
  const tablePreviewRows = params.tableRows
    .slice(0, MAX_PREVIEW_TABLE_ROWS)
    .map((r) => tablePreviewHeaders.map((_, i) => r[i] ?? ""));

  return {
    status: "ok",
    fullOutput: params.fullOutput,
    previewOutput,
    previewTruncated,
    rowCount: params.rowCount,
    columnCount: params.columnCount,
    detectedDelimiter: params.detectedDelimiter,
    delimiterAmbiguous: params.delimiterAmbiguous,
    hadInputBom: params.hadInputBom,
    formulaLikeCellCount: params.formulaLikeCellCount,
    formulaProtectedCount: params.formulaProtectedCount,
    formulaPreviewSamples: params.formulaPreviewSamples,
    renamedHeaders: params.renamedHeaders,
    paddedRowCount: params.paddedRowCount,
    extendedColumnCount: params.extendedColumnCount,
    ambiguousScalarArrayCount: params.ambiguousScalarArrayCount,
    depthCappedCellCount: params.depthCappedCellCount,
    singleObjectNormalized: params.singleObjectNormalized,
    tablePreviewHeaders,
    tablePreviewRows,
    tablePreviewTruncated,
  };
}

/**
 * Header-counting & cell-budget rule:
 * Any header row present in the input CSV (`firstRowHeaders: true`) or synthesized/emitted as a
 * table header row in the output (`csv_to_md`, `json_to_md`, or `json_to_csv` with `firstRowHeaders: true`)
 * counts as 1 row toward the materialized table cell budget (`totalMaterializedRows * columnCount <= maxCells`);
 * when neither input nor output has a header row (`csv_to_json` or `json_to_csv` with `firstRowHeaders: false`),
 * `dataRowCount * columnCount <= maxCells`. Checked BEFORE padding/allocating matrices.
 */
export function convertTabularData(
  rawInput: string,
  options: CsvJsonOptions,
  budgetOverrides?: TabularBudgetOverrides,
): TabularConversionResult {
  const budgets = resolveBudgets(budgetOverrides);
  const strippedCheck = rawInput.charCodeAt(0) === 0xfeff ? rawInput.slice(1) : rawInput;
  if (strippedCheck.length === 0) {
    return { status: "empty" };
  }

  const inputBytes = utf8ByteLength(rawInput);
  if (inputBytes > budgets.maxInputBytes) {
    return {
      status: "error",
      code: "SIZE_LIMIT_EXCEEDED",
      message: `Input size (${(inputBytes / (1024 * 1024)).toFixed(2)} MiB) exceeds the 8 MiB limit.`,
    };
  }

  if (options.direction === "csv_to_json" || options.direction === "csv_to_md") {
    return convertFromCsv(rawInput, options, budgets);
  }
  return convertFromJson(rawInput, options, budgets);
}

function convertFromCsv(
  rawInput: string,
  options: CsvJsonOptions,
  budgets: ResolvedTabularBudgets,
): TabularConversionResult {
  const parsed = parseCsvRecords(rawInput, options.delimiter, budgets);
  if (!parsed.ok) {
    return {
      status: "error",
      code: parsed.code,
      message: parsed.message,
      physicalLine: parsed.physicalLine,
      column: parsed.column,
      recordNumber: parsed.recordNumber,
    };
  }

  const { rows, recordPhysicalLines, detectedDelimiter, delimiterAmbiguous, hadLeadingBom } =
    parsed.data;

  if (rows.length === 0) {
    return { status: "empty" };
  }

  const headerPolicy = options.headerIssuePolicy ?? "error";
  const raggedPolicy = options.raggedRowPolicy ?? "error";
  const emptyAsNull = Boolean(options.emptyCellsAsNull);

  const baseCols = rows[0]!.length;
  let maxCols = baseCols;
  let paddedRowCount = 0;

  for (let r = 0; r < rows.length; r++) {
    const len = rows[r]!.length;
    if (len !== baseCols) {
      if (raggedPolicy === "error") {
        return {
          status: "error",
          code: "INCONSISTENT_COLUMN_COUNT",
          message: `Record #${r + 1} (physical line ${recordPhysicalLines[r] ?? r + 1}) has ${len} column(s), expected ${baseCols}.`,
          physicalLine: recordPhysicalLines[r] ?? r + 1,
          column: 1,
          recordNumber: r + 1,
        };
      }
      if (len < baseCols) {
        paddedRowCount += 1;
      } else if (len > maxCols) {
        maxCols = len;
      }
    }
  }

  // Enforce final matrix dimensions & cell budget BEFORE allocating headers or padding rows!
  if (maxCols > budgets.maxColumns) {
    return {
      status: "error",
      code: "COLUMN_LIMIT_EXCEEDED",
      message: `Normalized column count (${maxCols.toLocaleString()}) exceeds ${budgets.maxColumns.toLocaleString()} columns.`,
    };
  }

  const totalMaterializedRows =
    options.direction === "csv_to_md" && !options.firstRowHeaders ? rows.length + 1 : rows.length;
  const totalMaterializedCells = totalMaterializedRows * maxCols;
  if (totalMaterializedCells > budgets.maxCells) {
    return {
      status: "error",
      code: "CELL_BUDGET_EXCEEDED",
      message: `Normalized table (${totalMaterializedRows.toLocaleString()} rows × ${maxCols.toLocaleString()} columns = ${totalMaterializedCells.toLocaleString()} cells) exceeds the ${budgets.maxCells.toLocaleString()}-cell budget.`,
    };
  }

  const extendedColumnCount = Math.max(0, maxCols - baseCols);
  let headers: string[] = [];
  let renamedHeaders: RenamedHeaderInfo[] = [];
  let dataRows: string[][];

  if (options.firstRowHeaders) {
    const rawHeaderRow = [...rows[0]!];
    for (let extra = baseCols + 1; extra <= maxCols; extra++) {
      rawHeaderRow.push(`extra_col_${extra}`);
    }
    const resolved = resolveHeadersOrError(rawHeaderRow, headerPolicy);
    if (!resolved.ok) {
      return {
        status: "error",
        code: resolved.code,
        message: resolved.message,
        physicalLine: recordPhysicalLines[0] ?? 1,
        column: 1,
        recordNumber: 1,
      };
    }
    headers = resolved.headers;
    renamedHeaders = resolved.renamed;
    dataRows = rows.slice(1).map((r) => {
      if (r.length >= maxCols) return r;
      const copy = [...r];
      while (copy.length < maxCols) copy.push("");
      return copy;
    });
  } else {
    headers = Array.from({ length: maxCols }, (_, idx) => `column_${idx + 1}`);
    dataRows = rows.map((r) => {
      if (r.length >= maxCols) return r;
      const copy = [...r];
      while (copy.length < maxCols) copy.push("");
      return copy;
    });
  }

  // Count formula-like strings in CSV cells for informational awareness
  let formulaLikeCellCount = 0;
  const formulaPreviewSamples: FormulaPreviewSample[] = [];
  dataRows.forEach((row, rIdx) => {
    row.forEach((cell, cIdx) => {
      const isNum = CANONICAL_JSON_NUMBER_RE.test(cell.trim()) && cell.trim() === cell;
      if (isSpreadsheetFormulaRisk(cell, isNum)) {
        formulaLikeCellCount += 1;
        if (formulaPreviewSamples.length < 5) {
          formulaPreviewSamples.push({
            rowNumber: rIdx + 1,
            columnName: headers[cIdx] ?? `column_${cIdx + 1}`,
            original: cell,
            protectedValue: `'${cell}`,
          });
        }
      }
    });
  });

  if (options.direction === "csv_to_md") {
    const mdRes = buildMarkdownTableBounded(
      headers,
      dataRows,
      budgets.maxOutputBytes,
      budgets.onRowSerialized,
    );
    if (!mdRes.ok) {
      return makeOutputLimitError(budgets.maxOutputBytes);
    }
    return finalizeResult(
      {
        fullOutput: mdRes.mdText,
        rowCount: dataRows.length,
        columnCount: maxCols,
        detectedDelimiter: options.delimiter === "auto" ? detectedDelimiter : null,
        delimiterAmbiguous,
        hadInputBom: hadLeadingBom,
        formulaLikeCellCount,
        formulaProtectedCount: 0,
        formulaPreviewSamples,
        renamedHeaders,
        paddedRowCount,
        extendedColumnCount,
        ambiguousScalarArrayCount: 0,
        depthCappedCellCount: 0,
        singleObjectNormalized: false,
        tableHeaders: headers,
        tableRows: dataRows,
      },
      budgets.maxOutputBytes,
    );
  }

  // `csv_to_json` — prototype-safe lossless JSON emission with incremental UTF-8 byte budget
  if (dataRows.length === 0) {
    return finalizeResult(
      {
        fullOutput: "[]",
        rowCount: 0,
        columnCount: maxCols,
        detectedDelimiter: options.delimiter === "auto" ? detectedDelimiter : null,
        delimiterAmbiguous,
        hadInputBom: hadLeadingBom,
        formulaLikeCellCount: 0,
        formulaProtectedCount: 0,
        formulaPreviewSamples: [],
        renamedHeaders,
        paddedRowCount,
        extendedColumnCount,
        ambiguousScalarArrayCount: 0,
        depthCappedCellCount: 0,
        singleObjectNormalized: false,
        tableHeaders: headers,
        tableRows: [],
      },
      budgets.maxOutputBytes,
    );
  }

  const builder = new BoundedUtf8Builder(budgets.maxOutputBytes);
  if (!builder.append("[\n")) {
    return makeOutputLimitError(budgets.maxOutputBytes);
  }

  if (options.firstRowHeaders) {
    const keyPrefixes = headers.map((h) => `    ${JSON.stringify(h)}: `);
    for (let rIdx = 0; rIdx < dataRows.length; rIdx++) {
      if (rIdx > 0 && !builder.append(",\n")) {
        return makeOutputLimitError(budgets.maxOutputBytes);
      }
      if (!builder.append("  {\n")) {
        return makeOutputLimitError(budgets.maxOutputBytes);
      }
      const row = dataRows[rIdx]!;
      for (let cIdx = 0; cIdx < keyPrefixes.length; cIdx++) {
        if (cIdx > 0 && !builder.append(",\n")) {
          return makeOutputLimitError(budgets.maxOutputBytes);
        }
        if (!builder.append(keyPrefixes[cIdx]!)) {
          return makeOutputLimitError(budgets.maxOutputBytes);
        }
        const literal = csvCellToRawJsonLiteral(row[cIdx] ?? "", options.detectTypes, emptyAsNull);
        if (!builder.append(literal)) {
          return makeOutputLimitError(budgets.maxOutputBytes);
        }
      }
      if (!builder.append("\n  }")) {
        return makeOutputLimitError(budgets.maxOutputBytes);
      }
      budgets.onRowSerialized?.(rIdx);
    }
    if (!builder.append("\n]")) {
      return makeOutputLimitError(budgets.maxOutputBytes);
    }

    return finalizeResult(
      {
        fullOutput: builder.build(),
        rowCount: dataRows.length,
        columnCount: maxCols,
        detectedDelimiter: options.delimiter === "auto" ? detectedDelimiter : null,
        delimiterAmbiguous,
        hadInputBom: hadLeadingBom,
        formulaLikeCellCount,
        formulaProtectedCount: 0,
        formulaPreviewSamples,
        renamedHeaders,
        paddedRowCount,
        extendedColumnCount,
        ambiguousScalarArrayCount: 0,
        depthCappedCellCount: 0,
        singleObjectNormalized: false,
        tableHeaders: headers,
        tableRows: dataRows,
      },
      budgets.maxOutputBytes,
    );
  }

  for (let rIdx = 0; rIdx < dataRows.length; rIdx++) {
    if (rIdx > 0 && !builder.append(",\n")) {
      return makeOutputLimitError(budgets.maxOutputBytes);
    }
    if (!builder.append("  [")) {
      return makeOutputLimitError(budgets.maxOutputBytes);
    }
    const row = dataRows[rIdx]!;
    for (let cIdx = 0; cIdx < row.length; cIdx++) {
      if (cIdx > 0 && !builder.append(", ")) {
        return makeOutputLimitError(budgets.maxOutputBytes);
      }
      const literal = csvCellToRawJsonLiteral(row[cIdx] ?? "", options.detectTypes, emptyAsNull);
      if (!builder.append(literal)) {
        return makeOutputLimitError(budgets.maxOutputBytes);
      }
    }
    if (!builder.append("]")) {
      return makeOutputLimitError(budgets.maxOutputBytes);
    }
    budgets.onRowSerialized?.(rIdx);
  }
  if (!builder.append("\n]")) {
    return makeOutputLimitError(budgets.maxOutputBytes);
  }

  return finalizeResult(
    {
      fullOutput: builder.build(),
      rowCount: dataRows.length,
      columnCount: maxCols,
      detectedDelimiter: options.delimiter === "auto" ? detectedDelimiter : null,
      delimiterAmbiguous,
      hadInputBom: hadLeadingBom,
      formulaLikeCellCount,
      formulaProtectedCount: 0,
      formulaPreviewSamples,
      renamedHeaders,
      paddedRowCount,
      extendedColumnCount,
      ambiguousScalarArrayCount: 0,
      depthCappedCellCount: 0,
      singleObjectNormalized: false,
      tableHeaders: headers,
      tableRows: dataRows,
    },
    budgets.maxOutputBytes,
  );
}

function astScalarOrComplexToCell(
  node: JsonAstNode,
  arrayMode: JsonArrayCellMode,
  counters: { ambiguousScalarArrays: number; depthCapped: number },
): FlattenedCell {
  switch (node.kind) {
    case "null":
      return { text: "", isGenuineNumber: false };
    case "boolean":
      return { text: node.value ? "true" : "false", isGenuineNumber: false };
    case "number":
      return { text: node.rawLiteral, isGenuineNumber: true };
    case "string":
      return { text: node.decoded, isGenuineNumber: false };
    case "object":
      return { text: serializeAstCompactLossless(node), isGenuineNumber: false };
    case "array": {
      const allPlainScalars = node.items.every(
        (it) =>
          it.kind === "string" ||
          it.kind === "number" ||
          it.kind === "boolean" ||
          it.kind === "null",
      );
      if (!allPlainScalars || arrayMode === "compact_json") {
        return { text: serializeAstCompactLossless(node), isGenuineNumber: false };
      }

      if (node.items.length === 0) {
        counters.ambiguousScalarArrays += 1;
        return { text: "", isGenuineNumber: false };
      }

      let hasAmbiguity = false;
      const parts = node.items.map((it) => {
        if (it.kind === "null") {
          hasAmbiguity = true;
          return "";
        }
        if (it.kind === "boolean") {
          return it.value ? "true" : "false";
        }
        if (it.kind === "number") {
          return it.rawLiteral;
        }
        if (it.kind === "string") {
          if (
            it.decoded.length === 0 ||
            it.decoded.includes(";") ||
            it.decoded.includes("\n") ||
            it.decoded.includes("\r")
          ) {
            hasAmbiguity = true;
          }
          return it.decoded;
        }
        return serializeAstCompactLossless(it);
      });

      if (hasAmbiguity) {
        counters.ambiguousScalarArrays += 1;
      }
      return { text: parts.join(";"), isGenuineNumber: false };
    }
  }
}

function convertFromJson(
  rawInput: string,
  options: CsvJsonOptions,
  budgets: ResolvedTabularBudgets,
): TabularConversionResult {
  const hadLeadingBom = rawInput.charCodeAt(0) === 0xfeff;
  if (rawInput.trim().length === 0) {
    return { status: "empty" };
  }

  const parsedAst = parseLosslessJsonAst(rawInput);
  if (parsedAst.status === "invalid") {
    return {
      status: "error",
      code: "INVALID_JSON",
      message: parsedAst.error.message,
      physicalLine: parsedAst.error.line,
      column: parsedAst.error.column,
    };
  }

  const root = parsedAst.ast;
  const arrayMode = options.arrayMode ?? "semicolon";
  const pathPolicy = options.pathConflictPolicy ?? "error";
  const sep: ConcreteDelimiter = options.delimiter === "auto" ? "," : options.delimiter;
  const lineEnding = options.csvLineEnding === "crlf" ? "\r\n" : "\n";
  const counters = { ambiguousScalarArrays: 0, depthCapped: 0 };

  let recordsAst: JsonAstNode[];
  let singleObjectNormalized = false;

  if (root.kind === "object") {
    recordsAst = [root];
    singleObjectNormalized = true;
  } else if (root.kind === "array") {
    if (root.items.length === 0) {
      return {
        status: "error",
        code: "EMPTY_JSON_ARRAY",
        message: "JSON array is empty ([] — 0 records and 0 columns to export).",
      };
    }
    recordsAst = root.items;
  } else {
    return {
      status: "error",
      code: "UNSUPPORTED_JSON_ROOT",
      message: `JSON root is a scalar (${root.kind}); expected an array of objects, array of row arrays, or a single object.`,
    };
  }

  if (recordsAst.length > budgets.maxRows) {
    return {
      status: "error",
      code: "ROW_LIMIT_EXCEEDED",
      message: `JSON array (${recordsAst.length.toLocaleString()} items) exceeds the ${budgets.maxRows.toLocaleString()}-row limit.`,
    };
  }

  const hasExportedHeader = options.direction === "json_to_md" || Boolean(options.firstRowHeaders);
  const totalMaterializedRows = recordsAst.length + (hasExportedHeader ? 1 : 0);

  const firstKind = recordsAst[0]!.kind;
  if (firstKind !== "object" && firstKind !== "array") {
    return {
      status: "error",
      code: "UNSUPPORTED_JSON_ITEM",
      message: `JSON array element #1 is a primitive (${firstKind}); expected objects or row arrays.`,
    };
  }

  for (let idx = 1; idx < recordsAst.length; idx++) {
    if (recordsAst[idx]!.kind !== firstKind) {
      return {
        status: "error",
        code: "MIXED_JSON_ARRAY_ITEMS",
        message: `JSON array mixes ${firstKind} and ${recordsAst[idx]!.kind} at element #${idx + 1}; all rows must share the same structure.`,
      };
    }
  }

  let headers: string[];
  let cellMatrix: FlattenedCell[][];

  if (firstKind === "array") {
    // Array of arrays `[[...], [...]]`
    let maxLen = 0;
    for (const item of recordsAst) {
      if (item.kind === "array" && item.items.length > maxLen) {
        maxLen = item.items.length;
      }
    }
    if (maxLen === 0) {
      return {
        status: "error",
        code: "EMPTY_ROW_ARRAYS",
        message: "JSON row arrays contain 0 columns.",
      };
    }
    if (maxLen > budgets.maxColumns) {
      return {
        status: "error",
        code: "COLUMN_LIMIT_EXCEEDED",
        message: `Column count (${maxLen.toLocaleString()}) exceeds ${budgets.maxColumns.toLocaleString()}.`,
      };
    }
    if (totalMaterializedRows * maxLen > budgets.maxCells) {
      return {
        status: "error",
        code: "CELL_BUDGET_EXCEEDED",
        message: `Total table cells (${(totalMaterializedRows * maxLen).toLocaleString()}) exceed ${budgets.maxCells.toLocaleString()}.`,
      };
    }

    headers = Array.from({ length: maxLen }, (_, i) => `column_${i + 1}`);
    cellMatrix = recordsAst.map((item) => {
      const arr = item.kind === "array" ? item.items : [];
      return headers.map((_, colIdx) => {
        const node = arr[colIdx];
        if (!node) return { text: "", isGenuineNumber: false };
        return astScalarOrComplexToCell(node, arrayMode, counters);
      });
    });
  } else {
    // Array of objects `[{...}, {...}]` — prototype-safe `Map` throughout!
    // Map formatted column name -> canonical segment tuple JSON signature to catch path collisions
    const colProvenance = new Map<string, string>();
    const orderedColumns: string[] = [];
    const rowMaps: Array<Map<string, FlattenedCell>> = [];

    const flattenNodeIntoRow = (
      objNode: Extract<JsonAstNode, { kind: "object" }>,
      prefixSegments: readonly string[],
      depth: number,
      rowMap: Map<string, FlattenedCell>,
      recordIdx: number,
    ): { ok: true } | { ok: false; code: string; message: string } => {
      const seenKeysInThisObject = new Set<string>();
      for (const entry of objNode.entries) {
        if (seenKeysInThisObject.has(entry.keyDecoded)) {
          return {
            ok: false,
            code: "DUPLICATE_JSON_OBJECT_KEY",
            message: `Record #${recordIdx + 1} contains duplicate object key ${JSON.stringify(entry.keyDecoded)}, which would overwrite data.`,
          };
        }
        seenKeysInThisObject.add(entry.keyDecoded);

        const nextSegments = [...prefixSegments, entry.keyDecoded];
        const val = entry.value;

        if (val.kind === "object" && val.entries.length > 0 && depth + 1 < MAX_NESTED_DEPTH) {
          const sub = flattenNodeIntoRow(val, nextSegments, depth + 1, rowMap, recordIdx);
          if (!sub.ok) return sub;
          continue;
        }

        if (val.kind === "object" && val.entries.length > 0 && depth + 1 >= MAX_NESTED_DEPTH) {
          counters.depthCapped += 1;
        }

        const colName = formatColumnPath(nextSegments, pathPolicy);
        const provenanceSig = JSON.stringify(nextSegments);
        const existingSig = colProvenance.get(colName);

        if (existingSig !== undefined && existingSig !== provenanceSig) {
          return {
            ok: false,
            code: "PATH_COLLISION",
            message: `Column path collision on "${colName}": ${existingSig} conflicts with ${provenanceSig}. Enable bracket path escaping to keep both columns.`,
          };
        }

        if (existingSig === undefined) {
          const nextColCount = orderedColumns.length + 1;
          if (nextColCount > budgets.maxColumns) {
            return {
              ok: false,
              code: "COLUMN_LIMIT_EXCEEDED",
              message: `Flattened column count exceeds ${budgets.maxColumns.toLocaleString()}.`,
            };
          }
          if (totalMaterializedRows * nextColCount > budgets.maxCells) {
            return {
              ok: false,
              code: "CELL_BUDGET_EXCEEDED",
              message: `Flattened table (${(totalMaterializedRows * nextColCount).toLocaleString()} cells) exceeds the ${budgets.maxCells.toLocaleString()}-cell budget.`,
            };
          }
          colProvenance.set(colName, provenanceSig);
          orderedColumns.push(colName);
        }

        if (rowMap.has(colName)) {
          return {
            ok: false,
            code: "PATH_COLLISION",
            message: `Record #${recordIdx + 1} produces duplicate flattened column "${colName}".`,
          };
        }

        rowMap.set(colName, astScalarOrComplexToCell(val, arrayMode, counters));
      }
      return { ok: true };
    };

    for (let rIdx = 0; rIdx < recordsAst.length; rIdx++) {
      const obj = recordsAst[rIdx] as Extract<JsonAstNode, { kind: "object" }>;
      const rowMap = new Map<string, FlattenedCell>();
      if (obj.entries.length === 0) {
        // Preserve empty top-level object row without losing record count
        rowMaps.push(rowMap);
        continue;
      }
      const res = flattenNodeIntoRow(obj, [], 0, rowMap, rIdx);
      if (!res.ok) {
        return {
          status: "error",
          code: res.code,
          message: res.message,
          recordNumber: rIdx + 1,
        };
      }
      rowMaps.push(rowMap);
    }

    if (orderedColumns.length === 0) {
      orderedColumns.push("empty_object");
      for (const rm of rowMaps) {
        rm.set("empty_object", { text: "{}", isGenuineNumber: false });
      }
    }

    if (totalMaterializedRows * orderedColumns.length > budgets.maxCells) {
      return {
        status: "error",
        code: "CELL_BUDGET_EXCEEDED",
        message: `Flattened table (${(totalMaterializedRows * orderedColumns.length).toLocaleString()} cells) exceeds the ${budgets.maxCells.toLocaleString()}-cell budget.`,
      };
    }

    headers = orderedColumns;
    cellMatrix = rowMaps.map((rm) =>
      headers.map((col) => rm.get(col) ?? { text: "", isGenuineNumber: false }),
    );
  }

  if (options.direction === "json_to_md") {
    let formulaLikeCellCount = 0;
    const formulaPreviewSamples: FormulaPreviewSample[] = [];
    headers.forEach((h) => {
      if (isSpreadsheetFormulaRisk(h, false)) {
        formulaLikeCellCount += 1;
        if (formulaPreviewSamples.length < 5) {
          formulaPreviewSamples.push({
            rowNumber: 0,
            columnName: h,
            original: h,
            protectedValue: `'${h}`,
          });
        }
      }
    });
    cellMatrix.forEach((row, rIdx) => {
      row.forEach((cell, cIdx) => {
        if (isSpreadsheetFormulaRisk(cell.text, cell.isGenuineNumber)) {
          formulaLikeCellCount += 1;
          if (formulaPreviewSamples.length < 5) {
            formulaPreviewSamples.push({
              rowNumber: rIdx + 1,
              columnName: headers[cIdx] ?? `column_${cIdx + 1}`,
              original: cell.text,
              protectedValue: `'${cell.text}`,
            });
          }
        }
      });
    });

    const plainStringRows = cellMatrix.map((row) => row.map((c) => c.text));
    const mdRes = buildMarkdownTableBounded(
      headers,
      plainStringRows,
      budgets.maxOutputBytes,
      budgets.onRowSerialized,
    );
    if (!mdRes.ok) {
      return makeOutputLimitError(budgets.maxOutputBytes);
    }
    return finalizeResult(
      {
        fullOutput: mdRes.mdText,
        rowCount: cellMatrix.length,
        columnCount: headers.length,
        detectedDelimiter: null,
        delimiterAmbiguous: false,
        hadInputBom: hadLeadingBom,
        formulaLikeCellCount,
        formulaProtectedCount: 0,
        formulaPreviewSamples,
        renamedHeaders: [],
        paddedRowCount: 0,
        extendedColumnCount: 0,
        ambiguousScalarArrayCount: counters.ambiguousScalarArrays,
        depthCappedCellCount: counters.depthCapped,
        singleObjectNormalized,
        tableHeaders: headers,
        tableRows: plainStringRows,
      },
      budgets.maxOutputBytes,
    );
  }

  // `json_to_csv` — shared incremental UTF-8 budget & optional formula protection
  const csvSerialized = serializeTableToCsvBounded({
    headers,
    rows: cellMatrix,
    includeHeaderRow: options.firstRowHeaders,
    delimiter: sep,
    lineEnding,
    includeBom: Boolean(options.csvIncludeBom),
    formulaProtection: options.formulaProtection,
    maxOutputBytes: budgets.maxOutputBytes,
    onRowSerialized: budgets.onRowSerialized,
  });
  if (!csvSerialized.ok) {
    return {
      status: "error",
      code: csvSerialized.code,
      message: csvSerialized.message,
    };
  }

  return finalizeResult(
    {
      fullOutput: csvSerialized.csvText,
      rowCount: cellMatrix.length,
      columnCount: headers.length,
      detectedDelimiter: null,
      delimiterAmbiguous: false,
      hadInputBom: hadLeadingBom,
      formulaLikeCellCount: csvSerialized.formulaLikeCellCount,
      formulaProtectedCount: csvSerialized.formulaProtectedCount,
      formulaPreviewSamples: csvSerialized.formulaPreviewSamples,
      renamedHeaders: [],
      paddedRowCount: 0,
      extendedColumnCount: 0,
      ambiguousScalarArrayCount: counters.ambiguousScalarArrays,
      depthCappedCellCount: counters.depthCapped,
      singleObjectNormalized,
      tableHeaders: headers,
      tableRows: csvSerialized.previewRows,
      tableTotalRowCount: cellMatrix.length,
    },
    budgets.maxOutputBytes,
  );
}
