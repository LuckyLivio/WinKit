import { AudioLines, CheckCircle2, FilePlus2, FolderOpen, Info, Trash2, X } from "lucide-react";
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
  type AudioBitDepthOption,
  type AudioConvertFormat,
  type MediaToolsStatus,
} from "../../lib/tauriBridge";
import {
  ALL_MEDIA_EXTENSIONS,
  formatDurationLabel,
  formatMediaBytes,
  getFileName,
  getParentDir,
} from "../media-shared/mediaFormat";
import "../media-shared/mediaWorkspace.css";

const FORMAT_OPTIONS: {
  id: AudioConvertFormat;
  label: string;
  descZh: string;
  descEn: string;
  lossless: boolean;
}[] = [
  {
    id: "mp3",
    label: "MP3",
    descZh: "通用有损 (LAME)",
    descEn: "Universal Lossy",
    lossless: false,
  },
  { id: "m4a", label: "M4A", descZh: "高效有损 (AAC)", descEn: "AAC Audio", lossless: false },
  { id: "wav", label: "WAV", descZh: "无损 PCM", descEn: "Uncompressed PCM", lossless: true },
  { id: "flac", label: "FLAC", descZh: "无损压缩", descEn: "Lossless FLAC", lossless: true },
  { id: "aiff", label: "AIFF", descZh: "无损大端 PCM", descEn: "Lossless AIFF", lossless: true },
];

const BITRATE_OPTIONS = [128, 192, 256, 320];

