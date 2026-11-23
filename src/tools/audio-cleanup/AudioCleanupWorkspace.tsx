import {
  CheckCircle2,
  FolderOpen,
  Info,
  Pause,
  Play,
  RefreshCw,
  Save,
  SlidersHorizontal,
  Upload,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MediaToolsSetupPanel } from "../../components/MediaToolsSetupPanel";
import { useI18n } from "../../i18n/I18nContext";
import { useMediaSession } from "../../lib/mediaSessionStore";
import {
  bindDisposableListener,
  formatLocalizedError,
  openLocalDirectory,
  pickSaveFilePath,
  pickSingleFile,
  previewAudioCleanup,
  probeMediaInfo,
  subscribeFileDrop,
  type AudioDenoiseLevel,
  type MediaToolsStatus,
} from "../../lib/tauriBridge";
import {
  formatDurationLabel,
  formatLanguageName,
  formatMediaBytes,
  getFileStemAndExt,
  getParentDir,
  suggestMediaOutputPath,
} from "../media-shared/mediaFormat";
import "../media-shared/mediaWorkspace.css";

const MEDIA_EXTENSIONS = [
  "wav",
  "mp3",
  "m4a",
  "flac",
  "aiff",
  "aif",
  "ogg",
  "opus",
  "aac",
  "mp4",
  "mov",
  "mkv",
  "webm",
  "avi",
];

function buildDefaultCleanupOutputPath(sourcePath: string, hasVideo: boolean): string {
  const { ext } = getFileStemAndExt(sourcePath);
  const cleanExt = ext.toLowerCase();
  const outExt = hasVideo
    ? ["mp4", "mov", "mkv", "webm", "m4v"].includes(cleanExt)
      ? cleanExt
      : "mp4"
    : ["wav", "flac", "mp3", "m4a", "aac", "ogg", "opus", "aiff", "aif"].includes(cleanExt)
      ? cleanExt
      : "wav";
  return suggestMediaOutputPath(sourcePath, "_cleaned", outExt);
}

function formatLufs(val: number | null | undefined, isZh: boolean): string {
  if (val == null || !Number.isFinite(val)) return isZh ? "静音 / 无信号" : "Silence / N/A";
  return `${val.toFixed(1)} LUFS`;
}

function formatTruePeak(val: number | null | undefined): string {
  if (val == null || !Number.isFinite(val)) return "—";
  return `${val.toFixed(1)} dBTP`;
}

