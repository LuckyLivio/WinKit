import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { PdfSessionProvider } from "../../lib/pdfSessionStore";
import * as bridge from "../../lib/tauriBridge";
import { PdfToImagesWorkspace } from "./PdfToImagesWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof bridge>();
  return {
    ...actual,
    getImageHeicCapabilities: vi.fn(),
    pickSingleFile: vi.fn(),
    inspectPdfDocument: vi.fn(),
    previewPdfToImagesPlan: vi.fn(),
    pdfToImages: vi.fn(),
    subscribeFileDrop: vi.fn().mockResolvedValue(() => {}),
    subscribePdfTaskProgress: vi.fn().mockResolvedValue(() => {}),
  };
});

describe("P17 PdfToImagesWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hides HEIC when unavailable, shows upfront pixel estimate, and exports PNGs at 300 DPI", async () => {
    const user = userEvent.setup();
    vi.mocked(bridge.getImageHeicCapabilities).mockResolvedValue({
      decodeAvailable: false,
      encodeAvailable: false,
      decodeNote: "",
      encodeNote: "",
    });
    vi.mocked(bridge.pickSingleFile).mockResolvedValue("C:\\Docs\\slides.pdf");
    vi.mocked(bridge.inspectPdfDocument).mockResolvedValue({
      path: "C:\\Docs\\slides.pdf",
      fileName: "slides.pdf",
      byteLength: 28000,
      pageCount: 2,
      pages: [
        { pageNumber: 1, widthPt: 595, heightPt: 842, rotation: 0, isOversized: false },
        { pageNumber: 2, widthPt: 595, heightPt: 842, rotation: 0, isOversized: false },
      ],
      hasTextLayer: true,
      sampledTextPages: 2,
      isLikelyScanned: false,
      hasOutlines: false,
      outlines: [],
      hasAcroform: false,
      hasSignatures: false,
      signatureCount: 0,
      isEncrypted: false,
      title: null,
      author: null,
      subject: null,
      creator: null,
      producer: null,
      warnings: [],
    });
    vi.mocked(bridge.previewPdfToImagesPlan).mockResolvedValue({
      valid: true,
      sourcePageCount: 2,
      targetPageCount: 2,
      maxWidthPx: 2479,
      maxHeightPx: 3508,
      cappedCount: 0,
      heicEncodeAvailable: false,
      sampleEstimates: [
        { pageNumber: 1, widthPx: 2479, heightPx: 3508, capped: false },
        { pageNumber: 2, widthPx: 2479, heightPx: 3508, capped: false },
      ],
      errors: [],
      warnings: [],
    });
    vi.mocked(bridge.pdfToImages).mockResolvedValue({
      outputDir: "C:\\Docs\\slides_images",
      totalRequested: 2,
      succeededCount: 2,
      failedCount: 0,
      cancelled: false,
      totalOutputBytes: 420000,
      items: [
        {
          pageNumber: 1,
          status: "ok",
          outputPath: "C:\\Docs\\slides_images\\slides_p001.png",
          fileName: "slides_p001.png",
          widthPx: 2479,
          heightPx: 3508,
          byteLength: 210000,
          capped: false,
          collisionAdjusted: false,
          errorMessage: null,
        },
        {
          pageNumber: 2,
          status: "ok",
          outputPath: "C:\\Docs\\slides_images\\slides_p002.png",
          fileName: "slides_p002.png",
          widthPx: 2479,
          heightPx: 3508,
          byteLength: 210000,
          capped: false,
          collisionAdjusted: false,
          errorMessage: null,
        },
      ],
      warnings: [],
    });

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <PdfSessionProvider onNavigateToReader={() => {}} onNavigateToTool={() => {}}>
          <PdfToImagesWorkspace />
        </PdfSessionProvider>
      </I18nContext.Provider>,
    );

    await user.click(screen.getByRole("button", { name: /选择要导出的 PDF/ }));
    await waitFor(() => {
      expect(screen.getByText(/最大输出像素 2479×3508 px/)).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "HEIC" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "300 DPI" }));
    await user.click(screen.getByRole("button", { name: "开始导出图片" }));

    await waitFor(() => {
      expect(bridge.pdfToImages).toHaveBeenCalledWith(
        expect.objectContaining({
          dpi: 300,
          format: "png",
        }),
      );
      expect(screen.getByTestId("pdf-to-images-result")).toBeInTheDocument();
    });
  });
});
