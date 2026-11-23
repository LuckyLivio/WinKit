import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { MediaSessionProvider } from "../../lib/mediaSessionStore";
import { VideoMergeWorkspace } from "./VideoMergeWorkspace";

const mockBridge = vi.hoisted(() => ({
  getMediaToolsStatus: vi.fn(),
  pickMultipleFiles: vi.fn(),
  pickSaveFilePath: vi.fn(),
  probeMediaInfo: vi.fn(),
  extractOrientedPreviewFrame: vi.fn(),
  mergeVideos: vi.fn(),
  openLocalDirectory: vi.fn(),
}));

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    getMediaToolsStatus: mockBridge.getMediaToolsStatus,
    pickMultipleFiles: mockBridge.pickMultipleFiles,
    pickSaveFilePath: mockBridge.pickSaveFilePath,
    probeMediaInfo: mockBridge.probeMediaInfo,
    extractOrientedPreviewFrame: mockBridge.extractOrientedPreviewFrame,
    mergeVideos: mockBridge.mergeVideos,
    openLocalDirectory: mockBridge.openLocalDirectory,
    subscribeFileDrop: () => Promise.resolve(() => {}),
    subscribeMediaTaskProgress: () => Promise.resolve(() => {}),
    subscribeMediaSetupProgress: () => Promise.resolve(() => {}),
  };
});

function makeProbe(path: string, name: string, durationSec: number, hasAudio: boolean) {
  return {
    path,
    fileName: name,
    byteSize: 1024,
    containerFormat: "mp4",
    containerLongName: "MP4",
    durationSec,
    overallBitrateBps: 500000,
    streamCount: hasAudio ? 2 : 1,
    hasVideo: true,
    hasAudio,
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
        durationSec,
      },
    ],
    audioStreams: [],
    subtitleStreams: [],
    formatTags: {},
    summaryText: "",
    rawJson: "{}",
  };
}

function renderMergeWorkspace() {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: vi.fn() }}>
      <MediaSessionProvider>
        <VideoMergeWorkspace />
      </MediaSessionProvider>
    </I18nContext.Provider>,
  );
}

describe("VideoMergeWorkspace (V12)", () => {
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
    mockBridge.extractOrientedPreviewFrame.mockResolvedValue({
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      displayWidth: 1280,
      displayHeight: 720,
      timestampSec: 0.2,
    });
  });

  it("reorders clips, notices mixed audio/silent segments, and invokes mergeVideos in reordered sequence", async () => {
    const user = userEvent.setup();
    mockBridge.pickMultipleFiles.mockResolvedValue([
      "D:\\clips\\a.mp4",
      "D:\\clips\\b_silent.mp4",
      "D:\\clips\\c.mp4",
    ]);
    mockBridge.probeMediaInfo
      .mockResolvedValueOnce(makeProbe("D:\\clips\\a.mp4", "a.mp4", 2.0, true))
      .mockResolvedValueOnce(makeProbe("D:\\clips\\b_silent.mp4", "b_silent.mp4", 3.0, false))
      .mockResolvedValueOnce(makeProbe("D:\\clips\\c.mp4", "c.mp4", 4.0, true));
    mockBridge.mergeVideos.mockResolvedValue({
      outputPath: "D:\\clips\\a_merged.mp4",
      byteSize: 8000,
      clipCount: 3,
      outputWidth: 1280,
      outputHeight: 720,
      outputDurationSec: 9.0,
      hasAudio: true,
      elapsedMs: 300,
    });

    renderMergeWorkspace();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /选择视频片段/ })).not.toBeDisabled(),
    );
    await user.click(screen.getByRole("button", { name: /选择视频片段/ }));

    await waitFor(() => expect(screen.getByText(/静音段将自动补齐/)).toBeInTheDocument());
    expect(screen.getByText(/已选 3 段 · 预计总时长 00:09/)).toBeInTheDocument();

    // Move c.mp4 up to index 1, then to index 0 -> order becomes [c, a, b_silent]
    await user.click(screen.getByRole("button", { name: "上移 c.mp4" }));
    await user.click(screen.getByRole("button", { name: "上移 c.mp4" }));

    await user.click(screen.getByRole("button", { name: /开始合并/ }));
    await waitFor(() => expect(mockBridge.mergeVideos).toHaveBeenCalledTimes(1));
    expect(mockBridge.mergeVideos).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePaths: ["D:\\clips\\c.mp4", "D:\\clips\\a.mp4", "D:\\clips\\b_silent.mp4"],
        resolutionPreset: "match_first",
        fitMode: "pad",
      }),
    );
    await waitFor(() => expect(screen.getByText(/合并完成/)).toBeInTheDocument());
  });
});
