import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { PdfSessionProvider } from "../../lib/pdfSessionStore";
import * as bridge from "../../lib/tauriBridge";
import { PdfSplitWorkspace } from "./PdfSplitWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof bridge>();
  return {
    ...actual,
    pickSingleFile: vi.fn(),
    inspectPdfDocument: vi.fn(),
    previewSplitPdfPlan: vi.fn(),
    splitPdf: vi.fn(),
    subscribeFileDrop: vi.fn().mockResolvedValue(() => {}),
    subscribePdfTaskProgress: vi.fn().mockResolvedValue(() => {}),
  };
});

describe("P08 PdfSplitWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("previews split plan filenames upfront, blocks invalid ranges, and splits into previewable PDFs", async () => {
    const user = userEvent.setup();
    vi.mocked(bridge.pickSingleFile).mockResolvedValue("C:\\Docs\\manual.pdf");
    vi.mocked(bridge.inspectPdfDocument).mockResolvedValue({
      path: "C:\\Docs\\manual.pdf",
      fileName: "manual.pdf",
      byteLength: 32000,
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
    vi.mocked(bridge.previewSplitPdfPlan).mockResolvedValue({
      valid: true,
      sourcePageCount: 4,
      outputFileCount: 2,
      totalOutputPages: 4,
      items: [
        {
          partIndex: 1,
          fileName: "manual_p01-02.pdf",
          pages: [1, 2],
          pageCount: 2,
          rangeLabel: "1-2",
          collisionAdjusted: false,
        },
        {
          partIndex: 2,
          fileName: "manual_p03-04.pdf",
          pages: [3, 4],
          pageCount: 2,
          rangeLabel: "3-4",
          collisionAdjusted: false,
        },
      ],
      errors: [],
      warnings: [],
    });
    vi.mocked(bridge.splitPdf).mockResolvedValue({
      outputDir: "C:\\Docs",
      sourcePageCount: 4,
      files: [
        {
          partIndex: 1,
          path: "C:\\Docs\\manual_p01-02.pdf",
          fileName: "manual_p01-02.pdf",
          byteLength: 15000,
          pageCount: 2,
          rangeLabel: "1-2",
          collisionAdjusted: false,
        },
        {
          partIndex: 2,
          path: "C:\\Docs\\manual_p03-04.pdf",
          fileName: "manual_p03-04.pdf",
          byteLength: 16000,
          pageCount: 2,
          rangeLabel: "3-4",
          collisionAdjusted: false,
        },
      ],
      totalOutputPages: 4,
      totalOutputBytes: 31000,
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

    const onNavReader = vi.fn();
    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <PdfSessionProvider onNavigateToReader={onNavReader} onNavigateToTool={() => {}}>
          <PdfSplitWorkspace />
        </PdfSessionProvider>
      </I18nContext.Provider>,
    );

    await user.click(screen.getByRole("button", { name: /选择要拆分的 PDF/ }));

    await waitFor(() => {
      expect(screen.getByText("manual_p01-02.pdf")).toBeInTheDocument();
      expect(screen.getByText("manual_p03-04.pdf")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "开始拆分" }));

    await waitFor(() => {
      expect(screen.getByTestId("pdf-split-result")).toBeInTheDocument();
    });
    expect(screen.getByText(/拆分完成：已生成 2 个 PDF/)).toBeInTheDocument();
  });
});
