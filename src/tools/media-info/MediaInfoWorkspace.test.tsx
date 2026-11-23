import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { MediaSessionProvider } from "../../lib/mediaSessionStore";
import * as bridge from "../../lib/tauriBridge";
import { MediaInfoWorkspace } from "./MediaInfoWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    getMediaToolsStatus: vi.fn(),
    pickMultipleFiles: vi.fn(),
    probeMediaInfo: vi.fn(),
    writeSystemClipboardText: vi.fn(),
    subscribeFileDrop: vi.fn(async () => () => {}),
    subscribeMediaSetupProgress: vi.fn(async () => () => {}),
    subscribeMediaTaskProgress: vi.fn(async () => () => {}),
  };
});

function renderV10() {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
      <MediaSessionProvider>
        <MediaInfoWorkspace />
      </MediaSessionProvider>
    </I18nContext.Provider>,
  );
}

describe("MediaInfoWorkspace (V10)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows clear media setup entry when FFmpeg is missing", async () => {
    vi.mocked(bridge.getMediaToolsStatus).mockResolvedValue({
      ready: false,
      source: "missing",
      mode: "auto",
      customDir: null,
      ffmpegPath: null,
      ffprobePath: null,
      ffmpegVersion: null,
      ffprobeVersion: null,
      installDir:
        "C:\\Users\\Test\\AppData\\Local\\com.luckylivio.winkit\\media-tools\\ffmpeg-9.1-essentials",
      managedInstalledBytes: null,
      licensePath: null,
      error: null,
      spec: {
        version: "9.1-essentials_build-www.gyan.dev",
        sourceName: "GyanD/codexffmpeg (Release 9.1 · Windows x64 Static)",
        releaseUrl: "https://github.com/GyanD/codexffmpeg/releases/tag/9.1",
        sourceCommitUrl: "https://github.com/FFmpeg/FFmpeg/commit/74e4393595",
        downloadUrl:
          "https://github.com/GyanD/codexffmpeg/releases/download/9.1/ffmpeg-9.1-essentials_build.7z",
        downloadBytes: 36_671_021,
        sha256: "835b9a733445ba7a56a37a26cf7bde84e2f3ce7da2a8ec984276bb2abb1b922c",
        estimatedInstalledBytes: 221_044_037,
        licenseName: "GNU GPL v3",
      },
    });

    renderV10();
    await waitFor(() => {
      expect(screen.getByText("配置媒体组件（FFmpeg / ffprobe）")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "一键下载配置媒体组件" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择本地 FFmpeg 目录…" })).toBeInTheDocument();
  });

  it("displays VFR, rotation, multi-audio tracks, and honest unknown fields", async () => {
    vi.mocked(bridge.getMediaToolsStatus).mockResolvedValue({
      ready: true,
      source: "system_path",
      mode: "auto",
      customDir: null,
      ffmpegPath: "C:\\ffmpeg\\ffmpeg.exe",
      ffprobePath: "C:\\ffmpeg\\ffprobe.exe",
      ffmpegVersion: "ffmpeg version 9.1-essentials",
      ffprobeVersion: "ffprobe version 9.1-essentials",
      installDir: "C:\\Users\\Test\\media-tools\\ffmpeg-9.1-essentials",
      managedInstalledBytes: null,
      licensePath: null,
      error: null,
      spec: {
        version: "9.1-essentials_build-www.gyan.dev",
        sourceName: "GyanD/codexffmpeg",
        releaseUrl: "https://github.com/GyanD/codexffmpeg/releases/tag/9.1",
        sourceCommitUrl: "https://github.com/FFmpeg/FFmpeg/commit/74e4393595",
        downloadUrl:
          "https://github.com/GyanD/codexffmpeg/releases/download/9.1/ffmpeg-9.1-essentials_build.7z",
        downloadBytes: 36_671_021,
        sha256: "835b9a733445ba7a56a37a26cf7bde84e2f3ce7da2a8ec984276bb2abb1b922c",
        estimatedInstalledBytes: 221_044_037,
        licenseName: "GNU GPL v3",
      },
    });
    vi.mocked(bridge.pickMultipleFiles).mockResolvedValue(["C:\\demo\\vfr_portrait.mkv"]);
    vi.mocked(bridge.probeMediaInfo).mockResolvedValue({
      path: "C:\\demo\\vfr_portrait.mkv",
      fileName: "vfr_portrait.mkv",
      byteSize: 204800,
      containerFormat: "matroska,webm",
      containerLongName: "Matroska / WebM",
      durationSec: null,
      overallBitrateBps: null,
      streamCount: 3,
      hasVideo: true,
      hasAudio: true,
      videoStreams: [
        {
          index: 0,
          codecName: "h264",
          codecLongName: "H.264 / AVC",
          profile: "High",
          pixelFormat: "yuv420p",
          codedWidth: 1920,
          codedHeight: 1080,
          displayWidth: 1080,
          displayHeight: 1920,
          sampleAspectRatio: "1:1",
          rotationDegrees: 90,
          orientation: "portrait",
          avgFrameRate: null,
          rFrameRate: 30,
          avgFrameRateRaw: "0/0",
          rFrameRateRaw: "30/1",
          isVariableFrameRate: true,
          bitrateBps: null,
          colorSpace: null,
          colorTransfer: null,
          colorPrimaries: null,
          durationSec: null,
        },
      ],
      audioStreams: [
        {
          index: 1,
          audioTrackIndex: 0,
          codecName: "aac",
          codecLongName: "AAC",
          profile: "LC",
          language: "eng",
          title: "English",
          channels: 2,
          channelLayout: "stereo",
          sampleRateHz: 48000,
          bitrateBps: 128000,
          durationSec: null,
          isDefault: true,
        },
        {
          index: 2,
          audioTrackIndex: 1,
          codecName: "opus",
          codecLongName: "Opus",
          profile: null,
          language: "zho",
          title: "中文配音",
          channels: 2,
          channelLayout: "stereo",
          sampleRateHz: 48000,
          bitrateBps: null,
          durationSec: null,
          isDefault: false,
        },
      ],
      subtitleStreams: [],
      formatTags: {},
      summaryText: "File: vfr_portrait.mkv",
      rawJson: "{}",
    });

    renderV10();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "选择音视频文件…" })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "选择音视频文件…" }));

    await waitFor(() => {
      expect(screen.getByText("1080 × 1920")).toBeInTheDocument();
    });
    expect(screen.getByText("可变帧率 VFR")).toBeInTheDocument();
    expect(screen.getByText(/音轨 #1/)).toBeInTheDocument();
    expect(screen.getByText(/音轨 #2/)).toBeInTheDocument();
    expect(screen.getByText("容器未记录时长")).toBeInTheDocument();
    expect(screen.getAllByText("未知").length).toBeGreaterThanOrEqual(2);
  });
});
