import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { MediaSessionProvider } from "../../lib/mediaSessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { VideoReplaceAudioWorkspace } from "./VideoReplaceAudioWorkspace";

vi.mock("../../lib/tauriBridge", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/tauriBridge")>("../../lib/tauriBridge");
  return {
    ...actual,
    getMediaToolsStatus: vi.fn(),
    pickSingleFile: vi.fn(),
    probeMediaInfo: vi.fn(),
    registerMediaPreviewPath: vi.fn(),
    extractMediaPosterDataUrl: vi.fn(),
    previewReplaceAudio: vi.fn(),
    replaceVideoAudio: vi.fn(),
  };
});

const READY_STATUS: tauriBridge.MediaToolsStatus = {
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
};

function renderWorkspace() {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: vi.fn() }}>
      <MediaSessionProvider>
        <VideoReplaceAudioWorkspace />
      </MediaSessionProvider>
    </I18nContext.Provider>,
  );
}

describe("VideoReplaceAudioWorkspace (V14)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tauriBridge.getMediaToolsStatus).mockResolvedValue(READY_STATUS);
    vi.mocked(tauriBridge.registerMediaPreviewPath).mockResolvedValue({
      token: "t1",
      url: "http://winkitmedia.localhost/t1",
      mimeType: "video/mp4",
      fileName: "clip.mp4",
      byteLength: 1000,
    });
    vi.mocked(tauriBridge.extractMediaPosterDataUrl).mockResolvedValue("data:image/jpeg;base64,AA");
  });

  it("loads target video and shorter audio, configures Mix + Play Once, auditions mix, and exports", async () => {
    const user = userEvent.setup();
    vi.mocked(tauriBridge.pickSingleFile)
      .mockResolvedValueOnce("C:\\Demo\\clip.mp4")
      .mockResolvedValueOnce("C:\\Demo\\bgm.wav");

    vi.mocked(tauriBridge.probeMediaInfo)
      .mockResolvedValueOnce({
        path: "C:\\Demo\\clip.mp4",
        fileName: "clip.mp4",
        byteSize: 2_000_000,
        containerFormat: "mov,mp4",
        containerLongName: "MP4",
        durationSec: 10.0,
        overallBitrateBps: 1_500_000,
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
            bitrateBps: 1_200_000,
            colorSpace: null,
            colorTransfer: null,
            colorPrimaries: null,
            durationSec: 10.0,
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
            durationSec: 10.0,
            isDefault: true,
          },
        ],
        subtitleStreams: [],
        formatTags: {},
        summaryText: "",
        rawJson: "{}",
      })
      .mockResolvedValueOnce({
        path: "C:\\Demo\\bgm.wav",
        fileName: "bgm.wav",
        byteSize: 500_000,
        containerFormat: "wav",
        containerLongName: "WAV",
        durationSec: 4.0,
        overallBitrateBps: 1_536_000,
        streamCount: 1,
        hasVideo: false,
        hasAudio: true,
        videoStreams: [],
        audioStreams: [
          {
            index: 0,
            audioTrackIndex: 0,
            codecName: "pcm_s16le",
            codecLongName: "PCM",
            profile: null,
            language: null,
            title: null,
            channels: 2,
            channelLayout: "stereo",
            sampleRateHz: 48000,
            bitrateBps: 1_536_000,
            durationSec: 4.0,
            isDefault: true,
          },
        ],
        subtitleStreams: [],
        formatTags: {},
        summaryText: "",
        rawJson: "{}",
      });

    vi.mocked(tauriBridge.previewReplaceAudio).mockResolvedValue({
      previewUrl: "http://winkitmedia.localhost/mixpreview",
      startSec: 0,
      previewDurationSec: 10.0,
      effectiveMode: "mix",
    });
    vi.mocked(tauriBridge.replaceVideoAudio).mockResolvedValue({
      outputPath: "C:\\Demo\\clip_audio.mp4",
      byteSize: 2_100_000,
      durationSec: 10.0,
      videoStreamCopied: true,
      effectiveMode: "mix",
      targetVideoHadAudio: true,
      hasOutputAudio: true,
      elapsedMs: 540,
    });

    renderWorkspace();
    await user.click(screen.getByRole("button", { name: /选择视频/ }));
    await waitFor(() => expect(screen.getByText("clip.mp4")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /选择音频\/视频/ }));
    await waitFor(() => expect(screen.getByText("bgm.wav")).toBeInTheDocument());

    await user.click(screen.getByRole("radio", { name: /保留原声并混音/ }));
    await user.click(screen.getByRole("radio", { name: /仅播放一次/ }));
    await user.click(screen.getByRole("button", { name: /导出前试听混音效果/ }));
    await waitFor(() => expect(tauriBridge.previewReplaceAudio).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: /导出混音视频/ }));
    await waitFor(() => expect(tauriBridge.replaceVideoAudio).toHaveBeenCalledTimes(1));
    expect(tauriBridge.replaceVideoAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          mode: "mix",
          shortAudioBehavior: "play_once",
        }),
      }),
    );
    expect(await screen.findByText(/视频流无损拷贝/)).toBeInTheDocument();
  });
});
