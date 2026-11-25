import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { MediaSessionProvider } from "../../lib/mediaSessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { TranscribeMediaWorkspace } from "../transcribe-media/TranscribeMediaWorkspace";
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
    subscribeMediaSetupProgress: vi.fn().mockResolvedValue(() => {}),
    subscribeAsrProgress: vi.fn().mockResolvedValue(() => {}),
    subscribeAsrSetupProgress: vi.fn().mockResolvedValue(() => {}),
    subscribeFileDrop: vi.fn().mockResolvedValue(() => {}),
    getAsrModelStatus: vi.fn(),
    installManagedAsrModel: vi.fn(),
    inspectTranscribeMedia: vi.fn(),
    registerMediaPreviewPath: vi.fn(),
    transcribeMedia: vi.fn(),
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

const ASR_SPEC: tauriBridge.ManagedAsrModelSpec = {
  modelId: "sensevoice-small-int8-v20240717",
  displayName: "SenseVoiceSmall INT8 + Silero VAD v5 (Offline CPU)",
  version: "2024-07-17 + Silero VAD v5",
  sourceName: "FunAudioLLM / k2-fsa",
  releaseUrl: "https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models",
  sensevoiceArchiveUrl: "https://example.invalid/sv.tar.bz2",
  sensevoiceArchiveBytes: 163_002_883,
  sensevoiceArchiveSha256: "7d1efa21",
  sileroVadUrl: "https://example.invalid/vad.onnx",
  sileroVadBytes: 2_313_101,
  sileroVadSha256: "6b99cbfd",
  totalDownloadBytes: 165_315_984,
  estimatedInstalledBytes: 241_862_836,
  licenseSummary: "FunASR v1.1 + MIT",
};

const READY_ASR_STATUS: tauriBridge.AsrModelStatus = {
  ready: true,
  runtimeReady: true,
  source: "managed",
  mode: "managed",
  customDir: null,
  installDir: "C:\\Users\\Test\\AppData\\Local\\com.luckylivio.winkit\\asr-models",
  activeModelDir: "C:\\Users\\Test\\AppData\\Local\\com.luckylivio.winkit\\asr-models",
  installedBytes: 241_862_836,
  licensePath: null,
  error: null,
  spec: ASR_SPEC,
};

