import type { Locale } from "../../i18n/messages";
import {
  renameRuleError,
  type RenameCase,
  type RenameDate,
  type RenameRule,
  type RenameScope,
  type RenameSort,
} from "./renameRulesModel";

export const MAX_BATCH_RENAME_FILES = 2_000;
export const RENAME_PREVIEW_PAGE_SIZE = 200;

export interface BatchRenameSourceEntry {
  path: string;
  parentDir: string;
  fileName: string;
  byteLength: number;
  createdMs: number | null;
  modifiedMs: number | null;
}

export type BatchRenameRowStatus =
  "ready" | "case_only" | "unchanged" | "invalid_name" | "conflict_in_batch" | "conflict_existing";

export interface BatchRenamePreviewRow {
  index: number;
  path: string;
  parentDir: string;
  oldName: string;
  newName: string;
  byteLength: number;
  createdMs: number | null;
  modifiedMs: number | null;
  status: BatchRenameRowStatus;
  reason: string | null;
}

export interface BatchRenamePreviewSummary {
  rows: BatchRenamePreviewRow[];
  regexError: string | null;
  ruleValidationError: string | null;
  readyCount: number;
  caseOnlyCount: number;
  unchangedCount: number;
  invalidCount: number;
  conflictCount: number;
  canExecute: boolean;
}

const RESERVED_DOS_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "COM\u00B9",
  "COM\u00B2",
  "COM\u00B3",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
  "LPT\u00B9",
  "LPT\u00B2",
  "LPT\u00B3",
]);

const naturalNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function normalizeWindowsDirKey(dirPath: string): string {
  return dirPath.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

export function makeWindowsSlotKey(parentDir: string, fileName: string): string {
  return `${normalizeWindowsDirKey(parentDir)}\\${fileName.toLowerCase()}`;
}

export function splitFileNameStemAndExt(fileName: string): {
  stem: string;
  ext: string;
  hasExtension: boolean;
} {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot <= 0) {
    return { stem: fileName, ext: "", hasExtension: false };
  }
  return {
    stem: fileName.slice(0, lastDot),
    ext: fileName.slice(lastDot + 1),
    hasExtension: true,
  };
}

