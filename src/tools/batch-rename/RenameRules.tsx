import { useId } from "react";
import { useI18n } from "../../i18n/I18nContext";
import {
  initialRenameRule,
  renameRuleError,
  type RenameCase,
  type RenameDate,
  type RenameRule,
  type RenameScope,
  type RenameSort,
} from "./renameRulesModel";
import "./renameRules.css";

const copy = {
  "zh-CN": {
    settings: "重命名规则",
    kind: "规则",
    replace: "查找与替换",
    add: "添加前后缀",
    format: "序号与日期",
    case: "大小写",
    scope: "应用到",
    stem: "主文件名",
    extension: "扩展名",
    fullName: "完整文件名",
    find: "查找",
    replacement: "替换为",
    regex: "使用正则表达式",
    captures:
      "例如，用 (IMG)_(\\d+) 查找 IMG_42，用 $2-$1 替换为 42-IMG。用 ${name} 引用命名组，$$ 表示一个美元符号。",
    prefix: "前缀",
    suffix: "后缀",
    base: "基本名称",
    start: "起始序号",
    padding: "序号位数",
    separator: "分隔符",
    date: "日期",
    none: "不添加日期",
    created: "创建时间",
    modified: "修改时间",
    today: "今天",
    formatHelp: "按基本名称、日期（YYYY-MM-DD）、序号排列，以分隔符连接。保留原扩展名。",
    mode: "转换方式",
    lower: "小写",
    upper: "大写",
    title: "单词首字母大写",
    sort: "排序依据（升序）",
    byName: "文件名",
  },
  "en-US": {
    settings: "Rename rules",
    kind: "Rule",
    replace: "Find and replace",
    add: "Add prefix or suffix",
    format: "Numbering and date",
    case: "Change case",
    scope: "Apply to",
    stem: "Name stem",
    extension: "Extension",
    fullName: "Full filename",
    find: "Find",
    replacement: "Replace with",
    regex: "Use regular expression",
    captures:
      "For example, find IMG_42 with (IMG)_(\\d+) and replace with $2-$1 to get 42-IMG. Use ${name} for a named group and $$ for a dollar sign.",
    prefix: "Prefix",
    suffix: "Suffix",
    base: "Base name",
    start: "Starting number",
    padding: "Number width",
    separator: "Separator",
    date: "Date",
    none: "No date",
    created: "Creation time",
    modified: "Modification time",
    today: "Today",
    formatHelp:
      "The separator joins the base name, date (YYYY-MM-DD), and number. The original extension is preserved.",
    mode: "Letter case",
    lower: "Lowercase",
    upper: "Uppercase",
    title: "Title case",
    sort: "Sort by (ascending)",
    byName: "Filename",
  },
};

interface RenameRulesProps {
  rule: RenameRule;
  sort: RenameSort;
  onRuleChange: (rule: RenameRule) => void;
  onSortChange: (sort: RenameSort) => void;
  disabled?: boolean;
  regexError?: string | null;
}

