import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { MediaSessionProvider } from "../../lib/mediaSessionStore";
import { PdfSessionProvider } from "../../lib/pdfSessionStore";
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

  it("supports Video Watermark mode on a 90°-rotated portrait video while reusing shared watermark style", async () => {
    const user = userEvent.setup();
    vi.spyOn(stampMod, "rasterizeTextWatermarkStamp").mockReturnValue({
      dataUrl: SAMPLE_PNG_URL,
      width: 400,
      height: 120,
    });
    vi.spyOn(tauriBridge, "getMediaToolsStatus").mockResolvedValue({
      ready: true,
      source: "managed",
      mode: "auto",
      customDir: null,
      ffmpegPath: "C:\\Tools\\ffmpeg.exe",
      ffprobePath: "C:\\Tools\\ffprobe.exe",
      ffmpegVersion: "ffmpeg version 9.1",
      ffprobeVersion: "ffprobe version 9.1",
      installDir: "C:\\Tools",
      managedInstalledBytes: 42_000_000,
      licensePath: null,
      error: null,
      spec: {
        version: "9.1",
        sourceName: "BtbN",
        releaseUrl: "https://example.com",
        sourceCommitUrl: "https://example.com",
        downloadUrl: "https://example.com/ffmpeg.zip",
        downloadBytes: 42_000_000,
        sha256: "abc",
        estimatedInstalledBytes: 90_000_000,
        licenseName: "GPL-3.0",
      },
    });
    vi.spyOn(tauriBridge, "pickSingleFile").mockResolvedValueOnce("D:\\Samples\\portrait_rot.mp4");
    vi.spyOn(tauriBridge, "probeMediaInfo").mockResolvedValueOnce({
      path: "D:\\Samples\\portrait_rot.mp4",
      fileName: "portrait_rot.mp4",
      byteSize: 1_500_000,
      containerFormat: "mov,mp4",
      containerLongName: "MP4",
      durationSec: 6.0,
      overallBitrateBps: 2_000_000,
      streamCount: 2,
      hasVideo: true,
      hasAudio: true,
      videoStreams: [
        {
          index: 0,
          codecName: "h264",
          codecLongName: "H.264",
          profile: "High",
          pixelFormat: "yuv420p",
          codedWidth: 1280,
          codedHeight: 720,
          displayWidth: 720,
          displayHeight: 1280,
          sampleAspectRatio: "1:1",
          rotationDegrees: 90,
          orientation: "portrait",
          avgFrameRate: 30,
          rFrameRate: 30,
          avgFrameRateRaw: "30/1",
          rFrameRateRaw: "30/1",
          isVariableFrameRate: false,
          bitrateBps: 1_800_000,
          colorSpace: null,
          colorTransfer: null,
          colorPrimaries: null,
          durationSec: 6.0,
        },
      ],
      audioStreams: [
        {
          index: 1,
          audioTrackIndex: 0,
          codecName: "aac",
          codecLongName: "AAC",
          profile: "LC",
          language: null,
          title: null,
          channels: 2,
          channelLayout: "stereo",
          sampleRateHz: 48000,
          bitrateBps: 128000,
          durationSec: 6.0,
          isDefault: true,
        },
      ],
      subtitleStreams: [],
      formatTags: {},
      summaryText: "",
      rawJson: "{}",
    });
    vi.spyOn(tauriBridge, "extractMediaPosterDataUrl").mockResolvedValueOnce(SAMPLE_PNG_URL);
    const wmVideoSpy = vi.spyOn(tauriBridge, "watermarkVideo").mockResolvedValueOnce({
      outputPath: "D:\\Samples\\portrait_rot_watermarked.mp4",
      byteSize: 1_650_000,
      outputWidth: 720,
      outputHeight: 1280,
      outputRotation: 0,
      durationSec: 6.0,
      hasAudio: true,
      audioCopied: true,
      elapsedMs: 800,
    });

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <SessionStoreProvider>
          <MediaSessionProvider>
            <ImageWatermarkWorkspace />
          </MediaSessionProvider>
        </SessionStoreProvider>
      </I18nContext.Provider>,
    );

    await user.click(screen.getByRole("button", { name: "视频水印" }));
    await user.click(screen.getAllByRole("button", { name: "选择视频…" })[0]!);
    await waitFor(() => expect(screen.getByText("720×1280 px")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "导出水印视频" }));
    await waitFor(() => expect(wmVideoSpy).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/原音频无损保留/)).toBeInTheDocument();

    vi.restoreAllMocks();
  });

  it("supports PDF Watermark mode with page scope, rotation, and preserves selectable text notice", async () => {
    const user = userEvent.setup();
    vi.spyOn(stampMod, "rasterizeTextWatermarkStamp").mockReturnValue({
      dataUrl: SAMPLE_PNG_URL,
      width: 400,
      height: 120,
    });
    vi.spyOn(tauriBridge, "pickSingleFile").mockResolvedValueOnce("D:\\Docs\\brief.pdf");
    vi.spyOn(tauriBridge, "inspectPdfDocument").mockResolvedValueOnce({
      path: "D:\\Docs\\brief.pdf",
      fileName: "brief.pdf",
      byteLength: 32000,
      pageCount: 3,
      pages: [
        { pageNumber: 1, widthPt: 595, heightPt: 842, rotation: 0, isOversized: false },
        { pageNumber: 2, widthPt: 842, heightPt: 595, rotation: 90, isOversized: false },
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
    vi.spyOn(tauriBridge, "suggestSafeSiblingPath").mockResolvedValueOnce(
      "D:\\Docs\\brief_watermarked.pdf",
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
    const pdfWmSpy = vi.spyOn(tauriBridge, "watermarkPdf").mockResolvedValueOnce({
      outputPath: "D:\\Docs\\brief_watermarked.pdf",
      byteLength: 36000,
      totalPages: 3,
      watermarkedPageCount: 2,
      signatureInvalidated: false,
      warnings: [],
    });

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <SessionStoreProvider>
          <PdfSessionProvider onNavigateToReader={() => {}} onNavigateToTool={() => {}}>
            <ImageWatermarkWorkspace />
          </PdfSessionProvider>
        </SessionStoreProvider>
      </I18nContext.Provider>,
    );

    await user.click(screen.getByRole("button", { name: "PDF 水印" }));
    await user.click(screen.getAllByRole("button", { name: "选择 PDF…" })[0]!);
    await waitFor(() => {
      expect(screen.getByText("1 / 3")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "奇数页" }));
    await user.click(screen.getByRole("button", { name: "导出水印 PDF" }));

    await waitFor(() => {
      expect(pdfWmSpy).toHaveBeenCalledTimes(1);
    });
    expect(pdfWmSpy.mock.calls[0]?.[0].scope).toBe("odd");
    expect(screen.getByText(/PDF 水印导出完成：已叠加 2\/3 页/)).toBeInTheDocument();

    vi.restoreAllMocks();
  });
});
