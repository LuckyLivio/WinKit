import {
  ClipboardPaste,
  Copy,
  Download,
  Droplets,
  Eye,
  EyeOff,
  FolderOpen,
  Frame,
  Grid2x2,
  ImageOff,
  ImagePlus,
  Maximize2,
  MousePointer2,
  Pencil,
  PlusSquare,
  Redo2,
  RefreshCw,
  ScanFace,
  ShieldCheck,
  Square,
  Stamp,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useI18n } from "../../i18n/I18nContext";
import {
  useSessionStore,
  type BlurFaceBoxItem,
  type BlurFaceQueueEntry,
  type ImageHandoffTarget,
} from "../../lib/sessionStore";
import {
  applyImageRedactionsToAsset,
  bindDisposableListener,
  copyImageAssetToClipboard,
  detectFacesInAsset,
  detectFacesInFile,
  exportRedactedImageFile,
  formatLocalizedError,
  inspectBatchImages,
  loadFileAsImageAsset,
  openLocalDirectory,
  parseBackendError,
  pickMultipleFiles,
  pickSaveFilePath,
  pickSingleDirectory,
  readClipboardImageAsAsset,
  subscribeFileDrop,
  suggestSafeSiblingPath,
  type RedactionKind,
  type RedactionRegionPayload,
  type SaveAssetFormat,
} from "../../lib/tauriBridge";
import { findRegisteredTool } from "../../registry/tools";
import { IMAGE_FILE_DIALOG_EXTENSIONS } from "../image-batch/imageBatchModel";
import {
  DEFAULT_VIEWPORT,
  applyHandleResize,
  clampRectToImage,
  clampZoom,
  drawSelectionHandles,
  handleCursorFor,
  hitTestResizeHandle,
  normalizeRectFromDrag,
  resolveViewport,
  screenToImage,
  zoomViewportAroundStagePoint,
  type PixelRect,
  type ResizeHandle,
} from "../image-editor/canvasViewport";
import "../image-editor/editorCanvas.css";
import "./blurFaces.css";

const SOLID_SWATCHES = ["#111827", "#000000", "#334155", "#FFFFFF", "#B91C1C"];

const copy = {
  "zh-CN": {
    addImages: "添加图片",
    paste: "粘贴图片",
    detectAllBtn: "全部检测",
    redetectBtn: "重新检测",
    undo: "撤销",
    redo: "重做",
    fit: "适应",
    actualSize: "1:1",
    compareBtn: "前后对照",
    comparingOriginal: "正在查看原图（未打码）",
    copyImg: "复制当前结果",
    savePng: "导出 PNG",
    saveJpeg: "导出 JPEG",
    sendAnnotate: "送往批注 (I12)",
    sendBeautify: "送往美化 (I03)",
    sendWatermark: "送往水印 (I13)",
    modeSelect: "选择 / 调整框",
    modeAdd: "手动补框",
    kindBlur: "模糊",
    kindPixelate: "像素化",
    kindSolid: "实色遮盖",
    strengthLabel: "强度",
    colorLabel: "遮盖色",
    stripMetaLabel: "清理导出副本隐私元数据 (I09)",
    queueHeading: (n: number) => `图片队列 (${n})`,
    clearQueue: "清空",
    boxesHeading: (enabled: number, total: number) => `人脸选区 (${enabled}/${total})`,
    enableAll: "全选",
    disableAll: "全取消",
    noBoxesHint: "未检测到人脸或暂无选区，可切换到「手动补框」直接在画面上拖拽补框。",
    failedCanvasHint: "该文件无法解码或检测失败，批量导出时将单独计入失败项，不会中断其余图片。",
    statusPending: "待检测",
    statusDetecting: "检测中...",
    statusDetected: (n: number) => `检测到 ${n} 张脸`,
    statusNoFaces: "未检测到人脸",
    statusFailed: "检测失败",
    sourceAuto: "自动",
    sourceManual: "手动",
    modifiedTag: "已编辑",
    batchOutputLabel: "批量输出目录",
    chooseOutputDir: "选择目录",
    outputDirPlaceholder: "请选择导出目录（只写新副本，不覆盖原图）",
    batchUntouchedLabel: "未检测到人脸的图片也导出原样副本（单独计数）",
    startBatchBtn: (n: number) => `批量导出 (${n})`,
    cancelBatchBtn: "取消批量任务",
    openOutDirBtn: "打开输出目录",
    batchProgressText: (cur: number, total: number, name: string) =>
      `正在本地处理 ${cur}/${total}：${name}`,
    batchReportSummary: (
      redacted: number,
      untouched: number,
      skipped: number,
      failed: number,
      cancelled: boolean,
    ) =>
      `${cancelled ? "批量任务已取消：" : "批量导出完成："}已打码 ${redacted} 张 · 原样副本 ${untouched} 张 · 未检出跳过 ${skipped} 张 · 失败 ${failed} 张`,
    emptyTitle: "拖入单张合影或一批照片，离线自动定位并打码人脸",
    emptyDesc:
      "内置轻量级 CPU 人脸框检测模型（YuNet, MIT），完全离线运行且不提取身份特征。检测后可逐脸取消、手动补框、移动调大小，再一键单张或批量导出新副本。",
    copiedOk: "已将打码后的原图复制到 Windows 剪贴板",
    savedOk: (p: string, stripped: boolean) =>
      stripped ? `已导出干净打码副本（无隐私元数据）：${p}` : `已导出打码副本：${p}`,
    detectOkBanner: (n: number, ms: number) => `检测到 ${n} 张脸（离线 CPU 耗时 ${ms} ms）`,
    detectNoneBanner: "未检测到人脸，可切换到「手动补框」添加遮盖区域",
    detectFailedBanner: (msg: string) => `检测失败：${msg}`,
    panHint: "按住空格或中键平移 · Ctrl+滚轮缩放 · B 切换前后对照 · Del 删除选中框",
    overwriteTitle: "覆盖已有文件？",
    overwriteBody: (p: string) => `目标路径已存在文件：${p}\n确认覆盖吗？（不会修改原始图片）`,
    overwriteConfirm: "确认覆盖",
    cancel: "取消",
    needOutputDirErr: "请先选择批量导出的输出目录。",
    memoryBadge: "内存图片",
  },
  "en-US": {
    addImages: "Add Photos",
    paste: "Paste",
    detectAllBtn: "Detect All",
    redetectBtn: "Re-detect",
    undo: "Undo",
    redo: "Redo",
    fit: "Fit",
    actualSize: "1:1",
    compareBtn: "Compare",
    comparingOriginal: "Viewing Original (Before)",
    copyImg: "Copy",
    savePng: "Export PNG",
    saveJpeg: "Export JPEG",
    sendAnnotate: "Annotate (I12)",
    sendBeautify: "Beautify (I03)",
    sendWatermark: "Watermark (I13)",
    modeSelect: "Select / Edit",
    modeAdd: "Add Box",
    kindBlur: "Blur",
    kindPixelate: "Pixelate",
    kindSolid: "Solid Cover",
    strengthLabel: "Strength",
    colorLabel: "Fill",
    stripMetaLabel: "Strip privacy metadata (I09)",
    queueHeading: (n: number) => `Photos (${n})`,
    clearQueue: "Clear",
    boxesHeading: (enabled: number, total: number) => `Face Boxes (${enabled}/${total})`,
    enableAll: "Enable all",
    disableAll: "Uncheck all",
    noBoxesHint:
      "No faces detected or no active boxes yet. Switch to 'Add Box' to drag a manual redaction box.",
    failedCanvasHint:
      "This file could not be decoded or detected. During batch export it will be reported as failed without blocking other photos.",
    statusPending: "Pending",
    statusDetecting: "Detecting...",
    statusDetected: (n: number) => `${n} face(s)`,
    statusNoFaces: "No faces",
    statusFailed: "Detection failed",
    sourceAuto: "Auto",
    sourceManual: "Manual",
    modifiedTag: "Edited",
    batchOutputLabel: "Batch output folder",
    chooseOutputDir: "Choose Folder",
    outputDirPlaceholder: "Select an export folder (always writes new non-overwriting copies)",
    batchUntouchedLabel: "Also export untouched copies when no faces detected (counted separately)",
    startBatchBtn: (n: number) => `Batch Export (${n})`,
    cancelBatchBtn: "Cancel Batch",
    openOutDirBtn: "Open Output Folder",
    batchProgressText: (cur: number, total: number, name: string) =>
      `Processing locally ${cur}/${total}: ${name}`,
    batchReportSummary: (
      redacted: number,
      untouched: number,
      skipped: number,
      failed: number,
      cancelled: boolean,
    ) =>
      `${cancelled ? "Batch cancelled: " : "Batch complete: "}${redacted} redacted · ${untouched} untouched copies · ${skipped} skipped (no faces) · ${failed} failed`,
    emptyTitle: "Drop a group photo or a batch of photos to detect and blur faces offline",
    emptyDesc:
      "Bundled lightweight CPU face box detector (YuNet, MIT) runs 100% offline with zero identity biometrics. Toggle individual faces, add/move/resize boxes, preview before/after, and export new copies.",
    copiedOk: "Copied redacted full-resolution image to Windows clipboard",
    savedOk: (p: string, stripped: boolean) =>
      stripped ? `Exported clean redacted copy (metadata stripped): ${p}` : `Exported copy: ${p}`,
    detectOkBanner: (n: number, ms: number) => `Detected ${n} face(s) offline on CPU (${ms} ms)`,
    detectNoneBanner: "No faces detected. Switch to 'Add Box' to redact manually.",
    detectFailedBanner: (msg: string) => `Detection failed: ${msg}`,
    panHint: "Space+drag or middle-drag to pan · Ctrl+Wheel zoom · B compare · Del deletes box",
    overwriteTitle: "Overwrite existing file?",
    overwriteBody: (p: string) =>
      `Target file already exists: ${p}\nOverwrite it? (Source file is never modified.)`,
    overwriteConfirm: "Overwrite",
    cancel: "Cancel",
    needOutputDirErr: "Please choose an output folder before starting batch export.",
    memoryBadge: "In-Memory",
  },
} as const;

