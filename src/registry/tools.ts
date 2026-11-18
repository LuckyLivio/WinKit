import type { ComponentType } from "react";
import type { Locale } from "../i18n/messages";
import { CodecWorkspace } from "../tools/codec/CodecWorkspace";
import { HashGeneratorWorkspace } from "../tools/hash-generator/HashGeneratorWorkspace";
import { JsonFormatterWorkspace } from "../tools/json-formatter/JsonFormatterWorkspace";
import { ScreenshotBeautifierWorkspace } from "../tools/screenshot-beautifier/ScreenshotBeautifierWorkspace";

export type ToolCategory = "developer" | "text" | "image";
export type ToolImplementationStatus = "full" | "partial";
export type ToolIconName =
  | "braces"
  | "binary"
  | "shield-check"
  | "fingerprint"
  | "clock"
  | "file-text"
  | "case-sensitive"
  | "frame";

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
    id: "D02",
    category: "developer",
    name: {
      "zh-CN": "Base64 / Hex / 二进制编解码",
      "en-US": "Base64, Hex & Binary Codec",
    },
    summary: {
      "zh-CN":
        "支持 UTF-8 文本与本地原始字节小文件的标准/URL-safe Base64、十六进制与 8 位二进制编码解码、偏移报错与无损另存",
      "en-US":
        "Encode and decode UTF-8 text or bounded raw-byte files across Standard/URL-safe Base64, Hex, and 8-bit Binary",
    },
    keywords: [
      "base64",
      "base64url",
      "hex",
      "hexadecimal",
      "binary",
      "encode",
      "decode",
      "rfc4648",
      "编码",
      "解码",
      "十六进制",
      "二进制",
    ],
    icon: "binary",
    implementationStatus: "partial",
    component: CodecWorkspace,
  },
  {
    id: "D03",
    category: "developer",
    name: {
      "zh-CN": "哈希校验工具",
      "en-US": "Hash Generator (MD5 / SHA)",
    },
    summary: {
      "zh-CN":
        "单遍分块流式计算 UTF-8 文本与本地文件 MD5、SHA-1、SHA-256、SHA-384、SHA-512 摘要，支持真实进度、取消与期望值比对",
      "en-US":
        "Single-pass streaming MD5, SHA-1, SHA-256, SHA-384, and SHA-512 checksums for text and local files with progress and verification",
    },
    keywords: [
      "hash",
      "md5",
      "sha1",
      "sha-1",
      "sha256",
      "sha-256",
      "sha384",
      "sha512",
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
