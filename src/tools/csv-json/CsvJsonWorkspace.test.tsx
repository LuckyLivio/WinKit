import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { convertTabularData } from "./csvJsonEngine";
import { CsvJsonWorkspace } from "./CsvJsonWorkspace";
import type { TabularWorkerLike } from "./tabularController";
import type { TabularWorkerRequest, TabularWorkerResponse } from "./tabularWorker";

function createControllableWorkerFactory(options?: { manualAll?: boolean }) {
  const pending: Array<{
    req: TabularWorkerRequest;
    flush: () => void;
    forceDeliverIgnoringTerminate: () => void;
    fail: (message: string) => void;
    terminated: () => boolean;
  }> = [];

  const factory = (): TabularWorkerLike => {
    let isTerminated = false;
    const worker: TabularWorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(req: TabularWorkerRequest) {
        if (options?.manualAll || req.input.includes("SLOW_FIRST")) {
          pending.push({
            req,
            terminated: () => isTerminated,
            flush: () => {
              if (isTerminated) return;
              worker.onmessage?.({
                data: { seq: req.seq, result: convertTabularData(req.input, req.options) },
              } as MessageEvent<TabularWorkerResponse>);
            },
            forceDeliverIgnoringTerminate: () => {
              worker.onmessage?.({
                data: { seq: req.seq, result: convertTabularData(req.input, req.options) },
              } as MessageEvent<TabularWorkerResponse>);
            },
            fail: (message: string) => {
              worker.onerror?.({ message } as ErrorEvent);
            },
          });
          return;
        }
        queueMicrotask(() => {
          if (isTerminated) return;
          worker.onmessage?.({
            data: { seq: req.seq, result: convertTabularData(req.input, req.options) },
          } as MessageEvent<TabularWorkerResponse>);
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

describe("D14 CsvJsonWorkspace UI", () => {
  it("isolates stale/cancelled Worker jobs, clears stale output on error, and handles save failure cleanly", async () => {
    const user = userEvent.setup();
    const { factory, pending } = createControllableWorkerFactory();

    const pickSaveSpy = vi
      .spyOn(tauriBridge, "pickSaveFilePath")
      .mockResolvedValue("D:\\temp\\out.json");
    const saveSpy = vi
      .spyOn(tauriBridge, "saveLocalTextFile")
      .mockRejectedValue(
        JSON.stringify({ code: "SAME_INPUT_AND_OUTPUT", message: "Refused overwrite" }),
      );

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <SessionStoreProvider>
          <CsvJsonWorkspace workerFactory={factory} />
        </SessionStoreProvider>
      </I18nContext.Provider>,
    );

    const inputEditor = screen.getByTestId("csvjson-input-editor");

    // 1. Trigger a slow Worker job (`SLOW_FIRST`), then immediately type a newer input (`FAST_SECOND`)
    await user.click(inputEditor);
    await user.paste("col\nSLOW_FIRST");
    expect(pending.length).toBeGreaterThan(0);

    await user.clear(inputEditor);
    await user.paste("id,zip\n9007199254740993,00123");

    // Flush the old slow job after the newer job -> old job was terminated & cannot overwrite!
    pending.forEach((p) => p.flush());

    await waitFor(() =>
      expect(screen.getByTestId("csvjson-status-banner")).toHaveTextContent("1 行 × 2 列"),
    );
    expect(screen.getByTestId("csvjson-output-editor")).toHaveValue(
      '[\n  {\n    "id": "9007199254740993",\n    "zip": "00123"\n  }\n]',
    );
    expect(pending[0]?.terminated()).toBe(true);

    // 2. Save failure reports error banner and NEVER falsely shows saved success
    await user.click(screen.getByRole("button", { name: "另存为…" }));
    await waitFor(() => expect(screen.getByTestId("csvjson-io-banner")).toHaveClass("is-err"));

    // 3. Broken CSV clears previous output and disables Copy / Save so stale output can never be exported
    await user.clear(inputEditor);
    await user.paste('id,zip\n"unterminated');
    await waitFor(() => expect(screen.getByTestId("csvjson-status-banner")).toHaveClass("is-err"));
    expect(screen.getByTestId("csvjson-output-editor")).toHaveValue("");
    expect(screen.getByRole("button", { name: "复制完整结果" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "另存为…" })).toBeDisabled();

    pickSaveSpy.mockRestore();
    saveSpy.mockRestore();
  });

  it("cancels old Worker immediately during debounce, blocks stale clear/failure callbacks, and guards save dialogs across option changes", async () => {
    vi.useFakeTimers();
    const { factory, pending } = createControllableWorkerFactory({ manualAll: true });

    let resolvePickSave: ((path: string | null) => void) | null = null;
    const pickSaveSpy = vi.spyOn(tauriBridge, "pickSaveFilePath").mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          resolvePickSave = resolve;
        }),
    );
    const saveSpy = vi.spyOn(tauriBridge, "saveLocalTextFile").mockResolvedValue({
      path: "D:\\temp\\out.json",
      byteLength: 10,
    });

    try {
      render(
        <I18nContext.Provider
          value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}
        >
          <SessionStoreProvider>
            <CsvJsonWorkspace workerFactory={factory} />
          </SessionStoreProvider>
        </I18nContext.Provider>,
      );

      const inputEditor = screen.getByTestId("csvjson-input-editor");
      const copyBtn = screen.getByRole("button", { name: "复制完整结果" });
      const saveBtn = screen.getByRole("button", { name: "另存为…" });

      // 1. Start Input A (short -> 0 ms timer), then switch to Input B (>32,768 chars -> 140 ms debounce)
      fireEvent.change(inputEditor, { target: { value: "id,val\n1,FIRST_A" } });
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(pending).toHaveLength(1);
      expect(pending[0]!.terminated()).toBe(false);

      const longInputB = `id,val\n2,${"B".repeat(33_000)}`;
      fireEvent.change(inputEditor, { target: { value: longInputB } });

      // Worker A must ALREADY be terminated before B's 140 ms debounce timer fires
      expect(pending[0]!.terminated()).toBe(true);
      expect(pending).toHaveLength(1);

      // Even if A attempts to deliver a late message during B's debounce window (t = 50 ms),
      // A must NOT be shown as B's result or re-enable Copy/Save
      await act(async () => {
        vi.advanceTimersByTime(50);
        pending[0]!.forceDeliverIgnoringTerminate();
        await Promise.resolve();
      });
      expect(screen.getByTestId("csvjson-output-editor")).toHaveValue("");
      expect(copyBtn).toBeDisabled();
      expect(saveBtn).toBeDisabled();

      // Advance past B's 140 ms debounce and flush Worker B
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
      expect(pending).toHaveLength(2);
      await act(async () => {
        pending[1]!.flush();
        await Promise.resolve();
      });
      expect(copyBtn).not.toBeDisabled();
      expect(saveBtn).not.toBeDisabled();

      // 2. Open Save dialog while valid JSON output is active, then change direction while dialog is open
      await act(async () => {
        fireEvent.click(saveBtn);
        await Promise.resolve();
      });
      expect(resolvePickSave).not.toBeNull();

      // User switches direction to JSON -> CSV while native Save dialog is open
      fireEvent.click(screen.getByRole("button", { name: "JSON → CSV" }));

      await act(async () => {
        resolvePickSave?.("D:\\temp\\mixed_stale.json");
        await Promise.resolve();
      });
      // Must NOT write stale JSON content after options changed
      expect(saveSpy).not.toHaveBeenCalled();
      expect(screen.getByTestId("csvjson-io-banner")).toHaveClass("is-err");

      // 3. Old Worker fails while newer Worker is running -> newer Worker stays running and succeeds
      fireEvent.click(screen.getByRole("button", { name: "CSV → JSON" }));
      fireEvent.change(inputEditor, { target: { value: "k\nv_old_err" } });
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      const errWorkerIdx = pending.length - 1;

      fireEvent.change(inputEditor, { target: { value: "k\nv_new_ok" } });
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      const okWorkerIdx = pending.length - 1;

      await act(async () => {
        pending[errWorkerIdx]!.fail("STALE_WORKER_CRASH");
        await Promise.resolve();
      });
      expect(screen.getByTestId("csvjson-status-banner")).toHaveTextContent("正在后台 Worker");

      await act(async () => {
        pending[okWorkerIdx]!.flush();
        await Promise.resolve();
      });
      expect(screen.getByTestId("csvjson-output-editor")).toHaveValue(
        '[\n  {\n    "k": "v_new_ok"\n  }\n]',
      );

      // 4. Clear while Worker is running -> late completion cannot restore cleared output
      fireEvent.change(inputEditor, { target: { value: "k\nv_before_clear" } });
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      const clearWorkerIdx = pending.length - 1;

      fireEvent.click(screen.getByRole("button", { name: "清空" }));
      await act(async () => {
        pending[clearWorkerIdx]!.forceDeliverIgnoringTerminate();
        await Promise.resolve();
      });
      expect(screen.getByTestId("csvjson-output-editor")).toHaveValue("");
      expect(copyBtn).toBeDisabled();
    } finally {
      vi.useRealTimers();
      pickSaveSpy.mockRestore();
      saveSpy.mockRestore();
    }
  });
});
