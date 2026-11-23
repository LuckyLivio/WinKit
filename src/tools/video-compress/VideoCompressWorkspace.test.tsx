import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { MediaSessionProvider } from "../../lib/mediaSessionStore";
import { VideoCompressWorkspace } from "./VideoCompressWorkspace";

const mockBridge = vi.hoisted(() => ({
  getMediaToolsStatus: vi.fn(),
  probeVideoEncoders: vi.fn(),
  probeMediaInfo: vi.fn(),
  compressVideosBatch: vi.fn(),
  pickMultipleFiles: vi.fn(),
  pickSingleDirectory: vi.fn(),
  registerMediaPreviewPath: vi.fn(),
  openLocalDirectory: vi.fn(),
}));

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    getMediaToolsStatus: mockBridge.getMediaToolsStatus,
    probeVideoEncoders: mockBridge.probeVideoEncoders,
    probeMediaInfo: mockBridge.probeMediaInfo,
    compressVideosBatch: mockBridge.compressVideosBatch,
    pickMultipleFiles: mockBridge.pickMultipleFiles,
    pickSingleDirectory: mockBridge.pickSingleDirectory,
    registerMediaPreviewPath: mockBridge.registerMediaPreviewPath,
    openLocalDirectory: mockBridge.openLocalDirectory,
    subscribeFileDrop: vi.fn(async () => () => {}),
    subscribeMediaSetupProgress: vi.fn(async () => () => {}),
    subscribeMediaTaskProgress: vi.fn(async () => () => {}),
  };
});

describe("VideoCompressWorkspace (V06)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBridge.getMediaToolsStatus.mockResolvedValue({
      ready: true,
      source: "managed",
      mode: "auto",
      customDir: null,
      ffmpegPath: "C:\\Tools\\ffmpeg.exe",
      ffprobePath: "C:\\Tools\\ffprobe.exe",
      ffmpegVersion: "ffmpeg version 9.1",
      ffprobeVersion: "ffprobe version 9.1",
      installDir: "C:\\Tools",
      managedInstalledBytes: 221044037,
      licensePath: null,
      error: null,
      spec: {
        version: "9.1",
        sourceName: "GyanD",
        releaseUrl: "https://example.com",
        sourceCommitUrl: "https://example.com",
        downloadUrl: "https://example.com",
        downloadBytes: 36671021,
        sha256: "abc",
        estimatedInstalledBytes: 221044037,
        licenseName: "GNU GPL v3",
      },
    });
    mockBridge.probeVideoEncoders.mockResolvedValue({
      ffmpegPath: "C:\\Tools\\ffmpeg.exe",
      hasHardwareH264: true,
      hasHardwareHevc: true,
      h264Encoders: [
        { id: "libx264", codec: "h264", isHardware: false, label: "Software (libx264 · CPU)" },
        { id: "h264_nvenc", codec: "h264", isHardware: true, label: "NVIDIA NVENC (h264_nvenc)" },
      ],
      hevcEncoders: [
        { id: "libx265", codec: "hevc", isHardware: false, label: "Software (libx265 · CPU)" },
        { id: "hevc_nvenc", codec: "hevc", isHardware: true, label: "NVIDIA NVENC (hevc_nvenc)" },
      ],
    });
    mockBridge.registerMediaPreviewPath.mockResolvedValue({
      token: "tok2",
      url: "http://winkitmedia.localhost/tok2",
      mimeType: "video/mp4",
      fileName: "clip.mp4",
      byteLength: 5_000_000,
    });
  });

  it("displays verified hardware encoders, runs compression, and shows savings & encoder badge", async () => {
    mockBridge.pickMultipleFiles.mockResolvedValue(["C:\\demo\\clip.mp4"]);
    mockBridge.probeMediaInfo.mockResolvedValue({
      path: "C:\\demo\\clip.mp4",
      fileName: "clip.mp4",
      byteSize: 5_000_000,
      containerFormat: "mp4",
      containerLongName: "MP4",
      durationSec: 10,
      overallBitrateBps: 4_000_000,
      streamCount: 2,
      hasVideo: true,
      hasAudio: true,
      videoStreams: [
        {
          index: 0,
          codecName: "h264",
          codecLongName: null,
          profile: null,
          pixelFormat: "yuv420p",
          codedWidth: 1920,
          codedHeight: 1080,
          displayWidth: 1920,
          displayHeight: 1080,
          sampleAspectRatio: "1:1",
          rotationDegrees: null,
          orientation: "landscape",
          avgFrameRate: 30,
          rFrameRate: 30,
          avgFrameRateRaw: "30/1",
          rFrameRateRaw: "30/1",
          isVariableFrameRate: false,
          bitrateBps: null,
          colorSpace: null,
          colorTransfer: null,
          colorPrimaries: null,
          durationSec: 10,
        },
      ],
      audioStreams: [],
      subtitleStreams: [],
      formatTags: {},
      summaryText: "",
      rawJson: "{}",
    });
    mockBridge.compressVideosBatch.mockResolvedValue({
      taskId: "c1",
      outputDir: "C:\\demo",
      cancelled: false,
      compressedCount: 1,
      keptOriginalCount: 0,
      skippedCount: 0,
      failedCount: 0,
      totalOriginalBytes: 5_000_000,
      totalOutputBytes: 2_000_000,
      totalSavedBytes: 3_000_000,
      totalSavedPercent: 60.0,
      elapsedMs: 420,
      items: [
        {
          sourcePath: "C:\\demo\\clip.mp4",
          fileName: "clip.mp4",
          status: "compressed",
          outputPath: "C:\\demo\\clip_compressed.mp4",
          originalBytes: 5_000_000,
          outputBytes: 2_000_000,
          attemptedCompressedBytes: 2_000_000,
          savedBytes: 3_000_000,
          savedPercent: 60.0,
          keptOriginal: false,
          keptOriginalReason: null,
          actualEncoderUsed: "h264_nvenc",
          usedHardwareEncoder: true,
          outputWidth: 1280,
          outputHeight: 720,
          outputCodec: "h264",
          elapsedMs: 410,
          message: null,
        },
      ],
    });

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: vi.fn() }}>
        <MediaSessionProvider>
          <VideoCompressWorkspace />
        </MediaSessionProvider>
      </I18nContext.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /选择视频文件/ }));

    await waitFor(() => {
      expect(screen.getAllByText(/h264_nvenc/).length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByRole("button", { name: /开始压缩/ }));

    await waitFor(() => {
      expect(screen.getByText(/已压缩 -60\.0%/)).toBeInTheDocument();
    });
  });
});
