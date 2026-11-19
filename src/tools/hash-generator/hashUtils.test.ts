import { describe, expect, it } from "vitest";
import {
  buildHashBatchCsvBounded,
  compareMultiDigests,
  computeMd5HexFallback,
  formatBatchCopyAllText,
  normalizeExpectedDigest,
  utf8ByteLength,
  type AlgorithmDigestEntry,
  type HashBatchFileItem,
} from "./hashUtils";

const ABC_DIGESTS: AlgorithmDigestEntry[] = [
  { algorithm: "MD5", hexLength: 32, digestHex: "900150983cd24fb0d6963f7d28e17f72" },
  { algorithm: "SHA-1", hexLength: 40, digestHex: "a9993e364706816aba3e25717850c26c9cd0d89d" },
  {
    algorithm: "SHA-256",
    hexLength: 64,
    digestHex: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  },
  {
    algorithm: "SHA-384",
    hexLength: 96,
    digestHex:
      "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7",
  },
  {
    algorithm: "SHA-512",
    hexLength: 128,
    digestHex:
      "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
  },
];

describe("D03 multi-algorithm digest normalization, grouped-hex disambiguation, and batch export", () => {
  it("normalizes grouped SHA-256 (32+32), prefixes, BSD tags, and standard shasum lines without truncating", () => {
    expect(normalizeExpectedDigest("")).toEqual({
      status: "empty",
      isEmpty: true,
      normalizedHex: null,
      candidateAlgorithm: null,
    });

    // Regression B3: SHA-256("abc") split into two 32-hex halves by a space must NEVER be truncated to MD5
    const groupedSha256 = "ba7816bf8f01cfea414140de5dae2223 b00361a396177a9cb410ff61f20015ad";
    expect(normalizeExpectedDigest(groupedSha256)).toEqual({
      status: "ok",
      isEmpty: false,
      normalizedHex: ABC_DIGESTS[2]!.digestHex,
      candidateAlgorithm: "SHA-256",
    });
    expect(compareMultiDigests(ABC_DIGESTS, ["MD5", "SHA-256"], groupedSha256)).toEqual({
      kind: "match",
      matchedAlgorithm: "SHA-256",
      hexLength: 64,
    });

    // Prefix & BSD tag formats
    expect(normalizeExpectedDigest(`MD5: ${ABC_DIGESTS[0]!.digestHex.toUpperCase()}`)).toEqual({
      status: "ok",
      isEmpty: false,
      normalizedHex: ABC_DIGESTS[0]!.digestHex,
      candidateAlgorithm: "MD5",
    });
    expect(
      normalizeExpectedDigest(`SHA256 (WinKit_setup.exe) = ${ABC_DIGESTS[2]!.digestHex}`),
    ).toEqual({
      status: "ok",
      isEmpty: false,
      normalizedHex: ABC_DIGESTS[2]!.digestHex,
      candidateAlgorithm: "SHA-256",
    });

    // Standard binary `*filename` and two-space `  filename` shasum lines
    expect(
      normalizeExpectedDigest(`${ABC_DIGESTS[2]!.digestHex} *WinKit_0.6.0_x64-setup.exe`),
    ).toEqual({
      status: "ok",
      isEmpty: false,
      normalizedHex: ABC_DIGESTS[2]!.digestHex,
      candidateAlgorithm: "SHA-256",
    });
    expect(
      normalizeExpectedDigest(`${ABC_DIGESTS[2]!.digestHex}  WinKit_0.6.0_x64-setup.exe`),
    ).toEqual({
      status: "ok",
      isEmpty: false,
      normalizedHex: ABC_DIGESTS[2]!.digestHex,
      candidateAlgorithm: "SHA-256",
    });

    const colonSha1 = ABC_DIGESTS[1]!.digestHex.match(/.{1,2}/g)!.join(":");
    expect(normalizeExpectedDigest(colonSha1).candidateAlgorithm).toBe("SHA-1");
  });

  it("flags prefix-length contradictions as invalid and ambiguous shasum/hex combinations as ambiguous", () => {
    // Prefix declares SHA-256 (64 hex) while digest has 32 hex (MD5)
    expect(
      compareMultiDigests(ABC_DIGESTS, ["MD5", "SHA-256"], `SHA-256: ${ABC_DIGESTS[0]!.digestHex}`),
    ).toEqual({
      kind: "invalid_format",
      reason: "prefix_length_mismatch",
    });

    // Ambiguous: 32-hex + space + 8-hex (`32 + 8 = 40`) without prefix
    expect(
      compareMultiDigests(ABC_DIGESTS, ["MD5", "SHA-1"], `${ABC_DIGESTS[0]!.digestHex} deadbeef`),
    ).toEqual({ kind: "ambiguous_format" });

    // Ambiguous: two spaces between two 32-hex chunks without `*` or algorithm prefix
    expect(
      compareMultiDigests(
        ABC_DIGESTS,
        ["MD5", "SHA-256"],
        "ba7816bf8f01cfea414140de5dae2223  b00361a396177a9cb410ff61f20015ad",
      ),
    ).toEqual({ kind: "ambiguous_format" });

    // Ambiguous: single-space `<32-hex> filename.bin` without `*`
    expect(
      compareMultiDigests(ABC_DIGESTS, ["MD5"], `${ABC_DIGESTS[0]!.digestHex} filename.bin`),
    ).toEqual({ kind: "ambiguous_format" });
  });

  it("distinguishes invalid format, uncomputed candidate algorithm, match, and mismatch", () => {
    expect(compareMultiDigests(ABC_DIGESTS, ["SHA-256"], "not-hex").kind).toBe("invalid_format");
    expect(compareMultiDigests(ABC_DIGESTS, ["SHA-256"], "abcd1234").kind).toBe("invalid_format");

    // Valid 32-hex MD5 when only SHA-256 is selected -> candidate_uncomputed
    expect(compareMultiDigests([ABC_DIGESTS[2]!], ["SHA-256"], ABC_DIGESTS[0]!.digestHex)).toEqual({
      kind: "candidate_uncomputed",
      candidateAlgorithm: "MD5",
      hexLength: 32,
    });

    // Match when candidate algorithm is selected & computed
    expect(
      compareMultiDigests(
        ABC_DIGESTS,
        ["MD5", "SHA-256", "SHA-512"],
        ABC_DIGESTS[4]!.digestHex.toUpperCase(),
      ),
    ).toEqual({
      kind: "match",
      matchedAlgorithm: "SHA-512",
      hexLength: 128,
    });

    expect(
      compareMultiDigests(ABC_DIGESTS, ["MD5", "SHA-256"], "d41d8cd98f00b204e9800998ecf8427e"),
    ).toEqual({
      kind: "mismatch",
      candidateAlgorithm: "MD5",
      hexLength: 32,
    });
  });

  it("formats labeled batch Copy All text and bounded CSV with formula protection", () => {
    const items: HashBatchFileItem[] = [
      {
        itemId: "1",
        path: "D:\\dirA\\=report.bin",
        fileName: "=report.bin",
        byteLength: 3,
        status: "completed",
        processedBytes: 3,
        progressPercent: 100,
        digests: [ABC_DIGESTS[0]!, ABC_DIGESTS[2]!],
        errorCode: null,
        errorMessage: null,
        expectedHash: ABC_DIGESTS[2]!.digestHex,
      },
      {
        itemId: "2",
        path: "D:\\dirB\\missing.bin",
        fileName: "missing.bin",
        byteLength: null,
        status: "error",
        processedBytes: 0,
        progressPercent: null,
        digests: null,
        errorCode: "FILE_NOT_FOUND",
        errorMessage: "not found",
        expectedHash: "",
      },
    ];

    const copyText = formatBatchCopyAllText(items, ["MD5", "SHA-256"], true);
    expect(copyText).toContain("# =report.bin (D:\\dirA\\=report.bin)");
    expect(copyText).toContain(`MD5: ${ABC_DIGESTS[0]!.digestHex.toUpperCase()}`);
    expect(copyText).toContain(`SHA-256: ${ABC_DIGESTS[2]!.digestHex.toUpperCase()}`);
    expect(copyText).not.toContain("missing.bin");

    const csvOut = buildHashBatchCsvBounded(items, ["SHA-256"], {
      uppercase: false,
      formulaProtection: true,
    });
    expect(csvOut.ok).toBe(true);
    if (csvOut.ok) {
      expect(csvOut.formulaCellCount).toBe(1);
      expect(csvOut.csv).toContain("1,'=report.bin,D:\\dirA\\=report.bin,3,completed");
      expect(csvOut.csv).toContain("match (SHA-256)");
      expect(csvOut.csv).toContain("2,missing.bin,D:\\dirB\\missing.bin,,error");
    }
  });

  it("computes exact RFC 1321 MD5 fallback vectors and exact UTF-8 byte counts", () => {
    const enc = new TextEncoder();
    expect(computeMd5HexFallback(enc.encode(""))).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(computeMd5HexFallback(enc.encode("abc"))).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(
      computeMd5HexFallback(
        enc.encode("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"),
      ),
    ).toBe("d174ab98d277d9f5a5611c2c9f419d9f");

    expect(utf8ByteLength("")).toBe(0);
    expect(utf8ByteLength("  \r\n")).toBe(4);
    expect(utf8ByteLength("中文🚀")).toBe(10);
  });
});
