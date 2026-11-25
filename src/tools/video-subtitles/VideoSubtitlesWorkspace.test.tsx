import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n/I18nContext";
import { MESSAGES } from "../../i18n/messages";
import { MediaSessionProvider } from "../../lib/mediaSessionStore";
import * as tauriBridge from "../../lib/tauriBridge";
import { TranscribeMediaWorkspace } from "../transcribe-media/TranscribeMediaWorkspace";
import { VideoSubtitlesWorkspace } from "./VideoSubtitlesWorkspace";

vi.mock("../../lib/tauriBridge", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/tauriBridge")>("../../lib/tauriBridge");
  return {
    ...actual,
    getMediaToolsStatus: vi.fn(),
    pickSingleFile: vi.fn(),
    pickSaveFilePath: vi.fn(),
    probeMediaInfo: vi.fn(),
    extractMediaPosterDataUrl: vi.fn(),
    parseSubtitleFile: vi.fn(),
    previewBurnedSubtitleFrame: vi.fn(),
    burnInSubtitles: vi.fn(),
    getAsrModelStatus: vi.fn(),
    installManagedAsrModel: vi.fn(),
    inspectTranscribeMedia: vi.fn(),
    registerMediaPreviewPath: vi.fn(),
    transcribeMedia: vi.fn(),
    exportTranscriptFile: vi.fn(),
    subscribeAsrProgress: vi.fn().mockResolvedValue(() => {}),
    subscribeAsrSetupProgress: vi.fn().mockResolvedValue(() => {}),
    subscribeMediaTaskProgress: vi.fn().mockResolvedValue(() => {}),
    subscribeMediaSetupProgress: vi.fn().mockResolvedValue(() => {}),
    subscribeFileDrop: vi.fn().mockResolvedValue(() => {}),
  };
});

const READY_STATUS: tauriBridge.MediaToolsStatus = {
  ready: true,
  source: "managed",
  mode: "auto",
  customDir: null,
  ffmpegPath: "C:\\Tools\\ffmpeg.exe",
  ffprobePath: "C:\\Tools\\ffprobe.exe",
  ffmpegVersion: "ffmpeg version 9.1",
  ffprobeVersion: "ffprobe version 9.1",
  installDir: "C:\\Tools",
  managedInstalledBytes: 42_000_000,
  licensePath: null,
  error: null,
  spec: {
    version: "9.1",
    sourceName: "BtbN",
    releaseUrl: "https://example.com",
    sourceCommitUrl: "https://example.com",
    downloadUrl: "https://example.com/ffmpeg.zip",
    downloadBytes: 42_000_000,
    sha256: "abc",
    estimatedInstalledBytes: 90_000_000,
    licenseName: "GPL-3.0",
  },
};

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

function makeVideoProbe(
  path: string,
  fileName: string,
  options?: { hasAudio?: boolean; width?: number; height?: number },
): tauriBridge.MediaProbeReport {
  const hasAudio = options?.hasAudio ?? true;
  const width = options?.width ?? 1280;
  const height = options?.height ?? 720;
  return {
    path,
    fileName,
    byteSize: 2_500_000,
    containerFormat: "mov,mp4",
    containerLongName: "MP4",
    durationSec: 10.0,
    overallBitrateBps: 2_000_000,
    streamCount: hasAudio ? 2 : 1,
    hasVideo: true,
    hasAudio,
    videoStreams: [
      {
        index: 0,
        codecName: "h264",
        codecLongName: "H.264",
        profile: "High",
        pixelFormat: "yuv420p",
        codedWidth: width,
        codedHeight: height,
        displayWidth: width,
        displayHeight: height,
        sampleAspectRatio: "1:1",
        rotationDegrees: 0,
        orientation: height > width ? "portrait" : "landscape",
        avgFrameRate: 30,
        rFrameRate: 30,
        avgFrameRateRaw: "30/1",
        rFrameRateRaw: "30/1",
        isVariableFrameRate: false,
        bitrateBps: 1_800_000,
        colorSpace: null,
        colorTransfer: null,
        colorPrimaries: null,
        durationSec: 10.0,
      },
    ],
    audioStreams: hasAudio
      ? [
          {
            index: 1,
            audioTrackIndex: 0,
            codecName: "aac",
            codecLongName: "AAC",
            profile: "LC",
            language: null,
            title: null,
            channels: 2,
            channelLayout: "stereo",
            sampleRateHz: 48000,
            bitrateBps: 128000,
            durationSec: 10.0,
            isDefault: true,
          },
        ]
      : [],
    subtitleStreams: [],
    formatTags: {},
    summaryText: "",
    rawJson: "{}",
  };
}

