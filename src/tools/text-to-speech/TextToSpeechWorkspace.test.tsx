import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { SessionStoreProvider } from "../../lib/sessionStore";
import * as bridge from "../../lib/tauriBridge";
import type {
  MediaToolsStatus,
  SynthesizeTtsResult,
  TtsVoicesResponse,
} from "../../lib/tauriBridge";
import { TextToSpeechWorkspace } from "./TextToSpeechWorkspace";

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    listTtsVoices: vi.fn(),
    synthesizeTtsSpeech: vi.fn(),
    subscribeTtsProgress: vi.fn().mockResolvedValue(() => {}),
    exportTtsAudio: vi.fn(),
    clearTtsSession: vi.fn().mockResolvedValue(undefined),
    openWindowsSpeechSettings: vi.fn().mockResolvedValue(undefined),
    cancelBackendTask: vi.fn().mockResolvedValue(true),
    subscribeFileDrop: vi.fn().mockResolvedValue(() => {}),
    pickSingleFile: vi.fn(),
    pickSaveFilePath: vi.fn(),
    suggestSafeSiblingPath: vi.fn(),
    readLocalTextFile: vi.fn(),
    readSystemClipboardText: vi.fn(),
    openLocalDirectory: vi.fn(),
    getMediaToolsStatus: vi.fn(),
    subscribeMediaSetupProgress: vi.fn().mockResolvedValue(() => {}),
  };
});

const EN_ONLY_VOICES: TtsVoicesResponse = {
  voices: [
    {
      id: "winrt::zira",
      name: "Microsoft Zira",
      language: "en-US",
      gender: "female",
      engine: "winrt_one_core",
      isDefault: true,
    },
  ],
  defaultVoiceId: "winrt::zira",
  hasChineseVoice: false,
  hasEnglishVoice: true,
  winrtCount: 1,
  sapiCount: 0,
};

const BILINGUAL_VOICES: TtsVoicesResponse = {
  voices: [
    {
      id: "winrt::huihui",
      name: "Microsoft Huihui",
      language: "zh-CN",
      gender: "female",
      engine: "winrt_one_core",
      isDefault: true,
    },
    {
      id: "sapi::zira_desktop",
      name: "Microsoft Zira Desktop",
      language: "en-US",
      gender: "female",
      engine: "sapi_desktop",
      isDefault: false,
    },
  ],
  defaultVoiceId: "winrt::huihui",
  hasChineseVoice: true,
  hasEnglishVoice: true,
  winrtCount: 1,
  sapiCount: 1,
};

const SAMPLE_TTS_RESULT: SynthesizeTtsResult = {
  resultId: "tts-1",
  voiceId: "winrt::huihui",
  voiceName: "Microsoft Huihui",
  voiceLanguage: "zh-CN",
  engine: "winrt_one_core",
  rate: 1.25,
  segmentCount: 2,
  paragraphCount: 2,
  charCount: 38,
  sampleRate: 16000,
  channels: 1,
  bitsPerSample: 16,
  durationSec: 4.8,
  wavByteLength: 153644,
  previewUrl: "http://winkitmedia.localhost/preview/tts-1",
  elapsedMs: 120,
  sourcePath: null,
  supportedMp3BitratesKbps: [64, 96, 128, 160],
};

const MISSING_FFMPEG: MediaToolsStatus = {
  ready: false,
  source: "missing",
  mode: "auto",
  customDir: null,
  ffmpegPath: null,
  ffprobePath: null,
  ffmpegVersion: null,
  ffprobeVersion: null,
  installDir: "C:\\Users\\Test\\media-tools\\ffmpeg-9.1-essentials",
  managedInstalledBytes: null,
  licensePath: null,
  error: null,
  spec: {
    version: "9.1",
    sourceName: "GyanD/codexffmpeg 9.1 Essentials",
    releaseUrl: "https://github.com/GyanD/codexffmpeg/releases/tag/9.1",
    sourceCommitUrl: "https://github.com/FFmpeg/FFmpeg/commit/74e4393595",
    downloadUrl:
      "https://github.com/GyanD/codexffmpeg/releases/download/9.1/ffmpeg-9.1-essentials_build.7z",
    downloadBytes: 36_671_021,
    sha256: "835b9a733445ba7a56a37a26cf7bde84e2f3ce7da2a8ec984276bb2abb1b922c",
    estimatedInstalledBytes: 221_044_037,
    licenseName: "GNU GPL v3",
  },
};

