import { serializeTableToCsvBounded, type CsvCellInput } from "../csv-json/csvJsonEngine";

export type HashAlgorithm = "MD5" | "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";

export const ALL_HASH_ALGORITHMS: readonly HashAlgorithm[] = [
  "MD5",
  "SHA-1",
  "SHA-256",
  "SHA-384",
  "SHA-512",
] as const;

export const ALGORITHM_HEX_LENGTHS: Record<HashAlgorithm, number> = {
  MD5: 32,
  "SHA-1": 40,
  "SHA-256": 64,
  "SHA-384": 96,
  "SHA-512": 128,
};

export const MAX_HASH_BATCH_FILES = 1_000;
export const HASH_BATCH_PAGE_SIZE = 100;
export const MAX_HASH_BATCH_CSV_UTF8_BYTES = 8 * 1024 * 1024; // 8 MiB

export interface AlgorithmDigestEntry {
  algorithm: HashAlgorithm;
  hexLength: number;
  digestHex: string;
}

export type HashBatchItemStatus = "pending" | "running" | "completed" | "error" | "cancelled";

export interface HashBatchFileItem {
  itemId: string;
  path: string;
  fileName: string;
  byteLength: number | null;
  status: HashBatchItemStatus;
  processedBytes: number;
  progressPercent: number | null;
  digests: AlgorithmDigestEntry[] | null;
  errorCode: string | null;
  errorMessage: string | null;
  expectedHash: string;
}

export interface HashBatchState {
  batchGeneration: number;
  activeAttemptId: string | null;
  algorithmsSnapshot: HashAlgorithm[];
  items: HashBatchFileItem[];
  selectedItemId: string | null;
  overflowSkippedCount: number;
}

export type NormalizedDigestParseResult =
  | {
      status: "empty";
      isEmpty: true;
      normalizedHex: null;
      candidateAlgorithm: null;
    }
  | {
      status: "ok";
      isEmpty: false;
      normalizedHex: string;
      candidateAlgorithm: HashAlgorithm;
    }
  | {
      status: "ambiguous";
      isEmpty: false;
      normalizedHex: null;
      candidateAlgorithm: null;
    }
  | {
      status: "invalid";
      isEmpty: false;
      normalizedHex: null;
      candidateAlgorithm: null;
      reason?: "prefix_length_mismatch" | "malformed";
    };

export type ExpectedCompareStatus =
  | { kind: "idle" }
  | { kind: "invalid_format"; reason?: "prefix_length_mismatch" | "malformed" }
  | { kind: "ambiguous_format" }
  | { kind: "candidate_uncomputed"; candidateAlgorithm: HashAlgorithm; hexLength: number }
  | { kind: "match"; matchedAlgorithm: HashAlgorithm; hexLength: number }
  | { kind: "mismatch"; candidateAlgorithm: HashAlgorithm; hexLength: number };

export function isLegacyCompatAlgorithm(alg: HashAlgorithm): boolean {
  return alg === "MD5" || alg === "SHA-1";
}

export function inferCandidateAlgorithmByHexLength(hexLength: number): HashAlgorithm | null {
  switch (hexLength) {
    case 32:
      return "MD5";
    case 40:
      return "SHA-1";
    case 64:
      return "SHA-256";
    case 96:
      return "SHA-384";
    case 128:
      return "SHA-512";
    default:
      return null;
  }
}

function parseAlgorithmTag(rawTag: string): HashAlgorithm | null {
  const upper = rawTag.toUpperCase().replace(/-/g, "");
  switch (upper) {
    case "MD5":
      return "MD5";
    case "SHA1":
      return "SHA-1";
    case "SHA256":
      return "SHA-256";
    case "SHA384":
      return "SHA-384";
    case "SHA512":
      return "SHA-512";
    default:
      return null;
  }
}

function finalizeCandidateHex(
  hexLower: string,
  declaredAlg: HashAlgorithm | null,
): NormalizedDigestParseResult {
  const inferred = inferCandidateAlgorithmByHexLength(hexLower.length);
  if (!inferred) {
    return {
      status: "invalid",
      isEmpty: false,
      normalizedHex: null,
      candidateAlgorithm: null,
      reason: "malformed",
    };
  }
  if (declaredAlg !== null && declaredAlg !== inferred) {
    return {
      status: "invalid",
      isEmpty: false,
      normalizedHex: null,
      candidateAlgorithm: null,
      reason: "prefix_length_mismatch",
    };
  }
  return {
    status: "ok",
    isEmpty: false,
    normalizedHex: hexLower,
    candidateAlgorithm: inferred,
  };
}

