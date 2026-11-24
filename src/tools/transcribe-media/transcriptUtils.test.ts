import { describe, expect, it } from "vitest";
import {
  formatEditableTimestamp,
  formatSrtTimestamp,
  formatTranscriptAsSrt,
  formatTranscriptAsTxt,
  parseTimestampInput,
  resolvePreviewSeekTime,
  sanitizeSrtCueText,
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
    expect(srt).toBe(
      "1\r\n00:00:02,420 --> 00:00:07,500\r\n欢迎使用 WinKit\r\n\r\n" +
        "2\r\n00:00:08,000 --> 00:00:12,100\r\nOffline transcription works.\r\n\r\n",
    );

    expect(formatTranscriptAsTxt(segs, false)).toBe(
      "欢迎使用 WinKit\r\nOffline transcription works.",
    );
    expect(formatTranscriptAsTxt(segs, true)).toContain(
      "[00:00:02,420 -> 00:00:07,500] 欢迎使用 WinKit",
    );
  });

  it("preserves normal multi-line subtitles while stripping blank and whitespace-only lines identically to Rust", () => {
    expect(
      sanitizeSrtCueText(
        "\n  \t  \n第一行中文  \r\n\r\n   \n\u3000\u3000\nSecond English line\t\n\n",
      ),
    ).toBe("第一行中文\r\nSecond English line");

    const segs = [
      {
        id: 1,
        startSec: 0.5,
        endSec: 3.5,
        text: "欢迎使用 WinKit 离线转写\n\n   \n\t\n\u3000\nOffline transcription on Windows 11",
      },
      {
        id: 2,
        startSec: 4.0,
        endSec: 5.0,
        text: "   \n\t\n\u3000  ",
      },
      {
        id: 3,
        startSec: 6.0,
        endSec: 9.0,
        text: "第二条正常多行\r\nSecond cue line 2",
      },
    ];

    const check = validateTranscriptSegments(segs);
    expect(check.valid).toBe(true);
    expect(check.nonEmptyCount).toBe(2);

    const srt = formatTranscriptAsSrt(segs);
    expect(srt).toBe(
      "1\r\n00:00:00,500 --> 00:00:03,500\r\n欢迎使用 WinKit 离线转写\r\nOffline transcription on Windows 11\r\n\r\n" +
        "2\r\n00:00:06,000 --> 00:00:09,000\r\n第二条正常多行\r\nSecond cue line 2\r\n\r\n",
    );
    // Double-check no empty line splits a cue body: splitting by \r\n\r\n produces exactly 2 cues
    const blocks = srt.trim().split("\r\n\r\n");
    expect(blocks).toHaveLength(2);
  });

  it("suggests safe non-overwriting sibling output paths for TXT and SRT", () => {
    expect(suggestTranscriptExportPath("D:\\会议 录音\\demo.mp4", "srt")).toBe(
      "D:\\会议 录音\\demo.srt",
    );
    expect(suggestTranscriptExportPath("D:\\会议 录音\\demo.wav", "txt")).toBe(
      "D:\\会议 录音\\demo_transcript.txt",
    );
  });

  it("maps playback-zero cues accurately across Chromium container offsets, audio delays, and gaps", () => {
    // Case 1: Matroska container shifted to +10.0s where Chromium reports duration=16.347s
    expect(resolvePreviewSeekTime(0.584, 16.347, 10.0, 6.347)).toBeCloseTo(10.584, 3);
    expect(resolvePreviewSeekTime(3.2, 16.347, 10.0, 6.347)).toBeCloseTo(13.2, 3);
    // Case 1b: Container already normalized to 0 by browser (playerDuration == playbackDuration)
    expect(resolvePreviewSeekTime(0.584, 6.347, 10.0, 6.347)).toBeCloseTo(0.584, 3);
    // Case 2: Audio-only delay (+2.5s MP4 -> containerStartTimeSec == 0)
    expect(resolvePreviewSeekTime(3.05, 9.792, 0.0, 9.792)).toBeCloseTo(3.05, 3);
    // Case 3: Mid-stream audio PTS gap (MKV -> containerStartTimeSec == 0)
    expect(resolvePreviewSeekTime(8.62, 14.0, 0.0, 14.0)).toBeCloseTo(8.62, 3);
  });
});
