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
  cancelBackendTask,
  convertVideoToGif,
  extractAudioBatch,
  extractVideoFrames,
  muteVideosBatch,
  subscribeMediaTaskProgress,
  trimVideoFile,
  type AudioExtractFormat,
  type ConvertVideoToGifRequest,
  type ConvertVideoToGifResult,
  type ExtractAudioBatchRequest,
  type ExtractAudioBatchResponse,
  type ExtractFramesRequest,
  type ExtractFramesResponse,
  type FrameExtractMode,
  type FrameImageFormat,
  type FrameResolutionPreset,
  type GifWidthPreset,
  type MediaProbeReport,
  type MediaTaskProgressPayload,
  type MuteVideosBatchRequest,
  type MuteVideosBatchResponse,
  type TrimKeyframeAnalysis,
  type TrimVideoRequest,
  type TrimVideoResult,
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

export interface MediaSessionRoot {
  mediaInfo: MediaInfoSessionState;
  videoTrim: VideoTrimSessionState;
  videoMute: VideoMuteSessionState;
  audioExtract: AudioExtractSessionState;
  videoFrames: VideoFramesSessionState;
  videoGif: VideoGifSessionState;
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
        handoffMediaFileToTool,
        pendingHandoff,
        consumePendingHandoff,
      }}
    >
      {children}
    </MediaSessionContext.Provider>
  );
}

export function useMediaSession(): MediaSessionContextValue {
  const ctx = useContext(MediaSessionContext);
  if (!ctx) {
    throw new Error("useMediaSession must be used inside MediaSessionProvider");
  }
  return ctx;
}
