import type { BeautifierAspect } from "../../lib/sessionStore";

export const MAX_INPUT_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_SOURCE_DIMENSION = 8192;
export const MAX_SOURCE_PIXELS = 33_554_432;
export const MAX_OUTPUT_DIMENSION = 10000;
export const MAX_OUTPUT_PIXELS = 48_000_000;

export const PRESET_SOLID_BACKGROUNDS: Array<{ hex: string; labelZh: string; labelEn: string }> = [
  { hex: "#E8ECF2", labelZh: "冷雾灰", labelEn: "Cool Mist" },
  { hex: "#DDE5F0", labelZh: "石板浅蓝", labelEn: "Soft Slate" },
  { hex: "#E5EAE6", labelZh: "鼠尾草灰", labelEn: "Muted Sage" },
  { hex: "#EDE8E1", labelZh: "暖砂灰", labelEn: "Warm Sand" },
  { hex: "#FFFFFF", labelZh: "纯白", labelEn: "Pure White" },
  { hex: "#232933", labelZh: "深石墨", labelEn: "Deep Graphite" },
  { hex: "#151921", labelZh: "暗夜炭黑", labelEn: "Charcoal" },
];

export interface FrameLayoutMetrics {
  canvasWidth: number;
  canvasHeight: number;
  imageX: number;
  imageY: number;
  imageWidth: number;
  imageHeight: number;
  effectiveRadius: number;
  shadowBlur: number;
  shadowOffsetY: number;
  shadowOpacity: number;
  exceedsLimits: boolean;
}

export function normalizeHexColor(input: string): string | null {
  const cleaned = input.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(cleaned)) {
    return cleaned.toUpperCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    return `#${cleaned.toUpperCase()}`;
  }
  return null;
}

export function computeFrameLayout(params: {
  sourceWidth: number;
  sourceHeight: number;
  padding: number;
  cornerRadius: number;
  shadowStrength: number;
  aspectRatio: BeautifierAspect;
}): FrameLayoutMetrics {
  const srcW = Math.max(1, Math.round(params.sourceWidth));
  const srcH = Math.max(1, Math.round(params.sourceHeight));
  const pad = Math.max(0, Math.min(240, Math.round(params.padding)));
  const rawRadius = Math.max(0, Math.min(160, Math.round(params.cornerRadius)));
  const strength = Math.max(0, Math.min(100, Math.round(params.shadowStrength)));

  const baseW = srcW + 2 * pad;
  const baseH = srcH + 2 * pad;

  let canvasWidth = baseW;
  let canvasHeight = baseH;

  if (params.aspectRatio === "1:1") {
    const side = Math.max(baseW, baseH);
    canvasWidth = side;
    canvasHeight = side;
  } else if (params.aspectRatio === "16:9") {
    if (baseW * 9 >= baseH * 16) {
      canvasWidth = baseW;
      canvasHeight = Math.max(baseH, Math.round((baseW * 9) / 16));
    } else {
      canvasHeight = baseH;
      canvasWidth = Math.max(baseW, Math.round((baseH * 16) / 9));
    }
  }

  const imageX = Math.floor((canvasWidth - srcW) / 2);
  const imageY = Math.floor((canvasHeight - srcH) / 2);
  const effectiveRadius = Math.min(rawRadius, Math.floor(Math.min(srcW, srcH) / 2));

  const shadowBlur = strength > 0 ? Math.round(strength * 0.45) : 0;
  const shadowOffsetY = strength > 0 ? Math.round(strength * 0.18) : 0;
  const shadowOpacity = strength > 0 ? Math.min(0.55, (strength / 100) * 0.48) : 0;

  const exceedsLimits =
    srcW > MAX_SOURCE_DIMENSION ||
    srcH > MAX_SOURCE_DIMENSION ||
    srcW * srcH > MAX_SOURCE_PIXELS ||
    canvasWidth > MAX_OUTPUT_DIMENSION ||
    canvasHeight > MAX_OUTPUT_DIMENSION ||
    canvasWidth * canvasHeight > MAX_OUTPUT_PIXELS;

  return {
    canvasWidth,
    canvasHeight,
    imageX,
    imageY,
    imageWidth: srcW,
    imageHeight: srcH,
    effectiveRadius,
    shadowBlur,
    shadowOffsetY,
    shadowOpacity,
    exceedsLimits,
  };
}
