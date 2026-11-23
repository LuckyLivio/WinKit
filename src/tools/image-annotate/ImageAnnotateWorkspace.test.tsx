import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { ImageRedactWorkspace } from "../image-redact/ImageRedactWorkspace";
import { ScreenshotBeautifierWorkspace } from "../screenshot-beautifier/ScreenshotBeautifierWorkspace";
import * as renderer from "./annotationRenderer";
import { ImageAnnotateWorkspace } from "./ImageAnnotateWorkspace";

const SAMPLE_PNG_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function CrossToolHarness() {
  const [active, setActive] = useState<"I11" | "I12" | "I03">("I11");
  return (
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
      <SessionStoreProvider onNavigateToTool={(id) => setActive(id as "I11" | "I12" | "I03")}>
        <div>
          <button type="button" onClick={() => setActive("I11")}>
            NAV_I11
          </button>
          <button type="button" onClick={() => setActive("I12")}>
            NAV_I12
          </button>
          <button type="button" onClick={() => setActive("I03")}>
            NAV_I03
          </button>
          <div data-testid="active-tool-id">{active}</div>
          {active === "I11" && <ImageRedactWorkspace />}
          {active === "I12" && <ImageAnnotateWorkspace />}
          {active === "I03" && <ScreenshotBeautifierWorkspace />}
        </div>
      </SessionStoreProvider>
    </I18nContext.Provider>
  );
}

describe("I12 ImageAnnotateWorkspace & I11 -> I12 -> I03 handoff pipeline", () => {
  it("hands off redacted image from I11 to I12, adds numbered badge & Chinese text, preserves edits across tool switching, and forwards to I03", async () => {
    const user = userEvent.setup();

    vi.spyOn(tauriBridge, "readClipboardImageAsAsset").mockResolvedValueOnce({
      assetId: "asset-raw-1",
      label: "sample_email.png",
      width: 900,
      height: 600,
      hasAlpha: false,
      byteLength: 8192,
      dataUrl: SAMPLE_PNG_URL,
    });
    vi.spyOn(tauriBridge, "applyImageRedactionsToAsset").mockResolvedValueOnce({
      assetId: "asset-baked-i11",
      label: "sample_email.png",
      width: 900,
      height: 600,
      hasAlpha: false,
      byteLength: 8200,
      dataUrl: SAMPLE_PNG_URL,
    });
    vi.spyOn(renderer, "renderAnnotatedImageToPngDataUrl").mockReturnValueOnce({
      dataUrl: SAMPLE_PNG_URL,
      width: 900,
      height: 600,
    });
    const storeSpy = vi.spyOn(tauriBridge, "storePngAsset").mockResolvedValueOnce({
      assetId: "asset-baked-i12",
      label: "sample_email.png",
      width: 900,
      height: 600,
      hasAlpha: false,
      byteLength: 9100,
      dataUrl: SAMPLE_PNG_URL,
    });

    // jsdom Image does not fire onload automatically for data URLs — trigger it synchronously
    const origImage = globalThis.Image;
    class ImmediateImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      private _src = "";
      get src() {
        return this._src;
      }
      set src(v: string) {
        this._src = v;
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", ImmediateImage);

    try {
      render(<CrossToolHarness />);

      // 1. In I11: paste image, draw solid cover, send to I12
      await user.click(screen.getAllByRole("button", { name: "粘贴图片" })[0]!);
      const redactCanvas = await screen.findByTestId("redact-canvas");
      Object.defineProperty(redactCanvas, "setPointerCapture", { value: vi.fn() });
      fireEvent.pointerDown(redactCanvas, { clientX: 80, clientY: 80, button: 0, pointerId: 1 });
      fireEvent.pointerMove(redactCanvas, { clientX: 240, clientY: 140, pointerId: 1 });
      fireEvent.pointerUp(redactCanvas, { pointerId: 1 });

      await user.click(screen.getByRole("button", { name: "送往批注 (I12)" }));
      await waitFor(() => {
        expect(screen.getByTestId("active-tool-id")).toHaveTextContent("I12");
      });

      // 2. In I12: place numbered badge "1" and Chinese text callout
      const annotateCanvas = await screen.findByTestId("annotate-canvas");
      Object.defineProperty(annotateCanvas, "setPointerCapture", { value: vi.fn() });

      await user.click(screen.getByRole("button", { name: "编号" }));
      fireEvent.pointerDown(annotateCanvas, {
        clientX: 160,
        clientY: 160,
        button: 0,
        pointerId: 1,
      });
      fireEvent.pointerUp(annotateCanvas, { pointerId: 1 });
      await waitFor(() => {
        expect(screen.getByText(/1 项批注/)).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: "文字" }));
      fireEvent.pointerDown(annotateCanvas, {
        clientX: 240,
        clientY: 220,
        button: 0,
        pointerId: 1,
      });
      fireEvent.pointerUp(annotateCanvas, { pointerId: 1 });
      const inlineInput = await screen.findByPlaceholderText(/输入中英文批注/);
      await user.clear(inlineInput);
      await user.type(inlineInput, "已遮蔽测试邮箱{Enter}");

      await waitFor(() => {
        expect(screen.getByText(/2 项批注/)).toBeInTheDocument();
      });

      // 3. Switch away to I11 and return to I12 — in-session annotations MUST persist!
      await user.click(screen.getByRole("button", { name: "NAV_I11" }));
      expect(screen.getByText(/1 处遮盖/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "NAV_I12" }));
      expect(screen.getByText(/2 项批注/)).toBeInTheDocument();

      // 4. Forward annotated image to I03 Beautifier
      await user.click(screen.getByRole("button", { name: "送往美化 (I03)" }));
      await waitFor(() => {
        expect(storeSpy).toHaveBeenCalled();
        expect(screen.getByTestId("active-tool-id")).toHaveTextContent("I03");
        // 900x600 + default padding 48*2 -> 996x696 px
        expect(screen.getByText(/996×696 px/)).toBeInTheDocument();
      });
    } finally {
      vi.stubGlobal("Image", origImage);
      vi.restoreAllMocks();
    }
  });
});
