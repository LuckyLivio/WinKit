import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type {
  CompressPdfResult,
  CropPdfResult,
  DecryptPdfResult,
  DeletePdfPagesResult,
  EncryptPdfResult,
  ExtractPdfPagesResult,
  ImagesToPdfResult,
  MarkdownMarginPreset,
  MarkdownPaperSize,
  MarkdownTheme,
  MarkdownToPdfResult,
  MergePdfsResult,
  OrganizePdfResult,
  PdfCompressMode,
  PdfCropScope,
  PdfCropUnitsMode,
  PdfDocumentInspection,
  PdfExportImageFormat,
  PdfExportPageScope,
  PdfExtractMode,
  PdfModifyPermission,
  PdfPageOrientation,
  PdfPageSizePreset,
  PdfPrintPermission,
  PdfSearchResult,
  PdfSecurityStatus,
  PdfSplitMode,
  PdfTaskProgressPayload,
  PdfToImagesPlanPreview,
  PdfToImagesResult,
  PdfWatermarkScope,
  SignPdfResult,
  SplitPdfPlanPreview,
  SplitPdfResult,
  WatermarkPdfResult,
} from "./tauriBridge";
import type { PdfPageGridItem } from "../tools/pdf-shared/PdfPageGrid";

export type PdfZoomMode = "fit_width" | "fit_page" | "custom";
export type PdfReaderSidebarTab = "thumbs" | "outlines" | "info";

export interface PdfReaderSessionState {
  activePath: string | null;
  inspection: PdfDocumentInspection | null;
  loading: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  currentPage: number;
  zoomMode: PdfZoomMode;
  zoomScale: number;
  sidebarOpen: boolean;
  sidebarTab: PdfReaderSidebarTab;
  fullscreen: boolean;
  searchOpen: boolean;
  searchQuery: string;
  searchCaseSensitive: boolean;
  searchLoading: boolean;
  searchResult: PdfSearchResult | null;
  activeMatchIndex: number;
}

export interface PdfMergeQueueItem {
  id: string;
  path: string;
  fileName: string;
  kind: "pdf" | "image";
  status: "loading" | "ready" | "error";
  pageCount: number;
  byteLength: number;
  hasSignatures: boolean;
  hasAcroform: boolean;
  isLikelyScanned: boolean;
  warnings: string[];
  errorMessage: string | null;
}

export interface PdfMergeSessionState {
  items: PdfMergeQueueItem[];
  addFilenameBookmarks: boolean;
  outputPath: string;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  progress: PdfTaskProgressPayload | null;
  lastResult: MergePdfsResult | null;
  errorMessage: string | null;
}

export interface PdfSplitSessionState {
  sourcePath: string | null;
  inspection: PdfDocumentInspection | null;
  inspectLoading: boolean;
  mode: PdfSplitMode;
  chunkSize: number;
  customRanges: string;
  planPreview: SplitPdfPlanPreview | null;
  outputDir: string;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  progress: PdfTaskProgressPayload | null;
  lastResult: SplitPdfResult | null;
  errorMessage: string | null;
}

export interface PdfOrganizeSessionState {
  sourcePath: string | null;
  inspection: PdfDocumentInspection | null;
  inspectLoading: boolean;
  items: PdfPageGridItem[];
  undoStack: PdfPageGridItem[][];
  redoStack: PdfPageGridItem[][];
  outputPath: string;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  progress: PdfTaskProgressPayload | null;
  lastResult: OrganizePdfResult | null;
  errorMessage: string | null;
}

export interface PdfDeleteSessionState {
  sourcePath: string | null;
  inspection: PdfDocumentInspection | null;
  inspectLoading: boolean;
  deletedPages: number[];
  rangeInput: string;
  outputPath: string;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  progress: PdfTaskProgressPayload | null;
  lastResult: DeletePdfPagesResult | null;
  errorMessage: string | null;
}

