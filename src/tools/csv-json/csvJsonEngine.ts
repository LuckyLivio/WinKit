/**
 * D14 — CSV ↔ JSON & Markdown Table Converter
 *
 * RFC 4180-aware CSV parser with:
 * - Quoted-field support (embedded commas, newlines, escaped quotes)
 * - Auto-detect delimiter (comma / semicolon / tab)
 * - First-row-as-headers toggle
 * - Lossless large-integer and leading-zero preservation (string by default)
 * - Optional type detection (numbers, booleans)
 * - Nested JSON → CSV flattening with dot-path column names
 * - Optional spreadsheet formula protection (=, +, -, @ prefix escaping)
 * - JSON → CSV / CSV → JSON / either → Markdown table
 * - Error line/column reporting
 *
 * Input budget: 4 MiB.
 */

/** Maximum input size in bytes (4 MiB). */
export const MAX_INPUT_BYTES = 4 * 1024 * 1024;

export type CsvDelimiter = "auto" | "," | ";" | "\t";
export type ConversionDirection = "csv_to_json" | "json_to_csv" | "csv_to_md" | "json_to_md";

export interface CsvJsonOptions {
  direction: ConversionDirection;
  delimiter: CsvDelimiter;
  firstRowHeaders: boolean;
  detectTypes: boolean;
  formulaProtection: boolean;
}

export interface ConversionSuccess {
  status: "ok";
  output: string;
  rowCount: number;
  columnCount: number;
}

export interface ConversionError {
  status: "error";
  message: string;
  line?: number;
  column?: number;
}

export type ConversionResult = ConversionSuccess | ConversionError;

// ─── CSV Parsing ────────────────────────────────────────────────────

interface ParsedCsv {
  rows: string[][];
  detectedDelimiter: string;
}

function detectDelimiter(text: string): string {
  // Look at the first line to guess delimiter
  const firstLine = text.split(/\r?\n/)[0] ?? "";
  const counts = {
    ",": 0,
    ";": 0,
    "\t": 0,
  };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && ch in counts) {
      counts[ch as keyof typeof counts]++;
    }
  }
  // Prefer tab if any, then semicolon, then comma (comma is fallback default)
  if (counts["\t"] > 0 && counts["\t"] >= counts[","] && counts["\t"] >= counts[";"]) return "\t";
  if (counts[";"] > 0 && counts[";"] >= counts[","]) return ";";
  return ",";
}

/**
 * RFC 4180 CSV parser.
 * Supports quoted fields with embedded commas, newlines, and escaped quotes (doubled).
 */
export function parseCsv(text: string, delimiter: CsvDelimiter): ParsedCsv | ConversionError {
  const sep = delimiter === "auto" ? detectDelimiter(text) : delimiter;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  let line = 1;
  let col = 1;

  while (i < text.length) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          // Escaped quote
          field += '"';
          i += 2;
          col += 2;
          continue;
        }
        // End of quoted field
        inQuotes = false;
        i++;
        col++;
        continue;
      }
      // Any character inside quotes (including newline)
      field += ch;
      if (ch === "\n") {
        line++;
        col = 1;
      } else if (ch === "\r") {
        // skip for col tracking
      } else {
        col++;
      }
      i++;
      continue;
    }

    // Not in quotes
    if (ch === '"') {
      if (field.length === 0) {
        // Start of quoted field
        inQuotes = true;
        i++;
        col++;
        continue;
      }
      return {
        status: "error",
        message: `Unexpected quote character in unquoted field`,
        line,
        column: col,
      };
    }

    if (ch === sep) {
      row.push(field);
      field = "";
      i++;
      col++;
      continue;
    }

    if (ch === "\r") {
      // Handle \r\n or standalone \r
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      i++;
      if (i < text.length && text[i] === "\n") {
        i++;
      }
      line++;
      col = 1;
      continue;
    }

    if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      i++;
      line++;
      col = 1;
      continue;
    }

    field += ch;
    i++;
    col++;
  }

  if (inQuotes) {
    return {
      status: "error",
      message: "Unterminated quoted field (missing closing double-quote)",
      line,
      column: col,
    };
  }

  // Push final field/row (unless trailing empty line)
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return { rows, detectedDelimiter: sep };
}

// ─── Type Detection ────────────────────────────────────────────────

