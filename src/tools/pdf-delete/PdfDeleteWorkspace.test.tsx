import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { PdfSessionProvider } from "../../lib/pdfSessionStore";
import * as bridge from "../../lib/tauriBridge";
import { PdfDeleteWorkspace } from "./PdfDeleteWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof bridge>();
  return {
    ...actual,
    pickSingleFile: vi.fn(),
    inspectPdfDocument: vi.fn(),
    renderPdfPage: vi.fn(),
    suggestSafeSiblingPath: vi.fn(),
    deletePdfPages: vi.fn(),
    subscribeFileDrop: vi.fn().mockResolvedValue(() => {}),
    subscribePdfTaskProgress: vi.fn().mockResolvedValue(() => {}),
  };
});

describe("P10 PdfDeleteWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("blocks deleting all pages, supports range + invert selection, and exports trimmed PDF", async () => {
    const user = userEvent.setup();
    vi.mocked(bridge.pickSingleFile).mockResolvedValue("C:\\Docs\\notes.pdf");
    vi.mocked(bridge.suggestSafeSiblingPath).mockResolvedValue("C:\\Docs\\notes_trimmed.pdf");
    vi.mocked(bridge.inspectPdfDocument).mockResolvedValue({
      path: "C:\\Docs\\notes.pdf",
      fileName: "notes.pdf",
      byteLength: 18000,
      pageCount: 3,
      pages: [
        { pageNumber: 1, widthPt: 595, heightPt: 842, rotation: 0, isOversized: false },
        { pageNumber: 2, widthPt: 595, heightPt: 842, rotation: 0, isOversized: false },
        { pageNumber: 3, widthPt: 595, heightPt: 842, rotation: 0, isOversized: false },
      ],
      hasTextLayer: true,
      sampledTextPages: 3,
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
    vi.mocked(bridge.deletePdfPages).mockResolvedValue({
      outputPath: "C:\\Docs\\notes_trimmed.pdf",
      byteLength: 12000,
      sourcePageCount: 3,
      deletedPages: [2],
      keptPages: [1, 3],
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
          <PdfDeleteWorkspace />
        </PdfSessionProvider>
      </I18nContext.Provider>,
    );

    await user.click(screen.getByRole("button", { name: /选择要删页的 PDF/ }));
    await waitFor(() => {
      expect(screen.getByTestId("pdf-page-grid")).toBeInTheDocument();
    });

    // Marking all pages via invert (from empty -> all 3) blocks export
    await user.click(screen.getByRole("button", { name: "反选" }));
    expect(screen.getByText(/不能删除全部页面/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出删页后的新 PDF" })).toBeDisabled();

    // Mark only page 2 via range input and export
    const rangeInput = screen.getByLabelText(/按页码范围标记删除/);
    await user.type(rangeInput, "2");
    await user.click(screen.getByRole("button", { name: "标记删除" }));
    const exportBtn = screen.getByRole("button", { name: "导出删页后的新 PDF" });
    expect(exportBtn).toBeEnabled();
    await user.click(exportBtn);

    await waitFor(() => {
      expect(bridge.deletePdfPages).toHaveBeenCalledWith(
        expect.objectContaining({ deletePages: [2] }),
      );
      expect(screen.getByTestId("pdf-delete-result")).toBeInTheDocument();
    });
  });
});
