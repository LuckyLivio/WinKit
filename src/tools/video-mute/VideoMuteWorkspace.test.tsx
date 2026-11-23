import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { MediaSessionProvider } from "../../lib/mediaSessionStore";
import * as bridge from "../../lib/tauriBridge";
import { VideoMuteWorkspace } from "./VideoMuteWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    getMediaToolsStatus: vi.fn(),
    pickMultipleFiles: vi.fn(),
    probeMediaInfo: vi.fn(),
    muteVideosBatch: vi.fn(),
    subscribeFileDrop: vi.fn(async () => () => {}),
    subscribeMediaSetupProgress: vi.fn(async () => () => {}),
    subscribeMediaTaskProgress: vi.fn(async () => () => {}),
  };
});

describe("VideoMuteWorkspace (V13)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(bridge.getMediaToolsStatus).mockResolvedValue({
      ready: true,
      source: "managed",
      mode: "auto",
      customDir: null,
      ffmpegPath: "C:\\WinKit\\ffmpeg.exe",
      ffprobePath: "C:\\WinKit\\ffprobe.exe",
      ffmpegVersion: "ffmpeg version 9.1",
      ffprobeVersion: "ffprobe version 9.1",
      installDir: "C:\\WinKit",
      managedInstalledBytes: 221_044_037,
      licensePath: "C:\\WinKit\\LICENSE",
      error: null,
      spec: {
        version: "9.1",
        sourceName: "GyanD",
        releaseUrl: "https://example.com",
        sourceCommitUrl: "https://example.com",
        downloadUrl: "https://example.com/ffmpeg.7z",
        downloadBytes: 36_671_021,
        sha256: "835b9a733445ba7a56a37a26cf7bde84e2f3ce7da2a8ec984276bb2abb1b922c",
        estimatedInstalledBytes: 221_044_037,
        licenseName: "GNU GPL v3",
      },
    });
  });

  it("distinguishes multi-audio videos from already-silent videos and runs batch mute", async () => {
    vi.mocked(bridge.pickMultipleFiles).mockResolvedValue([
      "C:\\demo\\dual.mp4",
      "C:\\demo\\silent.mp4",
    ]);
    vi.mocked(bridge.probeMediaInfo)
      .mockResolvedValueOnce({
        path: "C:\\demo\\dual.mp4",
        fileName: "dual.mp4",
        byteSize: 200_000,
        containerFormat: "mp4",
        containerLongName: "MP4",
        durationSec: 4,
        overallBitrateBps: 400_000,
        streamCount: 3,
        hasVideo: true,
        hasAudio: true,
        videoStreams: [],
        audioStreams: [
          {
            index: 1,
            audioTrackIndex: 0,
            codecName: "aac",
            codecLongName: "AAC",
            profile: null,
            language: "eng",
            title: null,
            channels: 2,
            channelLayout: "stereo",
            sampleRateHz: 48000,
            bitrateBps: 128000,
            durationSec: 4,
            isDefault: true,
          },
          {
            index: 2,
            audioTrackIndex: 1,
            codecName: "aac",
            codecLongName: "AAC",
            profile: null,
            language: "zho",
            title: null,
            channels: 2,
            channelLayout: "stereo",
            sampleRateHz: 48000,
            bitrateBps: 128000,
            durationSec: 4,
            isDefault: false,
          },
        ],
        subtitleStreams: [],
        formatTags: {},
        summaryText: "",
        rawJson: "{}",
      })
      .mockResolvedValueOnce({
        path: "C:\\demo\\silent.mp4",
        fileName: "silent.mp4",
        byteSize: 100_000,
        containerFormat: "mp4",
        containerLongName: "MP4",
        durationSec: 2,
        overallBitrateBps: 400_000,
        streamCount: 1,
        hasVideo: true,
        hasAudio: false,
        videoStreams: [],
        audioStreams: [],
        subtitleStreams: [],
        formatTags: {},
        summaryText: "",
        rawJson: "{}",
      });

    vi.mocked(bridge.muteVideosBatch).mockResolvedValue({
      taskId: "v13-1",
      outputDir: "C:\\demo",
      cancelled: false,
      mutedCount: 1,
      alreadyMutedCount: 1,
      skippedCount: 0,
      failedCount: 0,
      elapsedMs: 120,
      items: [
        {
          sourcePath: "C:\\demo\\dual.mp4",
          fileName: "dual.mp4",
          status: "muted",
          outputPath: "C:\\demo\\dual_muted.mp4",
          byteSize: 150_000,
          removedAudioTracks: 2,
          durationSec: 4,
          displayWidth: 640,
          displayHeight: 360,
          rotationDegrees: 0,
          message: null,
        },
        {
          sourcePath: "C:\\demo\\silent.mp4",
          fileName: "silent.mp4",
          status: "already_muted",
          outputPath: null,
          byteSize: null,
          removedAudioTracks: 0,
          durationSec: 2,
          displayWidth: 640,
          displayHeight: 360,
          rotationDegrees: 0,
          message: "Video already has no audio tracks.",
        },
      ],
    });

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <MediaSessionProvider>
          <VideoMuteWorkspace />
        </MediaSessionProvider>
      </I18nContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "选择视频文件…" })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "选择视频文件…" }));

    await waitFor(() => {
      expect(screen.getByText("将移除 2 条音轨")).toBeInTheDocument();
      expect(screen.getByText("原本无音轨（无需处理）")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "生成静音副本" }));
    await waitFor(() => {
      expect(screen.getByText("静音批处理完成")).toBeInTheDocument();
    });
    expect(screen.getByText("已移除 2 条音轨")).toBeInTheDocument();
  });
});
