import type { ComponentType } from "react";
import type { Locale } from "../i18n/messages";
import { HashGeneratorWorkspace } from "../tools/hash-generator/HashGeneratorWorkspace";
import { JsonFormatterWorkspace } from "../tools/json-formatter/JsonFormatterWorkspace";
import { ScreenshotBeautifierWorkspace } from "../tools/screenshot-beautifier/ScreenshotBeautifierWorkspace";

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
  {
    id: "D03",
    category: "developer",
    name: {
      "zh-CN": "哈希校验工具",
      "en-US": "Hash Generator (SHA-256)",
    },
    summary: {
      "zh-CN":
        "计算 UTF-8 文本与任意大小本地文件的流式 SHA-256 摘要，支持实时进度、取消与期望值比对",
      "en-US":
        "Compute exact UTF-8 text and streaming local-file SHA-256 checksums with real progress, cancellation, and digest comparison",
    },
    keywords: [
      "hash",
      "sha256",
      "sha-256",
      "checksum",
      "digest",
      "shasum",
      "哈希",
      "校验和",
      "摘要",
    ],
    icon: "shield-check",
    implementationStatus: "partial",
    component: HashGeneratorWorkspace,
  },
  {
    id: "I03",
    category: "image",
    name: {
      "zh-CN": "截图美化",
      "en-US": "Beautify Screenshot",
    },
    summary: {
      "zh-CN":
        "为 PNG/JPEG 图片添加纯色背景、留白、圆角与柔和投影，按原始/1:1/16:9 导出原分辨率 PNG",
      "en-US":
        "Frame PNG/JPEG screenshots on solid backgrounds with padding, rounded corners, and soft drop shadows at full native resolution",
    },
    keywords: [
      "screenshot",
      "beautify",
      "frame",
      "mockup",
      "shadow",
      "rounded",
      "png",
      "截图",
      "美化",
      "装裱",
      "圆角",
      "阴影",
    ],
    icon: "frame",
    implementationStatus: "partial",
    component: ScreenshotBeautifierWorkspace,
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