export interface PdfExtractSessionState {
  sourcePath: string | null;
  inspection: PdfDocumentInspection | null;
  inspectLoading: boolean;
  selectedPages: number[];
  rangeInput: string;
  dedupeAndSort: boolean;
  mode: PdfExtractMode;
  outputPath: string;
  outputDir: string;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  progress: PdfTaskProgressPayload | null;
  lastResult: ExtractPdfPagesResult | null;
  errorMessage: string | null;
}

export interface PdfImageQueueEntry {
  id: string;
  path: string;
  fileName: string;
  width: number;
  height: number;
  byteLength: number;
  hasAlpha: boolean;
  thumbnailDataUrl: string | null;
  errorMessage: string | null;
}

export interface PdfImagesToPdfSessionState {
  items: PdfImageQueueEntry[];
  pageSize: PdfPageSizePreset;
  orientation: PdfPageOrientation;
  marginPt: number;
  backgroundHex: string;
  assumedDpi: number;
  losslessPngImages: boolean;
  outputPath: string;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  progress: PdfTaskProgressPayload | null;
  lastResult: ImagesToPdfResult | null;
  errorMessage: string | null;
}

export interface PdfToImagesSessionState {
  sourcePath: string | null;
  inspection: PdfDocumentInspection | null;
  inspectLoading: boolean;
  scope: PdfExportPageScope;
  singlePage: number;
  customRange: string;
  dpi: number;
  format: PdfExportImageFormat;
  quality: number;
  webpLossless: boolean;
  createSubfolder: boolean;
  outputDir: string;
  planPreview: PdfToImagesPlanPreview | null;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  progress: PdfTaskProgressPayload | null;
  lastResult: PdfToImagesResult | null;
  errorMessage: string | null;
}

export interface SessionSignatureStamp {
  id: string;
  label: string;
  pngDataUrl: string;
  widthPx: number;
  heightPx: number;
}

export interface PdfSignPlacedBox {
  id: string;
  pageNumber: number;
  stampDataUrl: string;
  aspectRatio: number;
  xNorm: number;
  yNorm: number;
  widthNorm: number;
  heightNorm: number;
  rotationDeg: number;
  opacity: number;
}

export interface PdfSignSessionState {
  sourcePath: string | null;
  inspection: PdfDocumentInspection | null;
  inspectLoading: boolean;
  currentPage: number;
  zoomScale: number;
  sessionStamps: SessionSignatureStamp[];
  activeStampId: string | null;
  placements: PdfSignPlacedBox[];
  selectedPlacementId: string | null;
  undoStack: PdfSignPlacedBox[][];
  redoStack: PdfSignPlacedBox[][];
  outputPath: string;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  progress: PdfTaskProgressPayload | null;
  lastResult: SignPdfResult | null;
  errorMessage: string | null;
}

export interface PdfCropSessionState {
  sourcePath: string | null;
  inspection: PdfDocumentInspection | null;
  inspectLoading: boolean;
  currentPage: number;
  scope: PdfCropScope;
  pageRange: string;
  mode: PdfCropUnitsMode;
  unitDisplay: "pt" | "mm";
  leftNorm: number;
  topNorm: number;
  widthNorm: number;
  heightNorm: number;
  autoDetectNotice: string | null;
  outputPath: string;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  progress: PdfTaskProgressPayload | null;
  lastResult: CropPdfResult | null;
  errorMessage: string | null;
}

export interface PdfWatermarkSessionState {
  sourcePath: string | null;
  inspection: PdfDocumentInspection | null;
  inspectLoading: boolean;
  currentPage: number;
  scope: PdfWatermarkScope;
  pageRange: string;
  singleAngleDeg: number;
  outputPath: string;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  progress: PdfTaskProgressPayload | null;
  lastResult: WatermarkPdfResult | null;
  errorMessage: string | null;
}

/** Non-secret session metadata only — passwords are NEVER stored in session context. */
export interface PdfEncryptSessionState {
  sourcePath: string | null;
  securityStatus: PdfSecurityStatus | null;
  inspectLoading: boolean;
  printPermission: PdfPrintPermission;
  allowCopy: boolean;
  allowModify: PdfModifyPermission;
  encryptMetadata: boolean;
  outputPath: string;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  progress: PdfTaskProgressPayload | null;
  lastResult: EncryptPdfResult | null;
  errorMessage: string | null;
}

