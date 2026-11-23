import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { MediaSessionProvider } from "../../lib/mediaSessionStore";
import * as bridge from "../../lib/tauriBridge";
import { AudioExtractWorkspace } from "./AudioExtractWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    getMediaToolsStatus: vi.fn(),
    pickMultipleFiles: vi.fn(),
    probeMediaInfo: vi.fn(),
    extractAudioBatch: vi.fn(),
    previewAudioTrack: vi.fn(),
    subscribeFileDrop: vi.fn(async () => () => {}),
    subscribeMediaSetupProgress: vi.fn(async () => () => {}),
    subscribeMediaTaskProgress: vi.fn(async () => () => {}),
  };
});

describe("AudioExtractWorkspace (A04)", () => {
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

  it("shows stream copy vs transcode status clearly and lets user select second language track", async () => {
    vi.mocked(bridge.pickMultipleFiles).mockResolvedValue(["C:\\demo\\dual.mp4"]);
    vi.mocked(bridge.probeMediaInfo).mockResolvedValue({
      path: "C:\\demo\\dual.mp4",
      fileName: "dual.mp4",
      byteSize: 250_000,
      containerFormat: "mp4",
      containerLongName: "MP4",
      durationSec: 5,
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
          title: "English",
          channels: 2,
          channelLayout: "stereo",
          sampleRateHz: 48000,
          bitrateBps: 128000,
          durationSec: 5,
          isDefault: true,
        },
        {
          index: 2,
          audioTrackIndex: 1,
          codecName: "aac",
          codecLongName: "AAC",
          profile: null,
          language: "zho",
          title: "中文配音",
          channels: 2,
          channelLayout: "stereo",
          sampleRateHz: 48000,
          bitrateBps: 128000,
          durationSec: 5,
          isDefault: false,
        },
      ],
      subtitleStreams: [],
      formatTags: {},
      summaryText: "",
      rawJson: "{}",
    });
    vi.mocked(bridge.extractAudioBatch).mockResolvedValue({
      taskId: "a04-1",
      outputDir: "C:\\demo",
      cancelled: false,
      extractedCount: 1,
      noAudioCount: 0,
      skippedCount: 0,
      failedCount: 0,
      elapsedMs: 140,
      items: [
        {
          sourcePath: "C:\\demo\\dual.mp4",
          fileName: "dual.mp4",
          audioTrackIndex: 1,
          trackLanguage: "zho",
          status: "extracted",
          usedStreamCopy: false,
          outputPath: "C:\\demo\\dual_track2_zho.mp3",
          byteSize: 96_000,
          durationSec: 5,
          outputCodec: "mp3",
          message: null,
        },
      ],
    });

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <MediaSessionProvider>
          <AudioExtractWorkspace />
        </MediaSessionProvider>
      </I18nContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "选择视频文件…" })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "选择视频文件…" }));

    await waitFor(() => {
      expect(screen.getByText("原样无损提取（流复制）")).toBeInTheDocument();
    });

    // Pick second audio track (zho) and switch target to MP3 -> should show transcode notice
    const radios = screen.getAllByRole("radio");
    fireEvent.click(radios[1]!);
    fireEvent.click(screen.getByRole("button", { name: "MP3" }));
    expect(screen.getByText(/将执行音频转码/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "开始提取音频" }));
    await waitFor(() => {
      expect(screen.getByText("音频提取完成")).toBeInTheDocument();
    });
    expect(bridge.extractAudioBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        format: "mp3",
        items: [{ sourcePath: "C:\\demo\\dual.mp4", audioTrackIndex: 1 }],
      }),
    );
  });
});
