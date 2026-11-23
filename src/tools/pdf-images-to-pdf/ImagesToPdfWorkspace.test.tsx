import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { PdfSessionProvider } from "../../lib/pdfSessionStore";
import * as bridge from "../../lib/tauriBridge";
import { ImagesToPdfWorkspace } from "./ImagesToPdfWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof bridge>();
  return {
    ...actual,
    pickMultipleFiles: vi.fn(),
    inspectBatchImages: vi.fn(),
    suggestSafeSiblingPath: vi.fn(),
    imagesToPdf: vi.fn(),
    subscribeFileDrop: vi.fn().mockResolvedValue(() => {}),
    subscribePdfTaskProgress: vi.fn().mockResolvedValue(() => {}),
  };
});

describe("P12 ImagesToPdfWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queues images, configures paper size/margins, builds PDF, and opens in C08", async () => {
    const user = userEvent.setup();
    vi.mocked(bridge.pickMultipleFiles).mockResolvedValue(["C:\\Imgs\\photo1.png"]);
    vi.mocked(bridge.suggestSafeSiblingPath).mockResolvedValue("C:\\Imgs\\photo1_images.pdf");
    vi.mocked(bridge.inspectBatchImages).mockResolvedValue({
      items: [
        {
          path: "C:\\Imgs\\photo1.png",
          fileName: "photo1.png",
          byteLength: 42000,
          format: "png",
          rawWidth: 1200,
          rawHeight: 800,
          exifOrientation: 1,
          displayWidth: 1200,
          displayHeight: 800,
          hasAlpha: true,
          isAnimated: false,
          pageCount: 1,
          hasIccProfile: false,
          metadataFlags: {
            hasExif: false,
            hasGps: false,
            hasCameraInfo: false,
            hasDatetime: false,
            hasXmp: false,
            hasIptc: false,
            hasComments: false,
            hasIcc: false,
            duplicateSegmentCount: 0,
            tagHighlights: [],
          },
          thumbnailDataUrl: "data:image/png;base64,iVBORw0KGgo=",
          warnings: [],
          error: null,
        },
      ],
      skipped: [],
      heicCapabilities: {
        decodeAvailable: false,
        encodeAvailable: false,
        decodeNote: "",
        encodeNote: "",
      },
    });
    vi.mocked(bridge.imagesToPdf).mockResolvedValue({
      outputPath: "C:\\Imgs\\photo1_images.pdf",
      byteLength: 55000,
      pageCount: 1,
      pages: [{ pageNumber: 1, sourceFileName: "photo1.png", widthPt: 612, heightPt: 792 }],
      warnings: [],
    });

    const onNavReader = vi.fn();
    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <PdfSessionProvider onNavigateToReader={onNavReader} onNavigateToTool={() => {}}>
          <ImagesToPdfWorkspace />
        </PdfSessionProvider>
      </I18nContext.Provider>,
    );

    await user.click(screen.getByRole("button", { name: /添加图片/ }));
    await waitFor(() => expect(screen.getByText("photo1.png")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Letter" }));
    await user.click(screen.getByRole("button", { name: "合成新 PDF" }));

    await waitFor(() => {
      expect(bridge.imagesToPdf).toHaveBeenCalledWith(
        expect.objectContaining({
          imagePaths: ["C:\\Imgs\\photo1.png"],
          pageSize: "letter",
        }),
      );
      expect(screen.getByTestId("pdf-images-to-pdf-result")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "在内置预览中打开" }));
    expect(onNavReader).toHaveBeenCalledTimes(1);
  });
});
