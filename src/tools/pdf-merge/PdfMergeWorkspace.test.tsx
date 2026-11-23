import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { PdfSessionProvider } from "../../lib/pdfSessionStore";
import * as bridge from "../../lib/tauriBridge";
import { PdfMergeWorkspace } from "./PdfMergeWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof bridge>();
  return {
    ...actual,
    pickMultipleFiles: vi.fn(),
    inspectPdfDocument: vi.fn(),
    suggestSafeSiblingPath: vi.fn(),
    mergePdfs: vi.fn(),
    subscribeFileDrop: vi.fn().mockResolvedValue(() => {}),
    subscribePdfTaskProgress: vi.fn().mockResolvedValue(() => {}),
  };
});

describe("P07 PdfMergeWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queues mixed PDF and image inputs, merges with bookmarks, and opens output in C08", async () => {
    const user = userEvent.setup();
    vi.mocked(bridge.pickMultipleFiles).mockResolvedValue([
      "C:\\Docs\\part1.pdf",
      "C:\\Docs\\cover.png",
    ]);
    vi.mocked(bridge.suggestSafeSiblingPath).mockResolvedValue("C:\\Docs\\part1_merged.pdf");
    vi.mocked(bridge.inspectPdfDocument).mockResolvedValue({
      path: "C:\\Docs\\part1.pdf",
      fileName: "part1.pdf",
      byteLength: 12000,
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
    vi.mocked(bridge.mergePdfs).mockResolvedValue({
      outputPath: "C:\\Docs\\part1_merged.pdf",
      byteLength: 28400,
      totalPages: 4,
      sourceCount: 2,
      pdfSourceCount: 1,
      imageSourceCount: 1,
      summary: {
        preservedExternalLinks: 1,
        remappedInternalLinks: 0,
        droppedDanglingLinks: 0,
        remappedBookmarks: 2,
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
          <PdfMergeWorkspace />
        </PdfSessionProvider>
      </I18nContext.Provider>,
    );

    await user.click(screen.getByRole("button", { name: /添加 PDF/ }));

    await waitFor(() => {
      expect(screen.getByText("part1.pdf")).toBeInTheDocument();
      expect(screen.getByText("cover.png")).toBeInTheDocument();
    });

    const mergeBtn = screen.getByRole("button", { name: "合并为新 PDF" });
    await waitFor(() => expect(mergeBtn).toBeEnabled());
    await user.click(mergeBtn);

    await waitFor(() => {
      expect(screen.getByTestId("pdf-merge-result")).toBeInTheDocument();
    });
    expect(screen.getByText(/已合并 2 个文件，共 4 页/)).toBeInTheDocument();

    const resultCard = screen.getByTestId("pdf-merge-result");
    await user.click(within(resultCard).getByRole("button", { name: "在内置预览中打开" }));
    expect(onNavReader).toHaveBeenCalledTimes(1);
  });
});
