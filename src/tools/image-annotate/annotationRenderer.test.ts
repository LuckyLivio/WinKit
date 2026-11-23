import { describe, expect, it } from "vitest";
import {
  getAnnotationBounds,
  hitTestAnnotation,
  translateAnnotation,
  type AnnotationItem,
} from "./annotationRenderer";

describe("I12 annotation model, hit-testing, and coordinate translation", () => {
  it("hit-tests arrows, numbered badges, Chinese text callouts, and translates cleanly in pixel space", () => {
    const items: AnnotationItem[] = [
      {
        id: "a1",
        type: "arrow",
        x1: 100,
        y1: 100,
        x2: 260,
        y2: 180,
        color: "#DC2626",
        strokeWidth: 4,
      },
      {
        id: "n1",
        type: "number",
        x: 320,
        y: 200,
        value: 1,
        color: "#2563EB",
        radius: 18,
      },
      {
        id: "t1",
        type: "text",
        x: 120,
        y: 260,
        text: "请核对账户编号",
        color: "#DC2626",
        fontSize: 22,
        backgroundPill: true,
      },
    ];

    // Hit midpoint of arrow
    expect(hitTestAnnotation(items, 180, 140, 1)?.id).toBe("a1");
    // Hit numbered badge
    expect(hitTestAnnotation(items, 325, 204, 0.5)?.id).toBe("n1");
    // Hit Chinese text callout
    expect(hitTestAnnotation(items, 160, 272, 1)?.id).toBe("t1");
    // Empty space misses
    expect(hitTestAnnotation(items, 10, 10, 1)).toBeNull();

    // Translate arrow & verify exact pixel delta
    const moved = translateAnnotation(items[0]!, 30, -15);
    expect(moved.type).toBe("arrow");
    if (moved.type === "arrow") {
      expect({ x1: moved.x1, y1: moved.y1, x2: moved.x2, y2: moved.y2 }).toEqual({
        x1: 130,
        y1: 85,
        x2: 290,
        y2: 165,
      });
    }

    // Text bounds grow appropriately for Chinese text
    const textBounds = getAnnotationBounds(items[2]!);
    expect(textBounds.width).toBeGreaterThan(140);
    expect(textBounds.height).toBeGreaterThan(28);
  });
});
