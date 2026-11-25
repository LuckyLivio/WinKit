import {
  AlertTriangle,
  Captions,
  CheckCircle2,
  FolderOpen,
  Mic,
  MicOff,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Save,
  Scissors,
  Sparkles,
  Square,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MediaToolsSetupPanel } from "../../components/MediaToolsSetupPanel";
import { useI18n } from "../../i18n/I18nContext";
import { useMediaSession } from "../../lib/mediaSessionStore";
import {
  bindDisposableListener,
  discardAudioRecording,
  formatLocalizedError,
  getAudioRecorderStatus,
  listAudioCaptureDevices,
  openLocalDirectory,
  pauseAudioRecording,
  pickSaveFilePath,
  resumeAudioRecording,
  saveAudioRecording,
  startAudioMonitor,
  startAudioRecording,
  stopAudioMonitor,
  stopAudioRecording,
  subscribeAudioRecorderState,
  type AudioDeviceInfo,
  type AudioRecordOutputFormat,
  type AudioRecorderSnapshot,
  type MediaToolsStatus,
  type SaveAudioRecordingResult,
} from "../../lib/tauriBridge";
import { formatMediaBytes, getParentDir } from "../media-shared/mediaFormat";
import "../media-shared/mediaWorkspace.css";
import "./AudioRecorderWorkspace.css";

const EMPTY_SNAPSHOT: AudioRecorderSnapshot = {
  phase: "idle",
  deviceId: null,
  deviceName: null,
  sampleRate: null,
  channels: null,
  elapsedSec: 0,
  levelRms: 0,
  levelPeak: 0,
  dbFs: -96,
  clipping: false,
  previewUrl: null,
  tempWavPath: null,
  byteSize: null,
  interruptedReason: null,
  errorCode: null,
  errorMessage: null,
};

const HISTORY_BAR_COUNT = 48;

export function formatRecorderTimer(sec: number): string {
  const clamped = Number.isFinite(sec) && sec > 0 ? sec : 0;
  const mins = Math.floor(clamped / 60);
  const rem = clamped - mins * 60;
  const wholeSec = Math.floor(rem);
  const tenths = Math.floor((rem - wholeSec) * 10);
  return `${String(mins).padStart(2, "0")}:${String(wholeSec).padStart(2, "0")}.${tenths}`;
}

export function dbFsToMeterPercent(dbFs: number): number {
  if (!Number.isFinite(dbFs) || dbFs <= -60) return 0;
  if (dbFs >= 0) return 100;
  return Math.round(((dbFs + 60) / 60) * 100);
}

function buildDefaultRecordingName(format: AudioRecordOutputFormat): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `WinKit_Recording_${stamp}.${format}`;
}

function formatChannelsLabel(channels: number | null, isZh: boolean): string {
  if (!channels) return isZh ? "未知声道" : "Unknown ch";
  if (channels === 1) return isZh ? "单声道 (1 ch)" : "Mono (1 ch)";
  if (channels === 2) return isZh ? "双声道 (2 ch)" : "Stereo (2 ch)";
  return `${channels} ch`;
}