/**
 * Normalizes a user-supplied expected digest string without silently truncating grouped hex:
 * - Recognizes optional `MD5:`, `SHA-256=`, or BSD `SHA256 (file) = ...` prefixes and rejects
 *   contradictions between declared algorithm prefix and hex length.
 * - Recognizes explicit `shasum` separators (`<digest> *filename` or `<digest>  filename` with >=2 spaces / tab),
 *   returning `status: "ambiguous"` if a trailing hex-like token could also form a longer digest.
 * - Normalizes space-, colon-, or hyphen-grouped hex (including `32 + 32` grouped SHA-256) and flags
 *   ambiguous single-space `<valid-digest> <extra>` inputs instead of guessing a shorter digest.
 */
export function normalizeExpectedDigest(raw: string): NormalizedDigestParseResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { status: "empty", isEmpty: true, normalizedHex: null, candidateAlgorithm: null };
  }

  if (/[\r\n]/.test(trimmed)) {
    return {
      status: "invalid",
      isEmpty: false,
      normalizedHex: null,
      candidateAlgorithm: null,
      reason: "malformed",
    };
  }

  let declaredAlg: HashAlgorithm | null = null;
  let body = trimmed;

  const bsdMatch = /^(MD5|SHA-?1|SHA-?256|SHA-?384|SHA-?512)\s*\([^)]+\)\s*=\s*(.+)$/i.exec(
    trimmed,
  );
  if (bsdMatch?.[1] && bsdMatch[2]) {
    declaredAlg = parseAlgorithmTag(bsdMatch[1]);
    body = bsdMatch[2].trim();
  } else {
    const prefixMatch = /^(MD5|SHA-?1|SHA-?256|SHA-?384|SHA-?512)\s*[:=]\s*(.+)$/i.exec(trimmed);
    if (prefixMatch?.[1] && prefixMatch[2]) {
      declaredAlg = parseAlgorithmTag(prefixMatch[1]);
      body = prefixMatch[2].trim();
    }
  }

  if (!body) {
    return {
      status: "invalid",
      isEmpty: false,
      normalizedHex: null,
      candidateAlgorithm: null,
      reason: "malformed",
    };
  }

  // 1. Explicit binary-mode shasum separator: `<32|40|64|96|128 hex> *filename`
  const binaryShasumMatch =
    /^([0-9a-fA-F]{32}|[0-9a-fA-F]{40}|[0-9a-fA-F]{64}|[0-9a-fA-F]{96}|[0-9a-fA-F]{128})\s+\*(\S.*)$/.exec(
      body,
    );
  if (binaryShasumMatch?.[1]) {
    return finalizeCandidateHex(binaryShasumMatch[1].toLowerCase(), declaredAlg);
  }

  // 2. Standard text-mode shasum separator: `<32|40|64|96|128 hex>  filename` (>=2 spaces or tab)
  const textShasumMatch =
    /^([0-9a-fA-F]{32}|[0-9a-fA-F]{40}|[0-9a-fA-F]{64}|[0-9a-fA-F]{96}|[0-9a-fA-F]{128})(?: {2,}|\t+)(\S.*)$/.exec(
      body,
    );
  if (textShasumMatch?.[1] && textShasumMatch[2]) {
    const leadHex = textShasumMatch[1].toLowerCase();
    const restPart = textShasumMatch[2].trim();
    const restStripped = restPart.replace(/[\s:-]+/g, "");
    const restIsPureHex =
      /^[0-9a-fA-F]+$/.test(restStripped) && !/^[:-]|[:-]$|[:]{2,}|[-]{2,}/.test(restPart);

    if (restIsPureHex) {
      const combinedHex = leadHex + restStripped.toLowerCase();
      const combinedAlg = inferCandidateAlgorithmByHexLength(combinedHex.length);
      const leadAlg = inferCandidateAlgorithmByHexLength(leadHex.length);
      if (combinedAlg !== null) {
        if (declaredAlg === leadAlg && declaredAlg !== combinedAlg) {
          return finalizeCandidateHex(leadHex, declaredAlg);
        }
        if (declaredAlg === combinedAlg && declaredAlg !== leadAlg) {
          return finalizeCandidateHex(combinedHex, declaredAlg);
        }
        // Without a disambiguating prefix, `<32-hex>  <32-hex>` or `<32-hex>  <8-hex>` is genuinely ambiguous
        return {
          status: "ambiguous",
          isEmpty: false,
          normalizedHex: null,
          candidateAlgorithm: null,
        };
      }
    }

    return finalizeCandidateHex(leadHex, declaredAlg);
  }

  // 3. Pure hex or space / colon / hyphen grouped hex (no non-hex filename characters)
  if (/^[0-9a-fA-F\s:-]+$/.test(body) && !/^[:-]|[:-]$|:{2,}|-{2,}/.test(body)) {
    const tokens = body.split(/[\s:-]+/).filter((t) => t.length > 0);
    if (tokens.length > 0 && tokens.every((t) => /^[0-9a-fA-F]+$/.test(t))) {
      const joined = tokens.join("").toLowerCase();
      const inferred = inferCandidateAlgorithmByHexLength(joined.length);
      if (!inferred) {
        return {
          status: "invalid",
          isEmpty: false,
          normalizedHex: null,
          candidateAlgorithm: null,
          reason: "malformed",
        };
      }
      if (declaredAlg !== null && declaredAlg !== inferred) {
        return {
          status: "invalid",
          isEmpty: false,
          normalizedHex: null,
          candidateAlgorithm: null,
          reason: "prefix_length_mismatch",
        };
      }
      if (tokens.length > 1 && declaredAlg === null) {
        const firstLen = tokens[0]!.length;
        const allUniformLength = tokens.every((t) => t.length === firstLen);
        // If unequal groups start with an already-complete digest length (e.g. `32 + 8 = 40`),
        // flag as ambiguous rather than guessing MD5 vs SHA-1.
        if (!allUniformLength && inferCandidateAlgorithmByHexLength(firstLen) !== null) {
          return {
            status: "ambiguous",
            isEmpty: false,
            normalizedHex: null,
            candidateAlgorithm: null,
          };
        }
      }
      return {
        status: "ok",
        isEmpty: false,
        normalizedHex: joined,
        candidateAlgorithm: inferred,
      };
    }
  }

  // 4. Single-space `<valid-digest> <non-hex-extra>` without `*`: ambiguous between corrupted shasum
  //    (single space instead of standard two spaces / `*`) and trailing garbage.
  const singleSpaceAmbiguous =
    /^([0-9a-fA-F]{32}|[0-9a-fA-F]{40}|[0-9a-fA-F]{64}|[0-9a-fA-F]{96}|[0-9a-fA-F]{128}) (\S.*)$/.exec(
      body,
    );
  if (singleSpaceAmbiguous) {
    return {
      status: "ambiguous",
      isEmpty: false,
      normalizedHex: null,
      candidateAlgorithm: null,
    };
  }

  return {
    status: "invalid",
    isEmpty: false,
    normalizedHex: null,
    candidateAlgorithm: null,
    reason: "malformed",
  };
}

