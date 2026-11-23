import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  bindDisposableListener,
  burnInSubtitles,
  cancelBackendTask,
  changeVideoSpeedBatch,
  cleanUpAudio,
  compressVideosBatch,
  convertAudioBatch,
  convertVideosBatch,
  convertVideoToGif,
  cropRotateVideo,
  extractAudioBatch,
  extractVideoFrames,
  mergeVideos,
  muteVideosBatch,
  replaceVideoAudio,
  resizeVideosBatch,
  subscribeMediaTaskProgress,
  trimAudioFile,
  trimVideoFile,
  watermarkVideo,
  type AudioBitDepthOption,
  type AudioConvertFormat,
  type AudioDenoiseLevel,
  type AudioExtractFormat,
  type AudioWaveformPayload,
  type BurnInSubtitlesRequest,
  type BurnInSubtitlesResult,
  type ChangeVideoSpeedBatchRequest,
  type ChangeVideoSpeedBatchResponse,
  type ParsedSubtitleFile,
  type PreviewSubtitleFrameResult,
  type SubtitleBoxStyle,
  type SubtitlePosition,
  type WatermarkVideoRequest,
  type WatermarkVideoResult,
  type CleanUpAudioRequest,
  type CleanUpAudioResult,
  type CompressQualityPreset,
  type CompressResolutionCap,
  type CompressVideoCodec,
  type CompressVideosBatchRequest,
  type CompressVideosBatchResponse,
  type ConvertAudioBatchRequest,
  type ConvertAudioBatchResponse,
  type ConvertVideosBatchRequest,
  type ConvertVideosBatchResponse,
  type ConvertVideoToGifRequest,
  type ConvertVideoToGifResult,
  type CropRotateVideoRequest,
  type CropRotateVideoResult,
  type ExtractAudioBatchRequest,
  type ExtractAudioBatchResponse,
  type ExtractFramesRequest,
  type ExtractFramesResponse,
  type FrameExtractMode,
  type FrameImageFormat,
  type FrameResolutionPreset,
  type GifWidthPreset,
  type InspectVideoConvertPlanItem,
  type MediaProbeReport,
  type MediaTaskProgressPayload,
  type MergeFitMode,
  type MergeResolutionPreset,
  type MergeVideosRequest,
  type MergeVideosResult,
  type MuteVideosBatchRequest,
  type MuteVideosBatchResponse,
  type PreviewAudioCleanupResult,
  type PreviewReplaceAudioResult,
  type ReplaceAudioMode,
  type ReplaceAudioRequest,
  type ReplaceAudioResult,
  type ResizeVideosBatchRequest,
  type ResizeVideosBatchResponse,
  type ShortAudioBehavior,
  type TrimAudioRequest,
  type TrimAudioResult,
  type TrimKeyframeAnalysis,
  type TrimVideoRequest,
  type TrimVideoResult,
  type VideoConvertFormat,
  type VideoEncoderCapabilities,
  type VideoResizeMode,
  type VideoTrimMode,
} from "./tauriBridge";

export interface MediaInfoQueueEntry {
  path: string;
  fileName: string;
  status: "loading" | "ready" | "error";
  report: MediaProbeReport | null;
  errorMessage: string | null;
}

export interface MediaInfoSessionState {
  items: MediaInfoQueueEntry[];
  selectedPath: string | null;
  showRawJson: boolean;
}

export interface VideoTrimSessionState {
  sourcePath: string | null;
  probe: MediaProbeReport | null;
  previewUrl: string | null;
  posterUrl: string | null;
  playbackUnsupported: boolean;
  startSec: number;
  endSec: number;
  mode: VideoTrimMode;
  outputPath: string;
  keyframeAnalysis: TrimKeyframeAnalysis | null;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  liveProgress: MediaTaskProgressPayload | null;
  lastResult: TrimVideoResult | null;
  errorMessage: string | null;
}

export interface MediaQueuedProbeItem {
  path: string;
  fileName: string;
  status: "loading" | "ready" | "error";
  probe: MediaProbeReport | null;
  errorMessage: string | null;
  selectedAudioTrackIndex: number;
}

export interface VideoMuteSessionState {
  items: MediaQueuedProbeItem[];
  outputDir: string;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  liveProgress: MediaTaskProgressPayload | null;
  lastReport: MuteVideosBatchResponse | null;
  errorMessage: string | null;
}

export interface AudioExtractSessionState {
  items: MediaQueuedProbeItem[];
  selectedPath: string | null;
  outputDir: string;
  format: AudioExtractFormat;
  preferStreamCopy: boolean;
  bitrateKbps: number | null;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  liveProgress: MediaTaskProgressPayload | null;
  lastReport: ExtractAudioBatchResponse | null;
  errorMessage: string | null;
}

export interface VideoFramesSessionState {
  sourcePath: string | null;
  probe: MediaProbeReport | null;
  previewUrl: string | null;
  posterUrl: string | null;
  playbackUnsupported: boolean;
  outputDir: string;
  mode: FrameExtractMode;
  timestampSec: number;
  intervalSec: number;
  frameCount: number;
  useCustomRange: boolean;
  startSec: number;
  endSec: number;
  resolution: FrameResolutionPreset;
  format: FrameImageFormat;
  quality: number;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  liveProgress: MediaTaskProgressPayload | null;
  lastReport: ExtractFramesResponse | null;
  errorMessage: string | null;
}

export interface VideoGifSessionState {
  sourcePath: string | null;
  probe: MediaProbeReport | null;
  previewUrl: string | null;
  posterUrl: string | null;
  playbackUnsupported: boolean;
  outputPath: string;
  useCustomRange: boolean;
  startSec: number;
  endSec: number;
  fps: 10 | 15 | 24;
  widthPreset: GifWidthPreset;
  loopForever: boolean;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  liveProgress: MediaTaskProgressPayload | null;
  lastResult: ConvertVideoToGifResult | null;
  errorMessage: string | null;
}

export interface VideoConvertSessionState {
  sourcePaths: string[];
  selectedPath: string | null;
  targetFormat: VideoConvertFormat;
  allowDropIncompatible: boolean;
  outputDir: string;
  plans: InspectVideoConvertPlanItem[];
  inspecting: boolean;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  liveProgress: MediaTaskProgressPayload | null;
  lastReport: ConvertVideosBatchResponse | null;
  errorMessage: string | null;
}

export interface VideoCompressSessionState {
  items: MediaQueuedProbeItem[];
  selectedPath: string | null;
  outputDir: string;
  preset: CompressQualityPreset;
  codec: CompressVideoCodec;
  resolutionCap: CompressResolutionCap;
  encoderPreference: string;
  encoderCaps: VideoEncoderCapabilities | null;
  keepAudio: boolean;
  keepOriginalIfLarger: boolean;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  liveProgress: MediaTaskProgressPayload | null;
  lastReport: CompressVideosBatchResponse | null;
  errorMessage: string | null;
}

export interface VideoResizeSessionState {
  items: MediaQueuedProbeItem[];
  selectedPath: string | null;
  outputDir: string;
  targetWidth: number;
  targetHeight: number;
  mode: VideoResizeMode;
  lockAspectRatio: boolean;
  preventUpscale: boolean;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  liveProgress: MediaTaskProgressPayload | null;
  lastReport: ResizeVideosBatchResponse | null;
  errorMessage: string | null;
}

export type CropAspectPreset = "free" | "1:1" | "16:9" | "9:16";

export interface VideoCropSessionState {
  sourcePath: string | null;
  probe: MediaProbeReport | null;
  previewFrameUrl: string | null;
  previewTimestampSec: number;
  displayWidth: number;
  displayHeight: number;
  rotateCw: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  aspectPreset: CropAspectPreset;
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  outputPath: string;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  liveProgress: MediaTaskProgressPayload | null;
  lastResult: CropRotateVideoResult | null;
  errorMessage: string | null;
}

export interface VideoSpeedSessionState {
  items: MediaQueuedProbeItem[];
  selectedPath: string | null;
  outputDir: string;
  speedFactor: number;
  preservePitch: boolean;
  muteAudio: boolean;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  liveProgress: MediaTaskProgressPayload | null;
  lastReport: ChangeVideoSpeedBatchResponse | null;
  errorMessage: string | null;
}

export interface VideoMergeClipItem {
  id: string;
  path: string;
  fileName: string;
  status: "loading" | "ready" | "error";
  probe: MediaProbeReport | null;
  thumbnailUrl: string | null;
  errorMessage: string | null;
}

export interface VideoMergeSessionState {
  clips: VideoMergeClipItem[];
  resolutionPreset: MergeResolutionPreset;
  fitMode: MergeFitMode;
  outputPath: string;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  liveProgress: MediaTaskProgressPayload | null;
  lastResult: MergeVideosResult | null;
  errorMessage: string | null;
}

