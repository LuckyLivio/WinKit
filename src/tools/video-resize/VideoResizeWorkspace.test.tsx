import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { MediaSessionProvider } from "../../lib/mediaSessionStore";
import { VideoResizeWorkspace } from "./VideoResizeWorkspace";

const mockBridge = vi.hoisted(() => ({
  getMediaToolsStatus: vi.fn(),
  probeMediaInfo: vi.fn(),
  resizeVideosBatch: vi.fn(),
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
    probeMediaInfo: mockBridge.probeMediaInfo,
    resizeVideosBatch: mockBridge.resizeVideosBatch,
    pickMultipleFiles: mockBridge.pickMultipleFiles,
    pickSingleDirectory: mockBridge.pickSingleDirectory,
    registerMediaPreviewPath: mockBridge.registerMediaPreviewPath,
    openLocalDirectory: mockBridge.openLocalDirectory,
    subscribeFileDrop: vi.fn(async () => () => {}),
    subscribeMediaSetupProgress: vi.fn(async () => () => {}),
    subscribeMediaTaskProgress: vi.fn(async () => () => {}),
  };
});

describe("VideoResizeWorkspace (V08)", () => {
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
    mockBridge.registerMediaPreviewPath.mockResolvedValue({
      token: "t8",
      url: "http://winkitmedia.localhost/t8",
      mimeType: "video/mp4",
      fileName: "portrait.mp4",
      byteLength: 100000,
    });
  });

  it("predicts output dimensions before export and gates Stretch mode behind explicit aspect unlock", async () => {
    mockBridge.pickMultipleFiles.mockResolvedValue(["C:\\demo\\portrait.mp4"]);
    mockBridge.probeMediaInfo.mockResolvedValue({
      path: "C:\\demo\\portrait.mp4",
      fileName: "portrait.mp4",
      byteSize: 100000,
      containerFormat: "mp4",
      containerLongName: "MP4",
      durationSec: 4,
      overallBitrateBps: 200000,
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
          durationSec: 4,
        },
      ],
      audioStreams: [],
      subtitleStreams: [],
      formatTags: {},
      summaryText: "",
      rawJson: "{}",
    });

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: vi.fn() }}>
        <MediaSessionProvider>
          <VideoResizeWorkspace />
        </MediaSessionProvider>
      </I18nContext.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /选择视频文件/ }));

    await waitFor(() => {
      expect(screen.getByText(/预计输出 608×1080/)).toBeInTheDocument();
    });

    const stretchBtn = screen.getByRole("button", { name: /拉伸填满/ });
    expect(stretchBtn).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /已锁定画面比例/ }));
    expect(stretchBtn).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /1:1 方形/ }));
    fireEvent.click(screen.getByRole("button", { name: /留黑边到指定尺寸/ }));
    expect(screen.getByText(/预计输出 1080×1080/)).toBeInTheDocument();
  });
});
