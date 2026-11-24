import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { PdfSessionProvider } from "../../lib/pdfSessionStore";
import { PdfCompressWorkspace } from "./PdfCompressWorkspace";

const mockInspectPdfDocument = vi.fn();
const mockCompressPdf = vi.fn();
const mockPickSingleFile = vi.fn();
const mockSuggestSafeSiblingPath = vi.fn();

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    inspectPdfDocument: (...args: unknown[]) => mockInspectPdfDocument(...args),
    compressPdf: (...args: unknown[]) => mockCompressPdf(...args),
    pickSingleFile: (...args: unknown[]) => mockPickSingleFile(...args),
    suggestSafeSiblingPath: (...args: unknown[]) => mockSuggestSafeSiblingPath(...args),
    subscribeFileDrop: () => Promise.resolve(() => {}),
    subscribePdfTaskProgress: () => Promise.resolve(() => {}),
  };
});

describe("PdfCompressWorkspace (P14)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("selects a PDF, switches compression mode, and displays real before/after savings", async () => {
    const user = userEvent.setup();
    mockPickSingleFile.mockResolvedValue("C:\\Docs\\scan.pdf");
    mockInspectPdfDocument.mockResolvedValue({
      path: "C:\\Docs\\scan.pdf",
      fileName: "scan.pdf",
      byteLength: 4_000_000,
      pageCount: 10,
      pages: [],
      hasTextLayer: true,
      sampledTextPages: 10,
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
    mockSuggestSafeSiblingPath.mockResolvedValue("C:\\Docs\\scan_compressed.pdf");
    mockCompressPdf.mockResolvedValue({
      outputPath: "C:\\Docs\\scan_compressed.pdf",
      mode: "smallest",
      pageCount: 10,
      originalBytes: 4_000_000,
      outputBytes: 1_200_000,
      savedBytes: 2_800_000,
      savedPercent: 70.0,
      keptOriginal: false,
      imagesInspected: 8,
      imagesOptimized: 8,
      imagesDownsampled: 6,
      hasTextLayer: true,
      warnings: [],
    });

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <PdfSessionProvider onNavigateToReader={() => {}} onNavigateToTool={() => {}}>
          <PdfCompressWorkspace />
        </PdfSessionProvider>
      </I18nContext.Provider>,
    );

    await user.click(screen.getByRole("button", { name: /选择 PDF 文件/ }));
    await waitFor(() => {
      expect(screen.getByText("scan.pdf")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("radio", { name: /最小体积/ }));
    await user.click(screen.getByRole("button", { name: /开始压缩并导出/ }));

    await waitFor(() => {
      expect(mockCompressPdf).toHaveBeenCalledWith(
        expect.stringMatching(/^p14-/),
        expect.objectContaining({
          inputPath: "C:\\Docs\\scan.pdf",
          outputPath: "C:\\Docs\\scan_compressed.pdf",
          mode: "smallest",
        }),
      );
    });

    expect(screen.getByText(/70\.0%/)).toBeInTheDocument();
  });
});
