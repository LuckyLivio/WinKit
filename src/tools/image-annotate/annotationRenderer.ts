//! Pure pixel-coordinate annotation data model, hit-testing, editing, and full-resolution
//! canvas renderer for I12 (Annotate Screenshot).

import type { PixelPoint, PixelRect } from "../image-editor/canvasViewport";

export type AnnotateToolKind =
  | "select"
  | "arrow"
  | "line"
  | "rect"
  | "ellipse"
  | "text"
  | "highlight"
  | "number"
  | "brush"
  | "blur"
  | "crop";

export interface ArrowAnnotation {
  id: string;
  type: "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  strokeWidth: number;
}

export interface LineAnnotation {
  id: string;
  type: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  strokeWidth: number;
}

export interface RectAnnotation {
  id: string;
  type: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  strokeWidth: number;
}

export interface EllipseAnnotation {
  id: string;
  type: "ellipse";
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  strokeWidth: number;
}

export interface TextAnnotation {
  id: string;
  type: "text";
  x: number;
  y: number;
  text: string;
  color: string;
  fontSize: number;
  backgroundPill: boolean;
}

export interface HighlightAnnotation {
  id: string;
  type: "highlight";
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  opacity: number;
}

export interface NumberAnnotation {
  id: string;
  type: "number";
  x: number;
  y: number;
  value: number;
  color: string;
  radius: number;
}

export interface BrushAnnotation {
  id: string;
  type: "brush";
  points: PixelPoint[];
  color: string;
  strokeWidth: number;
}

export interface BlurAnnotation {
  id: string;
  type: "blur";
  x: number;
  y: number;
  width: number;
  height: number;
  strength: number;
}

export type AnnotationItem =
  | ArrowAnnotation
  | LineAnnotation
  | RectAnnotation
  | EllipseAnnotation
  | TextAnnotation
  | HighlightAnnotation
  | NumberAnnotation
  | BrushAnnotation
  | BlurAnnotation;

export const ANNOTATE_FONT_FAMILY = '"Microsoft YaHei UI", "Segoe UI", "PingFang SC", sans-serif';

export const ANNOTATE_COLORS = [
  "#DC2626", // Red
  "#EA580C", // Orange
  "#D97706", // Amber
  "#16A34A", // Green
  "#2563EB", // Blue
  "#7C3AED", // Violet
  "#111827", // Ink Dark
  "#FFFFFF", // White
];

export const HIGHLIGHT_COLORS = ["#FDE047", "#86EFAC", "#93C5FD", "#F9A8D4"];

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "").trim();
  if (clean.length === 6) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
  }
  return `rgba(253, 224, 71, ${alpha})`;
}

export function estimateTextBox(
  item: TextAnnotation,
  ctx?: CanvasRenderingContext2D | null,
): PixelRect {
  const lines = (item.text || " ").split(/\r?\n/);
  const lineHeight = Math.round(item.fontSize * 1.32);
  let maxWidth = Math.max(40, item.fontSize * 2);
  if (ctx) {
    ctx.save();
    ctx.font = `600 ${item.fontSize}px ${ANNOTATE_FONT_FAMILY}`;
    for (const line of lines) {
      const m = ctx.measureText(line || " ");
      if (m.width > maxWidth) maxWidth = m.width;
    }
    ctx.restore();
  } else {
    for (const line of lines) {
      // Wide CJK glyphs ~1.05em, Latin ~0.62em
      let est = 0;
      for (const ch of line) {
        est += ch.charCodeAt(0) > 0x2e7f ? item.fontSize * 1.05 : item.fontSize * 0.62;
      }
      if (est > maxWidth) maxWidth = est;
    }
  }
  const padX = item.backgroundPill ? Math.round(item.fontSize * 0.45) : 4;
  const padY = item.backgroundPill ? Math.round(item.fontSize * 0.28) : 2;
  return {
    x: Math.round(item.x - padX),
    y: Math.round(item.y - padY),
    width: Math.round(maxWidth + padX * 2),
    height: Math.round(lines.length * lineHeight + padY * 2),
  };
}

