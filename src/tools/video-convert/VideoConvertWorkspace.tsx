import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  FilePlus2,
  FolderOpen,
  Info,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { MediaToolsSetupPanel } from "../../components/MediaToolsSetupPanel";
import { useI18n } from "../../i18n/I18nContext";
import { useMediaSession } from "../../lib/mediaSessionStore";
import {
  bindDisposableListener,
  formatLocalizedError,
  inspectVideoConvertPlan,
  openLocalDirectory,
  pickMultipleFiles,
  pickSingleDirectory,
  registerMediaPreviewPath,
  subscribeFileDrop,
  type ConvertOverallMode,
  type MediaToolsStatus,
  type TrackConvertAction,
  type VideoConvertFormat,
} from "../../lib/tauriBridge";
import {
  VIDEO_EXTENSIONS,
  formatDurationLabel,
  formatMediaBytes,
  getFileName,
  getParentDir,
} from "../media-shared/mediaFormat";
import "../media-shared/mediaWorkspace.css";

const FORMAT_OPTIONS: {
  id: VideoConvertFormat;
  label: string;
  zhHint: string;
  enHint: string;
}[] = [
  { id: "mp4", label: "MP4", zhHint: "通用兼容（优先直拷）", enHint: "Universal (copy first)" },
  { id: "mov", label: "MOV", zhHint: "QuickTime / 剪辑封装", enHint: "QuickTime / editing" },
  { id: "webm", label: "WebM", zhHint: "网页 VP9 + Opus", enHint: "Web VP9 + Opus" },
  { id: "m4v", label: "M4V", zhHint: "Apple 兼容封装", enHint: "Apple-compatible MP4" },
  { id: "mkv", label: "MKV", zhHint: "全能无损保留多轨字幕", enHint: "Lossless multi-track" },
];

