import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { PdfSessionProvider } from "../../lib/pdfSessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { PdfCropWorkspace } from "./PdfCropWorkspace";

const SAMPLE_PNG_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("P13 PdfCropWorkspace", () => {
  it("opens a PDF, previews auto-detected white margins without auto-exporting, displays non-destructive privacy notice, and exports via cropPdf", async () => {
    const user = userEvent.setup();
    vi.spyOn(tauriBridge, "pickSingleFile").mockResolvedValueOnce("D:\\Docs\\label.pdf");
    vi.spyOn(tauriBridge, "inspectPdfDocument").mockResolvedValueOnce({
      path: "D:\\Docs\\label.pdf",
      fileName: "label.pdf",
      byteLength: 18000,
      pageCount: 2,
      pages: [
        { pageNumber: 1, widthPt: 595, heightPt: 842, rotation: 0, isOversized: false },
        { pageNumber: 2, widthPt: 842, heightPt: 595, rotation: 90, isOversized: false },
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
    vi.spyOn(tauriBridge, "suggestSafeSiblingPath").mockResolvedValueOnce(
      "D:\\Docs\\label_cropped.pdf",
    );
    vi.spyOn(tauriBridge, "renderPdfPage").mockResolvedValue({
      meta: {
        pageNumber: 1,
        widthPx: 960,
        heightPx: 1358,
        pageWidthPt: 595,
        pageHeightPt: 842,
        rotation: 0,
        capped: false,
      },
      dataUrl: SAMPLE_PNG_URL,
      fromCache: false,
    });
    const detectSpy = vi.spyOn(tauriBridge, "detectPdfWhiteMargins").mockResolvedValueOnce({
      pageNumber: 1,
      isBlank: false,
      pageWidthPt: 595,
      pageHeightPt: 842,
      leftPt: 40,
      rightPt: 40,
      topPt: 60,
      bottomPt: 60,
      leftNorm: 40 / 595,
      topNorm: 60 / 842,
      widthNorm: 515 / 595,
      heightNorm: 722 / 842,
    });
    const cropSpy = vi.spyOn(tauriBridge, "cropPdf").mockResolvedValueOnce({
      outputPath: "D:\\Docs\\label_cropped.pdf",
      byteLength: 18200,
      totalPages: 2,
      croppedPageCount: 2,
      samplePages: [
        { pageNumber: 1, oldWidthPt: 595, oldHeightPt: 842, newWidthPt: 515, newHeightPt: 722 },
      ],
      signatureInvalidated: false,
      warnings: [],
    });

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <PdfSessionProvider onNavigateToReader={() => {}} onNavigateToTool={() => {}}>
          <PdfCropWorkspace />
        </PdfSessionProvider>
      </I18nContext.Provider>,
    );

    expect(screen.getByText(/不能代替隐私永久涂黑删除/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "选择 PDF…" }));
    await waitFor(() => {
      expect(screen.getByText("1 / 2")).toBeInTheDocument();
    });

    // Auto-detect white margins updates preview ONLY (does not call cropPdf!)
    await user.click(screen.getByRole("button", { name: "自动检测白边（先预览）" }));
    await waitFor(() => {
      expect(detectSpy).toHaveBeenCalledTimes(1);
    });
    expect(cropSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/已按检测结果预览白边/)).toBeInTheDocument();

    // Confirm and export
    await user.click(screen.getByRole("button", { name: "导出裁剪 PDF" }));
    await waitFor(() => {
      expect(cropSpy).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText(/裁剪完成/)).toBeInTheDocument();
  });
});
