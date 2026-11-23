import type { ComponentType } from "react";
import type { Locale } from "../i18n/messages";
import { CaseConverterWorkspace } from "../tools/case-converter/CaseConverterWorkspace";
import { CleanLinksWorkspace } from "../tools/clean-links/CleanLinksWorkspace";
import { CodecWorkspace } from "../tools/codec/CodecWorkspace";
import { CoordinateConverterWorkspace } from "../tools/coordinate-converter/CoordinateConverterWorkspace";
import { CsvJsonWorkspace } from "../tools/csv-json/CsvJsonWorkspace";
import { DiffCheckerWorkspace } from "../tools/diff-checker/DiffCheckerWorkspace";
import { HashGeneratorWorkspace } from "../tools/hash-generator/HashGeneratorWorkspace";
import { JsonFormatterWorkspace } from "../tools/json-formatter/JsonFormatterWorkspace";
import { JwtDecoderWorkspace } from "../tools/jwt-decoder/JwtDecoderWorkspace";
import { LoremIpsumWorkspace } from "../tools/lorem-ipsum/LoremIpsumWorkspace";
import { PasswordGeneratorWorkspace } from "../tools/password-generator/PasswordGeneratorWorkspace";
import { RegexTesterWorkspace } from "../tools/regex-tester/RegexTesterWorkspace";
import { ScreenCaptureWorkspace } from "../tools/screen-capture/ScreenCaptureWorkspace";
import { ScreenshotBeautifierWorkspace } from "../tools/screenshot-beautifier/ScreenshotBeautifierWorkspace";
import { TimestampConverterWorkspace } from "../tools/timestamp-converter/TimestampConverterWorkspace";
import { UnicodeInspectorWorkspace } from "../tools/unicode-inspector/UnicodeInspectorWorkspace";
import { UuidGeneratorWorkspace } from "../tools/uuid-generator/UuidGeneratorWorkspace";
import { WordCounterWorkspace } from "../tools/word-counter/WordCounterWorkspace";

import { QrWorkspace } from "../tools/qr-code/QrWorkspace";
import { BatchRenameWorkspace } from "../tools/batch-rename/BatchRenameWorkspace";
import { FindDuplicatesWorkspace } from "../tools/find-duplicates/FindDuplicatesWorkspace";
import { ArchiveWorkspace } from "../tools/archive/ArchiveWorkspace";
import { OrganizeDownloadsWorkspace } from "../tools/organize-downloads/OrganizeDownloadsWorkspace";
import { ImageConvertWorkspace } from "../tools/image-convert/ImageConvertWorkspace";
import { ImageCompressWorkspace } from "../tools/image-compress/ImageCompressWorkspace";
import { ImageResizeWorkspace } from "../tools/image-resize/ImageResizeWorkspace";
import { ImageRotateWorkspace } from "../tools/image-rotate/ImageRotateWorkspace";
import { ImageMetadataWorkspace } from "../tools/image-metadata/ImageMetadataWorkspace";
import { ImageRedactWorkspace } from "../tools/image-redact/ImageRedactWorkspace";
import { ImageAnnotateWorkspace } from "../tools/image-annotate/ImageAnnotateWorkspace";
import { ImageWatermarkWorkspace } from "../tools/image-watermark/ImageWatermarkWorkspace";

