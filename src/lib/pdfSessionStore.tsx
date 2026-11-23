import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type {
  DeletePdfPagesResult,
  ExtractPdfPagesResult,
  MergePdfsResult,
  OrganizePdfResult,
  PdfDocumentInspection,
  PdfExtractMode,
  PdfSearchResult,
  PdfSplitMode,
  PdfTaskProgressPayload,
  SplitPdfPlanPreview,
  SplitPdfResult,
} from "./tauriBridge";
import type { PdfPageGridItem } from "../tools/pdf-shared/PdfPageGrid";

export type PdfZoomMode = "fit_width" | "fit_page" | "custom";
export type PdfReaderSidebarTab = "thumbs" | "outlines" | "info";

export interface PdfReaderSessionState {
  activePath: string | null;
  inspection: PdfDocumentInspection | null;
  loading: boolean;
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

export interface PdfSessionRoot {
  reader: PdfReaderSessionState;
  merge: PdfMergeSessionState;
  split: PdfSplitSessionState;
  organize: PdfOrganizeSessionState;
  deletePages: PdfDeleteSessionState;
  extract: PdfExtractSessionState;
}

const INITIAL_PDF_SESSION: PdfSessionRoot = {
  reader: {
    activePath: null,
    inspection: null,
    loading: false,
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
};

export type PdfTargetToolId = "P07" | "P08" | "P09" | "P10" | "P11";

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
