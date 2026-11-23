//! Pure sRGB, HSL, OKLCH, CSS/XAML/C#/Tailwind formatting, color parsing,
//! and WCAG 2.x contrast calculation engine for I10 (Color Picker).

export interface RgbaColor {
  /** Integer 0..255 */
  r: number;
  /** Integer 0..255 */
  g: number;
  /** Integer 0..255 */
  b: number;
  /** Opacity 0..1 */
  a: number;
}

export type Hex8Interpretation = "css_rgba" | "xaml_argb";

export interface TailwindNearestMatch {
  token: string;
  className: string;
  hex: string;
  exactMatch: boolean;
  deltaE: number;
}

export interface FormattedColorOutputs {
  hex: string;
  hexNote: "rgb" | "css_rrggbbaa";
  rgb: string;
  hsl: string;
  oklch: string;
  css: string;
  winuiXaml: string;
  csharp: string;
  tailwindExact: string;
  tailwindNearest: TailwindNearestMatch;
}

export interface WcagContrastResult {
  /** Exact unrounded WCAG 2.x contrast ratio in [1, 21]. */
  ratio: number;
  /** Display ratio truncated down to 2 decimals so 4.499 never displays as 4.50 while failing AA. */
  displayRatio: string;
  /** Exact 4-decimal ratio string for threshold inspection. */
  preciseRatio: string;
  /** Pass/fail strictly evaluated on unrounded `ratio`. */
  aaNormal: boolean; // >= 4.5
  aaaNormal: boolean; // >= 7.0
  aaLarge: boolean; // >= 3.0
  aaaLarge: boolean; // >= 4.5
  foregroundLuminance: number;
  backgroundLuminance: number;
  compositedForeground: RgbaColor;
  compositedForegroundHex: string;
  compositedBackground: RgbaColor;
  compositedBackgroundHex: string;
  foregroundWasComposited: boolean;
}

export function clampByte(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(255, Math.max(0, n)));
}

export function clampAlpha(a: number): number {
  if (!Number.isFinite(a)) return 1;
  return Math.min(1, Math.max(0, a));
}

export function alphaToByte(a: number): number {
  return clampByte(clampAlpha(a) * 255);
}

export function normalizeColor(c: RgbaColor): RgbaColor {
  return {
    r: clampByte(c.r),
    g: clampByte(c.g),
    b: clampByte(c.b),
    a: Math.round(clampAlpha(c.a) * 1000) / 1000,
  };
}

function hex2(n: number): string {
  return clampByte(n).toString(16).toUpperCase().padStart(2, "0");
}

export function formatRgbHex6(c: Pick<RgbaColor, "r" | "g" | "b">): string {
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
}

