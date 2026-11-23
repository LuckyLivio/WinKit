import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { MediaSessionProvider } from "../../lib/mediaSessionStore";
import { AudioConvertWorkspace } from "./AudioConvertWorkspace";

const mockBridge = vi.hoisted(() => ({
  getMediaToolsStatus: vi.fn(),
  pickMultipleFiles: vi.fn(),
  probeMediaInfo: vi.fn(),
  convertAudioBatch: vi.fn(),
}));

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    getMediaToolsStatus: mockBridge.getMediaToolsStatus,
    pickMultipleFiles: mockBridge.pickMultipleFiles,
    probeMediaInfo: mockBridge.probeMediaInfo,
    convertAudioBatch: mockBridge.convertAudioBatch,
    subscribeFileDrop: () => Promise.resolve(() => {}),
    subscribeMediaTaskProgress: () => Promise.resolve(() => {}),
    subscribeMediaSetupProgress: () => Promise.resolve(() => {}),
  };
});

function renderAudioConvert() {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: vi.fn() }}>
      <MediaSessionProvider>
        <AudioConvertWorkspace />
      </MediaSessionProvider>
    </I18nContext.Provider>,
  );
}

describe("AudioConvertWorkspace (A05)", () => {
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
  });

  it("switches between lossy bitrate and lossless bit-depth controls and converts preserving source precision", async () => {
    const user = userEvent.setup();
    mockBridge.pickMultipleFiles.mockResolvedValue(["D:\\audio\\master_24bit.wav"]);
    mockBridge.probeMediaInfo.mockResolvedValue({
      path: "D:\\audio\\master_24bit.wav",
      fileName: "master_24bit.wav",
      byteSize: 8000,
      containerFormat: "wav",
      containerLongName: "WAV",
      durationSec: 2.0,
      overallBitrateBps: 2304000,
      streamCount: 1,
      hasVideo: false,
      hasAudio: true,
      videoStreams: [],
      audioStreams: [
        {
          index: 0,
          audioTrackIndex: 0,
          codecName: "pcm_s24le",
          codecLongName: null,
          profile: null,
          language: null,
          title: null,
          channels: 2,
          channelLayout: "stereo",
          sampleRateHz: 48000,
          sampleFmt: "s32",
          bitsPerSample: 24,
          bitrateBps: 2304000,
          durationSec: 2.0,
          isDefault: true,
        },
      ],
      subtitleStreams: [],
      formatTags: {},
      summaryText: "",
      rawJson: "{}",
    });
    mockBridge.convertAudioBatch.mockResolvedValue({
      taskId: "t-a05",
      outputDir: "D:\\audio",
      targetFormat: "flac",
      cancelled: false,
      convertedCount: 1,
      skippedCount: 0,
      failedCount: 0,
      elapsedMs: 110,
      items: [
        {
          sourcePath: "D:\\audio\\master_24bit.wav",
          fileName: "master_24bit.wav",
          status: "converted",
          outputPath: "D:\\audio\\master_24bit.flac",
          outputBytes: 4200,
          outputCodec: "flac",
          outputSampleRateHz: 48000,
          outputChannels: 2,
          outputBitsPerSample: 24,
          outputDurationSec: 2.0,
          elapsedMs: 110,
          message: null,
        },
      ],
    });

    renderAudioConvert();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /选择音频文件/ })).not.toBeDisabled(),
    );
    await user.click(screen.getByRole("button", { name: /选择音频文件/ }));

    // Initially MP3 -> shows bitrate controls
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "192 kbps" })).toBeInTheDocument(),
    );

    // Switch to FLAC -> hides bitrate, shows lossless bit depth selector defaulting to source
    await user.click(screen.getByRole("button", { name: "FLAC" }));
    expect(screen.queryByRole("button", { name: "192 kbps" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("无损采样位深")).toHaveValue("source");

    await user.click(screen.getByRole("button", { name: /开始转换/ }));
    await waitFor(() => expect(mockBridge.convertAudioBatch).toHaveBeenCalledTimes(1));
    expect(mockBridge.convertAudioBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePaths: ["D:\\audio\\master_24bit.wav"],
        targetFormat: "flac",
        bitrateKbps: null,
        bitDepth: "source",
        sampleRateHz: null,
      }),
    );
    await waitFor(() => expect(screen.getByText(/转换完成/)).toBeInTheDocument());
  });
});
