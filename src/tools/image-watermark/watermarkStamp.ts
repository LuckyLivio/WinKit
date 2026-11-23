//! Shared watermark stamp rasterizer & live preview compositor matching
//! `src-tauri/src/image_watermark.rs` placement, scaling, and diagonal tiling math 1:1.

import type { WatermarkPlacement } from "../../lib/tauriBridge";

export const WATERMARK_FONT_FAMILY = '"Microsoft YaHei UI", "Segoe UI", "PingFang SC", sans-serif';

export interface TextStampOptions {
  text: string;
  colorHex: string;
  bold: boolean;
  shadow: boolean;
}

export interface RasterizedStamp {
  dataUrl: string;
  width: number;
  height: number;
}

export function computeScaledStampSize(
  baseW: number,
  baseH: number,
  stampW: number,
  stampH: number,
  scalePercent: number,
): { width: number; height: number } {
  if (baseW <= 0 || baseH <= 0 || stampW <= 0 || stampH <= 0) {
    return { width: 1, height: 1 };
  }
  const scale = Math.max(5, Math.min(80, scalePercent)) / 100;
  const aspect = stampH / stampW;
  let targetW = Math.max(16, Math.round(baseW * scale));
  let targetH = Math.max(8, Math.round(targetW * aspect));

  const maxH = Math.max(16, baseH * 0.45);
  if (targetH > maxH) {
    targetH = maxH;
    targetW = Math.max(8, Math.round(targetH / aspect));
  }
  const maxW = Math.max(16, baseW * 0.92);
  if (targetW > maxW) {
    targetW = maxW;
    targetH = Math.max(8, Math.round(targetW * aspect));
  }
  return {
    width: Math.max(1, Math.min(baseW, Math.round(targetW))),
    height: Math.max(1, Math.min(baseH, Math.round(targetH))),
  };
}

/**
 * Renders Chinese/English watermark text at crisp high resolution onto a transparent PNG stamp
 * so both live Canvas preview and Rust Lanczos3 batch compositing share identical glyph pixels.
 */
export function rasterizeTextWatermarkStamp(opts: TextStampOptions): RasterizedStamp | null {
  const clean = opts.text.trim();
  if (!clean) return null;

  const fontSize = 112;
  const lines = clean.split(/\r?\n/);
  const lineHeight = Math.round(fontSize * 1.28);
  const weight = opts.bold ? "700" : "500";
  const font = `${weight} ${fontSize}px ${WATERMARK_FONT_FAMILY}`;

  const measureCanvas = document.createElement("canvas");
  const mctx = measureCanvas.getContext("2d");
  if (!mctx) return null;
  mctx.font = font;

  let maxLineW = 40;
  for (const line of lines) {
    const w = mctx.measureText(line || " ").width;
    if (w > maxLineW) maxLineW = w;
  }

  const pad = 24;
  const cw = Math.min(3600, Math.max(64, Math.ceil(maxLineW + pad * 2)));
  const ch = Math.min(2000, Math.max(48, Math.ceil(lines.length * lineHeight + pad * 2)));

  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.font = font;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";

  if (opts.shadow) {
    const upper = opts.colorHex.trim().toUpperCase();
    const isLight = upper === "#FFFFFF" || upper === "#F8FAFC" || upper === "#FDE047";
    ctx.shadowColor = isLight ? "rgba(15, 23, 42, 0.55)" : "rgba(255, 255, 255, 0.45)";
    ctx.shadowBlur = 10;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 3;
  }

  ctx.fillStyle = opts.colorHex || "#FFFFFF";
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i] ?? "", pad, pad + i * lineHeight);
  }

  return {
    dataUrl: canvas.toDataURL("image/png"),
    width: cw,
    height: ch,
  };
}

export interface PreviewWatermarkParams {
  placement: WatermarkPlacement;
  scalePercent: number;
  marginPercent: number;
  opacityPercent: number;
  tileAngleDeg: number;
  tileSpacingPercent: number;
}

/**
 * Draws the exact positioned or diagonally tiled watermark overlay onto a preview canvas
 * dimensioned `(baseW, baseH)` (scaled proportionally to fit the preview container).
 */
export function drawWatermarkOverlayOnCanvas(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  canvasH: number,
  stampImg: HTMLImageElement,
  params: PreviewWatermarkParams,
): void {
  const sw = stampImg.naturalWidth || stampImg.width;
  const sh = stampImg.naturalHeight || stampImg.height;
  if (sw <= 0 || sh <= 0 || canvasW <= 0 || canvasH <= 0) return;

  const { width: tw, height: th } = computeScaledStampSize(
    canvasW,
    canvasH,
    sw,
    sh,
    params.scalePercent,
  );
  const opacity = Math.max(0.05, Math.min(1, params.opacityPercent / 100));
  const margin = Math.round(
    (Math.min(canvasW, canvasH) * Math.max(0, Math.min(25, params.marginPercent))) / 100,
  );

  ctx.save();
  ctx.globalAlpha = opacity;

  if (params.placement === "diagonal_tile") {
    const angleDeg = Math.max(-60, Math.min(60, params.tileAngleDeg));
    const rad = (angleDeg * Math.PI) / 180;
    const cosA = Math.abs(Math.cos(rad));
    const sinA = Math.abs(Math.sin(rad));
    const rotW = Math.ceil(tw * cosA + th * sinA);
    const rotH = Math.ceil(tw * sinA + th * cosA);
    const spacing = Math.max(30, Math.min(250, params.tileSpacingPercent)) / 100;
    const stepX = Math.max(20, Math.round(rotW * (1 + spacing * 0.55)));
    const stepY = Math.max(20, Math.round(rotH * (1 + spacing * 0.65)));

    let rowIdx = 0;
    for (let y = -rotH / 2; y < canvasH + rotH; y += stepY) {
      const xOff = rowIdx % 2 === 1 ? stepX / 2 : 0;
      for (let x = -rotW + xOff; x < canvasW + rotW; x += stepX) {
        ctx.save();
        ctx.translate(x + rotW / 2, y + rotH / 2);
        ctx.rotate(rad);
        ctx.drawImage(stampImg, -tw / 2, -th / 2, tw, th);
        ctx.restore();
      }
      rowIdx++;
    }
    ctx.restore();
    return;
  }

  let ox = margin;
  let oy = margin;
  switch (params.placement) {
    case "top_left":
      ox = margin;
      oy = margin;
      break;
    case "top_center":
      ox = Math.round((canvasW - tw) / 2);
      oy = margin;
      break;
    case "top_right":
      ox = canvasW - tw - margin;
      oy = margin;
      break;
    case "middle_left":
      ox = margin;
      oy = Math.round((canvasH - th) / 2);
      break;
    case "center":
      ox = Math.round((canvasW - tw) / 2);
      oy = Math.round((canvasH - th) / 2);
      break;
    case "middle_right":
      ox = canvasW - tw - margin;
      oy = Math.round((canvasH - th) / 2);
      break;
    case "bottom_left":
      ox = margin;
      oy = canvasH - th - margin;
      break;
    case "bottom_center":
      ox = Math.round((canvasW - tw) / 2);
      oy = canvasH - th - margin;
      break;
    case "bottom_right":
      ox = canvasW - tw - margin;
      oy = canvasH - th - margin;
      break;
  }

  ctx.drawImage(stampImg, ox, oy, tw, th);
  ctx.restore();
}
