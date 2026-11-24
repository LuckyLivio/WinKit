import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Download,
  Eye,
  FileText,
  Film,
  FolderOpen,
  ImagePlus,
  Images,
  Info,
  Save,
  Stamp,
  Type,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { MediaToolsSetupPanel } from "../../components/MediaToolsSetupPanel";
import { useI18n } from "../../i18n/I18nContext";
import { useOptionalMediaSession } from "../../lib/mediaSessionStore";
import { useOptionalPdfSession } from "../../lib/pdfSessionStore";
import { useSessionStore } from "../../lib/sessionStore";
import {
  bindDisposableListener,
  cancelBackendTask,
  copyImageAssetToClipboard,
  extractMediaPosterDataUrl,
  formatLocalizedError,
  inspectBatchImages,
  inspectBeautifierSourceImage,
  inspectPdfDocument,
  loadFileAsImageAsset,
  openLocalDirectory,
  parseBackendError,
  pickMultipleDirectories,
  pickMultipleFiles,
  pickSaveFilePath,
  pickSingleDirectory,
  pickSingleFile,
  probeMediaInfo,
  readClipboardImageAsAsset,
  renderPdfPage,
  renderWatermarkedAsset,
  saveImageAssetFile,
  subscribeFileDrop,
  subscribePdfTaskProgress,
  suggestSafeSiblingPath,
  watermarkPdf,
  type MediaToolsStatus,
  type PdfWatermarkScope,
  type SaveAssetFormat,
  type WatermarkPlacement,
  type WatermarkStyleConfig,
} from "../../lib/tauriBridge";
import {
  IMAGE_FILE_DIALOG_EXTENSIONS,
  formatImageBytes,
  mergeInspectedItems,
} from "../image-batch/imageBatchModel";
import "../image-batch/imageBatchShell.css";
import {
  VIDEO_EXTENSIONS,
  formatDurationLabel,
  formatMediaBytes,
  getFileStemAndExt,
  getParentDir,
  suggestMediaOutputPath,
} from "../media-shared/mediaFormat";
import { drawWatermarkOverlayOnCanvas, rasterizeTextWatermarkStamp } from "./watermarkStamp";

const TEXT_SWATCHES = ["#FFFFFF", "#111827", "#DC2626", "#2563EB", "#D97706", "#059669"];

const PLACEMENT_GRID: Array<{ id: WatermarkPlacement; zh: string; en: string }> = [
  { id: "top_left", zh: "左上", en: "Top-L" },
  { id: "top_center", zh: "上中", en: "Top" },
  { id: "top_right", zh: "右上", en: "Top-R" },
  { id: "middle_left", zh: "左中", en: "Mid-L" },
  { id: "center", zh: "居中", en: "Center" },
  { id: "middle_right", zh: "右中", en: "Mid-R" },
  { id: "bottom_left", zh: "左下", en: "Bot-L" },
  { id: "bottom_center", zh: "下中", en: "Bottom" },
  { id: "bottom_right", zh: "右下", en: "Bot-R" },
];

const copy = {
  "zh-CN": {
    batchMode: "批量图片",
    singleMode: "单图水印",
    videoMode: "视频水印",
    pdfMode: "PDF 水印",
    openSingle: "选择单图",
    openVideo: "选择视频…",
    openPdf: "选择 PDF…",
    emptyPdf:
      "选择或拖入本地 PDF，在横竖混排或旋转页面上实时预览水印位置，保留可选文字、矢量与原有链接导出新文件。",
    pdfScopeLabel: "作用页面范围",
    pdfScopeAll: "全部页面",
    pdfScopeCurrent: "仅当前页",
    pdfScopeOdd: "奇数页",
    pdfScopeEven: "偶数页",
    pdfScopeRange: "指定范围",
    pdfRangePlaceholder: "例如 1-3, 5",
    pdfSingleAngle: "单水印旋转角度",
    pdfOutLabel: "输出 PDF 文件（绝不覆盖源文件）",
    runPdf: "导出水印 PDF",
    runningPdf: "正在写入 PDF 水印…",
    cancelPdf: "取消导出",
    openInReader: "在内置预览中打开",
    pdfNotice:
      "水印以独立对象叠加在页面上，保留文字可选性、矢量清晰度与原链接；水印不是永久涂黑，也不保证无法移除。",
    pdfSigWarn: (n: number) =>
      `此 PDF 包含 ${n} 个数字签名字段：添加水印导出的新副本会使原有密码学签名失效。`,
    pdfDoneSummary: (n: number, total: number, bytes: number) =>
      `PDF 水印导出完成：已叠加 ${n}/${total} 页（${(bytes / 1024).toFixed(1)} KiB）`,
    paste: "粘贴图片",
    addFiles: "添加图片",
    addFolders: "添加文件夹",
    clearQueue: "清空队列",
    copyResult: "复制水印图",
    savePng: "导出 PNG",
    saveJpeg: "导出 JPEG",
    previewLabel: "实时水印位置预览",
    memoryBadge: "内存原图",
    emptySingle: "选择本地图片、粘贴剪贴板，或从 I01 / I11 / I12 / I03 送入原图。",
    emptyBatch: "添加或拖入多张横图、竖图或透明 PNG，点击底部缩略图即可核对每张图的水印位置。",
    emptyVideo:
      "选择或拖入横屏、竖屏或含 90° 旋转标记的视频，实时预览 1:1 水印位置并无损保留原音频导出。",
    videoOutLabel: "输出视频文件（绝不覆盖源文件）",
    videoOutSaveAs: "另存为…",
    runVideo: "导出水印视频",
    runningVideo: "正在合成视频水印…",
    cancelVideo: "取消导出",
    videoSampleTime: "预览帧位置",
    kindLabel: "水印类型",
    kindText: "中英文文字",
    kindLogo: "透明 PNG Logo",
    textLabel: "水印文字",
    textPlaceholder: "输入中文或英文水印内容…",
    colorLabel: "文字颜色",
    boldLabel: "加粗",
    shadowLabel: "轻阴影增强可读性",
    logoPickBtn: "选择透明 PNG Logo…",
    logoClearBtn: "清除",
    logoMissing: "请先选择一张透明 PNG Logo 图片。",
    textMissing: "请输入水印文字内容。",
    placementLabel: "水印位置与排布",
    tileBtn: "斜向平铺满画布",
    scaleLabel: "大小比例",
    marginLabel: "边距比例",
    opacityLabel: "不透明度",
    angleLabel: "倾斜角度",
    spacingLabel: "平铺间距",
    outDirLabel: "输出文件夹（始终导出新副本，同名自动编号不覆盖原图）",
    outDirPlaceholder: "请选择输出目录…",
    pickOutDir: "选择目录…",
    runBatch: (n: number) => `批量导出 ${n} 张水印图`,
    cancelBatch: "取消处理",
    openOutDir: "打开输出目录",
    batchSummary: (ok: number, fail: number, cancelled: boolean) =>
      cancelled
        ? `已取消：已导出 ${ok} 张，失败 ${fail} 张`
        : `完成：成功导出 ${ok} 张，失败 ${fail} 张`,
    copiedOk: "已复制带水印的原分辨率图片到 Windows 剪贴板",
    savedOk: (p: string, w: number, h: number) => `已导出 (${w}×${h} px)：${p}`,
    scopeNote:
      "统一支持图片（单图/批量，保留透明 PNG）、视频（90° 竖拍一致并保留原音频）与 PDF 水印（保留可选文字与矢量；非永久涂黑）。",
    overwriteTitle: "覆盖已有文件？",
    overwriteBody: (p: string) => `目标文件已存在：${p}\n确认覆盖吗？`,
    overwriteConfirm: "确认覆盖",
    cancel: "取消",
  },
  "en-US": {
    batchMode: "Batch Images",
    singleMode: "Single Image",
    videoMode: "Video",
    pdfMode: "PDF",
    openSingle: "Open image",
    openVideo: "Open video...",
    openPdf: "Open PDF...",
    emptyPdf:
      "Open or drop a local PDF to preview exact watermark placement across portrait, landscape, and rotated pages while preserving selectable text and links.",
    pdfScopeLabel: "Target pages",
    pdfScopeAll: "All pages",
    pdfScopeCurrent: "Current page",
    pdfScopeOdd: "Odd pages",
    pdfScopeEven: "Even pages",
    pdfScopeRange: "Custom range",
    pdfRangePlaceholder: "e.g. 1-3, 5",
    pdfSingleAngle: "Rotation angle",
    pdfOutLabel: "Output PDF File (Never Overwrites Source)",
    runPdf: "Export Watermarked PDF",
    runningPdf: "Applying PDF Watermark...",
    cancelPdf: "Cancel",
    openInReader: "Open in Preview",
    pdfNotice:
      "Watermarks are overlaid as PDF objects preserving selectable text, vectors, and links. Watermarks are NOT permanent redaction and may be removable.",
    pdfSigWarn: (n: number) =>
      `This PDF contains ${n} digital signature field(s). Exporting a watermarked copy invalidates original signatures.`,
    pdfDoneSummary: (n: number, total: number, bytes: number) =>
      `Watermarked ${n}/${total} PDF page(s) (${(bytes / 1024).toFixed(1)} KiB)`,
    paste: "Paste",
    addFiles: "Add images",
    addFolders: "Add folders",
    clearQueue: "Clear queue",
    copyResult: "Copy result",
    savePng: "Export PNG",
    saveJpeg: "Export JPEG",
    previewLabel: "Live Watermark Placement Preview",
    memoryBadge: "In-Memory",
    emptySingle: "Open an image, paste clipboard, or send an image from I01 / I11 / I12 / I03.",
    emptyBatch:
      "Add or drop landscape, portrait, or transparent PNG images. Select any item below to inspect exact placement.",
    emptyVideo:
      "Open or drop landscape, portrait, or 90°-rotated videos to preview 1:1 watermark placement and export with original audio preserved.",
    videoOutLabel: "Output Video File (Never Overwrites Source)",
    videoOutSaveAs: "Save As...",
    runVideo: "Export Watermarked Video",
    runningVideo: "Rendering Video Watermark...",
    cancelVideo: "Cancel",
    videoSampleTime: "Preview frame",
    kindLabel: "Watermark type",
    kindText: "Text (CJK/Latin)",
    kindLogo: "Transparent PNG Logo",
    textLabel: "Watermark text",
    textPlaceholder: "Enter Chinese or English watermark text…",
    colorLabel: "Text color",
    boldLabel: "Bold",
    shadowLabel: "Subtle shadow",
    logoPickBtn: "Choose PNG Logo…",
    logoClearBtn: "Clear",
    logoMissing: "Please choose a local transparent PNG logo first.",
    textMissing: "Please enter watermark text.",
    placementLabel: "Placement & Tiling",
    tileBtn: "Diagonal Tiling",
    scaleLabel: "Size",
    marginLabel: "Margin",
    opacityLabel: "Opacity",
    angleLabel: "Tilt angle",
    spacingLabel: "Tile spacing",
    outDirLabel: "Output folder (always exports new copies; never overwrites originals)",
    outDirPlaceholder: "Choose an output directory…",
    pickOutDir: "Choose…",
    runBatch: (n: number) => `Export ${n} Watermarked Image(s)`,
    cancelBatch: "Cancel",
    openOutDir: "Open output folder",
    batchSummary: (ok: number, fail: number, cancelled: boolean) =>
      cancelled
        ? `Cancelled: ${ok} exported, ${fail} failed`
        : `Done: ${ok} exported, ${fail} failed`,
    copiedOk: "Copied watermarked full-resolution image to Windows clipboard",
    savedOk: (p: string, w: number, h: number) => `Exported (${w}×${h} px): ${p}`,
    scopeNote:
      "Supports image (single/batch, preserving PNG alpha), video (consistent across portrait/90° rotation with audio preserved), and PDF watermarking (preserves selectable text & vectors; not permanent redaction).",
    overwriteTitle: "Overwrite existing file?",
    overwriteBody: (p: string) => `Target file already exists: ${p}\nOverwrite it?`,
    overwriteConfirm: "Overwrite",
    cancel: "Cancel",
  },
} as const;

