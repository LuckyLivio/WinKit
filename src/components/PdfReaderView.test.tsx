import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../i18n/I18nContext";
import { MESSAGES } from "../i18n/messages";
import { PdfSessionProvider } from "../lib/pdfSessionStore";
import * as bridge from "../lib/tauriBridge";
import { PdfReaderView } from "./PdfReaderView";

vi.mock("../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof bridge>();
  return {
    ...actual,
    pickSingleFile: vi.fn(),
    inspectPdfDocument: vi.fn(),
    renderPdfPage: vi.fn(),
    getPdfPageText: vi.fn(),
    searchPdfText: vi.fn(),
    subscribeFileDrop: vi.fn().mockResolvedValue(() => {}),
  };
});

function renderReader(onNavigateToTool = vi.fn()) {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
      <PdfSessionProvider onNavigateToReader={() => {}} onNavigateToTool={onNavigateToTool}>
        <PdfReaderView />
      </PdfSessionProvider>
    </I18nContext.Provider>,
  );
}

describe("C08 PdfReaderView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens a PDF, renders selectable text layer, outlines, search results, and honest scanned/signature banners", async () => {
    const user = userEvent.setup();
    vi.mocked(bridge.pickSingleFile).mockResolvedValue("C:\\Samples\\report.pdf");
    vi.mocked(bridge.inspectPdfDocument).mockResolvedValue({
      path: "C:\\Samples\\report.pdf",
      fileName: "report.pdf",
      byteLength: 48200,
      pageCount: 2,
      pages: [
        { pageNumber: 1, widthPt: 595, heightPt: 842, rotation: 0, isOversized: false },
        { pageNumber: 2, widthPt: 842, heightPt: 595, rotation: 0, isOversized: false },
      ],
      hasTextLayer: true,
      sampledTextPages: 2,
      isLikelyScanned: false,
      hasOutlines: true,
      outlines: [{ title: "第一章 概述", pageNumber: 1, children: [] }],
      hasAcroform: false,
      hasSignatures: true,
      signatureCount: 1,
      isEncrypted: false,
      title: "季度报告",
      author: "Sample Team",
      subject: null,
      creator: null,
      producer: "WinKit PDF Engine",
      warnings: [],
    });
    vi.mocked(bridge.renderPdfPage).mockResolvedValue({
      meta: {
        pageNumber: 1,
        widthPx: 640,
        heightPx: 906,
        pageWidthPt: 595,
        pageHeightPt: 842,
        rotation: 0,
        capped: false,
      },
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      fromCache: false,
    });
    vi.mocked(bridge.getPdfPageText).mockResolvedValue({
      pageNumber: 1,
      fullText: "WinKit 离线预览测试",
      charCount: 13,
      spans: [
        {
          text: "WinKit 离线预览测试",
          rect: { left: 0.1, top: 0.1, width: 0.4, height: 0.04 },
        },
      ],
      links: [],
    });
    vi.mocked(bridge.searchPdfText).mockResolvedValue({
      query: "离线预览",
      totalMatches: 1,
      truncated: false,
      matches: [
        {
          pageNumber: 1,
          matchIndex: 0,
          snippet: "WinKit 离线预览测试",
          rects: [{ left: 0.2, top: 0.1, width: 0.15, height: 0.04 }],
        },
      ],
    });

    const onNavTool = vi.fn();
    renderReader(onNavTool);

    await user.click(screen.getAllByRole("button", { name: /打开 PDF/ })[0]!);

    await waitFor(() => {
      expect(screen.getAllByText("WinKit 离线预览测试").length).toBeGreaterThan(0);
    });
    expect(screen.getByText(/此 PDF 包含数字签名/)).toBeInTheDocument();

    // Switch sidebar to outlines and verify bookmark appears
    await user.click(screen.getByRole("tab", { name: "目录" }));
    expect(screen.getByRole("button", { name: /第一章 概述/ })).toBeInTheDocument();

    // Open search and search text
    await user.click(screen.getByRole("button", { name: "查找" }));
    const searchInput = screen.getByPlaceholderText(/查找文档文字/);
    await user.type(searchInput, "离线预览{Enter}");
    await waitFor(() => {
      expect(screen.getByText("1 / 1")).toBeInTheDocument();
    });

    // Send to P08 Split tool
    await user.click(screen.getByRole("button", { name: "P08" }));
    expect(onNavTool).toHaveBeenCalledWith("P08");
  });

  it("shows honest scanned PDF banner when no text layer is present", async () => {
    const user = userEvent.setup();
    vi.mocked(bridge.pickSingleFile).mockResolvedValue("C:\\Samples\\scan.pdf");
    vi.mocked(bridge.inspectPdfDocument).mockResolvedValue({
      path: "C:\\Samples\\scan.pdf",
      fileName: "scan.pdf",
      byteLength: 102400,
      pageCount: 1,
      pages: [{ pageNumber: 1, widthPt: 595, heightPt: 842, rotation: 0, isOversized: false }],
      hasTextLayer: false,
      sampledTextPages: 1,
      isLikelyScanned: true,
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
        widthPx: 640,
        heightPx: 906,
        pageWidthPt: 595,
        pageHeightPt: 842,
        rotation: 0,
        capped: false,
      },
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      fromCache: false,
    });

    renderReader();
    await user.click(screen.getAllByRole("button", { name: /打开 PDF/ })[0]!);
    await waitFor(() => {
      expect(screen.getByText(/扫描件或纯图片页面/)).toBeInTheDocument();
    });
  });
});
