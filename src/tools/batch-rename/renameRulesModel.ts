import type { Locale } from "../../i18n/messages";

export type RenameSort = "name" | "created" | "modified";
export type RenameScope = "stem" | "extension" | "name";
export type RenameDate = "none" | "created" | "modified" | "today";
export type RenameCase = "lower" | "upper" | "title";

export type RenameRule =
  | { kind: "replace"; find: string; replacement: string; regex: boolean; scope: RenameScope }
  | { kind: "add"; prefix: string; suffix: string; scope: RenameScope }
  | {
      kind: "format";
      base: string;
      start: number;
      padding: number;
      separator: string;
      date: RenameDate;
    }
  | { kind: "case"; mode: RenameCase; scope: RenameScope };

export const DEFAULT_RENAME_SORT: RenameSort = "name";

export function initialRenameRule(kind: RenameRule["kind"]): RenameRule {
  switch (kind) {
    case "replace":
      return { kind, find: "", replacement: "", regex: false, scope: "stem" };
    case "add":
      return { kind, prefix: "", suffix: "", scope: "stem" };
    case "format":
      return { kind, base: "", start: 1, padding: 3, separator: "-", date: "none" };
    case "case":
      return { kind, mode: "lower", scope: "stem" };
  }
}

export const DEFAULT_RENAME_RULE = initialRenameRule("replace");

export function renameRuleError(rule: RenameRule, locale: Locale): string | null {
  const zh = locale === "zh-CN";
  if (rule.kind === "replace" && !rule.find) {
    return zh ? "请输入要查找的内容。" : "Enter the text or pattern to find.";
  }
  if (rule.kind === "format") {
    if (!Number.isSafeInteger(rule.start) || rule.start < 0) {
      return zh
        ? "起始序号须为 0 至 9007199254740991 的整数。"
        : "Enter a whole starting number from 0 to 9007199254740991.";
    }
    if (!Number.isInteger(rule.padding) || rule.padding < 1 || rule.padding > 12) {
      return zh ? "序号位数须为 1 至 12 的整数。" : "Enter a number width from 1 to 12.";
    }
  }
  return null;
}