type DragInteraction =
  | { kind: "pan"; startClientX: number; startClientY: number; origPanX: number; origPanY: number }
  | { kind: "draw"; startImgX: number; startImgY: number; curRect: PixelRect }
  | { kind: "move"; id: string; startImgX: number; startImgY: number; origRect: PixelRect }
  | {
      kind: "resize";
      id: string;
      handle: ResizeHandle;
      startImgX: number;
      startImgY: number;
      origRect: PixelRect;
    };

function cloneBoxes(boxes: BlurFaceBoxItem[]): BlurFaceBoxItem[] {
  return boxes.map((b) => ({ ...b }));
}

function drawRedactionBoxPreview(
  ctx: CanvasRenderingContext2D,
  sourceImg: HTMLImageElement,
  imgW: number,
  imgH: number,
  box: BlurFaceBoxItem,
  kind: RedactionKind,
  strength: number,
  colorHex: string,
): void {
  const rect = clampRectToImage(box, imgW, imgH, 1);
  if (rect.width <= 0 || rect.height <= 0) return;

  if (kind === "solid") {
    ctx.save();
    ctx.fillStyle = colorHex || "#111827";
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.restore();
    return;
  }

  const block =
    kind === "pixelate"
      ? Math.max(4, Math.min(64, strength))
      : Math.max(4, Math.min(48, Math.round(strength * 0.9)));
  const sw = Math.max(1, Math.round(rect.width / block));
  const sh = Math.max(1, Math.round(rect.height / block));

  const tmp = document.createElement("canvas");
  tmp.width = sw;
  tmp.height = sh;
  const tctx = tmp.getContext("2d");
  if (!tctx) return;

  tctx.imageSmoothingEnabled = true;
  tctx.drawImage(sourceImg, rect.x, rect.y, rect.width, rect.height, 0, 0, sw, sh);

  ctx.save();
  ctx.imageSmoothingEnabled = kind === "blur";
  ctx.drawImage(tmp, 0, 0, sw, sh, rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function buildBackendRegions(
  boxes: BlurFaceBoxItem[],
  kind: RedactionKind,
  strength: number,
  colorHex: string,
): RedactionRegionPayload[] {
  return boxes
    .filter((b) => b.enabled && b.width > 0 && b.height > 0)
    .map((b) => ({
      kind,
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.round(b.width),
      height: Math.round(b.height),
      strength,
      colorHex: kind === "solid" ? colorHex : null,
    }));
}

export function BlurFacesWorkspace() {
  const { locale, t } = useI18n();
  const c = copy[locale];
  const {
    session,
    updateBlurFacesSession,
    startBlurFacesBatch,
    cancelBlurFacesBatch,
    handoffImageToTool,
  } = useSessionStore();
  const st = session.blurFaces;

  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const seqRef = useRef(1);
  const autoDetectingIdsRef = useRef<Set<string>>(new Set());

  const [imgVersion, setImgVersion] = useState(0);
  const [stageSize, setStageSize] = useState({ w: 720, h: 460 });
  const [spaceDown, setSpaceDown] = useState(false);
  const [dragState, setDragState] = useState<DragInteraction | null>(null);
  const [cursorStyle, setCursorStyle] = useState("default");
  const [dropHover, setDropHover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [detectingAll, setDetectingAll] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [pendingOverwrite, setPendingOverwrite] = useState<{
    path: string;
    format: SaveAssetFormat;
  } | null>(null);

  const hasAnnotate = Boolean(findRegisteredTool("I12"));
  const hasBeautify = Boolean(findRegisteredTool("I03"));
  const hasWatermark = Boolean(findRegisteredTool("I13"));

  const activeEntry = useMemo(
    () => st.entries.find((e) => e.id === st.activeEntryId) ?? st.entries[0] ?? null,
    [st.entries, st.activeEntryId],
  );

  const patchEntry = useCallback(
    (entryId: string, updater: (entry: BlurFaceQueueEntry) => BlurFaceQueueEntry) => {
      updateBlurFacesSession((prev) => ({
        ...prev,
        entries: prev.entries.map((entry) => (entry.id === entryId ? updater(entry) : entry)),
      }));
    },
    [updateBlurFacesSession],
  );

  const commitActiveBoxes = useCallback(
    (nextBoxes: BlurFaceBoxItem[], nextSelectedId: string | null) => {
      if (!activeEntry) return;
      const targetId = activeEntry.id;
      updateBlurFacesSession((prev) => ({
        ...prev,
        selectedBoxId: nextSelectedId,
        lastSavedMessage: null,
        entries: prev.entries.map((entry) => {
          if (entry.id !== targetId) return entry;
          return {
            ...entry,
            undoStack: [...entry.undoStack.slice(-39), cloneBoxes(entry.boxes)],
            redoStack: [],
            boxes: nextBoxes,
            modifiedByUser: true,
          };
        }),
      }));
    },
    [activeEntry, updateBlurFacesSession],
  );

  // Load full-res asset & run offline face detection for an entry
  const loadAndDetectEntry = useCallback(
    async (entry: BlurFaceQueueEntry, forceRedetect = false) => {
      if (!forceRedetect && autoDetectingIdsRef.current.has(entry.id)) {
        return;
      }
      autoDetectingIdsRef.current.add(entry.id);
      setErrorText(null);

      patchEntry(entry.id, (cur) => ({
        ...cur,
        detectionStatus: "detecting",
        detectionError: null,
      }));

      try {
        let assetId = entry.assetId;
        let dataUrl = entry.dataUrl;
        let width = entry.width;
        let height = entry.height;
        let hasAlpha = entry.hasAlpha;

        if (!assetId && entry.sourcePath) {
          const loaded = await loadFileAsImageAsset(entry.sourcePath);
          assetId = loaded.assetId;
          dataUrl = loaded.dataUrl;
          width = loaded.width;
          height = loaded.height;
          hasAlpha = loaded.hasAlpha;
        }

        if (!assetId) {
          throw new Error("Missing image payload.");
        }

        const det = await detectFacesInAsset({ assetId });
        const now = Date.now();
        const boxes: BlurFaceBoxItem[] = det.faces.map((face) => ({
          id: `face-${now}-${seqRef.current++}`,
          source: "auto",
          enabled: true,
          confidence: face.confidence,
          x: face.x,
          y: face.y,
          width: face.width,
          height: face.height,
        }));

        patchEntry(entry.id, (cur) => ({
          ...cur,
          assetId,
          dataUrl,
          width: det.imageWidth || width,
          height: det.imageHeight || height,
          hasAlpha,
          thumbnailDataUrl: cur.thumbnailDataUrl ?? dataUrl,
          detectionStatus: boxes.length > 0 ? "detected" : "no_faces",
          detectionError: null,
          detectedCount: boxes.length,
          elapsedMs: det.elapsedMs,
          boxes,
          undoStack: [],
          redoStack: [],
          modifiedByUser: false,
        }));

        updateBlurFacesSession((prev) => ({
          ...prev,
          selectedBoxId:
            prev.activeEntryId === entry.id ? (boxes[0]?.id ?? null) : prev.selectedBoxId,
          lastSavedMessage:
            prev.activeEntryId === entry.id
              ? boxes.length > 0
                ? c.detectOkBanner(boxes.length, det.elapsedMs)
                : c.detectNoneBanner
              : prev.lastSavedMessage,
        }));
      } catch (err) {
        const msg = formatLocalizedError(err, t);
        patchEntry(entry.id, (cur) => ({
          ...cur,
          detectionStatus: "failed",
          detectionError: msg,
          detectedCount: 0,
          elapsedMs: null,
        }));
        setErrorText(c.detectFailedBanner(msg));
      } finally {
        autoDetectingIdsRef.current.delete(entry.id);
      }
    },
    [c, patchEntry, t, updateBlurFacesSession],
  );

  // Auto-detect active entry whenever user selects a pending photo
  useEffect(() => {
    if (!activeEntry) return;
    if (activeEntry.detectionStatus === "pending") {
      void loadAndDetectEntry(activeEntry, false);
    } else if (
      !activeEntry.dataUrl &&
      activeEntry.sourcePath &&
      activeEntry.detectionStatus !== "failed"
    ) {
      // Entry was already detected in batch without full asset loaded in RAM
      void (async () => {
        try {
          const loaded = await loadFileAsImageAsset(activeEntry.sourcePath!);
          patchEntry(activeEntry.id, (cur) => ({
            ...cur,
            assetId: loaded.assetId,
            dataUrl: loaded.dataUrl,
            width: loaded.width,
            height: loaded.height,
            hasAlpha: loaded.hasAlpha,
          }));
        } catch (err) {
          const msg = formatLocalizedError(err, t);
          patchEntry(activeEntry.id, (cur) => ({
            ...cur,
            detectionStatus: "failed",
            detectionError: msg,
          }));
        }
      })();
    }
  }, [activeEntry, loadAndDetectEntry, patchEntry, t]);

  // Load Image element whenever active entry dataUrl changes
  useEffect(() => {
    const url = activeEntry?.dataUrl ?? null;
    if (!url) {
      imgRef.current = null;
      setImgVersion((v) => v + 1);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) {
        imgRef.current = img;
        setImgVersion((v) => v + 1);
      }
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [activeEntry?.dataUrl]);

  // Observe stage dimensions (150% DPI & resize safe)
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 40 && rect.height > 40) {
        setStageSize({ w: Math.round(rect.width), h: Math.round(rect.height) });
      }
    };
    update();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(update);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // Add file paths into queue (reusing Phase 3A inspectBatchImages)
  const addLocalPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      setErrorText(null);
      setBusy(true);
      try {
        const res = await inspectBatchImages(paths);
        const now = Date.now();
        const existingPaths = new Set(
          st.entries.map((e) => e.sourcePath?.toLowerCase()).filter(Boolean) as string[],
        );

        const newEntries: BlurFaceQueueEntry[] = [];
        for (const item of res.items) {
          if (existingPaths.has(item.path.toLowerCase())) continue;
          existingPaths.add(item.path.toLowerCase());
          const failedInspect = Boolean(item.error);
          newEntries.push({
            id: `file-face-${now}-${seqRef.current++}`,
            sourcePath: item.path,
            fileName: item.fileName,
            assetId: null,
            dataUrl: null,
            width: failedInspect ? null : item.displayWidth,
            height: failedInspect ? null : item.displayHeight,
            hasAlpha: item.hasAlpha,
            thumbnailDataUrl: item.thumbnailDataUrl,
            detectionStatus: failedInspect ? "failed" : "pending",
            detectionError: item.error ?? null,
            detectedCount: 0,
            elapsedMs: null,
            boxes: [],
            undoStack: [],
            redoStack: [],
            modifiedByUser: false,
          });
        }

        if (newEntries.length === 0 && res.skipped.length > 0) {
          setErrorText(res.skipped[0]?.reason ?? c.statusFailed);
          return;
        }

        if (newEntries.length > 0) {
          const firstAdded = newEntries[0]!;
          updateBlurFacesSession((prev) => ({
            ...prev,
            entries: [...prev.entries, ...newEntries],
            activeEntryId: prev.activeEntryId ?? firstAdded.id,
            viewport: prev.activeEntryId ? prev.viewport : { ...DEFAULT_VIEWPORT },
            lastSavedMessage: null,
            batchLastReport: null,
            batchErrorMessage: null,
          }));
        }
      } catch (err) {
        setErrorText(formatLocalizedError(err, t));
      } finally {
        setBusy(false);
      }
    },
    [c.statusFailed, st.entries, t, updateBlurFacesSession],
  );

  // Subscribe to native Tauri file drop
  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: setDropHover,
          onDropPaths: (paths) => {
            if (paths.length > 0) {
              void addLocalPaths(paths);
            }
          },
        }),
      "i02-file-drop",
    );
  }, [addLocalPaths]);

  const handlePickFiles = async () => {
    const picked = await pickMultipleFiles({
      title: c.addImages,
      filters: [{ name: "Images", extensions: IMAGE_FILE_DIALOG_EXTENSIONS }],
    });
    if (picked.length > 0) {
      await addLocalPaths(picked);
    }
  };

  const handlePasteClipboard = async () => {
    setErrorText(null);
    setBusy(true);
    try {
      const asset = await readClipboardImageAsAsset();
      const id = `clip-face-${Date.now()}-${seqRef.current++}`;
      const entry: BlurFaceQueueEntry = {
        id,
        sourcePath: null,
        fileName: asset.label || "clipboard.png",
        assetId: asset.assetId,
        dataUrl: asset.dataUrl,
        width: asset.width,
        height: asset.height,
        hasAlpha: asset.hasAlpha,
        thumbnailDataUrl: asset.dataUrl,
        detectionStatus: "pending",
        detectionError: null,
        detectedCount: 0,
        elapsedMs: null,
        boxes: [],
        undoStack: [],
        redoStack: [],
        modifiedByUser: false,
      };
      updateBlurFacesSession((prev) => ({
        ...prev,
        entries: [entry, ...prev.entries],
        activeEntryId: id,
        selectedBoxId: null,
        compareOriginal: false,
        viewport: { ...DEFAULT_VIEWPORT },
        lastSavedMessage: null,
      }));
    } catch (err) {
      setErrorText(formatLocalizedError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const handleDetectAllQueued = async () => {
    const pending = st.entries.filter(
      (e) => e.detectionStatus === "pending" && (e.sourcePath || e.assetId),
    );
    if (pending.length === 0) return;
    setDetectingAll(true);
    setErrorText(null);
    try {
      for (const entry of pending) {
        if (entry.id === activeEntry?.id) {
          await loadAndDetectEntry(entry, false);
          continue;
        }
        patchEntry(entry.id, (cur) => ({
          ...cur,
          detectionStatus: "detecting",
          detectionError: null,
        }));
        try {
          const det = entry.assetId
            ? await detectFacesInAsset({ assetId: entry.assetId })
            : await detectFacesInFile({ path: entry.sourcePath! });
          const now = Date.now();
          const boxes: BlurFaceBoxItem[] = det.faces.map((face) => ({
            id: `face-${now}-${seqRef.current++}`,
            source: "auto",
            enabled: true,
            confidence: face.confidence,
            x: face.x,
            y: face.y,
            width: face.width,
            height: face.height,
          }));
          patchEntry(entry.id, (cur) => ({
            ...cur,
            width: det.imageWidth || cur.width,
            height: det.imageHeight || cur.height,
            detectionStatus: boxes.length > 0 ? "detected" : "no_faces",
            detectionError: null,
            detectedCount: boxes.length,
            elapsedMs: det.elapsedMs,
            boxes,
            modifiedByUser: false,
          }));
        } catch (err) {
          const msg = formatLocalizedError(err, t);
          patchEntry(entry.id, (cur) => ({
            ...cur,
            detectionStatus: "failed",
            detectionError: msg,
          }));
        }
      }
    } finally {
      setDetectingAll(false);
    }
  };

  const handleUndo = useCallback(() => {
    if (!activeEntry || activeEntry.undoStack.length === 0) return;
    const prevBoxes = activeEntry.undoStack[activeEntry.undoStack.length - 1]!;
    const targetId = activeEntry.id;
    updateBlurFacesSession((prev) => ({
      ...prev,
      selectedBoxId: null,
      entries: prev.entries.map((entry) =>
        entry.id === targetId
          ? {
              ...entry,
              boxes: prevBoxes,
              undoStack: entry.undoStack.slice(0, -1),
              redoStack: [...entry.redoStack.slice(-39), cloneBoxes(entry.boxes)],
              modifiedByUser: true,
            }
          : entry,
      ),
    }));
  }, [activeEntry, updateBlurFacesSession]);

  const handleRedo = useCallback(() => {
    if (!activeEntry || activeEntry.redoStack.length === 0) return;
    const nextBoxes = activeEntry.redoStack[activeEntry.redoStack.length - 1]!;
    const targetId = activeEntry.id;
    updateBlurFacesSession((prev) => ({
      ...prev,
      selectedBoxId: null,
      entries: prev.entries.map((entry) =>
        entry.id === targetId
          ? {
              ...entry,
              boxes: nextBoxes,
              undoStack: [...entry.undoStack.slice(-39), cloneBoxes(entry.boxes)],
              redoStack: entry.redoStack.slice(0, -1),
              modifiedByUser: true,
            }
          : entry,
      ),
    }));
  }, [activeEntry, updateBlurFacesSession]);

  const handleDeleteBox = useCallback(
    (boxId: string) => {
      if (!activeEntry) return;
      commitActiveBoxes(
        activeEntry.boxes.filter((b) => b.id !== boxId),
        st.selectedBoxId === boxId ? null : st.selectedBoxId,
      );
    },
    [activeEntry, commitActiveBoxes, st.selectedBoxId],
  );

  const handleToggleBox = useCallback(
    (boxId: string) => {
      if (!activeEntry) return;
      commitActiveBoxes(
        activeEntry.boxes.map((b) => (b.id === boxId ? { ...b, enabled: !b.enabled } : b)),
        boxId,
      );
    },
    [activeEntry, commitActiveBoxes],
  );

  // Keyboard shortcuts: Ctrl+Z / Ctrl+Y / Del / Space pan / B compare toggle
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inInput =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (inInput) return;

      if (e.code === "Space") {
        e.preventDefault();
        setSpaceDown(true);
        return;
      }
      if ((e.key === "b" || e.key === "B") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        updateBlurFacesSession((prev) => ({
          ...prev,
          compareOriginal: !prev.compareOriginal,
        }));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        handleRedo();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && st.selectedBoxId) {
        e.preventDefault();
        handleDeleteBox(st.selectedBoxId);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceDown(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [handleDeleteBox, handleRedo, handleUndo, st.selectedBoxId, updateBlurFacesSession]);

  const resolvedViewport = useMemo(
    () =>
      resolveViewport(
        stageSize.w,
        stageSize.h,
        activeEntry?.width ?? 1,
        activeEntry?.height ?? 1,
        st.viewport,
      ),
    [stageSize.w, stageSize.h, activeEntry?.width, activeEntry?.height, st.viewport],
  );

  // Canvas render
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !activeEntry?.width || !activeEntry?.height) return;

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const cw = Math.max(1, Math.round(stageSize.w * dpr));
    const ch = Math.max(1, Math.round(stageSize.h * dpr));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, stageSize.w, stageSize.h);

    const { scale, offsetX, offsetY } = resolvedViewport;
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    ctx.drawImage(img, 0, 0, activeEntry.width, activeEntry.height);

    if (!st.compareOriginal) {
      for (const box of activeEntry.boxes) {
        if (!box.enabled) continue;
        drawRedactionBoxPreview(
          ctx,
          img,
          activeEntry.width,
          activeEntry.height,
          box,
          st.redactionKind,
          st.strength,
          st.colorHex,
        );
      }

      if (dragState?.kind === "draw") {
        drawRedactionBoxPreview(
          ctx,
          img,
          activeEntry.width,
          activeEntry.height,
          {
            id: "draft",
            source: "manual",
            enabled: true,
            confidence: null,
            ...dragState.curRect,
          },
          st.redactionKind,
          st.strength,
          st.colorHex,
        );
      }
    }

    // Draw editable face bounding-box outlines & index labels
    activeEntry.boxes.forEach((box, idx) => {
      const isSelected = box.id === st.selectedBoxId;
      ctx.save();
      ctx.lineWidth = (isSelected ? 2.2 : 1.5) / scale;
      if (!box.enabled) {
        ctx.strokeStyle = "rgba(148, 163, 184, 0.9)";
        ctx.setLineDash([5 / scale, 4 / scale]);
      } else if (isSelected) {
        ctx.strokeStyle = "#2563EB";
      } else if (box.source === "manual") {
        ctx.strokeStyle = "#0D9488";
      } else {
        ctx.strokeStyle = "rgba(37, 99, 235, 0.85)";
      }
      ctx.strokeRect(box.x, box.y, box.width, box.height);

      // Compact index pill at top-left corner of box
      const badgeFontPx = Math.max(10, Math.round(11 / scale));
      const pad = 3 / scale;
      const tag = `#${idx + 1}`;
      ctx.font = `600 ${badgeFontPx}px "Segoe UI", sans-serif`;
      const tw = ctx.measureText(tag).width;
      const bh = badgeFontPx + pad * 2;
      const bw = tw + pad * 2.4;
      const by = Math.max(0, box.y - bh);
      ctx.fillStyle = !box.enabled
        ? "rgba(71, 85, 105, 0.85)"
        : isSelected
          ? "#2563EB"
          : box.source === "manual"
            ? "#0D9488"
            : "rgba(15, 23, 42, 0.8)";
      ctx.fillRect(box.x, by, bw, bh);
      ctx.fillStyle = "#FFFFFF";
      ctx.textBaseline = "top";
      ctx.fillText(tag, box.x + pad * 1.2, by + pad);
      ctx.restore();
    });

    if (dragState?.kind === "draw") {
      ctx.save();
      ctx.strokeStyle = "#0D9488";
      ctx.lineWidth = 1.8 / scale;
      ctx.setLineDash([5 / scale, 4 / scale]);
      ctx.strokeRect(
        dragState.curRect.x,
        dragState.curRect.y,
        dragState.curRect.width,
        dragState.curRect.height,
      );
      ctx.restore();
    }

    ctx.restore();

    // Draw crisp screen-space selection handles on the active box
    const activeSel = activeEntry.boxes.find((b) => b.id === st.selectedBoxId);
    if (activeSel) {
      drawSelectionHandles(ctx, activeSel, resolvedViewport);
    }
  }, [
    activeEntry,
    dragState,
    imgVersion,
    resolvedViewport,
    st.colorHex,
    st.compareOriginal,
    st.redactionKind,
    st.selectedBoxId,
    st.strength,
    stageSize.h,
    stageSize.w,
  ]);

  const getImagePoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return screenToImage(e.clientX, e.clientY, rect.left, rect.top, resolvedViewport);
  };

  const hitTestBox = (imgX: number, imgY: number): BlurFaceBoxItem | null => {
    if (!activeEntry) return null;
    for (let i = activeEntry.boxes.length - 1; i >= 0; i--) {
      const b = activeEntry.boxes[i]!;
      if (imgX >= b.x && imgX <= b.x + b.width && imgY >= b.y && imgY <= b.y + b.height) {
        return b;
      }
    }
    return null;
  };

  const selectedBox = useMemo(
    () => activeEntry?.boxes.find((b) => b.id === st.selectedBoxId) ?? null,
    [activeEntry, st.selectedBoxId],
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!activeEntry?.width || !activeEntry?.height) return;
    e.currentTarget.setPointerCapture(e.pointerId);

    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      setDragState({
        kind: "pan",
        startClientX: e.clientX,
        startClientY: e.clientY,
        origPanX: st.viewport.panX,
        origPanY: st.viewport.panY,
      });
      return;
    }
    if (e.button !== 0) return;

    const imgPt = getImagePoint(e);

    // Resize handle on selected box
    if (selectedBox) {
      const handle = hitTestResizeHandle(imgPt.x, imgPt.y, selectedBox, resolvedViewport.scale);
      if (handle) {
        patchEntry(activeEntry.id, (cur) => ({
          ...cur,
          undoStack: [...cur.undoStack.slice(-39), cloneBoxes(cur.boxes)],
          redoStack: [],
          modifiedByUser: true,
        }));
        setDragState({
          kind: "resize",
          id: selectedBox.id,
          handle,
          startImgX: imgPt.x,
          startImgY: imgPt.y,
          origRect: {
            x: selectedBox.x,
            y: selectedBox.y,
            width: selectedBox.width,
            height: selectedBox.height,
          },
        });
        return;
      }
    }

    if (st.interactionMode === "add") {
      const clampedX = Math.max(0, Math.min(activeEntry.width, imgPt.x));
      const clampedY = Math.max(0, Math.min(activeEntry.height, imgPt.y));
      setDragState({
        kind: "draw",
        startImgX: clampedX,
        startImgY: clampedY,
        curRect: { x: Math.round(clampedX), y: Math.round(clampedY), width: 0, height: 0 },
      });
      return;
    }

    const hit = hitTestBox(imgPt.x, imgPt.y);
    if (hit) {
      patchEntry(activeEntry.id, (cur) => ({
        ...cur,
        undoStack: [...cur.undoStack.slice(-39), cloneBoxes(cur.boxes)],
        redoStack: [],
        modifiedByUser: true,
      }));
      updateBlurFacesSession({ selectedBoxId: hit.id });
      setDragState({
        kind: "move",
        id: hit.id,
        startImgX: imgPt.x,
        startImgY: imgPt.y,
        origRect: { x: hit.x, y: hit.y, width: hit.width, height: hit.height },
      });
      return;
    }

    updateBlurFacesSession({ selectedBoxId: null });
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!activeEntry?.width || !activeEntry?.height) return;
    const imgPt = getImagePoint(e);

    if (!dragState) {
      if (spaceDown) {
        setCursorStyle("grab");
      } else if (selectedBox) {
        const h = hitTestResizeHandle(imgPt.x, imgPt.y, selectedBox, resolvedViewport.scale);
        if (h) {
          setCursorStyle(handleCursorFor(h));
        } else if (st.interactionMode === "add") {
          setCursorStyle("crosshair");
        } else {
          setCursorStyle(hitTestBox(imgPt.x, imgPt.y) ? "move" : "default");
        }
      } else {
        setCursorStyle(
          st.interactionMode === "add"
            ? "crosshair"
            : hitTestBox(imgPt.x, imgPt.y)
              ? "move"
              : "default",
        );
      }
      return;
    }

    if (dragState.kind === "pan") {
      updateBlurFacesSession({
        viewport: {
          mode: "manual",
          scale: resolvedViewport.scale,
          panX: dragState.origPanX + (e.clientX - dragState.startClientX),
          panY: dragState.origPanY + (e.clientY - dragState.startClientY),
        },
      });
      return;
    }

    if (dragState.kind === "draw") {
      const rect = normalizeRectFromDrag(
        dragState.startImgX,
        dragState.startImgY,
        imgPt.x,
        imgPt.y,
        activeEntry.width,
        activeEntry.height,
      );
      setDragState({ ...dragState, curRect: rect });
      return;
    }

    if (dragState.kind === "move") {
      const dx = Math.round(imgPt.x - dragState.startImgX);
      const dy = Math.round(imgPt.y - dragState.startImgY);
      const moved = clampRectToImage(
        {
          x: dragState.origRect.x + dx,
          y: dragState.origRect.y + dy,
          width: dragState.origRect.width,
          height: dragState.origRect.height,
        },
        activeEntry.width,
        activeEntry.height,
      );
      patchEntry(activeEntry.id, (cur) => ({
        ...cur,
        boxes: cur.boxes.map((b) => (b.id === dragState.id ? { ...b, ...moved } : b)),
      }));
      return;
    }

    if (dragState.kind === "resize") {
      const resized = applyHandleResize(
        dragState.origRect,
        dragState.handle,
        imgPt.x - dragState.startImgX,
        imgPt.y - dragState.startImgY,
        activeEntry.width,
        activeEntry.height,
        8,
      );
      patchEntry(activeEntry.id, (cur) => ({
        ...cur,
        boxes: cur.boxes.map((b) => (b.id === dragState.id ? { ...b, ...resized } : b)),
      }));
    }
  };

  const handlePointerUp = () => {
    if (!dragState) return;
    if (dragState.kind === "draw" && activeEntry) {
      if (dragState.curRect.width >= 6 && dragState.curRect.height >= 6) {
        const newId = `manual-face-${Date.now()}-${seqRef.current++}`;
        const added: BlurFaceBoxItem = {
          id: newId,
          source: "manual",
          enabled: true,
          confidence: null,
          ...dragState.curRect,
        };
        commitActiveBoxes([...activeEntry.boxes, added], newId);
      }
    }
    setDragState(null);
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!activeEntry?.width || !activeEntry?.height || !e.ctrlKey) return;
    e.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const next = zoomViewportAroundStagePoint(
      stageSize.w,
      stageSize.h,
      activeEntry.width,
      activeEntry.height,
      st.viewport,
      resolvedViewport.scale * factor,
      e.clientX - rect.left,
      e.clientY - rect.top,
    );
    updateBlurFacesSession({ viewport: next });
  };

  const handleCopyCurrent = async () => {
    if (!activeEntry?.assetId) return;
    setErrorText(null);
    setBusy(true);
    try {
      const regions = buildBackendRegions(
        activeEntry.boxes,
        st.redactionKind,
        st.strength,
        st.colorHex,
      );
      const baked = await applyImageRedactionsToAsset({
        assetId: activeEntry.assetId,
        regions,
        label: activeEntry.fileName,
      });
      await copyImageAssetToClipboard({ assetId: baked.assetId });
      updateBlurFacesSession({ lastSavedMessage: c.copiedOk });
    } catch (err) {
      setErrorText(formatLocalizedError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const handleHandoff = async (target: ImageHandoffTarget) => {
    if (!activeEntry?.assetId) return;
    setErrorText(null);
    setBusy(true);
    try {
      const regions = buildBackendRegions(
        activeEntry.boxes,
        st.redactionKind,
        st.strength,
        st.colorHex,
      );
      const baked = await applyImageRedactionsToAsset({
        assetId: activeEntry.assetId,
        regions,
        label: activeEntry.fileName,
      });
      handoffImageToTool(target, baked);
    } catch (err) {
      setErrorText(formatLocalizedError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const runSaveCurrent = async (
    outputPath: string,
    format: SaveAssetFormat,
    overwrite: boolean,
  ) => {
    if (!activeEntry?.assetId) return;
    setErrorText(null);
    setBusy(true);
    try {
      const regions = buildBackendRegions(
        activeEntry.boxes,
        st.redactionKind,
        st.strength,
        st.colorHex,
      );
      const res = await exportRedactedImageFile({
        assetId: activeEntry.assetId,
        sourcePath: activeEntry.sourcePath,
        regions,
        outputPath,
        format,
        jpegQuality: 92,
        stripMetadata: st.stripMetadata,
        overwrite,
      });
      updateBlurFacesSession({
        lastSavedMessage: c.savedOk(res.outputPath, res.metadataStripped),
      });
    } catch (err) {
      const parsed = parseBackendError(err);
      if (parsed.code === "TARGET_ALREADY_EXISTS" && !overwrite) {
        setPendingOverwrite({ path: outputPath, format });
      } else {
        setErrorText(formatLocalizedError(err, t));
      }
    } finally {
      setBusy(false);
    }
  };

  const handleSaveCurrentClick = async (format: SaveAssetFormat) => {
    if (!activeEntry?.assetId) return;
    const ext = format === "png" ? "png" : "jpg";
    const defaultName =
      (activeEntry.sourcePath
        ? await suggestSafeSiblingPath(activeEntry.sourcePath, "faces_redacted", ext)
        : null) ?? `winkit_faces_redacted.${ext}`;
    const target = await pickSaveFilePath({
      title: format === "png" ? c.savePng : c.saveJpeg,
      defaultPath: defaultName,
      filters: [{ name: format.toUpperCase(), extensions: [ext] }],
    });
    if (!target) return;
    await runSaveCurrent(target, format, false);
  };

  const fileBackedEntries = useMemo(
    () => st.entries.filter((e) => Boolean(e.sourcePath)),
    [st.entries],
  );

  const handleChooseOutputDir = async () => {
    const dir = await pickSingleDirectory({
      title: c.batchOutputLabel,
    });
    if (dir) {
      updateBlurFacesSession({ outputDir: dir, batchErrorMessage: null });
    }
  };

  const handleStartBatch = async () => {
    if (fileBackedEntries.length === 0) return;
    if (!st.outputDir.trim()) {
      updateBlurFacesSession({ batchErrorMessage: c.needOutputDirErr });
      return;
    }

    const items = fileBackedEntries.map((entry) => {
      const hasKnownBoxes =
        entry.detectionStatus === "detected" ||
        entry.detectionStatus === "no_faces" ||
        entry.modifiedByUser;
      return {
        sourcePath: entry.sourcePath!,
        overrideRegions: hasKnownBoxes
          ? buildBackendRegions(entry.boxes, st.redactionKind, st.strength, st.colorHex)
          : null,
      };
    });

    await startBlurFacesBatch(
      {
        items,
        outputDir: st.outputDir.trim(),
        defaultKind: st.redactionKind,
        defaultStrength: st.strength,
        defaultColorHex: st.redactionKind === "solid" ? st.colorHex : null,
        scoreThreshold: null,
        format: st.exportFormat,
        jpegQuality: 92,
        stripMetadata: st.stripMetadata,
        exportUntouchedCopies: st.exportUntouchedCopies,
      },
      (err) => formatLocalizedError(err, t),
    );
  };

  const hasImage = Boolean(
    activeEntry &&
    activeEntry.assetId &&
    activeEntry.dataUrl &&
    activeEntry.width &&
    activeEntry.height,
  );
  const enabledCount = activeEntry ? activeEntry.boxes.filter((b) => b.enabled).length : 0;
  const pendingCount = st.entries.filter((e) => e.detectionStatus === "pending").length;

  const renderStatusBadge = (entry: BlurFaceQueueEntry) => {
    if (entry.detectionStatus === "detecting") {
      return <span className="blur-faces-pill is-pending">{c.statusDetecting}</span>;
    }
    if (entry.detectionStatus === "failed") {
      return <span className="blur-faces-pill is-failed">{c.statusFailed}</span>;
    }
    if (entry.detectionStatus === "detected") {
      const enabled = entry.boxes.filter((b) => b.enabled).length;
      return (
        <span className="blur-faces-pill is-detected">
          {c.statusDetected(entry.modifiedByUser ? enabled : entry.detectedCount)}
        </span>
      );
    }
    if (entry.detectionStatus === "no_faces") {
      const manualEnabled = entry.boxes.filter((b) => b.enabled).length;
      if (manualEnabled > 0) {
        return (
          <span className="blur-faces-pill is-detected">{c.statusDetected(manualEnabled)}</span>
        );
      }
      return <span className="blur-faces-pill is-none">{c.statusNoFaces}</span>;
    }
    return <span className="blur-faces-pill is-pending">{c.statusPending}</span>;
  };

  return (
    <div className="img-editor-shell">
      {/* Top Action Bar */}
      <div className="img-editor-topbar">
        <div className="img-editor-group">
          <button
            type="button"
            className="btn"
            disabled={busy || st.batchStatus === "running"}
            onClick={() => void handlePickFiles()}
          >
            <ImagePlus size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{c.addImages}</span>
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || st.batchStatus === "running"}
            onClick={() => void handlePasteClipboard()}
          >
            <ClipboardPaste size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{c.paste}</span>
          </button>
          {pendingCount > 0 && (
            <button
              type="button"
              className="btn"
              disabled={detectingAll || st.batchStatus === "running"}
              onClick={() => void handleDetectAllQueued()}
            >
              <ScanFace size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>
                {c.detectAllBtn} ({pendingCount})
              </span>
            </button>
          )}

          <span className="img-editor-divider" aria-hidden="true" />

          <button
            type="button"
            className="btn"
            disabled={!activeEntry || activeEntry.undoStack.length === 0}
            title={`${c.undo} (Ctrl+Z)`}
            onClick={handleUndo}
          >
            <Undo2 size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{c.undo}</span>
          </button>
          <button
            type="button"
            className="btn"
            disabled={!activeEntry || activeEntry.redoStack.length === 0}
            title={`${c.redo} (Ctrl+Y)`}
            onClick={handleRedo}
          >
            <Redo2 size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{c.redo}</span>
          </button>

          <span className="img-editor-divider" aria-hidden="true" />

          <button
            type="button"
            className="btn"
            disabled={!hasImage}
            onClick={() => updateBlurFacesSession({ viewport: { ...DEFAULT_VIEWPORT } })}
          >
            <Maximize2 size={13} strokeWidth={1.75} aria-hidden="true" />
            <span>{c.fit}</span>
          </button>
          <button
            type="button"
            className="btn"
            disabled={!hasImage}
            onClick={() =>
              updateBlurFacesSession({
                viewport: { mode: "manual", scale: 1, panX: 0, panY: 0 },
              })
            }
          >
            <span>{c.actualSize}</span>
          </button>
          <button
            type="button"
            className="btn"
            disabled={!hasImage}
            aria-label="Zoom out"
            onClick={() =>
              updateBlurFacesSession({
                viewport: {
                  mode: "manual",
                  scale: clampZoom(resolvedViewport.scale / 1.25),
                  panX: st.viewport.panX,
                  panY: st.viewport.panY,
                },
              })
            }
          >
            <ZoomOut size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <span className="img-editor-zoom-label">
            {hasImage ? `${Math.round(resolvedViewport.scale * 100)}%` : "—"}
          </span>
          <button
            type="button"
            className="btn"
            disabled={!hasImage}
            aria-label="Zoom in"
            onClick={() =>
              updateBlurFacesSession({
                viewport: {
                  mode: "manual",
                  scale: clampZoom(resolvedViewport.scale * 1.25),
                  panX: st.viewport.panX,
                  panY: st.viewport.panY,
                },
              })
            }
          >
            <ZoomIn size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>

          <button
            type="button"
            className={`btn ${st.compareOriginal ? "btn-primary" : ""}`}
            disabled={!hasImage}
            aria-pressed={st.compareOriginal}
            onClick={() =>
              updateBlurFacesSession((prev) => ({
                ...prev,
                compareOriginal: !prev.compareOriginal,
              }))
            }
          >
            {st.compareOriginal ? (
              <Eye size={14} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <EyeOff size={14} strokeWidth={1.75} aria-hidden="true" />
            )}
            <span>{c.compareBtn}</span>
          </button>
        </div>

        <div className="img-editor-group">
          <button
            type="button"
            className="btn"
            disabled={!hasImage || busy}
            onClick={() => void handleCopyCurrent()}
          >
            <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{c.copyImg}</span>
          </button>
          {hasAnnotate && (
            <button
              type="button"
              className="btn"
              disabled={!hasImage || busy}
              onClick={() => void handleHandoff("I12")}
            >
              <Pencil size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{c.sendAnnotate}</span>
            </button>
          )}
          {hasBeautify && (
            <button
              type="button"
              className="btn"
              disabled={!hasImage || busy}
              onClick={() => void handleHandoff("I03")}
            >
              <Frame size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{c.sendBeautify}</span>
            </button>
          )}
          {hasWatermark && (
            <button
              type="button"
              className="btn"
              disabled={!hasImage || busy}
              onClick={() => void handleHandoff("I13")}
            >
              <Stamp size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{c.sendWatermark}</span>
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={!hasImage || busy}
            onClick={() => void handleSaveCurrentClick("png")}
          >
            <Download size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{c.savePng}</span>
          </button>
          <button
            type="button"
            className="btn"
            disabled={!hasImage || busy}
            onClick={() => void handleSaveCurrentClick("jpeg")}
          >
            <span>{c.saveJpeg}</span>
          </button>
        </div>
      </div>

      {/* Contextual Style & Interaction Bar */}
      <div className="img-editor-context-bar">
        <div className="segmented" role="group" aria-label="Canvas mode">
          <button
            type="button"
            className={`segmented-btn ${st.interactionMode === "select" ? "is-selected" : ""}`}
            onClick={() => updateBlurFacesSession({ interactionMode: "select" })}
          >
            <MousePointer2 size={13} strokeWidth={1.8} aria-hidden="true" />
            <span>{c.modeSelect}</span>
          </button>
          <button
            type="button"
            className={`segmented-btn ${st.interactionMode === "add" ? "is-selected" : ""}`}
            onClick={() => updateBlurFacesSession({ interactionMode: "add" })}
          >
            <PlusSquare size={13} strokeWidth={1.8} aria-hidden="true" />
            <span>{c.modeAdd}</span>
          </button>
        </div>

        <span className="img-editor-divider" aria-hidden="true" />

        <div className="segmented" role="group" aria-label="Redaction style">
          {(
            [
              ["blur", c.kindBlur, Droplets],
              ["pixelate", c.kindPixelate, Grid2x2],
              ["solid", c.kindSolid, Square],
            ] as const
          ).map(([kind, label, Icon]) => (
            <button
              key={kind}
              type="button"
              className={`segmented-btn ${st.redactionKind === kind ? "is-selected" : ""}`}
              onClick={() => updateBlurFacesSession({ redactionKind: kind })}
            >
              <Icon size={13} strokeWidth={1.8} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </div>

        {st.redactionKind === "solid" ? (
          <div className="img-editor-group">
            <span>{c.colorLabel}</span>
            <div className="img-editor-swatch-row">
              {SOLID_SWATCHES.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  className={`img-editor-swatch ${st.colorHex.toUpperCase() === hex ? "is-active" : ""}`}
                  style={{ background: hex }}
                  aria-label={hex}
                  onClick={() => updateBlurFacesSession({ colorHex: hex })}
                />
              ))}
            </div>
          </div>
        ) : (
          <label className="img-editor-group">
            <span>
              {c.strengthLabel}: <strong>{st.strength}px</strong>
            </span>
            <input
              type="range"
              min={st.redactionKind === "pixelate" ? 6 : 4}
              max={st.redactionKind === "pixelate" ? 64 : 60}
              value={st.strength}
              onChange={(e) => updateBlurFacesSession({ strength: Number(e.target.value) })}
            />
          </label>
        )}

        <label
          className="img-editor-group"
          style={{ marginLeft: "auto", cursor: "pointer", userSelect: "none" }}
        >
          <input
            type="checkbox"
            checked={st.stripMetadata}
            onChange={(e) => updateBlurFacesSession({ stripMetadata: e.target.checked })}
          />
          <ShieldCheck size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>{c.stripMetaLabel}</span>
        </label>
      </div>

      {errorText && (
        <div className="status-banner is-err" role="alert">
          <span>{errorText}</span>
        </div>
      )}
      {st.batchErrorMessage && (
        <div className="status-banner is-err" role="alert">
          <span>{st.batchErrorMessage}</span>
        </div>
      )}
      {st.lastSavedMessage && !errorText && (
        <div className="status-banner is-ok" role="status" aria-live="polite">
          <span>{st.lastSavedMessage}</span>
        </div>
      )}
      {st.batchLastReport && (
        <div
          className={`status-banner ${st.batchLastReport.failedCount > 0 || st.batchLastReport.cancelled ? "is-warn" : "is-ok"}`}
          role="status"
          aria-live="polite"
        >
          <span>
            {c.batchReportSummary(
              st.batchLastReport.succeededCount,
              st.batchLastReport.keptOriginalCount,
              st.batchLastReport.skippedCount,
              st.batchLastReport.failedCount,
              st.batchLastReport.cancelled,
            )}
          </span>
          <button
            type="button"
            className="btn"
            style={{ marginLeft: "auto" }}
            onClick={() => void openLocalDirectory(st.batchLastReport!.outputDir)}
          >
            <FolderOpen size={13} strokeWidth={1.75} aria-hidden="true" />
            <span>{c.openOutDirBtn}</span>
          </button>
        </div>
      )}

      {/* Main Split: Left Photo Queue + Face Box List | Right Interactive Canvas */}
      <div className="blur-faces-main">
        <aside className="blur-faces-sidebar">
          {/* Queue Panel */}
          <section className="blur-faces-panel blur-faces-panel-queue">
            <div className="blur-faces-panel-head">
              <span>{c.queueHeading(st.entries.length)}</span>
              {st.entries.length > 0 && (
                <button
                  type="button"
                  className="btn"
                  style={{ height: 22, padding: "0 6px", fontSize: 11 }}
                  disabled={st.batchStatus === "running"}
                  onClick={() =>
                    updateBlurFacesSession({
                      entries: [],
                      activeEntryId: null,
                      selectedBoxId: null,
                      lastSavedMessage: null,
                      batchLastReport: null,
                    })
                  }
                >
                  {c.clearQueue}
                </button>
              )}
            </div>
            <div className="blur-faces-list" role="list">
              {st.entries.map((entry) => {
                const isActive = entry.id === activeEntry?.id;
                return (
                  <div
                    key={entry.id}
                    role="listitem"
                    className={`blur-faces-queue-row ${isActive ? "is-active" : ""}`}
                    onClick={() =>
                      updateBlurFacesSession({
                        activeEntryId: entry.id,
                        selectedBoxId: entry.boxes[0]?.id ?? null,
                        compareOriginal: false,
                        viewport: { ...DEFAULT_VIEWPORT },
                      })
                    }
                  >
                    {entry.thumbnailDataUrl ? (
                      <img src={entry.thumbnailDataUrl} alt="" className="blur-faces-thumb" />
                    ) : (
                      <div className="blur-faces-thumb-placeholder">
                        <ImageOff size={15} strokeWidth={1.75} aria-hidden="true" />
                      </div>
                    )}
                    <div className="blur-faces-queue-meta">
                      <span
                        className="blur-faces-filename"
                        title={entry.sourcePath ?? entry.fileName}
                      >
                        {entry.fileName}
                      </span>
                      <div className="blur-faces-status-row">
                        {renderStatusBadge(entry)}
                        {entry.modifiedByUser && (
                          <span className="blur-faces-pill is-pending">{c.modifiedTag}</span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="blur-faces-icon-btn"
                      aria-label={`Remove ${entry.fileName}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        updateBlurFacesSession((prev) => {
                          const next = prev.entries.filter((item) => item.id !== entry.id);
                          return {
                            ...prev,
                            entries: next,
                            activeEntryId:
                              prev.activeEntryId === entry.id
                                ? (next[0]?.id ?? null)
                                : prev.activeEntryId,
                            selectedBoxId: null,
                          };
                        });
                      }}
                    >
                      <X size={13} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Detected & Manual Face Boxes List */}
          <section className="blur-faces-panel blur-faces-panel-boxes">
            <div className="blur-faces-panel-head">
              <span>{c.boxesHeading(enabledCount, activeEntry?.boxes.length ?? 0)}</span>
              {activeEntry && (
                <div className="img-editor-group" style={{ gap: 3 }}>
                  <button
                    type="button"
                    className="blur-faces-icon-btn"
                    title={c.redetectBtn}
                    disabled={activeEntry.detectionStatus === "detecting"}
                    onClick={() => void loadAndDetectEntry(activeEntry, true)}
                  >
                    <RefreshCw size={12.5} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                  {activeEntry.boxes.length > 0 && (
                    <button
                      type="button"
                      className="btn"
                      style={{ height: 22, padding: "0 6px", fontSize: 11 }}
                      onClick={() => {
                        const targetEnabled = enabledCount < activeEntry.boxes.length;
                        commitActiveBoxes(
                          activeEntry.boxes.map((b) => ({ ...b, enabled: targetEnabled })),
                          st.selectedBoxId,
                        );
                      }}
                    >
                      {enabledCount < activeEntry.boxes.length ? c.enableAll : c.disableAll}
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="blur-faces-list">
              {!activeEntry || activeEntry.boxes.length === 0 ? (
                <div style={{ padding: "8px 6px", fontSize: 12, color: "var(--text-secondary)" }}>
                  {activeEntry?.detectionStatus === "failed"
                    ? activeEntry.detectionError || c.failedCanvasHint
                    : c.noBoxesHint}
                </div>
              ) : (
                activeEntry.boxes.map((box, idx) => (
                  <div
                    key={box.id}
                    className={`blur-faces-box-row ${st.selectedBoxId === box.id ? "is-selected" : ""} ${!box.enabled ? "is-disabled" : ""}`}
                    onClick={() => updateBlurFacesSession({ selectedBoxId: box.id })}
                  >
                    <input
                      type="checkbox"
                      checked={box.enabled}
                      aria-label={`Toggle face #${idx + 1}`}
                      onChange={() => handleToggleBox(box.id)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <div className="blur-faces-box-info">
                      <span>
                        <strong>#{idx + 1}</strong>{" "}
                        {box.source === "auto"
                          ? `${c.sourceAuto}${box.confidence !== null ? ` (${Math.round(box.confidence * 100)}%)` : ""}`
                          : c.sourceManual}
                      </span>
                      <span
                        className="mono"
                        style={{ fontSize: 11, color: "var(--text-secondary)" }}
                      >
                        {Math.round(box.width)}×{Math.round(box.height)}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="blur-faces-icon-btn"
                      aria-label={`Delete face #${idx + 1}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteBox(box.id);
                      }}
                    >
                      <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </section>
        </aside>

        {/* Interactive Canvas Stage */}
        <div ref={stageRef} className={`img-editor-stage-wrap ${dropHover ? "is-drop-hover" : ""}`}>
          {st.compareOriginal && hasImage && (
            <div className="blur-faces-compare-badge">{c.comparingOriginal}</div>
          )}
          {hasImage ? (
            <canvas
              ref={canvasRef}
              data-testid="blur-faces-canvas"
              className="img-editor-canvas"
              style={{ cursor: cursorStyle }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              onWheel={handleWheel}
            />
          ) : activeEntry?.detectionStatus === "failed" ? (
            <div className="img-editor-empty">
              <ImageOff size={28} strokeWidth={1.6} color="var(--err)" aria-hidden="true" />
              <strong style={{ color: "var(--text-primary)", fontSize: 14 }}>
                {activeEntry.fileName} — {c.statusFailed}
              </strong>
              <p
                style={{ margin: 0, maxWidth: 440, fontSize: 12.5, color: "var(--text-secondary)" }}
              >
                {activeEntry.detectionError || c.failedCanvasHint}
              </p>
            </div>
          ) : (
            <div className="img-editor-empty">
              <ScanFace size={30} strokeWidth={1.6} color="var(--accent)" aria-hidden="true" />
              <strong style={{ color: "var(--text-primary)", fontSize: 14 }}>{c.emptyTitle}</strong>
              <p
                style={{ margin: 0, maxWidth: 480, fontSize: 12.5, color: "var(--text-secondary)" }}
              >
                {c.emptyDesc}
              </p>
              <div className="img-editor-group" style={{ marginTop: 4 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void handlePickFiles()}
                >
                  <ImagePlus size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{c.addImages}</span>
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void handlePasteClipboard()}
                >
                  <ClipboardPaste size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{c.paste}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Batch Export Strip (shown whenever at least 1 local file is queued) */}
      {fileBackedEntries.length > 0 && (
        <div className="blur-faces-batch-bar">
          <div className="img-editor-group">
            <button
              type="button"
              className="btn"
              disabled={st.batchStatus === "running"}
              onClick={() => void handleChooseOutputDir()}
            >
              <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{c.chooseOutputDir}</span>
            </button>
            <span className="blur-faces-output-path" title={st.outputDir || c.outputDirPlaceholder}>
              {st.outputDir || c.outputDirPlaceholder}
            </span>

            <div className="segmented" role="group" aria-label="Batch export format">
              {(["png", "jpeg"] as SaveAssetFormat[]).map((fmt) => (
                <button
                  key={fmt}
                  type="button"
                  className={`segmented-btn ${st.exportFormat === fmt ? "is-selected" : ""}`}
                  disabled={st.batchStatus === "running"}
                  onClick={() => updateBlurFacesSession({ exportFormat: fmt })}
                >
                  {fmt.toUpperCase()}
                </button>
              ))}
            </div>

            <label className="img-editor-group" style={{ cursor: "pointer", userSelect: "none" }}>
              <input
                type="checkbox"
                checked={st.exportUntouchedCopies}
                disabled={st.batchStatus === "running"}
                onChange={(e) =>
                  updateBlurFacesSession({ exportUntouchedCopies: e.target.checked })
                }
              />
              <span>{c.batchUntouchedLabel}</span>
            </label>
          </div>

          <div className="img-editor-group">
            {st.batchStatus === "running" && st.batchLiveProgress && (
              <span style={{ color: "var(--text-secondary)" }}>
                {c.batchProgressText(
                  st.batchLiveProgress.currentIndex,
                  st.batchLiveProgress.totalItems,
                  st.batchLiveProgress.currentFileName,
                )}
              </span>
            )}
            {st.batchStatus === "running" ? (
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void cancelBlurFacesBatch()}
              >
                <span>{c.cancelBatchBtn}</span>
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void handleStartBatch()}
              >
                <Download size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{c.startBatchBtn(fileBackedEntries.length)}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Footer Status */}
      <div className="img-editor-footer">
        <div className="img-editor-group">
          {activeEntry && !activeEntry.sourcePath && (
            <span className="badge badge-ok">{c.memoryBadge}</span>
          )}
          {activeEntry && <span>{activeEntry.fileName}</span>}
          {activeEntry?.width && activeEntry?.height && (
            <span className="mono">
              {activeEntry.width}×{activeEntry.height} px
            </span>
          )}
          {activeEntry?.elapsedMs !== null && activeEntry?.elapsedMs !== undefined && (
            <span className="mono">· {activeEntry.elapsedMs} ms (CPU)</span>
          )}
          {st.batchLastReport && (
            <span className="mono">· {formatBytes(st.batchLastReport.totalOutputBytes)}</span>
          )}
        </div>
        <span>{c.panHint}</span>
      </div>

      <ConfirmDialog
        open={pendingOverwrite !== null}
        title={c.overwriteTitle}
        body={c.overwriteBody(pendingOverwrite?.path ?? "")}
        confirmLabel={c.overwriteConfirm}
        cancelLabel={c.cancel}
        onCancel={() => setPendingOverwrite(null)}
        onConfirm={async () => {
          const pending = pendingOverwrite;
          setPendingOverwrite(null);
          if (pending) await runSaveCurrent(pending.path, pending.format, true);
        }}
      />
    </div>
  );
}
