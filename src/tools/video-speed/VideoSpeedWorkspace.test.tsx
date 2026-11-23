import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { MediaSessionProvider } from "../../lib/mediaSessionStore";
import { estimateSpeedDuration, VideoSpeedWorkspace } from "./VideoSpeedWorkspace";

const mockBridge = vi.hoisted(() => ({
  getMediaToolsStatus: vi.fn(),
  pickMultipleFiles: vi.fn(),
  pickSingleDirectory: vi.fn(),
  probeMediaInfo: vi.fn(),
  registerMediaPreviewPath: vi.fn(),
  changeVideoSpeedBatch: vi.fn(),
  openLocalDirectory: vi.fn(),
}));

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    getMediaToolsStatus: mockBridge.getMediaToolsStatus,
    pickMultipleFiles: mockBridge.pickMultipleFiles,
    pickSingleDirectory: mockBridge.pickSingleDirectory,
    probeMediaInfo: mockBridge.probeMediaInfo,
    registerMediaPreviewPath: mockBridge.registerMediaPreviewPath,
    changeVideoSpeedBatch: mockBridge.changeVideoSpeedBatch,
    openLocalDirectory: mockBridge.openLocalDirectory,
    subscribeFileDrop: () => Promise.resolve(() => {}),
    subscribeMediaTaskProgress: () => Promise.resolve(() => {}),
    subscribeMediaSetupProgress: () => Promise.resolve(() => {}),
  };
});

function renderSpeedWorkspace() {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: vi.fn() }}>
      <MediaSessionProvider>
        <VideoSpeedWorkspace />
      </MediaSessionProvider>
    </I18nContext.Provider>,
  );
}

describe("VideoSpeedWorkspace (V03)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBridge.getMediaToolsStatus.mockResolvedValue({
      ready: true,
      source: "managed",
      mode: "auto",
      customDir: null,
      ffmpegPath: "C:\\ffmpeg.exe",
      ffprobePath: "C:\\ffprobe.exe",
      ffmpegVersion: "ffmpeg version 9.1",
      ffprobeVersion: "ffprobe version 9.1",
      installDir: "C:\\media-tools",
      managedInstalledBytes: 1000,
      licensePath: null,
      error: null,
      spec: {
        version: "9.1",
        sourceName: "Gyan.dev",
        releaseUrl: "",
        sourceCommitUrl: "",
        downloadUrl: "",
        downloadBytes: 0,
        sha256: "",
        estimatedInstalledBytes: 0,
        licenseName: "GPL-3.0",
      },
    });
    mockBridge.registerMediaPreviewPath.mockResolvedValue({
      token: "t1",
      url: "winkitmedia://localhost/t1",
      mimeType: "video/mp4",
      fileName: "demo.mp4",
      byteLength: 1024,
    });
  });

  it("estimates speed-adjusted duration accurately", () => {
    expect(estimateSpeedDuration(10, 2)).toBeCloseTo(5, 5);
    expect(estimateSpeedDuration(10, 0.5)).toBeCloseTo(20, 5);
    expect(estimateSpeedDuration(null, 2)).toBeNull();
  });

  it("updates estimated duration when selecting presets and submits pitch-preserving speed request", async () => {
    const user = userEvent.setup();
    mockBridge.pickMultipleFiles.mockResolvedValue(["D:\\clips\\clip.mp4"]);
    mockBridge.probeMediaInfo.mockResolvedValue({
      path: "D:\\clips\\clip.mp4",
      fileName: "clip.mp4",
      byteSize: 2048,
      containerFormat: "mp4",
      containerLongName: "MP4",
      durationSec: 10.0,
      overallBitrateBps: 1000000,
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
          codedWidth: 1280,
          codedHeight: 720,
          displayWidth: 1280,
          displayHeight: 720,
          sampleAspectRatio: "1:1",
          rotationDegrees: 0,
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
          durationSec: 10.0,
        },
      ],
      audioStreams: [],
      subtitleStreams: [],
      formatTags: {},
      summaryText: "",
      rawJson: "{}",
    });
    mockBridge.changeVideoSpeedBatch.mockResolvedValue({
      taskId: "t-v03",
      outputDir: "D:\\clips",
      speedFactor: 0.5,
      cancelled: false,
      completedCount: 1,
      skippedCount: 0,
      failedCount: 0,
      elapsedMs: 120,
      items: [
        {
          sourcePath: "D:\\clips\\clip.mp4",
          fileName: "clip.mp4",
          status: "completed",
          outputPath: "D:\\clips\\clip_0p5x.mp4",
          outputBytes: 3000,
          sourceDurationSec: 10.0,
          outputDurationSec: 20.0,
          hasOutputAudio: true,
          speedFactor: 0.5,
          elapsedMs: 120,
          message: null,
        },
      ],
    });

    renderSpeedWorkspace();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /选择视频文件/ })).not.toBeDisabled(),
    );
    await user.click(screen.getByRole("button", { name: /选择视频文件/ }));

    await waitFor(() => expect(screen.getByTestId("v03-duration-estimate")).toBeInTheDocument());
    expect(screen.getByTestId("v03-duration-estimate").textContent).toContain("00:05");

    // Click 0.5x preset -> estimated duration doubles to 20s
    await user.click(screen.getByRole("button", { name: "0.5×" }));
    expect(screen.getByTestId("v03-duration-estimate").textContent).toContain("00:20");

    await user.click(screen.getByRole("button", { name: /开始变速导出/ }));
    await waitFor(() => expect(mockBridge.changeVideoSpeedBatch).toHaveBeenCalledTimes(1));
    expect(mockBridge.changeVideoSpeedBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePaths: ["D:\\clips\\clip.mp4"],
        outputDir: "D:\\clips",
        speedFactor: 0.5,
        preservePitch: true,
        muteAudio: false,
      }),
    );
    await waitFor(() => expect(screen.getByText(/变速完成/)).toBeInTheDocument());
  });
});