export function AudioConvertWorkspace() {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const {
    mediaSession,
    updateAudioConvertSession,
    startAudioConvertBatch,
    cancelAudioConvertBatch,
    handoffMediaFileToTool,
    pendingHandoff,
    consumePendingHandoff,
  } = useMediaSession();
  const state = mediaSession.audioConvert;

  const [toolsStatus, setToolsStatus] = useState<MediaToolsStatus | null>(null);
  const [hovering, setHovering] = useState(false);

  const addAudioPaths = useCallback(
    async (paths: string[]) => {
      const unique = Array.from(new Set(paths.map((p) => p.trim()).filter(Boolean)));
      if (unique.length === 0) return;

      updateAudioConvertSession((prev) => {
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
          updateAudioConvertSession((prev) => ({
            ...prev,
            items: prev.items.map((item) =>
              item.path === p
                ? { ...item, fileName: probe.fileName, status: "ready", probe, errorMessage: null }
                : item,
            ),
          }));
        } catch (err) {
          const msg = formatLocalizedError(err, t);
          updateAudioConvertSession((prev) => ({
            ...prev,
            items: prev.items.map((item) =>
              item.path === p ? { ...item, status: "error", probe: null, errorMessage: msg } : item,
            ),
          }));
        }
      }
    },
    [t, updateAudioConvertSession],
  );

  useEffect(() => {
    if (pendingHandoff?.toolId === "A05") {
      const path = consumePendingHandoff("A05");
      if (path) void addAudioPaths([path]);
    }
  }, [pendingHandoff, consumePendingHandoff, addAudioPaths]);

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: setHovering,
          onDropPaths: (paths) => void addAudioPaths(paths),
        }),
      "a05-file-drop",
    );
  }, [addAudioPaths]);

  const handlePickFiles = async () => {
    try {
      const picked = await pickMultipleFiles({
        title: isZh ? "选择需要转换格式的音频文件" : "Select audio files to convert",
        filters: [
          {
            name: isZh ? "音频与媒体文件" : "Audio & Media Files",
            extensions: [...ALL_MEDIA_EXTENSIONS],
          },
        ],
      });
      if (picked && picked.length > 0) await addAudioPaths(picked);
    } catch (err) {
      updateAudioConvertSession((prev) => ({
        ...prev,
        errorMessage: formatLocalizedError(err, t),
      }));
    }
  };

  const handlePickOutDir = async () => {
    try {
      const picked = await pickSingleDirectory({
        title: isZh ? "选择输出目录" : "Select output directory",
      });
      if (picked) {
        updateAudioConvertSession((prev) => ({ ...prev, outputDir: picked }));
      }
    } catch (err) {
      updateAudioConvertSession((prev) => ({
        ...prev,
        errorMessage: formatLocalizedError(err, t),
      }));
    }
  };

  const removeItem = (path: string) => {
    updateAudioConvertSession((prev) => {
      const items = prev.items.filter((i) => i.path !== path);
      return {
        ...prev,
        items,
        selectedPath: prev.selectedPath === path ? (items[0]?.path ?? null) : prev.selectedPath,
      };
    });
  };

  const clearAll = () => {
    updateAudioConvertSession((prev) => ({
      ...prev,
      items: [],
      selectedPath: null,
      lastReport: null,
      errorMessage: null,
    }));
  };

  const isLosslessTarget =
    state.targetFormat === "wav" || state.targetFormat === "flac" || state.targetFormat === "aiff";

  const handleStart = async () => {
    if (state.items.length === 0 || !state.outputDir.trim()) return;
    await startAudioConvertBatch(
      {
        sourcePaths: state.items.map((i) => i.path),
        outputDir: state.outputDir.trim(),
        targetFormat: state.targetFormat,
        bitrateKbps: isLosslessTarget ? null : state.bitrateKbps,
        sampleRateHz: state.sampleRateHz,
        bitDepth: isLosslessTarget ? state.bitDepth : null,
      },
      (err) => formatLocalizedError(err, t),
    );
  };

  const mediaReady = Boolean(toolsStatus?.ready);
  const running = state.taskStatus === "running";
  const canStart =
    mediaReady && !running && state.items.length > 0 && Boolean(state.outputDir.trim());

  return (
    <div className="media-workspace">
      <MediaToolsSetupPanel onStatusChange={setToolsStatus} />

      <section className="panel media-section">
        <div className="media-section-header">
          <div>
            <h3>{isZh ? "音频格式转换" : "Convert Audio"}</h3>
            <p className="field-hint" style={{ margin: "2px 0 0" }}>
              {isZh
                ? "单文件与批量转换为 MP3、M4A (AAC)、WAV、FLAC 或 AIFF；无损格式默认保留可表达的源位深、采样率与声道。"
                : "Convert single or batch audio to MP3, M4A (AAC), WAV, FLAC, or AIFF. Lossless outputs preserve expressible source bit depth, sample rate, and channels by default."}
            </p>
          </div>
          <div className="media-actions-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!mediaReady || running}
              onClick={() => void handlePickFiles()}
            >
              <FilePlus2 size={15} aria-hidden="true" />
              <span>{isZh ? "添加音频" : "Add Audio"}</span>
            </button>
            {state.items.length > 0 && (
              <button type="button" className="btn btn-ghost" disabled={running} onClick={clearAll}>
                <Trash2 size={14} aria-hidden="true" />
                <span>{isZh ? "清空" : "Clear"}</span>
              </button>
            )}
          </div>
        </div>

        {state.items.length === 0 ? (
          <div className={`media-dropzone ${hovering ? "is-hover" : ""}`}>
            <AudioLines size={26} strokeWidth={1.6} aria-hidden="true" />
            <p style={{ margin: 0, fontWeight: 600 }}>
              {isZh
                ? "拖入一个或多个音频文件以批量转换格式"
                : "Drop one or more audio files to convert"}
            </p>
            <p className="field-hint" style={{ margin: 0 }}>
              {isZh
                ? "支持 MP3、M4A、WAV、FLAC、AIFF 输出，保留原文件不动，同名自动编号防覆盖。"
                : "Outputs MP3, M4A, WAV, FLAC, or AIFF into your target folder without overwriting originals."}
            </p>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!mediaReady}
              onClick={() => void handlePickFiles()}
            >
              <FilePlus2 size={15} aria-hidden="true" />
              <span>{isZh ? "选择音频文件…" : "Select Audio Files..."}</span>
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div className="media-grid-2">
              {/* Left: file queue */}
              <div className="media-queue-list" role="list">
                {state.items.map((item) => {
                  const a0 = item.probe?.audioStreams[0];
                  return (
                    <div
                      key={item.path}
                      className={`media-queue-item ${item.path === state.selectedPath ? "is-selected" : ""}`}
                      role="listitem"
                    >
                      <button
                        type="button"
                        className="media-queue-select"
                        onClick={() =>
                          updateAudioConvertSession((prev) => ({
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
                              ? "读取参数中…"
                              : "Probing..."
                            : item.status === "error"
                              ? item.errorMessage
                              : `${(a0?.codecName ?? "audio").toUpperCase()} · ${
                                  a0?.sampleRateHz ? `${a0.sampleRateHz} Hz` : "—"
                                } · ${a0?.channels ?? "—"} ch${
                                  a0?.bitsPerSample ? ` · ${a0.bitsPerSample}-bit` : ""
                                } · ${formatDurationLabel(item.probe?.durationSec ?? null, locale)}`}
                        </div>
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        disabled={running}
                        aria-label={isZh ? `移除 ${item.fileName}` : `Remove ${item.fileName}`}
                        onClick={() => removeItem(item.path)}
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* Right: format & precision controls */}
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                <div>
                  <span className="field-label">{isZh ? "目标格式" : "Target Format"}</span>
                  <div className="media-actions-row" style={{ marginTop: "6px" }}>
                    {FORMAT_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={`btn ${state.targetFormat === opt.id ? "btn-primary" : ""}`}
                        disabled={running}
                        onClick={() =>
                          updateAudioConvertSession((prev) => ({
                            ...prev,
                            targetFormat: opt.id,
                            bitDepth:
                              opt.id !== "wav" && prev.bitDepth === "bits32_float"
                                ? "source"
                                : prev.bitDepth,
                            lastReport: null,
                          }))
                        }
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <div className="field-hint" style={{ fontSize: "12px", marginTop: "4px" }}>
                    {(() => {
                      const cur = FORMAT_OPTIONS.find((f) => f.id === state.targetFormat);
                      return cur ? (isZh ? cur.descZh : cur.descEn) : "";
                    })()}
                  </div>
                </div>

                {!isLosslessTarget ? (
                  <div>
                    <label className="field-label" htmlFor="a05-bitrate">
                      {isZh ? "码率 (kbps)" : "Bitrate (kbps)"}
                    </label>
                    <div className="media-actions-row" style={{ marginTop: "6px" }}>
                      {BITRATE_OPTIONS.map((br) => (
                        <button
                          key={br}
                          type="button"
                          className={`btn ${state.bitrateKbps === br ? "btn-primary" : ""}`}
                          disabled={running}
                          onClick={() =>
                            updateAudioConvertSession((prev) => ({ ...prev, bitrateKbps: br }))
                          }
                        >
                          {br} kbps
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div>
                    <label className="field-label" htmlFor="a05-bit-depth">
                      {isZh ? "无损采样位深" : "Lossless Bit Depth"}
                    </label>
                    <select
                      id="a05-bit-depth"
                      className="text-input"
                      style={{ width: "100%", marginTop: "6px" }}
                      value={state.bitDepth}
                      disabled={running}
                      onChange={(e) =>
                        updateAudioConvertSession((prev) => ({
                          ...prev,
                          bitDepth: e.target.value as AudioBitDepthOption,
                        }))
                      }
                    >
                      <option value="source">
                        {isZh
                          ? "保留源位深与声道（默认，推荐）"
                          : "Keep Source Precision & Channels (Recommended)"}
                      </option>
                      <option value="bits16">16-bit PCM</option>
                      <option value="bits24">24-bit PCM</option>
                      {state.targetFormat === "wav" && (
                        <option value="bits32_float">32-bit Float (WAV)</option>
                      )}
                    </select>
                  </div>
                )}

                <div>
                  <label className="field-label" htmlFor="a05-sample-rate">
                    {isZh ? "采样率" : "Sample Rate"}
                  </label>
                  <select
                    id="a05-sample-rate"
                    className="text-input"
                    style={{ width: "100%", marginTop: "6px" }}
                    value={state.sampleRateHz ?? ""}
                    disabled={running}
                    onChange={(e) => {
                      const val = e.target.value ? Number(e.target.value) : null;
                      updateAudioConvertSession((prev) => ({ ...prev, sampleRateHz: val }));
                    }}
                  >
                    <option value="">
                      {isZh ? "保持原采样率（默认）" : "Keep Original Sample Rate (Default)"}
                    </option>
                    <option value="44100">44,100 Hz (CD)</option>
                    <option value="48000">48,000 Hz (Video / Studio)</option>
                    {isLosslessTarget && <option value="96000">96,000 Hz (Hi-Res)</option>}
                  </select>
                </div>

                <div>
                  <label className="field-label" htmlFor="a05-output-dir">
                    {isZh ? "输出目录" : "Output Folder"}
                  </label>
                  <div className="media-actions-row" style={{ marginTop: "6px" }}>
                    <input
                      id="a05-output-dir"
                      type="text"
                      className="text-input"
                      style={{ flex: 1 }}
                      value={state.outputDir}
                      disabled={running}
                      onChange={(e) =>
                        updateAudioConvertSession((prev) => ({
                          ...prev,
                          outputDir: e.target.value,
                        }))
                      }
                    />
                    <button
                      type="button"
                      className="btn"
                      disabled={running}
                      onClick={() => void handlePickOutDir()}
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
                    <AudioLines size={15} aria-hidden="true" />
                    <span>
                      {running
                        ? isZh
                          ? "正在转换音频…"
                          : "Converting Audio..."
                        : isZh
                          ? `开始转换 (${state.items.length} 个 → ${state.targetFormat.toUpperCase()})`
                          : `Convert ${state.items.length} to ${state.targetFormat.toUpperCase()}`}
                    </span>
                  </button>
                  {running && (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void cancelAudioConvertBatch()}
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
                      ? `转换中 (${state.liveProgress.currentItem}/${state.liveProgress.totalItems})：${state.liveProgress.itemName ?? ""}`
                      : `Converting (${state.liveProgress.currentItem}/${state.liveProgress.totalItems}): ${state.liveProgress.itemName ?? ""}`}
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
                          ? `已取消：完成 ${state.lastReport.convertedCount} 个，跳过 ${state.lastReport.skippedCount} 个`
                          : `Cancelled: ${state.lastReport.convertedCount} converted, ${state.lastReport.skippedCount} skipped`
                        : isZh
                          ? `转换完成：成功 ${state.lastReport.convertedCount} 个，失败 ${state.lastReport.failedCount} 个`
                          : `Done: ${state.lastReport.convertedCount} converted, ${state.lastReport.failedCount} failed`}
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
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, wordBreak: "break-all" }}>
                          {item.fileName}
                        </div>
                        <div className="field-hint" style={{ fontSize: "12px" }}>
                          {item.status === "converted"
                            ? `${(item.outputCodec ?? "").toUpperCase()} · ${
                                item.outputSampleRateHz ? `${item.outputSampleRateHz} Hz` : "—"
                              } · ${item.outputChannels ?? "—"} ch${
                                item.outputBitsPerSample ? ` · ${item.outputBitsPerSample}-bit` : ""
                              } · ${formatMediaBytes(item.outputBytes ?? 0, locale)}`
                            : (item.message ?? item.status)}
                        </div>
                      </div>
                      {item.outputPath && (
                        <div className="media-actions-row">
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() => handoffMediaFileToTool("A03", item.outputPath!)}
                          >
                            <span>{isZh ? "剪切 (A03)" : "Trim (A03)"}</span>
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
          </div>
        )}
      </section>
    </div>
  );
}