/** Non-secret session metadata only — passwords are NEVER stored in session context. */
export interface PdfDecryptSessionState {
  sourcePath: string | null;
  securityStatus: PdfSecurityStatus | null;
  inspectLoading: boolean;
  outputPath: string;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  progress: PdfTaskProgressPayload | null;
  lastResult: DecryptPdfResult | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface PdfCompressSessionState {
  sourcePath: string | null;
  inspection: PdfDocumentInspection | null;
  inspectLoading: boolean;
  mode: PdfCompressMode;
  outputPath: string;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  progress: PdfTaskProgressPayload | null;
  lastResult: CompressPdfResult | null;
  errorMessage: string | null;
}

export interface PdfMarkdownSessionState {
  sourceFilePath: string | null;
  sourceDir: string | null;
  markdown: string;
  theme: MarkdownTheme;
  paperSize: MarkdownPaperSize;
  marginPreset: MarkdownMarginPreset;
  headerText: string;
  footerText: string;
  showPageNumbers: boolean;
  includeBookmarks: boolean;
  outputPath: string;
  taskStatus: "idle" | "running";
  activeTaskId: string | null;
  progress: PdfTaskProgressPayload | null;
  lastResult: MarkdownToPdfResult | null;
  errorMessage: string | null;
}

export interface PdfSessionRoot {
  reader: PdfReaderSessionState;
  merge: PdfMergeSessionState;
  split: PdfSplitSessionState;
  organize: PdfOrganizeSessionState;
  deletePages: PdfDeleteSessionState;
  extract: PdfExtractSessionState;
  imagesToPdf: PdfImagesToPdfSessionState;
  pdfToImages: PdfToImagesSessionState;
  sign: PdfSignSessionState;
  crop: PdfCropSessionState;
  pdfWatermark: PdfWatermarkSessionState;
  encrypt: PdfEncryptSessionState;
  decrypt: PdfDecryptSessionState;
  compress: PdfCompressSessionState;
  markdown: PdfMarkdownSessionState;
}

const INITIAL_PDF_SESSION: PdfSessionRoot = {
  reader: {
    activePath: null,
    inspection: null,
    loading: false,
    errorCode: null,
    errorMessage: null,
    currentPage: 1,
    zoomMode: "fit_width",
    zoomScale: 1,
    sidebarOpen: true,
    sidebarTab: "thumbs",
    fullscreen: false,
    searchOpen: false,
    searchQuery: "",
    searchCaseSensitive: false,
    searchLoading: false,
    searchResult: null,
    activeMatchIndex: 0,
  },
  merge: {
    items: [],
    addFilenameBookmarks: true,
    outputPath: "",
    taskStatus: "idle",
    activeTaskId: null,
    progress: null,
    lastResult: null,
    errorMessage: null,
  },
  split: {
    sourcePath: null,
    inspection: null,
    inspectLoading: false,
    mode: "every_n_pages",
    chunkSize: 2,
    customRanges: "",
    planPreview: null,
    outputDir: "",
    taskStatus: "idle",
    activeTaskId: null,
    progress: null,
    lastResult: null,
    errorMessage: null,
  },
  organize: {
    sourcePath: null,
    inspection: null,
    inspectLoading: false,
    items: [],
    undoStack: [],
    redoStack: [],
    outputPath: "",
    taskStatus: "idle",
    activeTaskId: null,
    progress: null,
    lastResult: null,
    errorMessage: null,
  },
  deletePages: {
    sourcePath: null,
    inspection: null,
    inspectLoading: false,
    deletedPages: [],
    rangeInput: "",
    outputPath: "",
    taskStatus: "idle",
    activeTaskId: null,
    progress: null,
    lastResult: null,
    errorMessage: null,
  },
  extract: {
    sourcePath: null,
    inspection: null,
    inspectLoading: false,
    selectedPages: [],
    rangeInput: "",
    dedupeAndSort: true,
    mode: "single_pdf",
    outputPath: "",
    outputDir: "",
    taskStatus: "idle",
    activeTaskId: null,
    progress: null,
    lastResult: null,
    errorMessage: null,
  },
  imagesToPdf: {
    items: [],
    pageSize: "a4",
    orientation: "auto",
    marginPt: 24,
    backgroundHex: "#FFFFFF",
    assumedDpi: 150,
    losslessPngImages: false,
    outputPath: "",
    taskStatus: "idle",
    activeTaskId: null,
    progress: null,
    lastResult: null,
    errorMessage: null,
  },
  pdfToImages: {
    sourcePath: null,
    inspection: null,
    inspectLoading: false,
    scope: "all",
    singlePage: 1,
    customRange: "",
    dpi: 150,
    format: "png",
    quality: 90,
    webpLossless: false,
    createSubfolder: true,
    outputDir: "",
    planPreview: null,
    taskStatus: "idle",
    activeTaskId: null,
    progress: null,
    lastResult: null,
    errorMessage: null,
  },
  sign: {
    sourcePath: null,
    inspection: null,
    inspectLoading: false,
    currentPage: 1,
    zoomScale: 1,
    sessionStamps: [],
    activeStampId: null,
    placements: [],
    selectedPlacementId: null,
    undoStack: [],
    redoStack: [],
    outputPath: "",
    taskStatus: "idle",
    activeTaskId: null,
    progress: null,
    lastResult: null,
    errorMessage: null,
  },
  crop: {
    sourcePath: null,
    inspection: null,
    inspectLoading: false,
    currentPage: 1,
    scope: "all",
    pageRange: "",
    mode: "margins_pt",
    unitDisplay: "mm",
    leftNorm: 0.05,
    topNorm: 0.05,
    widthNorm: 0.9,
    heightNorm: 0.9,
    autoDetectNotice: null,
    outputPath: "",
    taskStatus: "idle",
    activeTaskId: null,
    progress: null,
    lastResult: null,
    errorMessage: null,
  },
  pdfWatermark: {
    sourcePath: null,
    inspection: null,
    inspectLoading: false,
    currentPage: 1,
    scope: "all",
    pageRange: "",
    singleAngleDeg: 0,
    outputPath: "",
    taskStatus: "idle",
    activeTaskId: null,
    progress: null,
    lastResult: null,
    errorMessage: null,
  },
  encrypt: {
    sourcePath: null,
    securityStatus: null,
    inspectLoading: false,
    printPermission: "full",
    allowCopy: true,
    allowModify: "none",
    encryptMetadata: true,
    outputPath: "",
    taskStatus: "idle",
    activeTaskId: null,
    progress: null,
    lastResult: null,
    errorMessage: null,
  },
  decrypt: {
    sourcePath: null,
    securityStatus: null,
    inspectLoading: false,
    outputPath: "",
    taskStatus: "idle",
    activeTaskId: null,
    progress: null,
    lastResult: null,
    errorCode: null,
    errorMessage: null,
  },
  compress: {
    sourcePath: null,
    inspection: null,
    inspectLoading: false,
    mode: "balanced",
    outputPath: "",
    taskStatus: "idle",
    activeTaskId: null,
    progress: null,
    lastResult: null,
    errorMessage: null,
  },
  markdown: {
    sourceFilePath: null,
    sourceDir: null,
    markdown: "",
    theme: "github",
    paperSize: "a4",
    marginPreset: "normal",
    headerText: "",
    footerText: "",
    showPageNumbers: true,
    includeBookmarks: true,
    outputPath: "",
    taskStatus: "idle",
    activeTaskId: null,
    progress: null,
    lastResult: null,
    errorMessage: null,
  },
};

export type PdfTargetToolId =
  | "P06"
  | "P07"
  | "P08"
  | "P09"
  | "P10"
  | "P11"
  | "P13"
  | "P14"
  | "P15"
  | "P16"
  | "P17"
  | "P23"
  | "I13";

export interface PdfSessionContextValue {
  pdfSession: PdfSessionRoot;
  updateReaderSession: (updater: (prev: PdfReaderSessionState) => PdfReaderSessionState) => void;
  updateMergeSession: (updater: (prev: PdfMergeSessionState) => PdfMergeSessionState) => void;
  updateSplitSession: (updater: (prev: PdfSplitSessionState) => PdfSplitSessionState) => void;
  updateOrganizeSession: (
    updater: (prev: PdfOrganizeSessionState) => PdfOrganizeSessionState,
  ) => void;
  updateDeleteSession: (updater: (prev: PdfDeleteSessionState) => PdfDeleteSessionState) => void;
  updateExtractSession: (updater: (prev: PdfExtractSessionState) => PdfExtractSessionState) => void;
  updateImagesToPdfSession: (
    updater: (prev: PdfImagesToPdfSessionState) => PdfImagesToPdfSessionState,
  ) => void;
  updatePdfToImagesSession: (
    updater: (prev: PdfToImagesSessionState) => PdfToImagesSessionState,
  ) => void;
  updateSignSession: (updater: (prev: PdfSignSessionState) => PdfSignSessionState) => void;
  updateCropSession: (updater: (prev: PdfCropSessionState) => PdfCropSessionState) => void;
  updatePdfWatermarkSession: (
    updater: (prev: PdfWatermarkSessionState) => PdfWatermarkSessionState,
  ) => void;
  updateEncryptSession: (updater: (prev: PdfEncryptSessionState) => PdfEncryptSessionState) => void;
  updateDecryptSession: (updater: (prev: PdfDecryptSessionState) => PdfDecryptSessionState) => void;
  updateCompressSession: (
    updater: (prev: PdfCompressSessionState) => PdfCompressSessionState,
  ) => void;
  updateMarkdownSession: (
    updater: (prev: PdfMarkdownSessionState) => PdfMarkdownSessionState,
  ) => void;
  openInPdfReader: (path: string) => void;
  sendPdfToTool: (path: string, toolId: PdfTargetToolId) => void;
  pendingReaderPath: string | null;
  clearPendingReaderPath: () => void;
  pendingToolIntake: { toolId: string; path: string } | null;
  clearPendingToolIntake: () => void;
}

const PdfSessionContext = createContext<PdfSessionContextValue | null>(null);

export function PdfSessionProvider({
  children,
  onNavigateToReader,
  onNavigateToTool,
}: {
  children: ReactNode;
  onNavigateToReader: () => void;
  onNavigateToTool: (toolId: string) => void;
}) {
  const [pdfSession, setPdfSession] = useState<PdfSessionRoot>(INITIAL_PDF_SESSION);
  const [pendingReaderPath, setPendingReaderPath] = useState<string | null>(null);
  const [pendingToolIntake, setPendingToolIntake] = useState<{
    toolId: string;
    path: string;
  } | null>(null);

  const updateReaderSession = useCallback(
    (updater: (prev: PdfReaderSessionState) => PdfReaderSessionState) => {
      setPdfSession((prev) => ({ ...prev, reader: updater(prev.reader) }));
    },
    [],
  );

  const updateMergeSession = useCallback(
    (updater: (prev: PdfMergeSessionState) => PdfMergeSessionState) => {
      setPdfSession((prev) => ({ ...prev, merge: updater(prev.merge) }));
    },
    [],
  );

  const updateSplitSession = useCallback(
    (updater: (prev: PdfSplitSessionState) => PdfSplitSessionState) => {
      setPdfSession((prev) => ({ ...prev, split: updater(prev.split) }));
    },
    [],
  );

  const updateOrganizeSession = useCallback(
    (updater: (prev: PdfOrganizeSessionState) => PdfOrganizeSessionState) => {
      setPdfSession((prev) => ({ ...prev, organize: updater(prev.organize) }));
    },
    [],
  );

  const updateDeleteSession = useCallback(
    (updater: (prev: PdfDeleteSessionState) => PdfDeleteSessionState) => {
      setPdfSession((prev) => ({ ...prev, deletePages: updater(prev.deletePages) }));
    },
    [],
  );

  const updateExtractSession = useCallback(
    (updater: (prev: PdfExtractSessionState) => PdfExtractSessionState) => {
      setPdfSession((prev) => ({ ...prev, extract: updater(prev.extract) }));
    },
    [],
  );

  const updateImagesToPdfSession = useCallback(
    (updater: (prev: PdfImagesToPdfSessionState) => PdfImagesToPdfSessionState) => {
      setPdfSession((prev) => ({ ...prev, imagesToPdf: updater(prev.imagesToPdf) }));
    },
    [],
  );

  const updatePdfToImagesSession = useCallback(
    (updater: (prev: PdfToImagesSessionState) => PdfToImagesSessionState) => {
      setPdfSession((prev) => ({ ...prev, pdfToImages: updater(prev.pdfToImages) }));
    },
    [],
  );

  const updateSignSession = useCallback(
    (updater: (prev: PdfSignSessionState) => PdfSignSessionState) => {
      setPdfSession((prev) => ({ ...prev, sign: updater(prev.sign) }));
    },
    [],
  );

  const updateCropSession = useCallback(
    (updater: (prev: PdfCropSessionState) => PdfCropSessionState) => {
      setPdfSession((prev) => ({ ...prev, crop: updater(prev.crop) }));
    },
    [],
  );

  const updatePdfWatermarkSession = useCallback(
    (updater: (prev: PdfWatermarkSessionState) => PdfWatermarkSessionState) => {
      setPdfSession((prev) => ({ ...prev, pdfWatermark: updater(prev.pdfWatermark) }));
    },
    [],
  );

  const updateEncryptSession = useCallback(
    (updater: (prev: PdfEncryptSessionState) => PdfEncryptSessionState) => {
      setPdfSession((prev) => ({ ...prev, encrypt: updater(prev.encrypt) }));
    },
    [],
  );

  const updateDecryptSession = useCallback(
    (updater: (prev: PdfDecryptSessionState) => PdfDecryptSessionState) => {
      setPdfSession((prev) => ({ ...prev, decrypt: updater(prev.decrypt) }));
    },
    [],
  );

  const updateCompressSession = useCallback(
    (updater: (prev: PdfCompressSessionState) => PdfCompressSessionState) => {
      setPdfSession((prev) => ({ ...prev, compress: updater(prev.compress) }));
    },
    [],
  );

  const updateMarkdownSession = useCallback(
    (updater: (prev: PdfMarkdownSessionState) => PdfMarkdownSessionState) => {
      setPdfSession((prev) => ({ ...prev, markdown: updater(prev.markdown) }));
    },
    [],
  );

  const openInPdfReader = useCallback(
    (path: string) => {
      setPendingReaderPath(path);
      onNavigateToReader();
    },
    [onNavigateToReader],
  );

  const sendPdfToTool = useCallback(
    (path: string, toolId: PdfTargetToolId) => {
      setPendingToolIntake({ toolId, path });
      onNavigateToTool(toolId);
    },
    [onNavigateToTool],
  );

  const clearPendingReaderPath = useCallback(() => {
    setPendingReaderPath(null);
  }, []);

  const clearPendingToolIntake = useCallback(() => {
    setPendingToolIntake(null);
  }, []);

  return (
    <PdfSessionContext.Provider
      value={{
        pdfSession,
        updateReaderSession,
        updateMergeSession,
        updateSplitSession,
        updateOrganizeSession,
        updateDeleteSession,
        updateExtractSession,
        updateImagesToPdfSession,
        updatePdfToImagesSession,
        updateSignSession,
        updateCropSession,
        updatePdfWatermarkSession,
        updateEncryptSession,
        updateDecryptSession,
        updateCompressSession,
        updateMarkdownSession,
        openInPdfReader,
        sendPdfToTool,
        pendingReaderPath,
        clearPendingReaderPath,
        pendingToolIntake,
        clearPendingToolIntake,
      }}
    >
      {children}
    </PdfSessionContext.Provider>
  );
}

export function usePdfSession(): PdfSessionContextValue {
  const ctx = useContext(PdfSessionContext);
  if (!ctx) {
    throw new Error("usePdfSession must be used inside PdfSessionProvider");
  }
  return ctx;
}

export function useOptionalPdfSession(): PdfSessionContextValue | null {
  return useContext(PdfSessionContext);
}
