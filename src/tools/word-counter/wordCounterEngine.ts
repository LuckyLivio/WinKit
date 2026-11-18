export const MAX_WORD_COUNTER_BYTES = 2 * 1024 * 1024; // 2 MiB safety ceiling

export interface FrequentWordItem {
  word: string;
  count: number;
}

export interface WordCountAnalysis {
  words: number;
  charsWithSpaces: number;
  charsNoWhitespace: number;
  sentences: number;
  paragraphs: number;
  lines: number;
  utf8Bytes: number;
  readingSeconds: number;
  speakingSeconds: number;
  topWords: FrequentWordItem[];
}

const EN_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "with",
]);

const ZH_STOPWORDS = new Set([
  "的",
  "了",
  "和",
  "是",
  "在",
  "我",
  "有",
  "就",
  "不",
  "也",
  "都",
  "而",
  "及",
  "与",
  "着",
  "或",
  "之",
]);

const CJK_SCRIPT_RE = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;
const WHITESPACE_ONLY_RE = /^\s+$/u;
const HAS_NON_WHITESPACE_RE = /\S/u;

const graphemeSegmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
const wordSegmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
const sentenceSegmenter = new Intl.Segmenter("zh-CN", { granularity: "sentence" });

export function analyzeTextMetrics(text: string): {
  exceededLimit: boolean;
  utf8Bytes: number;
  stats: WordCountAnalysis | null;
} {
  const utf8Bytes = new TextEncoder().encode(text).byteLength;
  if (utf8Bytes > MAX_WORD_COUNTER_BYTES) {
    return { exceededLimit: true, utf8Bytes, stats: null };
  }

  if (text.length === 0) {
    return {
      exceededLimit: false,
      utf8Bytes: 0,
      stats: {
        words: 0,
        charsWithSpaces: 0,
        charsNoWhitespace: 0,
        sentences: 0,
        paragraphs: 0,
        lines: 0,
        utf8Bytes: 0,
        readingSeconds: 0,
        speakingSeconds: 0,
        topWords: [],
      },
    };
  }

  // 1. User-perceived characters via Unicode UAX #29 grapheme clusters
  let charsWithSpaces = 0;
  let charsNoWhitespace = 0;
  for (const seg of graphemeSegmenter.segment(text)) {
    charsWithSpaces += 1;
    if (!WHITESPACE_ONLY_RE.test(seg.segment)) {
      charsNoWhitespace += 1;
    }
  }

  // 2. Words, CJK character units (for reading/speaking speed), and word frequencies
  let words = 0;
  let cjkChars = 0;
  let nonCjkWords = 0;
  const freqMap = new Map<string, number>();

  for (const seg of wordSegmenter.segment(text)) {
    if (!seg.isWordLike) continue;
    const token = seg.segment;
    words += 1;

    if (CJK_SCRIPT_RE.test(token)) {
      let tokenGraphemes = 0;
      for (const _g of graphemeSegmenter.segment(token)) {
        tokenGraphemes += 1;
      }
      cjkChars += tokenGraphemes;
    } else {
      nonCjkWords += 1;
    }

    const normalized = token.toLowerCase();
    if (!EN_STOPWORDS.has(normalized) && !ZH_STOPWORDS.has(normalized)) {
      freqMap.set(normalized, (freqMap.get(normalized) ?? 0) + 1);
    }
  }

  // 3. Sentences via Intl.Segmenter (non-whitespace sentence segments)
  let sentences = 0;
  if (charsNoWhitespace > 0) {
    for (const seg of sentenceSegmenter.segment(text)) {
      if (HAS_NON_WHITESPACE_RE.test(seg.segment)) {
        sentences += 1;
      }
    }
  }

  // 4. Lines & Paragraphs (normalize CRLF and lone CR to LF)
  const normalizedLf = text.replace(/\r\n?/g, "\n");
  const lines = normalizedLf.split("\n").length;
  const paragraphs =
    charsNoWhitespace === 0
      ? 0
      : normalizedLf.split(/\n(?:\s*\n)+/).filter((block) => HAS_NON_WHITESPACE_RE.test(block))
          .length;

  // 5. Estimated silent reading (~350 CJK chars/min + ~220 non-CJK words/min)
  //    and speaking (~180 CJK chars/min + ~140 non-CJK words/min)
  const readingMinutes = cjkChars / 350 + nonCjkWords / 220;
  const speakingMinutes = cjkChars / 180 + nonCjkWords / 140;
  const readingSeconds = words === 0 ? 0 : readingMinutes * 60;
  const speakingSeconds = words === 0 ? 0 : speakingMinutes * 60;

  const topWords: FrequentWordItem[] = Array.from(freqMap.entries())
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .slice(0, 10)
    .map(([word, count]) => ({ word, count }));

  return {
    exceededLimit: false,
    utf8Bytes,
    stats: {
      words,
      charsWithSpaces,
      charsNoWhitespace,
      sentences,
      paragraphs,
      lines,
      utf8Bytes,
      readingSeconds,
      speakingSeconds,
      topWords,
    },
  };
}
