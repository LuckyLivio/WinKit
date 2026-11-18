import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { CoordinateConverterWorkspace } from "./CoordinateConverterWorkspace";
import type { CoordinateWorkerLike } from "./coordinateController";
import {
  calculateWgs84EllipsoidDistance,
  convertCoordinateBatch,
  createWgs84Point,
  type CoordinateOutputFormatId,
} from "./coordinateEngine";
import type {
  CoordinateBatchWorkerRequest,
  CoordinateBatchWorkerResponse,
} from "./coordinateWorker";

function createControllableCoordWorkerFactory(options?: { manualAll?: boolean }) {
  const pending: Array<{
    req: CoordinateBatchWorkerRequest;
    flush: () => void;
    forceDeliverIgnoringTerminate: () => void;
    terminated: () => boolean;
  }> = [];

  const factory = (): CoordinateWorkerLike => {
    let isTerminated = false;
    const worker: CoordinateWorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(req: CoordinateBatchWorkerRequest) {
        if (options?.manualAll) {
          pending.push({
            req,
            terminated: () => isTerminated,
            flush: () => {
              if (isTerminated) return;
              worker.onmessage?.({
                data: { seq: req.seq, result: convertCoordinateBatch(req.input, req.options) },
              } as MessageEvent<CoordinateBatchWorkerResponse>);
            },
            forceDeliverIgnoringTerminate: () => {
              worker.onmessage?.({
                data: { seq: req.seq, result: convertCoordinateBatch(req.input, req.options) },
              } as MessageEvent<CoordinateBatchWorkerResponse>);
            },
          });
          return;
        }
        queueMicrotask(() => {
          if (isTerminated) return;
          worker.onmessage?.({
            data: { seq: req.seq, result: convertCoordinateBatch(req.input, req.options) },
          } as MessageEvent<CoordinateBatchWorkerResponse>);
        });
      },
      terminate() {
        isTerminated = true;
      },
    };
    return worker;
  };

  return { factory, pending };
}

