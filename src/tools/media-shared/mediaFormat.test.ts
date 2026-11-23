import { describe, expect, it } from "vitest";
import {
  formatBitrateLabel,
  formatDurationLabel,
  formatFrameRateLabel,
  formatOrientationLabel,
  formatTimecode,
  parseTimecodeInput,
  suggestMediaOutputPath,
} from "./mediaFormat";

describe("mediaFormat helpers", () => {
  it("renders missing or unknown values honestly instead of zero", () => {
    expect(formatDurationLabel(null, "zh-CN")).toBe("未知");
    expect(formatDurationLabel(undefined, "en-US")).toBe("Unknown");
    expect(formatDurationLabel(0, "zh-CN")).toBe("未知");
    expect(formatBitrateLabel(null, "zh-CN")).toBe("未知");
    expect(formatFrameRateLabel(null, null, null, "en-US")).toBe("Unknown");
    expect(formatFrameRateLabel(24.35, 30, true, "zh-CN")).toContain("VFR");
    expect(formatFrameRateLabel(null, 30, true, "en-US")).toContain("VFR");
  });

  it("formats and parses timecodes cleanly", () => {
    expect(formatTimecode(1.25)).toBe("00:01.250");
    expect(formatTimecode(3661.5)).toBe("01:01:01.500");
    expect(parseTimecodeInput("1.5")).toBe(1.5);
    expect(parseTimecodeInput("01:02.250")).toBeCloseTo(62.25, 6);
    expect(parseTimecodeInput("01:02:03.5")).toBeCloseTo(3723.5, 6);
    expect(parseTimecodeInput("-5")).toBeNull();
    expect(parseTimecodeInput("01:65")).toBeNull();
  });

  it("formats orientation and suggests non-colliding sibling output paths", () => {
    expect(formatOrientationLabel("portrait", 90, "zh-CN")).toContain("竖屏");
    expect(formatOrientationLabel("portrait", 90, "zh-CN")).toContain("90°");
    expect(suggestMediaOutputPath("C:\\Videos\\测试 01.mkv", "_trim", "mp4")).toBe(
      "C:\\Videos\\测试 01_trim.mp4",
    );
  });
});
