import type { CropAspectPreset } from "../../lib/mediaSessionStore";

export interface OrientationTransform {
  rotateCw: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function getOrientedDimensions(
  displayWidth: number,
  displayHeight: number,
  rotateCw: 0 | 90 | 180 | 270,
): { width: number; height: number } {
  if (rotateCw === 90 || rotateCw === 270) {
    return { width: displayHeight, height: displayWidth };
  }
  return { width: displayWidth, height: displayHeight };
}

export function makeEven(n: number): number {
  const r = Math.max(2, Math.round(n));
  return Math.max(2, Math.floor(r / 2) * 2);
}

export function clampCropRect(rect: CropRect, maxW: number, maxH: number): CropRect {
  if (maxW < 2 || maxH < 2) return { x: 0, y: 0, width: 0, height: 0 };
  const evenMaxW = Math.floor(maxW / 2) * 2;
  const evenMaxH = Math.floor(maxH / 2) * 2;
  const w = Math.min(evenMaxW, makeEven(rect.width));
  const h = Math.min(evenMaxH, makeEven(rect.height));
  const x = Math.max(0, Math.min(maxW - w, Math.round(rect.x)));
  const y = Math.max(0, Math.min(maxH - h, Math.round(rect.y)));
  return { x, y, width: w, height: h };
}

export function aspectRatioValue(preset: CropAspectPreset): number | null {
  switch (preset) {
    case "1:1":
      return 1;
    case "16:9":
      return 16 / 9;
    case "9:16":
      return 9 / 16;
    case "free":
      return null;
  }
}

export function fitCropToAspect(
  orientedW: number,
  orientedH: number,
  preset: CropAspectPreset,
): CropRect {
  const ratio = aspectRatioValue(preset);
  if (!ratio || orientedW < 2 || orientedH < 2) {
    return clampCropRect({ x: 0, y: 0, width: orientedW, height: orientedH }, orientedW, orientedH);
  }
  let w = orientedW;
  let h = w / ratio;
  if (h > orientedH) {
    h = orientedH;
    w = h * ratio;
  }
  const ew = Math.min(Math.floor(orientedW / 2) * 2, makeEven(w));
  const eh = Math.min(Math.floor(orientedH / 2) * 2, makeEven(h));
  const x = Math.floor((orientedW - ew) / 2);
  const y = Math.floor((orientedH - eh) / 2);
  return { x, y, width: ew, height: eh };
}

/**
 * Canonicalize any `(rotateCw, flipH, flipV)` into `(rotateCw, flipH, false)` because
 * `flipV === rotate(180) + flipH` in the dihedral group D4.
 */
function canonicalize(t: OrientationTransform): { rotateCw: 0 | 90 | 180 | 270; flipH: boolean } {
  if (t.flipV) {
    return {
      rotateCw: ((t.rotateCw + 180) % 360) as 0 | 90 | 180 | 270,
      flipH: !t.flipH,
    };
  }
  return { rotateCw: t.rotateCw, flipH: t.flipH };
}

export function applyOrientationOp(
  current: OrientationTransform,
  rect: CropRect,
  orientedW: number,
  orientedH: number,
  op: "rotate_cw" | "rotate_ccw" | "flip_h" | "flip_v",
): { transform: OrientationTransform; rect: CropRect; nextW: number; nextH: number } {
  const canon = canonicalize(current);
  if (op === "flip_h") {
    const nextTransform: OrientationTransform = {
      rotateCw: canon.rotateCw,
      flipH: !canon.flipH,
      flipV: false,
    };
    const nextRect = clampCropRect(
      { x: orientedW - (rect.x + rect.width), y: rect.y, width: rect.width, height: rect.height },
      orientedW,
      orientedH,
    );
    return { transform: nextTransform, rect: nextRect, nextW: orientedW, nextH: orientedH };
  }
  if (op === "flip_v") {
    const nextTransform: OrientationTransform = {
      rotateCw: ((canon.rotateCw + 180) % 360) as 0 | 90 | 180 | 270,
      flipH: !canon.flipH,
      flipV: false,
    };
    const nextRect = clampCropRect(
      { x: rect.x, y: orientedH - (rect.y + rect.height), width: rect.width, height: rect.height },
      orientedW,
      orientedH,
    );
    return { transform: nextTransform, rect: nextRect, nextW: orientedW, nextH: orientedH };
  }
  if (op === "rotate_cw") {
    const delta = canon.flipH ? 270 : 90;
    const nextTransform: OrientationTransform = {
      rotateCw: ((canon.rotateCw + delta) % 360) as 0 | 90 | 180 | 270,
      flipH: canon.flipH,
      flipV: false,
    };
    const nextW = orientedH;
    const nextH = orientedW;
    const nextRect = clampCropRect(
      { x: orientedH - (rect.y + rect.height), y: rect.x, width: rect.height, height: rect.width },
      nextW,
      nextH,
    );
    return { transform: nextTransform, rect: nextRect, nextW, nextH };
  }
  // rotate_ccw
  const delta = canon.flipH ? 90 : 270;
  const nextTransform: OrientationTransform = {
    rotateCw: ((canon.rotateCw + delta) % 360) as 0 | 90 | 180 | 270,
    flipH: canon.flipH,
    flipV: false,
  };
  const nextW = orientedH;
  const nextH = orientedW;
  const nextRect = clampCropRect(
    { x: rect.y, y: orientedW - (rect.x + rect.width), width: rect.height, height: rect.width },
    nextW,
    nextH,
  );
  return { transform: nextTransform, rect: nextRect, nextW, nextH };
}
