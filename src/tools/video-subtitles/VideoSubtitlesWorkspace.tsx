import {
  Captions,
  CheckCircle2,
  FileText,
  Film,
  FolderOpen,
  Info,
  RefreshCw,
  Save,
  Stamp,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MediaToolsSetupPanel } from "../../components/MediaToolsSetupPanel";
import { useI18n } from "../../i18n/I18nContext";
import { useMediaSession } from "../../lib/mediaSessionStore";
import {
  bindDisposableListener,
  extractMediaPosterDataUrl,
  formatLocalizedError,
  openLocalDirectory,
  parseSubtitleFile,
  pickSaveFilePath,
  pickSingleFile,
  previewBurnedSubtitleFrame,
  probeMediaInfo,
  subscribeFileDrop,
  type MediaToolsStatus,
  type SubtitleBoxStyle,
  type SubtitleBurnStyle,
  type SubtitleCue,
  type SubtitlePosition,
} from "../../lib/tauriBridge";
import {
  VIDEO_EXTENSIONS,
  formatDurationLabel,
  formatMediaBytes,
  formatTimecode,
  getFileStemAndExt,
  getParentDir,
  suggestMediaOutputPath,
} from "../media-shared/mediaFormat";
import "../media-shared/mediaWorkspace.css";

const SUBTITLE_EXTENSIONS = ["srt", "vtt"];

function buildDefaultSubtitledOutputPath(videoPath: string): string {
  const { ext } = getFileStemAndExt(videoPath);
  const cleanExt = ext.toLowerCase();
  const outExt = ["mp4", "mov", "mkv", "webm", "m4v"].includes(cleanExt) ? cleanExt : "mp4";
  return suggestMediaOutputPath(videoPath, "_subtitled", outExt);
}

