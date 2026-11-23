import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { ScreenCaptureWorkspace } from "./ScreenCaptureWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...orig,
    listCaptureMonitors: vi.fn(),
    listCaptureWindows: vi.fn(),
    captureScreenRegion: vi.fn(),
    captureScreenWindow: vi.fn(),
    captureScreenMonitor: vi.fn(),
    captureScreenScroll: vi.fn(),
    copyImageAssetToClipboard: vi.fn(),
    saveImageAssetFile: vi.fn(),
    pickSaveFilePath: vi.fn(),
    subscribeCaptureProgress: vi.fn(async () => () => {}),
    subscribeImageBatchProgress: vi.fn(async () => () => {}),
    subscribeArchiveProgress: vi.fn(async () => () => {}),
    subscribeDuplicateScanProgress: vi.fn(async () => () => {}),
  };
});

describe("I01 ScreenCaptureWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tauriBridge.listCaptureMonitors).mockResolvedValue([
      {
        id: "monitor-1",
        deviceName: "\\\\.\\DISPLAY1",
        isPrimary: true,
        x: 0,
        y: 0,
        width: 2560,
        height: 1440,
        scalePercent: 150,
      },
    ]);
    vi.mocked(tauriBridge.listCaptureWindows).mockResolvedValue([
      {
        hwnd: 12345,
        title: "Demo Long Page - Edge",
        processName: "msedge.exe",
        x: 100,
        y: 80,
        width: 1200,
        height: 900,
        isProtected: false,
      },
    ]);
  });

  it("handles partial scrolling capture confirmation, clipboard copy, and direct handoff to I03", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();

    vi.mocked(tauriBridge.captureScreenScroll).mockResolvedValue({
      asset: {
        assetId: "mem-img-1",
        label: "screenshot_scroll.png",
        width: 800,
        height: 2400,
        hasAlpha: false,
        byteLength: 120000,
        dataUrl: "data:image/png;base64,AA==",
      },
      mode: "scroll",
      rect: { x: 100, y: 100, width: 800, height: 600 },
      frameCount: 4,
      stopReason: "user_stopped",
      isPartial: true,
      note: null,
    });

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <SessionStoreProvider onNavigateToTool={onNavigate}>
          <ScreenCaptureWorkspace />
        </SessionStoreProvider>
      </I18nContext.Provider>,
    );

    await user.click(screen.getByRole("button", { name: "滚动长截图" }));
    await user.click(screen.getByRole("button", { name: "框选区域并滚动长截图" }));

    // Partial banner requires explicit user decision before Copy/Send unlock
    await waitFor(() => expect(screen.getByText(/仅得到部分长图/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "复制图片" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "保留当前部分长图" }));
    expect(screen.getByRole("button", { name: "复制图片" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "复制图片" }));
    expect(tauriBridge.copyImageAssetToClipboard).toHaveBeenCalledWith({
      assetId: "mem-img-1",
      dataUrl: "data:image/png;base64,AA==",
    });

    await user.click(screen.getByRole("button", { name: /截图美化 \(I03\)/ }));
    expect(onNavigate).toHaveBeenCalledWith("I03");
  });
});
