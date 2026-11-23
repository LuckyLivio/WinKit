import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { ImageWatermarkWorkspace } from "./ImageWatermarkWorkspace";
import * as stampMod from "./watermarkStamp";

const SAMPLE_PNG_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("I13 ImageWatermarkWorkspace", () => {
  it("previews landscape & portrait images in batch mode, configures Chinese text & diagonal tiling, and dispatches non-overwriting batch export", async () => {
    const user = userEvent.setup();

    vi.spyOn(stampMod, "rasterizeTextWatermarkStamp").mockReturnValue({
      dataUrl: SAMPLE_PNG_URL,
      width: 400,
      height: 120,
    });
    vi.spyOn(tauriBridge, "pickMultipleFiles").mockResolvedValueOnce([
      "D:\\Samples\\landscape.jpg",
      "D:\\Samples\\portrait.png",
    ]);
    vi.spyOn(tauriBridge, "inspectBatchImages").mockResolvedValueOnce({
      items: [
        {
          path: "D:\\Samples\\landscape.jpg",
          fileName: "landscape.jpg",
          format: "jpeg",
          byteLength: 20480,
          rawWidth: 1600,
          rawHeight: 900,
          displayWidth: 1600,
          displayHeight: 900,
          exifOrientation: 1,
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
          thumbnailDataUrl: SAMPLE_PNG_URL,
          warnings: [],
          error: null,
        },
        {
          path: "D:\\Samples\\portrait.png",
          fileName: "portrait.png",
          format: "png",
          byteLength: 18432,
          rawWidth: 900,
          rawHeight: 1600,
          displayWidth: 900,
          displayHeight: 1600,
          exifOrientation: 1,
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
          thumbnailDataUrl: SAMPLE_PNG_URL,
          warnings: [],
          error: null,
        },
      ],
      skipped: [],
      heicCapabilities: {
        decodeAvailable: true,
        encodeAvailable: false,
        decodeNote: "ok",
        encodeNote: "missing",
      },
    });
    vi.spyOn(tauriBridge, "pickSingleDirectory").mockResolvedValueOnce("D:\\Out\\Watermarked");
    const batchSpy = vi.spyOn(tauriBridge, "watermarkImagesBatch").mockResolvedValueOnce({
      taskId: "i13-test",
      toolId: "I13",
      outputDir: "D:\\Out\\Watermarked",
      succeededCount: 2,
      keptOriginalCount: 0,
      skippedCount: 0,
      failedCount: 0,
      cancelled: false,
      totalOriginalBytes: 38912,
      totalOutputBytes: 42000,
      items: [
        {
          sourcePath: "D:\\Samples\\landscape.jpg",
          fileName: "landscape.jpg",
          status: "ok",
          outputPath: "D:\\Out\\Watermarked\\landscape_watermarked.jpg",
          originalBytes: 20480,
          outputBytes: 21000,
          savedPercent: 0,
          outputWidth: 1600,
          outputHeight: 900,
          codecNote: null,
          message: null,
        },
        {
          sourcePath: "D:\\Samples\\portrait.png",
          fileName: "portrait.png",
          status: "ok",
          outputPath: "D:\\Out\\Watermarked\\portrait_watermarked.png",
          originalBytes: 18432,
          outputBytes: 21000,
          savedPercent: 0,
          outputWidth: 900,
          outputHeight: 1600,
          codecNote: null,
          message: null,
        },
      ],
    });

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <SessionStoreProvider>
          <ImageWatermarkWorkspace />
        </SessionStoreProvider>
      </I18nContext.Provider>,
    );

    await user.click(screen.getAllByRole("button", { name: "添加图片" })[0]!);
    await waitFor(() => {
      expect(screen.getByText("1600×900 px")).toBeInTheDocument();
    });

    // Switch preview to portrait image
    await user.click(screen.getByText("portrait.png"));
    expect(screen.getByText("900×1600 px")).toBeInTheDocument();

    // Switch to diagonal tiling & pick output folder
    await user.click(screen.getByRole("button", { name: "斜向平铺满画布" }));
    await user.click(screen.getByRole("button", { name: "选择目录…" }));
    await user.click(screen.getByRole("button", { name: "批量导出 2 张水印图" }));

    await waitFor(() => {
      expect(batchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          outputDir: "D:\\Out\\Watermarked",
          style: expect.objectContaining({ placement: "diagonal_tile" }),
        }),
      );
      expect(screen.getByText(/成功导出 2 张/)).toBeInTheDocument();
    });

    vi.restoreAllMocks();
  });
});
