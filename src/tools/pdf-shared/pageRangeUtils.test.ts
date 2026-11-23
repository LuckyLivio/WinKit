import { describe, expect, it } from "vitest";
import { formatCompactPages, parseClientPageRanges } from "./pageRangeUtils";

describe("pageRangeUtils", () => {
  it("parses valid ranges, reports duplicates, and formats compactly", () => {
    const parsed = parseClientPageRanges("1-3, 5, 3, 7-8", 10);
    expect(parsed.valid).toBe(true);
    expect(parsed.pages).toEqual([1, 2, 3, 5, 3, 7, 8]);
    expect(parsed.uniqueSorted).toEqual([1, 2, 3, 5, 7, 8]);
    expect(parsed.duplicateCount).toBe(1);
    expect(formatCompactPages(parsed.uniqueSorted)).toBe("1-3, 5, 7-8");
  });

  it("rejects out-of-bounds, reversed, and non-numeric inputs", () => {
    expect(parseClientPageRanges("0-2", 5).valid).toBe(false);
    expect(parseClientPageRanges("4-2", 5).valid).toBe(false);
    expect(parseClientPageRanges("1-6", 5).valid).toBe(false);
    expect(parseClientPageRanges("abc", 5).valid).toBe(false);
    expect(parseClientPageRanges("", 5).valid).toBe(false);
  });
});