export function RenameRules({
  rule,
  sort,
  onRuleChange,
  onSortChange,
  disabled,
  regexError,
}: RenameRulesProps) {
  const { locale } = useI18n();
  const t = copy[locale];
  const hintId = useId();
  const errorId = useId();
  const error =
    (rule.kind === "replace" && rule.regex && regexError) || renameRuleError(rule, locale);
  return (
    <fieldset className="rename-rules" disabled={disabled}>
      <legend>{t.settings}</legend>
      <div className="rename-rule-fields">
        <label className="field-stack">
          {t.kind}
          <select
            className="select-input"
            value={rule.kind}
            onChange={(e) => onRuleChange(initialRenameRule(e.target.value as RenameRule["kind"]))}
          >
            {(["replace", "add", "format", "case"] as const).map((kind) => (
              <option key={kind} value={kind}>
                {t[kind]}
              </option>
            ))}
          </select>
        </label>
        {rule.kind !== "format" && (
          <label className="field-stack">
            {t.scope}
            <select
              className="select-input"
              value={rule.scope}
              onChange={(e) => onRuleChange({ ...rule, scope: e.target.value as RenameScope })}
            >
              <option value="stem">{t.stem}</option>
              <option value="extension">{t.extension}</option>
              <option value="name">{t.fullName}</option>
            </select>
          </label>
        )}
        <label className="field-stack">
          {t.sort}
          <select
            className="select-input"
            value={sort}
            onChange={(e) => onSortChange(e.target.value as RenameSort)}
          >
            <option value="name">{t.byName}</option>
            <option value="created">{t.created}</option>
            <option value="modified">{t.modified}</option>
          </select>
        </label>
      </div>
      {rule.kind === "replace" && (
        <>
          <div className="rename-rule-fields">
            <label className="field-stack">
              {t.find}
              <input
                className="text-input"
                value={rule.find}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={!!error}
                aria-describedby={error ? errorId : undefined}
                onChange={(e) => onRuleChange({ ...rule, find: e.target.value })}
              />
            </label>
            <label className="field-stack">
              {t.replacement}
              <input
                className="text-input"
                value={rule.replacement}
                autoComplete="off"
                spellCheck={false}
                aria-describedby={rule.regex ? hintId : undefined}
                onChange={(e) => onRuleChange({ ...rule, replacement: e.target.value })}
              />
            </label>
          </div>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={rule.regex}
              onChange={(e) => onRuleChange({ ...rule, regex: e.target.checked })}
            />
            {t.regex}
          </label>
          {rule.regex && (
            <p id={hintId} className="field-hint">
              {t.captures}
            </p>
          )}
        </>
      )}
      {rule.kind === "add" && (
        <div className="rename-rule-fields">
          {(["prefix", "suffix"] as const).map((key) => (
            <label key={key} className="field-stack">
              {t[key]}
              <input
                className="text-input"
                value={rule[key]}
                autoComplete="off"
                onChange={(e) => onRuleChange({ ...rule, [key]: e.target.value })}
              />
            </label>
          ))}
        </div>
      )}
      {rule.kind === "format" && (
        <>
          <div className="rename-rule-fields">
            <label className="field-stack">
              {t.base}
              <input
                className="text-input"
                value={rule.base}
                autoComplete="off"
                onChange={(e) => onRuleChange({ ...rule, base: e.target.value })}
              />
            </label>
            <label className="field-stack">
              {t.date}
              <select
                className="select-input"
                value={rule.date}
                onChange={(e) => onRuleChange({ ...rule, date: e.target.value as RenameDate })}
              >
                {(["none", "created", "modified", "today"] as const).map((date) => (
                  <option key={date} value={date}>
                    {t[date]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-stack">
              {t.start}
              <input
                className="text-input"
                type="number"
                step={1}
                min={0}
                max={Number.MAX_SAFE_INTEGER}
                value={Number.isFinite(rule.start) ? rule.start : ""}
                aria-describedby={error ? errorId : undefined}
                onChange={(e) => onRuleChange({ ...rule, start: e.target.valueAsNumber })}
              />
            </label>
            <label className="field-stack">
              {t.padding}
              <input
                className="text-input"
                type="number"
                min={1}
                max={12}
                step={1}
                value={Number.isFinite(rule.padding) ? rule.padding : ""}
                aria-describedby={error ? errorId : undefined}
                onChange={(e) => onRuleChange({ ...rule, padding: e.target.valueAsNumber })}
              />
            </label>
            <label className="field-stack">
              {t.separator}
              <input
                className="text-input"
                value={rule.separator}
                autoComplete="off"
                onChange={(e) => onRuleChange({ ...rule, separator: e.target.value })}
              />
            </label>
          </div>
          <p className="field-hint">{t.formatHelp}</p>
        </>
      )}
      {rule.kind === "case" && (
        <div className="rename-rule-fields">
          <label className="field-stack">
            {t.mode}
            <select
              className="select-input"
              value={rule.mode}
              onChange={(e) => onRuleChange({ ...rule, mode: e.target.value as RenameCase })}
            >
              {(["lower", "upper", "title"] as const).map((mode) => (
                <option key={mode} value={mode}>
                  {t[mode]}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {error && (
        <p className="field-hint rename-rule-error" role="status" id={errorId}>
          {error}
        </p>
      )}
    </fieldset>
  );
}
