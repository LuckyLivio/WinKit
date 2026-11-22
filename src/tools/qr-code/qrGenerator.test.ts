import { describe, expect, it } from "vitest";
import { DEFAULT_QR_STYLE, generateQr, wifiPayload } from "./qrGenerator";

describe("QR generation", () => {
  it("escapes all Wi-Fi field delimiters, preserves Unicode, and omits open-network passwords", () => {
    const wifi = {
      ssid: '研究室;A,B:"\\',
      password: "密;码:🗝️",
      security: "WPA" as const,
      hidden: true,
    };
    expect(wifiPayload(wifi)).toBe('WIFI:T:WPA;S:研究室\\;A\\,B\\:\\"\\\\;P:密\\;码\\:🗝️;H:true;;');
    expect(wifiPayload({ ...wifi, security: "nopass" })).toBe(
      'WIFI:T:nopass;S:研究室\\;A\\,B\\:\\"\\\\;H:true;;',
    );
  });

  it("reserves four blank modules on all sides and uses exact output dimensions and colors", () => {
    const result = generateQr("ABC", {
      ...DEFAULT_QR_STYLE,
      size: 290,
      foreground: "#123456",
      background: "#fedcba",
    });
    if (!("image" in result)) throw new Error("Expected a version 1 symbol");
    const { runs, svg } = result.image;
    expect(Math.min(...runs.map((r) => r.x))).toBe(40);
    expect(Math.min(...runs.map((r) => r.y))).toBe(40);
    expect(Math.max(...runs.map((r) => r.x + r.width))).toBe(250);
    expect(Math.max(...runs.map((r) => r.y + r.height))).toBe(250);
    expect(svg).toContain('viewBox="0 0 290 290"');
    expect(svg).toContain('fill="#123456"');
    expect(svg).toContain('fill="#fedcba"');
  });

  it("distinguishes symbol capacity and rendering constraints", () => {
    expect(generateQr("", DEFAULT_QR_STYLE)).toEqual({ error: "empty" });
    expect(generateQr("😀".repeat(1000), DEFAULT_QR_STYLE)).toEqual({ error: "capacity" });
    expect(generateQr("1".repeat(7090), DEFAULT_QR_STYLE)).toEqual({ error: "capacity" });
    expect(generateQr("x".repeat(1200), { ...DEFAULT_QR_STYLE, size: 64 })).toEqual({
      error: "size",
    });
    expect(generateQr("a", { ...DEFAULT_QR_STYLE, foreground: "#ffffff" })).toEqual({
      error: "color",
    });
  });
});
