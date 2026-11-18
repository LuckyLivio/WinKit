import effWordlistRaw from "./eff_wordlist_7772.txt?raw";

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;
export const MIN_PASSPHRASE_WORDS = 3;
export const MAX_PASSPHRASE_WORDS = 12;
export const MIN_SECRET_BATCH_COUNT = 1;
export const MAX_SECRET_BATCH_COUNT = 50;

export const UPPERCASE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const LOWERCASE_CHARS = "abcdefghijklmnopqrstuvwxyz";
export const DIGIT_CHARS = "0123456789";
export const SYMBOL_CHARS = "!@#$%^&*()-_=+[]{};:,.<>?/|~";
export const LOOKALIKE_CHARS = "0Oo1lI|";

const MAX_UNIFORM_DRAW_ATTEMPTS = 4_096;
const MAX_CONSTRAINED_CANDIDATE_ATTEMPTS = 4_096;
const APPENDED_NUMBER_MODULUS = 100; // 00..99

export type PassphraseSeparator = "-" | " " | "." | "_" | "";

export type SecretGenRequest =
  | {
      mode: "password";
      length: number;
      count: number;
      uppercase: boolean;
      lowercase: boolean;
      digits: boolean;
      symbols: boolean;
      excludeLookAlikes: boolean;
      requireEachSelectedClass: boolean;
    }
  | {
      mode: "passphrase";
      wordCount: number;
      count: number;
      separator: PassphraseSeparator;
      capitalizeWords: boolean;
      includeNumber: boolean;
    };

export type StrengthTier = "weak" | "fair" | "strong" | "very_strong";

export type EntropyModelKind =
  | "independent_uniform_chars"
  | "constrained_all_selected_classes"
  | "independent_words_with_replacement";

export interface SecretStrengthEstimate {
  estimatedBits: number;
  unconstrainedUpperBoundBits: number;
  isUpperBound: boolean;
  tier: StrengthTier;
  modelKind: EntropyModelKind;
  poolSize: number;
}

export interface SecretGenResponse {
  items: string[];
  strength: SecretStrengthEstimate;
}

let cachedWords: readonly string[] | null = null;

export function getEffWordlist(): readonly string[] {
  if (!cachedWords) {
    cachedWords = effWordlistRaw
      .split(/\r?\n/)
      .map((w) => w.trim())
      .filter((w) => w.length > 0);
  }
  return cachedWords;
}

export type RandomUint32Source = () => number;

/**
 * Cryptographically secure 32-bit unsigned integer source backed strictly by W3C Web Crypto
 * `crypto.getRandomValues` (draws in small chunks well within the 65,536-byte spec ceiling).
 * Never falls back to `Math.random()`.
 */
export function createWebCryptoUint32Source(): RandomUint32Source {
  if (typeof globalThis.crypto === "undefined" || !globalThis.crypto.getRandomValues) {
    return () => {
      throw JSON.stringify({
        code: "CSPRNG_FAILED",
        message: "Web Crypto CSPRNG (crypto.getRandomValues) is unavailable.",
      });
    };
  }
  const buffer = new Uint32Array(256); // 1,024 bytes << 65,536-byte QuotaExceededError limit
  let cursor = buffer.length;
  return () => {
    if (cursor >= buffer.length) {
      globalThis.crypto.getRandomValues(buffer);
      cursor = 0;
    }
    const val = buffer[cursor]!;
    cursor += 1;
    return val >>> 0;
  };
}

export function sampleUniformIndex(nextUint32: RandomUint32Source, upperExclusive: number): number {
  if (!Number.isSafeInteger(upperExclusive) || upperExclusive <= 0 || upperExclusive > 0xffffffff) {
    throw JSON.stringify({
      code: "INVALID_PARAMETER",
      message: "Invalid sampling pool size.",
    });
  }
  if (upperExclusive === 1) return 0;

  const totalSpace = 0x1_0000_0000;
  const zone = totalSpace - (totalSpace % upperExclusive);

  for (let attempt = 0; attempt < MAX_UNIFORM_DRAW_ATTEMPTS; attempt++) {
    const candidate = nextUint32() >>> 0;
    if (candidate < zone) {
      return candidate % upperExclusive;
    }
  }

  throw JSON.stringify({
    code: "SAMPLING_BUDGET_EXCEEDED",
    message: "Unbiased random rejection budget was exhausted.",
  });
}

/**
 * Exact inclusion-exclusion log2(|V|) using BigInt combinatorics:
 * |V| = sum_{T subseteq {1..k}} (-1)^|T| * (S - sum_{i in T} s_i)^L.
 */
