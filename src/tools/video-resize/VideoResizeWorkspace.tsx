import {
  CheckCircle2,
  FilePlus2,
  FolderOpen,
  Info,
  Lock,
  Scaling,
  Trash2,
  Unlock,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { MediaToolsSetupPanel } from "../../components/MediaToolsSetupPanel";
import { useI18n } from "../../i18n/I18nContext";
import { useMediaSession } from "../../lib/mediaSessionStore";
import {
  bindDisposableListener,
  formatLocalizedError,
  openLocalDirectory,
  pickMultipleFiles,
  pickSingleDirectory,
  probeMediaInfo,
  registerMediaPreviewPath,
  subscribeFileDrop,
  type MediaToolsStatus,
  type VideoResizeMode,
} from "../../lib/tauriBridge";
import {
  VIDEO_EXTENSIONS,
  formatDurationLabel,
  formatMediaBytes,
  getFileName,
  getParentDir,
} from "../media-shared/mediaFormat";
import "../media-shared/mediaWorkspace.css";

const RESOLUTION_PRESETS: { labelZh: string; labelEn: string; w: number; h: number }[] = [
  { labelZh: "4K (3840×2160)", labelEn: "4K (3840×2160)", w: 3840, h: 2160 },
  { labelZh: "1080p (1920×1080)", labelEn: "1080p (1920×1080)", w: 1920, h: 1080 },
  { labelZh: "720p (1280×720)", labelEn: "720p (1280×720)", w: 1280, h: 720 },
  { labelZh: "480p (854×480)", labelEn: "480p (854×480)", w: 854, h: 480 },
  { labelZh: "1:1 方形 (1080×1080)", labelEn: "Square 1:1 (1080×1080)", w: 1080, h: 1080 },
  { labelZh: "9:16 竖屏 (1080×1920)", labelEn: "Vertical 9:16 (1080×1920)", w: 1080, h: 1920 },
];

function makeEven(n: number): number {
  const r = Math.max(2, Math.round(n));
  return Math.max(2, Math.floor(r / 2) * 2);
}

export function predictResizeOutput(
  srcW: number | null,
  srcH: number | null,
  targetW: number,
  targetH: number,
  mode: VideoResizeMode,
  preventUpscale: boolean,
): { width: number; height: number } {
  const tw = makeEven(Math.min(7680, Math.max(16, targetW || 16)));
  const th = makeEven(Math.min(7680, Math.max(16, targetH || 16)));
  if (!srcW || !srcH || mode !== "fit") {
    return { width: tw, height: th };
  }
  let scale = Math.min(tw / srcW, th / srcH);
  if (preventUpscale && scale > 1) scale = 1;
  return {
    width: Math.min(tw, makeEven(srcW * scale)),
    height: Math.min(th, makeEven(srcH * scale)),
  };
}

export function VideoResizeWorkspace() {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const {
    mediaSession,
    updateVideoResizeSession,
    startVideoResizeBatch,
    cancelVideoResizeBatch,
    handoffMediaFileToTool,
    pendingHandoff,
    consumePendingHandoff,
  } = useMediaSession();
  const state = mediaSession.videoResize;

  const [toolsStatus, setToolsStatus] = useState<MediaToolsStatus | null>(null);
  const [hovering, setHovering] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const addVideoPaths = useCallback(
    async (paths: string[]) => {
      const unique = Array.from(new Set(paths.map((p) => p.trim()).filter(Boolean)));
      if (unique.length === 0) return;

      updateVideoResizeSession((prev) => {
        const map = new Map(prev.items.map((i) => [i.path, i]));
        for (const p of unique) {
          if (!map.has(p)) {
            map.set(p, {
              path: p,
              fileName: getFileName(p),
              status: "loading",
              probe: null,
              errorMessage: null,
              selectedAudioTrackIndex: 0,
            });
          }
        }
        const items = Array.from(map.values());
        return {
          ...prev,
          items,
          selectedPath: prev.selectedPath ?? items[0]?.path ?? null,
          outputDir: prev.outputDir || (unique[0] ? getParentDir(unique[0]) : ""),
          lastReport: null,
          errorMessage: null,
        };
      });

      for (const p of unique) {
        try {
          const probe = await probeMediaInfo(p);
          updateVideoResizeSession((prev) => ({
            ...prev,
            items: prev.items.map((item) =>
              item.path === p
                ? { ...item, fileName: probe.fileName, status: "ready", probe, errorMessage: null }
                : item,
            ),
          }));
        } catch (err) {
          const msg = formatLocalizedError(err, t);
          updateVideoResizeSession((prev) => ({
            ...prev,
            items: prev.items.map((item) =>
              item.path === p ? { ...item, status: "error", probe: null, errorMessage: msg } : item,
            ),
          }));
        }
      }
    },
    [t, updateVideoResizeSession],
  );

  useEffect(() => {
    if (pendingHandoff?.toolId === "V08") {
      const path = consumePendingHandoff("V08");
      if (path) void addVideoPaths([path]);
    }
  }, [pendingHandoff, consumePendingHandoff, addVideoPaths]);

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: setHovering,
          onDropPaths: (paths) => void addVideoPaths(paths),
        }),
      "v08-file-drop",
    );
  }, [addVideoPaths]);

  useEffect(() => {
    let active = true;
    if (!state.selectedPath) {
      setPreviewUrl(null);
      return;
    }
    void registerMediaPreviewPath(state.selectedPath)
      .then((reg) => {
        if (active) setPreviewUrl(reg.url);
      })
      .catch(() => {
        if (active) setPreviewUrl(null);
      });
    return () => {
      active = false;
    };
  }, [state.selectedPath]);

  const handlePickFiles = async () => {
    const picked = await pickMultipleFiles({
      title: isZh ? "选择要调整尺寸的视频文件" : "Select videos to resize",
      filters: [{ name: isZh ? "视频文件" : "Video Files", extensions: VIDEO_EXTENSIONS }],
    });
    if (picked.length > 0) await addVideoPaths(picked);
  };

  const handlePickOutputDir = async () => {
    const dir = await pickSingleDirectory({
      title: isZh ? "选择输出目录" : "Choose output directory",
    });
    if (dir) {
      updateVideoResizeSession((prev) => ({ ...prev, outputDir: dir }));
    }
  };

  const handleRemove = (path: string) => {
    updateVideoResizeSession((prev) => {
      const next = prev.items.filter((i) => i.path !== path);
      return {
        ...prev,
        items: next,
        selectedPath: prev.selectedPath === path ? (next[0]?.path ?? null) : prev.selectedPath,
        lastReport: null,
      };
    });
  };

  const handleToggleAspectLock = () => {
    updateVideoResizeSession((prev) => {
      const nextLock = !prev.lockAspectRatio;
      return {
        ...prev,
        lockAspectRatio: nextLock,
        mode: nextLock && prev.mode === "stretch" ? "fit" : prev.mode,
      };
    });
  };

  const handleStartResize = async () => {
    if (state.items.length === 0 || !state.outputDir.trim()) return;
    await startVideoResizeBatch(
      {
        sourcePaths: state.items.map((i) => i.path),
        outputDir: state.outputDir.trim(),
        targetWidth: Math.max(16, Math.min(7680, Math.round(state.targetWidth))),
        targetHeight: Math.max(16, Math.min(7680, Math.round(state.targetHeight))),
        mode: state.mode,
        lockAspectRatio: state.lockAspectRatio,
        preventUpscale: state.preventUpscale,
      },
      (err) => formatLocalizedError(err, t),
    );
  };

  const mediaReady = toolsStatus?.ready ?? true;
  const modes: {
    id: VideoResizeMode;
    zh: string;
    en: string;
    descZh: string;
    descEn: string;
    requiresUnlock?: boolean;
  }[] = [
    {
      id: "fit",
      zh: "等比放入范围",
      en: "Fit in Bounds",
      descZh: "保持原比例不裁切不加黑边",
      descEn: "Keep ratio, no bars or crop",
    },
    {
      id: "pad",
      zh: "留黑边到指定尺寸",
      en: "Letterbox / Pad",
      descZh: "等比缩放并居中补黑边",
      descEn: "Exact size with black bars",
    },
    {
      id: "fill",
      zh: "裁满画布",
      en: "Crop to Fill",
      descZh: "等比放大并居中裁切填满",
      descEn: "Exact size by center crop",
    },
    {
      id: "stretch",
      zh: "拉伸填满",
      en: "Stretch",
      descZh: "仅关闭比例锁定时可用",
      descEn: "Requires unlocking ratio",
      requiresUnlock: true,
    },
  ];

  return (
    <div className="media-workspace">
      <MediaToolsSetupPanel onStatusChange={setToolsStatus} />

      {state.items.length === 0 ? (
        <div className={`media-dropzone ${hovering ? "is-hover" : ""}`}>
          <Scaling size={28} strokeWidth={1.6} aria-hidden="true" />
          <div style={{ fontWeight: 600, fontSize: "15px" }}>
            {isZh ? "拖入单个或多个视频调整分辨率" : "Drop one or more videos to resize"}
          </div>
          <div style={{ fontSize: "13px", color: "var(--text-secondary)", maxWidth: "560px" }}>
            {isZh
              ? "支持常见分辨率、1:1 方形、9:16 竖屏与自定义宽高，清晰区分「等比放入范围」「留黑边到指定尺寸」「裁满画布」，导出前实时展示每段实际输出尺寸。"
              : "Common presets, 1:1 square, 9:16 vertical, and custom dimensions with Fit, Letterbox/Pad, Crop-to-Fill, and explicit unlock-only Stretch."}
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!mediaReady}
            onClick={() => void handlePickFiles()}
          >
            <FilePlus2 size={15} />
            {isZh ? "选择视频文件..." : "Select Videos..."}
          </button>
        </div>
      ) : (
        <div className="media-split">
          {/* Left column: preview + queue with exact pre-export output dimensions */}
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
              <div style={{ fontWeight: 600, fontSize: "14px" }}>
                {isZh
                  ? `批量调整列表（${state.items.length} 个视频）`
                  : `Videos to Resize (${state.items.length})`}
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  type="button"
                  className="btn"
                  disabled={state.taskStatus === "running" || !mediaReady}
                  onClick={() => void handlePickFiles()}
                >
                  <FilePlus2 size={14} />
                  {isZh ? "添加视频" : "Add Videos"}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={state.taskStatus === "running"}
                  onClick={() =>
                    updateVideoResizeSession((prev) => ({
                      ...prev,
                      items: [],
                      selectedPath: null,
                      lastReport: null,
                    }))
                  }
                >
                  <Trash2 size={14} />
                  {isZh ? "清空" : "Clear"}
                </button>
              </div>
            </div>

            {previewUrl && (
              <div className="media-video-box" style={{ minHeight: "190px", maxHeight: "260px" }}>
                <video
                  key={previewUrl}
                  src={previewUrl}
                  controls
                  preload="metadata"
                  style={{ width: "100%", maxHeight: "260px", objectFit: "contain" }}
                />
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {state.items.map((item) => {
                const v0 = item.probe?.videoStreams[0];
                const dispW = v0?.displayWidth ?? v0?.codedWidth ?? null;
                const dispH = v0?.displayHeight ?? v0?.codedHeight ?? null;
                const predicted = predictResizeOutput(
                  dispW,
                  dispH,
                  state.targetWidth,
                  state.targetHeight,
                  state.mode,
                  state.preventUpscale,
                );
                const isSelected = (state.selectedPath ?? state.items[0]?.path) === item.path;
                const resItem = state.lastReport?.items.find((r) => r.sourcePath === item.path);

                return (
                  <div
                    key={item.path}
                    onClick={() =>
                      updateVideoResizeSession((prev) => ({ ...prev, selectedPath: item.path }))
                    }
                    style={{
                      border: `1px solid ${isSelected ? "var(--accent)" : "var(--border-subtle)"}`,
                      borderRadius: "8px",
                      padding: "10px 12px",
                      background: "var(--bg-subtle)",
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      gap: "6px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: "8px",
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: "13px", wordBreak: "break-all" }}>
                          {item.fileName}
                        </div>
                        {item.probe && (
                          <div
                            style={{
                              fontSize: "12px",
                              color: "var(--text-secondary)",
                              marginTop: "2px",
                            }}
                          >
                            {formatDurationLabel(item.probe.durationSec, locale)} ·{" "}
                            {isZh ? "当前显示" : "Display"}:{" "}
                            <span className="mono">
                              {dispW ?? "?"}×{dispH ?? "?"}
                            </span>{" "}
                            →{" "}
                            <strong className="mono" style={{ color: "var(--text-primary)" }}>
                              {isZh ? "预计输出" : "Output"} {predicted.width}×{predicted.height}
                            </strong>
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        className="btn"
                        aria-label={isZh ? "移除文件" : "Remove file"}
                        disabled={state.taskStatus === "running"}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemove(item.path);
                        }}
                        style={{ padding: "4px 6px" }}
                      >
                        <X size={13} />
                      </button>
                    </div>

                    {resItem && (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          flexWrap: "wrap",
                          fontSize: "12px",
                        }}
                      >
                        <span
                          className={`media-status-pill ${
                            resItem.status === "resized"
                              ? "is-ok"
                              : resItem.status === "skipped"
                                ? "is-warn"
                                : "is-err"
                          }`}
                        >
                          {resItem.status === "resized"
                            ? isZh
                              ? `已输出 ${resItem.outputWidth}×${resItem.outputHeight}`
                              : `Exported ${resItem.outputWidth}×${resItem.outputHeight}`
                            : resItem.status === "skipped"
                              ? isZh
                                ? "已跳过"
                                : "Skipped"
                              : isZh
                                ? "失败"
                                : "Failed"}
                        </span>
                        {resItem.outputBytes != null && (
                          <span className="mono">
                            {formatMediaBytes(resItem.outputBytes, locale)}
                          </span>
                        )}
                        {resItem.outputPath && (
                          <button
                            type="button"
                            className="btn"
                            style={{ padding: "3px 8px", fontSize: "11px" }}
                            onClick={(e) => {
                              e.stopPropagation();
                              handoffMediaFileToTool("V10", resItem.outputPath!);
                            }}
                          >
                            <Info size={12} />
                            {isZh ? "媒体信息 (V10)" : "Inspect (V10)"}
                          </button>
                        )}
                        {resItem.message && (
                          <span style={{ color: "var(--status-err)" }}>{resItem.message}</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right column: Presets, custom dimensions, fit/pad/fill/stretch, export */}
          <div className="media-stage-card">
            <div style={{ fontWeight: 600, fontSize: "14px" }}>
              {isZh ? "目标尺寸与适配方式" : "Target Size & Fit Mode"}
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
              {RESOLUTION_PRESETS.map((preset) => {
                const active = state.targetWidth === preset.w && state.targetHeight === preset.h;
                return (
                  <button
                    key={`${preset.w}x${preset.h}`}
                    type="button"
                    className={`btn ${active ? "btn-primary" : ""}`}
                    style={{ fontSize: "12px", padding: "5px 9px" }}
                    disabled={state.taskStatus === "running"}
                    onClick={() =>
                      updateVideoResizeSession((prev) => ({
                        ...prev,
                        targetWidth: preset.w,
                        targetHeight: preset.h,
                      }))
                    }
                  >
                    {isZh ? preset.labelZh : preset.labelEn}
                  </button>
                );
              })}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
              <label
                style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" }}
              >
                <span>{isZh ? "目标宽度 (px)" : "Target Width (px)"}</span>
                <input
                  type="number"
                  className="text-input mono"
                  min={16}
                  max={7680}
                  step={2}
                  value={state.targetWidth}
                  disabled={state.taskStatus === "running"}
                  onChange={(e) =>
                    updateVideoResizeSession((prev) => ({
                      ...prev,
                      targetWidth: Number(e.target.value) || 16,
                    }))
                  }
                />
              </label>
              <label
                style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" }}
              >
                <span>{isZh ? "目标高度 (px)" : "Target Height (px)"}</span>
                <input
                  type="number"
                  className="text-input mono"
                  min={16}
                  max={7680}
                  step={2}
                  value={state.targetHeight}
                  disabled={state.taskStatus === "running"}
                  onChange={(e) =>
                    updateVideoResizeSession((prev) => ({
                      ...prev,
                      targetHeight: Number(e.target.value) || 16,
                    }))
                  }
                />
              </label>
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "8px",
                flexWrap: "wrap",
              }}
            >
              <button
                type="button"
                className="btn"
                disabled={state.taskStatus === "running"}
                onClick={handleToggleAspectLock}
              >
                {state.lockAspectRatio ? <Lock size={14} /> : <Unlock size={14} />}
                {state.lockAspectRatio
                  ? isZh
                    ? "已锁定画面比例（防拉伸）"
                    : "Aspect Ratio Locked"
                  : isZh
                    ? "已关闭比例锁定（允许拉伸）"
                    : "Aspect Ratio Unlocked (Stretch Allowed)"}
              </button>
              {state.mode === "fit" && (
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    fontSize: "12px",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={state.preventUpscale}
                    disabled={state.taskStatus === "running"}
                    onChange={(e) =>
                      updateVideoResizeSession((prev) => ({
                        ...prev,
                        preventUpscale: e.target.checked,
                      }))
                    }
                  />
                  <span>{isZh ? "不放大更小的视频" : "Do not upscale smaller videos"}</span>
                </label>
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
              {modes.map((m) => {
                const disabled =
                  state.taskStatus === "running" ||
                  (Boolean(m.requiresUnlock) && state.lockAspectRatio);
                return (
                  <button
                    key={m.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => updateVideoResizeSession((prev) => ({ ...prev, mode: m.id }))}
                    style={{
                      textAlign: "left",
                      padding: "8px 10px",
                      borderRadius: "8px",
                      border: `1.5px solid ${state.mode === m.id ? "var(--accent)" : "var(--border-subtle)"}`,
                      background: state.mode === m.id ? "var(--bg-subtle)" : "var(--bg-surface)",
                      opacity: disabled ? 0.55 : 1,
                      cursor: disabled ? "not-allowed" : "pointer",
                    }}
                  >
                    <div
                      style={{ fontWeight: 600, fontSize: "12.5px", color: "var(--text-primary)" }}
                    >
                      {isZh ? m.zh : m.en}
                    </div>
                    <div
                      style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "2px" }}
                    >
                      {isZh ? m.descZh : m.descEn}
                    </div>
                  </button>
                );
              })}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ fontSize: "12px", fontWeight: 600 }}>
                {isZh ? "输出目录（绝不覆盖源文件）" : "Output Directory"}
              </label>
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  type="text"
                  className="text-input mono"
                  value={state.outputDir}
                  onChange={(e) =>
                    updateVideoResizeSession((prev) => ({ ...prev, outputDir: e.target.value }))
                  }
                  style={{ flex: 1, minWidth: 0 }}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={state.taskStatus === "running"}
                  onClick={() => void handlePickOutputDir()}
                >
                  {isZh ? "浏览..." : "Browse..."}
                </button>
              </div>
            </div>

            {state.taskStatus === "running" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px" }}>
                  <span>
                    {isZh
                      ? `正在调整 (${state.liveProgress?.currentItem ?? 1}/${state.liveProgress?.totalItems ?? state.items.length})...`
                      : `Resizing (${state.liveProgress?.currentItem ?? 1}/${state.liveProgress?.totalItems ?? state.items.length})...`}
                  </span>
                  <span className="mono">{Math.round(state.liveProgress?.percent ?? 0)}%</span>
                </div>
                <div className="media-progress-bar">
                  <div
                    className="media-progress-fill"
                    style={{ width: `${Math.round(state.liveProgress?.percent ?? 0)}%` }}
                  />
                </div>
                <button type="button" className="btn" onClick={() => void cancelVideoResizeBatch()}>
                  {isZh ? "取消" : "Cancel"}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!mediaReady || state.items.length === 0 || !state.outputDir.trim()}
                onClick={() => void handleStartResize()}
              >
                <Scaling size={15} />
                {isZh
                  ? `批量导出尺寸调整（${state.items.length} 项）`
                  : `Resize Videos (${state.items.length})`}
              </button>
            )}

            {state.errorMessage && (
              <div style={{ fontSize: "12px", color: "var(--status-err)" }}>
                {state.errorMessage}
              </div>
            )}

            {state.lastReport && (
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "8px",
                  borderTop: "1px solid var(--border-subtle)",
                  paddingTop: "10px",
                }}
              >
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    fontSize: "12px",
                    fontWeight: 600,
                  }}
                >
                  <CheckCircle2 size={14} style={{ color: "var(--status-ok)" }} />
                  {isZh
                    ? `成功 ${state.lastReport.resizedCount} · 失败 ${state.lastReport.failedCount}`
                    : `${state.lastReport.resizedCount} resized · ${state.lastReport.failedCount} failed`}
                </span>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void openLocalDirectory(state.lastReport!.outputDir)}
                >
                  <FolderOpen size={14} />
                  {isZh ? "打开输出目录" : "Open Folder"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
