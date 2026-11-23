import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { PdfSessionProvider } from "../../lib/pdfSessionStore";
import * as bridge from "../../lib/tauriBridge";
import { PdfOrganizeWorkspace } from "./PdfOrganizeWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof bridge>();
  return {
    ...actual,
    pickSingleFile: vi.fn(),
    inspectPdfDocument: vi.fn(),
    renderPdfPage: vi.fn(),
    suggestSafeSiblingPath: vi.fn(),
    organizePdf: vi.fn(),
    subscribeFileDrop: vi.fn().mockResolvedValue(() => {}),
    subscribePdfTaskProgress: vi.fn().mockResolvedValue(() => {}),
  };
});

describe("P09 PdfOrganizeWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads pages into grid, reorders/rotates/deletes with undo/redo, and exports organized PDF", async () => {
    const user = userEvent.setup();
    vi.mocked(bridge.pickSingleFile).mockResolvedValue("C:\\Docs\\deck.pdf");
    vi.mocked(bridge.suggestSafeSiblingPath).mockResolvedValue("C:\\Docs\\deck_organized.pdf");
    vi.mocked(bridge.inspectPdfDocument).mockResolvedValue({
      path: "C:\\Docs\\deck.pdf",
      fileName: "deck.pdf",
      byteLength: 24000,
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
    vi.mocked(bridge.organizePdf).mockResolvedValue({
      outputPath: "C:\\Docs\\deck_organized.pdf",
      byteLength: 20000,
      sourcePageCount: 3,
      outputPageCount: 2,
      rotatedPages: 1,
      deletedPages: 1,
      reordered: true,
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
          <PdfOrganizeWorkspace />
        </PdfSessionProvider>
      </I18nContext.Provider>,
    );

    await user.click(screen.getByRole("button", { name: /选择要整理的 PDF/ }));
    await waitFor(() => {
      expect(screen.getByTestId("pdf-page-grid")).toBeInTheDocument();
    });

    // Move page 1 right (so order becomes [2, 1, 3]) and rotate first item +90°, delete last item
    const moveRightBtns = screen.getAllByRole("button", { name: "后移一页" });
    await user.click(moveRightBtns[0]!);
    expect(screen.getByText("现 1 ← 原 2")).toBeInTheDocument();

    // Undo and redo
    await user.click(screen.getByRole("button", { name: "撤销" }));
    expect(screen.queryByText("现 1 ← 原 2")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重做" }));
    expect(screen.getByText("现 1 ← 原 2")).toBeInTheDocument();

    const rotRightBtns = screen.getAllByRole("button", { name: "顺时针旋转 90°" });
    await user.click(rotRightBtns[0]!);
    const deleteBtns = screen.getAllByRole("button", { name: "移除此页" });
    await user.click(deleteBtns[2]!);

    await user.click(screen.getByRole("button", { name: "导出新 PDF" }));
    await waitFor(() => {
      expect(bridge.organizePdf).toHaveBeenCalledWith(
        expect.objectContaining({
          pages: [
            { sourcePage: 2, extraRotationCw: 90 },
            { sourcePage: 1, extraRotationCw: 0 },
          ],
        }),
      );
      expect(screen.getByTestId("pdf-organize-result")).toBeInTheDocument();
    });
  });
});