export function AudioRecorderWorkspace() {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const { handoffMediaFileToTool } = useMediaSession();

  const [devices, setDevices] = useState<AudioDeviceInfo[]>([]);
  const [devicesLoaded, setDevicesLoaded] = useState(false);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [snapshot, setSnapshot] = useState<AudioRecorderSnapshot>(EMPTY_SNAPSHOT);
  const [levelHistory, setLevelHistory] = useState<number[]>(() =>
    Array.from({ length: HISTORY_BAR_COUNT }, () => 0),
  );
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [uiError, setUiError] = useState<string | null>(null);

  const [outputFormat, setOutputFormat] = useState<AudioRecordOutputFormat>("wav");
  const [m4aBitrateKbps, setM4aBitrateKbps] = useState<number>(192);
  const [outputPath, setOutputPath] = useState<string>("");
  const [toolsStatus, setToolsStatus] = useState<MediaToolsStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [overwritePendingPath, setOverwritePendingPath] = useState<string | null>(null);
  const [lastSaved, setLastSaved] = useState<SaveAudioRecordingResult | null>(null);

  const phaseRef = useRef(snapshot.phase);
  phaseRef.current = snapshot.phase;

  const refreshDevices = useCallback(async () => {
    try {
      const list = await listAudioCaptureDevices();
      setDevices(list);
      setDevicesLoaded(true);
      setSelectedDeviceId((prev) => {
        if (prev && list.some((d) => d.id === prev)) return prev;
        const def = list.find((d) => d.isDefault) ?? list[0];
        return def ? def.id : "";
      });
    } catch (err) {
      setDevicesLoaded(true);
      setUiError(formatLocalizedError(err, t));
    }
  }, [t]);

  // Enumerate devices (privacy-safe: NEVER opens mic) & sync current backend recorder state
  useEffect(() => {
    void refreshDevices();
    let mounted = true;
    getAudioRecorderStatus()
      .then((snap) => {
        if (!mounted) return;
        setSnapshot(snap);
        if (snap.deviceId) {
          setSelectedDeviceId(snap.deviceId);
        }
      })
      .catch(() => {});

    const unsub = bindDisposableListener(
      () =>
        subscribeAudioRecorderState((nextSnap) => {
          setSnapshot(nextSnap);
          if (
            nextSnap.phase === "monitoring" ||
            nextSnap.phase === "recording" ||
            nextSnap.phase === "paused"
          ) {
            const pct = dbFsToMeterPercent(nextSnap.dbFs);
            setLevelHistory((prev) => [...prev.slice(1), pct]);
          } else {
            setLevelHistory(Array.from({ length: HISTORY_BAR_COUNT }, () => 0));
          }
          if (nextSnap.errorCode && nextSnap.phase === "idle") {
            setUiError(
              formatLocalizedError(
                { code: nextSnap.errorCode, message: nextSnap.errorMessage ?? "" },
                t,
              ),
            );
          }
        }),
      "winkit://audio-recorder-state",
    );

    return () => {
      mounted = false;
      unsub();
      // Privacy hygiene: if leaving A02 while ONLY idle-monitoring (not recording), release mic.
      if (phaseRef.current === "monitoring") {
        void stopAudioMonitor().catch(() => {});
      }
    };
  }, [refreshDevices, t]);

  const activeDeviceInfo = devices.find((d) => d.id === selectedDeviceId) ?? null;
  const isRecordingOrPaused = snapshot.phase === "recording" || snapshot.phase === "paused";
  const isMonitoring = snapshot.phase === "monitoring";
  const isReadyToSave = snapshot.phase === "stopped_ready" && Boolean(snapshot.previewUrl);

  const handleToggleMonitor = async () => {
    setUiError(null);
    setBusyAction("monitor");
    try {
      if (isMonitoring) {
        const next = await stopAudioMonitor();
        setSnapshot(next);
      } else {
        const next = await startAudioMonitor(selectedDeviceId || null);
        setSnapshot(next);
      }
    } catch (err) {
      setUiError(formatLocalizedError(err, t));
    } finally {
      setBusyAction(null);
    }
  };

  const handleStartRecording = async () => {
    setUiError(null);
    setOverwritePendingPath(null);
    setLastSaved(null);
    setOutputPath("");
    setBusyAction("start");
    try {
      const next = await startAudioRecording(selectedDeviceId || null);
      setSnapshot(next);
      setLevelHistory(Array.from({ length: HISTORY_BAR_COUNT }, () => 0));
    } catch (err) {
      setUiError(formatLocalizedError(err, t));
    } finally {
      setBusyAction(null);
    }
  };

  const handlePauseResume = async () => {
    setUiError(null);
    setBusyAction("pause");
    try {
      const next =
        snapshot.phase === "recording" ? await pauseAudioRecording() : await resumeAudioRecording();
      setSnapshot(next);
    } catch (err) {
      setUiError(formatLocalizedError(err, t));
    } finally {
      setBusyAction(null);
    }
  };

  const handleStopRecording = async () => {
    setUiError(null);
    setBusyAction("stop");
    try {
      const next = await stopAudioRecording();
      setSnapshot(next);
    } catch (err) {
      setUiError(formatLocalizedError(err, t));
    } finally {
      setBusyAction(null);
    }
  };

  const handleDiscard = async () => {
    setUiError(null);
    setOverwritePendingPath(null);
    setLastSaved(null);
    setOutputPath("");
    setBusyAction("discard");
    try {
      const next = await discardAudioRecording();
      setSnapshot(next);
      setLevelHistory(Array.from({ length: HISTORY_BAR_COUNT }, () => 0));
    } catch (err) {
      setUiError(formatLocalizedError(err, t));
    } finally {
      setBusyAction(null);
    }
  };

  const handleChangeFormat = (fmt: AudioRecordOutputFormat) => {
    setOutputFormat(fmt);
    setOverwritePendingPath(null);
    if (outputPath.trim()) {
      const stripped = outputPath.replace(/\.(wav|m4a)$/i, "");
      setOutputPath(`${stripped}.${fmt}`);
    }
  };

  const handlePickSavePath = async (): Promise<string | null> => {
    const defaultName = outputPath.trim()
      ? outputPath.trim()
      : buildDefaultRecordingName(outputFormat);
    const chosen = await pickSaveFilePath({
      title: isZh ? "保存录音文件" : "Save Audio Recording",
      defaultPath: defaultName,
      filters:
        outputFormat === "wav"
          ? [{ name: "WAV Audio", extensions: ["wav"] }]
          : [{ name: "M4A / AAC Audio", extensions: ["m4a"] }],
    });
    if (chosen) {
      setOutputPath(chosen);
      setOverwritePendingPath(null);
    }
    return chosen;
  };

  const executeSave = async (targetPath: string, allowOverwrite: boolean) => {
    setUiError(null);
    setOverwritePendingPath(null);
    setSaving(true);
    try {
      const result = await saveAudioRecording({
        taskId: `a02-save-${Date.now()}`,
        outputPath: targetPath,
        format: outputFormat,
        bitrateKbps: outputFormat === "m4a" ? m4aBitrateKbps : null,
        allowOverwrite,
      });
      setLastSaved(result);
    } catch (err) {
      const maybeObj = err as { code?: string };
      if (maybeObj?.code === "TARGET_ALREADY_EXISTS" && !allowOverwrite) {
        setOverwritePendingPath(targetPath);
      } else {
        setUiError(formatLocalizedError(err, t));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleSaveClick = async () => {
    let target = outputPath.trim();
    if (!target) {
      const picked = await handlePickSavePath();
      if (!picked) return;
      target = picked;
    }
    await executeSave(target, false);
  };

  const meterPercent = dbFsToMeterPercent(snapshot.dbFs);
  const peakPercent = Math.min(100, Math.round(snapshot.levelPeak * 100));

  const statusPill = (() => {
    switch (snapshot.phase) {
      case "monitoring":
        return {
          cls: "is-ok",
          label: isZh ? "电平监听中（未录制）" : "Monitoring Input (Not Recording)",
        };
      case "recording":
        return { cls: "is-err", label: isZh ? "正在录制" : "Recording" };
      case "paused":
        return { cls: "is-warn", label: isZh ? "已暂停" : "Paused" };
      case "stopped_ready":
        return {
          cls: "is-ok",
          label: isZh ? "录制完成 · 可试听与保存" : "Ready to Audition & Save",
        };
      default:
        return {
          cls: "is-neutral",
          label: isZh ? "待机 · 麦克风未占用" : "Idle · Microphone Released",
        };
    }
  })();

  const displayedSampleRate = snapshot.sampleRate ?? activeDeviceInfo?.sampleRate ?? null;
  const displayedChannels = snapshot.channels ?? activeDeviceInfo?.channels ?? null;

  return (
    <div className="media-workspace" data-testid="audio-recorder-workspace">
      <div className="media-setup-compact">
        <span style={{ color: "var(--text-secondary)" }}>
          {isZh
            ? "仅在你主动点击「启用电平监听」或「开始录音」后打开麦克风；停止或放弃立即释放设备。保存录音后可点击「转写这段录音」直接送入 T01 离线语音转写。"
            : "Microphone capture starts only after you click Monitor or Record and is released immediately on Stop or Discard. After saving, click 'Transcribe Recording' to send it straight to T01 for offline transcription."}
        </span>
      </div>

      {uiError && (
        <div className="status-banner is-err" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{uiError}</span>
        </div>
      )}

      {/* Microphone Selector Card */}
      <section
        className="media-setup-card"
        aria-label={isZh ? "麦克风选择" : "Microphone Selection"}
      >
        <div className="media-setup-header">
          <div className="media-setup-title-row">
            <Mic size={16} aria-hidden="true" />
            <h2 className="media-setup-title">
              {isZh ? "输入设备（麦克风）" : "Input Device (Microphone)"}
            </h2>
            {displayedSampleRate && (
              <span className="media-status-pill is-neutral mono">
                {(displayedSampleRate / 1000).toFixed(1)} kHz ·{" "}
                {formatChannelsLabel(displayedChannels, isZh)}
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn"
              disabled={isRecordingOrPaused || busyAction !== null}
              onClick={() => void refreshDevices()}
            >
              <RefreshCw size={14} aria-hidden="true" />
              <span>{isZh ? "刷新设备" : "Refresh"}</span>
            </button>
            <button
              type="button"
              className={`btn ${isMonitoring ? "btn-primary" : ""}`}
              disabled={
                isRecordingOrPaused ||
                busyAction !== null ||
                (devicesLoaded && devices.length === 0)
              }
              onClick={() => void handleToggleMonitor()}
            >
              {isMonitoring ? (
                <>
                  <MicOff size={14} aria-hidden="true" />
                  <span>{isZh ? "停止监听" : "Stop Monitor"}</span>
                </>
              ) : (
                <>
                  <Radio size={14} aria-hidden="true" />
                  <span>{isZh ? "启用电平监听" : "Enable Level Monitor"}</span>
                </>
              )}
            </button>
          </div>
        </div>

        {devicesLoaded && devices.length === 0 ? (
          <div className="status-banner is-warn" role="status">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>
              {isZh
                ? "当前未检测到可用麦克风。请连接或启用录音设备后点击「刷新设备」，并确认 Windows 隐私设置允许桌面应用访问麦克风。"
                : "No active microphone detected. Connect or enable an input device and click Refresh, and verify Windows microphone privacy settings."}
            </span>
          </div>
        ) : (
          <div className="a02-device-row">
            <select
              aria-label={isZh ? "选择麦克风" : "Select Microphone"}
              className="select a02-device-select"
              value={selectedDeviceId}
              disabled={isRecordingOrPaused || isMonitoring}
              onChange={(e) => setSelectedDeviceId(e.target.value)}
            >
              {devices.map((dev) => (
                <option key={dev.id} value={dev.id}>
                  {dev.name}
                  {dev.isDefault ? (isZh ? "（系统默认）" : " (Default)") : ""}
                  {dev.sampleRate ? ` — ${Math.round(dev.sampleRate / 1000)} kHz` : ""}
                </option>
              ))}
            </select>
          </div>
        )}
      </section>

      {/* Prominent Live Level Meter & Transport Card */}
      <section
        className="a02-meter-card"
        aria-label={isZh ? "实时电平与录制控制" : "Live Meter & Recording Controls"}
      >
        <div className="a02-meter-header">
          <div className="media-setup-title-row">
            <span className={`media-status-pill ${statusPill.cls}`} role="status">
              {snapshot.phase === "recording" && (
                <span className="a02-rec-dot" aria-hidden="true" />
              )}
              {statusPill.label}
            </span>
            {snapshot.clipping && (
              <span className="media-status-pill is-err">
                {isZh ? "削波警告 (CLIP)" : "Clipping"}
              </span>
            )}
          </div>
          <div className="a02-timer" data-testid="a02-timer">
            {formatRecorderTimer(snapshot.elapsedSec)}
          </div>
        </div>

        <div className="a02-meter-box">
          <div className="a02-meter-scale">
            <span>{isZh ? "实时输入电平" : "Live Input Level"}</span>
            <span className="mono" data-testid="a02-dbfs">
              {snapshot.dbFs <= -95 ? "-∞ dBFS" : `${snapshot.dbFs.toFixed(1)} dBFS`}
            </span>
          </div>
          <div
            className="a02-meter-bar-track"
            role="meter"
            aria-label={isZh ? "输入音量电平" : "Input audio level"}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={meterPercent}
          >
            <div className="a02-meter-bar-fill" style={{ width: `${meterPercent}%` }} />
            {peakPercent > 2 && (
              <div className="a02-meter-peak-tick" style={{ left: `${peakPercent}%` }} />
            )}
          </div>
          <div className="a02-meter-scale">
            <span>-60 dB</span>
            <span>-36 dB</span>
            <span>-18 dB</span>
            <span>-6 dB</span>
            <span>0 dB</span>
          </div>
          <div className="a02-history-bars" aria-hidden="true">
            {levelHistory.map((pct, i) => (
              <div
                key={i}
                className={`a02-history-bar ${snapshot.phase === "paused" ? "is-paused" : ""} ${pct >= 94 ? "is-clip" : ""}`}
                style={{ height: `${Math.max(6, pct)}%` }}
              />
            ))}
          </div>
        </div>

        <div className="a02-transport-row">
          {!isRecordingOrPaused ? (
            <button
              type="button"
              className="btn btn-primary a02-transport-btn-lg"
              disabled={busyAction !== null || (devicesLoaded && devices.length === 0)}
              onClick={() => void handleStartRecording()}
              data-testid="a02-start-btn"
            >
              <Mic size={16} aria-hidden="true" />
              <span>
                {isReadyToSave
                  ? isZh
                    ? "开始新录音"
                    : "New Recording"
                  : isZh
                    ? "开始录音"
                    : "Start Recording"}
              </span>
            </button>
          ) : (
            <>
              <button
                type="button"
                className={`btn ${snapshot.phase === "paused" ? "btn-primary" : ""} a02-transport-btn-lg`}
                disabled={busyAction !== null}
                onClick={() => void handlePauseResume()}
                data-testid="a02-pause-btn"
              >
                {snapshot.phase === "paused" ? (
                  <>
                    <Play size={16} aria-hidden="true" />
                    <span>{isZh ? "继续录制" : "Resume"}</span>
                  </>
                ) : (
                  <>
                    <Pause size={16} aria-hidden="true" />
                    <span>{isZh ? "暂停" : "Pause"}</span>
                  </>
                )}
              </button>

              <button
                type="button"
                className="btn btn-primary a02-transport-btn-lg"
                disabled={busyAction !== null}
                onClick={() => void handleStopRecording()}
                data-testid="a02-stop-btn"
              >
                <Square size={15} aria-hidden="true" />
                <span>{isZh ? "停止并试听" : "Stop & Review"}</span>
              </button>

              <button
                type="button"
                className="btn a02-transport-btn-lg"
                disabled={busyAction !== null}
                onClick={() => void handleDiscard()}
                data-testid="a02-discard-btn"
              >
                <Trash2 size={15} aria-hidden="true" />
                <span>{isZh ? "放弃" : "Discard"}</span>
              </button>
            </>
          )}
        </div>

        {snapshot.phase === "paused" && (
          <p className="field-hint" style={{ margin: 0 }}>
            {isZh
              ? "录音已暂停：暂停期间不会写入任何音频帧，点击「继续录制」后无缝衔接上一片段。"
              : "Recording paused: zero samples are written during pause. Click Resume to continue seamlessly."}
          </p>
        )}
      </section>

      {/* Audition & Export Card */}
      {isReadyToSave && (
        <section className="media-setup-card" aria-label={isZh ? "试听与导出" : "Audition & Save"}>
          <div className="media-setup-header">
            <h2 className="media-setup-title">
              {isZh ? "试听并保存录音" : "Audition & Save Recording"}
            </h2>
            <div className="a02-meta-pills">
              <span className="media-status-pill is-neutral mono">
                {formatRecorderTimer(snapshot.elapsedSec)}
              </span>
              {snapshot.sampleRate && (
                <span className="media-status-pill is-neutral mono">
                  {snapshot.sampleRate.toLocaleString()} Hz ·{" "}
                  {formatChannelsLabel(snapshot.channels, isZh)}
                </span>
              )}
              {snapshot.byteSize && (
                <span className="media-status-pill is-neutral mono">
                  {formatMediaBytes(snapshot.byteSize, locale)}
                </span>
              )}
            </div>
          </div>

          {snapshot.interruptedReason === "device_disconnected" && (
            <div className="status-banner is-warn" role="status">
              <AlertTriangle size={16} aria-hidden="true" />
              <span>
                {isZh
                  ? `录制期间麦克风意外断开，已自动安全保留已录制的 ${snapshot.elapsedSec.toFixed(1)} 秒内容，可直接试听或保存。`
                  : `Microphone disconnected during recording. Your recorded ${snapshot.elapsedSec.toFixed(1)}s audio has been safely preserved for review and saving.`}
              </span>
            </div>
          )}

          {snapshot.previewUrl && (
            <audio
              className="a02-audition-player"
              controls
              src={snapshot.previewUrl}
              data-testid="a02-audition-player"
            />
          )}

          <div className="field-row">
            <span className="field-label">{isZh ? "保存格式" : "Format"}</span>
            <div className="segmented" role="group" aria-label={isZh ? "保存格式" : "Format"}>
              <button
                type="button"
                className={`segmented-btn ${outputFormat === "wav" ? "is-selected" : ""}`}
                aria-pressed={outputFormat === "wav"}
                onClick={() => handleChangeFormat("wav")}
              >
                {isZh ? "WAV（无损 PCM）" : "WAV (Lossless PCM)"}
              </button>
              <button
                type="button"
                className={`segmented-btn ${outputFormat === "m4a" ? "is-selected" : ""}`}
                aria-pressed={outputFormat === "m4a"}
                onClick={() => handleChangeFormat("m4a")}
              >
                {isZh ? "M4A / AAC（小体积）" : "M4A / AAC"}
              </button>
            </div>
          </div>

          {outputFormat === "m4a" && (
            <>
              <div className="field-row">
                <span className="field-label">{isZh ? "AAC 码率" : "AAC Bitrate"}</span>
                <div
                  className="segmented"
                  role="group"
                  aria-label={isZh ? "AAC 码率" : "AAC Bitrate"}
                >
                  {[128, 192, 256].map((kbps) => (
                    <button
                      key={kbps}
                      type="button"
                      className={`segmented-btn ${m4aBitrateKbps === kbps ? "is-selected" : ""}`}
                      aria-pressed={m4aBitrateKbps === kbps}
                      onClick={() => setM4aBitrateKbps(kbps)}
                    >
                      {kbps} kbps
                    </button>
                  ))}
                </div>
              </div>
              <MediaToolsSetupPanel mode="tool" onStatusChange={setToolsStatus} />
            </>
          )}

          <div className="field-row">
            <span className="field-label">{isZh ? "保存路径" : "Save Path"}</span>
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
                    ? "点击「保存录音」选择位置，或手动输入目标路径…"
                    : "Click Save Recording to choose path, or enter a target path…"
                }
              />
              <button type="button" className="btn" onClick={() => void handlePickSavePath()}>
                {isZh ? "选择位置…" : "Browse…"}
              </button>
            </div>
          </div>

          {overwritePendingPath && (
            <div className="status-banner is-warn" role="alert">
              <AlertTriangle size={16} aria-hidden="true" />
              <span style={{ flex: 1 }}>
                {isZh
                  ? `目标位置已存在同名文件：${overwritePendingPath}。确认覆盖或另选文件名。`
                  : `Target file already exists: ${overwritePendingPath}. Confirm overwrite or choose another filename.`}
              </span>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void executeSave(overwritePendingPath, true)}
              >
                {isZh ? "确认覆盖" : "Overwrite"}
              </button>
              <button type="button" className="btn" onClick={() => setOverwritePendingPath(null)}>
                {isZh ? "取消" : "Cancel"}
              </button>
            </div>
          )}

          <div className="a02-transport-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                saving || (outputFormat === "m4a" && toolsStatus !== null && !toolsStatus.ready)
              }
              onClick={() => void handleSaveClick()}
              data-testid="a02-save-btn"
            >
              <Save size={15} aria-hidden="true" />
              <span>
                {saving
                  ? isZh
                    ? "正在保存…"
                    : "Saving…"
                  : isZh
                    ? `保存为 ${outputFormat.toUpperCase()}`
                    : `Save as ${outputFormat.toUpperCase()}`}
              </span>
            </button>
            <button
              type="button"
              className="btn"
              disabled={saving}
              onClick={() => void handleDiscard()}
            >
              <Trash2 size={14} aria-hidden="true" />
              <span>{isZh ? "放弃此段录音" : "Discard Take"}</span>
            </button>
          </div>

          {lastSaved && (
            <div
              className="status-banner is-ok"
              role="status"
              style={{ flexWrap: "wrap", gap: "10px" }}
            >
              <CheckCircle2 size={16} aria-hidden="true" />
              <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>
                  {isZh ? "已保存录音" : "Recording saved"} ({lastSaved.format.toUpperCase()} ·{" "}
                  {formatRecorderTimer(lastSaved.durationSec)} ·{" "}
                  {lastSaved.sampleRate.toLocaleString()} Hz ·{" "}
                  {formatChannelsLabel(lastSaved.channels, isZh)} ·{" "}
                  {formatMediaBytes(lastSaved.byteSize, locale)})
                </div>
                <div className="mono" style={{ fontSize: "12px", wordBreak: "break-all" }}>
                  {lastSaved.outputPath}
                </div>
              </div>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => handoffMediaFileToTool("T01", lastSaved.outputPath, "A02")}
                  data-testid="a02-handoff-t01"
                >
                  <Captions size={14} aria-hidden="true" />
                  <span>{isZh ? "转写这段录音" : "Transcribe Recording"}</span>
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => handoffMediaFileToTool("A03", lastSaved.outputPath)}
                  data-testid="a02-handoff-a03"
                >
                  <Scissors size={14} aria-hidden="true" />
                  <span>{isZh ? "送往 A03 剪切" : "Send to A03 Trim"}</span>
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => handoffMediaFileToTool("A01", lastSaved.outputPath)}
                  data-testid="a02-handoff-a01"
                >
                  <Sparkles size={14} aria-hidden="true" />
                  <span>{isZh ? "送往 A01 降噪" : "Send to A01 Clean Up"}</span>
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    const dir = getParentDir(lastSaved.outputPath);
                    if (dir) void openLocalDirectory(dir);
                  }}
                >
                  <FolderOpen size={14} aria-hidden="true" />
                  <span>{isZh ? "打开目录" : "Open Folder"}</span>
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
