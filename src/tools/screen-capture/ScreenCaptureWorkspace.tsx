import {
  AppWindow,
  Camera,
  Check,
  Copy,
  Crop,
  Download,
  Frame,
  Monitor,
  PenTool,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  Stamp,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useI18n } from "../../i18n/I18nContext";
import {
  useSessionStore,
  type ImageHandoffTarget,
  type ScreenCaptureMode,
} from "../../lib/sessionStore";
import {
  bindDisposableListener,
  cancelBackendTask,
  captureScreenMonitor,
  captureScreenRegion,
  captureScreenScroll,
  captureScreenWindow,
  copyImageAssetToClipboard,
  formatLocalizedError,
  listCaptureMonitors,
  listCaptureWindows,
  parseBackendError,
  pickSaveFilePath,
  saveImageAssetFile,
  subscribeCaptureProgress,
  type SaveAssetFormat,
  type ScrollStopReason,
} from "../../lib/tauriBridge";
import { findRegisteredTool } from "../../registry/tools";
import "./screenCapture.css";

const copy = {
  "zh-CN": {
    modes: {
      region: "区域截图",
      window: "指定窗口",
      monitor: "指定显示器",
      scroll: "滚动长截图",
    } as Record<ScreenCaptureMode, string>,
    countdownLabel: "倒计时",
    countdownNone: "立即",
    countdownSec: (n: number) => `${n} 秒`,
    includeCursor: "包含鼠标指针",
    startRegion: "开始框选区域",
    startWindow: "截取选中窗口",
    startMonitor: "截取选中显示器",
    startScroll: "框选区域并滚动长截图",
    stopCancel: "停止 / 取消",
    refreshTargets: "刷新列表",
    windowsHeading: "可选窗口（已排除 WinKit）",
    monitorsHeading: "已连接显示器",
    noWindows: "未发现可截取的可见窗口，请点击刷新。",
    noMonitors: "未检测到显示器列表，请点击刷新。",
    primaryTag: "主显示器",
    protectedTag: "受系统保护",
    emptyTitle: "选择截图模式开始本地捕获",
    emptyBody:
      "支持自由区域、指定窗口（被遮挡窗口同样可完整捕获）、指定显示器与自动滚动长截图。截图自动隐藏 WinKit 主窗口与浮层，支持 Esc 随时取消，结果可直接复制到剪贴板、另存 PNG/JPEG 或无损送往美化、打码与批注。",
    stopReasons: {
      reached_bottom: "已到达页面底部，拼接完成",
      user_stopped: "已按用户指令停止滚动",
      alignment_failed: "画面变化无法可靠对齐，已自动停止",
      size_limit_reached: "已达到最大长图尺寸上限",
      max_frames_reached: "已达到最大捕获帧数上限",
      single_frame_only: "内容未发生滚动，仅捕获首屏",
    } as Record<ScrollStopReason, string>,
    partialPrompt: (reasonText: string) =>
      `仅得到部分长图（${reasonText}）。请先预览当前拼接结果，再明确选择保留或放弃。`,
    keepPartial: "保留当前部分长图",
    discardCapture: "放弃并清空",
    fitView: "适应窗口",
    scrollView: "原宽滚动浏览",
    copyImg: "复制图片",
    copiedOk: "已复制为 Windows 原生图片（可直接粘贴至画图等应用）",
    savePng: "另存 PNG…",
    saveJpeg: "另存 JPEG…",
    savedOk: (p: string, w: number, h: number) => `已保存 ${w}×${h} px 至 ${p}`,
    handoffPrefix: "送往",
    handoffLabels: {
      I11: "局部打码 (I11)",
      I12: "截图批注 (I12)",
      I03: "截图美化 (I03)",
      I13: "图片水印 (I13)",
    } as Record<ImageHandoffTarget, string>,
    progressCountdown: (rem: number) => `倒计时 ${rem} 秒（按 Esc 取消）…`,
    progressSelecting: "请在屏幕上拖动框选目标区域（Esc 或右键取消）…",
    progressScrolling: (frames: number, height: number) =>
      `正在滚动拼接：已捕获 ${frames} 帧，当前总高度 ${height} px（按 Esc 或点击浮窗立即停止）…`,
    cancelledNotice: "已取消本次截图，未产生额外输出。",
    protectedNote: "Windows 已对该窗口启用受保护内容限制，WinKit 严格遵守系统保护策略。",
    overwriteTitle: "覆盖已有文件？",
    overwriteBody: (p: string) => `目标文件已存在：${p}。是否覆盖？`,
    overwriteConfirm: "确认覆盖",
    cancelBtn: "取消",
    framesPill: (n: number) => `拼接 ${n} 帧`,
  },
  "en-US": {
    modes: {
      region: "Region",
      window: "Window",
      monitor: "Monitor",
      scroll: "Scrolling Capture",
    } as Record<ScreenCaptureMode, string>,
    countdownLabel: "Delay",
    countdownNone: "None",
    countdownSec: (n: number) => `${n}s`,
    includeCursor: "Include pointer",
    startRegion: "Select Region",
    startWindow: "Capture Window",
    startMonitor: "Capture Monitor",
    startScroll: "Select Area & Scroll Capture",
    stopCancel: "Stop / Cancel",
    refreshTargets: "Refresh",
    windowsHeading: "Visible Windows (WinKit Excluded)",
    monitorsHeading: "Connected Displays",
    noWindows: "No capturable windows found. Click Refresh.",
    noMonitors: "No displays detected. Click Refresh.",
    primaryTag: "Primary",
    protectedTag: "Protected",
    emptyTitle: "Choose a capture mode to start",
    emptyBody:
      "Capture a region, specific window (including partially occluded windows), monitor, or auto-scrolling long page. WinKit excludes its own window and selection overlays automatically, supports Esc cancel, and hands off full-resolution images in RAM without intermediate files.",
    stopReasons: {
      reached_bottom: "Reached bottom of scroll area",
      user_stopped: "Stopped by user",
      alignment_failed: "Stopped: frames could not align reliably",
      size_limit_reached: "Stopped: maximum long-image size reached",
      max_frames_reached: "Stopped: maximum frame count reached",
      single_frame_only: "No scroll movement detected (first frame only)",
    } as Record<ScrollStopReason, string>,
    partialPrompt: (reasonText: string) =>
      `Partial long screenshot captured (${reasonText}). Preview it and choose whether to keep or discard.`,
    keepPartial: "Keep Partial Capture",
    discardCapture: "Discard",
    fitView: "Fit Window",
    scrollView: "Scroll Full Width",
    copyImg: "Copy Image",
    copiedOk: "Copied native Windows image (PNG + DIB) to clipboard",
    savePng: "Save PNG…",
    saveJpeg: "Save JPEG…",
    savedOk: (p: string, w: number, h: number) => `Saved ${w}×${h} px to ${p}`,
    handoffPrefix: "Send to",
    handoffLabels: {
      I11: "Redact (I11)",
      I12: "Annotate (I12)",
      I03: "Beautify (I03)",
      I13: "Watermark (I13)",
    } as Record<ImageHandoffTarget, string>,
    progressCountdown: (rem: number) => `Countdown: ${rem}s (Esc to cancel)…`,
    progressSelecting: "Drag on screen to select target area (Esc or right-click cancels)…",
    progressScrolling: (frames: number, height: number) =>
      `Scrolling capture: ${frames} frame(s), ${height} px tall (Esc or HUD click stops immediately)…`,
    cancelledNotice: "Capture cancelled cleanly.",
    protectedNote:
      "Windows display affinity marks this window as protected content; WinKit respects system capture restrictions.",
    overwriteTitle: "Overwrite existing file?",
    overwriteBody: (p: string) => `File already exists: ${p}. Overwrite it?`,
    overwriteConfirm: "Overwrite",
    cancelBtn: "Cancel",
    framesPill: (n: number) => `${n} frames`,
  },
};

