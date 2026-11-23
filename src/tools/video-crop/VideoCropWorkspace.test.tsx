import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { MediaSessionProvider } from "../../lib/mediaSessionStore";
import { VideoCropWorkspace } from "./VideoCropWorkspace";

const mockBridge = vi.hoisted(() => ({
  getMediaToolsStatus: vi.fn(),
  probeMediaInfo: vi.fn(),
  extractOrientedPreviewFrame: vi.fn(),
  cropRotateVideo: vi.fn(),
  pickSingleFile: vi.fn(),
  pickSaveFilePath: vi.fn(),
  openLocalDirectory: vi.fn(),
}));

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    getMediaToolsStatus: mockBridge.getMediaToolsStatus,
    probeMediaInfo: mockBridge.probeMediaInfo,
    extractOrientedPreviewFrame: mockBridge.extractOrientedPreviewFrame,
    cropRotateVideo: mockBridge.cropRotateVideo,
    pickSingleFile: mockBridge.pickSingleFile,
    pickSaveFilePath: mockBridge.pickSaveFilePath,
    openLocalDirectory: mockBridge.openLocalDirectory,
    subscribeFileDrop: vi.fn(async () => () => {}),
    subscribeMediaSetupProgress: vi.fn(async () => () => {}),
    subscribeMediaTaskProgress: vi.fn(async () => () => {}),
  };
});

describe("VideoCropWorkspace (V09)", () => {
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
  });

  it("loads upright display orientation for rotated phone video, applies aspect ratio + flip, and exports", async () => {
    mockBridge.pickSingleFile.mockResolvedValue("C:\\demo\\phone_rot90.mp4");
    mockBridge.probeMediaInfo.mockResolvedValue({
      path: "C:\\demo\\phone_rot90.mp4",
      fileName: "phone_rot90.mp4",
      byteSize: 200000,
      containerFormat: "mp4",
      containerLongName: "MP4",
      durationSec: 3,
      overallBitrateBps: 500000,
      streamCount: 1,
      hasVideo: true,
      hasAudio: false,
      videoStreams: [
        {
          index: 0,
          codecName: "h264",
          codecLongName: null,
          profile: null,
          pixelFormat: "yuv420p",
          codedWidth: 640,
          codedHeight: 360,
          displayWidth: 360,
          displayHeight: 640,
          sampleAspectRatio: "1:1",
          rotationDegrees: 90,
          orientation: "portrait",
          avgFrameRate: 25,
          rFrameRate: 25,
          avgFrameRateRaw: "25/1",
          rFrameRateRaw: "25/1",
          isVariableFrameRate: false,
          bitrateBps: null,
          colorSpace: null,
          colorTransfer: null,
          colorPrimaries: null,
          durationSec: 3,
        },
      ],
      audioStreams: [],
      subtitleStreams: [],
      formatTags: {},
      summaryText: "",
      rawJson: "{}",
    });
    mockBridge.extractOrientedPreviewFrame.mockResolvedValue({
      dataUrl: "data:image/jpeg;base64,AA==",
      displayWidth: 360,
      displayHeight: 640,
      timestampSec: 0.3,
    });
    mockBridge.cropRotateVideo.mockResolvedValue({
      outputPath: "C:\\demo\\phone_rot90_cropped.mp4",
      byteSize: 150000,
      outputWidth: 360,
      outputHeight: 360,
      outputRotation: 0,
      durationSec: 3,
      elapsedMs: 180,
    });

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: vi.fn() }}>
        <MediaSessionProvider>
          <VideoCropWorkspace />
        </MediaSessionProvider>
      </I18nContext.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /选择视频文件/ }));

    await waitFor(() => {
      expect(screen.getByText(/画布 360×640/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "1:1" }));
    fireEvent.click(screen.getByRole("button", { name: /水平翻转/ }));
    expect(screen.getByText(/裁剪输出 360×360/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /导出成片（360×360）/ }));
    await waitFor(() => {
      expect(mockBridge.cropRotateVideo).toHaveBeenCalledWith(
        expect.objectContaining({
          rotateCw: 0,
          flipH: true,
          flipV: false,
          cropWidth: 360,
          cropHeight: 360,
        }),
      );
      expect(screen.getByText(/导出成功：360×360/)).toBeInTheDocument();
    });
  });
});
