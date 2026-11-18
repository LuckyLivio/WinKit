/**
 * D12 Offline Lorem Ipsum Placeholder Text Engine
 *
 * Vocabulary source: Classical Latin vocabulary drawn from Marcus Tullius Cicero,
 * "De finibus bonorum et malorum" (45 BC, classical antiquity).
 * No external APIs, LLMs, or synthetic personal-profile generators are used.
 */

export type LoremUnit = "words" | "sentences" | "paragraphs";
export type LoremFormat = "plain" | "html" | "markdown";

export const LOREM_UNIT_LIMITS: Record<
  LoremUnit,
  { min: number; max: number; defaultCount: number }
> = {
  words: { min: 1, max: 5_000, defaultCount: 50 },
  sentences: { min: 1, max: 500, defaultCount: 5 },
  paragraphs: { min: 1, max: 100, defaultCount: 3 },
};

export const MAX_LOREM_OUTPUT_CHARS = 262_144; // 256 Ki UTF-16 code units safety ceiling

const CLASSIC_OPENING_WORDS = [
  "lorem",
  "ipsum",
  "dolor",
  "sit",
  "amet",
  "consectetur",
  "adipiscing",
  "elit",
] as const;

export const CLASSIC_OPENING_SENTENCE = "Lorem ipsum dolor sit amet, consectetur adipiscing elit.";

const CLASSICAL_LATIN_WORDS: readonly string[] = [
  "accumsan",
  "adipiscing",
  "aenean",
  "aliquam",
  "aliquet",
  "amet",
  "ante",
  "aptent",
  "arcu",
  "at",
  "auctor",
  "augue",
  "bibendum",
  "blandit",
  "class",
  "commodo",
  "condimentum",
  "congue",
  "consectetur",
  "consequat",
  "conubia",
  "convallis",
  "cras",
  "cubilia",
  "curabitur",
  "curae",
  "cursus",
  "dapibus",
  "diam",
  "dictum",
  "dictumst",
  "dignissim",
  "dis",
  "dolor",
  "donec",
  "dui",
  "duis",
  "egestas",
  "eget",
  "eleifend",
  "elementum",
  "elit",
  "enim",
  "erat",
  "eros",
  "est",
  "et",
  "etiam",
  "eu",
  "euismod",
  "facilisi",
  "facilisis",
  "fames",
  "faucibus",
  "felis",
  "fermentum",
  "feugiat",
  "fringilla",
  "fusce",
  "gravida",
  "habitant",
  "habitasse",
  "hac",
  "hendrerit",
  "himenaeos",
  "iaculis",
  "id",
  "imperdiet",
  "in",
  "inceptos",
  "integer",
  "interdum",
  "ipsum",
  "justo",
  "lacinia",
  "lacus",
  "laoreet",
  "lectus",
  "leo",
  "libero",
  "ligula",
  "litora",
  "lobortis",
  "lorem",
  "luctus",
  "maecenas",
  "magna",
  "magnis",
  "malesuada",
  "massa",
  "mattis",
  "mauris",
  "metus",
  "mi",
  "molestie",
  "mollis",
  "montes",
  "morbi",
  "mus",
  "nam",
  "nascetur",
  "natoque",
  "nec",
  "neque",
  "netus",
  "nibh",
  "nisi",
  "nisl",
  "non",
  "nostra",
  "nulla",
  "nullam",
  "nunc",
  "odio",
  "orci",
  "ornare",
  "parturient",
  "pellentesque",
  "penatibus",
  "per",
  "pharetra",
  "phasellus",
  "placerat",
  "platea",
  "porta",
  "porttitor",
  "posuere",
  "potenti",
  "praesent",
  "pretium",
  "primis",
  "proin",
  "pulvinar",
  "purus",
  "quam",
  "quis",
  "quisque",
  "rhoncus",
  "ridiculus",
  "risus",
  "rutrum",
  "sagittis",
  "sapien",
  "scelerisque",
  "sed",
  "sem",
  "semper",
  "senectus",
  "sit",
  "sociosqu",
  "sodales",
  "sollicitudin",
  "suscipit",
  "suspendisse",
  "taciti",
  "tellus",
  "tempor",
  "tempus",
  "tincidunt",
  "torquent",
  "tortor",
  "tristique",
  "turpis",
  "ullamcorper",
  "ultrices",
  "ultricies",
  "urna",
  "ut",
  "varius",
  "vehicula",
  "vel",
  "velit",
  "venenatis",
  "vestibulum",
  "vitae",
  "vivamus",
  "viverra",
  "volutpat",
  "vulputate",
];

