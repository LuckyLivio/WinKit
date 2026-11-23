import {
  ClipboardPaste,
  Copy,
  Download,
  Droplets,
  Frame,
  Grid2x2,
  ImagePlus,
  Maximize2,
  MousePointer2,
  Pencil,
  Redo2,
  ShieldCheck,
  Square,
  Stamp,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useI18n } from "../../i18n/I18nContext";
import {
  useSessionStore,
  type ImageHandoffTarget,
  type RedactRegionItem,
} from "../../lib/sessionStore";
import {
  applyImageRedactionsToAsset,
  bindDisposableListener,
  copyImageAssetToClipboard,
  exportRedactedImageFile,
  formatLocalizedError,
  loadFileAsImageAsset,
  parseBackendError,
  pickSaveFilePath,
  pickSingleFile,
  readClipboardImageAsAsset,
  subscribeFileDrop,
  suggestSafeSiblingPath,
  type RedactionKind,
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

const SOLID_SWATCHES = ["#111827", "#000000", "#334155", "#FFFFFF", "#B91C1C"];

const copy = {
  "zh-CN": {
    openFile: "打开图片",
    paste: "粘贴图片",
    fit: "适应",
    actualSize: "1:1",
    undo: "撤销",
    redo: "重做",
    copyImg: "复制结果",
    savePng: "导出 PNG",
    saveJpeg: "导出 JPEG",
    sendAnnotate: "送往批注 (I12)",
    sendBeautify: "送往美化 (I03)",
    sendWatermark: "送往水印 (I13)",
    toolSelect: "选择移动",
    toolSolid: "实色遮盖",
    toolPixelate: "像素化",
    toolBlur: "模糊",
    strengthLabel: "强度",
    colorLabel: "遮盖色",
    stripMetaLabel: "清理导出副本隐私元数据 (I09)",
    deleteRegion: "删除选区",
    clearRegions: "清空选区",
    emptyTitle: "打开图片、粘贴剪贴板，或从 I01 截图直接送入",
    emptyDesc:
      "在画布上拖拽框选需要隐藏的邮箱、手机号或订单号。导出或交接其他工具时将把遮盖像素不可逆烘焙到新图像，不留可移除遮罩层或原图缩略图。",
    copiedOk: "已将打码后的原图复制到 Windows 剪贴板",
    savedOk: (p: string, stripped: boolean) =>
      stripped ? `已导出干净副本（已验证无隐私元数据）：${p}` : `已导出：${p}`,
    regionCount: (n: number) => `${n} 处遮盖`,
    panHint: "按住空格或中键平移 · Ctrl+滚轮缩放 · Del 删除选区",
    overwriteTitle: "覆盖已有文件？",
    overwriteBody: (p: string) => `目标路径已存在文件：${p}\n确认覆盖吗？（不会修改原始图片）`,
    overwriteConfirm: "确认覆盖",
    cancel: "取消",
    memoryBadge: "内存原图",
  },
  "en-US": {
    openFile: "Open",
    paste: "Paste",
    fit: "Fit",
    actualSize: "1:1",
    undo: "Undo",
    redo: "Redo",
    copyImg: "Copy",
    savePng: "Export PNG",
    saveJpeg: "Export JPEG",
    sendAnnotate: "Annotate (I12)",
    sendBeautify: "Beautify (I03)",
    sendWatermark: "Watermark (I13)",
    toolSelect: "Select",
    toolSolid: "Solid",
    toolPixelate: "Pixelate",
    toolBlur: "Blur",
    strengthLabel: "Strength",
    colorLabel: "Fill",
    stripMetaLabel: "Strip privacy metadata on export (I09)",
    deleteRegion: "Delete",
    clearRegions: "Clear all",
    emptyTitle: "Open an image, paste clipboard, or send a screenshot from I01",
    emptyDesc:
      "Drag on the canvas to redact private details. Exporting or handing off bakes redactions destructively into new flat pixels with zero removable mask layers or thumbnails.",
    copiedOk: "Copied redacted full-resolution image to Windows clipboard",
    savedOk: (p: string, stripped: boolean) =>
      stripped ? `Exported clean copy (privacy metadata stripped): ${p}` : `Exported: ${p}`,
    regionCount: (n: number) => `${n} region(s)`,
    panHint: "Space+drag or middle-drag to pan · Ctrl+Wheel zoom · Del removes selection",
    overwriteTitle: "Overwrite existing file?",
    overwriteBody: (p: string) =>
      `Target file already exists: ${p}\nOverwrite it? (Source file is never modified.)`,
    overwriteConfirm: "Overwrite",
    cancel: "Cancel",
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

function cloneRegions(list: RedactRegionItem[]): RedactRegionItem[] {
  return list.map((r) => ({ ...r }));
}

function drawRedactionPreviewRegion(
  ctx: CanvasRenderingContext2D,
  sourceImg: HTMLImageElement,
  imgW: number,
  imgH: number,
  region: RedactRegionItem,
): void {
  const rect = clampRectToImage(region, imgW, imgH, 1);
  if (rect.width <= 0 || rect.height <= 0) return;

  if (region.kind === "solid") {
    ctx.save();
    ctx.fillStyle = region.colorHex || "#111827";
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.restore();
    return;
  }

  // Pixelate & blur preview directly in original-image coordinates
  const block =
    region.kind === "pixelate"
      ? Math.max(4, Math.min(64, region.strength))
      : Math.max(4, Math.min(48, Math.round(region.strength * 0.9)));
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
  ctx.imageSmoothingEnabled = region.kind === "blur";
  ctx.drawImage(tmp, 0, 0, sw, sh, rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

export function ImageRedactWorkspace() {
  const { locale, t } = useI18n();
  const c = copy[locale];
  const { session, updateImageRedactSession, handoffImageToTool } = useSessionStore();
  const st = session.imageRedact;

  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const seqRef = useRef(1);

  const [imgVersion, setImgVersion] = useState(0);
  const [stageSize, setStageSize] = useState({ w: 720, h: 460 });
  const [spaceDown, setSpaceDown] = useState(false);
  const [dragState, setDragState] = useState<DragInteraction | null>(null);
  const [cursorStyle, setCursorStyle] = useState("crosshair");
  const [dropHover, setDropHover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [pendingOverwrite, setPendingOverwrite] = useState<{
    path: string;
    format: SaveAssetFormat;
  } | null>(null);

  const hasAnnotate = Boolean(findRegisteredTool("I12"));
  const hasBeautify = Boolean(findRegisteredTool("I03"));
  const hasWatermark = Boolean(findRegisteredTool("I13"));

  // Load Image element whenever dataUrl changes
  useEffect(() => {
    if (!st.dataUrl) {
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
    img.src = st.dataUrl;
    return () => {
      cancelled = true;
    };
  }, [st.dataUrl]);

  // Observe stage container size (150% DPI & window resize safe)
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
      const obs = new ResizeObserver(update);
      obs.observe(el);
      return () => obs.disconnect();
    }
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const resolvedViewport = useMemo(
    () => resolveViewport(stageSize.w, stageSize.h, st.width ?? 1, st.height ?? 1, st.viewport),
    [stageSize.h, stageSize.w, st.height, st.viewport, st.width],
  );

  const selectedRegion = useMemo(
    () => st.regions.find((r) => r.id === st.selectedId) ?? null,
    [st.regions, st.selectedId],
  );

  const commitRegionsWithHistory = useCallback(
    (nextRegions: RedactRegionItem[], nextSelectedId?: string | null) => {
      updateImageRedactSession((prev) => ({
        ...prev,
        undoStack: [...prev.undoStack.slice(-39), cloneRegions(prev.regions)],
        redoStack: [],
        regions: nextRegions,
        selectedId: nextSelectedId !== undefined ? nextSelectedId : prev.selectedId,
        lastSavedMessage: null,
      }));
    },
    [updateImageRedactSession],
  );

  const handleUndo = useCallback(() => {
    updateImageRedactSession((prev) => {
      if (prev.undoStack.length === 0) return prev;
      const previous = prev.undoStack[prev.undoStack.length - 1]!;
      return {
        ...prev,
        undoStack: prev.undoStack.slice(0, -1),
        redoStack: [...prev.redoStack.slice(-39), cloneRegions(prev.regions)],
        regions: previous,
        selectedId: null,
        lastSavedMessage: null,
      };
    });
  }, [updateImageRedactSession]);

  const handleRedo = useCallback(() => {
    updateImageRedactSession((prev) => {
      if (prev.redoStack.length === 0) return prev;
      const next = prev.redoStack[prev.redoStack.length - 1]!;
      return {
        ...prev,
        redoStack: prev.redoStack.slice(0, -1),
        undoStack: [...prev.undoStack.slice(-39), cloneRegions(prev.regions)],
        regions: next,
        selectedId: null,
        lastSavedMessage: null,
      };
    });
  }, [updateImageRedactSession]);

  const handleDeleteSelected = useCallback(() => {
    if (!st.selectedId) return;
    commitRegionsWithHistory(
      st.regions.filter((r) => r.id !== st.selectedId),
      null,
    );
  }, [commitRegionsWithHistory, st.regions, st.selectedId]);

  const loadFromPath = useCallback(
    async (filePath: string) => {
      setErrorText(null);
      setBusy(true);
      try {
        const asset = await loadFileAsImageAsset(filePath);
        updateImageRedactSession({
          assetId: asset.assetId,
          sourcePath: filePath,
          sourceFileName: asset.label,
          dataUrl: asset.dataUrl,
          width: asset.width,
          height: asset.height,
          hasAlpha: asset.hasAlpha,
          regions: [],
          undoStack: [],
          redoStack: [],
          selectedId: null,
          viewport: { ...DEFAULT_VIEWPORT },
          lastSavedMessage: null,
        });
      } catch (err) {
        setErrorText(formatLocalizedError(err, t));
      } finally {
        setBusy(false);
      }
    },
    [t, updateImageRedactSession],
  );

  const handlePickFile = async () => {
    const picked = await pickSingleFile({
      title: c.openFile,
      filters: [{ name: "Images", extensions: IMAGE_FILE_DIALOG_EXTENSIONS }],
    });
    if (picked) await loadFromPath(picked);
  };

  const handlePasteClipboard = useCallback(async () => {
    setErrorText(null);
    setBusy(true);
    try {
      const asset = await readClipboardImageAsAsset();
      updateImageRedactSession({
        assetId: asset.assetId,
        sourcePath: null,
        sourceFileName: asset.label,
        dataUrl: asset.dataUrl,
        width: asset.width,
        height: asset.height,
        hasAlpha: asset.hasAlpha,
        regions: [],
        undoStack: [],
        redoStack: [],
        selectedId: null,
        viewport: { ...DEFAULT_VIEWPORT },
        lastSavedMessage: null,
      });
    } catch (err) {
      setErrorText(formatLocalizedError(err, t));
    } finally {
      setBusy(false);
    }
  }, [t, updateImageRedactSession]);

  // Drag & drop support
  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: (hovering) => setDropHover(hovering),
          onDropPaths: (paths) => {
            setDropHover(false);
            if (paths[0]) void loadFromPath(paths[0]);
          },
        }),
      "i11-redact-file-drop",
    );
  }, [loadFromPath]);

  // Keyboard shortcuts: Space pan, Ctrl+Z, Ctrl+Y, Ctrl+V, Delete
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;

      if (e.code === "Space") {
        e.preventDefault();
        setSpaceDown(true);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        handleRedo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
        e.preventDefault();
        void handlePasteClipboard();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (st.selectedId) {
          e.preventDefault();
          handleDeleteSelected();
        }
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
  }, [handleDeleteSelected, handlePasteClipboard, handleRedo, handleUndo, st.selectedId]);

  // Render live canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !st.width || !st.height) return;

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const cw = Math.max(1, Math.round(stageSize.w * dpr));
    const ch = Math.max(1, Math.round(stageSize.h * dpr));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, stageSize.w, stageSize.h);

    // Draw image & redactions inside viewport pixel-space transform
    ctx.save();
    ctx.translate(resolvedViewport.offsetX, resolvedViewport.offsetY);
    ctx.scale(resolvedViewport.scale, resolvedViewport.scale);
    ctx.imageSmoothingEnabled = resolvedViewport.scale < 2;
    ctx.drawImage(img, 0, 0, st.width, st.height);

    for (const region of st.regions) {
      drawRedactionPreviewRegion(ctx, img, st.width, st.height, region);
    }

    // Active drag-to-draw preview
    if (dragState?.kind === "draw" && dragState.curRect.width > 0 && dragState.curRect.height > 0) {
      const kind: RedactionKind = st.activeTool === "select" ? "solid" : st.activeTool;
      drawRedactionPreviewRegion(ctx, img, st.width, st.height, {
        id: "draft",
        kind,
        ...dragState.curRect,
        strength: st.defaultStrength,
        colorHex: st.defaultColorHex,
      });
    }
    ctx.restore();

    // Subtle border around image canvas
    ctx.strokeStyle = "rgba(15, 23, 42, 0.22)";
    ctx.lineWidth = 1;
    ctx.strokeRect(
      resolvedViewport.offsetX,
      resolvedViewport.offsetY,
      resolvedViewport.displayWidth,
      resolvedViewport.displayHeight,
    );

    // Non-selected region faint outlines & selected region handles
    for (const region of st.regions) {
      if (region.id === st.selectedId) {
        drawSelectionHandles(ctx, region, resolvedViewport, "#2563EB");
      } else {
        ctx.save();
        ctx.strokeStyle = "rgba(37, 99, 235, 0.45)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(
          resolvedViewport.offsetX + region.x * resolvedViewport.scale,
          resolvedViewport.offsetY + region.y * resolvedViewport.scale,
          region.width * resolvedViewport.scale,
          region.height * resolvedViewport.scale,
        );
        ctx.restore();
      }
    }

    if (dragState?.kind === "draw" && dragState.curRect.width > 1 && dragState.curRect.height > 1) {
      drawSelectionHandles(ctx, dragState.curRect, resolvedViewport, "#2563EB");
    }

    ctx.restore();
  }, [
    dragState,
    imgVersion,
    resolvedViewport,
    st.activeTool,
    st.defaultColorHex,
    st.defaultStrength,
    st.height,
    st.regions,
    st.selectedId,
    st.width,
    stageSize.h,
    stageSize.w,
  ]);

  const getPointerImgCoords = (clientX: number, clientY: number) => {
    const stage = stageRef.current;
    if (!stage) return { x: 0, y: 0 };
    const rect = stage.getBoundingClientRect();
    return screenToImage(clientX, clientY, rect.left, rect.top, resolvedViewport);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!st.width || !st.height) return;
    e.currentTarget.setPointerCapture(e.pointerId);

    if (spaceDown || e.button === 1) {
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

    const pt = getPointerImgCoords(e.clientX, e.clientY);

    // 1. Check resize handles on currently selected region first
    if (selectedRegion) {
      const handle = hitTestResizeHandle(pt.x, pt.y, selectedRegion, resolvedViewport.scale);
      if (handle) {
        updateImageRedactSession((prev) => ({
          ...prev,
          undoStack: [...prev.undoStack.slice(-39), cloneRegions(prev.regions)],
          redoStack: [],
        }));
        setDragState({
          kind: "resize",
          id: selectedRegion.id,
          handle,
          startImgX: pt.x,
          startImgY: pt.y,
          origRect: {
            x: selectedRegion.x,
            y: selectedRegion.y,
            width: selectedRegion.width,
            height: selectedRegion.height,
          },
        });
        return;
      }
    }

    // 2. Hit test existing regions (always in Select mode; also when clicking inside selected region)
    const hit = [...st.regions]
      .reverse()
      .find((r) => pt.x >= r.x && pt.x <= r.x + r.width && pt.y >= r.y && pt.y <= r.y + r.height);

    if (st.activeTool === "select" || (hit && hit.id === st.selectedId)) {
      if (hit) {
        updateImageRedactSession((prev) => ({
          ...prev,
          selectedId: hit.id,
          undoStack: [...prev.undoStack.slice(-39), cloneRegions(prev.regions)],
          redoStack: [],
        }));
        setDragState({
          kind: "move",
          id: hit.id,
          startImgX: pt.x,
          startImgY: pt.y,
          origRect: { x: hit.x, y: hit.y, width: hit.width, height: hit.height },
        });
      } else {
        updateImageRedactSession({ selectedId: null });
      }
      return;
    }

    // 3. Draw new redaction rectangle
    const cx = Math.max(0, Math.min(st.width, pt.x));
    const cy = Math.max(0, Math.min(st.height, pt.y));
    setDragState({
      kind: "draw",
      startImgX: cx,
      startImgY: cy,
      curRect: { x: Math.round(cx), y: Math.round(cy), width: 0, height: 0 },
    });
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!st.width || !st.height) return;

    if (!dragState) {
      if (spaceDown) {
        setCursorStyle("grab");
        return;
      }
      const pt = getPointerImgCoords(e.clientX, e.clientY);
      if (selectedRegion) {
        const h = hitTestResizeHandle(pt.x, pt.y, selectedRegion, resolvedViewport.scale);
        if (h) {
          setCursorStyle(handleCursorFor(h));
          return;
        }
      }
      setCursorStyle(st.activeTool === "select" ? "default" : "crosshair");
      return;
    }

    if (dragState.kind === "pan") {
      const dx = e.clientX - dragState.startClientX;
      const dy = e.clientY - dragState.startClientY;
      updateImageRedactSession({
        viewport: {
          mode: "manual",
          scale: resolvedViewport.scale,
          panX: dragState.origPanX + dx,
          panY: dragState.origPanY + dy,
        },
      });
      return;
    }

    const pt = getPointerImgCoords(e.clientX, e.clientY);

    if (dragState.kind === "draw") {
      const nextRect = normalizeRectFromDrag(
        dragState.startImgX,
        dragState.startImgY,
        pt.x,
        pt.y,
        st.width,
        st.height,
      );
      setDragState({ ...dragState, curRect: nextRect });
      return;
    }

    if (dragState.kind === "move") {
      const dx = Math.round(pt.x - dragState.startImgX);
      const dy = Math.round(pt.y - dragState.startImgY);
      const moved = clampRectToImage(
        {
          x: dragState.origRect.x + dx,
          y: dragState.origRect.y + dy,
          width: dragState.origRect.width,
          height: dragState.origRect.height,
        },
        st.width,
        st.height,
      );
      updateImageRedactSession((prev) => ({
        ...prev,
        regions: prev.regions.map((r) => (r.id === dragState.id ? { ...r, ...moved } : r)),
        lastSavedMessage: null,
      }));
      return;
    }

    if (dragState.kind === "resize") {
      const dx = pt.x - dragState.startImgX;
      const dy = pt.y - dragState.startImgY;
      const resized = applyHandleResize(
        dragState.origRect,
        dragState.handle,
        dx,
        dy,
        st.width,
        st.height,
        8,
      );
      updateImageRedactSession((prev) => ({
        ...prev,
        regions: prev.regions.map((r) => (r.id === dragState.id ? { ...r, ...resized } : r)),
        lastSavedMessage: null,
      }));
    }
  };

  const handlePointerUp = () => {
    if (!dragState) return;
    if (dragState.kind === "draw") {
      if (dragState.curRect.width >= 4 && dragState.curRect.height >= 4) {
        const kind: RedactionKind = st.activeTool === "select" ? "solid" : st.activeTool;
        const newId = `redact-${Date.now()}-${seqRef.current++}`;
        const created: RedactRegionItem = {
          id: newId,
          kind,
          ...dragState.curRect,
          strength: st.defaultStrength,
          colorHex: st.defaultColorHex,
        };
        commitRegionsWithHistory([...st.regions, created], newId);
      }
    }
    setDragState(null);
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!st.width || !st.height || !e.ctrlKey) return;
    e.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const next = zoomViewportAroundStagePoint(
      stageSize.w,
      stageSize.h,
      st.width,
      st.height,
      st.viewport,
      resolvedViewport.scale * factor,
      e.clientX - rect.left,
      e.clientY - rect.top,
    );
    updateImageRedactSession({ viewport: next });
  };

  const toBackendRegions = () =>
    st.regions.map((r) => ({
      kind: r.kind,
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
      strength: r.strength,
      colorHex: r.kind === "solid" ? r.colorHex : null,
    }));

  const handleCopyResult = async () => {
    if (!st.assetId) return;
    setErrorText(null);
    setBusy(true);
    try {
      const baked = await applyImageRedactionsToAsset({
        assetId: st.assetId,
        regions: toBackendRegions(),
        label: st.sourceFileName ?? "redacted.png",
      });
      await copyImageAssetToClipboard({ assetId: baked.assetId });
      updateImageRedactSession({ lastSavedMessage: c.copiedOk });
    } catch (err) {
      setErrorText(formatLocalizedError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const handleHandoff = async (target: ImageHandoffTarget) => {
    if (!st.assetId) return;
    setErrorText(null);
    setBusy(true);
    try {
      const baked = await applyImageRedactionsToAsset({
        assetId: st.assetId,
        regions: toBackendRegions(),
        label: st.sourceFileName ?? "redacted.png",
      });
      handoffImageToTool(target, baked);
    } catch (err) {
      setErrorText(formatLocalizedError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const runSaveExport = async (outputPath: string, format: SaveAssetFormat, overwrite: boolean) => {
    if (!st.assetId) return;
    setErrorText(null);
    setBusy(true);
    try {
      const res = await exportRedactedImageFile({
        assetId: st.assetId,
        sourcePath: st.sourcePath,
        regions: toBackendRegions(),
        outputPath,
        format,
        jpegQuality: 92,
        stripMetadata: st.stripMetadata,
        overwrite,
      });
      updateImageRedactSession({
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

  const handleSaveClick = async (format: SaveAssetFormat) => {
    if (!st.assetId) return;
    const ext = format === "png" ? "png" : "jpg";
    const defaultName =
      (st.sourcePath ? await suggestSafeSiblingPath(st.sourcePath, "redacted", ext) : null) ??
      `winkit_redacted.${ext}`;
    const target = await pickSaveFilePath({
      title: format === "png" ? c.savePng : c.saveJpeg,
      defaultPath: defaultName,
      filters: [{ name: format.toUpperCase(), extensions: [ext] }],
    });
    if (!target) return;
    await runSaveExport(target, format, false);
  };

  const activeKind: RedactionKind | null =
    selectedRegion?.kind ?? (st.activeTool === "select" ? null : st.activeTool);
  const activeColor = selectedRegion?.colorHex ?? st.defaultColorHex;
  const activeStrength = selectedRegion?.strength ?? st.defaultStrength;

  const updateSelectedOrDefault = (
    patch: Partial<Pick<RedactRegionItem, "kind" | "colorHex" | "strength">>,
  ) => {
    if (selectedRegion) {
      commitRegionsWithHistory(
        st.regions.map((r) => (r.id === selectedRegion.id ? { ...r, ...patch } : r)),
        selectedRegion.id,
      );
    } else {
      updateImageRedactSession({
        ...(patch.colorHex ? { defaultColorHex: patch.colorHex } : {}),
        ...(patch.strength !== undefined ? { defaultStrength: patch.strength } : {}),
      });
    }
  };

  const hasImage = Boolean(st.assetId && st.dataUrl && st.width && st.height);

  return (
    <div className="img-editor-shell">
      {/* Top Action Bar */}
      <div className="img-editor-topbar">
        <div className="img-editor-group">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void handlePickFile()}
          >
            <ImagePlus size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{c.openFile}</span>
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

          <span className="img-editor-divider" aria-hidden="true" />

          <button
            type="button"
            className="btn"
            disabled={st.undoStack.length === 0}
            title={`${c.undo} (Ctrl+Z)`}
            onClick={handleUndo}
          >
            <Undo2 size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{c.undo}</span>
          </button>
          <button
            type="button"
            className="btn"
            disabled={st.redoStack.length === 0}
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
            onClick={() => updateImageRedactSession({ viewport: { ...DEFAULT_VIEWPORT } })}
          >
            <Maximize2 size={13} strokeWidth={1.75} aria-hidden="true" />
            <span>{c.fit}</span>
          </button>
          <button
            type="button"
            className="btn"
            disabled={!hasImage}
            onClick={() =>
              updateImageRedactSession({
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
              updateImageRedactSession({
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
              updateImageRedactSession({
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
        </div>

        <div className="img-editor-group">
          <button
            type="button"
            className="btn"
            disabled={!hasImage || busy}
            onClick={() => void handleCopyResult()}
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
            onClick={() => void handleSaveClick("png")}
          >
            <Download size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{c.savePng}</span>
          </button>
          <button
            type="button"
            className="btn"
            disabled={!hasImage || busy}
            onClick={() => void handleSaveClick("jpeg")}
          >
            <span>{c.saveJpeg}</span>
          </button>
        </div>
      </div>

      {/* Contextual Settings Strip */}
      <div className="img-editor-context-bar">
        {selectedRegion && (
          <div className="img-editor-group">
            <div className="segmented" role="group">
              {(
                [
                  ["solid", c.toolSolid],
                  ["pixelate", c.toolPixelate],
                  ["blur", c.toolBlur],
                ] as Array<[RedactionKind, string]>
              ).map(([kind, label]) => (
                <button
                  key={kind}
                  type="button"
                  className={`segmented-btn ${selectedRegion.kind === kind ? "is-selected" : ""}`}
                  onClick={() => updateSelectedOrDefault({ kind })}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="mono" style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
              {selectedRegion.x},{selectedRegion.y} · {selectedRegion.width}×{selectedRegion.height}{" "}
              px
            </span>
          </div>
        )}

        {activeKind === "solid" && (
          <div className="img-editor-group">
            <span>{c.colorLabel}</span>
            <div className="img-editor-swatch-row">
              {SOLID_SWATCHES.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  className={`img-editor-swatch ${activeColor.toUpperCase() === hex ? "is-active" : ""}`}
                  style={{ background: hex }}
                  aria-label={hex}
                  onClick={() => updateSelectedOrDefault({ colorHex: hex })}
                />
              ))}
            </div>
          </div>
        )}

        {(activeKind === "blur" || activeKind === "pixelate") && (
          <label className="img-editor-group">
            <span>
              {c.strengthLabel}: <strong>{activeStrength}px</strong>
            </span>
            <input
              type="range"
              min={activeKind === "pixelate" ? 4 : 2}
              max={activeKind === "pixelate" ? 64 : 60}
              value={activeStrength}
              onChange={(e) => updateSelectedOrDefault({ strength: Number(e.target.value) })}
            />
          </label>
        )}

        {selectedRegion && (
          <button type="button" className="btn" onClick={handleDeleteSelected}>
            <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
            <span>{c.deleteRegion}</span>
          </button>
        )}

        {st.regions.length > 0 && (
          <button type="button" className="btn" onClick={() => commitRegionsWithHistory([], null)}>
            <span>{c.clearRegions}</span>
          </button>
        )}

        <label
          className="img-editor-group"
          style={{ marginLeft: "auto", cursor: "pointer", userSelect: "none" }}
        >
          <input
            type="checkbox"
            checked={st.stripMetadata}
            onChange={(e) => updateImageRedactSession({ stripMetadata: e.target.checked })}
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
      {st.lastSavedMessage && !errorText && (
        <div className="status-banner is-ok" role="status" aria-live="polite">
          <span>{st.lastSavedMessage}</span>
        </div>
      )}

      {/* Main Body: Compact Left Tool Rail + Dominant Interactive Canvas */}
      <div className="img-editor-body">
        <div className="img-editor-toolrail" role="toolbar" aria-label="Redaction tools">
          {(
            [
              ["select", c.toolSelect, MousePointer2],
              ["solid", c.toolSolid, Square],
              ["pixelate", c.toolPixelate, Grid2x2],
              ["blur", c.toolBlur, Droplets],
            ] as const
          ).map(([toolId, label, Icon]) => (
            <button
              key={toolId}
              type="button"
              className={`img-editor-tool-btn ${st.activeTool === toolId ? "is-active" : ""}`}
              aria-pressed={st.activeTool === toolId}
              onClick={() => updateImageRedactSession({ activeTool: toolId })}
            >
              <Icon size={15} strokeWidth={1.8} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </div>

        <div ref={stageRef} className={`img-editor-stage-wrap ${dropHover ? "is-drop-hover" : ""}`}>
          {hasImage ? (
            <canvas
              ref={canvasRef}
              data-testid="redact-canvas"
              className="img-editor-canvas"
              style={{ cursor: cursorStyle }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              onWheel={handleWheel}
            />
          ) : (
            <div className="img-editor-empty">
              <strong style={{ color: "var(--text-primary)", fontSize: 14 }}>{c.emptyTitle}</strong>
              <p
                style={{ margin: 0, maxWidth: 460, fontSize: 12.5, color: "var(--text-secondary)" }}
              >
                {c.emptyDesc}
              </p>
              <div className="img-editor-group" style={{ marginTop: 4 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void handlePickFile()}
                >
                  <ImagePlus size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{c.openFile}</span>
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

      {/* Footer Status */}
      <div className="img-editor-footer">
        <div className="img-editor-group">
          {hasImage && !st.sourcePath && <span className="badge badge-ok">{c.memoryBadge}</span>}
          {st.sourceFileName && <span>{st.sourceFileName}</span>}
          {st.width && st.height && (
            <span className="mono">
              {st.width}×{st.height} px
            </span>
          )}
          <span>· {c.regionCount(st.regions.length)}</span>
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
          if (pending) await runSaveExport(pending.path, pending.format, true);
        }}
      />
    </div>
  );
}