export interface AudioTrimSessionState {
  sourcePath: string | null;
  probe: MediaProbeReport | null;
  waveform: AudioWaveformPayload | null;
  startSec: number;
  endSec: number;
  playheadSec: number;
  fadeInEnabled: boolean;
  fadeInSec: number;
  fadeOutEnabled: boolean;
  fadeOutSec: number;
  outputPath: string;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  liveProgress: MediaTaskProgressPayload | null;
  lastResult: TrimAudioResult | null;
  errorMessage: string | null;
}

export interface AudioConvertSessionState {
  items: MediaQueuedProbeItem[];
  selectedPath: string | null;
  outputDir: string;
  targetFormat: AudioConvertFormat;
  bitrateKbps: number;
  sampleRateHz: number | null;
  bitDepth: AudioBitDepthOption;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  liveProgress: MediaTaskProgressPayload | null;
  lastReport: ConvertAudioBatchResponse | null;
  errorMessage: string | null;
}

export interface AudioCleanupSessionState {
  sourcePath: string | null;
  probe: MediaProbeReport | null;
  audioTrackIndex: number;
  denoiseLevel: AudioDenoiseLevel;
  highpassRumble: boolean;
  normalizeLoudness: boolean;
  targetLufs: number;
  removeSilence: boolean;
  previewStartSec: number;
  preview: PreviewAudioCleanupResult | null;
  previewLoading: boolean;
  previewError: string | null;
  outputPath: string;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  liveProgress: MediaTaskProgressPayload | null;
  lastResult: CleanUpAudioResult | null;
  errorMessage: string | null;
}

export interface VideoReplaceAudioSessionState {
  videoPath: string | null;
  videoProbe: MediaProbeReport | null;
  videoPreviewUrl: string | null;
  videoPosterUrl: string | null;
  audioSourcePath: string | null;
  audioProbe: MediaProbeReport | null;
  audioSourceTrackIndex: number;
  mode: ReplaceAudioMode;
  originalVolume: number;
  newAudioVolume: number;
  shortAudioBehavior: ShortAudioBehavior;
  preview: PreviewReplaceAudioResult | null;
  previewLoading: boolean;
  previewError: string | null;
  outputPath: string;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  liveProgress: MediaTaskProgressPayload | null;
  lastResult: ReplaceAudioResult | null;
  errorMessage: string | null;
}

export interface VideoSubtitlesSessionState {
  videoPath: string | null;
  videoProbe: MediaProbeReport | null;
  posterUrl: string | null;
  subtitlePath: string | null;
  parsedSubtitle: ParsedSubtitleFile | null;
  subtitleParseError: string | null;
  selectedCueIndex: number | null;
  previewTimestampSec: number;
  previewFrame: PreviewSubtitleFrameResult | null;
  previewLoading: boolean;
  previewError: string | null;
  fontSize: number;
  position: SubtitlePosition;
  boxStyle: SubtitleBoxStyle;
  marginV: number;
  outputPath: string;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  liveProgress: MediaTaskProgressPayload | null;
  lastResult: BurnInSubtitlesResult | null;
  errorMessage: string | null;
}

export interface VideoWatermarkSessionState {
  videoPath: string | null;
  videoProbe: MediaProbeReport | null;
  posterUrl: string | null;
  posterTimestampSec: number;
  outputPath: string;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  liveProgress: MediaTaskProgressPayload | null;
  lastResult: WatermarkVideoResult | null;
  errorMessage: string | null;
}

export interface MediaSessionRoot {
  mediaInfo: MediaInfoSessionState;
  videoTrim: VideoTrimSessionState;
  videoMute: VideoMuteSessionState;
  audioExtract: AudioExtractSessionState;
  videoFrames: VideoFramesSessionState;
  videoGif: VideoGifSessionState;
  videoConvert: VideoConvertSessionState;
  videoCompress: VideoCompressSessionState;
  videoResize: VideoResizeSessionState;
  videoCrop: VideoCropSessionState;
  videoSpeed: VideoSpeedSessionState;
  videoMerge: VideoMergeSessionState;
  audioTrim: AudioTrimSessionState;
  audioConvert: AudioConvertSessionState;
  audioCleanup: AudioCleanupSessionState;
  videoReplaceAudio: VideoReplaceAudioSessionState;
  videoSubtitles: VideoSubtitlesSessionState;
  videoWatermark: VideoWatermarkSessionState;
}

const INITIAL_MEDIA_SESSION: MediaSessionRoot = {
  mediaInfo: {
    items: [],
    selectedPath: null,
    showRawJson: false,
  },
  videoTrim: {
    sourcePath: null,
    probe: null,
    previewUrl: null,
    posterUrl: null,
    playbackUnsupported: false,
    startSec: 0,
    endSec: 0,
    mode: "stream_copy",
    outputPath: "",
    keyframeAnalysis: null,
    taskStatus: "idle",
    activeTaskId: null,
    liveProgress: null,
    lastResult: null,
    errorMessage: null,
  },
  videoMute: {
    items: [],
    outputDir: "",
    taskStatus: "idle",
    activeTaskId: null,
    liveProgress: null,
    lastReport: null,
    errorMessage: null,
  },
  audioExtract: {
    items: [],
    selectedPath: null,
    outputDir: "",
    format: "m4a",
    preferStreamCopy: true,
    bitrateKbps: null,
    taskStatus: "idle",
    activeTaskId: null,
    liveProgress: null,
    lastReport: null,
    errorMessage: null,
  },
  videoFrames: {
    sourcePath: null,
    probe: null,
    previewUrl: null,
    posterUrl: null,
    playbackUnsupported: false,
    outputDir: "",
    mode: "single_time",
    timestampSec: 0,
    intervalSec: 1,
    frameCount: 6,
    useCustomRange: false,
    startSec: 0,
    endSec: 0,
    resolution: "original",
    format: "png",
    quality: 90,
    taskStatus: "idle",
    activeTaskId: null,
    liveProgress: null,
    lastReport: null,
    errorMessage: null,
  },
  videoGif: {
    sourcePath: null,
    probe: null,
    previewUrl: null,
    posterUrl: null,
    playbackUnsupported: false,
    outputPath: "",
    useCustomRange: false,
    startSec: 0,
    endSec: 0,
    fps: 15,
    widthPreset: "w480",
    loopForever: true,
    taskStatus: "idle",
    activeTaskId: null,
    liveProgress: null,
    lastResult: null,
    errorMessage: null,
  },
  videoConvert: {
    sourcePaths: [],
    selectedPath: null,
    targetFormat: "mp4",
    allowDropIncompatible: false,
    outputDir: "",
    plans: [],
    inspecting: false,
    taskStatus: "idle",
    activeTaskId: null,
    liveProgress: null,
    lastReport: null,
    errorMessage: null,
  },
  videoCompress: {
    items: [],
    selectedPath: null,
    outputDir: "",
    preset: "balanced",
    codec: "h264",
    resolutionCap: "original",
    encoderPreference: "software",
    encoderCaps: null,
    keepAudio: true,
    keepOriginalIfLarger: true,
    taskStatus: "idle",
    activeTaskId: null,
    liveProgress: null,
    lastReport: null,
    errorMessage: null,
  },
  videoResize: {
    items: [],
    selectedPath: null,
    outputDir: "",
    targetWidth: 1920,
    targetHeight: 1080,
    mode: "fit",
    lockAspectRatio: true,
    preventUpscale: false,
    taskStatus: "idle",
    activeTaskId: null,
    liveProgress: null,
    lastReport: null,
    errorMessage: null,
  },
  videoCrop: {
    sourcePath: null,
    probe: null,
    previewFrameUrl: null,
    previewTimestampSec: 0,
    displayWidth: 0,
    displayHeight: 0,
    rotateCw: 0,
    flipH: false,
    flipV: false,
    aspectPreset: "free",
    cropX: 0,
    cropY: 0,
    cropWidth: 0,
    cropHeight: 0,
    outputPath: "",
    taskStatus: "idle",
    activeTaskId: null,
    liveProgress: null,
    lastResult: null,
    errorMessage: null,
  },
  videoSpeed: {
    items: [],
    selectedPath: null,
    outputDir: "",
    speedFactor: 2.0,
    preservePitch: true,
    muteAudio: false,
    taskStatus: "idle",
    activeTaskId: null,
    liveProgress: null,
    lastReport: null,
    errorMessage: null,
  },
  videoMerge: {
    clips: [],
    resolutionPreset: "match_first",
    fitMode: "pad",
    outputPath: "",
    taskStatus: "idle",
    activeTaskId: null,
    liveProgress: null,
    lastResult: null,
    errorMessage: null,
  },
  audioTrim: {
    sourcePath: null,
    probe: null,
    waveform: null,
    startSec: 0,
    endSec: 0,
    playheadSec: 0,
    fadeInEnabled: false,
    fadeInSec: 0.5,
    fadeOutEnabled: false,
    fadeOutSec: 0.5,
    outputPath: "",
    taskStatus: "idle",
    activeTaskId: null,
    liveProgress: null,
    lastResult: null,
    errorMessage: null,
  },
  audioConvert: {
    items: [],
    selectedPath: null,
    outputDir: "",
    targetFormat: "mp3",
    bitrateKbps: 192,
    sampleRateHz: null,
    bitDepth: "source",
    taskStatus: "idle",
    activeTaskId: null,
    liveProgress: null,
    lastReport: null,
    errorMessage: null,
  },
  audioCleanup: {
    sourcePath: null,
    probe: null,
    audioTrackIndex: 0,
    denoiseLevel: "medium",
    highpassRumble: true,
    normalizeLoudness: true,
    targetLufs: -16,
    removeSilence: false,
    previewStartSec: 0,
    preview: null,
    previewLoading: false,
    previewError: null,
    outputPath: "",
    taskStatus: "idle",
    activeTaskId: null,
    liveProgress: null,
    lastResult: null,
    errorMessage: null,
  },
  videoReplaceAudio: {
    videoPath: null,
    videoProbe: null,
    videoPreviewUrl: null,
    videoPosterUrl: null,
    audioSourcePath: null,
    audioProbe: null,
    audioSourceTrackIndex: 0,
    mode: "replace",
    originalVolume: 0.4,
    newAudioVolume: 1.0,
    shortAudioBehavior: "loop_to_fill",
    preview: null,
    previewLoading: false,
    previewError: null,
    outputPath: "",
    taskStatus: "idle",
    activeTaskId: null,
    liveProgress: null,
    lastResult: null,
    errorMessage: null,
  },
  videoSubtitles: {
    videoPath: null,
    videoProbe: null,
    posterUrl: null,
    subtitlePath: null,
    parsedSubtitle: null,
    subtitleParseError: null,
    selectedCueIndex: null,
    previewTimestampSec: 0,
    previewFrame: null,
    previewLoading: false,
    previewError: null,
    fontSize: 38,
    position: "bottom",
    boxStyle: "outline_shadow",
    marginV: 36,
    outputPath: "",
    taskStatus: "idle",
    activeTaskId: null,
    liveProgress: null,
    lastResult: null,
    errorMessage: null,
  },
  videoWatermark: {
    videoPath: null,
    videoProbe: null,
    posterUrl: null,
    posterTimestampSec: 0.5,
    outputPath: "",
    taskStatus: "idle",
    activeTaskId: null,
    liveProgress: null,
    lastResult: null,
    errorMessage: null,
  },
};

