import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIEWPORT,
  applyHandleResize,
  hitTestResizeHandle,
  imageToScreen,
  resolveViewport,
  screenToImage,
  zoomViewportAroundStagePoint,
} from "./canvasViewport";

describe("shared image editor canvas viewport coordinates", () => {
  it("preserves exact original-image pixel coordinates across zoom, pan, and window resize", () => {
    // Original 1920x1080 screenshot displayed inside a 900x540 stage
    const fitA = resolveViewport(900, 540, 1920, 1080, DEFAULT_VIEWPORT);
    const pt = { x: 420, y: 260 };
    const screenA = imageToScreen(pt.x, pt.y, fitA);
    const backA = screenToImage(screenA.x + 120, screenA.y + 80, 120, 80, fitA);
    expect(backA.x).toBeCloseTo(pt.x, 5);
    expect(backA.y).toBeCloseTo(pt.y, 5);

    // Zoom to 2.0 around an arbitrary stage anchor — the anchor pixel stays locked
    const zoomed = zoomViewportAroundStagePoint(
      900,
      540,
      1920,
      1080,
      DEFAULT_VIEWPORT,
      2.0,
      screenA.x,
      screenA.y,
    );
    const resolvedZoomed = resolveViewport(900, 540, 1920, 1080, zoomed);
    const screenAfterZoom = imageToScreen(pt.x, pt.y, resolvedZoomed);
    expect(screenAfterZoom.x).toBeCloseTo(screenA.x, 4);
    expect(screenAfterZoom.y).toBeCloseTo(screenA.y, 4);

    // Simulate resizing window (150% DPI compact viewport 640x400): Fit recalculates cleanly
    const fitB = resolveViewport(640, 400, 1920, 1080, DEFAULT_VIEWPORT);
    const screenB = imageToScreen(pt.x, pt.y, fitB);
    const backB = screenToImage(screenB.x, screenB.y, 0, 0, fitB);
    expect(backB.x).toBeCloseTo(pt.x, 5);
    expect(backB.y).toBeCloseTo(pt.y, 5);
  });

  it("hit-tests and resizes handles in original pixel coordinates bounded to image dimensions", () => {
    const rect = { x: 100, y: 80, width: 200, height: 120 };
    expect(hitTestResizeHandle(300, 200, rect, 0.5)).toBe("se");
    expect(hitTestResizeHandle(100, 80, rect, 2.0)).toBe("nw");

    const resized = applyHandleResize(rect, "se", 50, -20, 1000, 800, 10);
    expect(resized).toEqual({ x: 100, y: 80, width: 250, height: 100 });

    // Clamps to image bounds
    const clamped = applyHandleResize(rect, "nw", -500, -500, 1000, 800, 10);
    expect(clamped).toEqual({ x: 0, y: 0, width: 300, height: 200 });
  });
});
