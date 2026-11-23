import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { ImageRedactWorkspace } from "./ImageRedactWorkspace";

const SAMPLE_PNG_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("I11 ImageRedactWorkspace", () => {
  it("pastes clipboard image, draws a solid redaction region, supports undo/redo, exports with I09 metadata stripping, and hands off baked pixels to I12", async () => {
    const user = userEvent.setup();
    const navSpy = vi.fn();

    vi.spyOn(tauriBridge, "readClipboardImageAsAsset").mockResolvedValueOnce({
      assetId: "asset-src-1",
      label: "clipboard.png",
      width: 800,
      height: 500,
      hasAlpha: false,
      byteLength: 4096,
      dataUrl: SAMPLE_PNG_URL,
    });
    const applySpy = vi.spyOn(tauriBridge, "applyImageRedactionsToAsset").mockResolvedValue({
      assetId: "asset-redacted-1",
      label: "clipboard.png",
      width: 800,
      height: 500,
      hasAlpha: false,
      byteLength: 4100,
      dataUrl: SAMPLE_PNG_URL,
    });
    vi.spyOn(tauriBridge, "pickSaveFilePath").mockResolvedValueOnce("D:\\Out\\clean.png");
    const exportSpy = vi.spyOn(tauriBridge, "exportRedactedImageFile").mockResolvedValueOnce({
      outputPath: "D:\\Out\\clean.png",
      width: 800,
      height: 500,
      byteLength: 4100,
      metadataStripped: true,
    });

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <SessionStoreProvider onNavigateToTool={navSpy}>
          <ImageRedactWorkspace />
        </SessionStoreProvider>
      </I18nContext.Provider>,
    );

    // Paste from clipboard
    await user.click(screen.getAllByRole("button", { name: "粘贴图片" })[0]!);
    const canvas = await screen.findByTestId("redact-canvas");
    Object.defineProperty(canvas, "setPointerCapture", { value: vi.fn() });
    Object.defineProperty(canvas.parentElement!, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 800, height: 500, right: 800, bottom: 500 }),
    });

    // Draw a solid cover box
    fireEvent.pointerDown(canvas, { clientX: 120, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 320, clientY: 180, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });

    await waitFor(() => {
      expect(screen.getByText(/1 处遮盖/)).toBeInTheDocument();
    });

    // Undo removes it; Redo restores it
    await user.click(screen.getByRole("button", { name: "撤销" }));
    expect(screen.getByText(/0 处遮盖/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重做" }));
    expect(screen.getByText(/1 处遮盖/)).toBeInTheDocument();

    // Export PNG verifies stripMetadata defaults to true
    await user.click(screen.getByRole("button", { name: "导出 PNG" }));
    await waitFor(() => {
      expect(exportSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          assetId: "asset-src-1",
          format: "png",
          stripMetadata: true,
          regions: expect.arrayContaining([expect.objectContaining({ kind: "solid" })]),
        }),
      );
    });
    expect(screen.getByRole("status")).toHaveTextContent(/无隐私元数据/);

    // Handoff to I12 bakes redactions destructively first
    await user.click(screen.getByRole("button", { name: "送往批注 (I12)" }));
    await waitFor(() => {
      expect(applySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          assetId: "asset-src-1",
          regions: expect.arrayContaining([expect.objectContaining({ kind: "solid" })]),
        }),
      );
      expect(navSpy).toHaveBeenCalledWith("I12");
    });

    vi.restoreAllMocks();
  });
});
