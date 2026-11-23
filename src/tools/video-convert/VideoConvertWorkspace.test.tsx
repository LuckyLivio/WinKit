import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { MediaSessionProvider } from "../../lib/mediaSessionStore";
import { VideoConvertWorkspace } from "./VideoConvertWorkspace";

const mockBridge = vi.hoisted(() => ({
  getMediaToolsStatus: vi.fn(),
  inspectVideoConvertPlan: vi.fn(),
  convertVideosBatch: vi.fn(),
  pickMultipleFiles: vi.fn(),
  pickSingleDirectory: vi.fn(),
  registerMediaPreviewPath: vi.fn(),
  openLocalDirectory: vi.fn(),
}));

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    getMediaToolsStatus: mockBridge.getMediaToolsStatus,
    inspectVideoConvertPlan: mockBridge.inspectVideoConvertPlan,
    convertVideosBatch: mockBridge.convertVideosBatch,
    pickMultipleFiles: mockBridge.pickMultipleFiles,
    pickSingleDirectory: mockBridge.pickSingleDirectory,
    registerMediaPreviewPath: mockBridge.registerMediaPreviewPath,
    openLocalDirectory: mockBridge.openLocalDirectory,
    subscribeFileDrop: vi.fn(async () => () => {}),
    subscribeMediaSetupProgress: vi.fn(async () => () => {}),
    subscribeMediaTaskProgress: vi.fn(async () => () => {}),
  };
});

describe("VideoConvertWorkspace (V07)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBridge.getMediaToolsStatus.mockResolvedValue({
      ready: true,
      source: "managed",
      mode: "auto",
      customDir: null,
      ffmpegPath: "C:\\Tools\\ffmpeg.exe",
      ffprobePath: "C:\\Tools\\ffprobe.exe",
      ffmpegVersion: "ffmpeg version 9.1",
      ffprobeVersion: "ffprobe version 9.1",
      installDir: "C:\\Tools",
      managedInstalledBytes: 221044037,
      licensePath: null,
      error: null,
      spec: {
        version: "9.1",
        sourceName: "GyanD",
        releaseUrl: "https://example.com",
        sourceCommitUrl: "https://example.com",
        downloadUrl: "https://example.com",
        downloadBytes: 36671021,
        sha256: "abc",
        estimatedInstalledBytes: 221044037,
        licenseName: "GNU GPL v3",
      },
    });
    mockBridge.registerMediaPreviewPath.mockResolvedValue({
      token: "tok",
      url: "http://winkitmedia.localhost/tok",
      mimeType: "video/mp4",
      fileName: "demo.mkv",
      byteLength: 1024,
    });
  });

  it("shows track compatibility plan, gates dropped bitmap subtitles on explicit user consent, and verifies output", async () => {
    mockBridge.pickMultipleFiles.mockResolvedValue(["C:\\demo\\movie.mkv"]);
    mockBridge.inspectVideoConvertPlan.mockResolvedValue({
      targetFormat: "mp4",
      items: [
        {
          sourcePath: "C:\\demo\\movie.mkv",
          fileName: "movie.mkv",
          ok: true,
          error: null,
          plan: {
            sourcePath: "C:\\demo\\movie.mkv",
            fileName: "movie.mkv",
            byteSize: 2048000,
            durationSec: 12,
            sourceContainer: "matroska,webm",
            targetFormat: "mp4",
            overallMode: "remux_only",
            copyTrackCount: 2,
            transcodeTrackCount: 0,
            dropTrackCount: 1,
            hasContainerLimitations: true,
            limitationMessages: [
              "Stream #2 Bitmap subtitle (hdmv_pgs_subtitle) is unsupported in MP4 and will be omitted.",
            ],
            tracks: [
              {
                streamIndex: 0,
                streamType: "video",
                sourceCodec: "h264",
                language: null,
                title: null,
                action: "copy",
                targetCodec: "copy",
                reasonCode: "compatible_copy",
                reasonText: "Copy H.264",
              },
              {
                streamIndex: 1,
                streamType: "audio",
                sourceCodec: "aac",
                language: "eng",
                title: null,
                action: "copy",
                targetCodec: "copy",
                reasonCode: "compatible_copy",
                reasonText: "Copy AAC",
              },
              {
                streamIndex: 2,
                streamType: "subtitle",
                sourceCodec: "hdmv_pgs_subtitle",
                language: "eng",
                title: null,
                action: "drop",
                targetCodec: null,
                reasonCode: "bitmap_subtitle_unsupported",
                reasonText: "PGS unsupported in MP4",
              },
            ],
          },
        },
      ],
    });
    mockBridge.convertVideosBatch.mockResolvedValue({
      taskId: "t1",
      outputDir: "C:\\demo",
      targetFormat: "mp4",
      cancelled: false,
      convertedCount: 1,
      skippedCount: 0,
      failedCount: 0,
      elapsedMs: 120,
      items: [
        {
          sourcePath: "C:\\demo\\movie.mkv",
          fileName: "movie.mkv",
          status: "converted",
          outputPath: "C:\\demo\\movie.mp4",
          outputBytes: 1990000,
          overallMode: "remux_only",
          verifiedContainer: "mov,mp4,m4a,3gp,3g2,mj2",
          verifiedVideoCodecs: ["h264"],
          verifiedAudioCodecs: ["aac"],
          verifiedSubtitleCodecs: [],
          verifiedStreamCount: 2,
          droppedTrackCount: 1,
          elapsedMs: 110,
          message: null,
        },
      ],
    });

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: vi.fn() }}>
        <MediaSessionProvider>
          <VideoConvertWorkspace />
        </MediaSessionProvider>
      </I18nContext.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /选择视频文件/ }));

    await waitFor(() => {
      expect(screen.getByText(/目标容器轨道限制提示/)).toBeInTheDocument();
    });

    const convertBtn = screen.getByRole("button", { name: /开始转换为 MP4/ });
    expect(convertBtn).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox"));
    expect(convertBtn).not.toBeDisabled();

    fireEvent.click(convertBtn);
    await waitFor(() => {
      expect(screen.getByText(/ffprobe 已核验/)).toBeInTheDocument();
    });
  });
});
