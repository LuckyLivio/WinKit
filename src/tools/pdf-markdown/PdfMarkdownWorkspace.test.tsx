import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { PdfSessionProvider } from "../../lib/pdfSessionStore";
import { PdfMarkdownWorkspace } from "./PdfMarkdownWorkspace";

const mockRenderMarkdownPreview = vi.fn();
const mockExportMarkdownToPdf = vi.fn();
const mockPickSaveFilePath = vi.fn();

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    renderMarkdownPreview: (...args: unknown[]) => mockRenderMarkdownPreview(...args),
    exportMarkdownToPdf: (...args: unknown[]) => mockExportMarkdownToPdf(...args),
    pickSaveFilePath: (...args: unknown[]) => mockPickSaveFilePath(...args),
    subscribeFileDrop: () => Promise.resolve(() => {}),
    subscribePdfTaskProgress: () => Promise.resolve(() => {}),
  };
});

describe("PdfMarkdownWorkspace (P23)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRenderMarkdownPreview.mockResolvedValue({
      htmlDocument: "<!DOCTYPE html><html><body><h1>Demo</h1></body></html>",
      headings: [{ level: 1, title: "Demo", slug: "demo" }],
      embeddedLocalImages: 0,
      blockedRemoteImages: 1,
      blockedLocalImages: 0,
      strippedRawHtmlCount: 1,
      warnings: [],
    });
  });

  it("renders sandboxed preview and exports Markdown to PDF with bookmarks", async () => {
    const user = userEvent.setup();
    mockPickSaveFilePath.mockResolvedValue("C:\\Docs\\readme.pdf");
    mockExportMarkdownToPdf.mockResolvedValue({
      outputPath: "C:\\Docs\\readme.pdf",
      byteLength: 82400,
      pageCount: 2,
      bookmarkCount: 3,
      embeddedLocalImages: 1,
      blockedRemoteImages: 1,
      blockedLocalImages: 0,
      strippedRawHtmlCount: 1,
      hasTextLayer: true,
      warnings: [],
    });

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <PdfSessionProvider onNavigateToReader={() => {}} onNavigateToTool={() => {}}>
          <PdfMarkdownWorkspace />
        </PdfSessionProvider>
      </I18nContext.Provider>,
    );

    await waitFor(() => {
      expect(mockRenderMarkdownPreview).toHaveBeenCalled();
    });

    const iframe = screen.getByTitle("Markdown 排版预览");
    expect(iframe).toHaveAttribute("sandbox", "");

    await user.selectOptions(screen.getByLabelText("排版主题"), "clean");
    await user.selectOptions(screen.getByLabelText("纸张尺寸"), "letter");
    await user.click(screen.getByRole("button", { name: /导出矢量 PDF/ }));

    await waitFor(() => {
      expect(mockExportMarkdownToPdf).toHaveBeenCalledWith(
        expect.stringMatching(/^p23-/),
        expect.objectContaining({
          outputPath: "C:\\Docs\\readme.pdf",
          theme: "clean",
          paperSize: "letter",
          includeBookmarks: true,
        }),
      );
    });

    expect(screen.getByText(/共 2 页.*3 条标题书签/)).toBeInTheDocument();
  });
});
