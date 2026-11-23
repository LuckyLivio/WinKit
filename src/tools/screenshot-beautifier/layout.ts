import type { BeautifierAspect } from "../../lib/sessionStore";

export const MAX_INPUT_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_SOURCE_DIMENSION = 16_384;
export const MAX_SOURCE_PIXELS = 33_554_432;
export const MAX_OUTPUT_DIMENSION = 16_800;
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

export const PRESET_GRADIENT_BACKGROUNDS: Array<{
  id: string;
  startHex: string;
  endHex: string;
  angleDeg: number;
  labelZh: string;
  labelEn: string;
}> = [
  {
    id: "soft-sky",
    startHex: "#DBEAFE",
    endHex: "#E0E7FF",
    angleDeg: 135,
    labelZh: "晴空浅蓝",
    labelEn: "Soft Sky",
  },
  {
    id: "ocean-dusk",
    startHex: "#2563EB",
    endHex: "#0F172A",
    angleDeg: 135,
    labelZh: "深海暮蓝",
    labelEn: "Ocean Dusk",
  },
  {
    id: "mint-breeze",
    startHex: "#D1FAE5",
    endHex: "#DBEAFE",
    angleDeg: 120,
    labelZh: "薄荷晴风",
    labelEn: "Mint Breeze",
  },
  {
    id: "warm-peach",
    startHex: "#FDE68A",
    endHex: "#FECACA",
    angleDeg: 135,
    labelZh: "暖阳杏桃",
    labelEn: "Warm Peach",
  },
  {
    id: "violet-mist",
    startHex: "#4F46E5",
    endHex: "#9333EA",
    angleDeg: 135,
    labelZh: "靛紫微光",
    labelEn: "Indigo Glow",
  },
  {
    id: "slate-carbon",
    startHex: "#334155",
    endHex: "#0F172A",
    angleDeg: 160,
    labelZh: "石墨渐变",
    labelEn: "Slate Carbon",
  },
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

function fitAspect(baseW: number, baseH: number, numW: number, numH: number): [number, number] {
  if (baseW * numH >= baseH * numW) {
    return [baseW, Math.max(baseH, Math.round((baseW * numH) / numW))];
  }
  return [Math.max(baseW, Math.round((baseH * numW) / numH)), baseH];
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
    [canvasWidth, canvasHeight] = fitAspect(baseW, baseH, 16, 9);
  } else if (params.aspectRatio === "4:5") {
    [canvasWidth, canvasHeight] = fitAspect(baseW, baseH, 4, 5);
  } else if (params.aspectRatio === "9:16") {
    [canvasWidth, canvasHeight] = fitAspect(baseW, baseH, 9, 16);
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
