import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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

  it("prompts before re-transcribing edited cues, locks editing while running, and preserves edits on cancel or failure", async () => {
    const user = userEvent.setup();
    vi.mocked(bridge.pickSingleFile).mockResolvedValue("D:\\audio\\meeting.wav");
    vi.mocked(bridge.inspectTranscribeMedia).mockResolvedValue({
      path: "D:\\audio\\meeting.wav",
      fileName: "meeting.wav",
      byteLength: 128_000,
      isWavNative: true,
      requiresFfmpeg: false,
      hasAudio: true,
      hasVideo: false,
      durationSec: 8.0,
      audioStartTimeSec: 0,
      audioCodec: "pcm_s16le",
      sampleRate: 16_000,
      channels: 1,
      containerFormat: "wav",
    });

    const firstResult: bridge.TranscribeMediaResult = {
      inputPath: "D:\\audio\\meeting.wav",
      fileName: "meeting.wav",
      durationSec: 8.0,
      timelineOffsetSec: 0,
      decodedWithFfmpeg: false,
      engineName: "SenseVoiceSmall INT8",
      segments: [{ id: 1, startSec: 0.5, endSec: 4.5, text: "原始转写", language: "zh" }],
      fullText: "原始转写",
      detectedLanguages: ["zh"],
      speechDurationSec: 4.0,
      elapsedMs: 200,
      rtf: 0.025,
      warnings: [],
    };
    let rejectSecond!: (err: unknown) => void;
    const secondRun = new Promise<bridge.TranscribeMediaResult>((_, rej) => {
      rejectSecond = rej;
    });
    const thirdResult: bridge.TranscribeMediaResult = {
      ...firstResult,
      segments: [{ id: 1, startSec: 0.5, endSec: 4.5, text: "全新转写结果", language: "zh" }],
      fullText: "全新转写结果",
    };

    vi.mocked(bridge.transcribeMedia)
      .mockResolvedValueOnce(firstResult)
      .mockImplementationOnce(() => secondRun)
      .mockResolvedValueOnce(thirdResult);

    renderWorkspace();
    await waitFor(() => expect(screen.getByTestId("asr-model-compact-bar")).toBeInTheDocument());
    await user.click(screen.getByTestId("t01-dropzone"));
    await waitFor(() => expect(screen.getByTestId("t01-start-btn")).not.toBeDisabled());
    await user.click(screen.getByTestId("t01-start-btn"));
    await waitFor(() => expect(screen.getByLabelText("第 1 条文本")).toHaveValue("原始转写"));

    // Manually edit cue #1 (including blank and full-width-space lines to verify Copy SRT sanitization too)
    const textBox = screen.getByLabelText("第 1 条文本");
    fireEvent.change(textBox, {
      target: { value: "手工校对第一行\n\n   \n\u3000\nManual line 2" },
    });
    expect(screen.getByTestId("t01-edited-pill")).toBeInTheDocument();

    // Copy SRT must match Rust sanitization rules
    await user.click(screen.getByTestId("t01-copy-srt-btn"));
    expect(bridge.writeSystemClipboardText).toHaveBeenCalledWith(
      "1\r\n00:00:00,500 --> 00:00:04,500\r\n手工校对第一行\r\nManual line 2\r\n\r\n",
    );

    // Click Re-transcribe -> confirm dialog MUST appear before backend starts
    await user.click(screen.getByTestId("t01-start-btn"));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("替换当前手工校对内容");
    expect(bridge.transcribeMedia).toHaveBeenCalledTimes(1);

    // Cancel confirmation -> backend still not called
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(bridge.transcribeMedia).toHaveBeenCalledTimes(1);

    // Click Re-transcribe again and confirm -> editing & export controls lock while running
    await user.click(screen.getByTestId("t01-start-btn"));
    await user.click(screen.getByRole("button", { name: "继续重新转写" }));
    await waitFor(() => {
      expect(screen.getByTestId("t01-edit-locked-banner")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("第 1 条文本")).toBeDisabled();
    expect(screen.getByLabelText("第 1 条开始时间")).toBeDisabled();
    expect(screen.getByTestId("t01-export-srt-btn")).toBeDisabled();
    expect(screen.getByTestId("t01-copy-srt-btn")).toBeDisabled();

    // Simulate task cancellation / failure -> manual edits MUST be preserved!
    await act(async () => {
      rejectSecond({ code: "CANCELLED", message: "Cancelled by user" });
    });
    await waitFor(() => {
      expect(screen.getByTestId("t01-error-banner")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("第 1 条文本")).not.toBeDisabled();
    expect(screen.getByLabelText("第 1 条文本")).toHaveValue(
      "手工校对第一行\n\n   \n\u3000\nManual line 2",
    );
    expect(screen.getByTestId("t01-edited-pill")).toBeInTheDocument();

    // Re-transcribe and succeed -> replaces old edits cleanly and clears edited pill
    await user.click(screen.getByTestId("t01-start-btn"));
    await user.click(screen.getByRole("button", { name: "继续重新转写" }));
    await waitFor(() => {
      expect(screen.getByLabelText("第 1 条文本")).toHaveValue("全新转写结果");
    });
    expect(screen.queryByTestId("t01-edited-pill")).not.toBeInTheDocument();
  });

  it("preserves inspect, running lock, and manual edits when leaving T01 and re-entering", async () => {
    const user = userEvent.setup();
    let resolveInspect!: (val: bridge.TranscribeMediaInspectResult) => void;
    let resolveAsr!: (val: bridge.TranscribeMediaResult) => void;

    vi.mocked(bridge.pickSingleFile).mockResolvedValue("D:\\audio\\stay.wav");
    vi.mocked(bridge.inspectTranscribeMedia).mockImplementation(
      () =>
        new Promise((res) => {
          resolveInspect = res;
        }),
    );
    vi.mocked(bridge.transcribeMedia).mockImplementation(
      () =>
        new Promise((res) => {
          resolveAsr = res;
        }),
    );

    function TabShell() {
      const [active, setActive] = useState(true);
      return (
        <I18nContext.Provider
          value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}
        >
          <MediaSessionProvider>
            <button type="button" data-testid="toggle-tab" onClick={() => setActive((v) => !v)}>
              Toggle
            </button>
            {active ? <TranscribeMediaWorkspace /> : <div data-testid="other-tab">Other</div>}
          </MediaSessionProvider>
        </I18nContext.Provider>
      );
    }

    render(<TabShell />);
    await waitFor(() => expect(screen.getByTestId("asr-model-compact-bar")).toBeInTheDocument());

    // Start loading A, then leave T01 while inspect is still in flight
    await user.click(screen.getByTestId("t01-dropzone"));
    await user.click(screen.getByTestId("toggle-tab"));
    expect(screen.getByTestId("other-tab")).toBeInTheDocument();

    // Resolve inspect while unmounted, then return to T01 -> metadata MUST be intact!
    await act(async () => {
      resolveInspect({
        path: "D:\\audio\\stay.wav",
        fileName: "stay.wav",
        byteLength: 64_000,
        isWavNative: true,
        requiresFfmpeg: false,
        hasAudio: true,
        hasVideo: false,
        durationSec: 5.0,
        audioStartTimeSec: 0,
        audioCodec: "pcm_s16le",
        sampleRate: 16_000,
        channels: 1,
        containerFormat: "wav",
      });
    });

    await user.click(screen.getByTestId("toggle-tab"));
    await waitFor(() => {
      expect(screen.getByTestId("t01-source-meta")).toHaveTextContent("stay.wav");
      expect(screen.getByTestId("t01-start-btn")).not.toBeDisabled();
    });

    // Start transcription, leave T01 while running, return while still running, then finish
    await user.click(screen.getByTestId("t01-start-btn"));
    await user.click(screen.getByTestId("toggle-tab"));
    await user.click(screen.getByTestId("toggle-tab"));
    expect(screen.getByTestId("t01-cancel-btn")).toBeInTheDocument();

    await act(async () => {
      resolveAsr({
        inputPath: "D:\\audio\\stay.wav",
        fileName: "stay.wav",
        durationSec: 5.0,
        timelineOffsetSec: 0,
        decodedWithFfmpeg: false,
        engineName: "SenseVoiceSmall INT8",
        segments: [{ id: 1, startSec: 0.2, endSec: 2.0, text: "切页后完成", language: "zh" }],
        fullText: "切页后完成",
        detectedLanguages: ["zh"],
        speechDurationSec: 1.8,
        elapsedMs: 150,
        rtf: 0.03,
        warnings: [],
      });
    });

    await waitFor(() => {
      expect(screen.getByLabelText("第 1 条文本")).toHaveValue("切页后完成");
    });
  });

  it("prevents stale export results from attaching media A's V02 handoff button to media B", async () => {
    const user = userEvent.setup();
    vi.mocked(bridge.pickSingleFile).mockResolvedValue("D:\\audio\\media_a.wav");
    vi.mocked(bridge.inspectTranscribeMedia)
      .mockResolvedValueOnce({
        path: "D:\\audio\\media_a.wav",
        fileName: "media_a.wav",
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
      })
      .mockResolvedValueOnce({
        path: "D:\\audio\\media_b.wav",
        fileName: "media_b.wav",
        byteLength: 96_000,
        isWavNative: true,
        requiresFfmpeg: false,
        hasAudio: true,
        hasVideo: false,
        durationSec: 6.0,
        audioStartTimeSec: 0,
        audioCodec: "pcm_s16le",
        sampleRate: 16_000,
        channels: 1,
        containerFormat: "wav",
      });
    vi.mocked(bridge.transcribeMedia).mockResolvedValue({
      inputPath: "D:\\audio\\media_a.wav",
      fileName: "media_a.wav",
      durationSec: 4.0,
      timelineOffsetSec: 0,
      decodedWithFfmpeg: false,
      engineName: "SenseVoiceSmall INT8",
      segments: [{ id: 1, startSec: 0.2, endSec: 2.5, text: "Audio A cue", language: "en" }],
      fullText: "Audio A cue",
      detectedLanguages: ["en"],
      speechDurationSec: 2.3,
      elapsedMs: 120,
      rtf: 0.03,
      warnings: [],
    });
    vi.mocked(bridge.pickSaveFilePath).mockResolvedValue("D:\\audio\\media_a.srt");

    let resolveExportA!: (val: bridge.ExportTranscriptResult) => void;
    vi.mocked(bridge.exportTranscriptFile).mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveExportA = res;
        }),
    );

    renderWorkspace();
    await waitFor(() => expect(screen.getByTestId("asr-model-compact-bar")).toBeInTheDocument());
    await user.click(screen.getByTestId("t01-dropzone"));
    await waitFor(() => expect(screen.getByTestId("t01-start-btn")).not.toBeDisabled());
    await user.click(screen.getByTestId("t01-start-btn"));
    await waitFor(() => expect(screen.getByTestId("t01-export-srt-btn")).not.toBeDisabled());

    // Begin exporting A (stays pending)
    await user.click(screen.getByTestId("t01-export-srt-btn"));
    await waitFor(() => expect(bridge.exportTranscriptFile).toHaveBeenCalledTimes(1));

    // Switch rapidly to media B via file drop while export A is still in flight
    const dropCb = vi.mocked(bridge.subscribeFileDrop).mock.calls.at(-1)?.[0];
    expect(dropCb).toBeDefined();
    await act(async () => {
      dropCb!.onDropPaths(["D:\\audio\\media_b.wav"]);
    });
    await waitFor(() => {
      expect(screen.getByTestId("t01-source-meta")).toHaveTextContent("media_b.wav");
    });

    // Late export A finishes -> MUST NOT attach A's export banner or V02 handoff button to B!
    await act(async () => {
      resolveExportA({
        outputPath: "D:\\audio\\media_a.srt",
        byteSize: 80,
        segmentCount: 1,
        format: "srt",
      });
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId("t01-export-success")).not.toBeInTheDocument();
    expect(screen.queryByTestId("t01-send-v02-btn")).not.toBeInTheDocument();
  });

  it("shows explicit 512 MiB WAV FFmpeg dependency prompt and disables Start when FFmpeg is absent", async () => {
    const user = userEvent.setup();
    vi.mocked(bridge.pickSingleFile).mockResolvedValue("D:\\audio\\huge_540mb.wav");
    vi.mocked(bridge.inspectTranscribeMedia).mockResolvedValue({
      path: "D:\\audio\\huge_540mb.wav",
      fileName: "huge_540mb.wav",
      byteLength: 540 * 1024 * 1024,
      isWavNative: false,
      requiresFfmpeg: true,
      hasAudio: true,
      hasVideo: false,
      durationSec: 2950.0,
      audioStartTimeSec: 0,
      audioCodec: "pcm_s16le",
      sampleRate: 48_000,
      channels: 2,
      containerFormat: "wav",
    });

    renderWorkspace();
    await waitFor(() => expect(screen.getByTestId("asr-model-compact-bar")).toBeInTheDocument());
    await user.click(screen.getByTestId("t01-dropzone"));

    await waitFor(() => {
      expect(screen.getByTestId("t01-ffmpeg-required-banner")).toHaveTextContent("512 MiB");
    });
    expect(screen.getByTestId("t01-start-btn")).toBeDisabled();
  });
});
