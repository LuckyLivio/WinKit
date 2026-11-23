import { FileVideo, Film, FolderOpen, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MediaToolsSetupPanel } from "../../components/MediaToolsSetupPanel";
import { useI18n } from "../../i18n/I18nContext";
import { useMediaSession } from "../../lib/mediaSessionStore";
import {
  bindDisposableListener,
  extractMediaPosterDataUrl,
  formatLocalizedError,
  openLocalDirectory,
  pickSaveFilePath,
  pickSingleFile,
  probeMediaInfo,
  registerMediaPreviewPath,
  subscribeFileDrop,
  type GifWidthPreset,
  type MediaToolsStatus,
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

export function VideoGifWorkspace() {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const {
    mediaSession,
    updateVideoGifSession,
    startVideoGifTask,
    cancelVideoGifTask,
    pendingHandoff,
    consumePendingHandoff,
  } = useMediaSession();
  const state = mediaSession.videoGif;

  const [toolsStatus, setToolsStatus] = useState<MediaToolsStatus | null>(null);
  const [hovering, setHovering] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [startInput, setStartInput] = useState("00:00.000");
  const [endInput, setEndInput] = useState("00:00.000");

  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    setStartInput(formatTimecode(state.startSec));
  }, [state.startSec]);

  useEffect(() => {
    setEndInput(formatTimecode(state.endSec));
  }, [state.endSec]);

  const loadVideoFile = useCallback(
    async (filePath: string) => {
      setLoadingFile(true);
      setPlayheadSec(0);
      updateVideoGifSession((prev) => ({
        ...prev,
        errorMessage: null,
        lastResult: null,
      }));
      try {
        const probe = await probeMediaInfo(filePath);
        if (!probe.hasVideo) {
          throw new Error(isZh ? "该文件不含视频流。" : "Selected file has no video stream.");
        }
        const preview = await registerMediaPreviewPath(filePath);
        const dur = probe.durationSec ?? 0;
        const defaultOut = suggestMediaOutputPath(filePath, "", "gif");

        updateVideoGifSession((prev) => ({
          ...prev,
          sourcePath: filePath,
          probe,
          previewUrl: preview.url,
          posterUrl: null,
          playbackUnsupported: false,
          outputPath: defaultOut,
          startSec: 0,
          endSec: dur,
          lastResult: null,
          errorMessage: null,
        }));

        void extractMediaPosterDataUrl(filePath, Math.min(0.2, dur * 0.1))
          .then((poster) => {
            updateVideoGifSession((prev) =>
              prev.sourcePath === filePath ? { ...prev, posterUrl: poster } : prev,
            );
          })
          .catch(() => {});
      } catch (err) {
        updateVideoGifSession((prev) => ({
          ...prev,
          errorMessage: formatLocalizedError(err, t),
        }));
      } finally {
        setLoadingFile(false);
      }
    },
    [isZh, t, updateVideoGifSession],
  );

  useEffect(() => {
    if (pendingHandoff?.toolId === "V15") {
      const path = consumePendingHandoff("V15");
      if (path) void loadVideoFile(path);
    }
  }, [pendingHandoff, consumePendingHandoff, loadVideoFile]);

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: setHovering,
          onDropPaths: (paths) => {
            if (paths[0]) void loadVideoFile(paths[0]);
          },
        }),
      "v15-file-drop",
    );
  }, [loadVideoFile]);

  const handlePickVideo = async () => {
    const p = await pickSingleFile({
      title: isZh ? "选择要转换为 GIF 的视频" : "Select a video file to convert to GIF",
      filters: [{ name: isZh ? "视频文件" : "Video Files", extensions: VIDEO_EXTENSIONS }],
    });
    if (p) await loadVideoFile(p);
  };

  const handlePickOutput = async () => {
    if (!state.sourcePath) return;
    const { stem } = getFileStemAndExt(state.sourcePath);
    const chosen = await pickSaveFilePath({
      title: isZh ? "选择 GIF 输出文件" : "Choose output GIF file",
      defaultPath: state.outputPath || `${stem}.gif`,
      filters: [{ name: "GIF", extensions: ["gif"] }],
    });
    if (chosen) {
      updateVideoGifSession((prev) => ({ ...prev, outputPath: chosen }));
    }
  };

  const handleConvert = async () => {
    if (!state.sourcePath || !state.outputPath.trim()) return;
    await startVideoGifTask(
      {
        sourcePath: state.sourcePath,
        outputPath: state.outputPath.trim(),
        startSec: state.useCustomRange ? state.startSec : null,
        endSec: state.useCustomRange ? state.endSec : null,
        fps: state.fps,
        widthPreset: state.widthPreset,
        loopForever: state.loopForever,
        allowUpscale: false,
        allowOverwrite: false,
      },
      (err) => formatLocalizedError(err, t),
    );
  };

  const mediaReady = toolsStatus?.ready ?? true;
  const primaryVideo = state.probe?.videoStreams[0] ?? null;

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
            {isZh
              ? "拖入视频文件，使用调色板优化生成高质量 GIF 动图"
              : "Drop a video to generate a high-quality palette-optimized GIF"}
          </p>
          <p className="field-hint" style={{ margin: 0 }}>
            {isZh
              ? "支持整段或时间范围、10/15/24 fps、320/480/640 px 或原宽及循环开关，默认不放大小素材，导出后直接展示动图、尺寸、时长与体积。"
              : "Full clip or range, 10/15/24 fps, 320/480/640 px or original width, loop toggle, no upscaling by default, with immediate animated preview and size readout."}
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
                  ? "读取中…"
                  : "Loading..."
                : isZh
                  ? "选择视频文件…"
                  : "Select Video File..."}
            </span>
          </button>
        </div>
      ) : (
        <>
          <div className="media-split">
            {/* Source preview + Live GIF Result */}
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
                  <strong className="mono" style={{ fontSize: "13px" }}>
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
                    onTimeUpdate={() => {
                      if (videoRef.current) setPlayheadSec(videoRef.current.currentTime);
                    }}
                    onError={() =>
                      updateVideoGifSession((prev) => ({
                        ...prev,
                        playbackUnsupported: true,
                      }))
                    }
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
                        ? "内置播放器暂无法直接播放该容器或编码（素材完好，并非损坏）。您仍可设置参数并正常生成高质量 GIF。"
                        : "WebView cannot play this container/codec directly (the file is valid, not corrupted). You can still export a palette-optimized GIF normally."}
                    </div>
                  </div>
                )}
              </div>

              {state.useCustomRange && (
                <div className="media-actions-row">
                  <span className="field-hint mono" style={{ margin: 0 }}>
                    {isZh ? "播放头：" : "Playhead: "}
                    {formatTimecode(playheadSec)}
                  </span>
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      updateVideoGifSession((prev) => ({
                        ...prev,
                        startSec: Number(playheadSec.toFixed(3)),
                      }))
                    }
                  >
                    {isZh ? "设播放头为起点" : "Set Start"}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      updateVideoGifSession((prev) => ({
                        ...prev,
                        endSec: Number(playheadSec.toFixed(3)),
                      }))
                    }
                  >
                    {isZh ? "设播放头为终点" : "Set End"}
                  </button>
                </div>
              )}
            </div>

            {/* Right controls */}
            <div className="media-section-card">
              <h3 className="media-section-title">
                <span>{isZh ? "GIF 参数与导出" : "GIF Settings & Export"}</span>
              </h3>

              <div className="media-field-group">
                <span className="media-field-label">{isZh ? "转换范围" : "Range"}</span>
                <div className="segmented" role="group" aria-label={isZh ? "转换范围" : "Range"}>
                  <button
                    type="button"
                    className={`segmented-btn ${!state.useCustomRange ? "is-selected" : ""}`}
                    aria-pressed={!state.useCustomRange}
                    onClick={() =>
                      updateVideoGifSession((prev) => ({ ...prev, useCustomRange: false }))
                    }
                  >
                    {isZh ? "整段视频" : "Full Video"}
                  </button>
                  <button
                    type="button"
                    className={`segmented-btn ${state.useCustomRange ? "is-selected" : ""}`}
                    aria-pressed={state.useCustomRange}
                    onClick={() =>
                      updateVideoGifSession((prev) => ({ ...prev, useCustomRange: true }))
                    }
                  >
                    {isZh ? "指定时间范围" : "Time Range"}
                  </button>
                </div>
              </div>

              {state.useCustomRange && (
                <div className="trim-time-row">
                  <label className="media-field-group">
                    <span className="media-field-label">{isZh ? "起点" : "Start"}</span>
                    <input
                      type="text"
                      className="input mono"
                      value={startInput}
                      onChange={(e) => setStartInput(e.target.value)}
                      onBlur={() => {
                        const p = parseTimecodeInput(startInput);
                        if (p != null) {
                          updateVideoGifSession((prev) => ({ ...prev, startSec: p }));
                        } else {
                          setStartInput(formatTimecode(state.startSec));
                        }
                      }}
                    />
                  </label>
                  <label className="media-field-group">
                    <span className="media-field-label">{isZh ? "终点" : "End"}</span>
                    <input
                      type="text"
                      className="input mono"
                      value={endInput}
                      onChange={(e) => setEndInput(e.target.value)}
                      onBlur={() => {
                        const p = parseTimecodeInput(endInput);
                        if (p != null) {
                          updateVideoGifSession((prev) => ({ ...prev, endSec: p }));
                        } else {
                          setEndInput(formatTimecode(state.endSec));
                        }
                      }}
                    />
                  </label>
                </div>
              )}

              <div className="media-field-group">
                <span className="media-field-label">{isZh ? "帧率（FPS）" : "Frame Rate"}</span>
                <div className="segmented" role="group" aria-label={isZh ? "帧率" : "Frame Rate"}>
                  {([10, 15, 24] as const).map((fps) => (
                    <button
                      key={fps}
                      type="button"
                      className={`segmented-btn ${state.fps === fps ? "is-selected" : ""}`}
                      aria-pressed={state.fps === fps}
                      onClick={() => updateVideoGifSession((prev) => ({ ...prev, fps }))}
                    >
                      {fps} fps
                    </button>
                  ))}
                </div>
              </div>

              <div className="media-field-group">
                <span className="media-field-label">
                  {isZh
                    ? "目标宽度（保持比例，默认不放大小素材）"
                    : "Width (Aspect kept, never upscales)"}
                </span>
                <div className="segmented" role="group" aria-label={isZh ? "目标宽度" : "Width"}>
                  {(
                    [
                      ["w320", "320 px"],
                      ["w480", "480 px"],
                      ["w640", "640 px"],
                      ["original", isZh ? "原宽" : "Original"],
                    ] as [GifWidthPreset, string][]
                  ).map(([val, label]) => (
                    <button
                      key={val}
                      type="button"
                      className={`segmented-btn ${state.widthPreset === val ? "is-selected" : ""}`}
                      aria-pressed={state.widthPreset === val}
                      onClick={() =>
                        updateVideoGifSession((prev) => ({ ...prev, widthPreset: val }))
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="media-field-group">
                <span className="media-field-label">{isZh ? "循环行为" : "Loop Behavior"}</span>
                <div
                  className="segmented"
                  role="group"
                  aria-label={isZh ? "循环行为" : "Loop Behavior"}
                >
                  <button
                    type="button"
                    className={`segmented-btn ${state.loopForever ? "is-selected" : ""}`}
                    aria-pressed={state.loopForever}
                    onClick={() =>
                      updateVideoGifSession((prev) => ({ ...prev, loopForever: true }))
                    }
                  >
                    {isZh ? "无限循环" : "Loop Forever"}
                  </button>
                  <button
                    type="button"
                    className={`segmented-btn ${!state.loopForever ? "is-selected" : ""}`}
                    aria-pressed={!state.loopForever}
                    onClick={() =>
                      updateVideoGifSession((prev) => ({ ...prev, loopForever: false }))
                    }
                  >
                    {isZh ? "仅播放一次" : "Play Once"}
                  </button>
                </div>
              </div>

              <div className="media-field-group">
                <span className="media-field-label">
                  {isZh ? "输出 GIF 文件" : "Output GIF Path"}
                </span>
                <div style={{ display: "flex", gap: "6px" }}>
                  <input
                    type="text"
                    className="input mono"
                    value={state.outputPath}
                    onChange={(e) =>
                      updateVideoGifSession((prev) => ({ ...prev, outputPath: e.target.value }))
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
                  <div
                    style={{ display: "flex", justifyContent: "space-between", fontSize: "12px" }}
                  >
                    <span>
                      {isZh ? "正在生成调色板并编码 GIF…" : "Generating palette & GIF..."}
                    </span>
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
                    disabled={!mediaReady || !state.outputPath.trim()}
                    onClick={() => void handleConvert()}
                  >
                    <Film size={14} aria-hidden="true" />
                    <span>{isZh ? "生成 GIF 动图" : "Export GIF"}</span>
                  </button>
                ) : (
                  <button type="button" className="btn" onClick={() => void cancelVideoGifTask()}>
                    <X size={14} aria-hidden="true" />
                    <span>{isZh ? "取消生成" : "Cancel"}</span>
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Immediate Animated GIF Result Preview */}
          {state.lastResult && (
            <section
              className="media-gif-result"
              aria-label={isZh ? "GIF 导出结果预览" : "Exported GIF Preview"}
            >
              <div
                style={{
                  width: "100%",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "8px",
                  flexWrap: "wrap",
                }}
              >
                <div
                  style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}
                >
                  <strong style={{ fontSize: "13.5px" }}>
                    {isZh
                      ? "GIF 生成完成（以下为实际动图预览）"
                      : "GIF Ready (Live Animated Preview)"}
                  </strong>
                  <span
                    className={`media-status-pill ${state.lastResult.byteSize <= 5 * 1024 * 1024 ? "is-ok" : "is-warn"}`}
                  >
                    {state.lastResult.byteSize <= 5 * 1024 * 1024
                      ? isZh
                        ? "体积适合网页 / README"
                        : "Web / README friendly size"
                      : isZh
                        ? "体积偏大，可降低帧率或宽度"
                        : "Large file — consider lower FPS or width"}
                  </span>
                </div>
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

              <img
                src={state.lastResult.previewUrl}
                alt={getFileName(state.lastResult.outputPath)}
                className="media-gif-preview-img"
              />

              <div className="media-metrics-grid" style={{ width: "100%" }}>
                <div className="media-metric-card">
                  <span className="media-metric-label">{isZh ? "动图尺寸" : "Dimensions"}</span>
                  <span className="media-metric-value mono">
                    {state.lastResult.width} × {state.lastResult.height} px
                  </span>
                </div>
                <div className="media-metric-card">
                  <span className="media-metric-label">
                    {isZh ? "时长与帧数" : "Duration & Frames"}
                  </span>
                  <span className="media-metric-value mono">
                    {formatDurationLabel(state.lastResult.durationSec, locale)} ·{" "}
                    {state.lastResult.frameCount} {isZh ? "帧" : "frames"}
                  </span>
                </div>
                <div className="media-metric-card">
                  <span className="media-metric-label">{isZh ? "文件大小" : "File Size"}</span>
                  <span className="media-metric-value mono">
                    {formatMediaBytes(state.lastResult.byteSize, locale)}
                  </span>
                </div>
                <div className="media-metric-card">
                  <span className="media-metric-label">
                    {isZh ? "循环模式 / 耗时" : "Loop / Elapsed"}
                  </span>
                  <span className="media-metric-value">
                    {state.lastResult.loopForever
                      ? isZh
                        ? "无限循环"
                        : "Loop Forever"
                      : isZh
                        ? "仅播放一次"
                        : "Play Once"}
                    {" · "}
                    <span className="mono">{state.lastResult.elapsedMs} ms</span>
                  </span>
                </div>
              </div>
              <span
                className="field-hint mono"
                style={{ margin: 0, width: "100%", wordBreak: "break-all" }}
              >
                {state.lastResult.outputPath}
              </span>
            </section>
          )}
        </>
      )}
    </div>
  );
}