const READY_FFMPEG: MediaToolsStatus = {
  ...MISSING_FFMPEG,
  ready: true,
  source: "managed",
  ffmpegPath: "C:\\Users\\Test\\media-tools\\ffmpeg.exe",
  ffprobePath: "C:\\Users\\Test\\media-tools\\ffprobe.exe",
  ffmpegVersion: "9.1",
  ffprobeVersion: "9.1",
};

function renderWorkspace() {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
      <SessionStoreProvider>
        <TextToSpeechWorkspace />
      </SessionStoreProvider>
    </I18nContext.Provider>,
  );
}

describe("TextToSpeechWorkspace (T06)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(bridge.subscribeTtsProgress).mockResolvedValue(() => {});
    vi.mocked(bridge.subscribeFileDrop).mockResolvedValue(() => {});
    vi.mocked(bridge.subscribeMediaSetupProgress).mockResolvedValue(() => {});
    vi.mocked(bridge.cancelBackendTask).mockResolvedValue(true);
    vi.mocked(bridge.clearTtsSession).mockResolvedValue(undefined);
    vi.mocked(bridge.openWindowsSpeechSettings).mockResolvedValue(undefined);
    vi.mocked(bridge.getMediaToolsStatus).mockResolvedValue(MISSING_FFMPEG);
  });

  it("shows missing Chinese voice guidance with ms-settings:speech action when only non-Chinese voices exist", async () => {
    const user = userEvent.setup();
    vi.mocked(bridge.listTtsVoices).mockResolvedValue(EN_ONLY_VOICES);

    renderWorkspace();

    await waitFor(() => {
      expect(screen.getByTestId("t06-voice-guidance")).toBeInTheDocument();
    });
    expect(screen.getByTestId("t06-voice-guidance")).toHaveTextContent("尚未安装中文离线语音");

    await user.click(screen.getByTestId("t06-open-speech-settings-btn"));
    expect(bridge.openWindowsSpeechSettings).toHaveBeenCalledTimes(1);
  });

  it("synthesizes pasted text, auditions inline, exports offline WAV without FFmpeg, and gates MP3 on FFmpeg", async () => {
    const user = userEvent.setup();
    vi.mocked(bridge.listTtsVoices).mockResolvedValue(BILINGUAL_VOICES);
    vi.mocked(bridge.synthesizeTtsSpeech).mockResolvedValue(SAMPLE_TTS_RESULT);
    vi.mocked(bridge.pickSaveFilePath).mockResolvedValue("C:\\Out\\speech.wav");
    vi.mocked(bridge.exportTtsAudio).mockResolvedValue({
      outputPath: "C:\\Out\\speech.wav",
      format: "wav",
      durationSec: 4.8,
      sampleRate: 16000,
      channels: 1,
      bitrateKbps: null,
      byteLength: 153644,
    });

    renderWorkspace();

    await waitFor(() => {
      expect(screen.getByTestId("t06-voice-select")).toHaveValue("winrt::huihui");
    });

    await user.type(
      screen.getByTestId("t06-text-input"),
      "第一段离线文本朗读测试。\n\nSecond paragraph mixed English.",
    );
    await user.click(screen.getByTestId("t06-rate-1.25"));
    await user.click(screen.getByTestId("t06-start-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("t06-audio-player")).toBeInTheDocument();
    });
    expect(bridge.synthesizeTtsSpeech).toHaveBeenCalledWith(
      expect.stringMatching(/^t06-tts-/),
      expect.objectContaining({
        voiceId: "winrt::huihui",
        rate: 1.25,
      }),
    );

    // WAV export works without FFmpeg
    expect(screen.getByTestId("t06-export-btn")).toBeEnabled();
    await user.click(screen.getByTestId("t06-export-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("t06-saved-banner")).toHaveTextContent("speech.wav");
    });

    // Switching to MP3 while FFmpeg is missing disables MP3 export
    await user.click(screen.getByTestId("t06-fmt-mp3"));
    await waitFor(() => {
      expect(screen.getByTestId("t06-export-btn")).toBeDisabled();
    });

    // Switching back to WAV immediately re-enables offline export
    await user.click(screen.getByTestId("t06-fmt-wav"));
    expect(screen.getByTestId("t06-export-btn")).toBeEnabled();
  });

  it("binds overwrite confirmation to live export snapshot and suppresses stale TARGET_ALREADY_EXISTS after format change", async () => {
    const user = userEvent.setup();
    vi.mocked(bridge.listTtsVoices).mockResolvedValue(BILINGUAL_VOICES);
    vi.mocked(bridge.getMediaToolsStatus).mockResolvedValue(READY_FFMPEG);
    vi.mocked(bridge.synthesizeTtsSpeech).mockResolvedValue(SAMPLE_TTS_RESULT);
    vi.mocked(bridge.pickSaveFilePath).mockResolvedValue("C:\\Out\\existing.wav");

    let rejectFirstExport!: (reason?: unknown) => void;
    vi.mocked(bridge.exportTtsAudio)
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectFirstExport = reject;
          }),
      )
      .mockRejectedValueOnce({ code: "TARGET_ALREADY_EXISTS", message: "Exists" })
      .mockResolvedValueOnce({
        outputPath: "C:\\Out\\existing.wav",
        format: "wav",
        durationSec: 4.8,
        sampleRate: 16000,
        channels: 1,
        bitrateKbps: null,
        byteLength: 153644,
      });

    renderWorkspace();
    await waitFor(() => {
      expect(screen.getByTestId("t06-voice-select")).toHaveValue("winrt::huihui");
    });
    await user.type(screen.getByTestId("t06-text-input"), "覆盖确认绑定测试。");
    await user.click(screen.getByTestId("t06-start-btn"));
    await waitFor(() => expect(screen.getByTestId("t06-export-btn")).toBeEnabled());

    // Start WAV export, then switch to MP3 while backend export is in-flight
    await user.click(screen.getByTestId("t06-export-btn"));
    await waitFor(() => expect(bridge.exportTtsAudio).toHaveBeenCalledTimes(1));
    await user.click(screen.getByTestId("t06-fmt-mp3"));
    rejectFirstExport({ code: "TARGET_ALREADY_EXISTS", message: "Exists" });
    await waitFor(() => {
      expect(screen.getByTestId("t06-bitrate-160")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("t06-bitrate-192")).not.toBeInTheDocument();
    expect(screen.queryByTestId("t06-bitrate-256")).not.toBeInTheDocument();
    expect(screen.queryByText("覆盖已存在的音频文件？")).not.toBeInTheDocument();

    // Switch back to WAV, hit TARGET_ALREADY_EXISTS cleanly, and confirm overwrite
    await user.click(screen.getByTestId("t06-fmt-wav"));
    await user.click(screen.getByTestId("t06-export-btn"));
    await waitFor(() => {
      expect(screen.getByText("覆盖已存在的音频文件？")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "确认覆盖" }));
    await waitFor(() => {
      expect(screen.getByTestId("t06-saved-banner")).toBeInTheDocument();
    });
    expect(vi.mocked(bridge.exportTtsAudio).mock.calls.at(-1)?.[0]).toMatchObject({
      resultId: "tts-1",
      outputPath: "C:\\Out\\existing.wav",
      format: "wav",
      overwrite: true,
    });
  });

  it("cancels mid-synthesis, recovers for retry, cleans up on clear, and preserves session across navigation", async () => {
    const user = userEvent.setup();
    vi.mocked(bridge.listTtsVoices).mockResolvedValue(BILINGUAL_VOICES);

    let rejectFirst!: (reason?: unknown) => void;
    vi.mocked(bridge.synthesizeTtsSpeech)
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce(SAMPLE_TTS_RESULT);

    const renderView = (showTool: boolean) => (
      <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: () => {} }}>
        <SessionStoreProvider>
          {showTool ? <TextToSpeechWorkspace /> : <div>Other Tool</div>}
        </SessionStoreProvider>
      </I18nContext.Provider>
    );

    const { rerender } = render(renderView(true));
    await waitFor(() => {
      expect(screen.getByTestId("t06-voice-select")).toHaveValue("winrt::huihui");
    });

    await user.type(screen.getByTestId("t06-text-input"), "第一段。\n\n第二段。");
    await user.click(screen.getByTestId("t06-start-btn"));
    await waitFor(() => expect(screen.getByTestId("t06-cancel-btn")).toBeInTheDocument());

    // Cancel mid-synthesis
    await user.click(screen.getByTestId("t06-cancel-btn"));
    expect(bridge.cancelBackendTask).toHaveBeenCalledTimes(1);
    rejectFirst({ code: "TASK_CANCELLED", message: "Cancelled" });
    await waitFor(() => expect(screen.getByTestId("t06-start-btn")).toBeEnabled());

    // Immediate retry succeeds
    await user.click(screen.getByTestId("t06-start-btn"));
    await waitFor(() => expect(screen.getByTestId("t06-audio-player")).toBeInTheDocument());

    // Navigate away and return -> text & audition result preserved
    rerender(renderView(false));
    expect(screen.getByText("Other Tool")).toBeInTheDocument();
    rerender(renderView(true));
    await waitFor(() => expect(screen.getByTestId("t06-audio-player")).toBeInTheDocument());
    expect(screen.getByTestId("t06-text-input")).toHaveValue("第一段。\n\n第二段。");

    // Clear resets UI and calls clearTtsSession
    await user.click(screen.getByTestId("t06-clear-btn"));
    expect(bridge.clearTtsSession).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("t06-text-input")).toHaveValue("");
    expect(screen.queryByTestId("t06-audio-player")).not.toBeInTheDocument();
  });

  it("keeps running synthesis intact when dropping an unreadable TXT and allows subsequent synthesis and export", async () => {
    const user = userEvent.setup();
    vi.mocked(bridge.listTtsVoices).mockResolvedValue(BILINGUAL_VOICES);

    let onDropPaths!: (paths: string[]) => void;
    vi.mocked(bridge.subscribeFileDrop).mockImplementation(async ({ onDropPaths: cb }) => {
      onDropPaths = cb;
      return () => {};
    });

    let resolveFirstSynth!: (value: SynthesizeTtsResult) => void;
    vi.mocked(bridge.synthesizeTtsSpeech)
      .mockImplementationOnce(
        () =>
          new Promise<SynthesizeTtsResult>((resolve) => {
            resolveFirstSynth = resolve;
          }),
      )
      .mockResolvedValueOnce({
        ...SAMPLE_TTS_RESULT,
        resultId: "tts-2",
      });

    vi.mocked(bridge.readLocalTextFile).mockRejectedValueOnce({
      code: "PERMISSION_DENIED",
      message: "Unreadable TXT",
    });
    vi.mocked(bridge.pickSaveFilePath).mockResolvedValue("C:\\Out\\after_failed_drop.wav");
    vi.mocked(bridge.exportTtsAudio).mockResolvedValue({
      outputPath: "C:\\Out\\after_failed_drop.wav",
      format: "wav",
      durationSec: 4.8,
      sampleRate: 16000,
      channels: 1,
      bitrateKbps: null,
      byteLength: 153644,
    });

    renderWorkspace();
    await waitFor(() => {
      expect(screen.getByTestId("t06-voice-select")).toHaveValue("winrt::huihui");
    });

    await user.type(screen.getByTestId("t06-text-input"), "正在合成中的原始稿件。");
    await user.click(screen.getByTestId("t06-start-btn"));
    await waitFor(() => expect(screen.getByTestId("t06-cancel-btn")).toBeInTheDocument());

    // Drop unreadable TXT while synthesis is running
    onDropPaths(["C:\\Docs\\unreadable.txt"]);
    await waitFor(() => {
      expect(screen.getByTestId("t06-error-banner")).toBeInTheDocument();
    });
    // Original draft & active running task must remain untouched (no cancel sent!)
    expect(screen.getByTestId("t06-text-input")).toHaveValue("正在合成中的原始稿件。");
    expect(screen.getByTestId("t06-cancel-btn")).toBeInTheDocument();
    expect(bridge.cancelBackendTask).not.toHaveBeenCalled();

    // Original synthesis completes cleanly and releases running state
    resolveFirstSynth(SAMPLE_TTS_RESULT);
    await waitFor(() => {
      expect(screen.getByTestId("t06-audio-player")).toBeInTheDocument();
      expect(screen.getByTestId("t06-start-btn")).toBeEnabled();
      expect(screen.getByTestId("t06-export-btn")).toBeEnabled();
    });

    // Subsequent re-synthesis and export both succeed
    await user.click(screen.getByTestId("t06-start-btn"));
    await waitFor(() => expect(bridge.synthesizeTtsSpeech).toHaveBeenCalledTimes(2));
    await user.click(screen.getByTestId("t06-export-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("t06-saved-banner")).toHaveTextContent("after_failed_drop.wav");
    });
  });

  it("shows only supported MP3 bitrate tiers for the audio sample rate and reports real probed parameters", async () => {
    const user = userEvent.setup();
    vi.mocked(bridge.listTtsVoices).mockResolvedValue(BILINGUAL_VOICES);
    vi.mocked(bridge.getMediaToolsStatus).mockResolvedValue(READY_FFMPEG);
    vi.mocked(bridge.synthesizeTtsSpeech).mockResolvedValue({
      ...SAMPLE_TTS_RESULT,
      sampleRate: 22050,
      supportedMp3BitratesKbps: [64, 96, 128, 160],
    });
    vi.mocked(bridge.pickSaveFilePath).mockResolvedValue("C:\\Out\\speech_160.mp3");
    vi.mocked(bridge.exportTtsAudio).mockResolvedValue({
      outputPath: "C:\\Out\\speech_160.mp3",
      format: "mp3",
      durationSec: 4.8,
      sampleRate: 22050,
      channels: 1,
      bitrateKbps: 160,
      byteLength: 96420,
    });

    renderWorkspace();
    await waitFor(() => {
      expect(screen.getByTestId("t06-voice-select")).toHaveValue("winrt::huihui");
    });
    await user.type(screen.getByTestId("t06-text-input"), "MP3 档位与回读参数验证。");
    await user.click(screen.getByTestId("t06-start-btn"));
    await waitFor(() => expect(screen.getByTestId("t06-audio-player")).toBeInTheDocument());

    await user.click(screen.getByTestId("t06-fmt-mp3"));
    expect(screen.getByTestId("t06-bitrate-64")).toBeInTheDocument();
    expect(screen.getByTestId("t06-bitrate-96")).toBeInTheDocument();
    expect(screen.getByTestId("t06-bitrate-128")).toBeInTheDocument();
    expect(screen.getByTestId("t06-bitrate-160")).toBeInTheDocument();
    expect(screen.queryByTestId("t06-bitrate-192")).not.toBeInTheDocument();
    expect(screen.queryByTestId("t06-bitrate-256")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("t06-bitrate-160"));
    await user.click(screen.getByTestId("t06-export-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("t06-saved-banner")).toHaveTextContent("22.05 kHz");
      expect(screen.getByTestId("t06-saved-banner")).toHaveTextContent("160 kbps");
    });
    expect(bridge.exportTtsAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        format: "mp3",
        mp3BitrateKbps: 160,
      }),
    );
  });

  it("blocks exporting old audio onto original A.txt after pasting replacement text without popping overwrite dialog", async () => {
    const user = userEvent.setup();
    vi.mocked(bridge.listTtsVoices).mockResolvedValue(BILINGUAL_VOICES);
    vi.mocked(bridge.pickSingleFile).mockResolvedValue("C:\\Docs\\A.txt");
    vi.mocked(bridge.readLocalTextFile).mockResolvedValue({
      path: "C:\\Docs\\A.txt",
      fileName: "A.txt",
      byteLength: 24,
      content: "Original file A content.",
    });
    vi.mocked(bridge.synthesizeTtsSpeech).mockResolvedValue({
      ...SAMPLE_TTS_RESULT,
      sourcePath: "C:\\Docs\\A.txt",
    });
    vi.mocked(bridge.readSystemClipboardText).mockResolvedValue("Pasted replacement text.");
    vi.mocked(bridge.pickSaveFilePath).mockResolvedValue("C:\\Docs\\A.txt");
    vi.mocked(bridge.exportTtsAudio).mockRejectedValue({
      code: "SAME_INPUT_AND_OUTPUT",
      message: "Output path cannot overwrite the source file.",
    });

    renderWorkspace();
    await waitFor(() => {
      expect(screen.getByTestId("t06-voice-select")).toHaveValue("winrt::huihui");
    });

    // Import A.txt -> Synthesize
    await user.click(screen.getByTestId("t06-open-txt-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("t06-source-file-badge")).toHaveTextContent("A.txt");
    });
    await user.click(screen.getByTestId("t06-start-btn"));
    await waitFor(() => expect(screen.getByTestId("t06-audio-player")).toBeInTheDocument());
    expect(bridge.synthesizeTtsSpeech).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ sourcePath: "C:\\Docs\\A.txt" }),
    );

    // Click Paste -> replaces text and clears editor sourceFilePath
    await user.click(screen.getByTestId("t06-paste-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("t06-text-input")).toHaveValue("Pasted replacement text.");
    });
    expect(screen.queryByTestId("t06-source-file-badge")).not.toBeInTheDocument();

    // Try saving old audio onto A.txt -> rejected immediately, no overwrite dialog
    await user.click(screen.getByTestId("t06-export-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("t06-error-banner")).toBeInTheDocument();
    });
    expect(screen.queryByText("覆盖已存在的音频文件？")).not.toBeInTheDocument();
  });
});
