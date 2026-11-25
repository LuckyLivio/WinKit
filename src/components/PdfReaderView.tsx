import {
  AlertTriangle,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Combine,
  FileSearch,
  FolderOpen,
  Info,
  Maximize2,
  Minimize2,
  PanelLeft,
  Scissors,
  Search,
  Volume2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/I18nContext";
import { PDF_MESSAGES } from "../i18n/pdfMessages";
import { usePdfSession } from "../lib/pdfSessionStore";
import { openQrHttpUrl } from "../lib/qrBridge";
import { useOptionalSessionStore } from "../lib/sessionStore";
import {
  bindDisposableListener,
  extractPdfPagesText,
  formatLocalizedError,
  getPdfPageText,
  inspectPdfDocument,
  parseBackendError,
  pickSingleFile,
  renderPdfPage,
  searchPdfText,
  subscribeFileDrop,
  type PdfOutlineItem,
  type PdfPageGeometry,
  type PdfPageTextPayload,
} from "../lib/tauriBridge";
import { formatCompactPages, parseClientPageRanges } from "../tools/pdf-shared/pageRangeUtils";
import "./PdfReaderView.css";

const MAX_CLIENT_PAGES = 18;
const MAX_CLIENT_THUMBS = 48;
const MAX_CLIENT_TEXT_PAGES = 18;

function setLru<K, V>(prev: Map<K, V>, key: K, value: V, maxEntries: number): Map<K, V> {
  const next = new Map(prev);
  if (next.has(key)) {
    next.delete(key);
  }
  next.set(key, value);
  while (next.size > maxEntries) {
    const oldest = next.keys().next().value;
    if (oldest !== undefined) {
      next.delete(oldest);
    } else {
      break;
    }
  }
  return next;
}

function OutlineTree({
  items,
  depth = 0,
  onJumpPage,
}: {
  items: PdfOutlineItem[];
  depth?: number;
  onJumpPage: (page: number) => void;
}) {
  return (
    <ul className={`pdf-outline-list depth-${Math.min(depth, 4)}`}>
      {items.map((item, idx) => (
        <li key={`${depth}-${idx}-${item.title}`}>
          <button
            type="button"
            className="pdf-outline-btn"
            disabled={!item.pageNumber}
            onClick={() => {
              if (item.pageNumber) {
                onJumpPage(item.pageNumber);
              }
            }}
            title={item.title}
          >
            <span className="pdf-outline-title">{item.title}</span>
            {item.pageNumber && <span className="pdf-outline-page mono">{item.pageNumber}</span>}
          </button>
          {item.children.length > 0 && (
            <OutlineTree items={item.children} depth={depth + 1} onJumpPage={onJumpPage} />
          )}
        </li>
      ))}
    </ul>
  );
}

export function PdfReaderView() {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const pm = PDF_MESSAGES[locale];
  const {
    pdfSession,
    updateReaderSession,
    sendPdfToTool,
    pendingReaderPath,
    clearPendingReaderPath,
  } = usePdfSession();
  const sessionStore = useOptionalSessionStore();
  const state = pdfSession.reader;

  const [dropHover, setDropHover] = useState(false);
  const [pageInputText, setPageInputText] = useState(String(state.currentPage));
  const [viewportWidth, setViewportWidth] = useState(860);
  const [viewportHeight, setViewportHeight] = useState(640);
  const [renderedPages, setRenderedPages] = useState<Map<string, string>>(() => new Map());
  const [renderedThumbs, setRenderedThumbs] = useState<Map<string, string>>(() => new Map());
  const [pageTexts, setPageTexts] = useState<Map<string, PdfPageTextPayload>>(() => new Map());
  const [visiblePages, setVisiblePages] = useState<Set<number>>(() => new Set([1]));
  const [visibleThumbs, setVisibleThumbs] = useState<Set<number>>(() => new Set([1, 2, 3, 4]));
  const [ttsPanelOpen, setTtsPanelOpen] = useState(false);
  const [ttsRangeInput, setTtsRangeInput] = useState("");
  const [ttsBusy, setTtsBusy] = useState(false);
  const [ttsScannedNotice, setTtsScannedNotice] = useState<{
    path: string;
    pages: number[];
  } | null>(null);
  const [ttsError, setTtsError] = useState<string | null>(null);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const thumbScrollRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const thumbRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const inFlightPagesRef = useRef<Set<string>>(new Set());
  const inFlightThumbsRef = useRef<Set<string>>(new Set());
  const inFlightTextRef = useRef<Set<string>>(new Set());
  const docGenerationRef = useRef(0);
  const ttsExtractGenRef = useRef(0);
  const mountedRef = useRef(true);
  const activeDocPathRef = useRef<string | null>(state.activePath);
  const docLoadingRef = useRef<boolean>(state.loading);
  activeDocPathRef.current = state.activePath;
  docLoadingRef.current = state.loading;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      ttsExtractGenRef.current += 1;
    };
  }, []);

  useEffect(() => {
    ttsExtractGenRef.current += 1;
    setTtsBusy(false);
  }, [state.activePath]);

  const openDocument = useCallback(
    async (path: string) => {
      const gen = ++docGenerationRef.current;
      ttsExtractGenRef.current += 1;
      activeDocPathRef.current = path;
      docLoadingRef.current = true;
      setRenderedPages(new Map());
      setRenderedThumbs(new Map());
      setPageTexts(new Map());
      setVisiblePages(new Set([1]));
      setVisibleThumbs(new Set([1, 2, 3, 4]));
      setTtsPanelOpen(false);
      setTtsRangeInput("");
      setTtsBusy(false);
      setTtsScannedNotice(null);
      setTtsError(null);
      inFlightPagesRef.current.clear();
      inFlightThumbsRef.current.clear();
      inFlightTextRef.current.clear();

      updateReaderSession((prev) => ({
        ...prev,
        activePath: path,
        loading: true,
        errorCode: null,
        errorMessage: null,
        currentPage: 1,
        searchResult: null,
        activeMatchIndex: 0,
      }));
      setPageInputText("1");

      try {
        const info = await inspectPdfDocument(path);
        if (docGenerationRef.current !== gen) return;
        activeDocPathRef.current = info.path;
        docLoadingRef.current = false;
        updateReaderSession((prev) => ({
          ...prev,
          activePath: info.path,
          inspection: info,
          loading: false,
          errorCode: null,
          errorMessage: null,
          currentPage: 1,
        }));
      } catch (err) {
        if (docGenerationRef.current !== gen) return;
        docLoadingRef.current = false;
        const parsed = parseBackendError(err);
        updateReaderSession((prev) => ({
          ...prev,
          inspection: null,
          loading: false,
          errorCode: parsed.code,
          errorMessage: formatLocalizedError(err, t),
        }));
      }
    },
    [t, updateReaderSession],
  );

  // Consume cross-tool "Open in Built-in PDF Preview" handoff
  useEffect(() => {
    if (!pendingReaderPath) return;
    const target = pendingReaderPath;
    clearPendingReaderPath();
    void openDocument(target);
  }, [pendingReaderPath, clearPendingReaderPath, openDocument]);

  // Keep page input synchronized with currentPage
  useEffect(() => {
    setPageInputText(String(state.currentPage));
  }, [state.currentPage]);

  // Native file drag-and-drop onto reader
  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: setDropHover,
          onDropPaths: (paths) => {
            const pdf = paths.find((p) => p.toLowerCase().endsWith(".pdf")) ?? paths[0];
            if (pdf) {
              void openDocument(pdf);
            }
          },
        }),
      "pdf-reader-drop",
    );
  }, [openDocument]);

  // Measure viewport dimensions for fit-width / fit-page calculations
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const updateSize = () => {
      setViewportWidth(Math.max(320, el.clientWidth - 48));
      setViewportHeight(Math.max(320, el.clientHeight - 40));
    };
    updateSize();
    if (typeof ResizeObserver === "function") {
      const obs = new ResizeObserver(updateSize);
      obs.observe(el);
      return () => obs.disconnect();
    }
    return undefined;
  }, [state.sidebarOpen, state.fullscreen, state.inspection]);

  // Keyboard shortcuts: Ctrl+F search, Escape close search/fullscreen
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && state.inspection) {
        e.preventDefault();
        updateReaderSession((prev) => ({ ...prev, searchOpen: true }));
        setTimeout(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        }, 0);
      } else if (e.key === "Escape") {
        if (state.searchOpen) {
          e.preventDefault();
          updateReaderSession((prev) => ({
            ...prev,
            searchOpen: false,
            searchResult: null,
            activeMatchIndex: 0,
          }));
        } else if (state.fullscreen) {
          e.preventDefault();
          updateReaderSession((prev) => ({ ...prev, fullscreen: false }));
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state.inspection, state.searchOpen, state.fullscreen, updateReaderSession]);

  const computePageDisplaySize = useCallback(
    (page: PdfPageGeometry): { width: number; height: number } => {
      const aspect = page.heightPt > 0 ? page.heightPt / Math.max(page.widthPt, 1) : 1.414;
      if (state.zoomMode === "fit_width") {
        const w = Math.max(260, Math.min(viewportWidth, 1360));
        return { width: Math.round(w), height: Math.round(w * aspect) };
      }
      if (state.zoomMode === "fit_page") {
        const byW = Math.max(240, viewportWidth);
        const byH = Math.max(240, viewportHeight) / aspect;
        const w = Math.min(byW, byH);
        return { width: Math.round(w), height: Math.round(w * aspect) };
      }
      // Custom zoom: 100% = 96 DPI equivalent (pt * 96 / 72)
      const baseW = Math.max(220, page.widthPt * (96 / 72));
      const w = Math.round(Math.min(2200, Math.max(200, baseW * state.zoomScale)));
      return { width: w, height: Math.round(w * aspect) };
    },
    [state.zoomMode, state.zoomScale, viewportWidth, viewportHeight],
  );

  // Observe visible main pages lazily (with 360px pre-render margin) and track actual viewport page
  useEffect(() => {
    const root = viewportRef.current;
    if (!root || !state.inspection) return;

    let rafId = 0;
    const syncCurrentPageFromViewport = () => {
      rafId = 0;
      const rootRect = root.getBoundingClientRect();
      if (rootRect.height <= 0) return;
      let bestPage: number | null = null;
      let bestOverlapPx = 0;
      for (const [p, el] of pageRefs.current.entries()) {
        const rect = el.getBoundingClientRect();
        const overlap = Math.min(rect.bottom, rootRect.bottom) - Math.max(rect.top, rootRect.top);
        if (overlap > bestOverlapPx + 0.5) {
          bestOverlapPx = overlap;
          bestPage = p;
        }
      }
      if (bestPage !== null) {
        updateReaderSession((curr) =>
          curr.currentPage === bestPage ? curr : { ...curr, currentPage: bestPage },
        );
      }
    };

    const scheduleSync = () => {
      if (rafId === 0) {
        rafId = window.requestAnimationFrame(syncCurrentPageFromViewport);
      }
    };

    root.addEventListener("scroll", scheduleSync, { passive: true });
    scheduleSync();

    let observer: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === "function") {
      observer = new IntersectionObserver(
        (entries) => {
          setVisiblePages((prev) => {
            const next = new Set(prev);
            for (const entry of entries) {
              const p = Number((entry.target as HTMLElement).dataset.page);
              if (!Number.isFinite(p)) continue;
              if (entry.isIntersecting) {
                next.add(p);
              } else {
                next.delete(p);
              }
            }
            return next;
          });
          scheduleSync();
        },
        { root, rootMargin: "360px 0px", threshold: [0.05, 0.35, 0.65] },
      );

      for (const el of pageRefs.current.values()) {
        observer.observe(el);
      }
    }

    return () => {
      root.removeEventListener("scroll", scheduleSync);
      if (rafId !== 0) {
        window.cancelAnimationFrame(rafId);
      }
      observer?.disconnect();
    };
  }, [state.inspection, updateReaderSession]);

  // Observe visible thumbnails lazily
  useEffect(() => {
    const root = thumbScrollRef.current;
    if (
      !root ||
      !state.inspection ||
      !state.sidebarOpen ||
      state.sidebarTab !== "thumbs" ||
      typeof IntersectionObserver !== "function"
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        setVisibleThumbs((prev) => {
          const next = new Set(prev);
          for (const entry of entries) {
            const p = Number((entry.target as HTMLElement).dataset.thumbPage);
            if (!Number.isFinite(p)) continue;
            if (entry.isIntersecting) next.add(p);
            else next.delete(p);
          }
          return next;
        });
      },
      { root, rootMargin: "200px 0px", threshold: 0.05 },
    );
    for (const el of thumbRefs.current.values()) {
      observer.observe(el);
    }
    return () => observer.disconnect();
  }, [state.inspection, state.sidebarOpen, state.sidebarTab]);

  // Trigger bounded lazy rendering for visible main pages + adjacent buffer
  useEffect(() => {
    const info = state.inspection;
    if (!info) return;
    const gen = docGenerationRef.current;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const targets = new Set<number>();
    for (const p of visiblePages) {
      targets.add(p);
      if (p > 1) targets.add(p - 1);
      if (p < info.pageCount) targets.add(p + 1);
    }
    targets.add(state.currentPage);

    for (const pageNumber of targets) {
      const pageGeom = info.pages[pageNumber - 1];
      if (!pageGeom) continue;
      const disp = computePageDisplaySize(pageGeom);
      // Quantize render width to 64px buckets to maximize backend & frontend cache hits
      const renderW = Math.min(2400, Math.max(240, Math.ceil((disp.width * dpr) / 64) * 64));
      const key = `${info.path}#${pageNumber}@${renderW}`;
      if (!renderedPages.has(key) && !inFlightPagesRef.current.has(key)) {
        inFlightPagesRef.current.add(key);
        void renderPdfPage({
          path: info.path,
          pageNumber,
          targetWidthPx: renderW,
        })
          .then((res) => {
            inFlightPagesRef.current.delete(key);
            if (docGenerationRef.current !== gen) return;
            setRenderedPages((prev) => setLru(prev, key, res.dataUrl, MAX_CLIENT_PAGES));
          })
          .catch(() => {
            inFlightPagesRef.current.delete(key);
          });
      }

      const textKey = `${info.path}#${pageNumber}`;
      if (info.hasTextLayer && !pageTexts.has(textKey) && !inFlightTextRef.current.has(textKey)) {
        inFlightTextRef.current.add(textKey);
        void getPdfPageText(info.path, pageNumber)
          .then((payload) => {
            inFlightTextRef.current.delete(textKey);
            if (docGenerationRef.current !== gen) return;
            setPageTexts((prev) => setLru(prev, textKey, payload, MAX_CLIENT_TEXT_PAGES));
          })
          .catch(() => {
            inFlightTextRef.current.delete(textKey);
          });
      }
    }
  }, [
    state.inspection,
    state.currentPage,
    visiblePages,
    computePageDisplaySize,
    renderedPages,
    pageTexts,
  ]);

  // Trigger bounded lazy rendering for visible sidebar thumbnails
  useEffect(() => {
    const info = state.inspection;
    if (!info || !state.sidebarOpen || state.sidebarTab !== "thumbs") return;
    const gen = docGenerationRef.current;

    for (const pageNumber of visibleThumbs) {
      const thumbKey = `${info.path}#${pageNumber}`;
      if (renderedThumbs.has(thumbKey) || inFlightThumbsRef.current.has(thumbKey)) continue;
      inFlightThumbsRef.current.add(thumbKey);
      void renderPdfPage({
        path: info.path,
        pageNumber,
        targetWidthPx: 180,
      })
        .then((res) => {
          inFlightThumbsRef.current.delete(thumbKey);
          if (docGenerationRef.current !== gen) return;
          setRenderedThumbs((prev) => setLru(prev, thumbKey, res.dataUrl, MAX_CLIENT_THUMBS));
        })
        .catch(() => {
          inFlightThumbsRef.current.delete(thumbKey);
        });
    }
  }, [state.inspection, state.sidebarOpen, state.sidebarTab, visibleThumbs, renderedThumbs]);

  const jumpToPage = useCallback(
    (pageNumber: number) => {
      if (!state.inspection) return;
      const clamped = Math.max(1, Math.min(state.inspection.pageCount, pageNumber));
      updateReaderSession((prev) => ({ ...prev, currentPage: clamped }));
      setVisiblePages((prev) => {
        const next = new Set(prev);
        next.add(clamped);
        return next;
      });
      const el = pageRefs.current.get(clamped);
      if (el && typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    },
    [state.inspection, updateReaderSession],
  );

  const handleOpenDialog = async () => {
    const selected = await pickSingleFile({
      title: pm.common.openPdf,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (selected) {
      await openDocument(selected);
    }
  };

  const handleRunSearch = async () => {
    if (!state.inspection) return;
    const query = state.searchQuery.trim();
    if (!query) {
      updateReaderSession((prev) => ({ ...prev, searchResult: null, activeMatchIndex: 0 }));
      return;
    }
    updateReaderSession((prev) => ({ ...prev, searchLoading: true }));
    try {
      const res = await searchPdfText(state.inspection.path, query, state.searchCaseSensitive);
      updateReaderSession((prev) => ({
        ...prev,
        searchLoading: false,
        searchResult: res,
        activeMatchIndex: 0,
      }));
      if (res.matches.length > 0) {
        jumpToPage(res.matches[0]!.pageNumber);
      }
    } catch (err) {
      updateReaderSession((prev) => ({
        ...prev,
        searchLoading: false,
        errorMessage: formatLocalizedError(err, t),
      }));
    }
  };

  const stepSearchMatch = (delta: number) => {
    const matches = state.searchResult?.matches ?? [];
    if (matches.length === 0) return;
    const nextIdx = (state.activeMatchIndex + delta + matches.length) % matches.length;
    updateReaderSession((prev) => ({ ...prev, activeMatchIndex: nextIdx }));
    const target = matches[nextIdx];
    if (target) {
      jumpToPage(target.pageNumber);
    }
  };

  const matchesByPage = useMemo(() => {
    const map = new Map<
      number,
      { isActive: boolean; rect: { left: number; top: number; width: number; height: number } }[]
    >();
    const res = state.searchResult;
    if (!res) return map;
    res.matches.forEach((m, idx) => {
      const list = map.get(m.pageNumber) ?? [];
      for (const rect of m.rects) {
        list.push({ isActive: idx === state.activeMatchIndex, rect });
      }
      map.set(m.pageNumber, list);
    });
    return map;
  }, [state.searchResult, state.activeMatchIndex]);

  const activeZoomPercent = useMemo(() => {
    if (state.zoomMode === "custom") {
      return `${Math.round(state.zoomScale * 100)}%`;
    }
    return state.zoomMode === "fit_width" ? pm.reader.fitWidth : pm.reader.fitPage;
  }, [state.zoomMode, state.zoomScale, pm.reader.fitWidth, pm.reader.fitPage]);

  const adjustZoom = (delta: number) => {
    updateReaderSession((prev) => {
      const base = prev.zoomMode === "custom" ? prev.zoomScale : 1;
      const nextScale = Math.round(Math.min(3, Math.max(0.4, base + delta)) * 100) / 100;
      return { ...prev, zoomMode: "custom", zoomScale: nextScale };
    });
  };

  const info = state.inspection;
  const isDocReady = Boolean(info && !state.loading && state.activePath === info.path);

  const parsedTtsSelection = useMemo(() => {
    if (!info) {
      return { valid: false, pages: [], uniqueSorted: [], duplicateCount: 0, error: null };
    }
    return parseClientPageRanges(ttsRangeInput, info.pageCount);
  }, [info, ttsRangeInput]);

  const selectedTtsPageSet = useMemo(
    () => new Set(parsedTtsSelection.uniqueSorted),
    [parsedTtsSelection.uniqueSorted],
  );

  const toggleThumbPageForTts = useCallback(
    (pageNumber: number) => {
      if (!info) return;
      const next = new Set(parsedTtsSelection.uniqueSorted);
      if (next.has(pageNumber)) {
        next.delete(pageNumber);
      } else {
        next.add(pageNumber);
      }
      const sorted = Array.from(next).sort((a, b) => a - b);
      setTtsRangeInput(formatCompactPages(sorted));
    },
    [info, parsedTtsSelection.uniqueSorted],
  );

  const handleOpenSelectedPagesTts = useCallback(() => {
    if (!info || !isDocReady) return;
    setTtsScannedNotice(null);
    setTtsError(null);
    setTtsPanelOpen((prev) => {
      const nextOpen = !prev;
      if (nextOpen) {
        const defaultRange = info.pageCount > 1 ? `1-${info.pageCount}` : "1";
        setTtsRangeInput((curr) => (curr.trim() ? curr : defaultRange));
        if (!state.sidebarOpen) {
          updateReaderSession((s) => ({ ...s, sidebarOpen: true, sidebarTab: "thumbs" }));
        }
      }
      return nextOpen;
    });
  }, [info, isDocReady, state.sidebarOpen, updateReaderSession]);

  const handleReadPagesAloud = useCallback(
    async (pages: number[]) => {
      if (!info || !isDocReady || !sessionStore || ttsBusy || pages.length === 0) return;
      const boundPath = info.path;
      const boundDocGen = docGenerationRef.current;
      const boundExtractGen = ++ttsExtractGenRef.current;
      const isExtractionStillValid = () =>
        mountedRef.current &&
        docGenerationRef.current === boundDocGen &&
        ttsExtractGenRef.current === boundExtractGen &&
        !docLoadingRef.current &&
        activeDocPathRef.current === boundPath;

      setTtsBusy(true);
      setTtsError(null);
      setTtsScannedNotice(null);
      try {
        const extracted = await extractPdfPagesText(boundPath, pages);
        if (!isExtractionStillValid()) return;
        const includedPages =
          extracted.includedPages && extracted.includedPages.length > 0
            ? extracted.includedPages
            : extracted.pages
                .filter((p) => p.status === "included" || p.status === "truncated")
                .map((p) => p.pageNumber);
        if (
          extracted.extractedPageCount === 0 ||
          includedPages.length === 0 ||
          !extracted.combinedText.trim()
        ) {
          setTtsScannedNotice({
            path: boundPath,
            pages: extracted.scannedPages.length > 0 ? extracted.scannedPages : pages,
          });
          return;
        }
        setTtsPanelOpen(false);
        sessionStore.handoffPdfTextToTts({
          path: extracted.path,
          fileName: extracted.fileName,
          text: extracted.combinedText,
          includedPages,
          skippedScannedPages: extracted.scannedPages,
          omittedPages: extracted.omittedPages ?? [],
          truncated: extracted.truncated,
        });
      } catch (err) {
        if (!isExtractionStillValid()) return;
        setTtsError(formatLocalizedError(err, t));
      } finally {
        if (
          mountedRef.current &&
          docGenerationRef.current === boundDocGen &&
          ttsExtractGenRef.current === boundExtractGen
        ) {
          setTtsBusy(false);
        }
      }
    },
    [info, isDocReady, sessionStore, ttsBusy, t],
  );

  return (
    <div
      className={`pdf-reader-shell ${state.fullscreen ? "is-fullscreen" : ""} ${dropHover ? "is-drop-hover" : ""}`}
      data-testid="pdf-reader-view"
    >
      {/* Top Reader Toolbar */}
      <div className="pdf-reader-toolbar">
        <div className="pdf-reader-toolbar-group">
          <button type="button" className="btn btn-primary" onClick={() => void handleOpenDialog()}>
            <FolderOpen size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>{pm.common.openPdf}</span>
          </button>

          {info && (
            <>
              <button
                type="button"
                className={`btn btn-ghost btn-icon ${state.sidebarOpen ? "is-active" : ""}`}
                title={pm.reader.toggleSidebar}
                aria-label={pm.reader.toggleSidebar}
                aria-pressed={state.sidebarOpen}
                onClick={() =>
                  updateReaderSession((prev) => ({ ...prev, sidebarOpen: !prev.sidebarOpen }))
                }
              >
                <PanelLeft size={16} strokeWidth={1.75} aria-hidden="true" />
              </button>

              <div className="pdf-toolbar-divider" aria-hidden="true" />

              <button
                type="button"
                className="btn btn-ghost btn-icon"
                title={pm.reader.prevPage}
                aria-label={pm.reader.prevPage}
                disabled={state.currentPage <= 1}
                onClick={() => jumpToPage(state.currentPage - 1)}
              >
                <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />
              </button>

              <form
                className="pdf-page-jump"
                onSubmit={(e) => {
                  e.preventDefault();
                  const parsed = Number.parseInt(pageInputText, 10);
                  if (Number.isFinite(parsed)) {
                    jumpToPage(parsed);
                  } else {
                    setPageInputText(String(state.currentPage));
                  }
                }}
              >
                <input
                  type="text"
                  inputMode="numeric"
                  className="pdf-page-input mono"
                  aria-label={pm.reader.pageInputLabel}
                  value={pageInputText}
                  onChange={(e) => setPageInputText(e.target.value)}
                  onBlur={() => {
                    const parsed = Number.parseInt(pageInputText, 10);
                    if (Number.isFinite(parsed)) {
                      jumpToPage(parsed);
                    } else {
                      setPageInputText(String(state.currentPage));
                    }
                  }}
                />
                <span className="pdf-page-total mono">/ {info.pageCount}</span>
              </form>

              <button
                type="button"
                className="btn btn-ghost btn-icon"
                title={pm.reader.nextPage}
                aria-label={pm.reader.nextPage}
                disabled={state.currentPage >= info.pageCount}
                onClick={() => jumpToPage(state.currentPage + 1)}
              >
                <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </>
          )}
        </div>

        {info && (
          <div className="pdf-reader-toolbar-group">
            <div className="segmented" role="group" aria-label={pm.reader.zoomReset}>
              <button
                type="button"
                className={`segmented-btn ${state.zoomMode === "fit_width" ? "is-selected" : ""}`}
                onClick={() =>
                  updateReaderSession((prev) => ({ ...prev, zoomMode: "fit_width", zoomScale: 1 }))
                }
              >
                {pm.reader.fitWidth}
              </button>
              <button
                type="button"
                className={`segmented-btn ${state.zoomMode === "fit_page" ? "is-selected" : ""}`}
                onClick={() =>
                  updateReaderSession((prev) => ({ ...prev, zoomMode: "fit_page", zoomScale: 1 }))
                }
              >
                {pm.reader.fitPage}
              </button>
            </div>

            <button
              type="button"
              className="btn btn-ghost btn-icon"
              title={pm.reader.zoomOut}
              aria-label={pm.reader.zoomOut}
              onClick={() => adjustZoom(-0.2)}
            >
              <ZoomOut size={15} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <span className="pdf-zoom-readout mono">{activeZoomPercent}</span>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              title={pm.reader.zoomIn}
              aria-label={pm.reader.zoomIn}
              onClick={() => adjustZoom(0.2)}
            >
              <ZoomIn size={15} strokeWidth={1.75} aria-hidden="true" />
            </button>

            <div className="pdf-toolbar-divider" aria-hidden="true" />

            <button
              type="button"
              className={`btn btn-ghost btn-icon ${state.searchOpen ? "is-active" : ""}`}
              title={pm.reader.searchPlaceholder}
              aria-label={pm.reader.searchBtn}
              onClick={() => {
                const nextOpen = !state.searchOpen;
                updateReaderSession((prev) => ({ ...prev, searchOpen: nextOpen }));
                if (nextOpen) {
                  setTimeout(() => searchInputRef.current?.focus(), 0);
                }
              }}
            >
              <Search size={15} strokeWidth={1.75} aria-hidden="true" />
            </button>

            <button
              type="button"
              className="btn btn-ghost btn-icon"
              title={state.fullscreen ? pm.reader.fullscreenExit : pm.reader.fullscreenEnter}
              aria-label={state.fullscreen ? pm.reader.fullscreenExit : pm.reader.fullscreenEnter}
              onClick={() =>
                updateReaderSession((prev) => ({ ...prev, fullscreen: !prev.fullscreen }))
              }
            >
              {state.fullscreen ? (
                <Minimize2 size={15} strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <Maximize2 size={15} strokeWidth={1.75} aria-hidden="true" />
              )}
            </button>

            <div className="pdf-toolbar-divider" aria-hidden="true" />

            {sessionStore && (
              <>
                <button
                  type="button"
                  className="btn"
                  disabled={ttsBusy || !isDocReady}
                  onClick={() => void handleReadPagesAloud([state.currentPage])}
                  title={
                    isZh
                      ? `提取第 ${state.currentPage} 页文字并送入「文本朗读 (T06)」`
                      : `Extract page ${state.currentPage} text and open in Read Text Aloud (T06)`
                  }
                  data-testid="c08-read-current-page-btn"
                >
                  <Volume2 size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{isZh ? "朗读当前页" : "Read Page"}</span>
                </button>
                <button
                  type="button"
                  className={`btn ${ttsPanelOpen ? "is-active" : ""}`}
                  disabled={ttsBusy || !isDocReady}
                  aria-expanded={ttsPanelOpen}
                  onClick={handleOpenSelectedPagesTts}
                  title={
                    isZh
                      ? "按页码范围或缩略图勾选多页提取文字并送入「文本朗读 (T06)」"
                      : "Select a page range or thumbnails to extract and open in Read Text Aloud (T06)"
                  }
                  data-testid="c08-read-selected-pages-btn"
                >
                  <span>{isZh ? "朗读所选页" : "Read Pages"}</span>
                </button>
                <div className="pdf-toolbar-divider" aria-hidden="true" />
              </>
            )}

            <button
              type="button"
              className="btn"
              onClick={() => sendPdfToTool(info.path, "P06")}
              title="P06"
            >
              <span>P06</span>
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => sendPdfToTool(info.path, "P13")}
              title="P13"
            >
              <span>P13</span>
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => sendPdfToTool(info.path, "I13")}
              title="I13"
            >
              <span>I13</span>
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => sendPdfToTool(info.path, "P14")}
              title="P14"
            >
              <span>P14</span>
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => sendPdfToTool(info.path, info.isEncrypted ? "P16" : "P15")}
              title={info.isEncrypted ? "P16" : "P15"}
            >
              <span>{info.isEncrypted ? "P16" : "P15"}</span>
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => sendPdfToTool(info.path, "P08")}
              title={pm.reader.sendToSplit}
            >
              <Scissors size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>P08</span>
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => sendPdfToTool(info.path, "P09")}
              title={pm.organize.title}
            >
              <span>P09</span>
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => sendPdfToTool(info.path, "P17")}
              title={pm.pdfToImages.title}
            >
              <span>P17</span>
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => sendPdfToTool(info.path, "P07")}
              title={pm.reader.sendToMerge}
            >
              <Combine size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>P07</span>
            </button>
          </div>
        )}
      </div>

      {/* Inline Full-Text Search Bar */}
      {info && state.searchOpen && (
        <div className="pdf-search-bar" role="search">
          <form
            className="pdf-search-form"
            onSubmit={(e) => {
              e.preventDefault();
              void handleRunSearch();
            }}
          >
            <input
              ref={searchInputRef}
              type="search"
              className="pdf-search-input"
              placeholder={pm.reader.searchPlaceholder}
              value={state.searchQuery}
              onChange={(e) =>
                updateReaderSession((prev) => ({ ...prev, searchQuery: e.target.value }))
              }
            />
            <label className="pdf-search-case">
              <input
                type="checkbox"
                checked={state.searchCaseSensitive}
                onChange={(e) =>
                  updateReaderSession((prev) => ({
                    ...prev,
                    searchCaseSensitive: e.target.checked,
                  }))
                }
              />
              <span>{pm.reader.searchCaseSensitive}</span>
            </label>
            <button type="submit" className="btn btn-primary" disabled={state.searchLoading}>
              {pm.reader.searchBtn}
            </button>
          </form>

          {state.searchResult && (
            <div className="pdf-search-status">
              <span className="mono">
                {state.searchResult.totalMatches === 0
                  ? pm.reader.searchNoMatches
                  : pm.reader.searchCount(
                      state.activeMatchIndex + 1,
                      state.searchResult.totalMatches,
                      state.searchResult.truncated,
                    )}
              </span>
              {state.searchResult.totalMatches > 0 && (
                <>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    title={pm.reader.searchPrev}
                    aria-label={pm.reader.searchPrev}
                    onClick={() => stepSearchMatch(-1)}
                  >
                    <ChevronUp size={15} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    title={pm.reader.searchNext}
                    aria-label={pm.reader.searchNext}
                    onClick={() => stepSearchMatch(1)}
                  >
                    <ChevronDown size={15} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </>
              )}
            </div>
          )}

          <button
            type="button"
            className="btn btn-ghost btn-icon"
            title={pm.reader.searchClose}
            aria-label={pm.reader.searchClose}
            onClick={() =>
              updateReaderSession((prev) => ({
                ...prev,
                searchOpen: false,
                searchResult: null,
                activeMatchIndex: 0,
              }))
            }
          >
            <X size={15} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Inline Selected-Pages PDF Read-Aloud Bar (C08 -> T06) */}
      {info && sessionStore && ttsPanelOpen && (
        <div
          className="pdf-search-bar pdf-tts-bar"
          role="region"
          aria-label={isZh ? "选择 PDF 朗读页面" : "Select PDF pages to read aloud"}
          data-testid="c08-tts-selected-bar"
        >
          <form
            className="pdf-tts-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (parsedTtsSelection.valid && !ttsBusy && isDocReady) {
                void handleReadPagesAloud(parsedTtsSelection.uniqueSorted);
              }
            }}
          >
            <Volume2 size={15} strokeWidth={1.75} aria-hidden="true" style={{ flexShrink: 0 }} />
            <label className="pdf-tts-label" htmlFor="c08-tts-range">
              {isZh ? "朗读页码" : "Pages"}
            </label>
            <input
              id="c08-tts-range"
              type="text"
              className="pdf-search-input mono"
              style={{ maxWidth: 200 }}
              value={ttsRangeInput}
              onChange={(e) => {
                setTtsScannedNotice(null);
                setTtsError(null);
                setTtsRangeInput(e.target.value);
              }}
              placeholder={
                isZh ? `例如 1-${info.pageCount} 或 1, 3-5` : `e.g. 1-${info.pageCount} or 1, 3-5`
              }
              data-testid="c08-tts-page-range-input"
            />
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setTtsRangeInput(info.pageCount > 1 ? `1-${info.pageCount}` : "1")}
              data-testid="c08-tts-select-all-btn"
            >
              {isZh ? `全部 (1-${info.pageCount})` : `All (1-${info.pageCount})`}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setTtsRangeInput(String(state.currentPage))}
              data-testid="c08-tts-select-current-btn"
            >
              {isZh ? `当前页 (${state.currentPage})` : `Current (${state.currentPage})`}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setTtsRangeInput("")}
              data-testid="c08-tts-clear-pages-btn"
            >
              {isZh ? "清空" : "Clear"}
            </button>
            <span className="pdf-tts-summary mono" data-testid="c08-tts-selection-summary">
              {parsedTtsSelection.valid
                ? isZh
                  ? `已选 ${parsedTtsSelection.uniqueSorted.length} 页（${formatCompactPages(parsedTtsSelection.uniqueSorted)}）`
                  : `${parsedTtsSelection.uniqueSorted.length} page(s) (${formatCompactPages(parsedTtsSelection.uniqueSorted)})`
                : isZh
                  ? `请输入 1-${info.pageCount} 范围内的页码`
                  : `Enter pages within 1-${info.pageCount}`}
            </span>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!parsedTtsSelection.valid || ttsBusy || !isDocReady}
              data-testid="c08-tts-send-selected-btn"
            >
              {ttsBusy
                ? isZh
                  ? "正在提取文字…"
                  : "Extracting..."
                : isZh
                  ? "提取并送入朗读 (T06)"
                  : "Send to Read Aloud (T06)"}
            </button>
          </form>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            title={isZh ? "关闭选页朗读栏" : "Close page selection bar"}
            aria-label={isZh ? "关闭选页朗读栏" : "Close page selection bar"}
            onClick={() => setTtsPanelOpen(false)}
          >
            <X size={15} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Honest Document Status Banners */}
      {ttsError && (
        <div
          className="pdf-banner pdf-banner-error"
          role="alert"
          data-testid="c08-tts-error-banner"
        >
          <AlertTriangle size={16} strokeWidth={1.75} aria-hidden="true" />
          <span style={{ flex: 1 }}>{ttsError}</span>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={isZh ? "关闭提示" : "Dismiss"}
            onClick={() => setTtsError(null)}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      {ttsScannedNotice && info && ttsScannedNotice.path === info.path && (
        <div
          className="pdf-banner pdf-banner-warn"
          role="status"
          data-testid="c08-tts-scanned-banner"
        >
          <AlertTriangle size={16} strokeWidth={1.75} aria-hidden="true" />
          <span style={{ flex: 1 }}>
            {isZh
              ? `第 ${formatCompactPages(ttsScannedNotice.pages)} 页未检测到可选文字层（纯扫描页），无法直接提取朗读文本。请先使用「扫描版 PDF 转可搜索 (P04)」识别叠加文字层，再直接朗读。`
              : `No selectable text layer was found on page(s) ${formatCompactPages(ttsScannedNotice.pages)} (pure scanned page). Convert it with Make PDF Searchable (P04) first, then read it aloud directly.`}
          </span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => sendPdfToTool(info.path, "P04")}
            data-testid="c08-tts-goto-p04-btn"
          >
            {isZh ? "转为可搜索 PDF (P04)" : "Make Searchable (P04)"}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={isZh ? "关闭提示" : "Dismiss"}
            onClick={() => setTtsScannedNotice(null)}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      {state.errorMessage && (
        <div className="pdf-banner pdf-banner-error" role="alert">
          <AlertTriangle size={16} strokeWidth={1.75} aria-hidden="true" />
          <span style={{ flex: 1 }}>{state.errorMessage}</span>
          {state.errorCode === "PDF_PASSWORD_REQUIRED" && state.activePath && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => sendPdfToTool(state.activePath!, "P16")}
            >
              {locale === "zh-CN" ? "使用 P16 输入密码解锁" : "Unlock in P16"}
            </button>
          )}
        </div>
      )}
      {info?.isEncrypted && (
        <div className="pdf-banner pdf-banner-info" role="status">
          <Info size={16} strokeWidth={1.75} aria-hidden="true" />
          <span style={{ flex: 1 }}>
            {locale === "zh-CN"
              ? "此 PDF 带有权限加密限制（可无密码打开）。如需导出无限制副本，请使用「PDF 解除密码 (P16)」。"
              : "This PDF has owner permission restrictions (opens without password). Use PDF Decrypt (P16) to save an unrestricted copy."}
          </span>
          <button type="button" className="btn" onClick={() => sendPdfToTool(info.path, "P16")}>
            {locale === "zh-CN" ? "前往 P16" : "Open P16"}
          </button>
        </div>
      )}
      {info?.isLikelyScanned && (
        <div className="pdf-banner pdf-banner-info" role="status">
          <Info size={16} strokeWidth={1.75} aria-hidden="true" />
          <span style={{ flex: 1 }}>{pm.reader.scannedBanner}</span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => sendPdfToTool(info.path, "P04")}
          >
            {locale === "zh-CN" ? "转为可搜索 PDF (P04)" : "Make Searchable (P04)"}
          </button>
          <button type="button" className="btn" onClick={() => sendPdfToTool(info.path, "T03")}>
            {locale === "zh-CN" ? "识别文字 (T03)" : "Extract Text (T03)"}
          </button>
        </div>
      )}
      {info?.hasSignatures && (
        <div className="pdf-banner pdf-banner-warn" role="status">
          <AlertTriangle size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>{pm.reader.signatureBanner}</span>
        </div>
      )}

      {/* Main Reader Body */}
      {!info ? (
        <div className="pdf-reader-empty">
          <div className="pdf-reader-empty-card">
            <FileSearch size={36} strokeWidth={1.5} aria-hidden="true" />
            <h2>{pm.reader.emptyTitle}</h2>
            <p>{pm.reader.emptyBody}</p>
            <button
              type="button"
              className="btn btn-primary"
              disabled={state.loading}
              onClick={() => void handleOpenDialog()}
            >
              <FolderOpen size={15} strokeWidth={1.75} aria-hidden="true" />
              <span>{state.loading ? pm.common.working : pm.common.openPdf}</span>
            </button>
            <p className="pdf-muted-note">{pm.common.nonDestructiveNote}</p>
          </div>
        </div>
      ) : (
        <div className={`pdf-reader-body ${state.sidebarOpen ? "with-sidebar" : ""}`}>
          {state.sidebarOpen && (
            <aside className="pdf-reader-sidebar">
              <div className="pdf-sidebar-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={state.sidebarTab === "thumbs"}
                  className={`pdf-sidebar-tab ${state.sidebarTab === "thumbs" ? "is-selected" : ""}`}
                  onClick={() => updateReaderSession((prev) => ({ ...prev, sidebarTab: "thumbs" }))}
                >
                  {pm.reader.tabThumbs}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={state.sidebarTab === "outlines"}
                  className={`pdf-sidebar-tab ${state.sidebarTab === "outlines" ? "is-selected" : ""}`}
                  onClick={() =>
                    updateReaderSession((prev) => ({ ...prev, sidebarTab: "outlines" }))
                  }
                >
                  {pm.reader.tabOutlines}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={state.sidebarTab === "info"}
                  className={`pdf-sidebar-tab ${state.sidebarTab === "info" ? "is-selected" : ""}`}
                  onClick={() => updateReaderSession((prev) => ({ ...prev, sidebarTab: "info" }))}
                >
                  {pm.reader.tabInfo}
                </button>
              </div>

              {state.sidebarTab === "thumbs" && (
                <div className="pdf-thumb-list" ref={thumbScrollRef}>
                  {info.pages.map((page) => {
                    const thumbUrl = renderedThumbs.get(`${info.path}#${page.pageNumber}`);
                    const aspect =
                      page.heightPt > 0 ? page.heightPt / Math.max(page.widthPt, 1) : 1.414;
                    const thumbH = Math.round(Math.min(220, Math.max(84, 140 * aspect)));
                    const active = state.currentPage === page.pageNumber;
                    const checkedForTts = ttsPanelOpen && selectedTtsPageSet.has(page.pageNumber);
                    return (
                      <div
                        key={page.pageNumber}
                        className={`pdf-thumb-row ${checkedForTts ? "is-tts-selected" : ""}`}
                      >
                        {ttsPanelOpen && sessionStore && (
                          <label
                            className="pdf-thumb-check-wrap"
                            title={
                              isZh
                                ? `勾选/取消第 ${page.pageNumber} 页用于朗读`
                                : `Toggle page ${page.pageNumber} for reading aloud`
                            }
                          >
                            <input
                              type="checkbox"
                              checked={checkedForTts}
                              onChange={() => toggleThumbPageForTts(page.pageNumber)}
                              aria-label={
                                isZh
                                  ? `勾选第 ${page.pageNumber} 页用于朗读`
                                  : `Select page ${page.pageNumber} for reading aloud`
                              }
                              data-testid={`c08-thumb-check-${page.pageNumber}`}
                            />
                          </label>
                        )}
                        <button
                          type="button"
                          data-thumb-page={page.pageNumber}
                          ref={(el) => {
                            if (el) thumbRefs.current.set(page.pageNumber, el);
                            else thumbRefs.current.delete(page.pageNumber);
                          }}
                          className={`pdf-thumb-item ${active ? "is-active" : ""}`}
                          onClick={() => jumpToPage(page.pageNumber)}
                        >
                          <div className="pdf-thumb-frame" style={{ height: `${thumbH}px` }}>
                            {thumbUrl ? (
                              <img src={thumbUrl} alt={`Page ${page.pageNumber}`} loading="lazy" />
                            ) : (
                              <span className="pdf-thumb-placeholder mono">{page.pageNumber}</span>
                            )}
                          </div>
                          <span className="pdf-thumb-label mono">{page.pageNumber}</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {state.sidebarTab === "outlines" && (
                <div className="pdf-outline-pane">
                  {info.outlines.length === 0 ? (
                    <div className="pdf-sidebar-empty">
                      <BookOpen size={20} strokeWidth={1.6} aria-hidden="true" />
                      <span>{pm.reader.noOutlines}</span>
                    </div>
                  ) : (
                    <OutlineTree items={info.outlines} onJumpPage={jumpToPage} />
                  )}
                </div>
              )}

              {state.sidebarTab === "info" && (
                <div className="pdf-info-pane">
                  <dl className="pdf-info-dl">
                    <dt>{pm.reader.infoFileName}</dt>
                    <dd className="mono">{info.fileName}</dd>
                    <dt>{pm.reader.infoFileSize}</dt>
                    <dd className="mono">{pm.common.bytesLabel(info.byteLength)}</dd>
                    <dt>{pm.reader.infoPageCount}</dt>
                    <dd className="mono">{info.pageCount}</dd>
                    <dt>{pm.reader.infoTextLayer}</dt>
                    <dd>
                      {info.hasTextLayer ? pm.reader.infoTextLayerYes : pm.reader.infoTextLayerNo}
                    </dd>
                    <dt>{pm.reader.infoSignatures}</dt>
                    <dd>
                      {info.hasSignatures
                        ? `${pm.reader.infoYes} (${info.signatureCount})`
                        : pm.reader.infoNo}
                    </dd>
                    <dt>{pm.reader.infoAcroForm}</dt>
                    <dd>{info.hasAcroform ? pm.reader.infoYes : pm.reader.infoNo}</dd>
                    {info.title && (
                      <>
                        <dt>{pm.reader.infoTitle}</dt>
                        <dd>{info.title}</dd>
                      </>
                    )}
                    {info.author && (
                      <>
                        <dt>{pm.reader.infoAuthor}</dt>
                        <dd>{info.author}</dd>
                      </>
                    )}
                    {info.creator && (
                      <>
                        <dt>{pm.reader.infoCreator}</dt>
                        <dd>{info.creator}</dd>
                      </>
                    )}
                    {info.producer && (
                      <>
                        <dt>{pm.reader.infoProducer}</dt>
                        <dd>{info.producer}</dd>
                      </>
                    )}
                  </dl>
                </div>
              )}
            </aside>
          )}

          {/* Scrollable Page Viewport */}
          <div className="pdf-viewport" ref={viewportRef}>
            <div className="pdf-pages-column">
              {info.pages.map((page) => {
                const disp = computePageDisplaySize(page);
                const dpr = Math.min(window.devicePixelRatio || 1, 2);
                const renderW = Math.min(
                  2400,
                  Math.max(240, Math.ceil((disp.width * dpr) / 64) * 64),
                );
                const key = `${info.path}#${page.pageNumber}@${renderW}`;
                const dataUrl = renderedPages.get(key);
                const textPayload = pageTexts.get(`${info.path}#${page.pageNumber}`);
                const pageHighlights = matchesByPage.get(page.pageNumber) ?? [];

                return (
                  <div
                    key={page.pageNumber}
                    data-page={page.pageNumber}
                    ref={(el) => {
                      if (el) pageRefs.current.set(page.pageNumber, el);
                      else pageRefs.current.delete(page.pageNumber);
                    }}
                    className="pdf-page-sheet"
                    style={{ width: `${disp.width}px`, height: `${disp.height}px` }}
                  >
                    {dataUrl ? (
                      <img
                        src={dataUrl}
                        alt={`Page ${page.pageNumber}`}
                        className="pdf-page-img"
                        draggable={false}
                      />
                    ) : (
                      <div className="pdf-page-loading">
                        <span className="mono">{pm.reader.pageRendering(page.pageNumber)}</span>
                      </div>
                    )}

                    {/* Search Highlights Layer */}
                    {pageHighlights.length > 0 && (
                      <div className="pdf-highlight-layer" aria-hidden="true">
                        {pageHighlights.map((hl, idx) => (
                          <div
                            key={idx}
                            className={`pdf-search-highlight ${hl.isActive ? "is-active" : ""}`}
                            style={{
                              left: `${hl.rect.left * 100}%`,
                              top: `${hl.rect.top * 100}%`,
                              width: `${hl.rect.width * 100}%`,
                              height: `${hl.rect.height * 100}%`,
                            }}
                          />
                        ))}
                      </div>
                    )}

                    {/* Selectable & Copyable Transparent Text Layer */}
                    {textPayload && textPayload.spans.length > 0 && (
                      <div className="pdf-text-layer">
                        {textPayload.spans.map((span, idx) => (
                          <span
                            key={idx}
                            className="pdf-text-span"
                            style={{
                              left: `${span.rect.left * 100}%`,
                              top: `${span.rect.top * 100}%`,
                              width: `${span.rect.width * 100}%`,
                              height: `${span.rect.height * 100}%`,
                              fontSize: `${Math.max(8, Math.round(span.rect.height * disp.height * 0.88))}px`,
                            }}
                          >
                            {span.text}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Clickable Links Layer */}
                    {textPayload && textPayload.links.length > 0 && (
                      <div className="pdf-link-layer">
                        {textPayload.links.map((link, idx) => (
                          <button
                            key={idx}
                            type="button"
                            className="pdf-link-hotspot"
                            title={
                              link.kind === "internal"
                                ? `Go to page ${link.targetPage}`
                                : (link.uri ?? "")
                            }
                            style={{
                              left: `${link.rect.left * 100}%`,
                              top: `${link.rect.top * 100}%`,
                              width: `${link.rect.width * 100}%`,
                              height: `${link.rect.height * 100}%`,
                            }}
                            onClick={() => {
                              if (link.kind === "internal" && link.targetPage) {
                                jumpToPage(link.targetPage);
                              } else if (link.kind === "external" && link.uri) {
                                if (window.confirm(pm.reader.openExternalConfirm(link.uri))) {
                                  void openQrHttpUrl(link.uri);
                                }
                              }
                            }}
                          />
                        ))}
                      </div>
                    )}

                    <span className="pdf-page-corner-num mono">{page.pageNumber}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
