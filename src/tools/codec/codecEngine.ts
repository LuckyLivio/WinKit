export type CodecFormat = "base64_standard" | "base64_url" | "hex" | "binary";
export type CodecOperation = "encode" | "decode";
export type Base64WrapWidth = "none" | "cols64" | "cols76";

export interface CodecOptions {
  format: CodecFormat;
  operation: CodecOperation;
  padding: boolean;
  wrap: Base64WrapWidth;
  ignoreWhitespace: boolean;
  uppercaseHex: boolean;
  groupBits: boolean;
}

export interface CodecTransformResponse {
  inputByteLength: number;
  outputByteLength: number;
  isValidUtf8: boolean;
  previewText: string;
  totalChars: number;
  truncated: boolean;
  hexPreview: string | null;
  fileName: string | null;
}

export const MAX_CODEC_TEXT_BYTES = 2 * 1024 * 1024;
export const PREVIEW_CHAR_LIMIT = 65_536;

const STD_ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL_ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function wrapColumns(s: string, wrap: Base64WrapWidth): string {
  const cols = wrap === "cols64" ? 64 : wrap === "cols76" ? 76 : 0;
  if (cols <= 0 || s.length <= cols) return s;
  const parts: string[] = [];
  for (let i = 0; i < s.length; i += cols) {
    parts.push(s.slice(i, i + cols));
  }
  return parts.join("\n");
}

export function encodeBytesClient(bytes: Uint8Array, opts: CodecOptions): string {
  if (opts.format === "base64_standard" || opts.format === "base64_url") {
    const alpha = opts.format === "base64_url" ? URL_ALPHA : STD_ALPHA;
    let out = "";
    let i = 0;
    while (i + 3 <= bytes.length) {
      const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
      out +=
        alpha[(n >>> 18) & 63]! + alpha[(n >>> 12) & 63]! + alpha[(n >>> 6) & 63]! + alpha[n & 63]!;
      i += 3;
    }
    const rem = bytes.length - i;
    if (rem === 1) {
      const n = bytes[i]! << 16;
      out += alpha[(n >>> 18) & 63]! + alpha[(n >>> 12) & 63]!;
      if (opts.padding) out += "==";
    } else if (rem === 2) {
      const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
      out += alpha[(n >>> 18) & 63]! + alpha[(n >>> 12) & 63]! + alpha[(n >>> 6) & 63]!;
      if (opts.padding) out += "=";
    }
    return wrapColumns(out, opts.wrap);
  }

  if (opts.format === "hex") {
    const hex = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return opts.uppercaseHex ? hex.toUpperCase() : hex;
  }

  // binary
  const groups = Array.from(bytes).map((b) => b.toString(2).padStart(8, "0"));
  return opts.groupBits ? groups.join(" ") : groups.join("");
}

