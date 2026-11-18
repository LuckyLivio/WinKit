export const MAX_UNICODE_TEXT_BYTES = 512 * 1024;
export const MAX_UNICODE_CODE_POINTS = 50_000;

export type UnicodeAttentionFlag =
  | "bom"
  | "zero_width"
  | "joiner_or_variation_selector"
  | "bidi_control"
  | "special_whitespace"
  | "control_char"
  | "combining_mark"
  | "potential_confusable"
  | "private_or_unassigned";

export interface UnicodeCodePointEntry {
  codePointIndex: number;
  utf16Offset: number;
  utf16Length: number;
  graphemeIndex: number;
  scalarValue: number;
  codePointHex: string;
  displayGlyph: string;
  name: string;
  generalCategory: string;
  script: string;
  utf8BytesHex: string;
  flags: UnicodeAttentionFlag[];
  isAttentionItem: boolean;
  confusablePrototype: string | null;
}

export interface UnicodeSanitizeOptions {
  removeBom: boolean;
  removeZeroWidth: boolean;
  normalizeSpecialSpaces: boolean;
  removeC0C1Controls: boolean;
  removeBidiControls: boolean;
  removeJoinersAndVs: boolean;
  replaceConfusables: boolean;
}

export const DEFAULT_UNICODE_SANITIZE_OPTIONS: UnicodeSanitizeOptions = {
  removeBom: true,
  removeZeroWidth: true,
  normalizeSpecialSpaces: true,
  removeC0C1Controls: true,
  removeBidiControls: false,
  removeJoinersAndVs: false,
  replaceConfusables: false,
};

export interface SanitizeChangePreview {
  codePointIndex: number;
  utf16Offset: number;
  codePointHex: string;
  originalLabel: string;
  action: "removed" | "replaced";
  replacementLabel: string;
  reason: string;
}

export interface UnicodeInspectSummary {
  unicodeVersion: string;
  totalCodePoints: number;
  totalUtf16Units: number;
  totalGraphemes: number;
  totalUtf8Bytes: number;
  attentionCount: number;
  zeroWidthCount: number;
  bidiControlCount: number;
  specialWhitespaceCount: number;
  confusableCount: number;
  joinerOrVsCount: number;
  combiningMarkCount: number;
}

export interface UnicodeInspectionResponse {
  summary: UnicodeInspectSummary;
  entries: UnicodeCodePointEntry[];
  sanitizedText: string;
  changes: SanitizeChangePreview[];
  changesTruncated: boolean;
  totalChangeCount: number;
}

const HANGUL_L = [
  "G",
  "GG",
  "N",
  "D",
  "DD",
  "R",
  "M",
  "B",
  "BB",
  "S",
  "SS",
  "",
  "J",
  "JJ",
  "C",
  "K",
  "T",
  "P",
  "H",
];
const HANGUL_V = [
  "A",
  "AE",
  "YA",
  "YAE",
  "EO",
  "E",
  "YEO",
  "YE",
  "O",
  "WA",
  "WAE",
  "OE",
  "YO",
  "U",
  "WEO",
  "WE",
  "WI",
  "YU",
  "EU",
  "YI",
  "I",
];
const HANGUL_T = [
  "",
  "G",
  "GG",
  "GS",
  "N",
  "NJ",
  "NH",
  "D",
  "L",
  "LG",
  "LM",
  "LB",
  "LS",
  "LT",
  "LP",
  "LH",
  "M",
  "B",
  "BS",
  "S",
  "SS",
  "NG",
  "J",
  "C",
  "K",
  "T",
  "P",
  "H",
];

