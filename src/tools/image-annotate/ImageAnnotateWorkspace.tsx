import {
  ArrowUpRight,
  Circle,
  ClipboardPaste,
  Copy,
  Crop,
  Download,
  Droplets,
  EyeOff,
  Frame,
  Hash,
  Highlighter,
  ImagePlus,
  Maximize2,
  Minus,
  MousePointer2,
  PenTool,
  Redo2,
  RotateCcw,
  Square,
  Stamp,
  Trash2,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore, type ImageHandoffTarget } from "../../lib/sessionStore";
import {
  bindDisposableListener,
  copyImageAssetToClipboard,
  formatLocalizedError,
  loadFileAsImageAsset,
  parseBackendError,
  pickSaveFilePath,
  pickSingleFile,
  readClipboardImageAsAsset,
  saveImageAssetFile,
  storePngAsset,
  subscribeFileDrop,
  suggestSafeSiblingPath,
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
  imageToScreen,
  normalizeRectFromDrag,
  resolveViewport,
  screenToImage,
  zoomViewportAroundStagePoint,
  type PixelRect,
  type ResizeHandle,
} from "../image-editor/canvasViewport";
import "../image-editor/editorCanvas.css";
import {
  ANNOTATE_COLORS,
  HIGHLIGHT_COLORS,
  drawAnnotationItem,
  getAnnotationBounds,
  hitTestAnnotation,
  isBoxResizable,
  renderAnnotatedImageToPngDataUrl,
  translateAnnotation,
  type AnnotateToolKind,
  type AnnotationItem,
  type TextAnnotation,
} from "./annotationRenderer";

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
    sendBeautify: "送往美化 (I03)",
    sendRedact: "送往打码 (I11)",
    sendWatermark: "送往水印 (I13)",
    tools: {
      select: "选择",
      arrow: "箭头",
      line: "直线",
      rect: "矩形",
      ellipse: "椭圆",
      text: "文字",
      highlight: "高亮",
      number: "编号",
      brush: "画笔",
      blur: "模糊",
      crop: "裁剪",
    } as Record<AnnotateToolKind, string>,
    colorLabel: "颜色",
    strokeLabel: "粗细",
    fontSizeLabel: "字号",
    textPillLabel: "底色衬底",
    textContentLabel: "说明文字",
    textPlaceholder: "输入中英文批注… (Enter 确认)",
    blurLabel: "模糊度",
    nextNumLabel: "下一编号",
    resetNum: "重置为 1",
    cropHint: "拖拽框选裁剪区域，导出/复制时将按精确像素裁剪",
    cropReset: "清除裁剪",
    deleteItem: "删除对象",
    clearAll: "清空批注",
    emptyTitle: "打开图片、粘贴剪贴板，或从 I01 / I11 直接送入",
    emptyDesc:
      "支持箭头、直线、矩形、椭圆、中文文字、高亮、连续编号、画笔、局部模糊与裁剪。所有标注锁定原图像素，复制或导出保持原始分辨率。",
    copiedOk: "已将原分辨率批注图片复制到 Windows 剪贴板",
    savedOk: (p: string, w: number, h: number) => `已导出 (${w}×${h} px)：${p}`,
    itemCount: (n: number) => `${n} 项批注`,
    cropBadge: (w: number, h: number) => `裁剪输出 ${w}×${h} px`,
    panHint: "空格/中键平移 · Ctrl+滚轮缩放 · 双击文字编辑 · Del 删除",
    overwriteTitle: "覆盖已有文件？",
    overwriteBody: (p: string) => `目标路径已存在文件：${p}\n确认覆盖吗？`,
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
    sendBeautify: "Beautify (I03)",
    sendRedact: "Redact (I11)",
    sendWatermark: "Watermark (I13)",
    tools: {
      select: "Select",
      arrow: "Arrow",
      line: "Line",
      rect: "Rect",
      ellipse: "Ellipse",
      text: "Text",
      highlight: "Highlight",
      number: "Number",
      brush: "Brush",
      blur: "Blur",
      crop: "Crop",
    } as Record<AnnotateToolKind, string>,
    colorLabel: "Color",
    strokeLabel: "Width",
    fontSizeLabel: "Size",
    textPillLabel: "Pill bg",
    textContentLabel: "Text",
    textPlaceholder: "Enter callout text… (Enter to apply)",
    blurLabel: "Blur",
    nextNumLabel: "Next #",
    resetNum: "Reset to 1",
    cropHint: "Drag crop area — export & copy output exact cropped pixels",
    cropReset: "Clear crop",
    deleteItem: "Delete",
    clearAll: "Clear all",
    emptyTitle: "Open an image, paste clipboard, or send from I01 / I11",
    emptyDesc:
      "Add arrows, lines, shapes, Chinese/English text, highlights, numbered callouts, brush strokes, local blur, and crop at full original resolution.",
    copiedOk: "Copied full-resolution annotated image to Windows clipboard",
    savedOk: (p: string, w: number, h: number) => `Exported (${w}×${h} px): ${p}`,
    itemCount: (n: number) => `${n} item(s)`,
    cropBadge: (w: number, h: number) => `Crop ${w}×${h} px`,
    panHint: "Space/Middle-drag pan · Ctrl+Wheel zoom · Double-click text · Del delete",
    overwriteTitle: "Overwrite existing file?",
    overwriteBody: (p: string) => `Target file already exists: ${p}\nOverwrite it?`,
    overwriteConfirm: "Overwrite",
    cancel: "Cancel",
    memoryBadge: "In-Memory",
  },
} as const;

