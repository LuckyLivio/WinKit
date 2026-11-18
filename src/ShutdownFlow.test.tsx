import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { StrictMode, useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import {
  isFrontendShuttingDown,
  registerCancelableFrontendWorker,
  resetFrontendShutdownGate,
} from "./lib/shutdownGate";
import * as tauriBridge from "./lib/tauriBridge";
import type { RegisteredTool } from "./registry/tools";

const MINIMAL_TOOLS: RegisteredTool[] = [
  {
    id: "D01",
    category: "developer",
    name: { "zh-CN": "JSON 格式化与校验", "en-US": "JSON Formatter" },
    summary: { "zh-CN": "格式化与校验 JSON", "en-US": "Format and validate JSON" },
    keywords: ["json"],
    icon: "braces",
    implementationStatus: "full",
    component: () => <div>JSON Tool</div>,
  },
];

describe("Phase 1.1 window shutdown coordination & regressions", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetFrontendShutdownGate();
    vi.restoreAllMocks();
  });

  it("grants narrow core:window:allow-destroy permission without wildcard window/process/shell permissions", () => {
    const capPath = resolve(process.cwd(), "src-tauri/capabilities/default.json");
    const cap = JSON.parse(readFileSync(capPath, "utf-8")) as { permissions: string[] };
    expect(cap.permissions).toContain("core:window:allow-destroy");
    expect(
      cap.permissions.some(
        (p) =>
          p === "window:default" ||
          p.startsWith("shell:") ||
          p.startsWith("process:") ||
          p.includes("allow-all"),
      ),
    ).toBe(false);
  });

  it("immediately unlistens late-resolving Tauri subscriptions under React StrictMode", async () => {
    let activeSubscriptions = 0;
    const pendingResolvers: Array<() => void> = [];

    function StrictSubscriber() {
      useEffect(() => {
        return tauriBridge.bindDisposableListener(
          () =>
            new Promise<() => void>((resolvePromise) => {
              pendingResolvers.push(() => {
                activeSubscriptions += 1;
                resolvePromise(() => {
                  activeSubscriptions -= 1;
                });
              });
            }),
          "strict-test-event",
        );
      }, []);
      return <div>Subscriber</div>;
    }

    const { unmount } = render(
      <StrictMode>
        <StrictSubscriber />
      </StrictMode>,
    );

    // Resolve all queued registrations (StrictMode mounts twice in dev/test)
    await act(async () => {
      for (const run of pendingResolvers) {
        run();
      }
    });

    // Only the live mount's listener remains active
    expect(activeSubscriptions).toBe(1);

    unmount();
    expect(activeSubscriptions).toBe(0);
  });

  it("destroys window directly on coordinated idle close, terminates frontend workers, and blocks new tasks", async () => {
    let triggerClose: (() => Promise<void> | void) | null = null;
    vi.spyOn(tauriBridge, "subscribeNativeCloseRequest").mockImplementation(async (cb) => {
      triggerClose = cb;
      return () => {};
    });
    vi.spyOn(tauriBridge, "requestWindowClose").mockResolvedValue({
      immediateCloseAllowed: true,
      snapshot: {
        shuttingDown: true,
        activeCount: 0,
        interruptibleCount: 0,
        writeFinishingCount: 0,
        tasks: [],
      },
    });
    let workerDisposed = false;
    registerCancelableFrontendWorker(() => {
      workerDisposed = true;
    });

    let gateDuringDestroy = false;
    const destroySpy = vi
      .spyOn(tauriBridge, "destroyCurrentWindow")
      .mockImplementation(async () => {
        gateDuringDestroy = isFrontendShuttingDown();
      });

    render(<App toolsOverride={MINIMAL_TOOLS} />);
    await waitFor(() => expect(triggerClose).not.toBeNull());

    await act(async () => {
      await triggerClose!();
    });

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(gateDuringDestroy).toBe(true);
    expect(workerDisposed).toBe(true);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("recovers task admission and surfaces error dialog if destroyCurrentWindow fails on idle close", async () => {
    const user = userEvent.setup();
    let triggerClose: (() => Promise<void> | void) | null = null;
    vi.spyOn(tauriBridge, "subscribeNativeCloseRequest").mockImplementation(async (cb) => {
      triggerClose = cb;
      return () => {};
    });
    vi.spyOn(tauriBridge, "requestWindowClose").mockResolvedValue({
      immediateCloseAllowed: true,
      snapshot: {
        shuttingDown: true,
        activeCount: 0,
        interruptibleCount: 0,
        writeFinishingCount: 0,
        tasks: [],
      },
    });
    const abortSpy = vi.spyOn(tauriBridge, "abortGracefulShutdown").mockResolvedValue();
    vi.spyOn(tauriBridge, "destroyCurrentWindow").mockRejectedValueOnce(
      new Error("simulated idle destroy error"),
    );

    render(<App toolsOverride={MINIMAL_TOOLS} />);
    await waitFor(() => expect(triggerClose).not.toBeNull());

    await act(async () => {
      await triggerClose!();
    });

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(isFrontendShuttingDown()).toBe(false);
    expect(screen.getByRole("heading", { name: "暂时无法完成退出" })).toBeInTheDocument();
    expect(screen.getByText(/simulated idle destroy error/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "继续使用" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(isFrontendShuttingDown()).toBe(false);
  });

  it("coordinates active-task confirmation, focus restoration, Escape handling, mid-confirm task completion, and draining gate", async () => {
    const user = userEvent.setup();
    let triggerClose: (() => Promise<void> | void) | null = null;
    let emitProgress: ((p: tauriBridge.TaskProgressPayload) => void) | null = null;

    vi.spyOn(tauriBridge, "subscribeNativeCloseRequest").mockImplementation(async (cb) => {
      triggerClose = cb;
      return () => {};
    });
    vi.spyOn(tauriBridge, "subscribeTaskProgress").mockImplementation(async (cb) => {
      emitProgress = cb;
      return () => {};
    });

    const closeDecisionSpy = vi.spyOn(tauriBridge, "requestWindowClose").mockResolvedValue({
      immediateCloseAllowed: false,
      snapshot: {
        shuttingDown: false,
        activeCount: 1,
        interruptibleCount: 1,
        writeFinishingCount: 0,
        tasks: [{ taskId: "hash-99", toolId: "D03", interruptible: true }],
      },
    });

    let resolveDrain: ((res: tauriBridge.ShutdownDrainResult) => void) | null = null;
    const drainSpy = vi.spyOn(tauriBridge, "beginGracefulShutdown").mockImplementation(
      () =>
        new Promise((res) => {
          resolveDrain = res;
        }),
    );
    const destroySpy = vi.spyOn(tauriBridge, "destroyCurrentWindow").mockResolvedValue();

    render(<App toolsOverride={MINIMAL_TOOLS} />);
    await waitFor(() => expect(triggerClose).not.toBeNull());

    // Focus search box before requesting close so we can verify focus restoration
    const searchBox = screen.getByRole("searchbox");
    searchBox.focus();
    expect(document.activeElement).toBe(searchBox);

    // 1. Trigger close while D03 task is active -> single dialog opens, Stay button focused
    await act(async () => {
      await triggerClose!();
    });
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    expect(isFrontendShuttingDown()).toBe(false);
    const stayBtn = screen.getByRole("button", { name: "继续使用" });
    expect(document.activeElement).toBe(stayBtn);

    // Duplicate close requests while confirming must be ignored (no stacked dialogs / extra queries)
    await act(async () => {
      await triggerClose!();
    });
    expect(closeDecisionSpy).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);

    // 2. Escape dismisses confirming dialog without cancelling tasks and restores focus
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(drainSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(searchBox);

    // 3. Re-trigger close -> simulate task finishing while modal is open -> label updates to "立即退出"
    await act(async () => {
      await triggerClose!();
    });
    expect(screen.getByRole("button", { name: "取消任务并退出" })).toBeInTheDocument();

    act(() => {
      emitProgress?.({
        taskId: "hash-99",
        toolId: "D03",
        state: "completed",
        processedBytes: 1024,
        totalBytes: 1024,
        percent: 100,
        errorCode: null,
        errorMessage: null,
      });
    });
    expect(screen.getByRole("button", { name: "立即退出" })).toBeInTheDocument();

    // 4. Confirm quit -> enters draining state; Escape MUST NOT hide draining state; destroy waits for drain!
    await user.click(screen.getByRole("button", { name: "立即退出" }));
    expect(screen.getByRole("heading", { name: "正在安全收尾并退出…" })).toBeInTheDocument();
    expect(isFrontendShuttingDown()).toBe(true);
    expect(destroySpy).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(screen.getByRole("heading", { name: "正在安全收尾并退出…" })).toBeInTheDocument();

    await act(async () => {
      resolveDrain?.({ readyToClose: true, remainingTasks: [] });
    });
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it("surfaces actionable error and recovery controls when drain times out or destroy fails", async () => {
    const user = userEvent.setup();
    let triggerClose: (() => Promise<void> | void) | null = null;
    vi.spyOn(tauriBridge, "subscribeNativeCloseRequest").mockImplementation(async (cb) => {
      triggerClose = cb;
      return () => {};
    });
    vi.spyOn(tauriBridge, "requestWindowClose").mockResolvedValue({
      immediateCloseAllowed: false,
      snapshot: {
        shuttingDown: false,
        activeCount: 1,
        interruptibleCount: 0,
        writeFinishingCount: 1,
        tasks: [{ taskId: "export-i03-1", toolId: "I03", interruptible: false }],
      },
    });

    const drainSpy = vi
      .spyOn(tauriBridge, "beginGracefulShutdown")
      .mockResolvedValueOnce({
        readyToClose: false,
        remainingTasks: [{ taskId: "export-i03-1", toolId: "I03", interruptible: false }],
      })
      .mockResolvedValueOnce({
        readyToClose: true,
        remainingTasks: [],
      });

    const abortSpy = vi.spyOn(tauriBridge, "abortGracefulShutdown").mockResolvedValue();
    const destroySpy = vi
      .spyOn(tauriBridge, "destroyCurrentWindow")
      .mockRejectedValueOnce(new Error("window.destroy not allowed"))
      .mockResolvedValueOnce();

    render(<App toolsOverride={MINIMAL_TOOLS} />);
    await waitFor(() => expect(triggerClose).not.toBeNull());

    await act(async () => {
      await triggerClose!();
    });
    await user.click(screen.getByRole("button", { name: "取消任务并退出" }));

    // Timeout surfaces remaining task ID and keeps retry/stay buttons operable
    expect(screen.getByRole("heading", { name: "暂时无法完成退出" })).toBeInTheDocument();
    expect(screen.getByText(/I03:export-i03-1/)).toBeInTheDocument();
    expect(destroySpy).not.toHaveBeenCalled();

    // Retry quit -> drain succeeds, first destroy rejects -> surfaces error & calls abortGracefulShutdown
    await user.click(screen.getByRole("button", { name: "重试退出" }));
    expect(drainSpy).toHaveBeenCalledTimes(2);
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/window\.destroy not allowed/)).toBeInTheDocument();

    // Clicking Stay resets back to idle cleanly
    await user.click(screen.getByRole("button", { name: "继续使用" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