export function formatCssHex(c: RgbaColor): string {
  const a8 = alphaToByte(c.a);
  if (a8 >= 255) {
    return formatRgbHex6(c);
  }
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${hex2(a8)}`;
}

/** WinUI / WPF / XAML strictly uses alpha-first `#AARRGGBB`. */
export function formatWinUiXamlHex(c: RgbaColor): string {
  const a8 = alphaToByte(c.a);
  return `#${hex2(a8)}${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
}

function formatAlphaDecimal(a: number): string {
  const clamped = clampAlpha(a);
  if (clamped >= 0.9995) return "1";
  if (clamped <= 0.0005) return "0";
  return Number(clamped.toFixed(2)).toString();
}

export function rgbToHsl(r8: number, g8: number, b8: number): { h: number; s: number; l: number } {
  const r = clampByte(r8) / 255;
  const g = clampByte(g8) / 255;
  const b = clampByte(b8) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;

  if (d === 0) {
    return { h: 0, s: 0, l: l * 100 };
  }

  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) {
    h = (g - b) / d + (g < b ? 6 : 0);
  } else if (max === g) {
    h = (b - r) / d + 2;
  } else {
    h = (r - g) / d + 4;
  }
  h *= 60;
  return { h, s: s * 100, l: l * 100 };
}

export function hslToRgb(
  hDeg: number,
  sPct: number,
  lPct: number,
): { r: number; g: number; b: number } {
  const h = ((hDeg % 360) + 360) % 360;
  const s = Math.min(100, Math.max(0, sPct)) / 100;
  const l = Math.min(100, Math.max(0, lPct)) / 100;

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (h < 60) {
    r1 = c;
    g1 = x;
  } else if (h < 120) {
    r1 = x;
    g1 = c;
  } else if (h < 180) {
    g1 = c;
    b1 = x;
  } else if (h < 240) {
    g1 = x;
    b1 = c;
  } else if (h < 300) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }

  return {
    r: clampByte((r1 + m) * 255),
    g: clampByte((g1 + m) * 255),
    b: clampByte((b1 + m) * 255),
  };
}

function srgbChannelToLinear(c01: number): number {
  return c01 <= 0.04045 ? c01 / 12.92 : Math.pow((c01 + 0.055) / 1.055, 2.4);
}

function linearChannelToSrgb(lin: number): number {
  const clamped = Math.min(1, Math.max(0, lin));
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

export function rgbToOklab(
  r8: number,
  g8: number,
  b8: number,
): { L: number; a: number; b: number } {
  const r = srgbChannelToLinear(clampByte(r8) / 255);
  const g = srgbChannelToLinear(clampByte(g8) / 255);
  const b = srgbChannelToLinear(clampByte(b8) / 255);

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

export function rgbToOklch(
  r8: number,
  g8: number,
  b8: number,
): { L: number; C: number; H: number } {
  const lab = rgbToOklab(r8, g8, b8);
  const C = Math.hypot(lab.a, lab.b);
  let H = 0;
  if (C > 1e-6) {
    H = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
    if (H < 0) H += 360;
  }
  return { L: lab.L, C, H };
}

export function oklchToRgb(L: number, C: number, H: number): { r: number; g: number; b: number } {
  const rad = (H * Math.PI) / 180;
  const a = C * Math.cos(rad);
  const b = C * Math.sin(rad);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const rLin = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  return {
    r: clampByte(linearChannelToSrgb(rLin) * 255),
    g: clampByte(linearChannelToSrgb(gLin) * 255),
    b: clampByte(linearChannelToSrgb(bLin) * 255),
  };
}

// Official Tailwind CSS palette (sRGB values for all 22 families × 11 shades + black & white)
const TAILWIND_RAW: ReadonlyArray<readonly [string, string]> = [
  ["black", "#000000"],
  ["white", "#FFFFFF"],
  ["slate-50", "#F8FAFC"],
  ["slate-100", "#F1F5F9"],
  ["slate-200", "#E2E8F0"],
  ["slate-300", "#CBD5E1"],
  ["slate-400", "#94A3B8"],
  ["slate-500", "#64748B"],
  ["slate-600", "#475569"],
  ["slate-700", "#334155"],
  ["slate-800", "#1E293B"],
  ["slate-900", "#0F172A"],
  ["slate-950", "#020617"],
  ["gray-50", "#F9FAFB"],
  ["gray-100", "#F3F4F6"],
  ["gray-200", "#E5E7EB"],
  ["gray-300", "#D1D5DB"],
  ["gray-400", "#9CA3AF"],
  ["gray-500", "#6B7280"],
  ["gray-600", "#4B5563"],
  ["gray-700", "#374151"],
  ["gray-800", "#1F2937"],
  ["gray-900", "#111827"],
  ["gray-950", "#030712"],
  ["zinc-50", "#FAFAFA"],
  ["zinc-100", "#F4F4F5"],
  ["zinc-200", "#E4E4E7"],
  ["zinc-300", "#D4D4D8"],
  ["zinc-400", "#A1A1AA"],
  ["zinc-500", "#71717A"],
  ["zinc-600", "#52525B"],
  ["zinc-700", "#3F3F46"],
  ["zinc-800", "#27272A"],
  ["zinc-900", "#18181B"],
  ["zinc-950", "#09090B"],
  ["neutral-50", "#FAFAFA"],
  ["neutral-100", "#F5F5F5"],
  ["neutral-200", "#E5E5E5"],
  ["neutral-300", "#D4D4D4"],
  ["neutral-400", "#A3A3A3"],
  ["neutral-500", "#737373"],
  ["neutral-600", "#525252"],
  ["neutral-700", "#404040"],
  ["neutral-800", "#262626"],
  ["neutral-900", "#171717"],
  ["neutral-950", "#0A0A0A"],
  ["stone-50", "#FAFAF9"],
  ["stone-100", "#F5F5F4"],
  ["stone-200", "#E7E5E4"],
  ["stone-300", "#D6D3D1"],
  ["stone-400", "#A8A29E"],
  ["stone-500", "#78716C"],
  ["stone-600", "#57534E"],
  ["stone-700", "#44403C"],
  ["stone-800", "#292524"],
  ["stone-900", "#1C1917"],
  ["stone-950", "#0C0A09"],
  ["red-50", "#FEF2F2"],
  ["red-100", "#FEE2E2"],
  ["red-200", "#FECACA"],
  ["red-300", "#FCA5A5"],
  ["red-400", "#F87171"],
  ["red-500", "#EF4444"],
  ["red-600", "#DC2626"],
  ["red-700", "#B91C1C"],
  ["red-800", "#991B1B"],
  ["red-900", "#7F1D1D"],
  ["red-950", "#450A0A"],
  ["orange-50", "#FFF7ED"],
  ["orange-100", "#FFEDD5"],
  ["orange-200", "#FED7AA"],
  ["orange-300", "#FDBA74"],
  ["orange-400", "#FB923C"],
  ["orange-500", "#F97316"],
  ["orange-600", "#EA580C"],
  ["orange-700", "#C2410C"],
  ["orange-800", "#9A3412"],
  ["orange-900", "#7C2D12"],
  ["orange-950", "#431407"],
  ["amber-50", "#FFFBEB"],
  ["amber-100", "#FEF3C7"],
  ["amber-200", "#FDE68A"],
  ["amber-300", "#FCD34D"],
  ["amber-400", "#FBBF24"],
  ["amber-500", "#F59E0B"],
  ["amber-600", "#D97706"],
  ["amber-700", "#B45309"],
  ["amber-800", "#92400E"],
  ["amber-900", "#78350F"],
  ["amber-950", "#451A03"],
  ["yellow-50", "#FEFCE8"],
  ["yellow-100", "#FEF9C3"],
  ["yellow-200", "#FEF08A"],
  ["yellow-300", "#FDE047"],
  ["yellow-400", "#FACC15"],
  ["yellow-500", "#EAB308"],
  ["yellow-600", "#CA8A04"],
  ["yellow-700", "#A16207"],
  ["yellow-800", "#854D0E"],
  ["yellow-900", "#713F12"],
  ["yellow-950", "#422006"],
  ["lime-50", "#F7FEE7"],
  ["lime-100", "#ECFCCB"],
  ["lime-200", "#D9F99D"],
  ["lime-300", "#BEF264"],
  ["lime-400", "#A3E635"],
  ["lime-500", "#84CC16"],
  ["lime-600", "#65A30D"],
  ["lime-700", "#4D7C0F"],
  ["lime-800", "#3F6212"],
  ["lime-900", "#365314"],
  ["lime-950", "#1A2E05"],
  ["green-50", "#F0FDF4"],
  ["green-100", "#DCFCE7"],
  ["green-200", "#BBF7D0"],
  ["green-300", "#86EFAC"],
  ["green-400", "#4ADE80"],
  ["green-500", "#22C55E"],
  ["green-600", "#16A34A"],
  ["green-700", "#15803D"],
  ["green-800", "#166534"],
  ["green-900", "#14532D"],
  ["green-950", "#052E16"],
  ["emerald-50", "#ECFDF5"],
  ["emerald-100", "#D1FAE5"],
  ["emerald-200", "#A7F3D0"],
  ["emerald-300", "#6EE7B7"],
  ["emerald-400", "#34D399"],
  ["emerald-500", "#10B981"],
  ["emerald-600", "#059669"],
  ["emerald-700", "#047857"],
  ["emerald-800", "#065F46"],
  ["emerald-900", "#064E3B"],
  ["emerald-950", "#022C22"],
  ["teal-50", "#F0FDFA"],
  ["teal-100", "#CCFBF1"],
  ["teal-200", "#99F6E4"],
  ["teal-300", "#5EEAD4"],
  ["teal-400", "#2DD4BF"],
  ["teal-500", "#14B8A6"],
  ["teal-600", "#0D9488"],
  ["teal-700", "#0F766E"],
  ["teal-800", "#115E59"],
  ["teal-900", "#134E4A"],
  ["teal-950", "#042F2E"],
  ["cyan-50", "#ECFEFF"],
  ["cyan-100", "#CFFAFE"],
  ["cyan-200", "#A5F3FC"],
  ["cyan-300", "#67E8F9"],
  ["cyan-400", "#22D3EE"],
  ["cyan-500", "#06B6D4"],
  ["cyan-600", "#0891B2"],
  ["cyan-700", "#0E7490"],
  ["cyan-800", "#155E75"],
  ["cyan-900", "#164E63"],
  ["cyan-950", "#083344"],
  ["sky-50", "#F0F9FF"],
  ["sky-100", "#E0F2FE"],
  ["sky-200", "#BAE6FD"],
  ["sky-300", "#7DD3FC"],
  ["sky-400", "#38BDF8"],
  ["sky-500", "#0EA5E9"],
  ["sky-600", "#0284C7"],
  ["sky-700", "#0369A1"],
  ["sky-800", "#075985"],
  ["sky-900", "#0C4A6E"],
  ["sky-950", "#082F49"],
  ["blue-50", "#EFF6FF"],
  ["blue-100", "#DBEAFE"],
  ["blue-200", "#BFDBFE"],
  ["blue-300", "#93C5FD"],
  ["blue-400", "#60A5FA"],
  ["blue-500", "#3B82F6"],
  ["blue-600", "#2563EB"],
  ["blue-700", "#1D4ED8"],
  ["blue-800", "#1E40AF"],
  ["blue-900", "#1E3A8A"],
  ["blue-950", "#172554"],
  ["indigo-50", "#EEF2FF"],
  ["indigo-100", "#E0E7FF"],
  ["indigo-200", "#C7D2FE"],
  ["indigo-300", "#A5B4FC"],
  ["indigo-400", "#818CF8"],
  ["indigo-500", "#6366F1"],
  ["indigo-600", "#4F46E5"],
  ["indigo-700", "#4338CA"],
  ["indigo-800", "#3730A3"],
  ["indigo-900", "#312E81"],
  ["indigo-950", "#1E1B4B"],
  ["violet-50", "#F5F3FF"],
  ["violet-100", "#EDE9FE"],
  ["violet-200", "#DDD6FE"],
  ["violet-300", "#C4B5FD"],
  ["violet-400", "#A78BFA"],
  ["violet-500", "#8B5CF6"],
  ["violet-600", "#7C3AED"],
  ["violet-700", "#6D28D9"],
  ["violet-800", "#5B21B6"],
  ["violet-900", "#4C1D95"],
  ["violet-950", "#2E1065"],
  ["purple-50", "#FAF5FF"],
  ["purple-100", "#F3E8FF"],
  ["purple-200", "#E9D5FF"],
  ["purple-300", "#D8B4FE"],
  ["purple-400", "#C084FC"],
  ["purple-500", "#A855F7"],
  ["purple-600", "#9333EA"],
  ["purple-700", "#7E22CE"],
  ["purple-800", "#6B21A8"],
  ["purple-900", "#581C87"],
  ["purple-950", "#3B0764"],
  ["fuchsia-50", "#FDF4FF"],
  ["fuchsia-100", "#FAE8FF"],
  ["fuchsia-200", "#F5D0FE"],
  ["fuchsia-300", "#F0ABFC"],
  ["fuchsia-400", "#E879F9"],
  ["fuchsia-500", "#D946EF"],
  ["fuchsia-600", "#C026D3"],
  ["fuchsia-700", "#A21CAF"],
  ["fuchsia-800", "#86198F"],
  ["fuchsia-900", "#701A75"],
  ["fuchsia-950", "#4A044E"],
  ["pink-50", "#FDF2F8"],
  ["pink-100", "#FCE7F3"],
  ["pink-200", "#FBCFE8"],
  ["pink-300", "#F9A8D4"],
  ["pink-400", "#F472B6"],
  ["pink-500", "#EC4899"],
  ["pink-600", "#DB2777"],
  ["pink-700", "#BE185D"],
  ["pink-800", "#9D174D"],
  ["pink-900", "#831843"],
  ["pink-950", "#500724"],
  ["rose-50", "#FFF1F2"],
  ["rose-100", "#FFE4E6"],
  ["rose-200", "#FECDD3"],
  ["rose-300", "#FDA4AF"],
  ["rose-400", "#FB7185"],
  ["rose-500", "#F43F5E"],
  ["rose-600", "#E11D48"],
  ["rose-700", "#BE123C"],
  ["rose-800", "#9F1239"],
  ["rose-900", "#881337"],
  ["rose-950", "#4C0519"],
];

interface TailwindEntry {
  token: string;
  hex: string;
  r: number;
  g: number;
  b: number;
  L: number;
  a: number;
  okb: number;
}

const TAILWIND_INDEX: TailwindEntry[] = TAILWIND_RAW.map(([token, hex]) => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lab = rgbToOklab(r, g, b);
  return { token, hex, r, g, b, L: lab.L, a: lab.a, okb: lab.b };
});

export function findNearestTailwindColor(c: RgbaColor): TailwindNearestMatch {
  const r = clampByte(c.r);
  const g = clampByte(c.g);
  const b = clampByte(c.b);
  const a8 = alphaToByte(c.a);
  const targetLab = rgbToOklab(r, g, b);

  let best = TAILWIND_INDEX[0]!;
  let bestDist = Infinity;

  for (const item of TAILWIND_INDEX) {
    if (item.r === r && item.g === g && item.b === b) {
      best = item;
      bestDist = 0;
      break;
    }
    const d = Math.hypot(targetLab.L - item.L, targetLab.a - item.a, targetLab.b - item.okb);
    if (d < bestDist) {
      bestDist = d;
      best = item;
    }
  }

  const alphaPct = Math.round(clampAlpha(c.a) * 100);
  const className = a8 >= 255 ? `bg-${best.token}` : `bg-${best.token}/${alphaPct}`;
  return {
    token: best.token,
    className,
    hex: best.hex,
    exactMatch: bestDist === 0 && a8 >= 255,
    deltaE: Math.round(bestDist * 1000) / 1000,
  };
}

export function formatAllColorOutputs(color: RgbaColor): FormattedColorOutputs {
  const c = normalizeColor(color);
  const a8 = alphaToByte(c.a);
  const isTranslucent = a8 < 255;
  const alphaStr = formatAlphaDecimal(c.a);

  const cssHex = formatCssHex(c);
  const hsl = rgbToHsl(c.r, c.g, c.b);
  const oklch = rgbToOklch(c.r, c.g, c.b);

  const rgbStr = isTranslucent
    ? `rgba(${c.r}, ${c.g}, ${c.b}, ${alphaStr})`
    : `rgb(${c.r}, ${c.g}, ${c.b})`;

  const hslH = Math.round(hsl.h);
  const hslS = Math.round(hsl.s);
  const hslL = Math.round(hsl.l);
  const hslStr = isTranslucent
    ? `hsla(${hslH}, ${hslS}%, ${hslL}%, ${alphaStr})`
    : `hsl(${hslH}, ${hslS}%, ${hslL}%)`;

  const okL = oklch.L.toFixed(3);
  const okC = oklch.C.toFixed(3);
  const okH = oklch.C < 1e-4 ? "0" : oklch.H.toFixed(1);
  const oklchStr = isTranslucent
    ? `oklch(${okL} ${okC} ${okH} / ${alphaStr})`
    : `oklch(${okL} ${okC} ${okH})`;

  const cssStr = `color: ${cssHex};`;
  const winuiXaml = formatWinUiXamlHex(c);
  const csharp = `Color.FromArgb(${a8}, ${c.r}, ${c.g}, ${c.b})`;
  const tailwindExact = `bg-[${cssHex}]`;
  const tailwindNearest = findNearestTailwindColor(c);

  return {
    hex: cssHex,
    hexNote: isTranslucent ? "css_rrggbbaa" : "rgb",
    rgb: rgbStr,
    hsl: hslStr,
    oklch: oklchStr,
    css: cssStr,
    winuiXaml,
    csharp,
    tailwindExact,
    tailwindNearest,
  };
}

/**
 * Parses manual color inputs in HEX (`#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA` or `#AARRGGBB`),
 * `rgb(...)`/`rgba(...)`, `hsl(...)`/`hsla(...)`, `oklch(...)`, or `Color.FromArgb(a, r, g, b)`.
 */
export function parseColorInput(
  raw: string,
  hex8Order: Hex8Interpretation = "css_rgba",
): RgbaColor | null {
  const s = raw.trim();
  if (!s) return null;

  // Hex formats
  const hexMatch = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(s);
  if (hexMatch) {
    const h = hexMatch[1]!;
    if (h.length === 3) {
      return {
        r: parseInt(h[0]! + h[0]!, 16),
        g: parseInt(h[1]! + h[1]!, 16),
        b: parseInt(h[2]! + h[2]!, 16),
        a: 1,
      };
    }
    if (h.length === 4) {
      const c0 = parseInt(h[0]! + h[0]!, 16);
      const c1 = parseInt(h[1]! + h[1]!, 16);
      const c2 = parseInt(h[2]! + h[2]!, 16);
      const c3 = parseInt(h[3]! + h[3]!, 16);
      if (hex8Order === "xaml_argb") {
        return normalizeColor({ r: c1, g: c2, b: c3, a: c0 / 255 });
      }
      return normalizeColor({ r: c0, g: c1, b: c2, a: c3 / 255 });
    }
    if (h.length === 6) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: 1,
      };
    }
    if (h.length === 8) {
      const b0 = parseInt(h.slice(0, 2), 16);
      const b1 = parseInt(h.slice(2, 4), 16);
      const b2 = parseInt(h.slice(4, 6), 16);
      const b3 = parseInt(h.slice(6, 8), 16);
      if (hex8Order === "xaml_argb") {
        return normalizeColor({ r: b1, g: b2, b: b3, a: b0 / 255 });
      }
      return normalizeColor({ r: b0, g: b1, b: b2, a: b3 / 255 });
    }
  }

  // C# Color.FromArgb(a, r, g, b)
  const csharpMatch = /^Color\.FromArgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(
    s,
  );
  if (csharpMatch) {
    const a8 = Number(csharpMatch[1]);
    const r = Number(csharpMatch[2]);
    const g = Number(csharpMatch[3]);
    const b = Number(csharpMatch[4]);
    if ([a8, r, g, b].every((n) => n >= 0 && n <= 255)) {
      return normalizeColor({ r, g, b, a: a8 / 255 });
    }
    return null;
  }

  // rgb() / rgba() (comma or space/slash syntax)
  const rgbMatch =
    /^rgba?\(\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)\s*(?:[,/]\s*([0-9.]+%?)\s*)?\)$/i.exec(
      s,
    );
  if (rgbMatch) {
    const r = Number(rgbMatch[1]);
    const g = Number(rgbMatch[2]);
    const b = Number(rgbMatch[3]);
    const aRaw = rgbMatch[4];
    const a =
      aRaw === undefined ? 1 : aRaw.endsWith("%") ? Number(aRaw.slice(0, -1)) / 100 : Number(aRaw);
    if (
      [r, g, b].every((n) => Number.isFinite(n) && n >= 0 && n <= 255) &&
      Number.isFinite(a) &&
      a >= 0 &&
      a <= 1
    ) {
      return normalizeColor({ r, g, b, a });
    }
    return null;
  }

  // hsl() / hsla()
  const hslMatch =
    /^hsla?\(\s*(-?[0-9.]+)(?:deg)?\s*[,\s]\s*([0-9.]+)%\s*[,\s]\s*([0-9.]+)%\s*(?:[,/]\s*([0-9.]+%?)\s*)?\)$/i.exec(
      s,
    );
  if (hslMatch) {
    const h = Number(hslMatch[1]);
    const sat = Number(hslMatch[2]);
    const light = Number(hslMatch[3]);
    const aRaw = hslMatch[4];
    const a =
      aRaw === undefined ? 1 : aRaw.endsWith("%") ? Number(aRaw.slice(0, -1)) / 100 : Number(aRaw);
    if (
      Number.isFinite(h) &&
      sat >= 0 &&
      sat <= 100 &&
      light >= 0 &&
      light <= 100 &&
      Number.isFinite(a) &&
      a >= 0 &&
      a <= 1
    ) {
      const rgb = hslToRgb(h, sat, light);
      return normalizeColor({ ...rgb, a });
    }
    return null;
  }

  // oklch(L C H [/ a]) where L can be 0..1 or 0%..100%
  const okMatch =
    /^oklch\(\s*([0-9.]+%?)\s+([0-9.]+)\s+(-?[0-9.]+)(?:deg)?\s*(?:\/\s*([0-9.]+%?)\s*)?\)$/i.exec(
      s,
    );
  if (okMatch) {
    const lRaw = okMatch[1]!;
    const L = lRaw.endsWith("%") ? Number(lRaw.slice(0, -1)) / 100 : Number(lRaw);
    const C = Number(okMatch[2]);
    const H = Number(okMatch[3]);
    const aRaw = okMatch[4];
    const a =
      aRaw === undefined ? 1 : aRaw.endsWith("%") ? Number(aRaw.slice(0, -1)) / 100 : Number(aRaw);
    if (
      Number.isFinite(L) &&
      L >= 0 &&
      L <= 1 &&
      Number.isFinite(C) &&
      C >= 0 &&
      C <= 0.5 &&
      Number.isFinite(H) &&
      Number.isFinite(a) &&
      a >= 0 &&
      a <= 1
    ) {
      const rgb = oklchToRgb(L, C, H);
      return normalizeColor({ ...rgb, a });
    }
    return null;
  }

  return null;
}