export function ImageWatermarkWorkspace() {
  const { locale, t } = useI18n();
  const c = copy[locale];
  const {
    session,
    updateImageWatermarkSession,
    startImageWatermarkBatch,
    cancelImageWatermarkBatch,
  } = useSessionStore();
  const mediaCtx = useOptionalMediaSession();
  const pdfCtx = useOptionalPdfSession();
  const st = session.imageWatermark;
  const videoSt = mediaCtx?.mediaSession.videoWatermark ?? null;
  const videoRunning = videoSt?.taskStatus === "running";
  const pdfSt = pdfCtx?.pdfSession.pdfWatermark ?? null;
  const pdfRunning = pdfSt?.taskStatus === "running";

  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const baseImgRef = useRef<HTMLImageElement | null>(null);
  const stampImgRef = useRef<HTMLImageElement | null>(null);

  const [baseImgVersion, setBaseImgVersion] = useState(0);
  const [stampImgVersion, setStampImgVersion] = useState(0);
  const [dropHover, setDropHover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mediaToolsStatus, setMediaToolsStatus] = useState<MediaToolsStatus | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [pdfPreviewPageUrl, setPdfPreviewPageUrl] = useState<string | null>(null);
  const [pdfPreviewDims, setPdfPreviewDims] = useState<{ w: number; h: number } | null>(null);
  const [pdfOverwritePending, setPdfOverwritePending] = useState<string | null>(null);
  const [pendingOverwrite, setPendingOverwrite] = useState<{
    path: string;
    format: SaveAssetFormat;
  } | null>(null);

  const batchBusy = st.batchStatus === "running";

  const selectedBatchItem = useMemo(() => {
    if (st.batchItems.length === 0) return null;
    return st.batchItems.find((i) => i.path === st.batchSelectedPath) ?? st.batchItems[0] ?? null;
  }, [st.batchItems, st.batchSelectedPath]);

  const videoStream = videoSt?.videoProbe?.videoStreams[0] ?? null;

  const activePreviewUrl =
    st.mode === "pdf"
      ? pdfPreviewPageUrl
      : st.mode === "video"
        ? (videoSt?.posterUrl ?? null)
        : st.mode === "batch"
          ? (selectedBatchItem?.thumbnailDataUrl ?? null)
          : st.previewDataUrl;
  const activeWidth =
    st.mode === "pdf"
      ? (pdfPreviewDims?.w ?? null)
      : st.mode === "video"
        ? (videoStream?.displayWidth ?? videoStream?.codedWidth ?? null)
        : st.mode === "batch"
          ? (selectedBatchItem?.displayWidth ?? null)
          : st.sourceWidth;
  const activeHeight =
    st.mode === "pdf"
      ? (pdfPreviewDims?.h ?? null)
      : st.mode === "video"
        ? (videoStream?.displayHeight ?? videoStream?.codedHeight ?? null)
        : st.mode === "batch"
          ? (selectedBatchItem?.displayHeight ?? null)
          : st.sourceHeight;
  const activeFileName =
    st.mode === "pdf"
      ? (pdfSt?.inspection?.fileName ?? null)
      : st.mode === "video"
        ? (videoSt?.videoProbe?.fileName ?? null)
        : st.mode === "batch"
          ? (selectedBatchItem?.fileName ?? null)
          : st.sourceFileName;

  // Rasterize crisp text stamp whenever text options change
  const textStamp = useMemo(() => {
    if (st.kind !== "text") return null;
    return rasterizeTextWatermarkStamp({
      text: st.text,
      colorHex: st.textColorHex,
      bold: st.textBold,
      shadow: st.textShadow,
    });
  }, [st.kind, st.text, st.textBold, st.textColorHex, st.textShadow]);

  const activeStampUrl = st.kind === "text" ? (textStamp?.dataUrl ?? null) : st.logoPreviewDataUrl;

  // Load preview base image element
  useEffect(() => {
    if (!activePreviewUrl) {
      baseImgRef.current = null;
      setBaseImgVersion((v) => v + 1);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) {
        baseImgRef.current = img;
        setBaseImgVersion((v) => v + 1);
      }
    };
    img.src = activePreviewUrl;
    return () => {
      cancelled = true;
    };
  }, [activePreviewUrl]);

  // Load watermark stamp image element
  useEffect(() => {
    if (!activeStampUrl) {
      stampImgRef.current = null;
      setStampImgVersion((v) => v + 1);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) {
        stampImgRef.current = img;
        setStampImgVersion((v) => v + 1);
      }
    };
    img.src = activeStampUrl;
    return () => {
      cancelled = true;
    };
  }, [activeStampUrl]);

  // Draw live WYSIWYG preview matching Rust placement math 1:1
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    const baseImg = baseImgRef.current;
    if (!canvas || !baseImg || !activeWidth || !activeHeight) return;

    const maxW = 540;
    const maxH = 380;
    const scale = Math.min(maxW / activeWidth, maxH / activeHeight, 1);
    const cw = Math.max(40, Math.round(activeWidth * scale));
    const ch = Math.max(40, Math.round(activeHeight * scale));

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(baseImg, 0, 0, cw, ch);

    if (stampImgRef.current) {
      drawWatermarkOverlayOnCanvas(ctx, cw, ch, stampImgRef.current, {
        placement: st.placement,
        scalePercent: st.scalePercent,
        marginPercent: st.marginPercent,
        opacityPercent: st.opacityPercent,
        tileAngleDeg: st.tileAngleDeg,
        tileSpacingPercent: st.tileSpacingPercent,
        singleAngleDeg: st.mode === "pdf" ? (pdfSt?.singleAngleDeg ?? 0) : 0,
      });
    }
    ctx.restore();
  }, [
    activeHeight,
    activeWidth,
    baseImgVersion,
    stampImgVersion,
    st.marginPercent,
    st.mode,
    st.opacityPercent,
    st.placement,
    st.scalePercent,
    st.tileAngleDeg,
    st.tileSpacingPercent,
    pdfSt?.singleAngleDeg,
  ]);

  const buildStyleConfig = (): WatermarkStyleConfig | null => {
    if (st.kind === "text") {
      if (!textStamp?.dataUrl) return null;
      return {
        stampPngDataUrl: textStamp.dataUrl,
        logoPath: null,
        placement: st.placement,
        scalePercent: st.scalePercent,
        marginPercent: st.marginPercent,
        opacityPercent: st.opacityPercent,
        tileAngleDeg: st.tileAngleDeg,
        tileSpacingPercent: st.tileSpacingPercent,
      };
    }
    if (!st.logoPath) return null;
    return {
      stampPngDataUrl: null,
      logoPath: st.logoPath,
      placement: st.placement,
      scalePercent: st.scalePercent,
      marginPercent: st.marginPercent,
      opacityPercent: st.opacityPercent,
      tileAngleDeg: st.tileAngleDeg,
      tileSpacingPercent: st.tileSpacingPercent,
    };
  };

  const watermarkReady = st.kind === "text" ? st.text.trim().length > 0 : Boolean(st.logoPath);

  const loadSinglePath = useCallback(
    async (filePath: string) => {
      setErrorText(null);
      setBusy(true);
      try {
        const asset = await loadFileAsImageAsset(filePath);
        updateImageWatermarkSession({
          mode: "single",
          assetId: asset.assetId,
          sourcePath: filePath,
          sourceFileName: asset.label,
          previewDataUrl: asset.dataUrl,
          sourceWidth: asset.width,
          sourceHeight: asset.height,
          lastSavedMessage: null,
        });
      } catch (err) {
        setErrorText(formatLocalizedError(err, t));
      } finally {
        setBusy(false);
      }
    },
    [t, updateImageWatermarkSession],
  );

  const addBatchPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      setErrorText(null);
      setBusy(true);
      try {
        const res = await inspectBatchImages(paths);
        updateImageWatermarkSession((prev) => {
          const merged = mergeInspectedItems(prev.batchItems, res.items);
          return {
            ...prev,
            mode: "batch",
            batchItems: merged,
            batchSelectedPath: prev.batchSelectedPath ?? merged[0]?.path ?? null,
            batchLastReport: null,
            batchErrorMessage: null,
          };
        });
      } catch (err) {
        setErrorText(formatLocalizedError(err, t));
      } finally {
        setBusy(false);
      }
    },
    [t, updateImageWatermarkSession],
  );

  const loadVideoPath = useCallback(
    async (filePath: string) => {
      if (!mediaCtx || videoRunning) return;
      setErrorText(null);
      setBusy(true);
      updateImageWatermarkSession({ mode: "video" });
      mediaCtx.updateVideoWatermarkSession((prev) => ({
        ...prev,
        videoPath: filePath,
        videoProbe: null,
        posterUrl: null,
        lastResult: null,
        errorMessage: null,
      }));
      try {
        const probe = await probeMediaInfo(filePath);
        if (!probe.hasVideo) {
          throw new Error(
            locale === "zh-CN"
              ? "所选文件不含视频画面流。"
              : "Selected file does not contain a video stream.",
          );
        }
        const sampleSec = Math.min(0.5, Math.max(0, (probe.durationSec ?? 1) * 0.25));
        const poster = await extractMediaPosterDataUrl(filePath, sampleSec).catch(() => null);
        const { ext } = getFileStemAndExt(filePath);
        const outExt = ["mp4", "mov", "mkv", "webm", "m4v"].includes(ext.toLowerCase())
          ? ext.toLowerCase()
          : "mp4";
        const outPath = suggestMediaOutputPath(filePath, "_watermarked", outExt);
        mediaCtx.updateVideoWatermarkSession((prev) => ({
          ...prev,
          videoPath: filePath,
          videoProbe: probe,
          posterUrl: poster,
          posterTimestampSec: sampleSec,
          outputPath: outPath,
          lastResult: null,
          errorMessage: null,
        }));
      } catch (err) {
        const msg = formatLocalizedError(err, t);
        setErrorText(msg);
        mediaCtx.updateVideoWatermarkSession((prev) => ({ ...prev, errorMessage: msg }));
      } finally {
        setBusy(false);
      }
    },
    [locale, mediaCtx, t, updateImageWatermarkSession, videoRunning],
  );

  const loadPdfPath = useCallback(
    async (filePath: string) => {
      if (!pdfCtx || pdfRunning) return;
      setErrorText(null);
      setBusy(true);
      updateImageWatermarkSession({ mode: "pdf" });
      pdfCtx.updatePdfWatermarkSession((prev) => ({
        ...prev,
        inspectLoading: true,
        errorMessage: null,
        lastResult: null,
      }));
      try {
        const info = await inspectPdfDocument(filePath);
        const suggested =
          (await suggestSafeSiblingPath(info.path, "_watermarked", ".pdf").catch(() => null)) ??
          `${info.path.replace(/\.pdf$/i, "")}_watermarked.pdf`;
        pdfCtx.updatePdfWatermarkSession((prev) => ({
          ...prev,
          sourcePath: info.path,
          inspection: info,
          inspectLoading: false,
          currentPage: 1,
          outputPath: suggested,
          lastResult: null,
          errorMessage: null,
        }));
      } catch (err) {
        const msg = formatLocalizedError(err, t);
        setErrorText(msg);
        pdfCtx.updatePdfWatermarkSession((prev) => ({
          ...prev,
          inspectLoading: false,
          errorMessage: msg,
        }));
      } finally {
        setBusy(false);
      }
    },
    [pdfCtx, pdfRunning, t, updateImageWatermarkSession],
  );

  // Consume PDF handoff from C08
  useEffect(() => {
    if (pdfCtx?.pendingToolIntake?.toolId === "I13") {
      const target = pdfCtx.pendingToolIntake.path;
      pdfCtx.clearPendingToolIntake();
      void loadPdfPath(target);
    }
  }, [pdfCtx, loadPdfPath]);

  // Subscribe to PDF progress for I13 PDF mode
  useEffect(() => {
    if (!pdfCtx) return;
    return bindDisposableListener(
      () =>
        subscribePdfTaskProgress((ev) => {
          if (ev.toolId !== "I13") return;
          pdfCtx.updatePdfWatermarkSession((prev) =>
            prev.activeTaskId === ev.taskId ? { ...prev, progress: ev } : prev,
          );
        }),
      "i13-pdf-progress",
    );
  }, [pdfCtx]);

  // Render active PDF page into preview canvas
  useEffect(() => {
    if (st.mode !== "pdf" || !pdfSt?.inspection) {
      setPdfPreviewPageUrl(null);
      setPdfPreviewDims(null);
      return;
    }
    let cancelled = false;
    void renderPdfPage({
      path: pdfSt.inspection.path,
      pageNumber: pdfSt.currentPage,
      targetWidthPx: 920,
    })
      .then((res) => {
        if (!cancelled) {
          setPdfPreviewPageUrl(res.dataUrl);
          setPdfPreviewDims({ w: res.meta.widthPx, h: res.meta.heightPx });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [st.mode, pdfSt?.inspection, pdfSt?.currentPage]);

  const handlePickPdf = async () => {
    const picked = await pickSingleFile({
      title: c.openPdf,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (picked) await loadPdfPath(picked);
  };

  const handlePickPdfOutput = async () => {
    if (!pdfCtx || !pdfSt?.sourcePath) return;
    const chosen = await pickSaveFilePath({
      title: c.pdfOutLabel,
      defaultPath: pdfSt.outputPath || `${pdfSt.sourcePath.replace(/\.pdf$/i, "")}_watermarked.pdf`,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (chosen) {
      pdfCtx.updatePdfWatermarkSession((prev) => ({
        ...prev,
        outputPath: chosen,
        lastResult: null,
      }));
    }
  };

  const handleRunPdfWatermark = async (overwrite: boolean) => {
    if (!pdfCtx || !pdfSt?.sourcePath || !pdfSt.outputPath.trim()) return;
    const style = buildStyleConfig();
    if (!style) return;
    setErrorText(null);
    const taskId = `i13-pdf-${Date.now()}`;
    pdfCtx.updatePdfWatermarkSession((prev) => ({
      ...prev,
      taskStatus: "running",
      activeTaskId: taskId,
      progress: null,
      errorMessage: null,
      lastResult: null,
    }));
    try {
      const res = await watermarkPdf({
        taskId,
        path: pdfSt.sourcePath,
        outputPath: pdfSt.outputPath.trim(),
        overwrite,
        scope: pdfSt.scope,
        currentPage: pdfSt.currentPage,
        pageRange: pdfSt.scope === "range" ? pdfSt.pageRange : undefined,
        style,
        singleAngleDeg: pdfSt.singleAngleDeg,
      });
      pdfCtx.updatePdfWatermarkSession((prev) => ({
        ...prev,
        taskStatus: "idle",
        activeTaskId: null,
        lastResult: res,
        errorMessage: null,
      }));
    } catch (err) {
      const parsed = parseBackendError(err);
      if (parsed?.code === "TARGET_ALREADY_EXISTS" && !overwrite) {
        setPdfOverwritePending(pdfSt.outputPath.trim());
        pdfCtx.updatePdfWatermarkSession((prev) => ({
          ...prev,
          taskStatus: "idle",
          activeTaskId: null,
        }));
        return;
      }
      const msg = formatLocalizedError(err, t);
      setErrorText(msg);
      pdfCtx.updatePdfWatermarkSession((prev) => ({
        ...prev,
        taskStatus: "idle",
        activeTaskId: null,
        errorMessage: msg,
      }));
    }
  };

  useEffect(() => {
    if (!mediaCtx) return;
    const handed = mediaCtx.consumePendingHandoff("I13");
    if (handed) {
      void loadVideoPath(handed);
    }
  }, [mediaCtx, loadVideoPath]);

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: (hovering) => setDropHover(hovering),
          onDropPaths: (paths) => {
            setDropHover(false);
            if (paths.length === 0) return;
            const firstExt = getFileStemAndExt(paths[0]!).ext.toLowerCase();
            if (firstExt === "pdf" || st.mode === "pdf") {
              void loadPdfPath(paths[0]!);
            } else if (VIDEO_EXTENSIONS.includes(firstExt) || st.mode === "video") {
              void loadVideoPath(paths[0]!);
            } else if (st.mode === "single" && paths.length === 1) {
              void loadSinglePath(paths[0]!);
            } else {
              void addBatchPaths(paths);
            }
          },
        }),
      "i13-watermark-file-drop",
    );
  }, [addBatchPaths, loadPdfPath, loadSinglePath, loadVideoPath, st.mode]);

  const handlePickVideo = async () => {
    const picked = await pickSingleFile({
      title: c.openVideo,
      filters: [{ name: "Videos", extensions: VIDEO_EXTENSIONS }],
    });
    if (picked) await loadVideoPath(picked);
  };

  const handlePickVideoOutput = async () => {
    if (!videoSt?.videoPath || !mediaCtx) return;
    const { ext } = getFileStemAndExt(videoSt.outputPath || videoSt.videoPath);
    const chosen = await pickSaveFilePath({
      title: c.videoOutLabel,
      defaultPath:
        videoSt.outputPath || suggestMediaOutputPath(videoSt.videoPath, "_watermarked", "mp4"),
      filters: [{ name: (ext || "mp4").toUpperCase(), extensions: [(ext || "mp4").toLowerCase()] }],
    });
    if (chosen) {
      mediaCtx.updateVideoWatermarkSession((prev) => ({
        ...prev,
        outputPath: chosen,
        lastResult: null,
      }));
    }
  };

  const handleRunVideoWatermark = async () => {
    if (!mediaCtx || !videoSt?.videoPath || !videoSt.outputPath.trim()) return;
    const style = buildStyleConfig();
    if (!style) return;
    setErrorText(null);
    await mediaCtx.startVideoWatermarkTask(
      {
        sourcePath: videoSt.videoPath,
        outputPath: videoSt.outputPath.trim(),
        style,
        allowOverwrite: true,
      },
      (err) => formatLocalizedError(err, t),
    );
  };

  const handlePickSingle = async () => {
    const picked = await pickSingleFile({
      title: c.openSingle,
      filters: [{ name: "Images", extensions: IMAGE_FILE_DIALOG_EXTENSIONS }],
    });
    if (picked) await loadSinglePath(picked);
  };

  const handlePasteClipboard = async () => {
    setErrorText(null);
    setBusy(true);
    try {
      const asset = await readClipboardImageAsAsset();
      updateImageWatermarkSession({
        mode: "single",
        assetId: asset.assetId,
        sourcePath: null,
        sourceFileName: asset.label,
        previewDataUrl: asset.dataUrl,
        sourceWidth: asset.width,
        sourceHeight: asset.height,
        lastSavedMessage: null,
      });
    } catch (err) {
      setErrorText(formatLocalizedError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const handlePickLogo = async () => {
    const picked = await pickSingleFile({
      title: c.logoPickBtn,
      filters: [{ name: "PNG / WebP Logo", extensions: ["png", "webp", "svg"] }],
    });
    if (!picked) return;
    setErrorText(null);
    setBusy(true);
    try {
      const info = await inspectBeautifierSourceImage(picked);
      updateImageWatermarkSession({
        kind: "logo",
        logoPath: info.path,
        logoFileName: info.fileName,
        logoPreviewDataUrl: info.previewDataUrl,
        lastSavedMessage: null,
      });
    } catch (err) {
      setErrorText(formatLocalizedError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const handleCopySingle = async () => {
    const style = buildStyleConfig();
    if (!style || (!st.assetId && !st.sourcePath)) return;
    setErrorText(null);
    setBusy(true);
    try {
      const rendered = await renderWatermarkedAsset({
        assetId: st.assetId,
        inputPath: st.sourcePath,
        label: st.sourceFileName ?? "watermarked.png",
        style,
      });
      await copyImageAssetToClipboard({ assetId: rendered.assetId });
      updateImageWatermarkSession({ lastSavedMessage: c.copiedOk });
    } catch (err) {
      setErrorText(formatLocalizedError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const runSingleSave = async (outputPath: string, format: SaveAssetFormat, overwrite: boolean) => {
    const style = buildStyleConfig();
    if (!style || (!st.assetId && !st.sourcePath)) return;
    setErrorText(null);
    setBusy(true);
    try {
      const rendered = await renderWatermarkedAsset({
        assetId: st.assetId,
        inputPath: st.sourcePath,
        label: st.sourceFileName ?? "watermarked.png",
        style,
      });
      const saved = await saveImageAssetFile({
        assetId: rendered.assetId,
        outputPath,
        format,
        jpegQuality: 92,
        overwrite,
        toolId: "I13",
      });
      updateImageWatermarkSession({
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

  const handleSingleSaveClick = async (format: SaveAssetFormat) => {
    const ext = format === "png" ? "png" : "jpg";
    const defaultName =
      (st.sourcePath ? await suggestSafeSiblingPath(st.sourcePath, "watermarked", ext) : null) ??
      `winkit_watermarked.${ext}`;
    const target = await pickSaveFilePath({
      title: format === "png" ? c.savePng : c.saveJpeg,
      defaultPath: defaultName,
      filters: [{ name: format.toUpperCase(), extensions: [ext] }],
    });
    if (!target) return;
    await runSingleSave(target, format, false);
  };

  const handleRunBatch = async () => {
    const style = buildStyleConfig();
    if (!style || st.batchItems.length === 0 || !st.batchOutputDir.trim()) return;
    await startImageWatermarkBatch(
      {
        sourcePaths: st.batchItems.map((i) => i.path),
        outputDir: st.batchOutputDir.trim(),
        style,
      },
      (err) => formatLocalizedError(err, t),
    );
  };

  const hasSingleSource = Boolean(st.assetId || st.sourcePath);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, height: "100%" }}>
      {st.mode === "video" && <MediaToolsSetupPanel onStatusChange={setMediaToolsStatus} />}

      {/* Top Toolbar */}
      <div className="tool-toolbar">
        <div className="tool-toolbar-group">
          <div className="segmented" role="group">
            <button
              type="button"
              className={`segmented-btn ${st.mode === "batch" ? "is-selected" : ""}`}
              onClick={() => updateImageWatermarkSession({ mode: "batch" })}
            >
              <Images size={13} strokeWidth={1.75} aria-hidden="true" />
              <span>{c.batchMode}</span>
            </button>
            <button
              type="button"
              className={`segmented-btn ${st.mode === "single" ? "is-selected" : ""}`}
              onClick={() => updateImageWatermarkSession({ mode: "single" })}
            >
              <Stamp size={13} strokeWidth={1.75} aria-hidden="true" />
              <span>{c.singleMode}</span>
            </button>
            <button
              type="button"
              className={`segmented-btn ${st.mode === "video" ? "is-selected" : ""}`}
              onClick={() => updateImageWatermarkSession({ mode: "video" })}
            >
              <Film size={13} strokeWidth={1.75} aria-hidden="true" />
              <span>{c.videoMode}</span>
            </button>
            <button
              type="button"
              className={`segmented-btn ${st.mode === "pdf" ? "is-selected" : ""}`}
              onClick={() => updateImageWatermarkSession({ mode: "pdf" })}
            >
              <FileText size={13} strokeWidth={1.75} aria-hidden="true" />
              <span>{c.pdfMode}</span>
            </button>
          </div>

          {st.mode === "pdf" ? (
            <>
              <button
                type="button"
                className="btn"
                disabled={busy || pdfRunning}
                onClick={() => void handlePickPdf()}
              >
                <FileText size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{c.openPdf}</span>
              </button>
              {pdfCtx && pdfSt?.inspection && (
                <>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    disabled={pdfSt.currentPage <= 1}
                    aria-label="Prev PDF page"
                    onClick={() =>
                      pdfCtx.updatePdfWatermarkSession((prev) => ({
                        ...prev,
                        currentPage: Math.max(1, prev.currentPage - 1),
                      }))
                    }
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <span className="mono" style={{ fontSize: 12.5 }}>
                    {pdfSt.currentPage} / {pdfSt.inspection.pageCount}
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    disabled={pdfSt.currentPage >= pdfSt.inspection.pageCount}
                    aria-label="Next PDF page"
                    onClick={() =>
                      pdfCtx.updatePdfWatermarkSession((prev) => ({
                        ...prev,
                        currentPage: Math.min(
                          prev.inspection?.pageCount ?? 1,
                          prev.currentPage + 1,
                        ),
                      }))
                    }
                  >
                    <ChevronRight size={14} />
                  </button>
                </>
              )}
            </>
          ) : st.mode === "video" ? (
            <button
              type="button"
              className="btn"
              disabled={busy || videoRunning}
              onClick={() => void handlePickVideo()}
            >
              <Film size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{c.openVideo}</span>
            </button>
          ) : st.mode === "single" ? (
            <>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void handlePickSingle()}
              >
                <ImagePlus size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{c.openSingle}</span>
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
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn"
                disabled={busy || batchBusy}
                onClick={async () => {
                  const files = await pickMultipleFiles({
                    title: c.addFiles,
                    filters: [{ name: "Images", extensions: IMAGE_FILE_DIALOG_EXTENSIONS }],
                  });
                  if (files.length > 0) await addBatchPaths(files);
                }}
              >
                <ImagePlus size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{c.addFiles}</span>
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy || batchBusy}
                onClick={async () => {
                  const dirs = await pickMultipleDirectories({ title: c.addFolders });
                  if (dirs.length > 0) await addBatchPaths(dirs);
                }}
              >
                <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{c.addFolders}</span>
              </button>
              {st.batchItems.length > 0 && (
                <button
                  type="button"
                  className="btn"
                  disabled={batchBusy}
                  onClick={() =>
                    updateImageWatermarkSession({
                      batchItems: [],
                      batchSelectedPath: null,
                      batchLastReport: null,
                    })
                  }
                >
                  <span>{c.clearQueue}</span>
                </button>
              )}
            </>
          )}
        </div>

        <div className="tool-toolbar-group">
          {st.mode === "single" && (
            <>
              <button
                type="button"
                className="btn"
                disabled={!hasSingleSource || !watermarkReady || busy}
                onClick={() => void handleCopySingle()}
              >
                <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{c.copyResult}</span>
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!hasSingleSource || !watermarkReady || busy}
                onClick={() => void handleSingleSaveClick("png")}
              >
                <Download size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{c.savePng}</span>
              </button>
              <button
                type="button"
                className="btn"
                disabled={!hasSingleSource || !watermarkReady || busy}
                onClick={() => void handleSingleSaveClick("jpeg")}
              >
                <span>{c.saveJpeg}</span>
              </button>
            </>
          )}
        </div>
      </div>

      {!watermarkReady && (
        <div className="status-banner" role="status">
          <span>{st.kind === "text" ? c.textMissing : c.logoMissing}</span>
        </div>
      )}
      {st.mode === "pdf" && pdfSt?.inspection?.hasSignatures && (
        <div className="status-banner is-err" role="alert">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>{c.pdfSigWarn(pdfSt.inspection.signatureCount || 1)}</span>
        </div>
      )}
      {(errorText ||
        st.batchErrorMessage ||
        (st.mode === "video" && videoSt?.errorMessage) ||
        (st.mode === "pdf" && pdfSt?.errorMessage)) && (
        <div className="status-banner is-err" role="alert">
          <span>
            {errorText ??
              (st.mode === "pdf"
                ? pdfSt?.errorMessage
                : st.mode === "video"
                  ? videoSt?.errorMessage
                  : st.batchErrorMessage)}
          </span>
        </div>
      )}
      {st.lastSavedMessage && !errorText && st.mode === "single" && (
        <div className="status-banner is-ok" role="status" aria-live="polite">
          <span>{st.lastSavedMessage}</span>
        </div>
      )}

      {/* Main Split: Live Checkerboard Preview Stage + Watermark Controls */}
      <div className="beautifier-grid">
        <div className={`pane ${dropHover ? "is-drop-hover" : ""}`}>
          <div className="pane-header">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="pane-title">{c.previewLabel}</span>
              {st.mode === "single" && st.assetId && !st.sourcePath && (
                <span className="badge badge-ok">{c.memoryBadge}</span>
              )}
              {activeFileName && (
                <span
                  className="field-hint"
                  style={{
                    maxWidth: 220,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {activeFileName}
                </span>
              )}
            </div>
            {activeWidth && activeHeight && (
              <span className="mono" style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                {activeWidth}×{activeHeight} px
              </span>
            )}
          </div>

          <div
            className="img-batch-preview-stage"
            style={{
              flex: 1,
              minHeight: 340,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
            }}
          >
            {activePreviewUrl && activeWidth && activeHeight ? (
              <canvas
                ref={previewCanvasRef}
                data-testid="watermark-preview-canvas"
                style={{
                  borderRadius: 4,
                  boxShadow: "var(--shadow-sm)",
                  maxWidth: "100%",
                  maxHeight: "100%",
                }}
              />
            ) : (
              <div className="empty-state" style={{ maxWidth: 420 }}>
                <p style={{ margin: "0 0 12px", fontSize: 12.5 }}>
                  {st.mode === "pdf"
                    ? c.emptyPdf
                    : st.mode === "video"
                      ? c.emptyVideo
                      : st.mode === "batch"
                        ? c.emptyBatch
                        : c.emptySingle}
                </p>
                {st.mode === "pdf" ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void handlePickPdf()}
                  >
                    <FileText size={14} strokeWidth={1.75} aria-hidden="true" />
                    <span>{c.openPdf}</span>
                  </button>
                ) : st.mode === "video" ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!(mediaToolsStatus?.ready ?? true)}
                    onClick={() => void handlePickVideo()}
                  >
                    <Film size={14} strokeWidth={1.75} aria-hidden="true" />
                    <span>{c.openVideo}</span>
                  </button>
                ) : st.mode === "batch" ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={async () => {
                      const files = await pickMultipleFiles({
                        title: c.addFiles,
                        filters: [{ name: "Images", extensions: IMAGE_FILE_DIALOG_EXTENSIONS }],
                      });
                      if (files.length > 0) await addBatchPaths(files);
                    }}
                  >
                    <ImagePlus size={14} strokeWidth={1.75} aria-hidden="true" />
                    <span>{c.addFiles}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void handlePickSingle()}
                  >
                    <ImagePlus size={14} strokeWidth={1.75} aria-hidden="true" />
                    <span>{c.openSingle}</span>
                  </button>
                )}
              </div>
            )}
          </div>

          <div
            style={{
              padding: "7px 12px",
              borderTop: "1px solid var(--border-subtle)",
              background: "var(--bg-surface)",
            }}
          >
            <p className="field-hint">{c.scopeNote}</p>
          </div>
        </div>

        {/* Right: Parameters Panel */}
        <div className="pane" style={{ padding: 14, gap: 12, overflowY: "auto" }}>
          <div className="field-stack">
            <span className="field-label">{c.kindLabel}</span>
            <div className="segmented" role="group">
              <button
                type="button"
                style={{ flex: 1 }}
                className={`segmented-btn ${st.kind === "text" ? "is-selected" : ""}`}
                onClick={() => updateImageWatermarkSession({ kind: "text" })}
              >
                <Type size={13} strokeWidth={1.75} aria-hidden="true" />
                <span>{c.kindText}</span>
              </button>
              <button
                type="button"
                style={{ flex: 1 }}
                className={`segmented-btn ${st.kind === "logo" ? "is-selected" : ""}`}
                onClick={() => updateImageWatermarkSession({ kind: "logo" })}
              >
                <ImagePlus size={13} strokeWidth={1.75} aria-hidden="true" />
                <span>{c.kindLogo}</span>
              </button>
            </div>
          </div>

          {st.kind === "text" ? (
            <>
              <label className="field-stack">
                <span className="field-label">{c.textLabel}</span>
                <input
                  type="text"
                  className="text-input"
                  placeholder={c.textPlaceholder}
                  value={st.text}
                  onChange={(e) => updateImageWatermarkSession({ text: e.target.value })}
                />
              </label>

              <div className="field-stack">
                <span className="field-label">{c.colorLabel}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  {TEXT_SWATCHES.map((hex) => (
                    <button
                      key={hex}
                      type="button"
                      className="swatch-btn"
                      style={{
                        background: hex,
                        outline:
                          st.textColorHex.toUpperCase() === hex
                            ? "2px solid var(--accent)"
                            : undefined,
                      }}
                      aria-label={hex}
                      onClick={() => updateImageWatermarkSession({ textColorHex: hex })}
                    />
                  ))}
                  <label
                    style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5 }}
                  >
                    <input
                      type="checkbox"
                      checked={st.textBold}
                      onChange={(e) => updateImageWatermarkSession({ textBold: e.target.checked })}
                    />
                    <span>{c.boldLabel}</span>
                  </label>
                  <label
                    style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5 }}
                  >
                    <input
                      type="checkbox"
                      checked={st.textShadow}
                      onChange={(e) =>
                        updateImageWatermarkSession({ textShadow: e.target.checked })
                      }
                    />
                    <span>{c.shadowLabel}</span>
                  </label>
                </div>
              </div>
            </>
          ) : (
            <div className="field-stack">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button type="button" className="btn" onClick={() => void handlePickLogo()}>
                  <ImagePlus size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{c.logoPickBtn}</span>
                </button>
                {st.logoPath && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      updateImageWatermarkSession({
                        logoPath: null,
                        logoFileName: null,
                        logoPreviewDataUrl: null,
                      })
                    }
                  >
                    {c.logoClearBtn}
                  </button>
                )}
              </div>
              {st.logoPreviewDataUrl && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: 6,
                    border: "1px solid var(--border-subtle)",
                    borderRadius: 6,
                    background: "var(--bg-subtle)",
                  }}
                >
                  <img
                    src={st.logoPreviewDataUrl}
                    alt={st.logoFileName ?? "Logo"}
                    style={{ maxHeight: 34, maxWidth: 80, objectFit: "contain" }}
                  />
                  <span className="field-hint">{st.logoFileName}</span>
                </div>
              )}
            </div>
          )}

          {/* 3x3 Corner/Edge Grid + Diagonal Tiling */}
          <div className="field-stack">
            <span className="field-label">{c.placementLabel}</span>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 5 }}>
              {PLACEMENT_GRID.map((cell) => (
                <button
                  key={cell.id}
                  type="button"
                  className={`btn ${st.placement === cell.id ? "btn-primary" : ""}`}
                  style={{ justifyContent: "center", padding: "5px 6px", fontSize: 12 }}
                  onClick={() => updateImageWatermarkSession({ placement: cell.id })}
                >
                  {locale === "zh-CN" ? cell.zh : cell.en}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={`btn ${st.placement === "diagonal_tile" ? "btn-primary" : ""}`}
              style={{ justifyContent: "center", marginTop: 4 }}
              onClick={() => updateImageWatermarkSession({ placement: "diagonal_tile" })}
            >
              {c.tileBtn}
            </button>
          </div>

          {/* Sliders */}
          <label className="field-stack">
            <span className="field-label">
              {c.scaleLabel}: <strong>{st.scalePercent}%</strong>
            </span>
            <input
              type="range"
              min={8}
              max={65}
              value={st.scalePercent}
              onChange={(e) =>
                updateImageWatermarkSession({ scalePercent: Number(e.target.value) })
              }
            />
          </label>

          {st.placement !== "diagonal_tile" && (
            <label className="field-stack">
              <span className="field-label">
                {c.marginLabel}: <strong>{st.marginPercent}%</strong>
              </span>
              <input
                type="range"
                min={0}
                max={20}
                value={st.marginPercent}
                onChange={(e) =>
                  updateImageWatermarkSession({ marginPercent: Number(e.target.value) })
                }
              />
            </label>
          )}

          <label className="field-stack">
            <span className="field-label">
              {c.opacityLabel}: <strong>{st.opacityPercent}%</strong>
            </span>
            <input
              type="range"
              min={10}
              max={100}
              value={st.opacityPercent}
              onChange={(e) =>
                updateImageWatermarkSession({ opacityPercent: Number(e.target.value) })
              }
            />
          </label>

          {st.placement === "diagonal_tile" && (
            <>
              <label className="field-stack">
                <span className="field-label">
                  {c.angleLabel}: <strong>{st.tileAngleDeg}°</strong>
                </span>
                <input
                  type="range"
                  min={-60}
                  max={60}
                  value={st.tileAngleDeg}
                  onChange={(e) =>
                    updateImageWatermarkSession({ tileAngleDeg: Number(e.target.value) })
                  }
                />
              </label>
              <label className="field-stack">
                <span className="field-label">
                  {c.spacingLabel}: <strong>{st.tileSpacingPercent}%</strong>
                </span>
                <input
                  type="range"
                  min={40}
                  max={220}
                  step={10}
                  value={st.tileSpacingPercent}
                  onChange={(e) =>
                    updateImageWatermarkSession({ tileSpacingPercent: Number(e.target.value) })
                  }
                />
              </label>
            </>
          )}

          {st.mode === "video" && mediaCtx && videoSt && (
            <div
              className="field-stack"
              style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: 10 }}
            >
              {videoSt.videoProbe && (
                <div className="field-hint" style={{ fontSize: 12 }}>
                  {`${formatDurationLabel(videoSt.videoProbe.durationSec, locale)} · ${activeWidth ?? "?"}×${activeHeight ?? "?"}${videoStream?.rotationDegrees ? ` (${videoStream.rotationDegrees}°→正立)` : ""}`}
                </div>
              )}
              <span className="field-label">{c.videoOutLabel}</span>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  id="i13-video-output-path"
                  type="text"
                  className="text-input"
                  style={{ flex: 1, minWidth: 0 }}
                  value={videoSt.outputPath}
                  disabled={videoRunning}
                  onChange={(e) =>
                    mediaCtx.updateVideoWatermarkSession((prev) => ({
                      ...prev,
                      outputPath: e.target.value,
                    }))
                  }
                />
                <button
                  type="button"
                  className="btn"
                  disabled={videoRunning || !videoSt.videoPath}
                  onClick={() => void handlePickVideoOutput()}
                >
                  <Save size={13} strokeWidth={1.75} aria-hidden="true" />
                  <span>{c.videoOutSaveAs}</span>
                </button>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ flex: 1, justifyContent: "center" }}
                  disabled={
                    videoRunning ||
                    !(mediaToolsStatus?.ready ?? true) ||
                    !watermarkReady ||
                    !videoSt.videoPath ||
                    !videoSt.outputPath.trim()
                  }
                  onClick={() => void handleRunVideoWatermark()}
                >
                  <Download size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{videoRunning ? c.runningVideo : c.runVideo}</span>
                </button>
                {videoRunning && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void mediaCtx.cancelVideoWatermarkTask()}
                  >
                    {c.cancelVideo}
                  </button>
                )}
              </div>
              {videoRunning && videoSt.liveProgress && (
                <progress
                  max={100}
                  value={videoSt.liveProgress.percent ?? undefined}
                  style={{ width: "100%" }}
                />
              )}
            </div>
          )}

          {st.mode === "pdf" && pdfSt && pdfCtx && (
            <div
              className="field-stack"
              style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: 10, gap: 8 }}
            >
              {st.placement !== "diagonal_tile" && (
                <div className="field-stack">
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                    <span className="field-label">{c.pdfSingleAngle}</span>
                    <span className="mono">{pdfSt.singleAngleDeg}°</span>
                  </div>
                  <input
                    type="range"
                    min={-180}
                    max={180}
                    step={5}
                    value={pdfSt.singleAngleDeg}
                    onChange={(e) =>
                      pdfCtx.updatePdfWatermarkSession((prev) => ({
                        ...prev,
                        singleAngleDeg: Number(e.target.value),
                      }))
                    }
                  />
                </div>
              )}

              <span className="field-label">{c.pdfScopeLabel}</span>
              <div className="segmented" style={{ flexWrap: "wrap" }}>
                {(
                  [
                    ["all", c.pdfScopeAll],
                    ["current", c.pdfScopeCurrent],
                    ["odd", c.pdfScopeOdd],
                    ["even", c.pdfScopeEven],
                    ["range", c.pdfScopeRange],
                  ] as Array<[PdfWatermarkScope, string]>
                ).map(([sc, lbl]) => (
                  <button
                    key={sc}
                    type="button"
                    className={`segmented-btn ${pdfSt.scope === sc ? "is-selected" : ""}`}
                    onClick={() =>
                      pdfCtx.updatePdfWatermarkSession((prev) => ({ ...prev, scope: sc }))
                    }
                  >
                    {lbl}
                  </button>
                ))}
              </div>
              {pdfSt.scope === "range" && (
                <input
                  type="text"
                  className="text-input mono"
                  placeholder={c.pdfRangePlaceholder}
                  value={pdfSt.pageRange}
                  onChange={(e) =>
                    pdfCtx.updatePdfWatermarkSession((prev) => ({
                      ...prev,
                      pageRange: e.target.value,
                    }))
                  }
                />
              )}

              <p className="field-hint" style={{ margin: 0, fontSize: 11.5 }}>
                {c.pdfNotice}
              </p>

              <span className="field-label">{c.pdfOutLabel}</span>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  id="i13-pdf-output-path"
                  type="text"
                  className="text-input mono"
                  style={{ flex: 1, minWidth: 0 }}
                  value={pdfSt.outputPath}
                  disabled={pdfRunning}
                  onChange={(e) =>
                    pdfCtx.updatePdfWatermarkSession((prev) => ({
                      ...prev,
                      outputPath: e.target.value,
                    }))
                  }
                />
                <button
                  type="button"
                  className="btn"
                  disabled={pdfRunning || !pdfSt.sourcePath}
                  onClick={() => void handlePickPdfOutput()}
                >
                  <Save size={13} strokeWidth={1.75} aria-hidden="true" />
                  <span>{c.videoOutSaveAs}</span>
                </button>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ flex: 1, justifyContent: "center" }}
                  disabled={
                    pdfRunning || !watermarkReady || !pdfSt.sourcePath || !pdfSt.outputPath.trim()
                  }
                  onClick={() => void handleRunPdfWatermark(false)}
                >
                  <Download size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{pdfRunning ? c.runningPdf : c.runPdf}</span>
                </button>
                {pdfRunning && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      if (pdfSt.activeTaskId) void cancelBackendTask(pdfSt.activeTaskId);
                    }}
                  >
                    {c.cancelPdf}
                  </button>
                )}
              </div>
              {pdfRunning && pdfSt.progress && (
                <progress max={100} value={pdfSt.progress.percent} style={{ width: "100%" }} />
              )}
            </div>
          )}

          {st.mode === "batch" && (
            <div
              className="field-stack"
              style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: 10 }}
            >
              <span className="field-label">{c.outDirLabel}</span>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="text"
                  className="text-input"
                  style={{ flex: 1 }}
                  placeholder={c.outDirPlaceholder}
                  value={st.batchOutputDir}
                  disabled={batchBusy}
                  onChange={(e) => updateImageWatermarkSession({ batchOutputDir: e.target.value })}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={batchBusy}
                  onClick={async () => {
                    const dir = await pickSingleDirectory({ title: c.pickOutDir });
                    if (dir) updateImageWatermarkSession({ batchOutputDir: dir });
                  }}
                >
                  {c.pickOutDir}
                </button>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ flex: 1, justifyContent: "center" }}
                  disabled={
                    batchBusy ||
                    !watermarkReady ||
                    st.batchItems.length === 0 ||
                    !st.batchOutputDir.trim()
                  }
                  onClick={() => void handleRunBatch()}
                >
                  <Download size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{c.runBatch(st.batchItems.length)}</span>
                </button>
                {batchBusy && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void cancelImageWatermarkBatch()}
                  >
                    {c.cancelBatch}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom PDF Watermark Result */}
      {st.mode === "pdf" && pdfSt?.lastResult && pdfCtx && (
        <section className="img-batch-queue-card">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <CheckCircle2 size={17} aria-hidden="true" />
              <strong style={{ fontSize: 13 }}>
                {c.pdfDoneSummary(
                  pdfSt.lastResult.watermarkedPageCount,
                  pdfSt.lastResult.totalPages,
                  pdfSt.lastResult.byteLength,
                )}
              </strong>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => pdfCtx.openInPdfReader(pdfSt.lastResult!.outputPath)}
              >
                <Eye size={13} aria-hidden="true" />
                <span>{c.openInReader}</span>
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => void openLocalDirectory(getParentDir(pdfSt.lastResult!.outputPath))}
              >
                <FolderOpen size={13} aria-hidden="true" />
                <span>{c.openOutDir}</span>
              </button>
            </div>
          </div>
          <div
            className="field-hint"
            style={{ fontSize: 12, marginTop: 4, wordBreak: "break-all" }}
          >
            {pdfSt.lastResult.outputPath}
          </div>
        </section>
      )}

      {/* Bottom Video Watermark Result */}
      {st.mode === "video" && videoSt?.lastResult && mediaCtx && (
        <section className="img-batch-queue-card">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <CheckCircle2 size={17} aria-hidden="true" />
              <strong style={{ fontSize: 13 }}>
                {locale === "zh-CN"
                  ? `视频水印导出完成：${videoSt.lastResult.outputWidth}×${videoSt.lastResult.outputHeight} · ${formatDurationLabel(videoSt.lastResult.durationSec, locale)} · ${formatMediaBytes(videoSt.lastResult.byteSize, locale)}${videoSt.lastResult.audioCopied ? " · 原音频无损保留" : ""}`
                  : `Video watermark exported: ${videoSt.lastResult.outputWidth}×${videoSt.lastResult.outputHeight} · ${formatDurationLabel(videoSt.lastResult.durationSec, locale)} · ${formatMediaBytes(videoSt.lastResult.byteSize, locale)}${videoSt.lastResult.audioCopied ? " · Audio copied" : ""}`}
              </strong>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  void openLocalDirectory(getParentDir(videoSt.lastResult!.outputPath))
                }
              >
                <FolderOpen size={13} aria-hidden="true" />
                <span>{c.openOutDir}</span>
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() =>
                  mediaCtx.handoffMediaFileToTool("V10", videoSt.lastResult!.outputPath)
                }
              >
                <Info size={13} aria-hidden="true" />
                <span>V10</span>
              </button>
            </div>
          </div>
          <div
            className="field-hint"
            style={{ fontSize: 12, marginTop: 4, wordBreak: "break-all" }}
          >
            {videoSt.lastResult.outputPath}
          </div>
        </section>
      )}

      {/* Bottom Batch Strip & Results */}
      {st.mode === "batch" && (st.batchItems.length > 0 || st.batchLastReport) && (
        <section className="img-batch-queue-card">
          {st.batchLiveProgress && (
            <div style={{ fontSize: 12.5 }}>
              <strong>
                {st.batchLiveProgress.currentIndex}/{st.batchLiveProgress.totalItems} ·{" "}
                {st.batchLiveProgress.currentFileName}
              </strong>
            </div>
          )}

          {st.batchItems.length > 0 && (
            <div className="img-batch-strip">
              {st.batchItems.map((item) => (
                <div
                  key={item.path}
                  role="button"
                  tabIndex={0}
                  className={`img-batch-item-card ${selectedBatchItem?.path === item.path ? "is-selected" : ""}`}
                  onClick={() => updateImageWatermarkSession({ batchSelectedPath: item.path })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      updateImageWatermarkSession({ batchSelectedPath: item.path });
                    }
                  }}
                >
                  {item.thumbnailDataUrl ? (
                    <img src={item.thumbnailDataUrl} alt="" className="img-batch-thumb" />
                  ) : (
                    <div className="img-batch-thumb-placeholder">!</div>
                  )}
                  <div className="img-batch-item-meta">
                    <span className="img-batch-item-name" title={item.path}>
                      {item.fileName}
                    </span>
                    <span className="img-batch-item-sub">
                      {item.displayWidth}×{item.displayHeight} · {formatImageBytes(item.byteLength)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="img-batch-remove-btn"
                    disabled={batchBusy}
                    aria-label={item.fileName}
                    onClick={(e) => {
                      e.stopPropagation();
                      updateImageWatermarkSession((prev) => {
                        const next = prev.batchItems.filter((i) => i.path !== item.path);
                        return {
                          ...prev,
                          batchItems: next,
                          batchSelectedPath:
                            prev.batchSelectedPath === item.path
                              ? (next[0]?.path ?? null)
                              : prev.batchSelectedPath,
                        };
                      });
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {st.batchLastReport && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="img-batch-toolbar">
                <span className="badge badge-ok">
                  {c.batchSummary(
                    st.batchLastReport.succeededCount,
                    st.batchLastReport.failedCount,
                    st.batchLastReport.cancelled,
                  )}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void openLocalDirectory(st.batchLastReport!.outputDir)}
                >
                  {c.openOutDir}
                </button>
              </div>
              <div className="img-batch-results-table-wrap">
                <table className="img-batch-table">
                  <tbody>
                    {st.batchLastReport.items.map((row, idx) => (
                      <tr key={`${row.sourcePath}-${idx}`}>
                        <td className="img-batch-mono">{row.fileName}</td>
                        <td>
                          <span
                            className={`badge ${row.status === "ok" ? "badge-ok" : "badge-err"}`}
                          >
                            {row.status}
                          </span>
                        </td>
                        <td>
                          {row.outputWidth && row.outputHeight
                            ? `${row.outputWidth}×${row.outputHeight}`
                            : "—"}
                        </td>
                        <td className="img-batch-hint">{row.outputPath ?? row.message ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      <ConfirmDialog
        open={pdfOverwritePending !== null}
        title={c.overwriteTitle}
        body={c.overwriteBody(pdfOverwritePending ?? "")}
        confirmLabel={c.overwriteConfirm}
        cancelLabel={c.cancel}
        onCancel={() => setPdfOverwritePending(null)}
        onConfirm={async () => {
          setPdfOverwritePending(null);
          await handleRunPdfWatermark(true);
        }}
      />

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
          if (pending) await runSingleSave(pending.path, pending.format, true);
        }}
      />
    </div>
  );
}
