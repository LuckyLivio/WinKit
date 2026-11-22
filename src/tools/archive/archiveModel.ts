import type { Locale } from "../../i18n/messages";

export type ArchiveFormat =
  | "zip"
  | "seven_z"
  | "rar"
  | "tar"
  | "tar_gz"
  | "tar_xz"
  | "tar_bz2"
  | "single_gz"
  | "single_xz"
  | "single_bz2"
  | "iso";

export type ArchiveCreateFormat = "zip" | "zip_aes256" | "zip_zipcrypto" | "tar_gz";

export type ExtractConflictPolicy = "unique_folder" | "fail_if_exists";

export type ArchiveExtractStatus =
  "extracted" | "needs_password" | "wrong_password" | "conflict" | "cancelled" | "error";

export interface ArchiveEntryInfo {
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  isMacosMetadata: boolean;
  compressedSize: number | null;
  uncompressedSize: number | null;
  encrypted: boolean;
}

export interface ArchivePreviewResponse {
  archivePath: string;
  archiveName: string;
  format: ArchiveFormat;
  archiveByteLength: number;
  needsPassword: boolean;
  encryptedEntryCount: number;
  totalEntries: number;
  totalUncompressedBytes: number;
  entriesTruncated: boolean;
  entries: ArchiveEntryInfo[];
}

export interface ExtractArchivesRequest {
  archivePaths: string[];
  outputParentDir: string;
  passwords: Record<string, string>;
  skipMacosMetadata: boolean;
  conflictPolicy: ExtractConflictPolicy;
}

export interface ArchiveExtractItemReport {
  archivePath: string;
  archiveName: string;
  format: ArchiveFormat | null;
  status: ArchiveExtractStatus;
  outputDir: string | null;
  extractedFiles: number;
  extractedDirs: number;
  skippedEntries: number;
  writtenBytes: number;
  message: string | null;
}

export interface ExtractArchivesBatchResponse {
  taskId: string;
  outputParentDir: string;
  cancelled: boolean;
  succeededCount: number;
  failedCount: number;
  items: ArchiveExtractItemReport[];
}

export interface CreateArchiveRequest {
  sourcePaths: string[];
  outputPath: string;
  format: ArchiveCreateFormat;
  password: string | null;
  overwrite: boolean;
}

export interface CreateArchiveResponse {
  taskId: string;
  outputPath: string;
  outputParentDir: string;
  format: ArchiveFormat;
  entryCount: number;
  skippedCount: number;
  outputByteLength: number;
}

export interface ArchiveProgressPayload {
  taskId: string;
  operation: "extract" | "create";
  currentIndex: number;
  totalItems: number;
  currentItem: string;
  processedBytes: number;
  totalBytes: number | null;
}

export interface ArchiveFormatCapabilityRow {
  formatLabel: string;
  extensions: string;
  preview: boolean;
  extract: boolean;
  create: boolean;
  password: Record<Locale, string>;
}