export function ScreenCaptureWorkspace() {
  const { locale, t: messages } = useI18n();
  const t = copy[locale];
  const { session, updateScreenCaptureSession, handoffImageToTool } = useSessionStore();
  const st = session.screenCapture;

  const [refreshing, setRefreshing] = useState(false);
  const [scrollPreviewMode, setScrollPreviewMode] = useState(false);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [pendingOverwrite, setPendingOverwrite] = useState<{
    path: string;
    format: SaveAssetFormat;
  } | null>(null);
  const taskSeqRef = useRef(1);

  const busy = st.status === "capturing";
  const capture = st.lastCapture;
  const actionsLocked = busy || (capture?.isPartial && st.partialDecision === "pending");

  const availableHandoffs = useMemo(
    () =>
      (["I12", "I11", "I03", "I13"] as ImageHandoffTarget[]).filter(
        (id) => findRegisteredTool(id) !== undefined,
      ),
    [],
  );

  const refreshTargets = useCallback(async () => {
    setRefreshing(true);
    try {
      const [mons, wins] = await Promise.all([listCaptureMonitors(), listCaptureWindows()]);
      updateScreenCaptureSession((prev) => ({
        ...prev,
        monitors: mons,
        selectedMonitorId:
          mons.find((m) => m.id === prev.selectedMonitorId)?.id ?? mons[0]?.id ?? "",
        windows: wins,
        selectedWindowHwnd:
          wins.find((w) => w.hwnd === prev.selectedWindowHwnd)?.hwnd ?? wins[0]?.hwnd ?? null,
      }));
    } catch {
      // ignore in browser unit tests
    } finally {
      setRefreshing(false);
    }
  }, [updateScreenCaptureSession]);

  useEffect(() => {
    if (st.monitors.length === 0 && st.windows.length === 0) {
      void refreshTargets();
    }
  }, [refreshTargets, st.monitors.length, st.windows.length]);

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeCaptureProgress((payload) => {
          updateScreenCaptureSession((prev) =>
            prev.activeTaskId === payload.taskId ? { ...prev, liveProgress: payload } : prev,
          );
        }),
      "i01-capture-progress",
    );
  }, [updateScreenCaptureSession]);

  const handleStartCapture = async () => {
    if (busy) return;
    setStatusNotice(null);
    const taskId = `i01-cap-${Date.now()}-${taskSeqRef.current++}`;
    updateScreenCaptureSession({
      status: "capturing",
      activeTaskId: taskId,
      liveProgress: null,
      errorMessage: null,
    });

    try {
      let result;
      if (st.mode === "region") {
        result = await captureScreenRegion(taskId, {
          countdownSeconds: st.countdownSeconds,
          includeCursor: st.includeCursor,
          hideMainWindow: true,
        });
      } else if (st.mode === "monitor") {
        result = await captureScreenMonitor(taskId, {
          monitorId: st.selectedMonitorId,
          countdownSeconds: st.countdownSeconds,
          includeCursor: st.includeCursor,
          hideMainWindow: true,
        });
      } else if (st.mode === "window") {
        if (!st.selectedWindowHwnd) {
          throw new Error(t.noWindows);
        }
        result = await captureScreenWindow(taskId, {
          hwnd: st.selectedWindowHwnd,
          countdownSeconds: st.countdownSeconds,
          includeCursor: st.includeCursor,
          hideMainWindow: true,
        });
      } else {
        result = await captureScreenScroll(taskId, {
          countdownSeconds: st.countdownSeconds,
          hideMainWindow: true,
        });
      }

      setScrollPreviewMode(result.asset.height > result.asset.width * 1.8);
      updateScreenCaptureSession({
        status: "idle",
        activeTaskId: null,
        liveProgress: null,
        lastCapture: result,
        partialDecision: result.isPartial ? "pending" : "kept",
        errorMessage: null,
      });
    } catch (err) {
      const parsed = parseBackendError(err);
      if (parsed.code === "TASK_CANCELLED") {
        setStatusNotice(t.cancelledNotice);
        updateScreenCaptureSession({
          status: "idle",
          activeTaskId: null,
          liveProgress: null,
          errorMessage: null,
        });
      } else if (parsed.code === "CAPTURE_PROTECTED") {
        updateScreenCaptureSession({
          status: "idle",
          activeTaskId: null,
          liveProgress: null,
          errorMessage: t.protectedNote,
        });
      } else {
        updateScreenCaptureSession({
          status: "idle",
          activeTaskId: null,
          liveProgress: null,
          errorMessage: formatLocalizedError(err, messages),
        });
      }
    }
  };

  const handleCancelCapture = async () => {
    if (st.activeTaskId) {
      await cancelBackendTask(st.activeTaskId);
    }
  };

  const handleCopyImage = async () => {
    if (!capture || actionsLocked) return;
    setStatusNotice(null);
    try {
      await copyImageAssetToClipboard({
        assetId: capture.asset.assetId,
        dataUrl: capture.asset.dataUrl,
      });
      setStatusNotice(t.copiedOk);
    } catch (err) {
      updateScreenCaptureSession({ errorMessage: formatLocalizedError(err, messages) });
    }
  };

  const runSave = async (outputPath: string, format: SaveAssetFormat, overwrite: boolean) => {
    if (!capture) return;
    setStatusNotice(null);
    try {
      const saved = await saveImageAssetFile({
        assetId: capture.asset.assetId,
        dataUrl: capture.asset.dataUrl,
        outputPath,
        format,
        jpegQuality: 92,
        overwrite,
        toolId: "I01",
      });
      setStatusNotice(t.savedOk(saved.outputPath, saved.width, saved.height));
      updateScreenCaptureSession({ errorMessage: null });
    } catch (err) {
      const parsed = parseBackendError(err);
      if (parsed.code === "TARGET_ALREADY_EXISTS" && !overwrite) {
        setPendingOverwrite({ path: outputPath, format });
        return;
      }
      updateScreenCaptureSession({ errorMessage: formatLocalizedError(err, messages) });
    }
  };

  const handleSaveClick = async (format: SaveAssetFormat) => {
    if (!capture || actionsLocked) return;
    const ext = format === "png" ? "png" : "jpg";
    const defaultName =
      capture.mode === "scroll" ? `winkit_long_capture.${ext}` : `winkit_capture.${ext}`;
    const chosen = await pickSaveFilePath({
      title: format === "png" ? t.savePng : t.saveJpeg,
      defaultPath: defaultName,
      filters: [
        {
          name: format === "png" ? "PNG Image" : "JPEG Image",
          extensions: format === "png" ? ["png"] : ["jpg", "jpeg"],
        },
      ],
    });
    if (chosen) {
      await runSave(chosen, format, false);
    }
  };

  const showTargetRail = st.mode === "window" || st.mode === "monitor";
  const primaryLabel =
    st.mode === "region"
      ? t.startRegion
      : st.mode === "window"
        ? t.startWindow
        : st.mode === "monitor"
          ? t.startMonitor
          : t.startScroll;

  const startDisabled =
    busy ||
    (st.mode === "window" && !st.selectedWindowHwnd) ||
    (st.mode === "monitor" && st.monitors.length === 0);

  return (
    <div className="capture-workspace">
      <section className="capture-toolbar-card">
        <div className="capture-toolbar-row">
          <div className="segmented" role="group" aria-label="Capture mode">
            {(
              [
                ["region", Crop],
                ["window", AppWindow],
                ["monitor", Monitor],
                ["scroll", ScrollText],
              ] as Array<[ScreenCaptureMode, typeof Crop]>
            ).map(([modeId, Icon]) => (
              <button
                key={modeId}
                type="button"
                disabled={busy}
                className={`segmented-btn ${st.mode === modeId ? "is-selected" : ""}`}
                aria-pressed={st.mode === modeId}
                onClick={() => updateScreenCaptureSession({ mode: modeId, errorMessage: null })}
              >
                <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{t.modes[modeId]}</span>
              </button>
            ))}
          </div>

          <div className="capture-group">
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
              <span style={{ color: "var(--text-secondary)" }}>{t.countdownLabel}</span>
              <select
                aria-label={t.countdownLabel}
                className="text-input"
                style={{ width: 84, padding: "4px 6px" }}
                disabled={busy}
                value={st.countdownSeconds}
                onChange={(e) =>
                  updateScreenCaptureSession({ countdownSeconds: Number(e.target.value) })
                }
              >
                <option value={0}>{t.countdownNone}</option>
                <option value={3}>{t.countdownSec(3)}</option>
                <option value={5}>{t.countdownSec(5)}</option>
                <option value={10}>{t.countdownSec(10)}</option>
              </select>
            </label>

            {st.mode !== "scroll" && (
              <label
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12.5,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={st.includeCursor}
                  onChange={(e) => updateScreenCaptureSession({ includeCursor: e.target.checked })}
                />
                <span>{t.includeCursor}</span>
              </label>
            )}

            {busy ? (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void handleCancelCapture()}
              >
                {t.stopCancel}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={startDisabled}
                onClick={() => void handleStartCapture()}
              >
                <Camera size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{primaryLabel}</span>
              </button>
            )}
          </div>
        </div>

        {busy && st.liveProgress && (
          <div className="status-banner" role="status" aria-live="polite">
            <span>
              {st.liveProgress.phase === "countdown" && st.liveProgress.countdownRemaining
                ? t.progressCountdown(st.liveProgress.countdownRemaining)
                : st.liveProgress.phase === "selecting"
                  ? t.progressSelecting
                  : t.progressScrolling(st.liveProgress.frameCount, st.liveProgress.stitchedHeight)}
            </span>
          </div>
        )}

        {st.errorMessage && (
          <div className="status-banner is-err" role="alert">
            <span>{st.errorMessage}</span>
          </div>
        )}

        {statusNotice && !st.errorMessage && (
          <div className="status-banner is-ok" role="status" aria-live="polite">
            <span>{statusNotice}</span>
          </div>
        )}
      </section>

      <div className={`capture-main-grid ${showTargetRail ? "" : "is-full"}`}>
        <section className="capture-stage-card">
          {capture && (
            <div className="capture-toolbar-row">
              <div className="capture-group">
                <strong style={{ fontSize: 13 }}>{capture.asset.label}</strong>
                <span className="capture-pill">
                  {capture.asset.width}×{capture.asset.height} px
                </span>
                {capture.frameCount > 1 && (
                  <span className="capture-pill">{t.framesPill(capture.frameCount)}</span>
                )}
                {capture.stopReason && (
                  <span className={`capture-pill ${capture.isPartial ? "is-warn" : "is-ok"}`}>
                    {t.stopReasons[capture.stopReason]}
                  </span>
                )}
                {capture.note && <span className="capture-pill">{capture.note}</span>}
              </div>

              <div className="capture-group">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setScrollPreviewMode((v) => !v)}
                >
                  {scrollPreviewMode ? t.fitView : t.scrollView}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => {
                    setStatusNotice(null);
                    updateScreenCaptureSession({
                      lastCapture: null,
                      partialDecision: null,
                      errorMessage: null,
                    });
                  }}
                >
                  <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{t.discardCapture}</span>
                </button>
              </div>
            </div>
          )}

          {capture &&
            capture.isPartial &&
            st.partialDecision === "pending" &&
            capture.stopReason && (
              <div className="capture-partial-banner" role="alert">
                <span>{t.partialPrompt(t.stopReasons[capture.stopReason])}</span>
                <div className="capture-group">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => updateScreenCaptureSession({ partialDecision: "kept" })}
                  >
                    <Check size={14} strokeWidth={1.75} aria-hidden="true" />
                    <span>{t.keepPartial}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() =>
                      updateScreenCaptureSession({
                        lastCapture: null,
                        partialDecision: null,
                      })
                    }
                  >
                    {t.discardCapture}
                  </button>
                </div>
              </div>
            )}

          <div className={`capture-stage-canvas ${scrollPreviewMode ? "is-scroll-view" : ""}`}>
            {capture ? (
              <img
                src={capture.asset.dataUrl}
                alt={capture.asset.label}
                className="capture-preview-img"
              />
            ) : (
              <div className="empty-state" style={{ maxWidth: 460 }}>
                <strong style={{ display: "block", marginBottom: 6, color: "var(--text-primary)" }}>
                  {t.emptyTitle}
                </strong>
                <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55 }}>{t.emptyBody}</p>
              </div>
            )}
          </div>

          {capture && (
            <div className="capture-toolbar-row" style={{ paddingTop: 4 }}>
              <div className="capture-group">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={actionsLocked}
                  onClick={() => void handleCopyImage()}
                >
                  <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{t.copyImg}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={actionsLocked}
                  onClick={() => void handleSaveClick("png")}
                >
                  <Download size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{t.savePng}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={actionsLocked}
                  onClick={() => void handleSaveClick("jpeg")}
                >
                  <Download size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{t.saveJpeg}</span>
                </button>
              </div>

              <div className="capture-group">
                {availableHandoffs.map((targetId) => {
                  const Icon =
                    targetId === "I12"
                      ? PenTool
                      : targetId === "I11"
                        ? ShieldAlert
                        : targetId === "I13"
                          ? Stamp
                          : Frame;
                  return (
                    <button
                      key={targetId}
                      type="button"
                      className="btn btn-secondary"
                      disabled={actionsLocked}
                      onClick={() => handoffImageToTool(targetId, capture.asset)}
                    >
                      <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
                      <span>
                        {t.handoffPrefix} {t.handoffLabels[targetId]}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        {showTargetRail && (
          <aside className="capture-target-card">
            <div className="capture-toolbar-row">
              <strong style={{ fontSize: 12.5 }}>
                {st.mode === "window" ? t.windowsHeading : t.monitorsHeading}
              </strong>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy || refreshing}
                onClick={() => void refreshTargets()}
              >
                <RefreshCw size={13} strokeWidth={1.75} aria-hidden="true" />
                <span>{t.refreshTargets}</span>
              </button>
            </div>

            {st.mode === "window" ? (
              st.windows.length === 0 ? (
                <p className="field-hint">{t.noWindows}</p>
              ) : (
                st.windows.map((win) => (
                  <button
                    key={win.hwnd}
                    type="button"
                    className={`capture-target-item ${st.selectedWindowHwnd === win.hwnd ? "is-selected" : ""}`}
                    onClick={() =>
                      updateScreenCaptureSession({
                        selectedWindowHwnd: win.hwnd,
                        errorMessage: null,
                      })
                    }
                  >
                    <span className="capture-target-title" title={win.title}>
                      {win.title}
                    </span>
                    <span className="capture-target-sub">
                      <span>{win.processName || "app"}</span>
                      <span>
                        {win.width}×{win.height}
                      </span>
                      {win.isProtected && (
                        <span className="capture-pill is-err">{t.protectedTag}</span>
                      )}
                    </span>
                  </button>
                ))
              )
            ) : st.monitors.length === 0 ? (
              <p className="field-hint">{t.noMonitors}</p>
            ) : (
              st.monitors.map((mon) => (
                <button
                  key={mon.id}
                  type="button"
                  className={`capture-target-item ${st.selectedMonitorId === mon.id ? "is-selected" : ""}`}
                  onClick={() =>
                    updateScreenCaptureSession({
                      selectedMonitorId: mon.id,
                      errorMessage: null,
                    })
                  }
                >
                  <span className="capture-target-title">
                    {mon.deviceName} {mon.isPrimary ? `(${t.primaryTag})` : ""}
                  </span>
                  <span className="capture-target-sub">
                    <span>
                      {mon.width}×{mon.height} px
                    </span>
                    <span>{mon.scalePercent}% DPI</span>
                  </span>
                </button>
              ))
            )}
          </aside>
        )}
      </div>

      <ConfirmDialog
        open={pendingOverwrite !== null}
        title={t.overwriteTitle}
        body={t.overwriteBody(pendingOverwrite?.path ?? "")}
        confirmLabel={t.overwriteConfirm}
        cancelLabel={t.cancelBtn}
        onCancel={() => setPendingOverwrite(null)}
        onConfirm={async () => {
          const item = pendingOverwrite;
          setPendingOverwrite(null);
          if (item) {
            await runSave(item.path, item.format, true);
          }
        }}
      />
    </div>
  );
}
