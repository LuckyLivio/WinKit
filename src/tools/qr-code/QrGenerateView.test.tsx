import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyQrImage, saveQrImage } from "../../lib/qrBridge";
import { pickSaveFilePath } from "../../lib/tauriBridge";
import { DEFAULT_QR_STYLE, generateQr, pngFromQr } from "./qrGenerator";
import { QrGenerateView } from "./QrGenerateView";

vi.mock("../../lib/qrBridge", () => ({ copyQrImage: vi.fn(), saveQrImage: vi.fn() }));
vi.mock("../../lib/tauriBridge", async (original) => ({
  ...(await original<typeof import("../../lib/tauriBridge")>()),
  pickSaveFilePath: vi.fn(),
  isTauriDesktop: () => true,
}));
vi.mock("./qrGenerator", async (original) => ({
  ...(await original<typeof import("./qrGenerator")>()),
  pngFromQr: vi.fn(),
}));

describe("QR generation controls", () => {
  beforeEach(() => vi.resetAllMocks());
  it("copies the displayed link including query parameters and disables every export for oversized content", async () => {
    render(<QrGenerateView />);
    const fullLink = "https://example.org/a?from=x%2By&to=%E4%B8%AD#part";
    fireEvent.change(screen.getByRole("textbox", { name: "链接" }), {
      target: { value: fullLink },
    });
    const result = generateQr(fullLink, DEFAULT_QR_STYLE);
    if (!("image" in result)) throw new Error("Expected link QR");
    const src = screen.getByRole("img").getAttribute("src")!;
    expect(decodeURIComponent(src.slice(src.indexOf(",") + 1))).toBe(result.image.svg);
    const blob = new Blob(["png"], { type: "image/png" });
    vi.mocked(pngFromQr).mockResolvedValue(blob);
    fireEvent.click(screen.getByRole("button", { name: "复制图片" }));
    await waitFor(() => expect(copyQrImage).toHaveBeenCalledWith(blob));
    expect(pngFromQr).toHaveBeenCalledWith(result.image);

    fireEvent.click(screen.getByRole("button", { name: "文本" }));
    fireEvent.change(screen.getByRole("textbox", { name: "文本" }), {
      target: { value: "中".repeat(4000) },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("超出");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    for (const name of ["复制图片", "保存 PNG", "导出 SVG"])
      expect(screen.getByRole("button", { name })).toBeDisabled();
  });

  it("confirms replacement of the same SVG bytes that were previewed", async () => {
    render(<QrGenerateView />);
    fireEvent.click(screen.getByRole("button", { name: "文本" }));
    fireEvent.change(screen.getByRole("textbox", { name: "文本" }), {
      target: { value: "第一行\n第二行 🦊" },
    });
    const src = screen.getByRole("img").getAttribute("src")!;
    const displayedSvg = decodeURIComponent(src.slice(src.indexOf(",") + 1));
    vi.mocked(pickSaveFilePath).mockResolvedValue("C:/out/test.svg");
    vi.mocked(saveQrImage)
      .mockRejectedValueOnce({ code: "TARGET_ALREADY_EXISTS", message: "exists" })
      .mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole("button", { name: "导出 SVG" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    const blob = vi.mocked(saveQrImage).mock.calls[0]![2];
    const svgText = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsText(blob);
    });
    expect(svgText).toBe(displayedSvg);
    expect(saveQrImage).toHaveBeenCalledWith("C:/out/test.svg", "svg", blob, false);
    fireEvent.click(screen.getByRole("button", { name: "确认覆盖" }));
    await waitFor(() =>
      expect(saveQrImage).toHaveBeenCalledWith("C:/out/test.svg", "svg", blob, true),
    );
  });

  it("clears the password when switching from WPA to an open network", () => {
    render(<QrGenerateView />);
    fireEvent.click(screen.getByRole("button", { name: "Wi-Fi" }));
    fireEvent.change(screen.getByLabelText("网络名 (SSID)"), { target: { value: "café" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "secret" } });
    fireEvent.change(screen.getByLabelText("安全类型"), { target: { value: "nopass" } });
    const expected = generateQr("WIFI:T:nopass;S:café;;", DEFAULT_QR_STYLE);
    if (!("image" in expected)) throw new Error("Expected open Wi-Fi image");
    expect(screen.getByRole("img").getAttribute("src")).toContain(
      encodeURIComponent(expected.image.svg),
    );
    fireEvent.change(screen.getByLabelText("安全类型"), { target: { value: "WPA" } });
    expect(screen.getByLabelText("密码")).toHaveValue("");
  });
});
