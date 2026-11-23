import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { ImageConvertWorkspace } from "./ImageConvertWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    getImageHeicCapabilities: vi.fn(),
    inspectBatchImages: vi.fn(),
    previewConvertImage: vi.fn(),
    convertImagesBatch: vi.fn(),
    pickMultipleFiles: vi.fn(),
    pickMultipleDirectories: vi.fn(),
    pickSingleDirectory: vi.fn(),
    openLocalDirectory: vi.fn(),
    subscribeImageBatchProgress: vi.fn(async () => () => {}),
    subscribeArchiveProgress: vi.fn(async () => () => {}),
    subscribeDuplicateScanProgress: vi.fn(async () => () => {}),
    subscribeFileDrop: vi.fn(async () => () => {}),
  };
});

function renderWorkspace() {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
      <SessionStoreProvider>
        <ImageConvertWorkspace />
      </SessionStoreProvider>
    </I18nContext.Provider>,
  );
}

describe("ImageConvertWorkspace (I05)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tauriBridge.getImageHeicCapabilities).mockResolvedValue({
      decodeAvailable: true,
      encodeAvailable: false,
      decodeNote: "HEIF decoder ok",
      encodeNote: "HEVC encoder missing",
    });
  });

  it("loads transparent PNG, updates preview background color, and converts batch", async () => {
    const user = userEvent.setup();
    vi.mocked(tauriBridge.pickMultipleFiles).mockResolvedValue(["D:\\Pics\\icon.png"]);
    vi.mocked(tauriBridge.inspectBatchImages).mockResolvedValue({
      items: [
        {
          path: "D:\\Pics\\icon.png",
          fileName: "icon.png",
          byteLength: 4096,
          format: "png",
          rawWidth: 256,
          rawHeight: 256,
          exifOrientation: 1,
          displayWidth: 256,
          displayHeight: 256,
          hasAlpha: true,
          isAnimated: false,
          pageCount: 1,
          hasIccProfile: false,
          metadataFlags: {
            hasExif: false,
            hasGps: false,
            hasXmp: false,
            hasIptc: false,
            hasIcc: false,
            hasComments: false,
            hasCameraInfo: false,
            hasDatetime: false,
            duplicateSegmentCount: 0,
            tagHighlights: [],
          },
          thumbnailDataUrl: "data:image/png;base64,AA==",
          warnings: [],
          error: null,
        },
      ],
      skipped: [],
      heicCapabilities: {
        decodeAvailable: true,
        encodeAvailable: false,
        decodeNote: "HEIF decoder ok",
        encodeNote: "HEVC encoder missing",
      },
    });
    vi.mocked(tauriBridge.previewConvertImage).mockResolvedValue({
      previewDataUrl: "data:image/jpeg;base64,AA==",
      displayWidth: 256,
      displayHeight: 256,
      hasAlpha: true,
      flattenedAlpha: true,
    });
    vi.mocked(tauriBridge.pickSingleDirectory).mockResolvedValue("D:\\Out");
    vi.mocked(tauriBridge.convertImagesBatch).mockResolvedValue({
      taskId: "t1",
      toolId: "I05",
      outputDir: "D:\\Out",
      cancelled: false,
      succeededCount: 1,
      keptOriginalCount: 0,
      skippedCount: 0,
      failedCount: 0,
      totalOriginalBytes: 4096,
      totalOutputBytes: 2048,
      items: [
        {
          sourcePath: "D:\\Pics\\icon.png",
          fileName: "icon.png",
          outputPath: "D:\\Out\\icon.jpg",
          status: "ok",
          originalBytes: 4096,
          outputBytes: 2048,
          savedPercent: 50.0,
          outputWidth: 256,
          outputHeight: 256,
          codecNote: "JPEG Q88",
          message: null,
        },
      ],
    });

    renderWorkspace();

    const addBtns = screen.getAllByRole("button", { name: "添加图片" });
    await user.click(addBtns[0]!);
    await waitFor(() => {
      expect(screen.getAllByText("icon.png").length).toBeGreaterThan(0);
    });

    await user.click(screen.getByRole("button", { name: "纯黑" }));
    await waitFor(() => {
      expect(tauriBridge.previewConvertImage).toHaveBeenCalledWith(
        expect.objectContaining({ backgroundHex: "#000000" }),
      );
    });

    await user.click(screen.getByRole("button", { name: "选择目录…" }));
    await user.click(screen.getByRole("button", { name: /批量转换为 JPEG/ }));

    await waitFor(() => {
      expect(screen.getByText("批量处理结果")).toBeInTheDocument();
    });
    expect(tauriBridge.convertImagesBatch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ targetFormat: "jpeg", backgroundHex: "#000000" }),
    );
  });
});