export function formatLocalDateYmd(timestampMs: number): string {
  const d = new Date(timestampMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function applyCaseMode(input: string, mode: RenameCase): string {
  if (mode === "lower") {
    return input.toLowerCase();
  }
  if (mode === "upper") {
    return input.toUpperCase();
  }
  // Title case across letter/digit word runs while keeping original delimiters intact
  return input.replace(/[\p{L}\p{N}]+/gu, (word) => {
    const chars = Array.from(word);
    if (chars.length === 0) return word;
    return chars[0]!.toUpperCase() + chars.slice(1).join("").toLowerCase();
  });
}

/**
 * Supports `$1`..`$99`, `$0` / `$&`, `${name}` (per `RenameRules.tsx`), `$<name>`, and `$$`
 * in a single left-to-right template scan without double-expanding `$` inside group values.
 */
export function expandRegexReplacementTemplate(
  template: string,
  match: string,
  captures: readonly (string | undefined)[],
  namedGroups: Record<string, string | undefined> | undefined,
): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const ch = template[i]!;
    if (ch !== "$" || i + 1 >= template.length) {
      out += ch;
      i += 1;
      continue;
    }

    const next = template[i + 1]!;
    if (next === "$") {
      out += "$";
      i += 2;
      continue;
    }
    if (next === "&" || (next === "0" && !/\d/.test(template[i + 2] ?? ""))) {
      out += match;
      i += 2;
      continue;
    }
    if (next === "{" || next === "<") {
      const closeChar = next === "{" ? "}" : ">";
      const endIdx = template.indexOf(closeChar, i + 2);
      if (endIdx > i + 2) {
        const groupName = template.slice(i + 2, endIdx);
        if (/^[\p{ID_Start}_$][\p{ID_Continue}$]*$/u.test(groupName)) {
          out += namedGroups?.[groupName] ?? "";
          i = endIdx + 1;
          continue;
        }
      }
    }
    if (next >= "1" && next <= "9") {
      const twoDigit = template.slice(i + 1, i + 3);
      if (/^\d\d$/.test(twoDigit)) {
        const idx2 = Number(twoDigit);
        if (idx2 >= 1 && idx2 <= captures.length) {
          out += captures[idx2 - 1] ?? "";
          i += 3;
          continue;
        }
      }
      const idx1 = Number(next);
      if (idx1 >= 1 && idx1 <= captures.length) {
        out += captures[idx1 - 1] ?? "";
      }
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

export function compileRenameRuleRegex(rule: RenameRule): {
  regex: RegExp | null;
  error: string | null;
} {
  if (rule.kind !== "replace" || !rule.regex || !rule.find) {
    return { regex: null, error: null };
  }
  try {
    return { regex: new RegExp(rule.find, "gu"), error: null };
  } catch (err) {
    return {
      regex: null,
      error: err instanceof Error ? err.message : "Invalid regular expression",
    };
  }
}

function applyScopedTransform(
  fileName: string,
  scope: RenameScope,
  transform: (segment: string) => string,
): string {
  if (scope === "name") {
    return transform(fileName);
  }
  const { stem, ext, hasExtension } = splitFileNameStemAndExt(fileName);
  if (scope === "stem") {
    const nextStem = transform(stem);
    return hasExtension ? (ext.length > 0 ? `${nextStem}.${ext}` : nextStem) : nextStem;
  }
  // `scope === "extension"`
  const rawNextExt = transform(ext);
  const cleanExt = rawNextExt.startsWith(".") ? rawNextExt.slice(1) : rawNextExt;
  if (cleanExt.length === 0) {
    return stem;
  }
  return `${stem}.${cleanExt}`;
}

function resolveItemDateYmd(
  entry: BatchRenameSourceEntry,
  dateMode: RenameDate,
  nowMs: number,
): string | null {
  if (dateMode === "none") return null;
  if (dateMode === "today") return formatLocalDateYmd(nowMs);
  if (dateMode === "created") {
    const ts = entry.createdMs ?? entry.modifiedMs ?? nowMs;
    return formatLocalDateYmd(ts);
  }
  const ts = entry.modifiedMs ?? entry.createdMs ?? nowMs;
  return formatLocalDateYmd(ts);
}

export function computeSingleTargetName(
  entry: BatchRenameSourceEntry,
  sortedZeroIndex: number,
  rule: RenameRule,
  compiledRegex: RegExp | null,
  nowMs: number,
): string {
  if (rule.kind === "replace") {
    if (!rule.find) return entry.fileName;
    if (!rule.regex) {
      return applyScopedTransform(entry.fileName, rule.scope, (seg) =>
        seg.split(rule.find).join(rule.replacement),
      );
    }
    if (!compiledRegex) return entry.fileName;
    return applyScopedTransform(entry.fileName, rule.scope, (seg) => {
      compiledRegex.lastIndex = 0;
      return seg.replace(compiledRegex, (...args: unknown[]) => {
        const whole = args[0] as string;
        const lastArg = args[args.length - 1];
        const hasNamed = typeof lastArg === "object" && lastArg !== null && !Array.isArray(lastArg);
        const named = hasNamed ? (lastArg as Record<string, string | undefined>) : undefined;
        // Args layout: (match, p1..pn, offset, string[, groups])
        const tailCount = hasNamed ? 3 : 2;
        const captures = args.slice(1, args.length - tailCount) as (string | undefined)[];
        return expandRegexReplacementTemplate(rule.replacement, whole, captures, named);
      });
    });
  }

  if (rule.kind === "add") {
    if (!rule.prefix && !rule.suffix) return entry.fileName;
    return applyScopedTransform(
      entry.fileName,
      rule.scope,
      (seg) => `${rule.prefix}${seg}${rule.suffix}`,
    );
  }

  if (rule.kind === "case") {
    return applyScopedTransform(entry.fileName, rule.scope, (seg) => applyCaseMode(seg, rule.mode));
  }

  // `rule.kind === "format"`
  const { ext, hasExtension } = splitFileNameStemAndExt(entry.fileName);
  const counter = BigInt(Math.trunc(rule.start)) + BigInt(sortedZeroIndex);
  const counterStr = counter.toString(10).padStart(rule.padding, "0");
  const datePart = resolveItemDateYmd(entry, rule.date, nowMs);
  const parts = [rule.base, datePart ?? "", counterStr].filter((p) => p.length > 0);
  const nextStem = parts.join(rule.separator);
  return hasExtension && ext.length > 0 ? `${nextStem}.${ext}` : nextStem;
}

export function validateWindowsFileName(name: string, locale: Locale): string | null {
  const zh = locale === "zh-CN";
  if (name.length === 0) {
    return zh ? "新文件名不能为空。" : "Target filename cannot be empty.";
  }
  if (name.length > 255) {
    return zh
      ? "新文件名超过 Windows 255 字符上限。"
      : "Target filename exceeds the 255-character Windows limit.";
  }
  if (name === "." || name === "..") {
    return zh ? "不能使用 . 或 .. 作为文件名。" : "Filename cannot be '.' or '..'.";
  }
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code <= 0x1f || '<>:"/\\|?*'.includes(name[i]!)) {
      return zh
        ? '包含 Windows 禁止字符（< > : " / \\ | ? * 或控制字符）。'
        : 'Contains characters disallowed on Windows (< > : " / \\ | ? * or control characters).';
    }
  }
  if (name.endsWith(" ") || name.endsWith(".")) {
    return zh
      ? "Windows 文件名不能以空格或句点结尾。"
      : "Windows filenames cannot end with a space or a period.";
  }

  const deviceCandidate = (name.split(".")[0] ?? "").trim().toUpperCase();
  if (RESERVED_DOS_NAMES.has(deviceCandidate)) {
    return zh
      ? `"${deviceCandidate}" 是 Windows 保留设备名，不能用作文件名。`
      : `"${deviceCandidate}" is a reserved Windows device name.`;
  }

  return null;
}

export function sortBatchRenameEntries(
  entries: readonly BatchRenameSourceEntry[],
  sort: RenameSort,
): BatchRenameSourceEntry[] {
  const copy = [...entries];
  copy.sort((a, b) => {
    if (sort === "created") {
      const ta = a.createdMs ?? a.modifiedMs ?? 0;
      const tb = b.createdMs ?? b.modifiedMs ?? 0;
      if (ta !== tb) return ta - tb;
    } else if (sort === "modified") {
      const ta = a.modifiedMs ?? 0;
      const tb = b.modifiedMs ?? 0;
      if (ta !== tb) return ta - tb;
    }
    const byName = naturalNameCollator.compare(a.fileName, b.fileName);
    if (byName !== 0) return byName;
    return a.path.localeCompare(b.path);
  });
  return copy;
}

export function computeBatchRenamePreview(
  entries: readonly BatchRenameSourceEntry[],
  rule: RenameRule,
  sort: RenameSort,
  options: {
    locale: Locale;
    existingDirSiblings?: Record<string, readonly string[]>;
    nowMs?: number;
  },
): BatchRenamePreviewSummary {
  const zh = options.locale === "zh-CN";
  const nowMs = options.nowMs ?? Date.now();
  const sorted = sortBatchRenameEntries(entries, sort);
  const { regex, error: regexError } = compileRenameRuleRegex(rule);
  const ruleValidationError = regexError ?? renameRuleError(rule, options.locale);
  const hasBlockingRuleError =
    Boolean(regexError) || (rule.kind === "format" && Boolean(ruleValidationError));

  // Build normalized lookup of un-selected sibling filenames per parent directory
  const externalSlotSet = new Set<string>();
  const batchOldSlots = new Set<string>(
    sorted.map((item) => makeWindowsSlotKey(item.parentDir, item.fileName)),
  );
  if (options.existingDirSiblings) {
    for (const [dirRaw, names] of Object.entries(options.existingDirSiblings)) {
      for (const siblingName of names) {
        const slot = makeWindowsSlotKey(dirRaw, siblingName);
        if (!batchOldSlots.has(slot)) {
          externalSlotSet.add(slot);
        }
      }
    }
  }

  const draft = sorted.map((entry, idx) => {
    const newName = hasBlockingRuleError
      ? entry.fileName
      : computeSingleTargetName(entry, idx, rule, regex, nowMs);
    const invalidReason =
      newName === entry.fileName ? null : validateWindowsFileName(newName, options.locale);
    return {
      entry,
      index: idx + 1,
      newName,
      invalidReason,
      finalSlot: makeWindowsSlotKey(entry.parentDir, newName),
    };
  });

  // Count how many items in the batch land on each final case-insensitive Windows slot
  const finalSlotCounts = new Map<string, number>();
  for (const item of draft) {
    if (!item.invalidReason) {
      finalSlotCounts.set(item.finalSlot, (finalSlotCounts.get(item.finalSlot) ?? 0) + 1);
    }
  }

  let readyCount = 0;
  let caseOnlyCount = 0;
  let unchangedCount = 0;
  let invalidCount = 0;
  let conflictCount = 0;

  const rows: BatchRenamePreviewRow[] = draft.map((item) => {
    const { entry, index, newName, invalidReason, finalSlot } = item;
    if (invalidReason) {
      invalidCount += 1;
      return {
        index,
        path: entry.path,
        parentDir: entry.parentDir,
        oldName: entry.fileName,
        newName,
        byteLength: entry.byteLength,
        createdMs: entry.createdMs,
        modifiedMs: entry.modifiedMs,
        status: "invalid_name",
        reason: invalidReason,
      };
    }

    if ((finalSlotCounts.get(finalSlot) ?? 0) > 1) {
      conflictCount += 1;
      return {
        index,
        path: entry.path,
        parentDir: entry.parentDir,
        oldName: entry.fileName,
        newName,
        byteLength: entry.byteLength,
        createdMs: entry.createdMs,
        modifiedMs: entry.modifiedMs,
        status: "conflict_in_batch",
        reason: zh
          ? "批内存在多个文件指向同一目标名称（Windows 不区分大小写）。"
          : "Multiple items in this batch resolve to the same Windows filename (case-insensitive).",
      };
    }

    if (newName === entry.fileName) {
      unchangedCount += 1;
      return {
        index,
        path: entry.path,
        parentDir: entry.parentDir,
        oldName: entry.fileName,
        newName,
        byteLength: entry.byteLength,
        createdMs: entry.createdMs,
        modifiedMs: entry.modifiedMs,
        status: "unchanged",
        reason: null,
      };
    }

    if (externalSlotSet.has(finalSlot)) {
      conflictCount += 1;
      return {
        index,
        path: entry.path,
        parentDir: entry.parentDir,
        oldName: entry.fileName,
        newName,
        byteLength: entry.byteLength,
        createdMs: entry.createdMs,
        modifiedMs: entry.modifiedMs,
        status: "conflict_existing",
        reason: zh
          ? "同目录下已存在同名文件或文件夹，已阻止覆盖。"
          : "Another file or folder with this name already exists in the directory.",
      };
    }

    if (newName.toLowerCase() === entry.fileName.toLowerCase()) {
      caseOnlyCount += 1;
      return {
        index,
        path: entry.path,
        parentDir: entry.parentDir,
        oldName: entry.fileName,
        newName,
        byteLength: entry.byteLength,
        createdMs: entry.createdMs,
        modifiedMs: entry.modifiedMs,
        status: "case_only",
        reason: null,
      };
    }

    readyCount += 1;
    return {
      index,
      path: entry.path,
      parentDir: entry.parentDir,
      oldName: entry.fileName,
      newName,
      byteLength: entry.byteLength,
      createdMs: entry.createdMs,
      modifiedMs: entry.modifiedMs,
      status: "ready",
      reason: null,
    };
  });

  const actionableCount = readyCount + caseOnlyCount;
  const canExecute =
    !hasBlockingRuleError && actionableCount > 0 && invalidCount === 0 && conflictCount === 0;

  return {
    rows,
    regexError,
    ruleValidationError,
    readyCount,
    caseOnlyCount,
    unchangedCount,
    invalidCount,
    conflictCount,
    canExecute,
  };
}
