import { CheckCircle2, Cpu, FilePlus2, FolderOpen, Info, Minimize2, Trash2, X } from "lucide-react";
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
  probeVideoEncoders,
  registerMediaPreviewPath,
  subscribeFileDrop,
  type CompressQualityPreset,
  type CompressResolutionCap,
  type CompressVideoCodec,
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

function computePredictedOutputSize(
  displayW: number | null,
  displayH: number | null,
  cap: CompressResolutionCap,
): string {
  if (!displayW || !displayH) return "—";
  const makeEven = (v: number) => Math.max(2, Math.floor(Math.round(v) / 2) * 2);
  if (cap === "original") return `${makeEven(displayW)} × ${makeEven(displayH)}`;
  const [maxLong, maxShort] =
    cap === "p1080" ? [1920, 1080] : cap === "p720" ? [1280, 720] : [854, 480];
  const [boundW, boundH] = displayW >= displayH ? [maxLong, maxShort] : [maxShort, maxLong];
  if (displayW <= boundW && displayH <= boundH) {
    return `${makeEven(displayW)} × ${makeEven(displayH)}`;
  }
  const scale = Math.min(boundW / displayW, boundH / displayH);
  return `${makeEven(displayW * scale)} × ${makeEven(displayH * scale)}`;
}

export function VideoCompressWorkspace() {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const {
    mediaSession,
    updateVideoCompressSession,
    startVideoCompressBatch,
    cancelVideoCompressBatch,
    handoffMediaFileToTool,
    pendingHandoff,
    consumePendingHandoff,
  } = useMediaSession();
  const state = mediaSession.videoCompress;

  const [toolsStatus, setToolsStatus] = useState<MediaToolsStatus | null>(null);
  const [hovering, setHovering] = useState(false);
  const [probingEncoders, setProbingEncoders] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!toolsStatus?.ready || state.encoderCaps) return;
    let active = true;
    setProbingEncoders(true);
    void probeVideoEncoders()
      .then((caps) => {
        if (!active) return;
        updateVideoCompressSession((prev) => ({ ...prev, encoderCaps: caps }));
      })
      .catch(() => {
        // Fallback silently to software option if probe fails
      })
      .finally(() => {
        if (active) setProbingEncoders(false);
      });
    return () => {
      active = false;
    };
  }, [toolsStatus?.ready, state.encoderCaps, updateVideoCompressSession]);

  const addVideoPaths = useCallback(
    async (paths: string[]) => {
      const unique = Array.from(new Set(paths.map((p) => p.trim()).filter(Boolean)));
      if (unique.length === 0) return;

      updateVideoCompressSession((prev) => {
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
          updateVideoCompressSession((prev) => ({
            ...prev,
            items: prev.items.map((item) =>
              item.path === p
                ? { ...item, fileName: probe.fileName, status: "ready", probe, errorMessage: null }
                : item,
            ),
          }));
        } catch (err) {
          const msg = formatLocalizedError(err, t);
          updateVideoCompressSession((prev) => ({
            ...prev,
            items: prev.items.map((item) =>
              item.path === p ? { ...item, status: "error", probe: null, errorMessage: msg } : item,
            ),
          }));
        }
      }
    },
    [t, updateVideoCompressSession],
  );

  useEffect(() => {
    if (pendingHandoff?.toolId === "V06") {
      const path = consumePendingHandoff("V06");
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
      "v06-file-drop",
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
      title: isZh ? "选择要压缩的视频文件" : "Select videos to compress",
      filters: [{ name: isZh ? "视频文件" : "Video Files", extensions: VIDEO_EXTENSIONS }],
    });
    if (picked.length > 0) await addVideoPaths(picked);
  };

  const handlePickOutputDir = async () => {
    const dir = await pickSingleDirectory({
      title: isZh ? "选择压缩输出目录" : "Choose output directory",
    });
    if (dir) {
      updateVideoCompressSession((prev) => ({ ...prev, outputDir: dir }));
    }
  };

  const handleRemoveItem = (path: string) => {
    updateVideoCompressSession((prev) => {
      const next = prev.items.filter((i) => i.path !== path);
      return {
        ...prev,
        items: next,
        selectedPath: prev.selectedPath === path ? (next[0]?.path ?? null) : prev.selectedPath,
        lastReport: null,
      };
    });
  };

  const handleClear = () => {
    updateVideoCompressSession((prev) => ({
      ...prev,
      items: [],
      selectedPath: null,
      lastReport: null,
      errorMessage: null,
    }));
  };

  const availableEncoders =
    state.codec === "h264"
      ? (state.encoderCaps?.h264Encoders ?? [
          {
            id: "libx264",
            codec: "h264" as const,
            isHardware: false,
            label: "Software (libx264 · CPU)",
          },
        ])
      : (state.encoderCaps?.hevcEncoders ?? [
          {
            id: "libx265",
            codec: "hevc" as const,
            isHardware: false,
            label: "Software (libx265 · CPU)",
          },
        ]);

  const effectiveEncoderPref =
    state.encoderPreference === "software" ||
    state.encoderPreference === "auto_hardware" ||
    availableEncoders.some((e) => e.id === state.encoderPreference)
      ? state.encoderPreference
      : "software";

  const handleStartCompress = async () => {
    if (state.items.length === 0 || !state.outputDir.trim()) return;
    await startVideoCompressBatch(
      {
        sourcePaths: state.items.map((i) => i.path),
        outputDir: state.outputDir.trim(),
        preset: state.preset,
        codec: state.codec,
        resolutionCap: state.resolutionCap,
        encoderPreference: effectiveEncoderPref,
        keepAudio: state.keepAudio,
        keepOriginalIfLarger: state.keepOriginalIfLarger,
      },
      (err) => formatLocalizedError(err, t),
    );
  };

  const mediaReady = toolsStatus?.ready ?? true;
  const presets: {
    id: CompressQualityPreset;
    zh: string;
    en: string;
    descZh: string;
    descEn: string;
  }[] = [
    { id: "high", zh: "高质量", en: "High", descZh: "画质优先", descEn: "Best quality" },
    { id: "balanced", zh: "均衡", en: "Balanced", descZh: "推荐默认", descEn: "Recommended" },
    { id: "small", zh: "小体积", en: "Small", descZh: "便于分享", descEn: "Smallest file" },
  ];
  const resCaps: { id: CompressResolutionCap; label: string }[] = [
    { id: "original", label: isZh ? "原尺寸" : "Original" },
    { id: "p1080", label: "1080p" },
    { id: "p720", label: "720p" },
    { id: "p480", label: "480p" },
  ];

  return (
    <div className="media-workspace">
      <MediaToolsSetupPanel onStatusChange={setToolsStatus} />

      {state.items.length === 0 ? (
        <div className={`media-dropzone ${hovering ? "is-hover" : ""}`}>
          <Minimize2 size={28} strokeWidth={1.6} aria-hidden="true" />
          <div style={{ fontWeight: 600, fontSize: "15px" }}>
            {isZh ? "拖入单个或多个视频进行本地压缩" : "Drop videos here to compress locally"}
          </div>
          <div style={{ fontSize: "13px", color: "var(--text-secondary)", maxWidth: "560px" }}>
            {isZh
              ? "提供高质量 / 均衡 / 小体积三档与 H.264 / HEVC 编码，默认保留音频、保持比例且绝不放大小视频；压后若未缩小默认保留原件并记录实际编码器。"
              : "High / Balanced / Small presets with H.264 or HEVC, orientation-aware resolution caps (never upscaling), real-trial hardware encoder detection, and keep-original protection."}
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
          {/* Left column: preview + queue + prominent savings summary */}
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
                  ? `待压缩视频（${state.items.length}）`
                  : `Videos to Compress (${state.items.length})`}
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
                  onClick={handleClear}
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

            {state.lastReport && (
              <div
                style={{
                  border: "1px solid var(--status-ok)",
                  borderRadius: "8px",
                  padding: "10px 12px",
                  background: "var(--status-ok-bg)",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "12px",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      fontWeight: 600,
                      fontSize: "13px",
                      color: "var(--status-ok)",
                    }}
                  >
                    <CheckCircle2 size={15} />
                    {isZh
                      ? `总计节省 ${formatMediaBytes(Math.max(0, state.lastReport.totalSavedBytes), locale)}（${state.lastReport.totalSavedPercent.toFixed(1)}%）`
                      : `Total saved ${formatMediaBytes(Math.max(0, state.lastReport.totalSavedBytes), locale)} (${state.lastReport.totalSavedPercent.toFixed(1)}%)`}
                  </div>
                  <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                    {formatMediaBytes(state.lastReport.totalOriginalBytes, locale)} →{" "}
                    {formatMediaBytes(state.lastReport.totalOutputBytes, locale)} ·{" "}
                    {isZh
                      ? `压缩 ${state.lastReport.compressedCount} · 保留原件 ${state.lastReport.keptOriginalCount} · 失败 ${state.lastReport.failedCount}`
                      : `Compressed ${state.lastReport.compressedCount} · Kept original ${state.lastReport.keptOriginalCount} · Failed ${state.lastReport.failedCount}`}
                  </div>
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
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {state.items.map((item) => {
                const v0 = item.probe?.videoStreams[0];
                const isSelected = (state.selectedPath ?? state.items[0]?.path) === item.path;
                const resultItem = state.lastReport?.items.find((r) => r.sourcePath === item.path);
                const predictedDim = computePredictedOutputSize(
                  v0?.displayWidth ?? null,
                  v0?.displayHeight ?? null,
                  state.resolutionCap,
                );

                return (
                  <div
                    key={item.path}
                    onClick={() =>
                      updateVideoCompressSession((prev) => ({ ...prev, selectedPath: item.path }))
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
                            {formatMediaBytes(item.probe.byteSize, locale)} ·{" "}
                            {formatDurationLabel(item.probe.durationSec, locale)} ·{" "}
                            {v0?.displayWidth ?? "?"}×{v0?.displayHeight ?? "?"} → {predictedDim}
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
                          handleRemoveItem(item.path);
                        }}
                        style={{ padding: "4px 6px" }}
                      >
                        <X size={13} />
                      </button>
                    </div>

                    {item.errorMessage && (
                      <div style={{ fontSize: "12px", color: "var(--status-err)" }}>
                        {item.errorMessage}
                      </div>
                    )}

                    {resultItem && (
                      <div
                        style={{
                          borderTop: "1px solid var(--border-subtle)",
                          paddingTop: "6px",
                          display: "flex",
                          flexDirection: "column",
                          gap: "4px",
                          fontSize: "12px",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            flexWrap: "wrap",
                          }}
                        >
                          {resultItem.status === "compressed" && (
                            <span className="media-status-pill is-ok">
                              {isZh
                                ? `已压缩 -${resultItem.savedPercent.toFixed(1)}%`
                                : `Compressed -${resultItem.savedPercent.toFixed(1)}%`}
                            </span>
                          )}
                          {resultItem.status === "kept_original" && (
                            <span className="media-status-pill is-warn">
                              {isZh ? "已保留原件" : "Kept Original"}
                            </span>
                          )}
                          {resultItem.status === "failed" && (
                            <span className="media-status-pill is-err">
                              {isZh ? "失败" : "Failed"}
                            </span>
                          )}
                          {resultItem.outputBytes != null && (
                            <span className="mono">
                              {formatMediaBytes(resultItem.originalBytes, locale)} →{" "}
                              {formatMediaBytes(resultItem.outputBytes, locale)}
                            </span>
                          )}
                          {resultItem.actualEncoderUsed && (
                            <span className="media-status-pill is-neutral">
                              <Cpu size={11} />
                              {resultItem.actualEncoderUsed}
                            </span>
                          )}
                        </div>
                        {resultItem.keptOriginalReason && (
                          <div style={{ color: "var(--text-secondary)" }}>
                            {resultItem.keptOriginalReason}
                          </div>
                        )}
                        {resultItem.message && (
                          <div style={{ color: "var(--status-err)" }}>{resultItem.message}</div>
                        )}
                        {resultItem.outputPath && (
                          <div>
                            <button
                              type="button"
                              className="btn"
                              style={{ padding: "3px 8px", fontSize: "11px" }}
                              onClick={(e) => {
                                e.stopPropagation();
                                handoffMediaFileToTool("V10", resultItem.outputPath!);
                              }}
                            >
                              <Info size={12} />
                              {isZh ? "在媒体信息 (V10) 查看" : "Inspect in V10"}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right column: Compression controls */}
          <div className="media-stage-card">
            <div style={{ fontWeight: 600, fontSize: "14px" }}>
              {isZh ? "压缩参数" : "Compression Settings"}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ fontSize: "12px", fontWeight: 600 }}>
                {isZh ? "压缩档位" : "Quality Preset"}
              </label>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                  gap: "6px",
                }}
              >
                {presets.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    disabled={state.taskStatus === "running"}
                    onClick={() =>
                      updateVideoCompressSession((prev) => ({ ...prev, preset: p.id }))
                    }
                    style={{
                      padding: "8px 6px",
                      borderRadius: "8px",
                      border: `1.5px solid ${state.preset === p.id ? "var(--accent)" : "var(--border-subtle)"}`,
                      background: state.preset === p.id ? "var(--bg-subtle)" : "var(--bg-surface)",
                      cursor: "pointer",
                      textAlign: "center",
                    }}
                  >
                    <div
                      style={{ fontWeight: 600, fontSize: "13px", color: "var(--text-primary)" }}
                    >
                      {isZh ? p.zh : p.en}
                    </div>
                    <div style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                      {isZh ? p.descZh : p.descEn}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ fontSize: "12px", fontWeight: 600 }}>
                {isZh ? "视频编码" : "Video Codec"}
              </label>
              <div className="segmented-control">
                {(["h264", "hevc"] as CompressVideoCodec[]).map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`segmented-btn ${state.codec === c ? "is-active" : ""}`}
                    disabled={state.taskStatus === "running"}
                    onClick={() =>
                      updateVideoCompressSession((prev) => ({
                        ...prev,
                        codec: c,
                        encoderPreference:
                          prev.encoderPreference === "auto_hardware" ? "auto_hardware" : "software",
                      }))
                    }
                  >
                    {c === "h264" ? "H.264 (AVC)" : "HEVC (H.265)"}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ fontSize: "12px", fontWeight: 600 }}>
                {isZh ? "分辨率上限（小视频默认不放大）" : "Max Resolution (never upscales)"}
              </label>
              <div className="segmented-control">
                {resCaps.map((cap) => (
                  <button
                    key={cap.id}
                    type="button"
                    className={`segmented-btn ${state.resolutionCap === cap.id ? "is-active" : ""}`}
                    disabled={state.taskStatus === "running"}
                    onClick={() =>
                      updateVideoCompressSession((prev) => ({ ...prev, resolutionCap: cap.id }))
                    }
                  >
                    {cap.label}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label htmlFor="v06-encoder-select" style={{ fontSize: "12px", fontWeight: 600 }}>
                {isZh
                  ? "编码器（仅启用经本机试编码验证的硬件项）"
                  : "Encoder (verified via trial encode)"}
              </label>
              <select
                id="v06-encoder-select"
                className="text-input"
                value={effectiveEncoderPref}
                disabled={state.taskStatus === "running" || probingEncoders}
                onChange={(e) =>
                  updateVideoCompressSession((prev) => ({
                    ...prev,
                    encoderPreference: e.target.value,
                  }))
                }
              >
                <option value="software">
                  {isZh
                    ? `软件 CPU（${state.codec === "h264" ? "libx264" : "libx265"} · 始终可用）`
                    : `Software CPU (${state.codec === "h264" ? "libx264" : "libx265"})`}
                </option>
                {availableEncoders.some((e) => e.isHardware) && (
                  <option value="auto_hardware">
                    {isZh
                      ? "优先已验证硬件编码器（失败自动回退 CPU）"
                      : "Prefer Verified Hardware (auto CPU fallback)"}
                  </option>
                )}
                {availableEncoders
                  .filter((e) => e.isHardware)
                  .map((enc) => (
                    <option key={enc.id} value={enc.id}>
                      {enc.label}
                    </option>
                  ))}
              </select>
              <div style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                {probingEncoders
                  ? isZh
                    ? "正在进行短片试编码探测本机硬件编码器..."
                    : "Running short trial encodes to probe hardware encoders..."
                  : availableEncoders.some((e) => e.isHardware)
                    ? isZh
                      ? `本机已通过试编码验证的硬件编码器：${availableEncoders
                          .filter((e) => e.isHardware)
                          .map((e) => e.id)
                          .join("、")}`
                      : `Verified hardware encoders: ${availableEncoders
                          .filter((e) => e.isHardware)
                          .map((e) => e.id)
                          .join(", ")}`
                    : isZh
                      ? "本机未检测到可用的硬件编码器，已自动锁定为 CPU 软件编码。"
                      : "No verified hardware encoder found; using software CPU encoding."}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "12px" }}>
              <label
                style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}
              >
                <input
                  type="checkbox"
                  checked={state.keepAudio}
                  disabled={state.taskStatus === "running"}
                  onChange={(e) =>
                    updateVideoCompressSession((prev) => ({ ...prev, keepAudio: e.target.checked }))
                  }
                />
                <span>{isZh ? "保留音轨（默认开启）" : "Keep audio tracks (default)"}</span>
              </label>
              <label
                style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}
              >
                <input
                  type="checkbox"
                  checked={state.keepOriginalIfLarger}
                  disabled={state.taskStatus === "running"}
                  onChange={(e) =>
                    updateVideoCompressSession((prev) => ({
                      ...prev,
                      keepOriginalIfLarger: e.target.checked,
                    }))
                  }
                />
                <span>
                  {isZh
                    ? "若压缩后未缩小则保留原件字节（防负优化）"
                    : "Keep original bytes if output is not smaller"}
                </span>
              </label>
            </div>

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
                    updateVideoCompressSession((prev) => ({ ...prev, outputDir: e.target.value }))
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
                      ? `正在压缩 (${state.liveProgress?.currentItem ?? 1}/${state.liveProgress?.totalItems ?? state.items.length})...`
                      : `Compressing (${state.liveProgress?.currentItem ?? 1}/${state.liveProgress?.totalItems ?? state.items.length})...`}
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
                  onClick={() => void cancelVideoCompressBatch()}
                >
                  {isZh ? "取消压缩" : "Cancel"}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!mediaReady || state.items.length === 0 || !state.outputDir.trim()}
                onClick={() => void handleStartCompress()}
              >
                <Minimize2 size={15} />
                {isZh ? `开始压缩（${state.items.length} 项）` : `Compress (${state.items.length})`}
              </button>
            )}

            {state.errorMessage && (
              <div style={{ fontSize: "12px", color: "var(--status-err)" }}>
                {state.errorMessage}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
