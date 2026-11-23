//! Shared original-image pixel coordinate and viewport math for I11 (Redact) and I12 (Annotate).
//!
//! All shapes, redactions, and crop rectangles are stored strictly in original source-image
//! pixel coordinates (`0..imageWidth`, `0..imageHeight`). Changing zoom, panning, resizing the
//! window, changing Windows DPI scaling, or switching tools never drifts stored coordinates.

export interface PixelPoint {
  x: number;
  y: number;
}

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewportState {
  mode: "fit" | "manual";
  scale: number;
  panX: number;
  panY: number;
}

export interface ResolvedViewport {
  scale: number;
  offsetX: number;
  offsetY: number;
  displayWidth: number;
  displayHeight: number;
}

export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const DEFAULT_VIEWPORT: ViewportState = {
  mode: "fit",
  scale: 1,
  panX: 0,
  panY: 0,
};

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8.0;

export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

export function computeFitScale(
  stageWidth: number,
  stageHeight: number,
  imageWidth: number,
  imageHeight: number,
  marginPx = 28,
): number {
  if (imageWidth <= 0 || imageHeight <= 0) return 1;
  const availW = Math.max(80, stageWidth - marginPx * 2);
  const availH = Math.max(80, stageHeight - marginPx * 2);
  const raw = Math.min(availW / imageWidth, availH / imageHeight);
  const maxFit = imageWidth < 240 && imageHeight < 240 ? 2 : 1;
  return clampZoom(Math.min(raw, maxFit));
}

export function resolveViewport(
  stageWidth: number,
  stageHeight: number,
  imageWidth: number,
  imageHeight: number,
  viewport: ViewportState,
): ResolvedViewport {
  const safeStageW = Math.max(1, stageWidth);
  const safeStageH = Math.max(1, stageHeight);
  const safeImgW = Math.max(1, imageWidth);
  const safeImgH = Math.max(1, imageHeight);

  if (viewport.mode === "fit") {
    const scale = computeFitScale(safeStageW, safeStageH, safeImgW, safeImgH);
    const displayWidth = safeImgW * scale;
    const displayHeight = safeImgH * scale;
    return {
      scale,
      offsetX: (safeStageW - displayWidth) / 2,
      offsetY: (safeStageH - displayHeight) / 2,
      displayWidth,
      displayHeight,
    };
  }

  const scale = clampZoom(viewport.scale);
  const displayWidth = safeImgW * scale;
  const displayHeight = safeImgH * scale;
  return {
    scale,
    offsetX: (safeStageW - displayWidth) / 2 + viewport.panX,
    offsetY: (safeStageH - displayHeight) / 2 + viewport.panY,
    displayWidth,
    displayHeight,
  };
}

export function screenToImage(
  clientX: number,
  clientY: number,
  stageLeft: number,
  stageTop: number,
  resolved: ResolvedViewport,
): PixelPoint {
  return {
    x: (clientX - stageLeft - resolved.offsetX) / resolved.scale,
    y: (clientY - stageTop - resolved.offsetY) / resolved.scale,
  };
}

export function imageToScreen(ix: number, iy: number, resolved: ResolvedViewport): PixelPoint {
  return {
    x: resolved.offsetX + ix * resolved.scale,
    y: resolved.offsetY + iy * resolved.scale,
  };
}

export function zoomViewportAroundStagePoint(
  stageWidth: number,
  stageHeight: number,
  imageWidth: number,
  imageHeight: number,
  current: ViewportState,
  nextScaleRaw: number,
  stageAnchorX: number,
  stageAnchorY: number,
): ViewportState {
  const before = resolveViewport(stageWidth, stageHeight, imageWidth, imageHeight, current);
  const imgX = (stageAnchorX - before.offsetX) / before.scale;
  const imgY = (stageAnchorY - before.offsetY) / before.scale;

  const nextScale = clampZoom(nextScaleRaw);
  const nextDisplayW = imageWidth * nextScale;
  const nextDisplayH = imageHeight * nextScale;
  const baseOffsetX = (stageWidth - nextDisplayW) / 2;
  const baseOffsetY = (stageHeight - nextDisplayH) / 2;
  const targetOffsetX = stageAnchorX - imgX * nextScale;
  const targetOffsetY = stageAnchorY - imgY * nextScale;

  return {
    mode: "manual",
    scale: nextScale,
    panX: targetOffsetX - baseOffsetX,
    panY: targetOffsetY - baseOffsetY,
  };
}

