import { describe, expect, it } from "vitest";
import {
  computeResizeTargetDimensions,
  computeRotatedDimensions,
  formatImageBytes,
  formatImageFormatLabel,
  formatImageWarningText,
  mergeInspectedItems,
  targetFormatFlattensAlpha,
  targetFormatSupportsQuality,
  type InspectedImageItem,
} from "./imageBatchModel";

describe("imageBatchModel", () => {
  it("identifies quality support and alpha-flattening formats accurately", () => {
    expect(targetFormatSupportsQuality("jpeg", false)).toBe(true);
    expect(targetFormatSupportsQuality("webp", false)).toBe(true);
    expect(targetFormatSupportsQuality("webp", true)).toBe(false);
    expect(targetFormatSupportsQuality("png", false)).toBe(false);
    expect(targetFormatSupportsQuality("tiff", false)).toBe(false);
    expect(targetFormatSupportsQuality("bmp", false)).toBe(false);
    expect(targetFormatSupportsQuality("heic", false)).toBe(true);

    expect(targetFormatFlattensAlpha("jpeg")).toBe(true);
    expect(targetFormatFlattensAlpha("bmp")).toBe(true);
    expect(targetFormatFlattensAlpha("png")).toBe(false);
    expect(targetFormatFlattensAlpha("webp")).toBe(false);
  });

  it("formats bytes, format labels, warnings, and deduplicates incoming batch items case-insensitively", () => {
    expect(formatImageBytes(512)).toBe("512 B");
    expect(formatImageBytes(2048)).toBe("2.0 KiB");
    expect(formatImageFormatLabel("heic")).toBe("HEIC");
    expect(formatImageWarningText("animated_first_frame_only", "zh-CN")).toContain("首帧");
    expect(formatImageWarningText("multipage_tiff_first_page_only", "en-US")).toContain("page 1");

    const base: InspectedImageItem = {
      path: "D:\\Photos\\A.PNG",
      fileName: "A.PNG",
      byteLength: 100,
      format: "png",
      rawWidth: 10,
      rawHeight: 10,
      exifOrientation: 1,
      displayWidth: 10,
      displayHeight: 10,
      hasAlpha: true,
      isAnimated: false,
      pageCount: 1,
      hasIccProfile: false,
      metadataFlags: {
        hasExif: false,
        hasGps: false,
        hasXmp: false,
        hasIptc: false,
        hasIcc: false,
        hasComments: false,
        hasCameraInfo: false,
        hasDatetime: false,
        duplicateSegmentCount: 0,
        tagHighlights: [],
      },
      thumbnailDataUrl: null,
      warnings: [],
      error: null,
    };
    const dup = { ...base, path: "d:\\photos\\a.png" };
    const second = { ...base, path: "D:\\Photos\\B.JPG", fileName: "B.JPG" };
    const merged = mergeInspectedItems([base], [dup, second]);
    expect(merged.map((m) => m.fileName)).toEqual(["A.PNG", "B.JPG"]);
  });

  it("computes resize target dimensions respecting aspect ratio, preventUpscale, and portrait display sizes", () => {
    // Portrait display size 1000x2000 -> longest edge 1000 => 500x1000
    expect(
      computeResizeTargetDimensions(1000, 2000, {
        mode: "longest_edge",
        percentage: 50,
        longestEdge: 1000,
        targetWidth: 800,
        targetHeight: 800,
        keepAspectRatio: true,
        preventUpscale: true,
      }),
    ).toEqual({ width: 500, height: 1000, unchanged: false });

    // Small 400x300 under longestEdge=1200 with preventUpscale=true stays 400x300
    expect(
      computeResizeTargetDimensions(400, 300, {
        mode: "longest_edge",
        percentage: 50,
        longestEdge: 1200,
        targetWidth: 800,
        targetHeight: 800,
        keepAspectRatio: true,
        preventUpscale: true,
      }),
    ).toEqual({ width: 400, height: 300, unchanged: true });

    // Exact 800x400 -> target 400x400 with keepAspectRatio=true => 400x200; false => 400x400
    expect(
      computeResizeTargetDimensions(800, 400, {
        mode: "exact",
        percentage: 50,
        longestEdge: 1200,
        targetWidth: 400,
        targetHeight: 400,
        keepAspectRatio: true,
        preventUpscale: true,
      }),
    ).toEqual({ width: 400, height: 200, unchanged: false });
    expect(
      computeResizeTargetDimensions(800, 400, {
        mode: "exact",
        percentage: 50,
        longestEdge: 1200,
        targetWidth: 400,
        targetHeight: 400,
        keepAspectRatio: false,
        preventUpscale: true,
      }),
    ).toEqual({ width: 400, height: 400, unchanged: false });

    // Rotated dimensions track 90-degree swaps
    expect(computeRotatedDimensions(800, 600, ["rotate_right", "flip_horizontal"])).toEqual({
      width: 600,
      height: 800,
    });
  });
});
