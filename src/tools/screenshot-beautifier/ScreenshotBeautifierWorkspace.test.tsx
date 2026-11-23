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

  it("supports 4:5 & 9:16 presets, gradient background, clipboard paste, and batch style apply", async () => {
    const user = userEvent.setup();
    vi.spyOn(tauriBridge, "readClipboardImageAsAsset").mockResolvedValueOnce({
      assetId: "asset-clip-1",
      label: "clipboard.png",
      width: 1000,
      height: 600,
      hasAlpha: false,
      byteLength: 12345,
      dataUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    });

    renderBeautifier();

    await user.click(screen.getByRole("button", { name: "粘贴剪贴板图片" }));
    await waitFor(() => {
      expect(screen.getByText(/1096×696 px/)).toBeInTheDocument();
    });

    // Switch to 4:5 -> 1096 * 5 / 4 = 1370
    await user.click(screen.getByRole("button", { name: "4 : 5" }));
    expect(screen.getByText(/1096×1370 px/)).toBeInTheDocument();

    // Switch to 9:16 -> 1096 * 16 / 9 = 1948
    await user.click(screen.getByRole("button", { name: "9 : 16" }));
    expect(screen.getByText(/1096×1948 px/)).toBeInTheDocument();

    // Switch to Gradient background
    await user.click(screen.getByRole("button", { name: "渐变" }));
    const canvas = screen.getByTestId("beautifier-preview-canvas");
    expect(canvas.style.background).toContain("linear-gradient");

    // Switch to batch apply mode and add images
    await user.click(screen.getByRole("button", { name: "批量套用" }));
    vi.spyOn(tauriBridge, "pickMultipleFiles").mockResolvedValueOnce([
      "D:\\Samples\\a.png",
      "D:\\Samples\\b.png",
    ]);
    vi.spyOn(tauriBridge, "inspectBatchImages").mockResolvedValueOnce({
      items: [
        {
          path: "D:\\Samples\\a.png",
          fileName: "a.png",
          format: "png",
          byteLength: 1024,
          rawWidth: 800,
          rawHeight: 600,
          displayWidth: 800,
          displayHeight: 600,
          exifOrientation: 1,
          hasAlpha: false,
          isAnimated: false,
          pageCount: 1,
          hasIccProfile: false,
          metadataFlags: {
            hasExif: false,
            hasGps: false,
            hasXmp: false,
            hasIptc: false,
            hasIcc: false,
            hasComments: false,
            hasCameraInfo: false,
            hasDatetime: false,
            duplicateSegmentCount: 0,
            tagHighlights: [],
          },
          thumbnailDataUrl:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          warnings: [],
          error: null,
        },
      ],
      skipped: [],
      heicCapabilities: {
        decodeAvailable: true,
        encodeAvailable: false,
        decodeNote: "ok",
        encodeNote: "missing",
      },
    });
    await user.click(screen.getAllByRole("button", { name: "添加多张图片" })[0]!);
    await waitFor(() => {
      expect(screen.getAllByText("a.png").length).toBeGreaterThan(0);
    });

    vi.restoreAllMocks();
  });
});
