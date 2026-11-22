export const QR_READ_LIMITS = {
  files: 12,
  bytes: 16 * 1024 * 1024,
  pixels: 16_000_000,
  side: 8192,
  timeoutMs: 10_000,
} as const;

export type DecodeErrorCode = "unsupported" | "invalid" | "tooLarge" | "timeout" | "failed";

export class DecodeImageError extends Error {
  constructor(readonly code: DecodeErrorCode) {
    super(code);
    this.name = "DecodeImageError";
  }
}

export interface DecodedCode {
  format: string;
  text: string;
}

export interface DecodeImageResult {
  codes: DecodedCode[];
  thumbnail: Blob;
}

export type DecodeResponse = { result: DecodeImageResult } | { error: DecodeErrorCode };

function invalid(): never {
  throw new DecodeImageError("invalid");
}

export function checkDimensions(width: number, height: number) {
  if (!width || !height) invalid();
  if (
    width > QR_READ_LIMITS.side ||
    height > QR_READ_LIMITS.side ||
    width * height > QR_READ_LIMITS.pixels
  ) {
    throw new DecodeImageError("tooLarge");
  }
  return { width, height };
}

function fourCC(bytes: Uint8Array, at: number) {
  return String.fromCharCode(...bytes.subarray(at, at + 4));
}

function png(bytes: Uint8Array, view: DataView) {
  if (
    bytes.length < 33 ||
    view.getUint32(4) !== 0x0d0a1a0a ||
    view.getUint32(8) !== 13 ||
    fourCC(bytes, 12) !== "IHDR"
  )
    invalid();
  const size = checkDimensions(view.getUint32(16), view.getUint32(20));
  for (let i = 33; i + 12 <= bytes.length;) {
    const length = view.getUint32(i);
    if (i + 12 + length > bytes.length) invalid();
    const chunk = fourCC(bytes, i + 4);
    if (chunk === "acTL" || chunk === "IHDR") invalid();
    if (chunk === "IDAT") return { ...size, type: "image/png" };
    i += 12 + length;
  }
  return invalid();
}

function jpeg(bytes: Uint8Array, view: DataView) {
  for (let i = 2; i + 4 <= bytes.length;) {
    if (bytes[i++] !== 0xff) invalid();
    while (bytes[i] === 0xff) i++;
    const marker = bytes[i++];
    if (marker === undefined || i + 2 > bytes.length || marker === 0xda || marker === 0xd9)
      invalid();
    const length = view.getUint16(i);
    if (length < 2 || i + length > bytes.length) invalid();
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8) invalid();
      return {
        ...checkDimensions(view.getUint16(i + 5), view.getUint16(i + 3)),
        type: "image/jpeg",
      };
    }
    i += length;
  }
  return invalid();
}

function webp(bytes: Uint8Array, view: DataView) {
  if (view.getUint32(4, true) + 8 !== bytes.length) invalid();
  let canvas: { width: number; height: number } | undefined;
  let frame: { width: number; height: number } | undefined;
  for (let i = 12; i < bytes.length;) {
    if (i + 8 > bytes.length) invalid();
    const chunk = fourCC(bytes, i);
    const length = view.getUint32(i + 4, true);
    const start = i + 8;
    i = start + length + (length % 2);
    if (i > bytes.length) invalid();
    if (chunk === "ANIM" || chunk === "ANMF") throw new DecodeImageError("unsupported");
    if (chunk === "VP8X") {
      if (length !== 10 || canvas || start !== 20) invalid();
      if ((bytes[start]! & 2) !== 0) throw new DecodeImageError("unsupported");
      const u24 = (p: number) => view.getUint16(p, true) + bytes[p + 2]! * 65536;
      canvas = checkDimensions(u24(start + 4) + 1, u24(start + 7) + 1);
    } else if (chunk === "VP8L") {
      if (frame || length < 5 || bytes[start] !== 0x2f) invalid();
      const bits = view.getUint32(start + 1, true);
      frame = checkDimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    } else if (chunk === "VP8 ") {
      if (frame || length < 10 || (view.getUint32(start + 2) & 0xffffff) !== 0x9d012a) invalid();
      frame = checkDimensions(
        view.getUint16(start + 6, true) & 0x3fff,
        view.getUint16(start + 8, true) & 0x3fff,
      );
    }
  }
  if (!frame || (canvas && (canvas.width !== frame.width || canvas.height !== frame.height)))
    invalid();
  return { ...frame, type: "image/webp" };
}

// Inspect encoded bytes before asking the browser to allocate decoded pixels.
export function inspectImage(bytes: Uint8Array) {
  if (bytes.length > QR_READ_LIMITS.bytes) throw new DecodeImageError("tooLarge");
  if (bytes.length < 12) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) === 0x89504e47) return png(bytes, view);
  if (view.getUint16(0) === 0xffd8) return jpeg(bytes, view);
  if (fourCC(bytes, 0) === "RIFF" && fourCC(bytes, 8) === "WEBP") return webp(bytes, view);
  throw new DecodeImageError("unsupported");
}