export function getAnnotationBounds(
  item: AnnotationItem,
  ctx?: CanvasRenderingContext2D | null,
): PixelRect {
  switch (item.type) {
    case "arrow":
    case "line": {
      const x = Math.min(item.x1, item.x2);
      const y = Math.min(item.y1, item.y2);
      return {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.max(8, Math.round(Math.abs(item.x2 - item.x1))),
        height: Math.max(8, Math.round(Math.abs(item.y2 - item.y1))),
      };
    }
    case "rect":
    case "ellipse":
    case "highlight":
    case "blur":
      return { x: item.x, y: item.y, width: item.width, height: item.height };
    case "number":
      return {
        x: Math.round(item.x - item.radius),
        y: Math.round(item.y - item.radius),
        width: Math.round(item.radius * 2),
        height: Math.round(item.radius * 2),
      };
    case "text":
      return estimateTextBox(item, ctx);
    case "brush": {
      if (item.points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
      let minX = item.points[0]!.x;
      let maxX = minX;
      let minY = item.points[0]!.y;
      let maxY = minY;
      for (const p of item.points) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      return {
        x: Math.round(minX),
        y: Math.round(minY),
        width: Math.max(8, Math.round(maxX - minX)),
        height: Math.max(8, Math.round(maxY - minY)),
      };
    }
  }
}

function pointToSegmentDist(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-6) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function hitTestAnnotation(
  items: AnnotationItem[],
  imgX: number,
  imgY: number,
  scale: number,
  ctx?: CanvasRenderingContext2D | null,
): AnnotationItem | null {
  const tol = Math.max(6, 10 / Math.max(0.1, scale));
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    switch (item.type) {
      case "arrow":
      case "line": {
        if (
          pointToSegmentDist(imgX, imgY, item.x1, item.y1, item.x2, item.y2) <=
          tol + item.strokeWidth * 0.6
        ) {
          return item;
        }
        break;
      }
      case "number": {
        if (Math.hypot(imgX - item.x, imgY - item.y) <= item.radius + tol * 0.5) {
          return item;
        }
        break;
      }
      case "brush": {
        for (let k = 1; k < item.points.length; k++) {
          const a = item.points[k - 1]!;
          const b = item.points[k]!;
          if (pointToSegmentDist(imgX, imgY, a.x, a.y, b.x, b.y) <= tol + item.strokeWidth * 0.6) {
            return item;
          }
        }
        if (item.points.length === 1) {
          const p = item.points[0]!;
          if (Math.hypot(imgX - p.x, imgY - p.y) <= tol + item.strokeWidth) return item;
        }
        break;
      }
      default: {
        const b = getAnnotationBounds(item, ctx);
        if (
          imgX >= b.x - tol * 0.5 &&
          imgX <= b.x + b.width + tol * 0.5 &&
          imgY >= b.y - tol * 0.5 &&
          imgY <= b.y + b.height + tol * 0.5
        ) {
          return item;
        }
        break;
      }
    }
  }
  return null;
}

export function translateAnnotation(item: AnnotationItem, dx: number, dy: number): AnnotationItem {
  const rx = Math.round(dx);
  const ry = Math.round(dy);
  switch (item.type) {
    case "arrow":
    case "line":
      return {
        ...item,
        x1: item.x1 + rx,
        y1: item.y1 + ry,
        x2: item.x2 + rx,
        y2: item.y2 + ry,
      };
    case "rect":
    case "ellipse":
    case "highlight":
    case "blur":
    case "text":
    case "number":
      return { ...item, x: item.x + rx, y: item.y + ry };
    case "brush":
      return {
        ...item,
        points: item.points.map((p) => ({ x: p.x + rx, y: p.y + ry })),
      };
  }
}

export function isBoxResizable(
  item: AnnotationItem,
): item is RectAnnotation | EllipseAnnotation | HighlightAnnotation | BlurAnnotation {
  return (
    item.type === "rect" ||
    item.type === "ellipse" ||
    item.type === "highlight" ||
    item.type === "blur"
  );
}

/**
 * Applies a fast deterministic pixel-block blur/mosaic to a rectangular region directly in
 * image-pixel coordinates on `ctx` by sampling the provided `sourceImage`.
 */
