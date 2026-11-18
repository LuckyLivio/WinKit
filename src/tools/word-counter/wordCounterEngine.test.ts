import { describe, expect, it } from "vitest";
import { analyzeTextMetrics } from "./wordCounterEngine";

describe("T08 Unicode Grapheme & Intl.Segmenter Word Counter Engine", () => {
  it("handles empty text, whitespace-only text, CRLF, trailing newlines, and multiple blank lines", () => {
    const empty = analyzeTextMetrics("");
    expect(empty.stats).toMatchObject({
      words: 0,
      charsWithSpaces: 0,
      charsNoWhitespace: 0,
      sentences: 0,
      paragraphs: 0,
      lines: 0,
      utf8Bytes: 0,
      readingSeconds: 0,
    });

    // CRLF + trailing newline + consecutive blank lines
    const crlfSample = "First paragraph line 1.\r\nLine 2.\r\n\r\n   \r\nSecond paragraph!\r\n";
    const crlfRes = analyzeTextMetrics(crlfSample).stats!;
    expect(crlfRes.lines).toBe(6); // trailing \r\n adds empty 6th physical line
    expect(crlfRes.paragraphs).toBe(2);
    expect(crlfRes.sentences).toBe(3);
  });

  it("counts ZWJ emoji sequences and combining marks as single graphemes rather than UTF-16 code units", () => {
    // "👨‍👩‍👧‍👦" has .length === 11 in JS UTF-16, "e\u0301" has .length === 2!
    const tricky = "👨‍👩‍👧‍👦 e\u0301";
    expect(tricky.length).toBe(14);
    const res = analyzeTextMetrics(tricky).stats!;
    expect(res.charsWithSpaces).toBe(3); // 1 family emoji + 1 space + 1 accented 'é'
    expect(res.charsNoWhitespace).toBe(2);
    expect(res.utf8Bytes).toBe(29); // 25 + 1 + 3
  });

  it("segments mixed Chinese and English text and extracts stopword-filtered frequent words", () => {
    const mixed = "WinKit 本地工具箱支持中文分词。WinKit 运行在本地桌面！";
    const res = analyzeTextMetrics(mixed).stats!;
    expect(res.words).toBeGreaterThanOrEqual(8);
    expect(res.sentences).toBe(2);
    expect(res.readingSeconds).toBeGreaterThan(0);
    expect(res.topWords.slice(0, 2)).toEqual(
      expect.arrayContaining([
        { word: "本地", count: 2 },
        { word: "winkit", count: 2 },
      ]),
    );
  });
});