export function computeExactConstrainedPasswordBits(
  length: number,
  classSizes: readonly number[],
): number {
  const total = classSizes.reduce((acc, s) => acc + s, 0);
  if (total <= 0 || length <= 0) return 0;
  const k = classSizes.length;
  if (k <= 1) {
    return length * Math.log2(total);
  }

  const bigL = BigInt(length);
  let validCount = 0n;
  const subsets = 1 << k;

  for (let mask = 0; mask < subsets; mask++) {
    let excluded = 0;
    let bitsSet = 0;
    for (let i = 0; i < k; i++) {
      if ((mask & (1 << i)) !== 0) {
        excluded += classSizes[i]!;
        bitsSet += 1;
      }
    }
    const remaining = BigInt(Math.max(0, total - excluded));
    const term = remaining ** bigL;
    if (bitsSet % 2 === 0) {
      validCount += term;
    } else {
      validCount -= term;
    }
  }

  if (validCount <= 0n) return 0;

  // Accurate log2 of arbitrary-precision BigInt via bit-length + top 53 mantissa bits
  const hex = validCount.toString(16);
  const topHex = hex.slice(0, 14); // up to 56 bits
  const topVal = Number(BigInt(`0x${topHex}`));
  const shiftBits = (hex.length - topHex.length) * 4;
  return Math.log2(topVal) + shiftBits;
}

function classifyTier(bits: number): StrengthTier {
  if (bits < 50) return "weak";
  if (bits < 70) return "fair";
  if (bits < 100) return "strong";
  return "very_strong";
}

function roundBits(bits: number): number {
  return Math.round(bits * 100) / 100;
}

/**
 * Pure deterministic configuration validation & strength model preview (runs synchronously
 * without consuming random entropy so invalid settings give immediate feedback).
 */
export function previewSecretConfigStrength(
  req: SecretGenRequest,
):
  | { ok: true; strength: SecretStrengthEstimate; activePoolPreview: string }
  | { ok: false; code: string; message: string } {
  if (
    !Number.isInteger(req.count) ||
    req.count < MIN_SECRET_BATCH_COUNT ||
    req.count > MAX_SECRET_BATCH_COUNT
  ) {
    return {
      ok: false,
      code: "INVALID_BATCH_COUNT",
      message: `Batch count must be an integer between ${MIN_SECRET_BATCH_COUNT} and ${MAX_SECRET_BATCH_COUNT}.`,
    };
  }

  if (req.mode === "password") {
    if (
      !Number.isInteger(req.length) ||
      req.length < MIN_PASSWORD_LENGTH ||
      req.length > MAX_PASSWORD_LENGTH
    ) {
      return {
        ok: false,
        code: "INVALID_PASSWORD_LENGTH",
        message: `Password length must be an integer between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH}.`,
      };
    }

    const filterSet = (src: string): string[] => {
      const res: string[] = [];
      for (const ch of src) {
        if (req.excludeLookAlikes && LOOKALIKE_CHARS.includes(ch)) continue;
        if (!res.includes(ch)) res.push(ch);
      }
      return res;
    };

    const classes: string[][] = [];
    if (req.uppercase) classes.push(filterSet(UPPERCASE_CHARS));
    if (req.lowercase) classes.push(filterSet(LOWERCASE_CHARS));
    if (req.digits) classes.push(filterSet(DIGIT_CHARS));
    if (req.symbols) classes.push(filterSet(SYMBOL_CHARS));

    if (classes.length === 0) {
      return {
        ok: false,
        code: "NO_CHARSET_SELECTED",
        message: "At least one character category must be enabled.",
      };
    }
    if (classes.some((c) => c.length === 0)) {
      return {
        ok: false,
        code: "EMPTY_CLASS_AFTER_FILTER",
        message: "A selected character category became empty after filtering.",
      };
    }
    if (req.requireEachSelectedClass && req.length < classes.length) {
      return {
        ok: false,
        code: "IMPOSSIBLE_CONSTRAINTS",
        message: "Password length is shorter than the number of required categories.",
      };
    }

    const combined: string[] = [];
    const classSizes: number[] = [];
    for (const cls of classes) {
      let countForClass = 0;
      for (const ch of cls) {
        if (!combined.includes(ch)) {
          combined.push(ch);
          countForClass += 1;
        }
      }
      classSizes.push(countForClass);
    }

    const poolSize = combined.length;
    const unconstrainedBits = req.length * Math.log2(poolSize);
    const rawBits = req.requireEachSelectedClass
      ? computeExactConstrainedPasswordBits(req.length, classSizes)
      : unconstrainedBits;

    return {
      ok: true,
      activePoolPreview: combined.join(""),
      strength: {
        estimatedBits: roundBits(rawBits),
        unconstrainedUpperBoundBits: roundBits(unconstrainedBits),
        isUpperBound: false,
        tier: classifyTier(rawBits),
        modelKind: req.requireEachSelectedClass
          ? "constrained_all_selected_classes"
          : "independent_uniform_chars",
        poolSize,
      },
    };
  }

  // Passphrase mode
  if (
    !Number.isInteger(req.wordCount) ||
    req.wordCount < MIN_PASSPHRASE_WORDS ||
    req.wordCount > MAX_PASSPHRASE_WORDS
  ) {
    return {
      ok: false,
      code: "INVALID_WORD_COUNT",
      message: `Word count must be an integer between ${MIN_PASSPHRASE_WORDS} and ${MAX_PASSPHRASE_WORDS}.`,
    };
  }
  const allowedSeps: readonly string[] = ["-", " ", ".", "_", ""];
  if (!allowedSeps.includes(req.separator)) {
    return {
      ok: false,
      code: "INVALID_SEPARATOR",
      message: "Unsupported passphrase separator.",
    };
  }

  const words = getEffWordlist();
  const dictLen = words.length;
  const choiceBits =
    req.wordCount * Math.log2(dictLen) +
    (req.includeNumber ? Math.log2(APPENDED_NUMBER_MODULUS) : 0);
  const isUpperBound = req.separator === "" && !req.capitalizeWords;

  return {
    ok: true,
    activePoolPreview: `EFF Wordlist (${dictLen.toLocaleString()} words)`,
    strength: {
      estimatedBits: roundBits(choiceBits),
      unconstrainedUpperBoundBits: roundBits(choiceBits),
      isUpperBound,
      tier: classifyTier(choiceBits),
      modelKind: "independent_words_with_replacement",
      poolSize: dictLen,
    },
  };
}

