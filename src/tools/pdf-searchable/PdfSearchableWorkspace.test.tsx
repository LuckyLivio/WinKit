import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { PdfSessionProvider } from "../../lib/pdfSessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { PdfSearchableWorkspace } from "./PdfSearchableWorkspace";

vi.mock("../../lib/tauriBridge", async () => {
  const actual = await vi.importActual<typeof tauriBridge>("../../lib/tauriBridge");
  return {
    ...actual,
    isTauriDesktop: vi.fn(() => true),
    getOcrEngineStatus: vi.fn(),
    pickSingleFile: vi.fn(),
    pickSaveFilePath: vi.fn(),
    suggestSafeSiblingPath: vi.fn(),
    inspectSearchablePdfPages: vi.fn(),
    renderPdfPage: vi.fn(),
    makePdfSearchable: vi.fn(),
    cancelBackendTask: vi.fn(),
    openLocalDirectory: vi.fn(),
    subscribeFileDrop: vi.fn(async () => () => {}),
    subscribePdfTaskProgress: vi.fn(async () => () => {}),
  };
});

function renderWorkspace(onNavigateToReader = vi.fn(), onNavigateToTool = vi.fn()) {
  return {
    onNavigateToReader,
    onNavigateToTool,
    ...render(
      <I18nContext.Provider value={{ locale: "zh-CN", setLocale: () => {}, t: MESSAGES["zh-CN"] }}>
        <PdfSessionProvider
          onNavigateToReader={onNavigateToReader}
          onNavigateToTool={onNavigateToTool}
        >
          <PdfSearchableWorkspace />
        </PdfSessionProvider>
      </I18nContext.Provider>,
    ),
  };
}

describe("PdfSearchableWorkspace (P04)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tauriBridge.getOcrEngineStatus).mockResolvedValue({
      ready: true,
      engineName: "RapidOCR PP-OCRv4 mobile (ONNX Runtime 1.23.2 CPU)",
      runtimeVersion: "1.23.2",
      ocrDir: "C:\\WinKit\\ocr",
      error: null,
    });
    vi.mocked(tauriBridge.renderPdfPage).mockResolvedValue({
      meta: {
        pageNumber: 1,
        widthPx: 220,
        heightPx: 310,
        pageWidthPt: 595,
        pageHeightPt: 842,
        rotation: 0,
        capped: false,
      },
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      fromCache: false,
    });
    vi.mocked(tauriBridge.suggestSafeSiblingPath).mockResolvedValue(
      "C:\\Docs\\mixed_scan_searchable.pdf",
    );
  });

  it("inspects per-page text layers, converts mixed scanned PDF with default skip, and opens result in C08", async () => {
    const user = userEvent.setup();
    vi.mocked(tauriBridge.pickSingleFile).mockResolvedValueOnce("C:\\Docs\\mixed_scan.pdf");
    vi.mocked(tauriBridge.inspectSearchablePdfPages).mockResolvedValueOnce({
      inspection: {
        path: "C:\\Docs\\mixed_scan.pdf",
        fileName: "mixed_scan.pdf",
        byteLength: 245_760,
        pageCount: 2,
        pages: [
          { pageNumber: 1, widthPt: 595, heightPt: 842, rotation: 0, isOversized: false },
          { pageNumber: 2, widthPt: 595, heightPt: 842, rotation: 90, isOversized: false },
        ],
        hasTextLayer: true,
        sampledTextPages: 2,
        isLikelyScanned: false,
        hasOutlines: true,
        outlines: [{ title: "Cover", pageNumber: 1, children: [] }],
        hasAcroform: false,
        hasSignatures: true,
        signatureCount: 1,
        isEncrypted: false,
        title: null,
        author: null,
        subject: null,
        creator: null,
        producer: null,
        warnings: [],
      },
      pages: [
        {
          pageNumber: 1,
          widthPt: 595,
          heightPt: 842,
          rotation: 0,
          meaningfulCharCount: 0,
          hasTextLayer: false,
        },
        {
          pageNumber: 2,
          widthPt: 595,
          heightPt: 842,
          rotation: 90,
          meaningfulCharCount: 42,
          hasTextLayer: true,
        },
      ],
      scannedPageCount: 1,
      searchablePageCount: 1,
    });

    vi.mocked(tauriBridge.makePdfSearchable).mockResolvedValueOnce({
      outputPath: "C:\\Docs\\mixed_scan_searchable.pdf",
      outputBytes: 251_000,
      totalPages: 2,
      selectedPages: 2,
      ocrAppliedPages: 1,
      skippedExistingTextPages: 1,
      ocrEmptyPages: 0,
      skippedOutOfRangePages: 0,
      cappedPages: 0,
      totalLinesAdded: 4,
      totalCharsAdded: 106,
      elapsedMs: 420,
      hadSignatures: true,
      warnings: ["Source PDF contained 1 digital signature(s)."],
      pages: [
        {
          pageNumber: 1,
          status: "ocr_applied",
          existingCharCount: 0,
          addedLineCount: 4,
          addedCharCount: 106,
          renderedWidthPx: 1653,
          renderedHeightPx: 2339,
          renderCapped: false,
        },
        {
          pageNumber: 2,
          status: "skipped_existing_text",
          existingCharCount: 42,
          addedLineCount: 0,
          addedCharCount: 0,
          renderedWidthPx: null,
          renderedHeightPx: null,
          renderCapped: false,
        },
      ],
    });

    const { onNavigateToReader } = renderWorkspace();
    await user.click(screen.getByRole("button", { name: /选择 PDF/ }));

    await waitFor(() => {
      expect(screen.getByText("mixed_scan.pdf")).toBeInTheDocument();
    });

    // Shows signature warning, per-page scanned vs existing text badges, and planned counts
    expect(screen.getByText(/数字签名字段/)).toBeInTheDocument();
    expect(screen.getByText(/扫描页 1/)).toBeInTheDocument();
    expect(screen.getByText(/已有文字 1/)).toBeInTheDocument();
    expect(screen.getByText(/计划离线识别 1 页，跳过已有文字层 1 页/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /开始离线识别并另存 PDF/ }));

    await waitFor(() => {
      expect(screen.getByText(/可搜索 PDF 已生成（识别 1 页，跳过 1 页/)).toBeInTheDocument();
    });

    expect(tauriBridge.makePdfSearchable).toHaveBeenCalledWith(
      expect.stringMatching(/^p04-/),
      expect.objectContaining({
        inputPath: "C:\\Docs\\mixed_scan.pdf",
        outputPath: "C:\\Docs\\mixed_scan_searchable.pdf",
        skipExistingTextPages: true,
        ocrDpi: 200,
        overwrite: false,
      }),
    );

    await user.click(screen.getByRole("button", { name: /用 C08 打开结果/ }));
    expect(onNavigateToReader).toHaveBeenCalledTimes(1);
  });

  it("guides user to P16 when opening an encrypted PDF and supports mid-run cancellation", async () => {
    const user = userEvent.setup();
    vi.mocked(tauriBridge.pickSingleFile).mockResolvedValueOnce("C:\\Docs\\locked.pdf");
    vi.mocked(tauriBridge.inspectSearchablePdfPages).mockRejectedValueOnce({
      code: "PDF_PASSWORD_REQUIRED",
      message: "Password required",
    });

    const { onNavigateToTool } = renderWorkspace();
    await user.click(screen.getByRole("button", { name: /选择 PDF/ }));

    const unlockBtn = await screen.findByRole("button", { name: /前往 P16 解锁/ });
    await user.click(unlockBtn);
    expect(onNavigateToTool).toHaveBeenCalledWith("P16");
  });
});
