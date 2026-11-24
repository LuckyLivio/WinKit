import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { PdfSessionProvider } from "../../lib/pdfSessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { PdfSignWorkspace } from "./PdfSignWorkspace";

const SAMPLE_PNG_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("P06 PdfSignWorkspace", () => {
  it("opens a signed PDF with digital signature warning, creates a typed signature, places it with undo/redo, and exports via signPdf", async () => {
    const user = userEvent.setup();
    vi.spyOn(tauriBridge, "listSignatureTemplates").mockResolvedValue({
      storageDir: "C:\\Temp\\sig-templates",
      items: [],
    });
    vi.spyOn(tauriBridge, "pickSingleFile").mockResolvedValueOnce("D:\\Docs\\contract.pdf");
    vi.spyOn(tauriBridge, "inspectPdfDocument").mockResolvedValueOnce({
      path: "D:\\Docs\\contract.pdf",
      fileName: "contract.pdf",
      byteLength: 24000,
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
      hasSignatures: true,
      signatureCount: 1,
      isEncrypted: false,
      title: null,
      author: null,
      subject: null,
      creator: null,
      producer: null,
      warnings: [],
    });
    vi.spyOn(tauriBridge, "suggestSafeSiblingPath").mockResolvedValueOnce(
      "D:\\Docs\\contract_signed.pdf",
    );
    vi.spyOn(tauriBridge, "renderPdfPage").mockResolvedValue({
      meta: {
        pageNumber: 1,
        widthPx: 920,
        heightPx: 1300,
        pageWidthPt: 595,
        pageHeightPt: 842,
        rotation: 0,
        capped: false,
      },
      dataUrl: SAMPLE_PNG_URL,
      fromCache: false,
    });
    const signSpy = vi.spyOn(tauriBridge, "signPdf").mockResolvedValueOnce({
      outputPath: "D:\\Docs\\contract_signed.pdf",
      byteLength: 28000,
      totalPages: 2,
      signedPages: [1],
      placementCount: 1,
      signatureInvalidated: true,
      warnings: [],
    });

    // Stub canvas 2D context for typed signature rasterization under jsdom
    const fakeCtx = {
      font: "",
      fillStyle: "",
      textBaseline: "",
      textAlign: "",
      measureText: () => ({ width: 120 }),
      fillText: () => {},
      getImageData: () => ({
        data: new Uint8ClampedArray(16 * 16 * 4).fill(255),
        width: 16,
        height: 16,
      }),
      drawImage: () => {},
      clearRect: () => {},
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fakeCtx);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(SAMPLE_PNG_URL);

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <PdfSessionProvider onNavigateToReader={() => {}} onNavigateToTool={() => {}}>
          <PdfSignWorkspace />
        </PdfSessionProvider>
      </I18nContext.Provider>,
    );

    // Non-CA honest disclosure is always visible
    expect(screen.getByText(/不提供 CA 数字证书认证/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "选择 PDF…" }));
    await waitFor(() => {
      expect(screen.getByText(/包含 1 个数字签名字段/)).toBeInTheDocument();
    });

    // Switch to Type signature tab, create a typed signature, and place it onto page 1
    await user.click(screen.getByRole("tab", { name: "文字" }));
    await user.type(screen.getByPlaceholderText("输入中文或英文姓名…"), "张三");
    await user.click(screen.getByRole("button", { name: "生成文字签名" }));
    await user.click(screen.getByRole("button", { name: "放置到当前页" }));

    expect(screen.getByText("已放置 1 处签名")).toBeInTheDocument();

    // Verify undo & redo
    await user.click(screen.getByRole("button", { name: "撤销" }));
    expect(screen.getByText("已放置 0 处签名")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重做" }));
    expect(screen.getByText("已放置 1 处签名")).toBeInTheDocument();

    // Export
    await user.click(screen.getByRole("button", { name: "导出已签名 PDF" }));
    await waitFor(() => {
      expect(signSpy).toHaveBeenCalledTimes(1);
    });
    expect(signSpy.mock.calls[0]?.[0].outputPath).toBe("D:\\Docs\\contract_signed.pdf");
    expect(screen.getByText(/导出完成/)).toBeInTheDocument();
  });
});
