import { FileVideo, FolderOpen, Images, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MediaToolsSetupPanel } from "../../components/MediaToolsSetupPanel";
import { useI18n } from "../../i18n/I18nContext";
import { useMediaSession } from "../../lib/mediaSessionStore";
import {
  bindDisposableListener,
  extractMediaPosterDataUrl,
  formatLocalizedError,
  getImageHeicCapabilities,
  openLocalDirectory,
  pickSingleDirectory,
  pickSingleFile,
  probeMediaInfo,
  registerMediaPreviewPath,
  subscribeFileDrop,
  type FrameExtractMode,
  type FrameImageFormat,
  type FrameResolutionPreset,
  type MediaToolsStatus,
} from "../../lib/tauriBridge";
import type { HeicCapabilities } from "../image-batch/imageBatchModel";
import {
  VIDEO_EXTENSIONS,
  formatDurationLabel,
  formatMediaBytes,
  formatOrientationLabel,
  formatTimecode,
  getFileName,
  getParentDir,
  parseTimecodeInput,
} from "../media-shared/mediaFormat";
import "../media-shared/mediaWorkspace.css";

export function VideoFramesWorkspace() {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const {
    mediaSession,
    updateVideoFramesSession,
    startVideoFramesTask,
    cancelVideoFramesTask,
    pendingHandoff,
    consumePendingHandoff,
  } = useMediaSession();
  const state = mediaSession.videoFrames;

  const [toolsStatus, setToolsStatus] = useState<MediaToolsStatus | null>(null);
  const [heicCaps, setHeicCaps] = useState<HeicCapabilities | null>(null);
  const [hovering, setHovering] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [tsInput, setTsInput] = useState("00:00.000");

  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    void getImageHeicCapabilities()
      .then(setHeicCaps)
      .catch(() => setHeicCaps(null));
  }, []);

  useEffect(() => {
    setTsInput(formatTimecode(state.timestampSec));
  }, [state.timestampSec]);

  const loadVideoFile = useCallback(
    async (filePath: string) => {
      setLoadingFile(true);
      setPlayheadSec(0);
      updateVideoFramesSession((prev) => ({
        ...prev,
        errorMessage: null,
        lastReport: null,
      }));
      try {
        const probe = await probeMediaInfo(filePath);
        if (!probe.hasVideo) {
          throw new Error(isZh ? "该文件不含视频流。" : "Selected file has no video stream.");
        }
        const preview = await registerMediaPreviewPath(filePath);
        const dur = probe.durationSec ?? 0;
        updateVideoFramesSession((prev) => ({
          ...prev,
          sourcePath: filePath,
          probe,
          previewUrl: preview.url,
          posterUrl: null,
          playbackUnsupported: false,
          outputDir: prev.outputDir || getParentDir(filePath),
          timestampSec: Math.min(0.5, dur * 0.25),
          startSec: 0,
          endSec: dur,
          lastReport: null,
          errorMessage: null,
        }));
        void extractMediaPosterDataUrl(filePath, Math.min(0.2, dur * 0.1))
          .then((poster) => {
            updateVideoFramesSession((prev) =>
              prev.sourcePath === filePath ? { ...prev, posterUrl: poster } : prev,
            );
          })
          .catch(() => {});
      } catch (err) {
        updateVideoFramesSession((prev) => ({
          ...prev,
          errorMessage: formatLocalizedError(err, t),
        }));
      } finally {
        setLoadingFile(false);
      }
    },
    [isZh, t, updateVideoFramesSession],
  );

  useEffect(() => {
    if (pendingHandoff?.toolId === "V04") {
      const path = consumePendingHandoff("V04");
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
      "v04-file-drop",
    );
  }, [loadVideoFile]);

  const handlePickVideo = async () => {
    const p = await pickSingleFile({
      title: isZh ? "选择要抽帧的视频文件" : "Select a video file to extract frames from",
      filters: [{ name: isZh ? "视频文件" : "Video Files", extensions: VIDEO_EXTENSIONS }],
    });
    if (p) await loadVideoFile(p);
  };

  const handlePickOutputDir = async () => {
    const dir = await pickSingleDirectory({
      title: isZh ? "选择抽帧图片输出目录" : "Choose output directory for extracted frames",
    });
    if (dir) {
      updateVideoFramesSession((prev) => ({ ...prev, outputDir: dir }));
    }
  };

  const handleExtract = async () => {
    if (!state.sourcePath || !state.outputDir.trim()) return;
    await startVideoFramesTask(
      {
        sourcePath: state.sourcePath,
        outputDir: state.outputDir.trim(),
        mode: state.mode,
        timestampSec: state.mode === "single_time" ? state.timestampSec : null,
        intervalSec: state.mode === "interval_seconds" ? state.intervalSec : null,
        frameCount: state.mode === "even_count" ? state.frameCount : null,
        startSec: state.useCustomRange ? state.startSec : null,
        endSec: state.useCustomRange ? state.endSec : null,
        resolution: state.resolution,
        format: state.format,
        quality: state.quality,
      },
      (err) => formatLocalizedError(err, t),
    );
  };

  const mediaReady = toolsStatus?.ready ?? true;
  const primaryVideo = state.probe?.videoStreams[0] ?? null;
  const heicEncodeAvailable = heicCaps?.encodeAvailable ?? false;
  const heicBlocked = state.format === "heic" && !heicEncodeAvailable;

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
              ? "拖入视频文件，按时间点、间隔或均匀数量抽取静帧图片"
              : "Drop a video to extract frames by timestamp, interval, or even count"}
          </p>
          <p className="field-hint" style={{ margin: 0 }}>
            {isZh
              ? "支持原尺寸 / 1080p / 720p 与 PNG / JPEG / WebP（及系统 WIC 支持下的 HEIC）；竖屏按显示方向正立导出，可变帧率素材严格按时间戳选帧。"
              : "Supports Original / 1080p / 720p and PNG / JPEG / WebP (plus HEIC via Windows WIC when available). Exports rotated portrait clips upright and seeks VFR by presentation timestamp."}
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
            {/* Video player & gallery */}
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
                  {primaryVideo?.isVariableFrameRate === true && (
                    <span className="media-status-pill is-warn">VFR</span>
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
                      updateVideoFramesSession((prev) => ({
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
                        ? "内置播放器暂无法直接播放该容器或编码（素材完好，并非损坏）。您仍可按右侧时间点、间隔或均匀数量准确抽帧导出。"
                        : "WebView cannot play this container/codec directly (the file is valid, not corrupted). You can still extract frames accurately by timestamp."}
                    </div>
                  </div>
                )}
              </div>

              <div className="media-actions-row" style={{ justifyContent: "space-between" }}>
                <span className="field-hint mono" style={{ margin: 0 }}>
                  {isZh ? "当前播放头：" : "Playhead: "}
                  {formatTimecode(playheadSec)} /{" "}
                  {formatDurationLabel(state.probe?.durationSec, locale)}
                </span>
                {state.mode === "single_time" && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      updateVideoFramesSession((prev) => ({
                        ...prev,
                        timestampSec: Number(playheadSec.toFixed(3)),
                      }))
                    }
                  >
                    {isZh ? "采用当前播放头时间" : "Use Playhead Time"}
                  </button>
                )}
              </div>
            </div>

            {/* Right controls */}
            <div className="media-section-card">
              <h3 className="media-section-title">
                <span>{isZh ? "抽帧规则与导出格式" : "Extraction Mode & Format"}</span>
              </h3>

              <div className="media-field-group">
                <span className="media-field-label">{isZh ? "抽帧方式" : "Mode"}</span>
                <div className="segmented" role="group" aria-label={isZh ? "抽帧方式" : "Mode"}>
                  {(
                    [
                      ["single_time", isZh ? "指定时间取一帧" : "Single Frame"],
                      ["interval_seconds", isZh ? "每隔 N 秒" : "Every N sec"],
                      ["even_count", isZh ? "均匀抽取数量" : "Even Count"],
                    ] as [FrameExtractMode, string][]
                  ).map(([val, label]) => (
                    <button
                      key={val}
                      type="button"
                      className={`segmented-btn ${state.mode === val ? "is-selected" : ""}`}
                      aria-pressed={state.mode === val}
                      onClick={() => updateVideoFramesSession((prev) => ({ ...prev, mode: val }))}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {state.mode === "single_time" && (
                <label className="media-field-group">
                  <span className="media-field-label">
                    {isZh ? "目标时间点（秒或 MM:SS.mmm）" : "Target Timestamp"}
                  </span>
                  <input
                    type="text"
                    className="input mono"
                    value={tsInput}
                    onChange={(e) => setTsInput(e.target.value)}
                    onBlur={() => {
                      const parsed = parseTimecodeInput(tsInput);
                      if (parsed != null) {
                        updateVideoFramesSession((prev) => ({ ...prev, timestampSec: parsed }));
                      } else {
                        setTsInput(formatTimecode(state.timestampSec));
                      }
                    }}
                  />
                </label>
              )}

              {state.mode === "interval_seconds" && (
                <label className="media-field-group">
                  <span className="media-field-label">
                    {isZh ? "抽帧间隔（秒，最小 0.1）" : "Interval (seconds)"}
                  </span>
                  <input
                    type="number"
                    className="input mono"
                    min={0.1}
                    step={0.5}
                    value={state.intervalSec}
                    onChange={(e) =>
                      updateVideoFramesSession((prev) => ({
                        ...prev,
                        intervalSec: Math.max(0.1, Number(e.target.value) || 1),
                      }))
                    }
                  />
                </label>
              )}

              {state.mode === "even_count" && (
                <label className="media-field-group">
                  <span className="media-field-label">
                    {isZh ? "均匀抽取张数（1–300）" : "Number of Frames (1–300)"}
                  </span>
                  <input
                    type="number"
                    className="input mono"
                    min={1}
                    max={300}
                    value={state.frameCount}
                    onChange={(e) =>
                      updateVideoFramesSession((prev) => ({
                        ...prev,
                        frameCount: Math.max(
                          1,
                          Math.min(300, Math.round(Number(e.target.value) || 1)),
                        ),
                      }))
                    }
                  />
                </label>
              )}

              <div className="media-field-group">
                <span className="media-field-label">
                  {isZh ? "输出尺寸（不放大小素材）" : "Resolution (No upscale)"}
                </span>
                <div
                  className="segmented"
                  role="group"
                  aria-label={isZh ? "输出尺寸" : "Resolution"}
                >
                  {(
                    [
                      ["original", isZh ? "原尺寸" : "Original"],
                      ["p1080", "1080p"],
                      ["p720", "720p"],
                    ] as [FrameResolutionPreset, string][]
                  ).map(([val, label]) => (
                    <button
                      key={val}
                      type="button"
                      className={`segmented-btn ${state.resolution === val ? "is-selected" : ""}`}
                      aria-pressed={state.resolution === val}
                      onClick={() =>
                        updateVideoFramesSession((prev) => ({ ...prev, resolution: val }))
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="media-field-group">
                <span className="media-field-label">{isZh ? "图片格式" : "Image Format"}</span>
                <div
                  className="segmented"
                  role="group"
                  aria-label={isZh ? "图片格式" : "Image Format"}
                >
                  {(["png", "jpeg", "webp", "heic"] as FrameImageFormat[]).map((fmt) => (
                    <button
                      key={fmt}
                      type="button"
                      className={`segmented-btn ${state.format === fmt ? "is-selected" : ""}`}
                      aria-pressed={state.format === fmt}
                      onClick={() => updateVideoFramesSession((prev) => ({ ...prev, format: fmt }))}
                    >
                      {fmt.toUpperCase()}
                    </button>
                  ))}
                </div>
                {state.format === "heic" && (
                  <p className="field-hint" style={{ margin: 0 }}>
                    {heicEncodeAvailable
                      ? isZh
                        ? "已探测到本机 Windows WIC HEIF/HEVC 编码扩展，可离线导出 HEIC。"
                        : "Windows WIC HEIF/HEVC encoder verified; offline HEIC export is ready."
                      : isZh
                        ? "当前系统未检测到 Windows WIC HEIC 编码扩展（HEIF/HEVC）。请改用 PNG/JPEG/WebP，或在 Microsoft Store 安装系统扩展后重启 WinKit。"
                        : "Windows WIC HEIC encoding is unavailable on this system. Choose PNG/JPEG/WebP or install Microsoft HEIF/HEVC Extensions."}
                  </p>
                )}
              </div>

              {state.format !== "png" && (
                <label className="media-field-group">
                  <span className="media-field-label">
                    {isZh ? `有损质量：${state.quality}` : `Quality: ${state.quality}`}
                  </span>
                  <input
                    type="range"
                    min={50}
                    max={100}
                    value={state.quality}
                    onChange={(e) =>
                      updateVideoFramesSession((prev) => ({
                        ...prev,
                        quality: Number(e.target.value),
                      }))
                    }
                  />
                </label>
              )}

              <div className="media-field-group">
                <span className="media-field-label">{isZh ? "输出目录" : "Output Folder"}</span>
                <div style={{ display: "flex", gap: "6px" }}>
                  <input
                    type="text"
                    className="input mono"
                    value={state.outputDir}
                    onChange={(e) =>
                      updateVideoFramesSession((prev) => ({ ...prev, outputDir: e.target.value }))
                    }
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    className="btn"
                    disabled={state.taskStatus === "running"}
                    onClick={() => void handlePickOutputDir()}
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
                      {isZh
                        ? `正在抽帧 ${state.liveProgress.currentItem}/${state.liveProgress.totalItems}`
                        : `Extracting ${state.liveProgress.currentItem}/${state.liveProgress.totalItems}`}
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
                    disabled={!mediaReady || !state.outputDir.trim() || heicBlocked}
                    onClick={() => void handleExtract()}
                  >
                    <Images size={14} aria-hidden="true" />
                    <span>{isZh ? "开始抽帧导出" : "Extract Frames"}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void cancelVideoFramesTask()}
                  >
                    <X size={14} aria-hidden="true" />
                    <span>{isZh ? "取消抽帧" : "Cancel"}</span>
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Extracted frame thumbnails gallery */}
          {state.lastReport && (
            <section className="media-section-card">
              <div className="media-section-title">
                <span>
                  {state.lastReport.cancelled
                    ? isZh
                      ? `抽帧已取消（已导出 ${state.lastReport.extractedCount}/${state.lastReport.requestedCount} 张）`
                      : `Cancelled (${state.lastReport.extractedCount}/${state.lastReport.requestedCount} extracted)`
                    : isZh
                      ? `抽帧结果（共 ${state.lastReport.extractedCount} 张 · ${state.lastReport.elapsedMs} ms）`
                      : `Extracted Frames (${state.lastReport.extractedCount} · ${state.lastReport.elapsedMs} ms)`}
                </span>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void openLocalDirectory(state.lastReport!.outputDir)}
                >
                  <FolderOpen size={14} aria-hidden="true" />
                  <span>{isZh ? "打开输出目录" : "Open Output Folder"}</span>
                </button>
              </div>

              <div className="media-frames-grid">
                {state.lastReport.frames.map((frame) => (
                  <div key={frame.outputPath} className="media-frame-card">
                    {frame.thumbnailDataUrl && (
                      <img
                        src={frame.thumbnailDataUrl}
                        alt={frame.fileName}
                        className="media-frame-thumb"
                      />
                    )}
                    <div className="media-frame-meta">
                      <div style={{ display: "flex", justifyContent: "space-between", gap: "6px" }}>
                        <strong className="mono">{formatTimecode(frame.timestampSec)}</strong>
                        <span className="mono" style={{ color: "var(--text-muted)" }}>
                          {frame.width}×{frame.height}
                        </span>
                      </div>
                      <span
                        className="mono"
                        style={{
                          color: "var(--text-secondary)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {frame.fileName}
                      </span>
                      <span className="mono" style={{ color: "var(--text-muted)" }}>
                        {formatMediaBytes(frame.byteSize, locale)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