export function drawLocalBlurRegion(
  ctx: CanvasRenderingContext2D,
  sourceImage: CanvasImageSource,
  imgW: number,
  imgH: number,
  rect: PixelRect,
  strength: number,
): void {
  const x0 = Math.max(0, Math.min(imgW, Math.round(rect.x)));
  const y0 = Math.max(0, Math.min(imgH, Math.round(rect.y)));
  const x1 = Math.max(0, Math.min(imgW, Math.round(rect.x + rect.width)));
  const y1 = Math.max(0, Math.min(imgH, Math.round(rect.y + rect.height)));
  const rw = x1 - x0;
  const rh = y1 - y0;
  if (rw <= 0 || rh <= 0) return;

  const block = Math.max(4, Math.min(48, Math.round(strength)));
  const sw = Math.max(1, Math.round(rw / block));
  const sh = Math.max(1, Math.round(rh / block));

  const tmp = document.createElement("canvas");
  tmp.width = sw;
  tmp.height = sh;
  const tctx = tmp.getContext("2d");
  if (!tctx) return;

  tctx.imageSmoothingEnabled = true;
  tctx.drawImage(sourceImage, x0, y0, rw, rh, 0, 0, sw, sh);

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, sw, sh, x0, y0, rw, rh);
  ctx.restore();
}

/**
 * Draws a single annotation item in **original image pixel coordinates** onto `ctx`.
 * Both the live preview canvas (under viewport transform) and the full-resolution offscreen
 * export canvas call this exact function so preview and export match 1:1.
 */