/**
 * Compares an expected hex digest against the currently computed algorithm results.
 * Length inference only identifies a length-compatible candidate algorithm — it never claims
 * cryptographic proof of how an external digest was produced.
 */
export function compareMultiDigests(
  computedDigests: readonly AlgorithmDigestEntry[] | null,
  selectedAlgorithms: readonly HashAlgorithm[],
  expectedInput: string,
): ExpectedCompareStatus {
  const parsed = normalizeExpectedDigest(expectedInput);
  if (parsed.status === "empty") {
    return { kind: "idle" };
  }
  if (parsed.status === "ambiguous") {
    return { kind: "ambiguous_format" };
  }
  if (parsed.status === "invalid") {
    return { kind: "invalid_format", reason: parsed.reason };
  }

  const candidate = parsed.candidateAlgorithm;
  const hexLength = parsed.normalizedHex.length;

  if (!selectedAlgorithms.includes(candidate)) {
    return {
      kind: "candidate_uncomputed",
      candidateAlgorithm: candidate,
      hexLength,
    };
  }

  if (!computedDigests || computedDigests.length === 0) {
    return { kind: "idle" };
  }

  const entry = computedDigests.find((d) => d.algorithm === candidate);
  if (!entry) {
    return {
      kind: "candidate_uncomputed",
      candidateAlgorithm: candidate,
      hexLength,
    };
  }

  return entry.digestHex.toLowerCase() === parsed.normalizedHex
    ? { kind: "match", matchedAlgorithm: candidate, hexLength }
    : { kind: "mismatch", candidateAlgorithm: candidate, hexLength };
}

export function formatDigestHex(hex: string, uppercase: boolean): string {
  return uppercase ? hex.toUpperCase() : hex.toLowerCase();
}

export function areAlgorithmListsEqual(
  a: readonly HashAlgorithm[],
  b: readonly HashAlgorithm[],
): boolean {
  if (a.length !== b.length) return false;
  return ALL_HASH_ALGORITHMS.every((alg) => a.includes(alg) === b.includes(alg));
}

export function formatBatchCopyAllText(
  items: readonly HashBatchFileItem[],
  algorithmsSnapshot: readonly HashAlgorithm[],
  uppercase: boolean,
): string {
  const blocks: string[] = [];
  for (const item of items) {
    if (item.status !== "completed" || !item.digests) continue;
    const lines: string[] = [`# ${item.fileName} (${item.path})`];
    for (const alg of algorithmsSnapshot) {
      const found = item.digests.find((d) => d.algorithm === alg);
      if (found) {
        lines.push(`${alg}: ${formatDigestHex(found.digestHex, uppercase)}`);
      }
    }
    if (lines.length > 1) {
      blocks.push(lines.join("\n"));
    }
  }
  return blocks.join("\n\n");
}

