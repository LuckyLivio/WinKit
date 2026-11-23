import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { PdfSessionProvider } from "../../lib/pdfSessionStore";
import * as bridge from "../../lib/tauriBridge";
import { PdfExtractWorkspace } from "./PdfExtractWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof bridge>();
  return {
    ...actual,
    pickSingleFile: vi.fn(),
    inspectPdfDocument: vi.fn(),
    renderPdfPage: vi.fn(),
    suggestSafeSiblingPath: vi.fn(),
    extractPdfPages: vi.fn(),
    subscribeFileDrop: vi.fn().mockResolvedValue(() => {}),
    subscribePdfTaskProgress: vi.fn().mockResolvedValue(() => {}),
  };
});

describe("P11 PdfExtractWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts non-contiguous ranges in both single-PDF and per-page modes", async () => {
    const user = userEvent.setup();
    vi.mocked(bridge.pickSingleFile).mockResolvedValue("C:\\Docs\\book.pdf");
    vi.mocked(bridge.suggestSafeSiblingPath).mockResolvedValue("C:\\Docs\\book_extracted.pdf");
    vi.mocked(bridge.inspectPdfDocument).mockResolvedValue({
      path: "C:\\Docs\\book.pdf",
      fileName: "book.pdf",
      byteLength: 44000,
      pageCount: 4,
      pages: [
        { pageNumber: 1, widthPt: 595, heightPt: 842, rotation: 0, isOversized: false },
        { pageNumber: 2, widthPt: 595, heightPt: 842, rotation: 0, isOversized: false },
        { pageNumber: 3, widthPt: 595, heightPt: 842, rotation: 0, isOversized: false },
        { pageNumber: 4, widthPt: 595, heightPt: 842, rotation: 0, isOversized: false },
      ],
      hasTextLayer: true,
      sampledTextPages: 4,
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
    vi.mocked(bridge.renderPdfPage).mockResolvedValue({
      meta: {
        pageNumber: 1,
        widthPx: 200,
        heightPx: 280,
        pageWidthPt: 595,
        pageHeightPt: 842,
        rotation: 0,
        capped: false,
      },
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      fromCache: false,
    });
    vi.mocked(bridge.extractPdfPages).mockResolvedValue({
      mode: "per_page_pdfs",
      sourcePageCount: 4,
      extractedPages: [1, 3],
      duplicatePagesRemoved: 0,
      files: [
        {
          path: "C:\\Docs\\book_p01.pdf",
          fileName: "book_p01.pdf",
          byteLength: 10000,
          pageCount: 1,
          rangeLabel: "1",
          collisionAdjusted: false,
        },
        {
          path: "C:\\Docs\\book_p03.pdf",
          fileName: "book_p03.pdf",
          byteLength: 10500,
          pageCount: 1,
          rangeLabel: "3",
          collisionAdjusted: false,
        },
      ],
      totalOutputBytes: 20500,
      cancelled: false,
      summary: {
        preservedExternalLinks: 0,
        remappedInternalLinks: 0,
        droppedDanglingLinks: 0,
        remappedBookmarks: 0,
        droppedDanglingBookmarks: 0,
        signatureInvalidatedSources: [],
        acroformSimplifiedSources: [],
      },
      warnings: [],
    });

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <PdfSessionProvider onNavigateToReader={() => {}} onNavigateToTool={() => {}}>
          <PdfExtractWorkspace />
        </PdfSessionProvider>
      </I18nContext.Provider>,
    );

    await user.click(screen.getByRole("button", { name: /选择要提取的 PDF/ }));
    await waitFor(() => {
      expect(screen.getByTestId("pdf-page-grid")).toBeInTheDocument();
    });

    // Click "选奇数页" (pages 1, 3) and switch to per-page PDF mode
    await user.click(screen.getByRole("button", { name: "选奇数页" }));
    await user.click(screen.getByRole("button", { name: "每页一个独立 PDF" }));
    await user.click(screen.getByRole("button", { name: "开始提取" }));

    await waitFor(() => {
      expect(bridge.extractPdfPages).toHaveBeenCalledWith(
        expect.objectContaining({
          pages: [1, 3],
          mode: "per_page_pdfs",
        }),
      );
      expect(screen.getByTestId("pdf-extract-result")).toBeInTheDocument();
    });
  });
});
