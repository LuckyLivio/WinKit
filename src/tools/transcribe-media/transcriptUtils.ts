import type { TranscriptExportFormat, TranscriptSegment } from "../../lib/tauriBridge";
import { getFileStemAndExt, getParentDir } from "../media-shared/mediaFormat";

export const TRANSCRIBE_AUDIO_EXTENSIONS = [
  "wav",
  "mp3",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "opus",
  "wma",
] as const;

export const TRANSCRIBE_VIDEO_EXTENSIONS = [
  "mp4",
  "mkv",
  "mov",
  "webm",
  "avi",
  "m4v",
  "ts",
  "wmv",
] as const;

export const TRANSCRIBE_MEDIA_EXTENSIONS = [
  ...TRANSCRIBE_AUDIO_EXTENSIONS,
  ...TRANSCRIBE_VIDEO_EXTENSIONS,
] as const;

/**
 * Clean decoupled handoff contracts for future `A02` (Audio Recorder -> `T01`)
 * and `V02` (`T01` exported `.srt` -> Add Subtitles) workflows.
 */
export interface TranscribeIncomingHandoff {
  sourceToolId: "A02" | "V01" | "A04" | "external";
  mediaPath: string;
}

export interface SubtitleOutgoingHandoff {
  targetToolId: "V02";
  srtPath: string;
}

export type SegmentOrderIssueKind =
  "empty_list" | "non_finite" | "negative_start" | "end_before_start" | "out_of_order" | "overlap";

export interface SegmentOrderIssue {
  segmentIndex: number;
  cueNumber: number;
  kind: SegmentOrderIssueKind;
}

export interface SegmentValidationResult {
  valid: boolean;
  nonEmptyCount: number;
  issues: SegmentOrderIssue[];
  issueIndexSet: Set<number>;
}

export function formatSrtTimestamp(sec: number): string {
  const totalMs = Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : 0;
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function formatEditableTimestamp(sec: number): string {
  const totalMs = Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : 0;
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

/**
 * Parses `HH:MM:SS,mmm`, `HH:MM:SS.mmm`, `MM:SS.mmm`, `MM:SS`, or plain seconds (`12.5`).
 * Returns finite non-negative seconds rounded to milliseconds, or `null` when invalid.
 */
export function parseTimestampInput(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (!trimmed) return null;

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const val = Number(trimmed);
    return Number.isFinite(val) && val >= 0 ? Math.round(val * 1000) / 1000 : null;
  }

  const parts = trimmed.split(":");
  if (parts.length !== 2 && parts.length !== 3) return null;
  if (parts.some((p) => p.trim() === "")) return null;

  let hours = 0;
  let minutes: number;
  let seconds: number;

  if (parts.length === 2) {
    if (!/^\d+$/.test(parts[0]!) || !/^\d+(?:\.\d+)?$/.test(parts[1]!)) return null;
    minutes = Number(parts[0]);
    seconds = Number(parts[1]);
  } else {
    if (
      !/^\d+$/.test(parts[0]!) ||
      !/^\d+$/.test(parts[1]!) ||
      !/^\d+(?:\.\d+)?$/.test(parts[2]!)
    ) {
      return null;
    }
    hours = Number(parts[0]);
    minutes = Number(parts[1]);
    seconds = Number(parts[2]);
    if (minutes >= 60) return null;
  }

  if (seconds >= 60) return null;
  const total = hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(total) && total >= 0 ? Math.round(total * 1000) / 1000 : null;
}

/**
 * Strictly validates non-empty transcript segments for SRT subtitle compliance:
 * non-negative start, `end > start`, monotonic start times, and zero overlaps.
 */
export function validateTranscriptSegments(segments: TranscriptSegment[]): SegmentValidationResult {
  const issues: SegmentOrderIssue[] = [];
  const issueIndexSet = new Set<number>();

  let prevStart = -1;
  let prevEnd = -1;
  let nonEmptyCount = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (!seg.text.trim()) continue;
    nonEmptyCount += 1;
    const cueNumber = nonEmptyCount;

    if (!Number.isFinite(seg.startSec) || !Number.isFinite(seg.endSec)) {
      issues.push({ segmentIndex: i, cueNumber, kind: "non_finite" });
      issueIndexSet.add(i);
      continue;
    }
    if (seg.startSec < 0) {
      issues.push({ segmentIndex: i, cueNumber, kind: "negative_start" });
      issueIndexSet.add(i);
    }
    if (seg.endSec <= seg.startSec) {
      issues.push({ segmentIndex: i, cueNumber, kind: "end_before_start" });
      issueIndexSet.add(i);
    }
    if (nonEmptyCount > 1) {
      if (seg.startSec + 1e-6 < prevStart) {
        issues.push({ segmentIndex: i, cueNumber, kind: "out_of_order" });
        issueIndexSet.add(i);
      } else if (seg.startSec + 1e-6 < prevEnd) {
        issues.push({ segmentIndex: i, cueNumber, kind: "overlap" });
        issueIndexSet.add(i);
      }
    }
    prevStart = seg.startSec;
    prevEnd = seg.endSec;
  }

  if (nonEmptyCount === 0) {
    issues.push({ segmentIndex: -1, cueNumber: 0, kind: "empty_list" });
  }

  return {
    valid: issues.length === 0,
    nonEmptyCount,
    issues,
    issueIndexSet,
  };
}

