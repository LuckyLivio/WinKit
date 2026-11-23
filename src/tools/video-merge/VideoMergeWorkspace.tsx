import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Combine,
  FilePlus2,
  FolderOpen,
  GripVertical,
  Info,
  Save,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MediaToolsSetupPanel } from "../../components/MediaToolsSetupPanel";
import { useI18n } from "../../i18n/I18nContext";
import { useMediaSession, type VideoMergeClipItem } from "../../lib/mediaSessionStore";
import {
  bindDisposableListener,
  extractOrientedPreviewFrame,
  formatLocalizedError,
  openLocalDirectory,
  pickMultipleFiles,
  pickSaveFilePath,
  probeMediaInfo,
  subscribeFileDrop,
  type MediaToolsStatus,
  type MergeFitMode,
  type MergeResolutionPreset,
} from "../../lib/tauriBridge";
import {
  VIDEO_EXTENSIONS,
  formatDurationLabel,
  formatMediaBytes,
  getFileName,
  getFileStemAndExt,
  getParentDir,
} from "../media-shared/mediaFormat";
import "../media-shared/mediaWorkspace.css";

const RESOLUTION_OPTIONS: {
  value: MergeResolutionPreset;
  labelZh: string;
  labelEn: string;
}[] = [
  {
    value: "match_first",
    labelZh: "跟随首段视频尺寸（推荐）",
    labelEn: "Match First Clip (Recommended)",
  },
  { value: "p1080", labelZh: "1080p 横屏 (1920×1080)", labelEn: "1080p Landscape (1920×1080)" },
  { value: "p720", labelZh: "720p 横屏 (1280×720)", labelEn: "720p Landscape (1280×720)" },
  { value: "vertical1080", labelZh: "竖屏 9:16 (1080×1920)", labelEn: "Vertical 9:16 (1080×1920)" },
  { value: "square1080", labelZh: "方形 1:1 (1080×1080)", labelEn: "Square 1:1 (1080×1080)" },
];

export function predictMergeResolution(
  firstClip: VideoMergeClipItem | undefined,
  preset: MergeResolutionPreset,
): string {
  switch (preset) {
    case "p1080":
      return "1920×1080";
    case "p720":
      return "1280×720";
    case "vertical1080":
      return "1080×1920";
    case "square1080":
      return "1080×1080";
    case "match_first": {
      const v0 = firstClip?.probe?.videoStreams[0];
      const w = v0?.displayWidth ?? v0?.codedWidth;
      const h = v0?.displayHeight ?? v0?.codedHeight;
      if (w && h) {
        const ew = Math.max(16, Math.floor(w / 2) * 2);
        const eh = Math.max(16, Math.floor(h / 2) * 2);
        return `${ew}×${eh}`;
      }
      return "—";
    }
  }
}