export interface MediaSessionContextValue {
  mediaSession: MediaSessionRoot;
  updateMediaInfoSession: (updater: (prev: MediaInfoSessionState) => MediaInfoSessionState) => void;
  updateVideoTrimSession: (updater: (prev: VideoTrimSessionState) => VideoTrimSessionState) => void;
  startVideoTrimTask: (
    req: Omit<TrimVideoRequest, "taskId">,
    formatError: (err: unknown) => string,
  ) => Promise<TrimVideoResult | null>;
  cancelVideoTrimTask: () => Promise<void>;
  updateVideoMuteSession: (updater: (prev: VideoMuteSessionState) => VideoMuteSessionState) => void;
  startVideoMuteBatch: (
    req: Omit<MuteVideosBatchRequest, "taskId">,
    formatError: (err: unknown) => string,
  ) => Promise<MuteVideosBatchResponse | null>;
  cancelVideoMuteBatch: () => Promise<void>;
  updateAudioExtractSession: (
    updater: (prev: AudioExtractSessionState) => AudioExtractSessionState,
  ) => void;
  startAudioExtractBatch: (
    req: Omit<ExtractAudioBatchRequest, "taskId">,
    formatError: (err: unknown) => string,
  ) => Promise<ExtractAudioBatchResponse | null>;
  cancelAudioExtractBatch: () => Promise<void>;
  updateVideoFramesSession: (
    updater: (prev: VideoFramesSessionState) => VideoFramesSessionState,
  ) => void;
  startVideoFramesTask: (
    req: Omit<ExtractFramesRequest, "taskId">,
    formatError: (err: unknown) => string,
  ) => Promise<ExtractFramesResponse | null>;
  cancelVideoFramesTask: () => Promise<void>;
  updateVideoGifSession: (updater: (prev: VideoGifSessionState) => VideoGifSessionState) => void;
  startVideoGifTask: (
    req: Omit<ConvertVideoToGifRequest, "taskId">,
    formatError: (err: unknown) => string,
  ) => Promise<ConvertVideoToGifResult | null>;
  cancelVideoGifTask: () => Promise<void>;
  updateVideoConvertSession: (
    updater: (prev: VideoConvertSessionState) => VideoConvertSessionState,
  ) => void;
  startVideoConvertBatch: (
    req: Omit<ConvertVideosBatchRequest, "taskId">,
    formatError: (err: unknown) => string,
  ) => Promise<ConvertVideosBatchResponse | null>;
  cancelVideoConvertBatch: () => Promise<void>;
  updateVideoCompressSession: (
    updater: (prev: VideoCompressSessionState) => VideoCompressSessionState,
  ) => void;
  startVideoCompressBatch: (
    req: Omit<CompressVideosBatchRequest, "taskId">,
    formatError: (err: unknown) => string,
  ) => Promise<CompressVideosBatchResponse | null>;
  cancelVideoCompressBatch: () => Promise<void>;
  updateVideoResizeSession: (
    updater: (prev: VideoResizeSessionState) => VideoResizeSessionState,
  ) => void;
  startVideoResizeBatch: (
    req: Omit<ResizeVideosBatchRequest, "taskId">,
    formatError: (err: unknown) => string,
  ) => Promise<ResizeVideosBatchResponse | null>;
  cancelVideoResizeBatch: () => Promise<void>;
  updateVideoCropSession: (updater: (prev: VideoCropSessionState) => VideoCropSessionState) => void;
  startVideoCropTask: (
    req: Omit<CropRotateVideoRequest, "taskId">,
    formatError: (err: unknown) => string,
  ) => Promise<CropRotateVideoResult | null>;
  cancelVideoCropTask: () => Promise<void>;
  updateVideoSpeedSession: (
    updater: (prev: VideoSpeedSessionState) => VideoSpeedSessionState,
  ) => void;
  startVideoSpeedBatch: (
    req: Omit<ChangeVideoSpeedBatchRequest, "taskId">,
    formatError: (err: unknown) => string,
  ) => Promise<ChangeVideoSpeedBatchResponse | null>;
  cancelVideoSpeedBatch: () => Promise<void>;
  updateVideoMergeSession: (
    updater: (prev: VideoMergeSessionState) => VideoMergeSessionState,
  ) => void;
  startVideoMergeTask: (
    req: Omit<MergeVideosRequest, "taskId">,
    formatError: (err: unknown) => string,
  ) => Promise<MergeVideosResult | null>;
  cancelVideoMergeTask: () => Promise<void>;
  updateAudioTrimSession: (updater: (prev: AudioTrimSessionState) => AudioTrimSessionState) => void;
  startAudioTrimTask: (
    req: Omit<TrimAudioRequest, "taskId">,
    formatError: (err: unknown) => string,
  ) => Promise<TrimAudioResult | null>;
  cancelAudioTrimTask: () => Promise<void>;
  updateAudioConvertSession: (
    updater: (prev: AudioConvertSessionState) => AudioConvertSessionState,
  ) => void;
  startAudioConvertBatch: (
    req: Omit<ConvertAudioBatchRequest, "taskId">,
    formatError: (err: unknown) => string,
  ) => Promise<ConvertAudioBatchResponse | null>;
  cancelAudioConvertBatch: () => Promise<void>;
  updateAudioCleanupSession: (
    updater: (prev: AudioCleanupSessionState) => AudioCleanupSessionState,
  ) => void;
  startAudioCleanupTask: (
    req: Omit<CleanUpAudioRequest, "taskId">,
    formatError: (err: unknown) => string,
  ) => Promise<CleanUpAudioResult | null>;
  cancelAudioCleanupTask: () => Promise<void>;
  updateVideoReplaceAudioSession: (
    updater: (prev: VideoReplaceAudioSessionState) => VideoReplaceAudioSessionState,
  ) => void;
  startVideoReplaceAudioTask: (
    req: Omit<ReplaceAudioRequest, "taskId">,
    formatError: (err: unknown) => string,
  ) => Promise<ReplaceAudioResult | null>;
  cancelVideoReplaceAudioTask: () => Promise<void>;
  updateVideoSubtitlesSession: (
    updater: (prev: VideoSubtitlesSessionState) => VideoSubtitlesSessionState,
  ) => void;
  startVideoSubtitlesTask: (
    req: Omit<BurnInSubtitlesRequest, "taskId">,
    formatError: (err: unknown) => string,
  ) => Promise<BurnInSubtitlesResult | null>;
  cancelVideoSubtitlesTask: () => Promise<void>;
  updateVideoWatermarkSession: (
    updater: (prev: VideoWatermarkSessionState) => VideoWatermarkSessionState,
  ) => void;
  startVideoWatermarkTask: (
    req: Omit<WatermarkVideoRequest, "taskId">,
    formatError: (err: unknown) => string,
  ) => Promise<WatermarkVideoResult | null>;
  cancelVideoWatermarkTask: () => Promise<void>;
  handoffMediaFileToTool: (toolId: string, filePath: string) => void;
  pendingHandoff: { toolId: string; path: string; nonce: number } | null;
  consumePendingHandoff: (toolId: string) => string | null;
}

