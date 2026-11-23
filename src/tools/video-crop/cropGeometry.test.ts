import { describe, expect, it } from "vitest";
import { applyOrientationOp, fitCropToAspect, getOrientedDimensions } from "./cropGeometry";

describe("cropGeometry D4 orientation and aspect math", () => {
  it("fits 9:16, 16:9, and 1:1 presets cleanly inside portrait and landscape frames", () => {
    expect(fitCropToAspect(360, 640, "1:1")).toEqual({ x: 0, y: 140, width: 360, height: 360 });
    expect(fitCropToAspect(1920, 1080, "9:16")).toEqual({ x: 656, y: 0, width: 608, height: 1080 });
    expect(fitCropToAspect(360, 640, "9:16")).toEqual({ x: 0, y: 0, width: 360, height: 640 });
  });

  it("keeps crop box locked to exact same subject under rotate + flip sequences", () => {
    // Portrait 360x640, top-left quadrant (0, 0, 180, 320)
    const start = { rotateCw: 0 as const, flipH: false, flipV: false };
    const startRect = { x: 0, y: 0, width: 180, height: 320 };

    // Flip horizontally -> moves to top-right (180, 0, 180, 320)
    const afterFlipH = applyOrientationOp(start, startRect, 360, 640, "flip_h");
    expect(afterFlipH.transform).toEqual({ rotateCw: 0, flipH: true, flipV: false });
    expect(afterFlipH.rect).toEqual({ x: 180, y: 0, width: 180, height: 320 });

    // Rotate 90 CW from flipped state -> dimensions swap to 640x360; old (180,0,180,320) -> (320,180,320,180)
    const afterRot = applyOrientationOp(
      afterFlipH.transform,
      afterFlipH.rect,
      afterFlipH.nextW,
      afterFlipH.nextH,
      "rotate_cw",
    );
    expect(afterRot.transform).toEqual({ rotateCw: 270, flipH: true, flipV: false });
    expect(getOrientedDimensions(360, 640, afterRot.transform.rotateCw)).toEqual({
      width: 640,
      height: 360,
    });
    expect(afterRot.rect).toEqual({ x: 320, y: 180, width: 320, height: 180 });
  });
});
