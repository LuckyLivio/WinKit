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

  it("protects all queued source files (A and B) during TXT and JSON export via forbiddenSourcePaths", async () => {
    const user = userEvent.setup();
    const pathA = "C:\\scans\\a.png";
    const pathB = "C:\\scans\\b.png";
    const pathSafe = "C:\\scans\\export_out.txt";

    vi.mocked(tauriBridge.pickMultipleFiles).mockResolvedValue([pathA, pathB]);
    vi.mocked(tauriBridge.inspectOcrSources).mockResolvedValue([
      {
        path: pathA,
        fileName: "a.png",
        kind: "image",
        byteLength: 1024,
        widthPx: 800,
        heightPx: 400,
        pageCount: 1,
        isLikelyScanned: false,
        previewDataUrl: null,
        errorCode: null,
        errorMessage: null,
      },
      {
        path: pathB,
        fileName: "b.png",
        kind: "image",
        byteLength: 2048,
        widthPx: 800,
        heightPx: 400,
        pageCount: 1,
        isLikelyScanned: false,
        previewDataUrl: null,
        errorCode: null,
        errorMessage: null,
      },
    ]);
    vi.mocked(tauriBridge.ocrExtractBatch).mockImplementationOnce(async (_tid, req) => ({
      engineName: "RapidOCR PP-OCRv4 mobile",
      completedCount: req.items.length,
      failedCount: 0,
      cancelled: false,
      totalPages: req.items.length,
      totalLines: req.items.length,
      totalChars: 12,
      totalElapsedMs: 120,
      items: req.items.map((it) => ({
        sourceId: it.id,
        sourcePath: it.path ?? null,
        sourceName: it.name ?? "",
        kind: "image",
        status: "completed",
        combinedText: `Text from ${it.name}`,
        totalLines: 1,
        totalChars: 12,
        averageConfidence: 0.99,
        elapsedMs: 60,
        errorCode: null,
        errorMessage: null,
        pages: [
          {
            pageNumber: 1,
            imageWidthPx: 800,
            imageHeightPx: 400,
            renderDpi: null,
            sourceWidthPt: null,
            sourceHeightPt: null,
            text: `Text from ${it.name}`,
            lineCount: 1,
            charCount: 12,
            averageConfidence: 0.99,
            elapsedMs: 60,
            previewDataUrl: null,
            warnings: [],
            lines: [],
          },
        ],
      })),
    }));

    // Simulate backend multi-source guard: reject if outputPath matches any forbidden source path
    vi.mocked(tauriBridge.saveLocalTextFile).mockImplementation(async (params) => {
      const blocked = (params.forbiddenSourcePaths ?? []).some(
        (p) => p.toLowerCase() === params.outputPath.toLowerCase(),
      );
      if (blocked) {
        throw { code: "SAME_INPUT_AND_OUTPUT", message: "Output path matches an input source." };
      }
      return { path: params.outputPath, byteLength: params.content.length };
    });

    renderWorkspace("zh-CN");
    await user.click(screen.getByRole("button", { name: /选择图片 \/ PDF/ }));
    await waitFor(() => {
      expect(screen.getAllByText("a.png").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("b.png").length).toBeGreaterThanOrEqual(1);
    });

    await user.click(screen.getByRole("button", { name: /开始离线识别/ }));
    await waitFor(() => {
      const ta = screen.getByRole("textbox", { name: /离线识别文本结果/ }) as HTMLTextAreaElement;
      expect(ta.value).toBe("Text from a.png");
    });

    // Active entry is A; attempt TXT export to B -> rejected and passes both A & B in forbiddenSourcePaths
    vi.mocked(tauriBridge.pickSaveFilePath).mockResolvedValueOnce(pathB);
    await user.click(screen.getByRole("button", { name: /\.txt/ }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(tauriBridge.saveLocalTextFile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outputPath: pathB,
        sourcePath: pathA,
        forbiddenSourcePaths: [pathA, pathB],
        toolId: "T03",
      }),
    );

    // Attempt JSON export to B -> also rejected with both A & B protected
    vi.mocked(tauriBridge.pickSaveFilePath).mockResolvedValueOnce(pathB);
    await user.click(screen.getByRole("button", { name: /JSON/ }));
    await waitFor(() => {
      expect(tauriBridge.saveLocalTextFile).toHaveBeenCalledTimes(2);
    });
    expect(tauriBridge.saveLocalTextFile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outputPath: pathB,
        sourcePath: pathA,
        forbiddenSourcePaths: [pathA, pathB],
        toolId: "T03",
      }),
    );

    // Normal TXT export to a distinct safe path C succeeds
    vi.mocked(tauriBridge.pickSaveFilePath).mockResolvedValueOnce(pathSafe);
    await user.click(screen.getByRole("button", { name: /\.txt/ }));
    await waitFor(() => {
      expect(screen.getByText(/已导出 \.txt/)).toBeInTheDocument();
    });
  });

  it("preserves manual proofread edits on A when recognizing newly added B, and replaces only on explicit re-run", async () => {
    const user = userEvent.setup();
    const pathA = "C:\\scans\\docA.png";
    const pathB = "C:\\scans\\docB.png";

    vi.mocked(tauriBridge.writeSystemClipboardText).mockResolvedValue();
    vi.mocked(tauriBridge.saveLocalTextFile).mockResolvedValue({
      path: "C:\\scans\\merged_ocr.txt",
      byteLength: 64,
    });

    // Step 1: Add A and run OCR
    vi.mocked(tauriBridge.pickMultipleFiles).mockResolvedValueOnce([pathA]);
    vi.mocked(tauriBridge.inspectOcrSources).mockResolvedValueOnce([
      {
        path: pathA,
        fileName: "docA.png",
        kind: "image",
        byteLength: 1000,
        widthPx: 600,
        heightPx: 300,
        pageCount: 1,
        isLikelyScanned: false,
        previewDataUrl: null,
        errorCode: null,
        errorMessage: null,
      },
    ]);
    vi.mocked(tauriBridge.ocrExtractBatch).mockImplementationOnce(async (_tid, req) => {
      const a = req.items[0]!;
      return {
        engineName: "RapidOCR PP-OCRv4 mobile",
        completedCount: 1,
        failedCount: 0,
        cancelled: false,
        totalPages: 1,
        totalLines: 1,
        totalChars: 8,
        totalElapsedMs: 80,
        items: [
          {
            sourceId: a.id,
            sourcePath: a.path ?? null,
            sourceName: "docA.png",
            kind: "image",
            status: "completed",
            combinedText: "RAW_A_OCR",
            totalLines: 1,
            totalChars: 9,
            averageConfidence: 0.98,
            elapsedMs: 80,
            errorCode: null,
            errorMessage: null,
            pages: [
              {
                pageNumber: 1,
                imageWidthPx: 600,
                imageHeightPx: 300,
                renderDpi: null,
                sourceWidthPt: null,
                sourceHeightPt: null,
                text: "RAW_A_OCR",
                lineCount: 1,
                charCount: 9,
                averageConfidence: 0.98,
                elapsedMs: 80,
                previewDataUrl: null,
                warnings: [],
                lines: [],
              },
            ],
          },
        ],
      };
    });

    renderWorkspace("zh-CN");
    await user.click(screen.getByRole("button", { name: /选择图片 \/ PDF/ }));
    await waitFor(() => expect(screen.getAllByText("docA.png").length).toBeGreaterThanOrEqual(1));

    await user.click(screen.getByRole("button", { name: /开始离线识别/ }));
    const ta = (await screen.findByRole("textbox", {
      name: /离线识别文本结果/,
    })) as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toBe("RAW_A_OCR"));

    // Step 2: Manually proofread A
    await user.clear(ta);
    await user.type(ta, "PROOFREAD_A_FINAL");
    expect(ta.value).toBe("PROOFREAD_A_FINAL");

    // Step 3: Add B and click "开始离线识别" -> ONLY B is sent, A's proofread text stays intact!
    vi.mocked(tauriBridge.pickMultipleFiles).mockResolvedValueOnce([pathB]);
    vi.mocked(tauriBridge.inspectOcrSources).mockResolvedValueOnce([
      {
        path: pathB,
        fileName: "docB.png",
        kind: "image",
        byteLength: 1000,
        widthPx: 600,
        heightPx: 300,
        pageCount: 1,
        isLikelyScanned: false,
        previewDataUrl: null,
        errorCode: null,
        errorMessage: null,
      },
    ]);
    vi.mocked(tauriBridge.ocrExtractBatch).mockImplementationOnce(async (_tid, req) => {
      // Crucial invariant: only pending item B is re-recognized; A is NOT re-run
      expect(req.items.map((it) => it.name)).toEqual(["docB.png"]);
      const b = req.items[0]!;
      return {
        engineName: "RapidOCR PP-OCRv4 mobile",
        completedCount: 1,
        failedCount: 0,
        cancelled: false,
        totalPages: 1,
        totalLines: 1,
        totalChars: 9,
        totalElapsedMs: 75,
        items: [
          {
            sourceId: b.id,
            sourcePath: b.path ?? null,
            sourceName: "docB.png",
            kind: "image",
            status: "completed",
            combinedText: "RAW_B_OCR",
            totalLines: 1,
            totalChars: 9,
            averageConfidence: 0.97,
            elapsedMs: 75,
            errorCode: null,
            errorMessage: null,
            pages: [
              {
                pageNumber: 1,
                imageWidthPx: 600,
                imageHeightPx: 300,
                renderDpi: null,
                sourceWidthPt: null,
                sourceHeightPt: null,
                text: "RAW_B_OCR",
                lineCount: 1,
                charCount: 9,
                averageConfidence: 0.97,
                elapsedMs: 75,
                previewDataUrl: null,
                warnings: [],
                lines: [],
              },
            ],
          },
        ],
      };
    });

    await user.click(screen.getByRole("button", { name: /选择图片 \/ PDF/ }));
    await waitFor(() => expect(screen.getAllByText("docB.png").length).toBeGreaterThanOrEqual(1));

    await user.click(screen.getByRole("button", { name: /开始离线识别/ }));
    await waitFor(() => {
      expect(tauriBridge.ocrExtractBatch).toHaveBeenCalledTimes(2);
    });

    // A is still active and keeps its manual proofread text
    expect(ta.value).toBe("PROOFREAD_A_FINAL");

    // Copy active page copies A's proofread text
    await user.click(screen.getByRole("button", { name: /复制当前页/ }));
    expect(tauriBridge.writeSystemClipboardText).toHaveBeenCalledWith("PROOFREAD_A_FINAL");

    // TXT export includes both A's proofread text AND B's recognized text
    vi.mocked(tauriBridge.pickSaveFilePath).mockResolvedValueOnce("C:\\scans\\merged_ocr.txt");
    await user.click(screen.getByRole("button", { name: /\.txt/ }));
    await waitFor(() => expect(tauriBridge.saveLocalTextFile).toHaveBeenCalledTimes(1));
    const txtCall = vi.mocked(tauriBridge.saveLocalTextFile).mock.calls[0]![0];
    expect(txtCall.content).toContain("PROOFREAD_A_FINAL");
    expect(txtCall.content).toContain("RAW_B_OCR");

    // Step 4: Explicit "重新识别当前项" on A replaces A's manual edit with fresh OCR output
    vi.mocked(tauriBridge.ocrExtractBatch).mockImplementationOnce(async (_tid, req) => {
      expect(req.items.map((it) => it.name)).toEqual(["docA.png"]);
      const a = req.items[0]!;
      return {
        engineName: "RapidOCR PP-OCRv4 mobile",
        completedCount: 1,
        failedCount: 0,
        cancelled: false,
        totalPages: 1,
        totalLines: 1,
        totalChars: 11,
        totalElapsedMs: 70,
        items: [
          {
            sourceId: a.id,
            sourcePath: a.path ?? null,
            sourceName: "docA.png",
            kind: "image",
            status: "completed",
            combinedText: "FRESH_A_OCR",
            totalLines: 1,
            totalChars: 11,
            averageConfidence: 0.99,
            elapsedMs: 70,
            errorCode: null,
            errorMessage: null,
            pages: [
              {
                pageNumber: 1,
                imageWidthPx: 600,
                imageHeightPx: 300,
                renderDpi: null,
                sourceWidthPt: null,
                sourceHeightPt: null,
                text: "FRESH_A_OCR",
                lineCount: 1,
                charCount: 11,
                averageConfidence: 0.99,
                elapsedMs: 70,
                previewDataUrl: null,
                warnings: [],
                lines: [],
              },
            ],
          },
        ],
      };
    });

    await user.click(screen.getByRole("button", { name: /重新识别当前项/ }));
    await waitFor(() => expect(ta.value).toBe("FRESH_A_OCR"));
  });
});