const MediaSessionContext = createContext<MediaSessionContextValue | null>(null);

export function MediaSessionProvider({
  children,
  onNavigateToTool,
}: {
  children: ReactNode;
  onNavigateToTool?: (toolId: string) => void;
}) {
  const [mediaSession, setMediaSession] = useState<MediaSessionRoot>(INITIAL_MEDIA_SESSION);
  const [pendingHandoff, setPendingHandoff] = useState<{
    toolId: string;
    path: string;
    nonce: number;
  } | null>(null);

  const taskSeqRef = useRef(1);
  const activeTrimTaskRef = useRef<string | null>(null);
  const activeMuteTaskRef = useRef<string | null>(null);
  const activeAudioExtractTaskRef = useRef<string | null>(null);
  const activeFramesTaskRef = useRef<string | null>(null);
  const activeGifTaskRef = useRef<string | null>(null);
  const activeConvertTaskRef = useRef<string | null>(null);
  const activeCompressTaskRef = useRef<string | null>(null);
  const activeResizeTaskRef = useRef<string | null>(null);
  const activeCropTaskRef = useRef<string | null>(null);
  const activeSpeedTaskRef = useRef<string | null>(null);
  const activeMergeTaskRef = useRef<string | null>(null);
  const activeAudioTrimTaskRef = useRef<string | null>(null);
  const activeAudioConvertTaskRef = useRef<string | null>(null);
  const activeAudioCleanupTaskRef = useRef<string | null>(null);
  const activeVideoReplaceAudioTaskRef = useRef<string | null>(null);
  const activeVideoSubtitlesTaskRef = useRef<string | null>(null);
  const activeVideoWatermarkTaskRef = useRef<string | null>(null);
  const pendingHandoffRef = useRef(pendingHandoff);
  pendingHandoffRef.current = pendingHandoff;

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeMediaTaskProgress((payload) => {
          if (payload.toolId === "V11" && payload.taskId === activeTrimTaskRef.current) {
            setMediaSession((prev) => ({
              ...prev,
              videoTrim: { ...prev.videoTrim, liveProgress: payload },
            }));
          } else if (payload.toolId === "V13" && payload.taskId === activeMuteTaskRef.current) {
            setMediaSession((prev) => ({
              ...prev,
              videoMute: { ...prev.videoMute, liveProgress: payload },
            }));
          } else if (
            payload.toolId === "A04" &&
            payload.taskId === activeAudioExtractTaskRef.current
          ) {
            setMediaSession((prev) => ({
              ...prev,
              audioExtract: { ...prev.audioExtract, liveProgress: payload },
            }));
          } else if (payload.toolId === "V04" && payload.taskId === activeFramesTaskRef.current) {
            setMediaSession((prev) => ({
              ...prev,
              videoFrames: { ...prev.videoFrames, liveProgress: payload },
            }));
          } else if (payload.toolId === "V15" && payload.taskId === activeGifTaskRef.current) {
            setMediaSession((prev) => ({
              ...prev,
              videoGif: { ...prev.videoGif, liveProgress: payload },
            }));
          } else if (payload.toolId === "V07" && payload.taskId === activeConvertTaskRef.current) {
            setMediaSession((prev) => ({
              ...prev,
              videoConvert: { ...prev.videoConvert, liveProgress: payload },
            }));
          } else if (payload.toolId === "V06" && payload.taskId === activeCompressTaskRef.current) {
            setMediaSession((prev) => ({
              ...prev,
              videoCompress: { ...prev.videoCompress, liveProgress: payload },
            }));
          } else if (payload.toolId === "V08" && payload.taskId === activeResizeTaskRef.current) {
            setMediaSession((prev) => ({
              ...prev,
              videoResize: { ...prev.videoResize, liveProgress: payload },
            }));
          } else if (payload.toolId === "V09" && payload.taskId === activeCropTaskRef.current) {
            setMediaSession((prev) => ({
              ...prev,
              videoCrop: { ...prev.videoCrop, liveProgress: payload },
            }));
          } else if (payload.toolId === "V03" && payload.taskId === activeSpeedTaskRef.current) {
            setMediaSession((prev) => ({
              ...prev,
              videoSpeed: { ...prev.videoSpeed, liveProgress: payload },
            }));
          } else if (payload.toolId === "V12" && payload.taskId === activeMergeTaskRef.current) {
            setMediaSession((prev) => ({
              ...prev,
              videoMerge: { ...prev.videoMerge, liveProgress: payload },
            }));
          } else if (
            payload.toolId === "A03" &&
            payload.taskId === activeAudioTrimTaskRef.current
          ) {
            setMediaSession((prev) => ({
              ...prev,
              audioTrim: { ...prev.audioTrim, liveProgress: payload },
            }));
          } else if (
            payload.toolId === "A05" &&
            payload.taskId === activeAudioConvertTaskRef.current
          ) {
            setMediaSession((prev) => ({
              ...prev,
              audioConvert: { ...prev.audioConvert, liveProgress: payload },
            }));
          } else if (
            payload.toolId === "A01" &&
            payload.taskId === activeAudioCleanupTaskRef.current
          ) {
            setMediaSession((prev) => ({
              ...prev,
              audioCleanup: { ...prev.audioCleanup, liveProgress: payload },
            }));
          } else if (
            payload.toolId === "V14" &&
            payload.taskId === activeVideoReplaceAudioTaskRef.current
          ) {
            setMediaSession((prev) => ({
              ...prev,
              videoReplaceAudio: { ...prev.videoReplaceAudio, liveProgress: payload },
            }));
          } else if (
            payload.toolId === "V02" &&
            payload.taskId === activeVideoSubtitlesTaskRef.current
          ) {
            setMediaSession((prev) => ({
              ...prev,
              videoSubtitles: { ...prev.videoSubtitles, liveProgress: payload },
            }));
          } else if (
            payload.toolId === "I13" &&
            payload.taskId === activeVideoWatermarkTaskRef.current
          ) {
            setMediaSession((prev) => ({
              ...prev,
              videoWatermark: { ...prev.videoWatermark, liveProgress: payload },
            }));
          }
        }),
      "winkit://media-progress",
    );
  }, []);

  const updateMediaInfoSession = useCallback(
    (updater: (prev: MediaInfoSessionState) => MediaInfoSessionState) => {
      setMediaSession((prev) => ({ ...prev, mediaInfo: updater(prev.mediaInfo) }));
    },
    [],
  );

  const updateVideoTrimSession = useCallback(
    (updater: (prev: VideoTrimSessionState) => VideoTrimSessionState) => {
      setMediaSession((prev) => ({ ...prev, videoTrim: updater(prev.videoTrim) }));
    },
    [],
  );

  const startVideoTrimTask = useCallback(
    async (
      req: Omit<TrimVideoRequest, "taskId">,
      formatError: (err: unknown) => string,
    ): Promise<TrimVideoResult | null> => {
      if (activeTrimTaskRef.current) return null;
      const taskId = `v11-trim-${Date.now()}-${taskSeqRef.current++}`;
      activeTrimTaskRef.current = taskId;
      setMediaSession((prev) => ({
        ...prev,
        videoTrim: {
          ...prev.videoTrim,
          taskStatus: "running",
          activeTaskId: taskId,
          liveProgress: {
            taskId,
            toolId: "V11",
            phase: "running",
            currentItem: 1,
            totalItems: 1,
            itemName: req.sourcePath,
            percent: 0,
            outTimeSec: 0,
            totalDurationSec: Math.max(0, req.endSec - req.startSec),
          },
          errorMessage: null,
        },
      }));
      try {
        const res = await trimVideoFile({ ...req, taskId });
        if (activeTrimTaskRef.current !== taskId) return null;
        activeTrimTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          videoTrim: {
            ...prev.videoTrim,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            lastResult: res,
            errorMessage: null,
          },
        }));
        return res;
      } catch (err) {
        if (activeTrimTaskRef.current !== taskId) return null;
        activeTrimTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          videoTrim: {
            ...prev.videoTrim,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            errorMessage: formatError(err),
          },
        }));
        return null;
      }
    },
    [],
  );

  const cancelVideoTrimTask = useCallback(async () => {
    const tid = activeTrimTaskRef.current;
    if (tid) await cancelBackendTask(tid);
  }, []);

  const updateVideoMuteSession = useCallback(
    (updater: (prev: VideoMuteSessionState) => VideoMuteSessionState) => {
      setMediaSession((prev) => ({ ...prev, videoMute: updater(prev.videoMute) }));
    },
    [],
  );

  const startVideoMuteBatch = useCallback(
    async (
      req: Omit<MuteVideosBatchRequest, "taskId">,
      formatError: (err: unknown) => string,
    ): Promise<MuteVideosBatchResponse | null> => {
      if (activeMuteTaskRef.current) return null;
      const taskId = `v13-mute-${Date.now()}-${taskSeqRef.current++}`;
      activeMuteTaskRef.current = taskId;
      setMediaSession((prev) => ({
        ...prev,
        videoMute: {
          ...prev.videoMute,
          taskStatus: "running",
          activeTaskId: taskId,
          liveProgress: {
            taskId,
            toolId: "V13",
            phase: "running",
            currentItem: 1,
            totalItems: req.sourcePaths.length,
            itemName: req.sourcePaths[0] ?? null,
            percent: 0,
            outTimeSec: null,
            totalDurationSec: null,
          },
          errorMessage: null,
        },
      }));
      try {
        const res = await muteVideosBatch({ ...req, taskId });
        if (activeMuteTaskRef.current !== taskId) return null;
        activeMuteTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          videoMute: {
            ...prev.videoMute,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            lastReport: res,
            errorMessage: null,
          },
        }));
        return res;
      } catch (err) {
        if (activeMuteTaskRef.current !== taskId) return null;
        activeMuteTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          videoMute: {
            ...prev.videoMute,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            errorMessage: formatError(err),
          },
        }));
        return null;
      }
    },
    [],
  );

  const cancelVideoMuteBatch = useCallback(async () => {
    const tid = activeMuteTaskRef.current;
    if (tid) await cancelBackendTask(tid);
  }, []);

  const updateAudioExtractSession = useCallback(
    (updater: (prev: AudioExtractSessionState) => AudioExtractSessionState) => {
      setMediaSession((prev) => ({ ...prev, audioExtract: updater(prev.audioExtract) }));
    },
    [],
  );

  const startAudioExtractBatch = useCallback(
    async (
      req: Omit<ExtractAudioBatchRequest, "taskId">,
      formatError: (err: unknown) => string,
    ): Promise<ExtractAudioBatchResponse | null> => {
      if (activeAudioExtractTaskRef.current) return null;
      const taskId = `a04-audio-${Date.now()}-${taskSeqRef.current++}`;
      activeAudioExtractTaskRef.current = taskId;
      setMediaSession((prev) => ({
        ...prev,
        audioExtract: {
          ...prev.audioExtract,
          taskStatus: "running",
          activeTaskId: taskId,
          liveProgress: {
            taskId,
            toolId: "A04",
            phase: "running",
            currentItem: 1,
            totalItems: req.items.length,
            itemName: req.items[0]?.sourcePath ?? null,
            percent: 0,
            outTimeSec: null,
            totalDurationSec: null,
          },
          errorMessage: null,
        },
      }));
      try {
        const res = await extractAudioBatch({ ...req, taskId });
        if (activeAudioExtractTaskRef.current !== taskId) return null;
        activeAudioExtractTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          audioExtract: {
            ...prev.audioExtract,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            lastReport: res,
            errorMessage: null,
          },
        }));
        return res;
      } catch (err) {
        if (activeAudioExtractTaskRef.current !== taskId) return null;
        activeAudioExtractTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          audioExtract: {
            ...prev.audioExtract,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            errorMessage: formatError(err),
          },
        }));
        return null;
      }
    },
    [],
  );

  const cancelAudioExtractBatch = useCallback(async () => {
    const tid = activeAudioExtractTaskRef.current;
    if (tid) await cancelBackendTask(tid);
  }, []);

  const updateVideoFramesSession = useCallback(
    (updater: (prev: VideoFramesSessionState) => VideoFramesSessionState) => {
      setMediaSession((prev) => ({ ...prev, videoFrames: updater(prev.videoFrames) }));
    },
    [],
  );

  const startVideoFramesTask = useCallback(
    async (
      req: Omit<ExtractFramesRequest, "taskId">,
      formatError: (err: unknown) => string,
    ): Promise<ExtractFramesResponse | null> => {
      if (activeFramesTaskRef.current) return null;
      const taskId = `v04-frames-${Date.now()}-${taskSeqRef.current++}`;
      activeFramesTaskRef.current = taskId;
      setMediaSession((prev) => ({
        ...prev,
        videoFrames: {
          ...prev.videoFrames,
          taskStatus: "running",
          activeTaskId: taskId,
          liveProgress: {
            taskId,
            toolId: "V04",
            phase: "running",
            currentItem: 1,
            totalItems: req.frameCount ?? 1,
            itemName: req.sourcePath,
            percent: 0,
            outTimeSec: null,
            totalDurationSec: null,
          },
          errorMessage: null,
        },
      }));
      try {
        const res = await extractVideoFrames({ ...req, taskId });
        if (activeFramesTaskRef.current !== taskId) return null;
        activeFramesTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          videoFrames: {
            ...prev.videoFrames,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            lastReport: res,
            errorMessage: null,
          },
        }));
        return res;
      } catch (err) {
        if (activeFramesTaskRef.current !== taskId) return null;
        activeFramesTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          videoFrames: {
            ...prev.videoFrames,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            errorMessage: formatError(err),
          },
        }));
        return null;
      }
    },
    [],
  );

  const cancelVideoFramesTask = useCallback(async () => {
    const tid = activeFramesTaskRef.current;
    if (tid) await cancelBackendTask(tid);
  }, []);

  const updateVideoGifSession = useCallback(
    (updater: (prev: VideoGifSessionState) => VideoGifSessionState) => {
      setMediaSession((prev) => ({ ...prev, videoGif: updater(prev.videoGif) }));
    },
    [],
  );

  const startVideoGifTask = useCallback(
    async (
      req: Omit<ConvertVideoToGifRequest, "taskId">,
      formatError: (err: unknown) => string,
    ): Promise<ConvertVideoToGifResult | null> => {
      if (activeGifTaskRef.current) return null;
      const taskId = `v15-gif-${Date.now()}-${taskSeqRef.current++}`;
      activeGifTaskRef.current = taskId;
      setMediaSession((prev) => ({
        ...prev,
        videoGif: {
          ...prev.videoGif,
          taskStatus: "running",
          activeTaskId: taskId,
          liveProgress: {
            taskId,
            toolId: "V15",
            phase: "running",
            currentItem: 1,
            totalItems: 1,
            itemName: req.sourcePath,
            percent: 0,
            outTimeSec: 0,
            totalDurationSec: null,
          },
          errorMessage: null,
        },
      }));
      try {
        const res = await convertVideoToGif({ ...req, taskId });
        if (activeGifTaskRef.current !== taskId) return null;
        activeGifTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          videoGif: {
            ...prev.videoGif,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            lastResult: res,
            errorMessage: null,
          },
        }));
        return res;
      } catch (err) {
        if (activeGifTaskRef.current !== taskId) return null;
        activeGifTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          videoGif: {
            ...prev.videoGif,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            errorMessage: formatError(err),
          },
        }));
        return null;
      }
    },
    [],
  );

  const cancelVideoGifTask = useCallback(async () => {
    const tid = activeGifTaskRef.current;
    if (tid) await cancelBackendTask(tid);
  }, []);

  const updateVideoConvertSession = useCallback(
    (updater: (prev: VideoConvertSessionState) => VideoConvertSessionState) => {
      setMediaSession((prev) => ({ ...prev, videoConvert: updater(prev.videoConvert) }));
    },
    [],
  );

  const startVideoConvertBatch = useCallback(
    async (
      req: Omit<ConvertVideosBatchRequest, "taskId">,
      formatError: (err: unknown) => string,
    ): Promise<ConvertVideosBatchResponse | null> => {
      if (activeConvertTaskRef.current) return null;
      const taskId = `v07-convert-${Date.now()}-${taskSeqRef.current++}`;
      activeConvertTaskRef.current = taskId;
      setMediaSession((prev) => ({
        ...prev,
        videoConvert: {
          ...prev.videoConvert,
          taskStatus: "running",
          activeTaskId: taskId,
          liveProgress: {
            taskId,
            toolId: "V07",
            phase: "running",
            currentItem: 1,
            totalItems: req.sourcePaths.length,
            itemName: req.sourcePaths[0] ?? null,
            percent: 0,
            outTimeSec: 0,
            totalDurationSec: null,
          },
          errorMessage: null,
        },
      }));
      try {
        const res = await convertVideosBatch({ ...req, taskId });
        if (activeConvertTaskRef.current !== taskId) return null;
        activeConvertTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          videoConvert: {
            ...prev.videoConvert,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            lastReport: res,
            errorMessage: null,
          },
        }));
        return res;
      } catch (err) {
        if (activeConvertTaskRef.current !== taskId) return null;
        activeConvertTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          videoConvert: {
            ...prev.videoConvert,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            errorMessage: formatError(err),
          },
        }));
        return null;
      }
    },
    [],
  );

  const cancelVideoConvertBatch = useCallback(async () => {
    const tid = activeConvertTaskRef.current;
    if (tid) await cancelBackendTask(tid);
  }, []);

  const updateVideoCompressSession = useCallback(
    (updater: (prev: VideoCompressSessionState) => VideoCompressSessionState) => {
      setMediaSession((prev) => ({ ...prev, videoCompress: updater(prev.videoCompress) }));
    },
    [],
  );

  const startVideoCompressBatch = useCallback(
    async (
      req: Omit<CompressVideosBatchRequest, "taskId">,
      formatError: (err: unknown) => string,
    ): Promise<CompressVideosBatchResponse | null> => {
      if (activeCompressTaskRef.current) return null;
      const taskId = `v06-compress-${Date.now()}-${taskSeqRef.current++}`;
      activeCompressTaskRef.current = taskId;
      setMediaSession((prev) => ({
        ...prev,
        videoCompress: {
          ...prev.videoCompress,
          taskStatus: "running",
          activeTaskId: taskId,
          liveProgress: {
            taskId,
            toolId: "V06",
            phase: "running",
            currentItem: 1,
            totalItems: req.sourcePaths.length,
            itemName: req.sourcePaths[0] ?? null,
            percent: 0,
            outTimeSec: 0,
            totalDurationSec: null,
          },
          errorMessage: null,
        },
      }));
      try {
        const res = await compressVideosBatch({ ...req, taskId });
        if (activeCompressTaskRef.current !== taskId) return null;
        activeCompressTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          videoCompress: {
            ...prev.videoCompress,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            lastReport: res,
            errorMessage: null,
          },
        }));
        return res;
      } catch (err) {
        if (activeCompressTaskRef.current !== taskId) return null;
        activeCompressTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          videoCompress: {
            ...prev.videoCompress,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            errorMessage: formatError(err),
          },
        }));
        return null;
      }
    },
    [],
  );

  const cancelVideoCompressBatch = useCallback(async () => {
    const tid = activeCompressTaskRef.current;
    if (tid) await cancelBackendTask(tid);
  }, []);

  const updateVideoResizeSession = useCallback(
    (updater: (prev: VideoResizeSessionState) => VideoResizeSessionState) => {
      setMediaSession((prev) => ({ ...prev, videoResize: updater(prev.videoResize) }));
    },
    [],
  );

  const startVideoResizeBatch = useCallback(
    async (
      req: Omit<ResizeVideosBatchRequest, "taskId">,
      formatError: (err: unknown) => string,
    ): Promise<ResizeVideosBatchResponse | null> => {
      if (activeResizeTaskRef.current) return null;
      const taskId = `v08-resize-${Date.now()}-${taskSeqRef.current++}`;
      activeResizeTaskRef.current = taskId;
      setMediaSession((prev) => ({
        ...prev,
        videoResize: {
          ...prev.videoResize,
          taskStatus: "running",
          activeTaskId: taskId,
          liveProgress: {
            taskId,
            toolId: "V08",
            phase: "running",
            currentItem: 1,
            totalItems: req.sourcePaths.length,
            itemName: req.sourcePaths[0] ?? null,
            percent: 0,
            outTimeSec: 0,
            totalDurationSec: null,
          },
          errorMessage: null,
        },
      }));
      try {
        const res = await resizeVideosBatch({ ...req, taskId });
        if (activeResizeTaskRef.current !== taskId) return null;
        activeResizeTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          videoResize: {
            ...prev.videoResize,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            lastReport: res,
            errorMessage: null,
          },
        }));
        return res;
      } catch (err) {
        if (activeResizeTaskRef.current !== taskId) return null;
        activeResizeTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          videoResize: {
            ...prev.videoResize,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            errorMessage: formatError(err),
          },
        }));
        return null;
      }
    },
    [],
  );

  const cancelVideoResizeBatch = useCallback(async () => {
    const tid = activeResizeTaskRef.current;
    if (tid) await cancelBackendTask(tid);
  }, []);

  const updateVideoCropSession = useCallback(
    (updater: (prev: VideoCropSessionState) => VideoCropSessionState) => {
      setMediaSession((prev) => ({ ...prev, videoCrop: updater(prev.videoCrop) }));
    },
    [],
  );

  const startVideoCropTask = useCallback(
    async (
      req: Omit<CropRotateVideoRequest, "taskId">,
      formatError: (err: unknown) => string,
    ): Promise<CropRotateVideoResult | null> => {
      if (activeCropTaskRef.current) return null;
      const taskId = `v09-crop-${Date.now()}-${taskSeqRef.current++}`;
      activeCropTaskRef.current = taskId;
      setMediaSession((prev) => ({
        ...prev,
        videoCrop: {
          ...prev.videoCrop,
          taskStatus: "running",
          activeTaskId: taskId,
          liveProgress: {
            taskId,
            toolId: "V09",
            phase: "running",
            currentItem: 1,
            totalItems: 1,
            itemName: req.sourcePath,
            percent: 0,
            outTimeSec: 0,
            totalDurationSec: null,
          },
          errorMessage: null,
        },
      }));
      try {
        const res = await cropRotateVideo({ ...req, taskId });
        if (activeCropTaskRef.current !== taskId) return null;
        activeCropTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          videoCrop: {
            ...prev.videoCrop,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            lastResult: res,
            errorMessage: null,
          },
        }));
        return res;
      } catch (err) {
        if (activeCropTaskRef.current !== taskId) return null;
        activeCropTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          videoCrop: {
            ...prev.videoCrop,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            errorMessage: formatError(err),
          },
        }));
        return null;
      }
    },
    [],
  );

  const cancelVideoCropTask = useCallback(async () => {
    const tid = activeCropTaskRef.current;
    if (tid) await cancelBackendTask(tid);
  }, []);

  const updateVideoSpeedSession = useCallback(
    (updater: (prev: VideoSpeedSessionState) => VideoSpeedSessionState) => {
      setMediaSession((prev) => ({ ...prev, videoSpeed: updater(prev.videoSpeed) }));
    },
    [],
  );

  const startVideoSpeedBatch = useCallback(
    async (
      req: Omit<ChangeVideoSpeedBatchRequest, "taskId">,
      formatError: (err: unknown) => string,
    ): Promise<ChangeVideoSpeedBatchResponse | null> => {
      if (activeSpeedTaskRef.current) return null;
      const taskId = `v03-speed-${Date.now()}-${taskSeqRef.current++}`;
      activeSpeedTaskRef.current = taskId;
      setMediaSession((prev) => ({
        ...prev,
        videoSpeed: {
          ...prev.videoSpeed,
          taskStatus: "running",
          activeTaskId: taskId,
          liveProgress: {
            taskId,
            toolId: "V03",
            phase: "running",
            currentItem: 1,
            totalItems: req.sourcePaths.length,
            itemName: req.sourcePaths[0] ?? null,
            percent: 0,
            outTimeSec: 0,
            totalDurationSec: null,
          },
          errorMessage: null,
        },
      }));
      try {
        const res = await changeVideoSpeedBatch({ ...req, taskId });
        if (activeSpeedTaskRef.current !== taskId) return null;
        activeSpeedTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          videoSpeed: {
            ...prev.videoSpeed,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            lastReport: res,
            errorMessage: null,
          },
        }));
        return res;
      } catch (err) {
        if (activeSpeedTaskRef.current !== taskId) return null;
        activeSpeedTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          videoSpeed: {
            ...prev.videoSpeed,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            errorMessage: formatError(err),
          },
        }));
        return null;
      }
    },
    [],
  );

  const cancelVideoSpeedBatch = useCallback(async () => {
    const tid = activeSpeedTaskRef.current;
    if (tid) await cancelBackendTask(tid);
  }, []);

  const updateVideoMergeSession = useCallback(
    (updater: (prev: VideoMergeSessionState) => VideoMergeSessionState) => {
      setMediaSession((prev) => ({ ...prev, videoMerge: updater(prev.videoMerge) }));
    },
    [],
  );

  const startVideoMergeTask = useCallback(
    async (
      req: Omit<MergeVideosRequest, "taskId">,
      formatError: (err: unknown) => string,
    ): Promise<MergeVideosResult | null> => {
      if (activeMergeTaskRef.current) return null;
      const taskId = `v12-merge-${Date.now()}-${taskSeqRef.current++}`;
      activeMergeTaskRef.current = taskId;
      setMediaSession((prev) => ({
        ...prev,
        videoMerge: {
          ...prev.videoMerge,
          taskStatus: "running",
          activeTaskId: taskId,
          liveProgress: {
            taskId,
            toolId: "V12",
            phase: "running",
            currentItem: 1,
            totalItems: req.sourcePaths.length,
            itemName: `${req.sourcePaths.length} clips`,
            percent: 0,
            outTimeSec: 0,
            totalDurationSec: null,
          },
          errorMessage: null,
        },
      }));
      try {
        const res = await mergeVideos({ ...req, taskId });
        if (activeMergeTaskRef.current !== taskId) return null;
        activeMergeTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          videoMerge: {
            ...prev.videoMerge,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            lastResult: res,
            errorMessage: null,
          },
        }));
        return res;
      } catch (err) {
        if (activeMergeTaskRef.current !== taskId) return null;
        activeMergeTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          videoMerge: {
            ...prev.videoMerge,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            errorMessage: formatError(err),
          },
        }));
        return null;
      }
    },
    [],
  );

  const cancelVideoMergeTask = useCallback(async () => {
    const tid = activeMergeTaskRef.current;
    if (tid) await cancelBackendTask(tid);
  }, []);

  const updateAudioTrimSession = useCallback(
    (updater: (prev: AudioTrimSessionState) => AudioTrimSessionState) => {
      setMediaSession((prev) => ({ ...prev, audioTrim: updater(prev.audioTrim) }));
    },
    [],
  );

  const startAudioTrimTask = useCallback(
    async (
      req: Omit<TrimAudioRequest, "taskId">,
      formatError: (err: unknown) => string,
    ): Promise<TrimAudioResult | null> => {
      if (activeAudioTrimTaskRef.current) return null;
      const taskId = `a03-trim-${Date.now()}-${taskSeqRef.current++}`;
      activeAudioTrimTaskRef.current = taskId;
      setMediaSession((prev) => ({
        ...prev,
        audioTrim: {
          ...prev.audioTrim,
          taskStatus: "running",
          activeTaskId: taskId,
          liveProgress: {
            taskId,
            toolId: "A03",
            phase: "running",
            currentItem: 1,
            totalItems: 1,
            itemName: req.sourcePath,
            percent: 0,
            outTimeSec: 0,
            totalDurationSec: Math.max(0, req.endSec - req.startSec),
          },
          errorMessage: null,
        },
      }));
      try {
        const res = await trimAudioFile({ ...req, taskId });
        if (activeAudioTrimTaskRef.current !== taskId) return null;
        activeAudioTrimTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          audioTrim: {
            ...prev.audioTrim,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            lastResult: res,
            errorMessage: null,
          },
        }));
        return res;
      } catch (err) {
        if (activeAudioTrimTaskRef.current !== taskId) return null;
        activeAudioTrimTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          audioTrim: {
            ...prev.audioTrim,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            errorMessage: formatError(err),
          },
        }));
        return null;
      }
    },
    [],
  );

  const cancelAudioTrimTask = useCallback(async () => {
    const tid = activeAudioTrimTaskRef.current;
    if (tid) await cancelBackendTask(tid);
  }, []);

  const updateAudioConvertSession = useCallback(
    (updater: (prev: AudioConvertSessionState) => AudioConvertSessionState) => {
      setMediaSession((prev) => ({ ...prev, audioConvert: updater(prev.audioConvert) }));
    },
    [],
  );

  const startAudioConvertBatch = useCallback(
    async (
      req: Omit<ConvertAudioBatchRequest, "taskId">,
      formatError: (err: unknown) => string,
    ): Promise<ConvertAudioBatchResponse | null> => {
      if (activeAudioConvertTaskRef.current) return null;
      const taskId = `a05-conv-${Date.now()}-${taskSeqRef.current++}`;
      activeAudioConvertTaskRef.current = taskId;
      setMediaSession((prev) => ({
        ...prev,
        audioConvert: {
          ...prev.audioConvert,
          taskStatus: "running",
          activeTaskId: taskId,
          liveProgress: {
            taskId,
            toolId: "A05",
            phase: "running",
            currentItem: 1,
            totalItems: req.sourcePaths.length,
            itemName: req.sourcePaths[0] ?? null,
            percent: 0,
            outTimeSec: 0,
            totalDurationSec: null,
          },
          errorMessage: null,
        },
      }));
      try {
        const res = await convertAudioBatch({ ...req, taskId });
        if (activeAudioConvertTaskRef.current !== taskId) return null;
        activeAudioConvertTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          audioConvert: {
            ...prev.audioConvert,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            lastReport: res,
            errorMessage: null,
          },
        }));
        return res;
      } catch (err) {
        if (activeAudioConvertTaskRef.current !== taskId) return null;
        activeAudioConvertTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          audioConvert: {
            ...prev.audioConvert,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            errorMessage: formatError(err),
          },
        }));
        return null;
      }
    },
    [],
  );

  const cancelAudioConvertBatch = useCallback(async () => {
    const tid = activeAudioConvertTaskRef.current;
    if (tid) await cancelBackendTask(tid);
  }, []);

  const updateAudioCleanupSession = useCallback(
    (updater: (prev: AudioCleanupSessionState) => AudioCleanupSessionState) => {
      setMediaSession((prev) => ({ ...prev, audioCleanup: updater(prev.audioCleanup) }));
    },
    [],
  );

  const startAudioCleanupTask = useCallback(
    async (
      req: Omit<CleanUpAudioRequest, "taskId">,
      formatError: (err: unknown) => string,
    ): Promise<CleanUpAudioResult | null> => {
      if (activeAudioCleanupTaskRef.current) return null;
      const taskId = `a01-clean-${Date.now()}-${taskSeqRef.current++}`;
      activeAudioCleanupTaskRef.current = taskId;
      setMediaSession((prev) => ({
        ...prev,
        audioCleanup: {
          ...prev.audioCleanup,
          taskStatus: "running",
          activeTaskId: taskId,
          liveProgress: {
            taskId,
            toolId: "A01",
            phase: "analyzing",
            currentItem: 1,
            totalItems: 1,
            itemName: req.sourcePath,
            percent: 0,
            outTimeSec: 0,
            totalDurationSec: null,
          },
          errorMessage: null,
        },
      }));
      try {
        const res = await cleanUpAudio({ ...req, taskId });
        if (activeAudioCleanupTaskRef.current !== taskId) return null;
        activeAudioCleanupTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          audioCleanup: {
            ...prev.audioCleanup,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            lastResult: res,
            errorMessage: null,
          },
        }));
        return res;
      } catch (err) {
        if (activeAudioCleanupTaskRef.current !== taskId) return null;
        activeAudioCleanupTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          audioCleanup: {
            ...prev.audioCleanup,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            errorMessage: formatError(err),
          },
        }));
        return null;
      }
    },
    [],
  );

  const cancelAudioCleanupTask = useCallback(async () => {
    const tid = activeAudioCleanupTaskRef.current;
    if (tid) await cancelBackendTask(tid);
  }, []);

  const updateVideoReplaceAudioSession = useCallback(
    (updater: (prev: VideoReplaceAudioSessionState) => VideoReplaceAudioSessionState) => {
      setMediaSession((prev) => ({ ...prev, videoReplaceAudio: updater(prev.videoReplaceAudio) }));
    },
    [],
  );

  const startVideoReplaceAudioTask = useCallback(
    async (
      req: Omit<ReplaceAudioRequest, "taskId">,
      formatError: (err: unknown) => string,
    ): Promise<ReplaceAudioResult | null> => {
      if (activeVideoReplaceAudioTaskRef.current) return null;
      const taskId = `v14-replace-${Date.now()}-${taskSeqRef.current++}`;
      activeVideoReplaceAudioTaskRef.current = taskId;
      setMediaSession((prev) => ({
        ...prev,
        videoReplaceAudio: {
          ...prev.videoReplaceAudio,
          taskStatus: "running",
          activeTaskId: taskId,
          liveProgress: {
            taskId,
            toolId: "V14",
            phase: "running",
            currentItem: 1,
            totalItems: 1,
            itemName: req.options.videoPath,
            percent: 0,
            outTimeSec: 0,
            totalDurationSec: null,
          },
          errorMessage: null,
        },
      }));
      try {
        const res = await replaceVideoAudio({ ...req, taskId });
        if (activeVideoReplaceAudioTaskRef.current !== taskId) return null;
        activeVideoReplaceAudioTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          videoReplaceAudio: {
            ...prev.videoReplaceAudio,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            lastResult: res,
            errorMessage: null,
          },
        }));
        return res;
      } catch (err) {
        if (activeVideoReplaceAudioTaskRef.current !== taskId) return null;
        activeVideoReplaceAudioTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          videoReplaceAudio: {
            ...prev.videoReplaceAudio,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            errorMessage: formatError(err),
          },
        }));
        return null;
      }
    },
    [],
  );

  const cancelVideoReplaceAudioTask = useCallback(async () => {
    const tid = activeVideoReplaceAudioTaskRef.current;
    if (tid) await cancelBackendTask(tid);
  }, []);

  const updateVideoSubtitlesSession = useCallback(
    (updater: (prev: VideoSubtitlesSessionState) => VideoSubtitlesSessionState) => {
      setMediaSession((prev) => ({ ...prev, videoSubtitles: updater(prev.videoSubtitles) }));
    },
    [],
  );

  const startVideoSubtitlesTask = useCallback(
    async (
      req: Omit<BurnInSubtitlesRequest, "taskId">,
      formatError: (err: unknown) => string,
    ): Promise<BurnInSubtitlesResult | null> => {
      if (activeVideoSubtitlesTaskRef.current) return null;
      const taskId = `v02-sub-${Date.now()}-${taskSeqRef.current++}`;
      activeVideoSubtitlesTaskRef.current = taskId;
      setMediaSession((prev) => ({
        ...prev,
        videoSubtitles: {
          ...prev.videoSubtitles,
          taskStatus: "running",
          activeTaskId: taskId,
          liveProgress: {
            taskId,
            toolId: "V02",
            phase: "running",
            currentItem: 1,
            totalItems: 1,
            itemName: req.videoPath,
            percent: 0,
            outTimeSec: 0,
            totalDurationSec: null,
          },
          errorMessage: null,
        },
      }));
      try {
        const res = await burnInSubtitles({ ...req, taskId });
        if (activeVideoSubtitlesTaskRef.current !== taskId) return null;
        activeVideoSubtitlesTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          videoSubtitles: {
            ...prev.videoSubtitles,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            lastResult: res,
            errorMessage: null,
          },
        }));
        return res;
      } catch (err) {
        if (activeVideoSubtitlesTaskRef.current !== taskId) return null;
        activeVideoSubtitlesTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          videoSubtitles: {
            ...prev.videoSubtitles,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            errorMessage: formatError(err),
          },
        }));
        return null;
      }
    },
    [],
  );

  const cancelVideoSubtitlesTask = useCallback(async () => {
    const tid = activeVideoSubtitlesTaskRef.current;
    if (tid) await cancelBackendTask(tid);
  }, []);

  const updateVideoWatermarkSession = useCallback(
    (updater: (prev: VideoWatermarkSessionState) => VideoWatermarkSessionState) => {
      setMediaSession((prev) => ({ ...prev, videoWatermark: updater(prev.videoWatermark) }));
    },
    [],
  );

  const startVideoWatermarkTask = useCallback(
    async (
      req: Omit<WatermarkVideoRequest, "taskId">,
      formatError: (err: unknown) => string,
    ): Promise<WatermarkVideoResult | null> => {
      if (activeVideoWatermarkTaskRef.current) return null;
      const taskId = `i13-vidwm-${Date.now()}-${taskSeqRef.current++}`;
      activeVideoWatermarkTaskRef.current = taskId;
      setMediaSession((prev) => ({
        ...prev,
        videoWatermark: {
          ...prev.videoWatermark,
          taskStatus: "running",
          activeTaskId: taskId,
          liveProgress: {
            taskId,
            toolId: "I13",
            phase: "running",
            currentItem: 1,
            totalItems: 1,
            itemName: req.sourcePath,
            percent: 0,
            outTimeSec: 0,
            totalDurationSec: null,
          },
          errorMessage: null,
        },
      }));
      try {
        const res = await watermarkVideo({ ...req, taskId });
        if (activeVideoWatermarkTaskRef.current !== taskId) return null;
        activeVideoWatermarkTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          videoWatermark: {
            ...prev.videoWatermark,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            lastResult: res,
            errorMessage: null,
          },
        }));
        return res;
      } catch (err) {
        if (activeVideoWatermarkTaskRef.current !== taskId) return null;
        activeVideoWatermarkTaskRef.current = null;
        setMediaSession((prev) => ({
          ...prev,
          videoWatermark: {
            ...prev.videoWatermark,
            taskStatus: "idle",
            activeTaskId: null,
            liveProgress: null,
            errorMessage: formatError(err),
          },
        }));
        return null;
      }
    },
    [],
  );

  const cancelVideoWatermarkTask = useCallback(async () => {
    const tid = activeVideoWatermarkTaskRef.current;
    if (tid) await cancelBackendTask(tid);
  }, []);

  const handoffMediaFileToTool = useCallback(
    (toolId: string, filePath: string) => {
      const next = { toolId, path: filePath, nonce: Date.now() + taskSeqRef.current++ };
      pendingHandoffRef.current = next;
      setPendingHandoff(next);
      onNavigateToTool?.(toolId);
    },
    [onNavigateToTool],
  );

  const consumePendingHandoff = useCallback((toolId: string): string | null => {
    const cur = pendingHandoffRef.current;
    if (cur && cur.toolId === toolId) {
      pendingHandoffRef.current = null;
      setPendingHandoff(null);
      return cur.path;
    }
    return null;
  }, []);

  return (
    <MediaSessionContext.Provider
      value={{
        mediaSession,
        updateMediaInfoSession,
        updateVideoTrimSession,
        startVideoTrimTask,
        cancelVideoTrimTask,
        updateVideoMuteSession,
        startVideoMuteBatch,
        cancelVideoMuteBatch,
        updateAudioExtractSession,
        startAudioExtractBatch,
        cancelAudioExtractBatch,
        updateVideoFramesSession,
        startVideoFramesTask,
        cancelVideoFramesTask,
        updateVideoGifSession,
        startVideoGifTask,
        cancelVideoGifTask,
        updateVideoConvertSession,
        startVideoConvertBatch,
        cancelVideoConvertBatch,
        updateVideoCompressSession,
        startVideoCompressBatch,
        cancelVideoCompressBatch,
        updateVideoResizeSession,
        startVideoResizeBatch,
        cancelVideoResizeBatch,
        updateVideoCropSession,
        startVideoCropTask,
        cancelVideoCropTask,
        updateVideoSpeedSession,
        startVideoSpeedBatch,
        cancelVideoSpeedBatch,
        updateVideoMergeSession,
        startVideoMergeTask,
        cancelVideoMergeTask,
        updateAudioTrimSession,
        startAudioTrimTask,
        cancelAudioTrimTask,
        updateAudioConvertSession,
        startAudioConvertBatch,
        cancelAudioConvertBatch,
        updateAudioCleanupSession,
        startAudioCleanupTask,
        cancelAudioCleanupTask,
        updateVideoReplaceAudioSession,
        startVideoReplaceAudioTask,
        cancelVideoReplaceAudioTask,
        updateVideoSubtitlesSession,
        startVideoSubtitlesTask,
        cancelVideoSubtitlesTask,
        updateVideoWatermarkSession,
        startVideoWatermarkTask,
        cancelVideoWatermarkTask,
        handoffMediaFileToTool,
        pendingHandoff,
        consumePendingHandoff,
      }}
    >
      {children}
    </MediaSessionContext.Provider>
  );
}

export function useOptionalMediaSession(): MediaSessionContextValue | null {
  return useContext(MediaSessionContext);
}

export function useMediaSession(): MediaSessionContextValue {
  const ctx = useContext(MediaSessionContext);
  if (!ctx) {
    throw new Error("useMediaSession must be used inside MediaSessionProvider");
  }
  return ctx;
}
