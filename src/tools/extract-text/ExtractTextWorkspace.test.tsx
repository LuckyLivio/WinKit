import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { PdfSessionProvider } from "../../lib/pdfSessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { ExtractTextWorkspace } from "./ExtractTextWorkspace";

vi.mock("../../lib/tauriBridge", async () => {
  const actual = await vi.importActual<typeof tauriBridge>("../../lib/tauriBridge");
  return {
    ...actual,
    isTauriDesktop: vi.fn(() => true),
    getOcrEngineStatus: vi.fn(),
    inspectOcrSources: vi.fn(),
    ocrExtractBatch: vi.fn(),
    readClipboardImageAsAsset: vi.fn(),
    cancelBackendTask: vi.fn(),
    writeSystemClipboardText: vi.fn(),
    pickMultipleFiles: vi.fn(),
    pickSaveFilePath: vi.fn(),
    saveLocalTextFile: vi.fn(),
    subscribeOcrProgress: vi.fn(async () => () => {}),
    subscribeFileDrop: vi.fn(async () => () => {}),
  };
});

function renderWorkspace(locale: "zh-CN" | "en-US" = "zh-CN") {
  return render(
    <I18nContext.Provider value={{ locale, setLocale: () => {}, t: MESSAGES[locale] }}>
      <PdfSessionProvider onNavigateToReader={() => {}} onNavigateToTool={() => {}}>
        <ExtractTextWorkspace />
      </PdfSessionProvider>
    </I18nContext.Provider>,
  );
}

