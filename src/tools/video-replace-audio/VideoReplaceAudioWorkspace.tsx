import {
  CheckCircle2,
  Film,
  FolderOpen,
  Info,
  Pause,
  Play,
  RefreshCw,
  Save,
  Upload,
  Volume2,
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
  pickSaveFilePath,
  pickSingleFile,
  previewReplaceAudio,
  probeMediaInfo,
  registerMediaPreviewPath,
  subscribeFileDrop,
  type MediaToolsStatus,
  type ReplaceAudioMode,
  type ShortAudioBehavior,
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

const VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "webm", "avi", "m4v", "ts", "flv"];
const AUDIO_OR_VIDEO_EXTENSIONS = [
  "wav",
  "mp3",
  "m4a",
  "flac",
  "aiff",
  "aif",
  "ogg",
  "opus",
  "aac",
  ...VIDEO_EXTENSIONS,
];

function buildDefaultReplaceOutputPath(videoPath: string): string {
  const { ext } = getFileStemAndExt(videoPath);
  const cleanExt = ext.toLowerCase();
  const outExt = ["mp4", "mov", "mkv", "webm", "m4v"].includes(cleanExt) ? cleanExt : "mp4";
  return suggestMediaOutputPath(videoPath, "_audio", outExt);
}

export function VideoReplaceAudioWorkspace() {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const {
    mediaSession,
    updateVideoReplaceAudioSession,
    startVideoReplaceAudioTask,
    cancelVideoReplaceAudioTask,
    handoffMediaFileToTool,
    pendingHandoff,
    consumePendingHandoff,
  } = useMediaSession();

  const state = mediaSession.videoReplaceAudio;
  const running = state.taskStatus === "running";

  const [toolsStatus, setToolsStatus] = useState<MediaToolsStatus | null>(null);
  const [hovering, setHovering] = useState(false);
  const [loadingVideo, setLoadingVideo] = useState(false);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [isPlayingMix, setIsPlayingMix] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mixAudioRef = useRef<HTMLAudioElement | null>(null);

  const targetHasAudio = (state.videoProbe?.audioStreams.length ?? 0) > 0;
  const donorAudioTracks = state.audioProbe?.audioStreams ?? [];
  const donorHasAudio = donorAudioTracks.length > 0;
  const targetDuration = state.videoProbe?.durationSec ?? null;
  const donorDuration = state.audioProbe?.durationSec ?? null;

  const loadTargetVideo = useCallback(
    async (filePath: string) => {
      if (running) return;
      setLoadingVideo(true);
      setIsPlayingMix(false);
      updateVideoReplaceAudioSession((prev) => ({
        ...prev,
        videoPath: filePath,
        videoProbe: null,
        videoPreviewUrl: null,
        videoPosterUrl: null,
        preview: null,
        previewError: null,
        lastResult: null,
        errorMessage: null,
      }));
      try {
        const probe = await probeMediaInfo(filePath);
        if (!probe.hasVideo) {
          throw new Error(
            isZh ? "所选目标文件不包含视频画面流。" : "Selected target file has no video stream.",
          );
        }
        const [reg, poster] = await Promise.all([
          registerMediaPreviewPath(filePath).catch(() => null),
          extractMediaPosterDataUrl(filePath, 0.2).catch(() => null),
        ]);
        updateVideoReplaceAudioSession((prev) => ({
          ...prev,
          videoPath: filePath,
          videoProbe: probe,
          videoPreviewUrl: reg?.url ?? null,
          videoPosterUrl: poster,
          outputPath: buildDefaultReplaceOutputPath(filePath),
          preview: null,
          previewError: null,
          lastResult: null,
          errorMessage: null,
        }));
      } catch (err) {
        updateVideoReplaceAudioSession((prev) => ({
          ...prev,
          errorMessage: formatLocalizedError(err, t),
        }));
      } finally {
        setLoadingVideo(false);
      }
    },
    [isZh, running, t, updateVideoReplaceAudioSession],
  );

  const loadAudioSource = useCallback(
    async (filePath: string) => {
      if (running) return;
      setLoadingAudio(true);
      setIsPlayingMix(false);
      updateVideoReplaceAudioSession((prev) => ({
        ...prev,
        audioSourcePath: filePath,
        audioProbe: null,
        audioSourceTrackIndex: 0,
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
        updateVideoReplaceAudioSession((prev) => ({
          ...prev,
          audioSourcePath: filePath,
          audioProbe: probe,
          audioSourceTrackIndex: defaultIdx,
          preview: null,
          previewError: null,
          lastResult: null,
          errorMessage: null,
        }));
      } catch (err) {
        updateVideoReplaceAudioSession((prev) => ({
          ...prev,
          errorMessage: formatLocalizedError(err, t),
        }));
      } finally {
        setLoadingAudio(false);
      }
    },
    [running, t, updateVideoReplaceAudioSession],
  );

  useEffect(() => {
    const handed = consumePendingHandoff("V14");
    if (!handed) return;
    void (async () => {
      try {
        const probe = await probeMediaInfo(handed);
        if (probe.hasVideo && !state.videoPath) {
          await loadTargetVideo(handed);
        } else if (!probe.hasVideo && probe.hasAudio) {
          await loadAudioSource(handed);
        } else if (probe.hasVideo) {
          await loadTargetVideo(handed);
        }
      } catch (err) {
        updateVideoReplaceAudioSession((prev) => ({
          ...prev,
          errorMessage: formatLocalizedError(err, t),
        }));
      }
    })();
  }, [
    pendingHandoff,
    consumePendingHandoff,
    loadTargetVideo,
    loadAudioSource,
    state.videoPath,
    t,
    updateVideoReplaceAudioSession,
  ]);

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: setHovering,
          onDropPaths: (paths) => {
            if (paths.length === 0 || running) return;
            const first = paths[0]!;
            const ext = getFileStemAndExt(first).ext.toLowerCase();
            if (!state.videoPath && VIDEO_EXTENSIONS.includes(ext)) {
              void loadTargetVideo(first);
            } else {
              void loadAudioSource(first);
            }
          },
        }),
      "v14-file-drop",
    );
  }, [loadAudioSource, loadTargetVideo, running, state.videoPath]);

  const handlePickVideo = async () => {
    if (running) return;
    const picked = await pickSingleFile({
      title: isZh ? "选择目标视频文件" : "Select Target Video",
      filters: [{ name: isZh ? "视频文件" : "Video Files", extensions: VIDEO_EXTENSIONS }],
    });
    if (picked) await loadTargetVideo(picked);
  };

  const handlePickAudioSource = async () => {
    if (running) return;
    const picked = await pickSingleFile({
      title: isZh ? "选择新音频文件或含音轨的视频" : "Select Audio File or Donor Video",
      filters: [
        {
          name: isZh ? "音频或视频文件" : "Audio or Video Files",
          extensions: AUDIO_OR_VIDEO_EXTENSIONS,
        },
      ],
    });
    if (picked) await loadAudioSource(picked);
  };

  const handleRenderMixPreview = async () => {
    if (!state.videoPath || !state.audioSourcePath || !donorHasAudio || running) return;
    setIsPlayingMix(false);
    videoRef.current?.pause();
    mixAudioRef.current?.pause();
    updateVideoReplaceAudioSession((prev) => ({
      ...prev,
      previewLoading: true,
      previewError: null,
    }));
    try {
      const res = await previewReplaceAudio({
        options: {
          videoPath: state.videoPath,
          audioSourcePath: state.audioSourcePath,
          audioSourceTrackIndex: state.audioSourceTrackIndex,
          mode: targetHasAudio ? state.mode : "replace",
          originalVolume: state.originalVolume,
          newAudioVolume: state.newAudioVolume,
          shortAudioBehavior: state.shortAudioBehavior,
        },
        startSec: 0,
        maxDurationSec: 20,
      });
      updateVideoReplaceAudioSession((prev) => ({
        ...prev,
        preview: res,
        previewLoading: false,
        previewError: null,
      }));
    } catch (err) {
      updateVideoReplaceAudioSession((prev) => ({
        ...prev,
        previewLoading: false,
        previewError: formatLocalizedError(err, t),
      }));
    }
  };

  const handleToggleSyncedAudition = async () => {
    const a = mixAudioRef.current;
    const v = videoRef.current;
    if (!a || !state.preview) return;
    if (!a.paused) {
      a.pause();
      v?.pause();
      setIsPlayingMix(false);
    } else {
      try {
        if (v) {
          v.muted = true;
          v.currentTime = a.currentTime;
          void v.play().catch(() => {});
        }
        await a.play();
        setIsPlayingMix(true);
      } catch {
        setIsPlayingMix(false);
      }
    }
  };

  const handlePickOutput = async () => {
    if (!state.videoPath) return;
    const { ext } = getFileStemAndExt(state.outputPath || state.videoPath);
    const chosen = await pickSaveFilePath({
      title: isZh ? "选择输出视频路径" : "Save Video With New Audio As",
      defaultPath: state.outputPath || buildDefaultReplaceOutputPath(state.videoPath),
      filters: [{ name: (ext || "mp4").toUpperCase(), extensions: [(ext || "mp4").toLowerCase()] }],
    });
    if (chosen) {
      updateVideoReplaceAudioSession((prev) => ({ ...prev, outputPath: chosen, lastResult: null }));
    }
  };

  const canExport =
    !running &&
    !loadingVideo &&
    !loadingAudio &&
    (toolsStatus?.ready ?? true) &&
    !!state.videoPath &&
    !!state.videoProbe?.hasVideo &&
    !!state.audioSourcePath &&
    donorHasAudio &&
    state.outputPath.trim().length > 0;

  const handleExport = async () => {
    if (!canExport || !state.videoPath || !state.audioSourcePath) return;
    await startVideoReplaceAudioTask(
      {
        options: {
          videoPath: state.videoPath,
          audioSourcePath: state.audioSourcePath,
          audioSourceTrackIndex: state.audioSourceTrackIndex,
          mode: targetHasAudio ? state.mode : "replace",
          originalVolume: state.originalVolume,
          newAudioVolume: state.newAudioVolume,
          shortAudioBehavior: state.shortAudioBehavior,
        },
        outputPath: state.outputPath.trim(),
        allowOverwrite: true,
      },
      (err) => formatLocalizedError(err, t),
    );
  };

  const invalidatePreview = () => {
    setIsPlayingMix(false);
    mixAudioRef.current?.pause();
    videoRef.current?.pause();
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
              <Volume2 size={16} aria-hidden="true" />
              <span>{isZh ? "替换视频音频与配音混音" : "Replace & Mix Video Audio"}</span>
            </h2>
            <p className="field-hint" style={{ margin: "4px 0 0" }}>
              {isZh
                ? "用本地音频文件或另一段视频的音轨替换/混合目标视频原声，独立调节原声与新音频音量、控制短音频循环铺满或单次播放，输出时长严格以目标视频为准。"
                : "Replace or mix a video's audio using an audio file or another video's audio track with independent volumes, Loop-to-Fill vs Play-Once behavior, and live pre-export mix audition."}
            </p>
          </div>
        </div>

        {/* Two source cards */}
        <div
          className={hovering ? "media-dropzone is-hover" : ""}
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: "12px",
            marginTop: "12px",
            padding: hovering ? "10px" : 0,
            borderStyle: hovering ? "dashed" : "none",
          }}
        >
          {/* Slot 1: Target Video */}
          <div
            className="media-summary-card"
            style={{ display: "flex", flexDirection: "column", gap: "8px" }}
          >
            <div className="media-section-header">
              <strong
                style={{ fontSize: "13px", display: "flex", alignItems: "center", gap: "6px" }}
              >
                <Film size={15} aria-hidden="true" />
                <span>{isZh ? "1. 目标视频" : "1. Target Video"}</span>
              </strong>
              <button
                type="button"
                className="btn"
                disabled={running}
                onClick={() => void handlePickVideo()}
              >
                <Upload size={13} aria-hidden="true" />
                <span>
                  {state.videoPath ? (isZh ? "更换" : "Change") : isZh ? "选择视频…" : "Choose..."}
                </span>
              </button>
            </div>
            {state.videoPath ? (
              <>
                <div className="mono" style={{ fontSize: "12px", wordBreak: "break-all" }}>
                  {state.videoProbe?.fileName ?? state.videoPath}
                </div>
                <div className="field-hint" style={{ fontSize: "12px" }}>
                  {loadingVideo
                    ? isZh
                      ? "正在读取视频…"
                      : "Probing video..."
                    : state.videoProbe
                      ? `${formatDurationLabel(targetDuration, locale)} · ${targetHasAudio ? (isZh ? `含 ${state.videoProbe.audioStreams.length} 条原音轨` : `${state.videoProbe.audioStreams.length} original track(s)`) : isZh ? "无原音轨（支持直接配音）" : "Silent video (ready for audio)"}`
                      : ""}
                </div>
                {state.videoPreviewUrl ? (
                  <video
                    ref={videoRef}
                    src={state.videoPreviewUrl}
                    poster={state.videoPosterUrl ?? undefined}
                    muted
                    playsInline
                    controls={!state.preview}
                    style={{
                      width: "100%",
                      maxHeight: "170px",
                      borderRadius: "6px",
                      background: "#000",
                      objectFit: "contain",
                    }}
                  />
                ) : state.videoPosterUrl ? (
                  <img
                    src={state.videoPosterUrl}
                    alt=""
                    style={{
                      width: "100%",
                      maxHeight: "170px",
                      borderRadius: "6px",
                      objectFit: "contain",
                      background: "#000",
                    }}
                  />
                ) : null}
              </>
            ) : (
              <div className="field-hint" style={{ fontSize: "12px", padding: "12px 0" }}>
                {isZh
                  ? "请选择或拖入要替换/混音的目标视频。"
                  : "Select or drop the target video file."}
              </div>
            )}
          </div>

          {/* Slot 2: New Audio Source */}
          <div
            className="media-summary-card"
            style={{ display: "flex", flexDirection: "column", gap: "8px" }}
          >
            <div className="media-section-header">
              <strong
                style={{ fontSize: "13px", display: "flex", alignItems: "center", gap: "6px" }}
              >
                <Volume2 size={15} aria-hidden="true" />
                <span>{isZh ? "2. 新音频来源（音频或视频）" : "2. New Audio Source"}</span>
              </strong>
              <button
                type="button"
                className="btn"
                disabled={running}
                onClick={() => void handlePickAudioSource()}
              >
                <Upload size={13} aria-hidden="true" />
                <span>
                  {state.audioSourcePath
                    ? isZh
                      ? "更换"
                      : "Change"
                    : isZh
                      ? "选择音频/视频…"
                      : "Choose..."}
                </span>
              </button>
            </div>
            {state.audioSourcePath ? (
              <>
                <div className="mono" style={{ fontSize: "12px", wordBreak: "break-all" }}>
                  {state.audioProbe?.fileName ?? state.audioSourcePath}
                </div>
                <div className="field-hint" style={{ fontSize: "12px" }}>
                  {loadingAudio
                    ? isZh
                      ? "正在读取音频来源…"
                      : "Probing audio source..."
                    : state.audioProbe
                      ? `${state.audioProbe.hasVideo ? (isZh ? "来自视频音轨" : "From donor video") : isZh ? "音频文件" : "Audio file"} · ${formatDurationLabel(donorDuration, locale)} · ${donorAudioTracks.length} ${isZh ? "条音轨" : "track(s)"}`
                      : ""}
                </div>
                {state.audioProbe && !donorHasAudio && (
                  <div className="inline-alert inline-alert-error" role="alert">
                    {isZh
                      ? "所选音频来源不含任何音轨，请更换文件。"
                      : "Selected audio source has no audio streams."}
                  </div>
                )}
                {donorAudioTracks.length > 1 && (
                  <div>
                    <label className="field-label" htmlFor="v14-donor-track">
                      {isZh ? "选择来源音轨" : "Select Donor Audio Track"}
                    </label>
                    <select
                      id="v14-donor-track"
                      className="text-input"
                      style={{ width: "100%", marginTop: "4px" }}
                      value={state.audioSourceTrackIndex}
                      disabled={running}
                      onChange={(e) => {
                        invalidatePreview();
                        updateVideoReplaceAudioSession((prev) => ({
                          ...prev,
                          audioSourceTrackIndex: Number(e.target.value),
                          preview: null,
                          lastResult: null,
                        }));
                      }}
                    >
                      {donorAudioTracks.map((tr) => (
                        <option key={tr.audioTrackIndex} value={tr.audioTrackIndex}>
                          {isZh
                            ? `音轨 #${tr.audioTrackIndex + 1} · ${formatLanguageName(tr.language, locale)} · ${tr.codecName ?? "audio"}`
                            : `Track #${tr.audioTrackIndex + 1} · ${formatLanguageName(tr.language, locale)} · ${tr.codecName ?? "audio"}`}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {targetDuration != null && donorDuration != null && (
                  <div className="field-hint" style={{ fontSize: "12px" }}>
                    {donorDuration < targetDuration - 0.05
                      ? isZh
                        ? `新音频 (${formatDurationLabel(donorDuration, locale)}) 短于目标视频 (${formatDurationLabel(targetDuration, locale)})，将按下方短音频策略处理。`
                        : `New audio (${formatDurationLabel(donorDuration, locale)}) is shorter than target video (${formatDurationLabel(targetDuration, locale)}); handled by the setting below.`
                      : donorDuration > targetDuration + 0.05
                        ? isZh
                          ? `新音频长于目标视频，导出时将自动截断至目标视频时长 (${formatDurationLabel(targetDuration, locale)})。`
                          : `New audio is longer than target video and will be trimmed to video duration (${formatDurationLabel(targetDuration, locale)}).`
                        : isZh
                          ? "新音频与目标视频时长一致。"
                          : "New audio matches target video duration."}
                  </div>
                )}
              </>
            ) : (
              <div className="field-hint" style={{ fontSize: "12px", padding: "12px 0" }}>
                {isZh
                  ? "支持 WAV / MP3 / M4A / FLAC 等音频，或直接选择另一段视频提取其音轨。"
                  : "Pick any audio file (WAV, MP3, M4A, FLAC) or another video to pull its audio track."}
              </div>
            )}
          </div>
        </div>

        {/* Mix / Replace & Volume & Short Audio Controls */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: "12px",
            marginTop: "12px",
          }}
        >
          <div
            className="media-summary-card"
            style={{ display: "flex", flexDirection: "column", gap: "10px" }}
          >
            <strong style={{ fontSize: "13px" }}>
              {isZh ? "替换 / 混音与音量控制" : "Mode & Volume Balance"}
            </strong>
            <div
              className="segmented"
              style={{ display: "flex", width: "100%" }}
              role="radiogroup"
              aria-label={isZh ? "替换或混音模式" : "Replace or Mix Mode"}
            >
              {(
                [
                  { value: "replace" as ReplaceAudioMode, zh: "完全替换原声", en: "Replace Audio" },
                  {
                    value: "mix" as ReplaceAudioMode,
                    zh: "保留原声并混音",
                    en: "Mix With Original",
                  },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={state.mode === opt.value}
                  style={{ flex: 1 }}
                  className={`segmented-btn ${state.mode === opt.value ? "is-selected" : ""}`}
                  disabled={
                    running || (opt.value === "mix" && !!state.videoProbe && !targetHasAudio)
                  }
                  onClick={() => {
                    invalidatePreview();
                    updateVideoReplaceAudioSession((prev) => ({
                      ...prev,
                      mode: opt.value,
                      preview: null,
                      lastResult: null,
                    }));
                  }}
                >
                  {isZh ? opt.zh : opt.en}
                </button>
              ))}
            </div>

            {state.mode === "mix" && targetHasAudio && (
              <div>
                <div className="media-section-header" style={{ fontSize: "12px" }}>
                  <label htmlFor="v14-orig-vol">
                    {isZh ? "视频原声音量" : "Original Video Volume"}
                  </label>
                  <span className="mono">{Math.round(state.originalVolume * 100)}%</span>
                </div>
                <input
                  id="v14-orig-vol"
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={state.originalVolume}
                  disabled={running}
                  style={{ width: "100%" }}
                  onChange={(e) => {
                    invalidatePreview();
                    updateVideoReplaceAudioSession((prev) => ({
                      ...prev,
                      originalVolume: Number(e.target.value),
                      preview: null,
                      lastResult: null,
                    }));
                  }}
                />
              </div>
            )}

            <div>
              <div className="media-section-header" style={{ fontSize: "12px" }}>
                <label htmlFor="v14-new-vol">{isZh ? "新音频音量" : "New Audio Volume"}</label>
                <span className="mono">{Math.round(state.newAudioVolume * 100)}%</span>
              </div>
              <input
                id="v14-new-vol"
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={state.newAudioVolume}
                disabled={running}
                style={{ width: "100%" }}
                onChange={(e) => {
                  invalidatePreview();
                  updateVideoReplaceAudioSession((prev) => ({
                    ...prev,
                    newAudioVolume: Number(e.target.value),
                    preview: null,
                    lastResult: null,
                  }));
                }}
              />
            </div>
          </div>

          <div
            className="media-summary-card"
            style={{ display: "flex", flexDirection: "column", gap: "10px" }}
          >
            <strong style={{ fontSize: "13px" }}>
              {isZh ? "短音频处理策略" : "When New Audio Is Shorter"}
            </strong>
            <div
              className="segmented"
              style={{ display: "flex", width: "100%" }}
              role="radiogroup"
              aria-label={isZh ? "短音频策略" : "Short audio behavior"}
            >
              {(
                [
                  {
                    value: "loop_to_fill" as ShortAudioBehavior,
                    zh: "循环铺满视频时长",
                    en: "Loop to Fill",
                  },
                  { value: "play_once" as ShortAudioBehavior, zh: "仅播放一次", en: "Play Once" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={state.shortAudioBehavior === opt.value}
                  style={{ flex: 1 }}
                  className={`segmented-btn ${state.shortAudioBehavior === opt.value ? "is-selected" : ""}`}
                  disabled={running}
                  onClick={() => {
                    invalidatePreview();
                    updateVideoReplaceAudioSession((prev) => ({
                      ...prev,
                      shortAudioBehavior: opt.value,
                      preview: null,
                      lastResult: null,
                    }));
                  }}
                >
                  {isZh ? opt.zh : opt.en}
                </button>
              ))}
            </div>
            <div className="field-hint" style={{ fontSize: "12px" }}>
              {state.shortAudioBehavior === "loop_to_fill"
                ? isZh
                  ? "新音频将无缝循环重复，直至目标视频结束。"
                  : "Repeats the new audio cleanly until the end of the target video."
                : isZh
                  ? "新音频播放完毕后停止；混音模式保留原声且无音量跳变，替换模式余下时段为静音。"
                  : "Plays the new audio once; Mix keeps original audio steady with no volume jump, Replace pads trailing silence."}
            </div>

            {/* Live Pre-Export Mix Audition */}
            <div
              style={{
                borderTop: "1px solid var(--border-subtle)",
                paddingTop: "8px",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              <div className="media-actions-row">
                <button
                  type="button"
                  className="btn"
                  disabled={
                    !state.videoPath ||
                    !state.audioSourcePath ||
                    !donorHasAudio ||
                    running ||
                    state.previewLoading
                  }
                  onClick={() => void handleRenderMixPreview()}
                >
                  <RefreshCw size={14} aria-hidden="true" />
                  <span>
                    {state.previewLoading
                      ? isZh
                        ? "正在生成混音试听…"
                        : "Rendering Mix Preview..."
                      : isZh
                        ? "导出前试听混音效果"
                        : "Audition Mix Before Export"}
                  </span>
                </button>
                {state.preview && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void handleToggleSyncedAudition()}
                  >
                    {isPlayingMix ? (
                      <Pause size={14} aria-hidden="true" />
                    ) : (
                      <Play size={14} aria-hidden="true" />
                    )}
                    <span>
                      {isPlayingMix
                        ? isZh
                          ? "暂停试听"
                          : "Pause"
                        : isZh
                          ? "音画同步试听"
                          : "Play Synced"}
                    </span>
                  </button>
                )}
              </div>
              {state.previewError && (
                <div className="inline-alert inline-alert-error" role="alert">
                  {state.previewError}
                </div>
              )}
              {state.preview && (
                <audio
                  ref={mixAudioRef}
                  src={state.preview.previewUrl}
                  controls
                  style={{ width: "100%", height: "34px" }}
                  onPlay={() => {
                    setIsPlayingMix(true);
                    if (videoRef.current) {
                      videoRef.current.muted = true;
                      videoRef.current.currentTime = mixAudioRef.current?.currentTime ?? 0;
                      void videoRef.current.play().catch(() => {});
                    }
                  }}
                  onPause={() => {
                    setIsPlayingMix(false);
                    videoRef.current?.pause();
                  }}
                  onEnded={() => {
                    setIsPlayingMix(false);
                    videoRef.current?.pause();
                  }}
                />
              )}
            </div>
          </div>
        </div>

        {/* Output path & export */}
        <div style={{ marginTop: "14px" }}>
          <label className="field-label" htmlFor="v14-output-path">
            {isZh
              ? "输出视频文件（绝不覆盖源文件）"
              : "Output Video File (Never Overwrites Source)"}
          </label>
          <div className="media-actions-row" style={{ marginTop: "6px" }}>
            <input
              id="v14-output-path"
              type="text"
              className="text-input"
              style={{ flex: 1 }}
              value={state.outputPath}
              disabled={running}
              onChange={(e) =>
                updateVideoReplaceAudioSession((prev) => ({ ...prev, outputPath: e.target.value }))
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
        </div>

        <div className="media-actions-row" style={{ marginTop: "12px" }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canExport}
            onClick={() => void handleExport()}
          >
            <Volume2 size={15} aria-hidden="true" />
            <span>
              {running
                ? isZh
                  ? "正在合成音轨…"
                  : "Exporting Video..."
                : state.mode === "mix" && targetHasAudio
                  ? isZh
                    ? "导出混音视频"
                    : "Export Mixed Video"
                  : isZh
                    ? "导出替换音轨视频"
                    : "Export With New Audio"}
            </span>
          </button>
          {running && (
            <button
              type="button"
              className="btn"
              onClick={() => void cancelVideoReplaceAudioTask()}
            >
              {isZh ? "取消任务" : "Cancel"}
            </button>
          )}
        </div>

        {running && state.liveProgress && (
          <div className="media-progress-panel" style={{ marginTop: "10px" }}>
            <div className="media-progress-header">
              <span>{isZh ? "正在处理视频音轨…" : "Processing audio track..."}</span>
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
          <div
            className="inline-alert inline-alert-error"
            role="alert"
            style={{ marginTop: "10px" }}
          >
            {state.errorMessage}
          </div>
        )}

        {state.lastResult && (
          <div className="media-result-card" style={{ marginTop: "12px" }}>
            <div className="media-section-header" style={{ flexWrap: "wrap", gap: "8px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <CheckCircle2 size={18} aria-hidden="true" />
                <strong>
                  {isZh
                    ? `导出完成：${formatDurationLabel(state.lastResult.durationSec, locale)} · ${formatMediaBytes(state.lastResult.byteSize, locale)} · ${state.lastResult.videoStreamCopied ? "视频流无损拷贝" : "视频已重新封装"}`
                    : `Exported: ${formatDurationLabel(state.lastResult.durationSec, locale)} · ${formatMediaBytes(state.lastResult.byteSize, locale)} · ${state.lastResult.videoStreamCopied ? "Video stream copied" : "Video re-encoded"}`}
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
                  onClick={() => handoffMediaFileToTool("V02", state.lastResult!.outputPath)}
                >
                  <span>{isZh ? "烧录字幕 (V02)" : "Subtitles (V02)"}</span>
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
            <div
              className="field-hint"
              style={{ fontSize: "12px", marginTop: "4px", wordBreak: "break-all" }}
            >
              {state.lastResult.outputPath}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
