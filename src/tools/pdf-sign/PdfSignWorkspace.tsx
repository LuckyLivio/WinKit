import {
  AlertTriangle,
  BookmarkPlus,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Eraser,
  Eye,
  FolderOpen,
  ImagePlus,
  Info,
  PenTool,
  Plus,
  Redo2,
  Save,
  Trash2,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useI18n } from "../../i18n/I18nContext";
import {
  usePdfSession,
  type PdfSignPlacedBox,
  type SessionSignatureStamp,
} from "../../lib/pdfSessionStore";
import {
  bindDisposableListener,
  cancelBackendTask,
  deleteSignatureTemplate,
  formatLocalizedError,
  getImageAsset,
  inspectPdfDocument,
  listSignatureTemplates,
  loadFileAsImageAsset,
  openLocalDirectory,
  parseBackendError,
  pickSaveFilePath,
  pickSingleFile,
  renderPdfPage,
  saveSignatureTemplate,
  signPdf,
  subscribeFileDrop,
  subscribePdfTaskProgress,
  suggestSafeSiblingPath,
  type SignatureTemplateItem,
} from "../../lib/tauriBridge";
import "../../components/PdfReaderView.css";
import "./pdfSign.css";

type CreatorTab = "draw" | "type" | "upload";

const INK_SWATCHES = ["#111827", "#1D4ED8", "#DC2626", "#0F766E"];

const SIGNATURE_FONTS = [
  {
    id: "kaiti",
    zh: "手写楷体",
    en: "Calligraphy",
    css: '"KaiTi", "STKaiti", "Segoe Script", cursive',
  },
  {
    id: "script",
    zh: "连笔花体",
    en: "Script",
    css: '"Segoe Script", "Brush Script MT", "KaiTi", cursive',
  },
  {
    id: "serif",
    zh: "正式宋体",
    en: "Formal Serif",
    css: '"SimSun", "Georgia", "Times New Roman", serif',
  },
  {
    id: "sans",
    zh: "现代黑体",
    en: "Modern Sans",
    css: '"Microsoft YaHei UI", "Segoe UI", sans-serif',
  },
] as const;

const copy = {
  "zh-CN": {
    title: "PDF 可视签名",
    subtitle: "支持手绘、文字样式或透明 PNG 签名，在文档页面上直接拖动定位并保留原矢量文字。",
    openPdf: "选择 PDF…",
    emptyHint: "选择或拖入本地 PDF，在左侧预览页上直接放置、拖动、缩放并旋转可视签名。",
    nonCaNotice:
      "可视电子签名仅作为页面可见内容嵌入，不提供 CA 数字证书认证或密码学防篡改签名；输出写入新文件，不覆盖原件。",
    sigWarn: (n: number) =>
      `此 PDF 包含 ${n} 个数字签名字段：导出后的可视签名新副本会使原有数字签名失效，请妥善保留原文件。`,
    creatorTitle: "1. 创建或选用签名",
    tabDraw: "手绘",
    tabType: "文字",
    tabUpload: "上传 PNG",
    inkColor: "颜色",
    penWidth: "笔触",
    undoStroke: "撤销一笔",
    clearPad: "清空画板",
    addStampFromDraw: "添加到签名栏",
    typePlaceholder: "输入中文或英文姓名…",
    bold: "加粗",
    addStampFromType: "生成文字签名",
    pickPngBtn: "选择透明 PNG 签名…",
    removeWhiteBg: "尝试去除纯白底色（适合白纸扫描签名）",
    sessionStampsTitle: "当前会话签名（仅驻留内存）",
    sessionEmpty: "尚无签名。绘制、键入或上传后点击添加即可在当前文档多页复用。",
    placeOnPage: "放置到当前页",
    saveTemplateBtn: "存为本地模板",
    templateNamePrompt: "模板名称",
    templateDefaultName: "我的签名",
    saveTemplateConfirm: "确认保存模板",
    templatesTitle: "已保存本地模板（仅主动保存）",
    templatesEmpty: "尚未保存本地模板。默认不会将签名素材写入磁盘。",
    templatesStorageInfo: (dir: string) =>
      `仅在您主动点击“存为本地模板”时写入本机目录 ${dir}，供跨会话快速复用，随时可一键删除。`,
    useTemplate: "载入会话",
    deleteTemplate: "删除",
    selectedBoxTitle: "2. 选中签名框属性",
    noSelection: "点击文档上的签名框即可调整大小、旋转、透明度或删除。",
    scaleLabel: "宽度比例",
    rotationLabel: "旋转角度",
    opacityLabel: "不透明度",
    removeBox: "移除此签名",
    undo: "撤销",
    redo: "重做",
    placementCount: (n: number) => `已放置 ${n} 处签名`,
    outputLabel: "3. 导出已签名 PDF（新文件）",
    saveAs: "另存为…",
    exportBtn: "导出已签名 PDF",
    exporting: "正在写入签名…",
    cancel: "取消",
    openInReader: "在内置预览中打开",
    openOutDir: "打开所在目录",
    doneSummary: (pages: number[], bytes: number) =>
      `导出完成（共签署第 ${pages.join("、")} 页，${(bytes / 1024).toFixed(1)} KiB）`,
    overwriteTitle: "覆盖已有文件？",
    overwriteBody: (p: string) => `目标文件已存在：${p}\n确认覆盖吗？`,
    overwriteConfirm: "确认覆盖",
    drawEmptyErr: "请先在画板中手绘签名。",
    typeEmptyErr: "请先输入签名文字。",
    noStampErr: "请先创建或选中一个签名。",
    noPlacementErr: "请先在文档页面上至少放置一处签名。",
  },
  "en-US": {
    title: "Sign PDF (Visual)",
    subtitle:
      "Draw, type, or upload a transparent PNG signature, drag it directly onto PDF pages, and export without rasterizing original text.",
    openPdf: "Open PDF...",
    emptyHint:
      "Open or drop a local PDF to place, drag, resize, and rotate visual signatures directly on the page.",
    nonCaNotice:
      "Visual signatures are embedded as visible page content only and do NOT provide CA digital certificate authentication. Exports always write a new file.",
    sigWarn: (n: number) =>
      `This PDF contains ${n} digital signature field(s). Exporting a modified copy invalidates original cryptographic signatures.`,
    creatorTitle: "1. Create or Pick Signature",
    tabDraw: "Draw",
    tabType: "Type",
    tabUpload: "Upload PNG",
    inkColor: "Color",
    penWidth: "Stroke",
    undoStroke: "Undo stroke",
    clearPad: "Clear",
    addStampFromDraw: "Add to Session",
    typePlaceholder: "Type your name...",
    bold: "Bold",
    addStampFromType: "Create Text Signature",
    pickPngBtn: "Choose Transparent PNG...",
    removeWhiteBg: "Knock out pure white background (for scanned paper signatures)",
    sessionStampsTitle: "Session Signatures (Memory Only)",
    sessionEmpty: "No signatures yet. Draw, type, or upload one to place on one or multiple pages.",
    placeOnPage: "Place on Page",
    saveTemplateBtn: "Save Local Template",
    templateNamePrompt: "Template name",
    templateDefaultName: "My Signature",
    saveTemplateConfirm: "Confirm Save",
    templatesTitle: "Saved Local Templates (Opt-In)",
    templatesEmpty: "No saved templates. Signatures are never written to disk unless you opt in.",
    templatesStorageInfo: (dir: string) =>
      `Written only when you click Save Local Template to ${dir} for reuse across sessions. Delete anytime.`,
    useTemplate: "Load",
    deleteTemplate: "Delete",
    selectedBoxTitle: "2. Selected Placement",
    noSelection:
      "Click any placed signature box on the page to resize, rotate, adjust opacity, or remove.",
    scaleLabel: "Width",
    rotationLabel: "Rotation",
    opacityLabel: "Opacity",
    removeBox: "Remove",
    undo: "Undo",
    redo: "Redo",
    placementCount: (n: number) => `${n} placement(s)`,
    outputLabel: "3. Export Signed PDF (New Copy)",
    saveAs: "Save As...",
    exportBtn: "Export Signed PDF",
    exporting: "Exporting Signed PDF...",
    cancel: "Cancel",
    openInReader: "Open in Preview",
    openOutDir: "Open Folder",
    doneSummary: (pages: number[], bytes: number) =>
      `Exported signed PDF (pages ${pages.join(", ")}, ${(bytes / 1024).toFixed(1)} KiB)`,
    overwriteTitle: "Overwrite Existing File?",
    overwriteBody: (p: string) => `File already exists: ${p}\nOverwrite it?`,
    overwriteConfirm: "Overwrite",
    drawEmptyErr: "Draw a signature on the pad first.",
    typeEmptyErr: "Enter signature text first.",
    noStampErr: "Create or select a signature first.",
    noPlacementErr: "Place at least one signature on the PDF before exporting.",
  },
} as const;

