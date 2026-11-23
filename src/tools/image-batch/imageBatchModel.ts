import type { Locale } from "../../i18n/messages";

export type ImageFileFormat = "jpeg" | "png" | "webp" | "tiff" | "bmp" | "heic" | "gif" | "unknown";

export type ImageConvertTargetFormat = "jpeg" | "png" | "webp" | "tiff" | "bmp" | "heic";
export type CompressQualityPreset = "low" | "medium" | "high";
export type PngCompressMode = "lossless" | "lossy_palette";

export interface HeicCapabilities {
  decodeAvailable: boolean;
  encodeAvailable: boolean;
  decodeNote: string;
  encodeNote: string;
}

export interface ImageMetadataFlags {
  hasExif: boolean;
  hasGps: boolean;
  hasXmp: boolean;
  hasIptc: boolean;
  hasIcc: boolean;
  hasComments: boolean;
  hasCameraInfo: boolean;
  hasDatetime: boolean;
  duplicateSegmentCount: number;
  tagHighlights: string[];
}

export interface InspectedImageItem {
  path: string;
  fileName: string;
  byteLength: number;
  format: ImageFileFormat;
  rawWidth: number;
  rawHeight: number;
  exifOrientation: number;
  displayWidth: number;
  displayHeight: number;
  hasAlpha: boolean;
  isAnimated: boolean;
  pageCount: number;
  hasIccProfile: boolean;
  metadataFlags: ImageMetadataFlags;
  thumbnailDataUrl: string | null;
  warnings: string[];
  error: string | null;
}

export interface SkippedImageInput {
  path: string;
  reason: string;
}

export interface InspectBatchImagesResponse {
  items: InspectedImageItem[];
  skipped: SkippedImageInput[];
  heicCapabilities: HeicCapabilities;
}

export interface ImageBatchProgressPayload {
  taskId: string;
  toolId: string;
  currentIndex: number;
  totalItems: number;
  currentFileName: string;
}

export type BatchImageOutcomeStatus = "ok" | "kept_original" | "skipped" | "error";

export interface BatchImageItemOutcome {
  sourcePath: string;
  fileName: string;
  outputPath: string | null;
  status: BatchImageOutcomeStatus;
  originalBytes: number;
  outputBytes: number;
  savedPercent: number;
  outputWidth: number | null;
  outputHeight: number | null;
  codecNote: string | null;
  message: string | null;
}

export interface BatchImageJobResponse {
  taskId: string;
  toolId: string;
  outputDir: string;
  cancelled: boolean;
  succeededCount: number;
  keptOriginalCount: number;
  skippedCount: number;
  failedCount: number;
  totalOriginalBytes: number;
  totalOutputBytes: number;
  items: BatchImageItemOutcome[];
}

export interface ConvertImagesBatchRequest {
  sourcePaths: string[];
  outputDir: string;
  targetFormat: ImageConvertTargetFormat;
  quality: number;
  webpLossless: boolean;
  backgroundHex: string;
}

export interface PreviewConvertImageRequest {
  path: string;
  targetFormat: ImageConvertTargetFormat;
  backgroundHex: string;
}

export interface PreviewConvertImageResponse {
  previewDataUrl: string;
  displayWidth: number;
  displayHeight: number;
  hasAlpha: boolean;
  flattenedAlpha: boolean;
}

export interface CompressImagesBatchRequest {
  sourcePaths: string[];
  outputDir: string;
  qualityPreset: CompressQualityPreset;
  pngMode: PngCompressMode;
}

export interface PreviewCompressImageRequest {
  path: string;
  qualityPreset: CompressQualityPreset;
  pngMode: PngCompressMode;
}

export interface PreviewCompressImageResponse {
  originalPreviewDataUrl: string;
  compressedPreviewDataUrl: string;
  originalBytes: number;
  compressedBytes: number;
  savedPercent: number;
  keptOriginal: boolean;
  width: number;
  height: number;
  format: ImageFileFormat;
  codecLabel: string;
}

export const IMAGE_FILE_DIALOG_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "webp",
  "tif",
  "tiff",
  "bmp",
  "heic",
  "heif",
  "gif",
];

export const BACKGROUND_COLOR_PRESETS = [
  { hex: "#FFFFFF", label: { "zh-CN": "纯白", "en-US": "White" } },
  { hex: "#000000", label: { "zh-CN": "纯黑", "en-US": "Black" } },
  { hex: "#F3F4F6", label: { "zh-CN": "浅灰", "en-US": "Light Gray" } },
  { hex: "#1E293B", label: { "zh-CN": "深灰", "en-US": "Slate" } },
] as const;

export function formatImageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function formatImageFormatLabel(fmt: ImageFileFormat): string {
  switch (fmt) {
    case "jpeg":
      return "JPEG";
    case "png":
      return "PNG";
    case "webp":
      return "WebP";
    case "tiff":
      return "TIFF";
    case "bmp":
      return "BMP";
    case "heic":
      return "HEIC";
    case "gif":
      return "GIF";
    default:
      return "UNKNOWN";
  }
}

export function targetFormatSupportsQuality(
  fmt: ImageConvertTargetFormat,
  webpLossless: boolean,
): boolean {
  if (fmt === "jpeg" || fmt === "heic") return true;
  if (fmt === "webp") return !webpLossless;
  return false;
}

export function targetFormatFlattensAlpha(fmt: ImageConvertTargetFormat): boolean {
  return fmt === "jpeg" || fmt === "bmp";
}

export function formatImageWarningText(code: string, locale: Locale): string {
  const zh = locale === "zh-CN";
  switch (code) {
    case "animated_first_frame_only":
      return zh
        ? "动图：导出时仅处理首帧静图"
        : "Animated image: export processes first frame only";
    case "multipage_tiff_first_page_only":
      return zh
        ? "多页 TIFF：像素导出仅处理第 1 页"
        : "Multi-page TIFF: pixel operations export page 1 only";
    case "oversized_file":
      return zh ? "文件超过 128 MiB 安全上限" : "File exceeds 128 MiB limit";
    case "heic_decode_unavailable":
      return zh
        ? "当前 Windows 缺少 HEIF/HEVC 解码扩展"
        : "Missing Windows HEIF/HEVC decoder extension";
    default:
      return code;
  }
}

export function mergeInspectedItems(
  existing: readonly InspectedImageItem[],
  incoming: readonly InspectedImageItem[],
): InspectedImageItem[] {
  const seen = new Set(existing.map((i) => i.path.toLowerCase()));
  const next = [...existing];
  for (const item of incoming) {
    const key = item.path.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      next.push(item);
    }
  }
  return next;
}
