import { describe, expect, it } from "vitest";
import {
  evaluateWcagContrast,
  findNearestTailwindColor,
  formatAllColorOutputs,
  parseColorInput,
  rgbToHsl,
  rgbToOklch,
} from "./colorEngine";

describe("I10 colorEngine conversions, formats, Tailwind matching, and WCAG 2.x contrast", () => {
  it("distinguishes CSS #RRGGBBAA from WinUI/XAML #AARRGGBB for translucent colors and formats all 8 targets", () => {
    // 50.2% alpha (0x80 = 128) vibrant crimson #E11D48
    const out = formatAllColorOutputs({ r: 0xe1, g: 0x1d, b: 0x48, a: 128 / 255 });

    expect(out.hex).toBe("#E11D4880");
    expect(out.hexNote).toBe("css_rrggbbaa");
    expect(out.css).toBe("color: #E11D4880;");
    // WinUI/XAML MUST be alpha-first (#AARRGGBB)!
    expect(out.winuiXaml).toBe("#80E11D48");
    expect(out.csharp).toBe("Color.FromArgb(128, 225, 29, 72)");
    expect(out.rgb).toBe("rgba(225, 29, 72, 0.5)");
    expect(out.hsl).toMatch(/^hsla\(/);
    expect(out.oklch).toMatch(/^oklch\(/);
    expect(out.tailwindExact).toBe("bg-[#E11D4880]");
    expect(out.tailwindNearest.token).toBe("rose-600");
    expect(out.tailwindNearest.exactMatch).toBe(false); // translucent differs from opaque rose-600
  });

  it("provides both exact arbitrary Tailwind value and closest named Tailwind token clearly marked approximate", () => {
    // Non-Tailwind custom shade near blue-600 (#2563EB)
    const custom = formatAllColorOutputs({ r: 0x26, g: 0x65, b: 0xe8, a: 1 });
    expect(custom.tailwindExact).toBe("bg-[#2665E8]");
    expect(custom.tailwindNearest.token).toBe("blue-600");
    expect(custom.tailwindNearest.exactMatch).toBe(false);
    expect(custom.tailwindNearest.deltaE).toBeGreaterThan(0);

    // Exact Tailwind blue-600
    const exact = findNearestTailwindColor({ r: 0x25, g: 0x63, b: 0xeb, a: 1 });
    expect(exact.token).toBe("blue-600");
    expect(exact.exactMatch).toBe(true);
    expect(exact.deltaE).toBe(0);
  });

  it("parses CSS #RRGGBBAA, WinUI #AARRGGBB, rgb(), hsl(), oklch(), and C# Color.FromArgb accurately", () => {
    expect(parseColorInput("#11223380", "css_rgba")).toEqual({
      r: 0x11,
      g: 0x22,
      b: 0x33,
      a: 0.502,
    });
    expect(parseColorInput("#80112233", "xaml_argb")).toEqual({
      r: 0x11,
      g: 0x22,
      b: 0x33,
      a: 0.502,
    });
    expect(parseColorInput("rgba(37, 99, 235, 0.5)")).toEqual({
      r: 37,
      g: 99,
      b: 235,
      a: 0.5,
    });
    expect(parseColorInput("Color.FromArgb(128, 37, 99, 235)")).toEqual({
      r: 37,
      g: 99,
      b: 235,
      a: 0.502,
    });

    const hsl = rgbToHsl(37, 99, 235);
    expect(Math.round(hsl.h)).toBe(221);
    const ok = rgbToOklch(37, 99, 235);
    expect(ok.L).toBeCloseTo(0.546, 2);
    const roundtripOk = parseColorInput(
      `oklch(${ok.L.toFixed(4)} ${ok.C.toFixed(4)} ${ok.H.toFixed(2)})`,
    );
    expect(roundtripOk).not.toBeNull();
    expect(Math.abs(roundtripOk!.r - 37)).toBeLessThanOrEqual(1);
    expect(Math.abs(roundtripOk!.g - 99)).toBeLessThanOrEqual(1);
    expect(Math.abs(roundtripOk!.b - 235)).toBeLessThanOrEqual(1);
  });

  it("computes exact WCAG 2.x ratios for black/white 21:1, same-color 1:1, unrounded AA 4.5:1 boundary, and translucent foreground compositing", () => {
    // 1. Black on White = exact 21:1
    const bw = evaluateWcagContrast({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 });
    expect(bw.ratio).toBeCloseTo(21, 6);
    expect(bw.displayRatio).toBe("21.00:1");
    expect(bw.aaNormal).toBe(true);
    expect(bw.aaaNormal).toBe(true);
    expect(bw.aaLarge).toBe(true);
    expect(bw.aaaLarge).toBe(true);

    // 2. Identical color = exact 1:1
    const same = evaluateWcagContrast(
      { r: 37, g: 99, b: 235, a: 1 },
      { r: 37, g: 99, b: 235, a: 1 },
    );
    expect(same.ratio).toBeCloseTo(1, 6);
    expect(same.displayRatio).toBe("1.00:1");
    expect(same.aaNormal).toBe(false);
    expect(same.aaLarge).toBe(false);

    // 3. Strict unrounded AA 4.5:1 boundary test:
    // #77767C on #FFFFFF has exact ratio ~4.499863 (would round to 4.50 if rounded to 2 decimals,
    // yet MUST FAIL AA normal and AAA large because unrounded ratio < 4.5!)
    // #777777 on #FFFFFF has exact ratio ~4.4781 (< 4.5 -> FAIL AA normal, PASS AA large)
    // #767676 on #FFFFFF has exact ratio ~4.5421 (>= 4.5 -> PASS AA normal, PASS AAA large)
    const ultraTightBelow = evaluateWcagContrast(
      { r: 0x77, g: 0x76, b: 0x7c, a: 1 },
      { r: 255, g: 255, b: 255, a: 1 },
    );
    const justBelow = evaluateWcagContrast(
      { r: 0x77, g: 0x77, b: 0x77, a: 1 },
      { r: 255, g: 255, b: 255, a: 1 },
    );
    const justAbove = evaluateWcagContrast(
      { r: 0x76, g: 0x76, b: 0x76, a: 1 },
      { r: 255, g: 255, b: 255, a: 1 },
    );

    expect(ultraTightBelow.ratio).toBeGreaterThan(4.495);
    expect(ultraTightBelow.ratio).toBeLessThan(4.5);
    expect(ultraTightBelow.aaNormal).toBe(false);
    expect(ultraTightBelow.aaaLarge).toBe(false);
    expect(ultraTightBelow.aaLarge).toBe(true);
    // Truncated display never falsely says "4.50:1" on a failing pair
    expect(ultraTightBelow.displayRatio).toBe("4.49:1");

    expect(justBelow.ratio).toBeLessThan(4.5);
    expect(justBelow.aaNormal).toBe(false);
    expect(justAbove.ratio).toBeGreaterThanOrEqual(4.5);
    expect(justAbove.aaNormal).toBe(true);
    expect(justAbove.aaaLarge).toBe(true);
    expect(justAbove.aaaNormal).toBe(false);

    // 4. Translucent foreground compositing over background:
    // Black at 50% alpha over white composites to mid-gray (~127.5, 127.5, 127.5 -> ~3.95:1, fails AA normal, passes AA large)
    const halfBlack = evaluateWcagContrast(
      { r: 0, g: 0, b: 0, a: 0.5 },
      { r: 255, g: 255, b: 255, a: 1 },
    );
    expect(halfBlack.foregroundWasComposited).toBe(true);
    expect(halfBlack.compositedForeground.r).toBe(128);
    expect(halfBlack.ratio).toBeGreaterThan(3.9);
    expect(halfBlack.ratio).toBeLessThan(4.1);
    expect(halfBlack.aaLarge).toBe(true);
    expect(halfBlack.aaNormal).toBe(false);
  });
});