export type ToolCategory = "developer" | "text" | "image" | "file";
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
  | "link"
  | "compass"
  | "scan-text"
  | "text-quote"
  | "lock-keyhole"
  | "table-2"
  | "file-text"
  | "case-sensitive"
  | "qr-code"
  | "file-pen-line"
  | "folder-search"
  | "file-archive"
  | "folder-input"
  | "frame"
  | "screenshot"
  | "image-convert"
  | "image-compress"
  | "image-resize"
  | "image-rotate"
  | "image-metadata"
  | "image-redact"
  | "image-annotate"
  | "image-watermark";

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
        "单遍分块流式计算 UTF-8 文本与批量本地文件 MD5、SHA-1、SHA-256、SHA-384、SHA-512 摘要，支持多文件队列、暂停继续、逐文件比对与 CSV 导出",
      "en-US":
        "Single-pass streaming MD5, SHA-1, SHA-256, SHA-384, and SHA-512 checksums for text and multi-file batches with session resume, verification, and CSV export",
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
      "batch",
      "哈希",
      "校验和",
      "摘要",
      "批量",
    ],
    icon: "shield-check",
    implementationStatus: "full",
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
    implementationStatus: "full",
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
    id: "D07",
    category: "developer",
    name: {
      "zh-CN": "文本与文件差异对比",
      "en-US": "Text & File Diff Checker",
    },
    summary: {
      "zh-CN":
        "支持并排或内联逐行差异对比、行内词/字符高亮、忽略空白与大小写、上下文折叠及精确 Unified Diff 导出",
      "en-US":
        "Compare texts or UTF-8 files side-by-side or inline with word-level highlights, context folding, and exact Unified Diff export",
    },
    keywords: [
      "diff",
      "compare",
      "patch",
      "unified",
      "merge",
      "line",
      "差异",
      "对比",
      "比较",
      "补丁",
    ],
    icon: "git-compare",
    implementationStatus: "partial",
    component: DiffCheckerWorkspace,
  },
  {
    id: "D08",
    category: "developer",
    name: {
      "zh-CN": "正则表达式测试",
      "en-US": "Regex Tester & Replacer",
    },
    summary: {
      "zh-CN":
        "基于独立 Worker 隔离与 2 秒硬终止预算的 ECMAScript 正则匹配高亮、命名捕获组与替换预览",
      "en-US":
        "Worker-isolated ECMAScript RegExp tester with 2-second preemptive timeout, live match highlights, capture groups, and replacement preview",
    },
    keywords: [
      "regex",
      "regexp",
      "regular",
      "expression",
      "match",
      "capture",
      "replace",
      "ecmascript",
      "正则",
      "匹配",
      "捕获组",
      "替换",
    ],
    icon: "regex",
    implementationStatus: "partial",
    component: RegexTesterWorkspace,
  },
  {
    id: "D09",
    category: "developer",
    name: {
      "zh-CN": "链接跟踪参数清理",
      "en-US": "Clean Links & Unwrap Redirects",
    },
    summary: {
      "zh-CN":
        "离线剥离 utm_*、fbclid、gclid 与站点专属跟踪参数，解包 Google / Facebook / Outlook 等跳转包装并原样保留其余查询编码",
      "en-US":
        "Strip utm_*, fbclid, gclid, and site-specific trackers and unwrap Google, Facebook, and Outlook redirects offline while preserving raw query encoding",
    },
    keywords: [
      "url",
      "link",
      "clean",
      "utm",
      "fbclid",
      "gclid",
      "msclkid",
      "tracking",
      "unwrap",
      "redirect",
      "safelinks",
      "链接",
      "去跟踪",
      "净化",
      "短链",
      "重定向",
    ],
    icon: "link",
    implementationStatus: "partial",
    component: CleanLinksWorkspace,
  },
  {
    id: "D10",
    category: "developer",
    name: {
      "zh-CN": "坐标转换与测距",
      "en-US": "Coordinate Converter & Distance",
    },
    summary: {
      "zh-CN":
        "离线转换二维 WGS 84 坐标（DD / DMS / DM / GeoJSON / WKT / geo: / 地图坐标链接）、计算椭球测地线距离并支持有限批量导出",
      "en-US":
        "Offline 2D WGS 84 coordinate converter across 8 formats, ellipsoid geodesic distance calculator, and bounded batch CSV exporter",
    },
    keywords: [
      "coordinate",
      "picker",
      "coordinate picker",
      "latitude",
      "longitude",
      "lat",
      "lon",
      "wgs84",
      "dms",
      "geojson",
      "wkt",
      "geo",
      "geodesic",
      "distance",
      "map",
      "maps",
      "坐标",
      "经纬度",
      "地图",
      "地图坐标",
      "坐标拾取",
      "度分秒",
      "测距",
    ],
    icon: "compass",
    implementationStatus: "partial",
    component: CoordinateConverterWorkspace,
  },
  {
    id: "D11",
    category: "developer",
    name: {
      "zh-CN": "Unicode 隐形与混淆字符检查",
      "en-US": "Unicode Inspector & Sanitizer",
    },
    summary: {
      "zh-CN":
        "离线逐码点解析 Unicode 16.0 官方名称、字素簇、UTF-8 字节及零宽/双向控制/UTS #39 相似字形，支持安全预览清理",
      "en-US":
        "Offline Unicode 16.0 code-point, grapheme, and UTF-8 byte inspector with zero-width, Bidi, UTS #39 confusable detection, and previewable cleanup",
    },
    keywords: [
      "unicode",
      "utf8",
      "utf16",
      "codepoint",
      "grapheme",
      "zero-width",
      "zwsp",
      "zwj",
      "zwnj",
      "bom",
      "bidi",
      "confusable",
      "homoglyph",
      "隐形字符",
      "零宽",
      "混淆",
      "码点",
    ],
    icon: "scan-text",
    implementationStatus: "partial",
    component: UnicodeInspectorWorkspace,
  },
  {
    id: "D12",
    category: "developer",
    name: {
      "zh-CN": "Lorem Ipsum 占位文本生成",
      "en-US": "Lorem Ipsum Generator",
    },
    summary: {
      "zh-CN":
        "按词、句、段离线生成纯文本、HTML <p> 段落或 Markdown 占位文本，支持经典开头与一键重新生成",
      "en-US":
        "Generate offline placeholder text by words, sentences, or paragraphs as plain text, HTML <p> tags, or Markdown",
    },
    keywords: [
      "lorem",
      "ipsum",
      "placeholder",
      "dummy",
      "latin",
      "paragraph",
      "mockup",
      "html",
      "markdown",
      "占位文本",
      "假文",
      "排版",
    ],
    icon: "text-quote",
    implementationStatus: "full",
    component: LoremIpsumWorkspace,
  },
  {
    id: "D13",
    category: "developer",
    name: {
      "zh-CN": "随机密码与口令短语生成",
      "en-US": "Password & Passphrase Generator",
    },
    summary: {
      "zh-CN":
        "使用操作系统密码学安全随机源无偏抽样生成随机密码与英文口令短语，支持排除易混字符与按生成模型估算的熵/强度展示",
      "en-US":
        "Generate random passwords and English passphrases via OS CSPRNG with look-alike exclusion and model-estimated entropy & strength",
    },
    keywords: [
      "password",
      "passphrase",
      "random",
      "csprng",
      "entropy",
      "secret",
      "diceware",
      "eff",
      "密码",
      "口令",
      "口令短语",
      "随机密码",
      "强度",
    ],
    icon: "lock-keyhole",
    implementationStatus: "full",
    component: PasswordGeneratorWorkspace,
  },
  {
    id: "D14",
    category: "developer",
    name: {
      "zh-CN": "CSV ↔ JSON 与 Markdown 表格转换",
      "en-US": "CSV ↔ JSON & Markdown Table Converter",
    },
    summary: {
      "zh-CN":
        "支持引号转义、字段内换行、自动/手动分隔符、大整数与前导零保真、嵌套对象路径展开及可选电子表格公式保护的 CSV ↔ JSON 互转及 Markdown 表格导出",
      "en-US":
        "Bidirectional CSV ↔ JSON conversion and Markdown table export with RFC 4180 quoting, lossless numbers, nested-path flattening, and formula protection",
    },
    keywords: [
      "csv",
      "json",
      "markdown",
      "table",
      "convert",
      "delimiter",
      "comma",
      "semicolon",
      "tab",
      "flatten",
      "表格",
      "转换",
      "逗号",
      "分隔符",
    ],
    icon: "table-2",
    implementationStatus: "full",
    component: CsvJsonWorkspace,
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
    id: "I01",
    category: "image",
    name: {
      "zh-CN": "屏幕截图与长截图",
      "en-US": "Screenshot & Scrolling Capture",
    },
    summary: {
      "zh-CN":
        "原生捕获区域、指定窗口（含被遮挡窗口）、指定显示器与自动滚动拼接长截图，自动排除自身浮层，支持剪贴板与无损直传编辑",
      "en-US":
        "Capture a region, specific window (including occluded windows), display, or auto-stitched scrolling page with native clipboard and zero-disk editor handoff",
    },
    keywords: [
      "screenshot",
      "capture",
      "scrolling",
      "long screenshot",
      "window",
      "monitor",
      "region",
      "snip",
      "截图",
      "长截图",
      "滚动截图",
      "区域截图",
      "窗口截图",
      "抓图",
    ],
    icon: "screenshot",
    implementationStatus: "full",
    component: ScreenCaptureWorkspace,
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
        "支持纯色、渐变与自选背景图，留白、圆角与柔和阴影，原始/1:1/16:9/4:5/9:16 比例及同配置批量套用导出高清 PNG",
      "en-US":
        "Frame screenshots with solid, gradient, or custom background images, padding, rounded corners, shadows, 5 aspect presets, and batch apply",
    },
    keywords: [
      "screenshot",
      "beautify",
      "frame",
      "mockup",
      "shadow",
      "rounded",
      "gradient",
      "4:5",
      "9:16",
      "png",
      "截图",
      "美化",
      "装裱",
      "圆角",
      "阴影",
      "渐变",
      "批量美化",
    ],
    icon: "frame",
    implementationStatus: "full",
    component: ScreenshotBeautifierWorkspace,
  },
  {
    id: "I05",
    category: "image",
    name: { "zh-CN": "图片格式转换", "en-US": "Convert Images" },
    summary: {
      "zh-CN":
        "批量转换 JPEG、PNG、WebP、TIFF、BMP 与 Windows WIC HEIC（含手机 HEIC 转 JPG），支持质量设置与透明图背景色实时预览",
      "en-US":
        "Batch convert JPEG, PNG, WebP, TIFF, BMP, and Windows WIC HEIC (including phone HEIC to JPG) with quality controls and live transparency background preview",
    },
    keywords: [
      "convert",
      "image",
      "heic",
      "heif",
      "jpg",
      "jpeg",
      "png",
      "webp",
      "tiff",
      "bmp",
      "format",
      "图片转换",
      "格式转换",
      "透明背景",
      "转jpg",
    ],
    icon: "image-convert",
    implementationStatus: "full",
    component: ImageConvertWorkspace,
  },
  {
    id: "I06",
    category: "image",
    name: { "zh-CN": "图片压缩", "en-US": "Compress Images" },
    summary: {
      "zh-CN":
        "低中高三档本地批量压缩 JPEG、PNG、WebP，支持实时前后细节对比、PNG 无损/有损区分及未节省空间保留原件",
      "en-US":
        "Batch compress JPEG, PNG, and WebP locally across Low/Medium/High presets with live before/after detail comparison, lossless vs lossy PNG modes, and no-bloat original preservation",
    },
    keywords: [
      "compress",
      "optimize",
      "shrink",
      "jpeg",
      "png",
      "webp",
      "oxipng",
      "lossless",
      "图片压缩",
      "无损优化",
      "体积压缩",
      "前后对比",
    ],
    icon: "image-compress",
    implementationStatus: "full",
    component: ImageCompressWorkspace,
  },
  {
    id: "I07",
    category: "image",
    name: { "zh-CN": "图片批量缩放", "en-US": "Resize Images" },
    summary: {
      "zh-CN":
        "按百分比、最长边或指定宽高批量缩放图片，默认保持比例并禁止放大，按 EXIF 实际显示方向实时预览最终像素尺寸",
      "en-US":
        "Batch resize by percentage, longest edge, or exact dimensions with aspect-ratio lock, no-upscale default, and EXIF display-orientation sizing preview",
    },
    keywords: [
      "resize",
      "scale",
      "dimensions",
      "percentage",
      "longest edge",
      "aspect ratio",
      "thumbnail",
      "图片缩放",
      "批量缩放",
      "调整尺寸",
      "最长边",
      "像素",
    ],
    icon: "image-resize",
    implementationStatus: "full",
    component: ImageResizeWorkspace,
  },
  {
    id: "I08",
    category: "image",
    name: { "zh-CN": "图片旋转与翻转", "en-US": "Rotate Images" },
    summary: {
      "zh-CN":
        "支持 90° 左右旋转、180° 旋转、水平与垂直翻转及按序组合重置，烘焙 EXIF 方向确保预览、导出与 Windows 照片一致",
      "en-US":
        "Batch rotate 90°/180° and flip horizontally or vertically in exact order, baking EXIF orientation upright so Windows Photos never double-rotates",
    },
    keywords: [
      "rotate",
      "flip",
      "mirror",
      "orientation",
      "exif",
      "90",
      "180",
      "图片旋转",
      "翻转",
      "镜像",
      "方向",
    ],
    icon: "image-rotate",
    implementationStatus: "full",
    component: ImageRotateWorkspace,
  },
  {
    id: "I09",
    category: "image",
    name: { "zh-CN": "图片元数据清除", "en-US": "Remove Metadata" },
    summary: {
      "zh-CN":
        "容器级无损清除 JPEG、PNG、WebP 与经典 TIFF 中的 GPS、相机、时间、EXIF、XMP、IPTC 与重复段，默认保留方向与色彩配置并二次校验",
      "en-US":
        "Losslessly strip GPS, camera, timestamp, EXIF, XMP, IPTC, and duplicate segments across JPEG, PNG, WebP, and classic TIFF while keeping orientation and ICC profiles by default",
    },
    keywords: [
      "metadata",
      "exif",
      "gps",
      "xmp",
      "iptc",
      "strip",
      "remove",
      "privacy",
      "icc",
      "元数据",
      "隐私",
      "定位",
      "清除exif",
      "去exif",
    ],
    icon: "image-metadata",
    implementationStatus: "full",
    component: ImageMetadataWorkspace,
  },
  {
    id: "I11",
    category: "image",
    name: { "zh-CN": "图片局部打码", "en-US": "Redact Image" },
    summary: {
      "zh-CN":
        "多区域模糊、像素化与不透明实色遮盖，导出或交接时将遮盖不可逆烘焙为平坦像素并可选复用 I09 清理隐私元数据",
      "en-US":
        "Multi-region blur, pixelate, and opaque solid cover that bakes redactions destructively into flat pixels with optional I09 privacy metadata stripping",
    },
    keywords: [
      "redact",
      "blur",
      "pixelate",
      "mosaic",
      "censor",
      "hide",
      "privacy",
      "mask",
      "打码",
      "马赛克",
      "遮盖",
      "模糊",
      "隐私",
      "涂抹",
    ],
    icon: "image-redact",
    implementationStatus: "partial",
    component: ImageRedactWorkspace,
  },
  {
    id: "I12",
    category: "image",
    name: { "zh-CN": "截图批注", "en-US": "Annotate Screenshot" },
    summary: {
      "zh-CN":
        "提供箭头、直线、矩形、椭圆、中文文字、高亮、连续编号、画笔、局部模糊与裁剪，锁定原图像素并以原分辨率复制或导出",
      "en-US":
        "Annotate screenshots with arrows, lines, shapes, Chinese/English text, highlights, numbered steps, brush, local blur, and pixel-exact crop at full resolution",
    },
    keywords: [
      "annotate",
      "markup",
      "arrow",
      "callout",
      "highlight",
      "crop",
      "draw",
      "text",
      "number",
      "批注",
      "标注",
      "箭头",
      "编号",
      "高亮",
      "裁剪",
      "截图编辑",
    ],
    icon: "image-annotate",
    implementationStatus: "full",
    component: ImageAnnotateWorkspace,
  },
  {
    id: "I13",
    category: "image",
    name: { "zh-CN": "图片水印", "en-US": "Image Watermark" },
    summary: {
      "zh-CN":
        "为单张或批量图片添加中英文文字水印与透明 PNG Logo，支持九宫格角落定位、边距、大小、不透明度与斜向平铺并输出新副本",
      "en-US":
        "Add Chinese/English text or transparent PNG logo watermarks to single or batch images with 9-point placement, margins, scale, opacity, and diagonal tiling",
    },
    keywords: [
      "watermark",
      "logo",
      "text watermark",
      "tile",
      "diagonal",
      "brand",
      "copyright",
      "stamp",
      "水印",
      "图片水印",
      "平铺",
      "版权",
      "徽标",
    ],
    icon: "image-watermark",
    implementationStatus: "partial",
    component: ImageWatermarkWorkspace,
  },
  {
    id: "F01",
    category: "file",
    name: { "zh-CN": "二维码生成与识别", "en-US": "QR Code Generator & Reader" },
    summary: {
      "zh-CN": "为链接、文本或 Wi-Fi 生成二维码，从本地图片读取二维码和条形码。",
      "en-US":
        "Create QR codes for links, text or Wi-Fi, and read QR codes and barcodes from local images.",
    },
    keywords: [
      "qr",
      "qrcode",
      "barcode",
      "code 128",
      "ean-13",
      "wi-fi",
      "wifi",
      "二维码",
      "条形码",
      "条码",
      "扫描",
      "识别",
    ],
    icon: "qr-code",
    implementationStatus: "full",
    component: QrWorkspace,
  },
  {
    id: "F02",
    category: "file",
    name: { "zh-CN": "批量重命名", "en-US": "Batch Rename" },
    summary: {
      "zh-CN":
        "支持查找替换、正则捕获组、前后缀、序号日期与大小写规则，执行前全量预览冲突并支持一键撤销最近批次",
      "en-US":
        "Batch rename files with find/replace, regex captures, prefix/suffix, numbering, dates, or case changes with full conflict preview and undo",
    },
    keywords: [
      "rename",
      "batch rename",
      "bulk rename",
      "prefix",
      "suffix",
      "numbering",
      "sequence",
      "filename",
      "undo",
      "批量重命名",
      "重命名",
      "改名",
      "前后缀",
      "序号",
      "撤销",
    ],
    icon: "file-pen-line",
    implementationStatus: "full",
    component: BatchRenameWorkspace,
  },
  {
    id: "F03",
    category: "file",
    name: { "zh-CN": "重复文件查找", "en-US": "Find Duplicates" },
    summary: {
      "zh-CN":
        "跨多个文件夹按大小、首尾 64 KiB 与整文件 SHA-256 三级流式查找相同文件，强制每组至少保留一份并仅移入 Windows 回收站",
      "en-US":
        "Scan multiple folders recursively via size, head/tail 64 KiB, and streaming SHA-256, keeping at least one copy per group and moving extras to the Windows Recycle Bin",
    },
    keywords: [
      "duplicate",
      "duplicates",
      "dedup",
      "deduplicate",
      "find duplicates",
      "recycle bin",
      "trash",
      "same file",
      "重复文件",
      "去重",
      "查重",
      "回收站",
      "释放空间",
    ],
    icon: "folder-search",
    implementationStatus: "full",
    component: FindDuplicatesWorkspace,
  },
  {
    id: "F04",
    category: "file",
    name: { "zh-CN": "压缩与解压", "en-US": "Zip & Unzip" },
    summary: {
      "zh-CN":
        "离线预览与批量解压 ZIP、7z、RAR、TAR/TGZ/TXZ/TBZ2、单文件 GZ/XZ/BZ2 与 ISO，并支持创建标准/AES-256 加密 ZIP 及 TAR.GZ",
      "en-US":
        "Offline preview and isolated batch extraction for ZIP, 7z, RAR, TAR/GZ/XZ/BZ2, single-stream GZ/XZ/BZ2, and ISO, plus ZIP (standard/AES-256/ZipCrypto) and TAR.GZ creation",
    },
    keywords: [
      "zip",
      "unzip",
      "archive",
      "extract",
      "compress",
      "7z",
      "rar",
      "tar",
      "targz",
      "iso",
      "aes",
      "压缩",
      "解压",
      "归档",
      "压缩包",
    ],
    icon: "file-archive",
    implementationStatus: "full",
    component: ArchiveWorkspace,
  },
  {
    id: "F05",
    category: "file",
    name: { "zh-CN": "下载图片按来源归档", "en-US": "Organize Downloads" },
    summary: {
      "zh-CN":
        "针对手动选择的本地图片目录读取 NTFS Zone.Identifier 下载来源域名，支持可编辑 CDN 站点映射、防覆盖同卷移动并原样保留安全流",
      "en-US":
        "Inspect NTFS Zone.Identifier source domains in a user-selected image folder, map CDNs to friendly site folders, and move without overwriting while preserving ZoneId",
    },
    keywords: [
      "organize",
      "downloads",
      "zone.identifier",
      "ads",
      "domain",
      "source",
      "images",
      "archive",
      "下载图片",
      "按来源归档",
      "来源归档",
      "归档",
      "图床",
    ],
    icon: "folder-input",
    implementationStatus: "full",
    component: OrganizeDownloadsWorkspace,
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
