import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { ColorPickerWorkspace } from "./ColorPickerWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    pickScreenColor: vi.fn(),
    pickSingleFile: vi.fn(),
    loadFileAsImageAsset: vi.fn(),
    readClipboardImageAsAsset: vi.fn(),
    extractImagePalette: vi.fn(),
    writeSystemClipboardText: vi.fn(async () => {}),
    subscribeFileDrop: vi.fn(async () => () => {}),
    subscribeImageBatchProgress: vi.fn(async () => () => {}),
    subscribeArchiveProgress: vi.fn(async () => () => {}),
    subscribeDuplicateScanProgress: vi.fn(async () => () => {}),
  };
});

function renderPicker() {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
      <SessionStoreProvider>
        <ColorPickerWorkspace />
      </SessionStoreProvider>
    </I18nContext.Provider>,
  );
}

describe("I10 ColorPickerWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles screen color picking, Esc cancel, translucent CSS vs XAML formats, recent 20 history clear, palette FG/BG, and WCAG boundary checks", async () => {
    const user = userEvent.setup();

    vi.mocked(tauriBridge.pickScreenColor)
      .mockResolvedValueOnce({
        r: 225,
        g: 29,
        b: 72,
        hex: "#E11D48",
        physicalX: 960,
        physicalY: 540,
        monitorId: "monitor-1",
        scalePercent: 150,
        compositedRgbOnly: true,
      })
      .mockRejectedValueOnce({ code: "TASK_CANCELLED", message: "Cancelled" });

    renderPicker();

    // 1. Live screen pick succeeds & pushes to history
    await user.click(screen.getByTestId("i10-pick-screen-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("i10-fmt-hex")).toHaveTextContent("#E11D48");
      expect(screen.getByTestId("i10-fmt-xaml")).toHaveTextContent("#FFE11D48");
      expect(screen.getByTestId("i10-fmt-csharp")).toHaveTextContent(
        "Color.FromArgb(255, 225, 29, 72)",
      );
      expect(screen.getByTestId("i10-fmt-tw-exact")).toHaveTextContent("bg-[#E11D48]");
      expect(screen.getByTestId("i10-fmt-tw-named")).toHaveTextContent("bg-rose-600");
    });
    expect(screen.getByTestId("i10-history-list")).toHaveTextContent("#E11D48");

    // 2. Second launch cancelled via Esc restores cleanly without error
    await user.click(screen.getByTestId("i10-pick-screen-btn"));
    await waitFor(() => {
      expect(screen.getByText("已取消屏幕取色。")).toBeInTheDocument();
    });

    // 3. Translucent color strictly distinguishes CSS #RRGGBBAA from WinUI/XAML #AARRGGBB
    const manual = screen.getByTestId("i10-manual-input");
    await user.clear(manual);
    await user.type(manual, "#10B98180{Enter}");
    expect(screen.getByTestId("i10-fmt-hex")).toHaveTextContent("#10B98180");
    expect(screen.getByTestId("i10-fmt-css")).toHaveTextContent("color: #10B98180;");
    expect(screen.getByTestId("i10-fmt-xaml")).toHaveTextContent("#8010B981");
    expect(screen.getByTestId("i10-fmt-csharp")).toHaveTextContent(
      "Color.FromArgb(128, 16, 185, 129)",
    );

    // Clear history works
    await user.click(screen.getByTestId("i10-clear-history-btn"));
    expect(screen.queryByTestId("i10-history-list")).not.toBeInTheDocument();

    // 4. Image palette extraction displays only valid swatches and lets user assign directly to Contrast FG/BG
    vi.mocked(tauriBridge.readClipboardImageAsAsset).mockResolvedValue({
      assetId: "mem-pal-1",
      label: "brand.png",
      width: 200,
      height: 100,
      hasAlpha: true,
      byteLength: 1024,
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
    });
    vi.mocked(tauriBridge.extractImagePalette).mockResolvedValue({
      swatches: [
        { r: 0, g: 0, b: 0, hex: "#000000", sharePercent: 60 },
        { r: 255, g: 255, b: 255, hex: "#FFFFFF", sharePercent: 40 },
      ],
      totalPixels: 20000,
      opaquePixels: 10000,
      excludedTransparentPixels: 10000,
      distinctColorCount: 2,
      width: 200,
      height: 100,
    });

    await user.click(screen.getByRole("button", { name: "粘贴图片" }));
    await waitFor(() => {
      expect(screen.getByTestId("i10-palette-swatches")).toBeInTheDocument();
    });
    expect(screen.getByText(/已排除 10,000 个全透明像素/)).toBeInTheDocument();

    // Set #000000 as FG and #FFFFFF as BG -> 21.00:1 all PASS
    const fgBtns = screen.getAllByRole("button", { name: "前景" });
    const bgBtns = screen.getAllByRole("button", { name: "背景" });
    await user.click(fgBtns[0]!);
    await user.click(bgBtns[1]!);
    expect(screen.getByTestId("i10-contrast-ratio")).toHaveTextContent("21.00:1");
    expect(screen.getByTestId("i10-wcag-aaa-normal")).toHaveTextContent("通过");

    // 5. AA 4.5:1 boundary test (#77767C on #FFFFFF = 4.499863 -> unrounded Fail for AA normal!)
    const fgInput = screen.getByTestId("i10-fg-input");
    await user.clear(fgInput);
    await user.type(fgInput, "#77767C");
    expect(screen.getByTestId("i10-contrast-ratio")).toHaveTextContent("4.49:1");
    expect(screen.getByTestId("i10-wcag-aa-normal")).toHaveTextContent("未通过");
    expect(screen.getByTestId("i10-wcag-aa-large")).toHaveTextContent("通过");

    // #767676 on #FFFFFF = 4.54:1 -> Pass AA normal
    await user.clear(fgInput);
    await user.type(fgInput, "#767676");
    expect(screen.getByTestId("i10-wcag-aa-normal")).toHaveTextContent("通过");
  });
});
