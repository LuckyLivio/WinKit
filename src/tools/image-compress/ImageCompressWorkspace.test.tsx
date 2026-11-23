import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { ImageCompressWorkspace } from "./ImageCompressWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    inspectBatchImages: vi.fn(),
    previewCompressImage: vi.fn(),
    compressImagesBatch: vi.fn(),
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
        <ImageCompressWorkspace />
      </SessionStoreProvider>
    </I18nContext.Provider>,
  );
}

describe("ImageCompressWorkspace (I06)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("displays live before/after comparison, switches PNG lossless/lossy mode, and reports kept_original", async () => {
    const user = userEvent.setup();
    vi.mocked(tauriBridge.pickMultipleFiles).mockResolvedValue(["D:\\Pics\\screen.png"]);
    vi.mocked(tauriBridge.inspectBatchImages).mockResolvedValue({
      items: [
        {
          path: "D:\\Pics\\screen.png",
          fileName: "screen.png",
          byteLength: 100000,
          format: "png",
          rawWidth: 800,
          rawHeight: 600,
          exifOrientation: 1,
          displayWidth: 800,
          displayHeight: 600,
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
        encodeAvailable: true,
        decodeNote: "ok",
        encodeNote: "ok",
      },
    });
    vi.mocked(tauriBridge.previewCompressImage).mockResolvedValue({
      originalPreviewDataUrl: "data:image/png;base64,AA==",
      compressedPreviewDataUrl: "data:image/png;base64,BB==",
      originalBytes: 100000,
      compressedBytes: 32000,
      savedPercent: 68.0,
      keptOriginal: false,
      width: 800,
      height: 600,
      format: "png",
      codecLabel: "PNG 有损 8 位调色板 (128 色)",
    });
    vi.mocked(tauriBridge.pickSingleDirectory).mockResolvedValue("D:\\Out");
    vi.mocked(tauriBridge.compressImagesBatch).mockResolvedValue({
      taskId: "c1",
      toolId: "I06",
      outputDir: "D:\\Out",
      cancelled: false,
      succeededCount: 0,
      keptOriginalCount: 1,
      skippedCount: 0,
      failedCount: 0,
      totalOriginalBytes: 100000,
      totalOutputBytes: 100000,
      items: [
        {
          sourcePath: "D:\\Pics\\screen.png",
          fileName: "screen.png",
          outputPath: "D:\\Out\\screen.png",
          status: "kept_original",
          originalBytes: 100000,
          outputBytes: 100000,
          savedPercent: 0,
          outputWidth: 800,
          outputHeight: 600,
          codecNote: "PNG 无损优化",
          message: "Compressed output was not smaller; preserved original bytes",
        },
      ],
    });

    renderWorkspace();
    const addBtns = screen.getAllByRole("button", { name: "添加图片" });
    await user.click(addBtns[0]!);

    await waitFor(() => {
      expect(screen.getByText("节省 68.0%")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /有损编码/ }));
    await waitFor(() => {
      expect(tauriBridge.previewCompressImage).toHaveBeenCalledWith(
        expect.objectContaining({ pngMode: "lossy_palette" }),
      );
    });

    await user.click(screen.getByRole("button", { name: "选择目录…" }));
    await user.click(screen.getByRole("button", { name: /开始批量压缩/ }));

    await waitFor(() => {
      expect(screen.getByText("未节省空间")).toBeInTheDocument();
    });
  });
});
