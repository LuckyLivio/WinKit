import { Check, Code2, Copy, FilePlus2, Save, Scissors, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { MediaToolsSetupPanel } from "../../components/MediaToolsSetupPanel";
import { useI18n } from "../../i18n/I18nContext";
import { useMediaSession, type MediaInfoQueueEntry } from "../../lib/mediaSessionStore";
import {
  bindDisposableListener,
  formatLocalizedError,
  pickMultipleFiles,
  pickSaveFilePath,
  probeMediaInfo,
  saveLocalTextFile,
  subscribeFileDrop,
  writeSystemClipboardText,
  type MediaToolsStatus,
} from "../../lib/tauriBridge";
import {
  ALL_MEDIA_EXTENSIONS,
  formatBitrateLabel,
  formatDurationLabel,
  formatFrameRateLabel,
  formatLanguageName,
  formatMediaBytes,
  formatOrientationLabel,
  getFileName,
  getFileStemAndExt,
  unknownLabel,
} from "../media-shared/mediaFormat";
import "../media-shared/mediaWorkspace.css";

export function MediaInfoWorkspace() {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const { mediaSession, updateMediaInfoSession, handoffMediaFileToTool } = useMediaSession();
  const state = mediaSession.mediaInfo;

  const [toolsStatus, setToolsStatus] = useState<MediaToolsStatus | null>(null);
  const [hovering, setHovering] = useState(false);
  const [copiedText, setCopiedText] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const inspectPaths = useCallback(
    async (paths: string[]) => {
      const unique = Array.from(new Set(paths.map((p) => p.trim()).filter(Boolean)));
      if (unique.length === 0) return;

      setErrorBanner(null);
      setFeedback(null);

      // Register placeholders immediately
      updateMediaInfoSession((prev) => {
        const existingMap = new Map(prev.items.map((item) => [item.path, item]));
        for (const p of unique) {
          existingMap.set(p, {
            path: p,
            fileName: getFileName(p),
            status: "loading",
            report: null,
            errorMessage: null,
          });
        }
        const items = Array.from(existingMap.values());
        return {
          ...prev,
          items,
          selectedPath: unique[0] ?? prev.selectedPath,
        };
      });

      for (const p of unique) {
        try {
          const report = await probeMediaInfo(p);
          updateMediaInfoSession((prev) => ({
            ...prev,
            items: prev.items.map((item) =>
              item.path === p
                ? {
                    ...item,
                    fileName: report.fileName,
                    status: "ready",
                    report,
                    errorMessage: null,
                  }
                : item,
            ),
          }));
        } catch (err) {
          const msg = formatLocalizedError(err, t);
          updateMediaInfoSession((prev) => ({
            ...prev,
            items: prev.items.map((item) =>
              item.path === p
                ? {
                    ...item,
                    status: "error",
                    report: null,
                    errorMessage: msg,
                  }
                : item,
            ),
          }));
        }
      }
    },
    [t, updateMediaInfoSession],
  );

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: setHovering,
          onDropPaths: (paths) => {
            void inspectPaths(paths);
          },
        }),
      "v10-file-drop",
    );
  }, [inspectPaths]);

  const handlePickFiles = async () => {
    const picked = await pickMultipleFiles({
      title: isZh ? "选择视频或音频文件" : "Select video or audio files",
      filters: [
        {
          name: isZh ? "音视频文件" : "Media Files",
          extensions: ALL_MEDIA_EXTENSIONS,
        },
      ],
    });
    if (picked.length > 0) {
      await inspectPaths(picked);
    }
  };

  const selectedItem: MediaInfoQueueEntry | null =
    state.items.find((i) => i.path === state.selectedPath) ?? state.items[0] ?? null;
  const report = selectedItem?.report ?? null;
  const primaryVideo = report?.videoStreams[0] ?? null;

  const handleCopySummary = async () => {
    if (!report) return;
    try {
      await writeSystemClipboardText(report.summaryText);
      setCopiedText(true);
      setTimeout(() => setCopiedText(false), 1800);
    } catch (err) {
      setErrorBanner(formatLocalizedError(err, t));
    }
  };

  const handleCopyJson = async () => {
    if (!report) return;
    try {
      const pretty = JSON.stringify(
        {
          fileName: report.fileName,
          byteSize: report.byteSize,
          containerFormat: report.containerFormat,
          containerLongName: report.containerLongName,
          durationSec: report.durationSec,
          overallBitrateBps: report.overallBitrateBps,
          videoStreams: report.videoStreams,
          audioStreams: report.audioStreams,
          subtitleStreams: report.subtitleStreams,
          formatTags: report.formatTags,
        },
        null,
        2,
      );
      await writeSystemClipboardText(pretty);
      setCopiedJson(true);
      setTimeout(() => setCopiedJson(false), 1800);
    } catch (err) {
      setErrorBanner(formatLocalizedError(err, t));
    }
  };

  const handleExportJson = async () => {
    if (!report) return;
    setErrorBanner(null);
    setFeedback(null);
    const { stem } = getFileStemAndExt(report.path);
    const savePath = await pickSaveFilePath({
      title: isZh ? "导出媒体信息 JSON" : "Export Media Info JSON",
      defaultPath: `${stem}_mediainfo.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!savePath) return;

    const payload = JSON.stringify(
      {
        fileName: report.fileName,
        byteSize: report.byteSize,
        containerFormat: report.containerFormat,
        containerLongName: report.containerLongName,
        durationSec: report.durationSec,
        overallBitrateBps: report.overallBitrateBps,
        videoStreams: report.videoStreams,
        audioStreams: report.audioStreams,
        subtitleStreams: report.subtitleStreams,
        formatTags: report.formatTags,
      },
      null,
      2,
    );
    try {
      await saveLocalTextFile({
        outputPath: savePath,
        sourcePath: report.path,
        content: payload,
        overwrite: true,
        toolId: "V10",
      });
      setFeedback(isZh ? `已导出 JSON 至：${savePath}` : `Exported JSON to: ${savePath}`);
    } catch (err) {
      setErrorBanner(formatLocalizedError(err, t));
    }
  };

  const handleClearAll = () => {
    setFeedback(null);
    setErrorBanner(null);
    updateMediaInfoSession((prev) => ({
      ...prev,
      items: [],
      selectedPath: null,
    }));
  };

  const mediaReady = toolsStatus?.ready ?? true;

  return (
    <div className="media-workspace">
      <MediaToolsSetupPanel onStatusChange={setToolsStatus} />

      {errorBanner && (
        <div className="status-banner is-err" role="alert">
          <span>{errorBanner}</span>
        </div>
      )}
      {feedback && (
        <div className="status-banner is-ok" role="status" aria-live="polite">
          <span>{feedback}</span>
        </div>
      )}

      {state.items.length === 0 ? (
        <div className={`media-dropzone ${hovering ? "is-hover" : ""}`}>
          <p style={{ margin: 0, fontWeight: 600 }}>
            {isZh
              ? "拖入视频或音频文件查看详细技术参数"
              : "Drop video or audio files to inspect technical metadata"}
          </p>
          <p className="field-hint" style={{ margin: 0 }}>
            {isZh
              ? "展示容器、时长、大小、视频编码、存储与显示尺寸、旋转方向、帧率（含可变帧率 VFR 标识）、码率及每条音轨的语言/编码/声道/采样率。未知或缺失字段如实显示，不用 0 填充。"
              : "Shows container, duration, size, video codec, storage vs display dimensions, rotation, frame rate (including VFR), bitrate, and every audio track. Missing or unknown fields are shown honestly without filling 0."}
          </p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!mediaReady}
            onClick={() => void handlePickFiles()}
          >
            <FilePlus2 size={15} aria-hidden="true" />
            <span>{isZh ? "选择音视频文件…" : "Select Media Files..."}</span>
          </button>
        </div>
      ) : (
        <>
          <div className="media-actions-row" style={{ justifyContent: "space-between" }}>
            <div className="media-actions-row">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!mediaReady}
                onClick={() => void handlePickFiles()}
              >
                <FilePlus2 size={14} aria-hidden="true" />
                <span>{isZh ? "添加文件" : "Add Files"}</span>
              </button>
              <button
                type="button"
                className="btn"
                disabled={!report}
                onClick={() => void handleCopySummary()}
              >
                {copiedText ? (
                  <Check size={14} aria-hidden="true" />
                ) : (
                  <Copy size={14} aria-hidden="true" />
                )}
                <span>
                  {copiedText
                    ? isZh
                      ? "已复制文本"
                      : "Copied Text"
                    : isZh
                      ? "复制文本摘要"
                      : "Copy Summary"}
                </span>
              </button>
              <button
                type="button"
                className="btn"
                disabled={!report}
                onClick={() => void handleCopyJson()}
              >
                {copiedJson ? (
                  <Check size={14} aria-hidden="true" />
                ) : (
                  <Code2 size={14} aria-hidden="true" />
                )}
                <span>
                  {copiedJson
                    ? isZh
                      ? "已复制 JSON"
                      : "Copied JSON"
                    : isZh
                      ? "复制 JSON"
                      : "Copy JSON"}
                </span>
              </button>
              <button
                type="button"
                className="btn"
                disabled={!report}
                onClick={() => void handleExportJson()}
              >
                <Save size={14} aria-hidden="true" />
                <span>{isZh ? "导出 JSON…" : "Export JSON..."}</span>
              </button>
              {report?.hasVideo && (
                <>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => handoffMediaFileToTool("V03", report.path)}
                  >
                    <span>{isZh ? "变速 (V03)" : "Speed (V03)"}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => handoffMediaFileToTool("V07", report.path)}
                  >
                    <span>{isZh ? "格式转换 (V07)" : "Convert (V07)"}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => handoffMediaFileToTool("V06", report.path)}
                  >
                    <span>{isZh ? "压缩 (V06)" : "Compress (V06)"}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => handoffMediaFileToTool("V08", report.path)}
                  >
                    <span>{isZh ? "尺寸 (V08)" : "Resize (V08)"}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => handoffMediaFileToTool("V09", report.path)}
                  >
                    <span>{isZh ? "裁剪旋转 (V09)" : "Crop (V09)"}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => handoffMediaFileToTool("V11", report.path)}
                  >
                    <Scissors size={14} aria-hidden="true" />
                    <span>{isZh ? "视频剪切 (V11)" : "Trim (V11)"}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => handoffMediaFileToTool("V12", report.path)}
                  >
                    <span>{isZh ? "合并 (V12)" : "Merge (V12)"}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => handoffMediaFileToTool("V13", report.path)}
                  >
                    <span>{isZh ? "静音 (V13)" : "Mute (V13)"}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => handoffMediaFileToTool("V04", report.path)}
                  >
                    <span>{isZh ? "抽帧 (V04)" : "Frames (V04)"}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => handoffMediaFileToTool("V15", report.path)}
                  >
                    <span>{isZh ? "转 GIF (V15)" : "GIF (V15)"}</span>
                  </button>
                </>
              )}
              {report?.hasAudio && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => handoffMediaFileToTool("A04", report.path)}
                >
                  <span>{isZh ? "提取音频 (A04)" : "Extract Audio (A04)"}</span>
                </button>
              )}
            </div>
            <button type="button" className="btn btn-ghost" onClick={handleClearAll}>
              <Trash2 size={14} aria-hidden="true" />
              <span>{isZh ? "清空列表" : "Clear"}</span>
            </button>
          </div>

          {state.items.length > 1 && (
            <div className="media-queue-list" role="list">
              {state.items.map((item) => (
                <div
                  key={item.path}
                  className={`media-queue-item ${item.path === selectedItem?.path ? "is-selected" : ""}`}
                  role="listitem"
                >
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{
                      justifyContent: "flex-start",
                      flex: 1,
                      minWidth: 0,
                      textAlign: "left",
                    }}
                    onClick={() =>
                      updateMediaInfoSession((prev) => ({ ...prev, selectedPath: item.path }))
                    }
                  >
                    <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                      {item.fileName}
                    </span>
                  </button>
                  {item.status === "loading" && (
                    <span className="media-status-pill is-neutral">
                      {isZh ? "解析中…" : "Probing..."}
                    </span>
                  )}
                  {item.status === "ready" && (
                    <span className="media-status-pill is-ok">
                      {item.report?.containerFormat ?? (isZh ? "已解析" : "Ready")}
                    </span>
                  )}
                  {item.status === "error" && (
                    <span className="media-status-pill is-err">{isZh ? "解析失败" : "Failed"}</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {selectedItem?.status === "loading" && (
            <div className="media-section-card" role="status">
              <span>
                {isZh
                  ? `正在解析 ${selectedItem.fileName}…`
                  : `Probing ${selectedItem.fileName}...`}
              </span>
            </div>
          )}

          {selectedItem?.status === "error" && (
            <div className="status-banner is-err" role="alert">
              <span>
                {selectedItem.fileName}: {selectedItem.errorMessage}
              </span>
            </div>
          )}

          {report && (
            <>
              <div className="media-metrics-grid">
                <div className="media-metric-card">
                  <span className="media-metric-label">{isZh ? "封装容器" : "Container"}</span>
                  <span className="media-metric-value mono">
                    {report.containerFormat ?? unknownLabel(locale)}
                  </span>
                  <span className="media-metric-sub">
                    {report.containerLongName ?? unknownLabel(locale)}
                  </span>
                </div>

                <div className="media-metric-card">
                  <span className="media-metric-label">{isZh ? "时长" : "Duration"}</span>
                  <span className="media-metric-value mono">
                    {formatDurationLabel(report.durationSec, locale)}
                  </span>
                  <span className="media-metric-sub">
                    {report.durationSec != null
                      ? `${report.durationSec.toFixed(3)} s`
                      : isZh
                        ? "容器未记录时长"
                        : "Duration not recorded"}
                  </span>
                </div>

                <div className="media-metric-card">
                  <span className="media-metric-label">
                    {isZh ? "文件大小 / 总码率" : "File Size / Overall Bitrate"}
                  </span>
                  <span className="media-metric-value mono">
                    {formatMediaBytes(report.byteSize, locale)}
                  </span>
                  <span className="media-metric-sub mono">
                    {formatBitrateLabel(report.overallBitrateBps, locale)}
                  </span>
                </div>

                {primaryVideo && (
                  <>
                    <div className="media-metric-card">
                      <span className="media-metric-label">
                        {isZh ? "显示尺寸 / 方向" : "Display Size / Orientation"}
                      </span>
                      <span className="media-metric-value mono">
                        {primaryVideo.displayWidth != null && primaryVideo.displayHeight != null
                          ? `${primaryVideo.displayWidth} × ${primaryVideo.displayHeight}`
                          : unknownLabel(locale)}
                      </span>
                      <span className="media-metric-sub">
                        {formatOrientationLabel(
                          primaryVideo.orientation,
                          primaryVideo.rotationDegrees,
                          locale,
                        )}
                      </span>
                    </div>

                    <div className="media-metric-card">
                      <span className="media-metric-label">
                        {isZh ? "帧率与模式" : "Frame Rate"}
                      </span>
                      <span className="media-metric-value mono">
                        {formatFrameRateLabel(
                          primaryVideo.avgFrameRate,
                          primaryVideo.rFrameRate,
                          primaryVideo.isVariableFrameRate,
                          locale,
                        )}
                      </span>
                      <span className="media-metric-sub mono">
                        {primaryVideo.codecName?.toUpperCase() ?? unknownLabel(locale)}
                        {primaryVideo.pixelFormat ? ` · ${primaryVideo.pixelFormat}` : ""}
                      </span>
                    </div>
                  </>
                )}

                <div className="media-metric-card">
                  <span className="media-metric-label">{isZh ? "流数量概览" : "Streams"}</span>
                  <span className="media-metric-value">
                    {isZh
                      ? `${report.videoStreams.length} 视频 · ${report.audioStreams.length} 音轨`
                      : `${report.videoStreams.length} video · ${report.audioStreams.length} audio`}
                  </span>
                  <span className="media-metric-sub">
                    {report.subtitleStreams.length > 0
                      ? isZh
                        ? `含 ${report.subtitleStreams.length} 条字幕流`
                        : `${report.subtitleStreams.length} subtitle stream(s)`
                      : isZh
                        ? "无字幕流"
                        : "No subtitle streams"}
                  </span>
                </div>
              </div>

              {report.videoStreams.map((v, idx) => (
                <section key={`v-${v.index}`} className="media-section-card">
                  <h3 className="media-section-title">
                    <span>
                      {isZh
                        ? `视频流 #${idx + 1}（流索引 ${v.index}）`
                        : `Video Stream #${idx + 1} (index ${v.index})`}
                    </span>
                    {v.isVariableFrameRate === true && (
                      <span className="media-status-pill is-warn">
                        {isZh ? "可变帧率 VFR" : "Variable Frame Rate (VFR)"}
                      </span>
                    )}
                  </h3>
                  <table className="media-kv-table">
                    <tbody>
                      <tr>
                        <th>{isZh ? "视频编码" : "Video Codec"}</th>
                        <td className="mono">
                          {v.codecLongName ?? v.codecName ?? unknownLabel(locale)}
                          {v.profile ? ` (${v.profile})` : ""}
                        </td>
                      </tr>
                      <tr>
                        <th>{isZh ? "存储尺寸" : "Storage Dimensions"}</th>
                        <td className="mono">
                          {v.codedWidth != null && v.codedHeight != null
                            ? `${v.codedWidth} × ${v.codedHeight} px`
                            : unknownLabel(locale)}
                          {v.sampleAspectRatio ? ` (SAR ${v.sampleAspectRatio})` : ""}
                        </td>
                      </tr>
                      <tr>
                        <th>{isZh ? "显示尺寸与方向" : "Display Dimensions & Orientation"}</th>
                        <td className="mono">
                          {v.displayWidth != null && v.displayHeight != null
                            ? `${v.displayWidth} × ${v.displayHeight} px`
                            : unknownLabel(locale)}
                          {" · "}
                          {formatOrientationLabel(v.orientation, v.rotationDegrees, locale)}
                        </td>
                      </tr>
                      <tr>
                        <th>{isZh ? "帧率" : "Frame Rate"}</th>
                        <td className="mono">
                          {formatFrameRateLabel(
                            v.avgFrameRate,
                            v.rFrameRate,
                            v.isVariableFrameRate,
                            locale,
                          )}
                          {v.avgFrameRateRaw || v.rFrameRateRaw
                            ? ` [avg: ${v.avgFrameRateRaw ?? "—"}, r: ${v.rFrameRateRaw ?? "—"}]`
                            : ""}
                        </td>
                      </tr>
                      <tr>
                        <th>{isZh ? "视频码率" : "Video Bitrate"}</th>
                        <td className="mono">{formatBitrateLabel(v.bitrateBps, locale)}</td>
                      </tr>
                      <tr>
                        <th>{isZh ? "像素格式与色彩" : "Pixel Format & Color"}</th>
                        <td className="mono">
                          {[v.pixelFormat, v.colorSpace, v.colorTransfer, v.colorPrimaries]
                            .filter(Boolean)
                            .join(" · ") || unknownLabel(locale)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </section>
              ))}

              <section className="media-section-card">
                <h3 className="media-section-title">
                  <span>
                    {isZh
                      ? `音轨信息（共 ${report.audioStreams.length} 条）`
                      : `Audio Tracks (${report.audioStreams.length})`}
                  </span>
                </h3>
                {report.audioStreams.length === 0 ? (
                  <p className="field-hint" style={{ margin: 0 }}>
                    {isZh
                      ? "该文件不包含任何音轨（静音素材）。"
                      : "This file contains no audio tracks (silent media)."}
                  </p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                    {report.audioStreams.map((a) => (
                      <div
                        key={`a-${a.index}`}
                        style={{
                          border: "1px solid var(--border-subtle)",
                          borderRadius: "8px",
                          padding: "8px 10px",
                          background: "var(--bg-subtle)",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            marginBottom: "6px",
                            gap: "8px",
                            flexWrap: "wrap",
                          }}
                        >
                          <strong style={{ fontSize: "12.5px" }}>
                            {isZh
                              ? `音轨 #${a.audioTrackIndex + 1}（流索引 ${a.index}）`
                              : `Audio Track #${a.audioTrackIndex + 1} (stream ${a.index})`}
                            {a.title ? ` · ${a.title}` : ""}
                          </strong>
                          <div className="media-actions-row">
                            <span className="badge">{formatLanguageName(a.language, locale)}</span>
                            {a.isDefault && (
                              <span className="media-status-pill is-ok">
                                {isZh ? "默认" : "Default"}
                              </span>
                            )}
                          </div>
                        </div>
                        <table className="media-kv-table">
                          <tbody>
                            <tr>
                              <th>{isZh ? "音频编码" : "Codec"}</th>
                              <td className="mono">
                                {a.codecLongName ?? a.codecName ?? unknownLabel(locale)}
                              </td>
                            </tr>
                            <tr>
                              <th>{isZh ? "声道与布局" : "Channels"}</th>
                              <td className="mono">
                                {a.channels != null
                                  ? a.channelLayout
                                    ? `${a.channels} (${a.channelLayout})`
                                    : `${a.channels}`
                                  : unknownLabel(locale)}
                              </td>
                            </tr>
                            <tr>
                              <th>{isZh ? "采样率 / 码率" : "Sample Rate / Bitrate"}</th>
                              <td className="mono">
                                {a.sampleRateHz != null
                                  ? `${a.sampleRateHz} Hz`
                                  : unknownLabel(locale)}
                                {" · "}
                                {formatBitrateLabel(a.bitrateBps, locale)}
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="media-section-card">
                <div className="media-section-title">
                  <span>{isZh ? "原始结构化摘要" : "Raw Structured Info"}</span>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() =>
                      updateMediaInfoSession((prev) => ({
                        ...prev,
                        showRawJson: !prev.showRawJson,
                      }))
                    }
                  >
                    {state.showRawJson
                      ? isZh
                        ? "隐藏原始 JSON"
                        : "Hide Raw JSON"
                      : isZh
                        ? "展开原始 JSON"
                        : "Show Raw JSON"}
                  </button>
                </div>
                {state.showRawJson && (
                  <pre
                    className="mono"
                    style={{
                      margin: 0,
                      padding: "10px",
                      borderRadius: "8px",
                      background: "var(--bg-subtle)",
                      maxHeight: "260px",
                      overflow: "auto",
                      fontSize: "11.5px",
                    }}
                  >
                    {report.rawJson}
                  </pre>
                )}
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