// Curated UTS #39 confusable prototypes for JSDOM client fallback (authoritative full table runs in Rust `unicode-security`)
const CLIENT_UTS39_FALLBACK: Record<number, string> = {
  0x0430: "a", // Cyrillic small a
  0x0435: "e", // Cyrillic small ie
  0x043e: "o", // Cyrillic small o
  0x0440: "p", // Cyrillic small er
  0x0441: "c", // Cyrillic small es
  0x0445: "x", // Cyrillic small ha
  0x0443: "y", // Cyrillic small u
  0x0410: "A", // Cyrillic capital A
  0x0412: "B", // Cyrillic capital VE
  0x0415: "E", // Cyrillic capital IE
  0x041a: "K", // Cyrillic capital KA
  0x041c: "M", // Cyrillic capital EM
  0x041d: "H", // Cyrillic capital EN
  0x041e: "O", // Cyrillic capital O
  0x0420: "P", // Cyrillic capital ER
  0x0421: "C", // Cyrillic capital ES
  0x0422: "T", // Cyrillic capital TE
  0x0425: "X", // Cyrillic capital HA
  0x0391: "A", // Greek capital Alpha
  0x0392: "B", // Greek capital Beta
  0x0395: "E", // Greek capital Epsilon
  0x039f: "O", // Greek capital Omicron
  0x03bf: "o", // Greek small omicron
  0x037e: ";", // Greek question mark
  0x2010: "-", // Hyphen
  0x2013: "-", // En dash
  0x2212: "-", // Minus sign
};

const KNOWN_CHAR_NAMES_FALLBACK: Record<number, string> = {
  0x0020: "SPACE",
  0x0061: "LATIN SMALL LETTER A",
  0x0065: "LATIN SMALL LETTER E",
  0x00a0: "NO-BREAK SPACE",
  0x00ad: "SOFT HYPHEN",
  0x0301: "COMBINING ACUTE ACCENT",
  0x0430: "CYRILLIC SMALL LETTER A",
  0x061c: "ARABIC LETTER MARK",
  0x200b: "ZERO WIDTH SPACE",
  0x200c: "ZERO WIDTH NON-JOINER",
  0x200d: "ZERO WIDTH JOINER",
  0x200e: "LEFT-TO-RIGHT MARK",
  0x200f: "RIGHT-TO-LEFT MARK",
  0x202a: "LEFT-TO-RIGHT EMBEDDING",
  0x202b: "RIGHT-TO-LEFT EMBEDDING",
  0x202c: "POP DIRECTIONAL FORMATTING",
  0x202d: "LEFT-TO-RIGHT OVERRIDE",
  0x202e: "RIGHT-TO-LEFT OVERRIDE",
  0x2060: "WORD JOINER",
  0x2066: "LEFT-TO-RIGHT ISOLATE",
  0x2067: "RIGHT-TO-LEFT ISOLATE",
  0x2068: "FIRST STRONG ISOLATE",
  0x2069: "POP DIRECTIONAL ISOLATE",
  0x3000: "IDEOGRAPHIC SPACE",
  0xfeff: "ZERO WIDTH NO-BREAK SPACE",
  0x1f468: "MAN",
  0x1f469: "WOMAN",
  0x1f467: "GIRL",
  0x1f466: "BOY",
};

function isBidiControl(u: number): boolean {
  return (
    u === 0x061c ||
    u === 0x200e ||
    u === 0x200f ||
    (u >= 0x202a && u <= 0x202e) ||
    (u >= 0x2066 && u <= 0x2069)
  );
}

function isJoinerOrVs(u: number): boolean {
  return (
    u === 0x200c || u === 0x200d || (u >= 0xfe00 && u <= 0xfe0f) || (u >= 0xe0100 && u <= 0xe01ef)
  );
}

function isSpecialNonAsciiWhitespace(ch: string, u: number): boolean {
  if (u <= 0x007f) return false;
  return /\p{White_Space}/u.test(ch) || u === 0x0085;
}

function isCombiningMark(ch: string): boolean {
  return /\p{Mark}/u.test(ch);
}

