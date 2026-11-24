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
import { BlurFacesWorkspace } from "../tools/blur-faces/BlurFacesWorkspace";
import { ColorPickerWorkspace } from "../tools/color-picker/ColorPickerWorkspace";
import { MediaInfoWorkspace } from "../tools/media-info/MediaInfoWorkspace";
import { VideoTrimWorkspace } from "../tools/video-trim/VideoTrimWorkspace";
import { VideoMuteWorkspace } from "../tools/video-mute/VideoMuteWorkspace";
import { AudioExtractWorkspace } from "../tools/audio-extract/AudioExtractWorkspace";
import { VideoFramesWorkspace } from "../tools/video-frames/VideoFramesWorkspace";
import { VideoGifWorkspace } from "../tools/video-gif/VideoGifWorkspace";
import { VideoConvertWorkspace } from "../tools/video-convert/VideoConvertWorkspace";
import { VideoCompressWorkspace } from "../tools/video-compress/VideoCompressWorkspace";
import { VideoResizeWorkspace } from "../tools/video-resize/VideoResizeWorkspace";
import { VideoCropWorkspace } from "../tools/video-crop/VideoCropWorkspace";
import { VideoSpeedWorkspace } from "../tools/video-speed/VideoSpeedWorkspace";
import { VideoMergeWorkspace } from "../tools/video-merge/VideoMergeWorkspace";
import { AudioTrimWorkspace } from "../tools/audio-trim/AudioTrimWorkspace";
import { AudioRecorderWorkspace } from "../tools/audio-recorder/AudioRecorderWorkspace";
import { AudioConvertWorkspace } from "../tools/audio-convert/AudioConvertWorkspace";
import { AudioCleanupWorkspace } from "../tools/audio-cleanup/AudioCleanupWorkspace";
import { VideoReplaceAudioWorkspace } from "../tools/video-replace-audio/VideoReplaceAudioWorkspace";
import { VideoSubtitlesWorkspace } from "../tools/video-subtitles/VideoSubtitlesWorkspace";
import { ScreenRecorderWorkspace } from "../tools/screen-recorder/ScreenRecorderWorkspace";
import { VideoDownloadWorkspace } from "../tools/video-download/VideoDownloadWorkspace";
import { PdfMergeWorkspace } from "../tools/pdf-merge/PdfMergeWorkspace";
import { PdfSplitWorkspace } from "../tools/pdf-split/PdfSplitWorkspace";
import { PdfOrganizeWorkspace } from "../tools/pdf-organize/PdfOrganizeWorkspace";
import { PdfDeleteWorkspace } from "../tools/pdf-delete/PdfDeleteWorkspace";
import { PdfExtractWorkspace } from "../tools/pdf-extract/PdfExtractWorkspace";
import { ImagesToPdfWorkspace } from "../tools/pdf-images-to-pdf/ImagesToPdfWorkspace";
import { PdfToImagesWorkspace } from "../tools/pdf-to-images/PdfToImagesWorkspace";
import { PdfSignWorkspace } from "../tools/pdf-sign/PdfSignWorkspace";
import { PdfCropWorkspace } from "../tools/pdf-crop/PdfCropWorkspace";
import { PdfEncryptWorkspace } from "../tools/pdf-encrypt/PdfEncryptWorkspace";
import { PdfDecryptWorkspace } from "../tools/pdf-decrypt/PdfDecryptWorkspace";
import { PdfCompressWorkspace } from "../tools/pdf-compress/PdfCompressWorkspace";
import { PdfMarkdownWorkspace } from "../tools/pdf-markdown/PdfMarkdownWorkspace";
import { ExtractTextWorkspace } from "../tools/extract-text/ExtractTextWorkspace";
import { CaptureTextWorkspace } from "../tools/capture-text/CaptureTextWorkspace";

