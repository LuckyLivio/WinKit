import {
  AlertTriangle,
  AudioLines,
  CheckCircle2,
  ClipboardPaste,
  Download,
  Film,
  FolderOpen,
  Info,
  Play,
  RefreshCw,
  RotateCcw,
  Scissors,
  Search,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MediaToolsSetupPanel } from "../../components/MediaToolsSetupPanel";
import { YtdlpSetupPanel } from "../../components/YtdlpSetupPanel";
import { useI18n } from "../../i18n/I18nContext";
import { useMediaSession } from "../../lib/mediaSessionStore";
import {
  bindDisposableListener,
  cancelBackendTask,
  downloadVideoItem,
  formatLocalizedError,
  openLocalDirectory,
  pickSingleDirectory,
  probeVideoDownloadUrl,
  readSystemClipboardText,
  subscribeVideoDownloadProgress,
  type MediaToolsStatus,
  type VideoDownloadItemResult,
  type VideoDownloadProbeResult,
  type VideoDownloadProgressPayload,
  type VideoDownloadQuality,
  type YtdlpToolsStatus,
} from "../../lib/tauriBridge";
import { formatDurationLabel, formatMediaBytes, getParentDir } from "../media-shared/mediaFormat";
import "../media-shared/mediaWorkspace.css";
import "./VideoDownloadWorkspace.css";

export type QueueItemStatus =
  | "pending"
  | "probing"
  | "ready"
  | "queued"
  | "downloading"
  | "merging"
  | "extracting_audio"
  | "completed"
  | "cancelled"
  | "error";

export interface VideoQueueItem {
  id: string;
  rawUrl: string;
  sanitizedUrl: string;
  status: QueueItemStatus;
  taskId: string | null;
  probe: VideoDownloadProbeResult | null;
  progress: VideoDownloadProgressPayload | null;
  result: VideoDownloadItemResult | null;
  errorCode: string | null;
  errorMessage: string | null;
}

const SENSITIVE_QUERY_KEYS = [
  "token",
  "secret",
  "pass",
  "auth",
  "sig",
  "key",
  "cookie",
  "session",
  "credential",
  "bearer",
  "policy",
  "hdnts",
  "hmac",
  "ticket",
];

/** Client-side display redaction matching backend rules before first probe returns. */
export function redactUrlForPreview(raw: string): string {
  const trimmed = raw.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "";
    }
    const nextParams = new URLSearchParams();
    parsed.searchParams.forEach((value, key) => {
      const lower = key.toLowerCase();
      const isSensitive =
        SENSITIVE_QUERY_KEYS.some((kw) => lower.includes(kw)) ||
        ["e", "st", "h", "sp", "sr", "se", "sv", "code", "expires"].includes(lower) ||
        value.length >= 48;
      nextParams.append(key, isSensitive ? "[REDACTED]" : value);
    });
    const qs = nextParams.toString().replace(/%5BREDACTED%5D/g, "[REDACTED]");
    const hash = parsed.hash ? "#[REDACTED]" : "";
    return `${parsed.origin}${parsed.pathname}${qs ? `?${qs}` : ""}${hash}`;
  } catch {
    return trimmed;
  }
}

export function extractHttpUrlsFromInput(rawInput: string): {
  valid: string[];
  rejectedCount: number;
} {
  const tokens = rawInput
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const seen = new Set<string>();
  const valid: string[] = [];
  let rejectedCount = 0;

  for (const token of tokens) {
    if (
      (token.startsWith("http://") || token.startsWith("https://")) &&
      !/\s/.test(token) &&
      !token.startsWith("-")
    ) {
      if (!seen.has(token)) {
        seen.add(token);
        valid.push(token);
      }
    } else {
      rejectedCount += 1;
    }
  }
  return { valid, rejectedCount };
}

function formatTransferSpeed(bytesPerSec: number | null, locale: string): string | null {
  if (bytesPerSec == null || !Number.isFinite(bytesPerSec) || bytesPerSec <= 0) {
    return null;
  }
  return `${formatMediaBytes(bytesPerSec, locale === "zh-CN" ? "zh-CN" : "en-US")}/s`;
}

