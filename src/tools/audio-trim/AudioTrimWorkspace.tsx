import {
  AudioWaveform,
  CheckCircle2,
  FilePlus2,
  FolderOpen,
  Info,
  Pause,
  Play,
  RotateCcw,
  Save,
  Scissors,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { MediaToolsSetupPanel } from "../../components/MediaToolsSetupPanel";
import { useI18n } from "../../i18n/I18nContext";
import { useMediaSession } from "../../lib/mediaSessionStore";
import {
  bindDisposableListener,
  extractAudioWaveform,
  formatLocalizedError,
  openLocalDirectory,
  pickSaveFilePath,
  pickSingleFile,
  probeMediaInfo,
  subscribeFileDrop,
  type MediaToolsStatus,
} from "../../lib/tauriBridge";
import {
  ALL_MEDIA_EXTENSIONS,
  AUDIO_EXTENSIONS,
  formatDurationLabel,
  formatMediaBytes,
  formatTimecode,
  getFileStemAndExt,
  getParentDir,
} from "../media-shared/mediaFormat";
import "../media-shared/mediaWorkspace.css";

const MAX_FADE_CAP_SEC = 30;
const MIN_SELECTION_SEC = 0.05;

export function computeAudioFadeBounds(
  startSec: number,
  endSec: number,
  fadeInEnabled: boolean,
  fadeInSec: number,
  fadeOutEnabled: boolean,
  fadeOutSec: number,
) {
  const selDur = Math.max(0, endSec - startSec);
  const sharedCap =
    fadeInEnabled && fadeOutEnabled
      ? Math.min(selDur * 0.5, MAX_FADE_CAP_SEC)
      : Math.min(selDur, MAX_FADE_CAP_SEC);
  const maxFadeInSec = fadeInEnabled ? sharedCap : Math.min(selDur, MAX_FADE_CAP_SEC);
  const maxFadeOutSec = fadeOutEnabled ? sharedCap : Math.min(selDur, MAX_FADE_CAP_SEC);
  const effectiveFadeInSec =
    fadeInEnabled && Number.isFinite(fadeInSec) && fadeInSec > 0
      ? Math.min(fadeInSec, maxFadeInSec)
      : 0;
  const effectiveFadeOutSec =
    fadeOutEnabled && Number.isFinite(fadeOutSec) && fadeOutSec > 0
      ? Math.min(fadeOutSec, maxFadeOutSec)
      : 0;
  return {
    selDur,
    maxFadeInSec,
    maxFadeOutSec,
    effectiveFadeInSec,
    effectiveFadeOutSec,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

type DragKind = "start" | "end" | "move" | "seek";

export function AudioTrimWorkspace() {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const {
    mediaSession,
    updateAudioTrimSession,
    startAudioTrimTask,
    cancelAudioTrimTask,
    handoffMediaFileToTool,
    pendingHandoff,
    consumePendingHandoff,
  } = useMediaSession();
  const state = mediaSession.audioTrim;

  const [toolsStatus, setToolsStatus] = useState<MediaToolsStatus | null>(null);
  const [hovering, setHovering] = useState(false);
  const [loadingWave, setLoadingWave] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    kind: DragKind;
    startClientX: number;
    initStart: number;
    initEnd: number;
    width: number;
  } | null>(null);

  const duration = state.waveform?.durationSec ?? state.probe?.durationSec ?? 0;
  const fadeBounds = computeAudioFadeBounds(
    state.startSec,
    state.endSec,
    state.fadeInEnabled,
    state.fadeInSec,
    state.fadeOutEnabled,
    state.fadeOutSec,
  );

  const loadAudioFile = useCallback(
    async (path: string) => {
      setLoadingWave(true);
      setIsPlaying(false);
      try {
        const probe = await probeMediaInfo(path);
        if (!probe.hasAudio) {
          throw new Error(
            isZh ? "该文件不包含可剪切的音频轨。" : "Selected file contains no audio track.",
          );
        }
        const wf = await extractAudioWaveform(path, 960);
        const { stem, ext } = getFileStemAndExt(path);
        const parent = getParentDir(path);
        const outExt = AUDIO_EXTENSIONS.includes(ext.toLowerCase()) ? ext.toLowerCase() : "wav";
        const defaultOut = parent
          ? `${parent}\\${stem}_trimmed.${outExt}`
          : `${stem}_trimmed.${outExt}`;

        updateAudioTrimSession((prev) => ({
          ...prev,
          sourcePath: path,
          probe,
          waveform: wf,
          startSec: 0,
          endSec: round3(wf.durationSec),
          playheadSec: 0,
          outputPath: defaultOut,
          lastResult: null,
          errorMessage: null,
        }));
      } catch (err) {
        updateAudioTrimSession((prev) => ({
          ...prev,
          errorMessage: formatLocalizedError(err, t),
        }));
      } finally {
        setLoadingWave(false);
      }
    },
    [isZh, t, updateAudioTrimSession],
  );

  useEffect(() => {
    if (pendingHandoff?.toolId === "A03") {
      const path = consumePendingHandoff("A03");
      if (path) void loadAudioFile(path);
    }
  }, [pendingHandoff, consumePendingHandoff, loadAudioFile]);

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: setHovering,
          onDropPaths: (paths) => {
            if (paths[0]) void loadAudioFile(paths[0]);
          },
        }),
      "a03-file-drop",
    );
  }, [loadAudioFile]);

  // Keep audio element aligned with playhead when selection changes
  const syncAudioCurrentTime = useCallback((sec: number) => {
    const el = audioRef.current;
    if (el && Number.isFinite(sec)) {
      try {
        el.currentTime = Math.max(0, sec);
      } catch {
        // Ignore seek errors before metadata ready
      }
    }
  }, []);

  // Draw waveform + selection + fade triangles + playhead on high-DPI canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    const wf = state.waveform;
    if (!canvas || !wf || wf.durationSec <= 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(320, Math.round(rect.width || 720));
    const cssH = Math.max(140, Math.round(rect.height || 168));
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);

    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    ctx.fillStyle = isDark ? "#0f172a" : "#f8fafc";
    ctx.fillRect(0, 0, cssW, cssH);

    const midY = cssH / 2;
    const ampScale = cssH * 0.44;
    const dur = wf.durationSec;
    const selX1 = (state.startSec / dur) * cssW;
    const selX2 = (state.endSec / dur) * cssW;

    // Selected region tint
    ctx.fillStyle = isDark ? "rgba(37, 99, 235, 0.22)" : "rgba(37, 99, 235, 0.12)";
    ctx.fillRect(selX1, 0, Math.max(2, selX2 - selX1), cssH);

    // Subtle center baseline
    ctx.strokeStyle = isDark ? "rgba(148,163,184,0.22)" : "rgba(100,116,139,0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(cssW, midY);
    ctx.stroke();

    // Waveform bars
    const n = wf.bucketCount;
    const stepX = cssW / n;
    for (let i = 0; i < n; i++) {
      const x = i * stepX;
      const tPos = ((i + 0.5) / n) * dur;
      const inSel = tPos >= state.startSec && tPos <= state.endSec;
      const lo = wf.minPeaks[i] ?? 0;
      const hi = wf.maxPeaks[i] ?? 0;
      const yTop = midY - Math.max(0.015, hi) * ampScale;
      const yBot = midY - Math.min(-0.015, lo) * ampScale;
      ctx.fillStyle = inSel
        ? isDark
          ? "#60a5fa"
          : "#2563eb"
        : isDark
          ? "rgba(148, 163, 184, 0.38)"
          : "rgba(100, 116, 139, 0.35)";
      ctx.fillRect(x, yTop, Math.max(1, stepX - 0.3), Math.max(1.5, yBot - yTop));
    }

    // Fade-in & Fade-out ramp overlays
    if (fadeBounds.effectiveFadeInSec > 0) {
      const fiW = (fadeBounds.effectiveFadeInSec / dur) * cssW;
      ctx.fillStyle = isDark ? "rgba(16, 185, 129, 0.25)" : "rgba(5, 150, 105, 0.20)";
      ctx.beginPath();
      ctx.moveTo(selX1, cssH);
      ctx.lineTo(selX1, 0);
      ctx.lineTo(selX1 + fiW, 0);
      ctx.closePath();
      ctx.fill();
    }
    if (fadeBounds.effectiveFadeOutSec > 0) {
      const foW = (fadeBounds.effectiveFadeOutSec / dur) * cssW;
      ctx.fillStyle = isDark ? "rgba(245, 158, 11, 0.25)" : "rgba(217, 119, 6, 0.20)";
      ctx.beginPath();
      ctx.moveTo(selX2, cssH);
      ctx.lineTo(selX2, 0);
      ctx.lineTo(selX2 - foW, 0);
      ctx.closePath();
      ctx.fill();
    }

    // Dimmed regions outside selection
    ctx.fillStyle = isDark ? "rgba(2, 6, 23, 0.52)" : "rgba(15, 23, 42, 0.14)";
    ctx.fillRect(0, 0, Math.max(0, selX1), cssH);
    ctx.fillRect(selX2, 0, Math.max(0, cssW - selX2), cssH);

    // Selection boundaries
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(selX1, 0);
    ctx.lineTo(selX1, cssH);
    ctx.moveTo(selX2, 0);
    ctx.lineTo(selX2, cssH);
    ctx.stroke();

    // Playhead marker
    const phX = Math.max(0, Math.min(cssW, (state.playheadSec / dur) * cssW));
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(phX, 0);
    ctx.lineTo(phX, cssH);
    ctx.stroke();

    ctx.restore();
  }, [
    state.waveform,
    state.startSec,
    state.endSec,
    state.playheadSec,
    fadeBounds.effectiveFadeInSec,
    fadeBounds.effectiveFadeOutSec,
  ]);

  // Audition loop: stop cleanly at endSec and update playhead continuously
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTimeUpdate = () => {
      const tNow = el.currentTime;
      if (tNow >= state.endSec - 0.015) {
        el.pause();
        el.currentTime = state.startSec;
        setIsPlaying(false);
        updateAudioTrimSession((prev) => ({ ...prev, playheadSec: prev.startSec }));
      } else {
        updateAudioTrimSession((prev) => ({ ...prev, playheadSec: round3(tNow) }));
      }
    };
    const onEnded = () => {
      setIsPlaying(false);
      updateAudioTrimSession((prev) => ({ ...prev, playheadSec: prev.startSec }));
    };
    el.addEventListener("timeupdate", onTimeUpdate);
    el.addEventListener("ended", onEnded);
    return () => {
      el.removeEventListener("timeupdate", onTimeUpdate);
      el.removeEventListener("ended", onEnded);
    };
  }, [state.startSec, state.endSec, updateAudioTrimSession]);

  const handleToggleAudition = async () => {
    const el = audioRef.current;
    if (!el || !state.waveform) return;
    if (isPlaying) {
      el.pause();
      setIsPlaying(false);
      return;
    }
    const startAt =
      state.playheadSec >= state.startSec && state.playheadSec < state.endSec - 0.05
        ? state.playheadSec
        : state.startSec;
    el.currentTime = startAt;
    try {
      await el.play();
      setIsPlaying(true);
    } catch {
      setIsPlaying(false);
    }
  };

  const applyRange = useCallback(
    (nextStart: number, nextEnd: number, syncPlayhead?: number) => {
      if (duration <= 0) return;
      const minGap = Math.min(MIN_SELECTION_SEC, duration);
      let s = Math.max(0, Math.min(duration - minGap, nextStart));
      let e = Math.max(s + minGap, Math.min(duration, nextEnd));
      s = round3(s);
      e = round3(e);
      const nextPh =
        syncPlayhead != null
          ? round3(Math.max(s, Math.min(e, syncPlayhead)))
          : round3(Math.max(s, Math.min(e, state.playheadSec)));
      syncAudioCurrentTime(nextPh);
      updateAudioTrimSession((prev) => ({
        ...prev,
        startSec: s,
        endSec: e,
        playheadSec: nextPh,
        lastResult: null,
      }));
    },
    [duration, state.playheadSec, syncAudioCurrentTime, updateAudioTrimSession],
  );

  const handleStagePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!stageRef.current || duration <= 0) return;
    const rect = stageRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const tClick = (x / rect.width) * duration;
    const xStart = (state.startSec / duration) * rect.width;
    const xEnd = (state.endSec / duration) * rect.width;

    let kind: DragKind = "seek";
    if (Math.abs(x - xStart) <= 10) {
      kind = "start";
    } else if (Math.abs(x - xEnd) <= 10) {
      kind = "end";
    } else if (x > xStart + 10 && x < xEnd - 10 && e.shiftKey) {
      kind = "move";
    } else {
      // Click directly on waveform moves playhead cleanly
      const ph = round3(Math.max(0, Math.min(duration, tClick)));
      syncAudioCurrentTime(ph);
      updateAudioTrimSession((prev) => ({ ...prev, playheadSec: ph }));
    }

    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      kind,
      startClientX: e.clientX,
      initStart: state.startSec,
      initEnd: state.endSec,
      width: Math.max(1, rect.width),
    };
  };

  const handleStagePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || duration <= 0) return;
    const dxSec = ((e.clientX - d.startClientX) / d.width) * duration;
    if (d.kind === "start") {
      const ns = Math.max(0, Math.min(d.initEnd - MIN_SELECTION_SEC, d.initStart + dxSec));
      applyRange(ns, d.initEnd, ns);
    } else if (d.kind === "end") {
      const ne = Math.max(d.initStart + MIN_SELECTION_SEC, Math.min(duration, d.initEnd + dxSec));
      applyRange(d.initStart, ne);
    } else if (d.kind === "move") {
      const span = d.initEnd - d.initStart;
      const ns = Math.max(0, Math.min(duration - span, d.initStart + dxSec));
      applyRange(ns, ns + span, ns);
    } else if (d.kind === "seek" && stageRef.current) {
      const rect = stageRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const ph = round3((x / rect.width) * duration);
      syncAudioCurrentTime(ph);
      updateAudioTrimSession((prev) => ({ ...prev, playheadSec: ph }));
    }
  };

  const handleStagePointerUp = () => {
    dragRef.current = null;
  };

  const handlePickAudio = async () => {
    try {
      const picked = await pickSingleFile({
        title: isZh ? "选择需要剪切的音频或视频文件" : "Select audio or video file to trim",
        filters: [
          {
            name: isZh ? "音频与视频文件" : "Audio & Video Files",
            extensions: [...ALL_MEDIA_EXTENSIONS],
          },
        ],
      });
      if (picked) await loadAudioFile(picked);
    } catch (err) {
      updateAudioTrimSession((prev) => ({
        ...prev,
        errorMessage: formatLocalizedError(err, t),
      }));
    }
  };

  const handlePickOutput = async () => {
    try {
      const picked = await pickSaveFilePath({
        title: isZh ? "选择导出音频文件" : "Save trimmed audio as",
        defaultPath: state.outputPath || "trimmed.wav",
        filters: [{ name: "Audio Files", extensions: ["wav", "mp3", "m4a", "flac", "aiff"] }],
      });
      if (picked) {
        updateAudioTrimSession((prev) => ({ ...prev, outputPath: picked }));
      }
    } catch (err) {
      updateAudioTrimSession((prev) => ({
        ...prev,
        errorMessage: formatLocalizedError(err, t),
      }));
    }
  };

  const handleExport = async () => {
    if (!state.sourcePath || !state.outputPath.trim()) return;
    if (audioRef.current && isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    }
    await startAudioTrimTask(
      {
        sourcePath: state.sourcePath,
        outputPath: state.outputPath.trim(),
        startSec: state.startSec,
        endSec: state.endSec,
        fadeInEnabled: state.fadeInEnabled,
        fadeInSec: fadeBounds.effectiveFadeInSec,
        fadeOutEnabled: state.fadeOutEnabled,
        fadeOutSec: fadeBounds.effectiveFadeOutSec,
        allowOverwrite: false,
      },
      (err) => formatLocalizedError(err, t),
    );
  };

  const mediaReady = Boolean(toolsStatus?.ready);
  const running = state.taskStatus === "running";
  const canExport =
    mediaReady &&
    !running &&
    Boolean(state.sourcePath) &&
    Boolean(state.waveform) &&
    fadeBounds.selDur >= 0.02 &&
    Boolean(state.outputPath.trim());

  const startPct = duration > 0 ? (state.startSec / duration) * 100 : 0;
  const endPct = duration > 0 ? (state.endSec / duration) * 100 : 100;

  return (
    <div className="media-workspace">
      <MediaToolsSetupPanel onStatusChange={setToolsStatus} />

      <section className="panel media-section">
        <div className="media-section-header">
          <div>
            <h3>{isZh ? "音频剪切" : "Trim Audio"}</h3>
            <p className="field-hint" style={{ margin: "2px 0 0" }}>
              {isZh
                ? "流式生成真实音频波形，拖动边界或输入精确时间剪切区间，支持选区试听与独立淡入/淡出控制。"
                : "Inspect real audio waveforms with bounded memory, drag trim boundaries or enter exact times, audition the selection, and apply separate fade-in / fade-out."}
            </p>
          </div>
          <div className="media-actions-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!mediaReady || running || loadingWave}
              onClick={() => void handlePickAudio()}
            >
              <FilePlus2 size={15} aria-hidden="true" />
              <span>
                {state.sourcePath
                  ? isZh
                    ? "更换音频…"
                    : "Change Audio..."
                  : isZh
                    ? "选择音频文件…"
                    : "Select Audio..."}
              </span>
            </button>
          </div>
        </div>

        {!state.sourcePath ? (
          <div className={`media-dropzone ${hovering ? "is-hover" : ""}`}>
            <AudioWaveform size={26} strokeWidth={1.6} aria-hidden="true" />
            <p style={{ margin: 0, fontWeight: 600 }}>
              {isZh
                ? "拖入录音、音乐或带音轨的视频文件以查看波形并剪切"
                : "Drop an audio file (or video with audio) to view waveform and trim"}
            </p>
            <p className="field-hint" style={{ margin: 0 }}>
              {isZh
                ? "支持 MP3、WAV、M4A、FLAC、AIFF、OGG 等格式；长录音采用流式峰值提取不占大内存。"
                : "Supports MP3, WAV, M4A, FLAC, AIFF, OGG and more; long recordings stream peaks with bounded memory."}
            </p>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!mediaReady || loadingWave}
              onClick={() => void handlePickAudio()}
            >
              <FilePlus2 size={15} aria-hidden="true" />
              <span>{isZh ? "选择音频文件…" : "Select Audio File..."}</span>
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            {/* File metadata bar */}
            <div
              className="media-summary-card"
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "10px",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <strong style={{ wordBreak: "break-all" }}>
                  {state.waveform?.fileName ?? state.probe?.fileName}
                </strong>
                <div className="field-hint" style={{ fontSize: "12px" }}>
                  {state.waveform
                    ? `${formatDurationLabel(duration, locale)} · ${(state.waveform.codecName ?? "audio").toUpperCase()} · ${
                        state.waveform.sampleRateHz ? `${state.waveform.sampleRateHz} Hz` : "—"
                      } · ${state.waveform.channels ?? "—"} ch${
                        state.waveform.bitsPerSample ? ` · ${state.waveform.bitsPerSample}-bit` : ""
                      }`
                    : isZh
                      ? "正在流式分析波形…"
                      : "Streaming waveform peaks..."}
                </div>
              </div>
              <div className="badge mono" data-testid="a03-selection-badge">
                {isZh ? "选区 " : "Sel "}
                {formatTimecode(state.startSec)} – {formatTimecode(state.endSec)} (
                {formatDurationLabel(fadeBounds.selDur, locale)})
              </div>
            </div>

            {/* Waveform Hero Stage */}
            <div
              ref={stageRef}
              data-testid="a03-waveform-stage"
              onPointerDown={handleStagePointerDown}
              onPointerMove={handleStagePointerMove}
              onPointerUp={handleStagePointerUp}
              style={{
                position: "relative",
                height: "172px",
                borderRadius: "8px",
                border: "1px solid var(--border-subtle)",
                overflow: "hidden",
                cursor: "ew-resize",
                userSelect: "none",
                touchAction: "none",
              }}
            >
              <canvas ref={canvasRef} style={{ display: "block", width: "100%", height: "100%" }} />
              {/* Visible draggable start/end handles */}
              <div
                aria-label={isZh ? "起点手柄" : "Start handle"}
                style={{
                  position: "absolute",
                  left: `calc(${startPct}% - 6px)`,
                  top: "6px",
                  width: "12px",
                  height: "24px",
                  borderRadius: "3px",
                  background: "#2563eb",
                  border: "2px solid #ffffff",
                  pointerEvents: "none",
                }}
              />
              <div
                aria-label={isZh ? "终点手柄" : "End handle"}
                style={{
                  position: "absolute",
                  left: `calc(${endPct}% - 6px)`,
                  top: "6px",
                  width: "12px",
                  height: "24px",
                  borderRadius: "3px",
                  background: "#2563eb",
                  border: "2px solid #ffffff",
                  pointerEvents: "none",
                }}
              />
            </div>

            {state.waveform && (
              <audio ref={audioRef} src={state.waveform.auditionUrl} preload="metadata" />
            )}

            {/* Playback & boundary quick actions */}
            <div className="media-actions-row" style={{ justifyContent: "space-between" }}>
              <div className="media-actions-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!state.waveform || loadingWave}
                  onClick={() => void handleToggleAudition()}
                >
                  {isPlaying ? (
                    <Pause size={14} aria-hidden="true" />
                  ) : (
                    <Play size={14} aria-hidden="true" />
                  )}
                  <span>
                    {isPlaying
                      ? isZh
                        ? "暂停试听"
                        : "Pause"
                      : isZh
                        ? "试听选区"
                        : "Play Selection"}
                  </span>
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={!state.waveform || running}
                  onClick={() => applyRange(state.playheadSec, state.endSec, state.playheadSec)}
                >
                  {isZh ? "播放头设为起点" : "Set Start at Playhead"}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={!state.waveform || running}
                  onClick={() => applyRange(state.startSec, state.playheadSec)}
                >
                  {isZh ? "播放头设为终点" : "Set End at Playhead"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={!state.waveform || running}
                  onClick={() => applyRange(0, duration, 0)}
                >
                  <RotateCcw size={14} aria-hidden="true" />
                  <span>{isZh ? "重置全段" : "Reset Full"}</span>
                </button>
              </div>
              <span className="field-hint mono" style={{ fontSize: "12px" }}>
                {isZh ? "当前位置：" : "Playhead: "}
                {formatTimecode(state.playheadSec)}
              </span>
            </div>

            {/* Exact time inputs & Fade-In / Fade-Out controls */}
            <div className="media-grid-2">
              <div
                className="media-summary-card"
                style={{ display: "flex", flexDirection: "column", gap: "10px" }}
              >
                <strong style={{ fontSize: "13px" }}>
                  {isZh ? "精确起止时间（秒）" : "Exact Trim Range (Seconds)"}
                </strong>
                <div className="media-actions-row">
                  <div style={{ flex: 1, minWidth: "120px" }}>
                    <label className="field-label" htmlFor="a03-start-sec">
                      {isZh ? "开始时间 (s)" : "Start (s)"}
                    </label>
                    <input
                      id="a03-start-sec"
                      type="number"
                      className="text-input"
                      style={{ width: "100%", marginTop: "4px" }}
                      min={0}
                      max={Math.max(0, round3(state.endSec - MIN_SELECTION_SEC))}
                      step={0.05}
                      value={state.startSec}
                      disabled={running || !state.waveform}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isFinite(v)) applyRange(v, state.endSec, v);
                      }}
                    />
                  </div>
                  <div style={{ flex: 1, minWidth: "120px" }}>
                    <label className="field-label" htmlFor="a03-end-sec">
                      {isZh ? "结束时间 (s)" : "End (s)"}
                    </label>
                    <input
                      id="a03-end-sec"
                      type="number"
                      className="text-input"
                      style={{ width: "100%", marginTop: "4px" }}
                      min={round3(state.startSec + MIN_SELECTION_SEC)}
                      max={round3(duration)}
                      step={0.05}
                      value={state.endSec}
                      disabled={running || !state.waveform}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isFinite(v)) applyRange(state.startSec, v);
                      }}
                    />
                  </div>
                </div>
                <div className="field-hint" style={{ fontSize: "12px" }}>
                  {isZh
                    ? "提示：可拖动波形蓝线、点击波形定位播放头，或按住 Shift 拖动选区平移。"
                    : "Tip: Drag blue handles, click waveform to seek, or Shift+drag to slide the selection."}
                </div>
              </div>

              <div
                className="media-summary-card"
                style={{ display: "flex", flexDirection: "column", gap: "10px" }}
              >
                <strong style={{ fontSize: "13px" }}>
                  {isZh ? "淡入与淡出包络" : "Fade-In & Fade-Out"}
                </strong>
                <div className="media-actions-row">
                  <label className="checkbox-row" style={{ minWidth: "105px" }}>
                    <input
                      type="checkbox"
                      checked={state.fadeInEnabled}
                      disabled={running}
                      onChange={(e) =>
                        updateAudioTrimSession((prev) => ({
                          ...prev,
                          fadeInEnabled: e.target.checked,
                          lastResult: null,
                        }))
                      }
                    />
                    <span>{isZh ? "开启淡入" : "Fade In"}</span>
                  </label>
                  <input
                    id="a03-fade-in"
                    aria-label={isZh ? "淡入时长（秒）" : "Fade-in seconds"}
                    type="number"
                    className="text-input"
                    style={{ width: "92px" }}
                    min={0}
                    max={round3(fadeBounds.maxFadeInSec)}
                    step={0.05}
                    value={state.fadeInSec}
                    disabled={running || !state.fadeInEnabled}
                    onChange={(e) =>
                      updateAudioTrimSession((prev) => ({
                        ...prev,
                        fadeInSec: Math.max(0, Number(e.target.value) || 0),
                        lastResult: null,
                      }))
                    }
                  />
                  <span
                    className="field-hint"
                    style={{ fontSize: "12px" }}
                    data-testid="a03-fadein-range"
                  >
                    {isZh
                      ? `有效范围 0–${fadeBounds.maxFadeInSec.toFixed(2)} s`
                      : `Valid 0–${fadeBounds.maxFadeInSec.toFixed(2)} s`}
                  </span>
                </div>

                <div className="media-actions-row">
                  <label className="checkbox-row" style={{ minWidth: "105px" }}>
                    <input
                      type="checkbox"
                      checked={state.fadeOutEnabled}
                      disabled={running}
                      onChange={(e) =>
                        updateAudioTrimSession((prev) => ({
                          ...prev,
                          fadeOutEnabled: e.target.checked,
                          lastResult: null,
                        }))
                      }
                    />
                    <span>{isZh ? "开启淡出" : "Fade Out"}</span>
                  </label>
                  <input
                    id="a03-fade-out"
                    aria-label={isZh ? "淡出时长（秒）" : "Fade-out seconds"}
                    type="number"
                    className="text-input"
                    style={{ width: "92px" }}
                    min={0}
                    max={round3(fadeBounds.maxFadeOutSec)}
                    step={0.05}
                    value={state.fadeOutSec}
                    disabled={running || !state.fadeOutEnabled}
                    onChange={(e) =>
                      updateAudioTrimSession((prev) => ({
                        ...prev,
                        fadeOutSec: Math.max(0, Number(e.target.value) || 0),
                        lastResult: null,
                      }))
                    }
                  />
                  <span
                    className="field-hint"
                    style={{ fontSize: "12px" }}
                    data-testid="a03-fadeout-range"
                  >
                    {isZh
                      ? `有效范围 0–${fadeBounds.maxFadeOutSec.toFixed(2)} s`
                      : `Valid 0–${fadeBounds.maxFadeOutSec.toFixed(2)} s`}
                  </span>
                </div>
              </div>
            </div>

            {/* Output path & export */}
            <div>
              <label className="field-label" htmlFor="a03-output-path">
                {isZh
                  ? "输出音频文件（绝不覆盖源文件）"
                  : "Output Audio File (Never Overwrites Source)"}
              </label>
              <div className="media-actions-row" style={{ marginTop: "6px" }}>
                <input
                  id="a03-output-path"
                  type="text"
                  className="text-input"
                  style={{ flex: 1 }}
                  value={state.outputPath}
                  disabled={running}
                  onChange={(e) =>
                    updateAudioTrimSession((prev) => ({ ...prev, outputPath: e.target.value }))
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
                <Scissors size={15} aria-hidden="true" />
                <span>
                  {running
                    ? isZh
                      ? "正在导出剪切音频…"
                      : "Exporting Trimmed Audio..."
                    : isZh
                      ? `导出选区 (${formatDurationLabel(fadeBounds.selDur, locale)})`
                      : `Export Selection (${formatDurationLabel(fadeBounds.selDur, locale)})`}
                </span>
              </button>
              {running && (
                <button type="button" className="btn" onClick={() => void cancelAudioTrimTask()}>
                  {isZh ? "取消任务" : "Cancel"}
                </button>
              )}
            </div>

            {running && state.liveProgress && (
              <div className="media-progress-panel">
                <div className="media-progress-header">
                  <span>{isZh ? "正在导出剪切音频…" : "Trimming audio..."}</span>
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
                <div className="media-section-header">
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <CheckCircle2 size={18} aria-hidden="true" />
                    <strong>
                      {isZh
                        ? `剪切完成：${formatDurationLabel(state.lastResult.durationSec, locale)} · ${formatMediaBytes(state.lastResult.byteSize, locale)}`
                        : `Trimmed: ${formatDurationLabel(state.lastResult.durationSec, locale)} · ${formatMediaBytes(state.lastResult.byteSize, locale)}`}
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
                      onClick={() => handoffMediaFileToTool("A01", state.lastResult!.outputPath)}
                    >
                      <span>{isZh ? "音频降噪 (A01)" : "Clean Up (A01)"}</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => handoffMediaFileToTool("A05", state.lastResult!.outputPath)}
                    >
                      <span>{isZh ? "格式转换 (A05)" : "Convert (A05)"}</span>
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
          </div>
        )}
      </section>
    </div>
  );
}
