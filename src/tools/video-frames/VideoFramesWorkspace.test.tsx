import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { MediaSessionProvider } from "../../lib/mediaSessionStore";
import * as bridge from "../../lib/tauriBridge";
import { VideoFramesWorkspace } from "./VideoFramesWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    getMediaToolsStatus: vi.fn(),
    getImageHeicCapabilities: vi.fn(),
    pickSingleFile: vi.fn(),
    probeMediaInfo: vi.fn(),
    registerMediaPreviewPath: vi.fn(),
    extractMediaPosterDataUrl: vi.fn(),
    extractVideoFrames: vi.fn(),
    subscribeFileDrop: vi.fn(async () => () => {}),
    subscribeMediaSetupProgress: vi.fn(async () => () => {}),
    subscribeMediaTaskProgress: vi.fn(async () => () => {}),
  };
});

describe("VideoFramesWorkspace (V04)", () => {
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
    vi.mocked(bridge.getImageHeicCapabilities).mockResolvedValue({
      decodeAvailable: false,
      encodeAvailable: false,
      decodeNote: "Missing",
      encodeNote: "Missing HEVC extension",
    });
  });

  it("extracts frames in even-count mode, displays thumbnails with timestamps, and flags unavailable HEIC encoding", async () => {
    vi.mocked(bridge.pickSingleFile).mockResolvedValue("C:\\demo\\clip.mp4");
    vi.mocked(bridge.probeMediaInfo).mockResolvedValue({
      path: "C:\\demo\\clip.mp4",
      fileName: "clip.mp4",
      byteSize: 400_000,
      containerFormat: "mp4",
      containerLongName: "MP4",
      durationSec: 4.0,
      overallBitrateBps: 800_000,
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
          codedWidth: 640,
          codedHeight: 360,
          displayWidth: 360,
          displayHeight: 640,
          sampleAspectRatio: "1:1",
          rotationDegrees: 90,
          orientation: "portrait",
          avgFrameRate: 25,
          rFrameRate: 25,
          avgFrameRateRaw: "25/1",
          rFrameRateRaw: "25/1",
          isVariableFrameRate: false,
          bitrateBps: 700_000,
          colorSpace: null,
          colorTransfer: null,
          colorPrimaries: null,
          durationSec: 4.0,
        },
      ],
      audioStreams: [],
      subtitleStreams: [],
      formatTags: {},
      summaryText: "",
      rawJson: "{}",
    });
    vi.mocked(bridge.registerMediaPreviewPath).mockResolvedValue({
      token: "tok-v04",
      url: "http://winkitmedia.localhost/tok-v04",
      mimeType: "video/mp4",
      fileName: "clip.mp4",
      byteLength: 400_000,
    });
    vi.mocked(bridge.extractMediaPosterDataUrl).mockResolvedValue("data:image/jpeg;base64,AAA=");
    vi.mocked(bridge.extractVideoFrames).mockResolvedValue({
      taskId: "v04-1",
      outputDir: "C:\\demo",
      cancelled: false,
      extractedCount: 2,
      requestedCount: 2,
      elapsedMs: 180,
      frames: [
        {
          index: 1,
          timestampSec: 0.0,
          outputPath: "C:\\demo\\clip_frame_001_00m00s000ms.png",
          fileName: "clip_frame_001_00m00s000ms.png",
          width: 360,
          height: 640,
          byteSize: 22_000,
          thumbnailDataUrl: "data:image/jpeg;base64,BBB=",
        },
        {
          index: 2,
          timestampSec: 3.98,
          outputPath: "C:\\demo\\clip_frame_002_00m03s980ms.png",
          fileName: "clip_frame_002_00m03s980ms.png",
          width: 360,
          height: 640,
          byteSize: 24_000,
          thumbnailDataUrl: "data:image/jpeg;base64,CCC=",
        },
      ],
    });

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <MediaSessionProvider>
          <VideoFramesWorkspace />
        </MediaSessionProvider>
      </I18nContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "选择视频文件…" })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "选择视频文件…" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "HEIC" })).toBeInTheDocument();
    });

    // Clicking HEIC when WIC encoder unavailable explains why and disables export
    fireEvent.click(screen.getByRole("button", { name: "HEIC" }));
    expect(screen.getByText(/Windows WIC HEIC 编码扩展/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始抽帧导出" })).toBeDisabled();

    // Switch back to PNG and extract even count
    fireEvent.click(screen.getByRole("button", { name: "PNG" }));
    fireEvent.click(screen.getByRole("button", { name: "均匀抽取数量" }));
    fireEvent.click(screen.getByRole("button", { name: "开始抽帧导出" }));

    await waitFor(() => {
      expect(screen.getByText(/抽帧结果（共 2 张/)).toBeInTheDocument();
    });
    expect(screen.getByText("00:03.980")).toBeInTheDocument();
  });
});
