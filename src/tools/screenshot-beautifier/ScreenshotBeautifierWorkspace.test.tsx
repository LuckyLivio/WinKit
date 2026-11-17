import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { ScreenshotBeautifierWorkspace } from "./ScreenshotBeautifierWorkspace";

function renderBeautifier() {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
      <SessionStoreProvider>
        <ScreenshotBeautifierWorkspace />
      </SessionStoreProvider>
    </I18nContext.Provider>,
  );
}

describe("I03 ScreenshotBeautifierWorkspace UI", () => {
  it("handles empty state, image import, aspect ratio dimension updates, and export error reporting", async () => {
    const user = userEvent.setup();
    vi.spyOn(tauriBridge, "pickSingleFile").mockResolvedValueOnce("D:\\Samples\\demo.png");
    vi.spyOn(tauriBridge, "inspectBeautifierSourceImage").mockResolvedValueOnce({
      path: "D:\\Samples\\demo.png",
      fileName: "demo.png",
      width: 800,
      height: 500,
      hasAlpha: true,
      previewDataUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    });

    renderBeautifier();

    // Empty state disables export
    const exportBtn = screen.getByRole("button", { name: "导出高清 PNG…" });
    expect(exportBtn).toBeDisabled();

    // Load image
    await user.click(screen.getAllByRole("button", { name: "选择图片（PNG / JPEG）…" })[0]!);
    await waitFor(() => {
      // 800x500 + default padding 48*2 -> 896x596
      expect(screen.getByText(/896×596 px/)).toBeInTheDocument();
    });
    expect(exportBtn).toBeEnabled();

    // Switch to 1:1 square -> 896x896
    await user.click(screen.getByRole("button", { name: "1 : 1 方形" }));
    expect(screen.getByText(/896×896 px/)).toBeInTheDocument();

    // Simulate failed export (e.g. read-only folder)
    vi.spyOn(tauriBridge, "suggestSafeSiblingPath").mockResolvedValueOnce(
      "D:\\ReadOnly\\demo_framed.png",
    );
    vi.spyOn(tauriBridge, "pickSaveFilePath").mockResolvedValueOnce(
      "D:\\ReadOnly\\demo_framed.png",
    );
    vi.spyOn(tauriBridge, "exportBeautifiedImage").mockRejectedValueOnce({
      code: "PERMISSION_DENIED",
      message: "read-only directory",
    });

    await user.click(exportBtn);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/只读/);
    });

    vi.restoreAllMocks();
  });
});
