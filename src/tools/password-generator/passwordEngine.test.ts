import { describe, expect, it } from "vitest";
import {
  computeExactConstrainedPasswordBits,
  generateSecretsClientFallback,
  getEffWordlist,
  LOOKALIKE_CHARS,
  previewSecretConfigStrength,
  sampleUniformIndex,
  SYMBOL_CHARS,
} from "./passwordEngine";

describe("D13 passwordEngine", () => {
  it("validates EFF wordlist membership, bounds, look-alike exclusion, and category constraints", () => {
    const words = getEffWordlist();
    expect(words.length).toBe(7_772);
    expect(words.every((w) => /^[a-z]{3,}$/.test(w))).toBe(true);
    expect(new Set(words).size).toBe(7_772);

    // Rejects invalid bounds and empty categories
    expect(
      previewSecretConfigStrength({
        mode: "password",
        length: 7,
        count: 1,
        uppercase: true,
        lowercase: true,
        digits: true,
        symbols: true,
        excludeLookAlikes: true,
        requireEachSelectedClass: true,
      }).ok,
    ).toBe(false);

    expect(
      previewSecretConfigStrength({
        mode: "password",
        length: 16,
        count: 51,
        uppercase: true,
        lowercase: false,
        digits: false,
        symbols: false,
        excludeLookAlikes: false,
        requireEachSelectedClass: false,
      }).ok,
    ).toBe(false);

    expect(
      previewSecretConfigStrength({
        mode: "password",
        length: 16,
        count: 1,
        uppercase: false,
        lowercase: false,
        digits: false,
        symbols: false,
        excludeLookAlikes: false,
        requireEachSelectedClass: false,
      }).ok,
    ).toBe(false);

    // Generates batch of 50 passwords satisfying every selected class and zero look-alikes
    const batch = generateSecretsClientFallback({
      mode: "password",
      length: 12,
      count: 50,
      uppercase: true,
      lowercase: true,
      digits: true,
      symbols: true,
      excludeLookAlikes: true,
      requireEachSelectedClass: true,
    });
    expect(batch.items).toHaveLength(50);
    for (const pw of batch.items) {
      expect(pw).toHaveLength(12);
      expect([...pw].some((c) => LOOKALIKE_CHARS.includes(c))).toBe(false);
      expect(/[A-Z]/.test(pw)).toBe(true);
      expect(/[a-z]/.test(pw)).toBe(true);
      expect(/[0-9]/.test(pw)).toBe(true);
      expect([...pw].some((c) => SYMBOL_CHARS.includes(c))).toBe(true);
    }
  });

  it("enforces unbiased zone rejection, bounded candidate rejection, and exact model entropy formulas", () => {
    // 1. Verify zone rejection skips values in `[zone, 2^32)` for non-power-of-two `n = 3`:
    // `2^32 % 3 == 1`, so `zone = 0xFFFF_FFFF` (`4294967295`); `0xFFFF_FFFF` MUST be rejected!
    const scriptedValues = [0xffffffff, 5]; // 5 % 3 == 2
    let idx = 0;
    const picked = sampleUniformIndex(() => scriptedValues[idx++] ?? 0, 3);
    expect(picked).toBe(2);
    expect(idx).toBe(2);

    // 2. Deterministic all-zero RNG fails bounded rejection when >= 2 classes are required
    expect(() =>
      generateSecretsClientFallback(
        {
          mode: "password",
          length: 10,
          count: 1,
          uppercase: true,
          lowercase: true,
          digits: false,
          symbols: false,
          excludeLookAlikes: false,
          requireEachSelectedClass: true,
        },
        () => 0,
      ),
    ).toThrow(/SAMPLING_BUDGET_EXCEEDED/);

    // 3. Exact inclusion-exclusion check: 2 classes of size 1 (`S=2`), L=8 -> |V| = 256 - 2 = 254
    expect(computeExactConstrainedPasswordBits(8, [1, 1])).toBeCloseTo(Math.log2(254), 10);

    // 4. Passphrase entropy: 6 words * log2(7772) + log2(100) = 77.5444 + 6.643856 = 84.19 bits
    const ppWithSep = previewSecretConfigStrength({
      mode: "passphrase",
      wordCount: 6,
      count: 2,
      separator: "-",
      capitalizeWords: true,
      includeNumber: true,
    });
    expect(ppWithSep.ok).toBe(true);
    if (ppWithSep.ok) {
      expect(ppWithSep.strength.isUpperBound).toBe(false);
      expect(ppWithSep.strength.estimatedBits).toBeCloseTo(6 * Math.log2(7772) + Math.log2(100), 1);
    }

    // Empty separator + lowercase marks selection entropy as upper bound
    const ppEmptyLower = previewSecretConfigStrength({
      mode: "passphrase",
      wordCount: 6,
      count: 1,
      separator: "",
      capitalizeWords: false,
      includeNumber: false,
    });
    expect(ppEmptyLower.ok && ppEmptyLower.strength.isUpperBound).toBe(true);
  });
});
