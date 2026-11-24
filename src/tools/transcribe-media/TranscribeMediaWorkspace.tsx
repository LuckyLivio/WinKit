import {
  AlertTriangle,
  Captions,
  Check,
  CheckCircle2,
  Copy,
  FileAudio,
  FileText,
  FolderOpen,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Square,
  Trash2,
  Upload,
  Wand2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { MediaToolsSetupPanel } from "../../components/MediaToolsSetupPanel";
import { useI18n } from "../../i18n/I18nContext";
import { useMediaSession } from "../../lib/mediaSessionStore";
import {
  bindDisposableListener,
  exportTranscriptFile,
  formatLocalizedError,
  inspectTranscribeMedia,
  openLocalDirectory,
  parseBackendError,
  pickSaveFilePath,
  pickSingleFile,
  registerMediaPreviewPath,
  subscribeFileDrop,
  writeSystemClipboardText,
  type AsrLanguage,
  type AsrModelStatus,
  type MediaToolsStatus,
  type TranscriptExportFormat,
  type TranscriptSegment,
} from "../../lib/tauriBridge";
import { formatDurationLabel, formatMediaBytes, getParentDir } from "../media-shared/mediaFormat";
import { AsrModelSetupPanel } from "./AsrModelSetupPanel";
import {
  TRANSCRIBE_MEDIA_EXTENSIONS,
  computeSegmentsDigestKey,
  formatEditableTimestamp,
  formatTranscriptAsSrt,
  formatTranscriptAsTxt,
  parseTimestampInput,
  sortAndResolveSegmentOverlaps,
  suggestTranscriptExportPath,
  validateTranscriptSegments,
} from "./transcriptUtils";
import "../media-shared/mediaWorkspace.css";
import "./transcribeMedia.css";

interface PendingExportOverwrite {
  outputPath: string;
  format: TranscriptExportFormat;
  sourcePath: string | null;
  segmentsDigest: string;
  segments: TranscriptSegment[];
}

function getPhaseLabel(phase: string, isZh: boolean): string {
  switch (phase) {
    case "decoding":
      return isZh ? "解码音轨" : "Decoding audio";
    case "loading_model":
      return isZh ? "加载离线模型" : "Loading model";
    case "vad":
      return isZh ? "语音端点检测 (VAD)" : "Detecting speech (VAD)";
    case "transcribing":
      return isZh ? "离线语音转写" : "Transcribing speech";
    case "completed":
      return isZh ? "转写完成" : "Completed";
    default:
      return phase;
  }
}

function formatLanguageBadge(lang: string, isZh: boolean): string {
  switch (lang) {
    case "zh":
      return isZh ? "中文" : "ZH";
    case "en":
      return isZh ? "英文" : "EN";
    case "yue":
      return isZh ? "粤语" : "YUE";
    case "ja":
      return isZh ? "日语" : "JA";
    case "ko":
      return isZh ? "韩语" : "KO";
    default:
      return lang.toUpperCase();
  }
}

export function TranscribeMediaWorkspace() {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";

  const {
    mediaSession,
    updateTranscribeMediaSession,
    startTranscribeMediaTask,
    cancelTranscribeMediaTask,
    handoffMediaFileToTool,
    pendingHandoff,
    consumePendingHandoff,
  } = useMediaSession();

  const st = mediaSession.transcribeMedia;
  const running = st.taskStatus === "running";

  const [modelStatus, setModelStatus] = useState<AsrModelStatus | null>(null);
  const [mediaToolsStatus, setMediaToolsStatus] = useState<MediaToolsStatus | null>(null);
  const [hovering, setHovering] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedKind, setCopiedKind] = useState<"txt" | "srt" | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [overwritePending, setOverwritePending] = useState<PendingExportOverwrite | null>(null);
  const [draftTimes, setDraftTimes] = useState<Record<string, string>>({});

  const loadSeqRef = useRef(0);
  const mediaPlayerRef = useRef<HTMLMediaElement | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const validation = useMemo(() => validateTranscriptSegments(st.segments), [st.segments]);
  const segmentsDigest = useMemo(() => computeSegmentsDigestKey(st.segments), [st.segments]);

  // Invalidate any pending overwrite confirmation whenever source media or transcript edits change.
  useEffect(() => {
    setOverwritePending((pending) => {
      if (!pending) return null;
      if (pending.sourcePath !== st.sourcePath || pending.segmentsDigest !== segmentsDigest) {
        return null;
      }
      return pending;
    });
  }, [st.sourcePath, segmentsDigest]);

  const loadMediaFile = useCallback(
    async (filePath: string) => {
      if (running) return;
      const loadId = ++loadSeqRef.current;
      setInspecting(true);
      setExportError(null);
      setOverwritePending(null);
      setDraftTimes({});
      updateTranscribeMediaSession((prev) => ({
        ...prev,
        sourcePath: filePath,
        inspect: null,
        previewUrl: null,
        lastResult: null,
        segments: [],
        lastExportedPath: null,
        lastExportedFormat: null,
        errorMessage: null,
      }));

      try {
        const inspected = await inspectTranscribeMedia(filePath);
        if (loadSeqRef.current !== loadId) return;
        const preview = await registerMediaPreviewPath(inspected.path).catch(() => null);
        if (loadSeqRef.current !== loadId) return;
        updateTranscribeMediaSession((prev) => ({
          ...prev,
          sourcePath: inspected.path,
          inspect: inspected,
          previewUrl: preview?.url ?? null,
          errorMessage: inspected.hasAudio
            ? null
            : isZh
              ? "该媒体文件不包含可转写的音轨。"
              : "This media file contains no audio stream to transcribe.",
        }));
      } catch (err) {
        if (loadSeqRef.current !== loadId) return;
        updateTranscribeMediaSession((prev) => ({
          ...prev,
          inspect: null,
          previewUrl: null,
          errorMessage: formatLocalizedError(err, t),
        }));
      } finally {
        if (loadSeqRef.current === loadId) {
          setInspecting(false);
        }
      }
    },
    [isZh, running, t, updateTranscribeMediaSession],
  );

  // Clean handoff intake hook for future A02 / media tools sending audio to T01.
  useEffect(() => {
    const handed = consumePendingHandoff("T01");
    if (handed) {
      void loadMediaFile(handed);
    }
  }, [pendingHandoff, consumePendingHandoff, loadMediaFile]);

  // Drag & drop support
  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: setHovering,
          onDropPaths: (paths) => {
            if (running || paths.length === 0) return;
            void loadMediaFile(paths[0]!);
          },
        }),
      "t01-file-drop",
    );
  }, [running, loadMediaFile]);

  const handlePickFile = async () => {
    if (running) return;
    const picked = await pickSingleFile({
      title: isZh ? "选择本地音频或视频文件" : "Select Local Audio or Video File",
      filters: [
        {
          name: isZh ? "音视频文件" : "Audio & Video",
          extensions: [...TRANSCRIBE_MEDIA_EXTENSIONS],
        },
      ],
    });
    if (picked) {
      void loadMediaFile(picked);
    }
  };

  const handleClear = () => {
    if (running) return;
    loadSeqRef.current += 1;
    setInspecting(false);
    setSearchQuery("");
    setExportError(null);
    setOverwritePending(null);
    setDraftTimes({});
    updateTranscribeMediaSession((prev) => ({
      ...prev,
      sourcePath: null,
      inspect: null,
      previewUrl: null,
      lastResult: null,
      segments: [],
      lastExportedPath: null,
      lastExportedFormat: null,
      errorMessage: null,
    }));
  };

  const needsFfmpegAndMissing = Boolean(
    st.inspect && st.inspect.requiresFfmpeg && mediaToolsStatus && !mediaToolsStatus.ready,
  );
  const canStart = Boolean(
    !running &&
    !inspecting &&
    st.sourcePath &&
    st.inspect?.hasAudio &&
    modelStatus?.ready &&
    !needsFfmpegAndMissing,
  );

  const handleStartTranscribe = async () => {
    if (!canStart || !st.sourcePath) return;
    setExportError(null);
    setOverwritePending(null);
    setDraftTimes({});
    await startTranscribeMediaTask(
      {
        inputPath: st.sourcePath,
        language: st.language,
        useItn: st.useItn,
      },
      (err) => formatLocalizedError(err, t),
    );
  };

  const handleSeekTo = (sec: number) => {
    const el = mediaPlayerRef.current;
    if (!el) return;
    const offset = st.lastResult?.timelineOffsetSec ?? st.inspect?.audioStartTimeSec ?? 0;
    const target = Math.max(0, sec - (offset > 0 && el.duration && sec > el.duration ? offset : 0));
    el.currentTime = Number.isFinite(el.duration)
      ? Math.min(target, Math.max(0, el.duration - 0.05))
      : target;
    void el.play().catch(() => {});
  };

  const handleUpdateSegmentText = (index: number, nextText: string) => {
    updateTranscribeMediaSession((prev) => {
      const next = prev.segments.map((seg, idx) =>
        idx === index ? { ...seg, text: nextText } : seg,
      );
      return { ...prev, segments: next };
    });
  };

  const handleCommitTimestamp = (index: number, field: "startSec" | "endSec", rawValue: string) => {
    const key = `${index}:${field}`;
    const parsed = parseTimestampInput(rawValue);
    setDraftTimes((prev) => {
      const copy = { ...prev };
      delete copy[key];
      return copy;
    });
    if (parsed === null) return;
    updateTranscribeMediaSession((prev) => {
      const next = prev.segments.map((seg, idx) =>
        idx === index ? { ...seg, [field]: parsed } : seg,
      );
      return { ...prev, segments: next };
    });
  };

  const handleDeleteSegment = (index: number) => {
    setDraftTimes({});
    updateTranscribeMediaSession((prev) => ({
      ...prev,
      segments: prev.segments
        .filter((_, idx) => idx !== index)
        .map((seg, idx) => ({ ...seg, id: idx + 1 })),
    }));
  };

  const handleInsertSegmentAfter = (index: number) => {
    setDraftTimes({});
    updateTranscribeMediaSession((prev) => {
      const cur = prev.segments[index];
      const nextSeg = prev.segments[index + 1];
      const startSec = cur ? cur.endSec : 0;
      const endSec =
        nextSeg && nextSeg.startSec > startSec + 0.1
          ? Math.min(startSec + 2.0, nextSeg.startSec)
          : startSec + 2.0;
      const inserted: TranscriptSegment = {
        id: index + 2,
        startSec: Math.round(startSec * 1000) / 1000,
        endSec: Math.round(endSec * 1000) / 1000,
        text: "",
        language: cur?.language ?? null,
      };
      const arr = [...prev.segments];
      arr.splice(index + 1, 0, inserted);
      return {
        ...prev,
        segments: arr.map((s, idx) => ({ ...s, id: idx + 1 })),
      };
    });
  };

  const handleAutoFixOrder = () => {
    setDraftTimes({});
    updateTranscribeMediaSession((prev) => ({
      ...prev,
      segments: sortAndResolveSegmentOverlaps(prev.segments),
    }));
  };

  const handleCopy = async (kind: "txt" | "srt") => {
    setExportError(null);
    if (kind === "srt" && !validation.valid) {
      setExportError(
        isZh
          ? "字幕时间轴存在重叠或倒序，请先修正或点击「自动排序并消除重叠」后再复制 SRT。"
          : "Subtitle timestamps overlap or are out of order. Fix them or click 'Sort & Fix Overlaps' before copying SRT.",
      );
      return;
    }
    const text =
      kind === "srt"
        ? formatTranscriptAsSrt(st.segments)
        : formatTranscriptAsTxt(st.segments, st.includeTxtTimestamps);
    if (!text.trim()) return;
    try {
      await writeSystemClipboardText(text);
      setCopiedKind(kind);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedKind(null), 1800);
    } catch (err) {
      setExportError(formatLocalizedError(err, t));
    }
  };

  const executeExport = async (
    outputPath: string,
    format: TranscriptExportFormat,
    segmentsSnapshot: TranscriptSegment[],
    sourcePathSnapshot: string | null,
    overwrite: boolean,
  ) => {
    setExporting(true);
    setExportError(null);
    try {
      const res = await exportTranscriptFile({
        outputPath,
        format,
        segments: segmentsSnapshot,
        forbiddenSourcePaths: sourcePathSnapshot ? [sourcePathSnapshot] : [],
        overwrite,
      });
      setOverwritePending(null);
      updateTranscribeMediaSession((prev) => ({
        ...prev,
        lastExportedPath: res.outputPath,
        lastExportedFormat: res.format,
      }));
    } catch (err) {
      const parsed = parseBackendError(err);
      if (!overwrite && parsed.code === "TARGET_ALREADY_EXISTS") {
        setOverwritePending({
          outputPath,
          format,
          sourcePath: sourcePathSnapshot,
          segmentsDigest: computeSegmentsDigestKey(segmentsSnapshot),
          segments: segmentsSnapshot,
        });
      } else {
        setExportError(formatLocalizedError(err, t));
      }
    } finally {
      setExporting(false);
    }
  };

  const handleExport = async (format: TranscriptExportFormat) => {
    setExportError(null);
    if (validation.nonEmptyCount === 0) {
      setExportError(
        isZh ? "没有可导出的非空转写内容。" : "No non-empty transcript cues to export.",
      );
      return;
    }
    if (format === "srt" && !validation.valid) {
      setExportError(
        isZh
          ? "字幕时间轴存在重叠或倒序，请先修正后再导出标准 SRT 文件。"
          : "Subtitle timestamps overlap or are out of order. Fix them before exporting SRT.",
      );
      return;
    }
    const defaultPath = st.sourcePath
      ? suggestTranscriptExportPath(st.sourcePath, format)
      : format === "srt"
        ? "transcript.srt"
        : "transcript.txt";
    const picked = await pickSaveFilePath({
      title:
        format === "srt"
          ? isZh
            ? "导出 SRT 字幕"
            : "Export SRT Subtitles"
          : isZh
            ? "导出 TXT 文本"
            : "Export TXT Transcript",
      defaultPath,
      filters:
        format === "srt"
          ? [{ name: "SubRip Subtitle (*.srt)", extensions: ["srt"] }]
          : [{ name: "Text File (*.txt)", extensions: ["txt"] }],
    });
    if (!picked) return;
    await executeExport(
      picked,
      format,
      st.segments.map((s) => ({ ...s })),
      st.sourcePath,
      false,
    );
  };

  const handleConfirmOverwrite = async () => {
    const pending = overwritePending;
    if (!pending) return;
    if (pending.sourcePath !== st.sourcePath || pending.segmentsDigest !== segmentsDigest) {
      setOverwritePending(null);
      return;
    }
    setOverwritePending(null);
    await executeExport(
      pending.outputPath,
      pending.format,
      pending.segments,
      pending.sourcePath,
      true,
    );
  };

  const filteredSegments = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return st.segments
      .map((seg, index) => ({ seg, index }))
      .filter(({ seg }) => !q || seg.text.toLowerCase().includes(q));
  }, [st.segments, searchQuery]);

  const progressPct = st.liveProgress ? Math.min(100, Math.max(0, st.liveProgress.percent)) : 0;

  return (
    <div className="t01-workspace" data-testid="t01-workspace">
      <div className="t01-setup-stack">
        <AsrModelSetupPanel onStatusChange={setModelStatus} />
        <MediaToolsSetupPanel mode="tool" onStatusChange={setMediaToolsStatus} />
      </div>

      <div className="t01-grid">
        {/* Left Column: Media Import, Preview, Options & Execution */}
        <div className="t01-left-col">
          <section
            className="t01-card"
            aria-label={isZh ? "媒体来源与转写设置" : "Media Source & Settings"}
          >
            <div
              className={`t01-dropzone ${hovering ? "is-hovering" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => void handlePickFile()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  void handlePickFile();
                }
              }}
              data-testid="t01-dropzone"
            >
              <Upload size={20} strokeWidth={1.75} aria-hidden="true" />
              <div className="t01-dropzone-title">
                {inspecting
                  ? isZh
                    ? "正在读取媒体信息…"
                    : "Inspecting media..."
                  : st.sourcePath
                    ? isZh
                      ? "点击或拖入替换音频 / 视频文件"
                      : "Click or drop to replace audio / video"
                    : isZh
                      ? "选择或拖入本地音频 / 视频文件"
                      : "Select or drop local audio / video"}
              </div>
              <div className="t01-dropzone-hint">
                {isZh
                  ? "支持 WAV（免 FFmpeg 直读）及 MP3 / M4A / FLAC / MP4 / MKV / MOV 等常见音视频容器"
                  : "Supports native WAV (no FFmpeg needed) plus MP3 / M4A / FLAC / MP4 / MKV / MOV via FFmpeg"}
              </div>
            </div>

            {st.inspect && (
              <div className="t01-source-meta" data-testid="t01-source-meta">
                <div className="t01-source-header">
                  <div className="t01-source-name" title={st.inspect.path}>
                    <FileAudio
                      size={14}
                      style={{ verticalAlign: "-2px", marginRight: 5 }}
                      aria-hidden="true"
                    />
                    {st.inspect.fileName}
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={running}
                    onClick={handleClear}
                    style={{ padding: "2px 8px", fontSize: 12 }}
                    data-testid="t01-clear-btn"
                  >
                    <Trash2 size={13} aria-hidden="true" />
                    <span>{isZh ? "清空" : "Clear"}</span>
                  </button>
                </div>

                <div className="t01-meta-pills">
                  <span className="t01-pill mono">
                    {formatMediaBytes(st.inspect.byteLength, locale)}
                  </span>
                  {st.inspect.durationSec != null && (
                    <span className="t01-pill mono">
                      {formatDurationLabel(st.inspect.durationSec, locale)}
                    </span>
                  )}
                  {st.inspect.audioCodec && (
                    <span className="t01-pill mono">{st.inspect.audioCodec}</span>
                  )}
                  {st.inspect.sampleRate && (
                    <span className="t01-pill mono">
                      {(st.inspect.sampleRate / 1000).toFixed(1)} kHz
                      {st.inspect.channels ? ` · ${st.inspect.channels}ch` : ""}
                    </span>
                  )}
                  <span className="t01-pill is-accent">
                    {st.inspect.isWavNative ? (isZh ? "WAV 直读" : "Native WAV") : "FFmpeg"}
                  </span>
                  {st.inspect.audioStartTimeSec > 0.01 && (
                    <span className="t01-pill is-warn mono" data-testid="t01-timeline-offset-pill">
                      {isZh
                        ? `原时间轴起点 +${st.inspect.audioStartTimeSec.toFixed(3)}s`
                        : `Timeline offset +${st.inspect.audioStartTimeSec.toFixed(3)}s`}
                    </span>
                  )}
                </div>

                {st.previewUrl && (
                  <div className="t01-player-wrap">
                    {st.inspect.hasVideo ? (
                      <video
                        ref={(el) => {
                          mediaPlayerRef.current = el;
                        }}
                        className="t01-video-player"
                        src={st.previewUrl}
                        controls
                        preload="metadata"
                      />
                    ) : (
                      <audio
                        ref={(el) => {
                          mediaPlayerRef.current = el;
                        }}
                        className="t01-audio-player"
                        src={st.previewUrl}
                        controls
                        preload="metadata"
                      />
                    )}
                  </div>
                )}
              </div>
            )}

            {needsFfmpegAndMissing && (
              <div className="status-banner is-error" role="alert">
                {isZh
                  ? "当前文件不是标准 WAV，请先在上方「配置媒体组件」安装或指定本地 FFmpeg / ffprobe。"
                  : "This container requires FFmpeg. Configure local FFmpeg / ffprobe in the panel above first."}
              </div>
            )}

            <div className="t01-controls-form">
              <div className="t01-field">
                <label htmlFor="t01-language-select">
                  {isZh ? "识别语言" : "Recognition Language"}
                </label>
                <select
                  id="t01-language-select"
                  className="select-input"
                  value={st.language}
                  disabled={running}
                  onChange={(e) =>
                    updateTranscribeMediaSession((prev) => ({
                      ...prev,
                      language: e.target.value as AsrLanguage,
                    }))
                  }
                  data-testid="t01-language-select"
                >
                  <option value="auto">
                    {isZh
                      ? "自动检测（推荐，支持中英混排）"
                      : "Auto-detect (Recommended, Bilingual)"}
                  </option>
                  <option value="zh">{isZh ? "中文（普通话）" : "Chinese (Mandarin)"}</option>
                  <option value="en">{isZh ? "英语 (English)" : "English"}</option>
                  <option value="yue">{isZh ? "粤语 (Cantonese)" : "Cantonese"}</option>
                  <option value="ja">{isZh ? "日语 (Japanese)" : "Japanese"}</option>
                  <option value="ko">{isZh ? "韩语 (Korean)" : "Korean"}</option>
                </select>
              </div>

              <label className="t01-checkbox-row">
                <input
                  type="checkbox"
                  checked={st.useItn}
                  disabled={running}
                  onChange={(e) =>
                    updateTranscribeMediaSession((prev) => ({
                      ...prev,
                      useItn: e.target.checked,
                    }))
                  }
                />
                <span>
                  {isZh
                    ? "启用自动标点与数字规范化 (ITN)"
                    : "Enable automatic punctuation & inverse text normalization (ITN)"}
                </span>
              </label>

              <div className="t01-primary-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!canStart}
                  onClick={() => void handleStartTranscribe()}
                  data-testid="t01-start-btn"
                >
                  {st.lastResult ? (
                    <RefreshCw size={15} aria-hidden="true" />
                  ) : (
                    <Wand2 size={15} aria-hidden="true" />
                  )}
                  <span>
                    {running
                      ? isZh
                        ? "离线转写中…"
                        : "Transcribing..."
                      : st.lastResult
                        ? isZh
                          ? "重新离线转写"
                          : "Re-transcribe Offline"
                        : isZh
                          ? "开始离线转写"
                          : "Start Offline Transcription"}
                  </span>
                </button>

                {running && (
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => void cancelTranscribeMediaTask()}
                    data-testid="t01-cancel-btn"
                  >
                    <Square size={14} aria-hidden="true" />
                    <span>{isZh ? "取消" : "Cancel"}</span>
                  </button>
                )}
              </div>
            </div>

            {running && st.liveProgress && (
              <div
                className="t01-live-progress"
                role="status"
                aria-live="polite"
                data-testid="t01-progress"
              >
                <div className="asr-progress-header">
                  <span>
                    {getPhaseLabel(st.liveProgress.phase, isZh)}
                    {st.liveProgress.totalSegments > 0
                      ? ` (${st.liveProgress.currentSegment}/${st.liveProgress.totalSegments})`
                      : ""}
                  </span>
                  <span className="mono">{Math.round(progressPct)}%</span>
                </div>
                <div className="asr-progress-track">
                  <div className="asr-progress-fill" style={{ width: `${progressPct}%` }} />
                </div>
                {st.liveProgress.detail && (
                  <div className="field-hint" style={{ margin: 0, fontSize: 11.5 }}>
                    {st.liveProgress.detail}
                  </div>
                )}
              </div>
            )}

            {st.errorMessage && (
              <div className="status-banner is-error" role="alert" data-testid="t01-error-banner">
                {st.errorMessage}
              </div>
            )}
          </section>
        </div>

        {/* Right Column: Timestamped Proofreader, Order Validation & TXT/SRT Export */}
        <div className="t01-right-col">
          <section
            className="t01-card"
            aria-label={isZh ? "时间戳校对与导出" : "Timestamped Proofreader & Export"}
          >
            <div className="t01-results-header">
              <div className="t01-results-title-group">
                <h3 className="t01-results-title">
                  {isZh ? "转写结果与时间戳校对" : "Transcript & Timestamp Proofreader"}
                </h3>
                {st.lastResult && (
                  <div className="t01-meta-pills">
                    <span className="t01-pill mono" data-testid="t01-segment-count-pill">
                      {isZh
                        ? `${st.segments.length} 条字幕`
                        : `${st.segments.length} cue${st.segments.length === 1 ? "" : "s"}`}
                    </span>
                    <span className="t01-pill mono">
                      {isZh
                        ? `耗时 ${(st.lastResult.elapsedMs / 1000).toFixed(2)}s`
                        : `${(st.lastResult.elapsedMs / 1000).toFixed(2)}s`}
                      {st.lastResult.rtf > 0.001 ? ` · ${(1 / st.lastResult.rtf).toFixed(1)}x` : ""}
                    </span>
                    {st.lastResult.detectedLanguages.map((lang) => (
                      <span key={lang} className="t01-pill is-accent">
                        {formatLanguageBadge(lang, isZh)}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {st.segments.length > 0 && (
                <label className="t01-checkbox-row" style={{ fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={st.includeTxtTimestamps}
                    onChange={(e) =>
                      updateTranscribeMediaSession((prev) => ({
                        ...prev,
                        includeTxtTimestamps: e.target.checked,
                      }))
                    }
                  />
                  <span>{isZh ? "TXT 附带时间戳" : "Include timestamps in TXT"}</span>
                </label>
              )}
            </div>

            {st.segments.length > 0 && (
              <div className="t01-toolbar">
                <div className="t01-search-box">
                  <Search size={13} className="t01-search-icon" aria-hidden="true" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={isZh ? "筛选关键词…" : "Filter cues..."}
                    aria-label={isZh ? "筛选转写片段" : "Filter transcript cues"}
                  />
                </div>

                <div className="t01-export-bar">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={exporting || validation.nonEmptyCount === 0}
                    onClick={() => void handleCopy("txt")}
                    data-testid="t01-copy-txt-btn"
                  >
                    {copiedKind === "txt" ? (
                      <Check size={14} aria-hidden="true" />
                    ) : (
                      <Copy size={14} aria-hidden="true" />
                    )}
                    <span>
                      {copiedKind === "txt"
                        ? isZh
                          ? "已复制文本"
                          : "Copied TXT"
                        : isZh
                          ? "复制纯文本"
                          : "Copy Text"}
                    </span>
                  </button>

                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={exporting || !validation.valid}
                    onClick={() => void handleCopy("srt")}
                    data-testid="t01-copy-srt-btn"
                  >
                    {copiedKind === "srt" ? (
                      <Check size={14} aria-hidden="true" />
                    ) : (
                      <Captions size={14} aria-hidden="true" />
                    )}
                    <span>
                      {copiedKind === "srt"
                        ? isZh
                          ? "已复制 SRT"
                          : "Copied SRT"
                        : isZh
                          ? "复制 SRT"
                          : "Copy SRT"}
                    </span>
                  </button>

                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={exporting || validation.nonEmptyCount === 0}
                    onClick={() =>
                      void handleExport(st.includeTxtTimestamps ? "txt_timestamped" : "txt")
                    }
                    data-testid="t01-export-txt-btn"
                  >
                    <FileText size={14} aria-hidden="true" />
                    <span>{isZh ? "导出 TXT" : "Export TXT"}</span>
                  </button>

                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={exporting || !validation.valid}
                    onClick={() => void handleExport("srt")}
                    data-testid="t01-export-srt-btn"
                  >
                    <Save size={14} aria-hidden="true" />
                    <span>{isZh ? "导出 SRT" : "Export SRT"}</span>
                  </button>
                </div>
              </div>
            )}

            {st.segments.length > 0 && !validation.valid && (
              <div className="t01-order-warning" role="alert" data-testid="t01-order-warning">
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <AlertTriangle size={15} aria-hidden="true" />
                  <span>
                    {isZh
                      ? `检测到 ${validation.issues.length} 处字幕时间轴异常（倒序、重叠或结束时间不大于开始时间），导出 SRT 前请修正。`
                      : `${validation.issues.length} subtitle timestamp issue(s) found (out-of-order, overlap, or end <= start). Fix before exporting SRT.`}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleAutoFixOrder}
                  data-testid="t01-autofix-order-btn"
                >
                  <span>{isZh ? "按时间排序并消除重叠" : "Sort & Fix Overlaps"}</span>
                </button>
              </div>
            )}

            {exportError && (
              <div className="status-banner is-error" role="alert" data-testid="t01-export-error">
                {exportError}
              </div>
            )}

            {st.lastResult && st.lastResult.warnings.length > 0 && (
              <div className="status-banner" role="status" data-testid="t01-warnings-banner">
                {st.lastResult.warnings.map((w, idx) => (
                  <div key={idx}>{w}</div>
                ))}
              </div>
            )}

            {st.lastExportedPath && (
              <div className="t01-export-result" role="status" data-testid="t01-export-success">
                <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  <CheckCircle2
                    size={15}
                    style={{ color: "var(--status-ok)", flexShrink: 0 }}
                    aria-hidden="true"
                  />
                  <span className="mono" style={{ wordBreak: "break-all" }}>
                    {isZh ? "已导出：" : "Saved: "}
                    {st.lastExportedPath}
                  </span>
                </div>
                <div className="media-actions-row">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void openLocalDirectory(getParentDir(st.lastExportedPath!))}
                  >
                    <FolderOpen size={14} aria-hidden="true" />
                    <span>{isZh ? "打开所在目录" : "Open Folder"}</span>
                  </button>
                  {st.lastExportedFormat === "srt" && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => handoffMediaFileToTool("V02", st.lastExportedPath!)}
                      data-testid="t01-send-v02-btn"
                    >
                      <Captions size={14} aria-hidden="true" />
                      <span>{isZh ? "发送到视频加字幕 (V02)" : "Send to Add Subtitles (V02)"}</span>
                    </button>
                  )}
                </div>
              </div>
            )}

            {st.segments.length === 0 ? (
              <div className="t01-empty-state" data-testid="t01-empty-state">
                <FileText size={26} strokeWidth={1.5} aria-hidden="true" />
                <div>
                  {st.lastResult
                    ? isZh
                      ? "本次未检测到清晰人声片段（纯静音或音量低于语音阈值）。"
                      : "No clear speech segments were detected (silence or below speech threshold)."
                    : isZh
                      ? "导入音频或视频并点击「开始离线转写」，此处将按原媒体时间轴展示可编辑的分段字幕。"
                      : "Import an audio or video file and click 'Start Offline Transcription' to review and proofread timestamped cues here."}
                </div>
              </div>
            ) : (
              <div className="t01-segment-list" data-testid="t01-segment-list">
                {filteredSegments.map(({ seg, index }) => {
                  const isBad = validation.issueIndexSet.has(index);
                  const startKey = `${index}:startSec`;
                  const endKey = `${index}:endSec`;
                  const startVal = draftTimes[startKey] ?? formatEditableTimestamp(seg.startSec);
                  const endVal = draftTimes[endKey] ?? formatEditableTimestamp(seg.endSec);

                  return (
                    <div
                      key={`${seg.id}-${index}`}
                      className={`t01-segment-row ${isBad ? "is-invalid" : ""}`}
                      data-testid={`t01-segment-row-${index}`}
                    >
                      <div className="t01-segment-top">
                        <div className="t01-segment-times">
                          <span className="t01-cue-index mono">#{index + 1}</span>
                          {st.previewUrl && (
                            <button
                              type="button"
                              className="t01-icon-btn"
                              title={isZh ? "从此处试听" : "Play from this cue"}
                              aria-label={
                                isZh ? `从第 ${index + 1} 条试听` : `Play cue ${index + 1}`
                              }
                              onClick={() => handleSeekTo(seg.startSec)}
                            >
                              <Play size={12} aria-hidden="true" />
                            </button>
                          )}
                          <input
                            type="text"
                            className={`t01-time-input mono ${isBad ? "is-bad" : ""}`}
                            value={startVal}
                            aria-label={
                              isZh ? `第 ${index + 1} 条开始时间` : `Cue ${index + 1} start time`
                            }
                            onChange={(e) =>
                              setDraftTimes((prev) => ({ ...prev, [startKey]: e.target.value }))
                            }
                            onBlur={(e) => handleCommitTimestamp(index, "startSec", e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                handleCommitTimestamp(index, "startSec", e.currentTarget.value);
                                e.currentTarget.blur();
                              }
                            }}
                          />
                          <span className="t01-time-arrow">→</span>
                          <input
                            type="text"
                            className={`t01-time-input mono ${isBad ? "is-bad" : ""}`}
                            value={endVal}
                            aria-label={
                              isZh ? `第 ${index + 1} 条结束时间` : `Cue ${index + 1} end time`
                            }
                            onChange={(e) =>
                              setDraftTimes((prev) => ({ ...prev, [endKey]: e.target.value }))
                            }
                            onBlur={(e) => handleCommitTimestamp(index, "endSec", e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                handleCommitTimestamp(index, "endSec", e.currentTarget.value);
                                e.currentTarget.blur();
                              }
                            }}
                          />
                          {seg.language && (
                            <span className="t01-pill">
                              {formatLanguageBadge(seg.language, isZh)}
                            </span>
                          )}
                        </div>

                        <div className="t01-segment-actions">
                          <button
                            type="button"
                            className="t01-icon-btn"
                            title={isZh ? "在下方插入一条字幕" : "Insert cue below"}
                            aria-label={
                              isZh ? `在第 ${index + 1} 条后插入` : `Insert after cue ${index + 1}`
                            }
                            onClick={() => handleInsertSegmentAfter(index)}
                          >
                            <Plus size={13} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="t01-icon-btn"
                            title={isZh ? "删除此条字幕" : "Delete cue"}
                            aria-label={isZh ? `删除第 ${index + 1} 条` : `Delete cue ${index + 1}`}
                            onClick={() => handleDeleteSegment(index)}
                          >
                            <Trash2 size={13} aria-hidden="true" />
                          </button>
                        </div>
                      </div>

                      <textarea
                        className="t01-segment-textarea"
                        value={seg.text}
                        rows={2}
                        aria-label={isZh ? `第 ${index + 1} 条文本` : `Cue ${index + 1} text`}
                        onChange={(e) => handleUpdateSegmentText(index, e.target.value)}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(overwritePending)}
        title={isZh ? "覆盖已有文件确认" : "Confirm File Overwrite"}
        body={
          overwritePending
            ? isZh
              ? `目标路径已存在文件：${overwritePending.outputPath}。是否覆盖该文件？（绝不会覆盖源音视频文件）`
              : `A file already exists at ${overwritePending.outputPath}. Overwrite it? (Source media is always protected.)`
            : ""
        }
        confirmLabel={isZh ? "确认覆盖" : "Overwrite"}
        cancelLabel={isZh ? "取消" : "Cancel"}
        danger
        onConfirm={() => void handleConfirmOverwrite()}
        onCancel={() => setOverwritePending(null)}
      />
    </div>
  );
}
