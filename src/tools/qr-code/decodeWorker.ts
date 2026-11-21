/// <reference lib="webworker" />
/// <reference types="vite/client" />

import { formatToLabel, prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import readerUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import {
  DecodeImageError,
  inspectImage,
  type DecodeImageResult,
  type DecodeResponse,
} from "./decodeFormat";

prepareZXingModule({ overrides: { locateFile: () => readerUrl } });

async function readImage(file: Blob): Promise<DecodeImageResult> {
  const encoded = await file.arrayBuffer();
  const header = inspectImage(new Uint8Array(encoded));
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([encoded], { type: header.type }));
  } catch {
    throw new DecodeImageError("invalid");
  }

  try {
    // EXIF may swap the axes when the browser applies the image orientation.
    if (!(
      (bitmap.width === header.width && bitmap.height === header.height) ||
      (bitmap.width === header.height && bitmap.height === header.width)
    ))
      throw new DecodeImageError("invalid");
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new DecodeImageError("failed");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const scale = Math.min(1, 240 / bitmap.width, 180 / bitmap.height);
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const thumbnail = await canvas.convertToBlob({ type: "image/png" });
    const symbols = await readBarcodes(data, { textMode: "Plain", maxNumberOfSymbols: 64 });
    const codes = symbols
      .filter((symbol) => symbol.isValid)
      .map((symbol) => ({
        format: formatToLabel(symbol.format) ?? symbol.format,
        text: symbol.text,
      }));
    return { codes, thumbnail };
  } finally {
    bitmap.close();
  }
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async (event: MessageEvent<Blob>) => {
  let response: DecodeResponse;
  try {
    response = { result: await readImage(event.data) };
  } catch (err) {
    response = { error: err instanceof DecodeImageError ? err.code : "failed" };
  }
  scope.postMessage(response);
};
