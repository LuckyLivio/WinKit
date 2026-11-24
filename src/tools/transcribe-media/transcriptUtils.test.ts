import { describe, expect, it } from "vitest";
import {
  formatEditableTimestamp,
  formatSrtTimestamp,
  formatTranscriptAsSrt,
  formatTranscriptAsTxt,
  parseTimestampInput,
  sortAndResolveSegmentOverlaps,
  suggestTranscriptExportPath,
  validateTranscriptSegments,
} from "./transcriptUtils";

describe("T01 transcript utilities", () => {
  it("formats and parses SRT and editable timestamps accurately", () => {
    expect(formatSrtTimestamp(0)).toBe("00:00:00,000");
    expect(formatSrtTimestamp(65.432)).toBe("00:01:05,432");
    expect(formatSrtTimestamp(3661.007)).toBe("01:01:01,007");
    expect(formatEditableTimestamp(65.432)).toBe("01:05.432");
    expect(formatEditableTimestamp(3661.007)).toBe("01:01:01.007");

    expect(parseTimestampInput("00:01:05,432")).toBe(65.432);
    expect(parseTimestampInput("01:05.432")).toBe(65.432);
    expect(parseTimestampInput("02:10")).toBe(130);
    expect(parseTimestampInput("12.75")).toBe(12.75);
    expect(parseTimestampInput("00:65:00")).toBeNull();
    expect(parseTimestampInput("bad")).toBeNull();
    expect(parseTimestampInput("-1.5")).toBeNull();
  });

  it("validates subtitle ordering strictly and auto-fixes overlaps cleanly", () => {
    const valid = validateTranscriptSegments([
      { id: 1, startSec: 0.5, endSec: 4.0, text: "第一段中文" },
      { id: 2, startSec: 4.0, endSec: 8.2, text: "Second English line" },
    ]);
    expect(valid.valid).toBe(true);
    expect(valid.nonEmptyCount).toBe(2);

    const broken = [
      { id: 1, startSec: 5.0, endSec: 8.0, text: "Later cue" },
      { id: 2, startSec: 2.0, endSec: 6.0, text: "Earlier overlapping cue" },
      { id: 3, startSec: 9.0, endSec: 9.0, text: "Zero duration cue" },
    ];
    const check = validateTranscriptSegments(broken);
    expect(check.valid).toBe(false);
    expect(check.issues.map((i) => i.kind)).toEqual(["out_of_order", "end_before_start"]);

    const fixed = sortAndResolveSegmentOverlaps(broken);
    const recheck = validateTranscriptSegments(fixed);
    expect(recheck.valid).toBe(true);
    expect(fixed[0]!.text).toBe("Earlier overlapping cue");
    expect(fixed[1]!.startSec).toBeGreaterThanOrEqual(fixed[0]!.endSec);
    expect(fixed[2]!.endSec).toBeGreaterThan(fixed[2]!.startSec);
  });

  it("formats standard CRLF SRT and plain/timestamped TXT", () => {
    const segs = [
      { id: 1, startSec: 2.42, endSec: 7.5, text: "欢迎使用 WinKit" },
      { id: 2, startSec: 8.0, endSec: 12.1, text: "Offline transcription works." },
    ];
    const srt = formatTranscriptAsSrt(segs);
    expect(srt).toContain("1\r\n00:00:02,420 --> 00:00:07,500\r\n欢迎使用 WinKit\r\n");
    expect(srt).toContain("2\r\n00:00:08,000 --> 00:00:12,100\r\nOffline transcription works.\r\n");

    expect(formatTranscriptAsTxt(segs, false)).toBe(
      "欢迎使用 WinKit\r\nOffline transcription works.",
    );
    expect(formatTranscriptAsTxt(segs, true)).toContain(
      "[00:00:02,420 -> 00:00:07,500] 欢迎使用 WinKit",
    );
  });

  it("suggests safe non-overwriting sibling output paths for TXT and SRT", () => {
    expect(suggestTranscriptExportPath("D:\\会议 录音\\demo.mp4", "srt")).toBe(
      "D:\\会议 录音\\demo.srt",
    );
    expect(suggestTranscriptExportPath("D:\\会议 录音\\demo.wav", "txt")).toBe(
      "D:\\会议 录音\\demo_transcript.txt",
    );
  });
});
