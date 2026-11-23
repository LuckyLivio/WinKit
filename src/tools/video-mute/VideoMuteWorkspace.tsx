import { FilePlus2, FolderOpen, Trash2, VolumeX, X } from "lucide-react";
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

export function VideoMuteWorkspace() {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const {
    mediaSession,
    updateVideoMuteSession,
    startVideoMuteBatch,
    cancelVideoMuteBatch,
    pendingHandoff,
    consumePendingHandoff,
  } = useMediaSession();
  const state = mediaSession.videoMute;

  const [toolsStatus, setToolsStatus] = useState<MediaToolsStatus | null>(null);
  const [hovering, setHovering] = useState(false);

  const addVideoPaths = useCallback(
    async (paths: string[]) => {
      const unique = Array.from(new Set(paths.map((p) => p.trim()).filter(Boolean)));
      if (unique.length === 0) return;

      updateVideoMuteSession((prev) => {
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
        const defaultDir = prev.outputDir || (unique[0] ? getParentDir(unique[0]) : "");
        return {
          ...prev,
          items: Array.from(map.values()),
          outputDir: defaultDir,
          lastReport: null,
          errorMessage: null,
        };
      });

      for (const p of unique) {
        try {
          const probe = await probeMediaInfo(p);
          updateVideoMuteSession((prev) => ({
            ...prev,
            items: prev.items.map((item) =>
              item.path === p
                ? {
                    ...item,
                    fileName: probe.fileName,
                    status: "ready",
                    probe,
                    errorMessage: null,
                  }
                : item,
            ),
          }));
        } catch (err) {
          const msg = formatLocalizedError(err, t);
          updateVideoMuteSession((prev) => ({
            ...prev,
            items: prev.items.map((item) =>
              item.path === p
                ? {
                    ...item,
                    status: "error",
                    probe: null,
                    errorMessage: msg,
                  }
                : item,
            ),
          }));
        }
      }
    },
    [t, updateVideoMuteSession],
  );

  useEffect(() => {
    if (pendingHandoff?.toolId === "V13") {
      const path = consumePendingHandoff("V13");
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
      "v13-file-drop",
    );
  }, [addVideoPaths]);

  const handlePickFiles = async () => {
    const picked = await pickMultipleFiles({
      title: isZh ? "选择要静音的视频文件" : "Select videos to mute",
      filters: [{ name: isZh ? "视频文件" : "Video Files", extensions: VIDEO_EXTENSIONS }],
    });
    if (picked.length > 0) await addVideoPaths(picked);
  };

  const handlePickOutputDir = async () => {
    const dir = await pickSingleDirectory({
      title: isZh ? "选择静音副本输出目录" : "Choose output directory for muted videos",
    });
    if (dir) {
      updateVideoMuteSession((prev) => ({ ...prev, outputDir: dir }));
    }
  };

  const handleRunMute = async () => {
    if (state.items.length === 0 || !state.outputDir.trim()) return;
    await startVideoMuteBatch(
      {
        sourcePaths: state.items.map((i) => i.path),
        outputDir: state.outputDir.trim(),
      },
      (err) => formatLocalizedError(err, t),
    );
  };

  const mediaReady = toolsStatus?.ready ?? true;
  const removableCount = state.items.filter(
    (i) => i.status === "ready" && i.probe && i.probe.audioStreams.length > 0,
  ).length;
  const alreadySilentCount = state.items.filter(
    (i) => i.status === "ready" && i.probe && i.probe.audioStreams.length === 0,
  ).length;

  return (
    <div className="media-workspace">
      <MediaToolsSetupPanel onStatusChange={setToolsStatus} />

      {state.errorMessage && (
        <div className="status-banner is-err" role="alert">
          <span>{state.errorMessage}</span>
        </div>
      )}

      {state.items.length === 0 ? (
        <div className={`media-dropzone ${hovering ? "is-hover" : ""}`}>
          <p style={{ margin: 0, fontWeight: 600 }}>
            {isZh
              ? "拖入一个或多个视频，无损移除全部音轨"
              : "Drop one or more videos to remove all audio tracks losslessly"}
          </p>
          <p className="field-hint" style={{ margin: 0 }}>
            {isZh
              ? "采用视频流无损直拷（不重编码），保留原封装容器、画质、竖屏旋转方向与时长；多语言视频会一并移除所有音轨，原本无音轨的视频直接提示不重复写出。"
              : "Lossless video copy without re-encoding, preserving original container, quality, vertical orientation, and duration. Strips every audio track on multi-language videos and flags already-silent videos."}
          </p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!mediaReady}
            onClick={() => void handlePickFiles()}
          >
            <FilePlus2 size={15} aria-hidden="true" />
            <span>{isZh ? "选择视频文件…" : "Select Video Files..."}</span>
          </button>
        </div>
      ) : (
        <div className="media-split">
          <div className="media-stage-card">
            <div className="media-actions-row" style={{ justifyContent: "space-between" }}>
              <div className="media-actions-row">
                <button
                  type="button"
                  className="btn"
                  disabled={state.taskStatus === "running" || !mediaReady}
                  onClick={() => void handlePickFiles()}
                >
                  <FilePlus2 size={14} aria-hidden="true" />
                  <span>{isZh ? "添加视频" : "Add Videos"}</span>
                </button>
                <span className="field-hint" style={{ margin: 0 }}>
                  {isZh
                    ? `队列 ${state.items.length} 项（可静音 ${removableCount} · 原本无音轨 ${alreadySilentCount}）`
                    : `${state.items.length} queued (${removableCount} with audio · ${alreadySilentCount} already silent)`}
                </span>
              </div>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={state.taskStatus === "running"}
                onClick={() =>
                  updateVideoMuteSession((prev) => ({
                    ...prev,
                    items: [],
                    lastReport: null,
                    errorMessage: null,
                  }))
                }
              >
                <Trash2 size={14} aria-hidden="true" />
                <span>{isZh ? "清空队列" : "Clear"}</span>
              </button>
            </div>

            <div className="media-queue-list" role="list">
              {state.items.map((item) => {
                const audioCount = item.probe?.audioStreams.length ?? 0;
                const langs =
                  item.probe?.audioStreams
                    .map((a) => a.language ?? `#${a.audioTrackIndex + 1}`)
                    .join(", ") ?? "";
                return (
                  <div key={item.path} className="media-queue-item" role="listitem">
                    <div
                      style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}
                    >
                      <strong
                        className="mono"
                        style={{ fontSize: "12.5px", overflow: "hidden", textOverflow: "ellipsis" }}
                      >
                        {item.fileName}
                      </strong>
                      {item.status === "ready" && item.probe && (
                        <span className="field-hint mono" style={{ margin: 0 }}>
                          {item.probe.containerFormat ?? "—"} ·{" "}
                          {formatDurationLabel(item.probe.durationSec, locale)} ·{" "}
                          {formatMediaBytes(item.probe.byteSize, locale)}
                          {audioCount > 0 && langs
                            ? ` · ${isZh ? "音轨" : "Tracks"}: ${langs}`
                            : ""}
                        </span>
                      )}
                      {item.status === "error" && (
                        <span style={{ color: "var(--status-err)", fontSize: "12px" }}>
                          {item.errorMessage}
                        </span>
                      )}
                    </div>

                    <div className="media-actions-row">
                      {item.status === "loading" && (
                        <span className="media-status-pill is-neutral">
                          {isZh ? "检测中…" : "Probing..."}
                        </span>
                      )}
                      {item.status === "ready" && audioCount > 0 && (
                        <span className="media-status-pill is-ok">
                          {isZh ? `将移除 ${audioCount} 条音轨` : `Removes ${audioCount} track(s)`}
                        </span>
                      )}
                      {item.status === "ready" && audioCount === 0 && (
                        <span className="media-status-pill is-warn">
                          {isZh ? "原本无音轨（无需处理）" : "Already silent"}
                        </span>
                      )}
                      {item.status === "error" && (
                        <span className="media-status-pill is-err">
                          {isZh ? "不可读取" : "Unreadable"}
                        </span>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        disabled={state.taskStatus === "running"}
                        aria-label={isZh ? `移除 ${item.fileName}` : `Remove ${item.fileName}`}
                        onClick={() =>
                          updateVideoMuteSession((prev) => ({
                            ...prev,
                            items: prev.items.filter((x) => x.path !== item.path),
                          }))
                        }
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="media-section-card">
            <h3 className="media-section-title">
              <span>{isZh ? "输出设置与执行" : "Output & Execution"}</span>
            </h3>
            <p className="field-hint" style={{ margin: 0 }}>
              {isZh
                ? "静音副本保存为新文件（自动附加 _muted 后缀并在重名时顺延编号），原始文件保持只读不改。"
                : "Muted copies are written as new files (_muted suffix, auto-numbered on collision). Original files are never modified."}
            </p>

            <div className="media-field-group">
              <span className="media-field-label">{isZh ? "输出目录" : "Output Folder"}</span>
              <div style={{ display: "flex", gap: "6px" }}>
                <input
                  type="text"
                  className="input mono"
                  value={state.outputDir}
                  onChange={(e) =>
                    updateVideoMuteSession((prev) => ({ ...prev, outputDir: e.target.value }))
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
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px" }}>
                  <span>
                    {isZh
                      ? `正在处理第 ${state.liveProgress.currentItem}/${state.liveProgress.totalItems} 项`
                      : `Processing ${state.liveProgress.currentItem}/${state.liveProgress.totalItems}`}
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
                  disabled={!mediaReady || !state.outputDir.trim() || state.items.length === 0}
                  onClick={() => void handleRunMute()}
                >
                  <VolumeX size={14} aria-hidden="true" />
                  <span>{isZh ? "生成静音副本" : "Generate Muted Copies"}</span>
                </button>
              ) : (
                <button type="button" className="btn" onClick={() => void cancelVideoMuteBatch()}>
                  <X size={14} aria-hidden="true" />
                  <span>{isZh ? "取消任务" : "Cancel"}</span>
                </button>
              )}
            </div>

            {state.lastReport && (
              <div
                className={`status-banner ${state.lastReport.failedCount > 0 ? "is-warn" : "is-ok"}`}
                style={{ flexDirection: "column", alignItems: "flex-start", gap: "8px" }}
                role="status"
              >
                <strong>
                  {state.lastReport.cancelled
                    ? isZh
                      ? "任务已取消"
                      : "Batch Cancelled"
                    : isZh
                      ? "静音批处理完成"
                      : "Mute Batch Complete"}
                </strong>
                <span style={{ fontSize: "12px" }}>
                  {isZh
                    ? `已静音 ${state.lastReport.mutedCount} · 原本无音轨 ${state.lastReport.alreadyMutedCount} · 跳过 ${state.lastReport.skippedCount} · 失败 ${state.lastReport.failedCount}（${state.lastReport.elapsedMs} ms）`
                    : `Muted ${state.lastReport.mutedCount} · Already silent ${state.lastReport.alreadyMutedCount} · Skipped ${state.lastReport.skippedCount} · Failed ${state.lastReport.failedCount} (${state.lastReport.elapsedMs} ms)`}
                </span>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                    width: "100%",
                    fontSize: "12px",
                  }}
                >
                  {state.lastReport.items.map((r) => (
                    <div
                      key={`${r.sourcePath}-${r.status}`}
                      style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}
                    >
                      <span
                        className="mono"
                        style={{ overflow: "hidden", textOverflow: "ellipsis" }}
                      >
                        {r.fileName}
                      </span>
                      <span>
                        {r.status === "muted"
                          ? isZh
                            ? `已移除 ${r.removedAudioTracks} 条音轨`
                            : `Removed ${r.removedAudioTracks} track(s)`
                          : r.status === "already_muted"
                            ? isZh
                              ? "原本无音轨"
                              : "Already silent"
                            : (r.message ?? r.status)}
                      </span>
                    </div>
                  ))}
                </div>
                {state.lastReport.mutedCount > 0 && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void openLocalDirectory(state.lastReport!.outputDir)}
                  >
                    <FolderOpen size={14} aria-hidden="true" />
                    <span>{isZh ? "打开输出目录" : "Open Output Folder"}</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
