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
  subscribeMediaTaskProgress,
  trimVideoFile,
  type MediaProbeReport,
  type MediaTaskProgressPayload,
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

export interface MediaSessionRoot {
  mediaInfo: MediaInfoSessionState;
  videoTrim: VideoTrimSessionState;
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
  const pendingHandoffRef = useRef(pendingHandoff);
  pendingHandoffRef.current = pendingHandoff;

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeMediaTaskProgress((payload) => {
          if (payload.toolId === "V11" && payload.taskId === activeTrimTaskRef.current) {
            setMediaSession((prev) => ({
              ...prev,
              videoTrim: {
                ...prev.videoTrim,
                liveProgress: payload,
              },
            }));
          }
        }),
      "winkit://media-progress",
    );
  }, []);

  const updateMediaInfoSession = useCallback(
    (updater: (prev: MediaInfoSessionState) => MediaInfoSessionState) => {
      setMediaSession((prev) => ({
        ...prev,
        mediaInfo: updater(prev.mediaInfo),
      }));
    },
    [],
  );

  const updateVideoTrimSession = useCallback(
    (updater: (prev: VideoTrimSessionState) => VideoTrimSessionState) => {
      setMediaSession((prev) => ({
        ...prev,
        videoTrim: updater(prev.videoTrim),
      }));
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
    if (tid) {
      await cancelBackendTask(tid);
    }
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
