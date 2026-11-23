import {
  CheckCircle2,
  Crop,
  FilePlus2,
  FlipHorizontal2,
  FlipVertical2,
  FolderOpen,
  Info,
  RotateCcw,
  RotateCw,
  Undo2,
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
import { useMediaSession, type CropAspectPreset } from "../../lib/mediaSessionStore";
import {
  bindDisposableListener,
  extractOrientedPreviewFrame,
  formatLocalizedError,
  openLocalDirectory,
  pickSaveFilePath,
  pickSingleFile,
  probeMediaInfo,
  subscribeFileDrop,
  type MediaToolsStatus,
} from "../../lib/tauriBridge";
import {
  VIDEO_EXTENSIONS,
  formatMediaBytes,
  formatTimecode,
  getFileName,
  getFileStemAndExt,
  getParentDir,
} from "../media-shared/mediaFormat";
import "../media-shared/mediaWorkspace.css";
import {
  applyOrientationOp,
  aspectRatioValue,
  clampCropRect,
  fitCropToAspect,
  getOrientedDimensions,
  makeEven,
  type CropRect,
} from "./cropGeometry";

type DragHandle = "move" | "nw" | "ne" | "sw" | "se";

export function VideoCropWorkspace() {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const {
    mediaSession,
    updateVideoCropSession,
    startVideoCropTask,
    cancelVideoCropTask,
    handoffMediaFileToTool,
    pendingHandoff,
    consumePendingHandoff,
  } = useMediaSession();
  const state = mediaSession.videoCrop;

  const [toolsStatus, setToolsStatus] = useState<MediaToolsStatus | null>(null);
  const [hovering, setHovering] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    handle: DragHandle;
    startClientX: number;
    startClientY: number;
    startRect: CropRect;
    stageW: number;
    stageH: number;
  } | null>(null);

  const { width: orientedW, height: orientedH } = getOrientedDimensions(
    state.displayWidth,
    state.displayHeight,
    state.rotateCw,
  );

  const loadVideoFile = useCallback(
    async (path: string) => {
      setLoadingPreview(true);
      try {
        const probe = await probeMediaInfo(path);
        const v0 = probe.videoStreams[0];
        if (!v0) {
          throw new Error(isZh ? "该文件不包含视频流。" : "Selected file has no video stream.");
        }
        const frame = await extractOrientedPreviewFrame(path, null);
        const dispW = frame.displayWidth || v0.displayWidth || v0.codedWidth || 1280;
        const dispH = frame.displayHeight || v0.displayHeight || v0.codedHeight || 720;
        const { stem } = getFileStemAndExt(path);
        const parent = getParentDir(path);
        const defaultOut = parent ? `${parent}\\${stem}_cropped.mp4` : `${stem}_cropped.mp4`;
        const initRect = clampCropRect({ x: 0, y: 0, width: dispW, height: dispH }, dispW, dispH);

        updateVideoCropSession((prev) => ({
          ...prev,
          sourcePath: path,
          probe,
          previewFrameUrl: frame.dataUrl,
          previewTimestampSec: frame.timestampSec,
          displayWidth: dispW,
          displayHeight: dispH,
          rotateCw: 0,
          flipH: false,
          flipV: false,
          aspectPreset: "free",
          cropX: initRect.x,
          cropY: initRect.y,
          cropWidth: initRect.width,
          cropHeight: initRect.height,
          outputPath: defaultOut,
          lastResult: null,
          errorMessage: null,
        }));
      } catch (err) {
        updateVideoCropSession((prev) => ({
          ...prev,
          errorMessage: formatLocalizedError(err, t),
        }));
      } finally {
        setLoadingPreview(false);
      }
    },
    [isZh, t, updateVideoCropSession],
  );

  useEffect(() => {
    if (pendingHandoff?.toolId === "V09") {
      const path = consumePendingHandoff("V09");
      if (path) void loadVideoFile(path);
    }
  }, [pendingHandoff, consumePendingHandoff, loadVideoFile]);

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: setHovering,
          onDropPaths: (paths) => {
            if (paths[0]) void loadVideoFile(paths[0]);
          },
        }),
      "v09-file-drop",
    );
  }, [loadVideoFile]);

  // Render exact transformed frame onto canvas (matching FFmpeg rotateCw -> flipH -> flipV 1:1)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !state.previewFrameUrl || orientedW < 2 || orientedH < 2) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = new Image();
    img.onload = () => {
      canvas.width = orientedW;
      canvas.height = orientedH;
      ctx.save();
      ctx.clearRect(0, 0, orientedW, orientedH);
      ctx.translate(orientedW / 2, orientedH / 2);
      // Apply flipV, then flipH, then rotateCw in reverse canvas order so effective order is:
      // rotateCw FIRST, then flipH, then flipV (matching FFmpeg `-vf transpose,hflip,vflip`)
      if (state.flipV) ctx.scale(1, -1);
      if (state.flipH) ctx.scale(-1, 1);
      if (state.rotateCw !== 0) {
        ctx.rotate((state.rotateCw * Math.PI) / 180);
      }
      ctx.drawImage(
        img,
        -state.displayWidth / 2,
        -state.displayHeight / 2,
        state.displayWidth,
        state.displayHeight,
      );
      ctx.restore();
    };
    img.src = state.previewFrameUrl;
  }, [
    state.previewFrameUrl,
    state.displayWidth,
    state.displayHeight,
    state.rotateCw,
    state.flipH,
    state.flipV,
    orientedW,
    orientedH,
  ]);

  const handlePickVideo = async () => {
    const picked = await pickSingleFile({
      title: isZh ? "选择要裁剪或旋转的视频" : "Select a video to crop or rotate",
      filters: [{ name: isZh ? "视频文件" : "Video Files", extensions: VIDEO_EXTENSIONS }],
    });
    if (picked) await loadVideoFile(picked);
  };

  const handlePickOutput = async () => {
    if (!state.sourcePath) return;
    const { stem } = getFileStemAndExt(state.sourcePath);
    const chosen = await pickSaveFilePath({
      title: isZh ? "选择裁剪输出路径" : "Choose output file path",
      defaultPath: state.outputPath || `${stem}_cropped.mp4`,
      filters: [{ name: "MP4", extensions: ["mp4"] }],
    });
    if (chosen) {
      updateVideoCropSession((prev) => ({ ...prev, outputPath: chosen }));
    }
  };

  const handleTransformOp = (op: "rotate_cw" | "rotate_ccw" | "flip_h" | "flip_v") => {
    if (orientedW < 2 || orientedH < 2) return;
    const res = applyOrientationOp(
      { rotateCw: state.rotateCw, flipH: state.flipH, flipV: state.flipV },
      { x: state.cropX, y: state.cropY, width: state.cropWidth, height: state.cropHeight },
      orientedW,
      orientedH,
      op,
    );
    updateVideoCropSession((prev) => ({
      ...prev,
      rotateCw: res.transform.rotateCw,
      flipH: res.transform.flipH,
      flipV: res.transform.flipV,
      cropX: res.rect.x,
      cropY: res.rect.y,
      cropWidth: res.rect.width,
      cropHeight: res.rect.height,
      lastResult: null,
    }));
  };

  const handleSelectAspect = (preset: CropAspectPreset) => {
    const fitted = fitCropToAspect(orientedW, orientedH, preset);
    updateVideoCropSession((prev) => ({
      ...prev,
      aspectPreset: preset,
      cropX: fitted.x,
      cropY: fitted.y,
      cropWidth: fitted.width,
      cropHeight: fitted.height,
      lastResult: null,
    }));
  };

  const handleReset = () => {
    const full = clampCropRect(
      { x: 0, y: 0, width: state.displayWidth, height: state.displayHeight },
      state.displayWidth,
      state.displayHeight,
    );
    updateVideoCropSession((prev) => ({
      ...prev,
      rotateCw: 0,
      flipH: false,
      flipV: false,
      aspectPreset: "free",
      cropX: full.x,
      cropY: full.y,
      cropWidth: full.width,
      cropHeight: full.height,
      lastResult: null,
    }));
  };

  const handleSeekPreviewFrame = async (ts: number) => {
    if (!state.sourcePath) return;
    setLoadingPreview(true);
    try {
      const frame = await extractOrientedPreviewFrame(state.sourcePath, ts);
      updateVideoCropSession((prev) => ({
        ...prev,
        previewFrameUrl: frame.dataUrl,
        previewTimestampSec: frame.timestampSec,
      }));
    } catch {
      // Keep previous frame on transient seek error
    } finally {
      setLoadingPreview(false);
    }
  };

  const handlePointerDown = (handle: DragHandle) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (state.taskStatus === "running" || orientedW < 2 || orientedH < 2) return;
    const box = stageRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0 || box.height <= 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      handle,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startRect: {
        x: state.cropX,
        y: state.cropY,
        width: state.cropWidth,
        height: state.cropHeight,
      },
      stageW: box.width,
      stageH: box.height,
    };
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || orientedW < 2 || orientedH < 2) return;
    const dx = ((e.clientX - drag.startClientX) / drag.stageW) * orientedW;
    const dy = ((e.clientY - drag.startClientY) / drag.stageH) * orientedH;
    const s = drag.startRect;
    const ratio = aspectRatioValue(state.aspectPreset);
    const minSize = 24;

    let next: CropRect = { ...s };
    if (drag.handle === "move") {
      next.x = Math.max(0, Math.min(orientedW - s.width, Math.round(s.x + dx)));
      next.y = Math.max(0, Math.min(orientedH - s.height, Math.round(s.y + dy)));
    } else {
      let left = s.x;
      let top = s.y;
      let right = s.x + s.width;
      let bottom = s.y + s.height;

      if (drag.handle === "nw" || drag.handle === "sw") {
        left = Math.max(0, Math.min(right - minSize, s.x + dx));
      } else {
        right = Math.min(orientedW, Math.max(left + minSize, right + dx));
      }
      if (drag.handle === "nw" || drag.handle === "ne") {
        top = Math.max(0, Math.min(bottom - minSize, s.y + dy));
      } else {
        bottom = Math.min(orientedH, Math.max(top + minSize, bottom + dy));
      }

      let w = right - left;
      let h = bottom - top;
      if (ratio) {
        h = w / ratio;
        if (drag.handle === "nw" || drag.handle === "ne") {
          top = bottom - h;
          if (top < 0) {
            top = 0;
            h = bottom;
            w = h * ratio;
          }
        } else {
          bottom = top + h;
          if (bottom > orientedH) {
            bottom = orientedH;
            h = bottom - top;
            w = h * ratio;
          }
        }
        if (drag.handle === "nw" || drag.handle === "sw") {
          left = right - w;
          if (left < 0) {
            left = 0;
            w = right;
            h = w / ratio;
          }
        } else {
          right = left + w;
          if (right > orientedW) {
            right = orientedW;
            w = right - left;
            h = w / ratio;
          }
        }
      }
      next = clampCropRect(
        { x: left, y: top, width: makeEven(w), height: makeEven(h) },
        orientedW,
        orientedH,
      );
    }

    updateVideoCropSession((prev) => ({
      ...prev,
      cropX: next.x,
      cropY: next.y,
      cropWidth: next.width,
      cropHeight: next.height,
    }));
  };

  const handlePointerUp = () => {
    dragRef.current = null;
  };

  const handleStartExport = async () => {
    if (!state.sourcePath || !state.outputPath.trim()) return;
    await startVideoCropTask(
      {
        sourcePath: state.sourcePath,
        outputPath: state.outputPath.trim(),
        rotateCw: state.rotateCw,
        flipH: state.flipH,
        flipV: state.flipV,
        cropX: state.cropX,
        cropY: state.cropY,
        cropWidth: state.cropWidth,
        cropHeight: state.cropHeight,
        allowOverwrite: false,
      },
      (err) => formatLocalizedError(err, t),
    );
  };

  const mediaReady = toolsStatus?.ready ?? true;
  const duration = state.probe?.durationSec ?? 0;

  const leftPct = orientedW > 0 ? (state.cropX / orientedW) * 100 : 0;
  const topPct = orientedH > 0 ? (state.cropY / orientedH) * 100 : 0;
  const widthPct = orientedW > 0 ? (state.cropWidth / orientedW) * 100 : 100;
  const heightPct = orientedH > 0 ? (state.cropHeight / orientedH) * 100 : 100;

  const aspectPresets: { id: CropAspectPreset; label: string }[] = [
    { id: "free", label: isZh ? "自由比例" : "Free" },
    { id: "1:1", label: "1:1" },
    { id: "16:9", label: "16:9" },
    { id: "9:16", label: "9:16" },
  ];

  return (
    <div className="media-workspace">
      <MediaToolsSetupPanel onStatusChange={setToolsStatus} />

      {!state.sourcePath ? (
        <div className={`media-dropzone ${hovering ? "is-hover" : ""}`}>
          <Crop size={28} strokeWidth={1.6} aria-hidden="true" />
          <div style={{ fontWeight: 600, fontSize: "15px" }}>
            {isZh
              ? "拖入视频文件进行画面裁剪、旋转与翻转"
              : "Drop a video to crop, rotate, or flip"}
          </div>
          <div style={{ fontSize: "13px", color: "var(--text-secondary)", maxWidth: "560px" }}>
            {isZh
              ? "在真实视频画面上直接拖动裁剪框，支持自由比例、1:1、16:9、9:16 及左右旋转 90°、水平/垂直翻转。自动采用手机竖拍显示方向作为坐标系，框选、预览与导出 1:1 一致。"
              : "Drag the crop box directly on the true display-oriented video frame with Free, 1:1, 16:9, 9:16 presets, 90° rotation, and horizontal/vertical flip."}
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!mediaReady}
            onClick={() => void handlePickVideo()}
          >
            <FilePlus2 size={15} />
            {isZh ? "选择视频文件..." : "Select Video..."}
          </button>
        </div>
      ) : (
        <div className="media-split">
          {/* Left column: prominent interactive display-oriented crop preview stage */}
          <div className="media-stage-card">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "8px",
                flexWrap: "wrap",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <strong style={{ fontSize: "13px" }}>{getFileName(state.sourcePath)}</strong>
                <span className="media-status-pill is-neutral mono">
                  {isZh ? "画布" : "Frame"} {orientedW}×{orientedH}
                </span>
                <span className="media-status-pill is-ok mono">
                  {isZh ? "裁剪输出" : "Crop"} {state.cropWidth}×{state.cropHeight}
                </span>
              </div>
              <button
                type="button"
                className="btn"
                disabled={state.taskStatus === "running"}
                onClick={() => void handlePickVideo()}
              >
                {isZh ? "更换视频..." : "Change Video..."}
              </button>
            </div>

            <div
              style={{
                background: "#0f172a",
                borderRadius: "8px",
                padding: "14px",
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                minHeight: "340px",
                maxHeight: "480px",
                overflow: "hidden",
              }}
            >
              {orientedW > 0 && orientedH > 0 ? (
                <div
                  ref={stageRef}
                  data-testid="v09-crop-stage"
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  style={{
                    position: "relative",
                    aspectRatio: `${orientedW} / ${orientedH}`,
                    maxWidth: "100%",
                    maxHeight: "450px",
                    height: orientedH >= orientedW ? "430px" : "auto",
                    width: orientedW > orientedH ? "100%" : "auto",
                    overflow: "hidden",
                    userSelect: "none",
                    touchAction: "none",
                    borderRadius: "4px",
                  }}
                >
                  <canvas
                    ref={canvasRef}
                    style={{
                      display: "block",
                      width: "100%",
                      height: "100%",
                    }}
                  />
                  {/* Interactive crop selection box with dimmed outer backdrop */}
                  <div
                    role="region"
                    aria-label={isZh ? "裁剪选区" : "Crop selection"}
                    onPointerDown={handlePointerDown("move")}
                    style={{
                      position: "absolute",
                      left: `${leftPct}%`,
                      top: `${topPct}%`,
                      width: `${widthPct}%`,
                      height: `${heightPct}%`,
                      border: "2px solid #ffffff",
                      boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.58)",
                      cursor: "move",
                      boxSizing: "border-box",
                    }}
                  >
                    {/* Rule-of-thirds guides */}
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        pointerEvents: "none",
                        backgroundImage:
                          "linear-gradient(to right, rgba(255,255,255,0.28) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.28) 1px, transparent 1px)",
                        backgroundSize: "33.333% 33.333%",
                      }}
                    />
                    <div
                      className="mono"
                      style={{
                        position: "absolute",
                        left: "6px",
                        top: "6px",
                        padding: "2px 6px",
                        borderRadius: "4px",
                        background: "rgba(15, 23, 42, 0.78)",
                        color: "#f8fafc",
                        fontSize: "11px",
                        pointerEvents: "none",
                      }}
                    >
                      {state.cropWidth}×{state.cropHeight}
                    </div>
                    {(
                      [
                        { h: "nw", style: { left: "-6px", top: "-6px", cursor: "nwse-resize" } },
                        { h: "ne", style: { right: "-6px", top: "-6px", cursor: "nesw-resize" } },
                        { h: "sw", style: { left: "-6px", bottom: "-6px", cursor: "nesw-resize" } },
                        {
                          h: "se",
                          style: { right: "-6px", bottom: "-6px", cursor: "nwse-resize" },
                        },
                      ] as const
                    ).map(({ h, style }) => (
                      <div
                        key={h}
                        onPointerDown={handlePointerDown(h)}
                        style={{
                          position: "absolute",
                          width: "12px",
                          height: "12px",
                          background: "#ffffff",
                          border: "2px solid #2563eb",
                          borderRadius: "2px",
                          ...style,
                        }}
                      />
                    ))}
                  </div>
                </div>
              ) : (
                <div style={{ color: "#94a3b8", fontSize: "13px" }}>
                  {loadingPreview
                    ? isZh
                      ? "正在提取正立视频帧..."
                      : "Loading upright preview frame..."
                    : ""}
                </div>
              )}
            </div>

            {duration > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: "10px", fontSize: "12px" }}>
                <span style={{ color: "var(--text-secondary)", flexShrink: 0 }}>
                  {isZh ? "预览帧位置" : "Preview frame"}
                </span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0.1, duration - 0.05)}
                  step={0.1}
                  value={state.previewTimestampSec}
                  disabled={loadingPreview}
                  onChange={(e) => void handleSeekPreviewFrame(Number(e.target.value))}
                  style={{ flex: 1 }}
                />
                <span className="mono">{formatTimecode(state.previewTimestampSec)}</span>
              </div>
            )}
          </div>

          {/* Right column: Ratio presets, Rotate/Flip, exact pixel coords, export */}
          <div className="media-stage-card">
            <div style={{ fontWeight: 600, fontSize: "14px" }}>
              {isZh ? "裁剪比例与画面方向" : "Aspect Ratio & Orientation"}
            </div>

            <div className="segmented-control">
              {aspectPresets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`segmented-btn ${state.aspectPreset === p.id ? "is-active" : ""}`}
                  disabled={state.taskStatus === "running"}
                  onClick={() => handleSelectAspect(p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
              <button
                type="button"
                className="btn"
                disabled={state.taskStatus === "running"}
                onClick={() => handleTransformOp("rotate_ccw")}
              >
                <RotateCcw size={14} />
                {isZh ? "左转 90°" : "Rotate Left"}
              </button>
              <button
                type="button"
                className="btn"
                disabled={state.taskStatus === "running"}
                onClick={() => handleTransformOp("rotate_cw")}
              >
                <RotateCw size={14} />
                {isZh ? "右转 90°" : "Rotate Right"}
              </button>
              <button
                type="button"
                className="btn"
                disabled={state.taskStatus === "running"}
                onClick={() => handleTransformOp("flip_h")}
              >
                <FlipHorizontal2 size={14} />
                {isZh ? "水平翻转" : "Flip Horizontal"}
              </button>
              <button
                type="button"
                className="btn"
                disabled={state.taskStatus === "running"}
                onClick={() => handleTransformOp("flip_v")}
              >
                <FlipVertical2 size={14} />
                {isZh ? "垂直翻转" : "Flip Vertical"}
              </button>
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontSize: "12px",
                color: "var(--text-secondary)",
              }}
            >
              <span>
                {isZh
                  ? `当前变换：旋转 ${state.rotateCw}°${state.flipH ? " · 水平翻转" : ""}${state.flipV ? " · 垂直翻转" : ""}`
                  : `Transform: ${state.rotateCw}°${state.flipH ? " · Flip H" : ""}${state.flipV ? " · Flip V" : ""}`}
              </span>
              <button
                type="button"
                className="btn"
                style={{ padding: "3px 8px", fontSize: "12px" }}
                disabled={state.taskStatus === "running"}
                onClick={handleReset}
              >
                <Undo2 size={13} />
                {isZh ? "重置" : "Reset"}
              </button>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "8px",
                fontSize: "12px",
              }}
            >
              <label style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                <span>X (px)</span>
                <input
                  type="number"
                  className="text-input mono"
                  min={0}
                  max={Math.max(0, orientedW - 2)}
                  value={state.cropX}
                  disabled={state.taskStatus === "running"}
                  onChange={(e) => {
                    const next = clampCropRect(
                      {
                        x: Number(e.target.value) || 0,
                        y: state.cropY,
                        width: state.cropWidth,
                        height: state.cropHeight,
                      },
                      orientedW,
                      orientedH,
                    );
                    updateVideoCropSession((prev) => ({
                      ...prev,
                      cropX: next.x,
                      cropY: next.y,
                      cropWidth: next.width,
                      cropHeight: next.height,
                    }));
                  }}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                <span>Y (px)</span>
                <input
                  type="number"
                  className="text-input mono"
                  min={0}
                  max={Math.max(0, orientedH - 2)}
                  value={state.cropY}
                  disabled={state.taskStatus === "running"}
                  onChange={(e) => {
                    const next = clampCropRect(
                      {
                        x: state.cropX,
                        y: Number(e.target.value) || 0,
                        width: state.cropWidth,
                        height: state.cropHeight,
                      },
                      orientedW,
                      orientedH,
                    );
                    updateVideoCropSession((prev) => ({
                      ...prev,
                      cropX: next.x,
                      cropY: next.y,
                      cropWidth: next.width,
                      cropHeight: next.height,
                    }));
                  }}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                <span>{isZh ? "宽度 (px)" : "Width (px)"}</span>
                <input
                  type="number"
                  className="text-input mono"
                  min={2}
                  max={orientedW}
                  step={2}
                  value={state.cropWidth}
                  disabled={state.taskStatus === "running"}
                  onChange={(e) => {
                    const next = clampCropRect(
                      {
                        x: state.cropX,
                        y: state.cropY,
                        width: Number(e.target.value) || 2,
                        height: state.cropHeight,
                      },
                      orientedW,
                      orientedH,
                    );
                    updateVideoCropSession((prev) => ({
                      ...prev,
                      cropX: next.x,
                      cropY: next.y,
                      cropWidth: next.width,
                      cropHeight: next.height,
                    }));
                  }}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                <span>{isZh ? "高度 (px)" : "Height (px)"}</span>
                <input
                  type="number"
                  className="text-input mono"
                  min={2}
                  max={orientedH}
                  step={2}
                  value={state.cropHeight}
                  disabled={state.taskStatus === "running"}
                  onChange={(e) => {
                    const next = clampCropRect(
                      {
                        x: state.cropX,
                        y: state.cropY,
                        width: state.cropWidth,
                        height: Number(e.target.value) || 2,
                      },
                      orientedW,
                      orientedH,
                    );
                    updateVideoCropSession((prev) => ({
                      ...prev,
                      cropX: next.x,
                      cropY: next.y,
                      cropWidth: next.width,
                      cropHeight: next.height,
                    }));
                  }}
                />
              </label>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ fontSize: "12px", fontWeight: 600 }}>
                {isZh ? "输出新文件（绝不覆盖源文件）" : "Output File (never overwrites source)"}
              </label>
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  type="text"
                  className="text-input mono"
                  value={state.outputPath}
                  onChange={(e) =>
                    updateVideoCropSession((prev) => ({ ...prev, outputPath: e.target.value }))
                  }
                  style={{ flex: 1, minWidth: 0 }}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={state.taskStatus === "running"}
                  onClick={() => void handlePickOutput()}
                >
                  {isZh ? "浏览..." : "Browse..."}
                </button>
              </div>
            </div>

            {state.taskStatus === "running" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px" }}>
                  <span>{isZh ? "正在导出裁剪与旋转..." : "Exporting cropped video..."}</span>
                  <span className="mono">{Math.round(state.liveProgress?.percent ?? 0)}%</span>
                </div>
                <div className="media-progress-bar">
                  <div
                    className="media-progress-fill"
                    style={{ width: `${Math.round(state.liveProgress?.percent ?? 0)}%` }}
                  />
                </div>
                <button type="button" className="btn" onClick={() => void cancelVideoCropTask()}>
                  {isZh ? "取消" : "Cancel"}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  !mediaReady ||
                  !state.outputPath.trim() ||
                  state.cropWidth < 2 ||
                  state.cropHeight < 2
                }
                onClick={() => void handleStartExport()}
              >
                <Crop size={15} />
                {isZh
                  ? `导出成片（${state.cropWidth}×${state.cropHeight}）`
                  : `Export (${state.cropWidth}×${state.cropHeight})`}
              </button>
            )}

            {state.errorMessage && (
              <div style={{ fontSize: "12px", color: "var(--status-err)" }}>
                {state.errorMessage}
              </div>
            )}

            {state.lastResult && (
              <div
                style={{
                  borderTop: "1px solid var(--border-subtle)",
                  paddingTop: "10px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                  fontSize: "12px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    fontWeight: 600,
                    color: "var(--status-ok)",
                  }}
                >
                  <CheckCircle2 size={14} />
                  {isZh
                    ? `导出成功：${state.lastResult.outputWidth}×${state.lastResult.outputHeight} · ${formatMediaBytes(state.lastResult.byteSize, locale)}`
                    : `Exported ${state.lastResult.outputWidth}×${state.lastResult.outputHeight} · ${formatMediaBytes(state.lastResult.byteSize, locale)}`}
                </div>
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      void openLocalDirectory(getParentDir(state.lastResult!.outputPath))
                    }
                  >
                    <FolderOpen size={13} />
                    {isZh ? "打开目录" : "Open Folder"}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => handoffMediaFileToTool("V03", state.lastResult!.outputPath)}
                  >
                    {isZh ? "继续变速 (V03)" : "Speed (V03)"}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => handoffMediaFileToTool("V12", state.lastResult!.outputPath)}
                  >
                    {isZh ? "去合并 (V12)" : "Merge (V12)"}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => handoffMediaFileToTool("V06", state.lastResult!.outputPath)}
                  >
                    {isZh ? "继续压缩 (V06)" : "Compress (V06)"}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => handoffMediaFileToTool("V10", state.lastResult!.outputPath)}
                  >
                    <Info size={13} />
                    {isZh ? "媒体信息 (V10)" : "Media Info (V10)"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
