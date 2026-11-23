import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { MediaSessionProvider } from "../../lib/mediaSessionStore";
import * as bridge from "../../lib/tauriBridge";
import { VideoGifWorkspace } from "./VideoGifWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    getMediaToolsStatus: vi.fn(),
    pickSingleFile: vi.fn(),
    probeMediaInfo: vi.fn(),
    registerMediaPreviewPath: vi.fn(),
    extractMediaPosterDataUrl: vi.fn(),
    convertVideoToGif: vi.fn(),
    subscribeFileDrop: vi.fn(async () => () => {}),
    subscribeMediaSetupProgress: vi.fn(async () => () => {}),
    subscribeMediaTaskProgress: vi.fn(async () => () => {}),
  };
});

describe("VideoGifWorkspace (V15)", () => {
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

  it("exports animated GIF with fps, width, and loop toggle and immediately renders live GIF preview and size", async () => {
    vi.mocked(bridge.pickSingleFile).mockResolvedValue("C:\\demo\\demo.mp4");
    vi.mocked(bridge.probeMediaInfo).mockResolvedValue({
      path: "C:\\demo\\demo.mp4",
      fileName: "demo.mp4",
      byteSize: 600_000,
      containerFormat: "mp4",
      containerLongName: "MP4",
      durationSec: 3.0,
      overallBitrateBps: 1_600_000,
      streamCount: 1,
      hasVideo: true,
      hasAudio: false,
      videoStreams: [
        {
          index: 0,
          codecName: "h264",
          codecLongName: "H.264",
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
          bitrateBps: 1_500_000,
          colorSpace: null,
          colorTransfer: null,
          colorPrimaries: null,
          durationSec: 3.0,
        },
      ],
      audioStreams: [],
      subtitleStreams: [],
      formatTags: {},
      summaryText: "",
      rawJson: "{}",
    });
    vi.mocked(bridge.registerMediaPreviewPath).mockResolvedValue({
      token: "tok-v15",
      url: "http://winkitmedia.localhost/tok-v15",
      mimeType: "video/mp4",
      fileName: "demo.mp4",
      byteLength: 600_000,
    });
    vi.mocked(bridge.extractMediaPosterDataUrl).mockResolvedValue("data:image/jpeg;base64,AAA=");
    vi.mocked(bridge.convertVideoToGif).mockResolvedValue({
      outputPath: "C:\\demo\\demo.gif",
      previewUrl: "http://winkitmedia.localhost/tok-gif",
      byteSize: 420_000,
      width: 640,
      height: 360,
      frameCount: 45,
      durationSec: 3.0,
      fps: 15,
      loopForever: false,
      elapsedMs: 410,
    });

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <MediaSessionProvider>
          <VideoGifWorkspace />
        </MediaSessionProvider>
      </I18nContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "选择视频文件…" })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "选择视频文件…" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "640 px" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "640 px" }));
    fireEvent.click(screen.getByRole("button", { name: "仅播放一次" }));
    fireEvent.click(screen.getByRole("button", { name: "生成 GIF 动图" }));

    await waitFor(() => {
      expect(screen.getByText(/GIF 生成完成/)).toBeInTheDocument();
    });
    expect(screen.getByText("640 × 360 px")).toBeInTheDocument();
    expect(screen.getByText(/45 帧/)).toBeInTheDocument();
    expect(bridge.convertVideoToGif).toHaveBeenCalledWith(
      expect.objectContaining({
        fps: 15,
        widthPreset: "w640",
        loopForever: false,
        allowUpscale: false,
      }),
    );
  });
});
