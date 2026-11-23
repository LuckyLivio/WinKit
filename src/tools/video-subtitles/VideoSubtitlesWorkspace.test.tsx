import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { MediaSessionProvider } from "../../lib/mediaSessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { VideoSubtitlesWorkspace } from "./VideoSubtitlesWorkspace";

vi.mock("../../lib/tauriBridge", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/tauriBridge")>("../../lib/tauriBridge");
  return {
    ...actual,
    getMediaToolsStatus: vi.fn(),
    pickSingleFile: vi.fn(),
    probeMediaInfo: vi.fn(),
    extractMediaPosterDataUrl: vi.fn(),
    parseSubtitleFile: vi.fn(),
    previewBurnedSubtitleFrame: vi.fn(),
    burnInSubtitles: vi.fn(),
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
        <VideoSubtitlesWorkspace />
      </MediaSessionProvider>
    </I18nContext.Provider>,
  );
}

describe("VideoSubtitlesWorkspace (V02)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tauriBridge.getMediaToolsStatus).mockResolvedValue(READY_STATUS);
    vi.mocked(tauriBridge.extractMediaPosterDataUrl).mockResolvedValue("data:image/jpeg;base64,AA");
  });

  it("loads video and SRT cues, previews clicked cue frame, toggles Black Box style, and exports burned video", async () => {
    const user = userEvent.setup();
    vi.mocked(tauriBridge.pickSingleFile)
      .mockResolvedValueOnce("C:\\Demo\\demo.mp4")
      .mockResolvedValueOnce("C:\\Demo\\captions.srt");

    vi.mocked(tauriBridge.probeMediaInfo).mockResolvedValue({
      path: "C:\\Demo\\demo.mp4",
      fileName: "demo.mp4",
      byteSize: 2_500_000,
      containerFormat: "mov,mp4",
      containerLongName: "MP4",
      durationSec: 10.0,
      overallBitrateBps: 2_000_000,
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
          bitrateBps: 1_800_000,
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
    });

    vi.mocked(tauriBridge.parseSubtitleFile).mockResolvedValue({
      path: "C:\\Demo\\captions.srt",
      fileName: "captions.srt",
      format: "srt",
      cueCount: 2,
      totalDurationSec: 8.0,
      cues: [
        { index: 1, startSec: 1.0, endSec: 3.0, text: "第一句中文字幕", sourceLine: 2 },
        { index: 2, startSec: 4.0, endSec: 8.0, text: "Second English & 中文", sourceLine: 6 },
      ],
      warnings: [],
    });

    vi.mocked(tauriBridge.previewBurnedSubtitleFrame).mockResolvedValue({
      dataUrl: "data:image/jpeg;base64,BB",
      timestampSec: 6.0,
      activeCueIndices: [2],
      displayWidth: 1280,
      displayHeight: 720,
    });

    vi.mocked(tauriBridge.burnInSubtitles).mockResolvedValue({
      outputPath: "C:\\Demo\\demo_subtitled.mp4",
      byteSize: 2_800_000,
      outputWidth: 1280,
      outputHeight: 720,
      outputRotation: 0,
      durationSec: 10.0,
      burnedCueCount: 2,
      hasAudio: true,
      audioCopied: true,
      subtitleStreamsInOutput: 0,
      elapsedMs: 1120,
    });

    renderWorkspace();
    await user.click(screen.getAllByRole("button", { name: /选择视频/ })[0]!);
    await waitFor(() => expect(screen.getByText("demo.mp4")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /导入字幕/ }));
    await waitFor(() => expect(screen.getByText(/第一句中文字幕/)).toBeInTheDocument());

    // Click second cue -> triggers burned preview at midpoint 6.0s
    await user.click(screen.getByRole("option", { name: /Second English/ }));
    await waitFor(() =>
      expect(tauriBridge.previewBurnedSubtitleFrame).toHaveBeenCalledWith(
        expect.objectContaining({ timestampSec: 6 }),
      ),
    );

    // Switch style to Black Box and export
    await user.click(screen.getByRole("radio", { name: /半透明黑底框/ }));
    await user.click(screen.getByRole("button", { name: /烧录硬字幕并导出/ }));

    await waitFor(() => expect(tauriBridge.burnInSubtitles).toHaveBeenCalledTimes(1));
    expect(tauriBridge.burnInSubtitles).toHaveBeenCalledWith(
      expect.objectContaining({
        style: expect.objectContaining({ boxStyle: "black_box" }),
      }),
    );
    expect(await screen.findByText(/共 2 条硬字幕/)).toBeInTheDocument();
  });
});