/** Exact WCAG 2.x sRGB relative luminance from floating-point channels in [0, 255]. */
export function computeRelativeLuminance(r255: number, g255: number, b255: number): number {
  const r = srgbChannelToLinear(Math.min(255, Math.max(0, r255)) / 255);
  const g = srgbChannelToLinear(Math.min(255, Math.max(0, g255)) / 255);
  const b = srgbChannelToLinear(Math.min(255, Math.max(0, b255)) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Evaluates WCAG 2.x contrast ratio between `foreground` and `background`.
 * - Translucent background is composited over pure white first (opaque canvas baseline).
 * - Translucent foreground is composited over the resolved background before luminance calculation.
 * - AA / AAA pass/fail checks strictly evaluate the UNROUNDED floating-point ratio.
 */
export function evaluateWcagContrast(
  foreground: RgbaColor,
  background: RgbaColor,
): WcagContrastResult {
  const bgA = clampAlpha(background.a);
  const effBgR = clampByte(background.r) * bgA + 255 * (1 - bgA);
  const effBgG = clampByte(background.g) * bgA + 255 * (1 - bgA);
  const effBgB = clampByte(background.b) * bgA + 255 * (1 - bgA);

  const fgA = clampAlpha(foreground.a);
  const foregroundWasComposited = alphaToByte(fgA) < 255;
  const effFgR = clampByte(foreground.r) * fgA + effBgR * (1 - fgA);
  const effFgG = clampByte(foreground.g) * fgA + effBgG * (1 - fgA);
  const effFgB = clampByte(foreground.b) * fgA + effBgB * (1 - fgA);

  const lFg = computeRelativeLuminance(effFgR, effFgG, effFgB);
  const lBg = computeRelativeLuminance(effBgR, effBgG, effBgB);

  const lighter = Math.max(lFg, lBg);
  const darker = Math.min(lFg, lBg);
  const ratio = (lighter + 0.05) / (darker + 0.05);

  // Truncate display ratio down to 2 decimals so e.g. 4.4991 displays as "4.49:1" (never "4.50:1" + Fail)
  const truncated2 = Math.floor(ratio * 100 + 1e-9) / 100;
  const displayRatio = `${truncated2.toFixed(2)}:1`;
  const preciseRatio = `${ratio.toFixed(4)}:1`;

  const compositedForeground: RgbaColor = {
    r: clampByte(effFgR),
    g: clampByte(effFgG),
    b: clampByte(effFgB),
    a: 1,
  };
  const compositedBackground: RgbaColor = {
    r: clampByte(effBgR),
    g: clampByte(effBgG),
    b: clampByte(effBgB),
    a: 1,
  };

  return {
    ratio,
    displayRatio,
    preciseRatio,
    // Strictly unrounded ratio comparisons:
    aaNormal: ratio >= 4.5,
    aaaNormal: ratio >= 7.0,
    aaLarge: ratio >= 3.0,
    aaaLarge: ratio >= 4.5,
    foregroundLuminance: lFg,
    backgroundLuminance: lBg,
    compositedForeground,
    compositedForegroundHex: formatRgbHex6(compositedForeground),
    compositedBackground,
    compositedBackgroundHex: formatRgbHex6(compositedBackground),
    foregroundWasComposited,
  };
}