export function AudioCleanupWorkspace() {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const {
    mediaSession,
    updateAudioCleanupSession,
    startAudioCleanupTask,
    cancelAudioCleanupTask,
    handoffMediaFileToTool,
    pendingHandoff,
    consumePendingHandoff,
  } = useMediaSession();

  const state = mediaSession.audioCleanup;
  const running = state.taskStatus === "running";

  const [toolsStatus, setToolsStatus] = useState<MediaToolsStatus | null>(null);
  const [hovering, setHovering] = useState(false);
  const [loadingSource, setLoadingSource] = useState(false);
  const [auditionSide, setAuditionSide] = useState<"before" | "after">("after");
  const [isPlaying, setIsPlaying] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const resumePosRef = useRef<number | null>(null);
  const resumePlayRef = useRef(false);

  const audioTracks = state.probe?.audioStreams ?? [];
  const hasAudio = audioTracks.length > 0;
  const hasVideo = state.probe?.hasVideo ?? false;
  const durationSec = state.probe?.durationSec ?? 0;

  const loadSource = useCallback(
    async (filePath: string) => {
      if (running) return;
      setLoadingSource(true);
      setIsPlaying(false);
      updateAudioCleanupSession((prev) => ({
        ...prev,
        sourcePath: filePath,
        probe: null,
        audioTrackIndex: 0,
        preview: null,
        previewError: null,
        lastResult: null,
        errorMessage: null,
      }));
      try {
        const probe = await probeMediaInfo(filePath);
        const defaultIdx =
          probe.audioStreams.find((s) => s.isDefault)?.audioTrackIndex ??
          probe.audioStreams[0]?.audioTrackIndex ??
          0;
        const outPath = buildDefaultCleanupOutputPath(filePath, probe.hasVideo);
        updateAudioCleanupSession((prev) => ({
          ...prev,
          sourcePath: filePath,
          probe,
          audioTrackIndex: defaultIdx,
          removeSilence: probe.hasVideo ? false : prev.removeSilence,
          previewStartSec: 0,
          preview: null,
          previewError: null,
          outputPath: outPath,
          lastResult: null,
          errorMessage: null,
        }));
      } catch (err) {
        updateAudioCleanupSession((prev) => ({
          ...prev,
          errorMessage: formatLocalizedError(err, t),
        }));
      } finally {
        setLoadingSource(false);
      }
    },
    [running, t, updateAudioCleanupSession],
  );

  useEffect(() => {
    const handed = consumePendingHandoff("A01");
    if (handed) {
      void loadSource(handed);
    }
  }, [pendingHandoff, consumePendingHandoff, loadSource]);

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: setHovering,
          onDropPaths: (paths) => {
            if (paths.length > 0 && !running) {
              void loadSource(paths[0]!);
            }
          },
        }),
      "a01-file-drop",
    );
  }, [loadSource, running]);

  const handlePickSource = async () => {
    if (running) return;
    const picked = await pickSingleFile({
      title: isZh ? "选择音频或包含音轨的视频文件" : "Select Audio or Video File",
      filters: [{ name: isZh ? "音频 / 视频" : "Audio / Video", extensions: MEDIA_EXTENSIONS }],
    });
    if (picked) {
      await loadSource(picked);
    }
  };

  const handleGeneratePreview = async () => {
    if (!state.sourcePath || !hasAudio || running) return;
    setIsPlaying(false);
    audioRef.current?.pause();
    updateAudioCleanupSession((prev) => ({
      ...prev,
      previewLoading: true,
      previewError: null,
    }));
    try {
      const res = await previewAudioCleanup({
        sourcePath: state.sourcePath,
        startSec: Math.max(0, state.previewStartSec),
        durationSec: 12,
        options: {
          audioTrackIndex: state.audioTrackIndex,
          denoiseLevel: state.denoiseLevel,
          highpassRumble: state.highpassRumble,
          normalizeLoudness: state.normalizeLoudness,
          targetLufs: state.targetLufs,
          removeSilence: hasVideo ? false : state.removeSilence,
        },
      });
      setAuditionSide("after");
      updateAudioCleanupSession((prev) => ({
        ...prev,
        preview: res,
        previewLoading: false,
        previewError: null,
      }));
    } catch (err) {
      updateAudioCleanupSession((prev) => ({
        ...prev,
        previewLoading: false,
        previewError: formatLocalizedError(err, t),
      }));
    }
  };

  const handleSwitchAuditionSide = (nextSide: "before" | "after") => {
    if (nextSide === auditionSide) return;
    const el = audioRef.current;
    if (el) {
      resumePosRef.current = el.currentTime;
      resumePlayRef.current = !el.paused;
    }
    setAuditionSide(nextSide);
  };

  const activePreviewUrl = useMemo(() => {
    if (!state.preview) return null;
    return auditionSide === "before" ? state.preview.beforeUrl : state.preview.afterUrl;
  }, [state.preview, auditionSide]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el || !activePreviewUrl) return;
    const targetTime = resumePosRef.current;
    const shouldPlay = resumePlayRef.current;
    resumePosRef.current = null;
    resumePlayRef.current = false;

    const onLoaded = () => {
      if (targetTime != null && Number.isFinite(targetTime)) {
        try {
          el.currentTime = Math.min(
            targetTime,
            Number.isFinite(el.duration) ? el.duration : targetTime,
          );
        } catch {
          // ignore
        }
      }
      if (shouldPlay) {
        void el.play().catch(() => {});
      }
    };
    el.addEventListener("loadedmetadata", onLoaded, { once: true });
    el.load();
    return () => el.removeEventListener("loadedmetadata", onLoaded);
  }, [activePreviewUrl]);

  const handleTogglePlay = async () => {
    const el = audioRef.current;
    if (!el || !activePreviewUrl) return;
    if (!el.paused) {
      el.pause();
      setIsPlaying(false);
    } else {
      try {
        await el.play();
        setIsPlaying(true);
      } catch {
        setIsPlaying(false);
      }
    }
  };

  const handlePickOutput = async () => {
    if (!state.sourcePath) return;
    const { ext } = getFileStemAndExt(state.outputPath || state.sourcePath);
    const chosen = await pickSaveFilePath({
      title: isZh ? "选择降噪后保存路径" : "Save Cleaned Output As",
      defaultPath: state.outputPath || buildDefaultCleanupOutputPath(state.sourcePath, hasVideo),
      filters: ext
        ? [{ name: ext.toUpperCase(), extensions: [ext.toLowerCase()] }]
        : [{ name: "WAV", extensions: ["wav"] }],
    });
    if (chosen) {
      updateAudioCleanupSession((prev) => ({ ...prev, outputPath: chosen, lastResult: null }));
    }
  };

  const canExport =
    !running &&
    !loadingSource &&
    (toolsStatus?.ready ?? true) &&
    !!state.sourcePath &&
    hasAudio &&
    state.outputPath.trim().length > 0;

  const handleExport = async () => {
    if (!canExport || !state.sourcePath) return;
    await startAudioCleanupTask(
      {
        sourcePath: state.sourcePath,
        outputPath: state.outputPath.trim(),
        options: {
          audioTrackIndex: state.audioTrackIndex,
          denoiseLevel: state.denoiseLevel,
          highpassRumble: state.highpassRumble,
          normalizeLoudness: state.normalizeLoudness,
          targetLufs: state.targetLufs,
          removeSilence: hasVideo ? false : state.removeSilence,
        },
        allowOverwrite: true,
      },
      (err) => formatLocalizedError(err, t),
    );
  };

  const denoiseChoices: { value: AudioDenoiseLevel; zh: string; en: string }[] = [
    { value: "off", zh: "关闭", en: "Off" },
    { value: "light", zh: "轻度", en: "Light" },
    { value: "medium", zh: "中度", en: "Medium" },
    { value: "strong", zh: "强力", en: "Strong" },
  ];

  const invalidatePreview = () => {
    setIsPlaying(false);
    audioRef.current?.pause();
  };

  return (
    <div className="media-workspace">
      <MediaToolsSetupPanel onStatusChange={setToolsStatus} />

      <section className="media-section-card">
        <div className="media-section-header">
          <div>
            <h2
              className="media-section-title"
              style={{ justifyContent: "flex-start", gap: "8px", margin: 0 }}
            >
              <SlidersHorizontal size={16} aria-hidden="true" />
              <span>{isZh ? "音频降噪与人声增强" : "Clean Up Audio"}</span>
            </h2>
            <p className="field-hint" style={{ margin: "4px 0 0" }}>
              {isZh
                ? "本地降噪（轻/中/强）、可选低频隆隆声/哼声过滤、EBU R128 两遍响度标准化（默认 -16 LUFS）与同片段处理前/后试听；视频输入默认直接复制视频流并保留其余音轨。"
                : "Offline denoise (Light/Medium/Strong), optional rumble/hum filter, 2-pass EBU R128 loudness normalization (default -16 LUFS), and same-segment Before/After audition. Videos stream-copy video and preserve extra tracks."}
            </p>
          </div>
          <div className="media-actions-row">
            <button
              type="button"
              className="btn"
              disabled={running}
              onClick={() => void handlePickSource()}
            >
              <Upload size={14} aria-hidden="true" />
              <span>
                {state.sourcePath
                  ? isZh
                    ? "更换文件…"
                    : "Change File..."
                  : isZh
                    ? "选择音频或视频…"
                    : "Choose Audio/Video..."}
              </span>
            </button>
          </div>
        </div>

        {!state.sourcePath ? (
          <div className={`media-dropzone ${hovering ? "is-hover" : ""}`}>
            <p style={{ margin: 0, fontWeight: 600 }}>
              {isZh
                ? "拖入需要降噪或响度标准化的音频或视频文件"
                : "Drop an audio or video file to clean up its audio"}
            </p>
            <p className="field-hint" style={{ margin: 0 }}>
              {isZh
                ? "支持 WAV / MP3 / M4A / FLAC / AIFF / OGG 与 MP4 / MOV / MKV / WebM。"
                : "Supports WAV, MP3, M4A, FLAC, AIFF, OGG, and MP4, MOV, MKV, WebM."}
            </p>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!(toolsStatus?.ready ?? true)}
              onClick={() => void handlePickSource()}
            >
              <Upload size={15} aria-hidden="true" />
              <span>{isZh ? "选择文件" : "Select File"}</span>
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "14px", marginTop: "12px" }}>
            <div className="media-summary-card">
              <div className="media-section-header" style={{ gap: "8px", flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <strong style={{ wordBreak: "break-all" }}>
                    {state.probe?.fileName ?? state.sourcePath}
                  </strong>
                  <div className="field-hint" style={{ marginTop: "2px", fontSize: "12px" }}>
                    {loadingSource
                      ? isZh
                        ? "正在读取媒体信息…"
                        : "Probing media..."
                      : state.probe
                        ? `${hasVideo ? (isZh ? "视频文件（视频流无损直拷贝）" : "Video (stream-copy video)") : isZh ? "纯音频文件" : "Audio only"} · ${formatDurationLabel(state.probe.durationSec, locale)} · ${audioTracks.length} ${isZh ? "条音轨" : "audio track(s)"}`
                        : ""}
                  </div>
                </div>
                {hasVideo && audioTracks.length > 1 && (
                  <span className="media-status-pill is-ok">
                    {isZh
                      ? `其余 ${audioTracks.length - 1} 条音轨将原样保留`
                      : `${audioTracks.length - 1} other track(s) preserved untouched`}
                  </span>
                )}
              </div>
            </div>

            {state.probe && !hasAudio && (
              <div className="inline-alert inline-alert-error" role="alert">
                {isZh
                  ? "该文件不含任何音轨，无法执行音频降噪或响度标准化。"
                  : "This file contains no audio tracks to clean up."}
              </div>
            )}

            {hasAudio && audioTracks.length > 1 && (
              <div>
                <label className="field-label" htmlFor="a01-track-select">
                  {isZh ? "选择需要处理的音轨" : "Audio Track to Process"}
                </label>
                <select
                  id="a01-track-select"
                  className="text-input"
                  style={{ width: "100%", marginTop: "6px" }}
                  value={state.audioTrackIndex}
                  disabled={running}
                  onChange={(e) => {
                    invalidatePreview();
                    updateAudioCleanupSession((prev) => ({
                      ...prev,
                      audioTrackIndex: Number(e.target.value),
                      preview: null,
                      lastResult: null,
                    }));
                  }}
                >
                  {audioTracks.map((tr) => (
                    <option key={tr.audioTrackIndex} value={tr.audioTrackIndex}>
                      {isZh
                        ? `音轨 #${tr.audioTrackIndex + 1} · ${formatLanguageName(tr.language, locale)} · ${tr.codecName ?? "audio"} · ${tr.channels ?? "?"}ch`
                        : `Track #${tr.audioTrackIndex + 1} · ${formatLanguageName(tr.language, locale)} · ${tr.codecName ?? "audio"} · ${tr.channels ?? "?"}ch`}
                      {tr.title ? ` (${tr.title})` : ""}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Processing options */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                gap: "12px",
              }}
            >
              <div
                className="media-summary-card"
                style={{ display: "flex", flexDirection: "column", gap: "10px" }}
              >
                <strong style={{ fontSize: "13px" }}>
                  {isZh ? "降噪与低频杂音过滤" : "Denoise & Rumble Filter"}
                </strong>
                <div>
                  <span className="field-label" style={{ display: "block", marginBottom: "6px" }}>
                    {isZh ? "背景降噪强度" : "Background Denoise"}
                  </span>
                  <div
                    className="segmented"
                    style={{ display: "flex", width: "100%" }}
                    role="radiogroup"
                    aria-label={isZh ? "降噪强度" : "Denoise level"}
                  >
                    {denoiseChoices.map((choice) => (
                      <button
                        key={choice.value}
                        type="button"
                        role="radio"
                        aria-checked={state.denoiseLevel === choice.value}
                        style={{ flex: 1 }}
                        className={`segmented-btn ${state.denoiseLevel === choice.value ? "is-selected" : ""}`}
                        disabled={running}
                        onClick={() => {
                          invalidatePreview();
                          updateAudioCleanupSession((prev) => ({
                            ...prev,
                            denoiseLevel: choice.value,
                            preview: null,
                            lastResult: null,
                          }));
                        }}
                      >
                        {isZh ? choice.zh : choice.en}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={state.highpassRumble}
                    disabled={running}
                    onChange={(e) => {
                      invalidatePreview();
                      updateAudioCleanupSession((prev) => ({
                        ...prev,
                        highpassRumble: e.target.checked,
                        preview: null,
                        lastResult: null,
                      }));
                    }}
                  />
                  <span>
                    {isZh
                      ? "过滤低频隆隆声与 50/60 Hz 交流电哼声"
                      : "High-pass low-frequency rumble & 50/60 Hz hum"}
                  </span>
                </label>
              </div>

              <div
                className="media-summary-card"
                style={{ display: "flex", flexDirection: "column", gap: "10px" }}
              >
                <strong style={{ fontSize: "13px" }}>
                  {isZh ? "响度标准化与静默裁剪" : "Loudness & Silence"}
                </strong>

                <div className="media-actions-row">
                  <label className="checkbox-row" style={{ flex: 1 }}>
                    <input
                      type="checkbox"
                      checked={state.normalizeLoudness}
                      disabled={running}
                      onChange={(e) => {
                        invalidatePreview();
                        updateAudioCleanupSession((prev) => ({
                          ...prev,
                          normalizeLoudness: e.target.checked,
                          preview: null,
                          lastResult: null,
                        }));
                      }}
                    />
                    <span>{isZh ? "EBU R128 两遍响度标准化" : "2-Pass EBU R128 Loudness"}</span>
                  </label>
                  <input
                    id="a01-target-lufs"
                    aria-label={isZh ? "目标响度 (LUFS)" : "Target LUFS"}
                    type="number"
                    className="text-input"
                    style={{ width: "84px" }}
                    min={-28}
                    max={-8}
                    step={0.5}
                    value={state.targetLufs}
                    disabled={running || !state.normalizeLoudness}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v)) {
                        invalidatePreview();
                        updateAudioCleanupSession((prev) => ({
                          ...prev,
                          targetLufs: Math.max(-28, Math.min(-8, v)),
                          preview: null,
                          lastResult: null,
                        }));
                      }
                    }}
                  />
                  <span className="field-hint" style={{ fontSize: "12px" }}>
                    LUFS
                  </span>
                </div>

                <div>
                  <label className="checkbox-row">
                    <input
                      id="a01-remove-silence"
                      type="checkbox"
                      checked={hasVideo ? false : state.removeSilence}
                      disabled={running || hasVideo}
                      onChange={(e) => {
                        invalidatePreview();
                        updateAudioCleanupSession((prev) => ({
                          ...prev,
                          removeSilence: e.target.checked,
                          preview: null,
                          lastResult: null,
                        }));
                      }}
                    />
                    <span>
                      {isZh
                        ? "裁剪超长静默片段（仅纯音频可用）"
                        : "Trim long silent pauses (audio-only)"}
                    </span>
                  </label>
                  {hasVideo && (
                    <div className="field-hint" style={{ fontSize: "11.5px", marginTop: "4px" }}>
                      {isZh
                        ? "当前为视频文件，已禁用静默裁剪以保证音画严格同步。"
                        : "Disabled for video inputs so A/V timing remains strictly synchronized."}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Same-segment Before / After Audition */}
            {hasAudio && (
              <div
                className="media-summary-card"
                style={{ display: "flex", flexDirection: "column", gap: "10px" }}
              >
                <div className="media-section-header" style={{ flexWrap: "wrap", gap: "8px" }}>
                  <strong
                    style={{ fontSize: "13px", display: "flex", alignItems: "center", gap: "6px" }}
                  >
                    <Volume2 size={15} aria-hidden="true" />
                    <span>
                      {isZh
                        ? "同片段处理前 / 处理后对比试听"
                        : "Same-Segment Before / After Audition"}
                    </span>
                  </strong>
                  <div className="media-actions-row">
                    <label
                      className="field-hint"
                      htmlFor="a01-preview-start"
                      style={{ fontSize: "12px" }}
                    >
                      {isZh ? "试听起点 (s)" : "Start (s)"}
                    </label>
                    <input
                      id="a01-preview-start"
                      type="number"
                      className="text-input"
                      style={{ width: "80px" }}
                      min={0}
                      max={Math.max(0, Math.floor(durationSec))}
                      step={0.5}
                      value={state.previewStartSec}
                      disabled={running || state.previewLoading}
                      onChange={(e) => {
                        const v = Math.max(0, Number(e.target.value) || 0);
                        updateAudioCleanupSession((prev) => ({
                          ...prev,
                          previewStartSec: v,
                        }));
                      }}
                    />
                    <button
                      type="button"
                      className="btn"
                      disabled={running || state.previewLoading}
                      onClick={() => void handleGeneratePreview()}
                    >
                      <RefreshCw size={14} aria-hidden="true" />
                      <span>
                        {state.previewLoading
                          ? isZh
                            ? "正在生成对比片段…"
                            : "Rendering Preview..."
                          : isZh
                            ? "生成对比试听"
                            : "Render Before/After Preview"}
                      </span>
                    </button>
                  </div>
                </div>

                {state.previewError && (
                  <div className="inline-alert inline-alert-error" role="alert">
                    {state.previewError}
                  </div>
                )}

                {state.preview && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <div className="media-actions-row" style={{ flexWrap: "wrap" }}>
                      <div
                        className="segmented"
                        role="tablist"
                        aria-label={isZh ? "对比试听切换" : "Before or After"}
                      >
                        <button
                          type="button"
                          role="tab"
                          aria-selected={auditionSide === "before"}
                          className={`segmented-btn ${auditionSide === "before" ? "is-selected" : ""}`}
                          onClick={() => handleSwitchAuditionSide("before")}
                        >
                          {isZh ? "处理前 (原声)" : "Before (Original)"}
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={auditionSide === "after"}
                          className={`segmented-btn ${auditionSide === "after" ? "is-selected" : ""}`}
                          onClick={() => handleSwitchAuditionSide("after")}
                        >
                          {isZh ? "处理后 (降噪+标准化)" : "After (Cleaned)"}
                        </button>
                      </div>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => void handleTogglePlay()}
                      >
                        {isPlaying ? (
                          <Pause size={14} aria-hidden="true" />
                        ) : (
                          <Play size={14} aria-hidden="true" />
                        )}
                        <span>
                          {isPlaying
                            ? isZh
                              ? "暂停"
                              : "Pause"
                            : isZh
                              ? "播放当前切换"
                              : "Play Selected"}
                        </span>
                      </button>
                      <span className="field-hint mono" style={{ fontSize: "12px" }}>
                        {isZh
                          ? `处理前: ${formatLufs(state.preview.beforeLufs, isZh)} (${formatTruePeak(state.preview.beforeTruePeakDb)}) → 处理后: ${formatLufs(state.preview.afterLufs, isZh)} (${formatTruePeak(state.preview.afterTruePeakDb)})`
                          : `Before: ${formatLufs(state.preview.beforeLufs, isZh)} (${formatTruePeak(state.preview.beforeTruePeakDb)}) → After: ${formatLufs(state.preview.afterLufs, isZh)} (${formatTruePeak(state.preview.afterTruePeakDb)})`}
                      </span>
                    </div>
                    {state.preview.isAllSilence && (
                      <div className="field-hint" style={{ fontSize: "12px" }}>
                        {isZh
                          ? "检测到该片段接近全静音，响度标准化已自动跳过以避免放大底噪。"
                          : "Near-silence segment detected; loudness gain was skipped to avoid amplifying noise floor."}
                      </div>
                    )}
                    <audio
                      ref={audioRef}
                      src={activePreviewUrl ?? undefined}
                      controls
                      style={{ width: "100%", height: "36px" }}
                      onPlay={() => setIsPlaying(true)}
                      onPause={() => setIsPlaying(false)}
                      onEnded={() => setIsPlaying(false)}
                    />
                  </div>
                )}
              </div>
            )}

            {/* Output path & export */}
            <div>
              <label className="field-label" htmlFor="a01-output-path">
                {isZh ? "输出文件（绝不覆盖源文件）" : "Output File (Never Overwrites Source)"}
              </label>
              <div className="media-actions-row" style={{ marginTop: "6px" }}>
                <input
                  id="a01-output-path"
                  type="text"
                  className="text-input"
                  style={{ flex: 1 }}
                  value={state.outputPath}
                  disabled={running}
                  onChange={(e) =>
                    updateAudioCleanupSession((prev) => ({ ...prev, outputPath: e.target.value }))
                  }
                />
                <button
                  type="button"
                  className="btn"
                  disabled={running}
                  onClick={() => void handlePickOutput()}
                >
                  <Save size={14} aria-hidden="true" />
                  <span>{isZh ? "另存为…" : "Save As..."}</span>
                </button>
              </div>
            </div>

            <div className="media-actions-row">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canExport}
                onClick={() => void handleExport()}
              >
                <SlidersHorizontal size={15} aria-hidden="true" />
                <span>
                  {running
                    ? isZh
                      ? "正在降噪与标准化…"
                      : "Cleaning Up Audio..."
                    : isZh
                      ? "开始降噪并导出"
                      : "Clean Up & Export"}
                </span>
              </button>
              {running && (
                <button type="button" className="btn" onClick={() => void cancelAudioCleanupTask()}>
                  {isZh ? "取消任务" : "Cancel"}
                </button>
              )}
            </div>

            {running && state.liveProgress && (
              <div className="media-progress-panel">
                <div className="media-progress-header">
                  <span>
                    {state.liveProgress.phase === "analyzing"
                      ? isZh
                        ? "第 1 遍：正在测量整体响度 (EBU R128)…"
                        : "Pass 1: Measuring integrated loudness (EBU R128)..."
                      : isZh
                        ? "第 2 遍：正在应用降噪与标准化并写出…"
                        : "Pass 2: Applying cleanup & loudness normalization..."}
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

            {state.lastResult && (
              <div className="media-result-card">
                <div className="media-section-header" style={{ flexWrap: "wrap", gap: "8px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <CheckCircle2 size={18} aria-hidden="true" />
                    <strong>
                      {isZh
                        ? `处理完成：${formatMediaBytes(state.lastResult.byteSize, locale)} · ${formatLufs(state.lastResult.measuredBeforeLufs, isZh)} → ${formatLufs(state.lastResult.measuredAfterLufs, isZh)}`
                        : `Cleaned: ${formatMediaBytes(state.lastResult.byteSize, locale)} · ${formatLufs(state.lastResult.measuredBeforeLufs, isZh)} → ${formatLufs(state.lastResult.measuredAfterLufs, isZh)}`}
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
                    {!state.lastResult.hasVideo && (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => handoffMediaFileToTool("V14", state.lastResult!.outputPath)}
                      >
                        <span>{isZh ? "用于视频换音轨 (V14)" : "Use in Replace Audio (V14)"}</span>
                      </button>
                    )}
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
                <div className="field-hint" style={{ fontSize: "12px", marginTop: "6px" }}>
                  {state.lastResult.isAllSilence
                    ? isZh
                      ? "全静音提示：输入接近全静音，已按安全策略保留静音且未放大底噪。"
                      : "All-silence note: near-silent input preserved safely without amplifying noise."
                    : isZh
                      ? `真实峰值：${formatTruePeak(state.lastResult.measuredBeforeTruePeakDb)} → ${formatTruePeak(state.lastResult.measuredAfterTruePeakDb)}${state.lastResult.videoStreamCopied ? " · 视频流无损拷贝" : ""}${state.lastResult.preservedOtherTracks > 0 ? ` · 保留其余 ${state.lastResult.preservedOtherTracks} 条音轨` : ""}`
                      : `True peak: ${formatTruePeak(state.lastResult.measuredBeforeTruePeakDb)} → ${formatTruePeak(state.lastResult.measuredAfterTruePeakDb)}${state.lastResult.videoStreamCopied ? " · Video stream copied" : ""}${state.lastResult.preservedOtherTracks > 0 ? ` · ${state.lastResult.preservedOtherTracks} other track(s) preserved` : ""}`}
                </div>
                <div
                  className="field-hint"
                  style={{ fontSize: "12px", marginTop: "4px", wordBreak: "break-all" }}
                >
                  {state.lastResult.outputPath}
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
