import { describe, expect, it } from "vitest";
import { computeFrameLayout, normalizeHexColor } from "./layout";

describe("I03 shared frame layout engine", () => {
  it("computes original, 1:1, and 16:9 canvas sizes without stretching landscape or portrait images", () => {
    // Landscape 1600x900 + padding 40 -> base 1680x980
    const orig = computeFrameLayout({
      sourceWidth: 1600,
      sourceHeight: 900,
      padding: 40,
      cornerRadius: 12,
      shadowStrength: 28,
      aspectRatio: "original",
    });
    expect(orig.canvasWidth).toBe(1680);
    expect(orig.canvasHeight).toBe(980);
    expect(orig.imageWidth).toBe(1600);
    expect(orig.imageHeight).toBe(900);
    expect(orig.imageX).toBe(40);
    expect(orig.imageY).toBe(40);
    expect(orig.exceedsLimits).toBe(false);

    // Portrait 600x1000 + padding 40 -> base 680x1080 -> 16:9 becomes 1920x1080
    const portraitWide = computeFrameLayout({
      sourceWidth: 600,
      sourceHeight: 1000,
      padding: 40,
      cornerRadius: 20,
      shadowStrength: 0,
      aspectRatio: "16:9",
    });
    expect(portraitWide.canvasWidth).toBe(1920);
    expect(portraitWide.canvasHeight).toBe(1080);
    expect(portraitWide.imageWidth).toBe(600);
    expect(portraitWide.imageHeight).toBe(1000);
    expect(portraitWide.imageX).toBe(660);
    expect(portraitWide.imageY).toBe(40);
    expect(portraitWide.shadowBlur).toBe(0);

    // 1:1 square
    const square = computeFrameLayout({
      sourceWidth: 600,
      sourceHeight: 1000,
      padding: 40,
      cornerRadius: 500,
      shadowStrength: 50,
      aspectRatio: "1:1",
    });
    expect(square.canvasWidth).toBe(1080);
    expect(square.canvasHeight).toBe(1080);
    expect(square.effectiveRadius).toBe(160); // clamped to slider bound <= min(w,h)/2

    // 4:5 portrait social frame on 1000x600 + padding 40 -> base 1080x680 -> 1080x1350
    const portrait45 = computeFrameLayout({
      sourceWidth: 1000,
      sourceHeight: 600,
      padding: 40,
      cornerRadius: 16,
      shadowStrength: 20,
      aspectRatio: "4:5",
    });
    expect(portrait45.canvasWidth).toBe(1080);
    expect(portrait45.canvasHeight).toBe(1350);
    expect(portrait45.imageWidth).toBe(1000);
    expect(portrait45.imageHeight).toBe(600);
    expect(portrait45.exceedsLimits).toBe(false);

    // 9:16 story frame on 800x600 + padding 50 -> base 900x700 -> 900x1600
    const story916 = computeFrameLayout({
      sourceWidth: 800,
      sourceHeight: 600,
      padding: 50,
      cornerRadius: 12,
      shadowStrength: 24,
      aspectRatio: "9:16",
    });
    expect(story916.canvasWidth).toBe(900);
    expect(story916.canvasHeight).toBe(1600);
    expect(story916.exceedsLimits).toBe(false);

    // Ultra-tall scrolling capture (800x10000) stays within safety bounds in original mode
    const ultraTall = computeFrameLayout({
      sourceWidth: 800,
      sourceHeight: 10000,
      padding: 40,
      cornerRadius: 12,
      shadowStrength: 20,
      aspectRatio: "original",
    });
    expect(ultraTall.canvasWidth).toBe(880);
    expect(ultraTall.canvasHeight).toBe(10080);
    expect(ultraTall.exceedsLimits).toBe(false);
  });

  it("flags oversized canvases that exceed safety pixel bounds", () => {
    const huge = computeFrameLayout({
      sourceWidth: 7500,
      sourceHeight: 7500,
      padding: 100,
      cornerRadius: 12,
      shadowStrength: 20,
      aspectRatio: "original",
    });
    expect(huge.exceedsLimits).toBe(true);
  });

  it("validates 6-digit hex color strings", () => {
    expect(normalizeHexColor("#e8ecf2")).toBe("#E8ECF2");
    expect(normalizeHexColor("2458d3")).toBe("#2458D3");
    expect(normalizeHexColor("#xyz")).toBeNull();
  });
});
