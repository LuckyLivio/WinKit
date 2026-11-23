import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { ImageRotateWorkspace } from "./ImageRotateWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    inspectBatchImages: vi.fn(),
    previewRotateImage: vi.fn(),
    rotateImagesBatch: vi.fn(),
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
        <ImageRotateWorkspace />
      </SessionStoreProvider>
    </I18nContext.Provider>,
  );
}

describe("ImageRotateWorkspace (I08)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("composes rotate and flip steps in exact click order, resets cleanly, and exports batch", async () => {
    const user = userEvent.setup();
    vi.mocked(tauriBridge.pickMultipleFiles).mockResolvedValue(["D:\\Pics\\arrow.png"]);
    vi.mocked(tauriBridge.inspectBatchImages).mockResolvedValue({
      items: [
        {
          path: "D:\\Pics\\arrow.png",
          fileName: "arrow.png",
          byteLength: 8000,
          format: "png",
          rawWidth: 400,
          rawHeight: 200,
          exifOrientation: 1,
          displayWidth: 400,
          displayHeight: 200,
          hasAlpha: false,
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
    vi.mocked(tauriBridge.previewRotateImage).mockResolvedValue({
      previewDataUrl: "data:image/png;base64,AA==",
      sourceExifOrientation: 1,
      displayWidth: 400,
      displayHeight: 200,
      outputWidth: 200,
      outputHeight: 400,
    });
    vi.mocked(tauriBridge.pickSingleDirectory).mockResolvedValue("D:\\Out");
    vi.mocked(tauriBridge.rotateImagesBatch).mockResolvedValue({
      taskId: "r1",
      toolId: "I08",
      outputDir: "D:\\Out",
      cancelled: false,
      succeededCount: 1,
      keptOriginalCount: 0,
      skippedCount: 0,
      failedCount: 0,
      totalOriginalBytes: 8000,
      totalOutputBytes: 7900,
      items: [
        {
          sourcePath: "D:\\Pics\\arrow.png",
          fileName: "arrow.png",
          outputPath: "D:\\Out\\arrow.png",
          status: "ok",
          originalBytes: 8000,
          outputBytes: 7900,
          savedPercent: 1.3,
          outputWidth: 200,
          outputHeight: 400,
          codecNote: "PNG (upright)",
          message: "2 transform step(s), exported upright",
        },
      ],
    });

    renderWorkspace();
    await user.click(screen.getAllByRole("button", { name: "添加图片" })[0]!);
    await waitFor(() => {
      expect(screen.getAllByText("arrow.png").length).toBeGreaterThan(0);
    });

    await user.click(screen.getByRole("button", { name: "右转 90°" }));
    await user.click(screen.getByRole("button", { name: "水平翻转" }));
    expect(screen.getByText("1. 右转 90°")).toBeInTheDocument();
    expect(screen.getByText("2. 水平翻转")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "选择目录…" }));
    await user.click(screen.getByRole("button", { name: /批量导出/ }));

    await waitFor(() => {
      expect(tauriBridge.rotateImagesBatch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          steps: ["rotate_right", "flip_horizontal"],
        }),
      );
    });

    await user.click(screen.getByRole("button", { name: "重置全部" }));
    expect(screen.queryByText("1. 右转 90°")).not.toBeInTheDocument();
  });
});