export function VideoMergeWorkspace() {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const {
    mediaSession,
    updateVideoMergeSession,
    startVideoMergeTask,
    cancelVideoMergeTask,
    handoffMediaFileToTool,
    pendingHandoff,
    consumePendingHandoff,
  } = useMediaSession();
  const state = mediaSession.videoMerge;

  const [toolsStatus, setToolsStatus] = useState<MediaToolsStatus | null>(null);
  const [hovering, setHovering] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const clipSeqRef = useRef(1);

  const addVideoClips = useCallback(
    async (paths: string[]) => {
      const cleaned = paths.map((p) => p.trim()).filter(Boolean);
      if (cleaned.length === 0) return;

      const addedEntries: VideoMergeClipItem[] = cleaned.map((p) => ({
        id: `clip-${Date.now()}-${clipSeqRef.current++}`,
        path: p,
        fileName: getFileName(p),
        status: "loading",
        probe: null,
        thumbnailUrl: null,
        errorMessage: null,
      }));

      updateVideoMergeSession((prev) => {
        const clips = [...prev.clips, ...addedEntries];
        let outputPath = prev.outputPath;
        if (!outputPath && clips[0]) {
          const parent = getParentDir(clips[0].path);
          const { stem } = getFileStemAndExt(clips[0].path);
          outputPath = parent ? `${parent}\\${stem}_merged.mp4` : `${stem}_merged.mp4`;
        }
        return {
          ...prev,
          clips,
          outputPath,
          lastResult: null,
          errorMessage: null,
        };
      });

      for (const entry of addedEntries) {
        try {
          const probe = await probeMediaInfo(entry.path);
          let thumbUrl: string | null = null;
          try {
            const frame = await extractOrientedPreviewFrame(entry.path, 0.2);
            thumbUrl = frame.dataUrl;
          } catch {
            thumbUrl = null;
          }
          updateVideoMergeSession((prev) => ({
            ...prev,
            clips: prev.clips.map((c) =>
              c.id === entry.id
                ? {
                    ...c,
                    fileName: probe.fileName,
                    status: "ready",
                    probe,
                    thumbnailUrl: thumbUrl,
                    errorMessage: null,
                  }
                : c,
            ),
          }));
        } catch (err) {
          const msg = formatLocalizedError(err, t);
          updateVideoMergeSession((prev) => ({
            ...prev,
            clips: prev.clips.map((c) =>
              c.id === entry.id ? { ...c, status: "error", probe: null, errorMessage: msg } : c,
            ),
          }));
        }
      }
    },
    [t, updateVideoMergeSession],
  );

  useEffect(() => {
    if (pendingHandoff?.toolId === "V12") {
      const path = consumePendingHandoff("V12");
      if (path) void addVideoClips([path]);
    }
  }, [pendingHandoff, consumePendingHandoff, addVideoClips]);

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: setHovering,
          onDropPaths: (paths) => void addVideoClips(paths),
        }),
      "v12-file-drop",
    );
  }, [addVideoClips]);

  const handlePickVideos = async () => {
    try {
      const picked = await pickMultipleFiles({
        title: isZh ? "选择要按顺序合并的视频片段" : "Select video clips to merge",
        filters: [
          {
            name: isZh ? "视频文件" : "Video Files",
            extensions: [...VIDEO_EXTENSIONS],
          },
        ],
      });
      if (picked && picked.length > 0) {
        await addVideoClips(picked);
      }
    } catch (err) {
      updateVideoMergeSession((prev) => ({
        ...prev,
        errorMessage: formatLocalizedError(err, t),
      }));
    }
  };

  const handlePickOutputPath = async () => {
    try {
      const picked = await pickSaveFilePath({
        title: isZh ? "选择合并输出文件" : "Save merged video as",
        defaultPath: state.outputPath || "merged.mp4",
        filters: [{ name: "MP4 Video", extensions: ["mp4"] }],
      });
      if (picked) {
        updateVideoMergeSession((prev) => ({ ...prev, outputPath: picked }));
      }
    } catch (err) {
      updateVideoMergeSession((prev) => ({
        ...prev,
        errorMessage: formatLocalizedError(err, t),
      }));
    }
  };

  const moveClip = (fromIdx: number, toIdx: number) => {
    updateVideoMergeSession((prev) => {
      if (toIdx < 0 || toIdx >= prev.clips.length || fromIdx === toIdx) return prev;
      const next = [...prev.clips];
      const [moved] = next.splice(fromIdx, 1);
      if (!moved) return prev;
      next.splice(toIdx, 0, moved);
      return { ...prev, clips: next, lastResult: null };
    });
  };

  const removeClip = (id: string) => {
    updateVideoMergeSession((prev) => ({
      ...prev,
      clips: prev.clips.filter((c) => c.id !== id),
      lastResult: null,
    }));
  };

  const clearClips = () => {
    updateVideoMergeSession((prev) => ({
      ...prev,
      clips: [],
      outputPath: "",
      lastResult: null,
      errorMessage: null,
    }));
  };

  const handleStart = async () => {
    if (state.clips.length < 2 || !state.outputPath.trim()) return;
    await startVideoMergeTask(
      {
        sourcePaths: state.clips.map((c) => c.path),
        outputPath: state.outputPath.trim(),
        resolutionPreset: state.resolutionPreset,
        fitMode: state.fitMode,
        allowOverwrite: false,
      },
      (err) => formatLocalizedError(err, t),
    );
  };

  const mediaReady = Boolean(toolsStatus?.ready);
  const running = state.taskStatus === "running";
  const readyClips = state.clips.filter((c) => c.status === "ready");
  const totalDurationSec = readyClips.reduce((acc, c) => acc + (c.probe?.durationSec ?? 0), 0);
  const anyAudio = readyClips.some((c) => c.probe?.hasAudio);
  const anySilent = readyClips.some((c) => c.probe && !c.probe.hasAudio);
  const predictedSize = predictMergeResolution(state.clips[0], state.resolutionPreset);
  const hasErrors = state.clips.some((c) => c.status === "error");
  const canStart =
    mediaReady &&
    !running &&
    state.clips.length >= 2 &&
    !hasErrors &&
    Boolean(state.outputPath.trim());

  return (
    <div className="media-workspace">
      <MediaToolsSetupPanel onStatusChange={setToolsStatus} />

      <section className="panel media-section">
        <div className="media-section-header">
          <div>
            <h3>{isZh ? "视频合并" : "Merge Videos"}</h3>
            <p className="field-hint" style={{ margin: "2px 0 0" }}>
              {isZh
                ? "将两段及以上视频按顺序拼接为一个 H.264 MP4。混排横竖屏默认等比留黑，有声段与无声段混拼自动补静音以保持音画同步。"
                : "Concatenate two or more clips in order into a single H.264 MP4 with automatic resolution normalization, proportional letterboxing, and silence synthesis."}
            </p>
          </div>
          <div className="media-actions-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!mediaReady || running}
              onClick={() => void handlePickVideos()}
            >
              <FilePlus2 size={15} aria-hidden="true" />
              <span>{isZh ? "添加片段" : "Add Clips"}</span>
            </button>
            {state.clips.length > 0 && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={running}
                onClick={clearClips}
              >
                <Trash2 size={14} aria-hidden="true" />
                <span>{isZh ? "清空" : "Clear"}</span>
              </button>
            )}
          </div>
        </div>

        {state.clips.length === 0 ? (
          <div className={`media-dropzone ${hovering ? "is-hover" : ""}`}>
            <Combine size={24} strokeWidth={1.6} aria-hidden="true" />
            <p style={{ margin: 0, fontWeight: 600 }}>
              {isZh ? "拖入两段或更多视频片段开始拼接" : "Drop two or more video clips to merge"}
            </p>
            <p className="field-hint" style={{ margin: 0 }}>
              {isZh
                ? "添加后可上下调整或拖拽排序，查看每段缩略图、分辨率、时长与音轨状态。"
                : "Reorder clips with drag-and-drop or arrow controls and preview thumbnails, dimensions, duration, and audio presence."}
            </p>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!mediaReady}
              onClick={() => void handlePickVideos()}
            >
              <FilePlus2 size={15} aria-hidden="true" />
              <span>{isZh ? "选择视频片段…" : "Select Video Clips..."}</span>
            </button>
          </div>
        ) : (
          <>
            {/* Clip strip with thumbnails & reordering */}
            <div className="media-summary-card" style={{ marginBottom: "12px" }}>
              <div className="media-actions-row" style={{ justifyContent: "space-between" }}>
                <div>
                  <strong>
                    {isZh
                      ? `已选 ${state.clips.length} 段 · 预计总时长 ${formatDurationLabel(totalDurationSec, locale)}`
                      : `${state.clips.length} clips · Est. Total ${formatDurationLabel(totalDurationSec, locale)}`}
                  </strong>
                  <span className="field-hint" style={{ marginLeft: "10px", fontSize: "12px" }}>
                    {isZh ? `输出尺寸：${predictedSize}` : `Output: ${predictedSize}`}
                  </span>
                </div>
                {state.clips.length < 2 && (
                  <span className="field-hint" style={{ fontSize: "12px" }}>
                    {isZh ? "请至少添加 2 段视频" : "Add at least 2 clips to merge"}
                  </span>
                )}
              </div>
              {anyAudio && anySilent && (
                <div className="field-hint" style={{ fontSize: "12px", marginTop: "4px" }}>
                  {isZh
                    ? "检测到队列同时包含有声与静音片段：静音段将自动补齐对应时长静音轨，确保后续片段声音准时衔接。"
                    : "Mixed audio & silent clips detected: silent segments will receive exact-duration silence so subsequent audio stays synced."}
                </div>
              )}
            </div>

            <div className="media-queue-list" role="list" data-testid="v12-clip-list">
              {state.clips.map((clip, idx) => {
                const v0 = clip.probe?.videoStreams[0];
                const dims =
                  v0?.displayWidth && v0?.displayHeight
                    ? `${v0.displayWidth}×${v0.displayHeight}`
                    : v0?.codedWidth && v0?.codedHeight
                      ? `${v0.codedWidth}×${v0.codedHeight}`
                      : "—";
                return (
                  <div
                    key={clip.id}
                    className="media-queue-item"
                    role="listitem"
                    draggable={!running}
                    onDragStart={() => setDragIndex(idx)}
                    onDragOver={(e) => {
                      e.preventDefault();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragIndex != null && dragIndex !== idx) {
                        moveClip(dragIndex, idx);
                      }
                      setDragIndex(null);
                    }}
                    onDragEnd={() => setDragIndex(null)}
                    style={{ alignItems: "center", gap: "10px" }}
                  >
                    <GripVertical
                      size={15}
                      aria-hidden="true"
                      style={{ opacity: 0.5, flexShrink: 0 }}
                    />
                    <span
                      style={{
                        minWidth: "28px",
                        fontWeight: 700,
                        fontSize: "12px",
                        opacity: 0.75,
                      }}
                    >
                      #{idx + 1}
                    </span>
                    <div
                      style={{
                        width: "76px",
                        height: "44px",
                        borderRadius: "4px",
                        overflow: "hidden",
                        background: "var(--surface-muted, #1a1d24)",
                        flexShrink: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {clip.thumbnailUrl ? (
                        <img
                          src={clip.thumbnailUrl}
                          alt={clip.fileName}
                          style={{ width: "100%", height: "100%", objectFit: "contain" }}
                        />
                      ) : (
                        <span className="field-hint" style={{ fontSize: "10px" }}>
                          {clip.status === "loading" ? "…" : "VIDEO"}
                        </span>
                      )}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, wordBreak: "break-all" }}>{clip.fileName}</div>
                      <div
                        className="field-hint"
                        style={{
                          fontSize: "12px",
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          flexWrap: "wrap",
                        }}
                      >
                        {clip.status === "loading" ? (
                          <span>{isZh ? "读取中…" : "Probing..."}</span>
                        ) : clip.status === "error" ? (
                          <span style={{ color: "var(--danger, #c62828)" }}>
                            {clip.errorMessage}
                          </span>
                        ) : (
                          <>
                            <span>{dims}</span>
                            <span>
                              {formatDurationLabel(clip.probe?.durationSec ?? null, locale)}
                            </span>
                            <span
                              style={{ display: "inline-flex", alignItems: "center", gap: "3px" }}
                            >
                              {clip.probe?.hasAudio ? (
                                <>
                                  <Volume2 size={12} aria-hidden="true" />
                                  {isZh ? "有音频" : "Audio"}
                                </>
                              ) : (
                                <>
                                  <VolumeX size={12} aria-hidden="true" />
                                  {isZh ? "静音段" : "Silent"}
                                </>
                              )}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="media-actions-row">
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        disabled={running || idx === 0}
                        aria-label={isZh ? `上移 ${clip.fileName}` : `Move ${clip.fileName} up`}
                        onClick={() => moveClip(idx, idx - 1)}
                      >
                        <ArrowUp size={14} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        disabled={running || idx === state.clips.length - 1}
                        aria-label={isZh ? `下移 ${clip.fileName}` : `Move ${clip.fileName} down`}
                        onClick={() => moveClip(idx, idx + 1)}
                      >
                        <ArrowDown size={14} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        disabled={running}
                        aria-label={isZh ? `移除 ${clip.fileName}` : `Remove ${clip.fileName}`}
                        onClick={() => removeClip(clip.id)}
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Output configuration */}
            <div className="media-grid-2" style={{ marginTop: "12px" }}>
              <div>
                <label className="field-label" htmlFor="v12-resolution-preset">
                  {isZh ? "目标分辨率（统一封装为 H.264 MP4）" : "Target Resolution (H.264 MP4)"}
                </label>
                <select
                  id="v12-resolution-preset"
                  className="text-input"
                  style={{ width: "100%", marginTop: "6px" }}
                  value={state.resolutionPreset}
                  disabled={running}
                  onChange={(e) =>
                    updateVideoMergeSession((prev) => ({
                      ...prev,
                      resolutionPreset: e.target.value as MergeResolutionPreset,
                      lastResult: null,
                    }))
                  }
                >
                  {RESOLUTION_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {isZh ? opt.labelZh : opt.labelEn}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="field-label" htmlFor="v12-fit-mode">
                  {isZh ? "横竖屏/不同比例适配方式" : "Aspect Ratio Fit Mode"}
                </label>
                <select
                  id="v12-fit-mode"
                  className="text-input"
                  style={{ width: "100%", marginTop: "6px" }}
                  value={state.fitMode}
                  disabled={running}
                  onChange={(e) =>
                    updateVideoMergeSession((prev) => ({
                      ...prev,
                      fitMode: e.target.value as MergeFitMode,
                      lastResult: null,
                    }))
                  }
                >
                  <option value="pad">
                    {isZh
                      ? "等比留黑（默认，完整保留每段画面）"
                      : "Letterbox / Pad (Default, keep full picture)"}
                  </option>
                  <option value="fill">
                    {isZh ? "等比居中裁剪填满（无黑边）" : "Center Crop Fill (No black bars)"}
                  </option>
                </select>
              </div>
            </div>

            <div style={{ marginTop: "12px" }}>
              <label className="field-label" htmlFor="v12-output-path">
                {isZh ? "输出文件 (.mp4)" : "Output File (.mp4)"}
              </label>
              <div className="media-actions-row" style={{ marginTop: "6px" }}>
                <input
                  id="v12-output-path"
                  type="text"
                  className="text-input"
                  style={{ flex: 1 }}
                  value={state.outputPath}
                  disabled={running}
                  onChange={(e) =>
                    updateVideoMergeSession((prev) => ({ ...prev, outputPath: e.target.value }))
                  }
                />
                <button
                  type="button"
                  className="btn"
                  disabled={running}
                  onClick={() => void handlePickOutputPath()}
                >
                  <Save size={14} aria-hidden="true" />
                  <span>{isZh ? "另存为…" : "Save As..."}</span>
                </button>
              </div>
            </div>

            <div className="media-actions-row" style={{ marginTop: "12px" }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canStart}
                onClick={() => void handleStart()}
              >
                <Combine size={15} aria-hidden="true" />
                <span>
                  {running
                    ? isZh
                      ? "正在合并导出…"
                      : "Merging..."
                    : isZh
                      ? `开始合并 (${state.clips.length} 段)`
                      : `Merge Clips (${state.clips.length})`}
                </span>
              </button>
              {running && (
                <button type="button" className="btn" onClick={() => void cancelVideoMergeTask()}>
                  {isZh ? "取消任务" : "Cancel"}
                </button>
              )}
            </div>

            {running && state.liveProgress && (
              <div className="media-progress-panel" style={{ marginTop: "12px" }}>
                <div className="media-progress-header">
                  <span>
                    {isZh
                      ? `正在拼接 ${state.clips.length} 段视频…`
                      : `Merging ${state.clips.length} video clips...`}
                  </span>
                  <span>
                    {state.liveProgress.percent != null
                      ? `${Math.round(state.liveProgress.percent)}%`
                      : "..."}
                  </span>
                </div>
                <progress
                  max={100}
                  value={state.liveProgress.percent ?? undefined}
                  style={{ width: "100%" }}
                />
              </div>
            )}

            {state.errorMessage && (
              <div
                className="inline-alert inline-alert-error"
                role="alert"
                style={{ marginTop: "12px" }}
              >
                {state.errorMessage}
              </div>
            )}

            {state.lastResult && (
              <div className="media-result-card" style={{ marginTop: "12px" }}>
                <div className="media-section-header">
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <CheckCircle2 size={18} aria-hidden="true" />
                    <strong>
                      {isZh
                        ? `合并完成：${state.lastResult.clipCount} 段 → ${state.lastResult.outputWidth}×${state.lastResult.outputHeight} · ${formatDurationLabel(state.lastResult.outputDurationSec, locale)} · ${formatMediaBytes(state.lastResult.byteSize, locale)}`
                        : `Merged ${state.lastResult.clipCount} clips → ${state.lastResult.outputWidth}×${state.lastResult.outputHeight} · ${formatDurationLabel(state.lastResult.outputDurationSec, locale)} · ${formatMediaBytes(state.lastResult.byteSize, locale)}`}
                    </strong>
                  </div>
                  <div className="media-actions-row">
                    <button
                      type="button"
                      className="btn"
                      onClick={() =>
                        void openLocalDirectory(getParentDir(state.lastResult!.outputPath))
                      }
                    >
                      <FolderOpen size={14} aria-hidden="true" />
                      <span>{isZh ? "打开所在目录" : "Open Folder"}</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => handoffMediaFileToTool("V06", state.lastResult!.outputPath)}
                    >
                      <span>{isZh ? "去压缩 (V06)" : "Compress (V06)"}</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => handoffMediaFileToTool("V04", state.lastResult!.outputPath)}
                    >
                      <span>{isZh ? "抽帧 (V04)" : "Frames (V04)"}</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => handoffMediaFileToTool("V15", state.lastResult!.outputPath)}
                    >
                      <span>{isZh ? "转 GIF (V15)" : "GIF (V15)"}</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => handoffMediaFileToTool("V10", state.lastResult!.outputPath)}
                    >
                      <Info size={13} aria-hidden="true" />
                      <span>V10</span>
                    </button>
                  </div>
                </div>
                <div
                  className="field-hint"
                  style={{ fontSize: "12px", marginTop: "6px", wordBreak: "break-all" }}
                >
                  {state.lastResult.outputPath}
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