function makeParsedSubtitle(
  path: string,
  fileName: string,
  format: "srt" | "web_vtt",
  cues: tauriBridge.SubtitleCue[],
): tauriBridge.ParsedSubtitleFile {
  return {
    path,
    fileName,
    format,
    cueCount: cues.length,
    totalDurationSec: cues.length > 0 ? cues[cues.length - 1]!.endSec : 0,
    cues,
    warnings: [],
  };
}

function makeVideoInspect(
  path: string,
  fileName: string,
): tauriBridge.TranscribeMediaInspectResult {
  return {
    path,
    fileName,
    byteLength: 2_500_000,
    isWavNative: false,
    requiresFfmpeg: true,
    hasAudio: true,
    hasVideo: true,
    durationSec: 10.0,
    containerStartTimeSec: 0,
    audioStartTimeSec: 0,
    audioCodec: "aac",
    sampleRate: 48000,
    channels: 2,
    containerFormat: "mp4",
  };
}

function makeTranscribeResult(
  inputPath: string,
  fileName: string,
  segments: tauriBridge.TranscriptSegment[],
): tauriBridge.TranscribeMediaResult {
  return {
    inputPath,
    fileName,
    durationSec: 10.0,
    timelineOffsetSec: 0,
    decodedWithFfmpeg: true,
    engineName: "SenseVoiceSmall INT8 + Silero VAD v5",
    segments,
    fullText: segments.map((s) => s.text).join("\n"),
    detectedLanguages: ["zh"],
    speechDurationSec: 2.0,
    elapsedMs: 420,
    rtf: 0.042,
    warnings: [],
  };
}

function renderWorkspace() {
  return render(
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: vi.fn() }}>
      <MediaSessionProvider>
        <VideoSubtitlesWorkspace />
      </MediaSessionProvider>
    </I18nContext.Provider>,
  );
}

function CrossToolV02T01Harness() {
  const [activeTool, setActiveTool] = useState<string>("V02");
  return (
    <I18nContext.Provider value={{ locale: "zh-CN", t: MESSAGES["zh-CN"], setLocale: vi.fn() }}>
      <MediaSessionProvider onNavigateToTool={setActiveTool}>
        <div data-testid="active-tool">{activeTool}</div>
        <button type="button" data-testid="switch-v02" onClick={() => setActiveTool("V02")}>
          V02
        </button>
        <button type="button" data-testid="switch-t01" onClick={() => setActiveTool("T01")}>
          T01
        </button>
        {activeTool === "V02" ? <VideoSubtitlesWorkspace /> : <TranscribeMediaWorkspace />}
      </MediaSessionProvider>
    </I18nContext.Provider>
  );
}