const MISSING_ASR_STATUS: tauriBridge.AsrModelStatus = {
  ready: false,
  runtimeReady: true,
  source: "missing",
  mode: "managed",
  customDir: null,
  installDir: "C:\\Users\\Test\\AppData\\Local\\com.luckylivio.winkit\\asr-models",
  activeModelDir: null,
  installedBytes: null,
  licensePath: null,
  error: null,
  spec: ASR_SPEC,
};

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
      expect(screen.getByTestId("a02-handoff-t01")).toBeTruthy();
      expect(screen.getByTestId("a02-handoff-a03")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("a02-handoff-t01"));
    expect(onNavigateToTool).toHaveBeenCalledWith("T01");

    fireEvent.click(screen.getByTestId("a02-handoff-a03"));
    expect(onNavigateToTool).toHaveBeenCalledWith("A03");
  });

  it("hands saved WAV directly from A02 into T01 with ready model and supports transcription & re-recording", async () => {
    const savedPath = "C:\\Temp\\中文 录音\\meeting_take.wav";
    vi.mocked(tauriBridge.getAsrModelStatus).mockResolvedValue(READY_ASR_STATUS);
    vi.mocked(tauriBridge.startAudioRecording).mockResolvedValue({
      ...IDLE_SNAP,
      phase: "recording",
      deviceId: "mic-1",
      sampleRate: 48000,
      channels: 2,
      elapsedSec: 0.2,
    });
    vi.mocked(tauriBridge.stopAudioRecording).mockResolvedValue({
      ...IDLE_SNAP,
      phase: "stopped_ready",
      deviceId: "mic-1",
      sampleRate: 48000,
      channels: 2,
      elapsedSec: 5.5,
      previewUrl: "winkitmedia://localhost/preview/take2",
      tempWavPath: "C:\\Temp\\rec_2.wav",
      byteSize: 1_056_044,
    });
    vi.mocked(tauriBridge.pickSaveFilePath).mockResolvedValue(savedPath);
    vi.mocked(tauriBridge.saveAudioRecording).mockResolvedValue({
      outputPath: savedPath,
      format: "wav",
      durationSec: 5.5,
      sampleRate: 48000,
      channels: 2,
      byteSize: 1_056_044,
    });
    vi.mocked(tauriBridge.inspectTranscribeMedia).mockResolvedValue({
      path: savedPath,
      fileName: "meeting_take.wav",
      byteLength: 1_056_044,
      isWavNative: true,
      requiresFfmpeg: false,
      hasAudio: true,
      hasVideo: false,
      durationSec: 5.5,
      containerStartTimeSec: 0,
      audioStartTimeSec: 0,
      audioCodec: "pcm_s16le",
      sampleRate: 48000,
      channels: 2,
      containerFormat: "wav",
    });
    vi.mocked(tauriBridge.registerMediaPreviewPath).mockResolvedValue({
      token: "tok-a02",
      url: "winkitmedia://localhost/tok-a02",
      mimeType: "audio/wav",
      byteLength: 1_056_044,
      fileName: "meeting_take.wav",
    });
    vi.mocked(tauriBridge.transcribeMedia).mockResolvedValue({
      inputPath: savedPath,
      fileName: "meeting_take.wav",
      durationSec: 5.5,
      timelineOffsetSec: 0,
      decodedWithFfmpeg: false,
      engineName: "SenseVoiceSmall INT8 + Silero VAD v5",
      segments: [
        { id: 1, startSec: 0.4, endSec: 2.8, text: "欢迎使用 WinKit 录音机。", language: "zh" },
        { id: 2, startSec: 3.1, endSec: 5.1, text: "Offline transcription works.", language: "en" },
      ],
      fullText: "欢迎使用 WinKit 录音机。\nOffline transcription works.",
      detectedLanguages: ["zh", "en"],
      speechDurationSec: 4.4,
      elapsedMs: 180,
      rtf: 0.032,
      warnings: [],
    });

    function DualToolShell() {
      const [activeTool, setActiveTool] = useState<string>("A02");
      return (
        <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: vi.fn() }}>
          <MediaSessionProvider onNavigateToTool={setActiveTool}>
            <button type="button" data-testid="nav-a02" onClick={() => setActiveTool("A02")}>
              Back to A02
            </button>
            {activeTool === "A02" ? <AudioRecorderWorkspace /> : <TranscribeMediaWorkspace />}
          </MediaSessionProvider>
        </I18nContext.Provider>
      );
    }

    render(<DualToolShell />);
    await waitFor(() => {
      expect((screen.getByTestId("a02-start-btn") as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId("a02-start-btn"));
    await waitFor(() => expect(screen.getByTestId("a02-stop-btn")).toBeTruthy());
    fireEvent.click(screen.getByTestId("a02-stop-btn"));
    await waitFor(() => expect(screen.getByTestId("a02-audition-player")).toBeTruthy());
    fireEvent.click(screen.getByTestId("a02-save-btn"));
    await waitFor(() => expect(screen.getByTestId("a02-handoff-t01")).toBeTruthy());

    // Hand off saved recording to T01
    fireEvent.click(screen.getByTestId("a02-handoff-t01"));
    await waitFor(() => {
      expect(screen.getByTestId("t01-workspace")).toBeTruthy();
      expect(tauriBridge.inspectTranscribeMedia).toHaveBeenCalledWith(savedPath);
      expect(screen.getByTestId("t01-source-meta")).toHaveTextContent("meeting_take.wav");
    });

    // Run transcription in T01 on exact saved WAV
    await waitFor(() => {
      expect((screen.getByTestId("t01-start-btn") as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId("t01-start-btn"));
    await waitFor(() => {
      expect(screen.getByLabelText("第 1 条文本")).toHaveValue("欢迎使用 WinKit 录音机。");
      expect(screen.getByLabelText("第 2 条文本")).toHaveValue("Offline transcription works.");
    });

    // Return to A02 and verify re-record works cleanly
    vi.mocked(tauriBridge.getAudioRecorderStatus).mockResolvedValueOnce({
      ...IDLE_SNAP,
      phase: "stopped_ready",
      deviceId: "mic-1",
      sampleRate: 48000,
      channels: 2,
      elapsedSec: 5.5,
      previewUrl: "winkitmedia://localhost/preview/take2",
      tempWavPath: "C:\\Temp\\rec_2.wav",
      byteSize: 1_056_044,
    });
    fireEvent.click(screen.getByTestId("nav-a02"));
    await waitFor(() => expect(screen.getByTestId("a02-audition-player")).toBeTruthy());
    fireEvent.click(screen.getByTestId("a02-start-btn"));
    await waitFor(() => expect(tauriBridge.startAudioRecording).toHaveBeenCalledTimes(2));
  });

  it("loads handed-off recording into T01 and shows existing model setup panel without auto-downloading when model is absent", async () => {
    const savedPath = "C:\\Temp\\no_model_rec.wav";
    vi.mocked(tauriBridge.getAsrModelStatus).mockResolvedValue(MISSING_ASR_STATUS);
    vi.mocked(tauriBridge.getAudioRecorderStatus).mockResolvedValue({
      ...IDLE_SNAP,
      phase: "stopped_ready",
      deviceId: "mic-1",
      sampleRate: 48000,
      channels: 2,
      elapsedSec: 3.2,
      previewUrl: "winkitmedia://localhost/preview/take3",
      tempWavPath: "C:\\Temp\\rec_3.wav",
      byteSize: 614_444,
    });
    vi.mocked(tauriBridge.pickSaveFilePath).mockResolvedValue(savedPath);
    vi.mocked(tauriBridge.saveAudioRecording).mockResolvedValue({
      outputPath: savedPath,
      format: "wav",
      durationSec: 3.2,
      sampleRate: 48000,
      channels: 2,
      byteSize: 614_444,
    });
    vi.mocked(tauriBridge.inspectTranscribeMedia).mockResolvedValue({
      path: savedPath,
      fileName: "no_model_rec.wav",
      byteLength: 614_444,
      isWavNative: true,
      requiresFfmpeg: false,
      hasAudio: true,
      hasVideo: false,
      durationSec: 3.2,
      containerStartTimeSec: 0,
      audioStartTimeSec: 0,
      audioCodec: "pcm_s16le",
      sampleRate: 48000,
      channels: 2,
      containerFormat: "wav",
    });
    vi.mocked(tauriBridge.registerMediaPreviewPath).mockResolvedValue({
      token: "tok-a02-missing",
      url: "winkitmedia://localhost/tok-a02-missing",
      mimeType: "audio/wav",
      byteLength: 614_444,
      fileName: "no_model_rec.wav",
    });

    function DualToolShell() {
      const [activeTool, setActiveTool] = useState<string>("A02");
      return (
        <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: vi.fn() }}>
          <MediaSessionProvider onNavigateToTool={setActiveTool}>
            {activeTool === "A02" ? <AudioRecorderWorkspace /> : <TranscribeMediaWorkspace />}
          </MediaSessionProvider>
        </I18nContext.Provider>
      );
    }

    render(<DualToolShell />);
    await waitFor(() => expect(screen.getByTestId("a02-save-btn")).toBeTruthy());
    fireEvent.click(screen.getByTestId("a02-save-btn"));
    await waitFor(() => expect(screen.getByTestId("a02-handoff-t01")).toBeTruthy());
    fireEvent.click(screen.getByTestId("a02-handoff-t01"));

    await waitFor(() => {
      expect(screen.getByTestId("t01-source-meta")).toHaveTextContent("no_model_rec.wav");
      expect(screen.getByTestId("asr-model-setup-card")).toBeTruthy();
    });
    // Must NEVER auto-download the speech model on handoff!
    expect(tauriBridge.installManagedAsrModel).not.toHaveBeenCalled();
    expect((screen.getByTestId("t01-start-btn") as HTMLButtonElement).disabled).toBe(true);
  });

  it("queues A02 handoff B in session while T01 is transcribing A, survives tab switch, and loads B after A finishes", async () => {
    const pathA = "C:\\Temp\\recording_a.wav";
    const pathB = "C:\\Temp\\recording_b.wav";
    vi.mocked(tauriBridge.getAsrModelStatus).mockResolvedValue(READY_ASR_STATUS);
    vi.mocked(tauriBridge.getAudioRecorderStatus).mockResolvedValue({
      ...IDLE_SNAP,
      phase: "stopped_ready",
      deviceId: "mic-1",
      sampleRate: 48000,
      channels: 2,
      elapsedSec: 4.0,
      previewUrl: "winkitmedia://localhost/preview/take_b",
      tempWavPath: "C:\\Temp\\rec_b.wav",
      byteSize: 768_044,
    });
    vi.mocked(tauriBridge.pickSaveFilePath)
      .mockResolvedValueOnce(pathA)
      .mockResolvedValueOnce(pathB);
    vi.mocked(tauriBridge.saveAudioRecording)
      .mockResolvedValueOnce({
        outputPath: pathA,
        format: "wav",
        durationSec: 4.0,
        sampleRate: 48000,
        channels: 2,
        byteSize: 768_044,
      })
      .mockResolvedValueOnce({
        outputPath: pathB,
        format: "wav",
        durationSec: 4.0,
        sampleRate: 48000,
        channels: 2,
        byteSize: 768_044,
      });
    vi.mocked(tauriBridge.inspectTranscribeMedia).mockImplementation(async (p) => ({
      path: p,
      fileName: p.split("\\").pop() ?? "audio.wav",
      byteLength: 768_044,
      isWavNative: true,
      requiresFfmpeg: false,
      hasAudio: true,
      hasVideo: false,
      durationSec: 4.0,
      containerStartTimeSec: 0,
      audioStartTimeSec: 0,
      audioCodec: "pcm_s16le",
      sampleRate: 48000,
      channels: 2,
      containerFormat: "wav",
    }));
    vi.mocked(tauriBridge.registerMediaPreviewPath).mockImplementation(async (p) => ({
      token: `tok-${p}`,
      url: `winkitmedia://localhost/${encodeURIComponent(p)}`,
      mimeType: "audio/wav",
      byteLength: 768_044,
      fileName: p.split("\\").pop() ?? "audio.wav",
    }));

    let resolveTranscribeA!: (res: tauriBridge.TranscribeMediaResult) => void;
    vi.mocked(tauriBridge.transcribeMedia).mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveTranscribeA = res;
        }),
    );

    function DualToolShell() {
      const [activeTool, setActiveTool] = useState<string>("A02");
      return (
        <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: vi.fn() }}>
          <MediaSessionProvider onNavigateToTool={setActiveTool}>
            <button type="button" data-testid="nav-a02" onClick={() => setActiveTool("A02")}>
              A02
            </button>
            <button type="button" data-testid="nav-t01" onClick={() => setActiveTool("T01")}>
              T01
            </button>
            <button type="button" data-testid="nav-other" onClick={() => setActiveTool("OTHER")}>
              Other
            </button>
            {activeTool === "A02" ? (
              <AudioRecorderWorkspace />
            ) : activeTool === "T01" ? (
              <TranscribeMediaWorkspace />
            ) : (
              <div data-testid="other-view">Other</div>
            )}
          </MediaSessionProvider>
        </I18nContext.Provider>
      );
    }

    render(<DualToolShell />);
    // Save A in A02 and send to T01
    await waitFor(() => expect(screen.getByTestId("a02-save-btn")).toBeTruthy());
    fireEvent.click(screen.getByTestId("a02-save-btn"));
    await waitFor(() => expect(screen.getByTestId("a02-handoff-t01")).toBeTruthy());
    fireEvent.click(screen.getByTestId("a02-handoff-t01"));

    await waitFor(() => {
      expect(screen.getByTestId("t01-source-meta")).toHaveTextContent("recording_a.wav");
      expect((screen.getByTestId("t01-start-btn") as HTMLButtonElement).disabled).toBe(false);
    });

    // Start transcribing A (stays running)
    fireEvent.click(screen.getByTestId("t01-start-btn"));
    await waitFor(() => expect(screen.getByTestId("t01-cancel-btn")).toBeTruthy());

    // Switch to A02 while A is running, save B, and click "转写这段录音"
    fireEvent.click(screen.getByTestId("nav-a02"));
    await waitFor(() => expect(screen.getByTestId("a02-save-btn")).toBeTruthy());
    fireEvent.click(screen.getByTestId("a02-save-btn"));
    await waitFor(() => expect(screen.getByTestId("a02-handoff-t01")).toBeTruthy());
    fireEvent.click(screen.getByTestId("a02-handoff-t01"));

    // T01 MUST stay on running A and queue B in session (Load button not shown while running)
    await waitFor(() => {
      expect(screen.getByTestId("t01-pending-handoff-banner")).toHaveTextContent("recording_b.wav");
      expect(screen.getByTestId("t01-source-meta")).toHaveTextContent("recording_a.wav");
    });
    expect(screen.queryByTestId("t01-load-pending-btn")).toBeNull();

    // Finish transcribing A -> A's result is preserved, B is NOT auto-loaded, Load & Dismiss buttons appear
    await act(async () => {
      resolveTranscribeA({
        inputPath: pathA,
        fileName: "recording_a.wav",
        durationSec: 4.0,
        timelineOffsetSec: 0,
        decodedWithFfmpeg: false,
        engineName: "SenseVoiceSmall INT8",
        segments: [{ id: 1, startSec: 0.3, endSec: 3.1, text: "A 的转写结果", language: "zh" }],
        fullText: "A 的转写结果",
        detectedLanguages: ["zh"],
        speechDurationSec: 2.8,
        elapsedMs: 120,
        rtf: 0.03,
        warnings: [],
      });
    });

    await waitFor(() => {
      expect(screen.getByLabelText("第 1 条文本")).toHaveValue("A 的转写结果");
      expect(screen.getByTestId("t01-load-pending-btn")).toBeTruthy();
      expect(screen.getByTestId("t01-dismiss-pending-btn")).toBeTruthy();
    });

    // Leave T01 and come back -> pending recording B and A's transcript MUST both survive!
    fireEvent.click(screen.getByTestId("nav-other"));
    expect(screen.getByTestId("other-view")).toBeTruthy();
    fireEvent.click(screen.getByTestId("nav-t01"));
    await waitFor(() => {
      expect(screen.getByLabelText("第 1 条文本")).toHaveValue("A 的转写结果");
      expect(screen.getByTestId("t01-pending-handoff-banner")).toHaveTextContent("recording_b.wav");
      expect(screen.getByTestId("t01-load-pending-btn")).toBeTruthy();
    });

    // User clicks "载入待处理录音" -> B loads cleanly and clears pending banner
    fireEvent.click(screen.getByTestId("t01-load-pending-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("t01-source-meta")).toHaveTextContent("recording_b.wav");
      expect(screen.queryByTestId("t01-pending-handoff-banner")).toBeNull();
    });
  });

  it("protects manually edited transcript A on A02 handoff B across reject, inspect failure, and confirmed load", async () => {
    const pathA = "C:\\Temp\\edited_a.wav";
    const pathBMoved = "C:\\Temp\\moved_b.wav";
    const pathBNoAudio = "C:\\Temp\\no_audio_b.mkv";
    const pathBValid = "C:\\Temp\\valid_b.wav";

    vi.mocked(tauriBridge.getAsrModelStatus).mockResolvedValue(READY_ASR_STATUS);
    vi.mocked(tauriBridge.getAudioRecorderStatus).mockResolvedValue({
      ...IDLE_SNAP,
      phase: "stopped_ready",
      deviceId: "mic-1",
      sampleRate: 48000,
      channels: 2,
      elapsedSec: 5.0,
      previewUrl: "winkitmedia://localhost/preview/take_a",
      tempWavPath: "C:\\Temp\\rec_a.wav",
      byteSize: 960_044,
    });
    vi.mocked(tauriBridge.pickSaveFilePath)
      .mockResolvedValueOnce(pathA)
      .mockResolvedValueOnce(pathBMoved)
      .mockResolvedValueOnce(pathBMoved)
      .mockResolvedValueOnce(pathBNoAudio)
      .mockResolvedValueOnce(pathBValid);
    vi.mocked(tauriBridge.saveAudioRecording).mockImplementation(async (req) => ({
      outputPath: req.outputPath,
      format: "wav",
      durationSec: 5.0,
      sampleRate: 48000,
      channels: 2,
      byteSize: 960_044,
    }));
    vi.mocked(tauriBridge.inspectTranscribeMedia).mockImplementation(async (p) => {
      if (p === pathBMoved) {
        throw { code: "NOT_FOUND", message: "Recording file was moved or deleted" };
      }
      if (p === pathBNoAudio) {
        return {
          path: p,
          fileName: "no_audio_b.mkv",
          byteLength: 50_000,
          isWavNative: false,
          requiresFfmpeg: true,
          hasAudio: false,
          hasVideo: true,
          durationSec: 5.0,
          containerStartTimeSec: 0,
          audioStartTimeSec: 0,
          audioCodec: null,
          sampleRate: null,
          channels: null,
          containerFormat: "matroska",
        };
      }
      return {
        path: p,
        fileName: p.split("\\").pop() ?? "audio.wav",
        byteLength: 960_044,
        isWavNative: true,
        requiresFfmpeg: false,
        hasAudio: true,
        hasVideo: false,
        durationSec: 5.0,
        containerStartTimeSec: 0,
        audioStartTimeSec: 0,
        audioCodec: "pcm_s16le",
        sampleRate: 48000,
        channels: 2,
        containerFormat: "wav",
      };
    });
    vi.mocked(tauriBridge.registerMediaPreviewPath).mockImplementation(async (p) => ({
      token: `tok-${p}`,
      url: `winkitmedia://localhost/${encodeURIComponent(p)}`,
      mimeType: "audio/wav",
      byteLength: 960_044,
      fileName: p.split("\\").pop() ?? "audio.wav",
    }));
    vi.mocked(tauriBridge.transcribeMedia).mockResolvedValueOnce({
      inputPath: pathA,
      fileName: "edited_a.wav",
      durationSec: 5.0,
      timelineOffsetSec: 0,
      decodedWithFfmpeg: false,
      engineName: "SenseVoiceSmall INT8",
      segments: [{ id: 1, startSec: 0.5, endSec: 3.5, text: "初始文本 A", language: "zh" }],
      fullText: "初始文本 A",
      detectedLanguages: ["zh"],
      speechDurationSec: 3.0,
      elapsedMs: 110,
      rtf: 0.022,
      warnings: [],
    });

    function DualToolShell() {
      const [activeTool, setActiveTool] = useState<string>("A02");
      return (
        <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: vi.fn() }}>
          <MediaSessionProvider onNavigateToTool={setActiveTool}>
            <button type="button" data-testid="nav-a02" onClick={() => setActiveTool("A02")}>
              A02
            </button>
            {activeTool === "A02" ? <AudioRecorderWorkspace /> : <TranscribeMediaWorkspace />}
          </MediaSessionProvider>
        </I18nContext.Provider>
      );
    }

    render(<DualToolShell />);
    // 1. Record/save A -> T01 -> transcribe -> manually edit text AND start timestamp
    await waitFor(() => expect(screen.getByTestId("a02-save-btn")).toBeTruthy());
    fireEvent.click(screen.getByTestId("a02-save-btn"));
    await waitFor(() => expect(screen.getByTestId("a02-handoff-t01")).toBeTruthy());
    fireEvent.click(screen.getByTestId("a02-handoff-t01"));
    await waitFor(() =>
      expect((screen.getByTestId("t01-start-btn") as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId("t01-start-btn"));
    await waitFor(() => expect(screen.getByLabelText("第 1 条文本")).toHaveValue("初始文本 A"));

    fireEvent.change(screen.getByLabelText("第 1 条文本"), {
      target: { value: "手工校对后的重要文本 A" },
    });
    const startInput = screen.getByLabelText("第 1 条开始时间");
    fireEvent.change(startInput, { target: { value: "00:01.250" } });
    fireEvent.blur(startInput);
    expect(screen.getByTestId("t01-edited-pill")).toBeTruthy();

    const assertAIntact = () => {
      expect(screen.getByTestId("t01-source-meta")).toHaveTextContent("edited_a.wav");
      expect(screen.getByLabelText("第 1 条文本")).toHaveValue("手工校对后的重要文本 A");
      expect(screen.getByLabelText("第 1 条开始时间")).toHaveValue("00:01.250");
      expect(screen.getByTestId("t01-edited-pill")).toBeTruthy();
      const audioEl = document.querySelector(".t01-audio-player") as HTMLAudioElement | null;
      expect(audioEl?.getAttribute("src")).toContain("edited_a.wav");
    };

    const sendFromA02 = async () => {
      fireEvent.click(screen.getByTestId("nav-a02"));
      await waitFor(() => expect(screen.getByTestId("a02-save-btn")).toBeTruthy());
      fireEvent.click(screen.getByTestId("a02-save-btn"));
      await waitFor(() => expect(screen.getByTestId("a02-handoff-t01")).toBeTruthy());
      fireEvent.click(screen.getByTestId("a02-handoff-t01"));
    };

    // 2. Case (a): Reject replacement -> A's text, timestamp, and preview stay 100% intact
    await sendFromA02();
    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toHaveTextContent("替换当前手工校对内容");
    });
    fireEvent.click(screen.getByRole("button", { name: "保留旧稿" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(tauriBridge.inspectTranscribeMedia).not.toHaveBeenCalledWith(pathBMoved);
    assertAIntact();

    // 3. Case (b1): Confirm replacement, but B was moved/deleted -> inspect fails, A stays 100% intact
    await sendFromA02();
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "确认载入" }));
    await waitFor(() => {
      expect(screen.getByTestId("t01-error-banner")).toBeTruthy();
    });
    assertAIntact();

    // 4. Case (b2): Confirm replacement, but B has no audio track -> rejected before switch, A stays intact
    await sendFromA02();
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "确认载入" }));
    await waitFor(() => {
      expect(screen.getByTestId("t01-error-banner")).toHaveTextContent("不包含可转写的音轨");
    });
    assertAIntact();

    // 5. Case (c): Confirm replacement with valid audio B -> switches cleanly to B
    await sendFromA02();
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "确认载入" }));
    await waitFor(() => {
      expect(screen.getByTestId("t01-source-meta")).toHaveTextContent("valid_b.wav");
      expect(screen.queryByTestId("t01-edited-pill")).toBeNull();
    });
    const audioElB = document.querySelector(".t01-audio-player") as HTMLAudioElement | null;
    expect(audioElB?.getAttribute("src")).toContain("valid_b.wav");
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
