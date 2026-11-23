import type { Locale } from "../../i18n/messages";
import type { AudioStreamInfo } from "../../lib/tauriBridge";

export const VIDEO_EXTENSIONS = [
  "mp4",
  "mov",
  "mkv",
  "webm",
  "avi",
  "m4v",
  "ts",
  "m2ts",
  "flv",
  "wmv",
  "mpg",
  "mpeg",
];

export const AUDIO_EXTENSIONS = ["mp3", "m4a", "wav", "flac", "aac", "ogg", "opus", "wma", "aiff"];

export const ALL_MEDIA_EXTENSIONS = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS];

export function unknownLabel(locale: Locale): string {
  return locale === "zh-CN" ? "未知" : "Unknown";
}

export function formatMediaBytes(bytes: number | null | undefined, locale: Locale): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) {
    return unknownLabel(locale);
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export function formatTimecode(sec: number | null | undefined, includeHours = false): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) {
    return "--:--.---";
  }
  const totalMs = Math.round(sec * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const mins = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");
  if (includeHours || hours > 0) {
    return `${pad2(hours)}:${pad2(mins)}:${pad2(secs)}.${pad3(ms)}`;
  }
  return `${pad2(mins)}:${pad2(secs)}.${pad3(ms)}`;
}

export function formatDurationLabel(sec: number | null | undefined, locale: Locale): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) {
    return unknownLabel(locale);
  }
  return formatTimecode(sec);
}

/**
 * Parses user-entered timecodes in `SS.mmm`, `MM:SS.mmm`, or `HH:MM:SS.mmm` format.
 * Returns `null` for invalid or negative inputs.
 */
export function parseTimecodeInput(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const val = Number(s);
    return Number.isFinite(val) && val >= 0 ? val : null;
  }
  const parts = s.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map((p) => Number(p.trim()));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts.length === 2) {
    const [m, sec] = nums as [number, number];
    if (sec >= 60) return null;
    return m * 60 + sec;
  }
  const [h, m, sec] = nums as [number, number, number];
  if (m >= 60 || sec >= 60) return null;
  return h * 3600 + m * 60 + sec;
}

export function formatBitrateLabel(bps: number | null | undefined, locale: Locale): string {
  if (bps == null || !Number.isFinite(bps) || bps <= 0) {
    return unknownLabel(locale);
  }
  if (bps >= 1_000_000) {
    return `${(bps / 1_000_000).toFixed(2)} Mbps`;
  }
  return `${Math.round(bps / 1000)} kbps`;
}

export function formatFrameRateLabel(
  avgFps: number | null | undefined,
  rFps: number | null | undefined,
  isVfr: boolean | null | undefined,
  locale: Locale,
): string {
  const fmtNum = (n: number) =>
    Math.abs(n - Math.round(n)) < 0.01 ? `${Math.round(n)}` : n.toFixed(2);
  if (avgFps != null && Number.isFinite(avgFps) && avgFps > 0) {
    if (isVfr === true) {
      return locale === "zh-CN"
        ? `${fmtNum(avgFps)} fps（可变帧率 VFR）`
        : `${fmtNum(avgFps)} fps (VFR)`;
    }
    if (isVfr === false) {
      return `${fmtNum(avgFps)} fps`;
    }
    return `${fmtNum(avgFps)} fps`;
  }
  if (rFps != null && Number.isFinite(rFps) && rFps > 0) {
    if (isVfr === true) {
      return locale === "zh-CN"
        ? `可变帧率 VFR（标称 ${fmtNum(rFps)} fps）`
        : `VFR (nominal ${fmtNum(rFps)} fps)`;
    }
    return `${fmtNum(rFps)} fps`;
  }
  if (isVfr === true) {
    return locale === "zh-CN" ? "可变帧率 VFR（帧率未知）" : "VFR (rate unknown)";
  }
  return unknownLabel(locale);
}

export function formatOrientationLabel(
  orientation: string | null | undefined,
  rotation: number | null | undefined,
  locale: Locale,
): string {
  const orientText =
    orientation === "portrait"
      ? locale === "zh-CN"
        ? "竖屏"
        : "Portrait"
      : orientation === "landscape"
        ? locale === "zh-CN"
          ? "横屏"
          : "Landscape"
        : orientation === "square"
          ? locale === "zh-CN"
            ? "方形"
            : "Square"
          : unknownLabel(locale);
  if (rotation != null && rotation !== 0) {
    return locale === "zh-CN"
      ? `${orientText}（旋转 ${rotation}°）`
      : `${orientText} (${rotation}° rotation)`;
  }
  return orientText;
}

export function formatLanguageName(lang: string | null | undefined, locale: Locale): string {
  if (!lang) return locale === "zh-CN" ? "未标注语言" : "Unspecified";
  const lower = lang.trim().toLowerCase();
  const mapZh: Record<string, string> = {
    zho: "中文 (zho)",
    chi: "中文 (chi)",
    zh: "中文 (zh)",
    eng: "英语 (eng)",
    en: "英语 (en)",
    jpn: "日语 (jpn)",
    kor: "韩语 (kor)",
    fra: "法语 (fra)",
    fre: "法语 (fre)",
    deu: "德语 (deu)",
    ger: "德语 (ger)",
    spa: "西班牙语 (spa)",
    und: "未定义 (und)",
  };
  const mapEn: Record<string, string> = {
    zho: "Chinese (zho)",
    chi: "Chinese (chi)",
    zh: "Chinese (zh)",
    eng: "English (eng)",
    en: "English (en)",
    jpn: "Japanese (jpn)",
    kor: "Korean (kor)",
    fra: "French (fra)",
    fre: "French (fre)",
    deu: "German (deu)",
    ger: "German (ger)",
    spa: "Spanish (spa)",
    und: "Undefined (und)",
  };
  return (locale === "zh-CN" ? mapZh[lower] : mapEn[lower]) ?? lang;
}

export function formatAudioTrackSummary(track: AudioStreamInfo, locale: Locale): string {
  const parts: string[] = [
    locale === "zh-CN" ? `音轨 ${track.audioTrackIndex + 1}` : `Track ${track.audioTrackIndex + 1}`,
  ];
  if (track.language) {
    parts.push(formatLanguageName(track.language, locale));
  }
  if (track.title) {
    parts.push(track.title);
  }
  if (track.codecName) {
    parts.push(track.codecName.toUpperCase());
  }
  if (track.channels != null) {
    parts.push(`${track.channels}ch`);
  }
  if (track.sampleRateHz != null) {
    parts.push(`${(track.sampleRateHz / 1000).toFixed(1).replace(/\.0$/, "")} kHz`);
  }
  return parts.join(" · ");
}

export function getParentDir(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
  return idx > 0 ? filePath.slice(0, idx) : "";
}

export function getFileName(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
  return idx >= 0 ? filePath.slice(idx + 1) : filePath;
}

export function getFileStemAndExt(filePath: string): { stem: string; ext: string } {
  const name = getFileName(filePath);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return { stem: name, ext: "" };
  }
  return { stem: name.slice(0, dot), ext: name.slice(dot + 1).toLowerCase() };
}

export function suggestMediaOutputPath(
  sourcePath: string,
  suffix: string,
  overrideExt?: string,
): string {
  const dir = getParentDir(sourcePath);
  const sep = sourcePath.includes("\\") ? "\\" : "/";
  const { stem, ext } = getFileStemAndExt(sourcePath);
  const finalExt = (overrideExt ?? ext) || "mp4";
  const filename = `${stem}${suffix}.${finalExt}`;
  return dir ? `${dir}${sep}${filename}` : filename;
}
