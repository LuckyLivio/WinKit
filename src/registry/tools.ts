import type { ComponentType } from "react";
import type { Locale } from "../i18n/messages";
import { CaseConverterWorkspace } from "../tools/case-converter/CaseConverterWorkspace";
import { CodecWorkspace } from "../tools/codec/CodecWorkspace";
import { HashGeneratorWorkspace } from "../tools/hash-generator/HashGeneratorWorkspace";
import { JsonFormatterWorkspace } from "../tools/json-formatter/JsonFormatterWorkspace";
import { JwtDecoderWorkspace } from "../tools/jwt-decoder/JwtDecoderWorkspace";
import { ScreenshotBeautifierWorkspace } from "../tools/screenshot-beautifier/ScreenshotBeautifierWorkspace";
import { TimestampConverterWorkspace } from "../tools/timestamp-converter/TimestampConverterWorkspace";
import { UuidGeneratorWorkspace } from "../tools/uuid-generator/UuidGeneratorWorkspace";
import { WordCounterWorkspace } from "../tools/word-counter/WordCounterWorkspace";

export type ToolCategory = "developer" | "text" | "image";
export type ToolImplementationStatus = "full" | "partial";
export type ToolIconName =
  | "braces"
  | "binary"
  | "shield-check"
  | "fingerprint"
  | "key-round"
  | "clock"
  | "git-compare"
  | "regex"
  | "scan-text"
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
    id: "D04",
    category: "developer",
    name: {
      "zh-CN": "UUID 生成与解析",
      "en-US": "UUID v4 / v7 Generator & Inspector",
    },
    summary: {
      "zh-CN":
        "基于密码学安全随机源批量生成 RFC 9562 UUID v4 与毫秒时间序 v7，支持大小写/连字符切换及版本、变体与 v7 时间解析",
      "en-US":
        "Generate RFC 9562 UUID v4 and time-ordered v7 batches via OS CSPRNG and inspect UUID version, variant, and v7 timestamps",
    },
    keywords: ["uuid", "guid", "v4", "v7", "rfc9562", "random", "identifier", "唯一标识符", "解析"],
    icon: "fingerprint",
    implementationStatus: "full",
    component: UuidGeneratorWorkspace,
  },
  {
    id: "D05",
    category: "developer",
    name: {
      "zh-CN": "JWT 本地解码与验签",
      "en-US": "JWT Decoder & HMAC Verifier",
    },
    summary: {
      "zh-CN":
        "离线解析 JWS/JWT 头部、载荷（大整数无损保真）与时间声明，支持原始片段 HS256 / HS384 / HS512 本地密钥验签",
      "en-US":
        "Offline JWS/JWT header, lossless claims, and NumericDate inspector with local HS256, HS384, and HS512 HMAC verification",
    },
    keywords: [
      "jwt",
      "jws",
      "jwe",
      "token",
      "bearer",
      "hmac",
      "hs256",
      "hs384",
      "hs512",
      "claims",
      "令牌",
      "解码",
      "验签",
    ],
    icon: "key-round",
    implementationStatus: "partial",
    component: JwtDecoderWorkspace,
  },
  {
    id: "D06",
    category: "developer",
    name: {
      "zh-CN": "Unix 时间戳转换",
      "en-US": "Unix Timestamp Converter",
    },
    summary: {
      "zh-CN":
        "基于 BigInt 精确整数运算转换秒/毫秒/微秒/纳秒与多时区 ISO 8601 日期，严格校验闰日并拦截夏令时缺失/歧义时刻",
      "en-US":
        "Lossless BigInt conversion across s/ms/µs/ns and UTC/local/IANA timezones with strict calendar and DST boundary validation",
    },
    keywords: [
      "timestamp",
      "epoch",
      "unix",
      "iso8601",
      "timezone",
      "iana",
      "utc",
      "nanosecond",
      "时间戳",
      "时区",
      "毫秒",
      "纳秒",
    ],
    icon: "clock",
    implementationStatus: "partial",
    component: TimestampConverterWorkspace,
  },
  {
    id: "T08",
    category: "text",
    name: {
      "zh-CN": "字数与阅读统计",
      "en-US": "Word & Reading Counter",
    },
    summary: {
      "zh-CN":
        "按 Unicode 字素簇与 Intl.Segmenter 统计中英文词数、字符、句段、行数、UTF-8 字节、预计阅读时长与高频词",
      "en-US":
        "Count Unicode grapheme characters, CJK/Latin words, sentences, paragraphs, lines, UTF-8 bytes, reading time, and top words",
    },
    keywords: [
      "word",
      "count",
      "character",
      "grapheme",
      "utf8",
      "bytes",
      "reading",
      "paragraph",
      "字数",
      "字符",
      "统计",
      "阅读时长",
    ],
    icon: "file-text",
    implementationStatus: "full",
    component: WordCounterWorkspace,
  },
  {
    id: "T09",
    category: "text",
    name: {
      "zh-CN": "大小写与命名转换",
      "en-US": "Case & Naming Converter",
    },
    summary: {
      "zh-CN":
        "支持 UPPER、lower、Title、Sentence、camel、Pascal、snake、CONSTANT、kebab、dot、交替与反转共 12 种样式按行转换",
      "en-US":
        "Convert text and identifier lists line by line across 12 styles including camelCase, snake_case, kebab-case, and Title Case",
    },
    keywords: [
      "case",
      "camel",
      "snake",
      "kebab",
      "pascal",
      "constant",
      "title",
      "uppercase",
      "lowercase",
      "大小写",
      "驼峰",
      "下划线",
      "命名",
    ],
    icon: "case-sensitive",
    implementationStatus: "full",
    component: CaseConverterWorkspace,
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