export function drawAnnotationItem(
  ctx: CanvasRenderingContext2D,
  item: AnnotationItem,
  sourceImage: CanvasImageSource | null,
  imageWidth: number,
  imageHeight: number,
): void {
  ctx.save();
  switch (item.type) {
    case "blur": {
      if (sourceImage) {
        drawLocalBlurRegion(ctx, sourceImage, imageWidth, imageHeight, item, item.strength);
      } else {
        ctx.fillStyle = "rgba(100, 116, 139, 0.55)";
        ctx.fillRect(item.x, item.y, item.width, item.height);
      }
      break;
    }
    case "highlight": {
      ctx.fillStyle = hexToRgba(item.color, Math.min(0.75, Math.max(0.15, item.opacity)));
      ctx.fillRect(item.x, item.y, item.width, item.height);
      break;
    }
    case "rect": {
      ctx.strokeStyle = item.color;
      ctx.lineWidth = item.strokeWidth;
      ctx.lineJoin = "round";
      ctx.strokeRect(item.x, item.y, item.width, item.height);
      break;
    }
    case "ellipse": {
      ctx.strokeStyle = item.color;
      ctx.lineWidth = item.strokeWidth;
      ctx.beginPath();
      ctx.ellipse(
        item.x + item.width / 2,
        item.y + item.height / 2,
        Math.max(1, item.width / 2),
        Math.max(1, item.height / 2),
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
      break;
    }
    case "line": {
      ctx.strokeStyle = item.color;
      ctx.lineWidth = item.strokeWidth;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(item.x1, item.y1);
      ctx.lineTo(item.x2, item.y2);
      ctx.stroke();
      break;
    }
    case "arrow": {
      const dx = item.x2 - item.x1;
      const dy = item.y2 - item.y1;
      const len = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      const headLen = Math.max(14, item.strokeWidth * 4.2);
      const headAngle = Math.PI / 6.5;

      // Shorten shaft slightly so the arrowhead tip stays razor-sharp
      const shaftEndX = len > headLen * 0.6 ? item.x2 - Math.cos(angle) * headLen * 0.55 : item.x2;
      const shaftEndY = len > headLen * 0.6 ? item.y2 - Math.sin(angle) * headLen * 0.55 : item.y2;

      ctx.strokeStyle = item.color;
      ctx.fillStyle = item.color;
      ctx.lineWidth = item.strokeWidth;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(item.x1, item.y1);
      ctx.lineTo(shaftEndX, shaftEndY);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(item.x2, item.y2);
      ctx.lineTo(
        item.x2 - headLen * Math.cos(angle - headAngle),
        item.y2 - headLen * Math.sin(angle - headAngle),
      );
      ctx.lineTo(
        item.x2 - headLen * Math.cos(angle + headAngle),
        item.y2 - headLen * Math.sin(angle + headAngle),
      );
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "brush": {
      if (item.points.length === 0) break;
      ctx.strokeStyle = item.color;
      ctx.fillStyle = item.color;
      ctx.lineWidth = item.strokeWidth;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (item.points.length === 1) {
        ctx.beginPath();
        ctx.arc(item.points[0]!.x, item.points[0]!.y, item.strokeWidth / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(item.points[0]!.x, item.points[0]!.y);
        for (let i = 1; i < item.points.length - 1; i++) {
          const midX = (item.points[i]!.x + item.points[i + 1]!.x) / 2;
          const midY = (item.points[i]!.y + item.points[i + 1]!.y) / 2;
          ctx.quadraticCurveTo(item.points[i]!.x, item.points[i]!.y, midX, midY);
        }
        const last = item.points[item.points.length - 1]!;
        ctx.lineTo(last.x, last.y);
        ctx.stroke();
      }
      break;
    }
    case "number": {
      ctx.fillStyle = item.color;
      ctx.beginPath();
      ctx.arc(item.x, item.y, item.radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "#FFFFFF";
      ctx.lineWidth = Math.max(2, item.radius * 0.14);
      ctx.stroke();

      const label = String(item.value);
      const fontSize = Math.round(item.radius * (label.length >= 2 ? 1.02 : 1.2));
      ctx.font = `700 ${fontSize}px ${ANNOTATE_FONT_FAMILY}`;
      ctx.fillStyle = "#FFFFFF";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, item.x, item.y + 1);
      break;
    }
    case "text": {
      const box = estimateTextBox(item, ctx);
      const lines = (item.text || "").split(/\r?\n/);
      const lineHeight = Math.round(item.fontSize * 1.32);

      if (item.backgroundPill && item.text.trim().length > 0) {
        const isLightText =
          item.color.toUpperCase() === "#FFFFFF" || item.color.toUpperCase() === "#F8FAFC";
        ctx.fillStyle = isLightText ? "rgba(15, 23, 42, 0.88)" : "rgba(255, 255, 255, 0.94)";
        const r = Math.min(8, Math.round(item.fontSize * 0.3));
        ctx.beginPath();
        ctx.roundRect(box.x, box.y, box.width, box.height, r);
        ctx.fill();
        ctx.strokeStyle = hexToRgba(item.color, 0.45);
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      ctx.font = `600 ${item.fontSize}px ${ANNOTATE_FONT_FAMILY}`;
      ctx.fillStyle = item.color;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i] ?? "", item.x, item.y + i * lineHeight);
      }
      break;
    }
  }
  ctx.restore();
}

/**
 * Renders the source image plus all annotations at **100% original resolution**
 * (or strictly the exact user-selected `cropRect` pixel region) into a lossless PNG Data URL.
 */
export function renderAnnotatedImageToPngDataUrl(
  sourceImage: HTMLImageElement,
  imageWidth: number,
  imageHeight: number,
  items: AnnotationItem[],
  cropRect: PixelRect | null,
): { dataUrl: string; width: number; height: number } {
  const rx = cropRect ? Math.max(0, Math.min(imageWidth - 1, Math.round(cropRect.x))) : 0;
  const ry = cropRect ? Math.max(0, Math.min(imageHeight - 1, Math.round(cropRect.y))) : 0;
  const outW = cropRect
    ? Math.max(1, Math.min(imageWidth - rx, Math.round(cropRect.width)))
    : imageWidth;
  const outH = cropRect
    ? Math.max(1, Math.min(imageHeight - ry, Math.round(cropRect.height)))
    : imageHeight;

  // Step 1: render full-resolution annotated composition so local blurs sample full image cleanly
  const fullCanvas = document.createElement("canvas");
  fullCanvas.width = imageWidth;
  fullCanvas.height = imageHeight;
  const fctx = fullCanvas.getContext("2d");
  if (!fctx) {
    throw new Error("Canvas 2D context unavailable.");
  }

  fctx.drawImage(sourceImage, 0, 0, imageWidth, imageHeight);
  // Draw blur items first so callouts placed above a blurred region remain crisp
  for (const item of items) {
    if (item.type === "blur") {
      drawAnnotationItem(fctx, item, sourceImage, imageWidth, imageHeight);
    }
  }
  for (const item of items) {
    if (item.type !== "blur") {
      drawAnnotationItem(fctx, item, sourceImage, imageWidth, imageHeight);
    }
  }

  if (!cropRect || (rx === 0 && ry === 0 && outW === imageWidth && outH === imageHeight)) {
    return {
      dataUrl: fullCanvas.toDataURL("image/png"),
      width: imageWidth,
      height: imageHeight,
    };
  }

  // Step 2: slice exact cropped pixel region with zero resampling
  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = outW;
  cropCanvas.height = outH;
  const cctx = cropCanvas.getContext("2d");
  if (!cctx) {
    throw new Error("Canvas 2D context unavailable.");
  }
  cctx.drawImage(fullCanvas, rx, ry, outW, outH, 0, 0, outW, outH);
  return {
    dataUrl: cropCanvas.toDataURL("image/png"),
    width: outW,
    height: outH,
  };
}