export function VideoConvertWorkspace() {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const {
    mediaSession,
    updateVideoConvertSession,
    startVideoConvertBatch,
    cancelVideoConvertBatch,
    handoffMediaFileToTool,
    pendingHandoff,
    consumePendingHandoff,
  } = useMediaSession();
  const state = mediaSession.videoConvert;

  const [toolsStatus, setToolsStatus] = useState<MediaToolsStatus | null>(null);
  const [hovering, setHovering] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const refreshPlans = useCallback(
    async (paths: string[], targetFormat: VideoConvertFormat) => {
      if (paths.length === 0) {
        updateVideoConvertSession((prev) => ({ ...prev, plans: [], inspecting: false }));
        return;
      }
      updateVideoConvertSession((prev) => ({
        ...prev,
        inspecting: true,
        errorMessage: null,
      }));
      try {
        const res = await inspectVideoConvertPlan({ sourcePaths: paths, targetFormat });
        updateVideoConvertSession((prev) => {
          if (prev.targetFormat !== targetFormat) return prev;
          return {
            ...prev,
            plans: res.items,
            inspecting: false,
            errorMessage: null,
          };
        });
      } catch (err) {
        const msg = formatLocalizedError(err, t);
        updateVideoConvertSession((prev) => ({
          ...prev,
          inspecting: false,
          errorMessage: msg,
        }));
      }
    },
    [t, updateVideoConvertSession],
  );

  const addVideoPaths = useCallback(
    async (paths: string[]) => {
      const unique = Array.from(new Set(paths.map((p) => p.trim()).filter(Boolean)));
      if (unique.length === 0) return;

      let nextPaths: string[] = [];
      let fmt: VideoConvertFormat = state.targetFormat;
      updateVideoConvertSession((prev) => {
        const merged = Array.from(new Set([...prev.sourcePaths, ...unique]));
        nextPaths = merged;
        fmt = prev.targetFormat;
        return {
          ...prev,
          sourcePaths: merged,
          selectedPath: prev.selectedPath ?? merged[0] ?? null,
          outputDir: prev.outputDir || (merged[0] ? getParentDir(merged[0]) : ""),
          lastReport: null,
          errorMessage: null,
        };
      });
      await refreshPlans(nextPaths, fmt);
    },
    [refreshPlans, state.targetFormat, updateVideoConvertSession],
  );

  useEffect(() => {
    if (pendingHandoff?.toolId === "V07") {
      const path = consumePendingHandoff("V07");
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
      "v07-file-drop",
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

  const handleSelectFormat = async (fmt: VideoConvertFormat) => {
    updateVideoConvertSession((prev) => ({
      ...prev,
      targetFormat: fmt,
      allowDropIncompatible: false,
      lastReport: null,
    }));
    if (state.sourcePaths.length > 0) {
      await refreshPlans(state.sourcePaths, fmt);
    }
  };

  const handlePickFiles = async () => {
    const picked = await pickMultipleFiles({
      title: isZh ? "选择要转换格式的视频文件" : "Select videos to convert",
      filters: [{ name: isZh ? "视频文件" : "Video Files", extensions: VIDEO_EXTENSIONS }],
    });
    if (picked.length > 0) await addVideoPaths(picked);
  };

  const handlePickOutputDir = async () => {
    const dir = await pickSingleDirectory({
      title: isZh ? "选择转换输出目录" : "Choose output directory",
    });
    if (dir) {
      updateVideoConvertSession((prev) => ({ ...prev, outputDir: dir }));
    }
  };

  const handleRemoveFile = async (path: string) => {
    const remaining = state.sourcePaths.filter((p) => p !== path);
    updateVideoConvertSession((prev) => ({
      ...prev,
      sourcePaths: remaining,
      selectedPath: prev.selectedPath === path ? (remaining[0] ?? null) : prev.selectedPath,
      plans: prev.plans.filter((item) => item.sourcePath !== path),
      lastReport: null,
    }));
  };

  const handleClearAll = () => {
    updateVideoConvertSession((prev) => ({
      ...prev,
      sourcePaths: [],
      selectedPath: null,
      plans: [],
      lastReport: null,
      errorMessage: null,
    }));
  };

  const totalDroppedTracks = state.plans.reduce(
    (sum, item) => sum + (item.plan?.dropTrackCount ?? 0),
    0,
  );
  const allLimitationMessages = state.plans.flatMap((item) =>
    (item.plan?.limitationMessages ?? []).map((msg) => `${item.fileName}: ${msg}`),
  );
  const needsDropConsent = totalDroppedTracks > 0 && !state.allowDropIncompatible;
  const mediaReady = toolsStatus?.ready ?? true;

  const handleStartConvert = async () => {
    if (state.sourcePaths.length === 0 || !state.outputDir.trim() || needsDropConsent) return;
    await startVideoConvertBatch(
      {
        sourcePaths: state.sourcePaths,
        outputDir: state.outputDir.trim(),
        targetFormat: state.targetFormat,
        allowDropIncompatible: state.allowDropIncompatible,
      },
      (err) => formatLocalizedError(err, t),
    );
  };

  const formatOverallModeLabel = (mode: ConvertOverallMode) => {
    if (mode === "remux_only") return isZh ? "无损重封装（零重编码）" : "Lossless Remux";
    if (mode === "mixed") return isZh ? "部分直拷 + 部分重编码" : "Mixed Copy + Transcode";
    return isZh ? "需要重新编码" : "Full Re-encode";
  };

  const formatActionLabel = (action: TrackConvertAction, targetCodec: string | null) => {
    if (action === "copy") return isZh ? "直拷 (copy)" : "Copy";
    if (action === "transcode") {
      return isZh ? `重编码 → ${targetCodec ?? ""}` : `Re-encode → ${targetCodec ?? ""}`;
    }
    return isZh ? "容器不支持 · 将忽略" : "Unsupported · Omit";
  };

  const selectedPlanItem =
    state.plans.find((p) => p.sourcePath === state.selectedPath) ?? state.plans[0] ?? null;

  return (
    <div className="media-workspace">
      <MediaToolsSetupPanel onStatusChange={setToolsStatus} />

      {state.sourcePaths.length === 0 ? (
        <div className={`media-dropzone ${hovering ? "is-hover" : ""}`}>
          <ArrowLeftRight size={28} strokeWidth={1.6} aria-hidden="true" />
          <div style={{ fontWeight: 600, fontSize: "15px" }}>
            {isZh
              ? "拖入单个或多个视频文件转换封装格式"
              : "Drop one or more videos to convert container format"}
          </div>
          <div style={{ fontSize: "13px", color: "var(--text-secondary)", maxWidth: "560px" }}>
            {isZh
              ? "支持 MP4、MOV、WebM（VP9 + Opus）、M4V 与 MKV。开始前逐轨分析直拷或重编码方案，遇多音轨或字幕容器限制先明确说明并由您决定。"
              : "Supports MP4, MOV, WebM (VP9 + Opus), M4V, and MKV. Inspects every video, audio, and subtitle stream before starting and verifies outputs with ffprobe."}
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
          {/* Left column: video preview + queue & per-track compatibility analysis */}
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
                  ? `待转换队列与逐轨兼容性（${state.sourcePaths.length} 个文件）`
                  : `Queue & Track Compatibility (${state.sourcePaths.length} files)`}
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
                  onClick={handleClearAll}
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

            {state.inspecting && (
              <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                {isZh
                  ? "正在用 ffprobe 逐轨分析目标容器兼容性..."
                  : "Inspecting stream compatibility with ffprobe..."}
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {state.sourcePaths.map((p) => {
                const entry = state.plans.find((item) => item.sourcePath === p);
                const plan = entry?.plan ?? null;
                const isSelected = (state.selectedPath ?? state.sourcePaths[0]) === p;

                return (
                  <div
                    key={p}
                    onClick={() =>
                      updateVideoConvertSession((prev) => ({ ...prev, selectedPath: p }))
                    }
                    style={{
                      border: `1px solid ${isSelected ? "var(--accent)" : "var(--border-subtle)"}`,
                      borderRadius: "8px",
                      padding: "10px 12px",
                      background: "var(--bg-subtle)",
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      gap: "8px",
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
                          {entry?.fileName ?? getFileName(p)}
                        </div>
                        {plan && (
                          <div
                            style={{
                              fontSize: "12px",
                              color: "var(--text-secondary)",
                              marginTop: "2px",
                            }}
                          >
                            {formatMediaBytes(plan.byteSize, locale)} ·{" "}
                            {formatDurationLabel(plan.durationSec, locale)} ·{" "}
                            {plan.sourceContainer ?? "?"} → {state.targetFormat.toUpperCase()}
                          </div>
                        )}
                      </div>
                      <div
                        style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}
                      >
                        {plan && (
                          <span
                            className={`media-status-pill ${
                              plan.dropTrackCount > 0
                                ? "is-warn"
                                : plan.overallMode === "remux_only"
                                  ? "is-ok"
                                  : "is-neutral"
                            }`}
                          >
                            {formatOverallModeLabel(plan.overallMode)}
                          </span>
                        )}
                        <button
                          type="button"
                          className="btn"
                          aria-label={isZh ? "移除文件" : "Remove file"}
                          disabled={state.taskStatus === "running"}
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleRemoveFile(p);
                          }}
                          style={{ padding: "4px 6px" }}
                        >
                          <X size={13} />
                        </button>
                      </div>
                    </div>

                    {entry && !entry.ok && entry.error && (
                      <div style={{ fontSize: "12px", color: "var(--status-err)" }}>
                        {entry.error}
                      </div>
                    )}

                    {plan && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                        {plan.tracks.map((tr) => (
                          <span
                            key={`${p}-${tr.streamIndex}`}
                            title={tr.reasonText}
                            className={`media-status-pill ${
                              tr.action === "copy"
                                ? "is-ok"
                                : tr.action === "transcode"
                                  ? "is-neutral"
                                  : "is-warn"
                            }`}
                          >
                            {tr.streamType.toUpperCase()} #{tr.streamIndex} ({tr.sourceCodec}
                            {tr.language ? `·${tr.language}` : ""}) :{" "}
                            {formatActionLabel(tr.action, tr.targetCodec)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {selectedPlanItem?.plan && (
              <div
                style={{
                  fontSize: "12px",
                  color: "var(--text-secondary)",
                  borderTop: "1px solid var(--border-subtle)",
                  paddingTop: "8px",
                }}
              >
                <div style={{ fontWeight: 600, color: "var(--text-primary)", marginBottom: "4px" }}>
                  {isZh
                    ? `当前选中轨道说明：${selectedPlanItem.fileName}`
                    : `Track details: ${selectedPlanItem.fileName}`}
                </div>
                {selectedPlanItem.plan.tracks.map((tr) => (
                  <div key={`detail-${tr.streamIndex}`} style={{ marginBottom: "2px" }}>
                    • #{tr.streamIndex} [{tr.streamType}/{tr.sourceCodec}]: {tr.reasonText}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Right column: Target format, container limitation decision, export & verified results */}
          <div className="media-stage-card">
            <div style={{ fontWeight: 600, fontSize: "14px" }}>
              {isZh ? "目标封装格式" : "Target Format"}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(112px, 1fr))",
                gap: "8px",
              }}
            >
              {FORMAT_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  disabled={state.taskStatus === "running"}
                  onClick={() => void handleSelectFormat(opt.id)}
                  style={{
                    textAlign: "left",
                    padding: "8px 10px",
                    borderRadius: "8px",
                    border: `1.5px solid ${state.targetFormat === opt.id ? "var(--accent)" : "var(--border-subtle)"}`,
                    background:
                      state.targetFormat === opt.id ? "var(--bg-subtle)" : "var(--bg-surface)",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: "13px", color: "var(--text-primary)" }}>
                    {opt.label}
                  </div>
                  <div
                    style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "2px" }}
                  >
                    {isZh ? opt.zhHint : opt.enHint}
                  </div>
                </button>
              ))}
            </div>

            {allLimitationMessages.length > 0 && (
              <div
                style={{
                  border: "1px solid var(--status-warn)",
                  borderRadius: "8px",
                  padding: "10px 12px",
                  background: "var(--status-warn-bg)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                  fontSize: "12px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    fontWeight: 600,
                    color: "var(--status-warn)",
                  }}
                >
                  <AlertTriangle size={15} />
                  {isZh ? "目标容器轨道限制提示" : "Container Track Limitations"}
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "3px",
                    color: "var(--text-primary)",
                  }}
                >
                  {allLimitationMessages.map((m, idx) => (
                    <div key={idx}>• {m}</div>
                  ))}
                </div>
                {totalDroppedTracks > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    <label
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: "6px",
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={state.allowDropIncompatible}
                        onChange={(e) =>
                          updateVideoConvertSession((prev) => ({
                            ...prev,
                            allowDropIncompatible: e.target.checked,
                          }))
                        }
                      />
                      <span>
                        {isZh
                          ? "我已了解上述限制，确认忽略目标容器不支持的轨道并继续转换"
                          : "I understand; omit unsupported tracks and proceed with conversion"}
                      </span>
                    </label>
                    {state.targetFormat !== "mkv" && (
                      <button
                        type="button"
                        className="btn"
                        style={{ alignSelf: "flex-start" }}
                        onClick={() => void handleSelectFormat("mkv")}
                      >
                        {isZh ? "改用 MKV 无损保留全部轨道" : "Switch to MKV to keep all tracks"}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ fontSize: "12px", fontWeight: 600 }}>
                {isZh ? "输出目录（绝不覆盖源文件）" : "Output Directory (never overwrites source)"}
              </label>
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  type="text"
                  className="text-input mono"
                  value={state.outputDir}
                  onChange={(e) =>
                    updateVideoConvertSession((prev) => ({ ...prev, outputDir: e.target.value }))
                  }
                  placeholder={isZh ? "选择保存文件夹..." : "Select output folder..."}
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
                      ? `正在转换 (${state.liveProgress?.currentItem ?? 1}/${state.liveProgress?.totalItems ?? state.sourcePaths.length})...`
                      : `Converting (${state.liveProgress?.currentItem ?? 1}/${state.liveProgress?.totalItems ?? state.sourcePaths.length})...`}
                  </span>
                  <span className="mono">{Math.round(state.liveProgress?.percent ?? 0)}%</span>
                </div>
                <div className="media-progress-bar">
                  <div
                    className="media-progress-fill"
                    style={{ width: `${Math.round(state.liveProgress?.percent ?? 0)}%` }}
                  />
                </div>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void cancelVideoConvertBatch()}
                >
                  {isZh ? "取消转换" : "Cancel"}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  !mediaReady ||
                  state.sourcePaths.length === 0 ||
                  !state.outputDir.trim() ||
                  state.inspecting ||
                  needsDropConsent
                }
                onClick={() => void handleStartConvert()}
              >
                <ArrowLeftRight size={15} />
                {isZh
                  ? `开始转换为 ${state.targetFormat.toUpperCase()}（${state.sourcePaths.length} 项）`
                  : `Convert to ${state.targetFormat.toUpperCase()} (${state.sourcePaths.length})`}
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
                  borderTop: "1px solid var(--border-subtle)",
                  paddingTop: "12px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
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
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      fontWeight: 600,
                      fontSize: "13px",
                    }}
                  >
                    <CheckCircle2 size={15} style={{ color: "var(--status-ok)" }} />
                    {isZh
                      ? `已完成：成功 ${state.lastReport.convertedCount} · 跳过 ${state.lastReport.skippedCount} · 失败 ${state.lastReport.failedCount}`
                      : `Done: ${state.lastReport.convertedCount} converted · ${state.lastReport.skippedCount} skipped · ${state.lastReport.failedCount} failed`}
                  </div>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void openLocalDirectory(state.lastReport!.outputDir)}
                  >
                    <FolderOpen size={14} />
                    {isZh ? "打开输出目录" : "Open Folder"}
                  </button>
                </div>

                {state.lastReport.items.map((item) => (
                  <div
                    key={`res-${item.sourcePath}`}
                    style={{
                      padding: "8px 10px",
                      borderRadius: "8px",
                      background: "var(--bg-subtle)",
                      fontSize: "12px",
                      display: "flex",
                      flexDirection: "column",
                      gap: "4px",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
                      <strong>
                        {item.outputPath ? getFileName(item.outputPath) : item.fileName}
                      </strong>
                      <span
                        className={`media-status-pill ${
                          item.status === "converted"
                            ? "is-ok"
                            : item.status === "skipped"
                              ? "is-warn"
                              : "is-err"
                        }`}
                      >
                        {item.status === "converted"
                          ? isZh
                            ? "ffprobe 已核验"
                            : "ffprobe verified"
                          : item.status === "skipped"
                            ? isZh
                              ? "已跳过"
                              : "Skipped"
                            : isZh
                              ? "失败"
                              : "Failed"}
                      </span>
                    </div>
                    {item.status === "converted" && (
                      <div style={{ color: "var(--text-secondary)" }}>
                        {item.outputBytes != null ? formatMediaBytes(item.outputBytes, locale) : ""}{" "}
                        · {isZh ? "容器" : "Container"}: {item.verifiedContainer ?? "?"} ·{" "}
                        {isZh ? "视频" : "Video"}: {item.verifiedVideoCodecs.join(", ") || "—"} ·{" "}
                        {isZh ? "音频" : "Audio"}: {item.verifiedAudioCodecs.join(", ") || "—"}
                        {item.verifiedSubtitleCodecs.length > 0
                          ? ` · ${isZh ? "字幕" : "Sub"}: ${item.verifiedSubtitleCodecs.join(", ")}`
                          : ""}
                      </div>
                    )}
                    {item.message && (
                      <div style={{ color: "var(--status-err)" }}>{item.message}</div>
                    )}
                    {item.outputPath && (
                      <div style={{ display: "flex", gap: "6px", marginTop: "2px" }}>
                        <button
                          type="button"
                          className="btn"
                          style={{ padding: "3px 8px", fontSize: "11px" }}
                          onClick={() => handoffMediaFileToTool("V10", item.outputPath!)}
                        >
                          <Info size={12} />
                          {isZh ? "在媒体信息 (V10) 查看" : "Inspect in V10"}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
