import { FileVideo, FolderOpen, Pause, Play, Scissors, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { MediaToolsSetupPanel } from "../../components/MediaToolsSetupPanel";
import { useI18n } from "../../i18n/I18nContext";
import { useMediaSession } from "../../lib/mediaSessionStore";
import {
  analyzeTrimKeyframes,
  bindDisposableListener,
  extractMediaPosterDataUrl,
  formatLocalizedError,
  openLocalDirectory,
  pickSaveFilePath,
  pickSingleFile,
  probeMediaInfo,
  registerMediaPreviewPath,
  subscribeFileDrop,
  type MediaToolsStatus,
  type VideoTrimMode,
} from "../../lib/tauriBridge";
import {
  VIDEO_EXTENSIONS,
  formatDurationLabel,
  formatMediaBytes,
  formatOrientationLabel,
  formatTimecode,
  getFileName,
  getFileStemAndExt,
  getParentDir,
  parseTimecodeInput,
  suggestMediaOutputPath,
} from "../media-shared/mediaFormat";
import "../media-shared/mediaWorkspace.css";

export function VideoTrimWorkspace() {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const {
    mediaSession,
    updateVideoTrimSession,
    startVideoTrimTask,
    cancelVideoTrimTask,
    pendingHandoff,
    consumePendingHandoff,
  } = useMediaSession();
  const state = mediaSession.videoTrim;

  const [toolsStatus, setToolsStatus] = useState<MediaToolsStatus | null>(null);
  const [hovering, setHovering] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewingSegment, setPreviewingSegment] = useState(false);
  const [startInput, setStartInput] = useState("00:00.000");
  const [endInput, setEndInput] = useState("00:00.000");
  const [dragging, setDragging] = useState<"start" | "end" | "playhead" | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  const duration = state.probe?.durationSec ?? 0;

  useEffect(() => {
    setStartInput(formatTimecode(state.startSec));
  }, [state.startSec]);

  useEffect(() => {
    setEndInput(formatTimecode(state.endSec));
  }, [state.endSec]);

  const loadVideoFile = useCallback(
    async (filePath: string) => {
      setLoadingFile(true);
      setIsPlaying(false);
      setPreviewingSegment(false);
      setPlayheadSec(0);
      updateVideoTrimSession((prev) => ({
        ...prev,
        errorMessage: null,
        lastResult: null,
        keyframeAnalysis: null,
      }));
      try {
        const probe = await probeMediaInfo(filePath);
        if (!probe.hasVideo) {
          throw new Error(
            isZh
              ? "所选文件不包含视频流，无法进行视频剪切。"
              : "Selected file has no video stream.",
          );
        }
        const preview = await registerMediaPreviewPath(filePath);
        const dur = probe.durationSec ?? 0;
        const { ext } = getFileStemAndExt(filePath);
        const defaultOutExt = ["mp4", "mov", "mkv", "webm", "m4v"].includes(ext) ? ext : "mp4";
        const defaultOut = suggestMediaOutputPath(filePath, "_trim", defaultOutExt);

        updateVideoTrimSession((prev) => ({
          ...prev,
          sourcePath: filePath,
          probe,
          previewUrl: preview.url,
          posterUrl: null,
          playbackUnsupported: false,
          startSec: 0,
          endSec: dur,
          outputPath: defaultOut,
          keyframeAnalysis: null,
          lastResult: null,
          errorMessage: null,
        }));

        // Extract lightweight fallback poster asynchronously in case WebView2 cannot decode container
        void extractMediaPosterDataUrl(filePath, Math.min(0.2, dur * 0.1))
          .then((poster) => {
            updateVideoTrimSession((prev) =>
              prev.sourcePath === filePath ? { ...prev, posterUrl: poster } : prev,
            );
          })
          .catch(() => {});
      } catch (err) {
        updateVideoTrimSession((prev) => ({
          ...prev,
          errorMessage: formatLocalizedError(err, t),
        }));
      } finally {
        setLoadingFile(false);
      }
    },
    [isZh, t, updateVideoTrimSession],
  );

  // Consume incoming handoff from V10 Media Info
  useEffect(() => {
    if (pendingHandoff?.toolId === "V11") {
      const path = consumePendingHandoff("V11");
      if (path) {
        void loadVideoFile(path);
      }
    }
  }, [pendingHandoff, consumePendingHandoff, loadVideoFile]);

  // Drag and drop
  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: setHovering,
          onDropPaths: (paths) => {
            const first = paths[0];
            if (first) void loadVideoFile(first);
          },
        }),
      "v11-file-drop",
    );
  }, [loadVideoFile]);

  // Debounced keyframe alignment analysis for Stream Copy mode
  useEffect(() => {
    if (!state.sourcePath || !state.probe?.hasVideo || state.endSec <= state.startSec) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void analyzeTrimKeyframes(state.sourcePath!, state.startSec, state.endSec)
        .then((analysis) => {
          if (!cancelled) {
            updateVideoTrimSession((prev) => ({ ...prev, keyframeAnalysis: analysis }));
          }
        })
        .catch(() => {
          if (!cancelled) {
            updateVideoTrimSession((prev) => ({ ...prev, keyframeAnalysis: null }));
          }
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    state.sourcePath,
    state.probe?.hasVideo,
    state.startSec,
    state.endSec,
    updateVideoTrimSession,
  ]);

  const seekVideoTo = useCallback(
    (sec: number) => {
      const clamped = duration > 0 ? Math.max(0, Math.min(duration, sec)) : Math.max(0, sec);
      setPlayheadSec(clamped);
      if (videoRef.current && !state.playbackUnsupported) {
        try {
          videoRef.current.currentTime = clamped;
        } catch {
          // Ignore seek errors while metadata loads
        }
      }
    },
    [duration, state.playbackUnsupported],
  );

  const setBounds = useCallback(
    (nextStart: number, nextEnd: number) => {
      const maxDur = duration > 0 ? duration : Math.max(nextEnd, 1);
      const minGap = Math.min(0.1, maxDur);
      const clampedStart = Math.max(0, Math.min(maxDur - minGap, nextStart));
      const clampedEnd = Math.max(clampedStart + minGap, Math.min(maxDur, nextEnd));
      updateVideoTrimSession((prev) => ({
        ...prev,
        startSec: Number(clampedStart.toFixed(3)),
        endSec: Number(clampedEnd.toFixed(3)),
      }));
    },
    [duration, updateVideoTrimSession],
  );

  const clientXToSeconds = useCallback(
    (clientX: number): number => {
      const el = trackRef.current;
      if (!el || duration <= 0) return 0;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return 0;
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return ratio * duration;
    },
    [duration],
  );

  const handleTrackPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const sec = clientXToSeconds(e.clientX);
    setDragging("playhead");
    seekVideoTo(sec);
  };

  const handleHandlePointerDown =
    (which: "start" | "end") => (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      if (duration <= 0) return;
      trackRef.current?.setPointerCapture(e.pointerId);
      setDragging(which);
    };

  const handleTrackPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging || duration <= 0) return;
    const sec = clientXToSeconds(e.clientX);
    if (dragging === "start") {
      setBounds(Math.min(sec, state.endSec - 0.1), state.endSec);
      seekVideoTo(Math.min(sec, state.endSec - 0.1));
    } else if (dragging === "end") {
      setBounds(state.startSec, Math.max(sec, state.startSec + 0.1));
      seekVideoTo(Math.max(sec, state.startSec + 0.1));
    } else {
      seekVideoTo(sec);
    }
  };

  const handleTrackPointerUp = () => {
    setDragging(null);
  };

  const handleTogglePlay = async () => {
    const v = videoRef.current;
    if (!v || state.playbackUnsupported) return;
    if (v.paused) {
      setPreviewingSegment(false);
      try {
        await v.play();
      } catch {
        // Ignore browser autoplay restrictions
      }
    } else {
      v.pause();
    }
  };

  const handlePreviewSegment = async () => {
    const v = videoRef.current;
    if (!v || state.playbackUnsupported) return;
    setPreviewingSegment(true);
    v.currentTime = state.startSec;
    setPlayheadSec(state.startSec);
    try {
      await v.play();
    } catch {
      // Ignore play error
    }
  };

  const handleVideoTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    setPlayheadSec(v.currentTime);
    if (previewingSegment && v.currentTime >= state.endSec) {
      v.pause();
      v.currentTime = state.endSec;
      setPreviewingSegment(false);
    }
  };

  const handlePickVideo = async () => {
    const path = await pickSingleFile({
      title: isZh ? "选择要剪切的视频文件" : "Select a video file to trim",
      filters: [{ name: isZh ? "视频文件" : "Video Files", extensions: VIDEO_EXTENSIONS }],
    });
    if (path) {
      await loadVideoFile(path);
    }
  };

  const handlePickOutput = async () => {
    if (!state.sourcePath) return;
    const { stem, ext } = getFileStemAndExt(state.sourcePath);
    const defaultExt =
      state.mode === "accurate" && !["mp4", "mov", "mkv", "webm"].includes(ext)
        ? "mp4"
        : ext || "mp4";
    const chosen = await pickSaveFilePath({
      title: isZh ? "选择剪切输出文件" : "Choose trimmed output file",
      defaultPath: state.outputPath || `${stem}_trim.${defaultExt}`,
      filters: [
        {
          name: isZh ? "视频文件" : "Video Files",
          extensions: [defaultExt, "mp4", "mkv", "mov", "webm"],
        },
      ],
    });
    if (chosen) {
      updateVideoTrimSession((prev) => ({ ...prev, outputPath: chosen }));
    }
  };

  const handleModeChange = (nextMode: VideoTrimMode) => {
    updateVideoTrimSession((prev) => {
      let nextOut = prev.outputPath;
      if (prev.sourcePath && nextMode === "accurate") {
        const { ext } = getFileStemAndExt(prev.outputPath);
        if (!["mp4", "mov", "mkv", "webm"].includes(ext)) {
          nextOut = suggestMediaOutputPath(prev.sourcePath, "_trim", "mp4");
        }
      }
      return { ...prev, mode: nextMode, outputPath: nextOut };
    });
  };

  const handleExport = async () => {
    if (!state.sourcePath || !state.outputPath.trim()) return;
    await startVideoTrimTask(
      {
        sourcePath: state.sourcePath,
        outputPath: state.outputPath.trim(),
        startSec: state.startSec,
        endSec: state.endSec,
        mode: state.mode,
        allowOverwrite: false,
      },
      (err) => formatLocalizedError(err, t),
    );
  };

  const handleRefreshPosterAtPlayhead = async () => {
    if (!state.sourcePath) return;
    try {
      const poster = await extractMediaPosterDataUrl(state.sourcePath, playheadSec);
      updateVideoTrimSession((prev) => ({ ...prev, posterUrl: poster }));
    } catch {
      // Ignore poster refresh failure
    }
  };

  const mediaReady = toolsStatus?.ready ?? true;
  const primaryVideo = state.probe?.videoStreams[0] ?? null;
  const selectedSpan = Math.max(0, state.endSec - state.startSec);
  const startPct = duration > 0 ? (state.startSec / duration) * 100 : 0;
  const endPct = duration > 0 ? (state.endSec / duration) * 100 : 100;
  const playheadPct = duration > 0 ? (playheadSec / duration) * 100 : 0;
  const kfShiftStartPct =
    duration > 0 && state.mode === "stream_copy" && state.keyframeAnalysis?.hasKeyframeShift
      ? (state.keyframeAnalysis.actualStreamCopyStartSec / duration) * 100
      : null;

  return (
    <div className="media-workspace">
      <MediaToolsSetupPanel onStatusChange={setToolsStatus} />

      {state.errorMessage && (
        <div className="status-banner is-err" role="alert">
          <span>{state.errorMessage}</span>
        </div>
      )}

      {!state.sourcePath ? (
        <div className={`media-dropzone ${hovering ? "is-hover" : ""}`}>
          <p style={{ margin: 0, fontWeight: 600 }}>
            {isZh ? "拖入视频文件开始剪切片段" : "Drop a video file to trim a segment"}
          </p>
          <p className="field-hint" style={{ margin: 0 }}>
            {isZh
              ? "支持拖动起止点、按播放头设定边界与片段预览；提供「快速流复制」与「精确剪切（重编码）」，导出前直观显示关键帧对齐差异。"
              : "Drag start/end handles, set bounds from the playhead, preview selection, and choose between Fast Stream Copy (with pre-export keyframe shift notice) and Accurate Transcode."}
          </p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!mediaReady || loadingFile}
            onClick={() => void handlePickVideo()}
          >
            <FileVideo size={15} aria-hidden="true" />
            <span>
              {loadingFile
                ? isZh
                  ? "正在读取视频…"
                  : "Loading..."
                : isZh
                  ? "选择视频文件…"
                  : "Select Video File..."}
            </span>
          </button>
        </div>
      ) : (
        <div className="media-split">
          {/* Primary visual stage + interactive timeline */}
          <div className="media-stage-card">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "8px",
                flexWrap: "wrap",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                <strong
                  className="mono"
                  style={{ fontSize: "13px", overflow: "hidden", textOverflow: "ellipsis" }}
                >
                  {getFileName(state.sourcePath)}
                </strong>
                {primaryVideo?.displayWidth && primaryVideo?.displayHeight && (
                  <span className="badge mono">
                    {primaryVideo.displayWidth}×{primaryVideo.displayHeight}
                  </span>
                )}
                {primaryVideo && (
                  <span className="badge">
                    {formatOrientationLabel(
                      primaryVideo.orientation,
                      primaryVideo.rotationDegrees,
                      locale,
                    )}
                  </span>
                )}
                {state.probe && !state.probe.hasAudio && (
                  <span className="media-status-pill is-neutral">
                    {isZh ? "无音轨" : "No Audio"}
                  </span>
                )}
              </div>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={state.taskStatus === "running"}
                onClick={() => void handlePickVideo()}
              >
                {isZh ? "更换视频…" : "Change Video..."}
              </button>
            </div>

            <div className="media-video-box">
              {!state.playbackUnsupported && state.previewUrl ? (
                <video
                  ref={videoRef}
                  src={state.previewUrl}
                  poster={state.posterUrl ?? undefined}
                  className="media-video-el"
                  controls
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => {
                    setIsPlaying(false);
                    setPreviewingSegment(false);
                  }}
                  onTimeUpdate={handleVideoTimeUpdate}
                  onError={() => {
                    updateVideoTrimSession((prev) => ({
                      ...prev,
                      playbackUnsupported: true,
                    }));
                  }}
                />
              ) : (
                <div className="media-fallback-stage">
                  {state.posterUrl && (
                    <img
                      src={state.posterUrl}
                      alt={getFileName(state.sourcePath)}
                      className="media-fallback-poster"
                    />
                  )}
                  <div className="media-fallback-note">
                    {isZh
                      ? "当前内置播放器暂无法直接播放该封装格式或视频编码（素材完好，并非损坏）。您仍可使用下方时间轴、输入起止时间并正常完成剪切导出。"
                      : "This container or codec cannot be played directly inside WebView (the file is valid, not corrupted). You can still set timestamps below and export normally."}
                  </div>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void handleRefreshPosterAtPlayhead()}
                  >
                    {isZh
                      ? `刷新 ${formatTimecode(playheadSec)} 预览帧`
                      : `Preview frame at ${formatTimecode(playheadSec)}`}
                  </button>
                </div>
              )}
            </div>

            {/* Timeline scrubber */}
            <div className="trim-timeline-wrap">
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: "12px",
                  color: "var(--text-secondary)",
                }}
              >
                <span className="mono">
                  {isZh ? "播放头：" : "Playhead: "}
                  {formatTimecode(playheadSec)}
                </span>
                <span className="mono">
                  {isZh ? "已选片段：" : "Selection: "}
                  {formatTimecode(state.startSec)} → {formatTimecode(state.endSec)} (
                  {selectedSpan.toFixed(2)} s)
                </span>
                <span className="mono">
                  {isZh ? "总时长：" : "Total: "}
                  {formatDurationLabel(state.probe?.durationSec, locale)}
                </span>
              </div>

              <div
                ref={trackRef}
                className="trim-timeline-track"
                role="group"
                aria-label={isZh ? "视频剪切时间轴" : "Video trim timeline"}
                onPointerDown={handleTrackPointerDown}
                onPointerMove={handleTrackPointerMove}
                onPointerUp={handleTrackPointerUp}
              >
                {kfShiftStartPct != null && (
                  <div
                    className="trim-timeline-keyframe-shift"
                    style={{
                      left: `${kfShiftStartPct}%`,
                      width: `${Math.max(0, startPct - kfShiftStartPct)}%`,
                    }}
                    title={isZh ? "流复制关键帧提前范围" : "Stream-copy keyframe offset range"}
                  />
                )}
                <div
                  className="trim-timeline-selection"
                  style={{
                    left: `${startPct}%`,
                    width: `${Math.max(0, endPct - startPct)}%`,
                  }}
                />
                <div className="trim-timeline-playhead" style={{ left: `${playheadPct}%` }} />

                <button
                  type="button"
                  className="trim-handle"
                  style={{ left: `${startPct}%` }}
                  aria-label={isZh ? "拖动剪切起点" : "Drag trim start"}
                  onPointerDown={handleHandlePointerDown("start")}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowLeft") setBounds(state.startSec - 0.1, state.endSec);
                    if (e.key === "ArrowRight") setBounds(state.startSec + 0.1, state.endSec);
                  }}
                >
                  [
                </button>
                <button
                  type="button"
                  className="trim-handle"
                  style={{ left: `${endPct}%` }}
                  aria-label={isZh ? "拖动剪切终点" : "Drag trim end"}
                  onPointerDown={handleHandlePointerDown("end")}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowLeft") setBounds(state.startSec, state.endSec - 0.1);
                    if (e.key === "ArrowRight") setBounds(state.startSec, state.endSec + 0.1);
                  }}
                >
                  ]
                </button>
              </div>

              <div className="media-actions-row">
                {!state.playbackUnsupported && (
                  <>
                    <button type="button" className="btn" onClick={() => void handleTogglePlay()}>
                      {isPlaying ? (
                        <Pause size={14} aria-hidden="true" />
                      ) : (
                        <Play size={14} aria-hidden="true" />
                      )}
                      <span>{isPlaying ? (isZh ? "暂停" : "Pause") : isZh ? "播放" : "Play"}</span>
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void handlePreviewSegment()}
                    >
                      <Play size={14} aria-hidden="true" />
                      <span>{isZh ? "预览选段" : "Preview Selection"}</span>
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="btn"
                  onClick={() => setBounds(playheadSec, state.endSec)}
                >
                  {isZh ? "设播放头为起点" : "Set Start at Playhead"}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setBounds(state.startSec, playheadSec)}
                >
                  {isZh ? "设播放头为终点" : "Set End at Playhead"}
                </button>
              </div>

              <div className="trim-time-row">
                <label className="media-field-group">
                  <span className="media-field-label">
                    {isZh ? "起点时间（秒或 MM:SS.mmm）" : "Start Time"}
                  </span>
                  <input
                    type="text"
                    className="input mono"
                    value={startInput}
                    onChange={(e) => setStartInput(e.target.value)}
                    onBlur={() => {
                      const parsed = parseTimecodeInput(startInput);
                      if (parsed != null) {
                        setBounds(parsed, state.endSec);
                        seekVideoTo(parsed);
                      } else {
                        setStartInput(formatTimecode(state.startSec));
                      }
                    }}
                  />
                </label>
                <label className="media-field-group">
                  <span className="media-field-label">
                    {isZh ? "终点时间（秒或 MM:SS.mmm）" : "End Time"}
                  </span>
                  <input
                    type="text"
                    className="input mono"
                    value={endInput}
                    onChange={(e) => setEndInput(e.target.value)}
                    onBlur={() => {
                      const parsed = parseTimecodeInput(endInput);
                      if (parsed != null) {
                        setBounds(state.startSec, parsed);
                      } else {
                        setEndInput(formatTimecode(state.endSec));
                      }
                    }}
                  />
                </label>
              </div>
            </div>
          </div>

          {/* Right settings & export panel */}
          <div className="media-section-card">
            <h3 className="media-section-title">
              <span>{isZh ? "剪切模式与导出" : "Trim Mode & Export"}</span>
            </h3>

            <div className="media-field-group">
              <span className="media-field-label">{isZh ? "剪切行为" : "Cut Mode"}</span>
              <div className="segmented" role="group" aria-label={isZh ? "剪切模式" : "Trim Mode"}>
                <button
                  type="button"
                  className={`segmented-btn ${state.mode === "stream_copy" ? "is-selected" : ""}`}
                  aria-pressed={state.mode === "stream_copy"}
                  onClick={() => handleModeChange("stream_copy")}
                >
                  {isZh ? "快速流复制" : "Fast Stream Copy"}
                </button>
                <button
                  type="button"
                  className={`segmented-btn ${state.mode === "accurate" ? "is-selected" : ""}`}
                  aria-pressed={state.mode === "accurate"}
                  onClick={() => handleModeChange("accurate")}
                >
                  {isZh ? "精确剪切（转码）" : "Accurate (Transcode)"}
                </button>
              </div>
              <p className="field-hint" style={{ margin: 0 }}>
                {state.mode === "stream_copy"
                  ? isZh
                    ? "无重编码直接复制音视频流，速度极快且保持原画质与旋转标记；起点须落在前一个关键帧。"
                    : "Copies streams losslessly at high speed while keeping original orientation; start aligns to the preceding keyframe."
                  : isZh
                    ? "按精确时间点重编码（H.264 / AAC），画面与音轨严格同步，竖屏自动校正为正立像素。"
                    : "Re-encodes cleanly (H.264 / AAC) to exact frame boundaries with A/V sync and upright portrait baking."}
              </p>
            </div>

            {state.mode === "stream_copy" && state.keyframeAnalysis && (
              <div
                className={`status-banner ${state.keyframeAnalysis.hasKeyframeShift ? "is-warn" : "is-ok"}`}
                role="status"
              >
                <span>
                  {state.keyframeAnalysis.hasKeyframeShift
                    ? isZh
                      ? `关键帧偏移提示：流复制实际起点将对齐至 ${formatTimecode(state.keyframeAnalysis.actualStreamCopyStartSec)}（比设定提前 ${state.keyframeAnalysis.startDeltaSec.toFixed(2)} 秒，预计输出约 ${state.keyframeAnalysis.estimatedStreamCopyDurationSec.toFixed(2)} 秒）。如需精确从 ${formatTimecode(state.startSec)} 开始，请切换「精确剪切（转码）」。`
                      : `Keyframe alignment notice: Stream Copy will start at keyframe ${formatTimecode(state.keyframeAnalysis.actualStreamCopyStartSec)} (${state.keyframeAnalysis.startDeltaSec.toFixed(2)}s earlier, ~${state.keyframeAnalysis.estimatedStreamCopyDurationSec.toFixed(2)}s output). Switch to Accurate (Transcode) for exact boundaries.`
                    : isZh
                      ? `所选起点 ${formatTimecode(state.startSec)} 已接近关键帧（偏移 ${state.keyframeAnalysis.startDeltaSec.toFixed(2)} 秒），快速流复制可直接无损对齐。`
                      : `Start ${formatTimecode(state.startSec)} aligns closely with a keyframe (${state.keyframeAnalysis.startDeltaSec.toFixed(2)}s offset).`}
                </span>
              </div>
            )}

            <div className="media-field-group">
              <span className="media-field-label">
                {isZh ? "输出新文件（绝不覆盖源文件）" : "Output File (Never overwrites source)"}
              </span>
              <div style={{ display: "flex", gap: "6px" }}>
                <input
                  type="text"
                  className="input mono"
                  value={state.outputPath}
                  onChange={(e) =>
                    updateVideoTrimSession((prev) => ({ ...prev, outputPath: e.target.value }))
                  }
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={state.taskStatus === "running"}
                  onClick={() => void handlePickOutput()}
                >
                  {isZh ? "浏览…" : "Browse..."}
                </button>
              </div>
            </div>

            {state.taskStatus === "running" && state.liveProgress && (
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }} role="status">
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px" }}>
                  <span>{isZh ? "正在导出剪切片段…" : "Exporting trimmed clip..."}</span>
                  <span className="mono">{Math.round(state.liveProgress.percent ?? 0)}%</span>
                </div>
                <div className="media-progress-bar">
                  <div
                    className="media-progress-fill"
                    style={{
                      width: `${Math.min(100, Math.max(0, state.liveProgress.percent ?? 0))}%`,
                    }}
                  />
                </div>
              </div>
            )}

            <div className="media-actions-row">
              {state.taskStatus !== "running" ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!mediaReady || !state.outputPath.trim() || selectedSpan < 0.05}
                  onClick={() => void handleExport()}
                >
                  <Scissors size={14} aria-hidden="true" />
                  <span>{isZh ? "导出剪切片段" : "Export Trimmed Video"}</span>
                </button>
              ) : (
                <button type="button" className="btn" onClick={() => void cancelVideoTrimTask()}>
                  <X size={14} aria-hidden="true" />
                  <span>{isZh ? "取消导出" : "Cancel"}</span>
                </button>
              )}
            </div>

            {state.lastResult && (
              <div
                className="status-banner is-ok"
                style={{ flexDirection: "column", alignItems: "flex-start", gap: "6px" }}
                role="status"
              >
                <strong>{isZh ? "剪切导出完成" : "Trim Export Complete"}</strong>
                <span className="mono" style={{ fontSize: "12px", wordBreak: "break-all" }}>
                  {state.lastResult.outputPath}
                </span>
                <span className="mono" style={{ fontSize: "12px" }}>
                  {formatDurationLabel(state.lastResult.durationSec, locale)}
                  {" · "}
                  {state.lastResult.displayWidth && state.lastResult.displayHeight
                    ? `${state.lastResult.displayWidth}×${state.lastResult.displayHeight}`
                    : "—"}
                  {" · "}
                  {formatMediaBytes(state.lastResult.byteSize, locale)}
                  {" · "}
                  {state.lastResult.elapsedMs} ms
                </span>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    void openLocalDirectory(getParentDir(state.lastResult!.outputPath))
                  }
                >
                  <FolderOpen size={14} aria-hidden="true" />
                  <span>{isZh ? "打开输出目录" : "Open Output Folder"}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