function summarizeCompareForCsv(
  item: HashBatchFileItem,
  algorithmsSnapshot: readonly HashAlgorithm[],
): string {
  if (!item.expectedHash.trim()) {
    return "";
  }
  const cmp = compareMultiDigests(
    item.status === "completed" ? item.digests : null,
    algorithmsSnapshot,
    item.expectedHash,
  );
  switch (cmp.kind) {
    case "match":
      return `match (${cmp.matchedAlgorithm})`;
    case "mismatch":
      return `mismatch (${cmp.candidateAlgorithm})`;
    case "candidate_uncomputed":
      return `uncomputed (${cmp.candidateAlgorithm})`;
    case "ambiguous_format":
      return "ambiguous_expected_digest";
    case "invalid_format":
      return "invalid_expected_digest";
    case "idle":
      return "pending";
  }
}

export function buildHashBatchCsvBounded(
  items: readonly HashBatchFileItem[],
  algorithmsSnapshot: readonly HashAlgorithm[],
  options: {
    uppercase: boolean;
    formulaProtection: boolean;
    maxUtf8Bytes?: number;
  },
):
  | { ok: true; csv: string; utf8Bytes: number; formulaCellCount: number }
  | { ok: false; message: string } {
  const headers: string[] = [
    "index",
    "file_name",
    "path",
    "byte_length",
    "status",
    ...algorithmsSnapshot,
    "expected_digest",
    "compare_status",
    "error",
  ];

  const rows: CsvCellInput[][] = items.map((item, idx) => {
    const algCells: CsvCellInput[] = algorithmsSnapshot.map((alg) => {
      if (item.status !== "completed" || !item.digests) {
        return { text: "", isGenuineNumber: false };
      }
      const found = item.digests.find((d) => d.algorithm === alg);
      return {
        text: found ? formatDigestHex(found.digestHex, options.uppercase) : "",
        isGenuineNumber: false,
      };
    });

    const errText =
      item.status === "error" || item.status === "cancelled"
        ? item.errorCode
          ? `[${item.errorCode}] ${item.errorMessage ?? ""}`.trim()
          : (item.errorMessage ?? "")
        : "";

    return [
      { text: String(idx + 1), isGenuineNumber: true },
      { text: item.fileName, isGenuineNumber: false },
      { text: item.path, isGenuineNumber: false },
      {
        text: item.byteLength !== null ? String(item.byteLength) : "",
        isGenuineNumber: item.byteLength !== null,
      },
      { text: item.status, isGenuineNumber: false },
      ...algCells,
      { text: item.expectedHash, isGenuineNumber: false },
      { text: summarizeCompareForCsv(item, algorithmsSnapshot), isGenuineNumber: false },
      { text: errText, isGenuineNumber: false },
    ];
  });

  const serialized = serializeTableToCsvBounded({
    headers,
    rows,
    includeHeaderRow: true,
    delimiter: ",",
    lineEnding: "\n",
    includeBom: false,
    formulaProtection: options.formulaProtection,
    maxOutputBytes: options.maxUtf8Bytes ?? MAX_HASH_BATCH_CSV_UTF8_BYTES,
  });

  if (!serialized.ok) {
    return { ok: false, message: serialized.message };
  }
  return {
    ok: true,
    csv: serialized.csvText,
    utf8Bytes: serialized.byteLength,
    formulaCellCount: serialized.formulaLikeCellCount,
  };
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Pure TypeScript RFC 1321 MD5 implementation used ONLY as the non-Tauri Web/Vitest fallback
 * (since WebCrypto `crypto.subtle.digest` intentionally omits MD5, while Tauri desktop uses
 * native Rust `md-5` crate).
 */
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K = Array.from(
  { length: 64 },
  (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0,
);

export function computeMd5HexFallback(bytes: Uint8Array): string {
  const bitLenLo = (bytes.length << 3) >>> 0;
  const bitLenHi = (bytes.length >>> 29) >>> 0;
  const paddedLen = (((bytes.length + 8) >>> 6) + 1) << 6;
  const buf = new Uint8Array(paddedLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(paddedLen - 8, bitLenLo, true);
  view.setUint32(paddedLen - 4, bitLenHi, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < paddedLen; offset += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }

      const word = view.getUint32(offset + g * 4, true);
      const sum = (a + f + MD5_K[i]! + word) >>> 0;
      const s = MD5_S[i]!;
      const rotated = ((sum << s) | (sum >>> (32 - s))) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotated) >>> 0;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return Array.from(out)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
