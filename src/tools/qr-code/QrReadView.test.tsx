import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as bridge from "../../lib/qrBridge";
import * as desktop from "../../lib/tauriBridge";
import * as decoder from "./decodeImage";
import { wifiPayload } from "./qrGenerator";
import { QrReadView } from "./QrReadView";
import { isQrWebUrl, wifiPassword } from "./readActions";

const thumbnail = new Blob(["preview"], { type: "image/png" });
const scanned = (text: string): decoder.DecodeImageResult => ({
  codes: [{ format: "QR Code", text }],
  thumbnail,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("F01 image reader", () => {
  let drop: (paths: string[]) => void;
  beforeEach(() => {
    // jsdom has no native object-URL implementation for images.
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:preview"),
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(desktop, "isTauriDesktop").mockReturnValue(true);
    vi.spyOn(desktop, "subscribeFileDrop").mockImplementation(async (handlers) => {
      drop = handlers.onDropPaths;
      return () => {};
    });
    vi.spyOn(bridge, "readQrImageFile").mockResolvedValue(new Blob(["input"]));
    vi.spyOn(bridge, "copyQrText").mockResolvedValue();
    vi.spyOn(bridge, "openQrHttpUrl").mockResolvedValue();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(URL, "createObjectURL");
    Reflect.deleteProperty(URL, "revokeObjectURL");
  });

  it("groups multiple symbols by selected image and only copies or opens on request", async () => {
    const url = "https://example.org/path?q=123&lang=zh";
    const password = 'A";\\,😀';
    const wifi = wifiPayload({ ssid: "访客;一", security: "WPA", password, hidden: true });
    vi.spyOn(desktop, "pickMultipleFiles").mockResolvedValue([
      "C:/pictures/one.png",
      "C:/pictures/two.webp",
    ]);
    vi.spyOn(decoder, "decodeImage")
      .mockResolvedValueOnce({
        thumbnail,
        codes: [
          { format: "QR Code", text: url },
          { format: "Code 128", text: "0042" },
        ],
      })
      .mockResolvedValueOnce(scanned(wifi));
    const view = render(<QrReadView />);
    fireEvent.click(screen.getByRole("button", { name: "选择图片" }));
    await screen.findByText(wifi);
    const first = within(screen.getByRole("region", { name: "one.png" }));
    const second = within(screen.getByRole("region", { name: "two.webp" }));
    expect(first.getByText("QR Code")).toBeVisible();
    expect(first.getByText("Code 128")).toBeVisible();
    expect(first.getByText(url)).toBeVisible();
    expect(second.getByText(wifi)).toBeVisible();
    expect(bridge.copyQrText).not.toHaveBeenCalled();
    expect(bridge.openQrHttpUrl).not.toHaveBeenCalled();
    fireEvent.click(first.getByRole("button", { name: "在浏览器打开" }));
    expect(bridge.openQrHttpUrl).toHaveBeenCalledWith(url);
    fireEvent.click(second.getByRole("button", { name: "复制 Wi-Fi 密码" }));
    expect(bridge.copyQrText).toHaveBeenCalledWith(password);
    fireEvent.click(second.getByRole("button", { name: "复制内容" }));
    expect(bridge.copyQrText).toHaveBeenCalledWith(wifi);
    await screen.findByText("已复制");
    expect(localStorage.length).toBe(0);
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("discards a late decoder reply after an Explorer drop or cancel, and stops queued files", async () => {
    const first = deferred<decoder.DecodeImageResult>();
    const last = deferred<decoder.DecodeImageResult>();
    vi.spyOn(decoder, "decodeImage")
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(scanned("new"))
      .mockReturnValueOnce(last.promise);
    render(<QrReadView />);
    act(() => drop(["one.png", "unused.jpg"]));
    await waitFor(() => expect(decoder.decodeImage).toHaveBeenCalledTimes(1));
    const signal = vi.mocked(decoder.decodeImage).mock.calls[0]![1];
    act(() => drop(["new.webp"]));
    expect(signal.aborted).toBe(true);
    await screen.findByText("new");
    await act(async () => first.resolve(scanned("obsolete")));
    expect(screen.queryByText("obsolete")).toBeNull();
    expect(bridge.readQrImageFile).not.toHaveBeenCalledWith("unused.jpg");

    act(() => drop(["busy.jpg"]));
    await waitFor(() => expect(decoder.decodeImage).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole("button", { name: "取消识别" }));
    await act(async () => last.resolve(scanned("cancelled data")));
    expect(screen.queryByText("cancelled data")).toBeNull();
    expect(screen.getByText("已取消识别。")).toBeVisible();
  });

  it("rejects oversized batches before file I/O, and reports bounded clipboard and file failures", async () => {
    const late = deferred<Blob>();
    const readClipboard = vi.spyOn(bridge, "readQrClipboardImage").mockReturnValue(late.promise);
    const decode = vi
      .spyOn(decoder, "decodeImage")
      .mockRejectedValueOnce(new decoder.DecodeImageError("invalid"));
    render(<QrReadView />);
    act(() => drop(Array(decoder.QR_READ_LIMITS.files + 1).fill("file.png")));
    expect(screen.getByText(/请选择|请一次选择/)).toBeVisible();
    expect(bridge.readQrImageFile).not.toHaveBeenCalled();
    expect(readClipboard).not.toHaveBeenCalled();
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "粘贴剪贴板图片" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(decoder.QR_READ_LIMITS.timeoutMs);
    });
    expect(screen.getByText("图片读取或识别超时。")).toBeVisible();
    await act(async () => late.resolve(new Blob(["late"])));
    expect(decode).not.toHaveBeenCalled();
    vi.useRealTimers();
    act(() => drop(["broken.png"]));
    await screen.findByText("图片已损坏或无法读取。");
  });

  it("ignores a picker completing after a newer clipboard image and never opens non-web content", async () => {
    const picker = deferred<string[]>();
    vi.spyOn(desktop, "pickMultipleFiles").mockReturnValue(picker.promise);
    vi.spyOn(bridge, "readQrClipboardImage").mockResolvedValue(new Blob(["new"]));
    vi.spyOn(decoder, "decodeImage").mockResolvedValue(scanned("file:///C:/local.txt"));
    render(<QrReadView />);
    fireEvent.click(screen.getByRole("button", { name: "选择图片" }));
    fireEvent.click(screen.getByRole("button", { name: "粘贴剪贴板图片" }));
    await screen.findByText("file:///C:/local.txt");
    await act(async () => picker.resolve(["old.png"]));
    expect(bridge.readQrImageFile).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "在浏览器打开" })).toBeNull();
    expect(bridge.openQrHttpUrl).not.toHaveBeenCalled();
  });

  it("offers password copying only for secured Wi-Fi payloads and opening only for single HTTP(S) URLs", () => {
    expect(wifiPassword("WIFI:T:nopass;S:x;P:stale;;")).toBeNull();
    expect(wifiPassword("WIFI:T:WPA;S:guest\\;P:wrong;P:right\\;pass;;")).toBe("right;pass");
    expect(isQrWebUrl("https://example.org?q=中文")).toBe(true);
    for (const value of [
      "file:///test",
      "javascript:alert(1)",
      "http://",
      "https://one\nhttps://two",
      "https:\\bad",
    ]) {
      expect(isQrWebUrl(value)).toBe(false);
    }
  });
});