export const ARCHIVE_SUPPORT_MATRIX: readonly ArchiveFormatCapabilityRow[] = [
  {
    formatLabel: "ZIP",
    extensions: ".zip",
    preview: true,
    extract: true,
    create: true,
    password: {
      "zh-CN": "支持（AES-256 / ZipCrypto 解压与创建）",
      "en-US": "Yes (AES-256 & ZipCrypto extract/create)",
    },
  },
  {
    formatLabel: "7Z",
    extensions: ".7z",
    preview: true,
    extract: true,
    create: false,
    password: {
      "zh-CN": "支持解压与列表预览",
      "en-US": "Yes (extract & encrypted header preview)",
    },
  },
  {
    formatLabel: "RAR (RAR4 / RAR5)",
    extensions: ".rar",
    preview: true,
    extract: true,
    create: false,
    password: {
      "zh-CN": "支持解压与列表预览（只读）",
      "en-US": "Yes (read-only extract & preview)",
    },
  },
  {
    formatLabel: "TAR",
    extensions: ".tar",
    preview: true,
    extract: true,
    create: false,
    password: { "zh-CN": "不适用", "en-US": "N/A" },
  },
  {
    formatLabel: "TAR.GZ",
    extensions: ".tar.gz, .tgz",
    preview: true,
    extract: true,
    create: true,
    password: { "zh-CN": "不适用", "en-US": "N/A" },
  },
  {
    formatLabel: "TAR.XZ",
    extensions: ".tar.xz, .txz",
    preview: true,
    extract: true,
    create: false,
    password: { "zh-CN": "不适用", "en-US": "N/A" },
  },
  {
    formatLabel: "TAR.BZ2",
    extensions: ".tar.bz2, .tbz2",
    preview: true,
    extract: true,
    create: false,
    password: { "zh-CN": "不适用", "en-US": "N/A" },
  },
  {
    formatLabel: "GZ / XZ / BZ2",
    extensions: ".gz, .xz, .bz2",
    preview: true,
    extract: true,
    create: false,
    password: {
      "zh-CN": "单文件流（与 tar.* 区分）",
      "en-US": "Single-file stream (distinct from tar.*)",
    },
  },
  {
    formatLabel: "ISO",
    extensions: ".iso",
    preview: true,
    extract: true,
    create: false,
    password: { "zh-CN": "只读（ISO 9660 / Joliet）", "en-US": "Read-only (ISO 9660 / Joliet)" },
  },
];

export const ARCHIVE_FILE_DIALOG_EXTENSIONS = [
  "zip",
  "7z",
  "rar",
  "tar",
  "gz",
  "tgz",
  "xz",
  "txz",
  "bz2",
  "tbz2",
  "iso",
];

export function formatArchiveFormatLabel(format: ArchiveFormat, locale: Locale): string {
  switch (format) {
    case "zip":
      return "ZIP";
    case "seven_z":
      return "7Z";
    case "rar":
      return "RAR";
    case "tar":
      return "TAR";
    case "tar_gz":
      return "TAR.GZ";
    case "tar_xz":
      return "TAR.XZ";
    case "tar_bz2":
      return "TAR.BZ2";
    case "single_gz":
      return locale === "zh-CN" ? "GZ 单文件" : "GZ Stream";
    case "single_xz":
      return locale === "zh-CN" ? "XZ 单文件" : "XZ Stream";
    case "single_bz2":
      return locale === "zh-CN" ? "BZ2 单文件" : "BZ2 Stream";
    case "iso":
      return "ISO";
  }
}

export function formatArchiveBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export function createFormatRequiresPassword(format: ArchiveCreateFormat): boolean {
  return format === "zip_aes256" || format === "zip_zipcrypto";
}

export function getCreateExtension(format: ArchiveCreateFormat): "zip" | "tar.gz" {
  return format === "tar_gz" ? "tar.gz" : "zip";
}

export function extractBaseFileName(rawPath: string): string {
  const normalized = rawPath.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || rawPath;
}

export function suggestCreateOutputFilename(
  sourcePaths: readonly string[],
  format: ArchiveCreateFormat,
): string {
  const ext = getCreateExtension(format);
  if (sourcePaths.length === 1) {
    const base = extractBaseFileName(sourcePaths[0]!);
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const safeStem = stem.replace(/[<>:"/\\|?*]+/g, "_").trim() || "archive";
    return `${safeStem}.${ext}`;
  }
  return `winkit-archive.${ext}`;
}

export function isLikelyArchivePath(path: string): boolean {
  const lower = path.trim().toLowerCase();
  return [
    ".tar.gz",
    ".tar.xz",
    ".tar.bz2",
    ".zip",
    ".7z",
    ".rar",
    ".tar",
    ".tgz",
    ".txz",
    ".tbz2",
    ".gz",
    ".xz",
    ".bz2",
    ".iso",
  ].some((suffix) => lower.endsWith(suffix));
}
