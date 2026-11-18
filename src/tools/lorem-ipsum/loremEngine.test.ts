import { describe, expect, it } from "vitest";
import { CLASSIC_OPENING_SENTENCE, generateLoremIpsum } from "./loremEngine";

function stripHtmlParagraphTags(html: string): string {
  return html.replace(/<\/?p>/g, " ").trim();
}

describe("D12 loremEngine", () => {
  it("counts the classic opening inside the requested word count without excluding or counting HTML tags", () => {
    // 10 words with classic opening enabled must produce EXACTLY 10 words, not 8 + 10 = 18
    const w10Plain = generateLoremIpsum({
      unit: "words",
      rawCount: "10",
      format: "plain",
      startWithClassic: true,
      seed: 42,
    });
    expect(w10Plain.status).toBe("ok");
    if (w10Plain.status !== "ok") return;
    expect(w10Plain.output.startsWith("Lorem ipsum dolor sit amet,")).toBe(true);
    expect(w10Plain.output.split(/\s+/)).toHaveLength(10);
    expect(w10Plain.wordCount).toBe(10);

    // 5 words (< 8 classic opening words) truncates cleanly at 5 words
    const w5Html = generateLoremIpsum({
      unit: "words",
      rawCount: "5",
      format: "html",
      startWithClassic: true,
      seed: 42,
    });
    expect(w5Html.status).toBe("ok");
    if (w5Html.status === "ok") {
      expect(w5Html.output).toBe("<p>Lorem ipsum dolor sit amet.</p>");
      expect(stripHtmlParagraphTags(w5Html.output).split(/\s+/)).toHaveLength(5);
      expect(w5Html.wordCount).toBe(5);
    }

    // 1 word edge case
    const w1 = generateLoremIpsum({
      unit: "words",
      rawCount: "1",
      format: "plain",
      startWithClassic: true,
      seed: 42,
    });
    expect(w1.status === "ok" && w1.output).toBe("Lorem");
  });

  it("generates exact sentence and paragraph counts across plain, HTML, and Markdown formats", () => {
    const s1 = generateLoremIpsum({
      unit: "sentences",
      rawCount: "1",
      format: "plain",
      startWithClassic: true,
      seed: 7,
    });
    expect(s1.status === "ok" && s1.output).toBe(CLASSIC_OPENING_SENTENCE);

    const s4 = generateLoremIpsum({
      unit: "sentences",
      rawCount: "4",
      format: "plain",
      startWithClassic: false,
      seed: 7,
    });
    expect(s4.status).toBe("ok");
    if (s4.status === "ok") {
      expect(s4.output.startsWith("Lorem ipsum dolor sit amet")).toBe(false);
      expect(s4.output.match(/\./g)).toHaveLength(4);
      expect(s4.sentenceCount).toBe(4);
    }

    const p3Html = generateLoremIpsum({
      unit: "paragraphs",
      rawCount: "3",
      format: "html",
      startWithClassic: true,
      seed: 99,
    });
    const p3Md = generateLoremIpsum({
      unit: "paragraphs",
      rawCount: "3",
      format: "markdown",
      startWithClassic: true,
      seed: 99,
    });
    expect(p3Html.status).toBe("ok");
    expect(p3Md.status).toBe("ok");
    if (p3Html.status === "ok" && p3Md.status === "ok") {
      expect(p3Html.output.split("\n")).toHaveLength(3);
      expect(p3Html.output.startsWith(`<p>${CLASSIC_OPENING_SENTENCE}`)).toBe(true);
      expect(p3Md.output.split("\n\n")).toHaveLength(3);
      expect(p3Md.wordCount).toBe(p3Html.wordCount);
    }
  });

  it("rejects 0, negative numbers, non-integers, and counts exceeding unit caps", () => {
    for (const bad of ["", "0", "-3", "2.5", "abc", "5001"]) {
      const res = generateLoremIpsum({
        unit: "words",
        rawCount: bad,
        format: "plain",
        startWithClassic: true,
        seed: 1,
      });
      expect(res.status).toBe("invalid");
    }

    expect(
      generateLoremIpsum({
        unit: "sentences",
        rawCount: "501",
        format: "plain",
        startWithClassic: true,
        seed: 1,
      }).status,
    ).toBe("invalid");

    expect(
      generateLoremIpsum({
        unit: "paragraphs",
        rawCount: "101",
        format: "plain",
        startWithClassic: true,
        seed: 1,
      }).status,
    ).toBe("invalid");
  });
});
