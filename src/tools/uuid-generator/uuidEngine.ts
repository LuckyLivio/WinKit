export type UuidGenVersion = "v4" | "v7";

export interface UuidInspectResult {
  canonical: string;
  compactHex: string;
  isNil: boolean;
  isMax: boolean;
  version: number | null;
  variant: string;
  unixTimestampMs: number | null;
}

export const MAX_UUID_BATCH = 500;

function bytesToCanonicalUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function formatUuidDisplay(
  canonical: string,
  options: { uppercase: boolean; hyphens: boolean },
): string {
  const base = options.hyphens ? canonical : canonical.replace(/-/g, "");
  return options.uppercase ? base.toUpperCase() : base.toLowerCase();
}

/**
 * WebCrypto CSPRNG fallback for non-Tauri Vitest/Web environments (strictly uses
 * `crypto.getRandomValues` — NEVER `Math.random`).
 */
export function generateUuidBatchClientFallback(version: UuidGenVersion, count: number): string[] {
  if (!Number.isInteger(count) || count < 1 || count > MAX_UUID_BATCH) {
    throw JSON.stringify({
      code: "INVALID_PARAMETER",
      message: `UUID batch count must be an integer between 1 and ${MAX_UUID_BATCH}.`,
    });
  }

  const out: string[] = [];
  for (let idx = 0; idx < count; idx++) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);

    if (version === "v4") {
      bytes[6] = (bytes[6]! & 0x0f) | 0x40;
      bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    } else {
      // RFC 9562 §5.7 UUIDv7: 48-bit big-endian Unix timestamp in ms + ver 7 + var 10 + 74 random bits
      const nowMs = BigInt(Date.now());
      bytes[0] = Number((nowMs >> 40n) & 0xffn);
      bytes[1] = Number((nowMs >> 32n) & 0xffn);
      bytes[2] = Number((nowMs >> 24n) & 0xffn);
      bytes[3] = Number((nowMs >> 16n) & 0xffn);
      bytes[4] = Number((nowMs >> 8n) & 0xffn);
      bytes[5] = Number(nowMs & 0xffn);
      bytes[6] = (bytes[6]! & 0x0f) | 0x70;
      bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    }
    out.push(bytesToCanonicalUuid(bytes));
  }
  return out;
}

export function inspectUuidClientFallback(raw: string): UuidInspectResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw JSON.stringify({
      code: "INVALID_PARAMETER",
      message: "UUID input is empty.",
    });
  }

  let candidate = trimmed;
  if (/^urn:uuid:/i.test(candidate)) {
    candidate = candidate.slice(9);
  } else if (candidate.startsWith("{") && candidate.endsWith("}")) {
    candidate = candidate.slice(1, -1);
  }

  let hex32: string;
  if (
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(candidate)
  ) {
    hex32 = candidate.replace(/-/g, "").toLowerCase();
  } else if (/^[0-9a-fA-F]{32}$/.test(candidate)) {
    hex32 = candidate.toLowerCase();
  } else {
    throw JSON.stringify({
      code: "DECODE_FAILED",
      message:
        "Invalid UUID syntax: expected 32 hexadecimal digits (8-4-4-4-12, hyphenless, braced, or urn:uuid:).",
    });
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Number.parseInt(hex32.slice(i * 2, i * 2 + 2), 16);
  }

  const isNil = bytes.every((b) => b === 0x00);
  const isMax = bytes.every((b) => b === 0xff);
  const canonical = bytesToCanonicalUuid(bytes);

  if (isNil) {
    return {
      canonical,
      compactHex: hex32,
      isNil: true,
      isMax: false,
      version: null,
      variant: "Nil (RFC 9562 §5.9)",
      unixTimestampMs: null,
    };
  }

  if (isMax) {
    return {
      canonical,
      compactHex: hex32,
      isNil: false,
      isMax: true,
      version: null,
      variant: "Max (RFC 9562 §5.10)",
      unixTimestampMs: null,
    };
  }

  const b8 = bytes[8]!;
  let variant: string;
  if ((b8 & 0x80) === 0x00) {
    variant = "NCS Backward Compatible (0xx)";
  } else if ((b8 & 0xc0) === 0x80) {
    variant = "RFC 9562 / RFC 4122 (10x)";
  } else if ((b8 & 0xe0) === 0xc0) {
    variant = "Microsoft Reserved (110)";
  } else {
    variant = "Future Reserved (111)";
  }

  const isRfc = (b8 & 0xc0) === 0x80;
  const version = isRfc ? (bytes[6]! >> 4) & 0x0f : null;
  let unixTimestampMs: number | null = null;
  if (version === 7) {
    const msBig =
      (BigInt(bytes[0]!) << 40n) |
      (BigInt(bytes[1]!) << 32n) |
      (BigInt(bytes[2]!) << 24n) |
      (BigInt(bytes[3]!) << 16n) |
      (BigInt(bytes[4]!) << 8n) |
      BigInt(bytes[5]!);
    unixTimestampMs = Number(msBig);
  }

  return {
    canonical,
    compactHex: hex32,
    isNil: false,
    isMax: false,
    version,
    variant,
    unixTimestampMs,
  };
}
