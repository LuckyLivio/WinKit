import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { PdfSessionProvider } from "../../lib/pdfSessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { CaptureTextWorkspace } from "./CaptureTextWorkspace";

vi.mock("../../lib/tauriBridge", async () => {
  const actual = await vi.importActual<typeof tauriBridge>("../../lib/tauriBridge");
  return {
    ...actual,
    isTauriDesktop: vi.fn(() => true),
    getOcrEngineStatus: vi.fn(),
    captureScreenRegion: vi.fn(),
    ocrExtractBatch: vi.fn(),
    cancelBackendTask: vi.fn(),
    writeSystemClipboardText: vi.fn(),
    pickSaveFilePath: vi.fn(),
    saveLocalTextFile: vi.fn(),
    storePngAsset: vi.fn(),
    subscribeCaptureProgress: vi.fn(async () => () => {}),
    subscribeOcrProgress: vi.fn(async () => () => {}),
  };
});

function renderWorkspace(locale: "zh-CN" | "en-US" = "zh-CN") {
  return render(
    <I18nContext.Provider value={{ locale, setLocale: () => {}, t: MESSAGES[locale] }}>
      <PdfSessionProvider onNavigateToReader={() => {}} onNavigateToTool={() => {}}>
        <CaptureTextWorkspace />
      </PdfSessionProvider>
    </I18nContext.Provider>,
  );
}

