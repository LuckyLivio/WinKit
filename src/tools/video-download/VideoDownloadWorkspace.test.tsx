import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { MediaSessionProvider } from "../../lib/mediaSessionStore";
import * as bridge from "../../lib/tauriBridge";
import {
  extractHttpUrlsFromInput,
  redactUrlForPreview,
  VideoDownloadWorkspace,
} from "./VideoDownloadWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    getMediaToolsStatus: vi.fn(),
    getYtdlpToolsStatus: vi.fn(),
    subscribeMediaSetupProgress: vi.fn().mockResolvedValue(() => {}),
    subscribeYtdlpSetupProgress: vi.fn().mockResolvedValue(() => {}),
    subscribeVideoDownloadProgress: vi.fn().mockResolvedValue(() => {}),
    probeVideoDownloadUrl: vi.fn(),
    downloadVideoItem: vi.fn(),
    pickSingleDirectory: vi.fn(),
    openLocalDirectory: vi.fn(),
    cancelBackendTask: vi.fn(),
  };
});

describe("V01 VideoDownloadWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(bridge.getMediaToolsStatus).mockResolvedValue({
      ready: true,
      source: "managed",
      mode: "auto",
      customDir: null,
      ffmpegPath: "C:\\Tools\\ffmpeg.exe",
      ffprobePath: "C:\\Tools\\ffprobe.exe",
      ffmpegVersion: "ffmpeg version 9.1",
      ffprobeVersion: "ffprobe version 9.1",
      installDir: "C:\\Tools\\ffmpeg",
      managedInstalledBytes: 221_044_037,
      licensePath: "C:\\Tools\\ffmpeg\\LICENSE",
      error: null,
      spec: {
        version: "9.1",
        sourceName: "GyanD/codexffmpeg",
        releaseUrl: "https://github.com/GyanD/codexffmpeg/releases/tag/9.1",
        sourceCommitUrl: "https://github.com/FFmpeg/FFmpeg/commit/74e4393595",
        downloadUrl: "https://example.invalid/ffmpeg.7z",
        downloadBytes: 36_671_021,
        sha256: "835b9a733445ba7a56a37a26cf7bde84e2f3ce7da2a8ec984276bb2abb1b922c",
        estimatedInstalledBytes: 221_044_037,
        licenseName: "GNU GPL v3",
      },
    });
    vi.mocked(bridge.getYtdlpToolsStatus).mockResolvedValue({
      ready: true,
      source: "managed",
      mode: "auto",
      customPath: null,
      ytdlpPath: "C:\\Tools\\yt-dlp.exe",
      ytdlpVersion: "2026.10.26",
      installDir: "C:\\Tools\\yt-dlp\\active",
      managedInstalledBytes: 23_575_744,
      licensePath: "C:\\Tools\\yt-dlp\\active\\LICENSE-yt-dlp.txt",
      jsRuntimes: [
        { name: "node", path: "D:\\NodeJS\\node.exe", version: "v24.11.1", recommended: false },
      ],
      hasJsRuntime: true,
      error: null,
      spec: {
        version: "2026.10.26",
        sourceName: "yt-dlp/yt-dlp (Release 2026.10.26 · Windows x64)",
        releaseUrl: "https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26",
        downloadUrl: "https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp.exe",
        downloadBytes: 23_575_744,
        sha256: "f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d",
        licenseName: "The Unlicense",
      },
    });
  });

  it("extracts valid HTTP(S) URLs and redacts sensitive tokens and credentials", () => {
    const parsed = extractHttpUrlsFromInput(
      "https://example.com/a.mp4?token=secret123&v=1\nfile:///C:/Windows/win.ini\n--exec calc\nhttp://127.0.0.1:8765/master.m3u8",
    );
    expect(parsed.valid).toEqual([
      "https://example.com/a.mp4?token=secret123&v=1",
      "http://127.0.0.1:8765/master.m3u8",
    ]);
    expect(parsed.rejectedCount).toBe(2);

    const safe = redactUrlForPreview(
      "https://user:pass@cdn.example.com/v.mp4?v=1&token=TOPSECRET&sig=DEADBEEF#frag",
    );
    expect(safe).not.toContain("TOPSECRET");
    expect(safe).not.toContain("DEADBEEF");
    expect(safe).not.toContain("pass");
    expect(safe).toContain("token=[REDACTED]");
    expect(safe).toContain("sig=[REDACTED]");
    expect(safe).toContain("v=1");
  });

  it("inspects URL, displays available resolutions/audio languages, and runs download with probed specs", async () => {
    const user = userEvent.setup();
    vi.mocked(bridge.probeVideoDownloadUrl).mockResolvedValue({
      sanitizedUrl: "https://example.com/watch?v=demo&token=[REDACTED]",
      title: "Sample Multi-Track Demo",
      extractor: "Generic",
      webpageDomain: "example.com",
      durationSec: 12.5,
      isDirectMedia: false,
      usedYtdlp: true,
      availableResolutions: [1080, 720, 480],
      availableAudioLanguages: [
        { language: "zh", label: "中文 / Chinese (zh)", codec: "aac" },
        { language: "en", label: "English (en)", codec: "aac" },
      ],
      hasH264: true,
      estimatedBestBytes: 5_242_880,
      warnings: [],
      formatsSummary: [],
    });
    vi.mocked(bridge.pickSingleDirectory).mockResolvedValue("D:\\Downloads\\WinKit");
    vi.mocked(bridge.downloadVideoItem).mockResolvedValue({
      itemId: "mock",
      sanitizedUrl: "https://example.com/watch?v=demo&token=[REDACTED]",
      outputPath: "D:\\Downloads\\WinKit\\Sample Multi-Track Demo.mp4",
      fileName: "Sample Multi-Track Demo.mp4",
      byteSize: 2_345_678,
      sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      title: "Sample Multi-Track Demo",
      extractor: "Generic",
      usedYtdlp: true,
      durationSec: 12.5,
      width: 1280,
      height: 720,
      videoCodec: "h264",
      audioCodec: "aac",
      audioLanguage: "zh",
      containerFormat: "mov,mp4,m4a,3gp,3g2,mj2",
      renamedForCollision: false,
      warnings: [],
    });

    render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <MediaSessionProvider onNavigateToTool={() => {}}>
          <VideoDownloadWorkspace />
        </MediaSessionProvider>
      </I18nContext.Provider>,
    );

    const textarea = await screen.findByLabelText(/粘贴一个或多个/);
    await user.type(textarea, "https://example.com/watch?v=demo&token=SECRET999");
    await user.click(screen.getByRole("button", { name: /解析并加入队列/ }));

    await waitFor(() => {
      expect(screen.getByText("Sample Multi-Track Demo")).toBeInTheDocument();
    });
    expect(screen.queryByText(/SECRET999/)).not.toBeInTheDocument();
    expect(screen.getByText(/1080p \/ 720p \/ 480p/)).toBeInTheDocument();
    expect(screen.getAllByText(/中文 \/ Chinese \(zh\)/).length).toBeGreaterThanOrEqual(2);

    await user.click(screen.getByRole("button", { name: "最高 720p" }));
    await user.selectOptions(screen.getByLabelText("首选音轨语言"), "zh");
    await user.click(screen.getByRole("button", { name: "开始下载队列" }));

    await waitFor(() => {
      expect(screen.getByText("Sample Multi-Track Demo.mp4")).toBeInTheDocument();
    });
    expect(screen.getByText("1280×720")).toBeInTheDocument();
    expect(screen.getByText(/h264/)).toBeInTheDocument();
    expect(screen.getByText(/aac/)).toBeInTheDocument();
    expect(screen.getByText(/音轨语言: zh/)).toBeInTheDocument();
    expect(bridge.downloadVideoItem).toHaveBeenCalledWith(
      expect.objectContaining({
        outputDir: "D:\\Downloads\\WinKit",
        quality: "max_720p",
        preferH264: true,
        preferredAudioLanguage: "zh",
      }),
    );
  });
});