export function generateSecretsClientFallback(
  req: SecretGenRequest,
  rngSource: RandomUint32Source = createWebCryptoUint32Source(),
): SecretGenResponse {
  const preview = previewSecretConfigStrength(req);
  if (!preview.ok) {
    throw JSON.stringify({
      code: "INVALID_PARAMETER",
      message: preview.message,
    });
  }

  if (req.mode === "password") {
    const filterSet = (src: string): string[] => {
      const res: string[] = [];
      for (const ch of src) {
        if (req.excludeLookAlikes && LOOKALIKE_CHARS.includes(ch)) continue;
        if (!res.includes(ch)) res.push(ch);
      }
      return res;
    };

    const classes: string[][] = [];
    if (req.uppercase) classes.push(filterSet(UPPERCASE_CHARS));
    if (req.lowercase) classes.push(filterSet(LOWERCASE_CHARS));
    if (req.digits) classes.push(filterSet(DIGIT_CHARS));
    if (req.symbols) classes.push(filterSet(SYMBOL_CHARS));

    const pool: Array<{ ch: string; bit: number }> = [];
    classes.forEach((cls, classIdx) => {
      const bit = 1 << classIdx;
      for (const ch of cls) {
        if (!pool.some((p) => p.ch === ch)) {
          pool.push({ ch, bit });
        }
      }
    });

    const requiredMask = req.requireEachSelectedClass ? (1 << classes.length) - 1 : 0;
    const maxAttempts = req.requireEachSelectedClass ? MAX_CONSTRAINED_CANDIDATE_ATTEMPTS : 1;
    const items: string[] = [];

    for (let c = 0; c < req.count; c++) {
      let accepted: string | null = null;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let chars = "";
        let mask = 0;
        for (let i = 0; i < req.length; i++) {
          const idx = sampleUniformIndex(rngSource, pool.length);
          const picked = pool[idx]!;
          chars += picked.ch;
          mask |= picked.bit;
        }
        if (!req.requireEachSelectedClass || (mask & requiredMask) === requiredMask) {
          accepted = chars;
          break;
        }
      }
      if (accepted === null) {
        throw JSON.stringify({
          code: "SAMPLING_BUDGET_EXCEEDED",
          message: "Bounded rejection sampling could not satisfy character category constraints.",
        });
      }
      items.push(accepted);
    }

    return {
      items,
      strength: preview.strength,
    };
  }

  // Passphrase mode
  const words = getEffWordlist();
  const items: string[] = [];
  for (let c = 0; c < req.count; c++) {
    const pickedWords: string[] = [];
    for (let w = 0; w < req.wordCount; w++) {
      const idx = sampleUniformIndex(rngSource, words.length);
      const rawWord = words[idx]!;
      pickedWords.push(
        req.capitalizeWords ? rawWord.charAt(0).toUpperCase() + rawWord.slice(1) : rawWord,
      );
    }
    let phrase = pickedWords.join(req.separator);
    if (req.includeNumber) {
      const num = sampleUniformIndex(rngSource, APPENDED_NUMBER_MODULUS);
      const padded = String(num).padStart(2, "0");
      phrase += req.separator === "" ? padded : `${req.separator}${padded}`;
    }
    items.push(phrase);
  }

  return {
    items,
    strength: preview.strength,
  };
}
