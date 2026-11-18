import type { CaseStyleId } from "../../lib/sessionStore";

export const ALL_CASE_STYLES: readonly CaseStyleId[] = [
  "uppercase",
  "lowercase",
  "title",
  "sentence",
  "camel",
  "pascal",
  "snake",
  "constant",
  "kebab",
  "dot",
  "alternating",
  "inverse",
] as const;

const graphemeSegmenter = new Intl.Segmenter("und", { granularity: "grapheme" });

const ENGLISH_MINOR_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "but",
  "by",
  "for",
  "from",
  "in",
  "into",
  "nor",
  "of",
  "on",
  "onto",
  "or",
  "per",
  "the",
  "to",
  "up",
  "via",
  "vs",
  "with",
]);

const KNOWN_SPECIAL_TOKENS: Record<string, string> = {
  iphone: "iPhone",
  ipad: "iPad",
  macos: "macOS",
  ios: "iOS",
  winkit: "WinKit",
  github: "GitHub",
  gitlab: "GitLab",
  javascript: "JavaScript",
  typescript: "TypeScript",
  graphql: "GraphQL",
  webview2: "WebView2",
  api: "API",
  apis: "APIs",
  http: "HTTP",
  https: "HTTPS",
  json: "JSON",
  uuid: "UUID",
  url: "URL",
  cli: "CLI",
  mcp: "MCP",
  pdf: "PDF",
  png: "PNG",
};

function splitGraphemes(s: string): string[] {
  const out: string[] = [];
  for (const seg of graphemeSegmenter.segment(s)) {
    out.push(seg.segment);
  }
  return out;
}

function isCasedGrapheme(g: string): boolean {
  return g.toLocaleLowerCase() !== g.toLocaleUpperCase();
}

function capitalizeGraphemeWord(word: string): string {
  const graphemes = splitGraphemes(word);
  if (graphemes.length === 0) return "";
  let capitalizedFirst = false;
  return graphemes
    .map((g) => {
      if (!capitalizedFirst && isCasedGrapheme(g)) {
        capitalizedFirst = true;
        return g.toLocaleUpperCase();
      }
      return g.toLocaleLowerCase();
    })
    .join("");
}

/**
 * Consistent identifier word splitter covering:
 * - `getHTTPResponse` -> `["get", "HTTP", "Response"]`
 * - `HTTPRequest`     -> `["HTTP", "Request"]`
 * - `version2Value`   -> `["version", "2", "Value"]`
 * - repeated delimiters (`--__..`)
 * - accented Unicode letters (`\p{L}\p{M}`), CJK, digits (`\p{N}`), and emojis
 */
export function tokenizeIdentifierWords(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  const spaced = trimmed
    .replace(/[\s_\-./\\:;,]+/gu, " ")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{L}\p{M}*)(\p{N})/gu, "$1 $2")
    .replace(/(\p{N})(\p{L})/gu, "$1 $2");

  const rawTokens = spaced.split(/\s+/u).filter(Boolean);
  const cleaned: string[] = [];
  for (const tok of rawTokens) {
    // Strip outer punctuation brackets/quotes while keeping letters, combining marks, digits, and emoji symbols
    const stripped = tok.replace(
      /^[^\p{L}\p{M}\p{N}\p{Extended_Pictographic}]+|[^\p{L}\p{M}\p{N}\p{Extended_Pictographic}]+$/gu,
      "",
    );
    if (stripped) {
      cleaned.push(stripped);
    }
  }
  return cleaned;
}

function looksLikeCompoundIdentifier(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || /\s/u.test(trimmed)) return false;
  return /[_.-]|(?:\p{Ll}\p{Lu})|(?:\p{Lu}{2,}\p{Ll})|(?:\p{L}\p{N})|(?:\p{N}\p{L})/u.test(trimmed);
}

function hasIntentionalSpecialCasing(token: string, wholeLineAllCaps: boolean): boolean {
  if (wholeLineAllCaps) return false;
  const graphemes = splitGraphemes(token).filter(isCasedGrapheme);
  if (graphemes.length < 2) return false;
  const restHasUpper = graphemes.slice(1).some((g) => g === g.toLocaleUpperCase());
  const anyLower = graphemes.some((g) => g === g.toLocaleLowerCase());
  if (restHasUpper && anyLower) {
    // e.g. iPhone, macOS, GraphQL, OpenAI
    return true;
  }
  // Short uppercase acronym in mixed-case prose (e.g. NASA, TLS, SDK)
  if (!anyLower && graphemes.length >= 2 && graphemes.length <= 5) {
    return true;
  }
  return false;
}