function coerceValue(raw: string, detectTypes: boolean): unknown {
  if (!detectTypes) return raw;

  const trimmed = raw.trim();
  if (trimmed === "") return raw;

  // Boolean
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  // Null
  if (trimmed === "null") return null;

  // Number — but preserve leading zeros and very large integers as strings
  if (/^-?\d+$/.test(trimmed)) {
    // Leading zero (except "0" itself) → keep as string for lossless preservation
    if (trimmed.length > 1 && trimmed.startsWith("0")) return raw;
    if (trimmed.startsWith("-0") && trimmed.length > 2) return raw;

    // Large integer check: if > Number.MAX_SAFE_INTEGER, keep as string
    const n = Number(trimmed);
    if (Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER) return n;
    return raw; // too large → keep string
  }

  // Float
  if (/^-?\d+\.\d+$/.test(trimmed) || /^-?\d+(\.\d+)?[eE][+-]?\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }

  return raw;
}

// ─── JSON Flattening ───────────────────────────────────────────────

/**
 * Flatten a nested object using dot-path keys.
 * Arrays are kept as JSON strings (not flattened).
 */
function flattenObject(obj: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof Date)
    ) {
      Object.assign(result, flattenObject(value as Record<string, unknown>, path));
    } else {
      result[path] = value;
    }
  }
  return result;
}

// ─── Formula Protection ───────────────────────────────────────────

function protectFormula(value: string): string {
  if (value.length > 0 && "=+-@".includes(value[0]!)) {
    return `'${value}`;
  }
  return value;
}

// ─── CSV Serialization ────────────────────────────────────────────

function escapeCsvField(value: string, sep: string, formulaProtect: boolean): string {
  const v = formulaProtect ? protectFormula(value) : value;
  if (v.includes('"') || v.includes(sep) || v.includes("\n") || v.includes("\r")) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// ─── Markdown Table ───────────────────────────────────────────────

function markdownTable(headers: string[], rows: string[][]): string {
  // Compute column widths
  const widths = headers.map((h, i) => {
    const headerLen = h.length;
    const maxRowLen = rows.reduce((max, row) => Math.max(max, (row[i] ?? "").length), 0);
    return Math.max(headerLen, maxRowLen, 3);
  });

  const headerLine = `| ${headers.map((h, i) => h.padEnd(widths[i]!)).join(" | ")} |`;
  const separatorLine = `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`;
  const dataLines = rows.map(
    (row) => `| ${headers.map((_, i) => (row[i] ?? "").padEnd(widths[i]!)).join(" | ")} |`,
  );

  return [headerLine, separatorLine, ...dataLines].join("\n");
}

// ─── Main Conversion ──────────────────────────────────────────────

export function convert(input: string, options: CsvJsonOptions): ConversionResult {
  const inputBytes = new TextEncoder().encode(input).length;
  if (inputBytes > MAX_INPUT_BYTES) {
    return {
      status: "error",
      message: `Input exceeds 4 MiB limit (${(inputBytes / 1024 / 1024).toFixed(1)} MiB)`,
    };
  }

  const trimmedInput = input.trim();
  if (trimmedInput.length === 0) {
    return { status: "error", message: "Input is empty" };
  }

  switch (options.direction) {
    case "csv_to_json":
      return csvToJson(trimmedInput, options);
    case "json_to_csv":
      return jsonToCsv(trimmedInput, options);
    case "csv_to_md":
      return csvToMarkdown(trimmedInput, options);
    case "json_to_md":
      return jsonToMarkdown(trimmedInput, options);
  }
}

function csvToJson(input: string, options: CsvJsonOptions): ConversionResult {
  const parsed = parseCsv(input, options.delimiter);
  if ("status" in parsed && parsed.status === "error") return parsed;
  const { rows } = parsed as ParsedCsv;

  if (rows.length === 0) {
    return { status: "error", message: "No data rows found in CSV" };
  }

  // Normalize column count to max width
  const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 0);

  if (options.firstRowHeaders && rows.length >= 1) {
    const headers = rows[0]!;
    const dataRows = rows.slice(1);
    const jsonRows = dataRows.map((row) => {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < maxCols; i++) {
        const key = headers[i] ?? `column_${i + 1}`;
        obj[key] = coerceValue(row[i] ?? "", options.detectTypes);
      }
      return obj;
    });
    return {
      status: "ok",
      output: JSON.stringify(jsonRows, null, 2),
      rowCount: dataRows.length,
      columnCount: maxCols,
    };
  }

  // No headers: array of arrays
  const jsonRows = rows.map((row) => {
    const padded = [...row];
    while (padded.length < maxCols) padded.push("");
    return padded.map((cell) => coerceValue(cell, options.detectTypes));
  });
  return {
    status: "ok",
    output: JSON.stringify(jsonRows, null, 2),
    rowCount: jsonRows.length,
    columnCount: maxCols,
  };
}

