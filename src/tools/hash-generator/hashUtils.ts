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

export interface AlgorithmDigestEntry {
  algorithm: HashAlgorithm;
  hexLength: number;
  digestHex: string;
}

export type ExpectedCompareStatus =
  | { kind: "idle" }
  | { kind: "invalid_format" }
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

/**
 * Normalizes a user-supplied expected digest string:
 * - Strips optional `md5:`, `sha1:`, `sha-256:`, `sha384=`, `sha512:` prefixes
 * - Extracts leading hex token from `shasum` / `CertUtil` (`<hex>  *filename`)
 * - Removes colons, hyphens, or whitespace used in byte-grouped hex strings
 */
export function normalizeExpectedDigest(raw: string): {
  isEmpty: boolean;
  normalizedHex: string | null;
  candidateAlgorithm: HashAlgorithm | null;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { isEmpty: true, normalizedHex: null, candidateAlgorithm: null };
  }

  let candidate = trimmed.replace(/^(?:md5|sha-?(?:1|256|384|512))\s*[:=]\s*/i, "").trim();

  // Standard shasum / md5sum line: `<32|40|64|96|128 hex>  *filename`
  const shasumMatch =
    /^([0-9a-fA-F]{32}|[0-9a-fA-F]{40}|[0-9a-fA-F]{64}|[0-9a-fA-F]{96}|[0-9a-fA-F]{128})(?:\s+\*?[^\s].*)$/.exec(
      candidate,
    );
  if (shasumMatch?.[1]) {
    const hex = shasumMatch[1].toLowerCase();
    return {
      isEmpty: false,
      normalizedHex: hex,
      candidateAlgorithm: inferCandidateAlgorithmByHexLength(hex.length),
    };
  }

  candidate = candidate.replace(/[\s:-]+/g, "");
  if (!/^[0-9a-fA-F]+$/.test(candidate)) {
    return { isEmpty: false, normalizedHex: null, candidateAlgorithm: null };
  }

  const alg = inferCandidateAlgorithmByHexLength(candidate.length);
  if (!alg) {
    return { isEmpty: false, normalizedHex: null, candidateAlgorithm: null };
  }

  return {
    isEmpty: false,
    normalizedHex: candidate.toLowerCase(),
    candidateAlgorithm: alg,
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
  if (parsed.isEmpty) {
    return { kind: "idle" };
  }
  if (!parsed.normalizedHex || !parsed.candidateAlgorithm) {
    return { kind: "invalid_format" };
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