describe("VideoSubtitlesWorkspace (V02)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tauriBridge.getMediaToolsStatus).mockResolvedValue(READY_STATUS);
    vi.mocked(tauriBridge.getAsrModelStatus).mockResolvedValue(READY_ASR_STATUS);
    vi.mocked(tauriBridge.extractMediaPosterDataUrl).mockResolvedValue("data:image/jpeg;base64,AA");
    vi.mocked(tauriBridge.registerMediaPreviewPath).mockImplementation(async (p) => ({
      token: `tok-${p}`,
      url: `winkitmedia://preview/${encodeURIComponent(p)}`,
      mimeType: "video/mp4",
      fileName: p.split("\\").pop() ?? "video.mp4",
      byteLength: 2_500_000,
    }));
  });

  it("loads video and SRT cues, previews clicked cue frame, toggles Black Box style, and exports burned video with allowOverwrite=false by default", async () => {
    const user = userEvent.setup();
    vi.mocked(tauriBridge.pickSingleFile)
      .mockResolvedValueOnce("C:\\Demo\\demo.mp4")
      .mockResolvedValueOnce("C:\\Demo\\captions.srt");

    vi.mocked(tauriBridge.probeMediaInfo).mockResolvedValue(
      makeVideoProbe("C:\\Demo\\demo.mp4", "demo.mp4"),
    );

    vi.mocked(tauriBridge.parseSubtitleFile).mockResolvedValue(
      makeParsedSubtitle("C:\\Demo\\captions.srt", "captions.srt", "srt", [
        { index: 1, startSec: 1.0, endSec: 3.0, text: "第一句中文字幕", sourceLine: 2 },
        { index: 2, startSec: 4.0, endSec: 8.0, text: "Second English & 中文", sourceLine: 6 },
      ]),
    );

    vi.mocked(tauriBridge.previewBurnedSubtitleFrame).mockResolvedValue({
      dataUrl: "data:image/jpeg;base64,BB",
      timestampSec: 6.0,
      activeCueIndices: [2],
      displayWidth: 1280,
      displayHeight: 720,
    });

    vi.mocked(tauriBridge.burnInSubtitles).mockResolvedValue({
      outputPath: "C:\\Demo\\demo_subtitled.mp4",
      byteSize: 2_800_000,
      outputWidth: 1280,
      outputHeight: 720,
      outputRotation: 0,
      durationSec: 10.0,
      burnedCueCount: 2,
      hasAudio: true,
      audioCopied: true,
      subtitleStreamsInOutput: 0,
      elapsedMs: 1120,
    });

    renderWorkspace();
    await user.click(screen.getAllByRole("button", { name: /选择视频/ })[0]!);
    await waitFor(() => expect(screen.getByText("demo.mp4")).toBeInTheDocument());

    // Video has audio -> auto-subtitle button is enabled
    expect(screen.getByTestId("v02-generate-subtitles-btn")).not.toBeDisabled();

    await user.click(screen.getByRole("button", { name: /导入字幕/ }));
    await waitFor(() => expect(screen.getByText(/第一句中文字幕/)).toBeInTheDocument());

    // Click second cue -> triggers burned preview at midpoint 6.0s
    await user.click(screen.getByRole("option", { name: /Second English/ }));
    await waitFor(() =>
      expect(tauriBridge.previewBurnedSubtitleFrame).toHaveBeenCalledWith(
        expect.objectContaining({ timestampSec: 6 }),
      ),
    );

    // Switch style to Black Box and export
    await user.click(screen.getByRole("radio", { name: /半透明黑底框/ }));
    await user.click(screen.getByRole("button", { name: /烧录硬字幕并导出/ }));

    await waitFor(() => expect(tauriBridge.burnInSubtitles).toHaveBeenCalledTimes(1));
    expect(tauriBridge.burnInSubtitles).toHaveBeenCalledWith(
      expect.objectContaining({
        allowOverwrite: false,
        style: expect.objectContaining({ boxStyle: "black_box" }),
      }),
    );
    expect(await screen.findByText(/共 2 条硬字幕/)).toBeInTheDocument();
  });

  it("disables auto-subtitles with an explicit hint for silent videos while keeping manual WebVTT burn-in intact", async () => {
    const user = userEvent.setup();
    vi.mocked(tauriBridge.pickSingleFile)
      .mockResolvedValueOnce("C:\\Demo\\silent.mp4")
      .mockResolvedValueOnce("C:\\Demo\\manual.vtt");

    vi.mocked(tauriBridge.probeMediaInfo).mockResolvedValue(
      makeVideoProbe("C:\\Demo\\silent.mp4", "silent.mp4", { hasAudio: false }),
    );
    vi.mocked(tauriBridge.parseSubtitleFile).mockResolvedValue(
      makeParsedSubtitle("C:\\Demo\\manual.vtt", "manual.vtt", "web_vtt", [
        { index: 1, startSec: 0.5, endSec: 2.5, text: "WebVTT 手动字幕", sourceLine: 3 },
      ]),
    );
    vi.mocked(tauriBridge.previewBurnedSubtitleFrame).mockResolvedValue({
      dataUrl: "data:image/jpeg;base64,CC",
      timestampSec: 1.5,
      activeCueIndices: [1],
      displayWidth: 1280,
      displayHeight: 720,
    });
    vi.mocked(tauriBridge.burnInSubtitles).mockResolvedValue({
      outputPath: "C:\\Demo\\silent_subtitled.mp4",
      byteSize: 1_900_000,
      outputWidth: 1280,
      outputHeight: 720,
      outputRotation: 0,
      durationSec: 10.0,
      burnedCueCount: 1,
      hasAudio: false,
      audioCopied: false,
      subtitleStreamsInOutput: 0,
      elapsedMs: 800,
    });

    renderWorkspace();
    await user.click(screen.getAllByRole("button", { name: /选择视频/ })[0]!);
    await waitFor(() => expect(screen.getByTestId("v02-no-audio-hint")).toBeInTheDocument());
    expect(screen.getByTestId("v02-generate-subtitles-btn")).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /导入字幕/ }));
    await waitFor(() => expect(screen.getByText("WebVTT")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /烧录硬字幕并导出/ }));
    await waitFor(() => expect(tauriBridge.burnInSubtitles).toHaveBeenCalledTimes(1));
    expect(tauriBridge.burnInSubtitles).toHaveBeenCalledWith(
      expect.objectContaining({
        videoPath: "C:\\Demo\\silent.mp4",
        subtitlePath: "C:\\Demo\\manual.vtt",
        allowOverwrite: false,
      }),
    );
  });

  it("prompts for explicit overwrite confirmation on TARGET_ALREADY_EXISTS, invalidates it when output or style changes, and blocks source overwrites directly", async () => {
    const user = userEvent.setup();
    vi.mocked(tauriBridge.pickSingleFile)
      .mockResolvedValueOnce("C:\\Demo\\clip.mp4")
      .mockResolvedValueOnce("C:\\Demo\\clip.srt");

    vi.mocked(tauriBridge.probeMediaInfo).mockResolvedValue(
      makeVideoProbe("C:\\Demo\\clip.mp4", "clip.mp4"),
    );
    vi.mocked(tauriBridge.parseSubtitleFile).mockResolvedValue(
      makeParsedSubtitle("C:\\Demo\\clip.srt", "clip.srt", "srt", [
        { index: 1, startSec: 1.0, endSec: 2.0, text: "Overwrite test", sourceLine: 2 },
      ]),
    );
    vi.mocked(tauriBridge.previewBurnedSubtitleFrame).mockResolvedValue({
      dataUrl: "data:image/jpeg;base64,DD",
      timestampSec: 1.5,
      activeCueIndices: [1],
      displayWidth: 1280,
      displayHeight: 720,
    });

    vi.mocked(tauriBridge.burnInSubtitles)
      .mockRejectedValueOnce({ code: "TARGET_ALREADY_EXISTS", message: "目标视频文件已存在" })
      .mockRejectedValueOnce({ code: "TARGET_ALREADY_EXISTS", message: "目标视频文件已存在" })
      .mockResolvedValueOnce({
        outputPath: "C:\\Demo\\clip_custom.mp4",
        byteSize: 2_600_000,
        outputWidth: 1280,
        outputHeight: 720,
        outputRotation: 0,
        durationSec: 10.0,
        burnedCueCount: 1,
        hasAudio: true,
        audioCopied: true,
        subtitleStreamsInOutput: 0,
        elapsedMs: 900,
      })
      .mockRejectedValueOnce({
        code: "SAME_INPUT_AND_OUTPUT",
        message: "禁止覆盖源视频或源字幕",
      });

    renderWorkspace();
    await user.click(screen.getAllByRole("button", { name: /选择视频/ })[0]!);
    await waitFor(() => expect(screen.getByText("clip.mp4")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /导入字幕/ }));
    await waitFor(() => expect(screen.getByText("Overwrite test")).toBeInTheDocument());

    // 1. Existing target triggers ConfirmDialog (not error banner)
    await user.click(screen.getByRole("button", { name: /烧录硬字幕并导出/ }));
    expect(await screen.findByText("覆盖已有视频文件确认")).toBeInTheDocument();

    // 2. Changing output path immediately invalidates the bound confirmation dialog
    const outputInput = screen.getByLabelText(/输出视频文件/);
    fireEvent.change(outputInput, { target: { value: "C:\\Demo\\clip_custom.mp4" } });
    await waitFor(() => expect(screen.queryByText("覆盖已有视频文件确认")).not.toBeInTheDocument());

    // 3. Re-export -> ConfirmDialog opens for clip_custom.mp4 -> confirm triggers allowOverwrite=true
    await user.click(screen.getByRole("button", { name: /烧录硬字幕并导出/ }));
    expect(await screen.findByText("覆盖已有视频文件确认")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认覆盖" }));

    await waitFor(() => expect(tauriBridge.burnInSubtitles).toHaveBeenCalledTimes(3));
    expect(tauriBridge.burnInSubtitles).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        outputPath: "C:\\Demo\\clip_custom.mp4",
        allowOverwrite: true,
      }),
    );

    // 4. Attempting to overwrite source video/subtitle surfaces error without opening ConfirmDialog
    fireEvent.change(outputInput, { target: { value: "C:\\Demo\\clip.srt" } });
    await user.click(screen.getByRole("button", { name: /烧录硬字幕并导出/ }));
    await waitFor(() => expect(tauriBridge.burnInSubtitles).toHaveBeenCalledTimes(4));
    expect(screen.queryByText("覆盖已有视频文件确认")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/禁止覆盖|相同/);
  });

  it("handoffs video from V02 to T01 (respecting missing-model zero-auto-download) and atomically replaces Video A with Video B + B.srt on Apply to Source Video", async () => {
    const user = userEvent.setup();
    vi.mocked(tauriBridge.getAsrModelStatus)
      .mockResolvedValueOnce(MISSING_ASR_STATUS)
      .mockResolvedValue(READY_ASR_STATUS);

    vi.mocked(tauriBridge.pickSingleFile)
      .mockResolvedValueOnce("C:\\Videos\\clip_a.mp4")
      .mockResolvedValueOnce("C:\\Videos\\clip_a.srt")
      .mockResolvedValueOnce("C:\\Videos\\clip_b.mp4");

    vi.mocked(tauriBridge.probeMediaInfo).mockImplementation(async (path) => {
      if (path.includes("clip_a")) return makeVideoProbe("C:\\Videos\\clip_a.mp4", "clip_a.mp4");
      return makeVideoProbe("C:\\Videos\\clip_b.mp4", "clip_b.mp4");
    });

    vi.mocked(tauriBridge.parseSubtitleFile).mockImplementation(async (path) => {
      if (path.includes("clip_a")) {
        return makeParsedSubtitle("C:\\Videos\\clip_a.srt", "clip_a.srt", "srt", [
          { index: 1, startSec: 0.5, endSec: 2.0, text: "旧视频 A 的字幕", sourceLine: 2 },
        ]);
      }
      return makeParsedSubtitle("C:\\Videos\\clip_b.srt", "clip_b.srt", "srt", [
        { index: 1, startSec: 1.0, endSec: 3.0, text: "已校对的视频 B 字幕", sourceLine: 2 },
      ]);
    });

    vi.mocked(tauriBridge.previewBurnedSubtitleFrame).mockImplementation(async (req) => ({
      dataUrl: `data:image/jpeg;base64,${req.videoPath.includes("clip_b") ? "VIDEO_B" : "VIDEO_A"}`,
      timestampSec: req.timestampSec,
      activeCueIndices: [1],
      displayWidth: 1280,
      displayHeight: 720,
    }));

    vi.mocked(tauriBridge.inspectTranscribeMedia).mockImplementation(async (path) => {
      if (path.includes("clip_a")) return makeVideoInspect("C:\\Videos\\clip_a.mp4", "clip_a.mp4");
      return makeVideoInspect("C:\\Videos\\clip_b.mp4", "clip_b.mp4");
    });

    vi.mocked(tauriBridge.transcribeMedia).mockResolvedValue(
      makeTranscribeResult("C:\\Videos\\clip_b.mp4", "clip_b.mp4", [
        { id: 1, startSec: 1.0, endSec: 3.0, text: "原始转写 B", language: "zh" },
      ]),
    );

    vi.mocked(tauriBridge.pickSaveFilePath).mockResolvedValue("C:\\Videos\\clip_b.srt");
    vi.mocked(tauriBridge.exportTranscriptFile).mockResolvedValue({
      outputPath: "C:\\Videos\\clip_b.srt",
      format: "srt",
      segmentCount: 1,
      byteSize: 64,
    });

    vi.mocked(tauriBridge.burnInSubtitles).mockResolvedValue({
      outputPath: "C:\\Videos\\clip_b_subtitled.mp4",
      byteSize: 2_900_000,
      outputWidth: 1280,
      outputHeight: 720,
      outputRotation: 0,
      durationSec: 10.0,
      burnedCueCount: 1,
      hasAudio: true,
      audioCopied: true,
      subtitleStreamsInOutput: 0,
      elapsedMs: 950,
    });

    render(<CrossToolV02T01Harness />);

    // 1. Load Video A + A.srt in V02
    await user.click(screen.getAllByRole("button", { name: /选择视频/ })[0]!);
    await waitFor(() =>
      expect(screen.getByTestId("v02-video-name")).toHaveTextContent("clip_a.mp4"),
    );
    await user.click(screen.getByRole("button", { name: /导入字幕/ }));
    await waitFor(() =>
      expect(screen.getByTestId("v02-subtitle-name")).toHaveTextContent("clip_a.srt"),
    );

    // 2. Click "从当前视频生成字幕" -> navigates to T01 with clip_a.mp4; missing model disables start with ZERO auto-download
    await user.click(screen.getByTestId("v02-generate-subtitles-btn"));
    await waitFor(() => expect(screen.getByTestId("active-tool")).toHaveTextContent("T01"));
    await waitFor(() =>
      expect(screen.getByTestId("t01-source-meta")).toHaveTextContent("clip_a.mp4"),
    );
    expect(screen.getByTestId("t01-start-btn")).toBeDisabled();
    expect(tauriBridge.installManagedAsrModel).not.toHaveBeenCalled();

    // 3. Re-mount T01 after model becomes ready, load Video B, transcribe, proofread, export B.srt
    await user.click(screen.getByTestId("switch-v02"));
    await user.click(screen.getByTestId("switch-t01"));
    await waitFor(() => expect(screen.getByTestId("t01-start-btn")).not.toBeDisabled());

    await user.click(screen.getByTestId("t01-dropzone"));
    await waitFor(() =>
      expect(screen.getByTestId("t01-source-meta")).toHaveTextContent("clip_b.mp4"),
    );
    await user.click(screen.getByTestId("t01-start-btn"));
    await waitFor(() => expect(screen.getByDisplayValue("原始转写 B")).toBeInTheDocument());

    fireEvent.change(screen.getByDisplayValue("原始转写 B"), {
      target: { value: "已校对的视频 B 字幕" },
    });
    await user.click(screen.getByTestId("t01-export-srt-btn"));
    await waitFor(() => expect(screen.getByTestId("t01-apply-v02-btn")).toBeInTheDocument());

    // 4. Click "应用到原视频" -> V02 atomically replaces BOTH Video A and A.srt with Video B and B.srt
    await user.click(screen.getByTestId("t01-apply-v02-btn"));
    await waitFor(() => expect(screen.getByTestId("active-tool")).toHaveTextContent("V02"));
    await waitFor(() =>
      expect(screen.getByTestId("v02-video-name")).toHaveTextContent("clip_b.mp4"),
    );
    expect(screen.getByTestId("v02-subtitle-name")).toHaveTextContent("clip_b.srt");
    expect(screen.getByText("已校对的视频 B 字幕")).toBeInTheDocument();

    // Preview & burn-in MUST both target Video B (NOT stale Video A!)
    await waitFor(() =>
      expect(tauriBridge.previewBurnedSubtitleFrame).toHaveBeenLastCalledWith(
        expect.objectContaining({
          videoPath: "C:\\Videos\\clip_b.mp4",
          subtitlePath: "C:\\Videos\\clip_b.srt",
        }),
      ),
    );

    await user.click(screen.getByRole("button", { name: /烧录硬字幕并导出/ }));
    await waitFor(() => expect(tauriBridge.burnInSubtitles).toHaveBeenCalledTimes(1));
    expect(tauriBridge.burnInSubtitles).toHaveBeenCalledWith(
      expect.objectContaining({
        videoPath: "C:\\Videos\\clip_b.mp4",
        subtitlePath: "C:\\Videos\\clip_b.srt",
        outputPath: "C:\\Videos\\clip_b_subtitled.mp4",
        allowOverwrite: false,
      }),
    );
  });

  it("queues a T01 video+SRT handoff without interrupting an active V02 burn-in, preserves it across tab switches, and lets the user apply it afterwards", async () => {
    const user = userEvent.setup();
    vi.mocked(tauriBridge.pickSingleFile)
      .mockResolvedValueOnce("C:\\Videos\\burn_a.mp4")
      .mockResolvedValueOnce("C:\\Videos\\burn_a.srt")
      .mockResolvedValueOnce("C:\\Videos\\next_b.mp4");

    vi.mocked(tauriBridge.probeMediaInfo).mockImplementation(async (path) =>
      path.includes("burn_a")
        ? makeVideoProbe("C:\\Videos\\burn_a.mp4", "burn_a.mp4")
        : makeVideoProbe("C:\\Videos\\next_b.mp4", "next_b.mp4"),
    );
    vi.mocked(tauriBridge.parseSubtitleFile).mockImplementation(async (path) =>
      path.includes("burn_a")
        ? makeParsedSubtitle("C:\\Videos\\burn_a.srt", "burn_a.srt", "srt", [
            { index: 1, startSec: 0.5, endSec: 2.0, text: "烧录中 A", sourceLine: 2 },
          ])
        : makeParsedSubtitle("C:\\Videos\\next_b.srt", "next_b.srt", "srt", [
            { index: 1, startSec: 1.0, endSec: 3.0, text: "待处理 B", sourceLine: 2 },
          ]),
    );
    vi.mocked(tauriBridge.previewBurnedSubtitleFrame).mockResolvedValue({
      dataUrl: "data:image/jpeg;base64,EE",
      timestampSec: 1.5,
      activeCueIndices: [1],
      displayWidth: 1280,
      displayHeight: 720,
    });

    let resolveBurnA!: (res: tauriBridge.BurnInSubtitlesResult) => void;
    vi.mocked(tauriBridge.burnInSubtitles).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveBurnA = resolve;
        }),
    );

    vi.mocked(tauriBridge.inspectTranscribeMedia).mockResolvedValue(
      makeVideoInspect("C:\\Videos\\next_b.mp4", "next_b.mp4"),
    );
    vi.mocked(tauriBridge.transcribeMedia).mockResolvedValue(
      makeTranscribeResult("C:\\Videos\\next_b.mp4", "next_b.mp4", [
        { id: 1, startSec: 1.0, endSec: 3.0, text: "待处理 B", language: "zh" },
      ]),
    );
    vi.mocked(tauriBridge.pickSaveFilePath).mockResolvedValue("C:\\Videos\\next_b.srt");
    vi.mocked(tauriBridge.exportTranscriptFile).mockResolvedValue({
      outputPath: "C:\\Videos\\next_b.srt",
      format: "srt",
      segmentCount: 1,
      byteSize: 48,
    });

    render(<CrossToolV02T01Harness />);

    // 1. Load Video A + A.srt and start burn-in (stays running)
    await user.click(screen.getAllByRole("button", { name: /选择视频/ })[0]!);
    await waitFor(() =>
      expect(screen.getByTestId("v02-video-name")).toHaveTextContent("burn_a.mp4"),
    );
    await user.click(screen.getByRole("button", { name: /导入字幕/ }));
    await waitFor(() =>
      expect(screen.getByTestId("v02-subtitle-name")).toHaveTextContent("burn_a.srt"),
    );
    await user.click(screen.getByRole("button", { name: /烧录硬字幕并导出/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "取消任务" })).toBeInTheDocument(),
    );

    // 2. Switch to T01, transcribe Video B, export B.srt, and click "应用到原视频" while V02 is running
    await user.click(screen.getByTestId("switch-t01"));
    await user.click(screen.getByTestId("t01-dropzone"));
    await waitFor(() =>
      expect(screen.getByTestId("t01-source-meta")).toHaveTextContent("next_b.mp4"),
    );
    await user.click(screen.getByTestId("t01-start-btn"));
    await waitFor(() => expect(screen.getByDisplayValue("待处理 B")).toBeInTheDocument());
    await user.click(screen.getByTestId("t01-export-srt-btn"));
    await waitFor(() => expect(screen.getByTestId("t01-apply-v02-btn")).toBeInTheDocument());
    await user.click(screen.getByTestId("t01-apply-v02-btn"));

    // 3. Back in V02: active burn-in of A is uninterrupted AND B pair is queued
    await waitFor(() => expect(screen.getByTestId("active-tool")).toHaveTextContent("V02"));
    expect(screen.getByTestId("v02-video-name")).toHaveTextContent("burn_a.mp4");
    expect(screen.getByRole("button", { name: "取消任务" })).toBeInTheDocument();
    expect(screen.getByTestId("v02-pending-pair-banner")).toHaveTextContent("next_b.mp4");
    expect(screen.queryByTestId("v02-load-pending-pair-btn")).not.toBeInTheDocument();

    // 4. Switch away and back -> pending pair persists
    await user.click(screen.getByTestId("switch-t01"));
    await user.click(screen.getByTestId("switch-v02"));
    expect(screen.getByTestId("v02-pending-pair-banner")).toHaveTextContent("next_b.srt");

    // 5. Complete burn-in of A -> A's result is shown AND user can now apply queued B pair
    await act(async () => {
      resolveBurnA({
        outputPath: "C:\\Videos\\burn_a_subtitled.mp4",
        byteSize: 2_500_000,
        outputWidth: 1280,
        outputHeight: 720,
        outputRotation: 0,
        durationSec: 10.0,
        burnedCueCount: 1,
        hasAudio: true,
        audioCopied: true,
        subtitleStreamsInOutput: 0,
        elapsedMs: 1200,
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId("v02-result")).toHaveTextContent("burn_a_subtitled.mp4"),
    );
    const applyQueuedBtn = await screen.findByTestId("v02-load-pending-pair-btn");
    await user.click(applyQueuedBtn);

    await waitFor(() =>
      expect(screen.getByTestId("v02-video-name")).toHaveTextContent("next_b.mp4"),
    );
    expect(screen.getByTestId("v02-subtitle-name")).toHaveTextContent("next_b.srt");
    expect(screen.queryByTestId("v02-pending-pair-banner")).not.toBeInTheDocument();
  });

  it("discards a slow earlier pair handoff when the user manually selects newer media in V02, and preserves existing V02 state when pair validation fails", async () => {
    const user = userEvent.setup();
    let resolveSlowProbeB!: (probe: tauriBridge.MediaProbeReport) => void;

    vi.mocked(tauriBridge.pickSingleFile)
      .mockResolvedValueOnce("C:\\Videos\\slow_b.mp4") // T01 pick B
      .mockResolvedValueOnce("C:\\Videos\\newer_c.mp4") // V02 manual pick C while B handoff is validating
      .mockResolvedValueOnce("C:\\Videos\\broken_d.mp4"); // T01 pick D with broken SRT

    vi.mocked(tauriBridge.inspectTranscribeMedia).mockImplementation(async (path) =>
      path.includes("slow_b")
        ? makeVideoInspect("C:\\Videos\\slow_b.mp4", "slow_b.mp4")
        : makeVideoInspect("C:\\Videos\\broken_d.mp4", "broken_d.mp4"),
    );

    vi.mocked(tauriBridge.transcribeMedia).mockImplementation(async (_taskId, req) =>
      makeTranscribeResult(req.inputPath, req.inputPath.split("\\").pop() ?? "video.mp4", [
        { id: 1, startSec: 1.0, endSec: 2.5, text: "字幕内容", language: "zh" },
      ]),
    );

    vi.mocked(tauriBridge.pickSaveFilePath)
      .mockResolvedValueOnce("C:\\Videos\\slow_b.srt")
      .mockResolvedValueOnce("C:\\Videos\\broken_d.srt");

    vi.mocked(tauriBridge.exportTranscriptFile).mockImplementation(async (req) => ({
      outputPath: req.outputPath,
      format: "srt",
      segmentCount: 1,
      byteSize: 44,
    }));

    vi.mocked(tauriBridge.probeMediaInfo).mockImplementation(async (path) => {
      if (path.includes("slow_b")) {
        return new Promise((resolve) => {
          resolveSlowProbeB = resolve;
        });
      }
      if (path.includes("newer_c")) {
        return makeVideoProbe("C:\\Videos\\newer_c.mp4", "newer_c.mp4");
      }
      return makeVideoProbe("C:\\Videos\\broken_d.mp4", "broken_d.mp4");
    });

    vi.mocked(tauriBridge.parseSubtitleFile).mockImplementation(async (path) => {
      if (path.includes("broken_d")) {
        throw new Error("INVALID_SUBTITLE: 字幕文件损坏");
      }
      return makeParsedSubtitle(path, "slow_b.srt", "srt", [
        { index: 1, startSec: 1.0, endSec: 2.5, text: "较早交接 B", sourceLine: 2 },
      ]);
    });

    vi.mocked(tauriBridge.previewBurnedSubtitleFrame).mockResolvedValue({
      dataUrl: "data:image/jpeg;base64,FF",
      timestampSec: 1.5,
      activeCueIndices: [1],
      displayWidth: 1280,
      displayHeight: 720,
    });

    render(<CrossToolV02T01Harness />);

    // 1. In T01, export slow_b.srt and click "应用到原视频" -> V02 begins slow validation of slow_b
    await user.click(screen.getByTestId("switch-t01"));
    await user.click(screen.getByTestId("t01-dropzone"));
    await waitFor(() =>
      expect(screen.getByTestId("t01-source-meta")).toHaveTextContent("slow_b.mp4"),
    );
    await user.click(screen.getByTestId("t01-start-btn"));
    await waitFor(() => expect(screen.getByDisplayValue("字幕内容")).toBeInTheDocument());
    await user.click(screen.getByTestId("t01-export-srt-btn"));
    await waitFor(() => expect(screen.getByTestId("t01-apply-v02-btn")).toBeInTheDocument());
    await user.click(screen.getByTestId("t01-apply-v02-btn"));

    await waitFor(() => expect(screen.getByTestId("active-tool")).toHaveTextContent("V02"));
    await waitFor(() =>
      expect(screen.getByTestId("v02-video-name")).toHaveTextContent("正在校验视频与字幕"),
    );

    // 2. While slow_b handoff is still validating, user manually picks newer_c.mp4
    await user.click(screen.getAllByRole("button", { name: /选择视频/ })[0]!);
    await waitFor(() =>
      expect(screen.getByTestId("v02-video-name")).toHaveTextContent("newer_c.mp4"),
    );

    // 3. Now slow_b resolves late -> MUST be discarded; newer_c.mp4 stays intact!
    await act(async () => {
      resolveSlowProbeB(makeVideoProbe("C:\\Videos\\slow_b.mp4", "slow_b.mp4"));
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId("v02-video-name")).toHaveTextContent("newer_c.mp4");
    expect(screen.queryByText("较早交接 B")).not.toBeInTheDocument();

    // 4. Now send broken_d.mp4 + broken_d.srt (fails subtitle parse) -> newer_c.mp4 stays intact + error shown!
    await user.click(screen.getByTestId("switch-t01"));
    await user.click(screen.getByTestId("t01-dropzone"));
    await waitFor(() =>
      expect(screen.getByTestId("t01-source-meta")).toHaveTextContent("broken_d.mp4"),
    );
    await user.click(screen.getByTestId("t01-start-btn"));
    await waitFor(() => expect(screen.getByDisplayValue("字幕内容")).toBeInTheDocument());
    await user.click(screen.getByTestId("t01-export-srt-btn"));
    await waitFor(() => expect(screen.getByTestId("t01-apply-v02-btn")).toBeInTheDocument());
    await user.click(screen.getByTestId("t01-apply-v02-btn"));

    await waitFor(() => expect(screen.getByTestId("active-tool")).toHaveTextContent("V02"));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/字幕文件损坏|INVALID_SUBTITLE/),
    );
    expect(screen.getByTestId("v02-video-name")).toHaveTextContent("newer_c.mp4");
  });
});