export interface LoremGenerateRequest {
  unit: LoremUnit;
  rawCount: string;
  format: LoremFormat;
  startWithClassic: boolean;
  seed: number;
}

export type LoremValidationError =
  | { kind: "empty_or_non_integer" }
  | { kind: "out_of_range"; unit: LoremUnit; min: number; max: number; actual: number }
  | { kind: "output_budget_exceeded"; maxChars: number };

export type LoremGenerateResult =
  | {
      status: "invalid";
      error: LoremValidationError;
    }
  | {
      status: "ok";
      output: string;
      wordCount: number;
      sentenceCount: number;
      paragraphCount: number;
      charCount: number;
    };

function createSeededPrng(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function nextRandomLoremSeed(): number {
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
    const arr = new Uint32Array(1);
    globalThis.crypto.getRandomValues(arr);
    return (arr[0] ?? 1) || 1;
  }
  return 0x9e3779b9;
}

function capitalizeAsciiWord(word: string): string {
  if (!word) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function pickRandomWord(nextFloat: () => number, prevWord: string | null): string {
  const len = CLASSICAL_LATIN_WORDS.length;
  const idx = Math.floor(nextFloat() * len);
  const candidate = CLASSICAL_LATIN_WORDS[idx] ?? "lorem";
  if (candidate === prevWord) {
    return CLASSICAL_LATIN_WORDS[(idx + 1) % len] ?? "ipsum";
  }
  return candidate;
}

function generateSingleRandomSentence(nextFloat: () => number): {
  sentence: string;
  wordCount: number;
} {
  // 7..=13 words per sentence
  const len = 7 + Math.floor(nextFloat() * 7);
  const words: string[] = [];
  let prev: string | null = null;
  for (let i = 0; i < len; i++) {
    const w = pickRandomWord(nextFloat, prev);
    prev = w;
    words.push(i === 0 ? capitalizeAsciiWord(w) : w);
  }
  if (len >= 9 && nextFloat() < 0.45) {
    const commaPos = 3 + Math.floor(nextFloat() * 3);
    words[commaPos] = `${words[commaPos]},`;
  }
  words[len - 1] = `${words[len - 1]}.`;
  return {
    sentence: words.join(" "),
    wordCount: len,
  };
}

function formatParagraphBlocks(paragraphs: string[], format: LoremFormat): string {
  if (format === "html") {
    return paragraphs.map((p) => `<p>${p}</p>`).join("\n");
  }
  return paragraphs.join("\n\n");
}

export function generateLoremIpsum(req: LoremGenerateRequest): LoremGenerateResult {
  const trimmed = req.rawCount.trim();
  if (!/^\d+$/.test(trimmed)) {
    return {
      status: "invalid",
      error: { kind: "empty_or_non_integer" },
    };
  }

  const count = Number(trimmed);
  const bounds = LOREM_UNIT_LIMITS[req.unit];
  if (!Number.isSafeInteger(count) || count < bounds.min || count > bounds.max) {
    return {
      status: "invalid",
      error: {
        kind: "out_of_range",
        unit: req.unit,
        min: bounds.min,
        max: bounds.max,
        actual: count,
      },
    };
  }

  // Conservative upfront budget guard before building strings
  const worstCaseChars =
    req.unit === "words"
      ? count * 14 + 16
      : req.unit === "sentences"
        ? count * 160 + 16
        : count * 960;
  if (worstCaseChars > MAX_LOREM_OUTPUT_CHARS * 2) {
    return {
      status: "invalid",
      error: { kind: "output_budget_exceeded", maxChars: MAX_LOREM_OUTPUT_CHARS },
    };
  }

  const nextFloat = createSeededPrng(req.seed);

  if (req.unit === "words") {
    const tokens: string[] = [];
    let prev: string | null = null;
    for (let i = 0; i < count; i++) {
      if (req.startWithClassic && i < CLASSIC_OPENING_WORDS.length) {
        const cw = CLASSIC_OPENING_WORDS[i]!;
        prev = cw;
        let formatted = i === 0 ? capitalizeAsciiWord(cw) : cw;
        if (i === 4 && count > 5) {
          formatted = `${formatted},`;
        } else if (i === 7 && count > 8) {
          formatted = `${formatted}.`;
        }
        tokens.push(formatted);
      } else {
        const w = pickRandomWord(nextFloat, prev);
        prev = w;
        const startsNewSentence = i === 0 || (tokens[i - 1]?.endsWith(".") ?? false);
        let formatted = startsNewSentence ? capitalizeAsciiWord(w) : w;
        if (i < count - 1 && !startsNewSentence && (i + 1) % 10 === 0) {
          formatted = `${formatted}.`;
        }
        tokens.push(formatted);
      }
    }

    const lastIdx = tokens.length - 1;
    if (lastIdx >= 0) {
      const cleanLast = tokens[lastIdx]!.replace(/[.,]+$/, "");
      tokens[lastIdx] = count >= 2 ? `${cleanLast}.` : cleanLast;
    }

    const body = tokens.join(" ");
    const output = formatParagraphBlocks([body], req.format);
    if (output.length > MAX_LOREM_OUTPUT_CHARS) {
      return {
        status: "invalid",
        error: { kind: "output_budget_exceeded", maxChars: MAX_LOREM_OUTPUT_CHARS },
      };
    }
    const sentenceCount = Math.max(1, tokens.filter((tk) => tk.endsWith(".")).length);
    return {
      status: "ok",
      output,
      wordCount: count,
      sentenceCount,
      paragraphCount: 1,
      charCount: output.length,
    };
  }

  if (req.unit === "sentences") {
    const sentences: string[] = [];
    let totalWords = 0;
    for (let s = 0; s < count; s++) {
      if (s === 0 && req.startWithClassic) {
        sentences.push(CLASSIC_OPENING_SENTENCE);
        totalWords += CLASSIC_OPENING_WORDS.length;
      } else {
        const gen = generateSingleRandomSentence(nextFloat);
        sentences.push(gen.sentence);
        totalWords += gen.wordCount;
      }
    }
    const paragraph = sentences.join(" ");
    const output = formatParagraphBlocks([paragraph], req.format);
    if (output.length > MAX_LOREM_OUTPUT_CHARS) {
      return {
        status: "invalid",
        error: { kind: "output_budget_exceeded", maxChars: MAX_LOREM_OUTPUT_CHARS },
      };
    }
    return {
      status: "ok",
      output,
      wordCount: totalWords,
      sentenceCount: count,
      paragraphCount: 1,
      charCount: output.length,
    };
  }

  // Paragraphs mode
  const paragraphs: string[] = [];
  let totalWords = 0;
  let totalSentences = 0;
  for (let p = 0; p < count; p++) {
    const sentencesInPara = 4 + Math.floor(nextFloat() * 3); // 4..=6 sentences
    const paraSentences: string[] = [];
    for (let s = 0; s < sentencesInPara; s++) {
      if (p === 0 && s === 0 && req.startWithClassic) {
        paraSentences.push(CLASSIC_OPENING_SENTENCE);
        totalWords += CLASSIC_OPENING_WORDS.length;
      } else {
        const gen = generateSingleRandomSentence(nextFloat);
        paraSentences.push(gen.sentence);
        totalWords += gen.wordCount;
      }
      totalSentences += 1;
    }
    paragraphs.push(paraSentences.join(" "));
  }

  const output = formatParagraphBlocks(paragraphs, req.format);
  if (output.length > MAX_LOREM_OUTPUT_CHARS) {
    return {
      status: "invalid",
      error: { kind: "output_budget_exceeded", maxChars: MAX_LOREM_OUTPUT_CHARS },
    };
  }

  return {
    status: "ok",
    output,
    wordCount: totalWords,
    sentenceCount: totalSentences,
    paragraphCount: count,
    charCount: output.length,
  };
}