export function decodeStringClient(text: string, opts: CodecOptions): Uint8Array {
  const chars = Array.from(text);

  if (opts.format === "base64_standard" || opts.format === "base64_url") {
    const urlSafe = opts.format === "base64_url";
    const alpha = urlSafe ? URL_ALPHA : STD_ALPHA;
    const lookup = new Map<string, number>();
    for (let i = 0; i < alpha.length; i++) lookup.set(alpha[i]!, i);

    const cleaned: string[] = [];
    let line = 1;
    let col = 1;
    let padCount = 0;
    let firstPadOffset = 0;

    for (let idx = 0; idx < chars.length; idx++) {
      const ch = chars[idx]!;
      const offset = idx + 1;
      if (ch === "\n") {
        if (!opts.ignoreWhitespace) {
          throw new Error(`Unexpected newline at offset ${offset} (line ${line}, col ${col}).`);
        }
        line += 1;
        col = 1;
        continue;
      }
      if (ch === " " || ch === "\t" || ch === "\r") {
        if (!opts.ignoreWhitespace) {
          throw new Error(`Unexpected whitespace at offset ${offset} (line ${line}, col ${col}).`);
        }
        col += 1;
        continue;
      }
      if (ch === "=") {
        if (padCount === 0) firstPadOffset = offset;
        padCount += 1;
        if (padCount > 2) {
          throw new Error(
            `Invalid Base64 padding: more than two '=' at offset ${offset} (line ${line}, col ${col}).`,
          );
        }
        cleaned.push("=");
        col += 1;
        continue;
      }
      if (padCount > 0) {
        throw new Error(
          `Invalid Base64 padding: unexpected '${ch}' at offset ${offset} after '=' at offset ${firstPadOffset}.`,
        );
      }
      if (!lookup.has(ch)) {
        const hint =
          !urlSafe && (ch === "-" || ch === "_")
            ? " (switch to URL-Safe Base64)"
            : urlSafe && (ch === "+" || ch === "/")
              ? " (switch to Standard Base64)"
              : "";
        throw new Error(
          `Invalid Base64 character '${ch}' at offset ${offset} (line ${line}, col ${col})${hint}.`,
        );
      }
      cleaned.push(ch);
      col += 1;
    }

    if (cleaned.length === 0) return new Uint8Array(0);
    if (padCount > 0 && cleaned.length % 4 !== 0) {
      throw new Error(
        `Malformed Base64 padding: length (${cleaned.length}) is not a multiple of 4.`,
      );
    }
    if (opts.padding && cleaned.length % 4 !== 0) {
      throw new Error(
        `Missing '=' padding: length (${cleaned.length}) must be a multiple of 4 (or uncheck strict padding).`,
      );
    }

    const dataLen = cleaned.length - padCount;
    if (dataLen % 4 === 1) {
      throw new Error(`Invalid Base64 quantum length (${dataLen} data chars).`);
    }

    const out: number[] = [];
    let i = 0;
    while (i + 4 <= dataLen) {
      const n =
        (lookup.get(cleaned[i]!)! << 18) |
        (lookup.get(cleaned[i + 1]!)! << 12) |
        (lookup.get(cleaned[i + 2]!)! << 6) |
        lookup.get(cleaned[i + 3]!)!;
      out.push((n >>> 16) & 255, (n >>> 8) & 255, n & 255);
      i += 4;
    }
    const rem = dataLen - i;
    if (rem === 2) {
      const a = lookup.get(cleaned[i]!)!;
      const b = lookup.get(cleaned[i + 1]!)!;
      if ((b & 0x0f) !== 0) {
        throw new Error("Non-canonical non-zero trailing Base64 pad bits (RFC 4648 §3.5).");
      }
      out.push(((a << 2) | (b >>> 4)) & 255);
    } else if (rem === 3) {
      const a = lookup.get(cleaned[i]!)!;
      const b = lookup.get(cleaned[i + 1]!)!;
      const c = lookup.get(cleaned[i + 2]!)!;
      if ((c & 0x03) !== 0) {
        throw new Error("Non-canonical non-zero trailing Base64 pad bits (RFC 4648 §3.5).");
      }
      out.push(((a << 2) | (b >>> 4)) & 255, ((b << 4) | (c >>> 2)) & 255);
    }
    return new Uint8Array(out);
  }

  if (opts.format === "hex") {
    const nibbles: number[] = [];
    let line = 1;
    let col = 1;
    for (let idx = 0; idx < chars.length; idx++) {
      const ch = chars[idx]!;
      const offset = idx + 1;
      if (ch === "\n") {
        if (!opts.ignoreWhitespace) {
          throw new Error(`Unexpected newline in Hex at offset ${offset}.`);
        }
        line += 1;
        col = 1;
        continue;
      }
      if (ch === " " || ch === "\t" || ch === "\r") {
        if (!opts.ignoreWhitespace) {
          throw new Error(`Unexpected whitespace in Hex at offset ${offset}.`);
        }
        col += 1;
        continue;
      }
      const v = Number.parseInt(ch, 16);
      if (Number.isNaN(v) || !/^[0-9a-fA-F]$/.test(ch)) {
        throw new Error(
          `Invalid hexadecimal character '${ch}' at offset ${offset} (line ${line}, col ${col}).`,
        );
      }
      nibbles.push(v);
      col += 1;
    }
    if (nibbles.length % 2 !== 0) {
      throw new Error(`Odd hexadecimal length (${nibbles.length} hex digits).`);
    }
    const out = new Uint8Array(nibbles.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = (nibbles[i * 2]! << 4) | nibbles[i * 2 + 1]!;
    }
    return out;
  }

  // binary
  const bits: number[] = [];
  let line = 1;
  let col = 1;
  for (let idx = 0; idx < chars.length; idx++) {
    const ch = chars[idx]!;
    const offset = idx + 1;
    if (ch === "\n") {
      if (!opts.ignoreWhitespace) {
        throw new Error(`Unexpected newline in Binary at offset ${offset}.`);
      }
      line += 1;
      col = 1;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      if (!opts.ignoreWhitespace) {
        throw new Error(`Unexpected whitespace in Binary at offset ${offset}.`);
      }
      col += 1;
      continue;
    }
    if (ch !== "0" && ch !== "1") {
      throw new Error(
        `Invalid binary bit '${ch}' at offset ${offset} (line ${line}, col ${col}); expected '0' or '1'.`,
      );
    }
    bits.push(ch === "1" ? 1 : 0);
    col += 1;
  }
  if (bits.length % 8 !== 0) {
    throw new Error(
      `Incomplete binary byte: got ${bits.length} bits (must be a multiple of 8 bits per byte).`,
    );
  }
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < out.length; i++) {
    let b = 0;
    for (let k = 0; k < 8; k++) {
      b = (b << 1) | bits[i * 8 + k]!;
    }
    out[i] = b;
  }
  return out;
}

