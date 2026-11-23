import { FileAudio, FilePlus2, FolderOpen, Headphones, Trash2, X } from "lucide-react";
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
  previewAudioTrack,
  probeMediaInfo,
  subscribeFileDrop,
  type AudioExtractFormat,
  type MediaToolsStatus,
} from "../../lib/tauriBridge";
import {
  ALL_MEDIA_EXTENSIONS,
  formatAudioTrackSummary,
  formatDurationLabel,
  formatLanguageName,
  formatMediaBytes,
  getFileName,
  getParentDir,
} from "../media-shared/mediaFormat";
import { planAudioExtractionUi } from "./audioExtractPlan";
import "../media-shared/mediaWorkspace.css";

export function AudioExtractWorkspace() {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const {
    mediaSession,
    updateAudioExtractSession,
    startAudioExtractBatch,
    cancelAudioExtractBatch,
    pendingHandoff,
    consumePendingHandoff,
  } = useMediaSession();
  const state = mediaSession.audioExtract;

  const [toolsStatus, setToolsStatus] = useState<MediaToolsStatus | null>(null);
  const [hovering, setHovering] = useState(false);
  const [auditionState, setAuditionState] = useState<{
    path: string;
    trackIndex: number;
    url: string;
  } | null>(null);
  const [auditionLoading, setAuditionLoading] = useState(false);
  const [auditionError, setAuditionError] = useState<string | null>(null);

  const addMediaPaths = useCallback(
    async (paths: string[]) => {
      const unique = Array.from(new Set(paths.map((p) => p.trim()).filter(Boolean)));
      if (unique.length === 0) return;

      setAuditionState(null);
      setAuditionError(null);

      updateAudioExtractSession((prev) => {
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
          selectedPath: unique[0] ?? prev.selectedPath ?? items[0]?.path ?? null,
          outputDir: prev.outputDir || (unique[0] ? getParentDir(unique[0]) : ""),
          lastReport: null,
          errorMessage: null,
        };
      });

      for (const p of unique) {
        try {
          const probe = await probeMediaInfo(p);
          updateAudioExtractSession((prev) => ({
            ...prev,
            items: prev.items.map((item) =>
              item.path === p
                ? {
                    ...item,
                    fileName: probe.fileName,
                    status: "ready",
                    probe,
                    errorMessage: null,
                    selectedAudioTrackIndex: 0,
                  }
                : item,
            ),
          }));
        } catch (err) {
          const msg = formatLocalizedError(err, t);
          updateAudioExtractSession((prev) => ({
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
    [t, updateAudioExtractSession],
  );

  useEffect(() => {
    if (pendingHandoff?.toolId === "A04") {
      const path = consumePendingHandoff("A04");
      if (path) void addMediaPaths([path]);
    }
  }, [pendingHandoff, consumePendingHandoff, addMediaPaths]);

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: setHovering,
          onDropPaths: (paths) => void addMediaPaths(paths),
        }),
      "a04-file-drop",
    );
  }, [addMediaPaths]);

  const handlePickFiles = async () => {
    const picked = await pickMultipleFiles({
      title: isZh ? "选择要提取音轨的视频文件" : "Select videos to extract audio from",
      filters: [{ name: isZh ? "音视频文件" : "Media Files", extensions: ALL_MEDIA_EXTENSIONS }],
    });
    if (picked.length > 0) await addMediaPaths(picked);
  };

  const handlePickOutputDir = async () => {
    const dir = await pickSingleDirectory({
      title: isZh ? "选择音频输出目录" : "Choose audio output directory",
    });
    if (dir) {
      updateAudioExtractSession((prev) => ({ ...prev, outputDir: dir }));
    }
  };

  const selectedItem =
    state.items.find((i) => i.path === state.selectedPath) ?? state.items[0] ?? null;
  const selectedTracks = selectedItem?.probe?.audioStreams ?? [];
  const activeTrack =
    selectedTracks[selectedItem?.selectedAudioTrackIndex ?? 0] ?? selectedTracks[0] ?? null;

  const activePlan = activeTrack
    ? planAudioExtractionUi(
        activeTrack.codecName,
        state.format,
        state.preferStreamCopy,
        state.bitrateKbps,
        locale,
      )
    : null;

  const handleAuditionTrack = async (path: string, trackIndex: number) => {
    setAuditionLoading(true);
    setAuditionError(null);
    try {
      const res = await previewAudioTrack(path, trackIndex);
      setAuditionState({ path, trackIndex, url: res.previewUrl });
    } catch (err) {
      setAuditionError(formatLocalizedError(err, t));
    } finally {
      setAuditionLoading(false);
    }
  };

  const handleExport = async () => {
    if (state.items.length === 0 || !state.outputDir.trim()) return;
    await startAudioExtractBatch(
      {
        items: state.items.map((i) => ({
          sourcePath: i.path,
          audioTrackIndex: i.selectedAudioTrackIndex,
        })),
        outputDir: state.outputDir.trim(),
        format: state.format,
        preferStreamCopy: state.preferStreamCopy,
        bitrateKbps: state.bitrateKbps,
      },
      (err) => formatLocalizedError(err, t),
    );
  };

  const mediaReady = toolsStatus?.ready ?? true;
  const extractableCount = state.items.filter(
    (i) => i.status === "ready" && i.probe && i.probe.audioStreams.length > 0,
  ).length;
  const isLossyTarget = state.format === "m4a" || state.format === "mp3";

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
              ? "拖入视频文件，选择音轨并提取为 M4A / MP3 / WAV / FLAC"
              : "Drop videos to pick an audio track and extract to M4A, MP3, WAV, or FLAC"}
          </p>
          <p className="field-hint" style={{ margin: 0 }}>
            {isZh
              ? "多语言视频可逐轨识别语言并直接试听确认；源编码与目标格式兼容时支持原样无损提取，指定其他格式或码率时明确提示转码；无音轨视频绝不生成空文件。"
              : "Identify and audition individual language tracks before export. Copies stream losslessly when compatible, clearly flags transcoding otherwise, and never writes empty files for silent videos."}
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
                  <span>{isZh ? "添加文件" : "Add Files"}</span>
                </button>
                <span className="field-hint" style={{ margin: 0 }}>
                  {isZh
                    ? `共 ${state.items.length} 项（可提取 ${extractableCount} 项）`
                    : `${state.items.length} file(s) (${extractableCount} with audio)`}
                </span>
              </div>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={state.taskStatus === "running"}
                onClick={() => {
                  setAuditionState(null);
                  updateAudioExtractSession((prev) => ({
                    ...prev,
                    items: [],
                    selectedPath: null,
                    lastReport: null,
                    errorMessage: null,
                  }));
                }}
              >
                <Trash2 size={14} aria-hidden="true" />
                <span>{isZh ? "清空" : "Clear"}</span>
              </button>
            </div>

            {/* File queue */}
            <div className="media-queue-list" role="list">
              {state.items.map((item) => {
                const tracks = item.probe?.audioStreams ?? [];
                const active = item.path === selectedItem?.path;
                return (
                  <div
                    key={item.path}
                    className={`media-queue-item ${active ? "is-selected" : ""}`}
                    role="listitem"
                  >
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{
                        flex: 1,
                        justifyContent: "flex-start",
                        textAlign: "left",
                        minWidth: 0,
                      }}
                      onClick={() =>
                        updateAudioExtractSession((prev) => ({
                          ...prev,
                          selectedPath: item.path,
                        }))
                      }
                    >
                      <span
                        className="mono"
                        style={{ overflow: "hidden", textOverflow: "ellipsis" }}
                      >
                        {item.fileName}
                      </span>
                    </button>

                    <div className="media-actions-row">
                      {item.status === "loading" && (
                        <span className="media-status-pill is-neutral">
                          {isZh ? "解析中…" : "Probing..."}
                        </span>
                      )}
                      {item.status === "ready" && tracks.length > 0 && (
                        <span className="media-status-pill is-ok">
                          {isZh
                            ? `音轨 ${item.selectedAudioTrackIndex + 1}/${tracks.length}`
                            : `Track ${item.selectedAudioTrackIndex + 1}/${tracks.length}`}
                        </span>
                      )}
                      {item.status === "ready" && tracks.length === 0 && (
                        <span className="media-status-pill is-warn">
                          {isZh ? "无音轨（不生成空文件）" : "No audio"}
                        </span>
                      )}
                      {item.status === "error" && (
                        <span className="media-status-pill is-err">
                          {isZh ? "读取失败" : "Error"}
                        </span>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        disabled={state.taskStatus === "running"}
                        aria-label={isZh ? `移除 ${item.fileName}` : `Remove ${item.fileName}`}
                        onClick={() =>
                          updateAudioExtractSession((prev) => ({
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

            {/* Track selector & audition for selected file */}
            {selectedItem && (
              <div
                style={{
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "8px",
                  padding: "12px",
                  background: "var(--bg-subtle)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "10px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "8px",
                    flexWrap: "wrap",
                  }}
                >
                  <strong style={{ fontSize: "13px" }}>
                    {isZh
                      ? `音轨选择与试听：${selectedItem.fileName}`
                      : `Track Selection: ${selectedItem.fileName}`}
                  </strong>
                  {selectedItem.probe && (
                    <span className="field-hint mono" style={{ margin: 0 }}>
                      {formatDurationLabel(selectedItem.probe.durationSec, locale)} ·{" "}
                      {formatMediaBytes(selectedItem.probe.byteSize, locale)}
                    </span>
                  )}
                </div>

                {selectedItem.status === "error" && (
                  <div className="status-banner is-err" role="alert">
                    <span>{selectedItem.errorMessage}</span>
                  </div>
                )}

                {selectedItem.status === "ready" && selectedTracks.length === 0 && (
                  <div className="status-banner is-warn" role="status">
                    <span>
                      {isZh
                        ? "该视频不包含任何音轨。执行提取时会自动跳过此项，绝不会写出 0 字节空文件。"
                        : "This video contains no audio tracks. It will be skipped cleanly without creating any empty file."}
                    </span>
                  </div>
                )}

                {selectedItem.status === "ready" && selectedTracks.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {selectedTracks.map((tr) => {
                      const isPicked = selectedItem.selectedAudioTrackIndex === tr.audioTrackIndex;
                      return (
                        <div
                          key={tr.index}
                          className={`media-queue-item ${isPicked ? "is-selected" : ""}`}
                        >
                          <label
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                              cursor: "pointer",
                              flex: 1,
                            }}
                          >
                            <input
                              type="radio"
                              name={`audio-track-${selectedItem.path}`}
                              checked={isPicked}
                              onChange={() =>
                                updateAudioExtractSession((prev) => ({
                                  ...prev,
                                  items: prev.items.map((x) =>
                                    x.path === selectedItem.path
                                      ? { ...x, selectedAudioTrackIndex: tr.audioTrackIndex }
                                      : x,
                                  ),
                                }))
                              }
                            />
                            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                              <span style={{ fontWeight: 600 }}>
                                {formatAudioTrackSummary(tr, locale)}
                              </span>
                              <span className="field-hint mono" style={{ margin: 0 }}>
                                {formatLanguageName(tr.language, locale)}
                                {tr.title ? ` · ${tr.title}` : ""}
                                {tr.channelLayout ? ` · ${tr.channelLayout}` : ""}
                              </span>
                            </div>
                          </label>
                          <button
                            type="button"
                            className="btn btn-ghost"
                            disabled={auditionLoading || !mediaReady}
                            onClick={() =>
                              void handleAuditionTrack(selectedItem.path, tr.audioTrackIndex)
                            }
                          >
                            <Headphones size={14} aria-hidden="true" />
                            <span>{isZh ? "试听此轨" : "Audition"}</span>
                          </button>
                        </div>
                      );
                    })}

                    {auditionError && (
                      <div className="status-banner is-err" role="alert">
                        <span>{auditionError}</span>
                      </div>
                    )}

                    {auditionState && auditionState.path === selectedItem.path && (
                      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                        <span className="field-hint" style={{ margin: 0 }}>
                          {isZh
                            ? `正在试听音轨 #${auditionState.trackIndex + 1}（前 30 秒片段）`
                            : `Auditioning Track #${auditionState.trackIndex + 1} (up to 30s sample)`}
                        </span>
                        <audio controls src={auditionState.url} style={{ width: "100%" }} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right settings & export panel */}
          <div className="media-section-card">
            <h3 className="media-section-title">
              <span>{isZh ? "导出格式与编码行为" : "Format & Encoding"}</span>
            </h3>

            <div className="media-field-group">
              <span className="media-field-label">{isZh ? "目标音频格式" : "Target Format"}</span>
              <div
                className="segmented"
                role="group"
                aria-label={isZh ? "目标音频格式" : "Target Format"}
              >
                {(["m4a", "mp3", "wav", "flac"] as AudioExtractFormat[]).map((fmt) => (
                  <button
                    key={fmt}
                    type="button"
                    className={`segmented-btn ${state.format === fmt ? "is-selected" : ""}`}
                    aria-pressed={state.format === fmt}
                    onClick={() =>
                      updateAudioExtractSession((prev) => ({
                        ...prev,
                        format: fmt,
                        bitrateKbps: fmt === "wav" || fmt === "flac" ? null : prev.bitrateKbps,
                      }))
                    }
                  >
                    {fmt.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                fontSize: "12.5px",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={state.preferStreamCopy}
                onChange={(e) =>
                  updateAudioExtractSession((prev) => ({
                    ...prev,
                    preferStreamCopy: e.target.checked,
                    bitrateKbps: e.target.checked ? null : (prev.bitrateKbps ?? 192),
                  }))
                }
              />
              <span>
                {isZh
                  ? "源编码与容器兼容时原样无损提取（流复制）"
                  : "Copy stream losslessly when source codec is compatible"}
              </span>
            </label>

            {isLossyTarget && (
              <div className="media-field-group">
                <span className="media-field-label">{isZh ? "码率设置" : "Bitrate"}</span>
                <div
                  className="segmented"
                  role="group"
                  aria-label={isZh ? "音频码率" : "Audio Bitrate"}
                >
                  {[
                    { val: null, label: isZh ? "自动" : "Auto" },
                    { val: 128, label: "128k" },
                    { val: 192, label: "192k" },
                    { val: 256, label: "256k" },
                    { val: 320, label: "320k" },
                  ].map((opt) => (
                    <button
                      key={String(opt.val)}
                      type="button"
                      className={`segmented-btn ${state.bitrateKbps === opt.val ? "is-selected" : ""}`}
                      aria-pressed={state.bitrateKbps === opt.val}
                      onClick={() =>
                        updateAudioExtractSession((prev) => ({
                          ...prev,
                          bitrateKbps: opt.val,
                        }))
                      }
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {activePlan && (
              <div
                className={`status-banner ${activePlan.willStreamCopy ? "is-ok" : "is-warn"}`}
                style={{ flexDirection: "column", alignItems: "flex-start", gap: "3px" }}
                role="status"
              >
                <strong>{activePlan.label}</strong>
                <span style={{ fontSize: "12px" }}>{activePlan.detail}</span>
              </div>
            )}

            <div className="media-field-group">
              <span className="media-field-label">{isZh ? "输出目录" : "Output Folder"}</span>
              <div style={{ display: "flex", gap: "6px" }}>
                <input
                  type="text"
                  className="input mono"
                  value={state.outputDir}
                  onChange={(e) =>
                    updateAudioExtractSession((prev) => ({ ...prev, outputDir: e.target.value }))
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
                      ? `正在提取第 ${state.liveProgress.currentItem}/${state.liveProgress.totalItems} 项`
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
                  disabled={!mediaReady || !state.outputDir.trim() || extractableCount === 0}
                  onClick={() => void handleExport()}
                >
                  <FileAudio size={14} aria-hidden="true" />
                  <span>{isZh ? "开始提取音频" : "Extract Audio"}</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="btn"
                  onClick={() => void cancelAudioExtractBatch()}
                >
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
                      ? "提取已取消"
                      : "Extraction Cancelled"
                    : isZh
                      ? "音频提取完成"
                      : "Audio Extraction Complete"}
                </strong>
                <span style={{ fontSize: "12px" }}>
                  {isZh
                    ? `成功 ${state.lastReport.extractedCount} · 无音轨跳过 ${state.lastReport.noAudioCount} · 取消跳过 ${state.lastReport.skippedCount} · 失败 ${state.lastReport.failedCount}`
                    : `Extracted ${state.lastReport.extractedCount} · No audio ${state.lastReport.noAudioCount} · Skipped ${state.lastReport.skippedCount} · Failed ${state.lastReport.failedCount}`}
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
                      key={`${r.sourcePath}-${r.audioTrackIndex}`}
                      style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}
                    >
                      <span
                        className="mono"
                        style={{ overflow: "hidden", textOverflow: "ellipsis" }}
                      >
                        {r.fileName} (#{r.audioTrackIndex + 1})
                      </span>
                      <span>
                        {r.status === "extracted"
                          ? r.usedStreamCopy
                            ? isZh
                              ? "原样提取"
                              : "Stream copy"
                            : isZh
                              ? `已转码 (${r.outputCodec ?? state.format})`
                              : `Transcoded (${r.outputCodec ?? state.format})`
                          : r.status === "no_audio"
                            ? isZh
                              ? "无音轨（未生成文件）"
                              : "No audio (no file)"
                            : (r.message ?? r.status)}
                      </span>
                    </div>
                  ))}
                </div>
                {state.lastReport.extractedCount > 0 && (
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
