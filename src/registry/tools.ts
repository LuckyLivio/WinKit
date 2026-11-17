import type { ComponentType } from "react";
import type { Locale } from "../i18n/messages";
import { JsonFormatterWorkspace } from "../tools/json-formatter/JsonFormatterWorkspace";

export type ToolCategory = "developer" | "image";
export type ToolImplementationStatus = "full" | "partial";
export type ToolIconName = "braces" | "shield-check" | "frame";

export interface RegisteredTool {
  id: string;
  category: ToolCategory;
  name: Record<Locale, string>;
  summary: Record<Locale, string>;
  keywords: string[];
  icon: ToolIconName;
  implementationStatus: ToolImplementationStatus;
  component: ComponentType;
}

/**
 * Only genuinely implemented and verified tools are registered here.
 * Planned tools remain in docs/PARITY_MATRIX.md — never register placeholder entries.
 */
export const REGISTERED_TOOLS: RegisteredTool[] = [
  {
    id: "D01",
    category: "developer",
    name: {
      "zh-CN": "JSON 格式化与校验",
      "en-US": "JSON Formatter & Validator",
    },
    summary: {
      "zh-CN": "美化、单行压缩与语法校验，精确定位行列号并无损保留大整数与小数位",
      "en-US":
        "Format, minify, and validate JSON with exact line/column locations and lossless large-number fidelity",
    },
    keywords: [
      "json",
      "format",
      "minify",
      "validate",
      "pretty",
      "lint",
      "格式化",
      "压缩",
      "校验",
      "美化",
    ],
    icon: "braces",
    implementationStatus: "full",
    component: JsonFormatterWorkspace,
  },
];

export function findRegisteredTool(id: string): RegisteredTool | undefined {
  return REGISTERED_TOOLS.find((tool) => tool.id === id);
}

export function filterTools(
  tools: RegisteredTool[],
  options: {
    query: string;
    category: "all" | ToolCategory;
  },
): RegisteredTool[] {
  const normalizedQuery = options.query.trim().toLowerCase();
  return tools.filter((tool) => {
    if (options.category !== "all" && tool.category !== options.category) {
      return false;
    }
    if (!normalizedQuery) {
      return true;
    }
    const haystacks = [
      tool.id.toLowerCase(),
      tool.name["zh-CN"].toLowerCase(),
      tool.name["en-US"].toLowerCase(),
      tool.summary["zh-CN"].toLowerCase(),
      tool.summary["en-US"].toLowerCase(),
      ...tool.keywords.map((k) => k.toLowerCase()),
    ];
    return haystacks.some((h) => h.includes(normalizedQuery));
  });
}
