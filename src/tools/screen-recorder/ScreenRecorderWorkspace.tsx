import {
  AlertTriangle,
  AppWindow,
  CheckCircle2,
  Crop,
  Film,
  FolderOpen,
  Image as ImageIcon,
  Mic,
  Minimize2,
  Monitor,
  RefreshCw,
  Scissors,
  Square,
  Trash2,
  Video,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { MediaToolsSetupPanel } from "../../components/MediaToolsSetupPanel";
import { useI18n } from "../../i18n/I18nContext";
import { useMediaSession } from "../../lib/mediaSessionStore";
import {
  bindDisposableListener,
  discardScreenRecording,
  formatLocalizedError,
  getScreenRecorderCapabilities,
  getScreenRecorderStatus,
  listAudioCaptureDevices,
  listAudioPlaybackDevices,
  listCaptureMonitors,
  listCaptureWindows,
  openLocalDirectory,
  pickSaveFilePath,
  pickScreenRecordingRegion,
  startScreenRecording,
  stopScreenRecording,
  subscribeScreenRecorderState,
  type AudioDeviceInfo,
  type CaptureMonitorInfo,
  type CaptureRect,
  type CaptureWindowInfo,
  type MediaToolsStatus,
  type ScreenRecordFormat,
  type ScreenRecordResolution,
  type ScreenRecordTargetKind,
  type ScreenRecorderCapabilities,
  type ScreenRecorderSnapshot,
} from "../../lib/tauriBridge";
import { dbFsToMeterPercent, formatRecorderTimer } from "../audio-recorder/AudioRecorderWorkspace";
import { formatMediaBytes, getParentDir } from "../media-shared/mediaFormat";
import "../media-shared/mediaWorkspace.css";
import "./ScreenRecorderWorkspace.css";

const EMPTY_SNAPSHOT: ScreenRecorderSnapshot = {
  phase: "idle",
  targetKind: null,
  targetSummary: null,
  audioScopeSummary: null,
  elapsedSec: 0,
  framesWritten: 0,
  outputWidth: null,
  outputHeight: null,
  fps: null,
  format: null,
  recordSystemAudio: false,
  recordMicrophone: false,
  systemLevelDb: -96,
  micLevelDb: -96,
  outputPath: null,
  previewUrl: null,
  byteSize: null,
  durationSec: null,
  interruptedReason: null,
  warnings: [],
  errorCode: null,
  errorMessage: null,
};

function buildDefaultScreenRecordingName(format: ScreenRecordFormat): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `WinKit_Screen_${stamp}.${format}`;
}

