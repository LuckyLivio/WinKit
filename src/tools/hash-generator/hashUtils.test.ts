import { describe, expect, it } from "vitest";
import { compareSha256Digest, normalizeExpectedSha256, utf8ByteLength } from "./hashUtils";

const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("D03 SHA-256 digest normalization and comparison", () => {
  it("normalizes uppercase, sha256: prefix, shasum output, and colon/space grouped hex", () => {
    expect(normalizeExpectedSha256("")).toEqual({ isEmpty: true, normalizedHex: null });
    expect(normalizeExpectedSha256(`SHA256: ${ABC_SHA256.toUpperCase()}`).normalizedHex).toBe(
      ABC_SHA256,
    );
    expect(
      normalizeExpectedSha256(`${ABC_SHA256}  *WinKit_0.1.0_x64-setup.exe`).normalizedHex,
    ).toBe(ABC_SHA256);
    const colonGrouped = ABC_SHA256.match(/.{1,2}/g)!.join(":");
    expect(normalizeExpectedSha256(colonGrouped).normalizedHex).toBe(ABC_SHA256);
  });

  it("rejects malformed or wrong-length digests and compares accurately", () => {
    expect(compareSha256Digest(ABC_SHA256, "not-a-valid-sha256")).toBe("invalid_format");
    expect(compareSha256Digest(ABC_SHA256, "d41d8cd98f00b204e9800998ecf8427e")).toBe(
      "invalid_format",
    ); // 32-char MD5 rejected cleanly in SHA-256 mode
    expect(compareSha256Digest(ABC_SHA256, ABC_SHA256.toUpperCase())).toBe("match");
    expect(
      compareSha256Digest(
        ABC_SHA256,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ),
    ).toBe("mismatch");
  });

  it("counts exact UTF-8 bytes including spaces, newlines, and multi-byte Unicode", () => {
    expect(utf8ByteLength("")).toBe(0);
    expect(utf8ByteLength("  \n")).toBe(3);
    expect(utf8ByteLength("中文🚀")).toBe(10);
  });
});
