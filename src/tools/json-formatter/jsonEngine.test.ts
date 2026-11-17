import { describe, expect, it } from "vitest";
import { processJsonText } from "./jsonEngine";

describe("D01 lossless JSON engine", () => {
  it("treats empty and whitespace-only input as empty state", () => {
    expect(processJsonText("", { indent: "2", sortKeys: false }).status).toBe("empty");
    expect(processJsonText("   \n\t\r\n  ", { indent: "2", sortKeys: false }).status).toBe("empty");
  });

  it("handles objects, arrays, and all valid RFC 8259 root scalars", () => {
    for (const [raw, expectedKind] of [
      ['{"a":1}', "object"],
      ["[1, 2, 3]", "array"],
      ['"hello"', "string"],
      ["42", "number"],
      ["true", "boolean"],
      ["false", "boolean"],
      ["null", "null"],
    ] as const) {
      const res = processJsonText(raw, { indent: "2", sortKeys: false });
      expect(res.status).toBe("valid");
      if (res.status === "valid") {
        expect(res.rootKind).toBe(expectedKind);
      }
    }
  });

  it("preserves large integers and exact decimal representations without IEEE-754 corruption", () => {
    const src =
      '{"id": 9007199254740993, "huge": 123456789012345678901234567890, "neg": -9223372036854775808, "price": 19.90, "negZero": -0}';
    const res = processJsonText(src, { indent: "2", sortKeys: false });
    expect(res.status).toBe("valid");
    if (res.status === "valid") {
      expect(res.hasPrecisionSensitiveNumbers).toBe(true);
      expect(res.formatted).toContain('"id": 9007199254740993');
      expect(res.formatted).toContain('"huge": 123456789012345678901234567890');
      expect(res.formatted).toContain('"neg": -9223372036854775808');
      expect(res.formatted).toContain('"price": 19.90');
      expect(res.formatted).toContain('"negZero": -0');
      expect(res.minified).toBe(
        '{"id":9007199254740993,"huge":123456789012345678901234567890,"neg":-9223372036854775808,"price":19.90,"negZero":-0}',
      );
    }
  });

  it("handles Unicode characters, surrogate pairs, nested structures, and optional key sorting", () => {
    const src = '{"z": ["中文测试", "🚀", "\\u4f60\\u597d"], "a": {"nested": [true, false, null]}}';
    const unsorted = processJsonText(src, { indent: "4", sortKeys: false });
    expect(unsorted.status).toBe("valid");
    if (unsorted.status === "valid") {
      expect(unsorted.formatted.indexOf('"z"')).toBeLessThan(unsorted.formatted.indexOf('"a"'));
      expect(unsorted.formatted).toContain('"中文测试"');
      expect(unsorted.formatted).toContain('"🚀"');
      expect(unsorted.formatted).toContain('"\\u4f60\\u597d"');
    }

    const sorted = processJsonText(src, { indent: "tab", sortKeys: true });
    expect(sorted.status).toBe("valid");
    if (sorted.status === "valid") {
      expect(sorted.formatted.indexOf('"a"')).toBeLessThan(sorted.formatted.indexOf('"z"'));
      expect(sorted.formatted).toContain('\n\t"a": {');
    }
  });

  it("preserves duplicate keys and reports duplicate count instead of silently dropping entries", () => {
    const src = '{"dup": 1, "dup": 2}';
    const res = processJsonText(src, { indent: "2", sortKeys: false });
    expect(res.status).toBe("valid");
    if (res.status === "valid") {
      expect(res.duplicateKeyCount).toBe(1);
      expect(res.minified).toBe('{"dup":1,"dup":2}');
    }
  });

  it("reports accurate 1-based line and column on invalid JSON without executing content", () => {
    const broken = '{\n  "name": "WinKit",\n  "bad": truX\n}';
    const res = processJsonText(broken, { indent: "2", sortKeys: false });
    expect(res.status).toBe("invalid");
    if (res.status === "invalid") {
      expect(res.error.line).toBe(3);
      expect(res.error.column).toBe(10);
    }

    // Rejects JavaScript expressions / trailing commas / single quotes / leading zeros
    for (const invalidSample of [
      "{'single': 1}",
      '{"trailing": 1,}',
      "[1, 2,]",
      '{"num": 01}',
      '{"fn": alert(1)}',
      '{"unclosed": "line1\nline2"}',
      '{"a": 1} extra',
    ]) {
      const r = processJsonText(invalidSample, { indent: "2", sortKeys: false });
      expect(r.status).toBe("invalid");
    }
  });
});
