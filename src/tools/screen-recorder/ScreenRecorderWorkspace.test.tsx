import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { MediaSessionProvider } from "../../lib/mediaSessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { ScreenRecorderWorkspace } from "./ScreenRecorderWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    listCaptureMonitors: vi.fn(),
    listCaptureWindows: vi.fn(),
    listAudioPlaybackDevices: vi.fn(),
    listAudioCaptureDevices: vi.fn(),
    getScreenRecorderCapabilities: vi.fn(),
    getScreenRecorderStatus: vi.fn(),
    pickScreenRecordingRegion: vi.fn(),
    startScreenRecording: vi.fn(),
    stopScreenRecording: vi.fn(),
    discardScreenRecording: vi.fn(),
    subscribeScreenRecorderState: vi.fn().mockResolvedValue(() => {}),
    subscribeMediaTaskProgress: vi.fn().mockResolvedValue(() => {}),
    getMediaToolsStatus: vi.fn().mockResolvedValue({
      ready: true,
      source: "system_path",
      mode: "auto",
      customDir: null,
      ffmpegPath: "C:\\ffmpeg\\ffmpeg.exe",
      ffprobePath: "C:\\ffmpeg\\ffprobe.exe",
      ffmpegVersion: "8.1.1",
      ffprobeVersion: "8.1.1",
      installDir: "C:\\Temp\\media",
      managedInstalledBytes: null,
      licensePath: null,
      error: null,
      spec: {
        version: "9.1",
        sourceName: "GyanD",
        releaseUrl: "https://example.com",
        sourceCommitUrl: "https://example.com",
        downloadUrl: "https://example.com",
        downloadBytes: 1000,
        sha256: "abc",
        estimatedInstalledBytes: 2000,
        licenseName: "GPL v3",
      },
    }),
    pickSaveFilePath: vi.fn(),
    openLocalDirectory: vi.fn(),
  };
});

const IDLE_SNAP: tauriBridge.ScreenRecorderSnapshot = {
  phase: "idle",
  targetKind: null,
  targetSummary: null,
  audioScopeSummary: null,
  elapsedSec: 0,
  framesWritten: 0,
  outputWidth: null,
  outputHeight: null,
  fps: null,
  format: null,
  recordSystemAudio: false,
  recordMicrophone: false,
  systemLevelDb: -96,
  micLevelDb: -96,
  outputPath: null,
  previewUrl: null,
  byteSize: null,
  durationSec: null,
  interruptedReason: null,
  warnings: [],
  errorCode: null,
  errorMessage: null,
};

function renderWorkspace(onNavigateToTool = vi.fn()) {
  return {
    onNavigateToTool,
    ...render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: vi.fn() }}>
        <MediaSessionProvider onNavigateToTool={onNavigateToTool}>
          <ScreenRecorderWorkspace />
        </MediaSessionProvider>
      </I18nContext.Provider>,
    ),
  };
}

describe("V05 ScreenRecorderWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tauriBridge.getScreenRecorderStatus).mockResolvedValue(IDLE_SNAP);
    vi.mocked(tauriBridge.getScreenRecorderCapabilities).mockResolvedValue({
      wgcSupported: true,
      cursorToggleSupported: true,
      clickHighlightSupported: true,
      formats: ["mp4", "mov"],
      fpsOptions: [30, 60],
      resolutionOptions: ["original", "p1440", "p1080", "p720"],
    });
    vi.mocked(tauriBridge.listCaptureMonitors).mockResolvedValue([
      {
        id: "\\\\.\\DISPLAY1",
        deviceName: "\\\\.\\DISPLAY1",
        isPrimary: true,
        x: 0,
        y: 0,
        width: 3840,
        height: 2160,
        scalePercent: 150,
      },
    ]);
    vi.mocked(tauriBridge.listCaptureWindows).mockResolvedValue([
      {
        hwnd: 123456,
        title: "WinKit Demo Player",
        processName: "player.exe",
        x: 100,
        y: 100,
        width: 1280,
        height: 720,
        isProtected: false,
      },
    ]);
    vi.mocked(tauriBridge.listAudioPlaybackDevices).mockResolvedValue([
      {
        id: "spk-1",
        name: "入梦扬声器 (VB-Audio Cable A)",
        flow: "render",
        isDefault: true,
        sampleRate: 48000,
        channels: 2,
        bitsPerSample: 32,
      },
    ]);
    vi.mocked(tauriBridge.listAudioCaptureDevices).mockResolvedValue([
      {
        id: "mic-1",
        name: "麦克风阵列 (2- Realtek(R) Audio)",
        flow: "capture",
        isDefault: true,
        sampleRate: 48000,
        channels: 2,
        bitsPerSample: 32,
      },
    ]);
  });

  afterEach(() => {
    cleanup();
  });

  it("clearly displays capture target, audio sources, and WASAPI loopback device-wide scope notice in Single Window mode", async () => {
    renderWorkspace();
    await waitFor(() => {
      expect(screen.getByTestId("v05-summary-target").textContent).toContain("3840×2160");
    });

    fireEvent.click(screen.getByText("单个窗口"));
    fireEvent.click(screen.getByTestId("v05-sys-audio-toggle"));

    await waitFor(() => {
      expect(screen.getByTestId("v05-summary-target").textContent).toContain("WinKit Demo Player");
      expect(screen.getByTestId("v05-system-audio-scope-note").textContent).toContain(
        "WASAPI 整机回环输出",
      );
      expect(screen.getByTestId("v05-system-audio-scope-note").textContent).toContain(
        "而非仅限当前选定窗口进程",
      );
    });
  });

  it("distinguishes Stop & Save vs Discard and hands off saved recording to V04", async () => {
    vi.mocked(tauriBridge.pickSaveFilePath).mockResolvedValue("C:\\Temp\\demo_rec.mp4");
    vi.mocked(tauriBridge.startScreenRecording).mockResolvedValue({
      ...IDLE_SNAP,
      phase: "recording",
      targetKind: "monitor",
      targetSummary: "\\\\.\\DISPLAY1 (3840×2160)",
      audioScopeSummary: "Muted (Video only)",
      outputWidth: 1920,
      outputHeight: 1080,
      fps: 30,
      format: "mp4",
      outputPath: "C:\\Temp\\demo_rec.mp4",
    });
    vi.mocked(tauriBridge.stopScreenRecording).mockResolvedValue({
      ...IDLE_SNAP,
      phase: "completed",
      outputWidth: 1920,
      outputHeight: 1080,
      fps: 30,
      format: "mp4",
      outputPath: "C:\\Temp\\demo_rec.mp4",
      previewUrl: "winkitmedia://localhost/preview/rec1",
      byteSize: 256000,
      durationSec: 5.2,
    });

    const { onNavigateToTool } = renderWorkspace();
    await waitFor(() => {
      expect((screen.getByTestId("v05-start-btn") as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(screen.getByTestId("v05-start-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("v05-stop-save-btn")).toBeTruthy();
      expect(screen.getByTestId("v05-discard-btn")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("v05-stop-save-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("v05-preview-video")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("v05-handoff-v04"));
    expect(onNavigateToTool).toHaveBeenCalledWith("V04");
  });
});
