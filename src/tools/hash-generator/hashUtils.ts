export type DigestCompareState = "idle" | "invalid_format" | "match" | "mismatch";

/**
 * Normalizes a user-supplied expected SHA-256 string:
 * - Strips optional `sha256:` / `sha-256=` prefixes
 * - Extracts leading token if pasted from `shasum -a 256` / `CertUtil` (`<hex>  filename`)
 * - Removes colons or spaces used in byte-grouped hex output (`AA:BB:...` or `aa bb ...`)
 */
export function normalizeExpectedSha256(raw: string): {
  isEmpty: boolean;
  normalizedHex: string | null;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { isEmpty: true, normalizedHex: null };
  }

  // Remove common algorithm prefixes
  let candidate = trimmed.replace(/^sha-?256\s*[:=]\s*/i, "").trim();

  // Handle standard `shasum` / `sha256sum` format: `<64-hex>  *filename.ext`
  const shasumMatch = /^([0-9a-fA-F]{64})(?:\s+\*?[^\s].*)$/.exec(candidate);
  if (shasumMatch?.[1]) {
    return { isEmpty: false, normalizedHex: shasumMatch[1].toLowerCase() };
  }

  // Strip colons, hyphens, or whitespace used in grouped hex representations
  candidate = candidate.replace(/[\s:-]+/g, "");
  if (/^[0-9a-fA-F]{64}$/.test(candidate)) {
    return { isEmpty: false, normalizedHex: candidate.toLowerCase() };
  }

  return { isEmpty: false, normalizedHex: null };
}

export function compareSha256Digest(
  actualDigestHex: string | null,
  expectedInput: string,
): DigestCompareState {
  const parsed = normalizeExpectedSha256(expectedInput);
  if (parsed.isEmpty) {
    return "idle";
  }
  if (!parsed.normalizedHex) {
    return "invalid_format";
  }
  if (!actualDigestHex) {
    return "idle";
  }
  return actualDigestHex.toLowerCase() === parsed.normalizedHex ? "match" : "mismatch";
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