export function formatTranscriptAsSrt(segments: TranscriptSegment[]): string {
  const nonEmpty = segments.filter((s) => s.text.trim().length > 0);
  return nonEmpty
    .map((seg, idx) => {
      const start = formatSrtTimestamp(seg.startSec);
      const end = formatSrtTimestamp(seg.endSec);
      const body = seg.text.trim().replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      return `${idx + 1}\r\n${start} --> ${end}\r\n${body}\r\n`;
    })
    .join("\r\n");
}

export function formatTranscriptAsTxt(
  segments: TranscriptSegment[],
  includeTimestamps: boolean,
): string {
  const nonEmpty = segments.filter((s) => s.text.trim().length > 0);
  return nonEmpty
    .map((seg) => {
      const body = seg.text.trim();
      if (!includeTimestamps) return body;
      return `[${formatSrtTimestamp(seg.startSec)} -> ${formatSrtTimestamp(seg.endSec)}] ${body}`;
    })
    .join("\r\n");
}

/**
 * Sorts segments chronologically by start time and trims/clamps any overlaps so every cue
 * satisfies `0 <= start < end` and `seg[i].start >= seg[i - 1].end`.
 */
export function sortAndResolveSegmentOverlaps(segments: TranscriptSegment[]): TranscriptSegment[] {
  const sorted = [...segments]
    .map((s) => ({
      ...s,
      startSec: Number.isFinite(s.startSec) && s.startSec >= 0 ? s.startSec : 0,
      endSec: Number.isFinite(s.endSec) && s.endSec >= 0 ? s.endSec : 0,
    }))
    .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);

  let prevEnd = 0;
  return sorted.map((seg, idx) => {
    const startSec = idx === 0 ? seg.startSec : Math.max(seg.startSec, prevEnd);
    const endSec = Math.max(seg.endSec, startSec + 0.1);
    const roundedStart = Math.round(startSec * 1000) / 1000;
    const roundedEnd = Math.round(endSec * 1000) / 1000;
    prevEnd = roundedEnd;
    return {
      ...seg,
      id: idx + 1,
      startSec: roundedStart,
      endSec: roundedEnd,
    };
  });
}

export function suggestTranscriptExportPath(
  sourcePath: string,
  format: TranscriptExportFormat,
): string {
  const dir = getParentDir(sourcePath);
  const { stem } = getFileStemAndExt(sourcePath);
  const sep = sourcePath.includes("\\") ? "\\" : "/";
  const ext = format === "srt" ? "srt" : "txt";
  const suffix = format === "srt" ? "" : "_transcript";
  const fileName = `${stem || "transcript"}${suffix}.${ext}`;
  return dir ? `${dir}${sep}${fileName}` : fileName;
}

export function isSupportedTranscribeMediaPath(path: string): boolean {
  const { ext } = getFileStemAndExt(path);
  return (TRANSCRIBE_MEDIA_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

export function computeSegmentsDigestKey(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => `${s.startSec.toFixed(3)}|${s.endSec.toFixed(3)}|${s.text.trim()}`)
    .join("\n");
}
