import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { MediaSessionProvider } from "../../lib/mediaSessionStore";
import * as bridge from "../../lib/tauriBridge";
import { TranscribeMediaWorkspace } from "./TranscribeMediaWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    getAsrModelStatus: vi.fn(),
    getMediaToolsStatus: vi.fn(),
    inspectTranscribeMedia: vi.fn(),
    registerMediaPreviewPath: vi.fn(),
    transcribeMedia: vi.fn(),
    exportTranscriptFile: vi.fn(),
    pickSingleFile: vi.fn(),
    pickSaveFilePath: vi.fn(),
    subscribeFileDrop: vi.fn(async () => () => {}),
    subscribeAsrProgress: vi.fn(async () => () => {}),
    subscribeAsrSetupProgress: vi.fn(async () => () => {}),
    subscribeMediaSetupProgress: vi.fn(async () => () => {}),
    subscribeMediaTaskProgress: vi.fn(async () => () => {}),
    writeSystemClipboardText: vi.fn(async () => {}),
    openLocalDirectory: vi.fn(async () => {}),
  };
});

const READY_ASR_STATUS: bridge.AsrModelStatus = {
  ready: true,
  runtimeReady: true,
  source: "managed",
  mode: "managed",
  customDir: null,
  installDir:
    "C:\\Users\\Test\\AppData\\Local\\com.luckylivio.winkit\\asr-models\\sensevoice-small-int8-v20240717",
  activeModelDir:
    "C:\\Users\\Test\\AppData\\Local\\com.luckylivio.winkit\\asr-models\\sensevoice-small-int8-v20240717",
  installedBytes: 241_862_836,
  licensePath: null,
  error: null,
  spec: {
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
  },
};

const MISSING_FFMPEG_STATUS: bridge.MediaToolsStatus = {
  ready: false,
  source: "missing",
  mode: "auto",
  customDir: null,
  ffmpegPath: null,
  ffprobePath: null,
  ffmpegVersion: null,
  ffprobeVersion: null,
  installDir: "C:\\Users\\Test\\AppData\\Local\\com.luckylivio.winkit\\media-tools",
  managedInstalledBytes: null,
  licensePath: null,
  error: null,
  spec: {
    version: "9.1",
    sourceName: "GyanD",
    releaseUrl: "https://example.invalid",
    sourceCommitUrl: "https://example.invalid",
    downloadUrl: "https://example.invalid/ffmpeg.7z",
    downloadBytes: 36_671_021,
    sha256: "835b9a73",
    estimatedInstalledBytes: 221_044_037,
    licenseName: "GNU GPL v3",
  },
};

function renderWorkspace(onNavigate?: (toolId: string) => void) {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
      <MediaSessionProvider onNavigateToTool={onNavigate}>
        <TranscribeMediaWorkspace />
      </MediaSessionProvider>
    </I18nContext.Provider>,
  );
}