function toEnglishTitleCaseLine(line: string): string {
  if (!line.trim()) return line;
  const source = looksLikeCompoundIdentifier(line) ? tokenizeIdentifierWords(line).join(" ") : line;

  const casedLetters = splitGraphemes(source).filter(isCasedGrapheme);
  const wholeLineAllCaps =
    casedLetters.length > 1 && casedLetters.every((g) => g === g.toLocaleUpperCase());

  const parts = source.split(/(\s+|[:;—–\-/]+)/u);
  const wordIndices: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (/\p{L}|\p{N}/u.test(parts[i]!)) {
      wordIndices.push(i);
    }
  }
  if (wordIndices.length === 0) return source;

  const firstPartIdx = wordIndices[0]!;
  const lastPartIdx = wordIndices[wordIndices.length - 1]!;
  let afterSubtleBreak = false;

  return parts
    .map((part, idx) => {
      if (/[:;—–]/u.test(part)) {
        afterSubtleBreak = true;
        return part;
      }
      if (!/\p{L}|\p{N}/u.test(part)) {
        return part;
      }

      const forceCap = idx === firstPartIdx || idx === lastPartIdx || afterSubtleBreak;
      afterSubtleBreak = false;

      // Preserve leading/trailing quote punctuation around word
      const match = /^([^\p{L}\p{M}\p{N}]*)([\s\S]*?)([^\p{L}\p{M}\p{N}]*)$/u.exec(part);
      const lead = match?.[1] ?? "";
      const core = match?.[2] ?? part;
      const trail = match?.[3] ?? "";
      const lower = core.toLocaleLowerCase();

      if (lower in KNOWN_SPECIAL_TOKENS) {
        return `${lead}${KNOWN_SPECIAL_TOKENS[lower]}${trail}`;
      }
      if (hasIntentionalSpecialCasing(core, wholeLineAllCaps)) {
        return part;
      }
      if (!forceCap && ENGLISH_MINOR_WORDS.has(lower)) {
        return `${lead}${lower}${trail}`;
      }
      return `${lead}${capitalizeGraphemeWord(core)}${trail}`;
    })
    .join("");
}

function toSentenceCaseLine(line: string): string {
  if (!line.trim()) return line;
  const source = looksLikeCompoundIdentifier(line) ? tokenizeIdentifierWords(line).join(" ") : line;

  const graphemes = splitGraphemes(source);
  let needCapital = true;
  return graphemes
    .map((g) => {
      if (/[.!?。！？]/u.test(g)) {
        needCapital = true;
        return g;
      }
      if (isCasedGrapheme(g)) {
        if (needCapital) {
          needCapital = false;
          return g.toLocaleUpperCase();
        }
        return g.toLocaleLowerCase();
      }
      return g;
    })
    .join("");
}

function toAlternatingLine(line: string): string {
  let casedIdx = 0;
  return splitGraphemes(line)
    .map((g) => {
      if (!isCasedGrapheme(g)) return g;
      const out = casedIdx % 2 === 0 ? g.toLocaleLowerCase() : g.toLocaleUpperCase();
      casedIdx += 1;
      return out;
    })
    .join("");
}

function toInverseLine(line: string): string {
  return splitGraphemes(line)
    .map((g) => {
      if (!isCasedGrapheme(g)) return g;
      const upper = g.toLocaleUpperCase();
      const lower = g.toLocaleLowerCase();
      return g === upper ? lower : upper;
    })
    .join("");
}

function convertSingleLine(line: string, style: CaseStyleId): string {
  if (line.length === 0) return "";

  switch (style) {
    case "uppercase":
      return line.toLocaleUpperCase();
    case "lowercase":
      return line.toLocaleLowerCase();
    case "title":
      return toEnglishTitleCaseLine(line);
    case "sentence":
      return toSentenceCaseLine(line);
    case "alternating":
      return toAlternatingLine(line);
    case "inverse":
      return toInverseLine(line);
    case "camel": {
      const words = tokenizeIdentifierWords(line);
      if (words.length === 0) return "";
      return words
        .map((w, idx) => (idx === 0 ? w.toLocaleLowerCase() : capitalizeGraphemeWord(w)))
        .join("");
    }
    case "pascal": {
      const words = tokenizeIdentifierWords(line);
      return words.map(capitalizeGraphemeWord).join("");
    }
    case "snake": {
      const words = tokenizeIdentifierWords(line);
      return words.map((w) => w.toLocaleLowerCase()).join("_");
    }
    case "constant": {
      const words = tokenizeIdentifierWords(line);
      return words.map((w) => w.toLocaleUpperCase()).join("_");
    }
    case "kebab": {
      const words = tokenizeIdentifierWords(line);
      return words.map((w) => w.toLocaleLowerCase()).join("-");
    }
    case "dot": {
      const words = tokenizeIdentifierWords(line);
      return words.map((w) => w.toLocaleLowerCase()).join(".");
    }
  }
}

/**
 * Converts `text` into `style` line by line, preserving exact `\n` and `\r\n` line boundaries.
 */
export function convertCaseText(text: string, style: CaseStyleId): string {
  if (text.length === 0) return "";
  const segments = text.split(/(\r?\n)/);
  return segments.map((seg, idx) => (idx % 2 === 1 ? seg : convertSingleLine(seg, style))).join("");
}
