import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { MediaSessionProvider } from "../../lib/mediaSessionStore";
import * as bridge from "../../lib/tauriBridge";
import { VideoTrimWorkspace } from "./VideoTrimWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    getMediaToolsStatus: vi.fn(),
    pickSingleFile: vi.fn(),
    probeMediaInfo: vi.fn(),
    registerMediaPreviewPath: vi.fn(),
    extractMediaPosterDataUrl: vi.fn(),
    analyzeTrimKeyframes: vi.fn(),
    trimVideoFile: vi.fn(),
    subscribeFileDrop: vi.fn(async () => () => {}),
    subscribeMediaSetupProgress: vi.fn(async () => () => {}),
    subscribeMediaTaskProgress: vi.fn(async () => () => {}),
  };
});

describe("VideoTrimWorkspace (V11)", () => {
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
        releaseUrl: "https://github.com/GyanD/codexffmpeg/releases/tag/9.1",
        sourceCommitUrl: "https://github.com/FFmpeg/FFmpeg/commit/74e4393595",
        downloadUrl: "https://example.com/ffmpeg.7z",
        downloadBytes: 36_671_021,
        sha256: "835b9a733445ba7a56a37a26cf7bde84e2f3ce7da2a8ec984276bb2abb1b922c",
        estimatedInstalledBytes: 221_044_037,
        licenseName: "GNU GPL v3",
      },
    });
  });

  it("shows stream-copy keyframe shift warning before export and switches to accurate transcode", async () => {
    vi.mocked(bridge.pickSingleFile).mockResolvedValue("C:\\demo\\sample.mp4");
    vi.mocked(bridge.probeMediaInfo).mockResolvedValue({
      path: "C:\\demo\\sample.mp4",
      fileName: "sample.mp4",
      byteSize: 500_000,
      containerFormat: "mov,mp4",
      containerLongName: "MP4",
      durationSec: 6.0,
      overallBitrateBps: 700_000,
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
          codedWidth: 640,
          codedHeight: 360,
          displayWidth: 640,
          displayHeight: 360,
          sampleAspectRatio: "1:1",
          rotationDegrees: 0,
          orientation: "landscape",
          avgFrameRate: 25,
          rFrameRate: 25,
          avgFrameRateRaw: "25/1",
          rFrameRateRaw: "25/1",
          isVariableFrameRate: false,
          bitrateBps: 500_000,
          colorSpace: null,
          colorTransfer: null,
          colorPrimaries: null,
          durationSec: 6.0,
        },
      ],
      audioStreams: [],
      subtitleStreams: [],
      formatTags: {},
      summaryText: "",
      rawJson: "{}",
    });
    vi.mocked(bridge.registerMediaPreviewPath).mockResolvedValue({
      token: "tok-1",
      url: "http://winkitmedia.localhost/tok-1",
      mimeType: "video/mp4",
      fileName: "sample.mp4",
      byteSize: 500_000,
    } as unknown as bridge.MediaPreviewRegistration);
    vi.mocked(bridge.extractMediaPosterDataUrl).mockResolvedValue("data:image/jpeg;base64,AAA=");
    vi.mocked(bridge.analyzeTrimKeyframes).mockResolvedValue({
      requestedStartSec: 1.5,
      requestedEndSec: 4.0,
      actualStreamCopyStartSec: 0.0,
      startDeltaSec: 1.5,
      estimatedStreamCopyDurationSec: 4.0,
      hasKeyframeShift: true,
      nearestNextKeyframeSec: 2.0,
      keyframeCountSampled: 3,
    });
    vi.mocked(bridge.trimVideoFile).mockResolvedValue({
      outputPath: "C:\\demo\\sample_trim.mp4",
      byteSize: 210_000,
      durationSec: 2.5,
      displayWidth: 640,
      displayHeight: 360,
      rotationDegrees: 0,
      mode: "accurate",
      requestedStartSec: 1.5,
      requestedEndSec: 4.0,
      elapsedMs: 320,
    });

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <MediaSessionProvider>
          <VideoTrimWorkspace />
        </MediaSessionProvider>
      </I18nContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "选择视频文件…" })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "选择视频文件…" }));

    await waitFor(() => {
      expect(screen.getByText(/关键帧偏移提示/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "精确剪切（转码）" }));
    fireEvent.click(screen.getByRole("button", { name: "导出剪切片段" }));

    await waitFor(() => {
      expect(screen.getByText("剪切导出完成")).toBeInTheDocument();
    });
    expect(bridge.trimVideoFile).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "accurate", sourcePath: "C:\\demo\\sample.mp4" }),
    );
  });
});
