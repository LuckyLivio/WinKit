import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { MediaSessionProvider } from "../../lib/mediaSessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import {
  AudioRecorderWorkspace,
  dbFsToMeterPercent,
  formatRecorderTimer,
} from "./AudioRecorderWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    listAudioCaptureDevices: vi.fn(),
    getAudioRecorderStatus: vi.fn(),
    startAudioMonitor: vi.fn(),
    stopAudioMonitor: vi.fn(),
    startAudioRecording: vi.fn(),
    pauseAudioRecording: vi.fn(),
    resumeAudioRecording: vi.fn(),
    stopAudioRecording: vi.fn(),
    discardAudioRecording: vi.fn(),
    saveAudioRecording: vi.fn(),
    subscribeAudioRecorderState: vi.fn().mockResolvedValue(() => {}),
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

const IDLE_SNAP: tauriBridge.AudioRecorderSnapshot = {
  phase: "idle",
  deviceId: null,
  deviceName: null,
  sampleRate: null,
  channels: null,
  elapsedSec: 0,
  levelRms: 0,
  levelPeak: 0,
  dbFs: -96,
  clipping: false,
  previewUrl: null,
  tempWavPath: null,
  byteSize: null,
  interruptedReason: null,
  errorCode: null,
  errorMessage: null,
};

function renderWorkspace(onNavigateToTool = vi.fn()) {
  return {
    onNavigateToTool,
    ...render(
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: vi.fn() }}>
        <MediaSessionProvider onNavigateToTool={onNavigateToTool}>
          <AudioRecorderWorkspace />
        </MediaSessionProvider>
      </I18nContext.Provider>,
    ),
  };
}

describe("A02 AudioRecorderWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tauriBridge.getAudioRecorderStatus).mockResolvedValue(IDLE_SNAP);
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

  it("formats recorder timer and dBFS meter scale accurately", () => {
    expect(formatRecorderTimer(0)).toBe("00:00.0");
    expect(formatRecorderTimer(6.35)).toBe("00:06.3");
    expect(formatRecorderTimer(125.9)).toBe("02:05.9");
    expect(dbFsToMeterPercent(-96)).toBe(0);
    expect(dbFsToMeterPercent(-30)).toBe(50);
    expect(dbFsToMeterPercent(0)).toBe(100);
  });

  it("does NOT open microphone automatically on mount and handles empty devices", async () => {
    vi.mocked(tauriBridge.listAudioCaptureDevices).mockResolvedValueOnce([]);
    renderWorkspace();
    await waitFor(() => {
      expect(screen.getByText(/当前未检测到可用麦克风/)).toBeTruthy();
    });
    expect(tauriBridge.startAudioMonitor).not.toHaveBeenCalled();
    expect(tauriBridge.startAudioRecording).not.toHaveBeenCalled();
    expect((screen.getByTestId("a02-start-btn") as HTMLButtonElement).disabled).toBe(true);
  });

  it("runs start -> pause -> resume -> stop -> save WAV -> handoff to A03/A01", async () => {
    vi.mocked(tauriBridge.startAudioRecording).mockResolvedValue({
      ...IDLE_SNAP,
      phase: "recording",
      deviceId: "mic-1",
      deviceName: "麦克风阵列 (2- Realtek(R) Audio)",
      sampleRate: 48000,
      channels: 2,
      elapsedSec: 0.1,
    });
    vi.mocked(tauriBridge.pauseAudioRecording).mockResolvedValue({
      ...IDLE_SNAP,
      phase: "paused",
      deviceId: "mic-1",
      sampleRate: 48000,
      channels: 2,
      elapsedSec: 3.0,
    });
    vi.mocked(tauriBridge.resumeAudioRecording).mockResolvedValue({
      ...IDLE_SNAP,
      phase: "recording",
      deviceId: "mic-1",
      sampleRate: 48000,
      channels: 2,
      elapsedSec: 3.0,
    });
    vi.mocked(tauriBridge.stopAudioRecording).mockResolvedValue({
      ...IDLE_SNAP,
      phase: "stopped_ready",
      deviceId: "mic-1",
      sampleRate: 48000,
      channels: 2,
      elapsedSec: 6.0,
      previewUrl: "winkitmedia://localhost/preview/take1",
      tempWavPath: "C:\\Temp\\rec_1.wav",
      byteSize: 1152044,
    });
    vi.mocked(tauriBridge.pickSaveFilePath).mockResolvedValue("C:\\Temp\\my_rec.wav");
    vi.mocked(tauriBridge.saveAudioRecording).mockResolvedValue({
      outputPath: "C:\\Temp\\my_rec.wav",
      format: "wav",
      durationSec: 6.0,
      sampleRate: 48000,
      channels: 2,
      byteSize: 1152044,
    });

    const { onNavigateToTool } = renderWorkspace();
    await waitFor(() => {
      expect((screen.getByTestId("a02-start-btn") as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(screen.getByTestId("a02-start-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("a02-pause-btn")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("a02-pause-btn"));
    await waitFor(() => {
      expect(screen.getByText(/暂停期间不会写入任何音频帧/)).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("a02-pause-btn"));
    await waitFor(() => {
      expect(tauriBridge.resumeAudioRecording).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByTestId("a02-stop-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("a02-audition-player")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("a02-save-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("a02-handoff-a03")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("a02-handoff-a03"));
    expect(onNavigateToTool).toHaveBeenCalledWith("A03");
  });

  it("shows localized microphone permission error when Windows denies access", async () => {
    vi.mocked(tauriBridge.startAudioRecording).mockRejectedValue({
      code: "MIC_PERMISSION_DENIED",
      message: "Access denied",
    });

    renderWorkspace();
    await waitFor(() => {
      expect((screen.getByTestId("a02-start-btn") as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId("a02-start-btn"));
    await waitFor(() => {
      expect(screen.getByText(/Windows 已阻止麦克风访问权限/)).toBeTruthy();
    });
  });
});
