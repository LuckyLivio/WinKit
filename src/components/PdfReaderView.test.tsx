import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../i18n/I18nContext";
import { MESSAGES } from "../i18n/messages";
import { PdfSessionProvider } from "../lib/pdfSessionStore";
import { SessionStoreProvider } from "../lib/sessionStore";
import * as bridge from "../lib/tauriBridge";
import { TextToSpeechWorkspace } from "../tools/text-to-speech/TextToSpeechWorkspace";
import { PdfReaderView } from "./PdfReaderView";

vi.mock("../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof bridge>();
  return {
    ...actual,
    pickSingleFile: vi.fn(),
    inspectPdfDocument: vi.fn(),
    renderPdfPage: vi.fn(),
    getPdfPageText: vi.fn(),
    extractPdfPagesText: vi.fn(),
    searchPdfText: vi.fn(),
    subscribeFileDrop: vi.fn().mockResolvedValue(() => {}),
    listTtsVoices: vi.fn().mockResolvedValue({
      voices: [
        {
          id: "winrt::huihui",
          name: "Microsoft Huihui",
          language: "zh-CN",
          gender: "female",
          engine: "winrt_one_core",
          isDefault: true,
        },
      ],
      defaultVoiceId: "winrt::huihui",
      hasChineseVoice: true,
      hasEnglishVoice: false,
      winrtCount: 1,
      sapiCount: 0,
    }),
    synthesizeTtsSpeech: vi.fn(),
    subscribeTtsProgress: vi.fn().mockResolvedValue(() => {}),
    clearTtsSession: vi.fn().mockResolvedValue(undefined),
    cancelBackendTask: vi.fn().mockResolvedValue(true),
    getMediaToolsStatus: vi.fn().mockResolvedValue({
      ready: false,
      source: "missing",
      mode: "auto",
      customDir: null,
      ffmpegPath: null,
      ffprobePath: null,
      ffmpegVersion: null,
      ffprobeVersion: null,
      installDir: "C:\\Users\\Test\\media-tools",
      managedInstalledBytes: null,
      licensePath: null,
      error: null,
      spec: {
        version: "9.1",
        sourceName: "GyanD/codexffmpeg",
        releaseUrl: "",
        sourceCommitUrl: "",
        downloadUrl: "",
        downloadBytes: 0,
        sha256: "",
        estimatedInstalledBytes: 0,
        licenseName: "GPL-3.0",
      },
    }),
    subscribeMediaSetupProgress: vi.fn().mockResolvedValue(() => {}),
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

  it("offers one-click P16 handoff when opening a password-protected PDF", async () => {
    const user = userEvent.setup();
    const onNavTool = vi.fn();
    vi.mocked(bridge.pickSingleFile).mockResolvedValue("C:\\Samples\\locked.pdf");
    vi.mocked(bridge.inspectPdfDocument).mockRejectedValue({
      code: "PDF_PASSWORD_REQUIRED",
      message: "This PDF requires a password to open.",
    });

    renderReader(onNavTool);
    await user.click(screen.getAllByRole("button", { name: /打开 PDF/ })[0]!);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/受打开密码保护/);
    });
    await user.click(screen.getByRole("button", { name: /使用 P16 输入密码解锁/ }));
    expect(onNavTool).toHaveBeenCalledWith("P16");
  });

  it("extracts current page or selected page range from C08 into T06 for user preview/edit before manual synthesis", async () => {
    const user = userEvent.setup();
    vi.mocked(bridge.pickSingleFile).mockResolvedValue("C:\\Samples\\bilingual.pdf");
    vi.mocked(bridge.inspectPdfDocument).mockResolvedValue({
      path: "C:\\Samples\\bilingual.pdf",
      fileName: "bilingual.pdf",
      byteLength: 64000,
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
      fullText: "第一页中文朗读内容。",
      charCount: 10,
      spans: [],
      links: [],
    });
    vi.mocked(bridge.extractPdfPagesText).mockResolvedValue({
      path: "C:\\Samples\\bilingual.pdf",
      fileName: "bilingual.pdf",
      totalPages: 3,
      requestedPages: [1, 2, 3],
      includedPages: [1, 3],
      scannedPages: [2],
      omittedPages: [],
      pages: [
        { pageNumber: 1, charCount: 10, byteCount: 30, hasText: true, status: "included" },
        { pageNumber: 2, charCount: 0, byteCount: 0, hasText: false, status: "scanned" },
        { pageNumber: 3, charCount: 26, byteCount: 26, hasText: true, status: "included" },
      ],
      combinedText: "第一页中文朗读内容。\n\nPage three English speech.",
      extractedPageCount: 2,
      totalChars: 38,
      totalBytes: 58,
      truncated: false,
    });
    vi.mocked(bridge.synthesizeTtsSpeech).mockResolvedValue({
      resultId: "tts-pdf-1",
      voiceId: "winrt::huihui",
      voiceName: "Microsoft Huihui",
      voiceLanguage: "zh-CN",
      engine: "winrt_one_core",
      rate: 1,
      segmentCount: 2,
      paragraphCount: 2,
      charCount: 40,
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      durationSec: 4.2,
      wavByteLength: 134444,
      previewUrl: "http://winkitmedia.localhost/preview/tts-pdf-1",
      elapsedMs: 95,
      sourcePath: "C:\\Samples\\bilingual.pdf",
      supportedMp3BitratesKbps: [64, 96, 128, 160],
    });

    const navSpy = vi.fn();
    function Harness() {
      const [view, setView] = useState<"reader" | "T06">("reader");
      const handleNav = (toolId: string) => {
        navSpy(toolId);
        if (toolId === "T06") setView("T06");
      };
      return (
        <I18nContext.Provider
          value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}
        >
          <SessionStoreProvider onNavigateToTool={handleNav}>
            <PdfSessionProvider
              onNavigateToReader={() => setView("reader")}
              onNavigateToTool={handleNav}
            >
              {view === "reader" ? <PdfReaderView /> : <TextToSpeechWorkspace />}
            </PdfSessionProvider>
          </SessionStoreProvider>
        </I18nContext.Provider>
      );
    }

    render(<Harness />);
    await user.click(screen.getAllByRole("button", { name: /打开 PDF/ })[0]!);
    await waitFor(() => {
      expect(screen.getByTestId("c08-read-selected-pages-btn")).toBeInTheDocument();
    });

    // Open selected pages bar, type 1-3, and send to T06
    await user.click(screen.getByTestId("c08-read-selected-pages-btn"));
    const rangeInput = screen.getByTestId("c08-tts-page-range-input");
    await user.clear(rangeInput);
    await user.type(rangeInput, "1-3");
    await user.click(screen.getByTestId("c08-tts-send-selected-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("text-to-speech-workspace")).toBeInTheDocument();
    });
    expect(bridge.extractPdfPagesText).toHaveBeenCalledWith(
      "C:\\Samples\\bilingual.pdf",
      [1, 2, 3],
    );
    // Must NOT auto-synthesize; user reviews & edits first
    expect(bridge.synthesizeTtsSpeech).not.toHaveBeenCalled();
    expect(screen.getByTestId("t06-source-file-badge")).toHaveTextContent("bilingual.pdf");
    expect(screen.getByTestId("t06-source-pages-badge")).toHaveTextContent("1, 3");
    expect(screen.getByTestId("t06-pdf-scanned-pages-notice")).toHaveTextContent("第 2 页");
    expect(screen.getByTestId("t06-text-input")).toHaveValue(
      "第一页中文朗读内容。\n\nPage three English speech.",
    );

    // Edit text and manually start synthesis -> preserves sourcePath = PDF path
    await user.type(screen.getByTestId("t06-text-input"), " 已校对。");
    await waitFor(() => expect(screen.getByTestId("t06-start-btn")).toBeEnabled());
    await user.click(screen.getByTestId("t06-start-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("t06-audio-player")).toBeInTheDocument();
    });
    expect(bridge.synthesizeTtsSpeech).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        sourcePath: "C:\\Samples\\bilingual.pdf",
        text: "第一页中文朗读内容。\n\nPage three English speech. 已校对。",
      }),
    );

    // Click skipped scanned page P04 button
    await user.click(screen.getByTestId("t06-goto-p04-btn"));
    expect(navSpy).toHaveBeenCalledWith("P04");
  });

  it("shows a direct jump to P04 when trying to read a pure scanned page in C08", async () => {
    const user = userEvent.setup();
    vi.mocked(bridge.pickSingleFile).mockResolvedValue("C:\\Samples\\pure_scan.pdf");
    vi.mocked(bridge.inspectPdfDocument).mockResolvedValue({
      path: "C:\\Samples\\pure_scan.pdf",
      fileName: "pure_scan.pdf",
      byteLength: 96000,
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
    vi.mocked(bridge.extractPdfPagesText).mockResolvedValue({
      path: "C:\\Samples\\pure_scan.pdf",
      fileName: "pure_scan.pdf",
      totalPages: 1,
      requestedPages: [1],
      includedPages: [],
      scannedPages: [1],
      omittedPages: [],
      pages: [{ pageNumber: 1, charCount: 0, byteCount: 0, hasText: false, status: "scanned" }],
      combinedText: "",
      extractedPageCount: 0,
      totalChars: 0,
      totalBytes: 0,
      truncated: false,
    });

    const navSpy = vi.fn();
    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <SessionStoreProvider onNavigateToTool={navSpy}>
          <PdfSessionProvider onNavigateToReader={() => {}} onNavigateToTool={navSpy}>
            <PdfReaderView />
          </PdfSessionProvider>
        </SessionStoreProvider>
      </I18nContext.Provider>,
    );

    await user.click(screen.getAllByRole("button", { name: /打开 PDF/ })[0]!);
    await waitFor(() => {
      expect(screen.getByTestId("c08-read-current-page-btn")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("c08-read-current-page-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("c08-tts-scanned-banner")).toBeInTheDocument();
    });
    expect(navSpy).not.toHaveBeenCalledWith("T06");

    await user.click(screen.getByTestId("c08-tts-goto-p04-btn"));
    expect(navSpy).toHaveBeenCalledWith("P04");
  });

  it("disables read-aloud while switching to document B and ignores late extraction after leaving C08", async () => {
    const user = userEvent.setup();
    const docA: bridge.PdfDocumentInspection = {
      path: "C:\\Samples\\docA.pdf",
      fileName: "docA.pdf",
      byteLength: 12000,
      pageCount: 1,
      pages: [{ pageNumber: 1, widthPt: 595, heightPt: 842, rotation: 0, isOversized: false }],
      hasTextLayer: true,
      sampledTextPages: 1,
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
    };
    const docB: bridge.PdfDocumentInspection = {
      ...docA,
      path: "C:\\Samples\\docB.pdf",
      fileName: "docB.pdf",
    };

    let resolveInspectB!: (info: bridge.PdfDocumentInspection) => void;
    vi.mocked(bridge.pickSingleFile)
      .mockResolvedValueOnce(docA.path)
      .mockResolvedValueOnce(docB.path);
    vi.mocked(bridge.inspectPdfDocument)
      .mockResolvedValueOnce(docA)
      .mockImplementationOnce(
        () =>
          new Promise<bridge.PdfDocumentInspection>((resolve) => {
            resolveInspectB = resolve;
          }),
      );
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
      fullText: "Doc text",
      charCount: 8,
      spans: [],
      links: [],
    });

    let resolveLateExtract!: (res: bridge.PdfExtractPagesTextResult) => void;
    vi.mocked(bridge.extractPdfPagesText).mockImplementationOnce(
      () =>
        new Promise<bridge.PdfExtractPagesTextResult>((resolve) => {
          resolveLateExtract = resolve;
        }),
    );

    const navSpy = vi.fn();
    function SwitchHarness() {
      const [view, setView] = useState<"reader" | "other" | "T06">("reader");
      const handleNav = (toolId: string) => {
        navSpy(toolId);
        if (toolId === "T06") setView("T06");
      };
      return (
        <I18nContext.Provider
          value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}
        >
          <SessionStoreProvider onNavigateToTool={handleNav}>
            <PdfSessionProvider
              onNavigateToReader={() => setView("reader")}
              onNavigateToTool={handleNav}
            >
              <button type="button" onClick={() => setView("other")} data-testid="leave-c08-btn">
                Leave
              </button>
              <button type="button" onClick={() => setView("T06")} data-testid="open-t06-btn">
                Open T06
              </button>
              {view === "reader" ? (
                <PdfReaderView />
              ) : view === "T06" ? (
                <TextToSpeechWorkspace />
              ) : (
                <div data-testid="other-view">Other Page</div>
              )}
            </PdfSessionProvider>
          </SessionStoreProvider>
        </I18nContext.Provider>
      );
    }

    render(<SwitchHarness />);
    // 1. Open A and confirm read-aloud is enabled
    await user.click(screen.getAllByRole("button", { name: /打开 PDF/ })[0]!);
    await waitFor(() => {
      expect(screen.getByTestId("c08-read-current-page-btn")).toBeEnabled();
    });

    // 2. Start opening B (inspect pending) -> read-aloud buttons MUST be disabled so A cannot be sent
    await user.click(screen.getAllByRole("button", { name: /打开 PDF/ })[0]!);
    await waitFor(() => {
      expect(screen.getByTestId("c08-read-current-page-btn")).toBeDisabled();
      expect(screen.getByTestId("c08-read-selected-pages-btn")).toBeDisabled();
    });
    expect(bridge.extractPdfPagesText).not.toHaveBeenCalled();

    // Finish loading B -> read-aloud re-enabled and bound strictly to docB
    resolveInspectB(docB);
    await waitFor(() => {
      expect(screen.getByTestId("c08-read-current-page-btn")).toBeEnabled();
    });

    // 3. Start extraction on B, leave C08 before extraction finishes -> late response MUST NOT hijack navigation
    await user.click(screen.getByTestId("c08-read-current-page-btn"));
    expect(bridge.extractPdfPagesText).toHaveBeenCalledWith(docB.path, [1]);
    await user.click(screen.getByTestId("leave-c08-btn"));
    expect(screen.getByTestId("other-view")).toBeInTheDocument();

    resolveLateExtract({
      path: docB.path,
      fileName: docB.fileName,
      totalPages: 1,
      requestedPages: [1],
      includedPages: [1],
      scannedPages: [],
      omittedPages: [],
      pages: [{ pageNumber: 1, charCount: 12, byteCount: 12, hasText: true, status: "included" }],
      combinedText: "Late docB text",
      extractedPageCount: 1,
      totalChars: 14,
      totalBytes: 14,
      truncated: false,
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(navSpy).not.toHaveBeenCalledWith("T06");
    expect(screen.getByTestId("other-view")).toBeInTheDocument();

    // Opening T06 manually confirms late extraction never wrote into T06
    await user.click(screen.getByTestId("open-t06-btn"));
    expect(screen.getByTestId("t06-text-input")).toHaveValue("");
  });

  it("stashes PDF handoff while T06 is synthesizing, confirms before replacing draft/audition, and preserves original on cancel or error", async () => {
    const user = userEvent.setup();
    const docB: bridge.PdfDocumentInspection = {
      path: "C:\\Samples\\incoming_b.pdf",
      fileName: "incoming_b.pdf",
      byteLength: 32000,
      pageCount: 5,
      pages: [1, 2, 3, 4, 5].map((n) => ({
        pageNumber: n,
        widthPt: 595,
        heightPt: 842,
        rotation: 0,
        isOversized: false,
      })),
      hasTextLayer: true,
      sampledTextPages: 5,
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
    };
    vi.mocked(bridge.pickSingleFile).mockResolvedValue(docB.path);
    vi.mocked(bridge.inspectPdfDocument).mockResolvedValue(docB);
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
      fullText: "Incoming B text",
      charCount: 15,
      spans: [],
      links: [],
    });

    const truncatedExtractB: bridge.PdfExtractPagesTextResult = {
      path: docB.path,
      fileName: docB.fileName,
      totalPages: 5,
      requestedPages: [1, 2, 3, 4, 5],
      includedPages: [1, 3, 4],
      scannedPages: [2],
      omittedPages: [5],
      pages: [
        { pageNumber: 1, charCount: 20, byteCount: 20, hasText: true, status: "included" },
        { pageNumber: 2, charCount: 0, byteCount: 0, hasText: false, status: "scanned" },
        { pageNumber: 3, charCount: 20, byteCount: 20, hasText: true, status: "included" },
        { pageNumber: 4, charCount: 15, byteCount: 15, hasText: true, status: "truncated" },
        { pageNumber: 5, charCount: 0, byteCount: 0, hasText: false, status: "omitted" },
      ],
      combinedText: "来自文档 B 的截断朗读正文。",
      extractedPageCount: 3,
      totalChars: 14,
      totalBytes: 42,
      truncated: true,
    };

    vi.mocked(bridge.extractPdfPagesText)
      .mockResolvedValueOnce(truncatedExtractB)
      .mockRejectedValueOnce({ code: "PDF_CORRUPT_OR_INVALID", message: "Corrupted PDF" })
      .mockResolvedValueOnce(truncatedExtractB);

    let resolveSynthA!: (res: bridge.SynthesizeTtsResult) => void;
    vi.mocked(bridge.synthesizeTtsSpeech).mockImplementationOnce(
      () =>
        new Promise<bridge.SynthesizeTtsResult>((resolve) => {
          resolveSynthA = resolve;
        }),
    );

    function HandoffHarness() {
      const [view, setView] = useState<"T06" | "reader" | "other">("T06");
      return (
        <I18nContext.Provider
          value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}
        >
          <SessionStoreProvider onNavigateToTool={(id) => id === "T06" && setView("T06")}>
            <PdfSessionProvider
              onNavigateToReader={() => setView("reader")}
              onNavigateToTool={(id) => id === "T06" && setView("T06")}
            >
              <button type="button" onClick={() => setView("other")} data-testid="goto-other-btn">
                Other
              </button>
              <button type="button" onClick={() => setView("T06")} data-testid="goto-t06-btn">
                T06
              </button>
              <button type="button" onClick={() => setView("reader")} data-testid="goto-c08-btn">
                C08
              </button>
              {view === "reader" ? (
                <PdfReaderView />
              ) : view === "T06" ? (
                <TextToSpeechWorkspace />
              ) : (
                <div data-testid="other-tool">Other Tool</div>
              )}
            </PdfSessionProvider>
          </SessionStoreProvider>
        </I18nContext.Provider>
      );
    }

    render(<HandoffHarness />);
    await waitFor(() => {
      expect(screen.getByTestId("t06-voice-select")).toHaveValue("winrt::huihui");
    });

    // 1. Start synthesizing draft A in T06
    await user.type(screen.getByTestId("t06-text-input"), "原始草稿 A 正文。");
    await user.click(screen.getByTestId("t06-start-btn"));
    await waitFor(() => expect(screen.getByTestId("t06-cancel-btn")).toBeInTheDocument());

    // 2. Open C08 while A is running, open docB, and send it to T06 -> MUST stash, NOT cancel A
    await user.click(screen.getByTestId("t06-open-pdf-reader-btn"));
    await user.click(screen.getAllByRole("button", { name: /打开 PDF/ })[0]!);
    await waitFor(() => expect(screen.getByTestId("c08-read-current-page-btn")).toBeEnabled());
    await user.click(screen.getByTestId("c08-read-current-page-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("t06-pending-handoff-banner")).toBeInTheDocument();
    });
    expect(bridge.cancelBackendTask).not.toHaveBeenCalled();
    expect(screen.getByTestId("t06-text-input")).toHaveValue("原始草稿 A 正文。");
    expect(screen.queryByTestId("t06-load-pending-btn")).not.toBeInTheDocument();

    // 3. Switch away and return -> pending handoff banner persists
    await user.click(screen.getByTestId("goto-other-btn"));
    expect(screen.getByTestId("other-tool")).toBeInTheDocument();
    await user.click(screen.getByTestId("goto-t06-btn"));
    expect(screen.getByTestId("t06-pending-handoff-banner")).toBeInTheDocument();

    // 4. Finish synthesis A -> audio player appears AND Load Pending PDF button becomes available
    resolveSynthA({
      resultId: "tts-draft-a",
      voiceId: "winrt::huihui",
      voiceName: "Microsoft Huihui",
      voiceLanguage: "zh-CN",
      engine: "winrt_one_core",
      rate: 1,
      segmentCount: 1,
      paragraphCount: 1,
      charCount: 9,
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      durationSec: 2.5,
      wavByteLength: 80044,
      previewUrl: "http://winkitmedia.localhost/preview/tts-draft-a",
      elapsedMs: 50,
      sourcePath: null,
      supportedMp3BitratesKbps: [64, 96, 128, 160],
    });
    await waitFor(() => {
      expect(screen.getByTestId("t06-audio-player")).toBeInTheDocument();
      expect(screen.getByTestId("t06-load-pending-btn")).toBeInTheDocument();
    });

    // Clicking Load Pending opens ConfirmDialog; cancelling preserves A's draft & audio
    await user.click(screen.getByTestId("t06-load-pending-btn"));
    expect(screen.getByText("替换当前朗读稿与试听结果？")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保留原稿与试听" }));
    expect(screen.getByTestId("t06-text-input")).toHaveValue("原始草稿 A 正文。");
    expect(screen.getByTestId("t06-audio-player")).toBeInTheDocument();

    // Dismissing queued banner also preserves A's draft & audio
    await user.click(screen.getByTestId("t06-dismiss-pending-btn"));
    expect(screen.queryByTestId("t06-pending-handoff-banner")).not.toBeInTheDocument();
    expect(screen.getByTestId("t06-text-input")).toHaveValue("原始草稿 A 正文。");
    expect(screen.getByTestId("t06-audio-player")).toBeInTheDocument();

    // 5. Failed extraction request in C08 preserves T06 draft & audition
    await user.click(screen.getByTestId("goto-c08-btn"));
    await waitFor(() => expect(screen.getByTestId("c08-read-current-page-btn")).toBeEnabled());
    await user.click(screen.getByTestId("c08-read-current-page-btn"));
    await waitFor(() => expect(screen.getByTestId("c08-tts-error-banner")).toBeInTheDocument());
    await user.click(screen.getByTestId("goto-t06-btn"));
    expect(screen.getByTestId("t06-text-input")).toHaveValue("原始草稿 A 正文。");
    expect(screen.getByTestId("t06-audio-player")).toBeInTheDocument();

    // 6. Idle T06 with draft & audio receiving PDF handoff -> immediate ConfirmDialog -> confirm loads B
    await user.click(screen.getByTestId("goto-c08-btn"));
    await user.click(screen.getByTestId("c08-read-current-page-btn"));
    await waitFor(() => {
      expect(screen.getByText("替换当前朗读稿与试听结果？")).toBeInTheDocument();
    });
    expect(screen.getByTestId("t06-text-input")).toHaveValue("原始草稿 A 正文。");
    expect(screen.getByTestId("t06-audio-player")).toBeInTheDocument();
    expect(bridge.clearTtsSession).not.toHaveBeenCalled();

    // Confirm -> replaces draft, clears audio, and renders exact included/scanned/omitted page badges
    await user.click(screen.getByRole("button", { name: "确认载入" }));
    await waitFor(() => {
      expect(screen.getByTestId("t06-text-input")).toHaveValue("来自文档 B 的截断朗读正文。");
    });
    expect(bridge.clearTtsSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("t06-audio-player")).not.toBeInTheDocument();
    expect(screen.getByTestId("t06-source-pages-badge")).toHaveTextContent("PDF 第 1, 3-4 页");
    expect(screen.getByTestId("t06-pdf-scanned-pages-notice")).toHaveTextContent("第 2 页");
    expect(screen.getByTestId("t06-pdf-truncated-notice")).toHaveTextContent("第 5 页");
  });
});