describe("ExtractTextWorkspace (T03)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tauriBridge.getOcrEngineStatus).mockResolvedValue({
      ready: true,
      engineName: "RapidOCR PP-OCRv4 mobile (ONNX Runtime 1.23.2 CPU)",
      runtimeVersion: "1.23.2",
      ocrDir: "C:\\WinKit\\ocr",
      error: null,
    });
  });

  it("pastes clipboard image, runs offline OCR, displays text + boxes, and copies text", async () => {
    const user = userEvent.setup();
    vi.mocked(tauriBridge.readClipboardImageAsAsset).mockResolvedValue({
      assetId: "clip-asset-1",
      label: "clipboard.png",
      width: 1200,
      height: 600,
      hasAlpha: true,
      byteLength: 1024,
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
    });
    vi.mocked(tauriBridge.ocrExtractBatch).mockResolvedValue({
      engineName: "RapidOCR PP-OCRv4 mobile (ONNX Runtime 1.23.2 CPU)",
      completedCount: 1,
      failedCount: 0,
      cancelled: false,
      totalPages: 1,
      totalLines: 2,
      totalChars: 24,
      totalElapsedMs: 312,
      items: [
        {
          sourceId: "item-1",
          sourcePath: null,
          sourceName: "剪贴板图片 (1200×600)",
          kind: "clipboard",
          status: "completed",
          combinedText: "WinKit 离线识别\nSHA-256 校验通过",
          totalLines: 2,
          totalChars: 17,
          averageConfidence: 0.985,
          elapsedMs: 312,
          errorCode: null,
          errorMessage: null,
          pages: [
            {
              pageNumber: 1,
              imageWidthPx: 1200,
              imageHeightPx: 600,
              renderDpi: null,
              sourceWidthPt: null,
              sourceHeightPt: null,
              text: "WinKit 离线识别\nSHA-256 校验通过",
              lineCount: 2,
              charCount: 17,
              averageConfidence: 0.985,
              elapsedMs: 312,
              previewDataUrl: "data:image/png;base64,iVBORw0KGgo=",
              warnings: [],
              lines: [
                {
                  index: 0,
                  rowIndex: 0,
                  text: "WinKit 离线识别",
                  confidence: 0.99,
                  quadPx: [
                    { x: 40, y: 30 },
                    { x: 340, y: 30 },
                    { x: 340, y: 70 },
                    { x: 40, y: 70 },
                  ],
                  quadNorm: [
                    { x: 0.033, y: 0.05 },
                    { x: 0.283, y: 0.05 },
                    { x: 0.283, y: 0.117 },
                    { x: 0.033, y: 0.117 },
                  ],
                  bboxPx: { x: 40, y: 30, width: 300, height: 40 },
                  bboxNorm: { x: 0.033, y: 0.05, width: 0.25, height: 0.067 },
                  angleDeg: 0,
                  rotated180: false,
                  spans: [
                    {
                      text: "WinKit",
                      bboxPx: { x: 40, y: 30, width: 120, height: 40 },
                      bboxNorm: { x: 0.033, y: 0.05, width: 0.1, height: 0.067 },
                      charStart: 0,
                      charEnd: 6,
                    },
                  ],
                },
                {
                  index: 1,
                  rowIndex: 1,
                  text: "SHA-256 校验通过",
                  confidence: 0.98,
                  quadPx: [
                    { x: 40, y: 90 },
                    { x: 380, y: 90 },
                    { x: 380, y: 130 },
                    { x: 40, y: 130 },
                  ],
                  quadNorm: [
                    { x: 0.033, y: 0.15 },
                    { x: 0.317, y: 0.15 },
                    { x: 0.317, y: 0.217 },
                    { x: 0.033, y: 0.217 },
                  ],
                  bboxPx: { x: 40, y: 90, width: 340, height: 40 },
                  bboxNorm: { x: 0.033, y: 0.15, width: 0.283, height: 0.067 },
                  angleDeg: 0,
                  rotated180: false,
                  spans: [],
                },
              ],
            },
          ],
        },
      ],
    });
    vi.mocked(tauriBridge.writeSystemClipboardText).mockResolvedValue();

    renderWorkspace("zh-CN");

    await waitFor(() => {
      expect(screen.getByText(/RapidOCR PP-OCRv4/)).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /粘贴剪贴板图片/ }));
    await waitFor(() => {
      expect(screen.getAllByText(/剪贴板图片 \(1200×600\)/).length).toBeGreaterThanOrEqual(1);
    });

    // Patch sourceId returned by mock to match dynamically generated queue ID
    vi.mocked(tauriBridge.ocrExtractBatch).mockImplementationOnce(async (_tid, req) => {
      const firstItem = req.items[0]!;
      return {
        engineName: "RapidOCR PP-OCRv4 mobile (ONNX Runtime 1.23.2 CPU)",
        completedCount: 1,
        failedCount: 0,
        cancelled: false,
        totalPages: 1,
        totalLines: 2,
        totalChars: 17,
        totalElapsedMs: 312,
        items: [
          {
            sourceId: firstItem.id,
            sourcePath: null,
            sourceName: firstItem.name ?? "clipboard",
            kind: "clipboard",
            status: "completed",
            combinedText: "WinKit 离线识别\nSHA-256 校验通过",
            totalLines: 2,
            totalChars: 17,
            averageConfidence: 0.985,
            elapsedMs: 312,
            errorCode: null,
            errorMessage: null,
            pages: [
              {
                pageNumber: 1,
                imageWidthPx: 1200,
                imageHeightPx: 600,
                renderDpi: null,
                sourceWidthPt: null,
                sourceHeightPt: null,
                text: "WinKit 离线识别\nSHA-256 校验通过",
                lineCount: 2,
                charCount: 17,
                averageConfidence: 0.985,
                elapsedMs: 312,
                previewDataUrl: "data:image/png;base64,iVBORw0KGgo=",
                warnings: [],
                lines: [
                  {
                    index: 0,
                    rowIndex: 0,
                    text: "WinKit 离线识别",
                    confidence: 0.99,
                    quadPx: [
                      { x: 40, y: 30 },
                      { x: 340, y: 30 },
                      { x: 340, y: 70 },
                      { x: 40, y: 70 },
                    ],
                    quadNorm: [
                      { x: 0.033, y: 0.05 },
                      { x: 0.283, y: 0.05 },
                      { x: 0.283, y: 0.117 },
                      { x: 0.033, y: 0.117 },
                    ],
                    bboxPx: { x: 40, y: 30, width: 300, height: 40 },
                    bboxNorm: { x: 0.033, y: 0.05, width: 0.25, height: 0.067 },
                    angleDeg: 0,
                    rotated180: false,
                    spans: [
                      {
                        text: "WinKit",
                        bboxPx: { x: 40, y: 30, width: 120, height: 40 },
                        bboxNorm: { x: 0.033, y: 0.05, width: 0.1, height: 0.067 },
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
      };
    });

    await user.click(screen.getByRole("button", { name: /开始离线识别/ }));
    await waitFor(() => {
      const ta = screen.getByRole("textbox", { name: /离线识别文本结果/ }) as HTMLTextAreaElement;
      expect(ta.value).toContain("SHA-256 校验通过");
    });

    await user.click(screen.getByRole("button", { name: /复制当前页/ }));
    expect(tauriBridge.writeSystemClipboardText).toHaveBeenCalledWith(
      "WinKit 离线识别\nSHA-256 校验通过",
    );

    await user.click(screen.getByRole("tab", { name: /逐行坐标/ }));
    expect(screen.getByText(/px\(40,30 300×40\)/)).toBeInTheDocument();
  });

  it("cancels an in-flight OCR job and reports cancelled status cleanly", async () => {
    const user = userEvent.setup();
    vi.mocked(tauriBridge.pickMultipleFiles).mockResolvedValue(["C:\\scans\\doc.pdf"]);
    vi.mocked(tauriBridge.inspectOcrSources).mockResolvedValue([
      {
        path: "C:\\scans\\doc.pdf",
        fileName: "doc.pdf",
        kind: "pdf",
        byteLength: 204800,
        widthPx: null,
        heightPx: null,
        pageCount: 5,
        isLikelyScanned: true,
        previewDataUrl: null,
        errorCode: null,
        errorMessage: null,
      },
    ]);

    let resolveBatch!: (value: tauriBridge.OcrBatchResult) => void;
    vi.mocked(tauriBridge.ocrExtractBatch).mockImplementation(
      () =>
        new Promise<tauriBridge.OcrBatchResult>((resolve) => {
          resolveBatch = resolve;
        }),
    );
    vi.mocked(tauriBridge.cancelBackendTask).mockResolvedValue(true);

    renderWorkspace("en-US");
    await user.click(screen.getByRole("button", { name: /Open Images \/ PDF/ }));
    await waitFor(() => {
      expect(screen.getAllByText("doc.pdf").length).toBeGreaterThanOrEqual(1);
    });

    await user.click(screen.getByRole("button", { name: /Extract Text/ }));
    const cancelBtn = await screen.findByRole("button", { name: /Cancel/ });
    await user.click(cancelBtn);
    expect(tauriBridge.cancelBackendTask).toHaveBeenCalledTimes(1);

    resolveBatch({
      engineName: "RapidOCR PP-OCRv4 mobile",
      items: [],
      completedCount: 0,
      failedCount: 0,
      cancelled: true,
      totalPages: 0,
      totalLines: 0,
      totalChars: 0,
      totalElapsedMs: 110,
    });

    await waitFor(() => {
      expect(screen.getByText(/OCR cancelled as requested/)).toBeInTheDocument();
    });
  });
});
