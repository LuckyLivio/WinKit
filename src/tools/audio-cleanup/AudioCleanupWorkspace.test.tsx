import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { MediaSessionProvider } from "../../lib/mediaSessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { AudioCleanupWorkspace } from "./AudioCleanupWorkspace";

vi.mock("../../lib/tauriBridge", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/tauriBridge")>("../../lib/tauriBridge");
  return {
    ...actual,
    getMediaToolsStatus: vi.fn(),
    pickSingleFile: vi.fn(),
    probeMediaInfo: vi.fn(),
    previewAudioCleanup: vi.fn(),
    cleanUpAudio: vi.fn(),
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
        <AudioCleanupWorkspace />
      </MediaSessionProvider>
    </I18nContext.Provider>,
  );
}

describe("AudioCleanupWorkspace (A01)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tauriBridge.getMediaToolsStatus).mockResolvedValue(READY_STATUS);
  });

  it("loads a multi-track video, disables silence removal to protect A/V sync, renders Before/After preview, and exports", async () => {
    const user = userEvent.setup();
    vi.mocked(tauriBridge.pickSingleFile).mockResolvedValue("C:\\Demo\\interview.mp4");
    vi.mocked(tauriBridge.probeMediaInfo).mockResolvedValue({
      path: "C:\\Demo\\interview.mp4",
      fileName: "interview.mp4",
      byteSize: 4_000_000,
      containerFormat: "mov,mp4",
      containerLongName: "MP4",
      durationSec: 18.5,
      overallBitrateBps: 1_500_000,
      streamCount: 3,
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
          durationSec: 18.5,
        },
      ],
      audioStreams: [
        {
          index: 1,
          audioTrackIndex: 0,
          codecName: "aac",
          codecLongName: "AAC",
          profile: "LC",
          language: "zho",
          title: "中文旁白",
          channels: 2,
          channelLayout: "stereo",
          sampleRateHz: 48000,
          bitrateBps: 128000,
          durationSec: 18.5,
          isDefault: true,
        },
        {
          index: 2,
          audioTrackIndex: 1,
          codecName: "aac",
          codecLongName: "AAC",
          profile: "LC",
          language: "eng",
          title: "English",
          channels: 2,
          channelLayout: "stereo",
          sampleRateHz: 48000,
          bitrateBps: 128000,
          durationSec: 18.5,
          isDefault: false,
        },
      ],
      subtitleStreams: [],
      formatTags: {},
      summaryText: "",
      rawJson: "{}",
    });
    vi.mocked(tauriBridge.previewAudioCleanup).mockResolvedValue({
      beforeUrl: "http://winkitmedia.localhost/before",
      afterUrl: "http://winkitmedia.localhost/after",
      startSec: 0,
      previewDurationSec: 12,
      beforeLufs: -25.4,
      beforeTruePeakDb: -4.2,
      afterLufs: -16.1,
      afterTruePeakDb: -1.6,
      isAllSilence: false,
    });
    vi.mocked(tauriBridge.cleanUpAudio).mockResolvedValue({
      outputPath: "C:\\Demo\\interview_cleaned.mp4",
      byteSize: 4_100_000,
      durationSec: 18.5,
      hasVideo: true,
      videoStreamCopied: true,
      processedTrackIndex: 0,
      totalAudioTracks: 2,
      preservedOtherTracks: 1,
      isAllSilence: false,
      silenceRemovalApplied: false,
      measuredBeforeLufs: -25.4,
      measuredBeforeTruePeakDb: -4.2,
      measuredAfterLufs: -16.0,
      measuredAfterTruePeakDb: -1.5,
      elapsedMs: 920,
    });

    renderWorkspace();
    await user.click(screen.getByRole("button", { name: "选择文件" }));

    await waitFor(() => expect(screen.getByText("interview.mp4")).toBeInTheDocument());
    expect(screen.getByText(/其余 1 条音轨将原样保留/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /裁剪超长静默片段/ })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /生成对比试听/ }));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /处理前 \(原声\)/ })).toBeInTheDocument(),
    );
    expect(screen.getByText(/-25.4 LUFS/)).toBeInTheDocument();
    expect(screen.getByText(/-16.1 LUFS/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /开始降噪并导出/ }));
    await waitFor(() => expect(tauriBridge.cleanUpAudio).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/视频流无损拷贝/)).toBeInTheDocument();
  });
});