function jsonToCsv(input: string, options: CsvJsonOptions): ConversionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (e) {
    const msg = e instanceof SyntaxError ? e.message : "Invalid JSON";
    return { status: "error", message: `JSON parse error: ${msg}` };
  }

  if (!Array.isArray(parsed)) {
    return { status: "error", message: "JSON root must be an array" };
  }

  if (parsed.length === 0) {
    return { status: "error", message: "JSON array is empty" };
  }

  const sep = options.delimiter === "auto" ? "," : options.delimiter;

  // Flatten objects and collect all column keys
  const flatRows: Record<string, unknown>[] = [];
  const allKeys = new Set<string>();

  for (const item of parsed) {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      const flat = flattenObject(item as Record<string, unknown>);
      flatRows.push(flat);
      for (const key of Object.keys(flat)) {
        allKeys.add(key);
      }
    } else if (Array.isArray(item)) {
      // Array item — treat as positional columns
      const obj: Record<string, unknown> = {};
      item.forEach((v: unknown, i: number) => {
        const key = `column_${i + 1}`;
        obj[key] = v;
        allKeys.add(key);
      });
      flatRows.push(obj);
    } else {
      // Primitive — single column
      const key = "value";
      allKeys.add(key);
      flatRows.push({ [key]: item });
    }
  }

  const headers = [...allKeys];
  const lines: string[] = [];

  if (options.firstRowHeaders) {
    lines.push(headers.map((h) => escapeCsvField(h, sep, options.formulaProtection)).join(sep));
  }

  for (const row of flatRows) {
    const cells = headers.map((h) => {
      const raw = stringifyValue(row[h]);
      return escapeCsvField(raw, sep, options.formulaProtection);
    });
    lines.push(cells.join(sep));
  }

  return {
    status: "ok",
    output: lines.join("\n"),
    rowCount: flatRows.length,
    columnCount: headers.length,
  };
}

function csvToMarkdown(input: string, options: CsvJsonOptions): ConversionResult {
  const parsed = parseCsv(input, options.delimiter);
  if ("status" in parsed && parsed.status === "error") return parsed;
  const { rows } = parsed as ParsedCsv;

  if (rows.length === 0) {
    return { status: "error", message: "No data rows found in CSV" };
  }

  const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 0);

  if (options.firstRowHeaders && rows.length >= 1) {
    const headers = rows[0]!.map((h) => h.trim());
    while (headers.length < maxCols) headers.push(`column_${headers.length + 1}`);
    const dataRows = rows.slice(1).map((row) => {
      const padded = [...row];
      while (padded.length < maxCols) padded.push("");
      return padded.map((cell) => cell.replace(/\|/g, "\\|").replace(/\n/g, " "));
    });
    return {
      status: "ok",
      output: markdownTable(headers, dataRows),
      rowCount: dataRows.length,
      columnCount: maxCols,
    };
  }

  // No headers: generate column_1, column_2 ...
  const headers = Array.from({ length: maxCols }, (_, i) => `column_${i + 1}`);
  const dataRows = rows.map((row) => {
    const padded = [...row];
    while (padded.length < maxCols) padded.push("");
    return padded.map((cell) => cell.replace(/\|/g, "\\|").replace(/\n/g, " "));
  });

  return {
    status: "ok",
    output: markdownTable(headers, dataRows),
    rowCount: dataRows.length,
    columnCount: maxCols,
  };
}

function jsonToMarkdown(input: string, _options: CsvJsonOptions): ConversionResult {
  // First convert JSON to structured data, then to markdown
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (e) {
    const msg = e instanceof SyntaxError ? e.message : "Invalid JSON";
    return { status: "error", message: `JSON parse error: ${msg}` };
  }

  if (!Array.isArray(parsed)) {
    return { status: "error", message: "JSON root must be an array" };
  }

  if (parsed.length === 0) {
    return { status: "error", message: "JSON array is empty" };
  }

  // Flatten and collect headers
  const flatRows: Record<string, unknown>[] = [];
  const allKeys = new Set<string>();

  for (const item of parsed) {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      const flat = flattenObject(item as Record<string, unknown>);
      flatRows.push(flat);
      for (const key of Object.keys(flat)) allKeys.add(key);
    } else if (Array.isArray(item)) {
      const obj: Record<string, unknown> = {};
      item.forEach((v: unknown, i: number) => {
        const key = `column_${i + 1}`;
        obj[key] = v;
        allKeys.add(key);
      });
      flatRows.push(obj);
    } else {
      const key = "value";
      allKeys.add(key);
      flatRows.push({ [key]: item });
    }
  }

  const headers = [...allKeys];
  const dataRows = flatRows.map((row) =>
    headers.map((h) => {
      const v = stringifyValue(row[h]);
      return v.replace(/\|/g, "\\|").replace(/\n/g, " ");
    }),
  );

  return {
    status: "ok",
    output: markdownTable(headers, dataRows),
    rowCount: flatRows.length,
    columnCount: headers.length,
  };
}