function formatHexPreviewClient(bytes: Uint8Array): string {
  const slice = bytes.subarray(0, 256);
  const rows: string[] = [];
  for (let r = 0; r < slice.length; r += 16) {
    const chunk = Array.from(slice.subarray(r, r + 16))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
    rows.push(`${r.toString(16).padStart(4, "0")}: ${chunk}`);
  }
  if (bytes.length > 256) {
    rows.push(`… (+${bytes.length - 256} more bytes)`);
  }
  return rows.join("\n");
}

export function transformTextClientFallback(
  text: string,
  opts: CodecOptions,
): CodecTransformResponse {
  const inputBytes = new TextEncoder().encode(text);
  if (inputBytes.byteLength > MAX_CODEC_TEXT_BYTES) {
    throw JSON.stringify({
      code: "SIZE_LIMIT_EXCEEDED",
      message: "Interactive text input exceeds 2 MiB limit.",
    });
  }

  try {
    if (opts.operation === "encode") {
      const encoded = encodeBytesClient(inputBytes, opts);
      const outBytes = new TextEncoder().encode(encoded).byteLength;
      const codePoints = Array.from(encoded);
      const truncated = codePoints.length > PREVIEW_CHAR_LIMIT;
      return {
        inputByteLength: inputBytes.byteLength,
        outputByteLength: outBytes,
        isValidUtf8: true,
        previewText: truncated ? codePoints.slice(0, PREVIEW_CHAR_LIMIT).join("") : encoded,
        totalChars: codePoints.length,
        truncated,
        hexPreview: null,
        fileName: null,
      };
    }

    const decoded = decodeStringClient(text, opts);
    try {
      const utf8 = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
      const codePoints = Array.from(utf8);
      const truncated = codePoints.length > PREVIEW_CHAR_LIMIT;
      return {
        inputByteLength: inputBytes.byteLength,
        outputByteLength: decoded.byteLength,
        isValidUtf8: true,
        previewText: truncated ? codePoints.slice(0, PREVIEW_CHAR_LIMIT).join("") : utf8,
        totalChars: codePoints.length,
        truncated,
        hexPreview: null,
        fileName: null,
      };
    } catch {
      return {
        inputByteLength: inputBytes.byteLength,
        outputByteLength: decoded.byteLength,
        isValidUtf8: false,
        previewText: "",
        totalChars: 0,
        truncated: false,
        hexPreview: formatHexPreviewClient(decoded),
        fileName: null,
      };
    }
  } catch (err) {
    throw JSON.stringify({
      code: "DECODE_FAILED",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
