import {
  AlertTriangle,
  BookOpen,
  ClipboardPaste,
  Download,
  Eraser,
  ExternalLink,
  FileText,
  FolderOpen,
  Gauge,
  Play,
  RefreshCw,
  Volume2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { MediaToolsSetupPanel } from "../../components/MediaToolsSetupPanel";
import { useI18n } from "../../i18n/I18nContext";
import { useOptionalPdfSession } from "../../lib/pdfSessionStore";
import { useSessionStore } from "../../lib/sessionStore";
import { formatCompactPages } from "../pdf-shared/pageRangeUtils";
import {
  bindDisposableListener,
  exportTtsAudio,
  formatLocalizedError,
  getDefaultTtsMp3Bitrate,
  getSupportedTtsMp3Bitrates,
  openLocalDirectory,
  openWindowsSpeechSettings,
  parseBackendError,
  pickSaveFilePath,
  pickSingleFile,
  readSystemClipboardText,
  subscribeFileDrop,
  suggestSafeSiblingPath,
  type ExportTtsAudioRequest,
  type MediaToolsStatus,
  type TtsExportFormat,
  type TtsVoiceInfo,
} from "../../lib/tauriBridge";
import { formatMediaBytes, getParentDir } from "../media-shared/mediaFormat";
import "../media-shared/mediaWorkspace.css";
import "./textToSpeech.css";

const RATE_PRESETS = [0.75, 1.0, 1.25, 1.5];
const EST_CHUNK_MAX_CHARS = 500;

interface PendingOverwriteExport {
  request: ExportTtsAudioRequest;
  bindingKey: string;
  seq: number;
}

function formatDuration(sec: number): string {
  const safe = Number.isFinite(sec) && sec > 0 ? sec : 0;
  const mins = Math.floor(safe / 60);
  const rem = safe - mins * 60;
  const whole = Math.floor(rem);
  const tenths = Math.floor((rem - whole) * 10);
  return `${String(mins).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${tenths}`;
}

function formatSampleRate(sr: number): string {
  return sr % 1000 === 0 ? `${sr / 1000} kHz` : `${(sr / 1000).toFixed(2)} kHz`;
}

function formatGenderLabel(gender: TtsVoiceInfo["gender"], isZh: boolean): string {
  if (gender === "female") return isZh ? "女声" : "Female";
  if (gender === "male") return isZh ? "男声" : "Male";
  return isZh ? "系统语音" : "Voice";
}

function formatEngineShort(engine: TtsVoiceInfo["engine"], isZh: boolean): string {
  if (engine === "winrt_one_core") {
    return isZh ? "WinRT OneCore" : "WinRT OneCore";
  }
  return isZh ? "SAPI 桌面" : "SAPI Desktop";
}

function formatVoiceOptionLabel(voice: TtsVoiceInfo, isZh: boolean): string {
  const parts = [voice.name];
  if (voice.language) {
    parts.push(voice.language);
  }
  parts.push(formatGenderLabel(voice.gender, isZh));
  parts.push(formatEngineShort(voice.engine, isZh));
  return parts.join(" · ");
}

function analyzeTextStats(raw: string): {
  charCount: number;
  paragraphCount: number;
  estimatedSegments: number;
  containsChinese: boolean;
  containsLatin: boolean;
} {
  const cleaned = raw.replace(/^\uFEFF/, "");
  const charCount = Array.from(cleaned).length;
  const lines = cleaned
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  let estimatedSegments = 0;
  for (const line of lines) {
    const len = Array.from(line).length;
    estimatedSegments += Math.max(1, Math.ceil(len / EST_CHUNK_MAX_CHARS));
  }
  return {
    charCount,
    paragraphCount: lines.length,
    estimatedSegments,
    containsChinese: /[\u3400-\u9FFF\uF900-\uFAFF]/.test(cleaned),
    containsLatin: /[A-Za-z]{2,}/.test(cleaned),
  };
}

export function TextToSpeechWorkspace() {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const {
    session,
    updateTextToSpeechSession,
    refreshTtsVoices,
    loadTextToSpeechFile,
    applyPendingPdfHandoff,
    dismissPendingPdfHandoff,
    startTextToSpeech,
    cancelTextToSpeech,
    clearTextToSpeechSession,
  } = useSessionStore();
  const pdfSession = useOptionalPdfSession();
  const state = session.textToSpeech;

  const [dragging, setDragging] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [mediaToolsStatus, setMediaToolsStatus] = useState<MediaToolsStatus | null>(null);
  const [pendingOverwrite, setPendingOverwrite] = useState<PendingOverwriteExport | null>(null);
  const [confirmPendingQueue, setConfirmPendingQueue] = useState(false);

  const mountedRef = useRef(true);
  const exportSeqRef = useRef(0);

  const availableMp3Bitrates = useMemo(() => {
    const reported = state.result?.supportedMp3BitratesKbps;
    if (reported && reported.length > 0) {
      return reported;
    }
    return getSupportedTtsMp3Bitrates(state.result?.sampleRate);
  }, [state.result]);

  const effectiveMp3BitrateKbps = useMemo(() => {
    if (availableMp3Bitrates.includes(state.mp3BitrateKbps)) {
      return state.mp3BitrateKbps;
    }
    const fallback = getDefaultTtsMp3Bitrate(state.result?.sampleRate);
    return availableMp3Bitrates.includes(fallback)
      ? fallback
      : (availableMp3Bitrates[availableMp3Bitrates.length - 1] ?? 128);
  }, [availableMp3Bitrates, state.mp3BitrateKbps, state.result?.sampleRate]);

  const exportBindingKey = useMemo(() => {
    if (!state.result) return null;
    return JSON.stringify({
      sourceGeneration: state.sourceGeneration,
      resultId: state.result.resultId,
      sourceFilePath: state.sourceFilePath,
      exportFormat: state.exportFormat,
      mp3BitrateKbps: state.exportFormat === "mp3" ? effectiveMp3BitrateKbps : null,
    });
  }, [
    state.sourceGeneration,
    state.result,
    state.sourceFilePath,
    state.exportFormat,
    effectiveMp3BitrateKbps,
  ]);

  const liveExportBindingRef = useRef<string | null>(exportBindingKey);
  liveExportBindingRef.current = exportBindingKey;

  const isExportStillCurrent = useCallback(
    (bindingKey: string, seq: number) =>
      mountedRef.current &&
      liveExportBindingRef.current === bindingKey &&
      exportSeqRef.current === seq,
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      exportSeqRef.current += 1;
    };
  }, []);

  useEffect(() => {
    exportSeqRef.current += 1;
    setPendingOverwrite(null);
    setExporting(false);
  }, [exportBindingKey]);

  useEffect(() => {
    if (state.status === "running" || !state.pendingPdfHandoff) {
      setConfirmPendingQueue(false);
    }
  }, [state.status, state.pendingPdfHandoff, state.sourceGeneration]);

  const handleRefreshVoices = useCallback(async () => {
    setLocalError(null);
    await refreshTtsVoices((err) => formatLocalizedError(err, t));
  }, [refreshTtsVoices, t]);

  useEffect(() => {
    if (!state.voicesLoaded && !state.voicesLoading) {
      void handleRefreshVoices();
    }
  }, [state.voicesLoaded, state.voicesLoading, handleRefreshVoices]);

  const loadTxtFile = useCallback(
    async (rawPath: string) => {
      setLocalError(null);
      const switched = await loadTextToSpeechFile(rawPath, (err) => formatLocalizedError(err, t));
      if (switched && mountedRef.current) {
        setPendingOverwrite(null);
      }
    },
    [loadTextToSpeechFile, t],
  );

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: setDragging,
          onDropPaths: (paths) => {
            setDragging(false);
            if (paths.length > 0 && paths[0]) {
              void loadTxtFile(paths[0]);
            }
          },
        }),
      "t06-file-drop",
    );
  }, [loadTxtFile]);

  const handleOpenTxt = async () => {
    setLocalError(null);
    try {
      const picked = await pickSingleFile({
        title: isZh ? "选择要朗读的纯文本文件（.txt）" : "Select a plain text (.txt) file",
        filters: [
          {
            name: isZh ? "纯文本文件" : "Text Files",
            extensions: ["txt"],
          },
        ],
      });
      if (!picked || !mountedRef.current) return;
      await loadTxtFile(picked);
    } catch (err) {
      if (!mountedRef.current) return;
      setLocalError(formatLocalizedError(err, t));
    }
  };

  const handlePasteClipboard = async () => {
    setLocalError(null);
    try {
      const pasted = await readSystemClipboardText();
      if (!mountedRef.current) return;
      if (!pasted || !pasted.trim()) {
        setLocalError(isZh ? "剪贴板中当前没有可粘贴的文本。" : "Clipboard does not contain text.");
        return;
      }
      updateTextToSpeechSession((prev) => ({
        ...prev,
        text: pasted,
        sourceKind: "none",
        sourceFilePath: null,
        sourceFileName: null,
        sourcePageSummary: null,
        sourceSkippedScannedPages: [],
        sourceOmittedPages: [],
        sourceTruncated: false,
        errorMessage: null,
      }));
    } catch (err) {
      if (!mountedRef.current) return;
      setLocalError(formatLocalizedError(err, t));
    }
  };

  const handleClear = () => {
    setLocalError(null);
    setPendingOverwrite(null);
    clearTextToSpeechSession();
  };

  const handleOpenSpeechSettings = async () => {
    setLocalError(null);
    try {
      await openWindowsSpeechSettings();
    } catch (err) {
      if (!mountedRef.current) return;
      setLocalError(formatLocalizedError(err, t));
    }
  };

  const handleStartSynthesis = async () => {
    if (state.status === "running" || state.loadingFile) return;
    if (!state.text.trim() || !state.selectedVoiceId) return;
    setLocalError(null);
    setPendingOverwrite(null);
    await startTextToSpeech(
      {
        text: state.text,
        voiceId: state.selectedVoiceId,
        rate: state.rate,
        sourcePath: state.sourceFilePath,
      },
      (err) => formatLocalizedError(err, t),
    );
  };

  const executeExport = async (req: ExportTtsAudioRequest, bindingKey: string, seq: number) => {
    if (!isExportStillCurrent(bindingKey, seq)) return;
    setExporting(true);
    setLocalError(null);
    try {
      const saved = await exportTtsAudio(req);
      if (!isExportStillCurrent(bindingKey, seq)) return;
      setPendingOverwrite(null);
      const savedRate = formatSampleRate(saved.sampleRate);
      const bitrateSegment =
        saved.format === "mp3" && saved.bitrateKbps ? `，${saved.bitrateKbps} kbps` : "";
      const bitrateSegmentEn =
        saved.format === "mp3" && saved.bitrateKbps ? `, ${saved.bitrateKbps} kbps` : "";
      updateTextToSpeechSession({
        lastSavedPath: saved.outputPath,
        lastSavedMessage: isZh
          ? `已保存 ${saved.format.toUpperCase()}（${formatDuration(saved.durationSec)}，${savedRate}${bitrateSegment}，${formatMediaBytes(saved.byteLength, locale)}）：${saved.outputPath}`
          : `Saved ${saved.format.toUpperCase()} (${formatDuration(saved.durationSec)}, ${savedRate}${bitrateSegmentEn}, ${formatMediaBytes(saved.byteLength, locale)}): ${saved.outputPath}`,
      });
    } catch (err) {
      if (!isExportStillCurrent(bindingKey, seq)) return;
      const parsed = parseBackendError(err);
      if (parsed.code === "TARGET_ALREADY_EXISTS" && !req.overwrite) {
        setPendingOverwrite({
          request: { ...req, overwrite: true },
          bindingKey,
          seq,
        });
      } else {
        setLocalError(formatLocalizedError(err, t));
      }
    } finally {
      if (mountedRef.current && exportSeqRef.current === seq) {
        setExporting(false);
      }
    }
  };

  const handleExportClick = async () => {
    const bindingKey = exportBindingKey;
    if (!state.result || !bindingKey || exporting) return;
    if (state.exportFormat === "mp3" && !mediaToolsStatus?.ready) return;

    const seq = ++exportSeqRef.current;
    const resultSnapshot = state.result;
    const sourcePathSnapshot = state.sourceFilePath;
    const sourceFileNameSnapshot = state.sourceFileName;
    const formatSnapshot = state.exportFormat;
    const bitrateSnapshot = effectiveMp3BitrateKbps;

    setLocalError(null);
    const ext = formatSnapshot === "mp3" ? "mp3" : "wav";
    let defaultPath: string | undefined;
    if (sourcePathSnapshot) {
      const suggested = await suggestSafeSiblingPath(sourcePathSnapshot, "_speech", ext);
      if (!isExportStillCurrent(bindingKey, seq)) return;
      if (suggested) {
        defaultPath = suggested;
      }
    }
    if (!defaultPath) {
      const stem = (sourceFileNameSnapshot ?? "winkit_speech").replace(/\.[^.]+$/, "") || "speech";
      defaultPath = `${stem}_speech.${ext}`;
    }

    const picked = await pickSaveFilePath({
      title: isZh ? `保存朗读音频（.${ext}）` : `Save Speech Audio (.${ext})`,
      defaultPath,
      filters: [
        {
          name: ext.toUpperCase(),
          extensions: [ext],
        },
      ],
    });
    if (!picked || !isExportStillCurrent(bindingKey, seq)) return;

    const req: ExportTtsAudioRequest = {
      resultId: resultSnapshot.resultId,
      outputPath: picked,
      sourcePath: sourcePathSnapshot,
      format: formatSnapshot,
      mp3BitrateKbps: formatSnapshot === "mp3" ? bitrateSnapshot : null,
      overwrite: false,
    };
    await executeExport(req, bindingKey, seq);
  };

  const stats = useMemo(() => analyzeTextStats(state.text), [state.text]);
  const selectedVoice = useMemo(
    () => state.voices.find((v) => v.id === state.selectedVoiceId) ?? null,
    [state.voices, state.selectedVoiceId],
  );

  const selectedIsZh = Boolean(selectedVoice?.language.toLowerCase().startsWith("zh"));
  const selectedIsEn = Boolean(selectedVoice?.language.toLowerCase().startsWith("en"));

  const guidance = useMemo(() => {
    if (!state.voicesLoaded) return null;
    if (state.voices.length === 0) {
      return {
        tone: "warn" as const,
        text: isZh
          ? "当前 Windows 系统未检测到已安装的本地离线语音。请先打开 Windows 语音设置添加中文或英文语音包，安装完成后点击「刷新语音列表」。"
          : "No installed offline Windows speech voices were detected. Open Windows Speech Settings to install a voice pack, then click Refresh Voices.",
      };
    }
    if (!state.hasChineseVoice) {
      return {
        tone: "warn" as const,
        text: isZh
          ? "当前 Windows 系统尚未安装中文离线语音。如需朗读中文内容，请前往 Windows 语音设置添加中文（简体）语音包；系统已安装的其他语言语音仍可直接离线使用。"
          : "No Chinese offline speech voice is installed on this Windows system. To read Chinese text aloud, add a Chinese voice pack in Windows Speech Settings; other installed voices remain ready to use offline.",
      };
    }
    if (stats.containsLatin && !stats.containsChinese && !state.hasEnglishVoice) {
      return {
        tone: "info" as const,
        text: isZh
          ? "当前文本以英文为主，但系统尚未安装独立英文语音包。可在 Windows 语音设置中添加英文语音以获得更自然的英文发音。"
          : "Your text is primarily English, and no dedicated English voice is installed yet. You can add an English voice pack in Windows Speech Settings for more natural pronunciation.",
      };
    }
    if (selectedVoice && stats.containsChinese && !selectedIsZh) {
      return {
        tone: "info" as const,
        text: isZh
          ? `当前所选语音为「${selectedVoice.name} (${selectedVoice.language})」，与中文文本语言不一致，建议切换到已安装的中文语音以获得准确发音。`
          : `Selected voice "${selectedVoice.name} (${selectedVoice.language})" does not match Chinese text. Switch to an installed Chinese voice for accurate pronunciation.`,
      };
    }
    if (
      selectedVoice &&
      stats.containsLatin &&
      !stats.containsChinese &&
      !selectedIsEn &&
      state.hasEnglishVoice
    ) {
      return {
        tone: "info" as const,
        text: isZh
          ? `当前所选语音为「${selectedVoice.name} (${selectedVoice.language})」，文本以英文为主，建议切换到已安装的英文语音。`
          : `Selected voice "${selectedVoice.name} (${selectedVoice.language})" is non-English while your text is English. Consider switching to an installed English voice.`,
      };
    }
    return null;
  }, [
    state.voicesLoaded,
    state.voices.length,
    state.hasChineseVoice,
    state.hasEnglishVoice,
    stats.containsChinese,
    stats.containsLatin,
    selectedVoice,
    selectedIsZh,
    selectedIsEn,
    isZh,
  ]);

  const isRunning = state.status === "running";
  const hasDraftOrAudition = Boolean(state.text.trim().length > 0 || state.result !== null);
  const hasAnyContent = Boolean(state.text.length > 0 || state.sourceFilePath || state.result);
  const pendingPdf = state.pendingPdfHandoff;
  const pendingPdfPagesLabel = useMemo(() => {
    if (!pendingPdf || pendingPdf.includedPages.length === 0) return null;
    return formatCompactPages(pendingPdf.includedPages);
  }, [pendingPdf]);
  const showPendingPdfBanner = Boolean(pendingPdf && !state.pendingPdfHandoffNeedsConfirm);
  const replacePdfConfirmOpen = Boolean(
    !isRunning && pendingPdf && (state.pendingPdfHandoffNeedsConfirm || confirmPendingQueue),
  );

  const handleRequestLoadPendingPdf = () => {
    if (!pendingPdf || isRunning) return;
    if (hasDraftOrAudition) {
      setConfirmPendingQueue(true);
      return;
    }
    setLocalError(null);
    setPendingOverwrite(null);
    applyPendingPdfHandoff();
  };

  const handleConfirmReplacePdf = () => {
    setConfirmPendingQueue(false);
    setLocalError(null);
    setPendingOverwrite(null);
    applyPendingPdfHandoff();
  };

  const handleCancelReplacePdf = () => {
    setConfirmPendingQueue(false);
    if (state.pendingPdfHandoffNeedsConfirm) {
      dismissPendingPdfHandoff();
    }
  };
  const canStart = Boolean(
    state.text.trim().length > 0 &&
    state.selectedVoiceId &&
    state.voices.length > 0 &&
    !isRunning &&
    !state.loadingFile,
  );
  const canExport = Boolean(
    state.result &&
    !exporting &&
    !isRunning &&
    (state.exportFormat === "wav" || mediaToolsStatus?.ready),
  );
  const activeError = localError ?? state.errorMessage;
  const savedDir = state.lastSavedPath ? getParentDir(state.lastSavedPath) : null;

  return (
    <div className="tts-workspace" data-testid="text-to-speech-workspace">
      <div className="workspace-header">
        <div>
          <h2 className="workspace-title">{isZh ? "文本朗读" : "Read Text Aloud"}</h2>
          <p className="workspace-subtitle">
            {isZh
              ? "调用 Windows 本机已安装的离线语音将粘贴文本、.txt 或从「PDF 快速预览 (C08)」提取的页面文本按段落顺序合成自然语音，支持试听与 WAV / MP3 安全导出"
              : "Synthesize pasted text, .txt files, or PDF pages extracted via C08 paragraph-by-paragraph with installed offline Windows voices, audition inline, and save as WAV or MP3"}
          </p>
        </div>
        <div className="media-actions-row" style={{ flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void handleOpenTxt()}
            data-testid="t06-open-txt-btn"
          >
            <FileText size={14} aria-hidden="true" />
            <span>{isZh ? "打开 .txt 文件" : "Open .txt"}</span>
          </button>
          {pdfSession && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => pdfSession.navigateToPdfReader()}
              data-testid="t06-open-pdf-reader-btn"
            >
              <BookOpen size={14} aria-hidden="true" />
              <span>{isZh ? "从 PDF 朗读 (C08)" : "Read from PDF (C08)"}</span>
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void handlePasteClipboard()}
            data-testid="t06-paste-btn"
          >
            <ClipboardPaste size={14} aria-hidden="true" />
            <span>{isZh ? "粘贴文本" : "Paste"}</span>
          </button>
          {hasAnyContent && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={handleClear}
              data-testid="t06-clear-btn"
            >
              <Eraser size={14} aria-hidden="true" />
              <span>{isZh ? "清空" : "Clear"}</span>
            </button>
          )}
        </div>
      </div>

      {showPendingPdfBanner && pendingPdf && (
        <div className="tts-guidance-banner" role="status" data-testid="t06-pending-handoff-banner">
          <div className="tts-guidance-head">
            <BookOpen size={15} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontWeight: 500, color: "var(--text-primary)" }}>
                {isRunning
                  ? isZh
                    ? "已暂存来自「PDF 快速预览 (C08)」的朗读文本，待当前合成完成或取消后可选择载入："
                    : "PDF text queued from Quick PDF Preview (C08). You can load it once the current synthesis finishes or is cancelled:"
                  : isZh
                    ? "有待处理的 PDF 朗读交接（已保留当前文本与试听结果）："
                    : "Pending PDF read-aloud handoff ready (current draft and audio preserved):"}
              </span>
              <span className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
                {pendingPdf.fileName}
                {pendingPdfPagesLabel
                  ? isZh
                    ? ` · 第 ${pendingPdfPagesLabel} 页`
                    : ` · p. ${pendingPdfPagesLabel}`
                  : ""}
              </span>
            </div>
          </div>
          <div className="tts-guidance-actions">
            {!isRunning && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleRequestLoadPendingPdf}
                data-testid="t06-load-pending-btn"
              >
                <span>{isZh ? "载入待处理 PDF" : "Load Pending PDF"}</span>
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setConfirmPendingQueue(false);
                dismissPendingPdfHandoff();
              }}
              data-testid="t06-dismiss-pending-btn"
            >
              <span>{isZh ? "放弃" : "Dismiss"}</span>
            </button>
          </div>
        </div>
      )}

      <div className="tts-layout">
        {/* Left: Text Editor + File Drop + Missing Voice Guidance */}
        <section
          className={`tts-editor-panel ${dragging ? "is-dragging" : ""}`}
          aria-label={isZh ? "待朗读文本" : "Input Text"}
        >
          <div className="tts-editor-bar">
            <div className="tts-stats-row">
              {state.sourceFileName && (
                <span className="tts-pill is-source" data-testid="t06-source-file-badge">
                  <FileText size={12} aria-hidden="true" />
                  <span>{state.sourceFileName}</span>
                </span>
              )}
              {state.sourceKind === "pdf" && state.sourcePageSummary && (
                <span className="tts-pill mono is-source" data-testid="t06-source-pages-badge">
                  {isZh
                    ? `PDF 第 ${state.sourcePageSummary} 页`
                    : `PDF p. ${state.sourcePageSummary}`}
                </span>
              )}
              <span className="tts-pill mono" data-testid="t06-char-count">
                {isZh ? `${stats.charCount} 字符` : `${stats.charCount} chars`}
              </span>
              <span className="tts-pill mono" data-testid="t06-para-count">
                {isZh
                  ? `${stats.paragraphCount} 段 · 约 ${stats.estimatedSegments} 片段`
                  : `${stats.paragraphCount} paragraphs · ~${stats.estimatedSegments} chunks`}
              </span>
            </div>
            <span className="field-hint" style={{ margin: 0 }}>
              {isZh
                ? "支持拖入 UTF-8 .txt 文件 · 全程离线不上传"
                : "Drop a UTF-8 .txt file · 100% offline"}
            </span>
          </div>

          <textarea
            className="tts-textarea"
            value={state.text}
            onChange={(e) => {
              setLocalError(null);
              updateTextToSpeechSession({
                text: e.target.value,
                errorMessage: null,
              });
            }}
            placeholder={
              isZh
                ? "在此粘贴或输入需要朗读的中文、英文或中英混排文本，或直接拖入本地 .txt 文件…\n\n长文本会自动按段落与句读顺序切分合成，并保留自然段落停顿。"
                : "Paste or type Chinese, English, or mixed text here, or drop a local .txt file...\n\nLong text is split cleanly by paragraph and sentence boundaries in strict order with natural pauses."
            }
            aria-label={isZh ? "朗读文本输入框" : "Text to synthesize"}
            data-testid="t06-text-input"
          />

          {state.sourceKind === "pdf" && state.sourceSkippedScannedPages.length > 0 && (
            <div
              className="tts-guidance-banner"
              role="status"
              data-testid="t06-pdf-scanned-pages-notice"
            >
              <div className="tts-guidance-head">
                <AlertTriangle
                  size={15}
                  aria-hidden="true"
                  style={{ flexShrink: 0, marginTop: 2 }}
                />
                <span>
                  {isZh
                    ? `原 PDF 第 ${formatCompactPages(state.sourceSkippedScannedPages)} 页未检测到可选文字层（纯扫描页），已跳过。如需朗读这些页面，请先使用「扫描版 PDF 转可搜索 (P04)」生成文字层。`
                    : `Page(s) ${formatCompactPages(state.sourceSkippedScannedPages)} of the PDF had no selectable text layer (pure scanned pages) and were skipped. Use Make PDF Searchable (P04) to add an OCR text layer first.`}
                </span>
              </div>
              {pdfSession && state.sourceFilePath && (
                <div className="tts-guidance-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => pdfSession.sendPdfToTool(state.sourceFilePath!, "P04")}
                    data-testid="t06-goto-p04-btn"
                  >
                    <span>{isZh ? "前往 P04 转为可搜索 PDF" : "Make Searchable (P04)"}</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {state.sourceKind === "pdf" &&
            (state.sourceTruncated || state.sourceOmittedPages.length > 0) && (
              <div
                className="tts-guidance-banner is-warn"
                role="status"
                data-testid="t06-pdf-truncated-notice"
              >
                <div className="tts-guidance-head">
                  <AlertTriangle
                    size={15}
                    aria-hidden="true"
                    style={{ flexShrink: 0, marginTop: 2 }}
                  />
                  <span>
                    {state.sourceOmittedPages.length > 0
                      ? isZh
                        ? `所选 PDF 页面文字超过单次离线合成上限（1 MiB / 200,000 字符），已按安全边界截断；第 ${formatCompactPages(state.sourceOmittedPages)} 页因超出上限已省略。建议分批按页范围提取朗读。`
                        : `Extracted PDF text exceeded the single-run offline ceiling (1 MiB / 200,000 chars) and was safely truncated; page(s) ${formatCompactPages(state.sourceOmittedPages)} were omitted. Consider reading smaller page ranges in batches.`
                      : isZh
                        ? "所选 PDF 页面文字超过单次离线合成上限（1 MiB / 200,000 字符），当前页面已按安全边界截断。建议分批按页范围提取朗读。"
                        : "Extracted PDF text exceeded the single-run offline ceiling (1 MiB / 200,000 chars) and was safely truncated. Consider reading smaller page ranges in batches."}
                  </span>
                </div>
              </div>
            )}

          {guidance && (
            <div
              className={`tts-guidance-banner ${guidance.tone === "warn" ? "is-warn" : ""}`}
              role="status"
              data-testid="t06-voice-guidance"
            >
              <div className="tts-guidance-head">
                <AlertTriangle
                  size={15}
                  aria-hidden="true"
                  style={{ flexShrink: 0, marginTop: 2 }}
                />
                <span>{guidance.text}</span>
              </div>
              <div className="tts-guidance-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void handleOpenSpeechSettings()}
                  data-testid="t06-open-speech-settings-btn"
                >
                  <ExternalLink size={13} aria-hidden="true" />
                  <span>{isZh ? "打开 Windows 语音设置" : "Open Windows Speech Settings"}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={state.voicesLoading}
                  onClick={() => void handleRefreshVoices()}
                  data-testid="t06-refresh-voices-guidance-btn"
                >
                  <RefreshCw size={13} aria-hidden="true" />
                  <span>{isZh ? "刷新语音列表" : "Refresh Voices"}</span>
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Right: Voice & Speed Controls + Audition & Export */}
        <aside className="tts-controls-rail">
          <div className="tts-card">
            <h3 className="tts-card-title">
              <Volume2 size={14} aria-hidden="true" />
              <span>{isZh ? "系统离线语音与语速" : "Offline Voice & Speed"}</span>
            </h3>

            <div className="tts-voice-row">
              <select
                className="tts-select"
                value={state.selectedVoiceId}
                disabled={state.voicesLoading || state.voices.length === 0 || isRunning}
                onChange={(e) => updateTextToSpeechSession({ selectedVoiceId: e.target.value })}
                aria-label={isZh ? "选择已安装的系统语音" : "Select installed system voice"}
                data-testid="t06-voice-select"
              >
                {state.voices.length === 0 ? (
                  <option value="">
                    {state.voicesLoaded
                      ? isZh
                        ? "未检测到已安装语音"
                        : "No installed voices found"
                      : isZh
                        ? "正在检测系统语音…"
                        : "Detecting installed voices..."}
                  </option>
                ) : (
                  state.voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {formatVoiceOptionLabel(v, isZh)}
                    </option>
                  ))
                )}
              </select>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={state.voicesLoading || isRunning}
                onClick={() => void handleRefreshVoices()}
                title={isZh ? "重新扫描 Windows 已安装语音" : "Refresh installed Windows voices"}
                aria-label={isZh ? "刷新语音列表" : "Refresh voice list"}
                data-testid="t06-refresh-voices-btn"
              >
                <RefreshCw size={14} aria-hidden="true" />
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <div className="tts-rate-header">
                <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                  <Gauge size={13} aria-hidden="true" />
                  <span>{isZh ? "朗读语速" : "Speaking Rate"}</span>
                </span>
                <span className="mono" data-testid="t06-rate-value">
                  {state.rate.toFixed(2)}×
                </span>
              </div>
              <input
                type="range"
                min={0.5}
                max={2.0}
                step={0.05}
                value={state.rate}
                disabled={isRunning}
                onChange={(e) => updateTextToSpeechSession({ rate: Number(e.target.value) })}
                aria-label={isZh ? "朗读语速滑块" : "Speaking rate slider"}
                data-testid="t06-rate-slider"
              />
              <div className="tts-chip-row">
                {RATE_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    disabled={isRunning}
                    className={`tts-chip-btn mono ${Math.abs(state.rate - preset) < 0.01 ? "is-active" : ""}`}
                    onClick={() => updateTextToSpeechSession({ rate: preset })}
                    data-testid={`t06-rate-${preset}`}
                  >
                    {preset}×
                  </button>
                ))}
              </div>
            </div>

            {!isRunning ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canStart}
                onClick={() => void handleStartSynthesis()}
                data-testid="t06-start-btn"
              >
                <Play size={14} aria-hidden="true" />
                <span>
                  {state.result
                    ? isZh
                      ? "重新离线合成"
                      : "Re-synthesize Offline"
                    : isZh
                      ? "开始离线朗读合成"
                      : "Synthesize Offline"}
                </span>
              </button>
            ) : (
              <>
                <div
                  className="tts-progress-box"
                  role="status"
                  aria-live="polite"
                  data-testid="t06-progress-box"
                >
                  <div className="tts-progress-header">
                    <span>
                      {state.liveProgress && state.liveProgress.totalSegments > 0
                        ? isZh
                          ? `正在合成第 ${state.liveProgress.currentSegment} / ${state.liveProgress.totalSegments} 段…`
                          : `Synthesizing chunk ${state.liveProgress.currentSegment} / ${state.liveProgress.totalSegments}...`
                        : isZh
                          ? "正在离线合成语音…"
                          : "Synthesizing speech offline..."}
                    </span>
                    <span className="mono">{Math.round(state.liveProgress?.percent ?? 5)}%</span>
                  </div>
                  <div className="tts-progress-track">
                    <div
                      className="tts-progress-fill"
                      style={{
                        width: `${Math.min(100, Math.max(5, state.liveProgress?.percent ?? 5))}%`,
                      }}
                    />
                  </div>
                  {state.liveProgress?.detail && (
                    <p className="tts-progress-detail">{state.liveProgress.detail}</p>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => void cancelTextToSpeech()}
                  data-testid="t06-cancel-btn"
                >
                  <X size={14} aria-hidden="true" />
                  <span>{isZh ? "取消合成" : "Cancel"}</span>
                </button>
              </>
            )}

            {activeError && (
              <div className="status-banner is-error" role="alert" data-testid="t06-error-banner">
                {activeError}
              </div>
            )}
          </div>

          <div className="tts-card">
            <h3 className="tts-card-title">
              <Download size={14} aria-hidden="true" />
              <span>{isZh ? "内置试听与保存音频" : "Audition & Export Audio"}</span>
            </h3>

            {state.result ? (
              <>
                <audio
                  key={state.result.resultId}
                  controls
                  preload="metadata"
                  src={state.result.previewUrl}
                  className="tts-audio-player"
                  data-testid="t06-audio-player"
                />
                <div className="tts-meta-grid" data-testid="t06-result-meta">
                  <span className="tts-pill mono">{formatDuration(state.result.durationSec)}</span>
                  <span className="tts-pill mono">{formatSampleRate(state.result.sampleRate)}</span>
                  <span className="tts-pill mono">
                    {state.result.channels === 1
                      ? isZh
                        ? "单声道 16-bit"
                        : "Mono 16-bit"
                      : isZh
                        ? `${state.result.channels} 声道 16-bit`
                        : `${state.result.channels}ch 16-bit`}
                  </span>
                  <span className="tts-pill mono">
                    {isZh
                      ? `${state.result.paragraphCount} 段 / ${state.result.segmentCount} 片段`
                      : `${state.result.paragraphCount} para / ${state.result.segmentCount} chunks`}
                  </span>
                  <span className="tts-pill mono">
                    {formatMediaBytes(state.result.wavByteLength, locale)}
                  </span>
                  <span className="tts-pill">{state.result.voiceName}</span>
                </div>
              </>
            ) : (
              <p className="field-hint" style={{ margin: 0 }}>
                {isZh
                  ? "完成离线合成后可在此直接试听，并无损保存为 WAV 或经本地 FFmpeg 导出为 MP3。"
                  : "After offline synthesis completes, audition the speech inline here and save as lossless WAV or MP3 (via local FFmpeg)."}
              </p>
            )}

            <div
              className="tts-segmented"
              role="radiogroup"
              aria-label={isZh ? "导出音频格式" : "Export audio format"}
            >
              {(
                [
                  { id: "wav", zh: "WAV（纯离线）", en: "WAV (Offline)" },
                  { id: "mp3", zh: "MP3（本地 FFmpeg）", en: "MP3 (FFmpeg)" },
                ] as { id: TtsExportFormat; zh: string; en: string }[]
              ).map((fmt) => (
                <button
                  key={fmt.id}
                  type="button"
                  role="radio"
                  aria-checked={state.exportFormat === fmt.id}
                  className={`tts-seg-btn ${state.exportFormat === fmt.id ? "is-active" : ""}`}
                  onClick={() => updateTextToSpeechSession({ exportFormat: fmt.id })}
                  data-testid={`t06-fmt-${fmt.id}`}
                >
                  {isZh ? fmt.zh : fmt.en}
                </button>
              ))}
            </div>

            {state.exportFormat === "mp3" && (
              <>
                <div className="tts-chip-row" style={{ alignItems: "center" }}>
                  <span className="field-hint" style={{ margin: 0 }}>
                    {isZh ? "MP3 码率" : "MP3 Bitrate"}
                  </span>
                  {availableMp3Bitrates.map((kbps) => (
                    <button
                      key={kbps}
                      type="button"
                      className={`tts-chip-btn mono ${effectiveMp3BitrateKbps === kbps ? "is-active" : ""}`}
                      onClick={() => updateTextToSpeechSession({ mp3BitrateKbps: kbps })}
                      data-testid={`t06-bitrate-${kbps}`}
                    >
                      {kbps} kbps
                    </button>
                  ))}
                </div>
                <MediaToolsSetupPanel onStatusChange={setMediaToolsStatus} />
              </>
            )}

            <button
              type="button"
              className="btn btn-primary"
              disabled={!canExport}
              onClick={() => void handleExportClick()}
              data-testid="t06-export-btn"
            >
              <Download size={14} aria-hidden="true" />
              <span>
                {exporting
                  ? isZh
                    ? "正在导出…"
                    : "Exporting..."
                  : state.exportFormat === "mp3"
                    ? isZh
                      ? "保存为 MP3…"
                      : "Save as MP3..."
                    : isZh
                      ? "保存为 WAV…"
                      : "Save as WAV..."}
              </span>
            </button>

            {state.lastSavedMessage && (
              <div className="status-banner is-ok" role="status" data-testid="t06-saved-banner">
                <span>{state.lastSavedMessage}</span>
                {savedDir && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ marginLeft: "auto", padding: "2px 6px", fontSize: "11.5px" }}
                    onClick={() => void openLocalDirectory(savedDir)}
                  >
                    <FolderOpen size={12} aria-hidden="true" />
                    <span>{isZh ? "打开目录" : "Open Folder"}</span>
                  </button>
                )}
              </div>
            )}

            <p className="tts-scope-note">
              {isZh
                ? "当前支持粘贴文本、.txt 纯文本及经「PDF 快速预览 (C08)」按页提取朗读（含 P04 OCR 可搜索 PDF）与 WAV / MP3 导出；Office 文档直接朗读保留于后续规划。"
                : "Currently supports pasted text, .txt plain text, and page-by-page PDF reading via C08 (including P04 OCR searchable PDFs) with WAV / MP3 export. Direct Office document reading is tracked separately."}
            </p>
          </div>
        </aside>
      </div>

      <ConfirmDialog
        open={replacePdfConfirmOpen}
        title={isZh ? "替换当前朗读稿与试听结果？" : "Replace Current Draft & Audio?"}
        body={
          pendingPdf
            ? isZh
              ? `当前工作区已有编辑文本或可试听音频。是否载入来自「PDF 快速预览 (C08)」的「${pendingPdf.fileName}${pendingPdfPagesLabel ? `（第 ${pendingPdfPagesLabel} 页）` : ""}」？确认后将替换当前文本并清空旧试听；取消则完整保留原稿与试听。`
              : `This workspace already has draft text or synthesized audio. Load "${pendingPdf.fileName}${pendingPdfPagesLabel ? ` (p. ${pendingPdfPagesLabel})` : ""}" from Quick PDF Preview (C08)? Confirming replaces the current text and clears existing audio; cancelling preserves both.`
            : ""
        }
        confirmLabel={isZh ? "确认载入" : "Load PDF Text"}
        cancelLabel={isZh ? "保留原稿与试听" : "Keep Current"}
        danger
        onConfirm={handleConfirmReplacePdf}
        onCancel={handleCancelReplacePdf}
      />

      <ConfirmDialog
        open={pendingOverwrite != null}
        title={isZh ? "覆盖已存在的音频文件？" : "Overwrite Existing Audio File?"}
        body={
          isZh
            ? `目标路径已存在文件：${pendingOverwrite?.request.outputPath ?? ""}。是否确认覆盖？（源文本或源 PDF 文件始终受保护，不会被覆盖）`
            : `A file already exists at: ${pendingOverwrite?.request.outputPath ?? ""}. Overwrite it? (Your source text or PDF file is always protected.)`
        }
        confirmLabel={isZh ? "确认覆盖" : "Overwrite"}
        cancelLabel={isZh ? "取消" : "Cancel"}
        danger
        onConfirm={() => {
          if (
            pendingOverwrite &&
            isExportStillCurrent(pendingOverwrite.bindingKey, pendingOverwrite.seq)
          ) {
            const confirmed = pendingOverwrite;
            setPendingOverwrite(null);
            void executeExport(confirmed.request, confirmed.bindingKey, confirmed.seq);
          } else {
            setPendingOverwrite(null);
          }
        }}
        onCancel={() => setPendingOverwrite(null)}
      />
    </div>
  );
}