function isPrivateUse(u: number): boolean {
  return (
    (u >= 0xe000 && u <= 0xf8ff) ||
    (u >= 0xf0000 && u <= 0xffffd) ||
    (u >= 0x100000 && u <= 0x10fffd)
  );
}

function isNoncharacter(u: number): boolean {
  return (u >= 0xfdd0 && u <= 0xfdef) || ((u & 0xfffe) === 0xfffe && u <= 0x10ffff);
}

function formatHexCode(u: number): string {
  return `U+${u.toString(16).toUpperCase().padStart(4, "0")}`;
}

function fallbackCharacterName(ch: string, u: number): string {
  if (KNOWN_CHAR_NAMES_FALLBACK[u]) {
    return KNOWN_CHAR_NAMES_FALLBACK[u]!;
  }
  if (u >= 0x41 && u <= 0x5a) return `LATIN CAPITAL LETTER ${ch}`;
  if (u >= 0x61 && u <= 0x7a) return `LATIN SMALL LETTER ${ch.toUpperCase()}`;
  if (u >= 0x30 && u <= 0x39) return `DIGIT ${ch}`;
  if (
    (u >= 0x3400 && u <= 0x4dbf) ||
    (u >= 0x4e00 && u <= 0x9fff) ||
    (u >= 0x20000 && u <= 0x323af)
  ) {
    return `CJK UNIFIED IDEOGRAPH-${u.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  if (u >= 0xac00 && u <= 0xd7a3) {
    const sIdx = u - 0xac00;
    const l = HANGUL_L[Math.floor(sIdx / 588)] ?? "";
    const v = HANGUL_V[Math.floor((sIdx % 588) / 28)] ?? "";
    const t = HANGUL_T[sIdx % 28] ?? "";
    return `HANGUL SYLLABLE ${l}${v}${t}`;
  }
  if (u <= 0x001f || (u >= 0x007f && u <= 0x009f)) {
    const ctrl =
      u === 0x0a
        ? "LINE FEED"
        : u === 0x0d
          ? "CARRIAGE RETURN"
          : u === 0x09
            ? "CHARACTER TABULATION"
            : "CONTROL";
    return `<control-${u.toString(16).toUpperCase().padStart(4, "0")}> (${ctrl})`;
  }
  if (isPrivateUse(u)) {
    return `<private-use-${u.toString(16).toUpperCase().padStart(4, "0")}>`;
  }
  if (isNoncharacter(u)) {
    return `<noncharacter-${u.toString(16).toUpperCase().padStart(4, "0")}>`;
  }
  if (!/\p{Assigned}/u.test(ch)) {
    return `<reserved-${u.toString(16).toUpperCase().padStart(4, "0")}>`;
  }
  return `UNICODE CHARACTER ${formatHexCode(u)}`;
}

function fallbackDisplayGlyph(ch: string, u: number): string {
  if (u === 0x09) return "[TAB]";
  if (u === 0x0a) return "[LF]";
  if (u === 0x0d) return "[CR]";
  if (u === 0x20) return "[SP]";
  if (u === 0xa0) return "[NBSP]";
  if (u === 0x200b) return "[ZWSP]";
  if (u === 0x200c) return "[ZWNJ]";
  if (u === 0x200d) return "[ZWJ]";
  if (u === 0x202e) return "[RLO]";
  if (u === 0xfeff) return "[BOM]";
  if (u <= 0x1f || (u >= 0x7f && u <= 0x9f))
    return `[CTRL ${u.toString(16).toUpperCase().padStart(2, "0")}]`;
  if (isCombiningMark(ch)) return `\u25CC${ch}`;
  return ch;
}

/**
 * Client-side JSDOM fallback matching the authoritative Rust `inspect_unicode_text` IPC engine.
 */
export function inspectUnicodeClientFallback(
  text: string,
  options: UnicodeSanitizeOptions,
): UnicodeInspectionResponse {
  const utf8Total = new TextEncoder().encode(text);
  if (utf8Total.byteLength > MAX_UNICODE_TEXT_BYTES) {
    throw JSON.stringify({
      code: "SIZE_LIMIT_EXCEEDED",
      message: `Input exceeds the 512 KB limit (${utf8Total.byteLength} bytes).`,
    });
  }

  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  const graphemeEndsUtf16: number[] = [];
  for (const seg of segmenter.segment(text)) {
    graphemeEndsUtf16.push(seg.index + seg.segment.length);
  }

  const entries: UnicodeCodePointEntry[] = [];
  const changes: SanitizeChangePreview[] = [];
  const sanitizedParts: string[] = [];

  let utf16Offset = 0;
  let cpIdx = 0;
  let graphemeIdx = 0;
  let totalChangeCount = 0;

  let attentionCount = 0;
  let zeroWidthCount = 0;
  let bidiControlCount = 0;
  let specialWhitespaceCount = 0;
  let confusableCount = 0;
  let joinerOrVsCount = 0;
  let combiningMarkCount = 0;

  for (const ch of text) {
    if (cpIdx >= MAX_UNICODE_CODE_POINTS) {
      throw JSON.stringify({
        code: "SIZE_LIMIT_EXCEEDED",
        message: `Input exceeds ${MAX_UNICODE_CODE_POINTS} code points.`,
      });
    }

    while (
      graphemeIdx + 1 < graphemeEndsUtf16.length &&
      utf16Offset >= (graphemeEndsUtf16[graphemeIdx] ?? 0)
    ) {
      graphemeIdx++;
    }

    const u = ch.codePointAt(0)!;
    const utf16Length = ch.length;
    const codePointHex = formatHexCode(u);
    const displayGlyph = fallbackDisplayGlyph(ch, u);
    const utf8BytesHex = Array.from(new TextEncoder().encode(ch))
      .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
      .join(" ");

    const flags: UnicodeAttentionFlag[] = [];
    let confusableAscii: string | null = null;
    let confusablePrototype: string | null = null;

    if (u === 0xfeff) flags.push("bom");
    if (isBidiControl(u)) {
      flags.push("bidi_control");
      bidiControlCount++;
    }
    if (isJoinerOrVs(u)) {
      flags.push("joiner_or_variation_selector");
      joinerOrVsCount++;
    }
    const isZeroW =
      u !== 0xfeff &&
      !isBidiControl(u) &&
      !isJoinerOrVs(u) &&
      (u === 0x00ad || u === 0x200b || u === 0x2060 || /\p{General_Category=Format}/u.test(ch));
    if (isZeroW) {
      flags.push("zero_width");
      zeroWidthCount++;
    }

    const isSpecWs = isSpecialNonAsciiWhitespace(ch, u);
    if (isSpecWs) {
      flags.push("special_whitespace");
      specialWhitespaceCount++;
    }

    const isNonStdCtrl =
      (u <= 0x001f || (u >= 0x007f && u <= 0x009f)) && u !== 0x09 && u !== 0x0a && u !== 0x0d;
    if (isNonStdCtrl) flags.push("control_char");

    if (isCombiningMark(ch)) {
      flags.push("combining_mark");
      combiningMarkCount++;
    }

    if (isPrivateUse(u) || isNoncharacter(u) || !/\p{Assigned}/u.test(ch)) {
      flags.push("private_or_unassigned");
    }

    // Fullwidth ASCII U+FF01..U+FF5E or curated UTS #39 table
    if (u >= 0xff01 && u <= 0xff5e) {
      confusableAscii = String.fromCharCode(u - 0xfee0);
    } else if (CLIENT_UTS39_FALLBACK[u]) {
      confusableAscii = CLIENT_UTS39_FALLBACK[u]!;
    }
    if (confusableAscii) {
      flags.push("potential_confusable");
      confusableCount++;
      const repHex = formatHexCode(confusableAscii.charCodeAt(0));
      confusablePrototype = `'${confusableAscii}' (${repHex})`;
    }

    const isAttentionItem = flags.length > 0;
    if (isAttentionItem) attentionCount++;

    const pushChange = (
      action: "removed" | "replaced",
      replacementLabel: string,
      reason: string,
    ) => {
      totalChangeCount++;
      if (changes.length < 500) {
        changes.push({
          codePointIndex: cpIdx,
          utf16Offset,
          codePointHex,
          originalLabel: displayGlyph,
          action,
          replacementLabel,
          reason,
        });
      }
    };

    if (u === 0xfeff && options.removeBom) {
      pushChange("removed", "", "bom");
    } else if (isBidiControl(u) && options.removeBidiControls) {
      pushChange("removed", "", "bidi_control");
    } else if (isJoinerOrVs(u) && options.removeJoinersAndVs) {
      pushChange("removed", "", "joiner_or_vs");
    } else if (isZeroW && options.removeZeroWidth) {
      pushChange("removed", "", "zero_width");
    } else if (isNonStdCtrl && options.removeC0C1Controls) {
      pushChange("removed", "", "control_char");
    } else if (isSpecWs && options.normalizeSpecialSpaces) {
      if (u === 0x2028 || u === 0x2029 || u === 0x0085) {
        sanitizedParts.push("\n");
        pushChange("replaced", "[LF]", "special_whitespace");
      } else {
        sanitizedParts.push(" ");
        pushChange("replaced", "[SP]", "special_whitespace");
      }
    } else if (options.replaceConfusables && confusableAscii) {
      sanitizedParts.push(confusableAscii);
      pushChange("replaced", confusableAscii, "confusable");
    } else {
      sanitizedParts.push(ch);
    }

    const generalCategory = isCombiningMark(ch)
      ? "Mn · Mark"
      : isPrivateUse(u)
        ? "Co · Private_Use"
        : !/\p{Assigned}/u.test(ch)
          ? "Cn · Unassigned"
          : /\p{General_Category=Format}/u.test(ch)
            ? "Cf · Format"
            : /\p{General_Category=Control}/u.test(ch)
              ? "Cc · Control"
              : /\p{General_Category=Space_Separator}/u.test(ch)
                ? "Zs · Space_Separator"
                : /\p{Letter}/u.test(ch)
                  ? "L · Letter"
                  : "Other";

    const script = /\p{Script=Han}/u.test(ch)
      ? "Han"
      : /\p{Script=Hangul}/u.test(ch)
        ? "Hangul"
        : /\p{Script=Cyrillic}/u.test(ch)
          ? "Cyrillic"
          : /\p{Script=Greek}/u.test(ch)
            ? "Greek"
            : /\p{Script=Arabic}/u.test(ch)
              ? "Arabic"
              : /\p{Script=Latin}/u.test(ch)
                ? "Latin"
                : "Common";

    entries.push({
      codePointIndex: cpIdx,
      utf16Offset,
      utf16Length,
      graphemeIndex: graphemeIdx,
      scalarValue: u,
      codePointHex,
      displayGlyph,
      name: fallbackCharacterName(ch, u),
      generalCategory,
      script,
      utf8BytesHex,
      flags,
      isAttentionItem,
      confusablePrototype,
    });

    utf16Offset += utf16Length;
    cpIdx++;
  }

  return {
    summary: {
      unicodeVersion: "16.0.0",
      totalCodePoints: entries.length,
      totalUtf16Units: utf16Offset,
      totalGraphemes: graphemeEndsUtf16.length,
      totalUtf8Bytes: utf8Total.byteLength,
      attentionCount,
      zeroWidthCount,
      bidiControlCount,
      specialWhitespaceCount,
      confusableCount,
      joinerOrVsCount,
      combiningMarkCount,
    },
    entries,
    sanitizedText: sanitizedParts.join(""),
    changes,
    changesTruncated: totalChangeCount > 500,
    totalChangeCount,
  };
}
