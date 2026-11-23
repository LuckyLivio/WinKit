import {
  CheckCircle2,
  FilePlus2,
  FolderOpen,
  Gauge,
  Info,
  Trash2,
  Volume2,
  VolumeX,
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
} from "../../lib/tauriBridge";
import {
  VIDEO_EXTENSIONS,
  formatDurationLabel,
  formatMediaBytes,
  getFileName,
  getParentDir,
} from "../media-shared/mediaFormat";
import "../media-shared/mediaWorkspace.css";

const SPEED_PRESETS = [0.25, 0.5, 0.75, 1.25, 1.5, 2.0, 3.0, 4.0];

export function estimateSpeedDuration(
  durationSec: number | null | undefined,
  speedFactor: number,
): number | null {
  if (durationSec == null || !Number.isFinite(durationSec) || durationSec <= 0) return null;
  if (!Number.isFinite(speedFactor) || speedFactor <= 0) return null;
  return durationSec / speedFactor;
}

export function VideoSpeedWorkspace() {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const {
    mediaSession,
    updateVideoSpeedSession,
    startVideoSpeedBatch,
    cancelVideoSpeedBatch,
    handoffMediaFileToTool,
    pendingHandoff,
    consumePendingHandoff,
  } = useMediaSession();
  const state = mediaSession.videoSpeed;

  const [toolsStatus, setToolsStatus] = useState<MediaToolsStatus | null>(null);
  const [hovering, setHovering] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const addVideoPaths = useCallback(
    async (paths: string[]) => {
      const unique = Array.from(new Set(paths.map((p) => p.trim()).filter(Boolean)));
      if (unique.length === 0) return;

      updateVideoSpeedSession((prev) => {
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
          updateVideoSpeedSession((prev) => ({
            ...prev,
            items: prev.items.map((item) =>
              item.path === p
                ? { ...item, fileName: probe.fileName, status: "ready", probe, errorMessage: null }
                : item,
            ),
          }));
        } catch (err) {
          const msg = formatLocalizedError(err, t);
          updateVideoSpeedSession((prev) => ({
            ...prev,
            items: prev.items.map((item) =>
              item.path === p ? { ...item, status: "error", probe: null, errorMessage: msg } : item,
            ),
          }));
        }
      }
    },
    [t, updateVideoSpeedSession],
  );

  useEffect(() => {
    if (pendingHandoff?.toolId === "V03") {
      const path = consumePendingHandoff("V03");
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
      "v03-file-drop",
    );
  }, [addVideoPaths]);

  const selectedItem =
    state.items.find((i) => i.path === state.selectedPath) ?? state.items[0] ?? null;

  useEffect(() => {
    let active = true;
    const path = selectedItem?.path;
    if (!path || selectedItem?.status !== "ready") {
      setPreviewUrl(null);
      return;
    }
    void registerMediaPreviewPath(path)
      .then((reg) => {
        if (active) setPreviewUrl(reg.url);
      })
      .catch(() => {
        if (active) setPreviewUrl(null);
      });
    return () => {
      active = false;
    };
  }, [selectedItem?.path, selectedItem?.status]);

  const handlePickVideos = async () => {
    try {
      const picked = await pickMultipleFiles({
        title: isZh ? "选择需要变速的视频文件" : "Select video files to change speed",
        filters: [
          {
            name: isZh ? "视频文件" : "Video Files",
            extensions: [...VIDEO_EXTENSIONS],
          },
        ],
      });
      if (picked && picked.length > 0) {
        await addVideoPaths(picked);
      }
    } catch (err) {
      updateVideoSpeedSession((prev) => ({
        ...prev,
        errorMessage: formatLocalizedError(err, t),
      }));
    }
  };

  const handlePickOutputDir = async () => {
    try {
      const picked = await pickSingleDirectory({
        title: isZh ? "选择输出目录" : "Select output directory",
      });
      if (picked) {
        updateVideoSpeedSession((prev) => ({ ...prev, outputDir: picked }));
      }
    } catch (err) {
      updateVideoSpeedSession((prev) => ({
        ...prev,
        errorMessage: formatLocalizedError(err, t),
      }));
    }
  };

  const handleRemoveItem = (path: string) => {
    updateVideoSpeedSession((prev) => {
      const items = prev.items.filter((i) => i.path !== path);
      return {
        ...prev,
        items,
        selectedPath: prev.selectedPath === path ? (items[0]?.path ?? null) : prev.selectedPath,
      };
    });
  };

  const handleClear = () => {
    updateVideoSpeedSession((prev) => ({
      ...prev,
      items: [],
      selectedPath: null,
      lastReport: null,
      errorMessage: null,
    }));
  };

  const handleSpeedInput = (val: number) => {
    if (!Number.isFinite(val)) return;
    const clamped = Math.min(4.0, Math.max(0.25, Math.round(val * 100) / 100));
    updateVideoSpeedSession((prev) => ({ ...prev, speedFactor: clamped, lastReport: null }));
  };

  const handleStart = async () => {
    if (state.items.length === 0 || !state.outputDir.trim()) return;
    await startVideoSpeedBatch(
      {
        sourcePaths: state.items.map((i) => i.path),
        outputDir: state.outputDir.trim(),
        speedFactor: state.speedFactor,
        preservePitch: state.preservePitch,
        muteAudio: state.muteAudio,
      },
      (err) => formatLocalizedError(err, t),
    );
  };

  const mediaReady = Boolean(toolsStatus?.ready);
  const running = state.taskStatus === "running";
  const selectedProbe = selectedItem?.probe ?? null;
  const selectedEstDur = estimateSpeedDuration(selectedProbe?.durationSec, state.speedFactor);
  const canStart =
    mediaReady && !running && state.items.length > 0 && Boolean(state.outputDir.trim());

  return (
    <div className="media-workspace">
      <MediaToolsSetupPanel onStatusChange={setToolsStatus} />

      <section className="panel media-section">
        <div className="media-section-header">
          <div>
            <h3>{isZh ? "视频变速" : "Change Video Speed"}</h3>
            <p className="field-hint" style={{ margin: "2px 0 0" }}>
              {isZh
                ? "支持 0.25× 至 4× 单文件与批量变速，默认多级 atempo 保持原音调，兼容静音视频，输出非破坏性 H.264 MP4。"
                : "Adjust single or batch videos from 0.25x to 4x with default chained-atempo pitch preservation, optional mute, and silent-clip support."}
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
              <span>{isZh ? "添加视频" : "Add Videos"}</span>
            </button>
            {state.items.length > 0 && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={running}
                onClick={handleClear}
              >
                <Trash2 size={14} aria-hidden="true" />
                <span>{isZh ? "清空" : "Clear"}</span>
              </button>
            )}
          </div>
        </div>

        {state.items.length === 0 ? (
          <div className={`media-dropzone ${hovering ? "is-hover" : ""}`}>
            <Gauge size={24} strokeWidth={1.6} aria-hidden="true" />
            <p style={{ margin: 0, fontWeight: 600 }}>
              {isZh
                ? "拖入一个或多个视频文件以调整播放倍率"
                : "Drop one or more video files to change playback speed"}
            </p>
            <p className="field-hint" style={{ margin: 0 }}>
              {isZh
                ? "0.25× 慢动作到 4× 快进，实时预估变速后时长，保留原始文件不动。"
                : "0.25x slow-motion to 4x fast-forward with live duration estimates; source files stay untouched."}
            </p>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!mediaReady}
              onClick={() => void handlePickVideos()}
            >
              <FilePlus2 size={15} aria-hidden="true" />
              <span>{isZh ? "选择视频文件…" : "Select Video Files..."}</span>
            </button>
          </div>
        ) : (
          <>
            <div className="media-grid-2">
              {/* Left: queue + preview */}
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <div className="media-queue-list" role="list">
                  {state.items.map((item) => {
                    const est = estimateSpeedDuration(item.probe?.durationSec, state.speedFactor);
                    const hasAudio = item.probe?.hasAudio ?? false;
                    return (
                      <div
                        key={item.path}
                        className={`media-queue-item ${item.path === selectedItem?.path ? "is-selected" : ""}`}
                        role="listitem"
                      >
                        <button
                          type="button"
                          className="media-queue-select"
                          onClick={() =>
                            updateVideoSpeedSession((prev) => ({
                              ...prev,
                              selectedPath: item.path,
                            }))
                          }
                        >
                          <div style={{ fontWeight: 600, wordBreak: "break-all" }}>
                            {item.fileName}
                          </div>
                          <div className="field-hint" style={{ fontSize: "12px" }}>
                            {item.status === "loading"
                              ? isZh
                                ? "正在读取信息…"
                                : "Probing..."
                              : item.status === "error"
                                ? item.errorMessage
                                : `${formatDurationLabel(item.probe?.durationSec ?? null, locale)} → ${formatDurationLabel(est, locale)} · ${
                                    hasAudio
                                      ? isZh
                                        ? "含音频"
                                        : "Audio"
                                      : isZh
                                        ? "无音轨"
                                        : "Silent"
                                  }`}
                          </div>
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon"
                          disabled={running}
                          aria-label={isZh ? `移除 ${item.fileName}` : `Remove ${item.fileName}`}
                          onClick={() => handleRemoveItem(item.path)}
                        >
                          <X size={14} aria-hidden="true" />
                        </button>
                      </div>
                    );
                  })}
                </div>

                {previewUrl && (
                  <div className="media-preview-box">
                    <video
                      src={previewUrl}
                      controls
                      preload="metadata"
                      style={{ width: "100%", maxHeight: "200px", borderRadius: "6px" }}
                    />
                  </div>
                )}
              </div>

              {/* Right: Speed controls */}
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                <div>
                  <label className="field-label" htmlFor="v03-speed-range">
                    {isZh
                      ? `播放倍率：${state.speedFactor.toFixed(2).replace(/\.?0+$/, "")}×`
                      : `Playback Speed: ${state.speedFactor.toFixed(2).replace(/\.?0+$/, "")}x`}
                  </label>
                  <div className="media-actions-row" style={{ marginTop: "6px" }}>
                    <input
                      id="v03-speed-range"
                      type="range"
                      min={0.25}
                      max={4.0}
                      step={0.05}
                      value={state.speedFactor}
                      disabled={running}
                      style={{ flex: 1 }}
                      onChange={(e) => handleSpeedInput(Number(e.target.value))}
                    />
                    <input
                      id="v03-speed-number"
                      aria-label={isZh ? "自定义倍率" : "Custom speed factor"}
                      type="number"
                      min={0.25}
                      max={4.0}
                      step={0.05}
                      value={state.speedFactor}
                      disabled={running}
                      className="text-input"
                      style={{ width: "86px" }}
                      onChange={(e) => handleSpeedInput(Number(e.target.value))}
                    />
                  </div>
                </div>

                <div>
                  <span className="field-label">{isZh ? "常用倍率预设" : "Common Presets"}</span>
                  <div className="media-actions-row" style={{ marginTop: "6px" }}>
                    {SPEED_PRESETS.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        className={`btn ${Math.abs(state.speedFactor - preset) < 1e-4 ? "btn-primary" : ""}`}
                        disabled={running}
                        onClick={() => handleSpeedInput(preset)}
                      >
                        {preset}×
                      </button>
                    ))}
                  </div>
                </div>

                {selectedProbe && (
                  <div className="media-summary-card" data-testid="v03-duration-estimate">
                    <div style={{ fontWeight: 600, marginBottom: "4px" }}>
                      {isZh ? "预计时长变化" : "Estimated Duration"}
                    </div>
                    <div style={{ fontSize: "13px" }}>
                      {isZh ? "原始时长：" : "Original: "}
                      <strong>{formatDurationLabel(selectedProbe.durationSec, locale)}</strong>
                      {"  →  "}
                      {isZh ? "预计输出：" : "Estimated: "}
                      <strong>{formatDurationLabel(selectedEstDur, locale)}</strong>
                    </div>
                    <div className="field-hint" style={{ fontSize: "12px", marginTop: "4px" }}>
                      {selectedProbe.hasAudio
                        ? state.muteAudio
                          ? isZh
                            ? "输出将静音（移除音轨）。"
                            : "Output audio will be muted."
                          : state.preservePitch
                            ? isZh
                              ? "默认保持原音调（多级 atempo 变速），保证声画同步。"
                              : "Pitch preserved via chained atempo filters with accurate A/V sync."
                            : isZh
                              ? "将随倍率改变音调（采样率变速模式）。"
                              : "Pitch will shift naturally with playback speed."
                        : isZh
                          ? "当前视频无音轨，将直接对画面变速并输出静音 MP4。"
                          : "Source clip has no audio stream; video will be speed-adjusted cleanly."}
                    </div>
                  </div>
                )}

                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={state.preservePitch}
                      disabled={running || state.muteAudio}
                      onChange={(e) =>
                        updateVideoSpeedSession((prev) => ({
                          ...prev,
                          preservePitch: e.target.checked,
                        }))
                      }
                    />
                    <Volume2 size={14} aria-hidden="true" />
                    <span>
                      {isZh ? "保持原始音调（推荐）" : "Preserve original pitch (recommended)"}
                    </span>
                  </label>

                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={state.muteAudio}
                      disabled={running}
                      onChange={(e) =>
                        updateVideoSpeedSession((prev) => ({
                          ...prev,
                          muteAudio: e.target.checked,
                        }))
                      }
                    />
                    <VolumeX size={14} aria-hidden="true" />
                    <span>{isZh ? "输出时移除音频（静音）" : "Mute audio in output"}</span>
                  </label>
                </div>

                <div>
                  <label className="field-label" htmlFor="v03-output-dir">
                    {isZh ? "输出目录" : "Output Folder"}
                  </label>
                  <div className="media-actions-row" style={{ marginTop: "6px" }}>
                    <input
                      id="v03-output-dir"
                      type="text"
                      className="text-input"
                      style={{ flex: 1 }}
                      value={state.outputDir}
                      disabled={running}
                      onChange={(e) =>
                        updateVideoSpeedSession((prev) => ({ ...prev, outputDir: e.target.value }))
                      }
                    />
                    <button
                      type="button"
                      className="btn"
                      disabled={running}
                      onClick={() => void handlePickOutputDir()}
                    >
                      <FolderOpen size={14} aria-hidden="true" />
                      <span>{isZh ? "选择目录…" : "Browse..."}</span>
                    </button>
                  </div>
                </div>

                <div className="media-actions-row">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!canStart}
                    onClick={() => void handleStart()}
                  >
                    <Gauge size={15} aria-hidden="true" />
                    <span>
                      {running
                        ? isZh
                          ? "正在处理变速…"
                          : "Applying Speed..."
                        : isZh
                          ? `开始变速导出 (${state.items.length})`
                          : `Export Speed (${state.items.length})`}
                    </span>
                  </button>
                  {running && (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void cancelVideoSpeedBatch()}
                    >
                      {isZh ? "取消任务" : "Cancel"}
                    </button>
                  )}
                </div>
              </div>
            </div>

            {running && state.liveProgress && (
              <div className="media-progress-panel">
                <div className="media-progress-header">
                  <span>
                    {isZh
                      ? `处理中 (${state.liveProgress.currentItem}/${state.liveProgress.totalItems})：${state.liveProgress.itemName ?? ""}`
                      : `Processing (${state.liveProgress.currentItem}/${state.liveProgress.totalItems}): ${state.liveProgress.itemName ?? ""}`}
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
              <div className="inline-alert inline-alert-error" role="alert">
                {state.errorMessage}
              </div>
            )}

            {state.lastReport && (
              <div className="media-result-card">
                <div className="media-section-header">
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <CheckCircle2 size={18} aria-hidden="true" />
                    <strong>
                      {state.lastReport.cancelled
                        ? isZh
                          ? `已取消：完成 ${state.lastReport.completedCount} 个，跳过 ${state.lastReport.skippedCount} 个`
                          : `Cancelled: ${state.lastReport.completedCount} completed, ${state.lastReport.skippedCount} skipped`
                        : isZh
                          ? `变速完成：成功 ${state.lastReport.completedCount} 个，失败 ${state.lastReport.failedCount} 个`
                          : `Done: ${state.lastReport.completedCount} succeeded, ${state.lastReport.failedCount} failed`}
                    </strong>
                  </div>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void openLocalDirectory(state.lastReport!.outputDir)}
                  >
                    <FolderOpen size={14} aria-hidden="true" />
                    <span>{isZh ? "打开输出文件夹" : "Open Output Folder"}</span>
                  </button>
                </div>

                <div className="media-queue-list" style={{ marginTop: "8px" }}>
                  {state.lastReport.items.map((item) => (
                    <div key={item.sourcePath} className="media-queue-item">
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600 }}>{item.fileName}</div>
                        <div className="field-hint" style={{ fontSize: "12px" }}>
                          {item.status === "completed"
                            ? `${formatDurationLabel(item.sourceDurationSec, locale)} → ${formatDurationLabel(item.outputDurationSec, locale)} · ${formatMediaBytes(item.outputBytes ?? 0, locale)} · ${
                                item.hasOutputAudio
                                  ? isZh
                                    ? "含音频"
                                    : "Audio"
                                  : isZh
                                    ? "无音轨"
                                    : "Silent"
                              }`
                            : (item.message ?? item.status)}
                        </div>
                      </div>
                      {item.outputPath && (
                        <div className="media-actions-row">
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() => handoffMediaFileToTool("V12", item.outputPath!)}
                          >
                            <span>{isZh ? "去合并 (V12)" : "Merge (V12)"}</span>
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() => handoffMediaFileToTool("V06", item.outputPath!)}
                          >
                            <span>{isZh ? "去压缩 (V06)" : "Compress (V06)"}</span>
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() => handoffMediaFileToTool("V10", item.outputPath!)}
                          >
                            <Info size={13} aria-hidden="true" />
                            <span>V10</span>
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
