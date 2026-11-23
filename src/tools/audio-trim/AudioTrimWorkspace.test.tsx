import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { MediaSessionProvider } from "../../lib/mediaSessionStore";
import { AudioTrimWorkspace, computeAudioFadeBounds } from "./AudioTrimWorkspace";

const mockBridge = vi.hoisted(() => ({
  getMediaToolsStatus: vi.fn(),
  pickSingleFile: vi.fn(),
  probeMediaInfo: vi.fn(),
  extractAudioWaveform: vi.fn(),
  trimAudioFile: vi.fn(),
}));

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    getMediaToolsStatus: mockBridge.getMediaToolsStatus,
    pickSingleFile: mockBridge.pickSingleFile,
    probeMediaInfo: mockBridge.probeMediaInfo,
    extractAudioWaveform: mockBridge.extractAudioWaveform,
    trimAudioFile: mockBridge.trimAudioFile,
    subscribeFileDrop: () => Promise.resolve(() => {}),
    subscribeMediaTaskProgress: () => Promise.resolve(() => {}),
    subscribeMediaSetupProgress: () => Promise.resolve(() => {}),
  };
});

function renderAudioTrim() {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: vi.fn() }}>
      <MediaSessionProvider>
        <AudioTrimWorkspace />
      </MediaSessionProvider>
    </I18nContext.Provider>,
  );
}

describe("AudioTrimWorkspace (A03)", () => {
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

  it("clamps fade bounds explicitly on short selections", () => {
    const b = computeAudioFadeBounds(1.0, 2.0, true, 0.9, true, 0.9);
    expect(b.maxFadeInSec).toBeCloseTo(0.5, 5);
    expect(b.effectiveFadeInSec).toBeCloseTo(0.5, 5);
    expect(b.effectiveFadeOutSec).toBeCloseTo(0.5, 5);
  });

  it("loads waveform, updates fade range for short clips, and submits exact trim request", async () => {
    const user = userEvent.setup();
    mockBridge.pickSingleFile.mockResolvedValue("D:\\audio\\voice.wav");
    mockBridge.probeMediaInfo.mockResolvedValue({
      path: "D:\\audio\\voice.wav",
      fileName: "voice.wav",
      byteSize: 4096,
      containerFormat: "wav",
      containerLongName: "WAV",
      durationSec: 4.0,
      overallBitrateBps: 1536000,
      streamCount: 1,
      hasVideo: false,
      hasAudio: true,
      videoStreams: [],
      audioStreams: [
        {
          index: 0,
          audioTrackIndex: 0,
          codecName: "pcm_s16le",
          codecLongName: null,
          profile: null,
          language: null,
          title: null,
          channels: 2,
          channelLayout: "stereo",
          sampleRateHz: 48000,
          sampleFmt: "s16",
          bitsPerSample: 16,
          bitrateBps: 1536000,
          durationSec: 4.0,
          isDefault: true,
        },
      ],
      subtitleStreams: [],
      formatTags: {},
      summaryText: "",
      rawJson: "{}",
    });
    mockBridge.extractAudioWaveform.mockResolvedValue({
      sourcePath: "D:\\audio\\voice.wav",
      fileName: "voice.wav",
      durationSec: 4.0,
      sampleRateHz: 48000,
      channels: 2,
      codecName: "pcm_s16le",
      bitsPerSample: 16,
      analysisSampleRateHz: 4000,
      bucketCount: 64,
      minPeaks: new Array(64).fill(-0.5),
      maxPeaks: new Array(64).fill(0.5),
      auditionUrl: "http://winkitmedia.localhost/tok1",
      auditionTranscoded: false,
    });
    mockBridge.trimAudioFile.mockResolvedValue({
      outputPath: "D:\\audio\\voice_trimmed.wav",
      byteSize: 2048,
      durationSec: 2.0,
      outputCodec: "pcm_s16le",
      sampleRateHz: 48000,
      channels: 2,
      requestedStartSec: 1.0,
      requestedEndSec: 3.0,
      appliedFadeInSec: 0.5,
      appliedFadeOutSec: 0.5,
      elapsedMs: 90,
    });

    renderAudioTrim();
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /选择音频文件/ })[0]).not.toBeDisabled(),
    );
    await user.click(screen.getAllByRole("button", { name: /选择音频文件/ })[0]!);

    await waitFor(() => expect(screen.getByTestId("a03-waveform-stage")).toBeInTheDocument());

    await user.click(screen.getByLabelText("开启淡入"));
    await user.click(screen.getByLabelText("开启淡出"));
    expect(screen.getByTestId("a03-fadein-range").textContent).toContain("0–2.00 s");

    await user.click(screen.getByRole("button", { name: /导出选区/ }));
    await waitFor(() => expect(mockBridge.trimAudioFile).toHaveBeenCalledTimes(1));
    expect(mockBridge.trimAudioFile).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePath: "D:\\audio\\voice.wav",
        fadeInEnabled: true,
        fadeOutEnabled: true,
      }),
    );
    await waitFor(() => expect(screen.getByText(/剪切完成/)).toBeInTheDocument());
  });
});