type DragAction =
  | { kind: "pan"; startClientX: number; startClientY: number; origPanX: number; origPanY: number }
  | { kind: "draw-item"; draft: AnnotationItem; startImgX: number; startImgY: number }
  | {
      kind: "move-item";
      id: string;
      origItem: AnnotationItem;
      startImgX: number;
      startImgY: number;
    }
  | {
      kind: "resize-item";
      id: string;
      handle: ResizeHandle;
      origRect: PixelRect;
      startImgX: number;
      startImgY: number;
    }
  | { kind: "draw-crop"; startImgX: number; startImgY: number; curRect: PixelRect }
  | { kind: "move-crop"; origRect: PixelRect; startImgX: number; startImgY: number }
  | {
      kind: "resize-crop";
      handle: ResizeHandle;
      origRect: PixelRect;
      startImgX: number;
      startImgY: number;
    };

function cloneItems(items: AnnotationItem[]): AnnotationItem[] {
  return items.map((item) =>
    item.type === "brush" ? { ...item, points: item.points.map((p) => ({ ...p })) } : { ...item },
  );
}

export function ImageAnnotateWorkspace() {
  const { locale, t } = useI18n();
  const c = copy[locale];
  const { session, updateImageAnnotateSession, handoffImageToTool } = useSessionStore();
  const st = session.imageAnnotate;

  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const seqRef = useRef(1);

  const [imgVersion, setImgVersion] = useState(0);
  const [stageSize, setStageSize] = useState({ w: 760, h: 480 });
  const [spaceDown, setSpaceDown] = useState(false);
  const [dragState, setDragState] = useState<DragAction | null>(null);
  const [cursorStyle, setCursorStyle] = useState("crosshair");
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [dropHover, setDropHover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [pendingOverwrite, setPendingOverwrite] = useState<{
    path: string;
    format: SaveAssetFormat;
  } | null>(null);

  const hasBeautify = Boolean(findRegisteredTool("I03"));
  const hasRedact = Boolean(findRegisteredTool("I11"));
  const hasWatermark = Boolean(findRegisteredTool("I13"));

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

  const selectedItem = useMemo(
    () => st.items.find((item) => item.id === st.selectedId) ?? null,
    [st.items, st.selectedId],
  );

  const editingTextItem = useMemo(() => {
    if (!editingTextId) return null;
    const found = st.items.find((it) => it.id === editingTextId);
    return found && found.type === "text" ? found : null;
  }, [editingTextId, st.items]);

  const pushSnapshot = useCallback(
    (
      nextItems: AnnotationItem[],
      nextCropRect: PixelRect | null,
      extra?: Partial<{ selectedId: string | null; nextNumber: number }>,
    ) => {
      updateImageAnnotateSession((prev) => ({
        ...prev,
        undoStack: [
          ...prev.undoStack.slice(-39),
          { items: cloneItems(prev.items), cropRect: prev.cropRect ? { ...prev.cropRect } : null },
        ],
        redoStack: [],
        items: nextItems,
        cropRect: nextCropRect,
        selectedId: extra?.selectedId !== undefined ? extra.selectedId : prev.selectedId,
        nextNumber: extra?.nextNumber !== undefined ? extra.nextNumber : prev.nextNumber,
        lastSavedMessage: null,
      }));
    },
    [updateImageAnnotateSession],
  );

  const handleUndo = useCallback(() => {
    setEditingTextId(null);
    updateImageAnnotateSession((prev) => {
      if (prev.undoStack.length === 0) return prev;
      const snap = prev.undoStack[prev.undoStack.length - 1]!;
      return {
        ...prev,
        undoStack: prev.undoStack.slice(0, -1),
        redoStack: [
          ...prev.redoStack.slice(-39),
          { items: cloneItems(prev.items), cropRect: prev.cropRect ? { ...prev.cropRect } : null },
        ],
        items: snap.items,
        cropRect: snap.cropRect,
        selectedId: null,
        lastSavedMessage: null,
      };
    });
  }, [updateImageAnnotateSession]);

  const handleRedo = useCallback(() => {
    setEditingTextId(null);
    updateImageAnnotateSession((prev) => {
      if (prev.redoStack.length === 0) return prev;
      const snap = prev.redoStack[prev.redoStack.length - 1]!;
      return {
        ...prev,
        redoStack: prev.redoStack.slice(0, -1),
        undoStack: [
          ...prev.undoStack.slice(-39),
          { items: cloneItems(prev.items), cropRect: prev.cropRect ? { ...prev.cropRect } : null },
        ],
        items: snap.items,
        cropRect: snap.cropRect,
        selectedId: null,
        lastSavedMessage: null,
      };
    });
  }, [updateImageAnnotateSession]);

  const handleDeleteSelected = useCallback(() => {
    if (!st.selectedId) return;
    setEditingTextId(null);
    pushSnapshot(
      st.items.filter((i) => i.id !== st.selectedId),
      st.cropRect,
      { selectedId: null },
    );
  }, [pushSnapshot, st.cropRect, st.items, st.selectedId]);

  const loadFromPath = useCallback(
    async (filePath: string) => {
      setErrorText(null);
      setEditingTextId(null);
      setBusy(true);
      try {
        const asset = await loadFileAsImageAsset(filePath);
        updateImageAnnotateSession({
          assetId: asset.assetId,
          sourcePath: filePath,
          sourceFileName: asset.label,
          dataUrl: asset.dataUrl,
          width: asset.width,
          height: asset.height,
          hasAlpha: asset.hasAlpha,
          items: [],
          cropRect: null,
          undoStack: [],
          redoStack: [],
          selectedId: null,
          nextNumber: 1,
          viewport: { ...DEFAULT_VIEWPORT },
          lastSavedMessage: null,
        });
      } catch (err) {
        setErrorText(formatLocalizedError(err, t));
      } finally {
        setBusy(false);
      }
    },
    [t, updateImageAnnotateSession],
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
    setEditingTextId(null);
    setBusy(true);
    try {
      const asset = await readClipboardImageAsAsset();
      updateImageAnnotateSession({
        assetId: asset.assetId,
        sourcePath: null,
        sourceFileName: asset.label,
        dataUrl: asset.dataUrl,
        width: asset.width,
        height: asset.height,
        hasAlpha: asset.hasAlpha,
        items: [],
        cropRect: null,
        undoStack: [],
        redoStack: [],
        selectedId: null,
        nextNumber: 1,
        viewport: { ...DEFAULT_VIEWPORT },
        lastSavedMessage: null,
      });
    } catch (err) {
      setErrorText(formatLocalizedError(err, t));
    } finally {
      setBusy(false);
    }
  }, [t, updateImageAnnotateSession]);

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
      "i12-annotate-file-drop",
    );
  }, [loadFromPath]);

  // Keyboard shortcuts
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
      } else if (e.key === "Escape") {
        setEditingTextId(null);
        updateImageAnnotateSession({ selectedId: null });
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
  }, [
    handleDeleteSelected,
    handlePasteClipboard,
    handleRedo,
    handleUndo,
    st.selectedId,
    updateImageAnnotateSession,
  ]);

  // Live canvas renderer
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

    // Image + annotations inside original pixel transform
    ctx.save();
    ctx.translate(resolvedViewport.offsetX, resolvedViewport.offsetY);
    ctx.scale(resolvedViewport.scale, resolvedViewport.scale);
    ctx.imageSmoothingEnabled = resolvedViewport.scale < 2;
    ctx.drawImage(img, 0, 0, st.width, st.height);

    // Draw blurs first so callouts on top stay razor sharp
    for (const item of st.items) {
      if (item.type === "blur") {
        drawAnnotationItem(ctx, item, img, st.width, st.height);
      }
    }
    if (dragState?.kind === "draw-item" && dragState.draft.type === "blur") {
      drawAnnotationItem(ctx, dragState.draft, img, st.width, st.height);
    }
    for (const item of st.items) {
      if (item.type !== "blur") {
        drawAnnotationItem(ctx, item, img, st.width, st.height);
      }
    }
    if (dragState?.kind === "draw-item" && dragState.draft.type !== "blur") {
      drawAnnotationItem(ctx, dragState.draft, img, st.width, st.height);
    }

    // Active crop dim overlay
    const activeCrop = dragState?.kind === "draw-crop" ? dragState.curRect : st.cropRect;
    if (activeCrop && activeCrop.width > 0 && activeCrop.height > 0) {
      ctx.save();
      ctx.fillStyle = "rgba(15, 23, 42, 0.48)";
      ctx.fillRect(0, 0, st.width, activeCrop.y);
      ctx.fillRect(
        0,
        activeCrop.y + activeCrop.height,
        st.width,
        st.height - (activeCrop.y + activeCrop.height),
      );
      ctx.fillRect(0, activeCrop.y, activeCrop.x, activeCrop.height);
      ctx.fillRect(
        activeCrop.x + activeCrop.width,
        activeCrop.y,
        st.width - (activeCrop.x + activeCrop.width),
        activeCrop.height,
      );
      ctx.restore();
    }
    ctx.restore();

    // Crisp border around image bounds
    ctx.strokeStyle = "rgba(15, 23, 42, 0.22)";
    ctx.lineWidth = 1;
    ctx.strokeRect(
      resolvedViewport.offsetX,
      resolvedViewport.offsetY,
      resolvedViewport.displayWidth,
      resolvedViewport.displayHeight,
    );

    // Crop selection handles
    const shownCrop = dragState?.kind === "draw-crop" ? dragState.curRect : st.cropRect;
    if (shownCrop && shownCrop.width > 1 && shownCrop.height > 1) {
      drawSelectionHandles(ctx, shownCrop, resolvedViewport, "#0EA5E9");
    }

    // Selected annotation outline & handles
    if (selectedItem && st.activeTool !== "crop") {
      const bounds = getAnnotationBounds(selectedItem, ctx);
      if (isBoxResizable(selectedItem)) {
        drawSelectionHandles(ctx, bounds, resolvedViewport, "#2563EB");
      } else {
        const tl = imageToScreen(bounds.x, bounds.y, resolvedViewport);
        ctx.save();
        ctx.strokeStyle = "#2563EB";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(
          tl.x - 4,
          tl.y - 4,
          bounds.width * resolvedViewport.scale + 8,
          bounds.height * resolvedViewport.scale + 8,
        );
        ctx.restore();
      }
    }

    ctx.restore();
  }, [
    dragState,
    imgVersion,
    resolvedViewport,
    selectedItem,
    st.activeTool,
    st.cropRect,
    st.height,
    st.items,
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

    setEditingTextId(null);
    const pt = getPointerImgCoords(e.clientX, e.clientY);
    const cx = Math.max(0, Math.min(st.width, pt.x));
    const cy = Math.max(0, Math.min(st.height, pt.y));

    // Crop tool interaction
    if (st.activeTool === "crop") {
      if (st.cropRect) {
        const h = hitTestResizeHandle(pt.x, pt.y, st.cropRect, resolvedViewport.scale);
        if (h) {
          updateImageAnnotateSession((prev) => ({
            ...prev,
            undoStack: [
              ...prev.undoStack.slice(-39),
              {
                items: cloneItems(prev.items),
                cropRect: prev.cropRect ? { ...prev.cropRect } : null,
              },
            ],
            redoStack: [],
          }));
          setDragState({
            kind: "resize-crop",
            handle: h,
            origRect: { ...st.cropRect },
            startImgX: pt.x,
            startImgY: pt.y,
          });
          return;
        }
        if (
          pt.x >= st.cropRect.x &&
          pt.x <= st.cropRect.x + st.cropRect.width &&
          pt.y >= st.cropRect.y &&
          pt.y <= st.cropRect.y + st.cropRect.height
        ) {
          updateImageAnnotateSession((prev) => ({
            ...prev,
            undoStack: [
              ...prev.undoStack.slice(-39),
              {
                items: cloneItems(prev.items),
                cropRect: prev.cropRect ? { ...prev.cropRect } : null,
              },
            ],
            redoStack: [],
          }));
          setDragState({
            kind: "move-crop",
            origRect: { ...st.cropRect },
            startImgX: pt.x,
            startImgY: pt.y,
          });
          return;
        }
      }
      setDragState({
        kind: "draw-crop",
        startImgX: cx,
        startImgY: cy,
        curRect: { x: Math.round(cx), y: Math.round(cy), width: 0, height: 0 },
      });
      return;
    }

    // Resize handle on selected box item
    if (selectedItem && isBoxResizable(selectedItem)) {
      const h = hitTestResizeHandle(pt.x, pt.y, selectedItem, resolvedViewport.scale);
      if (h) {
        updateImageAnnotateSession((prev) => ({
          ...prev,
          undoStack: [
            ...prev.undoStack.slice(-39),
            {
              items: cloneItems(prev.items),
              cropRect: prev.cropRect ? { ...prev.cropRect } : null,
            },
          ],
          redoStack: [],
        }));
        setDragState({
          kind: "resize-item",
          id: selectedItem.id,
          handle: h,
          origRect: {
            x: selectedItem.x,
            y: selectedItem.y,
            width: selectedItem.width,
            height: selectedItem.height,
          },
          startImgX: pt.x,
          startImgY: pt.y,
        });
        return;
      }
    }

    // Select mode (or clicking currently selected object to drag)
    const hit = hitTestAnnotation(st.items, pt.x, pt.y, resolvedViewport.scale);
    if (
      st.activeTool === "select" ||
      (hit && hit.id === st.selectedId && st.activeTool !== "number" && st.activeTool !== "text")
    ) {
      if (hit) {
        updateImageAnnotateSession((prev) => ({
          ...prev,
          selectedId: hit.id,
          undoStack: [
            ...prev.undoStack.slice(-39),
            {
              items: cloneItems(prev.items),
              cropRect: prev.cropRect ? { ...prev.cropRect } : null,
            },
          ],
          redoStack: [],
        }));
        setDragState({
          kind: "move-item",
          id: hit.id,
          origItem:
            hit.type === "brush"
              ? { ...hit, points: hit.points.map((p) => ({ ...p })) }
              : { ...hit },
          startImgX: pt.x,
          startImgY: pt.y,
        });
      } else {
        updateImageAnnotateSession({ selectedId: null });
      }
      return;
    }

    // Single-click placement tools: Number & Text
    const newId = `ann-${Date.now()}-${seqRef.current++}`;
    if (st.activeTool === "number") {
      const badgeRadius = Math.max(14, Math.round(st.fontSize * 0.78));
      const created: AnnotationItem = {
        id: newId,
        type: "number",
        x: Math.round(cx),
        y: Math.round(cy),
        value: st.nextNumber,
        color: st.color,
        radius: badgeRadius,
      };
      pushSnapshot([...st.items, created], st.cropRect, {
        selectedId: newId,
        nextNumber: st.nextNumber + 1,
      });
      return;
    }

    if (st.activeTool === "text") {
      const created: TextAnnotation = {
        id: newId,
        type: "text",
        x: Math.round(cx),
        y: Math.round(cy),
        text: locale === "zh-CN" ? "说明文字" : "Label",
        color: st.color,
        fontSize: st.fontSize,
        backgroundPill: st.textBackgroundPill,
      };
      pushSnapshot([...st.items, created], st.cropRect, { selectedId: newId });
      setEditingTextId(newId);
      return;
    }

    // Drag-to-draw tools
    let draft: AnnotationItem;
    switch (st.activeTool) {
      case "arrow":
        draft = {
          id: newId,
          type: "arrow",
          x1: Math.round(cx),
          y1: Math.round(cy),
          x2: Math.round(cx),
          y2: Math.round(cy),
          color: st.color,
          strokeWidth: st.strokeWidth,
        };
        break;
      case "line":
        draft = {
          id: newId,
          type: "line",
          x1: Math.round(cx),
          y1: Math.round(cy),
          x2: Math.round(cx),
          y2: Math.round(cy),
          color: st.color,
          strokeWidth: st.strokeWidth,
        };
        break;
      case "rect":
        draft = {
          id: newId,
          type: "rect",
          x: Math.round(cx),
          y: Math.round(cy),
          width: 0,
          height: 0,
          color: st.color,
          strokeWidth: st.strokeWidth,
        };
        break;
      case "ellipse":
        draft = {
          id: newId,
          type: "ellipse",
          x: Math.round(cx),
          y: Math.round(cy),
          width: 0,
          height: 0,
          color: st.color,
          strokeWidth: st.strokeWidth,
        };
        break;
      case "highlight":
        draft = {
          id: newId,
          type: "highlight",
          x: Math.round(cx),
          y: Math.round(cy),
          width: 0,
          height: 0,
          color: st.highlightColor,
          opacity: 0.42,
        };
        break;
      case "blur":
        draft = {
          id: newId,
          type: "blur",
          x: Math.round(cx),
          y: Math.round(cy),
          width: 0,
          height: 0,
          strength: st.blurStrength,
        };
        break;
      case "brush":
        draft = {
          id: newId,
          type: "brush",
          points: [{ x: Math.round(cx), y: Math.round(cy) }],
          color: st.color,
          strokeWidth: st.strokeWidth,
        };
        break;
    }

    setDragState({ kind: "draw-item", draft, startImgX: cx, startImgY: cy });
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!st.width || !st.height) return;

    if (!dragState) {
      if (spaceDown) {
        setCursorStyle("grab");
        return;
      }
      const pt = getPointerImgCoords(e.clientX, e.clientY);
      if (st.activeTool === "crop" && st.cropRect) {
        const h = hitTestResizeHandle(pt.x, pt.y, st.cropRect, resolvedViewport.scale);
        if (h) {
          setCursorStyle(handleCursorFor(h));
          return;
        }
      } else if (selectedItem && isBoxResizable(selectedItem)) {
        const h = hitTestResizeHandle(pt.x, pt.y, selectedItem, resolvedViewport.scale);
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
      updateImageAnnotateSession({
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

    if (dragState.kind === "draw-crop") {
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

    if (dragState.kind === "move-crop") {
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
      updateImageAnnotateSession({ cropRect: moved, lastSavedMessage: null });
      return;
    }

    if (dragState.kind === "resize-crop") {
      const resized = applyHandleResize(
        dragState.origRect,
        dragState.handle,
        pt.x - dragState.startImgX,
        pt.y - dragState.startImgY,
        st.width,
        st.height,
        16,
      );
      updateImageAnnotateSession({ cropRect: resized, lastSavedMessage: null });
      return;
    }

    if (dragState.kind === "move-item") {
      const moved = translateAnnotation(
        dragState.origItem,
        pt.x - dragState.startImgX,
        pt.y - dragState.startImgY,
      );
      updateImageAnnotateSession((prev) => ({
        ...prev,
        items: prev.items.map((it) => (it.id === dragState.id ? moved : it)),
        lastSavedMessage: null,
      }));
      return;
    }

    if (dragState.kind === "resize-item") {
      const resized = applyHandleResize(
        dragState.origRect,
        dragState.handle,
        pt.x - dragState.startImgX,
        pt.y - dragState.startImgY,
        st.width,
        st.height,
        8,
      );
      updateImageAnnotateSession((prev) => ({
        ...prev,
        items: prev.items.map((it) =>
          it.id === dragState.id && isBoxResizable(it) ? { ...it, ...resized } : it,
        ),
        lastSavedMessage: null,
      }));
      return;
    }

    if (dragState.kind === "draw-item") {
      const d = dragState.draft;
      const cx = Math.max(0, Math.min(st.width, pt.x));
      const cy = Math.max(0, Math.min(st.height, pt.y));
      let nextDraft: AnnotationItem = d;
      if (d.type === "arrow" || d.type === "line") {
        nextDraft = { ...d, x2: Math.round(cx), y2: Math.round(cy) };
      } else if (
        d.type === "rect" ||
        d.type === "ellipse" ||
        d.type === "highlight" ||
        d.type === "blur"
      ) {
        const box = normalizeRectFromDrag(
          dragState.startImgX,
          dragState.startImgY,
          cx,
          cy,
          st.width,
          st.height,
        );
        nextDraft = { ...d, ...box };
      } else if (d.type === "brush") {
        const last = d.points[d.points.length - 1];
        if (!last || Math.hypot(cx - last.x, cy - last.y) >= 2.5) {
          nextDraft = {
            ...d,
            points: [...d.points, { x: Math.round(cx), y: Math.round(cy) }],
          };
        }
      }
      setDragState({ ...dragState, draft: nextDraft });
    }
  };

  const handlePointerUp = () => {
    if (!dragState) return;
    if (dragState.kind === "draw-crop") {
      if (dragState.curRect.width >= 12 && dragState.curRect.height >= 12) {
        pushSnapshot(st.items, dragState.curRect);
      }
    } else if (dragState.kind === "draw-item") {
      const d = dragState.draft;
      const valid =
        d.type === "arrow" || d.type === "line"
          ? Math.hypot(d.x2 - d.x1, d.y2 - d.y1) >= 6
          : d.type === "brush"
            ? d.points.length >= 2
            : isBoxResizable(d)
              ? d.width >= 4 && d.height >= 4
              : true;
      if (valid) {
        pushSnapshot([...st.items, d], st.cropRect, { selectedId: d.id });
      }
    }
    setDragState(null);
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!st.width || !st.height) return;
    const pt = getPointerImgCoords(e.clientX, e.clientY);
    const hit = hitTestAnnotation(st.items, pt.x, pt.y, resolvedViewport.scale);
    if (hit && hit.type === "text") {
      updateImageAnnotateSession({ selectedId: hit.id });
      setEditingTextId(hit.id);
    }
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
    updateImageAnnotateSession({ viewport: next });
  };

  const bakeAnnotatedAsset = async () => {
    if (!st.width || !st.height) throw new Error("No image loaded.");
    let img = imgRef.current;
    if (!img && st.dataUrl) {
      img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("Image decode failed."));
        el.src = st.dataUrl!;
      });
    }
    if (!img) throw new Error("Image element unavailable.");

    const rendered = renderAnnotatedImageToPngDataUrl(
      img,
      st.width,
      st.height,
      st.items,
      st.cropRect,
    );
    return storePngAsset(rendered.dataUrl, st.sourceFileName ?? "annotated.png");
  };

  const handleCopyResult = async () => {
    if (!st.dataUrl) return;
    setErrorText(null);
    setBusy(true);
    try {
      const asset = await bakeAnnotatedAsset();
      await copyImageAssetToClipboard({ assetId: asset.assetId });
      updateImageAnnotateSession({ lastSavedMessage: c.copiedOk });
    } catch (err) {
      setErrorText(formatLocalizedError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const handleHandoff = async (target: ImageHandoffTarget) => {
    if (!st.dataUrl) return;
    setErrorText(null);
    setBusy(true);
    try {
      const asset = await bakeAnnotatedAsset();
      handoffImageToTool(target, asset);
    } catch (err) {
      setErrorText(formatLocalizedError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const runSaveExport = async (outputPath: string, format: SaveAssetFormat, overwrite: boolean) => {
    if (!st.dataUrl) return;
    setErrorText(null);
    setBusy(true);
    try {
      const asset = await bakeAnnotatedAsset();
      const saved = await saveImageAssetFile({
        assetId: asset.assetId,
        outputPath,
        format,
        jpegQuality: 92,
        overwrite,
        toolId: "I12",
      });
      updateImageAnnotateSession({
        lastSavedMessage: c.savedOk(saved.outputPath, saved.width, saved.height),
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
    if (!st.dataUrl) return;
    const ext = format === "png" ? "png" : "jpg";
    const defaultName =
      (st.sourcePath ? await suggestSafeSiblingPath(st.sourcePath, "annotated", ext) : null) ??
      `winkit_annotated.${ext}`;
    const target = await pickSaveFilePath({
      title: format === "png" ? c.savePng : c.saveJpeg,
      defaultPath: defaultName,
      filters: [{ name: format.toUpperCase(), extensions: [ext] }],
    });
    if (!target) return;
    await runSaveExport(target, format, false);
  };

  const updateSelectedItem = (updater: (item: AnnotationItem) => AnnotationItem) => {
    if (!selectedItem) return;
    pushSnapshot(
      st.items.map((it) => (it.id === selectedItem.id ? updater(it) : it)),
      st.cropRect,
      { selectedId: selectedItem.id },
    );
  };

  const hasImage = Boolean(st.dataUrl && st.width && st.height);

  // Determine which contextual controls to render (active tool or selected object)
  const effectiveKind: AnnotateToolKind =
    selectedItem && st.activeTool === "select" ? selectedItem.type : st.activeTool;

  const showStrokeColor =
    effectiveKind === "arrow" ||
    effectiveKind === "line" ||
    effectiveKind === "rect" ||
    effectiveKind === "ellipse" ||
    effectiveKind === "text" ||
    effectiveKind === "number" ||
    effectiveKind === "brush";
  const showHighlightColor = effectiveKind === "highlight";
  const showStrokeWidth =
    effectiveKind === "arrow" ||
    effectiveKind === "line" ||
    effectiveKind === "rect" ||
    effectiveKind === "ellipse" ||
    effectiveKind === "brush";
  const showTextControls = effectiveKind === "text" || selectedItem?.type === "text";
  const showNumberControls = effectiveKind === "number" || selectedItem?.type === "number";
  const showBlurControls = effectiveKind === "blur" || selectedItem?.type === "blur";
  const showCropControls = st.activeTool === "crop" || st.cropRect !== null;

  const activeColorValue =
    selectedItem && "color" in selectedItem
      ? selectedItem.color
      : showHighlightColor
        ? st.highlightColor
        : st.color;

  const activeStrokeValue =
    selectedItem && "strokeWidth" in selectedItem ? selectedItem.strokeWidth : st.strokeWidth;

  const activeFontSizeValue = selectedItem?.type === "text" ? selectedItem.fontSize : st.fontSize;

  const activeBlurValue = selectedItem?.type === "blur" ? selectedItem.strength : st.blurStrength;

  // Screen coordinates for inline text editor overlay
  const inlineTextPos = editingTextItem
    ? imageToScreen(editingTextItem.x, editingTextItem.y, resolvedViewport)
    : null;

  const toolButtons: Array<{ id: AnnotateToolKind; Icon: typeof ArrowUpRight }> = [
    { id: "select", Icon: MousePointer2 },
    { id: "arrow", Icon: ArrowUpRight },
    { id: "line", Icon: Minus },
    { id: "rect", Icon: Square },
    { id: "ellipse", Icon: Circle },
    { id: "text", Icon: Type },
    { id: "highlight", Icon: Highlighter },
    { id: "number", Icon: Hash },
    { id: "brush", Icon: PenTool },
    { id: "blur", Icon: Droplets },
    { id: "crop", Icon: Crop },
  ];

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
            onClick={() => updateImageAnnotateSession({ viewport: { ...DEFAULT_VIEWPORT } })}
          >
            <Maximize2 size={13} strokeWidth={1.75} aria-hidden="true" />
            <span>{c.fit}</span>
          </button>
          <button
            type="button"
            className="btn"
            disabled={!hasImage}
            onClick={() =>
              updateImageAnnotateSession({
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
              updateImageAnnotateSession({
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
              updateImageAnnotateSession({
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
          {hasRedact && (
            <button
              type="button"
              className="btn"
              disabled={!hasImage || busy}
              onClick={() => void handleHandoff("I11")}
            >
              <EyeOff size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{c.sendRedact}</span>
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

      {/* Contextual Settings Strip — only shows controls for active tool or selected item */}
      <div className="img-editor-context-bar">
        {(showStrokeColor || showHighlightColor) && (
          <div className="img-editor-group">
            <span>{c.colorLabel}</span>
            <div className="img-editor-swatch-row">
              {(showHighlightColor ? HIGHLIGHT_COLORS : ANNOTATE_COLORS).map((hex) => (
                <button
                  key={hex}
                  type="button"
                  className={`img-editor-swatch ${activeColorValue.toUpperCase() === hex ? "is-active" : ""}`}
                  style={{ background: hex }}
                  aria-label={hex}
                  onClick={() => {
                    if (selectedItem && "color" in selectedItem) {
                      updateSelectedItem((it) => ("color" in it ? { ...it, color: hex } : it));
                    } else if (showHighlightColor) {
                      updateImageAnnotateSession({ highlightColor: hex });
                    } else {
                      updateImageAnnotateSession({ color: hex });
                    }
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {showStrokeWidth && (
          <label className="img-editor-group">
            <span>
              {c.strokeLabel}: <strong>{activeStrokeValue}px</strong>
            </span>
            <input
              type="range"
              min={2}
              max={16}
              value={activeStrokeValue}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (selectedItem && "strokeWidth" in selectedItem) {
                  updateSelectedItem((it) =>
                    "strokeWidth" in it ? { ...it, strokeWidth: v } : it,
                  );
                } else {
                  updateImageAnnotateSession({ strokeWidth: v });
                }
              }}
            />
          </label>
        )}

        {showTextControls && (
          <>
            <label className="img-editor-group">
              <span>
                {c.fontSizeLabel}: <strong>{activeFontSizeValue}px</strong>
              </span>
              <input
                type="range"
                min={14}
                max={64}
                value={activeFontSizeValue}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (selectedItem?.type === "text") {
                    updateSelectedItem((it) => (it.type === "text" ? { ...it, fontSize: v } : it));
                  } else {
                    updateImageAnnotateSession({ fontSize: v });
                  }
                }}
              />
            </label>
            <label className="img-editor-group" style={{ cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={
                  selectedItem?.type === "text"
                    ? selectedItem.backgroundPill
                    : st.textBackgroundPill
                }
                onChange={(e) => {
                  const checked = e.target.checked;
                  if (selectedItem?.type === "text") {
                    updateSelectedItem((it) =>
                      it.type === "text" ? { ...it, backgroundPill: checked } : it,
                    );
                  } else {
                    updateImageAnnotateSession({ textBackgroundPill: checked });
                  }
                }}
              />
              <span>{c.textPillLabel}</span>
            </label>
            {selectedItem?.type === "text" && (
              <label className="img-editor-group">
                <span>{c.textContentLabel}</span>
                <input
                  type="text"
                  className="img-editor-compact-input"
                  style={{ width: 180 }}
                  value={selectedItem.text}
                  onChange={(e) => {
                    const txt = e.target.value;
                    updateImageAnnotateSession((prev) => ({
                      ...prev,
                      items: prev.items.map((it) =>
                        it.id === selectedItem.id && it.type === "text" ? { ...it, text: txt } : it,
                      ),
                    }));
                  }}
                />
              </label>
            )}
          </>
        )}

        {showNumberControls && (
          <div className="img-editor-group">
            <span>
              {c.nextNumLabel}: <strong>{st.nextNumber}</strong>
            </span>
            <button
              type="button"
              className="btn"
              style={{ padding: "2px 8px", fontSize: 12 }}
              onClick={() => updateImageAnnotateSession({ nextNumber: 1 })}
            >
              <RotateCcw size={12} strokeWidth={1.75} aria-hidden="true" />
              <span>{c.resetNum}</span>
            </button>
          </div>
        )}

        {showBlurControls && (
          <label className="img-editor-group">
            <span>
              {c.blurLabel}: <strong>{activeBlurValue}px</strong>
            </span>
            <input
              type="range"
              min={4}
              max={48}
              value={activeBlurValue}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (selectedItem?.type === "blur") {
                  updateSelectedItem((it) => (it.type === "blur" ? { ...it, strength: v } : it));
                } else {
                  updateImageAnnotateSession({ blurStrength: v });
                }
              }}
            />
          </label>
        )}

        {showCropControls && (
          <div className="img-editor-group">
            {st.cropRect ? (
              <>
                <span className="badge badge-ok">
                  {c.cropBadge(st.cropRect.width, st.cropRect.height)}
                </span>
                <button
                  type="button"
                  className="btn"
                  style={{ padding: "2px 8px", fontSize: 12 }}
                  onClick={() => pushSnapshot(st.items, null)}
                >
                  {c.cropReset}
                </button>
              </>
            ) : (
              <span style={{ color: "var(--text-secondary)" }}>{c.cropHint}</span>
            )}
          </div>
        )}

        <div className="img-editor-group" style={{ marginLeft: "auto" }}>
          {selectedItem && (
            <button type="button" className="btn" onClick={handleDeleteSelected}>
              <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
              <span>{c.deleteItem}</span>
            </button>
          )}
          {st.items.length > 0 && (
            <button
              type="button"
              className="btn"
              onClick={() => pushSnapshot([], st.cropRect, { selectedId: null, nextNumber: 1 })}
            >
              <span>{c.clearAll}</span>
            </button>
          )}
        </div>
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

      {/* Main Body: Compact Left Tool Rail + Dominant Canvas */}
      <div className="img-editor-body">
        <div className="img-editor-toolrail" role="toolbar" aria-label="Annotation tools">
          {toolButtons.map(({ id, Icon }) => (
            <button
              key={id}
              type="button"
              className={`img-editor-tool-btn ${st.activeTool === id ? "is-active" : ""}`}
              aria-pressed={st.activeTool === id}
              onClick={() => {
                setEditingTextId(null);
                updateImageAnnotateSession({ activeTool: id });
              }}
            >
              <Icon size={15} strokeWidth={1.8} aria-hidden="true" />
              <span>{c.tools[id]}</span>
            </button>
          ))}
        </div>

        <div ref={stageRef} className={`img-editor-stage-wrap ${dropHover ? "is-drop-hover" : ""}`}>
          {hasImage ? (
            <>
              <canvas
                ref={canvasRef}
                data-testid="annotate-canvas"
                className="img-editor-canvas"
                style={{ cursor: cursorStyle }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                onDoubleClick={handleDoubleClick}
                onWheel={handleWheel}
              />
              {editingTextItem && inlineTextPos && (
                <input
                  type="text"
                  autoFocus
                  aria-label={c.textContentLabel}
                  className="img-editor-inline-text"
                  placeholder={c.textPlaceholder}
                  style={{
                    left: `${Math.max(8, Math.min(stageSize.w - 180, inlineTextPos.x))}px`,
                    top: `${Math.max(8, Math.min(stageSize.h - 44, inlineTextPos.y))}px`,
                    fontSize: `${Math.max(13, Math.min(28, Math.round(editingTextItem.fontSize * resolvedViewport.scale)))}px`,
                  }}
                  value={editingTextItem.text}
                  onChange={(e) => {
                    const val = e.target.value;
                    updateImageAnnotateSession((prev) => ({
                      ...prev,
                      items: prev.items.map((it) =>
                        it.id === editingTextItem.id && it.type === "text"
                          ? { ...it, text: val }
                          : it,
                      ),
                    }));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === "Escape") {
                      e.preventDefault();
                      setEditingTextId(null);
                    }
                  }}
                  onBlur={() => setEditingTextId(null)}
                />
              )}
            </>
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
          <span>· {c.itemCount(st.items.length)}</span>
          {st.cropRect && (
            <span className="badge badge-ok">
              {c.cropBadge(st.cropRect.width, st.cropRect.height)}
            </span>
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
          if (pending) await runSaveExport(pending.path, pending.format, true);
        }}
      />
    </div>
  );
}