describe("D10 CoordinateConverterWorkspace UI", () => {
  it("converts single points, verifies all 8 copied format strings match UI, preserves unrounded distance inputs across precision changes, and labels A/B errors", async () => {
    const user = userEvent.setup();
    let lastClipboard = "";
    const clipSpy = vi
      .spyOn(tauriBridge, "writeSystemClipboardText")
      .mockImplementation(async (val) => {
        lastClipboard = val;
      });

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <SessionStoreProvider>
          <CoordinateConverterWorkspace />
        </SessionStoreProvider>
      </I18nContext.Provider>,
    );

    // 1. Load sample `37.8197, -122.4786` and verify all 8 copy buttons copy exact rendered text
    await user.click(screen.getByRole("button", { name: "填入示例" }));

    const formatIds: CoordinateOutputFormatId[] = [
      "dd",
      "dms",
      "dm",
      "geojson",
      "wkt",
      "geo_uri",
      "apple_maps",
      "google_maps",
    ];

    for (const fmt of formatIds) {
      const shownText = screen.getByTestId(`coord-output-${fmt}`).textContent ?? "";
      expect(shownText.length).toBeGreaterThan(0);
      await user.click(screen.getByTestId(`coord-copy-${fmt}`));
      expect(lastClipboard).toBe(shownText);
    }

    expect(screen.getByTestId("coord-output-dms")).toHaveTextContent(
      "37°49′10.92″N 122°28′42.96″W",
    );

    // 2. Reduce DD display precision to 0 decimals (`38, -122`), then send current point to Point A:
    // Distance tab must receive the UNROUNDED `37.8197, -122.4786`, never truncated `38, -122`!
    const ddDecInput = screen.getByLabelText("十进制度位数 (0–8)");
    await user.clear(ddDecInput);
    await user.type(ddDecInput, "0");
    expect(screen.getByTestId("coord-output-dd")).toHaveTextContent("38, -122");

    await user.click(screen.getByRole("button", { name: "填入测距起点 A" }));
    expect(screen.getByTestId("coord-point-a-input")).toHaveValue(
      '{"type":"Point","coordinates":[-122.4786,37.8197]}',
    );

    // 3. Verify near-antipodal benchmark and Point B specific error labeling
    await user.click(screen.getByRole("button", { name: "近对跖点示例" }));
    expect(screen.getByTestId("coord-distance-m")).toHaveTextContent("19959679.267 m");

    const pointBInput = screen.getByTestId("coord-point-b-input");
    await user.clear(pointBInput);
    await user.type(pointBInput, "95, 0");
    expect(screen.getByTestId("coord-distance-error")).toHaveTextContent("终点 B 错误");

    clipSpy.mockRestore();
  });

  it.each([
    {
      targetSlot: "A" as const,
      sendButtonName: "填入测距起点 A",
      existingOtherPlainText: "10, 50", // under lon_lat => lon=10, lat=50
    },
    {
      targetSlot: "B" as const,
      sendButtonName: "填入测距终点 B",
      existingOtherPlainText: "10, 50", // under lon_lat => lon=10, lat=50
    },
  ])(
    "preserves both sent point (lat=40, lon=20) and existing plain-text endpoint when Distance tab uses lon_lat (target=$targetSlot)",
    async ({ targetSlot, sendButtonName, existingOtherPlainText }) => {
      const user = userEvent.setup();

      render(
        <I18nContext.Provider
          value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}
        >
          <SessionStoreProvider>
            <CoordinateConverterWorkspace />
          </SessionStoreProvider>
        </I18nContext.Provider>,
      );

      // 1. On Distance tab, set plain-text axis order to `经度, 纬度` (`lon_lat`) and put plain text in the OTHER slot
      await user.click(screen.getByRole("tab", { name: "两点测距" }));
      await user.click(screen.getByRole("button", { name: "经度, 纬度" }));

      const otherInput =
        targetSlot === "A"
          ? screen.getByTestId("coord-point-b-input")
          : screen.getByTestId("coord-point-a-input");
      await user.clear(otherInput);
      await user.type(otherInput, existingOtherPlainText);

      // 2. Return to Convert tab (default `纬度, 经度` = `lat_lon`), enter `40, 20` (lat=40, lon=20), and send to targetSlot
      await user.click(screen.getByRole("tab", { name: "坐标转换" }));
      const singleInput = screen.getByTestId("coord-single-input");
      await user.clear(singleInput);
      await user.type(singleInput, "40, 20");

      await user.click(screen.getByRole("button", { name: sendButtonName }));

      // 3. Distance tab must keep `lon_lat` for the existing plain-text endpoint (lat=50, lon=10)
      //    while parsing the sent structured point as (lat=40, lon=20), NOT flipped to (lat=20, lon=40)!
      const expectedSentPt = createWgs84Point(40, 20);
      const expectedOtherPt = createWgs84Point(50, 10);
      expect(expectedSentPt.ok && expectedOtherPt.ok).toBe(true);
      if (expectedSentPt.ok && expectedOtherPt.ok) {
        const expectedDist = calculateWgs84EllipsoidDistance(
          targetSlot === "A" ? expectedSentPt.point : expectedOtherPt.point,
          targetSlot === "A" ? expectedOtherPt.point : expectedSentPt.point,
        );
        expect(expectedDist.ok).toBe(true);
        if (expectedDist.ok) {
          expect(screen.getByTestId("coord-distance-m")).toHaveTextContent(
            `${expectedDist.meters.toFixed(3)} m`,
          );
        }
      }
    },
  );

  it("exports batch CSV matching UI rows (including failed rows by default) and isolates stale batch Workers & save snapshots", async () => {
    vi.useFakeTimers();
    const { factory, pending } = createControllableCoordWorkerFactory({ manualAll: true });

    const savedPayloads: Array<Parameters<typeof tauriBridge.saveLocalTextFile>[0]> = [];
    let resolvePickSave: ((p: string | null) => void) | null = null;

    const pickSaveSpy = vi.spyOn(tauriBridge, "pickSaveFilePath").mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          resolvePickSave = resolve;
        }),
    );
    const saveSpy = vi.spyOn(tauriBridge, "saveLocalTextFile").mockImplementation(async (args) => {
      savedPayloads.push(args);
      return { path: args.outputPath, byteLength: args.content.length };
    });

    try {
      render(
        <I18nContext.Provider
          value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}
        >
          <SessionStoreProvider>
            <CoordinateConverterWorkspace workerFactory={factory} />
          </SessionStoreProvider>
        </I18nContext.Provider>,
      );

      fireEvent.click(screen.getByRole("tab", { name: "批量转换" }));
      const batchEditor = screen.getByTestId("coord-batch-editor");

      // 1. Start old batch A, then replace with long batch B (>16,384 chars -> 120 ms debounce)
      fireEvent.change(batchEditor, { target: { value: "0, 0" } });
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(pending).toHaveLength(1);
      expect(pending[0]!.terminated()).toBe(false);

      const paddedBlank = " ".repeat(16_400);
      const batchB = `37.8197, -122.4786\n${paddedBlank}\ninvalid_place_query`;
      fireEvent.change(batchEditor, { target: { value: batchB } });

      // Old Worker A terminated immediately before debounce fires; late delivery ignored
      expect(pending[0]!.terminated()).toBe(true);
      await act(async () => {
        vi.advanceTimersByTime(40);
        pending[0]!.forceDeliverIgnoringTerminate();
        await Promise.resolve();
      });
      expect(screen.getByRole("button", { name: "保存 CSV…" })).toBeDisabled();

      // Flush Worker B after debounce
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
      expect(pending).toHaveLength(2);
      await act(async () => {
        pending[1]!.flush();
        await Promise.resolve();
      });

      expect(screen.getByTestId("coord-batch-status")).toHaveTextContent(
        "成功 1 行 · 失败 1 行 · 跳过空行 1 行",
      );
      expect(screen.getByTestId("coord-batch-table")).toHaveTextContent("#1");
      expect(screen.getByTestId("coord-batch-table")).toHaveTextContent("#3");

      // 2. Save CSV in normal flow -> written CSV contains both line #1 (ok) and line #3 (error)
      const saveBtn = screen.getByRole("button", { name: "保存 CSV…" });
      await act(async () => {
        fireEvent.click(saveBtn);
        await Promise.resolve();
      });
      await act(async () => {
        resolvePickSave?.("D:\\temp\\coords_out.csv");
        await Promise.resolve();
      });
      expect(savedPayloads).toHaveLength(1);
      expect(savedPayloads[0]?.content).toContain(
        '1,"37.8197, -122.4786",ok,37.8197,-122.4786,"37.8197, -122.4786",',
      );
      expect(savedPayloads[0]?.content).toContain("3,invalid_place_query,error,,,,");

      // 3. Open Save dialog again, then Clear while dialog is open -> save cancelled cleanly
      savedPayloads.length = 0;
      await act(async () => {
        fireEvent.click(saveBtn);
        await Promise.resolve();
      });
      fireEvent.click(screen.getByRole("button", { name: "清空" }));
      await act(async () => {
        resolvePickSave?.("D:\\temp\\stale_coords.csv");
        await Promise.resolve();
      });
      expect(savedPayloads).toHaveLength(0);
      expect(screen.getByTestId("coord-io-banner")).toHaveClass("is-err");
    } finally {
      vi.useRealTimers();
      pickSaveSpy.mockRestore();
      saveSpy.mockRestore();
    }
  });
});