describe("TranscribeMediaWorkspace (T01)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(bridge.getAsrModelStatus).mockResolvedValue(READY_ASR_STATUS);
    vi.mocked(bridge.getMediaToolsStatus).mockResolvedValue(MISSING_FFMPEG_STATUS);
    vi.mocked(bridge.registerMediaPreviewPath).mockResolvedValue({
      token: "tok1",
      url: "winkitmedia://localhost/tok1",
      mimeType: "audio/wav",
      byteLength: 32_000,
      fileName: "meeting.wav",
    });
  });

  it("runs native WAV transcription without FFmpeg, validates subtitle order, protects source path, and hands SRT to V02", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();

    vi.mocked(bridge.pickSingleFile).mockResolvedValue("D:\\测试 音频\\meeting.wav");
    vi.mocked(bridge.inspectTranscribeMedia).mockResolvedValue({
      path: "D:\\测试 音频\\meeting.wav",
      fileName: "meeting.wav",
      byteLength: 320_000,
      isWavNative: true,
      requiresFfmpeg: false,
      hasAudio: true,
      hasVideo: false,
      durationSec: 12.5,
      audioStartTimeSec: 0,
      audioCodec: "pcm_s16le",
      sampleRate: 16_000,
      channels: 1,
      containerFormat: "wav",
    });
    vi.mocked(bridge.transcribeMedia).mockResolvedValue({
      inputPath: "D:\\测试 音频\\meeting.wav",
      fileName: "meeting.wav",
      durationSec: 12.5,
      timelineOffsetSec: 0,
      decodedWithFfmpeg: false,
      engineName: "SenseVoiceSmall INT8 + Silero VAD v5",
      segments: [
        { id: 1, startSec: 0.5, endSec: 4.5, text: "欢迎使用 WinKit", language: "zh" },
        {
          id: 2,
          startSec: 5.0,
          endSec: 9.2,
          text: "All processing stays offline.",
          language: "en",
        },
      ],
      fullText: "欢迎使用 WinKit\nAll processing stays offline.",
      detectedLanguages: ["zh", "en"],
      speechDurationSec: 8.2,
      elapsedMs: 420,
      rtf: 0.0336,
      warnings: [],
    });
    vi.mocked(bridge.pickSaveFilePath).mockResolvedValue("D:\\测试 音频\\meeting.srt");
    vi.mocked(bridge.exportTranscriptFile).mockResolvedValue({
      outputPath: "D:\\测试 音频\\meeting.srt",
      byteSize: 128,
      segmentCount: 2,
      format: "srt",
    });

    renderWorkspace(onNavigate);

    // Wait for ASR model status to load
    await waitFor(() => {
      expect(screen.getByTestId("asr-model-compact-bar")).toBeInTheDocument();
    });

    // Pick native WAV even though FFmpeg is missing -> Start button MUST be enabled!
    await user.click(screen.getByTestId("t01-dropzone"));
    await waitFor(() => {
      expect(screen.getByTestId("t01-source-meta")).toHaveTextContent("meeting.wav");
    });
    expect(screen.getByTestId("t01-start-btn")).not.toBeDisabled();

    // Run transcription
    await user.click(screen.getByTestId("t01-start-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("t01-segment-row-0")).toBeInTheDocument();
      expect(screen.getByTestId("t01-segment-row-1")).toBeInTheDocument();
    });

    // Break subtitle order by setting cue #2 start to 00:02.000 (overlaps cue #1)
    const cue2Start = screen.getByLabelText("第 2 条开始时间");
    fireEvent.change(cue2Start, { target: { value: "00:02.000" } });
    fireEvent.blur(cue2Start);

    await waitFor(() => {
      expect(screen.getByTestId("t01-order-warning")).toBeInTheDocument();
      expect(screen.getByTestId("t01-export-srt-btn")).toBeDisabled();
    });

    // Click auto-fix -> SRT export re-enables
    await user.click(screen.getByTestId("t01-autofix-order-btn"));
    await waitFor(() => {
      expect(screen.queryByTestId("t01-order-warning")).not.toBeInTheDocument();
      expect(screen.getByTestId("t01-export-srt-btn")).not.toBeDisabled();
    });

    // Export SRT and check forbiddenSourcePaths contains original media
    await user.click(screen.getByTestId("t01-export-srt-btn"));
    await waitFor(() => {
      expect(bridge.exportTranscriptFile).toHaveBeenCalledWith(
        expect.objectContaining({
          outputPath: "D:\\测试 音频\\meeting.srt",
          format: "srt",
          forbiddenSourcePaths: ["D:\\测试 音频\\meeting.wav"],
          overwrite: false,
        }),
      );
    });

    // Handoff SRT cleanly to V02
    const sendV02Btn = await screen.findByTestId("t01-send-v02-btn");
    await user.click(sendV02Btn);
    expect(onNavigate).toHaveBeenCalledWith("V02");
  });

  it("invalidates pending overwrite confirmation if transcript text changes before confirm", async () => {
    const user = userEvent.setup();
    vi.mocked(bridge.pickSingleFile).mockResolvedValue("D:\\audio\\a.wav");
    vi.mocked(bridge.inspectTranscribeMedia).mockResolvedValue({
      path: "D:\\audio\\a.wav",
      fileName: "a.wav",
      byteLength: 64_000,
      isWavNative: true,
      requiresFfmpeg: false,
      hasAudio: true,
      hasVideo: false,
      durationSec: 4.0,
      audioStartTimeSec: 0,
      audioCodec: "pcm_s16le",
      sampleRate: 16_000,
      channels: 1,
      containerFormat: "wav",
    });
    vi.mocked(bridge.transcribeMedia).mockResolvedValue({
      inputPath: "D:\\audio\\a.wav",
      fileName: "a.wav",
      durationSec: 4.0,
      timelineOffsetSec: 0,
      decodedWithFfmpeg: false,
      engineName: "SenseVoiceSmall INT8",
      segments: [{ id: 1, startSec: 0.2, endSec: 2.5, text: "Original A", language: "en" }],
      fullText: "Original A",
      detectedLanguages: ["en"],
      speechDurationSec: 2.3,
      elapsedMs: 120,
      rtf: 0.03,
      warnings: [],
    });
    vi.mocked(bridge.pickSaveFilePath).mockResolvedValue("D:\\audio\\existing.srt");
    vi.mocked(bridge.exportTranscriptFile).mockRejectedValueOnce({
      code: "TARGET_ALREADY_EXISTS",
      message: "Exists",
    });

    renderWorkspace();
    await waitFor(() => expect(screen.getByTestId("asr-model-compact-bar")).toBeInTheDocument());
    await user.click(screen.getByTestId("t01-dropzone"));
    await waitFor(() => expect(screen.getByTestId("t01-start-btn")).not.toBeDisabled());
    await user.click(screen.getByTestId("t01-start-btn"));
    await waitFor(() => expect(screen.getByTestId("t01-segment-row-0")).toBeInTheDocument());

    await user.click(screen.getByTestId("t01-export-srt-btn"));
    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });

    // Mutate transcript while dialog is open -> pending overwrite MUST auto-invalidate!
    const textBox = screen.getByLabelText("第 1 条文本");
    fireEvent.change(textBox, { target: { value: "Modified text" } });

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
  });

  it("ignores stale inspect results when Clear is clicked mid-load", async () => {
    const user = userEvent.setup();
    let resolveInspect!: (val: bridge.TranscribeMediaInspectResult) => void;
    vi.mocked(bridge.pickSingleFile).mockResolvedValue("D:\\audio\\slow.wav");
    vi.mocked(bridge.inspectTranscribeMedia).mockImplementation(
      () =>
        new Promise((res) => {
          resolveInspect = res;
        }),
    );

    renderWorkspace();
    await waitFor(() => expect(screen.getByTestId("asr-model-compact-bar")).toBeInTheDocument());
    await user.click(screen.getByTestId("t01-dropzone"));

    // Resolve slow inspect only after another dropzone load? Wait: Clear button shows when inspect is ready,
    // so simulate rapid drop A then B via subscribeFileDrop!
    const dropCb = vi.mocked(bridge.subscribeFileDrop).mock.calls[0]?.[0];
    expect(dropCb).toBeDefined();

    let resolveB!: (val: bridge.TranscribeMediaInspectResult) => void;
    vi.mocked(bridge.inspectTranscribeMedia).mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveB = res;
        }),
    );

    await act(async () => {
      dropCb!.onDropPaths(["D:\\audio\\fast_b.wav"]);
      resolveB({
        path: "D:\\audio\\fast_b.wav",
        fileName: "fast_b.wav",
        byteLength: 10_000,
        isWavNative: true,
        requiresFfmpeg: false,
        hasAudio: true,
        hasVideo: false,
        durationSec: 2.0,
        audioStartTimeSec: 0,
        audioCodec: "pcm_s16le",
        sampleRate: 16_000,
        channels: 1,
        containerFormat: "wav",
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("t01-source-meta")).toHaveTextContent("fast_b.wav");
    });

    // Late A result arrives -> MUST be ignored!
    await act(async () => {
      resolveInspect({
        path: "D:\\audio\\slow.wav",
        fileName: "slow.wav",
        byteLength: 99_000,
        isWavNative: true,
        requiresFfmpeg: false,
        hasAudio: true,
        hasVideo: false,
        durationSec: 20.0,
        audioStartTimeSec: 0,
        audioCodec: "pcm_s16le",
        sampleRate: 16_000,
        channels: 1,
        containerFormat: "wav",
      });
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId("t01-source-meta")).toHaveTextContent("fast_b.wav");
    expect(screen.getByTestId("t01-source-meta")).not.toHaveTextContent("slow.wav");
  });
});