export function ScreenRecorderWorkspace() {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const { handoffMediaFileToTool } = useMediaSession();

  const [toolsStatus, setToolsStatus] = useState<MediaToolsStatus | null>(null);
  const [caps, setCaps] = useState<ScreenRecorderCapabilities | null>(null);
  const [snapshot, setSnapshot] = useState<ScreenRecorderSnapshot>(EMPTY_SNAPSHOT);

  const [targetKind, setTargetKind] = useState<ScreenRecordTargetKind>("monitor");
  const [monitors, setMonitors] = useState<CaptureMonitorInfo[]>([]);
  const [selectedMonitorId, setSelectedMonitorId] = useState<string>("");
  const [windowsList, setWindowsList] = useState<CaptureWindowInfo[]>([]);
  const [selectedWindowHwnd, setSelectedWindowHwnd] = useState<number>(0);
  const [regionRect, setRegionRect] = useState<CaptureRect | null>(null);

  const [playbackDevices, setPlaybackDevices] = useState<AudioDeviceInfo[]>([]);
  const [micDevices, setMicDevices] = useState<AudioDeviceInfo[]>([]);
  const [recordSystemAudio, setRecordSystemAudio] = useState<boolean>(false);
  const [selectedSystemDeviceId, setSelectedSystemDeviceId] = useState<string>("");
  const [recordMicrophone, setRecordMicrophone] = useState<boolean>(false);
  const [selectedMicDeviceId, setSelectedMicDeviceId] = useState<string>("");

  const [resolution, setResolution] = useState<ScreenRecordResolution>("original");
  const [fps, setFps] = useState<number>(30);
  const [format, setFormat] = useState<ScreenRecordFormat>("mp4");
  const [includeCursor, setIncludeCursor] = useState<boolean>(true);
  const [highlightClicks, setHighlightClicks] = useState<boolean>(false);
  const [showFloatingHud, setShowFloatingHud] = useState<boolean>(true);

  const [outputPath, setOutputPath] = useState<string>("");
  const [overwritePendingPath, setOverwritePendingPath] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [uiError, setUiError] = useState<string | null>(null);

  const refreshSourcesAndAudio = useCallback(async () => {
    try {
      const [mons, wins, renders, mics, capInfo] = await Promise.all([
        listCaptureMonitors(),
        listCaptureWindows(),
        listAudioPlaybackDevices(),
        listAudioCaptureDevices(),
        getScreenRecorderCapabilities(),
      ]);
      setMonitors(mons);
      setWindowsList(wins);
      setPlaybackDevices(renders);
      setMicDevices(mics);
      setCaps(capInfo);

      setSelectedMonitorId((prev) => {
        if (prev && mons.some((m) => m.id === prev)) return prev;
        const primary = mons.find((m) => m.isPrimary) ?? mons[0];
        return primary ? primary.id : "";
      });
      setSelectedWindowHwnd((prev) => {
        if (prev && wins.some((w) => w.hwnd === prev)) return prev;
        const firstValid = wins.find((w) => !w.isProtected) ?? wins[0];
        return firstValid ? firstValid.hwnd : 0;
      });
      setSelectedSystemDeviceId((prev) => {
        if (prev && renders.some((d) => d.id === prev)) return prev;
        const def = renders.find((d) => d.isDefault) ?? renders[0];
        return def ? def.id : "";
      });
      setSelectedMicDeviceId((prev) => {
        if (prev && mics.some((d) => d.id === prev)) return prev;
        const def = mics.find((d) => d.isDefault) ?? mics[0];
        return def ? def.id : "";
      });
    } catch (err) {
      setUiError(formatLocalizedError(err, t));
    }
  }, [t]);

  useEffect(() => {
    void refreshSourcesAndAudio();
    let mounted = true;
    getScreenRecorderStatus()
      .then((snap) => {
        if (mounted) setSnapshot(snap);
      })
      .catch(() => {});

    const unsub = bindDisposableListener(
      () =>
        subscribeScreenRecorderState((nextSnap) => {
          setSnapshot(nextSnap);
          if (nextSnap.phase === "error" && nextSnap.errorMessage) {
            setUiError(
              formatLocalizedError(
                {
                  code: nextSnap.errorCode ?? "MEDIA_PROCESS_FAILED",
                  message: nextSnap.errorMessage,
                },
                t,
              ),
            );
          }
        }),
      "winkit://screen-recorder-state",
    );

    return () => {
      mounted = false;
      unsub();
    };
  }, [refreshSourcesAndAudio, t]);

  const isRecording = snapshot.phase === "recording";
  const isFinalizing = snapshot.phase === "finalizing";
  const isActive = isRecording || isFinalizing;

  const selectedMonitor = monitors.find((m) => m.id === selectedMonitorId) ?? null;
  const selectedWindow = windowsList.find((w) => w.hwnd === selectedWindowHwnd) ?? null;
  const selectedSystemDev = playbackDevices.find((d) => d.id === selectedSystemDeviceId) ?? null;
  const selectedMicDev = micDevices.find((d) => d.id === selectedMicDeviceId) ?? null;

  const preStartTargetSummary = (() => {
    if (targetKind === "monitor") {
      if (!selectedMonitor) return isZh ? "未检测到显示器" : "No display detected";
      return `${selectedMonitor.deviceName}${selectedMonitor.isPrimary ? (isZh ? "（主屏）" : " (Primary)") : ""} · ${selectedMonitor.width}×${selectedMonitor.height} (${selectedMonitor.scalePercent}%)`;
    }
    if (targetKind === "window") {
      if (!selectedWindow) return isZh ? "请选择要录制的窗口" : "Select a window to record";
      return `${selectedWindow.title} (${selectedWindow.processName}) · ${selectedWindow.width}×${selectedWindow.height}`;
    }
    if (!regionRect) return isZh ? "尚未框选区域（点击下方框选）" : "No region selected yet";
    return isZh
      ? `区域 ${regionRect.width}×${regionRect.height} @ (${regionRect.x}, ${regionRect.y})`
      : `Region ${regionRect.width}×${regionRect.height} @ (${regionRect.x}, ${regionRect.y})`;
  })();

  const preStartAudioSummary = (() => {
    if (!recordSystemAudio && !recordMicrophone) {
      return isZh ? "静音（仅画面，不录声音）" : "Muted (Video only)";
    }
    const parts: string[] = [];
    if (recordSystemAudio) {
      const dev = selectedSystemDev?.name ?? (isZh ? "默认播放设备" : "Default playback device");
      parts.push(isZh ? `系统声音（整机回环：${dev}）` : `System Audio (Device loopback: ${dev})`);
    }
    if (recordMicrophone) {
      const dev = selectedMicDev?.name ?? (isZh ? "默认麦克风" : "Default microphone");
      parts.push(isZh ? `麦克风（${dev}）` : `Microphone (${dev})`);
    }
    return parts.join(" + ");
  })();

  const handlePickRegion = async () => {
    setUiError(null);
    setBusyAction("region");
    try {
      const rect = await pickScreenRecordingRegion(true);
      setRegionRect(rect);
    } catch (err) {
      const maybe = err as { code?: string };
      if (maybe?.code !== "TASK_CANCELLED") {
        setUiError(formatLocalizedError(err, t));
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleChangeFormat = (nextFmt: ScreenRecordFormat) => {
    setFormat(nextFmt);
    setOverwritePendingPath(null);
    if (outputPath.trim()) {
      setOutputPath(`${outputPath.replace(/\.(mp4|mov)$/i, "")}.${nextFmt}`);
    }
  };

  const handleBrowseSavePath = async (): Promise<string | null> => {
    const chosen = await pickSaveFilePath({
      title: isZh ? "选择录屏保存路径" : "Choose Screen Recording Output Path",
      defaultPath: outputPath.trim() || buildDefaultScreenRecordingName(format),
      filters:
        format === "mp4"
          ? [{ name: "MP4 Video (H.264)", extensions: ["mp4"] }]
          : [{ name: "QuickTime MOV (H.264)", extensions: ["mov"] }],
    });
    if (chosen) {
      setOutputPath(chosen);
      setOverwritePendingPath(null);
    }
    return chosen;
  };

  const executeStart = async (targetPath: string, allowOverwrite: boolean) => {
    setUiError(null);
    setOverwritePendingPath(null);
    setBusyAction("start");
    try {
      const next = await startScreenRecording({
        targetKind,
        monitorId: targetKind === "monitor" ? selectedMonitorId || null : null,
        windowHwnd: targetKind === "window" ? selectedWindowHwnd || null : null,
        regionRect: targetKind === "region" ? regionRect : null,
        resolution,
        fps,
        format,
        includeCursor,
        highlightClicks,
        recordSystemAudio,
        systemAudioDeviceId: recordSystemAudio ? selectedSystemDeviceId || null : null,
        recordMicrophone,
        microphoneDeviceId: recordMicrophone ? selectedMicDeviceId || null : null,
        outputPath: targetPath,
        allowOverwrite,
        showFloatingHud,
      });
      setSnapshot(next);
    } catch (err) {
      const maybe = err as { code?: string };
      if (maybe?.code === "TARGET_ALREADY_EXISTS" && !allowOverwrite) {
        setOverwritePendingPath(targetPath);
      } else {
        setUiError(formatLocalizedError(err, t));
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleStartClick = async () => {
    if (targetKind === "region" && !regionRect) {
      setUiError(
        isZh ? "请先点击「拖动框选区域」确定录屏范围。" : "Please select a recording region first.",
      );
      return;
    }
    if (targetKind === "window" && (!selectedWindow || selectedWindow.isProtected)) {
      setUiError(
        selectedWindow?.isProtected
          ? isZh
            ? "所选窗口受 Windows 内容保护限制，无法录制。"
            : "Selected window is protected content and cannot be recorded."
          : isZh
            ? "请先选择一个有效的目标窗口。"
            : "Please select a valid target window first.",
      );
      return;
    }
    let target = outputPath.trim();
    if (!target) {
      const picked = await handleBrowseSavePath();
      if (!picked) return;
      target = picked;
    }
    await executeStart(target, false);
  };

  const handleStopAndSave = async () => {
    setUiError(null);
    setBusyAction("stop");
    try {
      const next = await stopScreenRecording();
      setSnapshot(next);
    } catch (err) {
      setUiError(formatLocalizedError(err, t));
    } finally {
      setBusyAction(null);
    }
  };

  const handleDiscard = async () => {
    setUiError(null);
    setBusyAction("discard");
    try {
      const next = await discardScreenRecording();
      setSnapshot(next);
    } catch (err) {
      setUiError(formatLocalizedError(err, t));
    } finally {
      setBusyAction(null);
    }
  };

  const canStart =
    !isActive &&
    busyAction === null &&
    (caps === null || caps.wgcSupported) &&
    (toolsStatus === null || toolsStatus.ready);

  return (
    <div className="media-workspace" data-testid="screen-recorder-workspace">
      <MediaToolsSetupPanel mode="tool" onStatusChange={setToolsStatus} />

      {uiError && (
        <div className="status-banner is-err" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{uiError}</span>
        </div>
      )}

      {/* Clear Pre-Start Summary: Where & Which Sounds */}
      <section
        className="v05-summary-strip"
        aria-label={isZh ? "录制范围摘要" : "Recording Scope Summary"}
      >
        <div className="v05-summary-item">
          <span className="v05-summary-label">
            {isZh ? "录哪里（画面来源）" : "Capture Target"}
          </span>
          <span
            className="v05-summary-value"
            title={preStartTargetSummary}
            data-testid="v05-summary-target"
          >
            {isActive ? (snapshot.targetSummary ?? preStartTargetSummary) : preStartTargetSummary}
          </span>
        </div>
        <div className="v05-summary-item">
          <span className="v05-summary-label">
            {isZh ? "录哪些声音（音频来源）" : "Audio Sources"}
          </span>
          <span
            className="v05-summary-value"
            title={preStartAudioSummary}
            data-testid="v05-summary-audio"
          >
            {isActive ? (snapshot.audioScopeSummary ?? preStartAudioSummary) : preStartAudioSummary}
          </span>
        </div>
      </section>

      {/* Always-Visible Live Recording Controls */}
      {isActive && (
        <section className="v05-live-card" role="status" data-testid="v05-live-panel">
          <div className="v05-live-top">
            <div className="media-setup-title-row">
              <span className={`media-status-pill ${isFinalizing ? "is-warn" : "is-err"}`}>
                {isRecording && <span className="a02-rec-dot" aria-hidden="true" />}
                {isFinalizing
                  ? isZh
                    ? "正在封装并保存视频…"
                    : "Finalizing & Saving Video…"
                  : isZh
                    ? "正在录制屏幕"
                    : "Recording Screen"}
              </span>
              {snapshot.outputWidth && snapshot.outputHeight && (
                <span className="media-status-pill is-neutral mono">
                  {snapshot.outputWidth}×{snapshot.outputHeight} · {snapshot.fps} fps ·{" "}
                  {(snapshot.format ?? "mp4").toUpperCase()}
                </span>
              )}
              <span className="media-status-pill is-neutral mono">
                {snapshot.framesWritten} {isZh ? "帧" : "frames"}
              </span>
            </div>
            <div className="v05-timer" data-testid="v05-live-timer">
              {formatRecorderTimer(snapshot.elapsedSec)}
            </div>
          </div>

          {(snapshot.recordSystemAudio || snapshot.recordMicrophone) && (
            <div className="v05-live-meters">
              {snapshot.recordSystemAudio && (
                <div className="v05-mini-meter">
                  <div className="a02-meter-scale">
                    <span>{isZh ? "系统声音电平" : "System Audio Level"}</span>
                    <span className="mono">
                      {snapshot.systemLevelDb <= -95
                        ? "-∞ dB"
                        : `${snapshot.systemLevelDb.toFixed(1)} dB`}
                    </span>
                  </div>
                  <div className="v05-mini-meter-track">
                    <div
                      className="v05-mini-meter-fill"
                      style={{ width: `${dbFsToMeterPercent(snapshot.systemLevelDb)}%` }}
                    />
                  </div>
                </div>
              )}
              {snapshot.recordMicrophone && (
                <div className="v05-mini-meter">
                  <div className="a02-meter-scale">
                    <span>{isZh ? "麦克风电平" : "Microphone Level"}</span>
                    <span className="mono">
                      {snapshot.micLevelDb <= -95
                        ? "-∞ dB"
                        : `${snapshot.micLevelDb.toFixed(1)} dB`}
                    </span>
                  </div>
                  <div className="v05-mini-meter-track">
                    <div
                      className="v05-mini-meter-fill"
                      style={{ width: `${dbFsToMeterPercent(snapshot.micLevelDb)}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="a02-transport-row">
            <button
              type="button"
              className="btn btn-primary a02-transport-btn-lg"
              disabled={isFinalizing || busyAction !== null}
              onClick={() => void handleStopAndSave()}
              data-testid="v05-stop-save-btn"
            >
              <Square size={15} aria-hidden="true" />
              <span>{isZh ? "停止并保存" : "Stop & Save"}</span>
            </button>
            <button
              type="button"
              className="btn btn-danger a02-transport-btn-lg"
              disabled={isFinalizing || busyAction !== null}
              onClick={() => void handleDiscard()}
              data-testid="v05-discard-btn"
            >
              <Trash2 size={15} aria-hidden="true" />
              <span>{isZh ? "放弃录制（不保存）" : "Discard (Do Not Save)"}</span>
            </button>
          </div>
        </section>
      )}

      {/* Configuration Panels (disabled while recording) */}
      {!isActive && (
        <>
          {/* 1. Target Source Card */}
          <section
            className="media-setup-card"
            aria-label={isZh ? "录制画面来源" : "Video Capture Source"}
          >
            <div className="media-setup-header">
              <div className="media-setup-title-row">
                <Video size={16} aria-hidden="true" />
                <h2 className="media-setup-title">
                  {isZh
                    ? "1. 选择录制画面（Windows.Graphics.Capture）"
                    : "1. Capture Target (Windows.Graphics.Capture)"}
                </h2>
              </div>
              <button
                type="button"
                className="btn"
                disabled={busyAction !== null}
                onClick={() => void refreshSourcesAndAudio()}
              >
                <RefreshCw size={14} aria-hidden="true" />
                <span>{isZh ? "刷新窗口与设备" : "Refresh Sources"}</span>
              </button>
            </div>

            <div className="segmented" role="group" aria-label={isZh ? "录制模式" : "Capture Mode"}>
              <button
                type="button"
                className={`segmented-btn ${targetKind === "monitor" ? "is-selected" : ""}`}
                aria-pressed={targetKind === "monitor"}
                onClick={() => setTargetKind("monitor")}
              >
                <Monitor size={14} aria-hidden="true" />
                <span>{isZh ? "显示器" : "Display"}</span>
              </button>
              <button
                type="button"
                className={`segmented-btn ${targetKind === "window" ? "is-selected" : ""}`}
                aria-pressed={targetKind === "window"}
                onClick={() => setTargetKind("window")}
              >
                <AppWindow size={14} aria-hidden="true" />
                <span>{isZh ? "单个窗口" : "Single Window"}</span>
              </button>
              <button
                type="button"
                className={`segmented-btn ${targetKind === "region" ? "is-selected" : ""}`}
                aria-pressed={targetKind === "region"}
                onClick={() => setTargetKind("region")}
              >
                <Crop size={14} aria-hidden="true" />
                <span>{isZh ? "框选区域" : "Region"}</span>
              </button>
            </div>

            {targetKind === "monitor" && (
              <div className="field-row">
                <span className="field-label">{isZh ? "目标显示器" : "Display"}</span>
                <select
                  aria-label={isZh ? "目标显示器" : "Target Display"}
                  className="select v05-device-select"
                  value={selectedMonitorId}
                  onChange={(e) => setSelectedMonitorId(e.target.value)}
                >
                  {monitors.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.deviceName}
                      {m.isPrimary ? (isZh ? "（主屏）" : " (Primary)") : ""} — {m.width}×{m.height}{" "}
                      ({m.scalePercent}%)
                    </option>
                  ))}
                </select>
              </div>
            )}

            {targetKind === "window" && (
              <div className="field-row">
                <span className="field-label">{isZh ? "目标窗口" : "Window"}</span>
                <select
                  aria-label={isZh ? "目标窗口" : "Target Window"}
                  className="select v05-device-select"
                  value={selectedWindowHwnd}
                  onChange={(e) => setSelectedWindowHwnd(Number(e.target.value))}
                >
                  {windowsList.map((w) => (
                    <option key={w.hwnd} value={w.hwnd} disabled={w.isProtected}>
                      {w.title} ({w.processName}) — {w.width}×{w.height}
                      {w.isProtected ? (isZh ? " [受内容保护不可录]" : " [Protected]") : ""}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {targetKind === "region" && (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <div
                  style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}
                >
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busyAction !== null}
                    onClick={() => void handlePickRegion()}
                    data-testid="v05-pick-region-btn"
                  >
                    <Crop size={14} aria-hidden="true" />
                    <span>{isZh ? "拖动框选录屏区域…" : "Drag to Select Region…"}</span>
                  </button>
                  <span className="field-hint" style={{ margin: 0 }}>
                    {isZh
                      ? "复用 I01 高分屏物理像素框选，按 Esc 或右键取消。"
                      : "Reuses I01 Per-Monitor DPI physical-pixel selector (Esc or right-click cancels)."}
                  </span>
                </div>
                {regionRect && (
                  <div className="v05-region-grid">
                    {(["x", "y", "width", "height"] as const).map((field) => (
                      <label key={field} className="media-setup-meta-item">
                        <span className="media-setup-meta-label">
                          {field === "x"
                            ? "X (px)"
                            : field === "y"
                              ? "Y (px)"
                              : field === "width"
                                ? isZh
                                  ? "宽 (px)"
                                  : "Width (px)"
                                : isZh
                                  ? "高 (px)"
                                  : "Height (px)"}
                        </span>
                        <input
                          type="number"
                          className="input mono"
                          value={regionRect[field]}
                          onChange={(e) => {
                            const val = Math.round(Number(e.target.value) || 0);
                            setRegionRect((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    [field]:
                                      field === "width" || field === "height"
                                        ? Math.max(4, val)
                                        : val,
                                  }
                                : null,
                            );
                          }}
                        />
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* 2. Audio Sources Card */}
          <section
            className="media-setup-card"
            aria-label={isZh ? "录制声音来源" : "Audio Sources"}
          >
            <div className="media-setup-title-row">
              <Volume2 size={16} aria-hidden="true" />
              <h2 className="media-setup-title">
                {isZh
                  ? "2. 选择录制声音（独立开关或双路混录）"
                  : "2. Audio Sources (Independent or Mixed)"}
              </h2>
            </div>

            <div className="field-row">
              <label className="v05-check-label" style={{ minWidth: "180px" }}>
                <input
                  type="checkbox"
                  checked={recordSystemAudio}
                  onChange={(e) => setRecordSystemAudio(e.target.checked)}
                  data-testid="v05-sys-audio-toggle"
                />
                <span>
                  {isZh ? "录制系统声音（WASAPI 回环）" : "Record System Audio (WASAPI Loopback)"}
                </span>
              </label>
              <select
                aria-label={isZh ? "系统播放设备" : "System Playback Device"}
                className="select v05-device-select"
                disabled={!recordSystemAudio || playbackDevices.length === 0}
                value={selectedSystemDeviceId}
                onChange={(e) => setSelectedSystemDeviceId(e.target.value)}
              >
                {playbackDevices.length === 0 ? (
                  <option value="">
                    {isZh ? "未检测到可用播放设备" : "No playback device found"}
                  </option>
                ) : (
                  playbackDevices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                      {d.isDefault ? (isZh ? "（默认播放设备）" : " (Default)") : ""}
                    </option>
                  ))
                )}
              </select>
            </div>

            {recordSystemAudio && (
              <div
                className="status-banner is-warn"
                role="note"
                data-testid="v05-system-audio-scope-note"
              >
                <AlertTriangle size={16} aria-hidden="true" />
                <span>
                  {targetKind === "window"
                    ? isZh
                      ? "声音范围提示（单窗口模式）：系统声音来自所选播放设备的 Windows WASAPI 整机回环输出，会录下该设备播放的全部声音，而非仅限当前选定窗口进程。如需避免其他软件提示音，请提前静音无关程序或切换独立播放设备。"
                      : "Audio scope notice (Single Window mode): System audio captures the entire selected playback device via Windows WASAPI loopback — not isolated to the selected window's process. Mute unrelated apps or choose a dedicated output device if needed."
                    : isZh
                      ? "声音范围提示：系统声音通过 Windows WASAPI 回环录制所选播放设备的全部输出声音。"
                      : "Audio scope notice: System audio captures all playback output from the selected Windows audio device via WASAPI loopback."}
                </span>
              </div>
            )}

            <div className="field-row">
              <label className="v05-check-label" style={{ minWidth: "180px" }}>
                <input
                  type="checkbox"
                  checked={recordMicrophone}
                  onChange={(e) => setRecordMicrophone(e.target.checked)}
                  data-testid="v05-mic-audio-toggle"
                />
                <Mic size={14} aria-hidden="true" />
                <span>{isZh ? "录制麦克风" : "Record Microphone"}</span>
              </label>
              <select
                aria-label={isZh ? "录制麦克风设备" : "Microphone Device"}
                className="select v05-device-select"
                disabled={!recordMicrophone || micDevices.length === 0}
                value={selectedMicDeviceId}
                onChange={(e) => setSelectedMicDeviceId(e.target.value)}
              >
                {micDevices.length === 0 ? (
                  <option value="">{isZh ? "未检测到可用麦克风" : "No microphone found"}</option>
                ) : (
                  micDevices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                      {d.isDefault ? (isZh ? "（默认麦克风）" : " (Default)") : ""}
                    </option>
                  ))
                )}
              </select>
            </div>
          </section>

          {/* 3. Output Format, Resolution, FPS & Capture Options */}
          <section
            className="media-setup-card"
            aria-label={isZh ? "输出参数与保存位置" : "Output Parameters & Save Location"}
          >
            <div className="media-setup-title-row">
              <Film size={16} aria-hidden="true" />
              <h2 className="media-setup-title">
                {isZh ? "3. 输出设置与保存位置" : "3. Output Settings & Destination"}
              </h2>
            </div>

            <div className="field-row">
              <span className="field-label">{isZh ? "分辨率上限" : "Max Resolution"}</span>
              <div
                className="segmented"
                role="group"
                aria-label={isZh ? "分辨率上限" : "Max Resolution"}
              >
                {(
                  [
                    ["original", isZh ? "原尺寸" : "Original"],
                    ["p1440", "1440p"],
                    ["p1080", "1080p"],
                    ["p720", "720p"],
                  ] as const
                ).map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    className={`segmented-btn ${resolution === val ? "is-selected" : ""}`}
                    aria-pressed={resolution === val}
                    onClick={() => setResolution(val)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="field-row">
              <span className="field-label">{isZh ? "帧率与格式" : "FPS & Format"}</span>
              <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                <div className="segmented" role="group" aria-label={isZh ? "帧率" : "Frame Rate"}>
                  {[30, 60].map((v) => (
                    <button
                      key={v}
                      type="button"
                      className={`segmented-btn ${fps === v ? "is-selected" : ""}`}
                      aria-pressed={fps === v}
                      onClick={() => setFps(v)}
                    >
                      {v} fps
                    </button>
                  ))}
                </div>
                <div
                  className="segmented"
                  role="group"
                  aria-label={isZh ? "封装格式" : "Container Format"}
                >
                  <button
                    type="button"
                    className={`segmented-btn ${format === "mp4" ? "is-selected" : ""}`}
                    aria-pressed={format === "mp4"}
                    onClick={() => handleChangeFormat("mp4")}
                  >
                    MP4 (H.264)
                  </button>
                  <button
                    type="button"
                    className={`segmented-btn ${format === "mov" ? "is-selected" : ""}`}
                    aria-pressed={format === "mov"}
                    onClick={() => handleChangeFormat("mov")}
                  >
                    MOV (H.264)
                  </button>
                </div>
              </div>
            </div>

            <div className="v05-check-row">
              <label className="v05-check-label">
                <input
                  type="checkbox"
                  checked={includeCursor}
                  onChange={(e) => setIncludeCursor(e.target.checked)}
                />
                <span>{isZh ? "录制鼠标指针" : "Show Cursor"}</span>
              </label>
              <label className="v05-check-label">
                <input
                  type="checkbox"
                  checked={highlightClicks}
                  onChange={(e) => setHighlightClicks(e.target.checked)}
                />
                <span>{isZh ? "显示点击高亮圆环" : "Highlight Mouse Clicks"}</span>
              </label>
              <label className="v05-check-label">
                <input
                  type="checkbox"
                  checked={showFloatingHud}
                  onChange={(e) => setShowFloatingHud(e.target.checked)}
                />
                <span>
                  {isZh
                    ? "置顶显示录屏状态浮条（不入画面）"
                    : "Show Always-on-Top Status Pill (Excluded from Capture)"}
                </span>
              </label>
            </div>

            <div className="field-row">
              <span className="field-label">{isZh ? "保存路径" : "Output File"}</span>
              <div style={{ display: "flex", gap: "8px", flex: 1, minWidth: 0, flexWrap: "wrap" }}>
                <input
                  type="text"
                  className="input mono"
                  style={{ flex: "1 1 260px", minWidth: 0 }}
                  value={outputPath}
                  onChange={(e) => {
                    setOutputPath(e.target.value);
                    setOverwritePendingPath(null);
                  }}
                  placeholder={
                    isZh
                      ? "点击「开始录屏」选择保存文件，或输入路径…"
                      : "Click Start Recording to choose output path, or enter a path…"
                  }
                />
                <button type="button" className="btn" onClick={() => void handleBrowseSavePath()}>
                  {isZh ? "选择位置…" : "Browse…"}
                </button>
              </div>
            </div>

            {overwritePendingPath && (
              <div className="status-banner is-warn" role="alert">
                <AlertTriangle size={16} aria-hidden="true" />
                <span style={{ flex: 1 }}>
                  {isZh
                    ? `目标文件已存在：${overwritePendingPath}。确认覆盖或另选路径。`
                    : `Target file already exists: ${overwritePendingPath}. Confirm overwrite or choose another filename.`}
                </span>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => void executeStart(overwritePendingPath, true)}
                >
                  {isZh ? "覆盖并开始" : "Overwrite & Start"}
                </button>
                <button type="button" className="btn" onClick={() => setOverwritePendingPath(null)}>
                  {isZh ? "取消" : "Cancel"}
                </button>
              </div>
            )}

            <div className="a02-transport-row">
              <button
                type="button"
                className="btn btn-primary a02-transport-btn-lg"
                disabled={!canStart}
                onClick={() => void handleStartClick()}
                data-testid="v05-start-btn"
              >
                <Video size={16} aria-hidden="true" />
                <span>{isZh ? "开始录屏" : "Start Recording"}</span>
              </button>
            </div>
          </section>
        </>
      )}

      {/* Completed Recording Preview & Handoff Card */}
      {snapshot.phase === "completed" && snapshot.outputPath && (
        <section
          className="media-setup-card"
          aria-label={isZh ? "录屏结果" : "Completed Recording"}
        >
          <div className="media-setup-header">
            <div className="media-setup-title-row">
              <CheckCircle2 size={16} aria-hidden="true" style={{ color: "var(--status-ok)" }} />
              <h2 className="media-setup-title">
                {isZh ? "录屏已保存" : "Screen Recording Saved"}
              </h2>
            </div>
            <div className="a02-meta-pills">
              {snapshot.durationSec != null && (
                <span className="media-status-pill is-neutral mono">
                  {formatRecorderTimer(snapshot.durationSec)}
                </span>
              )}
              {snapshot.outputWidth && snapshot.outputHeight && (
                <span className="media-status-pill is-neutral mono">
                  {snapshot.outputWidth}×{snapshot.outputHeight} · {snapshot.fps} fps
                </span>
              )}
              {snapshot.byteSize != null && (
                <span className="media-status-pill is-neutral mono">
                  {formatMediaBytes(snapshot.byteSize, locale)}
                </span>
              )}
            </div>
          </div>

          {snapshot.interruptedReason === "target_window_closed" && (
            <div className="status-banner is-warn" role="status">
              <AlertTriangle size={16} aria-hidden="true" />
              <span>
                {isZh
                  ? "目标窗口在录制途中关闭，WinKit 已自动收尾并完整保存已录制的全部内容。"
                  : "The target window closed during recording. WinKit automatically finalized and saved everything captured up to that moment."}
              </span>
            </div>
          )}

          {snapshot.warnings.map((w, idx) => (
            <div key={idx} className="status-banner is-warn" role="status">
              <AlertTriangle size={16} aria-hidden="true" />
              <span>{w}</span>
            </div>
          ))}

          {snapshot.previewUrl && (
            <video
              className="v05-preview-video"
              controls
              src={snapshot.previewUrl}
              data-testid="v05-preview-video"
            />
          )}

          <div
            className="mono"
            style={{ fontSize: "12px", wordBreak: "break-all", color: "var(--text-secondary)" }}
          >
            {snapshot.outputPath}
          </div>

          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn"
              onClick={() => handoffMediaFileToTool("V04", snapshot.outputPath!)}
              data-testid="v05-handoff-v04"
            >
              <ImageIcon size={14} aria-hidden="true" />
              <span>{isZh ? "送往 V04 提取封面帧" : "Send to V04 Extract Frames"}</span>
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => handoffMediaFileToTool("V11", snapshot.outputPath!)}
            >
              <Scissors size={14} aria-hidden="true" />
              <span>{isZh ? "送往 V11 剪切" : "Send to V11 Trim"}</span>
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => handoffMediaFileToTool("V06", snapshot.outputPath!)}
            >
              <Minimize2 size={14} aria-hidden="true" />
              <span>{isZh ? "送往 V06 压缩" : "Send to V06 Compress"}</span>
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                const dir = getParentDir(snapshot.outputPath!);
                if (dir) void openLocalDirectory(dir);
              }}
            >
              <FolderOpen size={14} aria-hidden="true" />
              <span>{isZh ? "打开输出目录" : "Open Folder"}</span>
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