interface DrawStroke {
  color: string;
  width: number;
  points: Array<{ x: number; y: number }>;
}

function getParentDir(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx > 0 ? path.slice(0, idx) : path;
}

function cropCanvasToTightPng(source: HTMLCanvasElement): {
  dataUrl: string;
  width: number;
  height: number;
} | null {
  const ctx = source.getContext("2d");
  if (!ctx) return null;
  const { width, height } = source;
  const img = ctx.getImageData(0, 0, width, height);
  const d = img.data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((d[(y * width + x) * 4 + 3] ?? 0) > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;
  const pad = 12;
  const cx = Math.max(0, minX - pad);
  const cy = Math.max(0, minY - pad);
  const cw = Math.min(width - cx, maxX - minX + 1 + pad * 2);
  const ch = Math.min(height - cy, maxY - minY + 1 + pad * 2);
  const out = document.createElement("canvas");
  out.width = Math.max(16, cw);
  out.height = Math.max(16, ch);
  const octx = out.getContext("2d");
  if (!octx) return null;
  octx.drawImage(source, cx, cy, cw, ch, 0, 0, cw, ch);
  return { dataUrl: out.toDataURL("image/png"), width: out.width, height: out.height };
}

function rasterizeTypedSignature(
  text: string,
  fontCss: string,
  color: string,
  bold: boolean,
): { dataUrl: string; width: number; height: number } | null {
  const clean = text.trim();
  if (!clean) return null;
  const fontSize = 112;
  const weight = bold ? "700" : "400";
  const font = `${weight} ${fontSize}px ${fontCss}`;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.font = font;
  const metrics = ctx.measureText(clean);
  const pad = 32;
  canvas.width = Math.min(2200, Math.max(120, Math.ceil(metrics.width + pad * 2)));
  canvas.height = Math.ceil(fontSize * 1.65 + pad * 2);
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillText(clean, canvas.width / 2, canvas.height / 2);
  return (
    cropCanvasToTightPng(canvas) ?? {
      dataUrl: canvas.toDataURL("image/png"),
      width: canvas.width,
      height: canvas.height,
    }
  );
}

async function processUploadedSignatureImage(
  dataUrl: string,
  knockoutWhite: boolean,
): Promise<{ dataUrl: string; width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const maxSide = 1400;
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
      const w = Math.max(16, Math.round((img.naturalWidth || 1) * scale));
      const h = Math.max(16, Math.round((img.naturalHeight || 1) * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      if (knockoutWhite) {
        const idata = ctx.getImageData(0, 0, w, h);
        const d = idata.data;
        for (let i = 0; i < d.length; i += 4) {
          const lum = 0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0);
          if (lum > 235) {
            d[i + 3] = 0;
          } else if (lum > 200) {
            d[i + 3] = Math.round(((235 - lum) / 35) * (d[i + 3] ?? 0));
          }
        }
        ctx.putImageData(idata, 0, 0);
      }
      resolve(
        cropCanvasToTightPng(canvas) ?? {
          dataUrl: canvas.toDataURL("image/png"),
          width: w,
          height: h,
        },
      );
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

export function PdfSignWorkspace() {
  const { locale, t } = useI18n();
  const c = copy[locale];
  const {
    pdfSession,
    updateSignSession,
    openInPdfReader,
    pendingToolIntake,
    clearPendingToolIntake,
  } = usePdfSession();
  const st = pdfSession.sign;

  const [creatorTab, setCreatorTab] = useState<CreatorTab>("draw");
  const [inkColor, setInkColor] = useState("#111827");
  const [penWidth, setPenWidth] = useState(4);
  const [strokes, setStrokes] = useState<DrawStroke[]>([]);
  const [typedText, setTypedText] = useState("");
  const [typedFontId, setTypedFontId] = useState<string>(SIGNATURE_FONTS[0].id);
  const [typedBold, setTypedBold] = useState(false);
  const [knockoutWhite, setKnockoutWhite] = useState(false);
  const [creatorError, setCreatorError] = useState<string | null>(null);

  // Opt-in saved templates state
  const [templatesDir, setTemplatesDir] = useState("");
  const [savedTemplates, setSavedTemplates] = useState<SignatureTemplateItem[]>([]);
  const [savingTemplateOpen, setSavingTemplateOpen] = useState(false);
  const [templateNameInput, setTemplateNameInput] = useState("");

  // Rendered current PDF page state
  const [pageDataUrl, setPageDataUrl] = useState<string | null>(null);
  const [renderLoading, setRenderLoading] = useState(false);
  const [overwritePending, setOverwritePending] = useState<string | null>(null);

  const drawCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingActiveRef = useRef(false);
  const pageFrameRef = useRef<HTMLDivElement | null>(null);

  const activeFont = useMemo(
    () => SIGNATURE_FONTS.find((f) => f.id === typedFontId) ?? SIGNATURE_FONTS[0],
    [typedFontId],
  );

  // Load opt-in saved templates list (read-only on mount)
  const refreshTemplates = useCallback(async () => {
    try {
      const res = await listSignatureTemplates();
      setTemplatesDir(res.storageDir);
      setSavedTemplates(res.items);
    } catch {
      // Ignore in test environments without backend templates dir
    }
  }, []);

  useEffect(() => {
    void refreshTemplates();
  }, [refreshTemplates]);

  // Redraw signature pad canvas when strokes change
  useEffect(() => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const s of strokes) {
      const first = s.points[0];
      if (!first) continue;
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.lineWidth = s.width * 2;
      if (s.points.length === 1) {
        ctx.beginPath();
        ctx.arc(first.x, first.y, s.width, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < s.points.length; i++) {
        const prev = s.points[i - 1]!;
        const curr = s.points[i]!;
        const mx = (prev.x + curr.x) / 2;
        const my = (prev.y + curr.y) / 2;
        ctx.quadraticCurveTo(prev.x, prev.y, mx, my);
      }
      const last = s.points[s.points.length - 1]!;
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
    }
  }, [strokes, creatorTab]);

  // Open a PDF document into P06
  const openPdfPath = useCallback(
    async (path: string) => {
      updateSignSession((prev) => ({
        ...prev,
        inspectLoading: true,
        errorMessage: null,
        lastResult: null,
      }));
      try {
        const info = await inspectPdfDocument(path);
        const suggested =
          (await suggestSafeSiblingPath(info.path, "_signed", ".pdf").catch(() => null)) ??
          `${info.path.replace(/\.pdf$/i, "")}_signed.pdf`;
        updateSignSession((prev) => ({
          ...prev,
          sourcePath: info.path,
          inspection: info,
          inspectLoading: false,
          currentPage: 1,
          placements: [],
          selectedPlacementId: null,
          undoStack: [],
          redoStack: [],
          outputPath: suggested,
          errorMessage: null,
        }));
      } catch (err) {
        updateSignSession((prev) => ({
          ...prev,
          inspectLoading: false,
          errorMessage: formatLocalizedError(err, t),
        }));
      }
    },
    [t, updateSignSession],
  );

  // Consume cross-tool intake from C08 or other PDF tools
  useEffect(() => {
    if (pendingToolIntake?.toolId === "P06") {
      const target = pendingToolIntake.path;
      clearPendingToolIntake();
      void openPdfPath(target);
    }
  }, [pendingToolIntake, clearPendingToolIntake, openPdfPath]);

  // Drag & drop PDF onto P06
  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onDropPaths: (paths) => {
            const pdf = paths.find((p) => p.toLowerCase().endsWith(".pdf"));
            if (pdf) void openPdfPath(pdf);
          },
        }),
      "p06-drop",
    );
  }, [openPdfPath]);

  // Subscribe to PDF task progress
  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribePdfTaskProgress((ev) => {
          if (ev.toolId !== "P06") return;
          updateSignSession((prev) =>
            prev.activeTaskId === ev.taskId ? { ...prev, progress: ev } : prev,
          );
        }),
      "p06-progress",
    );
  }, [updateSignSession]);

  // Render active page image via PDFium
  useEffect(() => {
    const info = st.inspection;
    if (!info) {
      setPageDataUrl(null);
      return;
    }
    let cancelled = false;
    setRenderLoading(true);
    const widthPx = Math.min(1800, Math.max(640, Math.round(920 * st.zoomScale)));
    void renderPdfPage({
      path: info.path,
      pageNumber: st.currentPage,
      targetWidthPx: widthPx,
    })
      .then((res) => {
        if (!cancelled) {
          setPageDataUrl(res.dataUrl);
          setRenderLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setRenderLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [st.inspection, st.currentPage, st.zoomScale]);

  const currentPageGeom = useMemo(() => {
    if (!st.inspection) return null;
    return st.inspection.pages[st.currentPage - 1] ?? null;
  }, [st.inspection, st.currentPage]);

  const pageDisplaySize = useMemo(() => {
    const baseW = 580 * st.zoomScale;
    if (!currentPageGeom || currentPageGeom.widthPt <= 0) {
      return { width: Math.round(baseW), height: Math.round(baseW * 1.414) };
    }
    const aspect = currentPageGeom.heightPt / currentPageGeom.widthPt;
    return { width: Math.round(baseW), height: Math.round(baseW * aspect) };
  }, [currentPageGeom, st.zoomScale]);

  // Placement history helper
  const commitPlacements = useCallback(
    (next: PdfSignPlacedBox[], nextSelectedId?: string | null) => {
      updateSignSession((prev) => ({
        ...prev,
        undoStack: [...prev.undoStack.slice(-29), prev.placements],
        redoStack: [],
        placements: next,
        selectedPlacementId:
          nextSelectedId !== undefined ? nextSelectedId : prev.selectedPlacementId,
      }));
    },
    [updateSignSession],
  );

  const handleUndo = useCallback(() => {
    updateSignSession((prev) => {
      const previous = prev.undoStack[prev.undoStack.length - 1];
      if (!previous) return prev;
      return {
        ...prev,
        undoStack: prev.undoStack.slice(0, -1),
        redoStack: [...prev.redoStack, prev.placements],
        placements: previous,
      };
    });
  }, [updateSignSession]);

  const handleRedo = useCallback(() => {
    updateSignSession((prev) => {
      const next = prev.redoStack[prev.redoStack.length - 1];
      if (!next) return prev;
      return {
        ...prev,
        redoStack: prev.redoStack.slice(0, -1),
        undoStack: [...prev.undoStack, prev.placements],
        placements: next,
      };
    });
  }, [updateSignSession]);

  // Drawing pointer handlers
  const getCanvasPoint = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / Math.max(rect.width, 1)) * canvas.width,
      y: ((e.clientY - rect.top) / Math.max(rect.height, 1)) * canvas.height,
    };
  };

  const onDrawPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingActiveRef.current = true;
    const pt = getCanvasPoint(e);
    setStrokes((prev) => [...prev, { color: inkColor, width: penWidth, points: [pt] }]);
    setCreatorError(null);
  };

  const onDrawPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawingActiveRef.current) return;
    const pt = getCanvasPoint(e);
    setStrokes((prev) => {
      const last = prev[prev.length - 1];
      if (!last) return prev;
      const copyArr = prev.slice();
      copyArr[copyArr.length - 1] = { ...last, points: [...last.points, pt] };
      return copyArr;
    });
  };

  const onDrawPointerUp = () => {
    drawingActiveRef.current = false;
  };

  const addStampToSession = useCallback(
    (label: string, pngDataUrl: string, widthPx: number, heightPx: number) => {
      const id = `stamp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const entry: SessionSignatureStamp = { id, label, pngDataUrl, widthPx, heightPx };
      updateSignSession((prev) => ({
        ...prev,
        sessionStamps: [entry, ...prev.sessionStamps],
        activeStampId: id,
      }));
      setCreatorError(null);
    },
    [updateSignSession],
  );

  const handleAddDrawnStamp = () => {
    const canvas = drawCanvasRef.current;
    if (!canvas || strokes.length === 0) {
      setCreatorError(c.drawEmptyErr);
      return;
    }
    const cropped = cropCanvasToTightPng(canvas);
    if (!cropped) {
      setCreatorError(c.drawEmptyErr);
      return;
    }
    addStampToSession(
      locale === "zh-CN"
        ? `手绘签名 #${st.sessionStamps.length + 1}`
        : `Drawn #${st.sessionStamps.length + 1}`,
      cropped.dataUrl,
      cropped.width,
      cropped.height,
    );
  };

  const handleAddTypedStamp = () => {
    if (!typedText.trim()) {
      setCreatorError(c.typeEmptyErr);
      return;
    }
    const res = rasterizeTypedSignature(typedText, activeFont.css, inkColor, typedBold);
    if (!res) {
      setCreatorError(c.typeEmptyErr);
      return;
    }
    addStampToSession(typedText.trim().slice(0, 18), res.dataUrl, res.width, res.height);
  };

  const handleUploadSignaturePng = async () => {
    const picked = await pickSingleFile({
      title: c.pickPngBtn,
      filters: [{ name: "Images", extensions: ["png", "webp", "jpg", "jpeg"] }],
    });
    if (!picked) return;
    try {
      const asset = await loadFileAsImageAsset(picked);
      const payload = await getImageAsset(asset.assetId);
      const processed = await processUploadedSignatureImage(payload.dataUrl, knockoutWhite);
      if (!processed) {
        setCreatorError("Failed to decode selected signature image.");
        return;
      }
      const fname = picked.split(/[\\/]/).pop() ?? "Signature PNG";
      addStampToSession(fname, processed.dataUrl, processed.width, processed.height);
    } catch (err) {
      setCreatorError(formatLocalizedError(err, t));
    }
  };

  const activeStamp = useMemo(
    () => st.sessionStamps.find((s) => s.id === st.activeStampId) ?? st.sessionStamps[0] ?? null,
    [st.sessionStamps, st.activeStampId],
  );

  const handlePlaceActiveStamp = () => {
    if (!st.inspection) return;
    if (!activeStamp) {
      setCreatorError(c.noStampErr);
      return;
    }
    const aspect = activeStamp.widthPx / Math.max(activeStamp.heightPx, 1);
    const pageAspect = pageDisplaySize.width / Math.max(pageDisplaySize.height, 1);
    const widthNorm = 0.26;
    const heightNorm = Math.min(0.4, Math.max(0.04, (widthNorm * pageAspect) / aspect));
    const newBox: PdfSignPlacedBox = {
      id: `box-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      pageNumber: st.currentPage,
      stampDataUrl: activeStamp.pngDataUrl,
      aspectRatio: aspect,
      xNorm: Math.max(0.05, 0.5 - widthNorm / 2),
      yNorm: Math.max(0.05, 0.72 - heightNorm / 2),
      widthNorm,
      heightNorm,
      rotationDeg: 0,
      opacity: 1.0,
    };
    commitPlacements([...st.placements, newBox], newBox.id);
    setCreatorError(null);
  };

  const handleSaveActiveStampAsTemplate = async () => {
    if (!activeStamp) return;
    const name = (templateNameInput.trim() || c.templateDefaultName).slice(0, 64);
    try {
      await saveSignatureTemplate({ name, pngDataUrl: activeStamp.pngDataUrl });
      setSavingTemplateOpen(false);
      setTemplateNameInput("");
      await refreshTemplates();
    } catch (err) {
      setCreatorError(formatLocalizedError(err, t));
    }
  };

  const handleDeleteTemplate = async (id: string) => {
    try {
      await deleteSignatureTemplate(id);
      await refreshTemplates();
    } catch (err) {
      setCreatorError(formatLocalizedError(err, t));
    }
  };

  // Drag / resize interactions on placed signature boxes
  const dragStateRef = useRef<{
    kind: "move" | "resize";
    boxId: string;
    startClientX: number;
    startClientY: number;
    origBox: PdfSignPlacedBox;
    snapshot: PdfSignPlacedBox[];
  } | null>(null);

  const startBoxInteraction = (
    e: ReactPointerEvent<HTMLElement>,
    box: PdfSignPlacedBox,
    kind: "move" | "resize",
  ) => {
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    updateSignSession((prev) => ({ ...prev, selectedPlacementId: box.id }));
    dragStateRef.current = {
      kind,
      boxId: box.id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      origBox: { ...box },
      snapshot: st.placements,
    };
  };

  const onBoxPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const ds = dragStateRef.current;
    const frame = pageFrameRef.current;
    if (!ds || !frame) return;
    const rect = frame.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const dx = (e.clientX - ds.startClientX) / rect.width;
    const dy = (e.clientY - ds.startClientY) / rect.height;

    updateSignSession((prev) => ({
      ...prev,
      placements: prev.placements.map((b) => {
        if (b.id !== ds.boxId) return b;
        if (ds.kind === "move") {
          return {
            ...b,
            xNorm: Math.max(-0.2, Math.min(0.95, ds.origBox.xNorm + dx)),
            yNorm: Math.max(-0.2, Math.min(0.95, ds.origBox.yNorm + dy)),
          };
        }
        const pageAspect = rect.width / rect.height;
        const newW = Math.max(0.05, Math.min(0.95, ds.origBox.widthNorm + dx));
        const newH = Math.max(
          0.02,
          Math.min(0.9, (newW * pageAspect) / Math.max(b.aspectRatio, 0.1)),
        );
        return { ...b, widthNorm: newW, heightNorm: newH };
      }),
    }));
  };

  const onBoxPointerUp = () => {
    const ds = dragStateRef.current;
    if (!ds) return;
    dragStateRef.current = null;
    updateSignSession((prev) => ({
      ...prev,
      undoStack: [...prev.undoStack.slice(-29), ds.snapshot],
      redoStack: [],
    }));
  };

  const selectedBox = useMemo(
    () => st.placements.find((p) => p.id === st.selectedPlacementId) ?? null,
    [st.placements, st.selectedPlacementId],
  );

  const updateSelectedBox = (patch: Partial<PdfSignPlacedBox>) => {
    if (!selectedBox) return;
    const next = st.placements.map((b) => (b.id === selectedBox.id ? { ...b, ...patch } : b));
    commitPlacements(next, selectedBox.id);
  };

  const removeSelectedBox = () => {
    if (!selectedBox) return;
    commitPlacements(
      st.placements.filter((b) => b.id !== selectedBox.id),
      null,
    );
  };

  const pagePlacements = useMemo(
    () => st.placements.filter((p) => p.pageNumber === st.currentPage),
    [st.placements, st.currentPage],
  );

  // Export signed PDF
  const runExport = useCallback(
    async (overwrite: boolean) => {
      if (!st.sourcePath || !st.inspection) return;
      if (st.placements.length === 0) {
        updateSignSession((prev) => ({ ...prev, errorMessage: c.noPlacementErr }));
        return;
      }
      const target = st.outputPath.trim();
      if (!target) return;

      const taskId = `p06-${Date.now()}`;
      updateSignSession((prev) => ({
        ...prev,
        taskStatus: "running",
        activeTaskId: taskId,
        progress: null,
        errorMessage: null,
        lastResult: null,
      }));
      try {
        const res = await signPdf({
          taskId,
          path: st.sourcePath,
          outputPath: target,
          overwrite,
          placements: st.placements.map((p) => ({
            pageNumber: p.pageNumber,
            xNorm: p.xNorm,
            yNorm: p.yNorm,
            widthNorm: p.widthNorm,
            heightNorm: p.heightNorm,
            rotationDeg: p.rotationDeg,
            opacity: p.opacity,
            stampPngDataUrl: p.stampDataUrl,
          })),
        });
        updateSignSession((prev) => ({
          ...prev,
          taskStatus: "idle",
          activeTaskId: null,
          lastResult: res,
          errorMessage: null,
        }));
      } catch (err) {
        const parsed = parseBackendError(err);
        if (parsed?.code === "TARGET_ALREADY_EXISTS" && !overwrite) {
          setOverwritePending(target);
          updateSignSession((prev) => ({ ...prev, taskStatus: "idle", activeTaskId: null }));
          return;
        }
        updateSignSession((prev) => ({
          ...prev,
          taskStatus: "idle",
          activeTaskId: null,
          errorMessage: formatLocalizedError(err, t),
        }));
      }
    },
    [
      c.noPlacementErr,
      st.inspection,
      st.outputPath,
      st.placements,
      st.sourcePath,
      t,
      updateSignSession,
    ],
  );

  const running = st.taskStatus === "running";

  return (
    <div className="tool-workspace">
      <div className="tool-intro">
        <p className="tool-intro-desc">{c.subtitle}</p>
      </div>

      <div className="pdf-banner pdf-banner-info" role="note">
        <Info size={16} strokeWidth={1.75} aria-hidden="true" />
        <span>{c.nonCaNotice}</span>
      </div>

      {st.inspection?.hasSignatures && (
        <div className="pdf-banner pdf-banner-warn" role="alert">
          <AlertTriangle size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>{c.sigWarn(st.inspection.signatureCount || 1)}</span>
        </div>
      )}

      {st.errorMessage && (
        <div className="pdf-banner pdf-banner-error" role="alert">
          <AlertTriangle size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>{st.errorMessage}</span>
        </div>
      )}

      <div className="pdf-sign-layout">
        {/* Left: Interactive PDF Document Page Canvas */}
        <div className="pdf-sign-stage-card">
          <div className="pdf-sign-stage-toolbar">
            <div className="pdf-sign-toolbar-group">
              <button
                type="button"
                className="btn btn-primary"
                disabled={running || st.inspectLoading}
                onClick={async () => {
                  const picked = await pickSingleFile({
                    title: c.openPdf,
                    filters: [{ name: "PDF", extensions: ["pdf"] }],
                  });
                  if (picked) void openPdfPath(picked);
                }}
              >
                <FolderOpen size={15} strokeWidth={1.75} aria-hidden="true" />
                <span>{c.openPdf}</span>
              </button>

              {st.inspection && (
                <>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    disabled={st.currentPage <= 1}
                    aria-label="Prev page"
                    onClick={() =>
                      updateSignSession((prev) => ({
                        ...prev,
                        currentPage: Math.max(1, prev.currentPage - 1),
                      }))
                    }
                  >
                    <ChevronLeft size={15} />
                  </button>
                  <span className="mono" style={{ fontSize: 13 }}>
                    {st.currentPage} / {st.inspection.pageCount}
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    disabled={st.currentPage >= st.inspection.pageCount}
                    aria-label="Next page"
                    onClick={() =>
                      updateSignSession((prev) => ({
                        ...prev,
                        currentPage: Math.min(
                          prev.inspection?.pageCount ?? 1,
                          prev.currentPage + 1,
                        ),
                      }))
                    }
                  >
                    <ChevronRight size={15} />
                  </button>
                </>
              )}
            </div>

            {st.inspection && (
              <div className="pdf-sign-toolbar-group">
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  aria-label="Zoom out"
                  onClick={() =>
                    updateSignSession((prev) => ({
                      ...prev,
                      zoomScale: Math.max(0.5, Number((prev.zoomScale - 0.15).toFixed(2))),
                    }))
                  }
                >
                  <ZoomOut size={15} />
                </button>
                <span className="mono" style={{ fontSize: 12 }}>
                  {Math.round(st.zoomScale * 100)}%
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  aria-label="Zoom in"
                  onClick={() =>
                    updateSignSession((prev) => ({
                      ...prev,
                      zoomScale: Math.min(2.0, Number((prev.zoomScale + 0.15).toFixed(2))),
                    }))
                  }
                >
                  <ZoomIn size={15} />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={st.undoStack.length === 0}
                  onClick={handleUndo}
                  title={c.undo}
                >
                  <Undo2 size={14} />
                  <span>{c.undo}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={st.redoStack.length === 0}
                  onClick={handleRedo}
                  title={c.redo}
                >
                  <Redo2 size={14} />
                  <span>{c.redo}</span>
                </button>
                <span className="badge mono">{c.placementCount(st.placements.length)}</span>
              </div>
            )}
          </div>

          {!st.inspection ? (
            <div className="pdf-reader-empty" style={{ minHeight: 340 }}>
              <div className="pdf-reader-empty-card">
                <PenTool size={32} strokeWidth={1.5} aria-hidden="true" />
                <p>{c.emptyHint}</p>
              </div>
            </div>
          ) : (
            <div
              className="pdf-sign-viewport"
              onClick={() => updateSignSession((prev) => ({ ...prev, selectedPlacementId: null }))}
            >
              <div
                ref={pageFrameRef}
                className="pdf-sign-page-frame"
                style={{ width: pageDisplaySize.width, height: pageDisplaySize.height }}
              >
                {pageDataUrl ? (
                  <img
                    src={pageDataUrl}
                    alt={`Page ${st.currentPage}`}
                    className="pdf-sign-page-img"
                    draggable={false}
                  />
                ) : (
                  <div
                    style={{
                      width: "100%",
                      height: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "var(--text-muted)",
                      fontSize: 13,
                    }}
                  >
                    {renderLoading ? "..." : `Page ${st.currentPage}`}
                  </div>
                )}

                {pagePlacements.map((box) => {
                  const isSel = box.id === st.selectedPlacementId;
                  return (
                    <div
                      key={box.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`Signature box ${box.id}`}
                      className={`pdf-sign-overlay-box ${isSel ? "is-selected" : ""}`}
                      style={{
                        left: `${box.xNorm * 100}%`,
                        top: `${box.yNorm * 100}%`,
                        width: `${box.widthNorm * 100}%`,
                        height: `${box.heightNorm * 100}%`,
                        transform: `rotate(${box.rotationDeg}deg)`,
                        opacity: box.opacity,
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        updateSignSession((prev) => ({ ...prev, selectedPlacementId: box.id }));
                      }}
                      onPointerDown={(e) => startBoxInteraction(e, box, "move")}
                      onPointerMove={onBoxPointerMove}
                      onPointerUp={onBoxPointerUp}
                    >
                      <img src={box.stampDataUrl} alt="" draggable={false} />
                      <div
                        className="pdf-sign-resize-handle"
                        onPointerDown={(e) => startBoxInteraction(e, box, "resize")}
                        onPointerMove={onBoxPointerMove}
                        onPointerUp={onBoxPointerUp}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Right: Signature Creator, Session Stamps, Templates, Box Properties & Export */}
        <div className="pdf-sign-side">
          <div className="pdf-sign-panel">
            <h3>{c.creatorTitle}</h3>
            <div className="segmented" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={creatorTab === "draw"}
                className={creatorTab === "draw" ? "is-active" : ""}
                onClick={() => setCreatorTab("draw")}
              >
                <PenTool size={13} />
                <span>{c.tabDraw}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={creatorTab === "type"}
                className={creatorTab === "type" ? "is-active" : ""}
                onClick={() => setCreatorTab("type")}
              >
                <Type size={13} />
                <span>{c.tabType}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={creatorTab === "upload"}
                className={creatorTab === "upload" ? "is-active" : ""}
                onClick={() => setCreatorTab("upload")}
              >
                <ImagePlus size={13} />
                <span>{c.tabUpload}</span>
              </button>
            </div>

            {creatorTab === "draw" && (
              <>
                <canvas
                  ref={drawCanvasRef}
                  width={600}
                  height={272}
                  className="pdf-sign-draw-canvas"
                  onPointerDown={onDrawPointerDown}
                  onPointerMove={onDrawPointerMove}
                  onPointerUp={onDrawPointerUp}
                />
                <div className="pdf-sign-field-row">
                  <span>{c.inkColor}</span>
                  <div className="pdf-sign-swatches">
                    {INK_SWATCHES.map((col) => (
                      <button
                        key={col}
                        type="button"
                        className={`pdf-sign-swatch ${inkColor === col ? "is-active" : ""}`}
                        style={{ backgroundColor: col }}
                        aria-label={col}
                        onClick={() => setInkColor(col)}
                      />
                    ))}
                    <input
                      type="color"
                      value={inkColor}
                      onChange={(e) => setInkColor(e.target.value)}
                      style={{ width: 24, height: 22, padding: 0, border: "none" }}
                    />
                  </div>
                </div>
                <div className="pdf-sign-field-row">
                  <span>{c.penWidth}</span>
                  <input
                    type="range"
                    min={2}
                    max={10}
                    value={penWidth}
                    onChange={(e) => setPenWidth(Number(e.target.value))}
                  />
                  <span className="mono">{penWidth}px</span>
                </div>
                <div className="pdf-sign-toolbar-group">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={strokes.length === 0}
                    onClick={() => setStrokes((prev) => prev.slice(0, -1))}
                  >
                    <Undo2 size={13} />
                    <span>{c.undoStroke}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={strokes.length === 0}
                    onClick={() => setStrokes([])}
                  >
                    <Eraser size={13} />
                    <span>{c.clearPad}</span>
                  </button>
                  <button type="button" className="btn btn-primary" onClick={handleAddDrawnStamp}>
                    <Plus size={13} />
                    <span>{c.addStampFromDraw}</span>
                  </button>
                </div>
              </>
            )}

            {creatorTab === "type" && (
              <>
                <input
                  type="text"
                  className="text-input"
                  placeholder={c.typePlaceholder}
                  value={typedText}
                  onChange={(e) => setTypedText(e.target.value)}
                />
                <div className="pdf-sign-type-preview">
                  <span
                    style={{
                      fontFamily: activeFont.css,
                      color: inkColor,
                      fontWeight: typedBold ? 700 : 400,
                      fontSize: 30,
                      lineHeight: 1.2,
                    }}
                  >
                    {typedText.trim() || (locale === "zh-CN" ? "签名预览" : "Signature")}
                  </span>
                </div>
                <div className="pdf-sign-font-grid">
                  {SIGNATURE_FONTS.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      className={`pdf-sign-font-btn ${typedFontId === f.id ? "is-active" : ""}`}
                      style={{ fontFamily: f.css }}
                      onClick={() => setTypedFontId(f.id)}
                    >
                      {locale === "zh-CN" ? f.zh : f.en}
                    </button>
                  ))}
                </div>
                <div className="pdf-sign-field-row">
                  <div className="pdf-sign-swatches">
                    {INK_SWATCHES.map((col) => (
                      <button
                        key={col}
                        type="button"
                        className={`pdf-sign-swatch ${inkColor === col ? "is-active" : ""}`}
                        style={{ backgroundColor: col }}
                        aria-label={col}
                        onClick={() => setInkColor(col)}
                      />
                    ))}
                  </div>
                  <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12.5 }}>
                    <input
                      type="checkbox"
                      checked={typedBold}
                      onChange={(e) => setTypedBold(e.target.checked)}
                    />
                    <span>{c.bold}</span>
                  </label>
                </div>
                <button type="button" className="btn btn-primary" onClick={handleAddTypedStamp}>
                  <Plus size={14} />
                  <span>{c.addStampFromType}</span>
                </button>
              </>
            )}

            {creatorTab === "upload" && (
              <>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
                  <input
                    type="checkbox"
                    checked={knockoutWhite}
                    onChange={(e) => setKnockoutWhite(e.target.checked)}
                  />
                  <span>{c.removeWhiteBg}</span>
                </label>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void handleUploadSignaturePng()}
                >
                  <ImagePlus size={14} />
                  <span>{c.pickPngBtn}</span>
                </button>
              </>
            )}

            {creatorError && (
              <div className="pdf-banner pdf-banner-error" role="alert" style={{ fontSize: 12 }}>
                <AlertTriangle size={14} />
                <span>{creatorError}</span>
              </div>
            )}

            {/* In-session stamps */}
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
              <div className="pdf-sign-field-row" style={{ marginBottom: 6 }}>
                <strong style={{ fontSize: 12.5 }}>{c.sessionStampsTitle}</strong>
              </div>
              {st.sessionStamps.length === 0 ? (
                <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
                  {c.sessionEmpty}
                </p>
              ) : (
                <>
                  <div className="pdf-sign-stamp-grid">
                    {st.sessionStamps.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className={`pdf-sign-stamp-card ${activeStamp?.id === s.id ? "is-active" : ""}`}
                        onClick={() =>
                          updateSignSession((prev) => ({ ...prev, activeStampId: s.id }))
                        }
                      >
                        <div className="pdf-sign-stamp-thumb">
                          <img src={s.pngDataUrl} alt={s.label} />
                        </div>
                        <span className="pdf-sign-stamp-label">{s.label}</span>
                      </button>
                    ))}
                  </div>
                  <div className="pdf-sign-toolbar-group" style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={!st.inspection || !activeStamp}
                      onClick={handlePlaceActiveStamp}
                    >
                      <Plus size={14} />
                      <span>{c.placeOnPage}</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={!activeStamp}
                      onClick={() => {
                        setTemplateNameInput(activeStamp?.label || c.templateDefaultName);
                        setSavingTemplateOpen((v) => !v);
                      }}
                    >
                      <BookmarkPlus size={14} />
                      <span>{c.saveTemplateBtn}</span>
                    </button>
                  </div>
                </>
              )}

              {savingTemplateOpen && activeStamp && (
                <div
                  style={{
                    marginTop: 8,
                    padding: 8,
                    borderRadius: 8,
                    background: "var(--surface-subtle)",
                    border: "1px solid var(--border)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                    {c.templatesStorageInfo(
                      templatesDir || "%LOCALAPPDATA%\\com.luckylivio.winkit\\signature-templates",
                    )}
                  </span>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      type="text"
                      className="text-input"
                      placeholder={c.templateNamePrompt}
                      value={templateNameInput}
                      onChange={(e) => setTemplateNameInput(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => void handleSaveActiveStampAsTemplate()}
                    >
                      {c.saveTemplateConfirm}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Opt-in saved local templates */}
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
              <strong style={{ fontSize: 12.5, display: "block", marginBottom: 4 }}>
                {c.templatesTitle}
              </strong>
              {savedTemplates.length === 0 ? (
                <p style={{ margin: 0, fontSize: 11.5, color: "var(--text-muted)" }}>
                  {c.templatesEmpty}
                </p>
              ) : (
                <div className="pdf-sign-stamp-grid">
                  {savedTemplates.map((tpl) => (
                    <div key={tpl.id} className="pdf-sign-stamp-card" style={{ cursor: "default" }}>
                      <div className="pdf-sign-stamp-thumb">
                        <img src={tpl.pngDataUrl} alt={tpl.name} />
                      </div>
                      <span className="pdf-sign-stamp-label">{tpl.name}</span>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          style={{ padding: "2px 6px", fontSize: 11 }}
                          onClick={() =>
                            addStampToSession(tpl.name, tpl.pngDataUrl, tpl.widthPx, tpl.heightPx)
                          }
                        >
                          {c.useTemplate}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          style={{ padding: "2px 6px", fontSize: 11 }}
                          onClick={() => void handleDeleteTemplate(tpl.id)}
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Selected Placement Properties */}
          <div className="pdf-sign-panel">
            <h3>{c.selectedBoxTitle}</h3>
            {!selectedBox ? (
              <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{c.noSelection}</p>
            ) : (
              <>
                <div className="pdf-sign-field-row">
                  <span>{c.scaleLabel}</span>
                  <input
                    type="range"
                    min={6}
                    max={80}
                    value={Math.round(selectedBox.widthNorm * 100)}
                    onChange={(e) => {
                      const newW = Number(e.target.value) / 100;
                      const pageAspect =
                        pageDisplaySize.width / Math.max(pageDisplaySize.height, 1);
                      const newH = Math.min(
                        0.85,
                        Math.max(
                          0.02,
                          (newW * pageAspect) / Math.max(selectedBox.aspectRatio, 0.1),
                        ),
                      );
                      updateSelectedBox({ widthNorm: newW, heightNorm: newH });
                    }}
                  />
                  <span className="mono">{Math.round(selectedBox.widthNorm * 100)}%</span>
                </div>
                <div className="pdf-sign-field-row">
                  <span>{c.rotationLabel}</span>
                  <input
                    type="range"
                    min={-180}
                    max={180}
                    value={Math.round(selectedBox.rotationDeg)}
                    onChange={(e) => updateSelectedBox({ rotationDeg: Number(e.target.value) })}
                  />
                  <span className="mono">{Math.round(selectedBox.rotationDeg)}°</span>
                </div>
                <div className="pdf-sign-field-row">
                  <span>{c.opacityLabel}</span>
                  <input
                    type="range"
                    min={15}
                    max={100}
                    value={Math.round(selectedBox.opacity * 100)}
                    onChange={(e) => updateSelectedBox({ opacity: Number(e.target.value) / 100 })}
                  />
                  <span className="mono">{Math.round(selectedBox.opacity * 100)}%</span>
                </div>
                <button type="button" className="btn btn-ghost" onClick={removeSelectedBox}>
                  <Trash2 size={14} />
                  <span>{c.removeBox}</span>
                </button>
              </>
            )}
          </div>

          {/* Export */}
          <div className="pdf-sign-panel">
            <h3>{c.outputLabel}</h3>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="text"
                className="text-input mono"
                value={st.outputPath}
                onChange={(e) =>
                  updateSignSession((prev) => ({ ...prev, outputPath: e.target.value }))
                }
                disabled={running}
              />
              <button
                type="button"
                className="btn"
                disabled={running || !st.sourcePath}
                onClick={async () => {
                  const picked = await pickSaveFilePath({
                    title: c.saveAs,
                    defaultPath: st.outputPath || "signed.pdf",
                    filters: [{ name: "PDF", extensions: ["pdf"] }],
                  });
                  if (picked) {
                    updateSignSession((prev) => ({ ...prev, outputPath: picked }));
                  }
                }}
              >
                {c.saveAs}
              </button>
            </div>

            {running ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 12.5 }}>
                  {c.exporting} {st.progress ? `${Math.round(st.progress.percent)}%` : ""}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    if (st.activeTaskId) void cancelBackendTask(st.activeTaskId);
                  }}
                >
                  {c.cancel}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!st.inspection || st.placements.length === 0 || !st.outputPath.trim()}
                onClick={() => void runExport(false)}
              >
                <Save size={15} />
                <span>{c.exportBtn}</span>
              </button>
            )}

            {st.lastResult && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  padding: 10,
                  borderRadius: 8,
                  background: "var(--surface-subtle)",
                  border: "1px solid var(--border)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
                  <CheckCircle2 size={15} color="var(--success)" />
                  <span>{c.doneSummary(st.lastResult.signedPages, st.lastResult.byteLength)}</span>
                </div>
                <div className="pdf-sign-toolbar-group">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => openInPdfReader(st.lastResult!.outputPath)}
                  >
                    <Eye size={14} />
                    <span>{c.openInReader}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void openLocalDirectory(getParentDir(st.lastResult!.outputPath))}
                  >
                    {c.openOutDir}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {overwritePending && (
        <ConfirmDialog
          open={true}
          title={c.overwriteTitle}
          body={c.overwriteBody(overwritePending)}
          confirmLabel={c.overwriteConfirm}
          cancelLabel={c.cancel}
          onConfirm={() => {
            setOverwritePending(null);
            void runExport(true);
          }}
          onCancel={() => setOverwritePending(null)}
        />
      )}
    </div>
  );
}
