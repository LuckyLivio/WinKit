// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import { inspectImage, QR_READ_LIMITS } from "./decodeFormat";
import { decodeImage } from "./decodeImage";

const fixture = (name: string) => readFileSync(resolve("tests/fixtures/f01", name));

describe("F01 bounded image decoding", () => {
  it.each([
    ["mixed.png", "image/png", 779, 402],
    ["code128.jpg", "image/jpeg", 507, 110],
    ["ean13.webp", "image/webp", 339, 110],
  ])("reads actual %s dimensions from the encoded bytes", (file, type, width, height) => {
    expect(inspectImage(fixture(file as string))).toEqual({ type, width, height });
  });

  it("decodes independently rendered QR, Code 128 and EAN-13 together with the bundled reader", async () => {
    const wasm = createRequire(import.meta.url).resolve("zxing-wasm/reader/zxing_reader.wasm");
    prepareZXingModule({ overrides: { wasmBinary: new Uint8Array(readFileSync(wasm)).buffer } });
    const results = await readBarcodes(fixture("mixed.png"), {
      textMode: "Plain",
      maxNumberOfSymbols: 64,
    });
    expect(
      results
        .filter((item) => item.isValid)
        .map((item) => item.text)
        .sort(),
    ).toEqual(["5901234123457", "Independent QR sample", "WINKIT-128"]);
  });

  it("rejects oversized PNG and WebP frame dimensions before rasterizing, and rejects truncated data", () => {
    const png = fixture("mixed.png");
    png.writeUInt32BE(QR_READ_LIMITS.side + 1, 16);
    expect(() => inspectImage(png)).toThrow("tooLarge");
    png.writeUInt32BE(5000, 16);
    png.writeUInt32BE(5000, 20);
    expect(() => inspectImage(png)).toThrow("tooLarge");
    const webp = fixture("ean13.webp");
    const frame = webp.indexOf(Buffer.from("VP8 "));
    expect(frame).toBeGreaterThan(0);
    webp.writeUInt16LE(QR_READ_LIMITS.side + 1, frame + 14);
    expect(() => inspectImage(webp)).toThrow("tooLarge");
    expect(() => inspectImage(fixture("mixed.png").subarray(0, 37))).toThrow("invalid");
    expect(() => inspectImage(fixture("code128.jpg").subarray(0, 30))).toThrow("invalid");
    expect(() => inspectImage(webp.subarray(0, 30))).toThrow("invalid");
    expect(() => inspectImage(new Uint8Array(40))).toThrow("unsupported");
  });
});

describe("F01 Worker lifetime", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["cancel", "timeout"] as const)(
    "terminates on %s and ignores a late success",
    async (reason) => {
      vi.useFakeTimers();
      const terminate = vi.fn();
      let sendLate: () => void = () => {
        throw new Error("worker never received the image");
      };
      vi.stubGlobal(
        "Worker",
        class {
          onmessage?: (event: { data: unknown }) => void;
          terminate = terminate;
          postMessage() {
            const handler = this.onmessage;
            sendLate = () =>
              handler?.({ data: { result: { codes: [{ text: "late" }], thumbnail: new Blob() } } });
          }
        },
      );
      const controller = new AbortController();
      const result = decodeImage(new Blob(["image"]), controller.signal);
      const check =
        reason === "cancel"
          ? expect(result).rejects.toMatchObject({ name: "AbortError" })
          : expect(result).rejects.toMatchObject({ code: "timeout" });
      if (reason === "cancel") controller.abort();
      else vi.advanceTimersByTime(QR_READ_LIMITS.timeoutMs);
      sendLate();
      await check;
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("rejects oversized files before creating a worker", async () => {
    const factory = vi.fn();
    vi.stubGlobal("Worker", factory);
    const file = { size: QR_READ_LIMITS.bytes + 1 } as Blob;
    await expect(decodeImage(file, new AbortController().signal)).rejects.toMatchObject({
      code: "tooLarge",
    });
    expect(factory).not.toHaveBeenCalled();
  });
});