function formatEta(etaSec: number | null, isZh: boolean): string | null {
  if (etaSec == null || !Number.isFinite(etaSec) || etaSec < 0) return null;
  const rounded = Math.ceil(etaSec);
  if (rounded < 60) {
    return isZh ? `剩余 ${rounded} 秒` : `${rounded}s left`;
  }
  const mins = Math.floor(rounded / 60);
  const secs = rounded % 60;
  return isZh ? `剩余 ${mins} 分 ${secs} 秒` : `${mins}m ${secs}s left`;
}

export function VideoDownloadWorkspace() {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const { handoffMediaFileToTool } = useMediaSession();

  const [ffmpegStatus, setFfmpegStatus] = useState<MediaToolsStatus | null>(null);
  const [ytdlpStatus, setYtdlpStatus] = useState<YtdlpToolsStatus | null>(null);

  const [urlInput, setUrlInput] = useState("");
  const [inputNotice, setInputNotice] = useState<string | null>(null);
  const [outputDir, setOutputDir] = useState("");
  const [quality, setQuality] = useState<VideoDownloadQuality>("best");
  const [preferH264, setPreferH264] = useState(true);
  const [preferredAudioLanguage, setPreferredAudioLanguage] = useState("");
  const [queue, setQueue] = useState<VideoQueueItem[]>([]);
  const [queueRunning, setQueueRunning] = useState(false);

  const queueRef = useRef<VideoQueueItem[]>(queue);
  queueRef.current = queue;
  const stopQueueRef = useRef(false);
  const activeTaskIdRef = useRef<string | null>(null);

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeVideoDownloadProgress((payload) => {
          setQueue((prev) =>
            prev.map((item) => {
              if (item.id !== payload.itemId) return item;
              const nextStatus: QueueItemStatus =
                payload.phase === "merging"
                  ? "merging"
                  : payload.phase === "extracting_audio"
                    ? "extracting_audio"
                    : payload.phase === "completed"
                      ? "completed"
                      : "downloading";
              return {
                ...item,
                status: nextStatus,
                progress: payload,
              };
            }),
          );
        }),
      "winkit://video-download-progress",
    );
  }, []);

  const discoveredLanguages = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of queue) {
      for (const track of item.probe?.availableAudioLanguages ?? []) {
        if (!map.has(track.language)) {
          map.set(track.language, track.label);
        }
      }
    }
    return Array.from(map.entries()).map(([code, label]) => ({ code, label }));
  }, [queue]);

  const counts = useMemo(() => {
    let completed = 0;
    let failed = 0;
    let active = 0;
    let ready = 0;
    for (const item of queue) {
      if (item.status === "completed") completed += 1;
      else if (item.status === "error" || item.status === "cancelled") failed += 1;
      else if (
        item.status === "downloading" ||
        item.status === "merging" ||
        item.status === "extracting_audio" ||
        item.status === "probing"
      )
        active += 1;
      else ready += 1;
    }
    return { total: queue.length, completed, failed, active, ready };
  }, [queue]);

  const probeSingleItem = useCallback(
    async (itemId: string, rawUrl: string) => {
      setQueue((prev) =>
        prev.map((item) =>
          item.id === itemId
            ? {
                ...item,
                status: "probing",
                errorCode: null,
                errorMessage: null,
              }
            : item,
        ),
      );

      try {
        const probe = await probeVideoDownloadUrl(rawUrl);
        setQueue((prev) =>
          prev.map((item) =>
            item.id === itemId
              ? {
                  ...item,
                  sanitizedUrl: probe.sanitizedUrl,
                  status: "ready",
                  probe,
                  errorCode: null,
                  errorMessage: null,
                }
              : item,
          ),
        );
      } catch (err) {
        const message = formatLocalizedError(err, t);
        const code =
          err && typeof err === "object" && "code" in err && typeof err.code === "string"
            ? err.code
            : "DOWNLOAD_FAILED";
        setQueue((prev) =>
          prev.map((item) =>
            item.id === itemId
              ? {
                  ...item,
                  status: "error",
                  errorCode: code,
                  errorMessage: message,
                }
              : item,
          ),
        );
      }
    },
    [t],
  );

  const handleAddUrls = async () => {
    setInputNotice(null);
    const { valid, rejectedCount } = extractHttpUrlsFromInput(urlInput);
    if (valid.length === 0) {
      setInputNotice(
        isZh
          ? "请输入至少一条有效的 http:// 或 https:// 链接（每行一条）。"
          : "Enter at least one valid http:// or https:// URL (one per line).",
      );
      return;
    }

    const existingUrls = new Set(queueRef.current.map((q) => q.rawUrl));
    const newItems: VideoQueueItem[] = [];
    for (const rawUrl of valid) {
      if (existingUrls.has(rawUrl)) continue;
      newItems.push({
        id: `v01-item-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        rawUrl,
        sanitizedUrl: redactUrlForPreview(rawUrl),
        status: "pending",
        taskId: null,
        probe: null,
        progress: null,
        result: null,
        errorCode: null,
        errorMessage: null,
      });
    }

    if (newItems.length === 0) {
      setInputNotice(
        isZh ? "这些链接已在当前下载队列中。" : "All pasted URLs are already in the queue.",
      );
      return;
    }

    setQueue((prev) => [...prev, ...newItems]);
    setUrlInput("");
    if (rejectedCount > 0) {
      setInputNotice(
        isZh
          ? `已添加 ${newItems.length} 条链接，忽略了 ${rejectedCount} 条非 HTTP(S) 行。`
          : `Added ${newItems.length} URL(s); skipped ${rejectedCount} non-HTTP(S) line(s).`,
      );
    }

    for (const item of newItems) {
      await probeSingleItem(item.id, item.rawUrl);
    }
  };

  const handlePasteFromClipboard = async () => {
    setInputNotice(null);
    try {
      const clip = await readSystemClipboardText();
      if (!clip.trim()) return;
      setUrlInput((prev) => (prev.trim() ? `${prev.trim()}\n${clip.trim()}` : clip.trim()));
    } catch {
      setInputNotice(
        isZh
          ? "无法读取剪贴板文本，请直接按 Ctrl+V 粘贴。"
          : "Unable to read clipboard; paste with Ctrl+V.",
      );
    }
  };

  const handlePickOutputDir = async () => {
    const picked = await pickSingleDirectory({
      title: isZh ? "选择下载保存目录" : "Choose Download Output Folder",
    });
    if (picked) {
      setOutputDir(picked);
      setInputNotice(null);
    }
  };

  const ensureOutputDir = async (): Promise<string | null> => {
    if (outputDir.trim()) return outputDir.trim();
    const picked = await pickSingleDirectory({
      title: isZh ? "选择下载保存目录" : "Choose Download Output Folder",
    });
    if (picked) {
      setOutputDir(picked);
      return picked;
    }
    setInputNotice(
      isZh ? "请先选择一个输出文件夹再开始下载。" : "Choose an output folder before downloading.",
    );
    return null;
  };

  const runSingleDownload = useCallback(
    async (item: VideoQueueItem, destDir: string) => {
      const taskId = `v01-dl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      activeTaskIdRef.current = taskId;

      setQueue((prev) =>
        prev.map((q) =>
          q.id === item.id
            ? {
                ...q,
                status: "downloading",
                taskId,
                errorCode: null,
                errorMessage: null,
                progress: {
                  taskId,
                  itemId: item.id,
                  phase: "downloading",
                  percent: 0,
                  downloadedBytes: 0,
                  totalBytes: item.probe?.estimatedBestBytes ?? null,
                  speedBytesPerSec: null,
                  etaSec: null,
                  message: isZh ? "准备下载…" : "Starting download...",
                },
              }
            : q,
        ),
      );

      try {
        const result = await downloadVideoItem({
          taskId,
          itemId: item.id,
          url: item.rawUrl,
          outputDir: destDir,
          suggestedTitle: item.probe?.title ?? null,
          quality,
          preferH264,
          preferredAudioLanguage: preferredAudioLanguage.trim() || null,
        });

        setQueue((prev) =>
          prev.map((q) =>
            q.id === item.id
              ? {
                  ...q,
                  sanitizedUrl: result.sanitizedUrl,
                  status: "completed",
                  taskId: null,
                  result,
                  errorCode: null,
                  errorMessage: null,
                }
              : q,
          ),
        );
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err && typeof err.code === "string"
            ? err.code
            : "DOWNLOAD_FAILED";
        const isCancelled = code === "TASK_CANCELLED";
        const message = formatLocalizedError(err, t);
        setQueue((prev) =>
          prev.map((q) =>
            q.id === item.id
              ? {
                  ...q,
                  status: isCancelled ? "cancelled" : "error",
                  taskId: null,
                  errorCode: code,
                  errorMessage: message,
                }
              : q,
          ),
        );
      } finally {
        if (activeTaskIdRef.current === taskId) {
          activeTaskIdRef.current = null;
        }
      }
    },
    [isZh, preferH264, preferredAudioLanguage, quality, t],
  );

  const runQueueForIds = async (targetIds: string[]) => {
    if (queueRunning || targetIds.length === 0) return;
    const destDir = await ensureOutputDir();
    if (!destDir) return;

    stopQueueRef.current = false;
    setQueueRunning(true);
    setInputNotice(null);

    setQueue((prev) =>
      prev.map((q) =>
        targetIds.includes(q.id) && q.status !== "completed"
          ? { ...q, status: "queued", errorCode: null, errorMessage: null }
          : q,
      ),
    );

    try {
      for (const id of targetIds) {
        if (stopQueueRef.current) break;
        const current = queueRef.current.find((q) => q.id === id);
        if (!current || current.status === "completed") continue;
        await runSingleDownload(current, destDir);
      }
    } finally {
      setQueueRunning(false);
      // Reset any remaining queued items back to ready when stopped early
      setQueue((prev) => prev.map((q) => (q.status === "queued" ? { ...q, status: "ready" } : q)));
    }
  };

  const handleStartAllPending = async () => {
    const ids = queueRef.current
      .filter((q) => q.status === "ready" || q.status === "pending" || q.status === "cancelled")
      .map((q) => q.id);
    await runQueueForIds(ids);
  };

  const handleRetryFailed = async () => {
    const ids = queueRef.current
      .filter((q) => q.status === "error" || q.status === "cancelled")
      .map((q) => q.id);
    await runQueueForIds(ids);
  };

  const handleStopQueue = async () => {
    stopQueueRef.current = true;
    const activeTid = activeTaskIdRef.current;
    if (activeTid) {
      await cancelBackendTask(activeTid);
    }
  };

  const handleCancelItem = async (item: VideoQueueItem) => {
    if (item.taskId) {
      await cancelBackendTask(item.taskId);
    } else if (item.status === "queued") {
      setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: "cancelled" } : q)));
    }
  };

  const handleRemoveItem = (itemId: string) => {
    setQueue((prev) => prev.filter((q) => q.id !== itemId));
  };

  const handleClearCompleted = () => {
    setQueue((prev) => prev.filter((q) => q.status !== "completed"));
  };

  const statusBadge = (status: QueueItemStatus) => {
    switch (status) {
      case "pending":
        return { cls: "", text: isZh ? "待解析" : "Pending" };
      case "probing":
        return { cls: "is-accent", text: isZh ? "解析中…" : "Inspecting..." };
      case "ready":
        return { cls: "is-accent", text: isZh ? "已就绪" : "Ready" };
      case "queued":
        return { cls: "", text: isZh ? "排队中" : "Queued" };
      case "downloading":
        return { cls: "is-accent", text: isZh ? "下载中" : "Downloading" };
      case "merging":
        return { cls: "is-accent", text: isZh ? "合并音视频" : "Merging" };
      case "extracting_audio":
        return { cls: "is-accent", text: isZh ? "提取 M4A" : "Extracting M4A" };
      case "completed":
        return { cls: "is-ok", text: isZh ? "已完成" : "Completed" };
      case "cancelled":
        return { cls: "is-warn", text: isZh ? "已取消" : "Cancelled" };
      case "error":
        return { cls: "is-warn", text: isZh ? "失败" : "Failed" };
    }
  };

  const canStartQueue =
    !queueRunning &&
    queue.some((q) => q.status === "ready" || q.status === "pending" || q.status === "cancelled");
  const canRetryFailed =
    !queueRunning && queue.some((q) => q.status === "error" || q.status === "cancelled");

  return (
    <div className="v01-workspace">
      <div className="v01-setup-stack">
        <MediaToolsSetupPanel mode="tool" onStatusChange={setFfmpegStatus} />
        <YtdlpSetupPanel mode="tool" onStatusChange={setYtdlpStatus} />
      </div>

      {!ffmpegStatus?.ready && (
        <div className="status-banner is-warn" role="status">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>
            {isZh
              ? "未检测到 FFmpeg/ffprobe：普通单文件直链仍可下载，但高清分离音视频合并与仅音频 M4A 导出需要配置 FFmpeg。"
              : "FFmpeg/ffprobe not configured: single-file direct links still download, while adaptive stream merging and M4A extraction require FFmpeg."}
          </span>
        </div>
      )}

      <section
        className="v01-input-card"
        aria-label={isZh ? "添加视频链接与选项" : "Add URLs and Options"}
      >
        <div className="v01-input-header">
          <label htmlFor="v01-urls-input" className="v01-control-label">
            {isZh
              ? "粘贴一个或多个 HTTP(S) 链接（每行一条；支持直链媒体、HLS/DASH 及公开视频页）"
              : "Paste one or more HTTP(S) URLs (one per line; supports direct media, HLS/DASH, and public video pages)"}
          </label>
          <div className="media-actions-row">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void handlePasteFromClipboard()}
            >
              <ClipboardPaste size={14} aria-hidden="true" />
              <span>{isZh ? "粘贴链接" : "Paste"}</span>
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!urlInput.trim()}
              onClick={() => void handleAddUrls()}
            >
              <Search size={14} aria-hidden="true" />
              <span>{isZh ? "解析并加入队列" : "Inspect & Add"}</span>
            </button>
          </div>
        </div>

        <textarea
          id="v01-urls-input"
          className="v01-url-textarea"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          placeholder={
            isZh
              ? "https://example.com/video.mp4\nhttps://example.com/watch?v=..."
              : "https://example.com/video.mp4\nhttps://example.com/watch?v=..."
          }
          spellCheck={false}
        />

        {inputNotice && (
          <div className="status-banner is-warn" role="status">
            <Info size={14} aria-hidden="true" />
            <span>{inputNotice}</span>
          </div>
        )}

        <div className="v01-controls-grid">
          <div className="v01-control-group">
            <span className="v01-control-label">
              {isZh ? "清晰度与输出类型" : "Quality & Format"}
            </span>
            <div
              className="segmented"
              role="group"
              aria-label={isZh ? "清晰度预设" : "Quality preset"}
            >
              {(
                [
                  ["best", isZh ? "最佳" : "Best"],
                  ["max_1080p", isZh ? "最高 1080p" : "Max 1080p"],
                  ["max_720p", isZh ? "最高 720p" : "Max 720p"],
                  ["audio_m4a", isZh ? "仅音频 M4A" : "Audio M4A"],
                ] as const
              ).map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  className={`segmented-btn ${quality === val ? "is-selected" : ""}`}
                  aria-pressed={quality === val}
                  disabled={queueRunning}
                  onClick={() => setQuality(val)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="v01-control-group">
            <label htmlFor="v01-audio-lang" className="v01-control-label">
              {isZh ? "首选音轨语言" : "Preferred Audio Language"}
            </label>
            <select
              id="v01-audio-lang"
              className="select-input"
              value={preferredAudioLanguage}
              disabled={queueRunning}
              onChange={(e) => setPreferredAudioLanguage(e.target.value)}
            >
              <option value="">{isZh ? "自动（默认音轨）" : "Auto (default track)"}</option>
              {discoveredLanguages.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.label}
                </option>
              ))}
              {!discoveredLanguages.some((l) => l.code.startsWith("zh")) && (
                <option value="zh">{isZh ? "中文 (zh)" : "Chinese (zh)"}</option>
              )}
              {!discoveredLanguages.some((l) => l.code.startsWith("en")) && (
                <option value="en">English (en)</option>
              )}
              {!discoveredLanguages.some((l) => l.code.startsWith("ja")) && (
                <option value="ja">日本語 (ja)</option>
              )}
            </select>
          </div>

          <div className="v01-control-group">
            <span className="v01-control-label">{isZh ? "编码兼容性" : "Codec Compatibility"}</span>
            <label className="v01-toggle-row">
              <input
                type="checkbox"
                checked={preferH264}
                disabled={queueRunning || quality === "audio_m4a"}
                onChange={(e) => setPreferH264(e.target.checked)}
              />
              <span>
                {isZh
                  ? "优先 H.264（更适合 Windows 与剪辑软件播放）"
                  : "Prefer H.264 (broadest Windows & editor compatibility)"}
              </span>
            </label>
          </div>
        </div>

        <div className="v01-control-group">
          <span className="v01-control-label">
            {isZh
              ? "保存目录（同名文件自动编号，绝不覆盖原文件）"
              : "Output Folder (collision-safe, never overwrites)"}
          </span>
          <div className="v01-output-row">
            <div className="v01-output-path mono" title={outputDir || undefined}>
              {outputDir || (isZh ? "尚未选择目录（开始下载时也可选择）" : "Not selected yet")}
            </div>
            <button
              type="button"
              className="btn"
              disabled={queueRunning}
              onClick={() => void handlePickOutputDir()}
            >
              <FolderOpen size={14} aria-hidden="true" />
              <span>{isZh ? "选择保存目录…" : "Choose Folder..."}</span>
            </button>
            {outputDir && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void openLocalDirectory(outputDir)}
              >
                <span>{isZh ? "打开目录" : "Open"}</span>
              </button>
            )}
          </div>
        </div>
      </section>

      <section
        className="v01-queue-section"
        aria-label={isZh ? "下载队列与结果" : "Download Queue & Results"}
      >
        <div className="v01-queue-header">
          <div className="v01-queue-counts">
            <h3 className="media-setup-title" style={{ margin: 0 }}>
              {isZh ? `下载队列（${counts.total}）` : `Download Queue (${counts.total})`}
            </h3>
            {counts.completed > 0 && (
              <span className="v01-meta-pill is-ok">
                {isZh ? `已完成 ${counts.completed}` : `${counts.completed} done`}
              </span>
            )}
            {counts.failed > 0 && (
              <span className="v01-meta-pill is-warn">
                {isZh ? `未完成/失败 ${counts.failed}` : `${counts.failed} failed/cancelled`}
              </span>
            )}
            {ytdlpStatus && !ytdlpStatus.ready && (
              <span className="v01-meta-pill">
                {isZh ? "当前仅启用直链下载" : "Direct-link mode (yt-dlp not set up)"}
              </span>
            )}
          </div>

          <div className="media-actions-row">
            {!queueRunning ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canStartQueue}
                onClick={() => void handleStartAllPending()}
              >
                <Play size={14} aria-hidden="true" />
                <span>{isZh ? "开始下载队列" : "Start Queue"}</span>
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void handleStopQueue()}
              >
                <Square size={14} aria-hidden="true" />
                <span>{isZh ? "停止当前队列" : "Stop Queue"}</span>
              </button>
            )}

            {canRetryFailed && (
              <button type="button" className="btn" onClick={() => void handleRetryFailed()}>
                <RotateCcw size={14} aria-hidden="true" />
                <span>{isZh ? "重试失败项" : "Retry Failed"}</span>
              </button>
            )}

            {counts.completed > 0 && !queueRunning && (
              <button type="button" className="btn btn-ghost" onClick={handleClearCompleted}>
                <Trash2 size={14} aria-hidden="true" />
                <span>{isZh ? "清空已完成" : "Clear Done"}</span>
              </button>
            )}
          </div>
        </div>

        {queue.length === 0 ? (
          <div className="v01-empty-queue">
            {isZh
              ? "在上方粘贴一条或多条视频 / 媒体链接并点击「解析并加入队列」，即可查看标题、可用清晰度与音轨语言并逐项下载。日志与界面会自动隐藏令牌和签名查询参数。"
              : "Paste one or more video or media URLs above and click Inspect & Add to view titles, resolutions, and audio tracks before downloading. Sensitive tokens and signatures are redacted automatically."}
          </div>
        ) : (
          <div className="v01-queue-list" role="list">
            {queue.map((item) => {
              const badge = statusBadge(item.status);
              const isRunning =
                item.status === "downloading" ||
                item.status === "merging" ||
                item.status === "extracting_audio";
              const itemClass =
                item.status === "completed"
                  ? "is-completed"
                  : item.status === "error"
                    ? "is-error"
                    : isRunning
                      ? "is-running"
                      : "";

              const speedText = formatTransferSpeed(
                item.progress?.speedBytesPerSec ?? null,
                locale,
              );
              const etaText = formatEta(item.progress?.etaSec ?? null, isZh);

              return (
                <article key={item.id} role="listitem" className={`v01-queue-item ${itemClass}`}>
                  <div className="v01-item-top">
                    <div className="v01-item-title-block">
                      <div className="v01-item-title-row">
                        <span className={`v01-meta-pill ${badge.cls}`}>{badge.text}</span>
                        <span className="v01-item-title">
                          {item.result?.title ?? item.probe?.title ?? item.sanitizedUrl}
                        </span>
                      </div>
                      <span className="v01-item-url mono">{item.sanitizedUrl}</span>
                    </div>

                    <div className="v01-item-actions">
                      {!isRunning && item.status !== "probing" && (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          disabled={queueRunning}
                          onClick={() => void probeSingleItem(item.id, item.rawUrl)}
                          title={isZh ? "重新解析链接信息" : "Re-inspect URL"}
                        >
                          <RefreshCw size={13} aria-hidden="true" />
                          <span>{isZh ? "解析" : "Inspect"}</span>
                        </button>
                      )}

                      {(item.status === "ready" ||
                        item.status === "pending" ||
                        item.status === "cancelled" ||
                        item.status === "error") && (
                        <button
                          type="button"
                          className="btn"
                          disabled={queueRunning}
                          onClick={() => void runQueueForIds([item.id])}
                        >
                          {item.status === "error" || item.status === "cancelled" ? (
                            <>
                              <RotateCcw size={13} aria-hidden="true" />
                              <span>{isZh ? "重试" : "Retry"}</span>
                            </>
                          ) : (
                            <>
                              <Download size={13} aria-hidden="true" />
                              <span>{isZh ? "下载" : "Download"}</span>
                            </>
                          )}
                        </button>
                      )}

                      {(isRunning || item.status === "queued") && (
                        <button
                          type="button"
                          className="btn btn-danger"
                          onClick={() => void handleCancelItem(item)}
                        >
                          <X size={13} aria-hidden="true" />
                          <span>{isZh ? "取消" : "Cancel"}</span>
                        </button>
                      )}

                      {!isRunning && item.status !== "probing" && (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          disabled={queueRunning && item.status === "queued"}
                          onClick={() => handleRemoveItem(item.id)}
                          aria-label={isZh ? "移除队列项" : "Remove item"}
                        >
                          <Trash2 size={13} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </div>

                  {item.probe && (
                    <div className="v01-pill-row">
                      <span className="v01-meta-pill">{item.probe.extractor}</span>
                      {item.probe.durationSec != null && (
                        <span className="v01-meta-pill mono">
                          {formatDurationLabel(item.probe.durationSec, locale)}
                        </span>
                      )}
                      {item.probe.estimatedBestBytes != null &&
                        item.probe.estimatedBestBytes > 0 && (
                          <span className="v01-meta-pill mono">
                            ~{formatMediaBytes(item.probe.estimatedBestBytes, locale)}
                          </span>
                        )}
                      {item.probe.availableResolutions.length > 0 && (
                        <span className="v01-meta-pill">
                          {isZh ? "清晰度: " : "Resolutions: "}
                          {item.probe.availableResolutions
                            .slice(0, 5)
                            .map((h) => `${h}p`)
                            .join(" / ")}
                        </span>
                      )}
                      {item.probe.availableAudioLanguages.length > 0 && (
                        <span className="v01-meta-pill">
                          {isZh ? "音轨: " : "Audio: "}
                          {item.probe.availableAudioLanguages.map((l) => l.label).join(", ")}
                        </span>
                      )}
                      {item.probe.isDirectMedia && (
                        <span className="v01-meta-pill is-ok">
                          {isZh ? "直链媒体（无需 yt-dlp）" : "Direct media (no yt-dlp needed)"}
                        </span>
                      )}
                    </div>
                  )}

                  {isRunning && item.progress && (
                    <div className="v01-progress-block" role="status" aria-live="polite">
                      <div className="v01-progress-stats">
                        <span>
                          {item.status === "merging"
                            ? isZh
                              ? "正在通过本地 FFmpeg 合并音视频…"
                              : "Merging audio & video via local FFmpeg..."
                            : item.status === "extracting_audio"
                              ? isZh
                                ? "正在提取 M4A 音频…"
                                : "Extracting M4A audio..."
                              : item.progress.downloadedBytes != null
                                ? `${formatMediaBytes(item.progress.downloadedBytes, locale)}${
                                    item.progress.totalBytes
                                      ? ` / ${formatMediaBytes(item.progress.totalBytes, locale)}`
                                      : ""
                                  }`
                                : (item.progress.message ??
                                  (isZh ? "正在传输…" : "Transferring..."))}
                        </span>
                        <span className="mono">
                          {[
                            item.progress.percent != null
                              ? `${Math.round(item.progress.percent)}%`
                              : null,
                            speedText,
                            etaText,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </div>
                      <div className="media-progress-bar">
                        <div
                          className="media-progress-fill"
                          style={{
                            width: `${Math.min(100, Math.max(2, item.progress.percent ?? 8))}%`,
                          }}
                        />
                      </div>
                    </div>
                  )}

                  {item.errorMessage && (
                    <div
                      className={`status-banner ${item.status === "cancelled" ? "is-warn" : "is-err"}`}
                      role="alert"
                    >
                      <AlertTriangle size={14} aria-hidden="true" />
                      <span>
                        {item.errorCode ? `[${item.errorCode}] ` : ""}
                        {item.errorMessage}
                      </span>
                    </div>
                  )}

                  {item.result && (
                    <div className="v01-result-box">
                      <div className="v01-item-title-row">
                        <CheckCircle2
                          size={14}
                          aria-hidden="true"
                          style={{ color: "var(--status-ok)" }}
                        />
                        <span className="v01-result-filename mono">{item.result.fileName}</span>
                        {item.result.renamedForCollision && (
                          <span className="v01-meta-pill is-warn">
                            {isZh ? "同名已自动编号保护" : "Auto-numbered (no overwrite)"}
                          </span>
                        )}
                      </div>

                      <div className="v01-pill-row">
                        <span className="v01-meta-pill mono">
                          {formatMediaBytes(item.result.byteSize, locale)}
                        </span>
                        {item.result.width && item.result.height ? (
                          <span className="v01-meta-pill mono">
                            {item.result.width}×{item.result.height}
                          </span>
                        ) : (
                          <span className="v01-meta-pill">{isZh ? "仅音频" : "Audio only"}</span>
                        )}
                        {item.result.videoCodec && (
                          <span className="v01-meta-pill mono">
                            {isZh ? "视频: " : "Video: "}
                            {item.result.videoCodec}
                          </span>
                        )}
                        {item.result.audioCodec && (
                          <span className="v01-meta-pill mono">
                            {isZh ? "音频: " : "Audio: "}
                            {item.result.audioCodec}
                          </span>
                        )}
                        {item.result.audioLanguage && (
                          <span className="v01-meta-pill">
                            {isZh ? "音轨语言: " : "Audio lang: "}
                            {item.result.audioLanguage}
                          </span>
                        )}
                        {item.result.durationSec != null && (
                          <span className="v01-meta-pill mono">
                            {formatDurationLabel(item.result.durationSec, locale)}
                          </span>
                        )}
                        {item.result.sha256 && (
                          <span className="v01-meta-pill mono" title={item.result.sha256}>
                            SHA-256: {item.result.sha256.slice(0, 12)}…
                          </span>
                        )}
                      </div>

                      {item.result.warnings.map((w, idx) => (
                        <div key={idx} className="status-banner is-warn" role="status">
                          <Info size={13} aria-hidden="true" />
                          <span>{w}</span>
                        </div>
                      ))}

                      <div className="v01-handoff-row">
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() =>
                            void openLocalDirectory(getParentDir(item.result!.outputPath))
                          }
                        >
                          <FolderOpen size={13} aria-hidden="true" />
                          <span>{isZh ? "打开所在目录" : "Open Folder"}</span>
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => handoffMediaFileToTool("V10", item.result!.outputPath)}
                        >
                          <Info size={13} aria-hidden="true" />
                          <span>{isZh ? "送往 V10 媒体信息" : "Inspect (V10)"}</span>
                        </button>
                        {item.result.width != null && (
                          <>
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={() => handoffMediaFileToTool("V11", item.result!.outputPath)}
                            >
                              <Scissors size={13} aria-hidden="true" />
                              <span>{isZh ? "送往 V11 剪切" : "Trim (V11)"}</span>
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={() => handoffMediaFileToTool("V04", item.result!.outputPath)}
                            >
                              <Film size={13} aria-hidden="true" />
                              <span>{isZh ? "送往 V04 抽帧" : "Frames (V04)"}</span>
                            </button>
                          </>
                        )}
                        {item.result.audioCodec && (
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() => handoffMediaFileToTool("A03", item.result!.outputPath)}
                          >
                            <AudioLines size={13} aria-hidden="true" />
                            <span>{isZh ? "送往 A03 音频剪切" : "Audio Trim (A03)"}</span>
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