describe("CaptureTextWorkspace (T04)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tauriBridge.getOcrEngineStatus).mockResolvedValue({
      ready: true,
      engineName: "RapidOCR PP-OCRv4 mobile (ONNX Runtime 1.23.2 CPU)",
      runtimeVersion: "1.23.2",
      ocrDir: "C:\\WinKit\\ocr",
      error: null,
    });
    vi.mocked(tauriBridge.writeSystemClipboardText).mockResolvedValue();
  });

  it("captures screen region in memory, runs offline OCR via T03 worker, previews text & boxes, and copies to clipboard", async () => {
    const user = userEvent.setup();
    vi.mocked(tauriBridge.captureScreenRegion).mockResolvedValue({
      asset: {
        assetId: "cap-ram-1",
        label: "screenshot_region.png",
        width: 820,
        height: 240,
        hasAlpha: true,
        byteLength: 14200,
        dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      },
      mode: "region",
      rect: { x: -1600, y: 120, width: 820, height: 240 },
      frameCount: 1,
      stopReason: null,
      isPartial: false,
      note: null,
    });

    vi.mocked(tauriBridge.ocrExtractBatch).mockResolvedValue({
      engineName: "RapidOCR PP-OCRv4 mobile",
      completedCount: 1,
      failedCount: 0,
      cancelled: false,
      totalPages: 1,
      totalLines: 2,
      totalChars: 24,
      totalElapsedMs: 285,
      items: [
        {
          sourceId: "t04-region",
          sourcePath: null,
          sourceName: "screen_820x240.png",
          kind: "clipboard",
          status: "completed",
          combinedText: "WinKit 屏幕区域取字\nSHA-256 校验通过",
          totalLines: 2,
          totalChars: 24,
          averageConfidence: 0.991,
          elapsedMs: 285,
          errorCode: null,
          errorMessage: null,
          pages: [
            {
              pageNumber: 1,
              imageWidthPx: 820,
              imageHeightPx: 240,
              renderDpi: null,
              sourceWidthPt: null,
              sourceHeightPt: null,
              text: "WinKit 屏幕区域取字\nSHA-256 校验通过",
              lineCount: 2,
              charCount: 24,
              averageConfidence: 0.991,
              elapsedMs: 285,
              previewDataUrl: null,
              warnings: [],
              lines: [
                {
                  index: 0,
                  rowIndex: 0,
                  text: "WinKit 屏幕区域取字",
                  confidence: 0.992,
                  quadPx: [
                    { x: 20, y: 20 },
                    { x: 320, y: 20 },
                    { x: 320, y: 60 },
                    { x: 20, y: 60 },
                  ],
                  quadNorm: [
                    { x: 0.024, y: 0.083 },
                    { x: 0.39, y: 0.083 },
                    { x: 0.39, y: 0.25 },
                    { x: 0.024, y: 0.25 },
                  ],
                  bboxPx: { x: 20, y: 20, width: 300, height: 40 },
                  bboxNorm: { x: 0.024, y: 0.083, width: 0.366, height: 0.167 },
                  angleDeg: 0,
                  rotated180: false,
                  spans: [
                    {
                      text: "WinKit",
                      bboxPx: { x: 20, y: 20, width: 100, height: 40 },
                      bboxNorm: { x: 0.024, y: 0.083, width: 0.122, height: 0.167 },
                      charStart: 0,
                      charEnd: 6,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    renderWorkspace("zh-CN");
    await waitFor(() => {
      expect(screen.getByText(/RapidOCR PP-OCRv4/)).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /框选屏幕区域取字/ }));

    await waitFor(() => {
      const ta = screen.getByRole("textbox", { name: /屏幕取字识别结果/ }) as HTMLTextAreaElement;
      expect(ta.value).toBe("WinKit 屏幕区域取字\nSHA-256 校验通过");
    });

    // Verify zero-disk-write in-memory assetId handoff and negative-X multi-monitor rect badge
    expect(tauriBridge.captureScreenRegion).toHaveBeenCalledWith(
      expect.stringMatching(/^t04-cap-/),
      expect.objectContaining({ toolId: "T04", hideMainWindow: true }),
    );
    expect(tauriBridge.ocrExtractBatch).toHaveBeenCalledWith(
      expect.stringMatching(/^t04-ocr-/),
      expect.objectContaining({
        items: [expect.objectContaining({ path: null, assetId: "cap-ram-1" })],
      }),
      "T04",
    );
    expect(screen.getByText(/\(-1600, 120\) · 820×240 px/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /一键复制/ }));
    expect(tauriBridge.writeSystemClipboardText).toHaveBeenCalledWith(
      "WinKit 屏幕区域取字\nSHA-256 校验通过",
    );
  });

  it("handles Esc region cancellation cleanly without touching clipboard, and recovers cleanly after cancelling OCR", async () => {
    const user = userEvent.setup();
    vi.mocked(tauriBridge.cancelBackendTask).mockResolvedValue(true);

    // 1. Esc cancel during region capture
    vi.mocked(tauriBridge.captureScreenRegion).mockRejectedValueOnce({
      code: "TASK_CANCELLED",
      message: "Cancelled",
    });

    renderWorkspace("zh-CN");
    await user.click(screen.getByRole("button", { name: /框选屏幕区域取字/ }));
    await waitFor(() => {
      expect(screen.getByText(/已取消屏幕框选/)).toBeInTheDocument();
    });
    expect(tauriBridge.writeSystemClipboardText).not.toHaveBeenCalled();

    // 2. Capture succeeds -> OCR is cancelled mid-flight -> user clicks "重新识别" and succeeds!
    vi.mocked(tauriBridge.captureScreenRegion).mockResolvedValueOnce({
      asset: {
        assetId: "cap-ram-2",
        label: "screenshot_region.png",
        width: 500,
        height: 180,
        hasAlpha: true,
        byteLength: 8200,
        dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      },
      mode: "region",
      rect: { x: 100, y: 100, width: 500, height: 180 },
      frameCount: 1,
      stopReason: null,
      isPartial: false,
      note: null,
    });

    let resolveCancelledOcr!: (val: tauriBridge.OcrBatchResult) => void;
    vi.mocked(tauriBridge.ocrExtractBatch).mockImplementationOnce(
      () =>
        new Promise<tauriBridge.OcrBatchResult>((resolve) => {
          resolveCancelledOcr = resolve;
        }),
    );

    await user.click(screen.getByRole("button", { name: /框选屏幕区域取字/ }));
    const cancelOcrBtn = await screen.findByRole("button", { name: /取消识别/ });
    await user.click(cancelOcrBtn);
    expect(tauriBridge.cancelBackendTask).toHaveBeenCalledTimes(1);

    resolveCancelledOcr({
      engineName: "RapidOCR PP-OCRv4 mobile",
      items: [],
      completedCount: 0,
      failedCount: 0,
      cancelled: true,
      totalPages: 0,
      totalLines: 0,
      totalChars: 0,
      totalElapsedMs: 65,
    });

    await waitFor(() => {
      expect(screen.getByText(/已取消本次离线识别/)).toBeInTheDocument();
    });

    // Re-run OCR on the same in-memory capture succeeds cleanly
    vi.mocked(tauriBridge.ocrExtractBatch).mockResolvedValueOnce({
      engineName: "RapidOCR PP-OCRv4 mobile",
      completedCount: 1,
      failedCount: 0,
      cancelled: false,
      totalPages: 1,
      totalLines: 1,
      totalChars: 11,
      totalElapsedMs: 140,
      items: [
        {
          sourceId: "t04-region",
          sourcePath: null,
          sourceName: "screen_500x180.png",
          kind: "clipboard",
          status: "completed",
          combinedText: "取消后重跑成功",
          totalLines: 1,
          totalChars: 7,
          averageConfidence: 0.99,
          elapsedMs: 140,
          errorCode: null,
          errorMessage: null,
          pages: [
            {
              pageNumber: 1,
              imageWidthPx: 500,
              imageHeightPx: 180,
              renderDpi: null,
              sourceWidthPt: null,
              sourceHeightPt: null,
              text: "取消后重跑成功",
              lineCount: 1,
              charCount: 7,
              averageConfidence: 0.99,
              elapsedMs: 140,
              previewDataUrl: null,
              warnings: [],
              lines: [],
            },
          ],
        },
      ],
    });

    await user.click(screen.getByRole("button", { name: /重新识别/ }));
    await waitFor(() => {
      const ta = screen.getByRole("textbox", { name: /屏幕取字识别结果/ }) as HTMLTextAreaElement;
      expect(ta.value).toBe("取消后重跑成功");
    });
  });

  it("re-runs OCR cleanly before and after shared in-memory asset cache eviction via storePngAsset", async () => {
    const user = userEvent.setup();
    const initialAsset: tauriBridge.ImageAssetPayload = {
      assetId: "cap-evict-1",
      label: "screenshot_region.png",
      width: 640,
      height: 200,
      hasAlpha: true,
      byteLength: 9100,
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
    };
    const restoredAsset: tauriBridge.ImageAssetPayload = {
      ...initialAsset,
      assetId: "cap-restored-2",
    };

    vi.mocked(tauriBridge.captureScreenRegion).mockResolvedValueOnce({
      asset: initialAsset,
      mode: "region",
      rect: { x: 120, y: 80, width: 640, height: 200 },
      frameCount: 1,
      stopReason: null,
      isPartial: false,
      note: null,
    });

    const makeSuccessBatch = (text: string): tauriBridge.OcrBatchResult => ({
      engineName: "RapidOCR PP-OCRv4 mobile",
      completedCount: 1,
      failedCount: 0,
      cancelled: false,
      totalPages: 1,
      totalLines: 1,
      totalChars: text.length,
      totalElapsedMs: 120,
      items: [
        {
          sourceId: "t04-region",
          sourcePath: null,
          sourceName: "screen_640x200.png",
          kind: "clipboard",
          status: "completed",
          combinedText: text,
          totalLines: 1,
          totalChars: text.length,
          averageConfidence: 0.99,
          elapsedMs: 120,
          errorCode: null,
          errorMessage: null,
          pages: [
            {
              pageNumber: 1,
              imageWidthPx: 640,
              imageHeightPx: 200,
              renderDpi: null,
              sourceWidthPt: null,
              sourceHeightPt: null,
              text,
              lineCount: 1,
              charCount: text.length,
              averageConfidence: 0.99,
              elapsedMs: 120,
              previewDataUrl: null,
              warnings: [],
              lines: [],
            },
          ],
        },
      ],
    });

    const evictedBatch: tauriBridge.OcrBatchResult = {
      engineName: "RapidOCR PP-OCRv4 mobile",
      completedCount: 0,
      failedCount: 1,
      cancelled: false,
      totalPages: 0,
      totalLines: 0,
      totalChars: 0,
      totalElapsedMs: 2,
      items: [
        {
          sourceId: "t04-region",
          sourcePath: null,
          sourceName: "screen_640x200.png",
          kind: "clipboard",
          status: "failed",
          combinedText: "",
          totalLines: 0,
          totalChars: 0,
          averageConfidence: 0,
          elapsedMs: 2,
          errorCode: "ASSET_NOT_FOUND",
          errorMessage: "In-memory image session expired or missing.",
          pages: [],
        },
      ],
    };

    vi.mocked(tauriBridge.storePngAsset).mockResolvedValueOnce(restoredAsset);
    vi.mocked(tauriBridge.ocrExtractBatch)
      .mockResolvedValueOnce(makeSuccessBatch("首次识别文本"))
      .mockResolvedValueOnce(makeSuccessBatch("淘汰前重跑成功"))
      .mockResolvedValueOnce(evictedBatch)
      .mockResolvedValueOnce(makeSuccessBatch("缓存淘汰后恢复成功"))
      .mockResolvedValueOnce(makeSuccessBatch("使用新缓存ID再次重跑"));

    renderWorkspace("zh-CN");
    await user.click(screen.getByRole("button", { name: /框选屏幕区域取字/ }));
    await waitFor(() => {
      const ta = screen.getByRole("textbox", { name: /屏幕取字识别结果/ }) as HTMLTextAreaElement;
      expect(ta.value).toBe("首次识别文本");
    });

    // 1. Re-run BEFORE cache eviction: directly reuses cap-evict-1, never calls storePngAsset
    await user.click(screen.getByRole("button", { name: /重新识别/ }));
    await waitFor(() => {
      const ta = screen.getByRole("textbox", { name: /屏幕取字识别结果/ }) as HTMLTextAreaElement;
      expect(ta.value).toBe("淘汰前重跑成功");
    });
    expect(tauriBridge.storePngAsset).not.toHaveBeenCalled();

    // 2. Re-run AFTER cache eviction (ASSET_NOT_FOUND): re-ingests preview PNG in RAM and succeeds
    await user.click(screen.getByRole("button", { name: /重新识别/ }));
    await waitFor(() => {
      const ta = screen.getByRole("textbox", { name: /屏幕取字识别结果/ }) as HTMLTextAreaElement;
      expect(ta.value).toBe("缓存淘汰后恢复成功");
    });
    expect(tauriBridge.storePngAsset).toHaveBeenCalledTimes(1);
    expect(tauriBridge.storePngAsset).toHaveBeenCalledWith(
      initialAsset.dataUrl,
      initialAsset.label,
    );
    expect(vi.mocked(tauriBridge.ocrExtractBatch).mock.calls[3]?.[1].items[0]?.assetId).toBe(
      "cap-restored-2",
    );

    // 3. Subsequent re-run uses the refreshed assetId directly without re-calling storePngAsset
    await user.click(screen.getByRole("button", { name: /重新识别/ }));
    await waitFor(() => {
      const ta = screen.getByRole("textbox", { name: /屏幕取字识别结果/ }) as HTMLTextAreaElement;
      expect(ta.value).toBe("使用新缓存ID再次重跑");
    });
    expect(tauriBridge.storePngAsset).toHaveBeenCalledTimes(1);
    expect(vi.mocked(tauriBridge.ocrExtractBatch).mock.calls[4]?.[1].items[0]?.assetId).toBe(
      "cap-restored-2",
    );
  });
});