export type ToolCategory = "pdf" | "video" | "audio" | "developer" | "text" | "image" | "file";
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
  | "capture-text"
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
  | "blur-faces"
  | "image-convert"
  | "image-compress"
  | "image-resize"
  | "image-rotate"
  | "image-metadata"
  | "color-picker"
  | "image-redact"
  | "image-annotate"
  | "image-watermark"
  | "media-info"
  | "video-trim"
  | "video-mute"
  | "audio-extract"
  | "video-frames"
  | "video-gif"
  | "video-convert"
  | "video-compress"
  | "video-resize"
  | "video-crop"
  | "video-speed"
  | "video-merge"
  | "audio-trim"
  | "audio-record"
  | "audio-convert"
  | "audio-cleanup"
  | "video-replace-audio"
  | "video-subtitles"
  | "screen-record"
  | "video-download"
  | "pdf-merge"
  | "pdf-split"
  | "pdf-organize"
  | "pdf-delete"
  | "pdf-extract"
  | "pdf-images-to-pdf"
  | "pdf-to-images"
  | "pdf-sign"
  | "pdf-crop"
  | "pdf-encrypt"
  | "pdf-decrypt"
  | "pdf-compress"
  | "pdf-markdown";

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
    id: "T03",
    category: "text",
    name: {
      "zh-CN": "图片与扫描件文字提取",
      "en-US": "Extract Text (OCR)",
    },
    summary: {
      "zh-CN":
        "基于本地离线 RapidOCR（PP-OCRv4）从截图、照片与扫描版 PDF 批量提取中英文文字与精确位置坐标",
      "en-US":
        "Extract bilingual text and bounding-box coordinates offline from screenshots, photos, and scanned PDFs via local RapidOCR (PP-OCRv4)",
    },
    keywords: [
      "ocr",
      "extract text",
      "text recognition",
      "scan",
      "scanned pdf",
      "screenshot",
      "rapidocr",
      "文字识别",
      "识图",
      "图片提字",
      "扫描件",
      "提取文字",
    ],
    icon: "scan-text",
    implementationStatus: "full",
    component: ExtractTextWorkspace,
  },
  {
    id: "T04",
    category: "text",
    name: {
      "zh-CN": "屏幕区域取字",
      "en-US": "Capture Text",
    },
    summary: {
      "zh-CN":
        "多屏与混合 DPI 屏幕框选后直接在内存中调用离线 RapidOCR 提取中英文文本，支持预览框、Esc/任务取消与一键复制",
      "en-US":
        "Select any area across multi-monitor and mixed-DPI screens, extract text offline in memory via RapidOCR, preview boxes, and copy with one click",
    },
    keywords: [
      "capture text",
      "screen ocr",
      "ocr",
      "snip text",
      "copy text from screen",
      "region ocr",
      "屏幕取字",
      "屏幕区域取字",
      "框选取字",
      "截图识字",
      "屏幕识字",
    ],
    icon: "capture-text",
    implementationStatus: "full",
    component: CaptureTextWorkspace,
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
    id: "I02",
    category: "image",
    name: {
      "zh-CN": "人脸自动打码",
      "en-US": "Blur Faces",
    },
    summary: {
      "zh-CN":
        "离线本地 CPU 自动识别单张合影与批量照片中的人脸，支持逐脸取消、手动补框、移动调大小、模糊/像素化/实色遮盖与安全副本批量导出",
      "en-US":
        "Offline CPU face detection for single group photos or batches with editable boxes, per-face toggle, manual add, blur/pixelate/solid redaction, before/after compare, and safe batch export",
    },
    keywords: [
      "face",
      "blur",
      "blur faces",
      "mosaic",
      "pixelate",
      "privacy",
      "redact",
      "portrait",
      "group photo",
      "yunet",
      "人脸",
      "打码",
      "自动打码",
      "马赛克",
      "模糊",
      "遮脸",
      "合影",
      "隐私",
    ],
    icon: "blur-faces",
    implementationStatus: "full",
    component: BlurFacesWorkspace,
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
    id: "I10",
    category: "image",
    name: {
      "zh-CN": "屏幕取色与对比度",
      "en-US": "Color Picker & Contrast",
    },
    summary: {
      "zh-CN":
        "Windows 原生放大镜屏幕取色（方向键 1px 微调），支持 HEX/RGB/HSL/OKLCH/CSS/WinUI XAML/C#/Tailwind 复制、图片色板提取与 WCAG 2.x 对比度校验",
      "en-US":
        "Windows native magnifier screen color picker (1px arrow-key nudge), HEX/RGB/HSL/OKLCH/CSS/WinUI XAML/C#/Tailwind copy, image palette extraction, and WCAG 2.x contrast checker",
    },
    keywords: [
      "color",
      "picker",
      "eyedropper",
      "palette",
      "contrast",
      "wcag",
      "oklch",
      "hsl",
      "rgb",
      "hex",
      "xaml",
      "winui",
      "tailwind",
      "取色",
      "屏幕取色",
      "吸管",
      "颜色",
      "色板",
      "调色板",
      "对比度",
    ],
    icon: "color-picker",
    implementationStatus: "partial",
    component: ColorPickerWorkspace,
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
    name: { "zh-CN": "图片 / PDF / 视频水印", "en-US": "Watermark (Images, PDF & Video)" },
    summary: {
      "zh-CN":
        "为单张/批量图片、本地 PDF 文档及横竖屏或 90° 旋转视频添加中英文文字水印与透明 PNG Logo，支持九宫格定位、旋转、不透明度与斜向平铺，输出新副本并保留原文字/矢量/音频",
      "en-US":
        "Add Chinese/English text or transparent PNG logo watermarks to images (single/batch), PDFs (preserving selectable text & vectors), and videos with 9-point placement, rotation, opacity, and diagonal tiling",
    },
    keywords: [
      "watermark",
      "video watermark",
      "pdf watermark",
      "logo",
      "text watermark",
      "tile",
      "diagonal",
      "brand",
      "copyright",
      "stamp",
      "水印",
      "图片水印",
      "视频水印",
      "pdf水印",
      "文档水印",
      "平铺",
      "版权",
      "徽标",
    ],
    icon: "image-watermark",
    implementationStatus: "full",
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
  {
    id: "V01",
    category: "video",
    name: { "zh-CN": "视频下载", "en-US": "Video Downloader" },
    summary: {
      "zh-CN":
        "粘贴一条或多条 HTTP(S) 链接解析标题、清晰度与音轨语言，支持最佳/1080p/720p/仅音频 M4A、优先 H.264、队列取消重试、直链独立下载与受管 yt-dlp",
      "en-US":
        "Inspect and queue one or more HTTP(S) video or direct media links with resolution caps, H.264 preference, audio language selection, M4A export, cancel/retry, and verified yt-dlp",
    },
    keywords: [
      "video download",
      "downloader",
      "yt-dlp",
      "ytdlp",
      "hls",
      "dash",
      "m3u8",
      "mp4",
      "m4a",
      "h264",
      "url",
      "视频下载",
      "下载视频",
      "网页视频",
      "直链下载",
      "音频提取",
    ],
    icon: "video-download",
    implementationStatus: "full",
    component: VideoDownloadWorkspace,
  },
  {
    id: "V02",
    category: "video",
    name: { "zh-CN": "视频烧录字幕", "en-US": "Burn In Subtitles" },
    summary: {
      "zh-CN":
        "离线导入 SRT / WebVTT 字幕文件，点击任意时间轴字幕即刻预览烧录帧，调整字号、顶部/底部位置及描边或半透明黑底框后永久烧录至视频像素（支持中文）",
      "en-US":
        "Import SRT or WebVTT subtitles offline, click any cue to preview burned-in frames with CJK fonts, customize size/position/outline or black box, and permanently burn into video pixels",
    },
    keywords: [
      "subtitle",
      "subtitles",
      "captions",
      "burn in",
      "hardsub",
      "srt",
      "vtt",
      "webvtt",
      "video",
      "字幕",
      "烧录字幕",
      "硬字幕",
      "加字幕",
    ],
    icon: "video-subtitles",
    implementationStatus: "partial",
    component: VideoSubtitlesWorkspace,
  },
  {
    id: "V03",
    category: "video",
    name: { "zh-CN": "视频变速", "en-US": "Change Speed" },
    summary: {
      "zh-CN":
        "支持 0.25× 至 4× 单文件与批量变速，提供常用预设与预计时长，默认多级 atempo 保持原音调并可选静音，兼容无音轨视频",
      "en-US":
        "Adjust video playback speed from 0.25x to 4x for single or batch files with duration estimates, default pitch preservation, optional mute, and silent-clip support",
    },
    keywords: [
      "speed",
      "change speed",
      "slow motion",
      "fast forward",
      "timelapse",
      "atempo",
      "pitch",
      "2x",
      "0.5x",
      "视频变速",
      "慢动作",
      "倍速",
      "加速",
      "减速",
    ],
    icon: "video-speed",
    implementationStatus: "full",
    component: VideoSpeedWorkspace,
  },
  {
    id: "V04",
    category: "video",
    name: { "zh-CN": "视频抽帧", "en-US": "Extract Frames" },
    summary: {
      "zh-CN":
        "按指定时间点、固定间隔秒数或均匀数量从视频抽取静帧，支持原尺寸/1080p/720p 与 PNG/JPEG/WebP（及系统 WIC HEIC），竖屏正立导出并适配 VFR",
      "en-US":
        "Extract still frames by timestamp, interval, or even count in Original/1080p/720p as PNG, JPEG, WebP (or Windows WIC HEIC), upright for portrait and timestamp-accurate for VFR",
    },
    keywords: [
      "extract frames",
      "frames",
      "still",
      "snapshot",
      "thumbnail",
      "poster",
      "video",
      "视频抽帧",
      "抽帧",
      "截帧",
      "封面",
    ],
    icon: "video-frames",
    implementationStatus: "full",
    component: VideoFramesWorkspace,
  },
  {
    id: "V05",
    category: "video",
    name: { "zh-CN": "屏幕录制", "en-US": "Record Screen" },
    summary: {
      "zh-CN":
        "基于 Windows.Graphics.Capture 录制显示器、单个窗口或高分屏框选区域，支持 WASAPI 系统声音与麦克风独立/混录、30/60 fps、H.264 MP4/MOV、指针与点击高亮及置顶无入画状态条",
      "en-US":
        "Record a display, single window, or DPI-accurate region with Windows.Graphics.Capture, optional WASAPI system audio and microphone mixing, 30/60 fps H.264 MP4/MOV, cursor/click highlight, and excluded floating status HUD",
    },
    keywords: [
      "v05",
      "record screen",
      "screen recorder",
      "screen capture",
      "wgc",
      "wasapi",
      "loopback",
      "mp4",
      "mov",
      "60fps",
      "屏幕录制",
      "录屏",
      "录制窗口",
      "区域录屏",
      "系统声音",
    ],
    icon: "screen-record",
    implementationStatus: "full",
    component: ScreenRecorderWorkspace,
  },
  {
    id: "V06",
    category: "video",
    name: { "zh-CN": "视频压缩", "en-US": "Compress Video" },
    summary: {
      "zh-CN":
        "高质量/均衡/小体积三档与 H.264/HEVC 压缩，支持原尺寸/1080p/720p/480p 上限（小视频不放大），压后未缩小默认保留原件并记录实际编码器",
      "en-US":
        "Compress videos with High/Balanced/Small presets, H.264 or HEVC, non-upscaling resolution caps, verified hardware encoder detection, and keep-original protection",
    },
    keywords: [
      "compress video",
      "shrink video",
      "h264",
      "hevc",
      "h265",
      "nvenc",
      "crf",
      "视频压缩",
      "减小体积",
      "压缩视频",
    ],
    icon: "video-compress",
    implementationStatus: "full",
    component: VideoCompressWorkspace,
  },
  {
    id: "V07",
    category: "video",
    name: { "zh-CN": "视频格式转换", "en-US": "Convert Video" },
    summary: {
      "zh-CN":
        "支持单文件与批量转换为 MP4、MOV、WebM（VP9/Opus）、M4V 与 MKV，开始前逐轨展示直拷/重编码与容器限制，导出后由 ffprobe 核验实际编码与轨道",
      "en-US":
        "Convert single or batch videos to MP4, MOV, WebM (VP9/Opus), M4V, or MKV with pre-run per-track compatibility analysis and post-export ffprobe verification",
    },
    keywords: [
      "convert video",
      "remux",
      "mp4",
      "mov",
      "webm",
      "m4v",
      "mkv",
      "vp9",
      "opus",
      "视频格式转换",
      "转码",
      "封装",
    ],
    icon: "video-convert",
    implementationStatus: "full",
    component: VideoConvertWorkspace,
  },
  {
    id: "V08",
    category: "video",
    name: { "zh-CN": "视频尺寸调整", "en-US": "Resize Video" },
    summary: {
      "zh-CN":
        "提供常见分辨率、1:1 方形、9:16 竖屏与自定义宽高，区分等比放入范围、留黑边与裁满画布（主动解锁比例才拉伸），导出前展示实际输出尺寸并支持批量套用",
      "en-US":
        "Resize single or batch videos to presets, 1:1, 9:16, or custom sizes with Fit, Letterbox/Pad, Crop-to-Fill, and explicit unlock-only Stretch",
    },
    keywords: [
      "resize video",
      "scale video",
      "resolution",
      "1080p",
      "720p",
      "9:16",
      "square",
      "letterbox",
      "pad",
      "视频尺寸调整",
      "分辨率",
      "缩放视频",
    ],
    icon: "video-resize",
    implementationStatus: "full",
    component: VideoResizeWorkspace,
  },
  {
    id: "V09",
    category: "video",
    name: { "zh-CN": "视频裁剪与旋转", "en-US": "Crop & Rotate Video" },
    summary: {
      "zh-CN":
        "在真实正立视频画面上直接拖动裁剪框，支持自由/1:1/16:9/9:16、左右旋转 90° 与水平/垂直翻转；以手机竖拍显示方向为坐标系，预览与导出 1:1 一致",
      "en-US":
        "Drag crop boxes directly on display-oriented video frames with Free, 1:1, 16:9, 9:16 ratios, 90° rotation, and horizontal/vertical flips",
    },
    keywords: [
      "crop video",
      "rotate video",
      "flip video",
      "9:16",
      "16:9",
      "1:1",
      "视频裁剪",
      "视频旋转",
      "翻转视频",
      "裁切画面",
    ],
    icon: "video-crop",
    implementationStatus: "full",
    component: VideoCropWorkspace,
  },
  {
    id: "V10",
    category: "video",
    name: { "zh-CN": "媒体信息检测", "en-US": "Media Info" },
    summary: {
      "zh-CN":
        "离线检测视频与音频容器、时长、大小、编码、存储与显示尺寸、旋转方向、帧率（含 VFR）、码率及每条音轨信息，支持复制文本与导出 JSON",
      "en-US":
        "Inspect video/audio container, duration, size, codecs, storage/display dimensions, rotation, frame rate (including VFR), bitrate, and every audio track with text copy and JSON export",
    },
    keywords: [
      "media info",
      "ffprobe",
      "video",
      "audio",
      "codec",
      "bitrate",
      "fps",
      "vfr",
      "metadata",
      "媒体信息",
      "视频信息",
      "编码",
      "码率",
      "帧率",
      "音轨",
    ],
    icon: "media-info",
    implementationStatus: "full",
    component: MediaInfoWorkspace,
  },
  {
    id: "V11",
    category: "video",
    name: { "zh-CN": "视频剪切", "en-US": "Trim Video" },
    summary: {
      "zh-CN":
        "可视化时间轴拖动起止点、按播放头设边界与选段预览；支持快速流复制（导出前展示关键帧偏移）与精确剪切（重编码），兼顾竖屏旋转与无音轨视频",
      "en-US":
        "Visual timeline trimming with playhead bounds, segment preview, Fast Stream Copy (with pre-export keyframe offset notice), and Accurate Transcode",
    },
    keywords: [
      "trim",
      "cut",
      "clip",
      "video",
      "stream copy",
      "keyframe",
      "ffmpeg",
      "视频剪切",
      "剪辑",
      "裁剪片段",
      "流复制",
      "精确剪切",
    ],
    icon: "video-trim",
    implementationStatus: "full",
    component: VideoTrimWorkspace,
  },
  {
    id: "V12",
    category: "video",
    name: { "zh-CN": "视频合并", "en-US": "Merge Videos" },
    summary: {
      "zh-CN":
        "选择两段及以上视频展示缩略图、顺序调整与总时长，统一封装为 H.264 MP4；横竖屏混排默认等比留黑，有声与无声段混拼自动补静音对齐",
      "en-US":
        "Merge two or more clips in order with thumbnails, drag/button reorder, total duration, resolution presets, default letterboxing, and exact silence padding for mixed audio/silent clips",
    },
    keywords: [
      "merge",
      "concat",
      "join",
      "combine",
      "stitch",
      "video",
      "mp4",
      "视频合并",
      "拼接",
      "合并视频",
      "串联",
    ],
    icon: "video-merge",
    implementationStatus: "full",
    component: VideoMergeWorkspace,
  },
  {
    id: "V13",
    category: "video",
    name: { "zh-CN": "视频静音", "en-US": "Mute Video" },
    summary: {
      "zh-CN":
        "无损移除视频中的全部音轨（含多语言第二条及后续音轨），保留原封装容器、画质、方向与时长；原本无音轨素材直接提示不重复写出",
      "en-US":
        "Losslessly strip all audio tracks (including multi-language tracks) while keeping original container, video stream, orientation, and duration",
    },
    keywords: [
      "mute",
      "silent",
      "remove audio",
      "strip audio",
      "video",
      "视频静音",
      "去声音",
      "移除音轨",
      "消除音频",
    ],
    icon: "video-mute",
    implementationStatus: "full",
    component: VideoMuteWorkspace,
  },
  {
    id: "V14",
    category: "video",
    name: { "zh-CN": "替换视频音频", "en-US": "Replace Audio" },
    summary: {
      "zh-CN":
        "用本地音频或另一段视频的音轨替换或混合视频原声，独立调节原声与新音频音量、控制短音频循环铺满或单次播放并支持导出前同步试听",
      "en-US":
        "Replace or mix a video's audio using an audio file or another video track with independent volumes, Loop-to-Fill vs Play-Once, and live pre-export mix audition",
    },
    keywords: [
      "replace audio",
      "dub",
      "mix audio",
      "bgm",
      "soundtrack",
      "loop",
      "video",
      "替换音频",
      "配音",
      "混音",
      "换背景音乐",
      "音轨",
    ],
    icon: "video-replace-audio",
    implementationStatus: "full",
    component: VideoReplaceAudioWorkspace,
  },
  {
    id: "V15",
    category: "video",
    name: { "zh-CN": "视频转 GIF", "en-US": "Video to GIF" },
    summary: {
      "zh-CN":
        "将整段视频或指定时间范围通过调色板优化生成高质量 GIF，支持 10/15/24 fps、320/480/640 px 或原宽（默认不放大）及循环开关，导出后即时预览动图与体积",
      "en-US":
        "Convert full videos or time ranges into palette-optimized GIFs at 10/15/24 fps and 320/480/640 px or original width with loop toggle and live animated preview",
    },
    keywords: [
      "gif",
      "video to gif",
      "animated",
      "palette",
      "loop",
      "视频转gif",
      "动图",
      "表情包",
      "录屏转gif",
    ],
    icon: "video-gif",
    implementationStatus: "full",
    component: VideoGifWorkspace,
  },
  {
    id: "A01",
    category: "audio",
    name: { "zh-CN": "音频降噪与增强", "en-US": "Clean Up Audio" },
    summary: {
      "zh-CN":
        "支持音频与含音轨视频的轻/中/强本地降噪、低频隆隆声/哼声过滤、两遍 EBU R128 响度标准化（默认 -16 LUFS）、同片段对比试听及纯音频静默裁剪",
      "en-US":
        "Offline Light/Medium/Strong denoise, rumble/hum filter, 2-pass EBU R128 loudness normalization (-16 LUFS default), Before/After audition, and audio-only silence trimming",
    },
    keywords: [
      "clean up audio",
      "denoise",
      "noise reduction",
      "loudness",
      "lufs",
      "rumble",
      "hum",
      "voice",
      "音频降噪",
      "人声增强",
      "响度标准化",
      "去噪",
      "底噪",
    ],
    icon: "audio-cleanup",
    implementationStatus: "full",
    component: AudioCleanupWorkspace,
  },
  {
    id: "A02",
    category: "audio",
    name: { "zh-CN": "录音机", "en-US": "Record Audio" },
    summary: {
      "zh-CN":
        "选择麦克风查看实时输入电平，支持开始、暂停、继续、停止试听并保存为无损 WAV 或 M4A/AAC，保存后可一键送往 A03 剪切或 A01 降噪（离线转写留阶段 6）",
      "en-US":
        "Select a microphone with live input metering, record with pause/resume, audition, and save as WAV or M4A/AAC with one-click handoff to A03 Trim or A01 Clean Up (offline transcription in Phase 6)",
    },
    keywords: [
      "a02",
      "record audio",
      "voice recorder",
      "microphone",
      "mic",
      "wav",
      "m4a",
      "aac",
      "wasapi",
      "录音",
      "录音机",
      "麦克风",
      "电平",
    ],
    icon: "audio-record",
    implementationStatus: "partial",
    component: AudioRecorderWorkspace,
  },
  {
    id: "A03",
    category: "audio",
    name: { "zh-CN": "音频剪切", "en-US": "Trim Audio" },
    summary: {
      "zh-CN":
        "流式有界内存生成真实波形，支持拖动选区、精确起止时间、选区试听及独立淡入/淡出控制（短选区明示有效范围），切换工具保留选区",
      "en-US":
        "Trim audio on real bounded-memory waveforms with draggable selection, exact start/end inputs, selection audition, and separate fade-in/fade-out controls",
    },
    keywords: [
      "trim audio",
      "cut audio",
      "waveform",
      "fade in",
      "fade out",
      "audio",
      "mp3",
      "wav",
      "音频剪切",
      "剪辑录音",
      "波形",
      "淡入",
      "淡出",
    ],
    icon: "audio-trim",
    implementationStatus: "full",
    component: AudioTrimWorkspace,
  },
  {
    id: "A04",
    category: "audio",
    name: { "zh-CN": "提取视频音频", "en-US": "Extract Audio" },
    summary: {
      "zh-CN":
        "从视频中按语言选择指定音轨并支持试听，导出为 M4A、MP3、WAV 或 FLAC；兼容编码原样无损提取，其余明确标注转码，无音轨不生成空文件",
      "en-US":
        "Select and audition any audio track from videos and export as M4A, MP3, WAV, or FLAC with stream copy when compatible or explicit transcoding",
    },
    keywords: [
      "extract audio",
      "audio",
      "m4a",
      "mp3",
      "wav",
      "flac",
      "track",
      "提取音频",
      "分离音轨",
      "视频转音频",
      "音轨",
    ],
    icon: "audio-extract",
    implementationStatus: "full",
    component: AudioExtractWorkspace,
  },
  {
    id: "A05",
    category: "audio",
    name: { "zh-CN": "音频格式转换", "en-US": "Convert Audio" },
    summary: {
      "zh-CN":
        "单文件与批量转换为 MP3、M4A (AAC)、WAV、FLAC 与 AIFF，按格式提供码率/采样率/位深选项，无损格式默认保留源位深、采样率与声道",
      "en-US":
        "Convert single or batch audio to MP3, M4A (AAC), WAV, FLAC, or AIFF with format-appropriate bitrate, sample rate, and lossless source-precision preservation",
    },
    keywords: [
      "convert audio",
      "mp3",
      "m4a",
      "aac",
      "wav",
      "flac",
      "aiff",
      "lossless",
      "24-bit",
      "音频格式转换",
      "音频转码",
      "无损",
    ],
    icon: "audio-convert",
    implementationStatus: "full",
    component: AudioConvertWorkspace,
  },
  {
    id: "P06",
    category: "pdf",
    name: {
      "zh-CN": "PDF 签名",
      "en-US": "Sign PDF",
    },
    summary: {
      "zh-CN":
        "手绘、键入样式或上传透明 PNG 可视签名，在 PDF 页面上直接拖动缩放旋转定位，支持会话复用与主动保存本地模板",
      "en-US":
        "Draw, type, or upload transparent PNG visual signatures, drag/resize/rotate on PDF pages with session reuse and opt-in local templates",
    },
    keywords: [
      "pdf",
      "sign",
      "signature",
      "handwriting",
      "stamp",
      "pdf签名",
      "电子签名",
      "手绘签名",
      "签字",
    ],
    icon: "pdf-sign",
    implementationStatus: "full",
    component: PdfSignWorkspace,
  },
  {
    id: "P07",
    category: "pdf",
    name: {
      "zh-CN": "PDF 合并",
      "en-US": "Merge PDFs",
    },
    summary: {
      "zh-CN":
        "按顺序合并多个 PDF 与图片为新 PDF，保留矢量、文字层、链接并可选按文件名生成书签目录",
      "en-US":
        "Merge multiple PDFs and images in order while preserving vectors, text layers, links, and optional filename outlines",
    },
    keywords: [
      "pdf",
      "merge",
      "combine",
      "join",
      "bookmarks",
      "outlines",
      "pdf合并",
      "合并pdf",
      "文档合并",
      "书签",
    ],
    icon: "pdf-merge",
    implementationStatus: "full",
    component: PdfMergeWorkspace,
  },
  {
    id: "P08",
    category: "pdf",
    name: {
      "zh-CN": "PDF 拆分",
      "en-US": "Split PDF",
    },
    summary: {
      "zh-CN": "按逐页、每 N 页或自定义页码范围拆分 PDF，执行前预览全部输出文件名并自动防覆盖",
      "en-US":
        "Split PDFs by every page, every N pages, or custom page ranges with upfront validation and collision-safe output",
    },
    keywords: [
      "pdf",
      "split",
      "divide",
      "chunk",
      "range",
      "pdf拆分",
      "拆分pdf",
      "分割pdf",
      "页码范围",
    ],
    icon: "pdf-split",
    implementationStatus: "full",
    component: PdfSplitWorkspace,
  },
  {
    id: "P09",
    category: "pdf",
    name: {
      "zh-CN": "PDF 页面重排与旋转",
      "en-US": "Organize PDF",
    },
    summary: {
      "zh-CN": "缩略图网格拖拽调整页面顺序、90°/180°/270° 旋转、删除与撤销重做，无损导出新 PDF",
      "en-US":
        "Reorder, rotate 90°/180°/270°, and remove PDF pages visually in a thumbnail grid with undo/redo",
    },
    keywords: [
      "pdf",
      "organize",
      "reorder",
      "rotate",
      "arrange",
      "pdf重排",
      "页面重排",
      "pdf旋转",
      "整理pdf",
    ],
    icon: "pdf-organize",
    implementationStatus: "full",
    component: PdfOrganizeWorkspace,
  },
  {
    id: "P10",
    category: "pdf",
    name: {
      "zh-CN": "删除 PDF 页面",
      "en-US": "Delete PDF Pages",
    },
    summary: {
      "zh-CN": "按页码范围、多选缩略图与反选精准删页，导出前核对保留/删除页数并禁止删空文档",
      "en-US":
        "Delete selected PDF pages via thumbnail grid, invert selection, or ranges with upfront kept/deleted confirmation",
    },
    keywords: ["pdf", "delete", "remove pages", "trim", "删除pdf页面", "删页", "移除页面"],
    icon: "pdf-delete",
    implementationStatus: "full",
    component: PdfDeleteWorkspace,
  },
  {
    id: "P11",
    category: "pdf",
    name: {
      "zh-CN": "提取 PDF 页面",
      "en-US": "Extract PDF Pages",
    },
    summary: {
      "zh-CN": "提取指定或不连续页面，支持导出为单个合并新 PDF 或按页拆分为多个独立单页 PDF",
      "en-US":
        "Extract contiguous or non-contiguous PDF pages into a single combined PDF or individual per-page PDFs",
    },
    keywords: ["pdf", "extract", "pages", "export pages", "提取pdf页面", "抽取页面", "另存页面"],
    icon: "pdf-extract",
    implementationStatus: "full",
    component: PdfExtractWorkspace,
  },
  {
    id: "P12",
    category: "pdf",
    name: {
      "zh-CN": "图片合成 PDF",
      "en-US": "Images to PDF",
    },
    summary: {
      "zh-CN": "将多张图片按顺序合成为 PDF，自动应用 EXIF 方向并支持纸张尺寸、边距与透明背景色",
      "en-US":
        "Combine images into a PDF with EXIF upright orientation, Original/A4/Letter paper presets, margins, and transparency fill",
    },
    keywords: [
      "pdf",
      "images to pdf",
      "jpg to pdf",
      "png to pdf",
      "photo pdf",
      "图片合成pdf",
      "图片转pdf",
      "照片转pdf",
    ],
    icon: "pdf-images-to-pdf",
    implementationStatus: "full",
    component: ImagesToPdfWorkspace,
  },
  {
    id: "P13",
    category: "pdf",
    name: {
      "zh-CN": "PDF 页面裁剪",
      "en-US": "Crop PDF",
    },
    summary: {
      "zh-CN":
        "可视化拖拽或四边数值非破坏性裁剪 PDF 页面，支持 A4/Letter/快递面单预设与自动检测白边预览，保留可选文字与矢量",
      "en-US":
        "Non-destructively crop PDF pages visually or by exact margins with A4/Letter/shipping-label presets and auto white-margin preview",
    },
    keywords: [
      "pdf",
      "crop",
      "trim",
      "margins",
      "shipping label",
      "white space",
      "pdf裁剪",
      "页面裁剪",
      "快递面单",
      "去白边",
    ],
    icon: "pdf-crop",
    implementationStatus: "full",
    component: PdfCropWorkspace,
  },
  {
    id: "P14",
    category: "pdf",
    name: {
      "zh-CN": "PDF 压缩",
      "en-US": "Compress PDF",
    },
    summary: {
      "zh-CN":
        "提供无损结构优化、均衡压缩与最小体积三档离线压缩，绝不整页栅格化、保留可选文字与矢量，并自动防膨胀保留原样",
      "en-US":
        "Compress PDFs offline with Lossless Structure, Balanced, and Smallest modes without page rasterization, preserving selectable text/vectors with no-bloat retention",
    },
    keywords: [
      "pdf",
      "compress",
      "shrink",
      "optimize",
      "reduce size",
      "lossless",
      "pdf压缩",
      "压缩pdf",
      "减小体积",
      "无损优化",
    ],
    icon: "pdf-compress",
    implementationStatus: "full",
    component: PdfCompressWorkspace,
  },
  {
    id: "P15",
    category: "pdf",
    name: {
      "zh-CN": "PDF 加密",
      "en-US": "Encrypt PDF",
    },
    summary: {
      "zh-CN":
        "使用 AES-256（PDF 2.0 R6）离线为 PDF 设置打开密码、独立权限密码及打印/复制/修改权限，自动独立校验并保护原文件",
      "en-US":
        "Encrypt PDFs offline with AES-256 (PDF 2.0 R6), open & separate owner passwords, and print/copy/modify permissions with independent verification",
    },
    keywords: [
      "pdf",
      "encrypt",
      "password",
      "protect",
      "aes-256",
      "lock",
      "permissions",
      "pdf加密",
      "添加密码",
      "加密pdf",
      "密码保护",
    ],
    icon: "pdf-encrypt",
    implementationStatus: "full",
    component: PdfEncryptWorkspace,
  },
  {
    id: "P16",
    category: "pdf",
    name: {
      "zh-CN": "PDF 解除密码",
      "en-US": "Decrypt PDF",
    },
    summary: {
      "zh-CN":
        "输入已知密码本地离线移除 PDF 密码与权限限制，支持 RC4/AES-128/AES-256 并独立校验输出可无密码打开",
      "en-US":
        "Remove password protection from PDFs offline using your known password (RC4/AES-128/AES-256) with independent verification that the copy opens unlocked",
    },
    keywords: [
      "pdf",
      "decrypt",
      "unlock",
      "remove password",
      "pdf解密",
      "解除密码",
      "移除密码",
      "解锁pdf",
    ],
    icon: "pdf-decrypt",
    implementationStatus: "full",
    component: PdfDecryptWorkspace,
  },
  {
    id: "P17",
    category: "pdf",
    name: {
      "zh-CN": "PDF 导出为图片",
      "en-US": "PDF to Images",
    },
    summary: {
      "zh-CN":
        "离线按自定义 DPI 批量将 PDF 页面渲染为 PNG / JPEG / WebP（及系统支持的 HEIC），带尺寸预估",
      "en-US":
        "Render PDF pages offline at custom DPI into PNG, JPEG, WebP (or HEIC when supported) with upfront size estimates",
    },
    keywords: [
      "pdf",
      "pdf to images",
      "pdf to png",
      "pdf to jpg",
      "render pdf",
      "dpi",
      "pdf转图片",
      "pdf导出图片",
    ],
    icon: "pdf-to-images",
    implementationStatus: "full",
    component: PdfToImagesWorkspace,
  },
  {
    id: "P23",
    category: "pdf",
    name: {
      "zh-CN": "Markdown 转 PDF",
      "en-US": "Markdown to PDF",
    },
    summary: {
      "zh-CN":
        "内置安全实时预览与本地 .md 打开，支持简约/GitHub 主题、A4/Letter、页眉页脚页码与标题目录书签，离线导出可选中矢量 PDF",
      "en-US":
        "Convert Markdown to vector PDF offline with live sanitized preview, Clean/GitHub themes, A4/Letter, headers/footers/page numbers, clickable links, and heading bookmarks",
    },
    keywords: [
      "pdf",
      "markdown",
      "md to pdf",
      "markdown to pdf",
      "readme",
      "export pdf",
      "bookmarks",
      "markdown转pdf",
      "md转pdf",
      "文档排版",
    ],
    icon: "pdf-markdown",
    implementationStatus: "full",
    component: PdfMarkdownWorkspace,
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
