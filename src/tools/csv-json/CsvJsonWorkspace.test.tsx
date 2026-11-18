import { render, screen, waitFor } from "@testing-library/react";
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

function createControllableWorkerFactory() {
  const pending: Array<{
    req: TabularWorkerRequest;
    flush: () => void;
    terminated: () => boolean;
  }> = [];

  const factory = (): TabularWorkerLike => {
    let isTerminated = false;
    const worker: TabularWorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(req: TabularWorkerRequest) {
        if (req.input.includes("SLOW_FIRST")) {
          pending.push({
            req,
            terminated: () => isTerminated,
            flush: () => {
              if (isTerminated) return;
              worker.onmessage?.({
                data: { seq: req.seq, result: convertTabularData(req.input, req.options) },
              } as MessageEvent<TabularWorkerResponse>);
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
});