export function VideoSubtitlesWorkspace() {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const {
    mediaSession,
    updateVideoSubtitlesSession,
    startVideoSubtitlesTask,
    cancelVideoSubtitlesTask,
    handoffMediaFileToTool,
    pendingHandoff,
    consumePendingHandoff,
  } = useMediaSession();

  const state = mediaSession.videoSubtitles;
  const running = state.taskStatus === "running";

  const [toolsStatus, setToolsStatus] = useState<MediaToolsStatus | null>(null);
  const [hovering, setHovering] = useState(false);
  const [loadingVideo, setLoadingVideo] = useState(false);
  const [loadingSubtitle, setLoadingSubtitle] = useState(false);
  const previewSeqRef = useRef(0);

  const primaryVideo = state.videoProbe?.videoStreams[0] ?? null;
  const durationSec = state.videoProbe?.durationSec ?? 0;

  const currentStyle = useCallback(
    (): SubtitleBurnStyle => ({
      fontSize: state.fontSize,
      position: state.position,
      boxStyle: state.boxStyle,
      marginV: state.marginV,
    }),
    [state.fontSize, state.position, state.boxStyle, state.marginV],
  );

  const renderPreviewAt = useCallback(
    async (
      videoPath: string,
      subtitlePath: string,
      timestampSec: number,
      style: SubtitleBurnStyle,
      cueIndex: number | null,
    ) => {
      const seq = ++previewSeqRef.current;
      updateVideoSubtitlesSession((prev) => ({
        ...prev,
        selectedCueIndex: cueIndex,
        previewTimestampSec: timestampSec,
        previewLoading: true,
        previewError: null,
      }));
      try {
        const res = await previewBurnedSubtitleFrame({
          videoPath,
          subtitlePath,
          timestampSec,
          style,
        });
        if (previewSeqRef.current !== seq) return;
        updateVideoSubtitlesSession((prev) => ({
          ...prev,
          previewFrame: res,
          previewLoading: false,
          previewError: null,
        }));
      } catch (err) {
        if (previewSeqRef.current !== seq) return;
        updateVideoSubtitlesSession((prev) => ({
          ...prev,
          previewLoading: false,
          previewError: formatLocalizedError(err, t),
        }));
      }
    },
    [t, updateVideoSubtitlesSession],
  );

  const loadVideo = useCallback(
    async (filePath: string) => {
      if (running) return;
      setLoadingVideo(true);
      updateVideoSubtitlesSession((prev) => ({
        ...prev,
        videoPath: filePath,
        videoProbe: null,
        posterUrl: null,
        previewFrame: null,
        previewError: null,
        lastResult: null,
        errorMessage: null,
      }));
      try {
        const probe = await probeMediaInfo(filePath);
        if (!probe.hasVideo) {
          throw new Error(
            isZh ? "所选文件不包含视频画面流。" : "Selected file does not contain a video stream.",
          );
        }
        const poster = await extractMediaPosterDataUrl(filePath, 0.25).catch(() => null);
        const outPath = buildDefaultSubtitledOutputPath(filePath);
        updateVideoSubtitlesSession((prev) => ({
          ...prev,
          videoPath: filePath,
          videoProbe: probe,
          posterUrl: poster,
          outputPath: outPath,
          lastResult: null,
          errorMessage: null,
        }));
        if (state.subtitlePath && state.parsedSubtitle && state.parsedSubtitle.cues.length > 0) {
          const firstCue = state.parsedSubtitle.cues[0]!;
          const mid = (firstCue.startSec + firstCue.endSec) / 2;
          await renderPreviewAt(filePath, state.subtitlePath, mid, currentStyle(), firstCue.index);
        }
      } catch (err) {
        updateVideoSubtitlesSession((prev) => ({
          ...prev,
          errorMessage: formatLocalizedError(err, t),
        }));
      } finally {
        setLoadingVideo(false);
      }
    },
    [
      currentStyle,
      isZh,
      renderPreviewAt,
      running,
      state.parsedSubtitle,
      state.subtitlePath,
      t,
      updateVideoSubtitlesSession,
    ],
  );

  const loadSubtitle = useCallback(
    async (filePath: string) => {
      if (running) return;
      setLoadingSubtitle(true);
      updateVideoSubtitlesSession((prev) => ({
        ...prev,
        subtitlePath: filePath,
        parsedSubtitle: null,
        subtitleParseError: null,
        selectedCueIndex: null,
        previewFrame: null,
        previewError: null,
        lastResult: null,
      }));
      try {
        const parsed = await parseSubtitleFile(filePath);
        const firstCue = parsed.cues[0] ?? null;
        const mid = firstCue ? (firstCue.startSec + firstCue.endSec) / 2 : 0;
        updateVideoSubtitlesSession((prev) => ({
          ...prev,
          subtitlePath: filePath,
          parsedSubtitle: parsed,
          subtitleParseError: null,
          selectedCueIndex: firstCue?.index ?? null,
          previewTimestampSec: mid,
        }));
        if (state.videoPath && firstCue) {
          await renderPreviewAt(state.videoPath, filePath, mid, currentStyle(), firstCue.index);
        }
      } catch (err) {
        updateVideoSubtitlesSession((prev) => ({
          ...prev,
          parsedSubtitle: null,
          subtitleParseError: formatLocalizedError(err, t),
        }));
      } finally {
        setLoadingSubtitle(false);
      }
    },
    [currentStyle, renderPreviewAt, running, state.videoPath, t, updateVideoSubtitlesSession],
  );

  useEffect(() => {
    const handed = consumePendingHandoff("V02");
    if (handed) {
      const ext = getFileStemAndExt(handed).ext.toLowerCase();
      if (SUBTITLE_EXTENSIONS.includes(ext)) {
        void loadSubtitle(handed);
      } else {
        void loadVideo(handed);
      }
    }
  }, [pendingHandoff, consumePendingHandoff, loadSubtitle, loadVideo]);

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: setHovering,
          onDropPaths: (paths) => {
            if (running || paths.length === 0) return;
            for (const p of paths) {
              const ext = getFileStemAndExt(p).ext.toLowerCase();
              if (SUBTITLE_EXTENSIONS.includes(ext)) {
                void loadSubtitle(p);
              } else {
                void loadVideo(p);
              }
            }
          },
        }),
      "v02-file-drop",
    );
  }, [loadSubtitle, loadVideo, running]);

  const handlePickVideo = async () => {
    if (running) return;
    const picked = await pickSingleFile({
      title: isZh ? "选择需要烧录字幕的视频" : "Select Target Video",
      filters: [{ name: isZh ? "视频文件" : "Video Files", extensions: VIDEO_EXTENSIONS }],
    });
    if (picked) await loadVideo(picked);
  };

  const handlePickSubtitle = async () => {
    if (running) return;
    const picked = await pickSingleFile({
      title: isZh ? "选择 SRT 或 WebVTT 字幕文件" : "Select SRT or WebVTT Subtitle File",
      filters: [{ name: "SRT / WebVTT", extensions: SUBTITLE_EXTENSIONS }],
    });
    if (picked) await loadSubtitle(picked);
  };

  const handleSelectCue = async (cue: SubtitleCue) => {
    const mid = (cue.startSec + cue.endSec) / 2;
    if (state.videoPath && state.subtitlePath) {
      await renderPreviewAt(state.videoPath, state.subtitlePath, mid, currentStyle(), cue.index);
    } else {
      updateVideoSubtitlesSession((prev) => ({
        ...prev,
        selectedCueIndex: cue.index,
        previewTimestampSec: mid,
      }));
    }
  };

  const handleRefreshPreview = async (overrideStyle?: SubtitleBurnStyle) => {
    if (!state.videoPath || !state.subtitlePath || !state.parsedSubtitle) return;
    await renderPreviewAt(
      state.videoPath,
      state.subtitlePath,
      state.previewTimestampSec,
      overrideStyle ?? currentStyle(),
      state.selectedCueIndex,
    );
  };

  const handlePickOutput = async () => {
    if (!state.videoPath) return;
    const { ext } = getFileStemAndExt(state.outputPath || state.videoPath);
    const chosen = await pickSaveFilePath({
      title: isZh ? "选择烧录字幕后的视频路径" : "Save Subtitled Video As",
      defaultPath: state.outputPath || buildDefaultSubtitledOutputPath(state.videoPath),
      filters: [{ name: (ext || "mp4").toUpperCase(), extensions: [(ext || "mp4").toLowerCase()] }],
    });
    if (chosen) {
      updateVideoSubtitlesSession((prev) => ({ ...prev, outputPath: chosen, lastResult: null }));
    }
  };

  const canExport =
    !running &&
    !loadingVideo &&
    !loadingSubtitle &&
    (toolsStatus?.ready ?? true) &&
    !!state.videoPath &&
    !!state.videoProbe?.hasVideo &&
    !!state.subtitlePath &&
    !!state.parsedSubtitle &&
    state.parsedSubtitle.cueCount > 0 &&
    state.outputPath.trim().length > 0;

  const handleExport = async () => {
    if (!canExport || !state.videoPath || !state.subtitlePath) return;
    await startVideoSubtitlesTask(
      {
        videoPath: state.videoPath,
        subtitlePath: state.subtitlePath,
        outputPath: state.outputPath.trim(),
        style: currentStyle(),
        allowOverwrite: true,
      },
      (err) => formatLocalizedError(err, t),
    );
  };

  const activePreviewImg = state.previewFrame?.dataUrl ?? state.posterUrl;

  return (
    <div className="media-workspace">
      <MediaToolsSetupPanel onStatusChange={setToolsStatus} />

      <section className={`media-section-card ${hovering ? "is-hover" : ""}`}>
        <div className="media-section-header" style={{ flexWrap: "wrap", gap: "8px" }}>
          <div>
            <h2
              className="media-section-title"
              style={{ justifyContent: "flex-start", gap: "8px", margin: 0 }}
            >
              <Captions size={16} aria-hidden="true" />
              <span>
                {isZh ? "视频烧录硬字幕（SRT / WebVTT）" : "Burn In Subtitles (SRT / WebVTT)"}
              </span>
            </h2>
            <p className="field-hint" style={{ margin: "4px 0 0" }}>
              {isZh
                ? "离线导入 SRT / WebVTT 字幕文件，点击任意一条字幕即可按实际字体与排版预览对应画面，并将硬字幕永久烧录到视频像素中（离线使用系统微软雅黑渲染中文）。自动语音转字幕保留至阶段 6。"
                : "Import SRT or WebVTT files offline, click any cue to preview exact burned-in frames with built-in Windows CJK fonts, and permanently burn subtitles into video pixels. Auto transcription is planned for Phase 6."}
            </p>
          </div>
          <div className="media-actions-row">
            <button
              type="button"
              className="btn"
              disabled={running}
              onClick={() => void handlePickVideo()}
            >
              <Film size={14} aria-hidden="true" />
              <span>
                {state.videoPath
                  ? isZh
                    ? "更换视频…"
                    : "Change Video..."
                  : isZh
                    ? "选择视频…"
                    : "Choose Video..."}
              </span>
            </button>
            <button
              type="button"
              className="btn"
              disabled={running}
              onClick={() => void handlePickSubtitle()}
            >
              <FileText size={14} aria-hidden="true" />
              <span>
                {state.subtitlePath
                  ? isZh
                    ? "更换字幕 (.srt/.vtt)…"
                    : "Change Subtitle..."
                  : isZh
                    ? "导入字幕 (.srt/.vtt)…"
                    : "Import SRT / VTT..."}
              </span>
            </button>
          </div>
        </div>

        {/* Main 2-column grid */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(300px, 1.35fr) minmax(280px, 1fr)",
            gap: "14px",
            marginTop: "12px",
            alignItems: "start",
          }}
        >
          {/* Left: Burned Subtitle Preview + Clickable Cue List */}
          <div style={{ display: "flex", flexDirection: "column", gap: "12px", minWidth: 0 }}>
            <div
              className="media-summary-card"
              style={{ display: "flex", flexDirection: "column", gap: "8px" }}
            >
              <div className="media-section-header" style={{ flexWrap: "wrap", gap: "6px" }}>
                <strong style={{ fontSize: "13px" }}>
                  {isZh ? "烧录画面实景预览" : "Burned Subtitle Frame Preview"}
                </strong>
                <div className="media-actions-row">
                  {primaryVideo && (
                    <span className="mono field-hint" style={{ fontSize: "12px" }}>
                      {primaryVideo.displayWidth}×{primaryVideo.displayHeight}
                      {primaryVideo.rotationDegrees
                        ? ` (${primaryVideo.rotationDegrees}°→正立)`
                        : ""}
                    </span>
                  )}
                  {state.videoPath && state.subtitlePath && state.parsedSubtitle && (
                    <button
                      type="button"
                      className="btn"
                      disabled={running || state.previewLoading}
                      onClick={() => void handleRefreshPreview()}
                    >
                      <RefreshCw size={13} aria-hidden="true" />
                      <span>
                        {state.previewLoading
                          ? isZh
                            ? "渲染中…"
                            : "Rendering..."
                          : isZh
                            ? "刷新预览"
                            : "Refresh"}
                      </span>
                    </button>
                  )}
                </div>
              </div>

              <div
                style={{
                  minHeight: "240px",
                  maxHeight: "360px",
                  background: "#0f172a",
                  borderRadius: "8px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  overflow: "hidden",
                  position: "relative",
                }}
              >
                {activePreviewImg ? (
                  <img
                    src={activePreviewImg}
                    alt={isZh ? "字幕烧录帧预览" : "Burned subtitle preview"}
                    data-testid="v02-preview-frame"
                    style={{
                      maxWidth: "100%",
                      maxHeight: "360px",
                      objectFit: "contain",
                      display: "block",
                    }}
                  />
                ) : (
                  <div style={{ textAlign: "center", padding: "24px", color: "#94a3b8" }}>
                    <p style={{ margin: "0 0 10px", fontSize: "13px" }}>
                      {isZh
                        ? "请先选择或拖入视频文件与 .srt / .vtt 字幕文件"
                        : "Select or drop a video file and an .srt or .vtt subtitle file"}
                    </p>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={!(toolsStatus?.ready ?? true)}
                      onClick={() => void handlePickVideo()}
                    >
                      <Upload size={14} aria-hidden="true" />
                      <span>{isZh ? "选择视频" : "Select Video"}</span>
                    </button>
                  </div>
                )}
              </div>

              {state.videoPath && (
                <div className="media-actions-row" style={{ flexWrap: "wrap", gap: "8px" }}>
                  <span className="field-hint mono" style={{ fontSize: "12px", minWidth: "90px" }}>
                    {formatTimecode(state.previewTimestampSec)}
                  </span>
                  <input
                    aria-label={isZh ? "预览时间点" : "Preview timestamp"}
                    type="range"
                    min={0}
                    max={Math.max(0.1, durationSec)}
                    step={0.1}
                    value={Math.min(state.previewTimestampSec, Math.max(0.1, durationSec))}
                    disabled={running || !state.parsedSubtitle}
                    style={{ flex: 1, minWidth: "120px" }}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      updateVideoSubtitlesSession((prev) => ({ ...prev, previewTimestampSec: v }));
                    }}
                    onMouseUp={() => void handleRefreshPreview()}
                    onKeyUp={() => void handleRefreshPreview()}
                  />
                  <span className="field-hint mono" style={{ fontSize: "12px" }}>
                    {formatDurationLabel(durationSec, locale)}
                  </span>
                </div>
              )}

              {state.previewError && (
                <div className="inline-alert inline-alert-error" role="alert">
                  {state.previewError}
                </div>
              )}
            </div>

            {/* Clickable Cue List */}
            {state.parsedSubtitle && (
              <div
                className="media-summary-card"
                style={{ display: "flex", flexDirection: "column", gap: "8px" }}
              >
                <div className="media-section-header">
                  <strong style={{ fontSize: "13px" }}>
                    {isZh
                      ? `字幕时间轴（共 ${state.parsedSubtitle.cueCount} 条，点击任意条跳转预览）`
                      : `Subtitle Cues (${state.parsedSubtitle.cueCount} — click any cue to preview)`}
                  </strong>
                  <span className="badge">
                    {state.parsedSubtitle.format === "web_vtt" ? "WebVTT" : "SRT"}
                  </span>
                </div>
                <div
                  role="listbox"
                  aria-label={isZh ? "字幕条目列表" : "Subtitle cues"}
                  style={{
                    maxHeight: "210px",
                    overflowY: "auto",
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                  }}
                >
                  {state.parsedSubtitle.cues.map((cue) => {
                    const selected = state.selectedCueIndex === cue.index;
                    return (
                      <button
                        key={cue.index}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={`btn btn-ghost`}
                        style={{
                          justifyContent: "flex-start",
                          textAlign: "left",
                          padding: "7px 10px",
                          height: "auto",
                          alignItems: "flex-start",
                          gap: "10px",
                          border: selected
                            ? "1px solid var(--accent)"
                            : "1px solid var(--border-subtle)",
                          background: selected ? "var(--bg-subtle)" : "transparent",
                        }}
                        onClick={() => void handleSelectCue(cue)}
                      >
                        <span
                          className="mono field-hint"
                          style={{ fontSize: "11.5px", whiteSpace: "nowrap" }}
                        >
                          #{cue.index} · {formatTimecode(cue.startSec)} →{" "}
                          {formatTimecode(cue.endSec)}
                        </span>
                        <span
                          style={{
                            fontSize: "12.5px",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                          }}
                        >
                          {cue.text}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Right: Source info, Parse Errors, Style Controls, Export */}
          <div style={{ display: "flex", flexDirection: "column", gap: "12px", minWidth: 0 }}>
            <div
              className="media-summary-card"
              style={{ display: "flex", flexDirection: "column", gap: "8px" }}
            >
              <strong style={{ fontSize: "13px" }}>{isZh ? "输入文件" : "Inputs"}</strong>
              <div style={{ fontSize: "12px" }}>
                <span className="field-hint">{isZh ? "视频：" : "Video: "}</span>
                <span className="mono" style={{ wordBreak: "break-all" }}>
                  {state.videoProbe?.fileName ??
                    (loadingVideo ? (isZh ? "读取中…" : "Loading...") : isZh ? "未选择" : "None")}
                </span>
              </div>
              <div style={{ fontSize: "12px" }}>
                <span className="field-hint">{isZh ? "字幕：" : "Subtitle: "}</span>
                <span className="mono" style={{ wordBreak: "break-all" }}>
                  {state.parsedSubtitle
                    ? `${state.parsedSubtitle.fileName} (${state.parsedSubtitle.cueCount} ${isZh ? "条" : "cues"})`
                    : loadingSubtitle
                      ? isZh
                        ? "解析中…"
                        : "Parsing..."
                      : isZh
                        ? "未导入 (.srt / .vtt)"
                        : "None (.srt / .vtt)"}
                </span>
              </div>
              {state.subtitleParseError && (
                <div
                  className="inline-alert inline-alert-error"
                  role="alert"
                  data-testid="v02-parse-error"
                >
                  {state.subtitleParseError}
                </div>
              )}
              {state.parsedSubtitle && state.parsedSubtitle.warnings.length > 0 && (
                <div className="field-hint" style={{ fontSize: "11.5px" }}>
                  {state.parsedSubtitle.warnings[0]}
                </div>
              )}
            </div>

            {/* Style Controls */}
            <div
              className="media-summary-card"
              style={{ display: "flex", flexDirection: "column", gap: "12px" }}
            >
              <strong style={{ fontSize: "13px" }}>
                {isZh ? "字幕外观与位置" : "Subtitle Appearance"}
              </strong>

              <div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "8px",
                    fontSize: "12px",
                  }}
                >
                  <label htmlFor="v02-font-size">
                    {isZh ? "字号（以 720p 画面等比缩放）" : "Font Size (720p scaled)"}
                  </label>
                  <span className="mono">{state.fontSize} px</span>
                </div>
                <input
                  id="v02-font-size"
                  type="range"
                  min={22}
                  max={64}
                  step={2}
                  value={state.fontSize}
                  disabled={running}
                  style={{ width: "100%" }}
                  onChange={(e) => {
                    const nextSize = Number(e.target.value);
                    updateVideoSubtitlesSession((prev) => ({
                      ...prev,
                      fontSize: nextSize,
                      lastResult: null,
                    }));
                  }}
                  onMouseUp={() => void handleRefreshPreview()}
                />
              </div>

              <div>
                <span className="field-label" style={{ display: "block", marginBottom: "6px" }}>
                  {isZh ? "字幕位置" : "Vertical Position"}
                </span>
                <div
                  className="segmented"
                  style={{ display: "flex", width: "100%" }}
                  role="radiogroup"
                  aria-label={isZh ? "字幕位置" : "Subtitle position"}
                >
                  {(
                    [
                      { value: "bottom" as SubtitlePosition, zh: "底部居中", en: "Bottom" },
                      { value: "top" as SubtitlePosition, zh: "顶部居中", en: "Top" },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={state.position === opt.value}
                      style={{ flex: 1 }}
                      className={`segmented-btn ${state.position === opt.value ? "is-selected" : ""}`}
                      disabled={running}
                      onClick={() => {
                        const nextStyle: SubtitleBurnStyle = {
                          ...currentStyle(),
                          position: opt.value,
                        };
                        updateVideoSubtitlesSession((prev) => ({
                          ...prev,
                          position: opt.value,
                          lastResult: null,
                        }));
                        void handleRefreshPreview(nextStyle);
                      }}
                    >
                      {isZh ? opt.zh : opt.en}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <span className="field-label" style={{ display: "block", marginBottom: "6px" }}>
                  {isZh ? "背景与描边样式" : "Background & Outline"}
                </span>
                <div
                  className="segmented"
                  style={{ display: "flex", width: "100%" }}
                  role="radiogroup"
                  aria-label={isZh ? "描边与底框样式" : "Box style"}
                >
                  {(
                    [
                      {
                        value: "outline_shadow" as SubtitleBoxStyle,
                        zh: "清晰描边 + 阴影",
                        en: "Outline & Shadow",
                      },
                      {
                        value: "black_box" as SubtitleBoxStyle,
                        zh: "半透明黑底框",
                        en: "Black Box",
                      },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={state.boxStyle === opt.value}
                      style={{ flex: 1 }}
                      className={`segmented-btn ${state.boxStyle === opt.value ? "is-selected" : ""}`}
                      disabled={running}
                      onClick={() => {
                        const nextStyle: SubtitleBurnStyle = {
                          ...currentStyle(),
                          boxStyle: opt.value,
                        };
                        updateVideoSubtitlesSession((prev) => ({
                          ...prev,
                          boxStyle: opt.value,
                          lastResult: null,
                        }));
                        void handleRefreshPreview(nextStyle);
                      }}
                    >
                      {isZh ? opt.zh : opt.en}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "8px",
                    fontSize: "12px",
                  }}
                >
                  <label htmlFor="v02-margin-v">{isZh ? "距边距离" : "Edge Margin"}</label>
                  <span className="mono">{state.marginV} px</span>
                </div>
                <input
                  id="v02-margin-v"
                  type="range"
                  min={16}
                  max={110}
                  step={2}
                  value={state.marginV}
                  disabled={running}
                  style={{ width: "100%" }}
                  onChange={(e) =>
                    updateVideoSubtitlesSession((prev) => ({
                      ...prev,
                      marginV: Number(e.target.value),
                      lastResult: null,
                    }))
                  }
                  onMouseUp={() => void handleRefreshPreview()}
                />
              </div>
            </div>

            {/* Output & Export */}
            <div
              className="media-summary-card"
              style={{ display: "flex", flexDirection: "column", gap: "10px" }}
            >
              <label className="field-label" htmlFor="v02-output-path">
                {isZh ? "输出视频文件（绝不覆盖源文件）" : "Output Video File"}
              </label>
              <div className="media-actions-row">
                <input
                  id="v02-output-path"
                  type="text"
                  className="text-input"
                  style={{ flex: 1, minWidth: 0 }}
                  value={state.outputPath}
                  disabled={running}
                  onChange={(e) =>
                    updateVideoSubtitlesSession((prev) => ({ ...prev, outputPath: e.target.value }))
                  }
                />
                <button
                  type="button"
                  className="btn"
                  disabled={running || !state.videoPath}
                  onClick={() => void handlePickOutput()}
                >
                  <Save size={14} aria-hidden="true" />
                  <span>{isZh ? "另存为…" : "Save As..."}</span>
                </button>
              </div>

              <div className="media-actions-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ flex: 1, justifyContent: "center" }}
                  disabled={!canExport}
                  onClick={() => void handleExport()}
                >
                  <Captions size={15} aria-hidden="true" />
                  <span>
                    {running
                      ? isZh
                        ? "正在烧录硬字幕…"
                        : "Burning Subtitles..."
                      : isZh
                        ? "烧录硬字幕并导出"
                        : "Burn In Subtitles & Export"}
                  </span>
                </button>
                {running && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void cancelVideoSubtitlesTask()}
                  >
                    {isZh ? "取消任务" : "Cancel"}
                  </button>
                )}
              </div>

              {running && state.liveProgress && (
                <div className="media-progress-panel">
                  <div className="media-progress-header">
                    <span>
                      {isZh ? "正在烧录字幕到视频画面…" : "Burning subtitles into frames..."}
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
            </div>
          </div>
        </div>

        {state.lastResult && (
          <div className="media-result-card" style={{ marginTop: "12px" }}>
            <div className="media-section-header" style={{ flexWrap: "wrap", gap: "8px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <CheckCircle2 size={18} aria-hidden="true" />
                <strong>
                  {isZh
                    ? `烧录完成：共 ${state.lastResult.burnedCueCount} 条硬字幕 · ${state.lastResult.outputWidth}×${state.lastResult.outputHeight} · ${formatMediaBytes(state.lastResult.byteSize, locale)}`
                    : `Burned ${state.lastResult.burnedCueCount} cue(s) · ${state.lastResult.outputWidth}×${state.lastResult.outputHeight} · ${formatMediaBytes(state.lastResult.byteSize, locale)}`}
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
                  <span>{isZh ? "打开目录" : "Open Folder"}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => handoffMediaFileToTool("I13", state.lastResult!.outputPath)}
                >
                  <Stamp size={13} aria-hidden="true" />
                  <span>{isZh ? "添加视频水印 (I13)" : "Add Watermark (I13)"}</span>
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
            <div className="field-hint" style={{ fontSize: "12px", marginTop: "4px" }}>
              {isZh
                ? `输出不含可选字幕轨（${state.lastResult.subtitleStreamsInOutput} 条软字幕轨），关闭播放器字幕开关仍稳定可见${state.lastResult.audioCopied ? " · 原音频无损拷贝" : ""}。`
                : `Output has ${state.lastResult.subtitleStreamsInOutput} soft subtitle streams (hard-burned directly into pixels)${state.lastResult.audioCopied ? " · Audio stream copied" : ""}.`}
            </div>
            <div
              className="field-hint"
              style={{ fontSize: "12px", marginTop: "2px", wordBreak: "break-all" }}
            >
              {state.lastResult.outputPath}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
