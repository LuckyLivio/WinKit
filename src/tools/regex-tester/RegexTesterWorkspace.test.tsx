import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import type { RegexWorkerLike } from "./regexController";
import { executeRegexInWorkerScope } from "./regexCore";
import { RegexTesterWorkspace } from "./RegexTesterWorkspace";
import type { RegexWorkerMessageIn, RegexWorkerMessageOut } from "./regexWorker";

function createTestWorkerFactory(): () => RegexWorkerLike {
  return () => {
    let terminated = false;
    const worker: RegexWorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(msg: RegexWorkerMessageIn) {
        if (msg.request.pattern === "SIMULATE_HANG") {
          // Never responds -> exercises external watchdog timeout & worker.terminate()
          return;
        }
        queueMicrotask(() => {
          if (terminated) return;
          const result = executeRegexInWorkerScope(msg.request);
          worker.onmessage?.({
            data: { seq: msg.seq, result },
          } as MessageEvent<RegexWorkerMessageOut>);
        });
      },
      terminate() {
        terminated = true;
      },
    };
    return worker;
  };
}

describe("D08 RegexTesterWorkspace UI", () => {
  it("highlights matches, displays named captures and replacement preview, handles Worker timeout, and recovers cleanly", async () => {
    const user = userEvent.setup();
    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <SessionStoreProvider>
          <RegexTesterWorkspace workerFactory={createTestWorkerFactory()} timeoutMs={80} />
        </SessionStoreProvider>
      </I18nContext.Provider>,
    );

    const patternInput = screen.getByLabelText("正则表达式 (Pattern)");
    const testTextInput = screen.getByLabelText("测试文本（上限 2 MiB，不修改原文件）");

    await user.click(testTextInput);
    await user.paste("Order #42 and Order #99");
    await user.click(patternInput);
    await user.paste("Order #(?<id>\\d+)");

    await waitFor(() =>
      expect(screen.getByTestId("regex-status-banner")).toHaveTextContent("共命中 2 处匹配"),
    );
    expect(screen.getByTestId("regex-matches-table")).toHaveTextContent("$1 ($<id>)");
    expect(screen.getByTestId("regex-matches-table")).toHaveTextContent("99");

    // Enable replacement preview
    await user.click(screen.getByLabelText("启用替换预览"));
    const replaceInput = screen.getByLabelText("替换模板 (Replacement)");
    await user.click(replaceInput);
    await user.paste("ID=$<id>");

    await waitFor(() =>
      expect(screen.getByTestId("regex-replacement-preview")).toHaveTextContent("ID=42 and ID=99"),
    );

    // Trigger Worker timeout -> shows timeout alert without crashing, then recovers on simple regex
    await user.clear(patternInput);
    await user.paste("SIMULATE_HANG");

    await waitFor(() =>
      expect(screen.getByTestId("regex-status-banner")).toHaveTextContent("已强制终止后台 Worker"),
    );

    await user.clear(patternInput);
    await user.paste("#\\d+");
    await waitFor(() =>
      expect(screen.getByTestId("regex-status-banner")).toHaveTextContent("共命中 2 处匹配"),
    );
  });
});
