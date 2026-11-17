import type { ComponentType } from "react";
import type { Locale } from "../i18n/messages";

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
export const REGISTERED_TOOLS: RegisteredTool[] = [];

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
