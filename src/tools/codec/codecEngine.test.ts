import { describe, expect, it } from "vitest";
import {
  decodeStringClient,
  encodeBytesClient,
  transformTextClientFallback,
  type CodecOptions,
} from "./codecEngine";

function makeOpts(
  format: CodecOptions["format"],
  operation: CodecOptions["operation"],
  overrides: Partial<CodecOptions> = {},
): CodecOptions {
  return {
    format,
    operation,
    padding: format === "base64_standard",
    wrap: "none",
    ignoreWhitespace: true,
    uppercaseHex: false,
    groupBits: true,
    ...overrides,
  };
}

describe("D02 Base64 / Hex / Binary codec engine", () => {
  it("matches RFC 4648 vectors and preserves byte-level 0x00..0xFF round-trip", () => {
    expect(transformTextClientFallback("", makeOpts("base64_standard", "encode")).previewText).toBe(
      "",
    );
    expect(
      transformTextClientFallback("foobar", makeOpts("base64_standard", "encode")).previewText,
    ).toBe("Zm9vYmFy");
    expect(
      transformTextClientFallback("foobar", makeOpts("hex", "encode", { uppercaseHex: true }))
        .previewText,
    ).toBe("666F6F626172");

    // Full 0x00..=0xFF binary round-trip across all 4 encodings
    const allBytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    for (const fmt of ["base64_standard", "base64_url", "hex", "binary"] as const) {
      const encoded = encodeBytesClient(allBytes, makeOpts(fmt, "encode"));
      const decoded = decodeStringClient(encoded, makeOpts(fmt, "decode"));
      expect(Array.from(decoded)).toEqual(Array.from(allBytes));
    }
  });

  it("refuses to silently replace invalid UTF-8 bytes with garbled text", () => {
    // 0xFF 0xFE 0x00 0x89 in hex -> invalid UTF-8!
    const resp = transformTextClientFallback("fffe0089", makeOpts("hex", "decode"));
    expect(resp.isValidUtf8).toBe(false);
    expect(resp.previewText).toBe("");
    expect(resp.outputByteLength).toBe(4);
    expect(resp.hexPreview).toContain("ff fe 00 89");
  });

  it("reports exact offsets for invalid characters, bad padding, odd hex, and partial binary bytes", () => {
    expect(() => decodeStringClient("Zm9-", makeOpts("base64_standard", "decode"))).toThrow(
      /offset 4/,
    );
    expect(() =>
      decodeStringClient("Zg", makeOpts("base64_standard", "decode", { padding: true })),
    ).toThrow(/padding/);
    expect(() => decodeStringClient("4a6f6", makeOpts("hex", "decode"))).toThrow(/Odd hexadecimal/);
    expect(() => decodeStringClient("0100001", makeOpts("binary", "decode"))).toThrow(/7 bits/);
  });
});