export function normalizeRectFromDrag(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  imageWidth: number,
  imageHeight: number,
): PixelRect {
  const x0 = Math.max(0, Math.min(imageWidth, Math.min(startX, endX)));
  const y0 = Math.max(0, Math.min(imageHeight, Math.min(startY, endY)));
  const x1 = Math.max(0, Math.min(imageWidth, Math.max(startX, endX)));
  const y1 = Math.max(0, Math.min(imageHeight, Math.max(startY, endY)));
  return {
    x: Math.round(x0),
    y: Math.round(y0),
    width: Math.round(x1 - x0),
    height: Math.round(y1 - y0),
  };
}

export function clampRectToImage(
  rect: PixelRect,
  imageWidth: number,
  imageHeight: number,
  minSize = 4,
): PixelRect {
  const w = Math.max(minSize, Math.min(imageWidth, Math.round(rect.width)));
  const h = Math.max(minSize, Math.min(imageHeight, Math.round(rect.height)));
  const x = Math.max(0, Math.min(imageWidth - w, Math.round(rect.x)));
  const y = Math.max(0, Math.min(imageHeight - h, Math.round(rect.y)));
  return { x, y, width: w, height: h };
}

export function getHandlePositions(rect: PixelRect): Record<ResizeHandle, PixelPoint> {
  const mx = rect.x + rect.width / 2;
  const my = rect.y + rect.height / 2;
  const r = rect.x + rect.width;
  const b = rect.y + rect.height;
  return {
    nw: { x: rect.x, y: rect.y },
    n: { x: mx, y: rect.y },
    ne: { x: r, y: rect.y },
    e: { x: r, y: my },
    se: { x: r, y: b },
    s: { x: mx, y: b },
    sw: { x: rect.x, y: b },
    w: { x: rect.x, y: my },
  };
}

export function hitTestResizeHandle(
  imgX: number,
  imgY: number,
  rect: PixelRect,
  scale: number,
  hitRadiusScreenPx = 9,
): ResizeHandle | null {
  const threshold = hitRadiusScreenPx / Math.max(0.05, scale);
  const handles = getHandlePositions(rect);
  const order: ResizeHandle[] = ["nw", "ne", "se", "sw", "n", "e", "s", "w"];
  for (const key of order) {
    const pt = handles[key];
    if (Math.abs(imgX - pt.x) <= threshold && Math.abs(imgY - pt.y) <= threshold) {
      return key;
    }
  }
  return null;
}

export function applyHandleResize(
  orig: PixelRect,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  imageWidth: number,
  imageHeight: number,
  minSize = 8,
): PixelRect {
  let x1 = orig.x;
  let y1 = orig.y;
  let x2 = orig.x + orig.width;
  let y2 = orig.y + orig.height;

  if (handle.includes("w")) x1 = Math.min(x2 - minSize, Math.max(0, orig.x + dx));
  if (handle.includes("e")) x2 = Math.max(x1 + minSize, Math.min(imageWidth, x2 + dx));
  if (handle.includes("n")) y1 = Math.min(y2 - minSize, Math.max(0, orig.y + dy));
  if (handle.includes("s")) y2 = Math.max(y1 + minSize, Math.min(imageHeight, y2 + dy));

  return {
    x: Math.round(x1),
    y: Math.round(y1),
    width: Math.max(minSize, Math.round(x2 - x1)),
    height: Math.max(minSize, Math.round(y2 - y1)),
  };
}

export function handleCursorFor(handle: ResizeHandle | null): string {
  switch (handle) {
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    case "n":
    case "s":
      return "ns-resize";
    case "e":
    case "w":
      return "ew-resize";
    default:
      return "default";
  }
}

export function drawSelectionHandles(
  ctx: CanvasRenderingContext2D,
  rect: PixelRect,
  resolved: ResolvedViewport,
  accentColor = "#2563EB",
): void {
  const tl = imageToScreen(rect.x, rect.y, resolved);
  const w = rect.width * resolved.scale;
  const h = rect.height * resolved.scale;

  ctx.save();
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(tl.x, tl.y, w, h);
  ctx.setLineDash([]);

  const handles = getHandlePositions(rect);
  const size = 7;
  for (const pt of Object.values(handles)) {
    const sp = imageToScreen(pt.x, pt.y, resolved);
    ctx.fillStyle = "#FFFFFF";
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 1.5;
    ctx.fillRect(sp.x - size / 2, sp.y - size / 2, size, size);
    ctx.strokeRect(sp.x - size / 2, sp.y - size / 2, size, size);
  }
  ctx.restore();
}
